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
    // oxlint-disable-next-line typescript/no-implied-eval -- new Function 本身就是被测对象：校验页面脚本可编译
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

  it('stays visible FOREVER: the resting cursor never fades away', () => {
    // always-on visibility is the contract: presence re-arms for STAY_MS on
    // every interaction, and the idle-expiry fade branch is gone entirely
    expect(PAGE_INSTALL_SOURCE).toContain('IDLE_MS')
    expect(PAGE_INSTALL_SOURCE).toContain('idleUntil')
    expect(PAGE_INSTALL_SOURCE).toContain('STAY_MS')
    expect(PAGE_INSTALL_SOURCE).toContain('if (now > hideAt)')
    expect(PAGE_INSTALL_SOURCE).not.toContain("'opacity', '0');\n      anim = null;")
    for (const entry of ['move: function', 'click: function', 'key: function', 'scroll: function']) {
      const entryIdx = PAGE_INSTALL_SOURCE.indexOf(entry)
      const stayIdx = PAGE_INSTALL_SOURCE.indexOf('idleUntil = ', entryIdx)
      expect(stayIdx, `${entry} extends presence`).toBeGreaterThan(entryIdx)
    }
  })

  it('reacts to EVERY agent operation and survives navigation', () => {
    // parkIfIdle materializes the resting cursor on a freshly (re)loaded page
    // without disturbing an in-flight gesture; touch() is the keep-alive
    // heartbeat; blip() is the amber AI-activity pulse for non-pointer ops
    expect(PAGE_INSTALL_SOURCE).toContain('parkIfIdle: function')
    expect(PAGE_INSTALL_SOURCE).toContain('touch: function')
    expect(PAGE_INSTALL_SOURCE).toContain('blip: function')
    expect(PAGE_INSTALL_SOURCE).toContain('if (anim) return;')
    // the activity pulse uses a hue no pointer gesture uses (amber pair)
    expect(PAGE_INSTALL_SOURCE).toContain('A0 = [253, 224, 71]')
    expect(PAGE_INSTALL_SOURCE).toContain('amber(')
  })
})
