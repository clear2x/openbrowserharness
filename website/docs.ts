/**
 * Canonical publication manifest for the documentation website.
 *
 * The site publishes the browser extension's own corpus: a landing home page,
 * the extension guide, and the policy pages. Markdown stays in its owning
 * repository tier. This manifest maps each canonical source into matching
 * route trees for both site locales.
 */

/** Locale key used by the VitePress site. */
export type DocsLocale = 'root' | 'en'

/** Sidebar collection rendered for one locale and top-level module. */
export type DocsSidebar =
  | 'zh-guide'
  | 'zh-reference'
  | 'en-guide'
  | 'en-reference'

/** A page projected into the VitePress source tree. */
export interface DocsPage {
  /** VitePress locale whose route tree owns this projection. */
  locale: DocsLocale
  /** Language of the canonical source currently projected at this route. */
  contentLocale: 'zh-CN' | 'en-US'
  /** Repository-relative canonical Markdown source. */
  source: string
  /** VitePress route, including the `.md` suffix. */
  route: string
  /** Navigation label shown in the sidebar. */
  label: string
  /** Sidebar collection that owns the page, or null for a locale home page. */
  sidebar: DocsSidebar | null
  /** Section label within the sidebar. */
  section: string
  /** Stable order within the section. */
  order: number
  /** Heading levels included in this page's VitePress outline. */
  outline?: number | readonly [number, number] | 'deep' | false
  /** Additional repository paths that resolve to this page. */
  sourceAliases?: string[]
}

interface MirroredPage {
  source: string | Record<DocsLocale, string>
  route: string
  contentLocale: DocsPage['contentLocale'] | Record<DocsLocale, DocsPage['contentLocale']>
  label: Record<DocsLocale, string>
  sidebar: Record<DocsLocale, DocsSidebar | null>
  section: Record<DocsLocale, string>
  order: number
  outline?: DocsPage['outline']
  sourceAliases?: string[] | Partial<Record<DocsLocale, string[]>>
}

type PairedPage = Omit<MirroredPage, 'source' | 'contentLocale' | 'sourceAliases'> & {
  /** English side of a sibling `foo.md` / `foo.zh.md` pair. */
  source: string
  /** Language-neutral repository aliases, such as the directory of an index page. */
  sourceAliases?: string[]
}

function localized<T>(value: T | Record<DocsLocale, T>, locale: DocsLocale): T {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<DocsLocale, T>)[locale]
    : value
}

function mirroredPages(pages: MirroredPage[]): DocsPage[] {
  return pages.flatMap(page => (['root', 'en'] as const).map((locale) => {
    const aliases = page.sourceAliases === undefined
      ? undefined
      : Array.isArray(page.sourceAliases) ? page.sourceAliases : page.sourceAliases[locale]
    return {
      locale,
      contentLocale: localized(page.contentLocale, locale),
      source: localized(page.source, locale),
      route: locale === 'root' ? page.route : `en/${page.route}`,
      label: page.label[locale],
      sidebar: page.sidebar[locale],
      section: page.section[locale],
      order: page.order,
      ...(page.outline === undefined ? {} : { outline: page.outline }),
      ...(aliases === undefined ? {} : { sourceAliases: aliases }),
    }
  }))
}

function pairedPages(pages: PairedPage[]): DocsPage[] {
  return mirroredPages(pages.map((page) => {
    const chineseSource = page.source.replace(/\.md$/, '.zh.md')
    const sharedAliases = page.sourceAliases ?? []
    return {
      ...page,
      source: { root: chineseSource, en: page.source },
      contentLocale: { root: 'zh-CN', en: 'en-US' },
      sourceAliases: {
        root: [...sharedAliases, page.source],
        en: [...sharedAliases, chineseSource],
      },
    }
  }))
}

/**
 * The landing home page. Its source is VitePress `layout: home` frontmatter,
 * which is the whole body a sidebar-null page publishes.
 */
const extensionHome = pairedPages([
  {
    source: 'docs/extension/index.md',
    route: 'index.md',
    label: { root: 'OpenBrowserHarness', en: 'OpenBrowserHarness' },
    sidebar: { root: null, en: null },
    section: { root: '首页', en: 'Home' },
    order: 0,
  },
])

/** The extension guide: install, models, automation surface, safety, plugins. */
const extensionGuide = pairedPages([
  {
    source: 'docs/extension/quickstart.md',
    route: 'guide/quickstart.md',
    label: { root: '快速上手', en: 'Get started' },
    sidebar: { root: 'zh-guide', en: 'en-guide' },
    section: { root: '入门', en: 'Getting started' },
    order: 0,
  },
  {
    source: 'docs/extension/providers.md',
    route: 'guide/providers.md',
    label: { root: '配置模型', en: 'Configure models' },
    sidebar: { root: 'zh-guide', en: 'en-guide' },
    section: { root: '使用', en: 'Usage' },
    order: 0,
  },
  {
    source: 'docs/extension/automation.md',
    route: 'guide/automation.md',
    label: { root: '浏览器自动化', en: 'Browser automation' },
    sidebar: { root: 'zh-guide', en: 'en-guide' },
    section: { root: '使用', en: 'Usage' },
    order: 1,
  },
  {
    source: 'docs/extension/permissions.md',
    route: 'guide/permissions.md',
    label: { root: '权限与安全', en: 'Permissions and safety' },
    sidebar: { root: 'zh-guide', en: 'en-guide' },
    section: { root: '使用', en: 'Usage' },
    order: 2,
  },
  {
    source: 'docs/extension/plugins.md',
    route: 'guide/plugins.md',
    label: { root: '用户插件', en: 'User plugins' },
    sidebar: { root: 'zh-guide', en: 'en-guide' },
    section: { root: '使用', en: 'Usage' },
    order: 3,
  },
])

/**
 * The privacy policy, published as the reference sidebar's page. Store
 * listings link it directly and each locale's site footer carries the link
 * alongside the sidebar placement.
 */
const privacyPolicy = pairedPages([
  {
    source: 'docs/privacy.md',
    route: 'reference/privacy.md',
    label: { root: '隐私政策', en: 'Privacy policy' },
    sidebar: { root: 'zh-reference', en: 'en-reference' },
    section: { root: '政策', en: 'Policies' },
    order: 0,
  },
])

/**
 * Sidebar collections of each locale, in the order the site's navigation
 * presents them. The navigation bar and the llms.txt index both read this
 * sequence, so a new collection lands in both surfaces together.
 */
export const localeCollections = {
  root: ['zh-guide', 'zh-reference'],
  en: ['en-guide', 'en-reference'],
} as const satisfies Record<DocsLocale, readonly DocsSidebar[]>

/** A sidebar group, matched to pages by `label`. */
export interface DocsSection {
  /** Group heading, equal to the `section` field of every page it holds. */
  label: string
  /** Render the group collapsed until it holds the page being read. */
  collapsed?: boolean
}

/**
 * Every sidebar group, in the order its locale renders it.
 *
 * The extension corpus keeps every group small enough to stay expanded.
 */
const sections: Record<DocsLocale, readonly DocsSection[]> = {
  root: [
    { label: '入门' },
    { label: '使用' },
    { label: '政策' },
  ],
  en: [
    { label: 'Getting started' },
    { label: 'Usage' },
    { label: 'Policies' },
  ],
}

/**
 * Placement and collapse behavior of one sidebar group.
 *
 * @param locale - Route tree whose sidebar is being built.
 * @param label - Section label carried by the pages in the group.
 * @returns The declared group, plus its zero-based position in the locale.
 * @throws When the locale declares no placement for the label. Ranking by list
 *   membership alone would sort an undeclared group silently ahead of every
 *   declared one.
 */
export function sectionSpec(locale: DocsLocale, label: string): DocsSection & { index: number } {
  const declared = sections[locale]
  const section = declared.find(candidate => candidate.label === label)
  if (section === undefined) throw new Error(`Sidebar section "${label}" has no placement in the ${locale} locale.`)
  return { ...section, index: declared.indexOf(section) }
}

/** Every canonical page published by the documentation website. */
export const docsPages: DocsPage[] = [
  ...extensionHome,
  ...extensionGuide,
  ...privacyPolicy,
]

/**
 * Pages of one sidebar collection, in the order the sidebar lists them.
 *
 * @param locale - Route tree whose sidebar is being built.
 * @param collection - Sidebar collection to read.
 * @returns The collection's pages, ordered by section placement then by `order`.
 */
export function orderedPages(locale: DocsLocale, collection: DocsSidebar): DocsPage[] {
  return docsPages
    .filter(page => page.locale === locale && page.sidebar === collection)
    .sort((left, right) => (
      sectionSpec(locale, left.section).index - sectionSpec(locale, right.section).index
      || left.order - right.order
    ))
}

/**
 * Site-relative link for a published route.
 *
 * @param route - Manifest route, including its `.md` suffix.
 * @returns The link VitePress serves the route at.
 */
export function routeLink(route: string): string {
  return `/${route.replace(/(?:index)?\.md$/, '')}`
}

/**
 * Where a top-level navigation item lands.
 *
 * The target is derived rather than written down: a collection whose first page
 * is renamed or reordered would otherwise leave the navigation bar pointing at
 * a route the manifest no longer publishes.
 *
 * @param locale - Route tree the navigation item belongs to.
 * @param collection - Sidebar collection the item opens.
 * @returns Site-relative link of the collection's first page.
 * @throws When the collection publishes no page.
 */
export function landingLink(locale: DocsLocale, collection: DocsSidebar): string {
  const first = orderedPages(locale, collection)[0]
  if (first === undefined) throw new Error(`Sidebar collection "${collection}" publishes no page.`)
  return routeLink(first.route)
}
