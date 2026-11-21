/**
 * The companion-watch slice: grid sampling/diff math, the pace keep bar, the
 * session state machine, sheet geometry, and the tool registration shape.
 * The capture channel + canvas decode + attachment commit are exercised by
 * the automation probe (scenario D) on a real device.
 * @module sense-now
 */
import { describe, expect, it } from 'vitest'
import { GRID_COLS, GRID_ROWS, gridDiff, sampleGrid, shouldKeepFrame } from '../src/offscreen/sense-now/grid.ts'
import { sheetLayout } from '../src/offscreen/sense-now/sheets.ts'
import { SenseWatchSessions } from '../src/offscreen/sense-now/session.ts'
import { apply, registerSenseNowTool } from '../src/offscreen/chrome-sense-now-tool.ts'

/** One solid-color frame's RGBA data (每像素同色). */
function solidFrame(r: number, g: number, b: number, width = 64, height = 36): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = r
    data[index * 4 + 1] = g
    data[index * 4 + 2] = b
    data[index * 4 + 3] = 255
  }
  return data
}

/** One frame with the left half black and the right half white. */
function splitFrame(width = 64, height = 36): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      const value = x < width / 2 ? 0 : 255
      data[offset] = value
      data[offset + 1] = value
      data[offset + 2] = value
      data[offset + 3] = 255
    }
  }
  return data
}

describe('grid sampling and diff', () => {
  it('samples a solid frame to a flat grid', () => {
    const grid = sampleGrid(solidFrame(255, 255, 255), 64, 36)
    expect(grid).toHaveLength(GRID_COLS * GRID_ROWS)
    expect(grid[0]).toBeCloseTo(1, 5)
    expect(grid[grid.length - 1]).toBeCloseTo(1, 5)
  })
  it('scores a hard cut high (spikes) and identical frames at zero', () => {
    const a = sampleGrid(solidFrame(10, 10, 10), 64, 36)
    const same = sampleGrid(solidFrame(10, 10, 10), 64, 36)
    expect(gridDiff(a, same).mean).toBe(0)
    const b = sampleGrid(splitFrame(), 64, 36)
    const diff = gridDiff(a, b)
    expect(diff.mean).toBeGreaterThan(0.05)
    expect(diff.spikes).toBeGreaterThan(0)
  })
  it('keeps frames per pace: first always, identical never, hard cut always', () => {
    const a = sampleGrid(solidFrame(10, 10, 10), 64, 36)
    const hard = gridDiff(a, sampleGrid(splitFrame(), 64, 36))
    const quiet = gridDiff(a, sampleGrid(solidFrame(12, 12, 12), 64, 36))
    const subtle = gridDiff(a, sampleGrid(solidFrame(30, 30, 30), 64, 36))
    expect(shouldKeepFrame(quiet, 'calm', 1)).toBe(false)
    expect(shouldKeepFrame(quiet, 'normal', 1)).toBe(false)
    expect(shouldKeepFrame(quiet, 'dense', 1)).toBe(false)
    expect(shouldKeepFrame(subtle, 'dense', 1)).toBe(true)
    expect(shouldKeepFrame(subtle, 'normal', 1)).toBe(false)
    expect(shouldKeepFrame(hard, 'calm', 1)).toBe(true)
    expect(shouldKeepFrame({ mean: 0, spikes: 99 }, 'calm', 1)).toBe(true)
    expect(shouldKeepFrame(quiet, 'calm', 0)).toBe(true)
  })
})

describe('sheet layout', () => {
  it('one frame keeps full size; four frames halve it into a 2x2 grid', () => {
    const one = sheetLayout(1, 640, 360)
    expect(one).toMatchObject({ cols: 1, rows: 1, cellW: 640, cellH: 360, canvasW: 640, canvasH: 360 })
    const four = sheetLayout(4, 640, 360)
    expect(four).toMatchObject({ cols: 2, rows: 2, cellW: 320, cellH: 180, canvasW: 640, canvasH: 360 })
    expect(four.positions[3]).toEqual({ x: 320, y: 180 })
  })
})

describe('session state machine', () => {
  it('starts one session, resumes it, updates pace, and stops it', () => {
    const sessions = new SenseWatchSessions()
    const started = sessions.start(undefined, 'normal')
    expect(started.sessionId).toBe('watch-0001')
    expect(started.rounds).toBe(0)
    const resumed = sessions.start(undefined, 'calm')
    expect(resumed.sessionId).toBe('watch-0001')
    expect(resumed.pace).toBe('calm')
    resumed.rounds += 1
    expect(sessions.active()?.rounds).toBe(1)
    expect(sessions.stop(started.sessionId)).toBe(true)
    expect(sessions.active()).toBeUndefined()
    expect(sessions.stop('watch-0001')).toBe(false)
    const fresh = sessions.start(3, undefined)
    expect(fresh.sessionId).toBe('watch-0002')
    expect(fresh.windowId).toBe(3)
    expect(fresh.pace).toBe('normal')
  })
})

describe('tool registration', () => {
  it('registers exactly one sense_now tool', () => {
    const registered: Array<{ name: string }> = []
    const ctx = {
      tools: { register: (tool: { name: string }): void => { registered.push(tool) } },
      browser: { provider: { tabs: async () => [] } },
    }
    apply(ctx as never, {})
    expect(registered.map(tool => tool.name)).toEqual(['sense_now'])
  })
  it('registerSenseNowTool accepts injected deps for tests', () => {
    const registered: Array<{ name: string }> = []
    registerSenseNowTool({ register: (tool: unknown): void => { registered.push(tool as { name: string }) } }, undefined)
    expect(registered.map(tool => tool.name)).toEqual(['sense_now'])
  })
})
