/**
 * SessionController — Effect service for creating and managing sessions.
 *
 * Ported from @neko/packages/core/src/session.ts.
 *
 * Exposes:
 *   create(input)               — create a new session, persist to ISessionRepository
 *   get(id)                     — fetch session by ID (NotFoundError if missing)
 *   list(projectID, anchor?)    — list sessions for a project
 *   prompt(sessionID, message)  — admit a user message and wake the runner
 *   interrupt(sessionID)        — interrupt an active session
 *   resume(sessionID)           — resume a paused session
 *   revert(sessionID, messageID)— revert to a previous message (drops events after messageID)
 */

import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { Event, Session, SessionMessage } from "@gco/schema"
import {
  EventRepository,
  SessionEvent,
  SessionRepository,
  type ListAnchor,
} from "@gco/model-domain"
import { SessionRunner } from "./SessionRunner"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()(
  "Session.NotFoundError",
  { sessionID: Session.ID },
) {}

export class PromptConflictError extends Schema.TaggedErrorClass<PromptConflictError>()(
  "Session.PromptConflictError",
  {
    sessionID: Session.ID,
    messageID: SessionMessage.ID,
  },
) {}

export class MessageNotFoundError extends Schema.TaggedErrorClass<MessageNotFoundError>()(
  "Session.MessageNotFoundError",
  {
    sessionID: Session.ID,
    messageID: SessionMessage.ID,
  },
) {}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CreateInput {
  readonly id?: Session.ID
  readonly projectID: string
  readonly parentID?: string
  readonly title?: string
  readonly agent?: string
  readonly model?: {
    readonly id: string
    readonly providerID: string
    readonly variant?: string
  }
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
  }
}

export interface PromptInput {
  readonly id?: SessionMessage.ID
  readonly sessionID: Session.ID
  readonly text: string
  readonly files?: ReadonlyArray<{
    readonly uri: string
    readonly mime: string
    readonly name?: string
    readonly description?: string
  }>
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Session.Info, Error>
  readonly get: (sessionID: Session.ID) => Effect.Effect<Session.Info, NotFoundError | Error>
  readonly list: (
    projectID: string,
    anchor?: ListAnchor,
  ) => Effect.Effect<Session.Info[], Error>
  readonly prompt: (
    input: PromptInput,
  ) => Effect.Effect<void, NotFoundError | PromptConflictError | Error>
  readonly interrupt: (sessionID: Session.ID) => Effect.Effect<void, Error>
  readonly resume: (sessionID: Session.ID) => Effect.Effect<void, NotFoundError | Error>
  readonly revert: (
    sessionID: Session.ID,
    messageID: SessionMessage.ID,
  ) => Effect.Effect<void, NotFoundError | MessageNotFoundError | Error>
  readonly compact: (sessionID: Session.ID) => Effect.Effect<void, NotFoundError | Error>
}

// ---------------------------------------------------------------------------
// Context.Tag
// ---------------------------------------------------------------------------

export class SessionController extends Context.Service<SessionController, Interface>()(
  "@gco/SessionController",
) {}

// ---------------------------------------------------------------------------
// Helper — build Session.Info from CreateInput
// ---------------------------------------------------------------------------

function buildSessionInfo(input: CreateInput, id: Session.ID): Session.Info {
  const now = Date.now()
  return {
    id,
    projectID: input.projectID as Session.Info["projectID"],
    parentID: input.parentID as Session.Info["parentID"] ?? undefined,
    title: input.title ?? `New session - ${new Date(now).toISOString()}`,
    agent: (input.agent as Session.Info["agent"]) ?? undefined,
    model: input.model
      ? {
          id: input.model.id as Session.Info["model"] extends { id: infer I } | undefined
            ? I
            : never,
          providerID: input.model.providerID as Session.Info["model"] extends {
            providerID: infer P
          }
            | undefined
            ? P
            : never,
          ...(input.model.variant !== undefined
            ? {
                variant: input.model.variant as Session.Info["model"] extends {
                  variant?: infer V
                }
                  | undefined
                  ? V
                  : never,
              }
            : {}),
        }
      : undefined,
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: {
      created: DateTime.makeUnsafe(now),
      updated: DateTime.makeUnsafe(now),
    },
    location: {
      directory: input.location.directory as Session.Info["location"]["directory"],
      ...(input.location.workspaceID !== undefined
        ? {
            workspaceID:
              input.location.workspaceID as Session.Info["location"]["workspaceID"],
          }
        : {}),
    },
    subpath: undefined,
    revert: undefined,
  } satisfies Session.Info
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const layer: Layer.Layer<
  SessionController,
  never,
  SessionRepository | EventRepository | SessionRunner
> = Layer.effect(
  SessionController,
  Effect.gen(function* () {
    const sessions = yield* Effect.service(SessionRepository)
    const eventRepo = yield* Effect.service(EventRepository)
    const runner = yield* Effect.service(SessionRunner)

    // ── helpers ────────────────────────────────────────────────────────────

    const getOrFail = (sessionID: Session.ID) =>
      sessions.get(sessionID).pipe(
        Effect.flatMap((session) =>
          session !== undefined
            ? Effect.succeed(session)
            : Effect.fail(new NotFoundError({ sessionID })),
        ),
      )

    const durable = undefined as unknown as SessionEvent.DurableEvent["durable"]

    return SessionController.of({
      // ── create ──────────────────────────────────────────────────────────
      create: Effect.fn("SessionController.create")(function* (input) {
        const id = input.id ?? Session.ID.create()

        // Idempotent: return existing session if already created
        const existing = yield* sessions.get(id)
        if (existing !== undefined) return existing

        const info = buildSessionInfo(input, id)
        yield* sessions.create(info)

        return info
      }),

      // ── get ─────────────────────────────────────────────────────────────
      get: Effect.fn("SessionController.get")(function* (sessionID) {
        return yield* getOrFail(sessionID)
      }),

      // ── list ────────────────────────────────────────────────────────────
      list: Effect.fn("SessionController.list")(function* (projectID, anchor) {
        return yield* sessions.list(projectID, anchor)
      }),

      // ── prompt ──────────────────────────────────────────────────────────
      prompt: Effect.fn("SessionController.prompt")(function* (input) {
        yield* getOrFail(input.sessionID)

        const messageID = input.id ?? SessionMessage.ID.create()
        const timestamp = yield* DateTime.now

        // Persist the PromptAdmitted event
        yield* eventRepo.append(input.sessionID, [
          {
            id: Event.ID.create(),
            type: "session.next.prompt.admitted",
            durable,
            data: {
              sessionID: input.sessionID,
              timestamp,
              messageID,
              prompt: {
                text: input.text,
                files: (input.files ?? []) as any,
                agents: [],
              },
              delivery: "steer",
            },
          } as unknown as SessionEvent.DurableEvent,
        ])

        // Wake the runner — fire-and-forget; the runner drains in background
        yield* runner.run({ sessionID: input.sessionID, force: false }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              process.stderr.write(`[runner] run failed for ${input.sessionID}:\n${cause}\n`)
            }),
          ),
          Effect.forkDetach,
          Effect.asVoid,
        )
      }),

      // ── interrupt ───────────────────────────────────────────────────────
      interrupt: Effect.fn("SessionController.interrupt")(function* (sessionID) {
        yield* runner.interrupt(sessionID)
      }),

      // ── resume ──────────────────────────────────────────────────────────
      resume: Effect.fn("SessionController.resume")(function* (sessionID) {
        yield* getOrFail(sessionID)
        yield* runner.run({ sessionID, force: true }).pipe(
          Effect.forkDetach,
          Effect.asVoid,
        )
      }),

      // ── compact ─────────────────────────────────────────────────────────
      // Trigger manual compaction — summarize old messages and write a
      // compaction checkpoint. Runs in the background so the caller does
      // not block on the LLM summary call.
      compact: Effect.fn("SessionController.compact")(function* (sessionID) {
        yield* getOrFail(sessionID)
        yield* runner.compact(sessionID).pipe(Effect.forkDetach, Effect.asVoid)
      }),

      // ── revert ──────────────────────────────────────────────────────────
      revert: Effect.fn("SessionController.revert")(function* (sessionID, messageID) {
        yield* getOrFail(sessionID)

        // Load all events and find the target message boundary
        const events = yield* eventRepo.load(sessionID)
        const targetIndex = events.findIndex((event) => {
          const data = (event as unknown as { data: { messageID?: unknown } }).data
          return data?.messageID === messageID
        })

        if (targetIndex === -1) {
          return yield* Effect.fail(new MessageNotFoundError({ sessionID, messageID }))
        }

        // Keep only events up to and including the target message
        const kept = events.slice(0, targetIndex + 1)

        // Re-append the truncated log. Implementations that track sequence
        // numbers should treat this as a compaction boundary reset.
        yield* eventRepo.append(sessionID, kept)
      }),
    })
  }),
)
