/**
 * Humanized keyboard: per-character keyDown/char/keyUp triplets, variable
 * inter-key delays, US-layout windowsVirtualKeyCode mapping, and
 * native-setter value clearing (React/Vue controlled components)
 * (ported from the OpenBrowserHarness reference).
 */

import { cdpController, sleep } from './cdp'
import { evaluateInPage } from './dom-snapshot'
import { click } from './mouse'
import { createRng } from './rng'
import { structuredValueFallbackScript } from './structured-value'
import { showTypePulse } from './virtual-cursor'

// ───────────────────────── key definitions (US layout) ─────────────────────────

interface NamedKeyDef {
  code: string
  vk: number
  /** Keys that produce text on keyDown (Enter/Tab/Space). */
  text?: string
}

const NAMED_KEYS: Record<string, NamedKeyDef> = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', vk: 9, text: '\t' },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  Escape: { code: 'Escape', vk: 27 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
  Space: { code: 'Space', vk: 32, text: ' ' },
}

interface SymbolDef {
  code: string
  vk: number
  shift: boolean
}

/** Printable symbols → physical key code + virtual key code (Shift-combos map to the base key). */
const SYMBOLS: Record<string, SymbolDef> = {
  ' ': { code: 'Space', vk: 32, shift: false },
  '!': { code: 'Digit1', vk: 49, shift: true },
  '@': { code: 'Digit2', vk: 50, shift: true },
  '#': { code: 'Digit3', vk: 51, shift: true },
  $: { code: 'Digit4', vk: 52, shift: true },
  '%': { code: 'Digit5', vk: 53, shift: true },
  '^': { code: 'Digit6', vk: 54, shift: true },
  '&': { code: 'Digit7', vk: 55, shift: true },
  '*': { code: 'Digit8', vk: 56, shift: true },
  '(': { code: 'Digit9', vk: 57, shift: true },
  ')': { code: 'Digit0', vk: 48, shift: true },
  '-': { code: 'Minus', vk: 189, shift: false },
  _: { code: 'Minus', vk: 189, shift: true },
  '=': { code: 'Equal', vk: 187, shift: false },
  '+': { code: 'Equal', vk: 187, shift: true },
  '[': { code: 'BracketLeft', vk: 219, shift: false },
  '{': { code: 'BracketLeft', vk: 219, shift: true },
  ']': { code: 'BracketRight', vk: 221, shift: false },
  '}': { code: 'BracketRight', vk: 221, shift: true },
  '\\': { code: 'Backslash', vk: 220, shift: false },
  '|': { code: 'Backslash', vk: 220, shift: true },
  ';': { code: 'Semicolon', vk: 186, shift: false },
  ':': { code: 'Semicolon', vk: 186, shift: true },
  "'": { code: 'Quote', vk: 222, shift: false },
  '"': { code: 'Quote', vk: 222, shift: true },
  '`': { code: 'Backquote', vk: 192, shift: false },
  '~': { code: 'Backquote', vk: 192, shift: true },
  ',': { code: 'Comma', vk: 188, shift: false },
  '<': { code: 'Comma', vk: 188, shift: true },
  '.': { code: 'Period', vk: 190, shift: false },
  '>': { code: 'Period', vk: 190, shift: true },
  '/': { code: 'Slash', vk: 191, shift: false },
  '?': { code: 'Slash', vk: 191, shift: true },
}

/** CDP Input.dispatchKeyEvent.modifiers: Shift bit. */
const MOD_SHIFT = 8

interface CharKeyDef {
  key: string
  code: string | null
  vk: number
  shift: boolean
  /** Non-ASCII (CJK/emoji…) carries text directly on keyDown (vk 229, IME style). */
  text: string | null
}

function resolveChar(c: string): CharKeyDef {
  if (c >= 'a' && c <= 'z') {
    const upper = c.toUpperCase()
    return { key: c, code: 'Key' + upper, vk: upper.charCodeAt(0), shift: false, text: null }
  }
  if (c >= 'A' && c <= 'Z') {
    return { key: c, code: 'Key' + c, vk: c.charCodeAt(0), shift: true, text: null }
  }
  if (c >= '0' && c <= '9') {
    return { key: c, code: 'Digit' + c, vk: c.charCodeAt(0), shift: false, text: null }
  }
  const sym = SYMBOLS[c]
  if (sym) {
    return { key: c, code: sym.code, vk: sym.vk, shift: sym.shift, text: null }
  }
  // Other Unicode (CJK / full-width / emoji): vk 229 (KEY_IN_PROCESS) simulates IME input.
  return { key: c, code: null, vk: 229, shift: false, text: c }
}

// ───────────────────────── low-level events ─────────────────────────

async function dispatchKey(
  tabId: number,
  params: Record<string, unknown>,
): Promise<void> {
  await cdpController.send(tabId, 'Input.dispatchKeyEvent', params)
}

/** One character keystroke: keyDown → (ASCII) char → keyUp. */
async function typeChar(tabId: number, c: string): Promise<void> {
  const d = resolveChar(c)
  const modifiers = d.shift ? MOD_SHIFT : 0
  const base: Record<string, unknown> = {
    modifiers,
    key: d.key,
    windowsVirtualKeyCode: d.vk,
    nativeVirtualKeyCode: d.vk,
  }

  const down: Record<string, unknown> = { type: 'keyDown', ...base }
  if (d.code) down.code = d.code
  if (d.text) down.text = d.text
  void showTypePulse(tabId) // fire-and-forget key-cap pulse, never delays the keystroke
  await dispatchKey(tabId, down)

  if (!d.text) {
    await dispatchKey(tabId, { type: 'char', modifiers, text: c })
  }

  const up: Record<string, unknown> = { type: 'keyUp', ...base }
  if (d.code) up.code = d.code
  await dispatchKey(tabId, up)
}

/** Named key press (case-insensitive + a few aliases); hold 40~110ms.
 *  Combos ("Control+A", "Ctrl+Shift+ArrowLeft", "Alt+ArrowLeft", "Cmd+C"):
 *  modifiers press in declared order, the base key runs between them, and
 *  release unwinds in reverse. Modifier bits follow the CDP
 *  Input.dispatchKeyEvent mask (Alt=1, Ctrl=2, Meta=4, Shift=8). */

/** CDP modifier bits for named modifiers. */
const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const
type ModifierName = keyof typeof MODIFIER_BITS

const MODIFIER_ALIASES: Record<string, ModifierName> = {
  ctrl: 'Control',
  control: 'Control',
  cmd: 'Meta',
  meta: 'Meta',
  command: 'Meta',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
}

/** Physical events for holding a modifier down while the base key runs. */
const MODIFIER_KEYS: Record<ModifierName, NamedKeyDef & { key: string }> = {
  Control: { key: 'Control', code: 'ControlLeft', vk: 17 },
  Meta: { key: 'Meta', code: 'MetaLeft', vk: 91 },
  Alt: { key: 'Alt', code: 'AltLeft', vk: 18 },
  Shift: { key: 'Shift', code: 'ShiftLeft', vk: 16 },
}

interface ResolvedKey {
  name: string
  def: NamedKeyDef
}

function resolveNamedKey(token: string): ResolvedKey | undefined {
  const lower = token.toLowerCase()
  for (const [k, def] of Object.entries(NAMED_KEYS)) {
    if (k.toLowerCase() === lower) return { name: k, def }
  }
  if (lower === 'return') return resolveNamedKey('Enter')
  if (lower === 'esc') return resolveNamedKey('Escape')
  return undefined
}

function resolveBaseKey(token: string): ResolvedKey | undefined {
  const named = resolveNamedKey(token)
  if (named) return named
  if (token.length === 1) {
    const c = resolveChar(token)
    // Letters and digits address a physical key; symbols/CJK do not make
    // sense as the base of a combo and stay a loud error.
    if (c.vk !== 229 && c.code !== null && /[a-z0-9]/i.test(token)) {
      return { name: token.toLowerCase(), def: { code: c.code, vk: c.vk } }
    }
  }
  return undefined
}

export async function pressKey(tabId: number, key: string): Promise<void> {
  const normalized = key.trim()

  // Combo parse: modifiers first, base key last; a bare ' ' means Space.
  const modifiers: ModifierName[] = []
  let baseToken = normalized
  if (normalized !== ' ' && normalized.includes('+')) {
    const parts = normalized.split('+')
    baseToken = (parts[parts.length - 1] ?? '').trim()
    for (const raw of parts.slice(0, -1)) {
      const alias = MODIFIER_ALIASES[raw.trim().toLowerCase()]
      if (!alias) {
        throw new Error(
          `不支持的修饰键：「${raw.trim()}」（支持 Ctrl/Control、Cmd/Meta/Command、Alt/Option、Shift，写法如 Ctrl+A、Ctrl+Shift+ArrowLeft）`,
        )
      }
      modifiers.push(alias)
    }
    if (baseToken.length === 0) {
      throw new Error(`按键名格式错误：「${key}」（组合键写法为 修饰键+基键，如 Ctrl+A）`)
    }
  }

  let resolved: ResolvedKey | undefined
  if (baseToken === ' ') {
    resolved = resolveNamedKey('Space')
  } else {
    resolved = resolveBaseKey(baseToken)
  }
  if (!resolved) {
    throw new Error(
      `不支持的按键：「${key}」（支持 Enter/Tab/Escape/Backspace/Delete/Space/Arrow*/Home/End/PageUp/PageDown、单字母/数字，及组合键如 Ctrl+A、Shift+ArrowLeft、Alt+ArrowLeft）`,
    )
  }

  const modBits = modifiers.reduce((bits, name) => bits | MODIFIER_BITS[name], 0)
  const base: Record<string, unknown> = {
    key: resolved.name,
    code: resolved.def.code,
    windowsVirtualKeyCode: resolved.def.vk,
    nativeVirtualKeyCode: resolved.def.vk,
  }
  if (modifiers.length > 0) base.modifiers = modBits

  // A modifier's keyDown carries the bits of everything held down so far
  // (Control alone = 2; by the time Shift lands, the mask is 10).
  let held = 0
  for (const mod of modifiers) {
    held |= MODIFIER_BITS[mod]
    const md = MODIFIER_KEYS[mod]
    await dispatchKey(tabId, {
      type: 'keyDown',
      modifiers: held,
      key: md.key,
      code: md.code,
      windowsVirtualKeyCode: md.vk,
      nativeVirtualKeyCode: md.vk,
    })
  }

  const down: Record<string, unknown> = { type: 'keyDown', ...base }
  // Modifiers change the meaning (Ctrl+Enter ≠ text-producing Enter): the
  // base key only carries text on a bare press.
  if (resolved.def.text !== undefined && modifiers.length === 0) down.text = resolved.def.text
  void showTypePulse(tabId) // fire-and-forget key-cap pulse, never delays the keystroke
  await dispatchKey(tabId, down)

  await sleep(createRng().randInt(40, 110))

  await dispatchKey(tabId, { type: 'keyUp', ...base })

  for (const mod of [...modifiers].reverse()) {
    const md = MODIFIER_KEYS[mod]
    await dispatchKey(tabId, {
      type: 'keyUp',
      modifiers: modBits,
      key: md.key,
      code: md.code,
      windowsVirtualKeyCode: md.vk,
      nativeVirtualKeyCode: md.vk,
    })
  }
}

// ───────────────────────── element value clearing ─────────────────────────

/**
 * Clear an input element's current value: prefer the native value setter
 * (React/Vue controlled components only re-render through the native setter),
 * then dispatch input/change events; contenteditable clears textContent.
 */
async function clearElement(tabId: number, selector: string): Promise<void> {
  const result = await evaluateInPage<string>(tabId, `(() => {
  var el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'not-found';
  if (typeof el.focus === 'function') { try { el.focus(); } catch (e) {} }
  if (el.isContentEditable) {
    el.textContent = '';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    return 'cleared';
  }
  var proto = null;
  if (el instanceof HTMLTextAreaElement) proto = HTMLTextAreaElement.prototype;
  else if (el instanceof HTMLInputElement) proto = HTMLInputElement.prototype;
  if (!proto) return 'unsupported';
  var desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) { desc.set.call(el, ''); } else { el.value = ''; }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'cleared';
})()`)
  if (result === 'not-found') {
    throw new Error(`清空输入失败，元素不存在：${selector}`)
  }
}

// ───────────────────────── structured value fallback ─────────────────────────

/**
 * 兜底校验 for structured date/time inputs: after the keystroke pass, if the
 * element's value did not take the text (批22: `<input type=time>` ends up
 * empty), assign it natively. Throws when the element is missing or the
 * browser rejects the text outright (empty sanitized value — format error,
 * fail loud rather than submit an unintended empty field).
 */
async function ensureStructuredValue(tabId: number, selector: string, text: string): Promise<void> {
  const raw = await evaluateInPage<string>(tabId, structuredValueFallbackScript(selector, text))
  if (raw === 'not-found') {
    throw new Error(`输入写入校验失败，元素不存在：${selector}`)
  }
  if (raw === 'skip') return
  if (raw.startsWith('ok:') && raw.slice(3) === '') {
    throw new Error(
      `时间/日期输入框不接受值「${text}」：${selector}（浏览器按类型校验后仍为空；time 需要 HH:MM、date 需要 YYYY-MM-DD、datetime-local 需要 YYYY-MM-DDTHH:MM）`,
    )
  }
}

// ───────────────────────── public API ─────────────────────────

export interface TypeTextOptions {
  /** Press Enter after typing (submit form / send message). */
  submit?: boolean
  /** Clear the existing value first (default false). */
  clear?: boolean
  /** Lower inter-key delay bound (ms), default 20. */
  minDelayMs?: number
  /** Upper inter-key delay bound (ms), default 150. */
  maxDelayMs?: number
}

/**
 * Humanized text input:
 * 1. focus the element with a humanized click (Bezier move + real press);
 * 2. optionally clear the existing value;
 * 3. per-character keyDown/char/keyUp, random 20~150ms inter-key delay;
 * 4. optional Enter submission.
 */
export async function typeText(
  tabId: number,
  selector: string,
  text: string,
  opts: TypeTextOptions = {},
): Promise<void> {
  const r = createRng()
  const minDelay = Math.max(0, opts.minDelayMs ?? 20)
  const maxDelay = Math.max(minDelay, opts.maxDelayMs ?? 150)

  await click(tabId, selector)
  await sleep(r.randInt(80, 200)) // focus → typing thought gap

  if (opts.clear) {
    await clearElement(tabId, selector)
    await sleep(r.randInt(50, 120))
  }

  const chars = Array.from(text)
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]
    if (c === undefined) continue
    await typeChar(tabId, c)
    if (i < chars.length - 1) {
      await sleep(r.randInt(minDelay, maxDelay))
    }
  }

  await ensureStructuredValue(tabId, selector, text)

  if (opts.submit) {
    await sleep(r.randInt(80, 200))
    await pressKey(tabId, 'Enter')
  }
}
