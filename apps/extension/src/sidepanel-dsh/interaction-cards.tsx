/**
 * `interaction-cards`: the SidePanel's answerable-interaction cards — the
 * approval card (允许一次 / 拒绝) and the question card (per-question options,
 * multi-question stepper, one batch submit, and a cancel that fail-fasts the
 * engine wait). Both read the pending-wait snapshot from the
 * `interaction-store` singleton (fed by the connection module's mux tap) and
 * answer through the store's respond carrier, so the cards and the
 * capability panel's amber dot describe the same pending waits.
 *
 * Mount point: `extension-shell.tsx` renders the container between the
 * transcript and the capability panel. The container is `flex: 0 0 auto`
 * with a viewport-capped scroll region, so a card can never push the
 * composer out of the panel — the flexible transcript above absorbs the
 * height instead.
 *
 * Answer semantics mirror `tests/ask-bridge.spec.ts`: a submit posts the
 * whole `{ sessionId, answer: { answers } }` batch (ids in the request's
 * order, single-select at most one label, labels restricted to the asked
 * options, blank custom omitted); cancel posts the `cancelled` error branch.
 * The card stays mounted until the engine's `resolved` frame removes the
 * wait — a refused respond (receipt `accepted: false`) or a transport error
 * surfaces as inline error text and keeps the answers editable.
 *
 * @module interaction-cards
 */

import { useCallback, useState, useSyncExternalStore } from 'react'
import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { interactionStore, pendingQuestionsKey } from './interaction-store.ts'
import type {
  ApprovalDecision,
  InteractionQuestion,
  InteractionStore,
  PendingApproval,
  PendingQuestions,
  QuestionAnswerItem,
} from './interaction-store.ts'

/** Read the store's snapshot through useSyncExternalStore (uSES direct wiring). */
function useInteractionSnapshot(store: InteractionStore): ReturnType<InteractionStore['getSnapshot']> {
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

/**
 * Pending interaction count for chrome that lives outside the cards (the
 * capability panel's amber dot reads this alongside its own runtime source).
 * @param store - observable store; defaults to the page singleton.
 */
export function useInteractionPendingCount(store: InteractionStore = interactionStore): number {
  const snapshot = useInteractionSnapshot(store)
  return snapshot.approvals.length + snapshot.questions.length
}

/** Normalize an error into display text (Error message, else String). */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The cards container: mounted only while at least one wait is pending. */
export function InteractionCards({ store = interactionStore }: { store?: InteractionStore }): JSX.Element | null {
  const snapshot = useInteractionSnapshot(store)
  if (snapshot.approvals.length === 0 && snapshot.questions.length === 0) return null
  return (
    <section className="dshx-ixcards" aria-label="待处理的审批与提问">
      {snapshot.approvals.map(entry => (
        <ApprovalCard key={entry.approvalId} entry={entry} store={store} />
      ))}
      {snapshot.questions.map(entry => (
        <QuestionCard key={pendingQuestionsKey(entry)} entry={entry} store={store} />
      ))}
    </section>
  )
}

/** One approval wait: tool name + reason, 允许一次 / 拒绝. */
function ApprovalCard({ entry, store }: { entry: PendingApproval; store: InteractionStore }): JSX.Element {
  const [busy, setBusy] = useState<ApprovalDecision | null>(null)
  const [error, setError] = useState<string | null>(null)
  const decide = useCallback((outcome: ApprovalDecision): void => {
    setBusy(outcome)
    setError(null)
    store.decideApproval(entry, outcome).then((receipt) => {
      // The card leaves on the engine's resolved frame; a refusal keeps it
      // answerable with the reason inline.
      if (receipt.accepted) return
      setBusy(null)
      setError(`操作未被接受（${receipt.reason}）`)
    }).catch((cause: unknown) => {
      setBusy(null)
      setError(errorText(cause))
    })
  }, [entry, store])
  return (
    <article className="dshx-ixcard">
      <header className="dshx-ixcard-head">
        <span className="dshx-ixbadge dshx-ixbadge--approval">审批</span>
        <span className="dshx-ixtool" title={entry.callId}>{entry.toolName}</span>
      </header>
      {entry.reason !== undefined && <p className="dshx-ixreason">{entry.reason}</p>}
      <div className="dshx-ixactions">
        <button
          type="button"
          className="dshx-ixbtn dshx-ixbtn--primary"
          disabled={busy !== null}
          onClick={() => { decide('allowed-once') }}
        >
          {busy === 'allowed-once' ? '提交中…' : '允许一次'}
        </button>
        <button
          type="button"
          className="dshx-ixbtn dshx-ixbtn--danger"
          disabled={busy !== null}
          onClick={() => { decide('rejected') }}
        >
          拒绝
        </button>
      </div>
      {error !== null && <div className="dshx-ixerror" role="alert">{error}</div>}
    </article>
  )
}

/** One question's local draft (labels picked so far; free text when the question has no options). */
interface QuestionDraft {
  selected: string[]
  custom: string
}

const EMPTY_DRAFT: QuestionDraft = { selected: [], custom: '' }

/** One question batch: per-question stepper, option picking, batch submit, whole-batch cancel. */
function QuestionCard({ entry, store }: { entry: PendingQuestions; store: InteractionStore }): JSX.Element {
  const questions = entry.questions
  const total = questions.length
  const [step, setStep] = useState(0)
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() => questions.map(() => ({ ...EMPTY_DRAFT })))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const patchDraft = useCallback((index: number, patch: (draft: QuestionDraft) => QuestionDraft): void => {
    setDrafts(current => current.map((draft, i) => (i === index ? patch(draft) : draft)))
  }, [])

  const question: InteractionQuestion | undefined = questions[step]
  if (question === undefined) return <></>
  const draft = drafts[step] ?? EMPTY_DRAFT
  const multi = question.multiSelect === true
  const options = question.options ?? []

  /** Single-select pick: replace the selection and step forward (last question stays for 提交). */
  const pickSingle = (label: string): void => {
    patchDraft(step, current => ({ ...current, selected: [label] }))
    setStep(current => Math.min(current + 1, total - 1))
  }

  /** Multi-select pick: toggle one label in place. */
  const toggleMulti = (label: string): void => {
    patchDraft(step, current => ({
      ...current,
      selected: current.selected.includes(label)
        ? current.selected.filter(item => item !== label)
        : [...current.selected, label],
    }))
  }

  /** Submit the whole batch; the engine's resolved frame retires the card. */
  const submit = (): void => {
    setSubmitting(true)
    setError(null)
    const answers: QuestionAnswerItem[] = questions.map((item, index) => {
      const own = drafts[index] ?? EMPTY_DRAFT
      return (item.options ?? []).length === 0
        ? { id: item.id, selected: own.selected, custom: own.custom }
        : { id: item.id, selected: own.selected }
    })
    store.answerQuestions(entry, answers).then((receipt) => {
      if (receipt.accepted) return
      setSubmitting(false)
      setError(`提交未被接受（${receipt.reason}）`)
    }).catch((cause: unknown) => {
      setSubmitting(false)
      setError(errorText(cause))
    })
  }

  /** Cancel the whole batch: the engine rejects the parked ask fail-fast. */
  const cancel = (): void => {
    setSubmitting(true)
    setError(null)
    store.cancelQuestions(entry).then((receipt) => {
      if (receipt.accepted) return
      setSubmitting(false)
      setError(`取消未被接受（${receipt.reason}）`)
    }).catch((cause: unknown) => {
      setSubmitting(false)
      setError(errorText(cause))
    })
  }

  /** Enter inside the free-text input advances (IME composing stays put). */
  const customKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key !== 'Enter') return
    event.preventDefault()
    setStep(current => Math.min(current + 1, total - 1))
  }

  return (
    <article className="dshx-ixcard" aria-label={total > 1 ? `提问 ${step + 1} / ${total}` : '提问'}>
      <header className="dshx-ixcard-head">
        <span className="dshx-ixbadge dshx-ixbadge--question">提问</span>
        {total > 1 && <span className="dshx-ixprogress">{step + 1} / {total}</span>}
      </header>
      {question.header !== undefined && <div className="dshx-ixqheader">{question.header}</div>}
      <div className="dshx-ixquestion">{question.question}</div>
      {question.detail !== undefined && <div className="dshx-ixdetail">{question.detail}</div>}
      {options.length > 0 && (
        <div className="dshx-ixoptions" role="group" aria-label={multi ? '多选选项' : '单选选项'}>
          {options.map((option) => {
            const checked = draft.selected.includes(option.label)
            return (
              <button
                key={option.label}
                type="button"
                role={multi ? 'checkbox' : 'radio'}
                aria-checked={checked}
                className="dshx-ixopt"
                onClick={() => {
                  if (multi) toggleMulti(option.label)
                  else pickSingle(option.label)
                }}
              >
                <span className="dshx-ixopt-label">{option.label}</span>
                {option.description !== undefined && <span className="dshx-ixopt-desc">{option.description}</span>}
              </button>
            )
          })}
        </div>
      )}
      {options.length === 0 && (
        <input
          type="text"
          className="dshx-ixcustom"
          placeholder="输入你的答案"
          value={draft.custom}
          onChange={(event) => { patchDraft(step, current => ({ ...current, custom: event.target.value })) }}
          onKeyDown={customKeyDown}
        />
      )}
      {multi && <div className="dshx-ixhint">可多选</div>}
      <div className="dshx-ixnav">
        <button
          type="button"
          className="dshx-ixbtn dshx-ixbtn--ghost"
          disabled={step === 0 || submitting}
          onClick={() => { setStep(current => Math.max(0, current - 1)) }}
          aria-label="上一题"
        >
          上一题
        </button>
        <button
          type="button"
          className="dshx-ixbtn dshx-ixbtn--ghost"
          disabled={step >= total - 1 || submitting}
          onClick={() => { setStep(current => Math.min(total - 1, current + 1)) }}
          aria-label="下一题"
        >
          下一题
        </button>
        <span className="dshx-ixnav-gap" />
        <button
          type="button"
          className="dshx-ixbtn dshx-ixbtn--ghost"
          disabled={submitting}
          title="取消等待：工具将立即收到取消错误"
          onClick={cancel}
        >
          跳过/取消
        </button>
        <button
          type="button"
          className="dshx-ixbtn dshx-ixbtn--primary"
          disabled={submitting}
          onClick={submit}
        >
          {submitting ? '提交中…' : '提交'}
        </button>
      </div>
      {error !== null && <div className="dshx-ixerror" role="alert">{error}</div>}
    </article>
  )
}

/**
 * Card stylesheet — composer/popover vocabulary (dshx- classes, --dsw-alias-*
 * tokens with light-mode fallbacks, 4-px spacing steps) so light/dark follow
 * the shell's theme presenter. The container caps its height at the viewport
 * so cards can never squeeze the composer out of the panel.
 *
 * Button discipline: operation buttons (`.dshx-ixbtn`) pin one-line labels
 * (nowrap), while option-card descriptions (`.dshx-ixopt-desc`) stay
 * wrappable — a long ask description is content, not a label. Button rows
 * (`.dshx-ixactions`/`.dshx-ixnav`) wrap as whole buttons instead of
 * squeezing individual labels.
 */
export const INTERACTION_CARDS_CSS = `
.dshx-ixcards{flex:0 0 auto;display:flex;flex-direction:column;gap:8px;max-height:44vh;overflow-y:auto;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,rgba(127,127,127,.35)) transparent}
.dshx-ixcard{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f59e0b) 45%,transparent);border-radius:12px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03));font-size:13px}
.dshx-ixcard-head{display:flex;align-items:center;gap:8px;min-width:0}
.dshx-ixbadge{flex:none;padding:1px 8px;border-radius:999px;font-size:11px;line-height:18px;color:#fff;background:var(--dsw-alias-state-warning-primary,#f59e0b)}
.dshx-ixbadge--approval{background:var(--dsw-alias-state-warning-primary,#f59e0b)}
.dshx-ixbadge--question{background:var(--dsw-alias-brand-primary,#4c7dfd)}
.dshx-ixtool{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dshx-ixprogress{flex:none;margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary,#aaa)}
.dshx-ixqheader{font-size:11px;letter-spacing:.4px;color:var(--dsw-alias-label-tertiary,#999)}
.dshx-ixquestion{font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.dshx-ixdetail{font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary,#888)}
.dshx-ixreason{margin:0;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary,#888)}
.dshx-ixoptions{display:flex;flex-direction:column;gap:6px}
.dshx-ixopt{display:flex;flex-direction:column;gap:2px;width:100%;padding:7px 10px;text-align:left;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:10px;background:transparent;cursor:pointer;color:inherit;transition:border-color .15s ease,background .15s ease}
.dshx-ixopt:hover{background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.05))}
.dshx-ixopt[aria-checked="true"]{border-color:var(--dsw-alias-brand-primary,#4c7dfd);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 10%,transparent)}
.dshx-ixopt-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600}
.dshx-ixopt-desc{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#999)}
.dshx-ixcustom{width:100%;padding:7px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:10px;background:transparent;color:inherit;font-size:12px;outline:none;transition:border-color .15s ease}
.dshx-ixcustom::placeholder{color:var(--dsw-alias-label-tertiary,#aaa)}
.dshx-ixcustom:focus{border-color:var(--dsw-alias-brand-primary,#4c7dfd)}
.dshx-ixhint{font-size:11px;color:var(--dsw-alias-label-tertiary,#aaa)}
.dshx-ixactions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dshx-ixnav{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dshx-ixnav-gap{flex:1 1 auto}
.dshx-ixbtn{height:28px;padding:0 12px;border-radius:9px;border:1px solid transparent;cursor:pointer;font-size:12px;line-height:26px;white-space:nowrap;transition:filter .15s ease,background .15s ease,color .15s ease}
.dshx-ixbtn:disabled{cursor:default;opacity:.55}
.dshx-ixbtn--primary{background:var(--dsw-alias-brand-primary,#4c7dfd);color:#fff}
.dshx-ixbtn--primary:not(:disabled):hover{filter:brightness(.94)}
/* brand fill flips near-white in dark: the white foreground must flip to ink
   or the question badge / primary action label vanish */
body[data-ds-dark-theme] .dshx-ixbadge--question,body[data-ds-dark-theme] .dshx-ixbtn--primary{color:var(--dsw-static-neutral-bluish-1000,#171717)}
.dshx-ixbtn--ghost{background:transparent;border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.16));color:var(--dsw-alias-label-secondary,#666)}
.dshx-ixbtn--ghost:not(:disabled):hover{background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#333)}
.dshx-ixbtn--danger{background:transparent;border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 55%,transparent);color:var(--dsw-alias-state-error-primary,#dc2626)}
.dshx-ixbtn--danger:not(:disabled):hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 10%,transparent)}
.dshx-ixerror{font-size:11px;line-height:1.6;word-break:break-word;color:var(--dsw-alias-state-error-primary,#dc2626)}
@media (max-width: 430px){
  .dshx-ixcards{padding:6px 8px;gap:6px}
  .dshx-ixcard{padding:8px 10px}
  .dshx-ixbtn{padding:0 8px}
}
@media (prefers-reduced-motion:reduce){.dshx-ixopt,.dshx-ixbtn,.dshx-ixcustom{transition:none}}
`
