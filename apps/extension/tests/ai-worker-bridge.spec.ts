/**
 * The AI worker bridge's retry policy. A crashed or timed-out worker is
 * replaced and the request tried once more — except for the CPU-bound
 * transcription, whose timeout means the machine is too slow for the job:
 * a second attempt would spend the same budget for the same answer.
 * @module ai-worker-bridge
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Bridge = typeof import('../src/offscreen/ai-runtime/worker-bridge.ts')

/** The fake worker the bridge creates: records its calls, never answers unless told to. */
interface FakeWorker {
  terminate: ReturnType<typeof vi.fn>
  postMessage: ReturnType<typeof vi.fn>
}

const created: FakeWorker[] = []
let deliver: (message: { id: number; ok: boolean; result?: unknown }) => void = () => {}
let bridge: Bridge

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  created.length = 0
  vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => `chrome-extension://test/${path}` } })
  vi.stubGlobal('Worker', class {
    terminate = vi.fn()
    postMessage = vi.fn()
    addEventListener = vi.fn((type: string, handler: (event: { data: unknown }) => void) => {
      if (type === 'message') {
        deliver = (message) => {
          handler({ data: message })
        }
      }
    })
    constructor() {
      created.push(this)
    }
  })
  bridge = await import('../src/offscreen/ai-runtime/worker-bridge.ts')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('transcription requests', () => {
  it('gives a timed-out transcription one attempt and names the cause', async () => {
    const pending = bridge.transcribeInWorker(new Float32Array(16), 1_000)

    const rejected = expect(pending).rejects.toThrow('本地转写超时（已运行 61 秒）：这台设备的转写速度太慢')
    await vi.advanceTimersByTimeAsync(61_000)
    await rejected

    expect(created).toHaveLength(1)
    expect(created[0]?.terminate).toHaveBeenCalledTimes(1)
    expect(created[0]?.postMessage).toHaveBeenCalledTimes(1)
  })

  it('carries the budget in the request and resolves the reply', async () => {
    const samples = new Float32Array(16)
    const pending = bridge.transcribeInWorker(samples, 5_000)
    const reply = { segments: [], processedMs: 1, truncated: false }
    deliver({ id: 1, ok: true, result: reply })

    await expect(pending).resolves.toEqual(reply)
    expect(created[0]?.postMessage).toHaveBeenCalledWith({ id: 1, kind: 'transcribe', samples, budgetMs: 5_000 })
  })
})

describe('every other request', () => {
  it('retries a timed-out OCR once on a fresh worker before failing', async () => {
    const pending = bridge.ocrInWorker(new Uint8ClampedArray(4), 1, 1)

    const rejected = expect(pending).rejects.toThrow('AI worker 请求超时（ocr，180s）')
    await vi.advanceTimersByTimeAsync(360_000)
    await rejected

    expect(created).toHaveLength(2)
    expect(created[0]?.terminate).toHaveBeenCalledTimes(1)
    expect(created[1]?.terminate).toHaveBeenCalledTimes(1)
    expect(created.map(worker => worker.postMessage.mock.calls.length)).toEqual([1, 1])
  })
})
