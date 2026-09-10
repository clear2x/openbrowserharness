/**
 * User plugins: AI/user-authored plugins persisted in chrome.storage and run
 * inside the MV3 sandbox page, bridged live onto the running engine Context.
 *
 * This is the extension twin of dsh desktop's bundle/self-modification lane:
 * the composition is static (offscreen/main.ts's MODULES map — MV3 CSP forbids
 * dynamic code in extension pages), so dynamically authored plugins get a
 * narrower seam. Each plugin is a record under one storage key; enabling it
 * evaluates its code in `sandbox.html` (the manifest-sandboxed page where
 * `new Function` is permitted) and subscribes the plugin's declared event
 * names back onto the real `ctx.events`, forwarding harness dispatches into
 * the sandbox over postMessage.
 *
 * SECURITY NOTE (threat model): user plugin code runs for the local user who
 * (or whose agent) explicitly wrote it, inside the sandboxed page with no
 * chrome.* bindings. The sandbox protects the extension bundle from
 * accidental breakage, not the user from hostile code — capability reaches
 * this channel exactly as far as the same user could reach through DevTools.
 * It is a convenience seam, not an adversarial boundary.
 *
 * Host↔sandbox message shapes are documented at the top of
 * src/sandbox/main.ts; this file owns the opposite end of that protocol.
 */

import type { Context } from '@deepseek-ai/cordis'
import { storageGet, storageSet } from './storage-client'

/** The single chrome.storage.local key holding the whole user-plugin roster. */
export const USER_PLUGINS_KEY = 'obh-user-plugins'

/** Storage medium format stamp bumped on breaking shape changes (no compat promise pre-release). */
const PLUGIN_MEDIUM_VERSION = 1

/**
 * Plugin id form: lowercase kebab-case (`greet-on-prompt`). Doubles as the
 * stable instance key on both sides of the postMessage protocol.
 */
export const USER_PLUGIN_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const MAX_NAME_LENGTH = 64
const MAX_TITLE_LENGTH = 120
const MAX_DESCRIPTION_LENGTH = 2_000
const MAX_CODE_LENGTH = 400_000
const MAX_EVENTS_PER_PLUGIN = 32
const MAX_EVENT_NAME_LENGTH = 128

/**
 * Sandbox page URL, lazily resolved through the runtime: extension pages
 * carry chrome.runtime, but module-loads from other hosts (unit tests,
 * sidepanel imports) must not crash on a missing binding.
 */
let cachedSandboxUrl: string | undefined

function sandboxUrl(): string {
  const runtime = (globalThis as { chrome?: { runtime?: { getURL?(path: string): string } } }).chrome?.runtime
  if (typeof runtime?.getURL !== 'function') {
    throw new Error('chrome.runtime.getURL 不可用：用户插件宿主只能在扩展上下文中运行')
  }
  cachedSandboxUrl ??= runtime.getURL('sandbox.html')
  return cachedSandboxUrl
}

/**
 * Host→sandbox postMessage targetOrigin. The manifest-sandboxed page runs in
 * an opaque ("null") origin, and a concrete targetOrigin never matches an
 * opaque target — the user agent silently drops such messages. Posts with the
 * extension origin as targetOrigin read downstream as "run reply timed out"
 * even though the sandbox never received the request (the observed
 * long-standing write/toggle timeout). '*' is the only deliverable value for
 * this direction; peer identity is enforced by the e.source checks on both
 * sides (sandbox: event.source === window.parent; host:
 * event.source === frame.contentWindow), not by targetOrigin.
 */
const SANDBOX_TARGET_ORIGIN = '*'

/** Host→sandbox message-source tag (must match src/sandbox/main.ts). */
const HOST_TO_SANDBOX = 'obh-sandbox'
/** Sandbox→host message-source tag (must match src/sandbox/main.ts). */
const SANDBOX_TO_HOST = 'obh-sandbox-host'

const READY_TIMEOUT_MS = 10_000
/**
 * Stuck-pipe guard for one correlated run: the request is posted only after
 * the ready handshake resolves, so this budget never includes iframe
 * navigation or module-evaluation cost (that belongs to READY_TIMEOUT_MS).
 * Healthy runs answer in milliseconds; the generous value is a backstop.
 */
const RUN_TIMEOUT_MS = 45_000

function log(...args: unknown[]): void {
  console.log('[user-plugins]', ...args)
}

function warn(...args: unknown[]): void {
  console.warn('[user-plugins]', ...args)
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

// ───────────────────────── storage medium ─────────────────────────

/** One persisted user plugin. */
export interface UserPluginRecord {
  /** Kebab-case id (see {@link USER_PLUGIN_NAME_RE}); also the sandbox instance key. */
  name: string
  /** Human-facing display title (may be shown in UI rosters). */
  title: string
  /** What the plugin does — free text the AI writes alongside the code. */
  description: string
  /** Whether the plugin should be mounted on the engine. */
  enabled: boolean
  /**
   * 最近一次激活失败的错误文本。激活失败时记录落盘为 `enabled: false` 并写入
   * 此字段（停用+失败标识， roster 不再声称「已启用」却无绑定）；后续 write
   * 或 toggle 会整体重建记录并清掉它。用户看得到、模型经 list 也看得到。
   */
  lastError?: string
  /** Plugin factory source; body of `new Function('ctx', …)` evaluated in the sandbox page. */
  code: string
  /** First-write epoch ms; preserved across rewrites. */
  createdAt: number
  /** Latest-write epoch ms. */
  updatedAt: number
}

/** Whole-roster storage shape (one key, version-stamped, read-modify-write). */
interface PluginMedium {
  version: number
  items: UserPluginRecord[]
}

/** Write input for {@link UserPluginHost.write}; `enabled` defaults to true. */
export interface UserPluginWriteInput {
  name: string
  title: string
  description: string
  code: string
  enabled?: boolean
}

/**
 * Parse and validate the stored medium. A malformed ENTRY is dropped loudly
 * (warn + skipped) so one bad record cannot poison the roster; a malformed
 * MEDIUM (wrong type/version) throws — misconfiguration fails loud, never
 * silently erases the roster by overwriting it.
 */
function parseMedium(raw: unknown): UserPluginRecord[] {
  if (raw === undefined) return []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`用户插件存储格式损坏：${USER_PLUGINS_KEY} 不是对象`)
  }
  const medium = raw as Partial<PluginMedium>
  if (medium.version !== PLUGIN_MEDIUM_VERSION) {
    throw new Error(`用户插件存储版本不匹配：medium ${String(medium.version)} ≠ ${String(PLUGIN_MEDIUM_VERSION)}`)
  }
  if (!Array.isArray(medium.items)) {
    throw new Error('用户插件存储格式损坏：items 不是数组')
  }
  const items: UserPluginRecord[] = []
  for (const entry of medium.items) {
    const parsed = parseRecord(entry)
    if (parsed !== undefined) items.push(parsed)
  }
  return items
}

/** Validate one stored record; returns undefined (with a warn) for malformed entries. */
function parseRecord(entry: unknown): UserPluginRecord | undefined {
  if (entry === null || typeof entry !== 'object') {
    warn('丢弃畸形插件条目（不是对象）')
    return undefined
  }
  const r = entry as Record<string, unknown>
  const pluginName = r.name
  const title = r.title
  const description = r.description
  const enabled = r.enabled
  const lastError = r.lastError
  const code = r.code
  const createdAt = r.createdAt
  const updatedAt = r.updatedAt
  if (typeof pluginName !== 'string' || !USER_PLUGIN_NAME_RE.test(pluginName) ||
    typeof title !== 'string' ||
    typeof description !== 'string' ||
    typeof enabled !== 'boolean' ||
    (lastError !== undefined && typeof lastError !== 'string') ||
    typeof code !== 'string' ||
    typeof createdAt !== 'number' || !Number.isFinite(createdAt) ||
    typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
    warn(`丢弃畸形插件条目（字段缺失或类型错误）：${typeof pluginName === 'string' ? pluginName : '<unnamed>'}`)
    return undefined
  }
  return {
    name: pluginName,
    title,
    description,
    enabled,
    code,
    createdAt,
    updatedAt,
    ...(lastError === undefined ? {} : { lastError }),
  }
}

/** Fail-loud bridge-input validators (throw at the RPC caller). */
function assertName(pluginName: string): void {
  if (typeof pluginName !== 'string' || !USER_PLUGIN_NAME_RE.test(pluginName)) {
    throw new Error(`name 必须匹配 /^[a-z0-9]+(?:-[a-z0-9]+)*$/（kebab-case），收到：${pluginName}`)
  }
  if (pluginName.length > MAX_NAME_LENGTH) {
    throw new Error(`name 长度不能超过 ${String(MAX_NAME_LENGTH)}`)
  }
}

function assertWriteFields(input: UserPluginWriteInput): void {
  if (typeof input.title !== 'string' || input.title.length === 0 || input.title.length > MAX_TITLE_LENGTH) {
    throw new Error(`title 必须是 1–${String(MAX_TITLE_LENGTH)} 字符的字符串`)
  }
  if (typeof input.description !== 'string' || input.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`description 必须是不超过 ${String(MAX_DESCRIPTION_LENGTH)} 字符的字符串`)
  }
  if (typeof input.code !== 'string' || input.code.trim().length === 0 || input.code.length > MAX_CODE_LENGTH) {
    throw new Error(`code 必须是非空且不超过 ${String(MAX_CODE_LENGTH)} 字符的源码字符串`)
  }
}

// ───────────────────────── payload snapshot ─────────────────────────

/** Depth cap for forwarded harness-event payloads (fidelity beyond this is noise anyway). */
const SNAPSHOT_DEPTH_LIMIT = 8

/**
 * Deep-copy an event argument into a structured-clone-safe plain value:
 * functions/symbols/bigints render as descriptive strings, cycles cut, depth
 * capped. Harness events routinely carry context proxies and class instances;
 * passing them through postMessage verbatim would throw (functions) or hand a
 * live mutable object across the frame edge.
 */
function snapshot(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`
  if (typeof value === 'bigint' || typeof value === 'symbol') return String(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  if (depth > SNAPSHOT_DEPTH_LIMIT) return '[depth-limit]'
  seen.add(value)
  if (Array.isArray(value)) return value.map(item => snapshot(item, depth + 1, seen))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) out[key] = snapshot(item, depth + 1, seen)
  return out
}

// ───────────────────────── wire types ─────────────────────────

/** Host→sandbox request envelope (src/sandbox/main.ts owns the receiving half). */
type SandboxRequest =
  | { source: typeof HOST_TO_SANDBOX; id: string; op: 'run'; plugin: string; code: string }
  | { source: typeof HOST_TO_SANDBOX; id: string; op: 'emit'; plugin: string; eventName: string; payload: unknown[] }
  | { source: typeof HOST_TO_SANDBOX; id: string; op: 'unload'; plugin: string }

/** Reply expected for one correlated `run` request. */
interface RunReply {
  registeredEvents: string[]
}

interface PendingRun {
  resolve: (reply: RunReply) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Live binding between one stored plugin and the engine Context. */
interface PluginBinding {
  record: UserPluginRecord
  events: string[]
  /** One `ctx.events.on` disposer per subscribed event name. */
  disposers: Array<() => boolean>
}

/** List item shape served by {@link UserPluginHost.list}. */
export interface UserPluginListItem extends Omit<UserPluginRecord, 'code'> {
  /** Plugin source — present only when explicitly requested (`includeCode`). */
  code?: string
  /** Event names the plugin is bound to right now (present only when mounted). */
  registeredEvents?: string[]
}

// ───────────────────────── host ─────────────────────────

/**
 * Owns the sandbox iframe, the user-plugin roster, and the bridge from
 * sandbox-declared event names onto `ctx.events`. One instance per offscreen
 * boot; obtain it elsewhere via {@link userPluginHost}.
 */
export class UserPluginHost {
  private readonly ctx: Context

  /** Hidden sandbox.html iframe injected into this document (created lazily). */
  private frame: HTMLIFrameElement | undefined
  /** Resolves when the sandbox page completed its ready handshake. */
  private readyPromise: Promise<HTMLIFrameElement> | undefined
  /** One-shot resolve hook invoked by the ready branch of {@link onWindowMessage}. */
  private readyWaiter: (() => void) | undefined
  /** Outstanding `run` requests awaiting their correlated sandbox reply. */
  private readonly pendingRuns = new Map<string, PendingRun>()
  /** Monotonic correlation-id source (per-request, unlike the stable plugin-name instance key). */
  private seq = 0
  /** Live plugin-name → binding map; exactly one binding per mounted plugin. */
  private readonly bindings = new Map<string, PluginBinding>()
  /**
   * Mutation mutex: write/remove/toggle each re-read then re-publish the whole
   * roster key, so they serialize behind one promise chain — the same
   * single-writer-per-unit durability argument the KV backend makes.
   */
  private tail: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context) {
    this.ctx = ctx
    // Installed once for the document lifetime; every message is filtered by
    // source identity below before any handling. Sandboxed frames report an
    // opaque ("null") origin, so e.origin cannot be allowlisted — e.source is
    // the reliable identity check.
    window.addEventListener('message', this.onWindowMessage)
  }

  /**
   * Boot the host: open the sandbox page and mount every stored plugin marked
   * enabled. A broken plugin logs loudly, is skipped, and is persisted as
   * disabled with its `lastError` — the roster must not claim an enabled
   * plugin that never mounted, and later boots must not silently re-pay the
   * same failure (re-enabling after a fix retries it). One bad plug-in must
   * not stop the rest, and its source stays stored for fixing. Throws only
   * when the sandbox page itself cannot be reached.
   */
  async start(): Promise<void> {
    const items = await this.readAll()
    const enabled = items.filter(record => record.enabled)
    if (enabled.length === 0) {
      // Pre-warm without blocking the engine boot: create the sandbox frame in
      // the background so the first write/toggle answers in milliseconds
      // instead of paying the iframe navigation + module evaluation. The frame
      // is cached by ensureReady, so the first run awaits the same promise.
      // A handshake failure surfaces as a warn here and as the real error on
      // the first run that needs the frame.
      void this.ensureReady().catch((err: unknown) => {
        warn('沙箱页面预热失败（首次插件操作将重试）：', errText(err))
      })
      return
    }
    await this.ensureReady()
    for (const record of enabled) {
      try {
        const events = await this.activate(record)
        log(`已挂载用户插件 ${record.name}（订阅事件：${events.length === 0 ? '无' : events.join('、')}）`)
      } catch (err) {
        warn(`挂载用户插件 ${record.name} 失败（已停用并记录失败原因，代码仍保留）：`, errText(err))
        // Runs before the engine finishes booting (main.ts awaits start() before
        // tools register), so this read-modify-write cannot race write/toggle.
        await this.persistActivationFailure(record.name, errText(err))
      }
    }
  }

  /** Release everything: context listeners, pending runs, the iframe slot. */
  dispose(): void {
    window.removeEventListener('message', this.onWindowMessage)
    for (const [pluginName, binding] of [...this.bindings]) {
      this.unbind(binding)
      this.bindings.delete(pluginName)
    }
    for (const [, pending] of [...this.pendingRuns]) {
      clearTimeout(pending.timer)
      pending.reject(new Error('用户插件宿主已销毁'))
    }
    this.pendingRuns.clear()
    this.frame?.remove()
    this.frame = undefined
    this.readyPromise = undefined
  }

  // ── public roster operations ──

  /**
   * List the roster.
   * @param includeCode - include each item's `code` (verbose); defaults to omitting it.
   * @returns stored records merged with live-bound event names.
   */
  async list(includeCode = false): Promise<UserPluginListItem[]> {
    const items = await this.readAll()
    return items.map((record) => {
      const binding = this.bindings.get(record.name)
      const item: UserPluginListItem = includeCode
        ? { ...record }
        // Code omitted entirely when not requested (the redacted default view).
        : (({ code: _code, ...rest }) => rest)(record)
      if (binding !== undefined) item.registeredEvents = [...binding.events]
      return item
    })
  }

  /**
   * Create or overwrite one plugin and hot-(re)load it. The record persists
   * first (`createdAt` preserved across rewrites); a successful write rebuilds
   * the record wholesale, clearing any stale `lastError`. Activation failures
   * surface as thrown errors WITH the code kept stored for the next
   * fix-and-retry — and the failed record is persisted as `enabled: false`
   * carrying the error text, so the roster never claims an enabled plugin
   * that has no binding. Disabled inputs persist without touching the sandbox.
   *
   * @returns the normalized name and the sandbox-declared event names actually bound.
   */
  async write(input: UserPluginWriteInput): Promise<{ name: string; registeredEvents: string[] }> {
    assertName(input.name)
    assertWriteFields(input)
    return this.enqueue(async () => {
      const existing = await this.readAll()
      const prior = existing.find(record => record.name === input.name)
      const now = Date.now()
      const record: UserPluginRecord = {
        name: input.name,
        title: input.title,
        description: input.description,
        enabled: input.enabled ?? true,
        code: input.code,
        createdAt: prior !== undefined ? prior.createdAt : now,
        updatedAt: now,
      }
      await this.saveAll([...existing.filter(item => item.name !== record.name), record])
      this.deactivate(record.name)
      if (!record.enabled) return { name: record.name, registeredEvents: [] }
      try {
        const registeredEvents = await this.activate(record)
        return { name: record.name, registeredEvents }
      } catch (err) {
        await this.persistActivationFailure(record.name, errText(err))
        throw new Error(`${errText(err)}（代码已保存，插件已停用并记录失败原因；修复后重新写入或启用即可）`)
      }
    })
  }

  /**
   * Delete one plugin: unmount its binding, drop its sandbox instance, remove
   * the record. Missing names throw (misconfiguration fails loud).
   */
  async remove(pluginName: string): Promise<void> {
    assertName(pluginName)
    await this.enqueue(async () => {
      const existing = await this.readAll()
      if (!existing.some(record => record.name === pluginName)) {
        throw new Error(`插件不存在：${pluginName}`)
      }
      await this.saveAll(existing.filter(record => record.name !== pluginName))
      this.deactivate(pluginName)
      log(`已删除用户插件 ${pluginName}`)
    })
  }

  /**
   * Enable or disable one plugin, persisting the flag and mounting/unmounting
   * accordingly. The rebuilt record drops a stale `lastError` (the user acted
   * on the switch; an activation failure below re-marks it). Enabling may
   * throw (broken code surfaces to the caller, with the record persisted
   * disabled + error); disabling never does.
   */
  async toggle(pluginName: string, enabled: boolean): Promise<{ name: string; enabled: boolean; registeredEvents: string[] }> {
    assertName(pluginName)
    return this.enqueue(async () => {
      const existing = await this.readAll()
      const record = existing.find(item => item.name === pluginName)
      if (record === undefined) throw new Error(`插件不存在：${pluginName}`)
      const { lastError: _cleared, ...withoutError } = record
      const updated: UserPluginRecord = { ...withoutError, enabled, updatedAt: Date.now() }
      await this.saveAll(existing.map(item => (item.name === pluginName ? updated : item)))
      this.deactivate(pluginName)
      if (!enabled) return { name: pluginName, enabled, registeredEvents: [] }
      try {
        const registeredEvents = await this.activate(updated)
        return { name: pluginName, enabled, registeredEvents }
      } catch (err) {
        await this.persistActivationFailure(pluginName, errText(err))
        throw new Error(`${errText(err)}（插件已停用并记录失败原因；修复代码后重新启用即可）`)
      }
    })
  }

  // ── mutation plumbing ──

  /** Serialize one roster-mutating operation behind the shared tail. */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.tail.then(op, op)
    this.tail = next.catch(() => undefined)
    return next
  }

  private async readAll(): Promise<UserPluginRecord[]> {
    const items = await storageGet([USER_PLUGINS_KEY])
    return parseMedium(items[USER_PLUGINS_KEY])
  }

  private async saveAll(items: UserPluginRecord[]): Promise<void> {
    const medium: PluginMedium = { version: PLUGIN_MEDIUM_VERSION, items }
    await storageSet({ [USER_PLUGINS_KEY]: medium })
  }

  /**
   * 落盘「停用+失败标识」：把该记录置为 `enabled: false` 并写入错误文本，让
   * list 面与后续 boot 如实反映「激活失败」。调用方拿到的必须是原始激活错误，
   * 所以这里的存储写入失败只告警不抛——标记是簿记，激活失败才是主故障。
   * write/toggle 内的调用已在 enqueue 串行链上；start() 的调用发生于引擎
   * boot 完成、工具注册之前（main.ts await start()），同样无并发竞争。
   */
  private async persistActivationFailure(pluginName: string, message: string): Promise<void> {
    try {
      const existing = await this.readAll()
      await this.saveAll(existing.map(record =>
        record.name === pluginName
          ? { ...record, enabled: false, lastError: message, updatedAt: Date.now() }
          : record,
      ))
    } catch (err) {
      warn(`插件 ${pluginName} 的失败标识落盘失败（记录可能仍显示为启用）：`, errText(err))
    }
  }

  // ── bind / unbind ──

  /**
   * Evaluate one enabled record in the sandbox page and subscribe its declared
   * events onto `ctx.events`. Replaces any prior binding of the same name, so
   * repeated writes never duplicate context listeners.
   * @returns the deduped event names that were subscribed.
   */
  private async activate(record: UserPluginRecord): Promise<string[]> {
    this.deactivate(record.name)
    const reply = await this.runInSandbox(record.name, record.code)
    const declared = reply.registeredEvents.filter(
      eventName => eventName.length > 0 && eventName.length <= MAX_EVENT_NAME_LENGTH,
    )
    const events = [...new Set(declared)].slice(0, MAX_EVENTS_PER_PLUGIN)
    if (declared.length > events.length) {
      warn(`插件 ${record.name} 声明的事件名超出上限或非法，已按上限截断（${String(MAX_EVENTS_PER_PLUGIN)}）`)
    }
    const binding: PluginBinding = { record, events, disposers: [] }
    // String-name subscription seam: EventsService.on accepts arbitrary names
    // (dynamic events declared by user plugins have no static Events entry),
    // so bind to the explicit string face instead of the K-keyed augmentation.
    const subscribe = this.ctx.events.on.bind(this.ctx.events) as (
      name: string,
      listener: (...args: unknown[]) => void,
    ) => () => boolean
    for (const eventName of events) {
      const listener = (...args: unknown[]): void => {
        this.forwardEvent(record.name, eventName, args)
      }
      binding.disposers.push(subscribe(eventName, listener))
    }
    this.bindings.set(record.name, binding)
    return events
  }

  /** Unmount one plugin if bound: detach context listeners, drop the sandbox instance. */
  private deactivate(pluginName: string): void {
    const binding = this.bindings.get(pluginName)
    if (binding !== undefined) {
      this.unbind(binding)
      this.bindings.delete(pluginName)
    }
    this.postToSandbox({ op: 'unload', plugin: pluginName })
  }

  private unbind(binding: PluginBinding): void {
    for (const dispose of binding.disposers) {
      try {
        dispose()
      } catch (err) {
        warn('解绑事件监听失败：', errText(err))
      }
    }
    binding.disposers = []
  }

  /** Forward one harness dispatch into the sandbox plugin (fire-and-forget). */
  private forwardEvent(pluginName: string, eventName: string, args: unknown[]): void {
    const request: Extract<SandboxRequest, { op: 'emit' }> = {
      source: HOST_TO_SANDBOX,
      id: this.nextId(),
      op: 'emit',
      plugin: pluginName,
      eventName,
      payload: args.map(arg => snapshot(arg)),
    }
    try {
      this.frame?.contentWindow?.postMessage(request, SANDBOX_TARGET_ORIGIN)
    } catch (err) {
      warn(`向插件 ${pluginName} 转发事件 ${eventName} 失败：`, errText(err))
    }
  }

  // ── iframe & messaging ──

  /** Insert the hidden sandbox iframe once and wait for its ready handshake. */
  private ensureReady(): Promise<HTMLIFrameElement> {
    this.readyPromise ??= this.createIframe()
    return this.readyPromise
  }

  private createIframe(): Promise<HTMLIFrameElement> {
    const frame = document.createElement('iframe')
    frame.src = sandboxUrl()
    // Invisible but present: display:none can suppress iframe loading in some
    // engines, so park it off-canvas instead.
    frame.style.position = 'fixed'
    frame.style.width = '0'
    frame.style.height = '0'
    frame.style.border = '0'
    frame.style.visibility = 'hidden'
    frame.style.left = '-9999px'
    // Module scripts run after parsing, so document.body always exists here
    // (this host boots from offscreen/main.ts, never from <head>).
    document.body.appendChild(frame)
    this.frame = frame
    return new Promise<HTMLIFrameElement>((resolve, reject) => {
      const timer = setTimeout(() => {
        // The handshake budget elapsed without a ready message: drop the dead
        // frame and clear the cached attempt so the next ensureReady() starts
        // a fresh load instead of replaying this rejection forever (the
        // pre-warm warn in start() documents the retry contract).
        this.readyWaiter = undefined
        this.readyPromise = undefined
        if (this.frame === frame) this.frame = undefined
        frame.remove()
        reject(new Error(
          `沙箱页面握手超时（${String(READY_TIMEOUT_MS)}ms）——检查 dist 是否包含 sandbox.html 且 manifest 已声明 sandbox.pages`,
        ))
      }, READY_TIMEOUT_MS)
      this.readyWaiter = () => {
        clearTimeout(timer)
        resolve(frame)
      }
    })
  }

  /** Send one `run` request and await the correlated reply. */
  private runInSandbox(pluginName: string, code: string): Promise<RunReply> {
    return this.ensureReady().then(
      frame =>
        new Promise<RunReply>((resolve, reject) => {
          const requestId = this.nextId()
          const timer = setTimeout(() => {
            this.pendingRuns.delete(requestId)
            reject(new Error(`沙箱运行响应超时（${String(RUN_TIMEOUT_MS)}ms）：${pluginName}`))
          }, RUN_TIMEOUT_MS)
          this.pendingRuns.set(requestId, { resolve, reject, timer })
          const request: Extract<SandboxRequest, { op: 'run' }> = {
            source: HOST_TO_SANDBOX,
            id: requestId,
            op: 'run',
            plugin: pluginName,
            code,
          }
          frame.contentWindow?.postMessage(request, SANDBOX_TARGET_ORIGIN)
        }),
    )
  }

  /** Fire-and-forget teardown notice; the sandbox session ends with this document anyway. */
  private postToSandbox(request: { op: 'unload'; plugin: string }): void {
    try {
      this.frame?.contentWindow?.postMessage(
        { source: HOST_TO_SANDBOX, id: this.nextId(), ...request } satisfies Extract<SandboxRequest, { op: 'unload' }>,
        SANDBOX_TARGET_ORIGIN,
      )
    } catch {
      // Frame gone mid-teardown: nothing to deliver to, nothing to recover.
    }
  }

  private nextId(): string {
    this.seq += 1
    return String(this.seq)
  }

  /**
   * Single ingress for every sandbox→host message: identify the frame, check
   * the protocol tag, then route (ready handshake / correlated run reply /
   * allowlisted host calls).
   */
  private readonly onWindowMessage = (event: MessageEvent): void => {
    if (this.frame === undefined || event.source !== this.frame.contentWindow) return
    const data: unknown = event.data
    if (data === null || typeof data !== 'object') return
    const message = data as Record<string, unknown>
    if (message.source !== SANDBOX_TO_HOST) return

    if (message.type === 'ready') {
      this.readyWaiter?.()
      this.readyWaiter = undefined
      log('沙箱页面就绪')
      return
    }

    if (message.type === 'call') {
      this.routeHostCall(message)
      return
    }

    const requestId = typeof message.id === 'string' ? message.id : undefined
    if (requestId === undefined) return
    const pending = this.pendingRuns.get(requestId)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.pendingRuns.delete(requestId)
    if (message.ok === true) {
      const rawEvents = Array.isArray(message.registeredEvents) ? message.registeredEvents : []
      pending.resolve({
        registeredEvents: rawEvents.filter((entry): entry is string => typeof entry === 'string'),
      })
    } else {
      pending.reject(new Error(typeof message.error === 'string' ? message.error : '沙箱返回未知错误'))
    }
  }

  /**
   * Host-call channel: an explicit ALLOWLIST — plugins reach the host only
   * through `log`/`warn`, attributed to their plugin name; anything else drops
   * loudly. Growing this surface means editing this method, keeping the
   * capability list auditable in one place.
   */
  private routeHostCall(message: Record<string, unknown>): void {
    // Array.isArray on an unknown value narrows to any[]; retype explicitly so
    // the spread below stays in the typed world.
    const args: unknown[] = Array.isArray(message.args) ? (message.args as unknown[]) : []
    const owner = typeof message.plugin === 'string' ? message.plugin : '<unknown>'
    switch (message.name) {
      case 'log':
        log(`[${owner}]`, ...args)
        break
      case 'warn':
        warn(`[${owner}]`, ...args)
        break
      default:
        warn(`拒绝未列入 allowlist 的沙箱调用 '${String(message.name)}'（来自 ${owner}）`)
        break
    }
  }
}

// ───────────────────────── singleton accessor ─────────────────────────

/**
 * The currently booted host (set by offscreen/main.ts), if any. Mirrors the
 * ui-bridge accessor pattern so later wiring (api-bridge methods) can reach
 * the live instance without import cycles.
 */
let activeHost: UserPluginHost | undefined

/** Publish the live host instance (called once per offscreen boot). */
export function setUserPluginHost(host: UserPluginHost): void {
  activeHost = host
}

/** The currently booted host, or undefined before/after the engine boots. */
export function userPluginHost(): UserPluginHost | undefined {
  return activeHost
}
