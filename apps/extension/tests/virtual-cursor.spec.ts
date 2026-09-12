/**
 * Virtual-cursor overlay script guarantees:
 * - the injected source is syntactically valid ES5 (it runs via
 *   Runtime.evaluate in arbitrary pages — a SyntaxError would silently kill
 *   every gesture's visible half);
 * - it stays CSP-safe: no injected <style>, no @keyframes, no inline event
 *   handlers — visuals ride CSSOM property writes and canvas only.
 */

import { describe, expect, it } from 'vitest'
import { PAGE_INSTALL_SOURCE } from '../src/background/virtual-cursor.ts'

describe('virtual cursor page script', () => {
  it('is syntactically valid (compiles as a function body)', () => {
    expect(() => new Function(PAGE_INSTALL_SOURCE)).not.toThrow()
  })

  it('contains no <style>, @keyframes, or inline handlers (CSP-safe)', () => {
    expect(PAGE_INSTALL_SOURCE).not.toContain('<style')
    expect(PAGE_INSTALL_SOURCE).not.toContain('@keyframes')
    expect(PAGE_INSTALL_SOURCE).not.toContain('onclick')
  })

  it('installs idempotently and exposes the move/click API', () => {
    expect(PAGE_INSTALL_SOURCE).toContain('window.__dshVC')
    expect(PAGE_INSTALL_SOURCE).toContain('if (window.__dshVC) return')
    expect(PAGE_INSTALL_SOURCE).toContain('move: function')
    expect(PAGE_INSTALL_SOURCE).toContain('click: function')
  })

  it('renders above everything and never intercepts input', () => {
    expect(PAGE_INSTALL_SOURCE).toContain("'pointer-events', 'none'")
    expect(PAGE_INSTALL_SOURCE).toContain("'z-index', '2147483647'")
  })

  it('renders the neon-comet show: gradient arrow, halo, sparks, layered tail, shockwave', () => {
    // gradient-filled arrow with a glow filter (visibility/\"cool\" ask)
    expect(PAGE_INSTALL_SOURCE).toContain('linearGradient')
    expect(PAGE_INSTALL_SOURCE).toContain('drop-shadow(')
    // additive glow pass + breathing halo
    expect(PAGE_INSTALL_SOURCE).toContain("'lighter'")
    expect(PAGE_INSTALL_SOURCE).toContain('drawHalo')
    // comet tail in layers + spark particles
    expect(PAGE_INSTALL_SOURCE).toContain('sparks.push')
    expect(PAGE_INSTALL_SOURCE).toContain('globalAlpha')
    // click shockwave: triple ring + cross flash + squash bounce
    expect(PAGE_INSTALL_SOURCE).toContain('squishAt')
    expect(PAGE_INSTALL_SOURCE).toContain('5 + 30 * f')
    // amplified cursor show: motion lean, afterimages, tail aura pass, head knot
    expect(PAGE_INSTALL_SOURCE).toContain('leanDeg')
    expect(PAGE_INSTALL_SOURCE).toContain('ghosts.push')
    expect(PAGE_INSTALL_SOURCE).toContain('arrowPath')
  })

  it('exposes the human-operation visuals: keystroke pulses and scroll direction', () => {
    expect(PAGE_INSTALL_SOURCE).toContain('key: function')
    expect(PAGE_INSTALL_SOURCE).toContain('scroll: function')
  })

  it('stays visible between operations: idle presence after every gesture', () => {
    // the cursor rests at its landing point after a gesture instead of
    // vanishing — visibility was the #1 user-facing gap
    expect(PAGE_INSTALL_SOURCE).toContain('IDLE_MS')
    expect(PAGE_INSTALL_SOURCE).toContain('idleUntil')
    expect(PAGE_INSTALL_SOURCE).toContain('else if (now > hideAt)')
    // every entry point extends the idle window
    for (const entry of ['move: function', 'click: function', 'key: function', 'scroll: function']) {
      const entryIdx = PAGE_INSTALL_SOURCE.indexOf(entry)
      const idleIdx = PAGE_INSTALL_SOURCE.indexOf('idleUntil = t + IDLE_MS', entryIdx)
      expect(idleIdx, `${entry} extends idle`).toBeGreaterThan(entryIdx)
    }
  })
})
