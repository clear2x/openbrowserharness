import { describe, expect, it } from 'vitest'
import { ToolCallId, createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import {
  applyUserQuestionEvent, foldUserQuestions, isTimedAskUserQuestionSchema, TIMED_WAIT_PARAMETER,
} from '../src/projection.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { UserQuestionFold } from '../src/projection.ts'

let seq = 0
const nextSeq = (): number => SessionSeq(++seq)

const timedHeader = (): SessionEvent => ({
  type: 'request/header', seq: nextSeq(), time: 0,
  data: { header: { tools: [timedSchema()] }, reason: 'initial' },
} as unknown as SessionEvent)

const legacyHeader = (): SessionEvent => ({
  type: 'request/header', seq: nextSeq(), time: 0,
  data: { header: { tools: [legacySchema()] }, reason: 'initial' },
} as unknown as SessionEvent)

function timedSchema(): { name: string; parameters: Record<string, unknown> } {
  return { name: 'ask_user_question', parameters: { type: 'object', properties: { questions: {}, [TIMED_WAIT_PARAMETER]: {} } } }
}

function legacySchema(): { name: string; parameters: Record<string, unknown> } {
  return { name: 'ask_user_question', parameters: { type: 'object', properties: { questions: {} } } }
}

const askCall = (callId: string): SessionEvent => ({
  type: 'tool/call', seq: nextSeq(), time: 0,
  data: {
    turn: 1, step: 1, callId: ToolCallId(callId), name: 'ask_user_question',
    arguments: JSON.stringify({ questions: [{ id: 'q1', question: 'Proceed?', options: [{ label: 'yes' }, { label: 'no' }] }] }),
  },
} as unknown as SessionEvent)

const v3ToolResult = (callId: string, body: string, opts: { isError?: boolean } = {}): SessionEvent => ({
  type: 'tool/result', seq: nextSeq(), time: 0, surfaceOp: 'append',
  data: {
    turn: 1, step: 1,
    message: createToolResultMessage({
      callId: ToolCallId(callId),
      content: [{ type: 'text', text: body }],
      isError: opts.isError === true,
    }),
  },
} as unknown as SessionEvent)

const lateReply = (callId: string, body: string): SessionEvent => ({
  type: 'user/message', seq: nextSeq(), time: 0, surfaceOp: 'append',
  data: {
    content: [{ type: 'text', text: body }],
    source: { kind: 'user-question-reply', callId: ToolCallId(callId), outcome: 'answered' },
    role: 'user',
  },
} as unknown as SessionEvent)

const ANSWERS = JSON.stringify({ answers: [{ id: 'q1', selected: ['yes'] }] })
const PENDING = JSON.stringify({ pending: true })

function foldWith(...events: SessionEvent[]): UserQuestionFold {
  return events.reduce(applyUserQuestionEvent, { timed: false, questions: { active: [], settled: [] } })
}

describe('isTimedAskUserQuestionSchema', () => {
  it('recognizes the schema by its timeout parameter', () => {
    expect(isTimedAskUserQuestionSchema(timedSchema())).toBe(true)
    expect(isTimedAskUserQuestionSchema(legacySchema())).toBe(false)
    expect(isTimedAskUserQuestionSchema({ name: 'bash', parameters: timedSchema().parameters })).toBe(false)
  })
})

describe('applyUserQuestionEvent', () => {
  it('tracks a timed call as open and settles it from its in-time result', () => {
    const fold = foldWith(timedHeader(), askCall('c1'))
    expect(fold.questions.active).toEqual([{
      callId: 'c1',
      questions: [{ id: 'q1', question: 'Proceed?', options: [{ label: 'yes' }, { label: 'no' }] }],
      state: 'open',
    }])

    const settled = foldWith(timedHeader(), askCall('c1'), v3ToolResult('c1', ANSWERS))
    expect(settled.questions.active).toEqual([])
    expect(settled.questions.settled).toEqual([{
      callId: 'c1',
      answers: [{ id: 'q1', selected: ['yes'] }],
    }])
  })

  it('never tracks calls under the legacy schema', () => {
    const fold = foldWith(legacyHeader(), askCall('c1'))
    expect(fold.questions.active).toEqual([])
    expect(fold.timed).toBe(false)
  })

  it('keeps a pending result answerable as continued', () => {
    const fold = foldWith(timedHeader(), askCall('c1'), v3ToolResult('c1', PENDING))
    expect(fold.questions.active[0]?.state).toBe('continued')
    expect(fold.questions.settled).toEqual([])
  })

  it('keeps the synthetic TOOL_OUTCOME_UNKNOWN repair result answerable as continued', () => {
    const interrupted = v3ToolResult('c1', 'The tool call was interrupted.', { isError: true })
    if (interrupted.type !== 'tool/result') throw new Error('unreachable')
    const fold = foldWith(timedHeader(), askCall('c1'), {
      ...interrupted,
      data: {
        ...interrupted.data,
        error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
      },
    })
    expect(fold.questions.active[0]?.state).toBe('continued')
  })

  it('drops a question whose result is a failure', () => {
    const fold = foldWith(timedHeader(), askCall('c1'), v3ToolResult('c1', 'boom', { isError: true }))
    expect(fold.questions.active).toEqual([])
    expect(fold.questions.settled).toEqual([])
  })

  it('settles a continued question from a late steered reply', () => {
    const fold = foldWith(
      timedHeader(), askCall('c1'), v3ToolResult('c1', PENDING),
      lateReply('c1', ANSWERS),
    )
    expect(fold.questions.active).toEqual([])
    expect(fold.questions.settled).toEqual([{ callId: 'c1', answers: [{ id: 'q1', selected: ['yes'] }] }])
  })

  it('a late reply for an unknown call changes nothing', () => {
    const before = foldWith(timedHeader(), askCall('c1'), v3ToolResult('c1', PENDING))
    const after = foldWith(timedHeader(), askCall('c1'), v3ToolResult('c1', PENDING), lateReply('c9', ANSWERS))
    expect(after.questions).toEqual(before.questions)
  })

  it('follows the header when a later series drops or adds the timed schema', () => {
    const dropped = foldWith(timedHeader(), legacyHeader(), askCall('c1'))
    expect(dropped.questions.active).toEqual([])

    const reAdded = foldWith(timedHeader(), legacyHeader(), timedHeader(), askCall('c1'))
    expect(reAdded.questions.active).toHaveLength(1)
  })
})

describe('foldUserQuestions', () => {
  it('folds a whole log to the same view the incremental fold reaches', () => {
    const events = [timedHeader(), askCall('c1'), v3ToolResult('c1', PENDING), lateReply('c1', ANSWERS)]
    expect(foldUserQuestions(events)).toEqual(
      events.reduce(applyUserQuestionEvent, { timed: false, questions: { active: [], settled: [] } }).questions,
    )
  })
})

describe('projection definition smoke', () => {
  it('wire view equals the fold view; the state carries the inherited offset', async () => {
    const { userQuestionProjectionDefinition } = await import('../src/projection.ts')
    const header = { sessionId: undefined, delegationDepth: 0 } as unknown as Parameters<typeof userQuestionProjectionDefinition.init>[0]
    const state = userQuestionProjectionDefinition.init(header, SessionLogOffset(3))
    expect(state.inheritedEventCount).toBe(SessionLogOffset(3))
    expect(state.timed).toBe(false)

    const event = timedHeader()
    const next = userQuestionProjectionDefinition.apply(state, event)
    expect(next.timed).toBe(true)
    expect(userQuestionProjectionDefinition.wire.view(next)).toEqual({ active: [], settled: [] })

    // Events below the inherited offset are ignored.
    expect(userQuestionProjectionDefinition.apply(state, { ...event, seq: SessionSeq(1) })).toBe(state)
  })
})

describe('createUserMessage source round trip', () => {
  it('a steered late reply keeps its user-question-reply source through message creation', () => {
    const message = createUserMessage({
      source: { kind: 'user-question-reply', callId: ToolCallId('c1'), outcome: 'answered' },
      content: [{ type: 'text', text: ANSWERS }],
    })
    expect(message.source.kind).toBe('user-question-reply')
  })
})
