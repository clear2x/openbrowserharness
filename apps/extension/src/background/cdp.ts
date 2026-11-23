/**
 * chrome.debugger (CDP) controller — the single owner of debug sessions on
 * the Service Worker side (ported from the OpenBrowserHarness reference and
 * hardened for SW restarts).
 *
 * - attach(tabId): idempotent, concurrent calls share one attach task. A
 *   discarded (sleeping/unloaded) tab is reloaded and awaited first. After
 *   the "already attached" error the controller self-heals by probing
 *   chrome.debugger.getTargets: a target OUR extension still holds counts as
 *   attached (an SW kill loses the in-memory Map while the browser layer
 *   stays attached) — and an adopted session is VERIFIED with a harmless
 *   probe before it is trusted; any other debugger holder stays a loud error.
 * - After a successful attach the Page / Runtime domains are enabled. An
 *   enable failure that says the session is gone (the attach resolved but the
 *   session died — a detach right after the attach, whatever caused it) is
 *   retried on a backoff schedule, each attempt from a clean slate; the
 *   final error carries the live browser-layer state and the most recent
 *   detach event (its reason included), so one message names the cause.
 * - send(tabId, method, params): promise wrapper over sendCommand with
 *   uniform Chinese error translation. A "not attached" failure means the
 *   command never ran: the controller re-attaches and sends it once more.
 */

import { beaconBlockEnabled, blockMediaEnabled } from './capability-gate'

/** Timing primitive shared by the humanized input modules. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}

/**
 * Waits before each attach retry after the session died right after an
 * attach. A detach caused by a waking tab or a navigating tab clears within
 * the first second; the later steps cover slow wake-and-reload cycles.
 */
export const DEFAULT_ATTACH_RETRY_WAITS_MS: readonly number[] = [0, 250, 750, 2000]

/** How long a discarded tab's wake-up reload may take to reach `complete`. */
export const DEFAULT_WAKE_WAIT_MS = 8_000

/** Budget for the probe that verifies an adopted session. */
export const DEFAULT_ADOPT_PROBE_MS = 3_000

/** How recent a detach event must be to be reported as the failure's cause. */
const DETACH_RELEVANCE_MS = 10_000

/** One recorded detach event of a tab. */
export interface DetachEvent {
  /** chrome.debugger.onDetach's reason, or `command-rejected` when a command found the session gone without an event. */
  reason: string
  /** Epoch ms. */
  at: number
}

/** Test-seam timing of the controller; production uses the defaults. */
export interface CdpControllerOptions {
  attachRetryWaitsMs?: readonly number[]
  wakeWaitMs?: number
  adoptProbeMs?: number
}

/** Readable text from an unknown error. */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/** Whether an error says the debug session is gone (attach/enable/command phases). */
function isSessionGone(err: unknown): boolean {
  return /not attached|session.*not found|debugger.*detach/i.test(errText(err))
}

/** Whether an error says the tab itself is gone from the debugger's view. */
function isTabGone(err: unknown): boolean {
  return /no tab|no target|not found|invalid tab/i.test(errText(err))
}

/**
 * Whether a failed attempt is worth retrying: only a session that died
 * right after the attach (a detach racing the enable) tends to clear within
 * the backoff schedule. A missing tab, a protected page, and another
 * debugger's session report at once instead of delaying the answer.
 */
function isRetryable(err: unknown): boolean {
  return isSessionGone(err) && !(err instanceof TranslatedCdpError)
}

/** An error already translated for the caller; never translate one twice. */
class TranslatedCdpError extends Error {}

/** Attach-phase error → Chinese message. */
function translateAttachError(err: unknown): Error {
  if (err instanceof TranslatedCdpError) return err
  const msg = errText(err)
  if (/another debugger|already attached/i.test(msg)) {
    return new TranslatedCdpError(
      '无法附加调试器：该标签页已被其他调试器占用（请关闭 DevTools 或其他正在使用 chrome.debugger 的扩展后重试）',
    )
  }
  if (/cannot attach|cannot access|not allowed|unsupported|protected/i.test(msg)) {
    return new TranslatedCdpError(
      '无法附加调试器：该页面受保护（chrome:// 等浏览器内部页面、Chrome 商店或 Web 编辑器），请切换到普通网页标签页',
    )
  }
  if (isTabGone(err)) {
    return new TranslatedCdpError('无法附加调试器：目标标签页不存在、已被关闭，或尚未完成恢复')
  }
  return new TranslatedCdpError(`无法附加调试器：${msg}`)
}

/** sendCommand-phase error → Chinese message. */
function translateCommandError(err: unknown, tabId: number, method: string): Error {
  const msg = errText(err)
  if (isSessionGone(err)) {
    return new Error(
      `CDP 命令 ${method} 失败：调试会话已断开（页面已关闭，或调试被其他客户端/浏览器提示条取消）`,
    )
  }
  if (isTabGone(err)) {
    return new Error(`CDP 命令 ${method} 失败：标签页 ${tabId} 不存在或已被关闭`)
  }
  return new Error(`CDP 命令 ${method} 失败：${msg}`)
}

/**
 * The user-facing explanation of a detach event recorded just before a
 * failure. `canceled_by_user` is the browser's debugging notice bar being
 * canceled, which detaches EVERY session of the extension until it is
 * allowed again — the one cause retrying cannot fix, so the text tells the
 * model to stop and inform the user.
 * @param event - the recorded detach.
 * @param now - the current epoch ms.
 * @returns the explanation.
 */
export function describeDetach(event: DetachEvent, now: number): string {
  const ago = Math.max(0, now - event.at)
  if (event.reason === 'canceled_by_user') {
    return `${String(ago)}ms 前调试会话被取消（canceled_by_user：浏览器顶部「已开始调试此浏览器」提示条上的「取消」被点击，或浏览器策略终止了调试）。在用户允许之前所有页面操作都会失败——请停止重试，并明确告诉用户：需要保留该提示条、不要点「取消」，然后再继续任务。`
  }
  if (event.reason === 'target_closed') {
    return `${String(ago)}ms 前调试目标被关闭（target_closed）。`
  }
  return `${String(ago)}ms 前调试会话被断开（${event.reason}）。`
}

/**
 * Edge's chrome.debugger.getTargets omits `extensionId` on every entry (it
 * names the session there too), so ownership probes fall back to the stable
 * session-target id recorded at attach time. @types/chrome omits the field.
 */
interface DebuggeeTargetWithId {
  id?: string
  type?: string
  tabId?: number
  attached?: boolean
  extensionId?: string
}

const targetIdKey = (tabId: number): string => `dsh-dbg-target:${tabId}`

async function recordTargetId(tabId: number): Promise<void> {
  try {
    const targets = (await chrome.debugger.getTargets()) as DebuggeeTargetWithId[]
    const mine = targets.find(t => t.type === 'page' && t.tabId === tabId && t.attached)
    if (mine?.id !== undefined) {
      await chrome.storage.session.set({ [targetIdKey(tabId)]: mine.id })
    }
  } catch {
    // Ownership bookkeeping is best-effort; the Chrome path never needs it.
  }
}

async function recordedTargetId(tabId: number): Promise<string | undefined> {
  try {
    const key = targetIdKey(tabId)
    const stored = await chrome.storage.session.get(key)
    const id = stored[key]
    return typeof id === 'string' ? id : undefined
  } catch {
    return undefined
  }
}

async function clearRecordedTargetId(tabId: number): Promise<void> {
  try {
    await chrome.storage.session.remove(targetIdKey(tabId))
  } catch {
    // Best-effort cleanup; a stale record only widens the adopt probe.
  }
}

/** Promise that settles to `undefined` after `ms` without rejecting the wrapped work. */
function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const timer = setTimeout(() => { resolve(undefined) }, ms)
    work.then(
      (value) => { clearTimeout(timer); resolve(value) },
      () => { clearTimeout(timer); resolve(undefined) },
    )
  })
}

export class CdpController {
  private readonly attachedTabs = new Set<number>()
  /** In-flight attach requests (concurrency dedup). */
  private readonly attaching = new Map<number, Promise<void>>()
  /** The most recent detach event per tab (the cause a nearby failure reports). */
  private readonly lastDetach = new Map<number, DetachEvent>()
  private readonly retryWaitsMs: readonly number[]
  private readonly wakeWaitMs: number
  private readonly adoptProbeMs: number

  constructor(options: CdpControllerOptions = {}) {
    this.retryWaitsMs = options.attachRetryWaitsMs ?? DEFAULT_ATTACH_RETRY_WAITS_MS
    this.wakeWaitMs = options.wakeWaitMs ?? DEFAULT_WAKE_WAIT_MS
    this.adoptProbeMs = options.adoptProbeMs ?? DEFAULT_ADOPT_PROBE_MS
  }

  /** Whether the tab is currently attached (internal Map + onDetach sync). */
  isAttached(tabId: number): boolean {
    return this.attachedTabs.has(tabId)
  }

  /** All tabs the controller currently believes are attached. */
  attachedTabIds(): number[] {
    return [...this.attachedTabs]
  }

  /**
   * Probe chrome.debugger.getTargets and re-adopt every page target our own
   * extension still holds. Covers the SW-restart case: the in-memory Map was
   * lost but the browser layer kept the session. On Edge the probe rides the
   * recorded session-target ids (extensionId is omitted there). A re-adopted
   * session that turns out dead self-heals on its first command (send).
   */
  async recoverFromBrowserState(): Promise<void> {
    try {
      const targets = await chrome.debugger.getTargets()
      const own = chrome.runtime.id
      for (const target of targets) {
        if (target.type !== 'page' || target.tabId === undefined) continue
        if (!target.attached) continue
        if (target.extensionId === own) {
          this.attachedTabs.add(target.tabId)
          continue
        }
        const recorded = await recordedTargetId(target.tabId)
        if (recorded !== undefined && recorded === target.id) {
          this.attachedTabs.add(target.tabId)
        }
      }
    } catch (err) {
      console.warn('[dsh-bg] 恢复调试器附加状态失败：', errText(err))
    }
  }

  /**
   * Idempotent attach; already-attached returns immediately; concurrent calls
   * share one task. On success Page/Runtime domains are enabled and the
   * debugger-layer capability guards are applied (once, by the initiating
   * caller — a guard's own send may re-enter attach, so the guards run
   * outside the shared task).
   */
  async attach(tabId: number): Promise<void> {
    if (this.attachedTabs.has(tabId)) return
    const pending = this.attaching.get(tabId)
    if (pending) {
      await pending
      return
    }
    const task = this.doAttach(tabId).finally(() => {
      this.attaching.delete(tabId)
    })
    this.attaching.set(tabId, task)
    await task
    await recordTargetId(tabId)
    await this.applyCapabilityGuards(tabId)
  }

  /**
   * Live attachment facts of one tab as the browser layer sees them (the
   * diagnosis inputs for the enable-failure error).
   */
  private async targetFactsOf(tabId: number): Promise<{ exists: boolean; attached: boolean; holder?: string }> {
    try {
      const targets = (await chrome.debugger.getTargets()) as DebuggeeTargetWithId[]
      const match = targets.find(target => target.type === 'page' && target.tabId === tabId)
      if (match === undefined) return { exists: false, attached: false }
      return {
        exists: true,
        attached: match.attached === true,
        ...(match.extensionId !== undefined ? { holder: match.extensionId } : {}),
      }
    } catch {
      return { exists: false, attached: false }
    }
  }

  /** Best-effort chrome-level detach; every failure is swallowed. */
  private async forceDetachQuietly(tabId: number): Promise<void> {
    try {
      await chrome.debugger.detach({ tabId })
    } catch {
      // Nothing actionable: the session is already gone or held elsewhere.
    }
  }

  /**
   * Reload a discarded tab and await its load: a discarded (sleeping or
   * unloaded) tab has no page to debug — the debugger reports
   * "No tab with given id" — and reloading it is the only way to operate on
   * it (the browser reloads it on activation anyway). A tab that is gone or
   * never finishes is left for the attach below to report.
   */
  private async wakeIfDiscarded(tabId: number): Promise<void> {
    try {
      const tab = await chrome.tabs.get(tabId)
      if (!tab.discarded) return
      await chrome.tabs.reload(tabId)
      const deadline = Date.now() + this.wakeWaitMs
      while (Date.now() < deadline) {
        await sleep(200)
        if ((await chrome.tabs.get(tabId)).status === 'complete') return
      }
    } catch {
      // No tabs API, or the tab vanished: the attach attempt reports it.
    }
  }

  /**
   * The chrome.debugger.attach half of a fresh session, with the
   * already-attached adopt path. Does not touch attachedTabs. An adopted
   * session is verified with a harmless probe: a session that rejects the
   * probe while the target still shows as attached belongs to someone else
   * (loud error); one whose target shows as detached was ours and is gone
   * (the caller retries with a real attach).
   */
  private async rawAttachWithAdopt(tabId: number): Promise<void> {
    try {
      await chrome.debugger.attach({ tabId }, '1.3')
    } catch (err) {
      if (!/another debugger|already attached|duplicate attach/i.test(errText(err))) {
        throw translateAttachError(err)
      }
      // Self-heal: adopt only when OUR extension is the holder (a lost
      // in-memory Map after an SW restart); another debugger stays loud.
      const ours = await this.ownAttachmentOf(tabId)
      if (!ours) throw translateAttachError(err)
      const probe = await within(
        chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1', returnByValue: true }),
        this.adoptProbeMs,
      )
      if (probe !== undefined) return
      // The adopted session failed the probe: the recorded ownership is
      // stale. A target still showing as attached belongs to someone else
      // (loud); one showing as detached was ours and is gone — attach for real.
      const facts = await this.targetFactsOf(tabId)
      await clearRecordedTargetId(tabId)
      if (facts.attached) throw translateAttachError(err)
      try {
        await chrome.debugger.attach({ tabId }, '1.3')
      } catch (reattachErr) {
        throw translateAttachError(reattachErr)
      }
    }
  }

  /**
   * The final failure of an attach: live browser-layer state plus the most
   * recent detach event when one occurred nearby, so the message names the
   * cause instead of a contradictory 已附加/未附加 pair.
   * @param tabId - the failing tab.
   * @param err - the last attempt's error.
   * @param attempts - how many attempts ran.
   * @returns the error to throw.
   */
  private async attachInitFailure(tabId: number, err: unknown, attempts: number): Promise<Error> {
    const facts = await this.targetFactsOf(tabId)
    const state = [
      facts.exists ? '标签页存在' : '标签页不存在或已关闭',
      facts.attached ? '浏览器层存在附加会话' : '浏览器层无附加会话',
      ...(facts.holder !== undefined ? [`持有者 ${facts.holder}`] : []),
    ].join('，')
    const detach = this.lastDetach.get(tabId)
    const cause = detach !== undefined && Date.now() - detach.at <= DETACH_RELEVANCE_MS
      ? describeDetach(detach, Date.now())
      : '期间未收到调试会话断开事件'
    return new Error(
      `调试器附加后初始化失败（${errText(err)}），已自动重试 ${String(Math.max(0, attempts - 1))} 次仍失败。` +
        `断开原因：${cause} 现场：${state}。` +
        '其他常见原因：标签页正被浏览器休眠/丢弃（先切换到该标签页让它活跃再试）或被 DevTools/其他调试客户端抢占。',
    )
  }

  /**
   * One attach+enable attempt. Throws the raw enable error after rolling
   * the half-initialized session back.
   */
  private async attachAttempt(tabId: number): Promise<void> {
    await this.rawAttachWithAdopt(tabId)
    this.attachedTabs.add(tabId)
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable')
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable')
    } catch (err) {
      // Roll back: never leave a half-initialized session behind.
      this.attachedTabs.delete(tabId)
      throw err
    }
  }

  private async doAttach(tabId: number): Promise<void> {
    await this.wakeIfDiscarded(tabId)
    let lastErr: unknown
    let attempts = 0
    for (const waitMs of this.retryWaitsMs) {
      if (waitMs > 0) await sleep(waitMs)
      attempts += 1
      // Every attempt starts from a clean slate: a session left behind by an
      // earlier attempt (or lost by an SW restart) is detached first.
      await this.forceDetachQuietly(tabId)
      try {
        await this.attachAttempt(tabId)
        return
      } catch (err) {
        lastErr = err
        if (!isRetryable(err)) {
          const facts = await this.targetFactsOf(tabId)
          const base = translateAttachError(err)
          throw new TranslatedCdpError(
            `${base.message} 现场：${facts.exists ? '标签页存在' : '标签页不存在或已关闭'}，${facts.attached ? '浏览器层存在附加会话' : '浏览器层无附加会话'}`,
          )
        }
      }
    }
    throw await this.attachInitFailure(tabId, lastErr, attempts)
  }

  /**
   * Per-attach capability guards (the 内置能力 switches that live at the
   * debugger layer): 禁媒体加载 blocks image/video loads via the Network
   * domain; 埋点屏蔽 no-ops `navigator.sendBeacon` on this and every future
   * document of the tab. Both best-effort — a guard failure must not fail
   * the attach.
   */
  private async applyCapabilityGuards(tabId: number): Promise<void> {
    const guards: Array<Promise<void>> = []
    guards.push((async () => {
      if (!(await blockMediaEnabled())) return
      await this.send(tabId, 'Network.enable', {})
      await this.send(tabId, 'Network.setBlockedURLs', {
        urls: ['*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.avif', '*.bmp', '*.mp4', '*.webm', '*.m4v', '*.mov'],
      })
    })())
    guards.push((async () => {
      if (!(await beaconBlockEnabled())) return
      await this.send(tabId, 'Page.addScriptToEvaluateOnNewDocument', {
        source: `(function(){
          try { Navigator.prototype.sendBeacon = function(){ return true }; } catch (e) {}
        })()`,
      })
    })())
    await Promise.allSettled(guards)
  }

  /**
   * Whether this tab's attached debugger session is OUR extension.
   *
   * Chrome populates `extensionId` on the matching getTargets entry; Edge omits
   * it entirely, so there the recorded session-target id decides: doAttach
   * stored the target id in storage.session (which survives the SW restart
   * that loses the in-memory Map), and another debugger taking the tab would
   * appear as a different session id.
   */
  private async ownAttachmentOf(tabId: number): Promise<boolean> {
    try {
      const targets = await chrome.debugger.getTargets()
      const attached = targets.filter(
        target =>
          target.type === 'page' &&
          target.tabId === tabId &&
          target.attached,
      )
      if (attached.some(target => target.extensionId === chrome.runtime.id)) return true
      const recorded = await recordedTargetId(tabId)
      return recorded !== undefined && attached.some(target => target.id === recorded)
    } catch {
      return false
    }
  }

  /** Idempotent detach; not-attached returns immediately. */
  async detach(tabId: number): Promise<void> {
    if (!this.attachedTabs.has(tabId)) return
    this.attachedTabs.delete(tabId)
    void clearRecordedTargetId(tabId)
    try {
      await chrome.debugger.detach({ tabId })
    } catch (err) {
      if (!isSessionGone(err) && !isTabGone(err)) {
        throw new Error(`分离调试器失败：${errText(err)}`)
      }
    }
  }

  /**
   * External (onDetach event) notification that a session ended. 只清
   * attachedTabs 并记录断开原因，不删进行中的 attaching 条目：onDetach 不会
   * 取消仍在跑的 doAttach 任务，删掉条目会让并发到达的 send/attach 丢失同一
   * 个去重 promise、在 attach 窗口内重复发起 attach（竞态假性失败）；条目由
   * attach 任务自身的 finally 清理。
   * @param tabId - the tab whose session ended.
   * @param reason - chrome.debugger.onDetach's reason (absent for a bare notification).
   */
  handleDetached(tabId: number, reason?: string): void {
    this.attachedTabs.delete(tabId)
    if (reason !== undefined) this.lastDetach.set(tabId, { reason, at: Date.now() })
    void clearRecordedTargetId(tabId)
  }

  /**
   * Send one CDP command; auto-attaches first when needed (idempotent).
   * 同一 tab 已有 attach 进行中时先等待该 attach promise 再发命令（attach
   * 去重，失败原样抛出）——否则命令会在 attach 完成前的窗口里发出，报出假性
   * 的「调试会话已断开」。A "not attached" rejection means the command never
   * ran: the controller re-attaches and sends it once more. All low-level
   * errors are translated to Chinese before throwing.
   */
  async send<T = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    if (!this.attachedTabs.has(tabId)) {
      // attach() 自身幂等：已 attached 立即返回、attaching 进行中共享同一
      // 个 promise、否则新建任务——三种情况都等 attach 落定再发命令。
      await this.attach(tabId)
    }
    try {
      const result = await chrome.debugger.sendCommand({ tabId }, method, params ?? {})
      return result as unknown as T
    } catch (err) {
      if (!isSessionGone(err)) throw translateCommandError(err, tabId, method)
      this.handleDetached(tabId, 'command-rejected')
    }
    // The session was gone without an event (a dead re-adopted session, a
    // detach the SW slept through): one fresh attach, then the command again.
    await this.attach(tabId)
    try {
      const retried = await chrome.debugger.sendCommand({ tabId }, method, params ?? {})
      return retried as unknown as T
    } catch (err) {
      if (isSessionGone(err)) this.handleDetached(tabId, 'command-rejected')
      throw translateCommandError(err, tabId, method)
    }
  }
}

/** Global singleton: one controller for the whole Service Worker. */
export const cdpController = new CdpController()
