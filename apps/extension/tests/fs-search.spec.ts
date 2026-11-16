/**
 * chrome-fs-search spec: the OPFS `glob`/`grep` suite against a stub
 * FileSystem over an in-memory tree. The model-facing contract under test —
 * basename-vs-anchored glob matching, VCS-directory pruning, grep line
 * numbers, and the include filter — is the surface the model sees; the walk
 * itself rides `ctx.fs`, which the OPFS provider implements.
 */

import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { FileSystem, type FsDirEntry, type FsInfo, type FsPathInfo, type FsTarget } from '@deepseek-ai/dsh-fs'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import * as chromeFsSearch from '../src/chrome/fs-search.ts'

/** Brand a stub path into the opaque key type (the stub world keys by the same path strings). */
function brandKey(path: string): FsTarget['targetKey'] {
  return brandString<FsTarget['targetKey']>(path)
}

/** An in-memory tree: path (POSIX, no leading slash) → text content. */
const TREE: Record<string, string> = {
  'skills/bili/SKILL.md': '# Bili\n自动生成 B 站动态摘要\n',
  'skills/learn/SKILL.md': '# Learn\n站点学习配方\n',
  'skills/learn/notes.md': '笔记：tag 顺序不可靠\n',
  '.git/config': '[core]\n',
  'deep/nested/leaf.txt': 'needle here\nno match line\nsecond needle\n',
}

/** FileSystem stub resolving POSIX paths against the in-memory tree. */
class MemoryFs extends FileSystem {
  override async resolve(path: string): Promise<FsTarget> {
    return { targetKey: brandKey(path), displayPath: path }
  }

  override processPath(target: FsTarget): string {
    return target.displayPath
  }

  override fileUrl(target: FsTarget): string {
    return `memory://${target.displayPath}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const parentPath = parent.displayPath
    const childPath = child.displayPath
    return childPath === parentPath || childPath.startsWith(`${parentPath}/`) || parentPath === '.'
  }

  override async stat(target: FsTarget): Promise<FsInfo | undefined> {
    const version = brandString<FsInfo['version']>('v1')
    if (target.displayPath === '.' || target.displayPath === '') return { version, type: 'directory' }
    const exact = TREE[target.targetKey]
    if (exact !== undefined) return { version, type: 'file', size: exact.length }
    const isDir = Object.keys(TREE).some(key => key.startsWith(`${target.targetKey}/`))
    return isDir ? { version, type: 'directory' } : undefined
  }

  override async lstat(path: string): Promise<FsPathInfo | undefined> {
    const info = await this.stat({ targetKey: brandKey(path), displayPath: path })
    return info === undefined ? undefined : { ...info, type: info.type === 'directory' ? 'directory' : 'file' }
  }

  override async listDir(target: FsTarget): Promise<FsDirEntry[]> {
    const prefix = target.targetKey === '.' || target.targetKey === '' ? '' : `${target.targetKey}/`
    const names = new Map<string, 'file' | 'directory'>()
    for (const key of Object.keys(TREE)) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      const [name, ...more] = rest.split('/')
      if (name === undefined) continue
      names.set(name, more.length > 0 ? 'directory' : 'file')
    }
    return [...names.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, type]) => ({ name, type, target: { targetKey: brandKey(`${prefix}${name}`), displayPath: `${prefix}${name}` } }))
  }

  override async readText(target: FsTarget): Promise<string> {
    const content = TREE[target.targetKey]
    if (content === undefined) throw new Error('absent')
    return content
  }

  override async streamText(): Promise<AsyncIterable<string>> {
    throw new Error('unused in this spec')
  }

  override async readBytes(): Promise<Uint8Array> {
    throw new Error('unused in this spec')
  }

  override async readByteRange(): Promise<Uint8Array> {
    throw new Error('unused in this spec')
  }

  override async writeText(): Promise<never> {
    throw new Error('unused in this spec')
  }

  override async editText(): Promise<never> {
    throw new Error('unused in this spec')
  }

  override async patchText(): Promise<never> {
    throw new Error('unused in this spec')
  }

  override async deleteFile(): Promise<never> {
    throw new Error('unused in spec')
  }

  override async moveFile(): Promise<never> {
    throw new Error('unused in spec')
  }
}

/** Minimal stub services so the plugin's inject list resolves without a composition. */
class ToolsStub extends Service {
  readonly registry = new Map<string, { name: string; execute: (args: never, run: ToolRunContext) => Promise<unknown> }>()

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  register(tool: { name: string; execute: (args: never, run: ToolRunContext) => Promise<unknown> }): void {
    this.registry.set(tool.name, tool)
  }

  get(name: string): { name: string; execute: (args: never, run: ToolRunContext) => Promise<unknown> } | undefined {
    return this.registry.get(name)
  }
}

class SystemPromptStub extends Service {
  constructor(ctx: Context) {
    super(ctx, 'systemPrompt')
  }

  section(): void {}

  getSectionOrder(): number {
    return 0
  }
}

class WorkingDirectoryStub extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workingDirectory')
  }

  async ensure(): Promise<string> {
    return '/'
  }
}

/** A minimal well-shaped run context for direct tool invocations (no agent session). */
function runCall(name: string, args: unknown): ToolRunContext {
  return {
    callId: ToolCallId('call-1'),
    rootCallId: ToolCallId('call-1'),
    token: Symbol('dsh.tool.execution') as ToolRunContext['token'],
    name,
    arguments: args,
    signal: new AbortController().signal,
    deferContext: () => {},
    concludeTurn: () => {},
  }
}

async function boot(): Promise<Context> {
  const ctx = new Context()
  // Service construction registers each stub on the context under its name.
  new ToolsStub(ctx)
  new SystemPromptStub(ctx)
  new WorkingDirectoryStub(ctx)
  new MemoryFs(ctx)
  chromeFsSearch.apply(ctx, { maxResults: 100, maxMatches: 250, maxLineBytes: 2000, timeoutMs: 30_000 })
  return ctx
}

describe('chrome-fs-search', () => {
  it('matches basenames at any depth and prunes VCS directories', async () => {
    const ctx = await boot()
    const glob = ctx.tools.get('glob')!
    const result = await glob.execute({ pattern: '*.md' }, runCall('glob', { pattern: '*.md' }))
    const paths = (result as { paths: string[] }).paths
    expect(paths).toContain('skills/bili/SKILL.md')
    expect(paths).toContain('skills/learn/notes.md')
    expect(paths.some(path => path.includes('.git/'))).toBe(false)
  })

  it('anchors separator patterns to the whole relative path', async () => {
    const ctx = await boot()
    const glob = ctx.tools.get('glob')!
    const result = await glob.execute({ pattern: 'skills/learn/*.md' }, runCall('glob', { pattern: 'skills/learn/*.md' }))
    const paths = (result as { paths: string[] }).paths
    expect(paths).toEqual(['skills/learn/notes.md', 'skills/learn/SKILL.md'])
  })

  it('greps contents with line numbers and honors the include filter', async () => {
    const ctx = await boot()
    const grep = ctx.tools.get('grep')!
    const result = await grep.execute({ pattern: 'needle' }, runCall('grep', { pattern: 'needle' }))
    const matches = (result as { matches: Array<{ path: string; lineNumber: number; line: string }> }).matches
    expect(matches).toEqual([
      { path: 'deep/nested/leaf.txt', lineNumber: 1, line: 'needle here' },
      { path: 'deep/nested/leaf.txt', lineNumber: 3, line: 'second needle' },
    ])
    const filtered = await grep.execute(
      { pattern: '配方', include: '*.txt' },
      runCall('grep', { pattern: '配方', include: '*.txt' }),
    )
    expect((filtered as { matches: unknown[] }).matches).toEqual([])
  })
})
