/**
 * bootstrap.ts — Effect Layer compositions for neko.
 *
 * Two exported layers:
 *   ProductionLayer — local persistence: SQLite metadata + JSON event files
 *                     under ~/.local/share/neko/. No cloud.
 *   TestLayer       — in-memory repositories.
 *
 * Layer wiring rules:
 *   Layer.mergeAll evaluates layers in parallel — siblings cannot satisfy each
 *   other's requirements. Use Layer.provide(dep) to explicitly wire a dependency
 *   into a layer before merging it with others.
 */

import { DateTime, Effect, Layer } from "effect"
import { Event, SessionMessage } from "@gco/schema"
import { EventRepository } from "@gco/model-domain"

// LLM providers
import * as AnthropicProvider from "@gco/llm/providers/anthropic"
import * as DeepSeekProvider from "@gco/llm/providers/deepseek"
import * as OllamaProvider from "@gco/llm/providers/ollama"
import * as OpenAIProvider from "@gco/llm/providers/openai"

// Model layer
import { LocalModelLayer } from "@gco/model-local"
import { TestModelLayer } from "@gco/model-test"

// Controllers
import {
  sessionControllerLayer,
  sessionRunnerLayer,
  SessionController,
  SessionRunner,
  ModelResolver,
  type ModelResolverInterface,
  type SessionControllerInterface,
  type SessionRunnerInterface,
} from "@gco/controller-session"
import { agentLayer } from "@gco/controller-agent"
import { mcpLayer, mcpAuthLayer } from "@gco/controller-mcp"
import {
  toolRegistryLayer,
  toolPermissionEnforcerLayer,
  ToolRegistryService,
  BashTool,
  ReadTool,
  GlobTool,
  GrepTool,
  EditTool,
  WriteTool,
  WebFetchTool,
  WebSearchTool,
  ApplyPatchTool,
  ApplyUnifiedDiffTool,
  TodoWriteTool,
  AgentTool,
  TaskTool,
  SkillTool,
  LspTool,
} from "@gco/controller-tool"

// LLM infrastructure
import { LLMClient, type LLMClientService } from "@gco/llm"
import { RequestExecutor } from "@gco/llm/route"
import type { Model } from "@gco/llm"
import type { Session } from "@gco/schema"
import type { IEventRepository } from "@gco/model-domain"

// ---------------------------------------------------------------------------
// ModelResolver implementations
// ---------------------------------------------------------------------------

const multiProviderModelResolverLayer: Layer.Layer<ModelResolver> = Layer.succeed(
  ModelResolver,
  ModelResolver.of({
    resolve: (session: Session.Info) => {
      const modelId =
        session.model?.id ??
        (session.model as any)?.modelID ??
        "deepseek-v4-flash"

      const providerID =
        (session.model as any)?.providerID ??
        (session.model as any)?.provider ??
        ""

      const isDeepSeek =
        providerID === "deepseek" ||
        modelId.startsWith("deepseek") ||
        modelId.includes("deepseek")

      if (isDeepSeek) {
        const apiKey = process.env.DEEPSEEK_API_KEY
        const ds = DeepSeekProvider.configure({ apiKey })
        return Effect.succeed(ds.model(modelId) as unknown as Model)
      }

      const isAnthropic =
        providerID === "anthropic" ||
        modelId.startsWith("claude")

      if (isAnthropic) {
        const apiKey = process.env.ANTHROPIC_API_KEY
        const ap = AnthropicProvider.configure({ apiKey })
        return Effect.succeed(ap.model(modelId) as unknown as Model)
      }

      const isOpenAI =
        providerID === "openai" ||
        modelId.startsWith("gpt-") ||
        modelId.startsWith("o1") ||
        modelId.startsWith("o3") ||
        modelId.startsWith("o4")

      if (isOpenAI) {
        const apiKey = process.env.OPENAI_API_KEY
        const oa = OpenAIProvider.configure({ apiKey })
        return Effect.succeed(oa.model(modelId) as unknown as Model)
      }

      // Ollama: explicit provider ID routes here too.
      // Falls through from unknown providers as the local-inference default.
      const ollamaBaseURL = process.env.OLLAMA_HOST
        ? `${process.env.OLLAMA_HOST}/v1`
        : undefined
      const ol = OllamaProvider.configure(ollamaBaseURL ? { baseURL: ollamaBaseURL } : {})
      return Effect.succeed(ol.model(modelId) as unknown as Model)
    },
  }),
)

const testModelResolverLayer: Layer.Layer<ModelResolver> = Layer.succeed(
  ModelResolver,
  ModelResolver.of({
    resolve: (_session: Session.Info) => {
      const fakeModel = {} as unknown as Model
      return Effect.succeed(fakeModel)
    },
  }),
)

// ---------------------------------------------------------------------------
// LLM Client layer
// ---------------------------------------------------------------------------

const llmClientLayer: Layer.Layer<LLMClientService> = LLMClient.layer.pipe(
  Layer.provide(RequestExecutor.fetchLayer),
)

// ---------------------------------------------------------------------------
// Production Layer
// ---------------------------------------------------------------------------

// Model repositories — SQLite + JSON on disk. Self-contained; no config
// beyond `$XDG_DATA_HOME` (defaults to `~/.local/share/neko`).
const modelReposLayer = LocalModelLayer

// ---------------------------------------------------------------------------
// Subagent runtime — resolves the cycle between builtinToolsLayer (which
// contains task/agent tools) and controllersLayer (SessionController /
// SessionRunner, which the tools call to spawn child sessions).
//
// The tools capture this module-level ref at build time; a wiring layer that
// runs AFTER the controllers layer populates it. Until populated, the tools
// return a clear error rather than a stubbed one.
// ---------------------------------------------------------------------------

type SubagentRuntime = {
  sessions: SessionControllerInterface
  runner: SessionRunnerInterface
  events: IEventRepository
}

const subagentRuntime: { current: SubagentRuntime | null } = { current: null }

/** Read the last assistant text.ended event and return its accumulated text. */
function extractLastAssistantText(events: ReadonlyArray<{ type: string; data: unknown }>): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i] as { type: string; data: { text?: string } }
    if (ev.type === "session.next.text.ended") return ev.data?.text ?? ""
  }
  return ""
}

/**
 * Shared spawn helper for both task (fg+bg) and agent (fg-only) tools.
 * Creates a child session (or resumes taskId), admits the prompt, drives the
 * runner to completion, then returns the last assistant text.
 *
 * Also writes `session.next.subagent.spawned` and `.ended` events to the PARENT
 * session so the TUI can nest the child's transcript under the spawning tool row.
 */
const spawnSubagent = (input: {
  prompt: string
  subagentType: string
  parentSessionID: string
  toolCallID?: string
  taskId?: string
  title?: string
  background?: boolean
}) =>
  Effect.gen(function* () {
    const rt = subagentRuntime.current
    if (!rt) return yield* Effect.fail(new Error("Subagent runtime not initialized"))

    // Resolve or create the child session
    let childSid: Session.ID
    if (input.taskId) {
      childSid = input.taskId as Session.ID
      yield* rt.sessions
        .get(childSid)
        .pipe(Effect.mapError(() => new Error(`Task session not found: ${input.taskId}`)))
    } else {
      const parent = yield* rt.sessions
        .get(input.parentSessionID as Session.ID)
        .pipe(Effect.mapError(() => new Error(`Parent session not found: ${input.parentSessionID}`)))
      const child = yield* rt.sessions.create({
        projectID: parent.projectID,
        parentID: input.parentSessionID,
        title: input.title ?? `Task: ${input.subagentType}`,
        agent: input.subagentType,
        model: parent.model
          ? {
              id: parent.model.id,
              providerID: parent.model.providerID,
              variant: parent.model.variant,
            }
          : undefined,
        location: {
          directory: parent.location.directory,
          workspaceID: parent.location.workspaceID,
        },
      })
      childSid = child.id
    }

    // Announce the spawn to the PARENT stream so the TUI can associate this
    // child session with the spawning tool call and start streaming its events.
    const spawnTs = yield* DateTime.now
    yield* rt.events
      .append(input.parentSessionID as Session.ID, [
        {
          id: Event.ID.create(),
          type: "session.next.subagent.spawned",
          durable: undefined,
          data: {
            sessionID: input.parentSessionID,
            timestamp: spawnTs,
            childSessionID: childSid,
            subagentType: input.subagentType,
            toolCallID: input.toolCallID,
            description: input.title,
          },
        } as any,
      ])
      .pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            process.stderr.write(
              `[subagent] failed to append spawned event for ${input.parentSessionID}: ${cause}\n`,
            )
          }),
        ),
      )

    // Admit the prompt directly (bypassing SessionController.prompt so we can
    // wait for the runner synchronously below instead of fork-and-forget).
    const messageID = SessionMessage.ID.create()
    const timestamp = yield* DateTime.now
    yield* rt.events.append(childSid, [
      {
        id: Event.ID.create(),
        type: "session.next.prompt.admitted",
        durable: undefined,
        data: {
          sessionID: childSid,
          timestamp,
          messageID,
          prompt: { text: input.prompt, files: [], agents: [] },
          delivery: "steer",
        },
      } as any,
    ])

    // Write a subagent.ended event to the parent stream so the TUI knows to
    // finalize the nested transcript. Fires for both fg and bg completion.
    const emitEnded = (state: "completed" | "error" | "running") =>
      Effect.gen(function* () {
        const ts = yield* DateTime.now
        yield* rt.events
          .append(input.parentSessionID as Session.ID, [
            {
              id: Event.ID.create(),
              type: "session.next.subagent.ended",
              durable: undefined,
              data: {
                sessionID: input.parentSessionID,
                timestamp: ts,
                childSessionID: childSid,
                toolCallID: input.toolCallID,
                state,
              },
            } as any,
          ])
          .pipe(Effect.catchCause(() => Effect.void))
      })

    if (input.background) {
      yield* rt.runner
        .run({ sessionID: childSid, force: false })
        .pipe(Effect.catchCause(() => Effect.void), Effect.forkDetach)
      // Background tasks don't get an ended event now — the child poller will
      // detect completion via the child's own step.ended stream.
      return {
        sessionID: childSid as string,
        state: "running" as const,
        text: "",
      }
    }

    // Track any runner fault for diagnostic logging. Note: a fault does NOT
    // automatically mean the subagent's work was lost — the model may have
    // produced its final text before an unrelated tail-effect faulted (e.g.
    // background cleanup, cost aggregation). Success is judged by whether
    // usable text landed in the event stream.
    let runFault: string | null = null
    yield* rt.runner.run({ sessionID: childSid, force: false }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          runFault = String(cause)
          process.stderr.write(`[subagent] child run faulted for ${childSid}: ${cause}\n`)
        }),
      ),
    )
    const events = yield* rt.events.load(childSid).pipe(Effect.catchCause(() => Effect.succeed([] as never[])))
    const text = extractLastAssistantText(events as Array<{ type: string; data: unknown }>)

    // Only report error when there's no usable output. Any text at all means
    // the subagent did its job and the parent LLM should treat it as success.
    const state: "completed" | "error" = text.trim() ? "completed" : "error"
    yield* emitEnded(state)
    return {
      sessionID: childSid as string,
      state,
      text: state === "error" ? (runFault ?? "Subagent produced no output") : text,
    }
  })

// Provides ToolRegistryService AND registers all built-in tools on startup.
// Service-dependent tools use inline stubs — real implementations replace these
// as the corresponding subsystems are built out.
const builtinToolsLayer = Layer.merge(
  toolRegistryLayer,
  Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* ToolRegistryService

      // ── Inline stubs for service-dependent tools ─────────────────────────

      const todoStore = new Map<string, ReadonlyArray<TodoWriteTool.TodoInfo>>()
      const todoSvc: TodoWriteTool.ITodoService = {
        update: ({ sessionID, todos }) =>
          Effect.sync(() => { todoStore.set(sessionID, todos) }),
      }

      const agentSvc: AgentTool.IAgentRunnerService = {
        run: (input) =>
          Effect.gen(function* () {
            const result = yield* spawnSubagent({
              prompt: input.prompt,
              subagentType: input.subagentType,
              parentSessionID: input.parentSessionID,
              toolCallID: input.toolCallID,
              taskId: input.taskId,
              title: input.description,
            })
            return {
              sessionID: result.sessionID,
              output: result.text,
            }
          }),
      }

      const taskSvc: TaskTool.ITaskRunnerService = {
        run: (input) =>
          Effect.gen(function* () {
            const result = yield* spawnSubagent({
              prompt: input.prompt,
              subagentType: input.subagentType,
              parentSessionID: input.parentSessionID,
              toolCallID: input.toolCallID,
              taskId: input.taskId,
              title: input.description,
              background: input.background,
            })
            return result
          }),
      }

      const skillSvc: SkillTool.ISkillService = {
        run: ({ skill }) =>
          Effect.tryPromise({
            try: async () => {
              const { resolveSkill } = await import("./skill-resolver")
              const found = await resolveSkill(skill)
              if (!found) throw new Error(`Skill '${skill}' not found`)
              return { output: found.body }
            },
            catch: (cause) =>
              cause instanceof Error
                ? cause
                : new Error(`Skill lookup failed: ${cause}`),
          }),
      }

      const lspSvc: LspTool.ILspService = {
        hasClients: () => Effect.succeed(false),
        touchFile: () => Effect.void,
        definition: () => Effect.succeed([]),
        references: () => Effect.succeed([]),
        hover: () => Effect.succeed([]),
        documentSymbol: () => Effect.succeed([]),
        workspaceSymbol: () => Effect.succeed([]),
        implementation: () => Effect.succeed([]),
        prepareCallHierarchy: () => Effect.succeed([]),
        incomingCalls: () => Effect.succeed([]),
        outgoingCalls: () => Effect.succeed([]),
      }

      // ── Registration ─────────────────────────────────────────────────────

      yield* registry.register({
        bash:               BashTool.tool,
        read:               ReadTool.tool,
        glob:               GlobTool.tool,
        grep:               GrepTool.tool,
        edit:               EditTool.tool,
        write:              WriteTool.tool,
        web_fetch:          WebFetchTool.tool,
        web_search:         WebSearchTool.tool,
        apply_patch:        ApplyPatchTool.tool,
        apply_unified_diff: ApplyUnifiedDiffTool.tool,
        todowrite:          TodoWriteTool.makeTodoWriteTool(todoSvc),
        agent:              AgentTool.makeAgentTool(agentSvc),
        task:               TaskTool.makeTaskTool(taskSvc),
        skill:              SkillTool.makeSkillTool(skillSvc),
        lsp:                LspTool.makeLspTool(lspSvc, process.cwd()),
      })
    }),
  ).pipe(Layer.provide(toolRegistryLayer)),
)

// Infrastructure available to all controllers (everything except SessionRunner itself).
// toolPermissionEnforcerLayer is placed here (not in controllersLayer) so that
// SessionRunner can depend on it for per-call permission checks.
const infraLayer = Layer.mergeAll(
  modelReposLayer,
  multiProviderModelResolverLayer,
  llmClientLayer,
  agentLayer,
  builtinToolsLayer,
  mcpAuthLayer,
  // McpController lives in infra so SessionRunner can merge MCP tools into
  // the LLM tool catalog on every turn.
  mcpLayer(process.cwd()).pipe(Layer.provide(mcpAuthLayer)),
  toolPermissionEnforcerLayer.pipe(Layer.provide(modelReposLayer)),
)

// SessionRunner needs LLM, repos, ToolRegistry, and ModelResolver — all in infraLayer.
const sessionRunnerWithDeps = sessionRunnerLayer.pipe(Layer.provide(infraLayer))

// Top-level controllers — need repos and SessionRunner.
// (McpController lives in infraLayer so SessionRunner can see it.)
const controllersLayer = sessionControllerLayer.pipe(
  Layer.provide(Layer.merge(infraLayer, sessionRunnerWithDeps)),
)

// Populate subagentRuntime after controllers are ready. Depends on
// SessionController + SessionRunner (from controllersLayer/sessionRunnerWithDeps)
// and EventRepository (from infraLayer via modelReposLayer).
const subagentWiringLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sessions = yield* SessionController
    const runner = yield* SessionRunner
    const events = yield* EventRepository
    subagentRuntime.current = { sessions, runner, events }
  }),
).pipe(Layer.provide(Layer.merge(controllersLayer, Layer.merge(infraLayer, sessionRunnerWithDeps))))

export const ProductionLayer: Layer.Layer<any, any, never> = Layer.mergeAll(
  infraLayer,
  sessionRunnerWithDeps,
  controllersLayer,
  subagentWiringLayer,
) as unknown as Layer.Layer<any, any, never>

// ---------------------------------------------------------------------------
// Test Layer
// ---------------------------------------------------------------------------

// Infrastructure for tests — in-memory repos.
const testInfraLayer = Layer.mergeAll(
  TestModelLayer,
  llmClientLayer,
  agentLayer,
  builtinToolsLayer,
  mcpAuthLayer,
  // McpController in infra so tests exercising SessionRunner can wire tools.
  mcpLayer(process.cwd()).pipe(Layer.provide(mcpAuthLayer)),
  testModelResolverLayer,
  toolPermissionEnforcerLayer.pipe(Layer.provide(TestModelLayer)),
)

const testSessionRunnerWithDeps = sessionRunnerLayer.pipe(Layer.provide(testInfraLayer))

const testControllersLayer = sessionControllerLayer.pipe(
  Layer.provide(Layer.merge(testInfraLayer, testSessionRunnerWithDeps)),
)

const testSubagentWiringLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sessions = yield* SessionController
    const runner = yield* SessionRunner
    const events = yield* EventRepository
    subagentRuntime.current = { sessions, runner, events }
  }),
).pipe(Layer.provide(Layer.merge(testControllersLayer, Layer.merge(testInfraLayer, testSessionRunnerWithDeps))))

export const TestLayer: Layer.Layer<any, any, never> = Layer.mergeAll(
  testInfraLayer,
  testSessionRunnerWithDeps,
  testControllersLayer,
  testSubagentWiringLayer,
) as unknown as Layer.Layer<any, any, never>
