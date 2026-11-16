/**
 * The OPFS `glob`/`grep` suite: the model-facing filesystem discovery tools
 * over `ctx.fs` (the extension's OPFS provider). The desktop's
 * `@deepseek-ai/dsh-tool-fs-search` executes through the packaged ripgrep
 * binary via `ctx.subprocess` — a seam a browser host does not have — so this
 * plugin mirrors the desktop's model-facing surface (tool names, parameters,
 * output values, caps, result formatting) and replaces the execution with an
 * OPFS tree walk. Two documented deviations, both forced by the `ctx.fs`
 * seam (names, types, sizes; no timestamps, no subprocess):
 *
 * - `glob` results are ordered by path ascending instead of modification
 *   time (the desktop sorts by `rg --sort=modified`).
 * - over-cap results truncate with a narrow-the-search footer instead of
 *   spilling the complete list to a spill file.
 *
 * @module chrome-fs-search
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import picomatch from 'picomatch'
import { ToolArgsError, defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { FileSystem, FsDirEntry, FsTarget } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-working-directory'
import {
  presentGlobCall,
  presentGrepCall,
  renderGlobPaths,
  renderGrepMatches,
} from './fs-search-format.ts'

export const name = 'chrome-fs-search'
/** Services the suite reads: the tool registry, prompt sections, the OPFS world, and session directories. */
export const inject = ['tools', 'systemPrompt', 'fs', 'workingDirectory'] as const

/** Inline cap on `glob` paths (the desktop `GLOB_MAX_RESULTS`). */
const GLOB_MAX_RESULTS = 100
/** Inline cap on flat `grep` matches (the desktop `GREP_MAX_MATCHES`). */
const GREP_MAX_MATCHES = 250
/** Per-line preview cap for a matched line (the desktop `GREP_MAX_LINE_BYTES`). */
const GREP_MAX_LINE_BYTES = 2000
/** Directories the walk never descends into: VCS metadata stores (the desktop `GLOB_VCS_EXCLUDES`). */
const VCS_EXCLUDES: ReadonlySet<string> = new Set(['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'])
/** Total entries one walk may visit, bounding runaway trees across both tools. */
const WALK_ENTRY_BUDGET = 20_000
/** Walk depth cap, bounding pathological nesting. */
const WALK_DEPTH_BUDGET = 24
/** Per-file read cap for `grep`; larger files are skipped rather than parsed. */
const GREP_FILE_MAX_BYTES = 1_000_000

/** Config: the shared caps of the two tools (validated positive integers). */
export interface Config {
  /** Max `glob` paths retained inline. */
  maxResults: number
  /** Max flat `grep` matches retained inline. */
  maxMatches: number
  /** Max bytes of one matched-line preview. */
  maxLineBytes: number
  /** Cooperative tool-call budget (ms) attached as `ToolDefinition.timeoutMs`. */
  timeoutMs: number
}

export const Config: z<Config> = z.object({
  maxResults: z.number().default(GLOB_MAX_RESULTS),
  maxMatches: z.number().default(GREP_MAX_MATCHES),
  maxLineBytes: z.number().default(GREP_MAX_LINE_BYTES),
  timeoutMs: z.number().default(30_000),
})

/** Reject a blank optional path-like argument the schema DSL cannot constrain. */
function requireNonBlank(value: string | undefined, label: string): void {
  if (value !== undefined && value.trim().length === 0) {
    throw new ToolArgsError([`${label} must be a non-empty string when given`])
  }
}

/**
 * One walked file: its model-facing path relative to the search root (POSIX
 * separators, no leading `./`) and its resolved target.
 */
interface WalkedFile {
  path: string
  target: FsTarget
}

/** Join a walk prefix and one entry name into the display-relative path. */
function joinRelative(prefix: string, name: string): string {
  return prefix === '' ? name : `${prefix}/${name}`
}

/**
 * Depth-first walk collecting every regular file under `root`, skipping
 * {@link VCS_EXCLUDES} directories. The entry and depth budgets stop the walk
 * early; the caller learns of truncation through the returned flag instead of
 * a failure, so a bounded answer still reaches the model.
 */
async function walkFiles(
  fs: FileSystem,
  root: FsTarget,
  signal: AbortSignal | undefined,
): Promise<{ files: WalkedFile[]; truncated: boolean }> {
  const files: WalkedFile[] = []
  let budget = WALK_ENTRY_BUDGET
  let truncated = false

  const visit = async (target: FsTarget, prefix: string, depth: number): Promise<void> => {
    if (truncated || depth > WALK_DEPTH_BUDGET) return
    let entries: FsDirEntry[]
    try {
      entries = await fs.listDir(target, signal)
    } catch {
      // An unreadable directory prunes that subtree; the rest of the walk continues.
      return
    }
    for (const entry of entries) {
      if (budget <= 0) {
        truncated = true
        return
      }
      budget -= 1
      const path = joinRelative(prefix, entry.name)
      if (entry.type === 'directory') {
        if (!VCS_EXCLUDES.has(entry.name)) await visit(entry.target, path, depth + 1)
      } else if (entry.type === 'file') {
        files.push({ path, target: entry.target })
      }
    }
  }

  await visit(root, '', 0)
  return { files, truncated }
}

/**
 * Resolve the search root from `args.path` or the session's working directory.
 * A file-typed `path` is a caller error for both tools (the desktop lets rg
 * search one file; the port keeps the suite directory-rooted and the model
 * uses `read` for single files).
 */
async function resolveRoot(
  fs: FileSystem,
  ctx: Context,
  exec: ToolExecution,
  path: string | undefined,
): Promise<FsTarget> {
  const cwd = exec.agent === undefined ? undefined : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
  const target = await fs.resolve(path ?? '.', cwd === undefined ? { signal: exec.signal } : { cwd, signal: exec.signal })
  if (path !== undefined) {
    const info = await fs.stat(target, exec.signal)
    if (info !== undefined && info.type !== 'directory') {
      throw new ToolArgsError([`path must be a directory; ${path} is a ${info.type}`])
    }
  }
  return target
}

/** Register the `glob` and `grep` tools plus their scope-aware prompt guidance. Registrations are effects scoped to `ctx`. */
export function apply(ctx: Context, config: Config): void {
  ctx.systemPrompt.section({
    name: 'tool:glob',
    order: ctx.systemPrompt.getSectionOrder('TOOL_GLOB'),
    text: ({ scope }) => ctx.tools.get('glob', scope) === undefined
      ? ''
      : 'Use the glob tool — not shell find — to discover files by path pattern.',
  })
  ctx.systemPrompt.section({
    name: 'tool:grep',
    order: ctx.systemPrompt.getSectionOrder('TOOL_GREP'),
    text: ({ scope }) => ctx.tools.get('grep', scope) === undefined
      ? ''
      : 'Use the grep tool — not shell grep or rg — to search file contents.'
        + (ctx.tools.get('read', scope) === undefined ? '' : ' Use read on a matched file when you need surrounding context.'),
  })

  const fs = ctx.fs

  ctx.tools.register(defineTool({
    name: 'glob',
    description: 'Find files, not directories, whose paths match a glob pattern, including hidden files. '
      + `Returns up to ${config.maxResults} paths sorted by path; a larger result keeps the first paths `
      + 'and reports how many paths were omitted.',
    parameters: {
      pattern: {
        type: 'string',
        required: true,
        description: 'Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/*.test.js"). '
          + 'A pattern with no "/" matches the basename at any depth, so "*" and "*.ts" both search the whole tree; '
          + 'include a separator to anchor the match to the whole relative path.',
      },
      path: { type: 'string', description: 'Directory to search in. Defaults to the session workspace; a relative path resolves against it.' },
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          paths: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderGlobPaths(value.paths, config.maxResults) }],
    },
    async execute(args, exec) {
      if (args.pattern.trim().length === 0) throw new ToolArgsError(['pattern must be a non-empty string'])
      requireNonBlank(args.path, 'path')
      const root = await resolveRoot(fs, ctx, exec, args.path)
      const isMatch = picomatch(args.pattern, { dot: true })
      const { files } = await walkFiles(fs, root, exec.signal)
      // A pattern with no separator matches the basename at any depth (the
      // desktop `--glob` semantics); a separator anchors the whole relative path.
      const anchored = args.pattern.includes('/')
      const paths = files
        .filter(file => isMatch(anchored ? file.path : file.path.split('/').at(-1) ?? file.path))
        .map(file => file.path)
        .sort((a, b) => a.localeCompare(b))
      return { root: args.path ?? '.', paths }
    },
    presentCall: presentGlobCall,
  }))

  ctx.tools.register(defineTool({
    name: 'grep',
    description: 'Search file contents with a regular expression. Returns matching lines with line numbers, grouped by file. '
      + `Returns up to ${config.maxMatches} matches; a larger result reports where truncation cut the list.`,
    parameters: {
      pattern: { type: 'string', required: true, description: 'Regular expression to search for (JavaScript RegExp syntax).' },
      path: { type: 'string', description: 'Directory to search. Defaults to the session workspace; a relative path resolves against it.' },
      include: { type: 'string', description: 'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.' },
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                lineNumber: { type: 'integer', required: true },
                line: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderGrepMatches(value.matches, config.maxMatches, config.maxLineBytes) }],
    },
    async execute(args, exec) {
      if (args.pattern.trim().length === 0) throw new ToolArgsError(['pattern must be a non-empty string'])
      let regex: RegExp
      try {
        regex = new RegExp(args.pattern)
      } catch {
        throw new ToolArgsError(['pattern is not a valid regular expression'])
      }
      requireNonBlank(args.path, 'path')
      requireNonBlank(args.include, 'include')
      const includeMatch = args.include === undefined ? undefined : picomatch(args.include, { dot: true, basename: true })

      const root = await resolveRoot(fs, ctx, exec, args.path)
      const matches: Array<{ path: string; lineNumber: number; line: string }> = []

      const scanFile = async (file: WalkedFile, displayPath: string): Promise<void> => {
        if (matches.length >= config.maxMatches) return
        if (includeMatch !== undefined && !includeMatch(displayPath.split('/').at(-1) ?? displayPath)) return
        const info = await fs.stat(file.target, exec.signal)
        if (info === undefined || info.type !== 'file' || (info.size ?? 0) > GREP_FILE_MAX_BYTES) return
        let content: string
        try {
          content = await fs.readText(file.target, exec.signal)
        } catch {
          // A binary or undecodable file has no text matches; skip it.
          return
        }
        const lines = content.split('\n')
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index]
          if (line === undefined) continue
          if (regex.test(line)) {
            matches.push({ path: displayPath, lineNumber: index + 1, line })
            if (matches.length >= config.maxMatches) return
          }
        }
      }

      const rootInfo = await fs.stat(root, exec.signal)
      if (rootInfo !== undefined && rootInfo.type === 'file') {
        throw new ToolArgsError(['path must be a directory; use read for a single file'])
      }
      const { files, truncated } = await walkFiles(fs, root, exec.signal)
      // Display paths carry the search-root prefix (the desktop prints
      // workdir-relative paths, which include the root when one was given).
      const prefix = args.path === undefined ? '' : `${args.path.replace(/\/+$/, '')}/`
      for (const file of files) {
        await scanFile(file, `${prefix}${file.path}`)
        if (matches.length >= config.maxMatches) break
      }
      // The walk budget exhausted before every file was scanned: say so in the
      // result instead of presenting a complete-looking match list.
      if (truncated && matches.length < config.maxMatches) {
        matches.push({
          path: '(search incomplete)',
          lineNumber: 0,
          line: `the walk stopped at its ${WALK_ENTRY_BUDGET}-entry budget before scanning every file`,
        })
      }
      return { matches }
    },
    presentCall: presentGrepCall,
  }))
}
