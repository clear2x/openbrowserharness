// @vitest-environment jsdom
/**
 * interaction-cards spec (SidePanel interaction channel): the store + cards
 * against a scripted respond carrier, no chrome and no Port — the store is
 * fed mux envelopes exactly as `connection-module`'s tap receives them
 * (per-delivery client-minted rpcIds) and the cards are driven through
 * testing-library.
 *
 * Covered contracts:
 * - question card: renders every asked question (options with
 *   label+description, free-text for option-less, multi-select), steps
 *   through a batch, and submits ONE answers array shaped like the
 *   ask-bridge contract (ids in request order, selected labels, custom for
 *   free text);
 * - approval card: 允许一次 / 拒绝 post the `{sessionId, approvalId,
 *   outcome}` result with the delivered envelope's rpcId;
 * - cancel posts the `cancelled` error branch verbatim;
 * - resolved frames retire the cards; same-id repeated `requested` frames
 *   (mux-open replay) stay one card each and refresh the echoed rpcId to
 *   the newest delivery;
 * - refused responds (`accepted: false` receipt) and transport throws keep
 *   the card answerable with the failure inline.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { MuxFrame, RpcReceipt, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { InteractionStore } from '../src/sidepanel-dsh/interaction-store.ts'
import type { InteractionRespond } from '../src/sidepanel-dsh/interaction-store.ts'
import { InteractionCards, INTERACTION_CARDS_CSS } from '../src/sidepanel-dsh/interaction-cards.tsx'

afterEach(cleanup)

/** One mux envelope as the tap sees it: parsed frame + this delivery's fresh client rpcId. */
function envelope(rpcId: string, frame: unknown): RpcRequest<MuxFrame> {
  return { rpcId: RpcId(rpcId), payload: frame as MuxFrame }
}

/** An accepted carrier receipt (the only shape a settled respond returns). */
const ACCEPTED: RpcReceipt = { accepted: true }

/** A store over a scripted respond carrier. */
function bootStore(respond: InteractionRespond = vi.fn((): Promise<RpcReceipt> => Promise.resolve(ACCEPTED))): {
  store: InteractionStore
  respond: InteractionRespond
} {
  const store = new InteractionStore()
  store.setRespond(respond)
  return { store, respond }
}

/** Feed one envelope to the store (act: subscribers update React). */
function feed(store: InteractionStore, rpcId: string, frame: unknown): void {
  act(() => {
    store.handleMuxEnvelope(envelope(rpcId, frame))
  })
}

const QUESTIONS = [
  {
    id: 'q1',
    question: '继续执行哪一步？',
    options: [
      { label: '选项A', description: '优先工程交付。' },
      { label: '选项B' },
    ],
  },
  { id: 'q2', question: '补充你的要求' },
  {
    id: 'q3',
    question: '带哪些信号？（可多选）',
    multiSelect: true,
    options: [{ label: '系统设计' }, { label: '代码质量' }, { label: '产品判断' }],
  },
]

describe('interaction-cards', () => {
  it('renders every question, steps through the batch, and submits one answers array', () => {
    const { store, respond } = bootStore()
    feed(store, 'rpc-q', { type: 'question/requested', sessionId: 'session-main', questions: QUESTIONS })
    const view = render(<InteractionCards store={store} />)

    expect(screen.getByText('继续执行哪一步？')).toBeTruthy()
    expect(screen.getByText('1 / 3')).toBeTruthy()
    expect(screen.getByText('优先工程交付。')).toBeTruthy()

    // Single-select pick advances to the free-text question.
    fireEvent.click(screen.getByRole('radio', { name: /选项A/ }))
    expect(screen.getByText('2 / 3')).toBeTruthy()
    const custom = screen.getByPlaceholderText('输入你的答案')
    fireEvent.change(custom, { target: { value: '要能独立排查' } })
    fireEvent.keyDown(custom, { key: 'Enter' })

    // Multi-select picks do not advance; submit posts the whole batch.
    expect(screen.getByText('3 / 3')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: '系统设计' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '代码质量' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))

    expect(respond).toHaveBeenCalledTimes(1)
    expect(respond).toHaveBeenCalledWith({
      ok: true,
      value: {
        sessionId: 'session-main',
        answer: {
          answers: [
            { id: 'q1', selected: ['选项A'] },
            { id: 'q2', selected: [], custom: '要能独立排查' },
            { id: 'q3', selected: ['系统设计', '代码质量'] },
          ],
        },
      },
    }, 'rpc-q')
    // Nothing retires the card before the engine's resolved frame.
    expect(screen.getByText('提问')).toBeTruthy()
    expect(view.container.querySelector('.dshx-ixcards')).toBeTruthy()
  })

  it('allows once and rejects with the approval result shape, and retires on the resolved frame', () => {
    const { store, respond } = bootStore()
    feed(store, 'rpc-a', {
      type: 'approval/requested',
      sessionId: 'session-main',
      approvalId: 'ap-1',
      toolName: 'page_evaluate',
      callId: 'call-1',
      reason: '请求在页面上下文中执行脚本。参数：{"function":"1+1"}',
    })
    render(<InteractionCards store={store} />)

    expect(screen.getByText('page_evaluate')).toBeTruthy()
    expect(screen.getByText(/1\+1/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '允许一次' }))
    expect(respond).toHaveBeenCalledWith({
      ok: true,
      value: { sessionId: 'session-main', approvalId: 'ap-1', outcome: 'allowed-once' },
    }, 'rpc-a')

    feed(store, 'unused', { type: 'approval/resolved', sessionId: 'session-main', approvalId: 'ap-1', outcome: 'allowed-once' })
    expect(screen.queryByText('审批')).toBeNull()

    // 拒绝 posts the same payload with the rejected outcome.
    const second = bootStore()
    feed(second.store, 'rpc-b', {
      type: 'approval/requested', sessionId: 'session-main', approvalId: 'ap-2', toolName: 'page_navigate',
    })
    render(<InteractionCards store={second.store} />)
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    expect(second.respond).toHaveBeenCalledWith({
      ok: true,
      value: { sessionId: 'session-main', approvalId: 'ap-2', outcome: 'rejected' },
    }, 'rpc-b')
  })

  it('cancels with the cancelled error branch and keeps the card on a refused receipt', async () => {
    const respond = vi.fn<() => Promise<RpcReceipt>>()
      .mockResolvedValueOnce({ accepted: false, reason: 'not-pending' })
      .mockResolvedValueOnce(ACCEPTED)
    const { store } = bootStore(respond)
    feed(store, 'rpc-q', { type: 'question/requested', sessionId: 'session-main', questions: [{ id: 'q1', question: '继续吗？' }] })
    render(<InteractionCards store={store} />)

    fireEvent.click(screen.getByRole('button', { name: '跳过/取消' }))
    expect(respond).toHaveBeenNthCalledWith(1, {
      ok: false,
      error: { code: 'cancelled', message: 'the user closed this question request', details: {} },
    }, 'rpc-q')
    expect(await screen.findByText('取消未被接受（not-pending）')).toBeTruthy()
    expect(screen.getByText('继续吗？')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '跳过/取消' }))
    expect(respond).toHaveBeenCalledTimes(2)
  })

  it('keeps repeated same-id requested frames idempotent and echoes the newest rpcId', () => {
    const { store, respond } = bootStore()
    // Mux-open replay: the same engine waits re-delivered under fresh client rpcIds.
    feed(store, 'rpc-a1', {
      type: 'approval/requested', sessionId: 'session-main', approvalId: 'ap-1', toolName: 'page_evaluate',
    })
    feed(store, 'rpc-a2', {
      type: 'approval/requested', sessionId: 'session-main', approvalId: 'ap-1', toolName: 'page_evaluate',
    })
    feed(store, 'rpc-q1', { type: 'question/requested', sessionId: 'session-main', questions: QUESTIONS })
    feed(store, 'rpc-q2', { type: 'question/requested', sessionId: 'session-main', questions: QUESTIONS })
    render(<InteractionCards store={store} />)

    expect(screen.getAllByText('审批')).toHaveLength(1)
    expect(screen.getByText('1 / 3')).toBeTruthy()
    expect(store.pendingCount).toBe(2)

    // The upserted correlation id is the NEWEST delivery.
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
    }), 'rpc-a2')

    feed(store, 'unused-q', { type: 'question/resolved', sessionId: 'session-main', questionRpcId: 'rpc-q2', outcome: 'cancelled' })
    feed(store, 'unused-a', { type: 'approval/resolved', sessionId: 'session-main', approvalId: 'ap-1', outcome: 'cancelled' })
    expect(store.pendingCount).toBe(0)
  })

  it('removes question waits on engine-minted resolved echoes (withdrawal without a respond)', () => {
    const { store } = bootStore()
    feed(store, 'rpc-q', { type: 'question/requested', sessionId: 'session-main', questions: [{ id: 'q9', question: '等谁？' }] })
    render(<InteractionCards store={store} />)
    expect(screen.getByText('等谁？')).toBeTruthy()

    // Turn-cancel / teardown echo the ENGINE's own id — no client delivery matches.
    feed(store, 'unused', { type: 'question/resolved', sessionId: 'session-main', questionRpcId: 'engine-minted-id', outcome: 'cancelled' })
    expect(store.pendingCount).toBe(0)
    expect(screen.queryByText('等谁？')).toBeNull()
  })

  it('surfaces submit failures inline and keeps the answers editable', async () => {
    const respond = vi.fn((): Promise<RpcReceipt> => Promise.reject(new Error('dsh-api port disconnected')))
    const { store } = bootStore(respond)
    feed(store, 'rpc-q', {
      type: 'question/requested', sessionId: 'session-main',
      questions: [{ id: 'q1', question: '继续吗？', options: [{ label: '选项A' }] }],
    })
    render(<InteractionCards store={store} />)

    fireEvent.click(screen.getByRole('radio', { name: '选项A' }))
    // The single-select auto-advance stepped to the last question; submit from here.
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(await screen.findByText('dsh-api port disconnected')).toBeTruthy()
    const submitButton = screen.getByRole('button', { name: '提交' })
    expect(submitButton.hasAttribute('disabled')).toBe(false)
    expect(store.pendingCount).toBe(1)
  })

  it('renders nothing while no wait is pending', () => {
    const { store } = bootStore()
    const view = render(<InteractionCards store={store} />)
    expect(view.container.firstChild).toBeNull()
  })
})

describe('INTERACTION_CARDS_CSS button discipline', () => {
  /** The body of the named rule (selector start → closing brace). */
  const rule = (selector: string): string => {
    const at = INTERACTION_CARDS_CSS.indexOf(selector)
    expect(at).toBeGreaterThanOrEqual(0)
    return INTERACTION_CARDS_CSS.slice(at, INTERACTION_CARDS_CSS.indexOf('}', at) + 1)
  }

  it('pins operation-button labels to one line', () => {
    expect(rule('.dshx-ixbtn{')).toContain('white-space:nowrap')
    // Ask-option labels ellipsize on one line too (the 提交中… busy state rides dshx-ixbtn).
    expect(rule('.dshx-ixopt-label{')).toContain('white-space:nowrap')
    expect(rule('.dshx-ixopt-label{')).toContain('text-overflow:ellipsis')
  })

  it('keeps option descriptions wrappable — content, not a label', () => {
    expect(rule('.dshx-ixopt-desc{')).not.toContain('white-space')
  })

  it('wraps the approval and question footer rows as whole buttons', () => {
    expect(rule('.dshx-ixactions{')).toContain('flex-wrap:wrap')
    expect(rule('.dshx-ixnav{')).toContain('flex-wrap:wrap')
  })

  it('flips the brand-fill foregrounds to ink in dark mode', () => {
    // The brand alias is near-white in dark; the hard-coded #fff on the
    // question badge and the primary action button would vanish without the
    // dark-theme override.
    expect(INTERACTION_CARDS_CSS).toContain(
      'body[data-ds-dark-theme] .dshx-ixbadge--question,body[data-ds-dark-theme] .dshx-ixbtn--primary{color:var(--dsw-static-neutral-bluish-1000,#171717)}',
    )
  })
})
