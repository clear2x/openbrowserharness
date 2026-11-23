/**
 * Pacing of one local transcription (batch 280-F). Whisper-base runs on the
 * CPU wasm backend at a machine-dependent rate (measured ≈2.4× realtime on
 * Apple Silicon; far slower elsewhere), so a fixed ceiling on video length
 * cannot promise a bounded wait: a slow machine would burn the whole budget
 * and return nothing. The audio is therefore transcribed window by window
 * and the measured rate decides, after every window, whether the next one
 * still fits the budget — a run that cannot finish stops with the transcript
 * it has, and the index records how far that transcript reaches.
 *
 * @module ai-runtime/asr-pacing
 */

/** Default wall-clock budget for one transcription (ms); the caller's deadline sits above it. */
export const DEFAULT_ASR_BUDGET_MS = 300_000
/** The nominal length of one pacing window (seconds). */
export const ASR_WINDOW_S = 60
/** A remainder shorter than this (seconds) stays with the window before it. */
export const ASR_MIN_TAIL_S = 10
/** How far around a nominal cut the planner looks for the quietest moment (seconds). */
export const ASR_CUT_SEARCH_S = 3
/** The frame the quietest-moment search scores (seconds). */
export const ASR_CUT_FRAME_S = 0.02

/**
 * The sample index where the quietest frame of a range starts.
 * @param samples - the mono samples.
 * @param from - the range start (sample index; negative values clamp to 0).
 * @param to - the last start position the search may reach.
 * @param frame - the frame length in samples.
 * @returns the quietest frame's start index; `from` (clamped into the audio) when the range is empty.
 */
function quietestFrameStart(samples: Float32Array, from: number, to: number, frame: number): number {
  const first = Math.max(0, from)
  const last = Math.min(samples.length - frame, to)
  let best = Math.min(Math.max(from, 0), samples.length)
  let bestEnergy = Number.POSITIVE_INFINITY
  for (let start = first; start <= last; start += frame) {
    let energy = 0
    for (let index = start; index < start + frame; index += 1) {
      const value = samples[index]
      if (value !== undefined) energy += value * value
    }
    if (energy < bestEnergy) {
      bestEnergy = energy
      best = start
    }
  }
  return best
}

/**
 * Plan the cut points of one paced transcription: every window is about
 * `windowS` long, each cut moved to the quietest frame within
 * `ASR_CUT_SEARCH_S` of its nominal position so a pause — not a word —
 * takes the cut; a remainder shorter than `ASR_MIN_TAIL_S` stays with the
 * window before it.
 * @param samples - the mono 16 kHz samples.
 * @param sampleRate - the sample rate (Hz).
 * @param windowS - the nominal window length (seconds).
 * @returns cut points as sample indexes, ascending; empty for audio that fits one window.
 */
export function planAsrCuts(samples: Float32Array, sampleRate: number, windowS = ASR_WINDOW_S): number[] {
  const window = Math.round(windowS * sampleRate)
  const minTail = Math.round(ASR_MIN_TAIL_S * sampleRate)
  const search = Math.round(ASR_CUT_SEARCH_S * sampleRate)
  const frame = Math.max(1, Math.round(ASR_CUT_FRAME_S * sampleRate))
  const cuts: number[] = []
  for (let nominal = window; nominal + minTail < samples.length; nominal += window) {
    cuts.push(quietestFrameStart(samples, nominal - search, nominal + search, frame))
  }
  return cuts
}

/**
 * Decide, after one window, whether the next one still fits the budget. The
 * next window's cost is projected from the average cost per millisecond of
 * audio so far.
 * @param params - audio done and left, time spent, the budget, and the nominal window length (all ms).
 * @returns false when the next window is projected to end after the budget (or nothing is left to do).
 */
export function asrNextWindowFits(params: {
  processedMs: number
  remainingMs: number
  elapsedMs: number
  budgetMs: number
  windowMs: number
}): boolean {
  const { processedMs, remainingMs, elapsedMs, budgetMs, windowMs } = params
  if (remainingMs <= 0 || processedMs <= 0) return false
  const nextMs = Math.min(windowMs, remainingMs)
  return elapsedMs + (elapsedMs / processedMs) * nextMs <= budgetMs
}
