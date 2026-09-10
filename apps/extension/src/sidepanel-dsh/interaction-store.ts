/**
 * `interaction-store`: the SidePanel's interaction channel. The engine's ask
 * bridge (`src/chrome/chrome-ask-bridge.ts`) answers engine-side waits
 * (approval gate / ask_user_question) by broadcasting answerable mux frames —
 * `approval/requested` / `question/requested` — and settling on the panel's
 * `{ k: 'respond' }` up message. This store is the panel side of that
 * conversation: it consumes those frames (plus their `resolved` echoes) from
 * the one mux downlink every frame already rides, exposes the pending waits
 * as an observable snapshot for React (`useSyncExternalStore`), and encodes
 * the respond bodies.
 *
 * Tap point: `connection-module.ts` wraps the ConnectionController's
 * `onMuxEnvelope` sink — every mux frame passes here FIRST and is then
 * forwarded to the unchanged runtime dispatch (session streams, projections,
 * queue, jobs), so the standard distribution is untouched. The connection
 * module also hands the store the respond carrier (the shared api client's
 * `respond`), so decisions ride the same Port leg the frames arrived on.
 *
 * Identity and idempotency: the client layer (`PortApiClient.tapStream`)
 * mints a FRESH envelope rpcId per delivered frame, so replays of the same
 * engine wait arrive under new ids. Entries therefore dedupe by payload
 * identity — approvals by `approvalId`, question batches by their session id
 * plus question-id set — and a replay UPSERTS, refreshing the correlation
 * rpcId to the newest delivery. `resolved` frames remove: approvals exactly
 * by `approvalId`; questions by the respond's echoed rpcId, falling back to
 * every question wait of the frame's session (the engine echoes its own id
 * on withdrawal paths that never saw a respond — turn cancel, teardown —
 * which no client-minted envelope id can match).
 *
 * Wire bodies mirror `tests/ask-bridge.spec.ts` verbatim: the approval
 * payload `{ sessionId, approvalId, outcome }` (outcome `'allowed-once' |
 * 'rejected'`), the question payload `{ sessionId, answer: { answers } }`
 * (items `{ id, selected, custom? }`), and the cancel branch as the error
 * result `{ code: 'cancelled', … }`. The engine correlates a respond by
 * body — the echoed rpcId is the client's own pending-wait key — so any
 * correlation failure on the engine side surfaces as a rejected receipt
 * rather than a lost answer.
 *
 * @module interaction-store
 */

import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ClientResponse, MuxFrame, RpcReceipt, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'

/** One asked question, verbatim off the `question/requested` frame payload. */
export type InteractionQuestion = Extract<MuxFrame, { type: 'question/requested' }>['questions'][number]

/** Render face of one pending approval wait (deduped by `approvalId`). */
export interface PendingApproval {
  readonly kind: 'approval'
  readonly approvalId: string
  readonly sessionId: string
  readonly toolName: string
  readonly callId: string | undefined
  readonly reason: string | undefined
}

/** Render face of one pending question batch (deduped by session + id set). */
export interface PendingQuestions {
  readonly kind: 'question'
  readonly sessionId: string
  readonly questions: readonly InteractionQuestion[]
}

/** Observable store snapshot (stable reference between changes). */
export interface InteractionSnapshot {
  readonly approvals: readonly PendingApproval[]
  readonly questions: readonly PendingQuestions[]
}

/** One answer item of a question submit batch (the respond body's `answer.answers` items). */
export interface QuestionAnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  /** Free-text answer; omitted when absent or blank (the engine rejects an empty string). */
  readonly custom?: string | undefined
}

/** The decision body of an approval respond (apiproxy approval semantics). */
export type ApprovalDecision = 'allowed-once' | 'rejected'

/**
 * The respond carrier: encode one wire result and echo the frame's
 * correlation id. `connection-module.ts` binds this to the shared api
 * client's `respond` (which wraps it into a `client-response` envelope and
 * rides the `{ k: 'respond' }` Port leg).
 */
export type InteractionRespond = (result: ClientResponse['result'], rpcId: string) => Promise<RpcReceipt>

/** The cancel body's exact vocabulary: the engine maps it to ASK_CANCELLED fail-fast. */
const CANCEL_RESULT = {
  ok: false,
  error: { code: 'cancelled', message: 'the user closed this question request', details: {} },
} as const satisfies ClientResponse['result']

/** Dedupe identity of one question batch: session id + sorted question ids. */
export function pendingQuestionsKey(entry: Pick<PendingQuestions, 'sessionId' | 'questions'>): string {
  const ids = entry.questions.map(question => question.id).sort()
  return `${entry.sessionId}\n${ids.join('\n')}`
}

/**
 * Observable pending-interaction state over the mux downlink. One instance
 * lives for the page (the module singleton below); tests construct fresh
 * ones.
 */
export class InteractionStore {
  #respond: InteractionRespond | undefined
  readonly #approvals = new Map<string, { view: PendingApproval; rpcId: string }>()
  readonly #questions = new Map<string, { view: PendingQuestions; rpcId: string }>()
  #rev = 0
  #cache: { rev: number; snapshot: InteractionSnapshot } | undefined
  readonly #listeners = new Set<() => void>()

  /** Bind the respond carrier (the shared api client's respond leg). */
  setRespond(respond: InteractionRespond | undefined): void {
    this.#respond = respond
  }

  /** uSES subscription entry (stable reference; bound field). */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Cached snapshot (stable reference between changes; rebuilt lazily). */
  readonly getSnapshot = (): InteractionSnapshot => {
    const cached = this.#cache
    if (cached !== undefined && cached.rev === this.#rev) return cached.snapshot
    const snapshot: InteractionSnapshot = {
      approvals: [...this.#approvals.values()].map(item => item.view),
      questions: [...this.#questions.values()].map(item => item.view),
    }
    this.#cache = { rev: this.#rev, snapshot }
    return snapshot
  }

  /** Total pending waits — the interaction counterpart of the capability panel's amber dot. */
  get pendingCount(): number {
    return this.#approvals.size + this.#questions.size
  }

  /**
   * The mux-frame tap. Called for EVERY mux envelope ahead of the unchanged
   * runtime dispatch; only the four interaction frames mutate state, the
   * rest return without notifying.
   * @param envelope - the parsed frame with its per-delivery client rpcId.
   */
  handleMuxEnvelope(envelope: RpcRequest<MuxFrame>): void {
    const frame = envelope.payload
    switch (frame.type) {
      case 'approval/requested': {
        const view: PendingApproval = {
          kind: 'approval',
          approvalId: frame.approvalId,
          sessionId: frame.sessionId,
          toolName: frame.toolName,
          callId: frame.callId,
          reason: frame.reason,
        }
        const existing = this.#approvals.get(frame.approvalId)
        if (existing === undefined) this.#approvals.set(frame.approvalId, { rpcId: envelope.rpcId, view })
        else {
          existing.rpcId = envelope.rpcId
          existing.view = view
        }
        break
      }
      case 'approval/resolved': {
        if (!this.#approvals.delete(frame.approvalId)) return
        break
      }
      case 'question/requested': {
        const view: PendingQuestions = {
          kind: 'question',
          sessionId: frame.sessionId,
          questions: frame.questions,
        }
        const key = pendingQuestionsKey(view)
        const existing = this.#questions.get(key)
        if (existing === undefined) this.#questions.set(key, { rpcId: envelope.rpcId, view })
        else {
          existing.rpcId = envelope.rpcId
          existing.view = view
        }
        break
      }
      case 'question/resolved': {
        if (!this.#removeQuestionByRpcId(frame.questionRpcId)
          && !this.#removeSessionQuestions(frame.sessionId)) return
        break
      }
      default:
        return
    }
    this.#rev += 1
    for (const listener of [...this.#listeners]) listener()
  }

  /** Drop the question wait whose newest delivery echoed `rpcId` on its resolved frame. */
  #removeQuestionByRpcId(rpcId: string): boolean {
    for (const [key, entry] of this.#questions) {
      if (entry.rpcId !== rpcId) continue
      this.#questions.delete(key)
      return true
    }
    return false
  }

  /** Fallback for engine-minted resolved echoes: drop every question wait of one session. */
  #removeSessionQuestions(sessionId: string): boolean {
    let removed = false
    for (const [key, entry] of this.#questions) {
      if (entry.view.sessionId !== sessionId) continue
      this.#questions.delete(key)
      removed = true
    }
    return removed
  }

  /** The correlation id to echo on a respond: the batch's newest delivery. */
  #questionsRpcId(entry: PendingQuestions): string {
    const found = this.#questions.get(pendingQuestionsKey(entry))
    if (found === undefined) throw new Error('该问题请求已结束')
    return found.rpcId
  }

  /** The correlation id to echo on a respond: the approval's newest delivery. */
  #approvalRpcId(approvalId: string): string {
    const found = this.#approvals.get(approvalId)
    if (found === undefined) throw new Error('该审批请求已结束')
    return found.rpcId
  }

  /** Send one respond body through the bound carrier (throws on transport/receipt refusal). */
  async #send(rpcId: string, result: ClientResponse['result']): Promise<RpcReceipt> {
    const respond = this.#respond
    if (respond === undefined) throw new Error('交互通道未就绪（引擎连接尚未建立）')
    return respond(result, rpcId)
  }

  /**
   * Submit the whole answer batch for one question wait. The body mirrors
   * the ask-bridge contract: items keep the request's question order, and a
   * blank `custom` is omitted (the engine rejects an empty string).
   * @param entry - the wait being answered (must still be pending).
   * @param answers - one item per question, same order.
   * @returns the engine receipt (`accepted: false` means the body was refused).
   */
  answerQuestions(entry: PendingQuestions, answers: readonly QuestionAnswerItem[]): Promise<RpcReceipt> {
    const rpcId = this.#questionsRpcId(entry)
    const wireAnswers = answers.map((answer) => {
      const custom = answer.custom?.trim()
      return custom === undefined || custom === ''
        ? { id: answer.id, selected: [...answer.selected] }
        : { id: answer.id, selected: [...answer.selected], custom }
    })
    return this.#send(rpcId, {
      ok: true,
      value: { sessionId: entry.sessionId, answer: { answers: wireAnswers } },
    })
  }

  /**
   * Cancel one question wait (the panel's 跳过/取消): the engine rejects the
   * parked ask with ASK_CANCELLED instead of waiting forever.
   * @param entry - the wait being cancelled (must still be pending).
   * @returns the engine receipt.
   */
  cancelQuestions(entry: PendingQuestions): Promise<RpcReceipt> {
    const rpcId = this.#questionsRpcId(entry)
    return this.#send(rpcId, CANCEL_RESULT)
  }

  /**
   * Settle one approval wait with the user's decision.
   * @param entry - the wait being decided (must still be pending).
   * @param outcome - allow this once, or reject.
   * @returns the engine receipt.
   */
  decideApproval(entry: PendingApproval, outcome: ApprovalDecision): Promise<RpcReceipt> {
    const rpcId = this.#approvalRpcId(entry.approvalId)
    return this.#send(rpcId, {
      ok: true,
      value: { sessionId: entry.sessionId, approvalId: entry.approvalId, outcome },
    })
  }
}

/** Brands a plain correlation id into the envelope id slot of a respond message. */
function rpcIdOf(value: string): ClientResponse['rpcId'] {
  return RpcId(value)
}

/**
 * The page-lifetime store. `connection-module.ts` feeds it every mux envelope
 * and binds the respond carrier; the shell's cards read it.
 */
export const interactionStore = new InteractionStore()

/**
 * The connection module's respond binding: one `client-response` envelope
 * over the shared api client — the same Port leg the frames arrived on.
 * @param api - the page's api client (port-backed, or the fixture client).
 */
export function bindInteractionRespond(
  api: { respond(message: ClientResponse, signal?: AbortSignal): Promise<RpcReceipt> },
): void {
  interactionStore.setRespond((result, rpcId) => api.respond({ type: 'client-response', rpcId: rpcIdOf(rpcId), result }))
}
