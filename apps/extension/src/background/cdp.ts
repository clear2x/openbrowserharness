/**
 * chrome.debugger (CDP) controller — the single owner of debug sessions on
 * the Service Worker side (ported from the OpenBrowserHarness reference and
 * hardened for SW restarts).
 *
 * - attach(tabId): idempotent, concurrent calls share one attach task, and
 *   after the "already attached" error it self-heals by probing
 *   chrome.debugger.getTargets: a target OUR extension still holds counts as
 *   attached (an SW kill loses the in-memory Map while the browser layer
 *   stays attached), while any other debugger holder stays a loud error.
 * - After a successful attach the Page / Runtime domains are enabled; an
 *   enable failure rolls the attach back.
 * - send(tabId, method, params): promise wrapper over sendCommand with
 *   uniform Chinese error translation; "not attached" failures sync the
 *   internal state before throwing.
 */

/** Timing primitive shared by the humanized input modules. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
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

/** Attach-phase error → Chinese message. */
function translateAttachError(err: unknown): Error {
  const msg = errText(err)
  if (/another debugger|already attached/i.test(msg)) {
    return new Error(
      '无法附加调试器：该标签页已被其他调试器占用（请关闭 DevTools 或其他正在使用 chrome.debugger 的扩展后重试）',
    )
  }
  if (/cannot attach|not allowed|unsupported|protected/i.test(msg)) {
    return new Error(
      '无法附加调试器：该页面受保护（chrome:// 等浏览器内部页面、Chrome 商店或 Web 编辑器），请切换到普通网页标签页',
    )
  }
  if (/no target|not found|invalid tab/i.test(msg)) {
    return new Error('无法附加调试器：目标标签页不存在或已被关闭')
  }
  return new Error(`无法附加调试器：${msg}`)
}

/** sendCommand-phase error → Chinese message. */
function translateCommandError(err: unknown, tabId: number, method: string): Error {
  const msg = errText(err)
  if (/not attached|session.*not found|debugger.*detach/i.test(msg)) {
    return new Error(
      `CDP 命令 ${method} 失败：调试会话已断开（页面可能已导航、关闭或被 DevTools 抢占），请重新执行 ensure_attached`,
    )
  }
  if (/no target|not found/i.test(msg)) {
    return new Error(`CDP 命令 ${method} 失败：标签页 ${tabId} 不存在或已被关闭`)
  }
  return new Error(`CDP 命令 ${method} 失败：${msg}`)
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

class CdpController {
  private readonly attachedTabs = new Set<number>()
  /** In-flight attach requests (concurrency dedup). */
  private readonly attaching = new Map<number, Promise<void>>()

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
   * recorded session-target ids (extensionId is omitted there).
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
   * share one task. On success Page/Runtime domains are enabled; an enable
   * failure rolls the attach back.
   */
  async attach(tabId: number): Promise<void> {
    if (this.attachedTabs.has(tabId)) return
    const pending = this.attaching.get(tabId)
    if (pending) return pending

    const task = this.doAttach(tabId).finally(() => {
      this.attaching.delete(tabId)
    })
    this.attaching.set(tabId, task)
    return task
  }

  private async doAttach(tabId: number): Promise<void> {
    try {
      await chrome.debugger.attach({ tabId }, '1.3')
    } catch (err) {
      const msg = errText(err)
      if (/another debugger|already attached|duplicate attach/i.test(msg)) {
        // Self-heal: adopt only when OUR extension is the holder (a lost
        // in-memory Map after an SW restart); another debugger stays loud.
        const ours = await this.ownAttachmentOf(tabId)
        if (!ours) throw translateAttachError(err)
      } else {
        throw translateAttachError(err)
      }
    }

    this.attachedTabs.add(tabId)
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable')
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable')
    } catch (err) {
      // Roll back: never leave a half-initialized session behind.
      this.attachedTabs.delete(tabId)
      try {
        await chrome.debugger.detach({ tabId })
      } catch {
        // Rollback failure is not actionable.
      }
      throw new Error(
        `调试器已附加，但初始化失败（Page/Runtime enable）：${errText(err)}`,
      )
    }
    await recordTargetId(tabId)
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
      const msg = errText(err)
      if (!/not attached|no debugger|not found/i.test(msg)) {
        throw new Error(`分离调试器失败：${msg}`)
      }
    }
  }

  /** External (onDetach event) notification that a session ended. */
  handleDetached(tabId: number): void {
    this.attachedTabs.delete(tabId)
    this.attaching.delete(tabId)
    void clearRecordedTargetId(tabId)
  }

  /**
   * Send one CDP command; auto-attaches first when needed (idempotent,
   * equivalent to ensure_attached). All low-level errors are translated to
   * Chinese before throwing.
   */
  async send<T = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    if (!this.attachedTabs.has(tabId) && !this.attaching.has(tabId)) {
      await this.attach(tabId)
    }
    try {
      const result = await chrome.debugger.sendCommand(
        { tabId },
        method,
        params ?? {},
      )
      return result as unknown as T
    } catch (err) {
      if (/not attached|session.*not found/i.test(errText(err))) {
        this.handleDetached(tabId)
      }
      throw translateCommandError(err, tabId, method)
    }
  }
}

/** Global singleton: one controller for the whole Service Worker. */
export const cdpController = new CdpController()
