// @vitest-environment jsdom
/**
 * Native 轨迹 view spec: the row folder (buildTrajectoryRows) mapping the
 * durable event log to trajectory rows, the toolbar counts and text filter,
 * and the fresh-session empty state.
 *
 * Covered contracts:
 * - buildTrajectoryRows: turn separators, user/assistant text rows, tool
 *   call+result rows (failure coloring), and unknown-type skipping;
 * - TrajectoryHost: toolbar renders the turn/call counts, rows render in log
 *   order through the mocked history RPC, the search input filters rows, and
 *   the fresh-session sentinel renders the explicit empty state without any
 *   RPC.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { buildTrajectoryLanes, buildTrajectoryRows, formatDuration, TrajectoryHost } from '../src/sidepanel-dsh/trajectory-host.tsx'

afterEach(() => { cleanup(); vi.clearAllMocks() })

vi.mock('../src/sidepanel-dsh/rpc-client.ts', () => ({
  rpc: vi.fn(),
}))

import { rpc } from '../src/sidepanel-dsh/rpc-client.ts'
const rpcMock = vi.mocked(rpc)

const SEED_EVENTS = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  {
    type: 'user/message', seq: 1, time: 2, surfaceOp: 'append',
    data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '帮我查一下页面上的按钮' }], source: { kind: 'user' } },
  },
  {
    type: 'assistant/message', seq: 2, time: 3, surfaceOp: 'append',
    data: { turn: 1, step: 1, stream: [], message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '我先点一下按钮看看。' }], source: { kind: 'model', provider: 'deepseek', model: 'm' } } },
  },
  { type: 'tool/call', seq: 3, time: 4, data: { turn: 1, step: 1, name: 'page_click', arguments: '{"index":3}' } },
  {
    type: 'tool/result', seq: 4, time: 5, surfaceOp: 'append',
    data: { turn: 1, step: 1, message: { id: 't1', role: 'tool', source: { kind: 'tool', callId: 'c1', name: 'page_click' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '按钮已点击' }] }] } },
  },
  {
    type: 'assistant/message', seq: 5, time: 6, surfaceOp: 'append',
    data: { turn: 1, step: 2, stream: [], message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: '按钮点击成功，任务完成。' }], source: { kind: 'model', provider: 'deepseek', model: 'm' } } },
  },
  { type: 'turn/end', seq: 6, time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
]

describe('buildTrajectoryRows', () => {
  it('folds the durable log into ordered timeline cards, merging the tool pair', () => {
    const rows = buildTrajectoryRows(SEED_EVENTS)
    expect(rows.map(row => row.kind)).toEqual([
      'turn', 'user', 'assistant', 'tool', 'assistant',
    ])
    expect(rows[0]?.label).toBe('第 1 轮')
    expect(rows[1]?.text).toContain('帮我查一下页面上的按钮')
    // The paired call+result reads as one card: tool name pill, args, arrow, result, duration.
    expect(rows[3]).toMatchObject({
      label: 'page_click',
      ok: true,
      result: '按钮已点击',
      durationMs: 1,
    })
    expect(rows[3]?.text).toContain('{"index":3}')
  })

  it('pairs by callId, falls back to the most recent unresolved call, and keeps orphan results', () => {
    const rows = buildTrajectoryRows([
      { type: 'tool/call', seq: 0, time: 10, data: { callId: 'a', name: 'page_click', arguments: '{"index":1}' } },
      { type: 'tool/call', seq: 1, time: 20, data: { callId: 'b', name: 'page_type', arguments: '{"text":"x"}' } },
      // callId-less call pairs with the next result in order.
      { type: 'tool/call', seq: 2, time: 30, data: { name: 'page_snapshot', arguments: '{}' } },
      // Out-of-order result for callId b first: the id map routes it.
      { type: 'tool/result', seq: 3, time: 50, data: { message: { content: [{ type: 'tool-result', toolCallId: 'b', content: [{ type: 'text', text: 'typed' }] }] } } },
      { type: 'tool/result', seq: 4, time: 60, data: { message: { content: [{ type: 'tool-result', toolCallId: 'a', content: [{ type: 'text', text: 'clicked' }] }] } } },
      // Unknown callId with an unresolved id-less call waiting: the
      // order-based fallback claims it (the orphan-own-row path is covered
      // by the error-result test below, where no call exists at all).
      { type: 'tool/result', seq: 5, time: 70, data: { message: { content: [{ type: 'tool-result', toolCallId: 'zzz', content: [{ type: 'text', text: 'orphan' }] }] } } },
    ])
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ label: 'page_click', result: 'clicked', durationMs: 50 })
    expect(rows[1]).toMatchObject({ label: 'page_type', result: 'typed', durationMs: 30 })
    expect(rows[2]).toMatchObject({ label: 'page_snapshot', result: 'orphan', durationMs: 40 })
  })

  it('marks an error tool result as failed and skips unknown event types', () => {
    const rows = buildTrajectoryRows([
      { type: 'tool/result', seq: 0, time: 1, data: { message: { id: 't', role: 'tool', source: { kind: 'tool', callId: 'c9' }, content: [{ type: 'tool-result', toolCallId: 'c9', content: [{ type: 'text', text: 'boom' }], isError: true }] } } },
      { type: 'dsh-future-thing', seq: 1, time: 2, data: {} },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.ok).toBe(false)
    expect(rows[0]?.text).toContain('boom')
  })

  it('keeps a tool-call-only assistant step as a subdued card', () => {
    const rows = buildTrajectoryRows([
      { type: 'assistant/message', seq: 0, time: 1, data: { message: { content: [{ type: 'tool-use', id: 'u1', name: 'page_click', arguments: '{}' }] } } },
      { type: 'assistant/message', seq: 1, time: 2, data: { message: { content: [] } } },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'assistant', subdued: true, text: '（仅工具调用）' })
  })
})

describe('buildTrajectoryLanes + formatDuration', () => {
  it('folds rows into the three normalized lanes and renders only with a real span', () => {
    const rows = buildTrajectoryRows(SEED_EVENTS)
    const lanes = buildTrajectoryLanes(rows, 7)
    expect(lanes).not.toBeNull()
    expect(lanes?.input).toHaveLength(1)
    expect(lanes?.model).toHaveLength(2)
    expect(lanes?.tool).toEqual([{ start: 4, end: 5 }])
    expect(buildTrajectoryLanes(rows, 1)).toBeNull()
    expect(buildTrajectoryLanes([], 5)).toBeNull()
  })

  it('formats the duration ladder', () => {
    expect(formatDuration(650)).toBe('650ms')
    expect(formatDuration(1200)).toBe('1.2s')
    expect(formatDuration(138_000)).toBe('2分18秒')
    expect(formatDuration(120_000)).toBe('2分')
  })
})

describe('TrajectoryHost', () => {
  function mockHistory(events: unknown[]): void {
    // The wire wraps every row: { events: [{ event: {...} }] }.
    rpcMock.mockResolvedValue({ ok: true, value: { events: events.map(event => ({ event })) } })
  }

  it('renders the toolbar counts and the event rows in log order', async () => {
    mockHistory(SEED_EVENTS)
    const { container, getByLabelText } = render(
      createElement(TrajectoryHost, { sessionId: 'session-main', refreshSeq: 0 }),
    )
    await waitFor(() => {
      expect(getByLabelText('搜索轨迹')).not.toBeNull()
      expect(container.textContent).toContain('按钮点击成功，任务完成。')
    })
    expect(container.textContent).toContain('第 1 轮')
    expect(container.textContent).toContain('用户')
    expect(container.textContent).toContain('助手')
    // merged tool card: name pill + args + arrow + result on one card
    expect(container.textContent).toContain('page_click')
    expect(container.textContent).toContain('按钮已点击')
    // swimlane strip renders with the three lane rows
    expect(container.querySelectorAll('.dshx-trj-lane')).toHaveLength(3)
    const toolbar = container.querySelector('.dshx-trj-toolbar')
    expect(toolbar?.textContent).toContain('1')
    expect(toolbar?.textContent).toContain('时长')
  })

  it('filters rows through the search input', async () => {
    mockHistory(SEED_EVENTS)
    const { container, getByLabelText } = render(
      createElement(TrajectoryHost, { sessionId: 'session-main', refreshSeq: 0 }),
    )
    await waitFor(() => { expect(container.textContent).toContain('帮我查一下页面上的按钮') })
    const input = getByLabelText('搜索轨迹')
    fireEvent.input(input, { target: { value: 'page_click' } })
    await waitFor(() => { expect(container.textContent).not.toContain('帮我查一下页面上的按钮') })
    expect(container.textContent).toContain('page_click')
  })

  it('renders the explicit empty state for the fresh-session start without any RPC', async () => {
    const { container } = render(
      createElement(TrajectoryHost, { sessionId: 'session-new', refreshSeq: 0 }),
    )
    await waitFor(() => {
      expect(container.textContent).toContain('新会话还没有轨迹')
    })
    expect(rpcMock).not.toHaveBeenCalled()
  })
})
