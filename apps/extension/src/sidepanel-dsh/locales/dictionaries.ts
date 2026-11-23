/**
 * The shell's merged dictionaries and the namespace they register under.
 * Each surface owns one file; this module is the single place that names the
 * namespace, so the registration cannot drift from the key type.
 *
 * The namespace stays out of upstream's `LocaleNamespaceMap`: the seat binds
 * it through the runtime's untyped overloads and narrows the translate to
 * `ShellLocaleKey` itself, which keeps the key check at every call site while
 * the client type checker never has to expand a ~450-key union inside the
 * `Context` service type.
 *
 * @module extension-shell-locales-dictionaries
 */
import { cardsEn, cardsZh } from './cards.ts'
import { composerEn, composerZh } from './composer.ts'
import { panelsEn, panelsZh } from './panels.ts'
import { presetsEn, presetsZh } from './presets.ts'
import { settingsEn, settingsZh } from './settings.ts'
import { shellChromeEn, shellChromeZh } from './shell-chrome.ts'

/** The zh surface dictionaries on their own, for the parity spec's disjointness check. */
export { cardsZh, composerZh, panelsZh, presetsZh, settingsZh, shellChromeZh }

/** The locale namespace every shell component translates through. */
export const SHELL_NS = 'extension.shell'

/** The shell's zh dictionary: the union of every surface's authoring text. */
export const shellZh = { ...cardsZh, ...composerZh, ...panelsZh, ...presetsZh, ...settingsZh, ...shellChromeZh }

/** Every key a shell component may translate. */
export type ShellLocaleKey = keyof typeof shellZh

/** The shell's en dictionary: complete over the same keys (a missing or extra key fails to compile). */
export const shellEn: Record<ShellLocaleKey, string> = {
  ...cardsEn,
  ...composerEn,
  ...panelsEn,
  ...presetsEn,
  ...settingsEn,
  ...shellChromeEn,
}
