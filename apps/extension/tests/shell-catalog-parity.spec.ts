/**
 * shell catalog parity spec: the on-device model catalog (host face) and the
 * shell's dictionary tables (client face) name the same models. The services
 * card translates each catalog row through `locales/ai-local.ts`, whose zh
 * wording must stay the catalog's own `label`/`purposeZh` — the two live in
 * different compiler faces, so this host-face spec reads the client sources as
 * text instead of importing them. A catalog model without a label or purpose
 * entry, an entry without a model, or zh wording that drifted from the
 * catalog fails here.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AI_LOCAL_CATALOG } from '../src/offscreen/ai-runtime/catalog.ts'

const LOCALES_DIR = resolve(__dirname, '../src/sidepanel-dsh/locales')
const KEY_TABLES = readFileSync(resolve(LOCALES_DIR, 'ai-local.ts'), 'utf8')
const PANELS = readFileSync(resolve(LOCALES_DIR, 'panels.ts'), 'utf8')

/** The `'model id': 'dictionary key'` pairs of one exported key table. */
function keyTable(name: string): Map<string, string> {
  const start = KEY_TABLES.indexOf(`export const ${name}`)
  if (start < 0) throw new Error(`ai-local.ts declares no ${name}`)
  const body = KEY_TABLES.slice(start, KEY_TABLES.indexOf('\n}', start))
  return new Map([...body.matchAll(/'([^']+)': '([^']+)'/g)].map(match => [match[1] ?? '', match[2] ?? '']))
}

/** The zh value of one dictionary key: `panels.ts` lists its zh block first. */
function zhValue(key: string): string | undefined {
  const escaped = key.replaceAll('.', '\\.')
  return PANELS.match(new RegExp(`'${escaped}': '([^']*)'`))?.[1]
}

describe('on-device catalog and shell dictionary parity', () => {
  it('translates every catalog row with the catalog wording', () => {
    const labels = keyTable('AI_LOCAL_LABEL_KEYS')
    const purposes = keyTable('AI_LOCAL_PURPOSE_KEYS')
    expect(AI_LOCAL_CATALOG.length).toBeGreaterThan(0)
    expect([...labels.keys()].sort()).toEqual([...purposes.keys()].sort())
    for (const spec of AI_LOCAL_CATALOG) {
      const labelKey = labels.get(spec.id)
      const purposeKey = purposes.get(spec.id)
      expect(labelKey, `label entry of ${spec.id}`).toBeDefined()
      expect(purposeKey, `purpose entry of ${spec.id}`).toBeDefined()
      expect(zhValue(labelKey ?? ''), labelKey).toBe(spec.label)
      expect(zhValue(purposeKey ?? ''), purposeKey).toBe(spec.purposeZh)
    }
  })

  it('names no model outside the catalog', () => {
    const ids = new Set(AI_LOCAL_CATALOG.map(spec => spec.id))
    for (const table of ['AI_LOCAL_LABEL_KEYS', 'AI_LOCAL_PURPOSE_KEYS']) {
      for (const id of keyTable(table).keys()) expect(ids.has(id), `${table}: ${id}`).toBe(true)
    }
  })
})
