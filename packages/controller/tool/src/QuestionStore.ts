/**
 * QuestionStore — in-process store for pending QuestionTool requests.
 *
 * Implements IQuestionService so it can be passed directly to
 * QuestionTool.makeQuestionTool(). Also exposes list/reply/reject so
 * the HTTP layer (tui-server) can surface pending questions and relay
 * user answers back into the blocked Effect fiber.
 */

import { Effect } from "effect"
import type { Question } from "@gco/schema"
import type { IQuestionService, QuestionAskInput } from "./tools/QuestionTool"

interface PendingEntry {
  readonly id: string
  readonly sessionID: string
  readonly questions: ReadonlyArray<Question.Prompt>
  readonly tool: { readonly messageID: string; readonly callID: string }
  readonly resolve: (answers: ReadonlyArray<Question.Answer>) => void
  readonly reject: () => void
}

export interface QuestionRequestInfo {
  readonly id: string
  readonly sessionID: string
  readonly questions: ReadonlyArray<Question.Prompt>
  readonly tool: { readonly messageID: string; readonly callID: string }
}

export interface QuestionStoreCallbacks {
  readonly onAsk?: (req: QuestionRequestInfo) => void
  readonly onReply?: (req: QuestionRequestInfo, answers: ReadonlyArray<ReadonlyArray<string>>) => void
  readonly onReject?: (req: QuestionRequestInfo) => void
}

export class QuestionStore implements IQuestionService {
  private readonly pending = new Map<string, PendingEntry>()
  constructor(private readonly cb: QuestionStoreCallbacks = {}) {}

  ask(input: QuestionAskInput): Effect.Effect<{ answers: ReadonlyArray<Question.Answer> }> {
    return Effect.callback<{ answers: ReadonlyArray<Question.Answer> }>((resume) => {
      // Use the tool callID as the request ID so the event projector can emit
      // question.asked events with the same ID via session.next.tool.called events.
      const id = input.tool.callID
      const req: QuestionRequestInfo = { id, sessionID: input.sessionID, questions: input.questions, tool: input.tool }
      this.pending.set(id, {
        ...req,
        resolve: (answers) => {
          this.pending.delete(id)
          resume(Effect.succeed({ answers }))
        },
        reject: () => {
          this.pending.delete(id)
          resume(Effect.succeed({ answers: [] as ReadonlyArray<Question.Answer> }))
        },
      })
      this.cb.onAsk?.(req)
    })
  }

  list(sessionID: string): QuestionRequestInfo[] {
    return [...this.pending.values()]
      .filter((p) => p.sessionID === sessionID)
      .map(({ id, sessionID: sid, questions, tool }) => ({ id, sessionID: sid, questions, tool }))
  }

  reply(requestID: string, answers: ReadonlyArray<ReadonlyArray<string>>): void {
    const entry = this.pending.get(requestID)
    if (!entry) return
    const req: QuestionRequestInfo = { id: entry.id, sessionID: entry.sessionID, questions: entry.questions, tool: entry.tool }
    entry.resolve(answers as ReadonlyArray<Question.Answer>)
    this.cb.onReply?.(req, answers)
  }

  reject(requestID: string): void {
    const entry = this.pending.get(requestID)
    if (!entry) return
    const req: QuestionRequestInfo = { id: entry.id, sessionID: entry.sessionID, questions: entry.questions, tool: entry.tool }
    entry.reject()
    this.cb.onReject?.(req)
  }
}
