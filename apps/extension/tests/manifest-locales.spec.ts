/**
 * manifest locales spec: the extension's own `_locales` messages back every
 * `__MSG_name__` the manifest references and every message the service worker
 * reads through `chrome.i18n.getMessage` (the worker sits outside the panel's
 * locale service, so a name without a message would render empty). Each
 * shipped locale carries the same message names, every message is non-empty,
 * and the default locale is one of them.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const PUBLIC_ROOT = resolve(__dirname, '../public')
const BACKGROUND_ROOT = resolve(__dirname, '../src/background')

interface MessageFile {
  readonly [name: string]: { readonly message: string }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function localeMessages(): Map<string, MessageFile> {
  const localesRoot = join(PUBLIC_ROOT, '_locales')
  return new Map(readdirSync(localesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => [entry.name, readJson(join(localesRoot, entry.name, 'messages.json')) as MessageFile]))
}

/** Source text of every service worker module. */
function backgroundSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) backgroundSources(path, out)
    else if (entry.name.endsWith('.ts')) out.push(readFileSync(path, 'utf8'))
  }
  return out
}

function unique(matches: Iterable<string>): string[] {
  return [...new Set(matches)].sort()
}

describe('manifest _locales', () => {
  it('ships the default locale and the same message names everywhere', () => {
    const manifest = readJson(join(PUBLIC_ROOT, 'manifest.json')) as { default_locale: string }
    const locales = localeMessages()
    expect(locales.has(manifest.default_locale), `default locale ${manifest.default_locale}`).toBe(true)
    expect([...locales.keys()].sort()).toEqual(['en', 'zh_CN', 'zh_TW'])
    const names = unique(Object.keys(locales.get(manifest.default_locale) ?? {}))
    expect(names.length).toBeGreaterThan(0)
    for (const [locale, messages] of locales) {
      expect(unique(Object.keys(messages)), locale).toEqual(names)
      for (const name of names) expect(messages[name]?.message, `${locale}/${name}`).not.toBe('')
    }
  })

  it('backs every manifest placeholder and every service worker message', () => {
    const locales = localeMessages()
    const manifestText = readFileSync(join(PUBLIC_ROOT, 'manifest.json'), 'utf8')
    const referenced = [
      ...unique([...manifestText.matchAll(/__MSG_([A-Za-z0-9@_]+)__/g)].map(match => match[1] ?? '')),
      ...unique(backgroundSources(BACKGROUND_ROOT)
        .flatMap(source => [...source.matchAll(/chrome\.i18n\.getMessage\('([A-Za-z0-9@_]+)'/g)])
        .map(match => match[1] ?? '')),
    ]
    expect(referenced.length).toBeGreaterThan(0)
    for (const [, messages] of locales) {
      for (const name of referenced) expect(Object.hasOwn(messages, name), name).toBe(true)
    }
  })

  it('keeps English free of CJK text', () => {
    for (const [name, entry] of Object.entries(localeMessages().get('en') ?? {})) {
      expect(/[\u3400-\u9fff]/u.test(entry.message), name).toBe(false)
    }
  })
})
