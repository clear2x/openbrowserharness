/**
 * The device-tier probe: what inference hardware this browser/machine pair
 * actually offers. Gating is honest about the trap cases — Chromium's
 * SwiftShader fallback reports a working WebGPU adapter but runs every
 * matmul on the CPU (so it must gate like `unavailable`), and `LanguageModel`
 * may exist while its model is still un-downloaded.
 *
 * @module ai-runtime/device
 */
import type { DeviceProbe, DeviceProbeInput, NanoTier, WebGpuTier } from './types.ts'

/**
 * Map the probed adapter/nano verdicts onto the public tiers. Pure, so tests
 * pin every cell of the matrix without real GPU access.
 * @param input - the resolved probe inputs.
 * @returns the public device probe.
 */
export function describeDeviceEnvironment(input: DeviceProbeInput): DeviceProbe {
  const webgpu: WebGpuTier = input.webgpuAdapter ?? 'unavailable'
  const geminiNano: NanoTier = input.nanoAvailability === null
    ? 'unsupported'
    : input.nanoAvailability === 'available'
      ? 'ready'
      : input.nanoAvailability === 'unavailable'
        ? 'unavailable'
        : 'downloadable'
  return { webgpu, geminiNano }
}

/**
 * Whether a model whose {@link AiLocalModelSpec.minDevice} is `webgpu` may
 * run on this machine. The SwiftShader fallback counts as CPU-only: a
 * generative VLM over software rasterization is not a usable experience.
 * @param probe - the current device probe.
 * @returns true when a real GPU adapter answered.
 */
export function webgpuCapable(probe: DeviceProbe): boolean {
  return probe.webgpu === 'real'
}

/**
 * Probe the real environment: a WebGPU adapter request plus the built-in
 * `LanguageModel` availability. Both probes fail soft — a missing or throwing
 * API degrades its tier instead of failing the probe.
 * @returns the resolved device probe.
 */
export async function probeDeviceEnvironment(): Promise<DeviceProbe> {
  const webgpuAdapter = await probeWebGpuAdapter()
  const nanoAvailability = await probeNanoAvailability()
  return describeDeviceEnvironment({ webgpuAdapter, nanoAvailability })
}

/**
 * Ask for one WebGPU adapter and classify it. `isFallbackAdapter` is the
 * Chromium contract for the software (SwiftShader) path; a missing
 * `navigator.gpu` or a rejected request reports no GPU.
 */
async function probeWebGpuAdapter(): Promise<'real' | 'software' | null> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu
  if (gpu === undefined) return null
  try {
    const adapter = await gpu.requestAdapter()
    if (adapter === null) return null
    // Chromium's software-rasterizer contract: `isFallbackAdapter` is not yet
    // in the TS DOM lib, so read it off the structural shape instead of
    // assuming the lib's GPUAdapter surface.
    const flags = adapter as { isFallbackAdapter?: boolean }
    return flags.isFallbackAdapter === true ? 'software' : 'real'
  } catch {
    return null
  }
}

/**
 * Read the built-in Gemini Nano availability. The API ships progressively
 * (Chrome 138 extensions / ~148 web, Edge behind its own rollout), so every
 * failure shape — absent global, throwing call — reports `null` and the
 * pure mapper turns that into `unsupported`.
 */
async function probeNanoAvailability(): Promise<DeviceProbeInput['nanoAvailability']> {
  const g = globalThis as typeof globalThis & { LanguageModel?: { availability?: () => Promise<string> } }
  const lm = g.LanguageModel
  if (lm === undefined || typeof lm.availability !== 'function') return null
  try {
    const verdict = await lm.availability()
    return verdict === 'available' || verdict === 'downloadable' || verdict === 'downloading' || verdict === 'unavailable'
      ? verdict
      : null
  } catch {
    return null
  }
}
