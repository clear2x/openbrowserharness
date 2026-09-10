/**
 * Seedable random source shared by the humanized input modules
 * (ported from the OpenBrowserHarness reference implementation).
 *
 * Default instance is stateless over Math.random; `createRng(seed)`
 * (mulberry32) gives reproducible sequences for unit tests.
 */

export interface Rng {
  /** Raw random number in [0, 1). */
  next(): number
  /** Uniform float in [min, max) (defaults 0..1). */
  rand(min?: number, max?: number): number
  /** Uniform integer in the closed range [min, max]. */
  randInt(min: number, max: number): number
  /** True with probability p. */
  chance(p: number): boolean
}

/** mulberry32: compact, good enough for behavior simulation. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a string seed → uint32; numeric seeds truncate. */
function hashSeed(seed: string | number): number {
  if (typeof seed === 'number') return seed >>> 0
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Create an rng; with a seed the sequence is reproducible. */
export function createRng(seed?: string | number): Rng {
  const next: () => number =
    seed === undefined ? () => Math.random() : mulberry32(hashSeed(seed))
  const rand = (min = 0, max = 1): number => min + next() * (max - min)
  return {
    next,
    rand,
    randInt(min: number, max: number): number {
      // next() is strictly < 1, so flooring never steps past max.
      return Math.floor(rand(min, max + 1))
    },
    chance(p: number): boolean {
      return next() < p
    },
  }
}
