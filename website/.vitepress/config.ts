/** VitePress configuration for the locally projected documentation site. */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { DefaultTheme, HeadConfig, PageData, SiteConfig, UserConfig } from 'vitepress'
import type { ViteDevServer } from 'vite'
import { withMermaid } from 'vitepress-plugin-mermaid'
import { codeGroupFallbackHead, isolateCodeGroupRadios } from './code-groups.ts'
import { landingLink, localeCollections, orderedPages, routeLink, sectionSpec, type DocsLocale, type DocsPage, type DocsSidebar } from '../docs.ts'
import { docsSourceFiles, emitRawMarkdownPages, llmsTxt, projectDocs } from '../../scripts/project-doc-site.ts'
import { rawMarkdownMiddleware } from '../raw-markdown.ts'

projectDocs()

function sidebar(locale: DocsLocale, collection: NonNullable<DocsPage['sidebar']>): DefaultTheme.SidebarItem[] {
  // `orderedPages` already sorts by section placement, so insertion order
  // carries the group order and each group keeps its pages in sequence.
  const groups = new Map<string, DocsPage[]>()
  for (const page of orderedPages(locale, collection)) {
    const entries = groups.get(page.section) ?? []
    entries.push(page)
    groups.set(page.section, entries)
  }
  return [...groups.entries()].map(([text, entries]) => {
    const { collapsed } = sectionSpec(locale, text)
    return {
      text,
      // A present `collapsed` is what makes the default theme render the
      // group as collapsible at all, so an open group must omit the key.
      ...(collapsed === undefined ? {} : { collapsed }),
      items: entries.map(page => ({ text: page.label, link: routeLink(page.route) })),
    }
  })
}

/** One module link shared between the navigation bar and the guide sidebar. */
interface GuideModuleLink {
  /** Label shown in the navigation bar and the guide sidebar. */
  label: string
  /** Sidebar collection the link opens. */
  collection: DocsSidebar
}

/**
 * Per-locale guide-module facts: the guide collection and the module links
 * appended to the guide sidebar.
 */
interface GuideModules {
  /** Guide sidebar collection for the locale. */
  guide: 'zh-guide' | 'en-guide'
  /** Reference module link. */
  reference: GuideModuleLink
}

/**
 * Guide-module facts keyed by locale, giving every module label and collection
 * one home shared by the navigation bar and the guide sidebar.
 */
const guideModules = {
  root: {
    guide: localeCollections.root[0],
    reference: { label: '参考', collection: localeCollections.root[1] },
  },
  en: {
    guide: localeCollections.en[0],
    reference: { label: 'Reference', collection: localeCollections.en[1] },
  },
} satisfies Record<DocsLocale, GuideModules>

/**
 * Guide sidebar with a direct link into the reference module.
 *
 * @param locale - Route tree whose guide sidebar is being built.
 * @returns Guide groups followed by a top-level link to the reference module.
 */
function guideSidebar(locale: DocsLocale): DefaultTheme.SidebarItem[] {
  const { guide, reference } = guideModules[locale]
  return [
    ...sidebar(locale, guide),
    {
      text: reference.label,
      link: landingLink(locale, reference.collection),
    },
  ]
}

/**
 * Navigation-bar items for the modules the guide sidebar links into, reading
 * their labels and collections from the shared per-locale record.
 *
 * @param locale - Route tree the navigation items belong to.
 * @returns The module items for the locale's navigation bar.
 */
function moduleNav(locale: DocsLocale): DefaultTheme.NavItem[] {
  const { reference } = guideModules[locale]
  const routePrefix = locale === 'root' ? '' : '/en'
  return [
    { text: reference.label, link: landingLink(locale, reference.collection), activeMatch: `^${routePrefix}/reference/` },
  ]
}

function watchCanonicalDocs(server: ViteDevServer): void {
  const sources = docsSourceFiles()
  server.watcher.add(sources)
  server.watcher.on('change', (changed) => {
    if (!sources.includes(changed)) return
    projectDocs()
  })
}

/**
 * Serve the raw-Markdown twin of each route and llms.txt during development,
 * matching what `buildEnd` emits into the static build. Pages project from
 * their canonical sources per request, so an edit shows without a rebuild.
 */
function serveRawMarkdown(server: ViteDevServer): void {
  server.middlewares.use(rawMarkdownMiddleware(base, () => llmsTxt({ base, ...siteIdentity })))
}

function escapeVueInterpolation(html: string): string {
  return html.replaceAll('{{', '&#123;&#123;').replaceAll('}}', '&#125;&#125;')
}

const sharedTheme: Pick<DefaultTheme.Config, 'search' | 'socialLinks' | 'editLink'> = {
  search: {
    provider: 'local',
    options: {
      locales: {
        root: {
          translations: {
            button: {
              buttonText: '搜索文档',
              buttonAriaLabel: '搜索文档',
            },
            modal: {
              displayDetails: '显示详细列表',
              resetButtonTitle: '清除搜索',
              backButtonTitle: '关闭搜索',
              noResultsText: '未找到相关结果',
              footer: {
                selectText: '选择',
                selectKeyAriaLabel: '回车键',
                navigateText: '切换',
                navigateUpKeyAriaLabel: '上方向键',
                navigateDownKeyAriaLabel: '下方向键',
                closeText: '关闭',
                closeKeyAriaLabel: 'Esc 键',
              },
            },
          },
        },
      },
    },
  },
  socialLinks: [
    { icon: 'github', link: 'https://github.com/clear2x/openbrowserharness' },
  ],
  editLink: {
    pattern: ({ frontmatter }: PageData) => {
      const data: unknown = frontmatter
      const editSource: unknown = typeof data === 'object' && data !== null ? Reflect.get(data, 'editSource') : undefined
      if (typeof editSource !== 'string') throw new Error('Projected documentation page has no editSource frontmatter.')
      return `https://github.com/clear2x/openbrowserharness/edit/main/${editSource}`
    },
    text: '在 GitHub 上编辑此页',
  },
}

/** Site base path, carrying the leading and trailing slashes VitePress requires. */
const base = process.env.DOCS_BASE ?? '/'

/** Site identity shared by the VitePress configuration and the llms.txt index. */
const siteIdentity = {
  title: 'OpenBrowserHarness',
  description: '跑在浏览器里的 AI 智能体扩展——在你批准下拟人化地驱动真实网页',
}

/** Origin the deployed site answers on; canonical, social, and sitemap URLs must be absolute. */
const siteOrigin = 'https://openbrowserharness.opmio.app'

/**
 * Facts that differ between the two locales' social cards: the Open Graph
 * locale tags and the share image published from `public/`.
 */
interface SocialCard {
  /** Open Graph locale of the route tree, in `language_TERRITORY` form. */
  locale: string
  /** Open Graph locale of the other route tree. */
  alternateLocale: string
  /** Share image file name inside `public/`. */
  image: string
  /** Alt text describing that image for social clients. */
  imageAlt: string
}

/** Social-card facts keyed by locale. */
const socialCards = {
  root: {
    locale: 'zh_CN',
    alternateLocale: 'en_US',
    image: 'og-zh.png',
    imageAlt: 'OpenBrowserHarness —— 住在你浏览器里的智能体',
  },
  en: {
    locale: 'en_US',
    alternateLocale: 'zh_CN',
    image: 'og-en.png',
    imageAlt: 'OpenBrowserHarness — the agent that lives in your browser',
  },
} satisfies Record<DocsLocale, SocialCard>

/** Source path of each locale's home route, the only pages that publish application structured data. */
const homeRoutes: Record<DocsLocale, string> = { root: 'index.md', en: 'en/index.md' }

/** Chrome Web Store listing of the extension. */
const chromeStoreUrl = 'https://chromewebstore.google.com/detail/bleodidoeedilojmbklkcbelamehbimj'

/** Latest published Release, the always-current build the nav points at. */
const releaseLatestUrl = 'https://github.com/clear2x/openbrowserharness/releases/latest'

/** Edge Add-ons listing of the extension. */
const edgeStoreUrl = 'https://microsoftedge.microsoft.com/addons/detail/hfhgnobjheiffkedldooeehanpamocni'

/**
 * Locale whose route tree owns a page.
 *
 * @param relativePath - Page path relative to the VitePress source root.
 * @returns Locale key of the page's route tree.
 */
function pageLocale(relativePath: string): DocsLocale {
  return relativePath.startsWith('en/') ? 'en' : 'root'
}

/**
 * Route path of a page, in the form a browser requests it.
 *
 * @param relativePath - Page path relative to the VitePress source root.
 * @returns Leading-slash route, carrying a trailing slash on directory index routes.
 */
function routePath(relativePath: string): string {
  return `/${relativePath.replace(/\.md$/, '')}`.replace(/index$/, '')
}

/**
 * Absolute URL of a site path. Search and social clients resolve nothing
 * relatively, so every published URL is built here.
 *
 * @param path - Leading-slash site path such as `/en/guide/quickstart` or `/og-en.png`.
 * @returns Absolute https URL under the configured base.
 */
function absoluteUrl(path: string): string {
  return `${siteOrigin}${base}${path.replace(/^\//, '')}`
}

/**
 * `SoftwareApplication` structured data describing the extension itself.
 *
 * @param url - Absolute URL of the home route publishing the document.
 * @returns Script tag carrying the JSON-LD document.
 */
function softwareApplicationHead(url: string): HeadConfig {
  const application = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: siteIdentity.title,
    applicationCategory: 'BrowserApplication',
    operatingSystem: 'Chrome, Edge',
    url,
    license: 'https://opensource.org/license/mit',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    sameAs: [chromeStoreUrl, edgeStoreUrl],
  }
  return ['script', { type: 'application/ld+json' }, JSON.stringify(application)]
}

/**
 * Open Graph, Twitter-card, and canonical tags for one route. The page's own
 * title and description win; a page without them inherits its locale's site
 * identity.
 *
 * @param pageData - Page whose HTML is being written.
 * @param siteDescription - Resolved description of the page's locale.
 * @returns Head tags merged after the static site head.
 */
function socialHead(pageData: PageData, siteDescription: string): HeadConfig[] {
  // The generated 404 page has no route of its own to canonicalize.
  if (pageData.isNotFound === true) return []
  const locale = pageLocale(pageData.relativePath)
  const card = socialCards[locale]
  const url = absoluteUrl(routePath(pageData.relativePath))
  const image = absoluteUrl(`/${card.image}`)
  const title = pageData.title || siteIdentity.title
  const description = pageData.description || siteDescription
  const tags: HeadConfig[] = [
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: siteIdentity.title }],
    ['meta', { property: 'og:title', content: title }],
    ['meta', { property: 'og:description', content: description }],
    ['meta', { property: 'og:url', content: url }],
    ['meta', { property: 'og:image', content: image }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    ['meta', { property: 'og:image:alt', content: card.imageAlt }],
    ['meta', { property: 'og:locale', content: card.locale }],
    ['meta', { property: 'og:locale:alternate', content: card.alternateLocale }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: title }],
    ['meta', { name: 'twitter:description', content: description }],
    ['meta', { name: 'twitter:image', content: image }],
    ['link', { rel: 'canonical', href: url }],
  ]
  if (homeRoutes[locale] === pageData.relativePath) tags.push(softwareApplicationHead(url))
  return tags
}

/**
 * The site wordmark, inlined so its `currentColor` fills follow the active
 * theme. An `<img>` would freeze the mark at the colors the file declares.
 */
const wordmark = readFileSync(resolve(import.meta.dirname, '../public/wordmark.svg'), 'utf8')
  .trim()
  .replace('<svg ', '<svg class="dsh-wordmark" ')

/**
 * Head-injected styles for the site identity and sidebar scrollbar.
 *
 * The navigation-bar lockup pairs with `siteTitle`. The scrollbar rules replace
 * the sidebar's platform bar, which reserves 15px of a 265px column and draws a
 * track the rest of the navigation has no border for; `scrollbarScript` supplies
 * the marker that reveals the thumb. Chrome drops `::-webkit-scrollbar` once
 * `scrollbar-width` is set to anything but `auto`, so the standard properties
 * stay behind a query only Firefox answers.
 */
const siteStyle = `
.dsh-lockup { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-wordmark { display: block; height: 22px; width: auto; color: var(--vp-c-text-1); }
.dsh-tag {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--vp-c-brand-soft);
  border-radius: 999px;
  padding: 1px 9px;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  white-space: nowrap;
  color: var(--vp-c-brand-1);
}

.VPSidebar::-webkit-scrollbar { width: 6px; }
.VPSidebar::-webkit-scrollbar-track { background: transparent; }
.VPSidebar::-webkit-scrollbar-thumb {
  background-color: transparent;
  border-radius: 3px;
  transition: background-color 0.3s;
}
.VPSidebar[data-scrolling]::-webkit-scrollbar-thumb { background-color: var(--vp-c-text-3); }
@supports not selector(::-webkit-scrollbar) {
  .VPSidebar { scrollbar-width: thin; scrollbar-color: transparent transparent; }
  .VPSidebar[data-scrolling] { scrollbar-color: var(--vp-c-text-3) transparent; }
}
`

/**
 * Mark the sidebar while it scrolls, so its scrollbar rests invisible.
 *
 * A sized `::-webkit-scrollbar` opts the element out of the platform's
 * self-hiding overlay bar, leaving one painted at all times; nothing in CSS
 * reports that an element is scrolling. The listener captures instead of
 * bubbling because scroll events do not bubble, and marks a `data-` attribute
 * rather than a class because Vue rewrites `class` wholesale when it patches
 * the element.
 */
const scrollbarScript = `
(() => {
  let idle
  addEventListener('scroll', (event) => {
    const target = event.target
    if (!(target instanceof Element) || !target.classList.contains('VPSidebar')) return
    target.dataset.scrolling = ''
    clearTimeout(idle)
    idle = setTimeout(() => delete target.dataset.scrolling, 800)
  }, true)
})()
`

/**
 * Marks the document before first paint. The landing's entrance and
 * scroll-reveal styles apply only under this class, so the server-rendered
 * page stays complete when scripts do not run.
 */
const landingScript = "document.documentElement.classList.add('dsh-landing-js')"

/**
 * Navigation-bar title: the site wordmark and the release-stage tag.
 * VitePress renders `siteTitle` as HTML.
 *
 * @param previewTag - Localized release-stage label.
 * @returns Markup placed beside the navigation-bar home link.
 */
function siteTitle(previewTag: string): string {
  return `<span class="dsh-lockup">${wordmark}<span class="dsh-tag">${previewTag}</span></span>`
}

const siteConfig = withMermaid({
  title: siteIdentity.title,
  description: siteIdentity.description,
  base,
  // Per-route head: the code-group fallback first, so an MPA build still exposes
  // every command block, followed by the route's social and canonical tags.
  transformHead: ({ pageData, siteConfig, siteData }) => [
    ...codeGroupFallbackHead(siteConfig.mpa),
    ...socialHead(pageData, siteData.description),
  ],
  // VitePress's sitemap writer joins `hostname` with source paths and ignores
  // `base`, so this stays correct only while the site deploys at the origin root.
  sitemap: { hostname: siteOrigin },
  /** Emit the raw-Markdown twin of every route plus llms.txt beside the rendered site. */
  buildEnd(siteConfig: SiteConfig) {
    emitRawMarkdownPages(siteConfig.outDir)
    writeFileSync(resolve(siteConfig.outDir, 'llms.txt'), llmsTxt({ base, ...siteIdentity }))
  },
  head: [
    // VitePress leaves head hrefs untouched, so the base belongs here explicitly.
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }],
    // Safari skips SVG favicons; the ICO and the touch icon cover those surfaces.
    ['link', { rel: 'alternate icon', href: `${base}favicon.ico` }],
    ['link', { rel: 'apple-touch-icon', href: `${base}apple-touch-icon.png` }],
    ['style', {}, siteStyle],
    ['script', {}, scrollbarScript],
    ['script', {}, landingScript],
  ],
  cleanUrls: true,
  srcDir: '.generated',
  cacheDir: '.cache',
  outDir: '.dist',
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      themeConfig: {
        siteTitle: siteTitle('技术预览'),
        nav: [
          { text: '入门', link: landingLink('root', guideModules.root.guide), activeMatch: '^/guide/' },
          ...moduleNav('root'),
          { text: '下载', link: releaseLatestUrl, target: '_blank', rel: 'noreferrer', noIcon: true },
        ],
        sidebar: {
          '/guide/': guideSidebar('root'),
          '/reference/': sidebar('root', 'zh-reference'),
        },
        outline: { label: '本页目录' },
        docFooter: { prev: '上一篇', next: '下一篇' },
        darkModeSwitchLabel: '外观',
        lightModeSwitchTitle: '切换到浅色主题',
        darkModeSwitchTitle: '切换到深色主题',
        sidebarMenuLabel: '菜单',
        returnToTopLabel: '返回顶部',
        langMenuLabel: '切换语言',
        skipToContentLabel: '跳至内容',
        footer: {
          // A space-separated run: the stylesheet lays the links out as wrapping flex items.
          copyright: `© 2026 OpenBrowserHarness <a href="https://github.com/clear2x/openbrowserharness">GitHub</a> <a href="${base}reference/privacy">隐私政策</a>`,
        },
      },
    },
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      // English routes otherwise inherit the Chinese description in `meta name="description"`.
      description: 'An AI agent extension in your browser — it drives real web pages in a human-like way, under your approval.',
      themeConfig: {
        siteTitle: siteTitle('Preview'),
        nav: [
          { text: 'Guide', link: landingLink('en', guideModules.en.guide), activeMatch: '^/en/guide/' },
          ...moduleNav('en'),
          { text: 'Download', link: releaseLatestUrl, target: '_blank', rel: 'noreferrer', noIcon: true },
        ],
        sidebar: {
          '/en/guide/': guideSidebar('en'),
          '/en/reference/': sidebar('en', 'en-reference'),
        },
        editLink: {
          pattern: ({ frontmatter }: PageData) => {
            const data: unknown = frontmatter
            const editSource: unknown = typeof data === 'object' && data !== null ? Reflect.get(data, 'editSource') : undefined
            if (typeof editSource !== 'string') throw new Error('Projected documentation page has no editSource frontmatter.')
            return `https://github.com/clear2x/openbrowserharness/edit/main/${editSource}`
          },
          text: 'Edit this page on GitHub',
        },
        outline: { label: 'On this page' },
        docFooter: { prev: 'Previous', next: 'Next' },
        footer: {
          copyright: `© 2026 OpenBrowserHarness <a href="https://github.com/clear2x/openbrowserharness">GitHub</a> <a href="${base}en/reference/privacy">Privacy policy</a>`,
        },
      },
    },
  },
  vite: {
    // `srcDir` puts the Vite root inside the disposable generated tree, whose
    // own `public/` no tracked asset can live in.
    publicDir: resolve(import.meta.dirname, '../public'),
    plugins: [
      {
        name: 'deepseek-harness-doc-projector',
        configureServer(server) {
          watchCanonicalDocs(server)
          serveRawMarkdown(server)
        },
      },
    ],
  },
  markdown: {
    config(md) {
      isolateCodeGroupRadios(md)
      const renderText = md.renderer.rules.text
      const renderCode = md.renderer.rules.code_inline
      const renderFence = md.renderer.rules.fence
      if (renderText === undefined) throw new Error('VitePress Markdown renderer is missing the text rendering rule.')
      if (renderCode === undefined) throw new Error('VitePress Markdown renderer is missing the inline-code rendering rule.')
      if (renderFence === undefined) throw new Error('VitePress Markdown renderer is missing the fence rendering rule.')
      md.renderer.rules.text = (...args) => escapeVueInterpolation(renderText(...args))
      md.renderer.rules.code_inline = (...args) => escapeVueInterpolation(renderCode(...args))
      const renderedFences = new Map<string, string>()
      md.renderer.rules.fence = (...args) => {
        const [tokens, index] = args
        const token = tokens[index]
        if (token === undefined) throw new Error('VitePress code-fence renderer received no token.')
        // Mermaid output embeds the token position, and VitePress snippets resolve source files during rendering.
        if (['mermaid', 'mmd'].includes(token.info.trim().split(/\s+/, 1)[0] ?? '')) return renderFence(...args)
        if (Reflect.get(token, 'src') !== undefined) return renderFence(...args)
        // Keep the cache build-local; a dev renderer can survive many HMR updates.
        if (process.env.NODE_ENV !== 'production') return renderFence(...args)
        const key = JSON.stringify([token.content, token.info, token.markup, token.attrs])
        const cached = renderedFences.get(key)
        if (cached !== undefined) return cached
        const html = renderFence(...args)
        renderedFences.set(key, html)
        return html
      }
    },
  },
  mermaid: {},
  themeConfig: sharedTheme,
})

/**
 * Remove the Mermaid plugin's entry transform.
 *
 * `vitepress-plugin-mermaid` registers its renderer by prepending a static
 * import to the VitePress app entry, and VitePress preloads every dynamic
 * import of that chunk on every route: one landing-page visit would fetch
 * Mermaid, KaTeX, and 40 diagram chunks for a page with no diagram. The theme
 * registers the same component as an async component instead, so the entry
 * keeps no Mermaid reference and only diagram pages load it.
 *
 * @param config - Site config `withMermaid` returned, whose plugin list it edits.
 */
function dropMermaidEntryTransform(config: UserConfig): void {
  const plugins = config.vite?.plugins
  if (plugins === undefined) throw new Error('Mermaid plugin was not registered on the Vite config.')
  for (const candidate of plugins) {
    if (typeof candidate !== 'object' || candidate === null) continue
    if (Reflect.get(candidate, 'name') !== 'vite-plugin-mermaid') continue
    if (!Reflect.deleteProperty(candidate, 'transform')) {
      throw new Error('Mermaid plugin did not carry the entry transform this config removes.')
    }
    return
  }
  throw new Error('Mermaid plugin was not registered on the Vite config.')
}

dropMermaidEntryTransform(siteConfig)

export default siteConfig
