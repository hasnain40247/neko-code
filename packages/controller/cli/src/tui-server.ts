/**
 * tui-server.ts — in-process HTTP server for the TUI client.
 *
 * Implements the neko-compatible REST + SSE API that @gco/view-tui
 * connects to. Routes are backed by real Effect services passed in from
 * TuiCommand (which runs them inside a single Effect scope so their
 * lifecycle stays tied to the TUI session).
 */

import type { Server } from "bun"
import { execSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { SlashCommand } from "@gco/schema"

// ─── Service interface ────────────────────────────────────────────────────────

export interface TuiServerServices {
  readonly createSession: (input: {
    projectID: string
    title?: string
    agent?: string
    model?: { id: string; providerID: string }
    location: { directory: string }
  }) => Promise<any>
  readonly getSession: (id: string) => Promise<any>
  readonly listSessions: (projectID: string) => Promise<any[]>
  readonly prompt: (input: {
    sessionID: string
    text: string
    files?: any[]
    parts?: any[]
    id?: string
  }) => Promise<void>
  readonly loadEvents: (sessionID: string) => Promise<any[]>
  readonly archiveSession: (sessionID: string) => Promise<void>
  readonly abortSession: (sessionID: string) => Promise<void>
  readonly compactSession: (sessionID: string) => Promise<void>
  readonly updateSession: (sessionID: string, patch: { title?: string; agent?: string; model?: { id: string; providerID: string } }) => Promise<any>
  readonly forkSession: (sessionID: string, opts?: { messageID?: string; partID?: string }) => Promise<any>
  readonly revertSession: (sessionID: string, messageID: string) => Promise<void>
  readonly listAgents: () => Promise<any[]>
  readonly listSkills: () => Promise<Array<{ id: string; name: string; description: string; body: string }>>
  readonly listTools: () => Promise<Array<{ name: string; description: string }>>
  readonly listMcpServers: () => Promise<Array<{ id: string; name: string; status: string; error?: string; config: any; tools: string[] }>>
  readonly listProjects: () => Promise<Array<{ id: string; worktree: string; time: { created: number; updated: number } }>>
  readonly addMcp: (name: string, config: { type: "local"; command: string[]; cwd?: string; environment?: Record<string, string>; timeout?: number } | { type: "remote"; url: string; headers?: Record<string, string>; timeout?: number }) => Promise<Record<string, { status: string; error?: string }>>
  readonly addAgent: (name: string, override: { description?: string; system?: string; mode?: "primary" | "subagent" | "all"; model?: string }) => Promise<void>
  readonly removeAgent: (name: string) => Promise<void>
  readonly connectMcp: (name: string) => Promise<void>
  readonly disconnectMcp: (name: string) => Promise<void>
  readonly removeMcp: (name: string) => Promise<void>
  readonly listCredentials: () => Promise<Array<{ integrationID: string }>>
  readonly setProviderKey: (providerID: string, key: string) => Promise<void>
  readonly listQuestions: (sessionID: string) => Promise<Array<{ id: string; sessionID: string; questions: readonly any[]; tool: any }>>
  readonly replyQuestion: (requestID: string, answers: ReadonlyArray<ReadonlyArray<string>>) => Promise<void>
  readonly rejectQuestion: (requestID: string) => Promise<void>
  readonly listPermissions: (sessionID?: string) => Promise<Array<{ id: string; sessionID: string; permission: string; patterns: readonly string[]; always: readonly string[]; metadata: Record<string, unknown>; tool?: { messageID: string; callID: string } }>>
  readonly replyPermission: (requestID: string, reply: "once" | "always" | "reject") => Promise<void>
}

// In-memory config override (set via PATCH /config)
let configOverride: Record<string, unknown> = {}

// ─── SSE helpers ─────────────────────────────────────────────────────────────

type SSESend = (raw: string) => void
const sseClients = new Set<SSESend>()

export function broadcastSSE(globalEvent: object): void {
  const raw = `data: ${JSON.stringify(globalEvent)}\n\n`
  for (const send of sseClients) send(raw)
}

// Per-session polling — starts when prompt is submitted, stops after idle.
const activePollers = new Map<string, () => void>()

// In-memory staging area for revert operations (sessionID → { messageID, partID })
const revertStage = new Map<string, { messageID: string; partID?: string }>()

async function startEventPoller(
  sessionID: string,
  directory: string,
  loadEvents: (id: string) => Promise<any[]>,
  getSession: (id: string) => Promise<any>,
  /**
   * Number of events already on disk *before* this turn's prompt was admitted.
   * Callers that admit a prompt just before starting the poller MUST pass this
   * (captured pre-admit) so `prompt.admitted` is processed by the poller. With
   * local (SQLite + fs) storage the write completes before the poller's own
   * `loadEvents` fires, so falling back to `existing.length` would skip past
   * the new prompt event. Firestore's latency masked this before the local
   * migration.
   */
  seedSeenCount?: number,
): Promise<void> {
  if (activePollers.has(sessionID)) return
  let running = true
  activePollers.set(sessionID, () => { running = false })

  // Seed from existing events so we only process events from THIS turn.
  const existing = await loadEvents(sessionID).catch(() => [] as any[])
  let seenCount = seedSeenCount ?? existing.length
  let idleMs = 0
  const IDLE_STOP_MS = 60_000  // stop polling 60 s after last event
  const projector = createStreamingProjector(sessionID, directory)

  // Track step starts vs ends so multi-step turns (tool call → follow-up text)
  // are fully drained before the poller stops.
  let stepStarts = 0
  let stepEnds = 0
  // Track the finish reason of the last step. If it was "tool-calls" or
  // "tool_calls", the runner will spin up another turn — we must keep
  // polling so its events reach the TUI.
  let lastStepFinish: string | undefined

  while (running) {
    const events = await loadEvents(sessionID).catch((err) => {
      console.error("[tui-server] loadEvents error:", err)
      return [] as any[]
    })
    const newEvents = events.slice(seenCount)
    seenCount = events.length

    if (newEvents.length > 0) {
      idleMs = 0
      for (const ev of newEvents) {
        projector.handle(ev)
        if (ev.type === "session.next.step.started") stepStarts++
        if (
          ev.type === "session.next.step.ended" ||
          ev.type === "session.next.step.failed"
        ) {
          stepEnds++
          lastStepFinish = (ev.data as any)?.finish ?? lastStepFinish
        }
        // When the parent spawns a subagent, kick off a poller for the child
        // session so its events also flow through the SSE stream. The TUI
        // uses the payload broadcast by the projector to nest the child's
        // transcript under the spawning tool call.
        if (ev.type === "session.next.subagent.spawned") {
          const childSid = (ev.data as any)?.childSessionID as string | undefined
          if (childSid) {
            void startEventPoller(childSid, directory, loadEvents, getSession).catch(
              (e) => console.error("[tui-server] child poller failed:", e),
            )
          }
        }
      }

      // Only stop when every started step has ended AND the last step wasn't
      // a tool-call step (which triggers a follow-up turn we haven't seen yet).
      const isContinuing =
        lastStepFinish === "tool-calls" || lastStepFinish === "tool_calls"
      const done = stepStarts > 0 && stepEnds >= stepStarts && !isContinuing
      if (done) {
        // Drain any trailing events, then stop
        await new Promise((r) => setTimeout(r, 500))
        const finalEvents = await loadEvents(sessionID).catch(() => [] as any[])
        for (const ev of finalEvents.slice(seenCount)) {
          projector.handle(ev)
        }
        // Refresh the session list entry
        const sess = await getSession(sessionID).catch(() => null)
        broadcastSSE({
          directory,
          payload: {
            id: `upd_${Date.now()}`,
            type: "session.updated",
            properties: { sessionID, info: sess ? sessionToSDK(sess) : { id: sessionID } },
          },
        })
        running = false
        break
      }
    } else {
      idleMs += 150
      if (idleMs >= IDLE_STOP_MS) {
        running = false
        break
      }
    }

    await new Promise((r) => setTimeout(r, 150))
  }

  activePollers.delete(sessionID)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })

// ─── OpenAPI spec ─────────────────────────────────────────────────────────────

function buildOpenApiSpec(port: number): object {
  return {
    openapi: "3.0.3",
    info: {
      title: "neko API",
      version: "0.1.0",
      description: "In-process HTTP API served by the neko TUI server. Poll `GET /debug/session/{id}/events` to read LLM responses after submitting a prompt.",
    },
    servers: [{ url: `http://localhost:${port}`, description: "Local TUI server" }],
    tags: [
      { name: "Health & Config" },
      { name: "Sessions" },
      { name: "Debug" },
      { name: "Skills" },
      { name: "MCP" },
      { name: "VCS" },
      { name: "Agents & Commands" },
      { name: "Projects" },
    ],
    paths: {
      "/global/health": {
        get: { tags: ["Health & Config"], summary: "Health check", responses: { "200": { description: "OK" } } },
      },
      "/global/event": {
        get: { tags: ["Health & Config"], summary: "SSE event stream", description: "Server-Sent Events stream. Emits session lifecycle events and LLM turn events in real time.", responses: { "200": { description: "SSE stream (text/event-stream)" } } },
      },
      "/config": {
        get: {
          tags: ["Health & Config"], summary: "Get config",
          responses: { "200": { description: "Current config", content: { "application/json": { schema: { type: "object", properties: { model: { type: "string", example: "deepseek/deepseek-v4-flash" } } } } } } },
        },
        patch: {
          tags: ["Health & Config"], summary: "Update config (persists model to neko.json)",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { model: { type: "string", example: "deepseek/deepseek-v4-flash" } } } } } },
          responses: { "200": { description: "Merged config" } },
        },
      },
      "/provider": {
        get: { tags: ["Health & Config"], summary: "List providers with model catalog and connection status", responses: { "200": { description: "Provider list" } } },
      },
      "/provider/auth": {
        get: { tags: ["Health & Config"], summary: "Provider auth methods", responses: { "200": { description: "Auth info" } } },
      },
      "/path": {
        get: { tags: ["Health & Config"], summary: "Resolved filesystem paths", responses: { "200": { description: "Paths object with home, state, config, worktree, directory" } } },
      },
      "/session": {
        get: {
          tags: ["Sessions"], summary: "List sessions for the current project",
          responses: { "200": { description: "Array of session objects" } },
        },
        post: {
          tags: ["Sessions"], summary: "Create a session",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    agent: { type: "string", example: "build" },
                    model: { type: "object", properties: { id: { type: "string", example: "deepseek-v4-flash" }, providerID: { type: "string", example: "deepseek" } } },
                    directory: { type: "string" },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Created session" } },
        },
      },
      "/session/status": {
        get: { tags: ["Sessions"], summary: "Map of sessionID → running|idle", responses: { "200": { description: "Status map" } } },
      },
      "/session/{id}": {
        get: {
          tags: ["Sessions"], summary: "Get a session",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Session object" }, "404": { description: "Not found" } },
        },
      },
      "/session/{id}/prompt": {
        post: {
          tags: ["Sessions"], summary: "Submit a prompt — LLM runs in background",
          description: "Returns immediately with the user message ID. Poll `GET /debug/session/{id}/events` until you see a `session.next.text.ended` event — the reply is in `data.text`.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text"], properties: { text: { type: "string", example: "What files are in this directory?" }, files: { type: "array", items: { type: "object" } } } } } } },
          responses: { "200": { description: "User message envelope" } },
        },
      },
      "/session/{id}/message": {
        get: {
          tags: ["Sessions"], summary: "Full conversation history projected from Firestore events",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Array of message objects with role and parts" } },
        },
      },
      "/session/{id}/diff": {
        get: {
          tags: ["Sessions"], summary: "git status for the session working directory",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Array of changed file objects" } },
        },
      },
      "/session/{id}/todo": {
        get: {
          tags: ["Sessions"], summary: "Todo items (not yet wired — returns [])",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Empty array" } },
        },
      },
      "/session/{id}/abort": {
        post: {
          tags: ["Sessions"], summary: "Interrupt the running LLM turn",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "OK" } },
        },
      },
      "/debug/session/{id}/events": {
        get: {
          tags: ["Debug"], summary: "Raw Firestore events for a session",
          description: "Returns all persisted events in sequence order. Use `data.text` on `session.next.text.ended` events to read LLM replies.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "{ sessionID, count, events[] }" } },
        },
      },
      "/debug/session/abort-all": {
        post: { tags: ["Debug"], summary: "Abort all active sessions", responses: { "200": { description: "{ aborted: number }" } } },
      },
      "/skill": {
        get: {
          tags: ["Skills"], summary: "List skills defined as .md files in the skills/ directory",
          responses: { "200": { description: "Array of { name, description, body }" } },
        },
        post: {
          tags: ["Skills"], summary: "Create a new skill — writes skills/<name>.md",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name", "body"],
                  properties: {
                    name: { type: "string", example: "reviewer" },
                    body: { type: "string", example: "You are a senior code reviewer..." },
                  },
                },
              },
            },
          },
          responses: { "201": { description: "Created skill" }, "400": { description: "Validation error" } },
        },
      },
      "/skill/{id}": {
        get: {
          tags: ["Skills"], summary: "Get a single skill by id",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "{ id, name, description, body }" }, "404": { description: "Not found" } },
        },
        delete: {
          tags: ["Skills"], summary: "Delete skills/<id>.md",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "{ id, removed: true }" } },
        },
      },
      "/tool": {
        get: { tags: ["Skills"], summary: "List registered tools from ToolRegistry", responses: { "200": { description: "Array of { name, description }" } } },
      },
      "/mcp": {
        get: { tags: ["MCP"], summary: "List MCP servers with status, config, and tools", responses: { "200": { description: "{ servers[], connected: number }" } } },
        post: {
          tags: ["MCP"], summary: "Add and connect a new MCP server — persists to neko.json",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    {
                      title: "Local stdio",
                      type: "object",
                      required: ["name", "type", "command"],
                      properties: {
                        name: { type: "string", example: "filesystem" },
                        type: { type: "string", enum: ["local"] },
                        command: { type: "array", items: { type: "string" }, example: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
                        cwd: { type: "string" },
                        environment: { type: "object", additionalProperties: { type: "string" } },
                        timeout: { type: "integer" },
                      },
                    },
                    {
                      title: "Remote SSE",
                      type: "object",
                      required: ["name", "type", "url"],
                      properties: {
                        name: { type: "string", example: "my-api" },
                        type: { type: "string", enum: ["remote"] },
                        url: { type: "string", example: "https://example.com/mcp" },
                        headers: { type: "object", additionalProperties: { type: "string" } },
                        timeout: { type: "integer" },
                      },
                    },
                  ],
                },
              },
            },
          },
          responses: { "200": { description: "Server status after connection attempt" }, "400": { description: "Validation error" } },
        },
      },
      "/mcp/{name}/connect": {
        post: {
          tags: ["MCP"], summary: "Connect a pre-configured MCP server",
          parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "{ name, status: 'connecting' }" } },
        },
      },
      "/mcp/{id}": {
        get: {
          tags: ["MCP"], summary: "Get a single MCP server by id",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Server object with status, config, and tools" }, "404": { description: "Not found" } },
        },
        delete: {
          tags: ["MCP"], summary: "Disconnect and remove an MCP server from neko.json",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "{ name, removed: true }" } },
        },
      },
      "/vcs": {
        get: { tags: ["VCS"], summary: "Git repo info { type, root, branch, commit }", responses: { "200": { description: "Git info or null" } } },
      },
      "/vcs/status": {
        get: { tags: ["VCS"], summary: "Parsed git status --porcelain", responses: { "200": { description: "Array of { file, staged, unstaged, untracked, status }" } } },
      },
      "/vcs/diff": {
        get: {
          tags: ["VCS"], summary: "Raw git diff",
          parameters: [{ name: "staged", in: "query", schema: { type: "boolean" }, description: "true for staged diff" }],
          responses: { "200": { description: "{ diff: string }" } },
        },
      },
      "/agent": {
        get: { tags: ["Agents & Commands"], summary: "List configured agents", responses: { "200": { description: "Array of agent objects" } } },
      },
      "/command": {
        get: { tags: ["Agents & Commands"], summary: "List CLI shell subcommands (yargs verbs)", responses: { "200": { description: "Array of { name, description }" } } },
      },
      "/slash-command": {
        get: { tags: ["Agents & Commands"], summary: "List TUI slash-palette actions", responses: { "200": { description: "Array of { name, description, aliases? }" } } },
      },
      "/lsp": {
        get: { tags: ["Agents & Commands"], summary: "LSP status (not wired — returns { running: false })", responses: { "200": { description: "LSP state" } } },
      },
      "/formatter": {
        get: { tags: ["Agents & Commands"], summary: "Formatter status (not wired — returns { running: false })", responses: { "200": { description: "Formatter state" } } },
      },
      "/project": {
        get: { tags: ["Projects"], summary: "List projects from Firestore", responses: { "200": { description: "Array of project objects" } } },
      },
      "/project/current": {
        get: { tags: ["Projects"], summary: "Current working directory as a project", responses: { "200": { description: "Project object" } } },
      },
      "/project/{id}/directories": {
        get: {
          tags: ["Projects"], summary: "Directories for a project",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Array of { directory }" } },
        },
      },
      "/permission": {
        get: { tags: ["Agents & Commands"], summary: "Pending tool permission requests", responses: { "200": { description: "Array of requests" } } },
      },
      "/question": {
        get: { tags: ["Agents & Commands"], summary: "Pending question requests", responses: { "200": { description: "Array of questions" } } },
      },
    },
  }
}

const SWAGGER_HTML = (specUrl: string) => `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>neko API</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  <style>body { margin: 0; } .swagger-ui .topbar { background: #1a1a2e; } .swagger-ui .topbar-wrapper img { content: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>'); } .swagger-ui .topbar-wrapper .link::after { content: 'neko API'; color: white; font-weight: bold; font-size: 1.2em; margin-left: 8px; }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '${specUrl}',
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      plugins: [SwaggerUIBundle.plugins.DownloadUrl],
      layout: 'BaseLayout',
      tryItOutEnabled: true,
      requestInterceptor: (req) => { req.credentials = 'include'; return req; },
    })
  </script>
</body>
</html>`

function sessionToSDK(info: any): object {
  const toMs = (dt: unknown): number => {
    if (typeof dt === "number") return dt
    if (dt && typeof (dt as any).epochMillis === "number") return (dt as any).epochMillis
    if (dt instanceof Date) return dt.getTime()
    return Date.now()
  }
  return {
    id: String(info.id),
    slug: String(info.id),
    projectID: String(info.projectID),
    directory: info.location?.directory ?? "",
    title: info.title ?? "Untitled",
    version: "0.1.0",
    cost: info.cost ?? 0,
    tokens: info.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    model: info.model
      ? { id: info.model.id, providerID: (info.model as any).providerID ?? "deepseek" }
      : { id: "deepseek-v4-flash", providerID: "deepseek" },
    time: {
      created: toMs(info.time?.created),
      updated: toMs(info.time?.updated),
    },
  }
}

function deepseekProvider(): object {
  const connected = Boolean(process.env.DEEPSEEK_API_KEY)
  return {
    id: "deepseek",
    name: "DeepSeek",
    source: "config",
    env: ["DEEPSEEK_API_KEY"],
    key: connected ? "***" : undefined,
    options: {},
    models: {
      "deepseek-v4-flash": {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        release: "2025",
        context: 65536,
        limit: { context: 65536, output: 8192 },
      },
      "deepseek-v4-pro": {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        release: "2025",
        context: 65536,
        limit: { context: 65536, output: 8192 },
      },
    },
  }
}

function anthropicProvider(): object {
  const connected = Boolean(process.env.ANTHROPIC_API_KEY)
  return {
    id: "anthropic",
    name: "Anthropic",
    source: "config",
    env: ["ANTHROPIC_API_KEY"],
    key: connected ? "***" : undefined,
    options: {},
    models: {
      "claude-opus-4-7":   { id: "claude-opus-4-7",   name: "Claude Opus 4.7",   release: "2026", context: 200000, limit: { context: 200000, output: 32000 } },
      "claude-sonnet-4-6": { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", release: "2026", context: 200000, limit: { context: 200000, output: 16000 } },
      "claude-haiku-4-5":  { id: "claude-haiku-4-5",  name: "Claude Haiku 4.5",  release: "2025", context: 200000, limit: { context: 200000, output: 8000  } },
    },
  }
}

function ollamaProvider(): object {
  return {
    id: "ollama",
    name: "Ollama",
    source: "local",
    env: [],
    options: {},
    models: {},
  }
}

function openaiProvider(): object {
  const connected = Boolean(process.env.OPENAI_API_KEY)
  return {
    id: "openai",
    name: "OpenAI",
    source: "config",
    env: ["OPENAI_API_KEY"],
    key: connected ? "***" : undefined,
    options: {},
    models: {
      "gpt-5.6":      { id: "gpt-5.6",      name: "GPT-5.6",       release: "2026", context: 400000, limit: { context: 400000, output: 32000 } },
      "gpt-5.4":      { id: "gpt-5.4",      name: "GPT-5.4",       release: "2026", context: 400000, limit: { context: 400000, output: 32000 } },
      "gpt-5.4-mini": { id: "gpt-5.4-mini", name: "GPT-5.4 mini",  release: "2026", context: 400000, limit: { context: 400000, output: 16000 } },
      "o4-mini":      { id: "o4-mini",      name: "o4-mini",       release: "2025", context: 200000, limit: { context: 200000, output: 16000 } },
    },
  }
}

function providerListResponse(connectedIntegrations: string[] = []): object {
  const ds = deepseekProvider() as any
  const ap = anthropicProvider() as any
  const oa = openaiProvider() as any
  const ol = ollamaProvider() as any
  const all = [ds, ap, oa, ol]
  const connected = all
    .filter((p) => {
      if (p.id === "deepseek")  return Boolean(process.env.DEEPSEEK_API_KEY)  || connectedIntegrations.includes("deepseek")
      if (p.id === "anthropic") return Boolean(process.env.ANTHROPIC_API_KEY) || connectedIntegrations.includes("anthropic")
      if (p.id === "openai")    return Boolean(process.env.OPENAI_API_KEY)    || connectedIntegrations.includes("openai")
      if (p.id === "ollama")    return true
      return false
    })
    .map((p) => p.id)
  return {
    all,
    providers: all,
    default: { deepseek: "deepseek-v4-flash", anthropic: "claude-sonnet-4-6", openai: "gpt-5.4-mini" },
    connected,
  }
}

// ─── Event → message projection ───────────────────────────────────────────────

const toMs = (dt: unknown): number => {
  if (typeof dt === "number") return dt
  if (dt && typeof (dt as any).epochMillis === "number") return (dt as any).epochMillis
  if (typeof dt === "string") return new Date(dt).getTime()
  return Date.now()
}

function textContent(content: any[]): string {
  return (content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
}

// Returns MessageWithParts[] — the shape the SDK sync context expects.
function projectEventsToMessages(events: any[], sessionID: string): { info: any; parts: any[] }[] {
  const result: { info: any; parts: any[] }[] = []
  let currentMsg: { info: any; parts: any[] } | null = null
  const toolTimes = new Map<string, number>()
  let parentID = ""

  for (const event of events) {
    const data = event.data ?? {}
    const ts = toMs(data.timestamp)

    switch (event.type) {
      case "session.next.prompt.admitted":
      case "session.next.prompted": {
        if (currentMsg) { result.push(currentMsg); currentMsg = null }
        const msgID: string = data.messageID ?? `msg_u_${Date.now()}`
        parentID = msgID
        result.push({
          info: {
            id: msgID,
            sessionID,
            role: "user",
            time: { created: ts },
            agent: "build",
            model: { providerID: "unknown", modelID: "unknown" },
          },
          parts: [{
            id: `txt_${msgID}`,
            sessionID,
            messageID: msgID,
            type: "text",
            text: data.prompt?.text ?? "",
          }],
        })
        break
      }

      case "session.next.step.started": {
        if (currentMsg) { result.push(currentMsg) }
        const msgID: string = data.assistantMessageID ?? `msg_a_${Date.now()}`
        currentMsg = {
          info: {
            id: msgID,
            sessionID,
            role: "assistant",
            time: { created: ts },
            parentID,
            modelID: data.model?.id ?? "unknown",
            providerID: data.model?.providerID ?? "unknown",
            mode: "one-shot",
            agent: data.agent ?? "build",
            path: { cwd: ".", root: "." },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [],
        }
        break
      }

      case "session.next.text.ended": {
        if (currentMsg && data.text) {
          const msgID = currentMsg.info.id
          currentMsg.parts.push({
            id: data.textID ?? `txt_${Date.now()}`,
            sessionID,
            messageID: msgID,
            type: "text",
            text: data.text,
          })
        }
        break
      }

      case "session.next.reasoning.ended": {
        if (currentMsg && data.text) {
          const msgID = currentMsg.info.id
          currentMsg.parts.push({
            id: data.reasoningID ?? `rsn_${Date.now()}`,
            sessionID,
            messageID: msgID,
            type: "reasoning",
            text: data.text,
            time: { start: ts, end: ts },
          })
        }
        break
      }

      case "session.next.tool.input.started": {
        toolTimes.set(data.callID, ts)
        if (currentMsg) {
          const msgID = currentMsg.info.id
          const callID: string = data.callID
          currentMsg.parts.push({
            id: callID,
            sessionID,
            messageID: msgID,
            type: "tool",
            callID,
            tool: data.name ?? "unknown",
            state: { status: "running", input: {}, time: { start: ts } },
          })
        }
        break
      }

      case "session.next.tool.called": {
        if (currentMsg) {
          const msgID = currentMsg.info.id
          const callID: string = data.callID
          const startMs = toolTimes.get(callID) ?? ts
          toolTimes.set(callID, startMs)
          const existing = currentMsg.parts.find((p: any) => p.id === callID)
          const part = {
            id: callID,
            sessionID,
            messageID: msgID,
            type: "tool",
            callID,
            tool: data.tool ?? existing?.tool ?? "unknown",
            state: { status: "running", input: data.input ?? {}, time: { start: startMs } },
          }
          if (existing) {
            Object.assign(existing, part)
          } else {
            currentMsg.parts.push(part)
          }
        }
        break
      }

      case "session.next.tool.progress": {
        if (currentMsg) {
          const existing = currentMsg.parts.find((p: any) => p.id === data.callID)
          if (existing) {
            existing.state = {
              ...existing.state,
              metadata: { output: textContent(data.content), ...data.structured },
            }
          }
        }
        break
      }

      case "session.next.tool.success": {
        if (currentMsg) {
          const existing = currentMsg.parts.find((p: any) => p.id === data.callID)
          if (existing) {
            const startMs = toolTimes.get(data.callID) ?? ts
            existing.state = {
              status: "completed",
              input: existing.state?.input ?? data.input ?? {},
              output: textContent(data.content),
              title: existing.tool ?? "unknown",
              metadata: data.structured ?? {},
              time: { start: startMs, end: ts },
            }
          }
        }
        break
      }

      case "session.next.tool.failed": {
        if (currentMsg) {
          const existing = currentMsg.parts.find((p: any) => p.id === data.callID)
          if (existing) {
            const startMs = toolTimes.get(data.callID) ?? ts
            existing.state = {
              status: "error",
              input: existing.state?.input ?? {},
              error: data.error?.message ?? "Tool failed",
              time: { start: startMs, end: ts },
            }
          }
        }
        break
      }

      case "session.next.step.ended": {
        if (currentMsg) {
          currentMsg.info.time.completed = ts
          currentMsg.info.finish = data.finish ?? "end-turn"
          currentMsg.info.cost = data.cost ?? 0
          if (data.tokens) currentMsg.info.tokens = data.tokens
          result.push(currentMsg)
          currentMsg = null
          toolTimes.clear()
        }
        break
      }

      case "session.next.step.failed": {
        if (currentMsg) {
          currentMsg.info.time.completed = ts
          currentMsg.info.error = { name: "UnknownError", data: { message: data.error?.message ?? "Step failed" } }
          result.push(currentMsg)
          currentMsg = null
          toolTimes.clear()
        }
        break
      }
    }
  }
  if (currentMsg) result.push(currentMsg)
  return result
}

// ─── Streaming projector for real-time SSE events ─────────────────────────────

function createStreamingProjector(sessionID: string, directory: string) {
  let parentID = ""
  let currentAssistantID = ""
  let currentAssistantCreatedMs = 0
  let providerID = "unknown"
  let modelID = "unknown"
  let agent = "build"
  const toolTimes = new Map<string, number>()
  const toolInputs = new Map<string, Record<string, unknown>>()
  const toolNames = new Map<string, string>()

  const bcast = (type: string, properties: Record<string, unknown>) =>
    broadcastSSE({ directory, payload: { id: `evt_${Date.now()}`, type, properties } })

  return {
    handle(ev: any) {
      const data = ev.data ?? {}
      const ts = toMs(data.timestamp)

      switch (ev.type) {
        case "session.next.prompt.admitted":
        case "session.next.prompted": {
          const msgID: string = data.messageID ?? `msg_u_${Date.now()}`
          parentID = msgID
          const info = {
            id: msgID, sessionID, role: "user",
            time: { created: ts },
            agent, model: { providerID, modelID },
          }
          bcast("message.updated", { info })
          bcast("message.part.updated", {
            part: { id: `txt_${msgID}`, sessionID, messageID: msgID, type: "text", text: data.prompt?.text ?? "" },
          })
          bcast("session.status", { sessionID, status: { type: "running" } })
          break
        }

        case "session.next.step.started": {
          currentAssistantID = data.assistantMessageID ?? `msg_a_${Date.now()}`
          currentAssistantCreatedMs = ts
          modelID = data.model?.id ?? modelID
          providerID = data.model?.providerID ?? providerID
          agent = data.agent ?? agent
          bcast("message.updated", {
            info: {
              id: currentAssistantID, sessionID, role: "assistant",
              time: { created: ts },
              parentID, modelID, providerID,
              mode: "one-shot", agent,
              path: { cwd: ".", root: "." },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          })
          break
        }

        case "session.next.text.ended": {
          const msgID = data.assistantMessageID ?? currentAssistantID
          bcast("message.part.updated", {
            part: {
              id: data.textID ?? `txt_${Date.now()}`, sessionID, messageID: msgID,
              type: "text", text: data.text ?? "",
              time: { start: ts, end: ts },
            },
          })
          break
        }

        case "session.next.reasoning.ended": {
          const msgID = data.assistantMessageID ?? currentAssistantID
          bcast("message.part.updated", {
            part: {
              id: data.reasoningID ?? `rsn_${Date.now()}`, sessionID, messageID: msgID,
              type: "reasoning", text: data.text ?? "",
              time: { start: ts, end: ts },
            },
          })
          break
        }

        case "session.next.tool.input.started": {
          const callID: string = data.callID
          toolTimes.set(callID, ts)
          toolNames.set(callID, data.name ?? "unknown")
          const msgID = data.assistantMessageID ?? currentAssistantID
          bcast("message.part.updated", {
            part: {
              id: callID, sessionID, messageID: msgID,
              type: "tool", callID,
              tool: data.name ?? "unknown",
              state: { status: "running", input: {}, time: { start: ts } },
            },
          })
          break
        }

        case "session.next.tool.called": {
          const callID: string = data.callID
          const startMs = toolTimes.get(callID) ?? ts
          toolTimes.set(callID, startMs)
          toolInputs.set(callID, data.input ?? {})
          toolNames.set(callID, data.tool ?? toolNames.get(callID) ?? "unknown")
          const msgID = data.assistantMessageID ?? currentAssistantID
          bcast("message.part.updated", {
            part: {
              id: callID, sessionID, messageID: msgID,
              type: "tool", callID,
              tool: toolNames.get(callID)!,
              state: { status: "running", input: data.input ?? {}, time: { start: startMs } },
            },
          })
          // When the question tool is called, emit question.asked so the TUI
          // shows the QuestionPrompt. Use callID as requestID so reply/reject
          // can route back to the blocked Effect fiber via QuestionStore.
          if (data.tool === "question" && data.input?.questions) {
            bcast("question.asked", {
              id: callID,
              sessionID,
              questions: data.input.questions,
              tool: { messageID: msgID, callID },
            })
          }
          break
        }

        case "session.next.tool.progress": {
          const callID: string = data.callID
          const msgID = data.assistantMessageID ?? currentAssistantID
          bcast("message.part.updated", {
            part: {
              id: callID, sessionID, messageID: msgID,
              type: "tool", callID,
              tool: toolNames.get(callID) ?? "unknown",
              state: {
                status: "running",
                input: toolInputs.get(callID) ?? {},
                title: toolNames.get(callID) ?? "unknown",
                metadata: { output: textContent(data.content), ...data.structured },
                time: { start: toolTimes.get(callID) ?? ts },
              },
            },
          })
          break
        }

        case "session.next.tool.success": {
          const callID: string = data.callID
          const startMs = toolTimes.get(callID) ?? ts
          const msgID = data.assistantMessageID ?? currentAssistantID
          bcast("message.part.updated", {
            part: {
              id: callID, sessionID, messageID: msgID,
              type: "tool", callID,
              tool: toolNames.get(callID) ?? "unknown",
              state: {
                status: "completed",
                input: toolInputs.get(callID) ?? {},
                output: textContent(data.content),
                title: toolNames.get(callID) ?? "unknown",
                metadata: data.structured ?? {},
                time: { start: startMs, end: ts },
              },
            },
          })
          // Clear question from TUI store if this was a question tool call
          if (toolNames.get(callID) === "question") {
            bcast("question.replied", { sessionID, requestID: callID, answers: [] })
          }
          break
        }

        case "session.next.tool.failed": {
          const callID: string = data.callID
          const startMs = toolTimes.get(callID) ?? ts
          const msgID = data.assistantMessageID ?? currentAssistantID
          bcast("message.part.updated", {
            part: {
              id: callID, sessionID, messageID: msgID,
              type: "tool", callID,
              tool: toolNames.get(callID) ?? "unknown",
              state: {
                status: "error",
                input: toolInputs.get(callID) ?? {},
                error: data.error?.message ?? "Tool failed",
                time: { start: startMs, end: ts },
              },
            },
          })
          // Clear question from TUI store if the question tool failed/was rejected
          if (toolNames.get(callID) === "question") {
            bcast("question.rejected", { sessionID, requestID: callID })
          }
          break
        }

        case "session.next.step.ended": {
          const msgID = data.assistantMessageID ?? currentAssistantID
          bcast("message.updated", {
            info: {
              id: msgID, sessionID, role: "assistant",
              time: { created: currentAssistantCreatedMs || ts, completed: ts },
              parentID, modelID, providerID,
              mode: "one-shot", agent,
              path: { cwd: ".", root: "." },
              finish: data.finish ?? "end-turn",
              cost: data.cost ?? 0,
              tokens: data.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          })
          // Only mark session idle when the LLM is truly done. If the step
          // ended because the model wants to call more tools, the runner will
          // spin up another turn — keep the spinner running through it.
          const finish = data.finish
          const willContinue = finish === "tool-calls" || finish === "tool_calls"
          if (!willContinue) {
            bcast("session.status", { sessionID, status: { type: "idle" } })
          }
          toolTimes.clear()
          toolInputs.clear()
          toolNames.clear()
          break
        }

        case "session.next.step.failed": {
          const msgID = data.assistantMessageID ?? currentAssistantID
          bcast("message.updated", {
            info: {
              id: msgID, sessionID, role: "assistant",
              time: { created: currentAssistantCreatedMs || ts, completed: ts },
              parentID, modelID, providerID,
              mode: "one-shot", agent,
              path: { cwd: ".", root: "." },
              error: { name: "UnknownError", data: { message: data.error?.message ?? "Step failed" } },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          })
          bcast("session.status", { sessionID, status: { type: "idle" } })
          toolTimes.clear()
          toolInputs.clear()
          toolNames.clear()
          break
        }

        // Announce subagent lifecycle to the TUI so it can nest the child's
        // transcript under the spawning tool call. Fields mirror the internal
        // event data (childSessionID, subagentType, toolCallID, ...).
        case "session.next.subagent.spawned": {
          bcast("session.subagent.spawned", {
            parentSessionID: sessionID,
            childSessionID: data.childSessionID,
            subagentType: data.subagentType,
            toolCallID: data.toolCallID,
            description: data.description,
            time: { created: ts },
          })
          break
        }
        case "session.next.subagent.ended": {
          bcast("session.subagent.ended", {
            parentSessionID: sessionID,
            childSessionID: data.childSessionID,
            toolCallID: data.toolCallID,
            state: data.state,
            time: { completed: ts },
          })
          break
        }
      }
    },
  }
}

// ─── Git helpers ──────────────────────────────────────────────────────────────

function gitExec(cmd: string, cwd: string): string {
  try { return execSync(cmd, { cwd, encoding: "utf8", timeout: 5000 }).trim() } catch { return "" }
}

function gitInfo(cwd: string): object | null {
  try {
    const root = gitExec("git rev-parse --show-toplevel", cwd)
    if (!root) return null
    const branch = gitExec("git branch --show-current", cwd)
    const commit = gitExec("git rev-parse --short HEAD", cwd)
    return { type: "git", root, branch, commit }
  } catch { return null }
}

function gitStatus(cwd: string): object[] {
  const out = gitExec("git status --porcelain=v1", cwd)
  if (!out) return []
  return out.split("\n").filter(Boolean).map((line) => {
    const xy = line.slice(0, 2)
    const file = line.slice(3)
    return {
      file,
      staged: xy[0] !== " " && xy[0] !== "?",
      unstaged: xy[1] !== " ",
      untracked: xy[0] === "?",
      status: xy.trim(),
    }
  })
}

function gitDiff(cwd: string, staged = false): string {
  return gitExec(staged ? "git diff --cached" : "git diff", cwd)
}

// ─── Route handler ───────────────────────────────────────────────────────────

function handleRequest(
  req: Request,
  directory: string,
  services: TuiServerServices,
): Response | Promise<Response> {
  const url = new URL(req.url)
  const pathname = url.pathname
  const method = req.method

  // ── Health ────────────────────────────────────────────────────────────────
  if (pathname === "/global/health") return new Response("OK")

  // ── SSE event stream ──────────────────────────────────────────────────────
  if (pathname === "/global/event" && method === "GET") {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        let closed = false
        const send: SSESend = (raw) => {
          if (!closed) controller.enqueue(encoder.encode(raw))
        }
        sseClients.add(send)

        // Send server.connected immediately
        send(
          `data: ${JSON.stringify({
            directory,
            payload: { id: `conn_${Date.now()}`, type: "server.connected", properties: {} },
          })}\n\n`,
        )

        const ping = setInterval(() => {
          if (!closed) controller.enqueue(encoder.encode(": ping\n\n"))
        }, 15_000)

        return () => {
          closed = true
          clearInterval(ping)
          sseClients.delete(send)
        }
      },
    })
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    })
  }

  // ── Config ────────────────────────────────────────────────────────────────
  if ((pathname === "/config" || pathname === "/global/config") && method === "GET")
    return json({ model: "deepseek/deepseek-v4-flash", ...configOverride })

  if ((pathname === "/config" || pathname === "/global/config") && method === "PATCH") {
    return (async () => {
      try {
        const body = await req.json() as Record<string, unknown>
        Object.assign(configOverride, body)
        // Persist model change to neko.json if present
        if (body.model && typeof body.model === "string") {
          try {
            const cfgPath = path.join(directory, "neko.json")
            const file = Bun.file(cfgPath)
            const existing = await file.exists() ? await file.json().catch(() => ({})) : {}
            existing.model = body.model
            await Bun.write(cfgPath, JSON.stringify(existing, null, 2) + "\n")
          } catch { /* non-fatal */ }
        }
      } catch { /* malformed body */ }
      return json({ model: "deepseek/deepseek-v4-flash", ...configOverride })
    })()
  }

  // ── Providers ─────────────────────────────────────────────────────────────
  if (
    (pathname === "/config/providers" || pathname === "/provider") &&
    method === "GET"
  ) {
    return (async () => {
      const creds = await services.listCredentials().catch(() => [] as any[])
      return json(providerListResponse(creds.map((c: any) => c.integrationID)))
    })()
  }

  if (pathname === "/provider/auth" && method === "GET") return json({})

  // PATCH /provider/:id — set API key for a provider
  const providerPatchMatch = pathname.match(/^\/provider\/([^/]+)$/)
  if (providerPatchMatch && method === "PATCH") {
    const providerID = decodeURIComponent(providerPatchMatch[1]!)
    return (async () => {
      let body: any = {}
      try { body = await req.json() } catch {}
      const key = body.value?.key ?? body.key
      if (key && typeof key === "string") {
        await services.setProviderKey(providerID, key).catch(() => {})
      }
      const creds = await services.listCredentials().catch(() => [] as any[])
      return json(providerListResponse(creds.map((c: any) => c.integrationID)))
    })()
  }

  // ── Agents ────────────────────────────────────────────────────────────────
  if (pathname === "/agent" && method === "GET") {
    return (async () => {
      const agents = await services.listAgents().catch(() => [])
      const sdkAgents = agents
        .filter((a) => !a.hidden)
        .map((a) => {
          const modelStr = a.model
          let model: { providerID: string; modelID: string } | undefined = undefined
          if (modelStr && typeof modelStr === "string" && modelStr.includes("/")) {
            const idx = modelStr.indexOf("/")
            model = { providerID: modelStr.slice(0, idx), modelID: modelStr.slice(idx + 1) }
          }
          return {
            name: a.name ?? a.id,
            description: a.description ?? "",
            mode: a.mode ?? "primary",
            native: true,
            hidden: false,
            permission: a.permissions ? { allow: a.permissions } : {},
            options: {},
            ...(model ? { model } : {}),
            ...(a.color ? { color: a.color } : {}),
          }
        })
      return json(sdkAgents)
    })()
  }

  // POST /agent — create a new agent (persists to neko.json + registers at runtime)
  // Body: { name: string, description?: string, system?: string, mode?: "primary"|"subagent"|"all", model?: string }
  if (pathname === "/agent" && method === "POST") {
    return (async () => {
      let body: any = {}
      try { body = await req.json() } catch { return json({ error: "Invalid JSON" }, 400) }
      const { name, ...override } = body
      if (!name || typeof name !== "string" || !/^[a-z][a-z0-9-]*$/i.test(name))
        return json({ error: "name must match [a-zA-Z][a-zA-Z0-9-]*" }, 400)
      if (override.mode && !["primary", "subagent", "all"].includes(override.mode))
        return json({ error: "mode must be 'primary', 'subagent', or 'all'" }, 400)

      // Persist to neko.json under `agents` key
      try {
        const cfgPath = path.join(directory, "neko.json")
        const file = Bun.file(cfgPath)
        const existing = await file.exists() ? await file.json().catch(() => ({})) : {}
        existing.agents = existing.agents ?? {}
        existing.agents[name] = override
        await Bun.write(cfgPath, JSON.stringify(existing, null, 2) + "\n")
      } catch (e) {
        return json({ error: `Failed to persist: ${String(e)}` }, 500)
      }

      await services.addAgent(name, override).catch(() => {})
      return json({ name, ...override })
    })()
  }

  // DELETE /agent/:name — remove a user-defined agent (built-ins are protected)
  const BUILT_IN_AGENT_IDS = new Set(["build", "explore", "plan", "general", "compaction", "title", "summary"])
  const agentDeleteMatch = pathname.match(/^\/agent\/([^/]+)$/)
  if (agentDeleteMatch && method === "DELETE") {
    const name = decodeURIComponent(agentDeleteMatch[1]!)
    return (async () => {
      if (BUILT_IN_AGENT_IDS.has(name))
        return json({ error: `Cannot delete built-in agent '${name}'` }, 400)

      try {
        const cfgPath = path.join(directory, "neko.json")
        const file = Bun.file(cfgPath)
        if (await file.exists()) {
          const existing = await file.json().catch(() => ({}))
          if (existing.agents && typeof existing.agents === "object" && name in existing.agents) {
            delete existing.agents[name]
            await Bun.write(cfgPath, JSON.stringify(existing, null, 2) + "\n")
          }
        }
      } catch (e) {
        return json({ error: `Failed to persist: ${String(e)}` }, 500)
      }

      await services.removeAgent(name).catch(() => {})
      return json({ name, deleted: true })
    })()
  }

  // ── File search — GET /find/file?query=&limit= (used by @-mentions) ──────
  if (pathname === "/find/file" && method === "GET") {
    return (async () => {
      const query = (url.searchParams.get("query") ?? "").toLowerCase()
      const rawLimit = Number(url.searchParams.get("limit") ?? "50")
      const limit = Math.max(1, Math.min(200, Number.isFinite(rawLimit) ? rawLimit : 50))
      const results: string[] = []
      try {
        const glob = new Bun.Glob("**/*")
        for await (const rel of glob.scan({
          cwd: directory,
          absolute: false,
          onlyFiles: true,
          dot: false,
        })) {
          // Skip common noisy roots. Bun.Glob doesn't support ignore patterns,
          // so we filter by prefix.
          if (
            rel.startsWith("node_modules/") ||
            rel.includes("/node_modules/") ||
            rel.startsWith(".git/") ||
            rel.startsWith("dist/") ||
            rel.startsWith("build/") ||
            rel.startsWith(".next/") ||
            rel.startsWith(".turbo/")
          ) continue
          if (query && !rel.toLowerCase().includes(query)) continue
          results.push(rel)
          if (results.length >= limit) break
        }
      } catch {
        return json([])
      }
      // Rank: basename startsWith wins over includes; shorter paths first.
      const q = query
      if (q) {
        results.sort((a, b) => {
          const ba = path.basename(a).toLowerCase()
          const bb = path.basename(b).toLowerCase()
          const sa = ba.startsWith(q) ? 0 : ba.includes(q) ? 1 : 2
          const sb = bb.startsWith(q) ? 0 : bb.includes(q) ? 1 : 2
          if (sa !== sb) return sa - sb
          return a.length - b.length
        })
      } else {
        results.sort((a, b) => a.length - b.length)
      }
      return json(results.slice(0, limit))
    })()
  }

  // ── Skills (markdown files in skills/) ───────────────────────────────────
  if (pathname === "/skill" && method === "GET") {
    return (async () => {
      const skills = await services.listSkills().catch(() => [] as any[])
      return json(skills)
    })()
  }

  // ── Tools (registered ToolRegistry entries) ───────────────────────────────
  if (pathname === "/tool" && method === "GET") {
    return (async () => {
      const tools = await services.listTools().catch(() => [] as any[])
      return json(tools.map((t) => ({ name: t.name, description: t.description })))
    })()
  }

  // ── Sessions — list ───────────────────────────────────────────────────────
  if (pathname === "/session" && method === "GET") {
    return (async () => {
      const projectID = encodeURIComponent(directory)
      const sessions = await services.listSessions(projectID).catch((err) => {
        console.error("[tui-server] listSessions error:", err)
        return [] as any[]
      })
      return json(sessions.map(sessionToSDK))
    })()
  }

  // ── Sessions — status ─────────────────────────────────────────────────────
  if (pathname === "/session/status" && method === "GET") {
    return (async () => {
      const projectID = encodeURIComponent(directory)
      const sessions = await services.listSessions(projectID).catch(() => [] as any[])
      const status: Record<string, { type: string }> = {}
      for (const s of sessions) {
        const events = await services.loadEvents(s.id).catch(() => [] as any[])
        const last = events.at(-1)?.type ?? ""
        const running = last === "session.next.step.started" || last === "session.next.text.started"
        status[s.id] = { type: running ? "running" : "idle" }
      }
      return json(status)
    })()
  }

  // ── Sessions — create ─────────────────────────────────────────────────────
  if (pathname === "/session" && method === "POST") {
    return (async () => {
      let body: any = {}
      try {
        body = await req.json()
      } catch {}
      const projectID = encodeURIComponent(directory)
      const session = await services.createSession({
        projectID,
        title: body.title,
        agent: body.agent,
        model: body.model ?? { id: "deepseek-v4-flash", providerID: "deepseek", variant: undefined },
        location: { directory: body.directory ?? directory },
      })
      const sdkSession = sessionToSDK(session)

      // Broadcast session.created
      broadcastSSE({
        directory,
        payload: {
          id: `sc_${Date.now()}`,
          type: "session.created",
          properties: { sessionID: (sdkSession as any).id, info: sdkSession },
        },
      })

      return json(sdkSession)
    })()
  }

  // ── Sessions — get ────────────────────────────────────────────────────────
  const sessionMatch = pathname.match(/^\/session\/([^/]+)$/)
  if (sessionMatch && method === "GET") {
    const sessionID = sessionMatch[1]!
    return (async () => {
      const session = await services.getSession(sessionID).catch(() => null)
      if (!session) return json({ error: "Not found" }, 404)
      return json(sessionToSDK(session))
    })()
  }

  // ── Sessions — prompt ─────────────────────────────────────────────────────
  const promptMatch = pathname.match(/^\/session\/([^/]+)\/prompt$/)
  if (promptMatch && method === "POST") {
    const sessionID = promptMatch[1]!
    return (async () => {
      let body: any = {}
      try {
        body = await req.json()
      } catch {}
      const parts = body.parts ?? []
      const textParts = parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text as string)
      const text: string = body.text ?? (textParts.length > 0 ? textParts.join("\n") : "")

      // Snapshot event count before admitting so the poller can process the
      // prompt.admitted event we're about to write. With local storage the
      // admit completes before the poller's own loadEvents fires.
      const preAdmitCount = (await services.loadEvents(sessionID).catch(() => [] as any[])).length

      // Fire-and-forget — the runner runs in background
      services
        .prompt({ sessionID, text, files: body.files ?? [], parts: body.parts ?? [] })
        .then(() => console.log(`[tui-server] prompt admitted for ${sessionID}`))
        .catch((err) => console.error("[tui-server] prompt error:", err))

      // Start polling for events produced by this session
      startEventPoller(sessionID, directory, services.loadEvents, services.getSession, preAdmitCount).catch(
        (err) => console.error("[tui-server] poller error:", err),
      )
      console.log(`[tui-server] poller started for ${sessionID}`)

      const msgID = `msg_${Date.now()}`
      return json({
        id: msgID,
        sessionID,
        role: "user",
        time: { created: Date.now(), updated: Date.now() },
        parts: [{ id: `part_${Date.now()}`, type: "text", text }],
      })
    })()
  }

  // ── Sessions — messages ───────────────────────────────────────────────────
  const msgMatch = pathname.match(/^\/session\/([^/]+)\/message$/)
  if (msgMatch && method === "GET") {
    const sessionID = msgMatch[1]!
    return (async () => {
      const events = await services.loadEvents(sessionID).catch(() => [] as any[])
      return json(projectEventsToMessages(events, sessionID))
    })()
  }

  // ── Sessions — parts ──────────────────────────────────────────────────────
  const partMatch = pathname.match(/^\/session\/([^/]+)\/message\/([^/]+)\/part$/)
  if (partMatch && method === "GET") return json([])

  // ── Debug — raw events for a session ─────────────────────────────────────
  const debugEventsMatch = pathname.match(/^\/debug\/session\/([^/]+)\/events$/)
  if (debugEventsMatch && method === "GET") {
    const sessionID = debugEventsMatch[1]!
    return (async () => {
      const events = await services.loadEvents(sessionID).catch((err) => {
        console.error("[tui-server] debug loadEvents error:", err)
        return []
      })
      return json({ sessionID, count: events.length, events })
    })()
  }

  // ── Debug — abort all sessions ────────────────────────────────────────────
  if (pathname === "/debug/session/abort-all" && method === "POST") {
    return (async () => {
      const projectID = encodeURIComponent(directory)
      const sessions = await services.listSessions(projectID).catch(() => [] as any[])
      await Promise.allSettled(sessions.map((s: any) => services.archiveSession(s.id)))
      for (const stop of activePollers.values()) stop()
      activePollers.clear()
      return json({ aborted: sessions.length })
    })()
  }

  // ── Sessions — PATCH (update title / agent) ──────────────────────────────
  if (sessionMatch && method === "PATCH") {
    const sessionID = sessionMatch[1]!
    return (async () => {
      let body: any = {}
      try { body = await req.json() } catch {}
      const patch: { title?: string; agent?: string; model?: { id: string; providerID: string } } = {}
      if (typeof body.title === "string") patch.title = body.title
      if (typeof body.agent === "string") patch.agent = body.agent
      if (body.model && typeof body.model === "object" && typeof body.model.id === "string" && typeof body.model.providerID === "string") {
        patch.model = { id: body.model.id, providerID: body.model.providerID }
      }
      const updated = await services.updateSession(sessionID, patch).catch(() => null)
      if (!updated) return json({ error: "Not found" }, 404)
      const sdkSession = sessionToSDK(updated)
      broadcastSSE({
        directory,
        payload: {
          id: `upd_${Date.now()}`,
          type: "session.updated",
          properties: { sessionID, info: sdkSession },
        },
      })
      return json(sdkSession)
    })()
  }

  // ── Sessions — DELETE ─────────────────────────────────────────────────────
  if (sessionMatch && method === "DELETE") {
    const sessionID = sessionMatch[1]!
    return (async () => {
      const sess = await services.getSession(sessionID).catch(() => null)
      await services.archiveSession(sessionID).catch(() => {})
      const info = sess ? sessionToSDK(sess) : { id: sessionID }
      broadcastSSE({
        directory,
        payload: {
          id: `del_${Date.now()}`,
          type: "session.deleted",
          properties: { sessionID, info },
        },
      })
      return json({ id: sessionID, deleted: true })
    })()
  }

  // ── Sessions — fork ───────────────────────────────────────────────────────
  const forkMatch = pathname.match(/^\/session\/([^/]+)\/fork$/)
  if (forkMatch && method === "POST") {
    const sessionID = forkMatch[1]!
    return (async () => {
      const forked = await services.forkSession(sessionID).catch(() => null)
      if (!forked) return json({ error: "Failed to fork session" }, 500)
      const sdkSession = sessionToSDK(forked)
      broadcastSSE({
        directory,
        payload: {
          id: `fork_${Date.now()}`,
          type: "session.created",
          properties: { sessionID: (sdkSession as any).id, info: sdkSession },
        },
      })
      return json(sdkSession)
    })()
  }

  // ── Sessions — revert/stage ───────────────────────────────────────────────
  const revertStageMatch = pathname.match(/^\/session\/([^/]+)\/revert\/stage$/)
  if (revertStageMatch && method === "POST") {
    const sessionID = revertStageMatch[1]!
    return (async () => {
      let body: any = {}
      try { body = await req.json() } catch {}
      const messageID = body.messageID
      if (!messageID) return json({ error: "messageID is required" }, 400)
      revertStage.set(sessionID, { messageID, partID: body.partID })
      return json({ sessionID, messageID, staged: true })
    })()
  }

  // ── Sessions — revert/commit ──────────────────────────────────────────────
  const revertCommitMatch = pathname.match(/^\/session\/([^/]+)\/revert\/commit$/)
  if (revertCommitMatch && method === "POST") {
    const sessionID = revertCommitMatch[1]!
    return (async () => {
      const staged = revertStage.get(sessionID)
      if (!staged) return json({ error: "No revert staged for this session" }, 400)
      revertStage.delete(sessionID)
      await services.revertSession(sessionID, staged.messageID).catch((e) => {
        console.error("[tui-server] revert error:", e)
        throw e
      })
      const sess = await services.getSession(sessionID).catch(() => null)
      broadcastSSE({
        directory,
        payload: {
          id: `rev_${Date.now()}`,
          type: "session.updated",
          properties: { sessionID, info: sess ? sessionToSDK(sess) : { id: sessionID } },
        },
      })
      return json({ sessionID, reverted: true })
    })()
  }

  // ── Sessions — revert/clear ───────────────────────────────────────────────
  const revertClearMatch = pathname.match(/^\/session\/([^/]+)\/revert\/clear$/)
  if (revertClearMatch && method === "POST") {
    const sessionID = revertClearMatch[1]!
    revertStage.delete(sessionID)
    return json({ sessionID, cleared: true })
  }

  // ── Sessions — unrevert ───────────────────────────────────────────────────
  const unrevertMatch = pathname.match(/^\/session\/([^/]+)\/unrevert$/)
  if (unrevertMatch && method === "POST") return json({})

  // ── Sessions — diff / todo / abort ───────────────────────────────────────
  if (pathname.startsWith("/session/") && pathname.includes("/diff") && method === "GET") {
    const sid = pathname.split("/")[2]!
    return (async () => {
      const session = await services.getSession(sid).catch(() => null)
      const dir = (session as any)?.location?.directory ?? directory
      return json(gitStatus(dir))
    })()
  }
  if (pathname.startsWith("/session/") && pathname.includes("/todo") && method === "GET") return json([])
  if (pathname.startsWith("/session/") && pathname.includes("/abort") && method === "POST") {
    const sid = pathname.split("/")[2]!
    return (async () => {
      await services.abortSession(sid).catch(() => {})
      // Runner may still be mid-step when the abort lands, but the user has
      // signalled "stop" — flip the UI to idle immediately so the spinner and
      // turn timer don't linger while the current step drains.
      broadcastSSE({
        directory,
        payload: {
          id: `abort_${Date.now()}`,
          type: "session.status",
          properties: { sessionID: sid, status: { type: "idle" } },
        },
      })
      return json({})
    })()
  }

  // ── Permissions / Questions ───────────────────────────────────────────────
  if (pathname === "/permission" && method === "GET") {
    return (async () => {
      const list = await services.listPermissions().catch(() => [])
      return json(list)
    })()
  }
  const permissionReplyMatch = pathname.match(/^\/permission\/([^/]+)\/reply$/)
  if (permissionReplyMatch && method === "POST") {
    const requestID = decodeURIComponent(permissionReplyMatch[1]!)
    return (async () => {
      let body: any = {}
      try { body = await req.json() } catch {}
      const reply = body?.reply
      if (reply !== "once" && reply !== "always" && reply !== "reject") {
        return json({ error: "reply must be one of once|always|reject" }, 400)
      }
      await services.replyPermission(requestID, reply).catch(() => {})
      return json({})
    })()
  }
  if (pathname === "/question" && method === "GET") return json([])
  const questionReplyMatch = pathname.match(/^\/question\/([^/]+)\/reply$/)
  if (questionReplyMatch && method === "POST") {
    const requestID = decodeURIComponent(questionReplyMatch[1]!)
    return (async () => {
      let body: any = {}
      try { body = await req.json() } catch {}
      await services.replyQuestion(requestID, body.answers ?? []).catch(() => {})
      return json({})
    })()
  }
  const questionRejectMatch = pathname.match(/^\/question\/([^/]+)\/reject$/)
  if (questionRejectMatch && method === "POST") {
    const requestID = decodeURIComponent(questionRejectMatch[1]!)
    return (async () => {
      await services.rejectQuestion(requestID).catch(() => {})
      return json({})
    })()
  }

  // ── CLI verbs — shell subcommands exposed by the `neko` binary.
  // These are yargs commands you run from a terminal, not TUI palette actions.
  // For TUI slash-palette actions, see GET /slash-command.
  if (pathname === "/command" && method === "GET") {
    return json([
      { name: "run [message..]",          description: "Run neko with a message (non-interactive)" },
      { name: "session list",             description: "List sessions" },
      { name: "session delete",           description: "Delete a session" },
      { name: "agent list",               description: "List all available agents" },
      { name: "mcp list",                 description: "List MCP servers and their status" },
      { name: "mcp add",                  description: "Add an MCP server" },
      { name: "mcp auth",                 description: "Authenticate with an MCP server" },
      { name: "providers list",           description: "List providers and credentials" },
      { name: "models [provider]",        description: "List all available models" },
      { name: "db path",                  description: "Print Firestore project and collection information" },
      { name: "upgrade [target]",         description: "Upgrade neko to the latest or a specific version" },
      { name: "uninstall",                description: "Uninstall neko and remove all related files" },
    ])
  }

  // ── TUI slash-palette actions — invoked from the "/" palette inside the TUI.
  // Sourced from the shared registry in @gco/schema so view and controller
  // agree on one canonical list.
  if (pathname === "/slash-command" && method === "GET") {
    return json(SlashCommand.registry)
  }

  // ── LSP / Formatter — not wired up; return accurate empty state ───────────
  if (pathname === "/lsp" && method === "GET") return json({ running: false, servers: [] })
  if (pathname === "/formatter" && method === "GET") return json({ running: false, formatters: [] })

  // ── MCP — live status from McpController ─────────────────────────────────
  if (pathname === "/mcp" && method === "GET") {
    return (async () => {
      const servers = await services.listMcpServers().catch(() => [])
      const connected = servers.filter((s) => s.status === "connected").length
      return json({ servers, connected })
    })()
  }

  // GET /mcp/:id — get single server by id
  const mcpIdMatch = pathname.match(/^\/mcp\/([^/]+)$/)
  if (mcpIdMatch && method === "GET") {
    const id = decodeURIComponent(mcpIdMatch[1]!)
    return (async () => {
      const servers = await services.listMcpServers().catch(() => [])
      const server = servers.find((s) => s.id === id)
      if (!server) return json({ error: "Not found" }, 404)
      return json(server)
    })()
  }

  // POST /mcp — add a new MCP server (persists to neko.json + connects immediately)
  // Body: { name: string, type: "local", command: string[], cwd?: string }
  //    or { name: string, type: "remote", url: string, headers?: Record<string,string> }
  if (pathname === "/mcp" && method === "POST") {
    return (async () => {
      let body: any = {}
      try { body = await req.json() } catch { return json({ error: "Invalid JSON" }, 400) }
      const { name, ...config } = body
      if (!name || typeof name !== "string") return json({ error: "name is required" }, 400)
      if (!config.type || (config.type !== "local" && config.type !== "remote"))
        return json({ error: "type must be 'local' or 'remote'" }, 400)
      if (config.type === "local" && (!Array.isArray(config.command) || config.command.length === 0))
        return json({ error: "command[] is required for local servers" }, 400)
      if (config.type === "remote" && !config.url)
        return json({ error: "url is required for remote servers" }, 400)

      // Persist to neko.json
      try {
        const cfgPath = path.join(directory, "neko.json")
        const file = Bun.file(cfgPath)
        const existing = await file.exists() ? await file.json().catch(() => ({})) : {}
        existing.mcp = existing.mcp ?? {}
        existing.mcp[name] = config
        await Bun.write(cfgPath, JSON.stringify(existing, null, 2) + "\n")
      } catch { /* non-fatal — still add at runtime */ }

      const status = await services.addMcp(name, config).catch((e) => ({ error: String(e) }))
      return json({ name, ...status })
    })()
  }

  // POST /mcp/:name/connect — connect an already-configured server
  const mcpConnectMatch = pathname.match(/^\/mcp\/([^/]+)\/connect$/)
  if (mcpConnectMatch && method === "POST") {
    const name = decodeURIComponent(mcpConnectMatch[1]!)
    return (async () => {
      await services.connectMcp(name).catch((e) => { throw e })
      return json({ name, status: "connecting" })
    })()
  }

  // DELETE /mcp/:name — disconnect and remove from neko.json
  const mcpDeleteMatch = pathname.match(/^\/mcp\/([^/]+)$/)
  if (mcpDeleteMatch && method === "DELETE") {
    const name = decodeURIComponent(mcpDeleteMatch[1]!)
    return (async () => {
      await services.removeMcp(name).catch(() => {})
      try {
        const cfgPath = path.join(directory, "neko.json")
        const file = Bun.file(cfgPath)
        if (await file.exists()) {
          const existing = await file.json().catch(() => ({}))
          if (existing.mcp) { delete existing.mcp[name]; await Bun.write(cfgPath, JSON.stringify(existing, null, 2) + "\n") }
        }
      } catch { /* non-fatal */ }
      return json({ name, removed: true })
    })()
  }

  // POST /skill — create skills/<name>.md
  if (pathname === "/skill" && method === "POST") {
    return (async () => {
      let body: any = {}
      try { body = await req.json() } catch { return json({ error: "Invalid JSON" }, 400) }
      const { name, body: skillBody } = body
      if (!name || typeof name !== "string") return json({ error: "name is required" }, 400)
      if (!skillBody || typeof skillBody !== "string") return json({ error: "body is required" }, 400)
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) return json({ error: "name may only contain letters, numbers, hyphens and underscores" }, 400)
      try {
        const skillsDir = path.join(directory, "skills")
        await Bun.write(path.join(skillsDir, `${name}.md`), skillBody)
      } catch (e) { return json({ error: `Failed to save: ${e}` }, 500) }
      const description = skillBody.split("\n").find((l: string) => l.trim()) ?? ""
      return json({ id: name, name, description, body: skillBody }, 201)
    })()
  }

  // GET /skill/:id  |  DELETE /skill/:id
  const skillIdMatch = pathname.match(/^\/skill\/([^/]+)$/)
  if (skillIdMatch) {
    const id = decodeURIComponent(skillIdMatch[1]!)
    if (method === "GET") {
      return (async () => {
        const skillPath = path.join(directory, "skills", `${id}.md`)
        const file = Bun.file(skillPath)
        if (!await file.exists()) return json({ error: "Not found" }, 404)
        const body = await file.text()
        const description = body.split("\n").find((l: string) => l.trim()) ?? ""
        return json({ id, name: id, description, body })
      })()
    }
    if (method === "DELETE") {
      return (async () => {
        try {
          const skillPath = path.join(directory, "skills", `${id}.md`)
          const file = Bun.file(skillPath)
          if (await file.exists()) {
            await import("node:fs/promises").then((fs) => fs.unlink(skillPath))
          }
        } catch (e) { return json({ error: `Failed to remove: ${e}` }, 500) }
        return json({ id, removed: true })
      })()
    }
  }

  // ── VCS ───────────────────────────────────────────────────────────────────
  if (pathname === "/vcs" && method === "GET") return json(gitInfo(directory))
  if (pathname === "/vcs/status" && method === "GET") return json(gitStatus(directory))
  if (pathname === "/vcs/diff" && method === "GET") {
    const staged = new URL(req.url).searchParams.get("staged") === "true"
    return json({ diff: gitDiff(directory, staged) })
  }

  // ── Path ──────────────────────────────────────────────────────────────────
  if (pathname === "/path" && method === "GET") {
    const home = os.homedir()
    const state = path.join(home, ".local", "share", "neko")
    return json({
      home,
      state,
      config: path.join(home, ".config", "neko"),
      worktree: path.join(state, "worktree"),
      directory,
    })
  }

  // ── Projects ──────────────────────────────────────────────────────────────
  if (pathname === "/project" && method === "GET") {
    return (async () => {
      const projects = await services.listProjects().catch(() => [] as any[])
      if (projects.length > 0) return json(projects.map((p) => ({ ...p, sandboxes: [] })))
      // Fallback: current directory as the only project
      return json([{
        id: encodeURIComponent(directory),
        worktree: directory,
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      }])
    })()
  }
  if (pathname === "/project/current" && method === "GET") {
    return json({
      id: encodeURIComponent(directory),
      worktree: directory,
      time: { created: Date.now(), updated: Date.now() },
      sandboxes: [],
    })
  }
  if (/^\/project\/[^/]+\/directories$/.test(pathname) && method === "GET") {
    return json([{ directory }])
  }

  // ── Dispose ───────────────────────────────────────────────────────────────
  if (pathname === "/global/dispose" && method === "POST") return json({})

  // ── V2 question endpoints ─────────────────────────────────────────────────
  const v2QuestionListMatch = pathname.match(/^\/v2\/session\/([^/]+)\/question$/)
  if (v2QuestionListMatch && method === "GET") {
    const sessionID = decodeURIComponent(v2QuestionListMatch[1]!)
    return (async () => {
      const questions = await services.listQuestions(sessionID).catch(() => [])
      return json({ data: questions })
    })()
  }

  const v2QuestionReplyMatch = pathname.match(/^\/v2\/session\/([^/]+)\/question\/([^/]+)\/reply$/)
  if (v2QuestionReplyMatch && method === "POST") {
    const requestID = decodeURIComponent(v2QuestionReplyMatch[2]!)
    return (async () => {
      let body: any = {}
      try { body = await req.json() } catch {}
      await services.replyQuestion(requestID, body.answers ?? []).catch(() => {})
      return json({})
    })()
  }

  const v2QuestionRejectMatch = pathname.match(/^\/v2\/session\/([^/]+)\/question\/([^/]+)\/reject$/)
  if (v2QuestionRejectMatch && method === "POST") {
    const requestID = decodeURIComponent(v2QuestionRejectMatch[2]!)
    return (async () => {
      await services.rejectQuestion(requestID).catch(() => {})
      return json({})
    })()
  }

  // ── V2 permission endpoints ───────────────────────────────────────────────
  const v2PermissionListMatch = pathname.match(/^\/v2\/session\/([^/]+)\/permission$/)
  if (v2PermissionListMatch && method === "GET") {
    const sessionID = decodeURIComponent(v2PermissionListMatch[1]!)
    return (async () => {
      const list = await services.listPermissions(sessionID).catch(() => [])
      return json({ data: list })
    })()
  }

  // ── Experimental endpoints (stub responses) ────────────────────────────────
  if (pathname === "/experimental/capabilities" && method === "GET")
    return json({ backgroundSubagents: false })
  if (pathname === "/experimental/console" && method === "GET")
    return json({ consoleManagedProviders: [], switchableOrgCount: 0 })
  if (pathname === "/experimental/resource" && method === "GET") return json({})
  if (pathname === "/experimental/workspace" && method === "GET") return json([])
  if (pathname === "/experimental/worktree" && method === "GET") return json([])

  // ── Session sub-resource stubs ─────────────────────────────────────────────
  if (pathname.startsWith("/session/") && pathname.endsWith("/shell") && method === "POST") return json({})
  if (pathname.startsWith("/session/") && pathname.endsWith("/command") && method === "POST") return json({})

  // ── Sessions — summarize (manual /compact) ────────────────────────────────
  const summarizeMatch = pathname.match(/^\/session\/([^/]+)\/summarize$/)
  if (summarizeMatch && method === "POST") {
    const sessionID = summarizeMatch[1]!
    return (async () => {
      // Snapshot event count before compaction so the poller can pick up the
      // compaction.started / compaction.ended events we're about to write.
      const preCount = (await services.loadEvents(sessionID).catch(() => [] as any[])).length

      // Fire-and-forget — compaction runs an LLM call in the background.
      services
        .compactSession(sessionID)
        .then(() => console.log(`[tui-server] compact triggered for ${sessionID}`))
        .catch((err) => console.error("[tui-server] compact error:", err))

      startEventPoller(sessionID, directory, services.loadEvents, services.getSession, preCount).catch(
        (err) => console.error("[tui-server] poller error:", err),
      )

      return json({})
    })()
  }

  // ── Sync endpoints (stub) ──────────────────────────────────────────────────
  if (pathname === "/sync/list" && method === "GET") return json([])
  if (pathname === "/sync/start" && method === "POST") return json({})

  // ── Default ───────────────────────────────────────────────────────────────
  return json({ error: `Not implemented: ${method} ${pathname}` }, 404)
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

// Default to port 0 so the OS picks a free port — required for running
// multiple `neko` instances concurrently. NEKO_SERVER_PORT still forces a
// specific port when set (useful for scripts hitting the API).
const DEFAULT_PORT = 0

export function startTuiServer(directory: string, services: TuiServerServices): Server<undefined> {
  const port = Number(process.env.NEKO_SERVER_PORT ?? DEFAULT_PORT)
  let serverPort = port

  // Hydrate configOverride from neko.json so GET /config returns the
  // persisted model on cold start. Without this, the /models palette can't
  // highlight which model is active until the user does a PATCH.
  try {
    const cfgPath = path.join(directory, "neko.json")
    const raw = fs.readFileSync(cfgPath, "utf8")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed.model === "string") {
      // Normalize bare model IDs (e.g. "deepseek-v4-flash") to `provider/model`
      // format so the palette's current-key comparison matches.
      const m = parsed.model.includes("/") ? parsed.model : `deepseek/${parsed.model}`
      configOverride.model = m
    }
  } catch { /* neko.json missing or unreadable — fall back to hardcoded default */ }

  const server = Bun.serve({
    port,
    idleTimeout: 0,
    fetch(req) {
      try {
        const url = new URL(req.url)
        // ── Swagger UI ──────────────────────────────────────────────────────
        if (url.pathname === "/docs") {
          return new Response(SWAGGER_HTML(`http://localhost:${serverPort}/openapi.json`), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          })
        }
        if (url.pathname === "/openapi.json") {
          return json(buildOpenApiSpec(serverPort))
        }
        return handleRequest(req, directory, services) ?? json({}, 204)
      } catch (err) {
        console.error("[tui-server] unhandled error:", err)
        return json({ error: "Internal server error" }, 500)
      }
    },
  })
  serverPort = server.port ?? 0
  process.stderr.write(`[tui-server] listening on http://localhost:${server.port}\n`)
  process.stderr.write(`[tui-server] API docs at http://localhost:${server.port}/docs\n`)
  return server
}
