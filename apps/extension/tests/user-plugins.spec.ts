// @vitest-environment jsdom
/**
 * UserPluginHost spec: the sandbox bridge's timing and correlation contract.
 *
 * Covers the write hot path (persist → activate → correlated run reply →
 * context binding), the host→sandbox postMessage targetOrigin contract
 * (`'*'` — the manifest-sandboxed page runs in an opaque origin, so a
 * concrete targetOrigin is silently dropped; that drop was the root cause of
 * the historical "45s run timeout but the write actually persisted" reports),
 * reply correlation by request id (interleaved runs, reverse-order replies,
 * unknown ids ignored), the 45s stuck-pipe backstop with late replies
 * ignored, ready-handshake timeout recovery (the next operation rebuilds a
 * fresh frame instead of replaying the cached rejection), and the `'*'`
 * targetOrigin on emit/unload posts.
 *
 * jsdom cannot load the real sandbox page, so a SandboxDouble plays the
 * sandbox side: it spies `contentWindow.postMessage` to capture host→sandbox
 * posts (jsdom never enforces targetOrigin, so the `'-'`-constant assertion
 * pins the host-side contract) and delivers replies through the real window
 * ingress as synthetic MessageEvents whose `source` is the frame's
 * contentWindow — the exact identity check the host's single ingress applies.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { USER_PLUGINS_KEY, UserPluginHost } from '../src/chrome/user-plugins.ts'
import type { UserPluginRecord } from '../src/chrome/user-plugins.ts'

// ───────────────────────── chrome storage double ─────────────────────────

const store = new Map<string, unknown>()
;(globalThis as { chrome?: unknown }).chrome = {
  storage: {
    local: {
      get: async (keys: string[]) => {
        const out: Record<string, unknown> = {}
        for (const key of keys) if (store.has(key)) out[key] = store.get(key)
        return out
      },
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) store.set(key, value)
      },
      remove: async (keys: string[]) => {
        for (const key of keys) store.delete(key)
      },
    },
    onChanged: { addListener: () => undefined },
  },
  runtime: {
    // https URL: jsdom treats chrome-extension:// origins as opaque and its
    // Window setup throws on localStorage for opaque origins; the URL value
    // is irrelevant to the host contract under test.
    getURL: (path: string) => `https://sandbox.test/${path}`,
    sendMessage: async () => undefined,
    onMessage: { addListener: () => undefined },
  },
}

/** Wire tags duplicated from src/sandbox/main.ts (the receiving half owns them). */
const HOST_TO_SANDBOX = 'obh-sandbox'
const SANDBOX_TO_HOST = 'obh-sandbox-host'

// ───────────────────────── fixtures ─────────────────────────

interface FakeEvents {
  listeners: Map<string, Array<(...args: unknown[]) => void>>
  ctx: Context
}

/** Minimal context stand-in: only `ctx.events.on` (with real disposer semantics). */
function fakeCtx(): FakeEvents {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const ctx = {
    events: {
      on: (name: string, listener: (...args: unknown[]) => void) => {
        const bucket = listeners.get(name) ?? []
        bucket.push(listener)
        listeners.set(name, bucket)
        return () => {
          const index = bucket.indexOf(listener)
          if (index >= 0) bucket.splice(index, 1)
          return true
        }
      },
    },
  } as unknown as Context
  return { listeners, ctx }
}

function storedRecord(name: string, code: string, enabled = true): UserPluginRecord {
  return { name, title: `标题 ${name}`, description: '', enabled, code, createdAt: 1, updatedAt: 1 }
}

function mediumOf(items: UserPluginRecord[]): unknown {
  return { version: 1, items }
}

async function waitForIframe(): Promise<HTMLIFrameElement> {
  for (let tick = 0; tick < 200; tick += 1) {
    const frame = document.querySelector('iframe')
    if (frame !== null) return frame
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('沙箱 iframe 未被创建')
}

// ───────────────────────── sandbox double ─────────────────────────

interface PostedCall {
  message: Record<string, unknown>
  targetOrigin: string
}

/**
 * Plays the sandbox page for one host frame: captures host→sandbox posts and
 * answers run requests through the host's real ingress (synthetic
 * MessageEvent with the frame's contentWindow as e.source).
 */
class SandboxDouble {
  readonly posted: PostedCall[] = []
  private automatic: string[] | undefined
  private waiters: Array<{ op: string; plugin?: string | undefined; resolve: (message: Record<string, unknown>) => void }> = []

  constructor(private readonly frame: HTMLIFrameElement) {}

  /** Spy the outbound postMessage; must be armed before any host post. */
  arm(): void {
    const contentWindow = this.frame.contentWindow
    if (contentWindow === null) throw new Error('jsdom 未提供 iframe contentWindow')
    vi.spyOn(contentWindow, 'postMessage').mockImplementation(
      ((message: Record<string, unknown>, targetOrigin: string) => {
        this.posted.push({ message, targetOrigin })
        if (message.op === 'run' && this.automatic !== undefined) {
          this.reply(String(message.id), true, this.automatic)
        }
        const matched: typeof this.waiters = []
        const remaining: typeof this.waiters = []
        for (const waiter of this.waiters) {
          const hit = waiter.op === message.op &&
            (waiter.plugin === undefined || waiter.plugin === message.plugin)
          ;(hit ? matched : remaining).push(waiter)
        }
        this.waiters = remaining
        for (const waiter of matched) waiter.resolve(message)
      }) as typeof contentWindow.postMessage,
    )
  }

  /** Auto-reply ok:true with these events to every subsequent run request. */
  autoReply(registeredEvents: string[]): void {
    this.automatic = registeredEvents
  }

  /** Disarm the auto-replyer: subsequent run requests hang until a manual reply. */
  silence(): void {
    this.automatic = undefined
  }

  /** The module-load handshake the real sandbox page posts. */
  ready(): void {
    this.deliver({ source: SANDBOX_TO_HOST, type: 'ready' })
  }

  /** One correlated run reply (or an arbitrary id — the host must ignore unknowns). */
  reply(id: string, ok: boolean, registeredEvents: string[] = []): void {
    this.deliver(ok
      ? { source: SANDBOX_TO_HOST, id, ok: true, registeredEvents }
      : { source: SANDBOX_TO_HOST, id, ok: false, error: 'boom' })
  }

  /** Resolves with the first matching posted message (existing or future). */
  waitForPost(op: string, plugin?: string): Promise<Record<string, unknown>> {
    const existing = this.posted.find(
      call => call.message.op === op && (plugin === undefined || call.message.plugin === plugin),
    )
    if (existing !== undefined) return Promise.resolve(existing.message)
    return new Promise((resolve) => {
      this.waiters.push({ op, plugin, resolve })
    })
  }

  private deliver(data: Record<string, unknown>): void {
    window.dispatchEvent(new MessageEvent('message', { source: this.frame.contentWindow, data }))
  }
}

// ───────────────────────── suite ─────────────────────────

const hosts: UserPluginHost[] = []

beforeEach(() => {
  store.clear()
})

afterEach(() => {
  vi.useRealTimers()
  for (const host of hosts) host.dispose()
  hosts.length = 0
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('UserPluginHost sandbox bridge', () => {
  it('write 热路径：run 请求以 * 为 targetOrigin 发出，回包后解析并完成绑定与持久化', async () => {
    const { listeners, ctx } = fakeCtx()
    const host = new UserPluginHost(ctx)
    hosts.push(host)
    const started = host.start() // 空名单 → 后台预热
    const frame = await waitForIframe()
    const sandbox = new SandboxDouble(frame)
    sandbox.arm()
    sandbox.ready()
    sandbox.autoReply(['user/message'])
    await started

    const result = await host.write({
      name: 'greet-on-prompt',
      title: '问候助手',
      description: '收到问候时回应',
      code: 'return { events: ["user/message"] }',
    })
    expect(result).toEqual({ name: 'greet-on-prompt', registeredEvents: ['user/message'] })

    // 根因回归钉：manifest 沙箱页是 opaque origin，具体 origin 的 targetOrigin
    // 会被静默丢弃（历史「45s 超时但写入已生效」的机制），出站必须用 '*'。
    const runCalls = sandbox.posted.filter(call => call.message.op === 'run')
    expect(runCalls).toHaveLength(1)
    expect(runCalls[0]!.message).toMatchObject({
      source: HOST_TO_SANDBOX,
      op: 'run',
      plugin: 'greet-on-prompt',
      code: 'return { events: ["user/message"] }',
    })
    expect(runCalls[0]!.targetOrigin).toBe('*')

    // 持久化发生在激活之前：记录已入库且启用。
    const medium = store.get(USER_PLUGINS_KEY) as { version: number; items: UserPluginRecord[] }
    expect(medium.items).toHaveLength(1)
    expect(medium.items[0]).toMatchObject({ name: 'greet-on-prompt', enabled: true })

    // 绑定已建立：ctx.events 收到订阅，list 汇报 registeredEvents。
    expect(listeners.get('user/message')).toHaveLength(1)
    const items = await host.list()
    expect(items).toHaveLength(1)
    expect(items[0]!.registeredEvents).toEqual(['user/message'])
  })

  it('回包按请求 id 匹配：boot 挂载与并发 write 的回包乱序各归其位，未知 id 被忽略', async () => {
    const { listeners, ctx } = fakeCtx()
    store.set(USER_PLUGINS_KEY, mediumOf([storedRecord('alpha', 'return { events: [] }')]))
    const host = new UserPluginHost(ctx)
    hosts.push(host)
    const started = host.start()
    const frame = await waitForIframe()
    const sandbox = new SandboxDouble(frame)
    sandbox.arm()
    sandbox.ready()

    const bootRun = await sandbox.waitForPost('run', 'alpha') // boot 挂载已挂起等回包
    const writing = host.write({
      name: 'beta',
      title: '第二只',
      description: '',
      code: 'return { events: [] }',
    })
    const writeRun = await sandbox.waitForPost('run', 'beta') // 两个 run 同时在飞
    expect(bootRun.id).not.toBe(writeRun.id)

    // 未知 id 的回包先到：必须被忽略，不得误配任何 pending。
    sandbox.reply('ghost', true, ['noise'])
    // 乱序回包：后发的请求先回。
    sandbox.reply(String(writeRun.id), true, ['event-b'])
    sandbox.reply(String(bootRun.id), true, ['event-a'])

    await Promise.all([started, writing])
    const items = await host.list()
    expect(items.find(item => item.name === 'alpha')!.registeredEvents).toEqual(['event-a'])
    expect(items.find(item => item.name === 'beta')!.registeredEvents).toEqual(['event-b'])
    expect(listeners.get('noise')).toBeUndefined()
  })

  it('RUN_TIMEOUT 兜底：无回包 45s 拒绝；迟到回包被忽略且后续 run 正常', async () => {
    const { ctx } = fakeCtx()
    const host = new UserPluginHost(ctx)
    hosts.push(host)
    await host.start() // 空名单 + 预热（真实定时器下完成握手）
    const frame = await waitForIframe()
    const sandbox = new SandboxDouble(frame)
    sandbox.arm()
    sandbox.ready()

    vi.useFakeTimers()
    const done = host.write({
      name: 'late-reply',
      title: '迟到回包',
      description: '',
      code: 'return { events: ["user/message"] }',
    })
    // 先挂上拒绝断言再推时钟，避免拒绝在断言前落空成未处理 rejection。
    const timedOut = expect(done).rejects.toThrow('沙箱运行响应超时（45000ms）：late-reply')
    await vi.advanceTimersByTimeAsync(45_000)
    await timedOut

    // 迟到的回包：pending 已清理，回包被忽略，不产生未处理拒绝。
    const staleRun = sandbox.posted.find(call => call.message.op === 'run' && call.message.plugin === 'late-reply')
    expect(staleRun).toBeDefined()
    sandbox.reply(String(staleRun!.message.id), true, ['user/message'])
    expect(sandbox.posted.filter(call => call.message.op === 'run')).toHaveLength(1)

    // 管道恢复：下一个 run 拿到自己的回包，正常解析。
    vi.useRealTimers()
    sandbox.autoReply(['user/message'])
    const again = await host.write({
      name: 'late-reply',
      title: '迟到回包',
      description: '',
      code: 'return { events: ["user/message"] }',
    })
    expect(again.registeredEvents).toEqual(['user/message'])
  })

  it('ready 握手超时可恢复：丢弃死 frame，下一次操作重建 frame 并成功', async () => {
    const { ctx } = fakeCtx()
    const host = new UserPluginHost(ctx)
    hosts.push(host)
    const prewarm = host.start() // 预热的 ensureReady 永远等不到 ready

    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(prewarm).resolves.toBeUndefined() // 预热失败只告警，不阻断 boot
    const first = host.write({ name: 'slow-frame', title: '慢帧', description: '', code: 'return { events: [] }' })
    // 先挂上拒绝断言再推时钟，避免拒绝在断言前落空成未处理 rejection。
    const firstSettled = expect(first).rejects.toThrow('沙箱页面握手超时（10000ms）')
    await vi.advanceTimersByTimeAsync(10_000)
    await firstSettled
    expect(document.querySelectorAll('iframe')).toHaveLength(0) // 死 frame 已移除

    // 第二次操作重建 frame：缓存未污染，重试走新帧。
    const second = host.write({ name: 'slow-frame', title: '慢帧', description: '', code: 'return { events: [] }' })
    await vi.advanceTimersByTimeAsync(0)
    const frame2 = document.querySelector('iframe')
    expect(frame2).toBeTruthy()
    const sandbox = new SandboxDouble(frame2!)
    sandbox.arm()
    sandbox.ready()
    sandbox.autoReply([])
    await expect(second).resolves.toEqual({ name: 'slow-frame', registeredEvents: [] })
  })

  it('emit 转发与 unload 同样以 * 为 targetOrigin 发出；停用解除 ctx 订阅', async () => {
    const { listeners, ctx } = fakeCtx()
    const host = new UserPluginHost(ctx)
    hosts.push(host)
    await host.start()
    const frame = await waitForIframe()
    const sandbox = new SandboxDouble(frame)
    sandbox.arm()
    sandbox.ready()
    sandbox.autoReply(['user/message'])
    await host.write({
      name: 'greet-on-prompt',
      title: '问候助手',
      description: '',
      code: 'return { events: ["user/message"] }',
    })

    const listener = listeners.get('user/message')![0]!
    listener('hello', 42)
    const emitCalls = sandbox.posted.filter(call => call.message.op === 'emit')
    expect(emitCalls).toHaveLength(1)
    expect(emitCalls[0]!.message).toMatchObject({
      source: HOST_TO_SANDBOX,
      op: 'emit',
      plugin: 'greet-on-prompt',
      eventName: 'user/message',
      payload: ['hello', 42],
    })
    expect(emitCalls[0]!.targetOrigin).toBe('*')

    // write 内部（deactivate + activate 前置）已产生 unload；toggle 停用再追加一个。
    const unloadsBeforeToggle = sandbox.posted.filter(call => call.message.op === 'unload').length
    expect(unloadsBeforeToggle).toBeGreaterThanOrEqual(1)
    await host.toggle('greet-on-prompt', false)
    const unloadCalls = sandbox.posted.filter(call => call.message.op === 'unload')
    expect(unloadCalls).toHaveLength(unloadsBeforeToggle + 1)
    expect(unloadCalls[0]!.message).toMatchObject({ source: HOST_TO_SANDBOX, op: 'unload', plugin: 'greet-on-prompt' })
    expect(unloadCalls[0]!.targetOrigin).toBe('*')
    expect(listeners.get('user/message')).toHaveLength(0)
  })
})

describe('UserPluginHost 激活失败落盘（停用+失败标识）', () => {
  it('write 激活失败：错误抛给调用方，记录落盘为停用并携带 lastError，list 不再声称启用', async () => {
    const { listeners, ctx } = fakeCtx()
    const host = new UserPluginHost(ctx)
    hosts.push(host)
    await host.start() // 空名单 + 预热
    const frame = await waitForIframe()
    const sandbox = new SandboxDouble(frame)
    sandbox.arm()
    sandbox.ready()

    const writing = host.write({
      name: 'broken-writer',
      title: '坏插件',
      description: '',
      code: 'return { events: ["user/message"] }',
    })
    const run = await sandbox.waitForPost('run', 'broken-writer')
    sandbox.reply(String(run.id), false)
    // 原始错误 + 状态指引都到达调用方。
    await expect(writing).rejects.toThrow('boom（代码已保存，插件已停用并记录失败原因；修复后重新写入或启用即可）')

    const medium = store.get(USER_PLUGINS_KEY) as { version: number; items: UserPluginRecord[] }
    expect(medium.items[0]).toMatchObject({ name: 'broken-writer', enabled: false, lastError: 'boom' })

    const items = await host.list()
    expect(items[0]).toMatchObject({ name: 'broken-writer', enabled: false, lastError: 'boom' })
    expect(items[0]!.registeredEvents).toBeUndefined()
    expect(listeners.get('user/message')).toBeUndefined()
  })

  it('失败后重写修复：记录整体重建，lastError 清除，正常绑定', async () => {
    const { ctx } = fakeCtx()
    const host = new UserPluginHost(ctx)
    hosts.push(host)
    await host.start()
    const frame = await waitForIframe()
    const sandbox = new SandboxDouble(frame)
    sandbox.arm()
    sandbox.ready()

    const failing = host.write({ name: 'fix-later', title: '待修', description: '', code: 'return { events: [] }' })
    const badRun = await sandbox.waitForPost('run', 'fix-later')
    sandbox.reply(String(badRun.id), false)
    await expect(failing).rejects.toThrow('boom')

    sandbox.autoReply(['user/message'])
    await host.write({ name: 'fix-later', title: '待修', description: '', code: 'return { events: ["user/message"] }' })

    const medium = store.get(USER_PLUGINS_KEY) as { version: number; items: UserPluginRecord[] }
    expect(medium.items).toHaveLength(1)
    expect(medium.items[0]).not.toHaveProperty('lastError')
    expect(medium.items[0]).toMatchObject({ name: 'fix-later', enabled: true })
    const items = await host.list()
    expect(items[0]!.lastError).toBeUndefined()
    expect(items[0]!.registeredEvents).toEqual(['user/message'])
  })

  it('toggle 启用失败：停用+lastError 落盘；停用与再次启用成功均清除标识', async () => {
    const { ctx } = fakeCtx()
    const host = new UserPluginHost(ctx)
    hosts.push(host)
    await host.start()
    const frame = await waitForIframe()
    const sandbox = new SandboxDouble(frame)
    sandbox.arm()
    sandbox.ready()
    sandbox.autoReply(['user/message'])
    await host.write({ name: 'flaky', title: '时好时坏', description: '', code: 'return { events: ["user/message"] }' })

    // 启用路径再次激活失败（同名重挂）：先撤掉自动应答，再对「新的那个 run」回失败。
    sandbox.silence()
    const runsBefore = sandbox.posted.filter(call => call.message.op === 'run').length
    const failing = host.toggle('flaky', true)
    let toggleRun: PostedCall | undefined
    for (let tick = 0; tick < 200 && toggleRun === undefined; tick += 1) {
      toggleRun = sandbox.posted.filter(call => call.message.op === 'run')[runsBefore]
      if (toggleRun === undefined) await new Promise(resolve => setTimeout(resolve, 5))
    }
    sandbox.reply(String(toggleRun!.message.id), false)
    await expect(failing).rejects.toThrow('插件已停用并记录失败原因')
    let medium = store.get(USER_PLUGINS_KEY) as { version: number; items: UserPluginRecord[] }
    expect(medium.items[0]).toMatchObject({ enabled: false, lastError: 'boom' })

    // 用户拨停用开关：标识随重建清除。
    await host.toggle('flaky', false)
    medium = store.get(USER_PLUGINS_KEY) as { version: number; items: UserPluginRecord[] }
    expect(medium.items[0]).toMatchObject({ enabled: false })
    expect(medium.items[0]).not.toHaveProperty('lastError')

    // 修复后的启用：成功激活，无残留标识。
    sandbox.autoReply(['user/message'])
    await host.toggle('flaky', true)
    medium = store.get(USER_PLUGINS_KEY) as { version: number; items: UserPluginRecord[] }
    expect(medium.items[0]).toMatchObject({ enabled: true })
    expect(medium.items[0]).not.toHaveProperty('lastError')
  })

  it('boot 挂载失败：start 落盘停用+lastError，list 如实反映，后续 boot 不再重试', async () => {
    const { ctx } = fakeCtx()
    store.set(USER_PLUGINS_KEY, mediumOf([storedRecord('broken-at-boot', 'return { events: [] }', true)]))
    const host = new UserPluginHost(ctx)
    hosts.push(host)
    const started = host.start()
    const frame = await waitForIframe()
    const sandbox = new SandboxDouble(frame)
    sandbox.arm()
    sandbox.ready()
    const run = await sandbox.waitForPost('run', 'broken-at-boot')
    sandbox.reply(String(run.id), false)
    await started

    const medium = store.get(USER_PLUGINS_KEY) as { version: number; items: UserPluginRecord[] }
    expect(medium.items[0]).toMatchObject({ name: 'broken-at-boot', enabled: false, lastError: 'boom' })
    const items = await host.list()
    expect(items[0]).toMatchObject({ enabled: false, lastError: 'boom' })

    // 记录已停用：下一次 boot 直接跳过（不发 run），不再重复失败。
    const host2 = new UserPluginHost(ctx)
    hosts.push(host2)
    await host2.start()
    const frames = document.querySelectorAll('iframe')
    const sandbox2 = new SandboxDouble(frames[frames.length - 1] as HTMLIFrameElement)
    sandbox2.arm()
    sandbox2.ready()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(sandbox2.posted.filter(call => call.message.op === 'run')).toHaveLength(0)
  })

  it('存储校验：lastError 非字符串的条目被丢弃；合法 lastError 原样透传', async () => {
    const { ctx } = fakeCtx()
    store.set(USER_PLUGINS_KEY, mediumOf([
      // 存储投毒模拟：lastError 类型损坏的条目必须被丢弃，不能毒化整份名册。
      { ...storedRecord('bad-marker', 'return {}', false), lastError: 42 } as unknown as UserPluginRecord,
      { ...storedRecord('marked', 'return {}', false), lastError: '旧错误' },
    ]))
    const host = new UserPluginHost(ctx)
    hosts.push(host)
    await host.start() // 全停用 → 预热路径，无 run

    const items = await host.list()
    expect(items.map(item => item.name)).toEqual(['marked'])
    expect(items[0]!.lastError).toBe('旧错误')
  })
})
