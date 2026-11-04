/**
 * The default preset is a user setting behind the preset picker. While the
 * picker is hidden, `config.default` remains the deployment's safe default;
 * once shown, the volatile `selectedDefault` field overrides it and is
 * hot-reloaded through the settings plane.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { afterEach, describe, expect, it } from 'vitest'
import { rosterOf } from './roster.ts'
import AgentPresets, { COMPOSITION_FILE, SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-agent-presets'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const ROOTS = [{ path: join(FIXTURES, 'system'), trust: 'system' as const }]
const NS = SETTINGS_NAMESPACE

/** Every temp home created by this file, removed after each test. */
const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

/**
 * A composition with a real profile, configuration editor, and settings plane,
 * the way the launcher mounts the roster: `agent-presets` loads as a Loader
 * entry whose id is the settings namespace, so the settings writes below land
 * in the roster's own volatile config.
 */
async function harness(
  extraRoots: readonly { path: string; trust: 'system' | 'user' }[] = [],
): Promise<Context> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-preset-settings-')))
  homes.push(home)
  const dir = join(home, 'profiles', 'test')
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({
    name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'llm', name: 'cordis:llm' },
    { id: 'sessions', name: 'cordis:sessions' },
    { id: 'session-projections', name: 'cordis:projections' },
    { id: 'system-prompt', name: 'cordis:system-prompt', config: { personaPrefix: '' } },
    { id: 'tools', name: 'cordis:tools' },
    { id: 'agents', name: 'cordis:agents' },
    { id: 'agent-loop', name: 'cordis:loop', config: { agents: [] } },
    {
      id: NS,
      name: 'cordis:agent-presets',
      config: {
        default: 'standard',
        roots: [...ROOTS, ...extraRoots],
        includeShippedRoot: false,
        includeUserRoot: false,
      },
    },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-bundle'], dir,
    patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'),
    cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  return await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (bootCtx) => {
    bootCtx.provide('profileContext', profile)
    bootCtx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    Object.assign(bootCtx.loader.builtins, {
      editor: ConfigEditor,
      settings: Settings,
      llm: LlmRuntime,
      sessions: SessionStore,
      projections: SessionProjectionRegistry,
      'system-prompt': SystemPrompt,
      tools: ToolRuntime,
      agents: AgentRegistry,
      loop: AgentLoop,
      'agent-presets': AgentPresets,
    })
  })
}

const toolNames = (ctx: Context, agent?: unknown): string[] =>
  ctx.tools.schemas(agent as never).map(schema => schema.name).sort()

describe('the default preset as a user setting', () => {
  it('shows mode selection on the composition default by default', async () => {
    const ctx = await harness()

    expect((await rosterOf(ctx).remoteExportList()).modeSelectionEnabled).toBe(true)
    expect(rosterOf(ctx).defaultId).toBe('standard')

    await ctx.settings.update(NS, { modeSelectionEnabled: false })
    expect((await rosterOf(ctx).remoteExportList()).modeSelectionEnabled).toBe(false)
    expect(rosterOf(ctx).defaultId).toBe('standard')
  })

  it('temporarily ignores the saved user default while selection is off', async () => {
    const ctx = await harness()

    await ctx.settings.update(NS, { selectedDefault: 'minimal' })
    expect(rosterOf(ctx).defaultId).toBe('minimal')

    await ctx.settings.update(NS, { modeSelectionEnabled: false })
    expect(rosterOf(ctx).defaultId).toBe('standard')

    await ctx.settings.update(NS, { modeSelectionEnabled: true })
    expect(rosterOf(ctx).defaultId).toBe('minimal')
  })

  it('composes a new session from the user default', async () => {
    const ctx = await harness()
    await ctx.settings.update(NS, { selectedDefault: 'minimal' })

    const handle = await ctx.agents.create({
      sessionId: SessionId('settings-default'),
      setup: async (agentCtx: Context) => void await rosterOf(ctx).mount(agentCtx),
    })
    try {
      expect(toolNames(ctx, handle.agent)).toEqual(['beta'])
    } finally {
      await handle.dispose()
    }
  })

  it('leaves a running session on the preset it was composed from', async () => {
    const ctx = await harness()
    const running = await ctx.agents.create({
      sessionId: SessionId('settings-running'),
      setup: async (agentCtx: Context) => void await rosterOf(ctx).mount(agentCtx),
    })
    try {
      expect(toolNames(ctx, running.agent)).toEqual(['alpha'])

      // Changing the default mid-flight must not reach an agent that already
      // composed: its history was produced under `standard`'s tools.
      await ctx.settings.update(NS, { selectedDefault: 'minimal' })

      expect(rosterOf(ctx).defaultId).toBe('minimal')
      expect(toolNames(ctx, running.agent)).toEqual(['alpha'])

      await ctx.settings.update(NS, { modeSelectionEnabled: false })

      expect(rosterOf(ctx).defaultId).toBe('standard')
      expect(toolNames(ctx, running.agent)).toEqual(['alpha'])
    } finally {
      await running.dispose()
    }
  })

  it('re-inherits the composition default when the user setting is cleared', async () => {
    const ctx = await harness()
    await ctx.settings.update(NS, { selectedDefault: 'minimal' })
    expect((await rosterOf(ctx).remoteExportList()).modeSelectionEnabled).toBe(true)
    expect(rosterOf(ctx).defaultId).toBe('minimal')

    await ctx.settings.replace(NS, {})

    expect((await rosterOf(ctx).remoteExportList()).modeSelectionEnabled).toBe(true)
    expect(rosterOf(ctx).defaultId).toBe('standard')
  })

  it('clears a user default it has just deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-preset-authored-'))
    homes.push(root)
    await mkdir(join(root, 'mine'))
    await writeFile(
      join(root, 'mine', COMPOSITION_FILE),
      `- id: only\n  name: ${join(FIXTURES, 'plugins', 'contribute.js')}\n  config:\n    tool: only\n`,
    )
    const ctx = await harness([{ path: root, trust: 'user' as const }])
    await ctx.settings.update(NS, { selectedDefault: 'mine' })
    expect(rosterOf(ctx).defaultId).toBe('mine')

    await rosterOf(ctx).remove('mine')

    // Nothing will ever supply that id again, so leaving the setting pointed at
    // it would fail every session created without an explicit pick. Clearing it
    // exposes the deployment's own default underneath.
    expect(rosterOf(ctx).defaultId).toBe('standard')
    expect((await rosterOf(ctx).resolve()).id).toBe('standard')
  })

  it('reports an unknown user default only when a session tries to use it', async () => {
    const ctx = await harness()

    // Storing it succeeds — the roster is a live directory, so a name that is
    // absent now may exist by the time a session asks for it.
    await ctx.settings.update(NS, { selectedDefault: 'no-such-preset' })

    await expect(rosterOf(ctx).resolve())
      .rejects.toThrow(/preset "no-such-preset" not found/)
  })
})

describe('a cleared user layer', () => {
  it('falls back to the composition default when the user layer empties', async () => {
    const ctx = await harness()
    await ctx.settings.update(NS, { selectedDefault: 'minimal' })
    expect((await rosterOf(ctx).remoteExportList()).modeSelectionEnabled).toBe(true)
    expect(rosterOf(ctx).defaultId).toBe('minimal')

    // Emptying the volatile user layer is the write-side equivalent of losing
    // it: the roster keeps working on its composition default rather than
    // holding a stale override.
    await ctx.settings.mutate(NS, [{ op: 'unset', path: [] }])

    expect((await rosterOf(ctx).remoteExportList()).modeSelectionEnabled).toBe(true)
    expect(rosterOf(ctx).defaultId).toBe('standard')
  })
})
