/**
 * `chrome-site-learn`: the `/learn-site` command and the site-knowledge
 * prompt context.
 *
 * The command mechanically learns the current tab's site (same-origin pages
 * discovered by breadth-first crawl through a dedicated learning tab — the
 * user's tab is only the URL source and is restored by id afterwards,
 * best-effort), extracting per-page structure with a fixed in-page
 * expression: forms and their fields, key controls with stable selectors,
 * the heading line, and the same-origin link map. No model call participates
 * in learning. The condensed cheat sheet is persisted as a knowledge record
 * in the user-plugin roster (`site-<host>`; the panel's enable switch owns
 * injection), and while a learned host is the active tab the prompt context
 * injects that cheat sheet — the agent then addresses the site by known
 * selectors instead of paying repeated `page_snapshot` round-trips to
 * rediscover them.
 *
 * The prompt context provider must be synchronous, so an effect-owned poll
 * (default 1.5s) refreshes a plugin-local cache of active-tab hosts and
 * enabled knowledge entries; a completed learn refreshes it too, so the
 * just-learned site injects on the very next turn.
 *
 * @module chrome-site-learn
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TabInfo } from '@deepseek-ai/dsh-browser'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import { userPluginHost, type SiteKnowledge, type UserPluginListItem } from '../chrome/user-plugins.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'chrome-site-learn'

/** Engine services this plugin drives: the command registry, the prompt registry, and the browser seam. */
export const inject = ['commands', 'systemPrompt', 'browser']

/** Deployment-tunable learning budgets; every field optional, resolved and validated by {@link resolveConfig}. */
export interface Config {
  /** Default and maximum page count for one learn (the command argument clamps to this). */
  maxPages?: number
  /** Byte budget for one site's rendered cheat sheet. */
  maxDigestBytes?: number
  /** How long the in-page extraction waits for `document.readyState === 'complete'` after a navigation. */
  navSettleMs?: number
  /** Politeness gap between two page navigations. */
  requestDelayMs?: number
  /** Active-tab poll cadence feeding the prompt-context cache. */
  tabPollMs?: number
}

/** Validated learning budgets (the composition's config with defaults applied and bounds enforced). */
export interface ResolvedConfig {
  readonly maxPages: number
  readonly maxDigestBytes: number
  readonly navSettleMs: number
  readonly requestDelayMs: number
  readonly tabPollMs: number
}

/** Upper bound on one learn's page count (crawl time scales with it). */
const MAX_PAGES_CEILING = 200
/** Mirrors the roster's digest storage cap; a wider composition value is a misconfiguration. */
const MAX_DIGEST_CEILING = 200_000

/**
 * Resolve the composition config: fail loud at load on non-integer or
 * out-of-range values (self-contained validation); defaults match the
 * shipped composition row.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const pick = (value: number | undefined, fallback: number, ceiling: number, floor: number, label: string): number => {
    if (value === undefined) return fallback
    if (!Number.isInteger(value) || value < floor || value > ceiling) {
      throw new Error(`chrome-site-learn 配置 ${label} 必须是 ${String(floor)}–${String(ceiling)} 的整数，收到：${String(value)}`)
    }
    return value
  }
  return {
    maxPages: pick(config.maxPages, 12, MAX_PAGES_CEILING, 1, 'maxPages'),
    maxDigestBytes: pick(config.maxDigestBytes, 12_000, MAX_DIGEST_CEILING, 500, 'maxDigestBytes'),
    navSettleMs: pick(config.navSettleMs, 1_200, 60_000, 0, 'navSettleMs'),
    requestDelayMs: pick(config.requestDelayMs, 350, 10_000, 0, 'requestDelayMs'),
    tabPollMs: pick(config.tabPollMs, 1_500, 60_000, 250, 'tabPollMs'),
  }
}

// ───────────────────────── in-page extraction ─────────────────────────
//
// buildSelector and collectPageKnowledge are serialized into the learned
// page by source (`Function.prototype.toString`), so both must be
// closure-free: every helper and constant they use lives inside their own
// bodies. The jsdom tests exercise the same exported function objects.

/** One interactive control the digest addresses by CSS selector. */
export interface PageControl {
  readonly sel: string
  readonly name: string
}

/** One form with its addressable fields. */
export interface PageForm {
  readonly sel: string
  readonly method: string
  readonly action: string
  readonly fields: readonly PageControl[]
}

/** One extracted page (the in-page expression's return shape). */
export interface PageKnowledge {
  readonly url: string
  readonly path: string
  readonly title: string
  readonly h1: string
  readonly forms: readonly PageForm[]
  readonly inputs: readonly PageControl[]
  readonly buttons: readonly PageControl[]
  readonly links: readonly { href: string; name: string; inNav: boolean }[]
}

/**
 * The best compact CSS selector for one element: `#id`, then stable
 * attribute anchors, then a unique tag+class combo, then a short
 * nth-of-type path. Never throws; falls back to the tag name. Runs inside
 * the learned page (serialized source) and in jsdom tests through the same
 * exported function object.
 */
export function buildSelector(el: Element, doc: Document): string {
  const id = el.getAttribute('id')
  if (id !== null && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id)) return `#${id}`
  const anchor = (attr: string): string | undefined => {
    const value = el.getAttribute(attr)
    return value !== null && value.length > 0 && /^[A-Za-z0-9 _\u4e00-\u9fa5.,:;/@#()-]{1,64}$/.test(value)
      ? `[${attr}="${value}"]`
      : undefined
  }
  const attrSel = anchor('data-testid') ?? anchor('aria-label') ?? anchor('name') ?? anchor('placeholder')
  if (attrSel !== undefined) return attrSel
  const tag = el.tagName.toLowerCase()
  const classes = [...el.classList].slice(0, 2)
  if (classes.length > 0) {
    const candidate = `${tag}.${classes.join('.')}`
    if (candidate.length <= 60 && doc.querySelectorAll(candidate).length === 1) return candidate
  }
  let hop = el
  const parts: string[] = []
  while (hop !== null && hop !== doc.documentElement && parts.length < 4) {
    const parent: Element | null = hop.parentElement
    if (parent === null) break
    const sameTag = [...parent.children].filter(child => child.tagName === hop.tagName)
    const nth = sameTag.length > 1 ? `:nth-of-type(${String(sameTag.indexOf(hop) + 1)})` : ''
    parts.unshift(`${hop.tagName.toLowerCase()}${nth}`)
    hop = parent
  }
  const path = parts.join('>')
  return path.length > 0 && path.length <= 80 ? path : tag
}

/**
 * Extract one page's knowledge from its live DOM. Serialized into the
 * learned page as source and unit-tested directly in jsdom — the same
 * function object on both sides. Attribute-based visibility heuristics only
 * (no layout reads, so jsdom fidelity holds): `hidden`, `aria-hidden`,
 * `type=hidden`, and inline `display:none` are skipped.
 */
export function collectPageKnowledge(
  doc: Document,
  loc: { readonly href: string },
  selector: (el: Element, doc: Document) => string,
): PageKnowledge {
  /** Accessible-ish name for a control: aria-label, label text, text content, value, placeholder; capped. */
  const controlName = (el: Element): string => {
    const aria = el.getAttribute('aria-label')
    if (aria !== null && aria.trim().length > 0) return aria.trim().slice(0, 24)
    if (el instanceof HTMLInputElement || el instanceof HTMLButtonElement) {
      const owned = el.id.length > 0 ? doc.querySelector(`label[for="${el.id}"]`) : null
      if (owned !== null && owned.textContent !== null && owned.textContent.trim().length > 0) {
        return owned.textContent.trim().slice(0, 24)
      }
    }
    const text = el.textContent
    if (text !== null && text.trim().length > 0) return text.trim().replace(/\s+/g, ' ').slice(0, 24)
    const value = el.getAttribute('value')
    if (value !== null && value.length > 0) return value.slice(0, 24)
    const placeholder = el.getAttribute('placeholder')
    if (placeholder !== null && placeholder.length > 0) return placeholder.slice(0, 24)
    return ''
  }
  /** Field label: controlName, then the name attribute (the selector already carries it). */
  const fieldLabel = (el: Element): string => {
    const viaName = controlName(el)
    if (viaName !== '') return viaName
    const nameAttr = el.getAttribute('name')
    return nameAttr !== null ? nameAttr.slice(0, 24) : ''
  }
  const interactive = (el: Element): boolean =>
    !el.hasAttribute('hidden')
    && el.getAttribute('aria-hidden') !== 'true'
    && (el as HTMLElement).style.display !== 'none'

  const title = (doc.title ?? '').trim().slice(0, 80)
  const h1 = doc.querySelector('h1')?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 60) ?? ''

  const forms: PageForm[] = []
  for (const form of [...doc.querySelectorAll('form')].slice(0, 4)) {
    const fields: PageControl[] = []
    for (const field of [...form.querySelectorAll('input, select, textarea')].slice(0, 8)) {
      if (field.getAttribute('type') === 'hidden' || !interactive(field)) continue
      fields.push({ sel: selector(field, doc), name: fieldLabel(field) })
    }
    const rawAction = form.getAttribute('action') ?? ''
    let action = ''
    try {
      action = rawAction === '' ? loc.href : new URL(rawAction, loc.href).pathname
    } catch {
      action = rawAction.slice(0, 60)
    }
    forms.push({
      sel: selector(form, doc),
      method: (form.getAttribute('method') ?? 'get').toLowerCase(),
      action: action.slice(0, 80),
      fields,
    })
  }

  const inputs: PageControl[] = []
  for (const field of [...doc.querySelectorAll('input, textarea, select')].slice(0, 40)) {
    if (inputs.length >= 6) break
    if (field.closest('form') !== null) continue
    if (field.getAttribute('type') === 'hidden' || !interactive(field)) continue
    inputs.push({ sel: selector(field, doc), name: fieldLabel(field) })
  }

  const buttons: PageControl[] = []
  const seenButtons = new Set<string>()
  for (const btn of [...doc.querySelectorAll('button, input[type=submit], input[type=button], [role=button]')].slice(0, 40)) {
    if (buttons.length >= 8) break
    if ((btn instanceof HTMLInputElement || btn instanceof HTMLButtonElement) && btn.disabled) continue
    if (!interactive(btn)) continue
    const sel = selector(btn, doc)
    if (sel === 'button' || seenButtons.has(sel)) continue
    seenButtons.add(sel)
    buttons.push({ sel, name: controlName(btn) })
  }

  const links: { href: string; name: string; inNav: boolean }[] = []
  const seenLinks = new Set<string>()
  for (const anchor of [...doc.querySelectorAll('a[href]')]) {
    if (links.length >= 60) break
    let href: string
    try {
      href = new URL(anchor.getAttribute('href') ?? '', loc.href).href
    } catch {
      continue
    }
    const colon = href.indexOf(':')
    const scheme = colon === -1 ? '' : href.slice(0, colon)
    if (scheme !== 'http' && scheme !== 'https') continue
    const name = (anchor.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 16)
    if (name === '') continue
    const key = `${href}|${name}`
    if (seenLinks.has(key)) continue
    seenLinks.add(key)
    links.push({ href, name, inNav: anchor.closest('nav, header, [role=navigation]') !== null })
  }

  let pathname = loc.href.slice(0, 160)
  try {
    const u = new URL(loc.href)
    pathname = u.pathname + (u.search.length > 40 ? u.search.slice(0, 40) : u.search)
  } catch {
    // Keep the capped href fallback.
  }

  return { url: loc.href.slice(0, 160), path: pathname, title, h1, forms, inputs, buttons, links }
}

/**
 * The full in-page expression for one page: wait for load completion within
 * the settle budget, then collect. Serialized sources only — the same
 * exported function objects the jsdom tests exercise.
 * @param settleMs - load-wait budget before collection proceeds regardless.
 */
export function pageExtractExpression(settleMs: number): string {
  return `(async () => {
  const deadline = Date.now() + ${String(Math.max(0, Math.floor(settleMs)))}
  while (document.readyState !== 'complete' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const selector = ${buildSelector.toString()}
  const collect = ${collectPageKnowledge.toString()}
  return collect(document, location, selector)
})()`
}

// ───────────────────────── URL queue logic ─────────────────────────

/** Extensions that never yield a learnable document page. */
const SKIP_EXTENSIONS = new RegExp(
  '\\.(pdf|zip|gz|tgz|tar|rar|7z|png|jpe?g|gif|svg|webp|avif|ico|mp4|webm|mov|mp3|wav|ogg|css|mjs|js|map|woff2?|ttf|eot|dmg|exe|apk)$',
  'i',
)

/**
 * Normalize one candidate URL for the crawl: http(s) only, hash stripped,
 * host lowercased, default port dropped, trailing directory slash collapsed
 * (except the root), obvious non-document extensions skipped. Returns the
 * canonical href or undefined for a non-candidate.
 */
export function normalizeLearnUrl(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.username !== '' || url.password !== '') return undefined
  if (SKIP_EXTENSIONS.test(url.pathname)) return undefined
  url.hash = ''
  const defaultPort = (url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')
  if (defaultPort) url.port = ''
  if (url.pathname !== '/' && url.search === '' && url.href.endsWith('/')) return url.href.slice(0, -1)
  return url.href
}

/** Whether a candidate URL belongs to the crawl's origin. */
export function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}

// ───────────────────────── digest building ─────────────────────────

/** Render one page's compact cheat-sheet block. */
function renderPageBlock(page: PageKnowledge): string {
  const lines: string[] = [`· ${page.path}${page.title !== '' ? ` — ${page.title}` : ''}${page.h1 !== '' && page.h1 !== page.title ? `（${page.h1}）` : ''}`]
  for (const form of page.forms) {
    const fields = form.fields.map(field => `${field.sel}${field.name !== '' ? `(${field.name})` : ''}`).join(' ')
    const head = `  表单 ${form.sel}(${form.method} ${form.action})`
    lines.push(fields !== '' ? `${head}: ${fields}` : head)
  }
  if (page.inputs.length > 0) {
    lines.push(`  输入 ${page.inputs.map(input => `${input.sel}${input.name !== '' ? `(${input.name})` : ''}`).join(' ')}`)
  }
  if (page.buttons.length > 0) {
    lines.push(`  按钮 ${page.buttons.map(button => `${button.sel}${button.name !== '' ? `「${button.name}」` : ''}`).join(' ')}`)
  }
  const navLinks = page.links.filter(link => link.inNav)
  const rest = page.links.filter(link => !link.inNav)
  const shown = [...navLinks, ...rest].slice(0, 8).map((link) => {
    let path: string
    try {
      const u = new URL(link.href)
      path = u.pathname + (u.search.length > 20 ? '' : u.search)
    } catch {
      path = link.href.slice(0, 40)
    }
    return `${path}「${link.name}」`
  })
  if (shown.length > 0) lines.push(`  链接 ${shown.join(' ')}`)
  return lines.join('\n')
}

/** Format an epoch ms as YYYY-MM-DD (local). */
function formatDate(epochMs: number): string {
  const d = new Date(epochMs)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/**
 * Build one site's cheat sheet: a usage header, then per-page blocks in
 * crawl order (the entry page first). Pages are dropped from the tail when
 * the byte budget is exceeded, with a truncation marker.
 * @param host - learned hostname for the header.
 * @param pages - extracted pages in crawl order.
 * @param learnedAt - learning completion epoch ms.
 * @param maxBytes - rendered-digest byte budget.
 */
export function buildSiteDigest(host: string, pages: readonly PageKnowledge[], learnedAt: number, maxBytes: number): string {
  const header = [
    `【站点速查 ${host}】${String(pages.length)} 页 · 学习于 ${formatDate(learnedAt)} · /learn-site 生成`,
    '操作本站优先直接使用下列路径与选择器（page_navigate 的 url、page_click/page_type 的 selector）；结构漂移或未收录路径再用 page_snapshot 探索验证。',
  ].join('\n')
  const blocks: string[] = []
  let used = header.length
  let truncated = false
  for (const page of pages) {
    const block = renderPageBlock(page)
    if (used + block.length + 1 > maxBytes) {
      truncated = true
      break
    }
    used += block.length + 1
    blocks.push(block)
  }
  const tail = truncated ? `\n（超出 ${String(maxBytes)} 字节预算，已截断至 ${String(blocks.length)}/${String(pages.length)} 页）` : ''
  return `${header}\n${blocks.join('\n')}${tail}`
}

// ───────────────────────── crawl orchestration ─────────────────────────

/** The browser-seam subset the crawler drives (structurally satisfied by `ctx.browser`; faked in tests). */
export interface LearnTabAccess {
  tabs(): Promise<readonly TabInfo[]>
  openTab(url: string, opts?: { active?: boolean }): Promise<TabInfo>
  closeTab(tabId: number): Promise<void>
  switchTab(tabId: number): Promise<void>
  navigate(tabId: number, url: string): Promise<void>
  evaluate<T>(tabId: number, expression: string): Promise<T>
}

/** One settled learn's outcome, fed to the roster write and the command result. */
export interface LearnOutcome {
  readonly host: string
  readonly origin: string
  readonly entryUrl: string
  readonly pageCount: number
  readonly skipped: number
  readonly digest: string
}

/** Sleep helper (crawl politeness). */
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Learn one site: breadth-first crawl of same-origin pages starting from
 * `entryTabUrl`, in a dedicated tab opened beside the panel (the user's tab
 * is only the URL source; `restoreTabId` is re-activated afterwards,
 * best-effort). Per-page failures (navigation, unloadable page) count as
 * skips; the learning tab is always closed.
 * @param browser - browser seam (or test double).
 * @param entryTabUrl - the active tab's URL at command time.
 * @param restoreTabId - the user's tab to re-activate after the crawl (−1 to skip).
 * @param budgets - resolved learn budgets.
 * @returns the built outcome (digest rendered, host normalized).
 */
export async function learnSite(
  browser: LearnTabAccess,
  entryTabUrl: string,
  restoreTabId: number,
  budgets: Pick<ResolvedConfig, 'maxPages' | 'maxDigestBytes' | 'navSettleMs' | 'requestDelayMs'>,
): Promise<LearnOutcome> {
  const entry = normalizeLearnUrl(entryTabUrl)
  if (entry === undefined) {
    throw new Error(`当前标签页不是可学习的 http(s) 文档页面：${entryTabUrl.slice(0, 120)}`)
  }
  const entryUrl = new URL(entry)
  const origin = entryUrl.origin
  const host = entryUrl.hostname.toLowerCase()

  let learnTabId = -1
  const pages: PageKnowledge[] = []
  const queue: string[] = [entry]
  const seen = new Set([entry])
  let skipped = 0

  try {
    const opened = await browser.openTab(entry, { active: false })
    learnTabId = opened.tabId
    const expression = pageExtractExpression(budgets.navSettleMs)

    while (queue.length > 0 && pages.length < budgets.maxPages) {
      const url = queue.shift()
      if (url === undefined) break
      try {
        if (url !== entry) await browser.navigate(learnTabId, url)
        const page = await browser.evaluate<PageKnowledge | null>(learnTabId, expression)
        if (page === null || typeof page !== 'object' || typeof page.url !== 'string') {
          skipped += 1
        } else {
          pages.push(page)
          for (const link of page.links) {
            const next = normalizeLearnUrl(link.href)
            if (next === undefined || seen.has(next) || !sameOrigin(next, origin)) continue
            seen.add(next)
            queue.push(next)
          }
        }
      } catch {
        skipped += 1
      }
      if (budgets.requestDelayMs > 0 && queue.length > 0) await sleep(budgets.requestDelayMs)
    }
  } finally {
    if (learnTabId !== -1) {
      try {
        await browser.closeTab(learnTabId)
      } catch {
        // The learning tab is best-effort teardown; a close race must not
        // fail an otherwise complete learn.
      }
    }
    if (restoreTabId !== -1) {
      try {
        await browser.switchTab(restoreTabId)
      } catch {
        // The tab may have been closed by the user mid-learn; nothing to
        // restore onto.
      }
    }
  }

  const digest = buildSiteDigest(host, pages, Date.now(), budgets.maxDigestBytes)
  return { host, origin, entryUrl: entry, pageCount: pages.length, skipped, digest }
}

// ───────────────────────── prompt-context cache + rendering ─────────────────────────

/** Prompt-time cache: active-tab hosts and the enabled knowledge entries (refreshed by the poll). */
export interface KnowledgeCache {
  readonly hosts: readonly string[]
  readonly entries: readonly SiteKnowledge[]
}

const EMPTY_CACHE: KnowledgeCache = { hosts: [], entries: [] }

/** Whether an active tab host matches a learned host (equality or subdomain on either side). */
export function hostMatches(activeHost: string, learnedHost: string): boolean {
  const a = activeHost.toLowerCase()
  const k = learnedHost.toLowerCase()
  return a === k || a.endsWith(`.${k}`) || k.endsWith(`.${a}`)
}

/**
 * Render the injected prompt text: the matched sites' digests, newest learn
 * first, capped to `maxBytes` with a truncation marker; empty when no
 * learned host is active (the common case — zero cost for other sites).
 */
export function renderSiteKnowledgeText(cache: KnowledgeCache, maxBytes: number): string {
  const matched = cache.entries.filter(entry => cache.hosts.some(host => hostMatches(host, entry.host)))
  if (matched.length === 0) return ''
  const ordered = [...matched].sort((left, right) => right.learnedAt - left.learnedAt).slice(0, 2)
  const parts: string[] = []
  let used = 0
  let truncated = false
  for (const entry of ordered) {
    if (used + entry.digest.length + 2 > maxBytes) {
      truncated = true
      break
    }
    used += entry.digest.length + 2
    parts.push(entry.digest)
  }
  if (parts.length === 0) return ''
  return parts.join('\n\n') + (truncated ? '\n（注入超出预算，已截断）' : '')
}

/**
 * Read the prompt cache once: every window's active http(s) tab hosts plus
 * the enabled knowledge records. Storage or SW failures propagate to the
 * caller — the poll keeps the last snapshot, and prompt assembly never
 * awaits this path.
 */
export async function refreshKnowledgeCache(browser: LearnTabAccess): Promise<KnowledgeCache> {
  const tabs = await browser.tabs()
  const hosts = [...new Set(tabs
    .filter(tab => tab.active && /^https?:/i.test(tab.url))
    .map(tab => safeHostOf(tab.url))
    .filter((hostName): hostName is string => hostName !== undefined))]
  const host = userPluginHost()
  const items = host === undefined ? [] : await host.list()
  const entries = items
    .filter((item): item is UserPluginListItem & { knowledge: SiteKnowledge } =>
      item.enabled && item.knowledge !== undefined)
    .map(item => item.knowledge)
  return { hosts, entries }
}

/** Hostname of a URL string, or undefined when unparseable. */
function safeHostOf(raw: string): string | undefined {
  try {
    return new URL(raw).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

// ───────────────────────── plugin ─────────────────────────

/** Register `/learn-site` and the site-knowledge prompt context. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)

  const cache: { current: KnowledgeCache } = { current: EMPTY_CACHE }
  const refresh = async (): Promise<void> => {
    try {
      cache.current = await refreshKnowledgeCache(ctx.browser.provider)
    } catch {
      // Dead SW or storage outage between polls: keep serving the last
      // snapshot — prompt assembly must not depend on live polling.
    }
  }

  // The poll is effect-owned: engine teardown stops it with the fiber.
  ctx.effect(() => {
    const timer = setInterval(() => { void refresh() }, resolved.tabPollMs)
    void refresh()
    return () => { clearInterval(timer) }
  }, 'site-learn active-tab poll')

  ctx.systemPrompt.context({
    name: 'chrome:site-knowledge',
    order: ctx.systemPrompt.getContextOrder('SITE_KNOWLEDGE'),
    text: () => renderSiteKnowledgeText(cache.current, resolved.maxDigestBytes),
  })

  ctx.commands.register({
    definitionId: CommandDefinitionId('chrome-site-learn'),
    name: 'learn-site',
    description: '学习当前标签页的站点（同源子页面），生成可启停的站点知识插件',
    input: { hint: `[<最大页数 1-${String(resolved.maxPages)}>]` },
    handler: async (invocation) => {
      const argRaw = invocation.rawInput.trim()
      let maxPages = resolved.maxPages
      if (argRaw !== '') {
        const parsed = Number(argRaw)
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > resolved.maxPages) {
          return { kind: 'error', text: `参数必须是 1–${String(resolved.maxPages)} 的整数（页数上限由配置决定）` }
        }
        maxPages = parsed
      }

      const rosterHost = userPluginHost()
      if (rosterHost === undefined) {
        return { kind: 'error', text: '用户插件宿主未初始化，无法保存站点知识' }
      }

      const tabs = await ctx.browser.provider.tabs()
      const learnable = tabs.filter(tab => tab.active && /^https?:/i.test(tab.url))
      if (learnable.length === 0) {
        return { kind: 'error', text: '没有可学习的活动标签页（仅支持 http/https 页面）' }
      }
      // Every window has an active tab; the last one in the tabs listing is
      // the most recently touched window's — the practical "current" tab.
      const entryTab = learnable.at(-1)
      if (entryTab === undefined) {
        return { kind: 'error', text: '没有可学习的活动标签页（仅支持 http/https 页面）' }
      }

      let outcome: LearnOutcome
      try {
        outcome = await learnSite(ctx.browser.provider, entryTab.url, entryTab.tabId, { ...resolved, maxPages })
      } catch (err) {
        return { kind: 'error', text: err instanceof Error ? err.message : String(err) }
      }
      if (outcome.pageCount === 0) {
        return { kind: 'error', text: `学习 ${outcome.host} 失败：一个页面也没有提取到（全部 ${String(outcome.skipped)} 页被跳过）` }
      }

      const learnedAt = Date.now()
      const { name } = await rosterHost.writeKnowledge({
        title: `站点知识：${outcome.host}`,
        description: `${String(outcome.pageCount)} 页速查表（学习于 ${formatDate(learnedAt)}）。启用时 agent 在该站点操作会自动注入速查，直接用已知选择器与路径。/learn-site 生成，重新学习会整体替换。`,
        knowledge: {
          origin: outcome.origin,
          host: outcome.host,
          learnedAt,
          pageCount: outcome.pageCount,
          digest: outcome.digest,
        },
      })
      await refresh()
      return {
        kind: 'success',
        text: `已学习 ${outcome.host}：提取 ${String(outcome.pageCount)} 页（跳过 ${String(outcome.skipped)}），速查表 ${String(outcome.digest.length)} 字节，已写入用户插件 ${name}（「用户插件」面板可启停）。当前标签页回到该站点后，agent 将自动获得速查。`,
      }
    },
  })
}
