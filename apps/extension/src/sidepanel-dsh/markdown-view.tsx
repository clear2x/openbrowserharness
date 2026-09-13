/**
 * Markdown presentation for assistant text blocks.
 *
 * react-markdown + remark-gfm: GFM tables, task lists, strikethrough and
 * autolinks render from the durable log's text blocks. No rehype plugin is
 * mounted, so raw HTML never parses — the MV3 CSP-safe default (no eval
 * surface). Links force a new tab so a mis-click cannot navigate the panel
 * itself; URLs pass react-markdown's `urlTransform` sanitizer first.
 *
 * Styling is one stylesheet string (`MARKDOWN_CSS`) the shell concatenates
 * into its injected sheet. Tokens prefer the dedicated `--dsw-alias-*`
 * aliases (including the markdown-specific ones design-platform projects for
 * both color schemes), each with a neutral fallback so an unprojected token
 * degrades instead of vanishing.
 */
import Markdown, { type Components } from 'react-markdown'
import type { JSX } from 'react'
import remarkGfm from 'remark-gfm'

/**
 * Anchor override: every link opens in a new tab (the SidePanel document must
 * stay put), with noopener/noreferrer per standard external-link hygiene.
 */
const COMPONENTS: Components = {
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children ?? null}
    </a>
  ),
}

/** Markdown for one assistant text block (or any trusted plain text). */
export function MarkdownView({ text }: { text: string }): JSX.Element {
  return (
    <div className="dshx-md">
      <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </Markdown>
    </div>
  )
}

/**
 * Prose stylesheet under the `.dshx-md` scope. Type ladder follows the shell
 * (12 / 13 / 15 px); rhythm sits on 4-px steps; horizontal rules reuse the
 * border tokens instead of painted boxes.
 */
export const MARKDOWN_CSS = `
.dshx-md{font-size:13px;line-height:1.7;overflow-wrap:anywhere}
.dshx-md>:first-child,.dshx-md p:first-child{margin-top:0}
.dshx-md>:last-child,.dshx-md p:last-child{margin-bottom:0}
.dshx-md h1,.dshx-md h2,.dshx-md h3,.dshx-md h4,.dshx-md h5,.dshx-md h6{margin:16px 0 8px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary,#171717)}
.dshx-md h1{font-size:15px;font-weight:700}
.dshx-md h2{font-size:15px;padding-bottom:4px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}
.dshx-md :where(h3,h4,h5,h6){font-size:13px}
.dshx-md strong{font-weight:600;color:var(--dsw-alias-label-primary,#171717)}
.dshx-md del{color:var(--dsw-alias-label-secondary,#888)}
.dshx-md p{margin:8px 0}
.dshx-md :where(ul,ol){margin:8px 0;padding-left:20px}
.dshx-md li{margin:4px 0}
.dshx-md li::marker{color:var(--dsw-alias-label-secondary,#888)}
.dshx-md li>p{margin:4px 0}
.dshx-md li>*:first-child{margin-top:0}
.dshx-md li>*:last-child{margin-bottom:0}
.dshx-md input[type=checkbox]{margin:0 8px 0 0;accent-color:var(--dsw-alias-brand-primary,#4c7dfd)}
.dshx-md blockquote{margin:8px 0;padding:4px 12px;border-left:3px solid var(--dsw-alias-border-l3,rgba(0,0,0,.18));color:var(--dsw-alias-label-secondary,#888)}
.dshx-md blockquote>:first-child{margin-top:0}
.dshx-md blockquote>:last-child{margin-bottom:0}
.dshx-md hr{border:none;height:1px;margin:16px 0;background:var(--dsw-alias-border-l2,rgba(0,0,0,.08))}
.dshx-md a{color:var(--dsw-alias-brand-primary,#4c7dfd);text-decoration:underline;text-decoration-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 40%,transparent);text-underline-offset:2px;word-break:break-all}
.dshx-md a:hover{text-decoration-color:var(--dsw-alias-brand-primary,#4c7dfd)}
.dshx-md img{max-width:100%;height:auto;border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.04))}
/* Inline code chip vs fenced code block (react-markdown emits pre>code). */
.dshx-md :not(pre)>code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;padding:1px 5px;border-radius:4px;background:var(--dsw-alias-markdown-inline-code,rgba(0,0,0,.07));word-break:break-word}
.dshx-md :where(h1,h2,h3,h4,h5,h6) code{font-size:inherit}
.dshx-md pre{margin:8px 0;padding:12px;border-radius:8px;background:var(--dsw-alias-markdown-code-block,rgba(0,0,0,.06));overflow-x:auto;overscroll-behavior-x:contain;font-size:12px;line-height:1.55}
.dshx-md pre::-webkit-scrollbar{height:10px}
.dshx-md pre>code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:inherit;background:none;padding:0;border-radius:0;color:var(--dsw-alias-label-primary,#24292f);white-space:pre}
/* Tables scroll horizontally inside the narrow panel instead of squeezing. */
.dshx-md table{display:block;width:max-content;max-width:100%;margin:8px 0;overflow-x:auto;border-collapse:collapse;font-size:12px;overscroll-behavior-x:contain}
.dshx-md th{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.18));background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03));font-weight:600;text-align:start;white-space:nowrap}
.dshx-md td{padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));text-align:start}
.dshx-md th code,.dshx-md td code{font-size:11px}
`
