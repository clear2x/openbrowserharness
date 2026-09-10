/**
 * MV3 sandbox-page runtime for user-authored plugins.
 *
 * This page is declared in manifest.json under `sandbox.pages`, which exempts
 * it from the extension pages' `script-src 'self'` CSP: `new Function`/`eval`
 * work here and nowhere else in the extension. The offscreen engine host
 * embeds this document as a hidden iframe and drives it exclusively over
 * window.postMessage (chrome.* APIs are unavailable inside a sandboxed
 * origin, so chrome.runtime is never touched).
 *
 * SECURITY NOTE (threat model): the code evaluated here runs on the local
 * user's own machine, authored or AI-generated on their explicit behalf —
 * this is the user extending their own harness, not an adversarial input
 * surface. The sandbox isolates the extension bundle from accidental breakage
 * (syntax errors, runaway listeners), NOT malicious code from the user; any
 * capability a hostile script could obtain through this channel exists only
 * because the same user could paste it into DevTools anyway. Do not present
 * this mechanism as a security boundary.
 *
 * Protocol — host → sandbox (`window.postMessage`, source tag below):
 *   { source:'obh-sandbox', id:string, op:'run',    plugin:string, code:string }
 *       evaluate `code` as a function body receiving `ctx`; the returned value
 *       is the plugin instance registered under `plugin`. A prior instance of
 *       the same name is removed first (its remove() runs best-effort).
 *   { source:'obh-sandbox', id:string, op:'emit',   plugin:string, eventName:string, payload:unknown[] }
 *       forward one harness event to that instance's `on(eventName, payload)`.
 *   { source:'obh-sandbox', id:string, op:'unload', plugin:string }
 *       run the instance's `remove()` and drop it.
 *
 * Protocol — sandbox → host:
 *   { source:'obh-sandbox-host', type:'ready' }                         load handshake
 *   { source:'obh-sandbox-host', id, ok:true,  registeredEvents }       run reply
 *   { source:'obh-sandbox-host', id, ok:false, error }                  run failure
 *   { source:'obh-sandbox-host', type:'call', name:'log'|'warn', args } allowlisted host calls
 *
 * User plugin instance contract (the object user code returns):
 *   {
 *     events?: string[],                                            // harness event names to subscribe
 *     on?:     (eventName: string, payload: unknown[]) => void,     // forwarded harness events
 *     remove?: () => void,                                          // teardown
 *   }
 * Everything else the code can reach arrives through the `ctx` parameter:
 * `{ config, log(...a), warn(...a) }` — the minimal sandbox-side host API;
 * every real capability lives in the offscreen host behind postMessage.
 */

/** Message-source tags shared by both protocol directions. */
const HOST_TO_SANDBOX = 'obh-sandbox'
const SANDBOX_TO_HOST = 'obh-sandbox-host'

/** Upper bounds mirroring the host's write validation (defense in depth). */
const MAX_CODE_LENGTH = 400_000
const MAX_REGISTERED_EVENTS = 32

/** Functions/symbols/bigins cannot cross structured clone; render them inert. */
function snapshotArg(value: unknown, depth: number, seen: Set<object>): unknown {
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`
  if (typeof value === 'bigint' || typeof value === 'symbol') return String(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  if (depth > 6) return '[depth-limit]'
  const nextSeen = new Set(seen)
  nextSeen.add(value)
  if (Array.isArray(value)) return value.map(item => snapshotArg(item, depth + 1, nextSeen))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) out[key] = snapshotArg(item, depth + 1, nextSeen)
  return out
}

/**
 * The per-plugin `ctx` handed into user code. `config` is a frozen placeholder
 * for future per-plugin settings — reading anything from it stays legal today.
 */
function buildHostCtx(pluginName: string): Record<string, unknown> {
  const emit = (name: 'log' | 'warn', args: unknown[]): void => {
    window.parent.postMessage(
      { source: SANDBOX_TO_HOST, type: 'call', plugin: pluginName, name, args: args.map(a => snapshotArg(a, 0, new Set())) },
      parentTarget(),
    )
  }
  return {
    config: Object.freeze({}),
    log: (...args: unknown[]): void => {
      emit('log', args)
    },
    warn: (...args: unknown[]): void => {
      emit('warn', args)
    },
  }
}

/** The embedding extension origin when discoverable, else unrestricted. */
function parentTarget(): string {
  // Sandboxed origins are opaque, so the exact ancestor origin cannot be
  // derived locally; Chromium exposes it via ancestorOrigins. An empty list
  // falls back to '*'.
  const origins = window.location.ancestorOrigins
  const first = origins.length > 0 ? origins[0] : undefined
  return first ?? '*'
}

function reply(id: string, ok: true, registeredEvents: string[]): void
function reply(id: string, ok: false, error: string): void
function reply(id: string, ok: boolean, body: unknown): void {
  const message: Record<string, unknown> = { source: SANDBOX_TO_HOST, id, ok }
  if (!ok) message.error = body
  else message.registeredEvents = body
  window.parent.postMessage(message, parentTarget())
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

interface UserPluginInstance {
  events?: unknown
  on?: unknown
  remove?: unknown
}

/** Instances keyed by plugin name: re-running a name replaces its instance. */
const instances = new Map<string, UserPluginInstance>()

/** Extract the deduped, size-capped `events` declaration list from one instance. */
function registeredEventsOf(instance: UserPluginInstance): string[] {
  if (!Array.isArray(instance.events)) return []
  const names: string[] = []
  for (const entry of instance.events) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 128) continue
    if (!names.includes(entry)) names.push(entry)
    if (names.length >= MAX_REGISTERED_EVENTS) break
  }
  return names
}

/** Best-effort teardown of one instance; a throwing remove() never blocks unload. */
function disposeInstance(pluginName: string, instance: UserPluginInstance | undefined): void {
  if (instance === undefined || typeof instance.remove !== 'function') return
  try {
    (instance.remove as () => void)()
  } catch (err) {
    console.warn(`[obh-sandbox] 插件 ${pluginName} 的 remove() 抛错：`, errText(err))
  }
}

function handleRun(request: Record<string, unknown>): void {
  const requestId = typeof request.id === 'string' ? request.id : ''
  const pluginName = request.plugin
  const code = request.code
  if (typeof pluginName !== 'string' || pluginName.length === 0) {
    reply(requestId, false, 'run：缺少 plugin 名称')
    return
  }
  if (typeof code !== 'string' || code.length === 0 || code.length > MAX_CODE_LENGTH) {
    reply(requestId, false, `run：插件代码必须是非空且不超过 ${String(MAX_CODE_LENGTH)} 字符的字符串`)
    return
  }
  let factory: (ctx: unknown) => unknown
  try {
    // The mechanism's whole point: this page is the manifest-sandboxed one,
    // the only extension page whose CSP permits indirect eval. Narrow,
    // justified exception to no-implied-eval — see the security note above.
    // oxlint-disable-next-line typescript/no-implied-eval
    factory = new Function('ctx', `"use strict";\n${code}`) as (ctx: unknown) => unknown
  } catch (err) {
    reply(requestId, false, `run：代码编译失败——${errText(err)}（若为 EvalError，检查 manifest.json 是否已声明 sandbox.pages）`)
    return
  }
  let instance: unknown
  try {
    instance = factory(buildHostCtx(pluginName))
  } catch (err) {
    reply(requestId, false, `run：插件初始化抛错——${errText(err)}`)
    return
  }
  if (instance === null || typeof instance !== 'object') {
    reply(requestId, false, 'run：插件代码必须返回一个对象（{ events?, on?, remove? }）')
    return
  }
  disposeInstance(pluginName, instances.get(pluginName))
  instances.set(pluginName, instance)
  reply(requestId, true, registeredEventsOf(instance))
}

function handleEmit(request: Record<string, unknown>): void {
  const instance = typeof request.plugin === 'string' ? instances.get(request.plugin) : undefined
  const eventName = request.eventName
  if (instance === undefined || typeof eventName !== 'string') return
  if (typeof instance.on !== 'function') return
  const payload = Array.isArray(request.payload) ? request.payload : []
  // Async isolation: a slow or rejected handler must not stall later emits.
  Promise.resolve()
    .then(() => (instance.on as (name: string, list: unknown[]) => unknown)(eventName, payload))
    .catch((err: unknown) => {
      console.warn(`[obh-sandbox] 插件 ${String(request.plugin)} 处理事件 ${eventName} 抛错：`, errText(err))
    })
}

function handleUnload(request: Record<string, unknown>): void {
  const pluginName = request.plugin
  if (typeof pluginName !== 'string') return
  disposeInstance(pluginName, instances.get(pluginName))
  instances.delete(pluginName)
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window.parent) return
  const data: unknown = event.data
  if (data === null || typeof data !== 'object' || (data as { source?: unknown }).source !== HOST_TO_SANDBOX) return
  const request = data as Record<string, unknown>
  switch (request.op) {
    case 'run':
      handleRun(request)
      break
    case 'emit':
      handleEmit(request)
      break
    case 'unload':
      handleUnload(request)
      break
    default:
      break
  }
})

// Load handshake: the host installs its message listener BEFORE inserting the
// iframe, so this module-load-time post can never be missed.
window.parent.postMessage({ source: SANDBOX_TO_HOST, type: 'ready' }, parentTarget())
