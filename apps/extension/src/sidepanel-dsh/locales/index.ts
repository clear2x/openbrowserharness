/**
 * The locale seat of the extension's own shell: one typed namespace for every
 * piece of copy the fork's components render — the composer, the conversation
 * chrome, the panels and the cards — so the shell follows the same active
 * locale as the upstream UI around it (the stored preference, else the
 * browser language). The dictionary files beside this module own the text:
 * `zh` is the authoring wording, `en` its translation.
 * `verify-client-ui-i18n` covers `sidepanel-dsh`, so literal copy that creeps
 * back into a component fails that gate.
 *
 * @module extension-shell-locales
 */
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { useSyncExternalStore } from 'react'
import { SHELL_NS, shellEn, shellZh } from './dictionaries.ts'
import type { ShellLocaleKey } from './dictionaries.ts'

export { SHELL_NS }
export type { ShellLocaleKey }

/** The shell's translate: a dictionary key plus its interpolation values. */
export type ShellTranslate = Translate<ShellLocaleKey>

/** The slice of the locale runtime this seat reads: the observable revision and the namespace-bound translate. */
export interface ShellLocaleFace {
  getSnapshot(): { revision: number }
  subscribe(listener: () => void): () => void
  bind(ns: typeof SHELL_NS): Translate
}

/**
 * The slice of a client context {@link installShellLocale} needs. Structural
 * on purpose: the seat names the two services it touches instead of the
 * whole merged context type.
 */
export interface ShellLocaleHost {
  locale: {
    getSnapshot(): { revision: number }
    subscribe(listener: () => void): () => void
    bind(ns: typeof SHELL_NS): Translate
    register(ns: string, locale: string, dict: Record<string, string>): () => void
  }
  effect(setup: () => () => void, label?: string): unknown
}

/** One revision of the seat: what the components render with until the next change. */
interface ShellSnapshot {
  readonly revision: number
  readonly t: ShellTranslate
}

/**
 * Interpolate the `{name}` placeholders of one template; a placeholder with
 * no value stays verbatim, the way the locale runtime leaves it.
 * @param template - the dictionary template.
 * @param params - the interpolation values.
 * @returns the rendered text.
 */
export function interpolate(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}

// Before a face is bound (a component rendered outside the panel, a unit
// test), the seat answers from the zh dictionary, so the text is never a raw key.
const FALLBACK_SNAPSHOT: ShellSnapshot = {
  revision: -1,
  t: (key, params) => interpolate(shellZh[key] ?? key, params),
}

let face: ShellLocaleFace | undefined
let snapshot: ShellSnapshot | undefined
/**
 * One locale service's live dictionary registration: its disposers and the
 * installer contexts still holding it. A registration exists exactly while at
 * least one holder does, so the last holder's disposer is the one that
 * unregisters.
 */
interface Registration {
  readonly disposers: readonly (() => void)[]
  holders: number
}
/** The live registrations, one per locale service (a client root provides one). */
const registrations = new Map<ShellLocaleHost['locale'], Registration>()

function readSnapshot(): ShellSnapshot {
  if (face === undefined) return FALLBACK_SNAPSHOT
  const revision = face.getSnapshot().revision
  if (snapshot?.revision !== revision) snapshot = { revision, t: face.bind(SHELL_NS) }
  return snapshot
}

function subscribe(listener: () => void): () => void {
  return face?.subscribe(listener) ?? (() => {})
}

/**
 * Bind the locale face the shell translates through, replacing any face bound
 * earlier. The shell plugins install their `ctx.locale` at apply time; tests
 * install a face of their own.
 * @param next - the face; undefined returns the seat to the zh dictionary.
 */
export function bindShellLocaleFace(next: ShellLocaleFace | undefined): void {
  face = next
  snapshot = undefined
}

/**
 * Register the shell dictionary on a context's locale service and bind that
 * service as the shell's face. Every shell plugin's apply calls it: the first
 * call on a locale service registers, later calls only add a holder and
 * rebind, and the dictionaries stay registered until the last caller's
 * context unloads. Each locale service is registered independently, so a
 * shell that moves to a newer client root is translated there as well.
 * @param ctx - a context carrying `locale` and `effect` (see {@link ShellLocaleHost}).
 */
export function installShellLocale(ctx: ShellLocaleHost): void {
  const runtime = ctx.locale
  bindShellLocaleFace(runtime)
  let held = registrations.get(runtime)
  if (held === undefined) {
    held = {
      // The per-locale form: the namespace is outside the runtime's merge table.
      disposers: [
        runtime.register(SHELL_NS, 'zh', shellZh),
        runtime.register(SHELL_NS, 'en', shellEn),
      ],
      holders: 0,
    }
    registrations.set(runtime, held)
  }
  held.holders += 1
  ctx.effect(() => () => {
    held.holders -= 1
    if (held.holders > 0) return
    for (const dispose of held.disposers) dispose()
    registrations.delete(runtime)
  }, 'extension-shell: locale')
}

/**
 * The shell's translate for a component's render; the caller re-renders when
 * the active locale or the dictionary registry changes.
 * @returns the namespace-bound translate function.
 */
export function useShellT(): ShellTranslate {
  return useSyncExternalStore(subscribe, readSnapshot, readSnapshot).t
}

/**
 * The shell's translate for code outside a render (send routing, stores,
 * module-level helpers); it reads the active locale at call time.
 * @returns the namespace-bound translate function.
 */
export function shellT(): ShellTranslate {
  return readSnapshot().t
}
