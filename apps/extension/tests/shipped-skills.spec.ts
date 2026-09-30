// @vitest-environment jsdom
/**
 * Shipped-skill seeding spec: `ensureShippedSkills` seeds the 炼化 recipe
 * (`site-distill`) into the chrome.storage roster once per revision, and a
 * user deletion sticks until the shipped revision bumps.
 * @module @deepseek-ai/dsh-extension/tests/shipped-skills
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureShippedSkills, removeStoredSkill, SHIPPED_SKILL_REVISIONS, writeStoredSkill } from '../src/chrome/skill-storage.ts'

/**
 * Minimal chrome double: storage.local is a plain in-memory map (the
 * offscreen test context has no native storage API, so the storage client
 * routes through runtime.sendMessage — answered here synchronously).
 */
const backing = new Map<string, unknown>()

function installChromeDouble(): void {
  ;(globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      sendMessage: (msg: unknown) => {
        const request = msg as { channel?: string; op?: string; keys?: string[]; items?: Record<string, unknown> }
        if (request.channel !== 'dsh-storage') return Promise.resolve({ ok: false, error: 'unknown channel' })
        if (request.op === 'get') {
          const data: Record<string, unknown> = {}
          for (const key of request.keys ?? []) {
            if (backing.has(key) || key.endsWith(':')) {
              data[key] = backing.get(key)
            }
          }
          return Promise.resolve({ ok: true, data })
        }
        if (request.op === 'set') {
          for (const [key, value] of Object.entries(request.items ?? {})) backing.set(key, value)
          return Promise.resolve({ ok: true, data: {} })
        }
        if (request.op === 'remove') {
          for (const key of request.keys ?? []) backing.delete(key)
          return Promise.resolve({ ok: true, data: {} })
        }
        return Promise.resolve({ ok: false, error: 'unknown op' })
      },
      onMessage: { addListener: () => undefined },
    },
  }
}

beforeEach(() => {
  backing.clear()
  installChromeDouble()
})

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome
})

describe('ensureShippedSkills', () => {
  it('seeds the 炼化 recipe into the roster with a revision marker', async () => {
    await ensureShippedSkills()
    const record = backing.get('dsh-skill:site-distill') as { name: string; content: string } | undefined
    expect(record !== undefined && record.name === 'site-distill' && record.content.includes('page_network')).toBe(true)
    expect(record?.content).toContain('skill_write')
    expect(backing.get('dsh-skill-seed-revisions')).toEqual({ 'site-distill': SHIPPED_SKILL_REVISIONS['site-distill'] })
  })

  it('is idempotent: a second boot does not rewrite the record', async () => {
    await ensureShippedSkills()
    const first = backing.get('dsh-skill:site-distill')
    backing.set('dsh-skill:site-distill', { name: 'site-distill', description: 'user-modified', content: 'custom' })
    await ensureShippedSkills()
    expect(backing.get('dsh-skill:site-distill')).toEqual({ name: 'site-distill', description: 'user-modified', content: 'custom' })
    expect(first).toBeDefined()
  })

  it('a user deletion sticks: the skill is not re-seeded on the next boot', async () => {
    await ensureShippedSkills()
    // The user removes the skill through the management surface.
    await removeStoredSkill('site-distill')
    expect(backing.has('dsh-skill:site-distill')).toBe(false)
    await ensureShippedSkills()
    expect(backing.has('dsh-skill:site-distill')).toBe(false)
  })

  it('bumping the shipped revision re-seeds over a user modification', async () => {
    await ensureShippedSkills()
    // Simulate the next shipped revision of the same recipe.
    const shippedRevision = SHIPPED_SKILL_REVISIONS['site-distill'] ?? 1
    backing.set('dsh-skill-seed-revisions', { 'site-distill': shippedRevision - 1 })
    await writeStoredSkill({ name: 'site-distill', description: 'old', content: 'old body' })
    await ensureShippedSkills()
    const record = backing.get('dsh-skill:site-distill') as { content: string }
    expect(record.content).toContain('page_network')
  })
})
