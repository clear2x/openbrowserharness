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
    expect(entries[0]).toEqual(expect.objectContaining({ capability: 'embed', ts: expect.any(Number) }))
    expect(entries[1]).toEqual(expect.objectContaining({ capability: 'ocr' }))
    expect(JSON.parse(fs.files.get('ai-local/usage.json')!).entries.length).toBe(2)
  })

  it('caps the usage ledger at 50 rows', async () => {
    const { manager, fs } = makeManager()
    for (let index = 0; index < 55; index += 1) {
      await manager.recordUsage({ capability: 'ocr', model: 'm', durationMs: 1, detail: String(index) })
    }
    const { entries } = await manager.usage()
    expect(entries).toHaveLength(50)
    expect(JSON.parse(fs.files.get('ai-local/usage.json')!).entries.length).toBe(50)
  })

  it('survives ledger write failures invisibly', async () => {
    const { manager, fs } = makeManager()
    fs.broken = true
    await expect(manager.recordUsage({ capability: 'ocr', model: 'm', durationMs: 1, detail: 'x' })).resolves.toBeUndefined()
    const { entries } = await manager.usage()
    expect(entries).toHaveLength(0)
  })
})
