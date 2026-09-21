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
import { buildTrajectoryRows, TrajectoryHost } from '../src/sidepanel-dsh/trajectory-host.tsx'

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
  it('folds the durable log into ordered trajectory rows', () => {
    const rows = buildTrajectoryRows(SEED_EVENTS)
    expect(rows.map(row => row.kind)).toEqual([
      'turn', 'user', 'assistant', 'tool', 'tool-result', 'assistant',
    ])
    expect(rows[0]?.label).toBe('第 1 轮')
    expect(rows[1]?.text).toContain('帮我查一下页面上的按钮')
    expect(rows[3]?.text).toContain('page_click')
    expect(rows[4]?.text).toContain('按钮已点击')
    expect(rows[4]?.ok).toBe(true)
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
    expect(container.textContent).toContain('工具')
    const toolbar = container.querySelector('.dshx-trj-toolbar')
    expect(toolbar?.textContent).toContain('1')
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
