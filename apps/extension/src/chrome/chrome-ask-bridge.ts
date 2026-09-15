/**
 * `chrome-ask-bridge`: the extension twin of the apiproxy gateway's
 * interaction surface (`packages/host/apiproxy/src/api-proxy.ts` approval
 * registry + user-questions provider). It wires the two engine interaction
 * seams onto the SidePanel over the api bridge's mux/respond channel:
 *
 * - user-questions provider: `ctx.userQuestions.ask()` mints a stable rpcId,
 *   pushes a `question/requested` mux frame, and parks until the panel's
 *   respond message settles it (answer batch, or the `cancelled` error branch
 *   when the user closes the flow).
 * - approval answerer: `ctx.on('approval/request')` pairs the request with the
 *   service's still-undecided `approval/asked` audit event (newest-first,
 *   callId-symmetric, unclaimed), pushes an `approval/requested` mux frame,
 *   and parks until the panel's respond message carries the decision.
 *
 * Parked waits re-announce their request frame on a fixed cadence so a panel
 * that connects or reloads mid-wait still renders the pending card; every
 * settle path clears the timer.
 *
 * Respond correlation adapts to the port carrier's one deviation from the
 * desktop: the SidePanel's client layer mints a FRESH rpcId per delivered
 * frame (`PortApiClient.tapStream`), so a panel respond echoes an id the
 * engine never minted. Responds therefore settle by body — the approval
 * payload's `approvalId`, and the question batch accepted only when exactly
 * one pending request matches its id set — while a respond whose rpcId does
 * match a registered responder still settles directly. The
 * `question/resolved` frame echoes the RESPOND's rpcId (the client-minted
 * pending-wait key), so the answering panel's wait settles; withdrawal paths
 * that never saw a respond fall back to the engine's own id.
 *
 * Fail-closed posture, mirroring the gateway: an ask's own abort signal (turn
 * cancel) settles `'cancelled'` / `ASK_ABORTED`; the api bridge fires the
 * registered cancel hook when the last port disconnects and no panel returns
 * within the grace window (or the plugin disposes), withdrawing every pending
 * wait; an ask arriving while no port has ever connected (no interaction
 * channel) rejects instead of parking forever.
 *
 * Wire shapes (frames and respond bodies) are the apiproxy events/approvals/
 * questions contracts verbatim — the SidePanel re-parses frames with the real
 * zod schemas and the panels encode the respond bodies themselves.
 *
 * @module chrome-ask-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions/types'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { interactionChannel, setInteractionCancel, setInteractionValueRouter } from './api-bridge.ts'
import type { ApiRpcResult, MuxFrame } from './api-bridge.ts'
import { storageGet, storageSet } from './storage-client.ts'

export const name = 'chrome-ask-bridge'

/** storage.local key of the field-triage ring (last 20 bridge lifecycle entries). */
const DIAG_KEY = 'dsh-askbridge-diag'

/**
 * Persist one bridge lifecycle entry for field triage (park vs cancel cause).
 * Best-effort: a storage failure must never break an interaction wait, and a
 * concurrent write's last-writer-wins loss costs at most ring entries. The
 * console mirror is `warn` so the offscreen DevTools shows it at default
 * filter levels.
 */
export async function diagLog(entry: Record<string, unknown>): Promise<void> {
  console.warn('[dsh-ask-bridge]', JSON.stringify(entry))
  try {
    const stored = await storageGet([DIAG_KEY])
    const ring = stored[DIAG_KEY]
    const list = Array.isArray(ring) ? ring : []
    list.push({ ts: new Date().toISOString(), ...entry })
    await storageSet({ [DIAG_KEY]: list.slice(-20) })
  } catch {
    // Diagnostics only: the interaction path must not depend on storage.
  }
}

/** Engine services the bridge routes: the question service it backs and the approval seam it answers. */
export const inject = ['userQuestions', 'approval']

/** This plugin has no config. */
export interface Config {}

/** One host-owned approval wait, addressed by the stable server-request rpcId. */
interface PendingApproval {
  rpcId: string
  sessionId: SessionId
  approvalId: ApprovalRequestId
  toolName: string
  callId?: string
  reason?: string
  resolve(outcome: ApprovalOutcome): void
  signal?: AbortSignal
  onAbort?: () => void
  /** Periodic re-announce of the requested frame (cleared on settle). */
  reannounce?: ReturnType<typeof setInterval>
}

/** One host-owned question wait, addressed by the stable server-request rpcId. */
interface PendingQuestion {
  rpcId: string
  sessionId: SessionId
  questions: AskUserQuestionItem[]
  resolve(answer: AskUserQuestionAnswer): void
  reject(error: UserQuestionError): void
  signal?: AbortSignal
  onAbort?: () => void
  /** Periodic re-announce of the requested frame (cleared on settle). */
  reannounce?: ReturnType<typeof setInterval>
}

/** Mint the stable rpcId of one answerable interaction frame. */
function mintInteractionId(): string {
  return globalThis.crypto.randomUUID?.() ?? `ask-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/** Cadence at which parked request frames re-announce to the panel. */
const REANNOUNCE_INTERVAL_MS = 5000

/**
 * Periodically re-push a request frame while its wait is parked: a panel that
 * connects or reloads mid-wait never saw the original broadcast and would
 * otherwise show no card. The current channel is re-resolved per tick so a
 * reconnecting port receives the frame.
 */
function startReannounce(frame: MuxFrame): ReturnType<typeof setInterval> {
  return setInterval(() => {
    interactionChannel()?.broadcastMuxFrame(frame)
  }, REANNOUNCE_INTERVAL_MS)
}

/**
 * Extension interaction bridge: user-questions provider + approval answerer
 * over the api bridge's mux/respond channel.
 * @param ctx - the composed engine context.
 */
export function apply(ctx: Context): void {
  const pendingApprovals = new Map<string, PendingApproval>()
  const pendingQuestions = new Map<string, PendingQuestion>()

  /** Resolve a panel respond body's payload object, or undefined when foreign-typed. */
  function respondValue(result: ApiRpcResult): Record<string, unknown> | undefined {
    if (!result.ok) return undefined
    const value = result.value
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
  }

  /**
   * Remove a question before settling it: synchronous deletion makes the first
   * claimant (answer, cancel, abort, teardown) win. The resolved frame echoes
   * `resolvedRpcId` — the respond's own rpcId when a respond drove the claim
   * (the client's pending-wait key), else the engine's id.
   */
  function claimQuestion(pending: PendingQuestion, outcome: 'answered' | 'cancelled', resolvedRpcId: string): void {
    if (!pendingQuestions.delete(pending.rpcId)) return
    if (pending.reannounce !== undefined) clearInterval(pending.reannounce)
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort)
    }
    interactionChannel()?.broadcastMuxFrame({
      type: 'question/resolved',
      sessionId: pending.sessionId,
      questionRpcId: resolvedRpcId,
      outcome,
    })
  }

  /** Validate one answer batch against the exact question request it resolves (apiproxy parity). */
  function matchesQuestions(value: QuestionRespondValue, pending: PendingQuestion): boolean {
    if (value.sessionId !== pending.sessionId) return false
    const answers = value.answer.answers
    if (answers.length !== pending.questions.length) return false
    return answers.every((answer, index) => {
      const question = pending.questions[index] as AskUserQuestionItem
      if (answer.id !== question.id) return false
      if (new Set(answer.selected).size !== answer.selected.length) return false
      const custom = answer.custom?.trim()
      if (custom !== undefined && custom === '') return false
      if (question.multiSelect !== true) {
        if (custom !== undefined && answer.selected.length > 0) return false
        if (answer.selected.length > 1) return false
      }
      const labels = new Set(question.options?.map(option => option.label) ?? [])
      return answer.selected.every(label => labels.has(label))
    })
  }

  /** The respond body the QuestionComposer sends (apiproxy QuestionResponsePayload). */
  interface QuestionRespondValue {
    sessionId: SessionId
    answer: AskUserQuestionAnswer
  }

  /**
   * Parse one panel respond body into an answer batch. Throws on a malformed
   * or mismatching one: the respond receipt turns `bad-response` and the
   * pending entry stays answerable.
   */
  function parseAnswerBatch(value: Record<string, unknown>, pending: PendingQuestion): AskUserQuestionAnswer {
    const rawSessionId = value['sessionId']
    const rawAnswer = value['answer']
    if (rawSessionId !== pending.sessionId
      || rawAnswer === null || typeof rawAnswer !== 'object' || Array.isArray(rawAnswer)) {
      throw new Error('question respond 与请求不匹配')
    }
    const rawAnswers = (rawAnswer as { answers?: unknown }).answers
    if (!Array.isArray(rawAnswers)) throw new Error('question respond 缺少 answers 数组')
    const answers: AskUserQuestionAnswerItem[] = rawAnswers.map((raw) => {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('question respond 的 answers 项格式非法')
      }
      const item = raw as { id?: unknown; selected?: unknown; custom?: unknown }
      if (typeof item.id !== 'string' || !Array.isArray(item.selected)
        || !item.selected.every(label => typeof label === 'string')) {
        throw new Error('question respond 的 answers 项格式非法')
      }
      const selected: string[] = item.selected
      return {
        id: item.id,
        selected: [...selected],
        ...(typeof item.custom === 'string' && item.custom !== '' ? { custom: item.custom } : {}),
      }
    })
    const candidate: QuestionRespondValue = {
      sessionId: pending.sessionId,
      answer: { answers },
    }
    if (!matchesQuestions(candidate, pending)) {
      throw new Error('question respond 与请求不匹配')
    }
    return candidate.answer
  }

  /**
   * Settle one approval wait from a panel respond body. The approval payload
   * carries its own audit correlation, so the body's `approvalId` must match
   * the entry the rpcId routed to — a mismatched answer is malformed, not
   * merely late. Throws on refusal (receipt `bad-response`, entry stays
   * pending).
   */
  function settleApprovalRespond(pending: PendingApproval, result: ApiRpcResult): void {
    const value = respondValue(result)
    if (value === undefined) throw new Error('approval respond 载荷格式非法')
    if (value['sessionId'] !== pending.sessionId || value['approvalId'] !== pending.approvalId) {
      throw new Error('approval respond 与请求不匹配')
    }
    if (value['outcome'] === 'allowed-once' || value['outcome'] === 'rejected') {
      settleApproval(pending, value['outcome'])
      return
    }
    throw new Error(`approval respond outcome 非法：${String(value['outcome'])}`)
  }

  /** Close one approval wait: withdraw the responder, push the resolved frame, wake the asker. */
  function settleApproval(pending: PendingApproval, outcome: ApprovalOutcome): void {
    // Defensive double-settle guard: a settled id is removed before it can
    // re-settle, and the first settle drops the abort listener.
    if (!pendingApprovals.delete(pending.rpcId)) return
    if (pending.reannounce !== undefined) clearInterval(pending.reannounce)
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort)
    }
    interactionChannel()?.removeResponder(pending.rpcId)
    interactionChannel()?.broadcastMuxFrame({
      type: 'approval/resolved',
      sessionId: pending.sessionId,
      approvalId: pending.approvalId,
      outcome,
    })
    // After an abort won the race this resolve is a settled-promise no-op:
    // the service's own signal race discarded this late resolution.
    pending.resolve(outcome)
  }

  /** Whether one pending question is a plausible owner of an answer batch body (pre-correlation filter). */
  function questionBodyMatches(pending: PendingQuestion, value: Record<string, unknown>): boolean {
    if (value['sessionId'] !== pending.sessionId) return false
    const answer = value['answer']
    if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return false
    const answers = (answer as { answers?: unknown }).answers
    if (!Array.isArray(answers) || answers.length !== pending.questions.length) return false
    const bodyIds = answers.map(item => (item as { id?: unknown } | null)?.id).sort()
    const questionIds = pending.questions.map(question => question.id).sort()
    return JSON.stringify(bodyIds) === JSON.stringify(questionIds)
  }

  /**
   * Settle one question wait from a panel respond body. `respondRpcId` — the
   * id the panel echoed — is what the resolved frame must carry: the client
   * keyed its pending wait by exactly that id.
   */
  function settleQuestionRespond(pending: PendingQuestion, respondRpcId: string, result: ApiRpcResult): void {
    if (!result.ok) {
      if (result.error.code !== 'cancelled') {
        throw new Error(`question respond 错误分支非法：${result.error.code}`)
      }
      claimQuestion(pending, 'cancelled', respondRpcId)
      pending.reject(new UserQuestionError(
        'the user cancelled ask_user_question', 'ASK_CANCELLED'))
      return
    }
    const value = respondValue(result)
    if (value === undefined) throw new Error('question respond 载荷格式非法')
    claimQuestion(pending, 'answered', respondRpcId)
    pending.resolve(parseAnswerBatch(value, pending))
  }

  /**
   * Correlate a respond whose echoed rpcId matched no responder: approvals by
   * their payload `approvalId`, questions only when exactly one pending
   * request's id set matches the batch (ambiguous or unknown bodies are not
   * ours → `false`, receipt `not-pending`). A matched-but-malformed body
   * throws → receipt `bad-response`, entry stays pending.
   */
  function routeRespondByValue(respondRpcId: string, result: ApiRpcResult): boolean {
    // 面板的取消体只带 { code: 'cancelled' }，没有任何关联字段：仅在恰好一个
    // 问题在等待时可以唯一归属，否则无法安全路由（fail closed）。
    if (!result.ok) {
      if (result.error.code === 'cancelled' && pendingQuestions.size === 1) {
        const pending = [...pendingQuestions.values()][0] as PendingQuestion
        settleQuestionRespond(pending, respondRpcId, result)
        return true
      }
      return false
    }
    const value = respondValue(result)
    if (value !== undefined && typeof value['approvalId'] === 'string') {
      const approval = [...pendingApprovals.values()]
        .find(entry => entry.approvalId === value['approvalId'])
      if (approval === undefined) return false
      settleApprovalRespond(approval, result)
      return true
    }
    const questions = [...pendingQuestions.values()]
      .filter(pending => questionBodyMatches(pending, value ?? {}))
    if (questions.length !== 1) return false
    settleQuestionRespond(questions[0] as PendingQuestion, respondRpcId, result)
    return true
  }

  /** Withdraw every pending wait (fail closed): questions reject, approvals settle 'cancelled'. */
  function cancelAllPending(): void {
    if (pendingApprovals.size > 0 || pendingQuestions.size > 0) {
      // Field triage: the caller stack discriminates port-disconnect teardown
      // from plugin disposal, the two producers of this fail-closed sweep.
      void diagLog({
        kind: 'cancel-all',
        approvals: pendingApprovals.size,
        questions: pendingQuestions.size,
        stack: (new Error().stack ?? '').split('\n').slice(1, 5).join(' | ').slice(0, 600),
      })
    }
    for (const pending of [...pendingQuestions.values()]) {
      claimQuestion(pending, 'cancelled', pending.rpcId)
      pending.reject(new UserQuestionError(
        'the extension user-questions channel was closed before the user answered', 'ASK_ABORTED'))
    }
    for (const pending of [...pendingApprovals.values()]) settleApproval(pending, 'cancelled')
  }

  // ── user-questions answerer (the 0.1.5 scoped waterfall registration) ──

  const disposeProvider = ctx.on('user-questions/request', (request, _next) => {
    const sessionId = request.agent?.id
    if (sessionId === undefined) {
      return Promise.reject(new UserQuestionError(
        'extension user interaction requires an agent-owned session', 'ASK_MISSING_AGENT'))
    }
    const channel = interactionChannel()
    if (channel === undefined) {
      return Promise.reject(new UserQuestionError(
        'no SidePanel interaction channel is available (api-bridge not applied)', 'NO_PROVIDER'))
    }
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const rpcId = mintInteractionId()
      const pending: PendingQuestion = {
        rpcId,
        sessionId,
        questions: request.questions,
        resolve,
        reject,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }
      const onAbort = (): void => {
        void diagLog({
          kind: 'question-abort',
          reason: String(request.signal?.reason ?? '<none>').slice(0, 300),
        })
        claimQuestion(pending, 'cancelled', pending.rpcId)
        reject(new UserQuestionError(
          'ask_user_question was aborted before the user answered', 'ASK_ABORTED'))
      }
      pending.onAbort = onAbort
      pendingQuestions.set(rpcId, pending)
      void diagLog({ kind: 'park-question', questions: request.questions.length })
      // Register before broadcasting so a same-tick respond finds its settle.
      channel.addResponder(rpcId, (respondRpcId, result) => {
        settleQuestionRespond(pending, respondRpcId, result)
      })
      request.signal?.addEventListener('abort', onAbort, { once: true })
      const frame: MuxFrame = {
        type: 'question/requested',
        sessionId,
        questions: request.questions,
      }
      channel.broadcastMuxFrame(frame)
      pending.reannounce = startReannounce(frame)
    })
  })

  // ── approval answerer ──

  ctx.on('approval/request', (req, next) => {
    // Dispatch rides a microtask behind the service's own signal check: settle
    // synchronously instead of publishing an already-withdrawn question.
    if (req.signal?.aborted === true) return Promise.resolve<ApprovalOutcome>('cancelled')
    // The service appended this request's `approval/asked` before dispatch, but
    // parallel asks can all append before any answerer runs: take the newest
    // asked event that is still undecided, unclaimed by another pending entry,
    // and callId-symmetric with the request.
    const events = req.agent.session.snapshotEvents()
    const claimed = new Set<ApprovalRequestId>()
    for (const entry of pendingApprovals.values()) claimed.add(entry.approvalId)
    const decided = new Set<ApprovalRequestId>()
    let approvalId: ApprovalRequestId | undefined
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i] as SessionEvent
      if (event.type === 'approval/decided') {
        decided.add(event.data.id)
      } else if (event.type === 'approval/asked') {
        if (decided.has(event.data.id) || claimed.has(event.data.id)) continue
        if ((req.callId ?? null) !== (event.data.callId ?? null)) continue
        approvalId = event.data.id
        break
      }
    }
    // No asked event means the request bypassed the service's audit path — not
    // this channel's question; delegate to the fail-closed default. The same
    // delegation covers a disconnected panel: no channel, no answerable frame.
    if (approvalId === undefined) return next()
    const channel = interactionChannel()
    if (channel === undefined) return next()
    const id = approvalId
    return new Promise<ApprovalOutcome>((resolve) => {
      const onAbort = (): void => {
        void diagLog({
          kind: 'approval-abort',
          approvalId: id,
          reason: String(req.signal?.reason ?? '<none>').slice(0, 300),
        })
        settleApproval(pending, 'cancelled')
      }
      const pending: PendingApproval = {
        rpcId: mintInteractionId(),
        sessionId: req.agent.session.id,
        approvalId: id,
        toolName: req.toolName,
        ...(req.callId === undefined ? {} : { callId: req.callId }),
        ...(req.reason === undefined ? {} : { reason: req.reason }),
        resolve,
        ...(req.signal === undefined ? {} : { signal: req.signal }),
        onAbort,
      }
      pendingApprovals.set(pending.rpcId, pending)
      void diagLog({ kind: 'park-approval', approvalId: id, toolName: pending.toolName })
      channel.addResponder(pending.rpcId, (_respondRpcId, result) => {
        settleApprovalRespond(pending, result)
      })
      req.signal?.addEventListener('abort', onAbort, { once: true })
      const frame: MuxFrame = {
        type: 'approval/requested',
        sessionId: pending.sessionId,
        approvalId: id,
        toolName: pending.toolName,
        ...(pending.callId === undefined ? {} : { callId: pending.callId }),
        ...(pending.reason === undefined ? {} : { reason: pending.reason }),
      }
      channel.broadcastMuxFrame(frame)
      pending.reannounce = startReannounce(frame)
    })
  })

  // ── teardown ──

  // The api bridge fires the cancel hook when the last port disconnects or the
  // bridge itself disposes: a pending wait with no audience fails closed. The
  // value router is the body-correlation half of the respond path.
  const disposeCancelHook = setInteractionCancel(cancelAllPending)
  const disposeValueRouter = setInteractionValueRouter(routeRespondByValue)
  ctx.effect(() => () => {
    disposeCancelHook()
    disposeValueRouter()
    disposeProvider()
    cancelAllPending()
  }, 'chrome-ask-bridge: teardown')
}
