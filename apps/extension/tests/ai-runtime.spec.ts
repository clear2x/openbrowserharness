/**
 * The on-device AI runtime substrate: the device-tier mapping matrix, the
 * catalog's hard size ceiling, and the manager's lifecycle-state machine
 * over a memory fs double. The real probes (GPU adapter, LanguageModel) are
 * exercised by the on-device probe; these specs pin the decision logic.
 *
 * @module ai-runtime.spec
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AI_LOCAL_CATALOG, assertCatalogWithinBudget, MAX_MODEL_BYTES } from '../src/offscreen/ai-runtime/catalog.ts'
import { asrNextWindowFits, planAsrCuts } from '../src/offscreen/ai-runtime/asr-pacing.ts'
import { describeDeviceEnvironment, probeDeviceEnvironment, webgpuCapable } from '../src/offscreen/ai-runtime/device.ts'
import { AiLocalManager } from '../src/offscreen/ai-runtime/manager.ts'
import { AiLocalError } from '../src/offscreen/ai-runtime/types.ts'
import type { AiLocalModelSpec } from '../src/offscreen/ai-runtime/catalog.ts'
import type { DeviceProbe } from '../src/offscreen/ai-runtime/types.ts'

describe('describeDeviceEnvironment', () => {
  it('maps a real adapter to the real GPU tier and Nano availability verbatim', () => {
    expect(describeDeviceEnvironment({ webgpuAdapter: 'real', nanoAvailability: 'available' })).toEqual({
      webgpu: 'real',
      geminiNano: 'ready',
    })
  })

  it('maps the SwiftShader fallback to the software tier, not real', () => {
    expect(describeDeviceEnvironment({ webgpuAdapter: 'software', nanoAvailability: 'downloadable' })).toEqual({
      webgpu: 'software',
      geminiNano: 'downloadable',
    })
  })

  it('maps downloading Nano to downloadable and unavailable Nano verbatim', () => {
    expect(describeDeviceEnvironment({ webgpuAdapter: 'real', nanoAvailability: 'downloading' }).geminiNano).toBe('downloadable')
    expect(describeDeviceEnvironment({ webgpuAdapter: 'real', nanoAvailability: 'unavailable' }).geminiNano).toBe('unavailable')
  })

  it('maps missing globals to unavailable / unsupported', () => {
    expect(describeDeviceEnvironment({ webgpuAdapter: null, nanoAvailability: null })).toEqual({
      webgpu: 'unavailable',
      geminiNano: 'unsupported',
    })
  })

  it('gates webgpu models on a real adapter only', () => {
    expect(webgpuCapable({ webgpu: 'real', geminiNano: 'unsupported' })).toBe(true)
    expect(webgpuCapable({ webgpu: 'software', geminiNano: 'unsupported' })).toBe(false)
    expect(webgpuCapable({ webgpu: 'unavailable', geminiNano: 'unsupported' })).toBe(false)
  })
})

describe('probeDeviceEnvironment', () => {
  it('reports an honest tier set on a WebGPU-less Node runtime', async () => {
    // Node has neither navigator.gpu nor LanguageModel: the probe degrades
    // both instead of throwing.
    const probe = await probeDeviceEnvironment()
    expect(probe.webgpu).toBe('unavailable')
    expect(probe.geminiNano).toBe('unsupported')
  })
})

describe('catalog', () => {
  it('keeps every shipped entry inside the 1 GiB ceiling', () => {
    expect(() => { assertCatalogWithinBudget(AI_LOCAL_CATALOG) }).not.toThrow()
    for (const spec of AI_LOCAL_CATALOG) {
      expect(spec.declaredBytes).toBeGreaterThan(0)
      expect(spec.declaredBytes).toBeLessThanOrEqual(MAX_MODEL_BYTES)
    }
  })

  it('ships every entry except the landed rows as a roadmap row', () => {
    const landed = new Set(['ocr-ppocr-mobile', 'caption-smolvlm2-256m', 'asr-whisper-base', 'embed-e5-small'])
    for (const spec of AI_LOCAL_CATALOG) {
      expect(spec.planned).toBe(!landed.has(spec.id))
    }
  })

  it('rejects a catalog that breaks the size ceiling or repeats an id', () => {
    const over: AiLocalModelSpec[] = [{
      id: 'huge', label: 'huge', task: 'embedding', purposeZh: 'x',
      declaredBytes: MAX_MODEL_BYTES + 1, minDevice: 'any', planned: false,
    }]
    expect(() => { assertCatalogWithinBudget(over) }).toThrow(AiLocalError)
    expect(() => { assertCatalogWithinBudget(over) }).toThrow(/1GB/)
    const fine: AiLocalModelSpec[] = [{ ...over[0]!, declaredBytes: 1024 }]
    const dup: AiLocalModelSpec[] = [fine[0]!, { ...fine[0]! }]
    expect(() => { assertCatalogWithinBudget(dup) }).toThrow(/重复/)
  })
})

/** A memory fs double over the manager's narrow seam. */
class MemoryFs {
  readonly files = new Map<string, string>()
  broken = false

  async resolve(path: string): Promise<{ path: string }> {
    if (this.broken) throw new Error('fs broken')
    return { path }
  }

  async readText(target: { path: string }): Promise<string> {
    const content = this.files.get(target.path)
    if (content === undefined) throw new Error(`not found: ${target.path}`)
    return content
  }

  async writeText(target: { path: string }, content: string): Promise<undefined> {
    this.files.set(target.path, content)
    return undefined
  }

  async deleteFile(target: { path: string }): Promise<undefined> {
    this.files.delete(target.path)
    return undefined
  }
}

const PROBE: DeviceProbe = { webgpu: 'real', geminiNano: 'ready' }

describe('AiLocalManager', () => {
  const testCatalog: AiLocalModelSpec[] = [{
    id: 'm1',
    label: 'M1',
    task: 'embedding',
    purposeZh: 'test',
    declaredBytes: 1024,
    minDevice: 'any',
    planned: false,
  }, {
    id: 'p1',
    label: 'P1',
    task: 'ocr',
    purposeZh: 'test',
    declaredBytes: 1024,
    minDevice: 'any',
    planned: true,
  }]

  function makeManager(probeFn: () => Promise<DeviceProbe> = async () => PROBE): {
    manager: AiLocalManager
    fs: MemoryFs
  } {
    const fs = new MemoryFs()
    return { manager: new AiLocalManager(new Context(), fs, probeFn, testCatalog), fs }
  }

  it('reports planned rows as unavailable and keeps them out of the state file', async () => {
    const { manager } = makeManager()
    const view = await manager.catalog()
    expect(view.models.every(row => row.state === 'unavailable')).toBe(true)
    expect(view.device.webgpu).toBe(PROBE.webgpu)
    expect(view.device.geminiNano).toBe(PROBE.geminiNano)
    expect(typeof view.device.at).toBe('number')
    await expect(manager.markReady('p1', 100)).rejects.toThrow(/尚未开放下载/)
    await expect(manager.removeModel('nope')).rejects.toThrow(/未知模型/)
  })

  it('persists a ready row and clears it on remove', async () => {
    const { manager, fs } = makeManager()
    await manager.markReady('m1', 2048)
    const ready = await manager.catalog()
    const m1 = ready.models.find(row => row.id === 'm1')
    expect(m1).toEqual(expect.objectContaining({ state: 'ready', sizeBytes: 2048 }))
    expect(ready.models.find(row => row.id === 'p1')).toEqual(expect.objectContaining({ state: 'unavailable', planned: true }))
    const persisted = JSON.parse(fs.files.get('ai-local/state.json')!) as { models: Record<string, unknown> }
    expect(Object.keys(persisted.models)).toEqual(['m1'])
    await manager.removeModel('m1')
    const view = await manager.catalog()
    expect(view.models[0]!.state).toBe('unavailable')
  })

  it('rejects a measured size beyond the ceiling and a failed row survives a re-read', async () => {
    const { manager } = makeManager()
    await expect(manager.markReady('m1', MAX_MODEL_BYTES + 1)).rejects.toThrow(/1GB/)
    await manager.markFailed('m1', '磁盘满')
    const view = await manager.catalog()
    expect(view.models[0]!.state).toBe('failed')
    expect(view.models[0]!.error).toBe('磁盘满')
  })

  it('caches the device probe within its TTL', async () => {
    const probeFn = vi.fn(async () => PROBE)
    const { manager } = makeManager(probeFn)
    await manager.probe()
    await manager.probe()
    expect(probeFn).toHaveBeenCalledTimes(1)
  })

  it('keeps a usage ledger: newest first, capped, ts stamped, readable', async () => {
    const { manager, fs } = makeManager()
    await manager.recordUsage({ capability: 'ocr', model: 'PP-OCRv4-mobile', durationMs: 120, detail: '字幕测试' })
    await manager.recordUsage({ capability: 'embed', model: 'e5-small', durationMs: 80, detail: 'top8/40' })
    const { entries } = await manager.usage()
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ capability: 'embed' })
    expect(typeof entries[0]?.ts).toBe('number')
    expect(entries[1]).toEqual(expect.objectContaining({ capability: 'ocr' }))
    expect((JSON.parse(fs.files.get('ai-local/usage.json') ?? 'null') as { entries: unknown[] }).entries).toHaveLength(2)
  })

  it('caps the usage ledger at 50 rows', async () => {
    const { manager, fs } = makeManager()
    for (let index = 0; index < 55; index += 1) {
      await manager.recordUsage({ capability: 'ocr', model: 'm', durationMs: 1, detail: String(index) })
    }
    const { entries } = await manager.usage()
    expect(entries).toHaveLength(50)
    expect((JSON.parse(fs.files.get('ai-local/usage.json') ?? 'null') as { entries: unknown[] }).entries).toHaveLength(50)
  })

  it('survives ledger write failures invisibly', async () => {
    const { manager, fs } = makeManager()
    fs.broken = true
    await expect(manager.recordUsage({ capability: 'ocr', model: 'm', durationMs: 1, detail: 'x' })).resolves.toBeUndefined()
    const { entries } = await manager.usage()
    expect(entries).toHaveLength(0)
  })
})

describe('local transcription pacing (批280-F)', () => {
  const rate = 16_000

  /** A loud tone with one near-silent dip at `dipS` — a pause between words. */
  const tone = (seconds: number, dipS: number): Float32Array => {
    const samples = new Float32Array(Math.round(seconds * rate))
    for (let index = 0; index < samples.length; index += 1) {
      const time = index / rate
      samples[index] = Math.abs(time - dipS) < 0.05 ? 0.001 : Math.abs(Math.sin(2 * Math.PI * 220 * time)) * 0.5
    }
    return samples
  }

  it('cuts every window at the quietest moment near its nominal position', () => {
    const cuts = planAsrCuts(tone(200, 61.5), rate)

    expect(cuts).toHaveLength(3)
    const first = (cuts[0] ?? 0) / rate
    expect(first).toBeGreaterThan(61.4)
    expect(first).toBeLessThan(61.6)
    for (const [position, nominal] of [[1, 120], [2, 180]] as const) {
      const at = (cuts[position] ?? 0) / rate
      expect(Math.abs(at - nominal)).toBeLessThanOrEqual(3.01)
    }
    expect(cuts).toEqual([...cuts].sort((a, b) => a - b))
  })

  it('keeps a short remainder with the window before it and leaves short audio whole', () => {
    expect(planAsrCuts(tone(69, 0), rate)).toHaveLength(0)
    expect(planAsrCuts(tone(61, 0), rate)).toHaveLength(0)
    expect(planAsrCuts(tone(75, 0), rate)).toHaveLength(1)
    expect(planAsrCuts(new Float32Array(0), rate)).toHaveLength(0)
  })

  it('projects the next window from the measured rate', () => {
    const windowMs = 60_000
    // 60 s of audio in 25 s: the next window ends at 50 s, well inside the budget.
    expect(asrNextWindowFits({ processedMs: 60_000, remainingMs: 349_000, elapsedMs: 25_000, budgetMs: 300_000, windowMs })).toBe(true)
    // 60 s of audio per 100 s: after two windows the third ends exactly at the budget.
    expect(asrNextWindowFits({ processedMs: 120_000, remainingMs: 289_000, elapsedMs: 200_000, budgetMs: 300_000, windowMs })).toBe(true)
    // …and the fourth would end at 400 s: stop here with three windows done.
    expect(asrNextWindowFits({ processedMs: 180_000, remainingMs: 229_000, elapsedMs: 300_000, budgetMs: 300_000, windowMs })).toBe(false)
    // A short tail costs less than a window: 40 s of audio in 40 s, 20 s left, 40 s of budget.
    expect(asrNextWindowFits({ processedMs: 40_000, remainingMs: 20_000, elapsedMs: 40_000, budgetMs: 80_000, windowMs })).toBe(true)
    // Nothing left means no next window.
    expect(asrNextWindowFits({ processedMs: 409_000, remainingMs: 0, elapsedMs: 170_000, budgetMs: 300_000, windowMs })).toBe(false)
  })
})
