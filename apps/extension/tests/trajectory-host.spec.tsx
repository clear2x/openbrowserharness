// @vitest-environment jsdom
/**
 * SidePanel trajectory view spec: the shell's 对话/轨迹 strip and the host
 * that mounts the shipped ui-trajectory TrajectoryView over the bridged
 * runtime Session window.
 *
 * Covered contracts:
 * - useTrajectoryAvailable: flips with the ui-trajectory plugin's
 *   'conversation.view' ring entry against a real SlotRegistry — the same
 *   bound-receiver rule useCapabilityOccupied pins (a free-call extraction of
 *   the erased subscribe face must not be used);
 * - ViewStrip: renders no dead control while unavailable; tabs select through
 *   the single onSelect seam;
 * - TrajectoryHost: mounts the real TrajectoryView (toolbar renders through
 *   the injected namespace translate), reports the loading strip while the
 *   runtime binding has not materialized, and routes the load-earlier
 *   affordance through the plugin-shaped loadOlder (window-grew probe over
 *   session.loadOlder);
 * - real cordis proxy: the shell face is the PLUGIN's traceable context, so a
 *   service read outside the reader's declared inject throws
 *   (`cannot get property "locale" without inject` — the real-device failure
 *   this suite pins). The host degrades: the guarded locale read falls back
 *   to the zh dictionary and the inner boundary catches view crashes with the
 *   friendly strip instead of the shell's generic fallback.
 */
import { Context } from '@deepseek-ai/cordis'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { ConversationEventRegistry, ConversationViewRegistry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import { EMPTY_TRAJECTORY_SNAPSHOT } from '../../../packages/client/ui-trajectory/src/client/trajectory-snapshot-builder.ts'
import { apply as localeApply, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply as trajectoryApply, inject as trajectoryInject } from '@deepseek-ai/dsh-client-ui-trajectory/client'
import { TrajectoryHost, trajectoryLoadOlder, useTrajectoryAvailable } from '../src/sidepanel-dsh/trajectory-host.tsx'
import { ViewStrip } from '../src/sidepanel-dsh/extension-shell.tsx'

afterEach(cleanup)

/** Root context with a real SlotRegistry, viewed as the shell's client face. */
function makeCtx(): ClientContext {
  const raw = new Context()
  new SlotRegistry(raw)
  return raw
}

/** Erased-string view of the register face (this program's SlotMap lacks the probed key). */
function registerErased(ctx: ClientContext): (options: Record<string, unknown>, component: unknown) => () => void {
  return (ctx.slots.register as unknown as
    (this: unknown, options: Record<string, unknown>, component: unknown) => () => void)
    .bind(ctx.slots)
}

function AvailabilityProbe({ ctx }: { ctx: ClientContext }): JSX.Element {
  const available = useTrajectoryAvailable(ctx)
  return createElement('div', null, available ? 'trajectory-available' : 'trajectory-absent')
}

describe('useTrajectoryAvailable', () => {
  it('follows the ui-trajectory ring entry through a real SlotRegistry', async () => {
    const ctx = makeCtx()
    // Declare the ring the way ui-conversation's conversation.session entry
    // does; the probe key lives in its compile boundary, so registration and
    // reading ride erased-string faces here.
    const disposeDeclaration = registerErased(ctx)({
      name: 'root',
      children: { 'conversation.view': { kind: 'list', scope: 'session' } },
    }, () => null)
    const { container } = render(createElement(AvailabilityProbe, { ctx }))
    expect(container.textContent).toBe('trajectory-absent')

    const disposeEntry = registerErased(ctx)({ name: 'conversation.view', id: 'trajectory' }, () => null)
    await waitFor(() => { expect(container.textContent).toBe('trajectory-available') })

    disposeEntry()
    await waitFor(() => { expect(container.textContent).toBe('trajectory-absent') })
    disposeDeclaration()
  })
})

describe('ViewStrip', () => {
  it('renders nothing while the trajectory plugin has no ring entry', () => {
    const onSelect = vi.fn()
    const { container } = render(
      <ViewStrip available={false} active="chat" onSelect={onSelect} />,
    )
    expect(container.querySelector('.dshx-viewstrip')).toBeNull()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('renders both tabs and selects through the one onSelect seam', () => {
    const onSelect = vi.fn()
    const { container, getAllByRole } = render(
      <ViewStrip available={true} active="chat" onSelect={onSelect} />,
    )
    const tabs = getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]?.textContent).toBe('对话')
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs[1]?.textContent).toBe('轨迹')
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('false')
    expect(container.querySelector('.dshx-viewstrip')).not.toBeNull()

    fireEvent.click(tabs[1] as Element)
    expect(onSelect).toHaveBeenCalledWith('trajectory')
  })
})

/** Minimal assembled conversation snapshot: only what the trajectory view reads. */
function fakeSnapshotWith(trajectory: typeof EMPTY_TRAJECTORY_SNAPSHOT): ConversationSnapshot {
  return {
    views: {
      get: (target: string) => target === 'trajectory' ? trajectory : undefined,
    },
    openState: 'open',
    loadingOlder: false,
    hasMore: true,
  } as unknown as ConversationSnapshot
}

const fakeSnapshot = (): ConversationSnapshot => fakeSnapshotWith(EMPTY_TRAJECTORY_SNAPSHOT)

/** Client face over one scripted session face (binding + list + locale binds). */
function fakeCtx(session: SessionFace | undefined): ClientContext {
  return {
    sessions: {
      binding: () => (session === undefined ? undefined : { sessionId: 'session-main', session }),
      list: { subscribe: () => () => {} },
    },
    locale: { bind: () => (key: string) => key },
  } as unknown as ClientContext
}

function fakeSession(loadOlder: () => Promise<void>): SessionFace {
  return {
    sessionId: 'session-main',
    getSnapshot: fakeSnapshot,
    subscribe: () => () => {},
    loadOlder,
  } as unknown as SessionFace
}

describe('TrajectoryHost', () => {
  it('mounts the shipped TrajectoryView once the session binding exists', async () => {
    const loadOlder = vi.fn((): Promise<void> => Promise.resolve())
    const { container } = render(
      <TrajectoryHost ctx={fakeCtx(fakeSession(loadOlder))} sessionId="session-main" />,
    )
    // The view's toolbar renders through the injected namespace translate
    // (the fake bind passes keys through, so the aria-label carries the key).
    const toolbar = await waitFor(() => {
      const element = container.querySelector('[role="toolbar"][aria-label="toolbar.aria"]')
      expect(element).not.toBeNull()
      return element
    })
    expect(toolbar).not.toBeNull()
    expect(container.querySelector('.dshx-trajectory--loading')).toBeNull()
  })

  it('shows the loading strip while the runtime binding has not materialized', () => {
    const { container } = render(
      <TrajectoryHost ctx={fakeCtx(undefined)} sessionId="session-main" />,
    )
    expect(container.querySelector('.dshx-trajectory--loading')).not.toBeNull()
    expect(container.querySelector('[role="toolbar"]')).toBeNull()
  })
})

describe('trajectoryLoadOlder', () => {
  it('reports whether session.loadOlder actually grew the trajectory window', async () => {
    const first = EMPTY_TRAJECTORY_SNAPSHOT
    const second = { ...EMPTY_TRAJECTORY_SNAPSHOT }
    let current: typeof first = first
    const loadOlder = vi.fn((): Promise<void> => {
      current = second
      return Promise.resolve()
    })
    const session = {
      sessionId: 'session-main',
      getSnapshot: () => fakeSnapshotWith(current),
      subscribe: () => () => {},
      loadOlder,
    } as unknown as SessionFace
    const load = trajectoryLoadOlder(session)
    await expect(load()).resolves.toBe(true)
    expect(loadOlder).toHaveBeenCalledTimes(1)

    // A page that loads nothing new keeps the same snapshot → false.
    await expect(load()).resolves.toBe(false)
    expect(loadOlder).toHaveBeenCalledTimes(2)
  })
})

// ── real cordis proxy stack (the real-device failure class) ──
// The SidePanel shell face is the PLUGIN's traceable context, not a plain
// object: a service read outside the reader's declared inject throws
// (vendor/cordis reflect.ts). These cases run the host against real plugin
// fibers — real locale service, real ui-trajectory dictionary registration,
// real proxy gate — so the mock-green/real-red class stays pinned.

/**
 * Real plugin-fiber stack over one scripted session face: real slot/event/
 * view registries, the real locale plugin, and the real ui-trajectory apply
 * (which registers the trajectory dictionaries). `withLocaleEdge` decides
 * whether the captured shell-face plugin declares 'locale' — mirroring the
 * extension-ui-shell inject before and after the fix.
 */
async function realShellFace(session: SessionFace, withLocaleEdge: boolean): Promise<ClientContext> {
  const root = new Context()
  new SlotRegistry(root)
  root.provide('sessions', {
    binding: () => ({ sessionId: 'session-main', session }),
    list: { subscribe: () => () => {} },
  })
  root.provide('connection', { api: { settings: {} }, isLoopback: false })
  root.provide('remote', { $on: () => () => {} })
  // Minimal settings-scope face: host-loading snapshot, no writes — the
  // locale plugin adopts its default (fallback zh) from it.
  root.provide('settingsScope', {
    bind: () => ({
      getSnapshot: () => ({
        status: 'loading', value: undefined, base: undefined, user: undefined,
        revision: undefined, writable: false, mode: 'host',
      }),
      subscribe: () => () => {},
      set: () => Promise.resolve(),
      unset: () => Promise.resolve(),
    }),
  })
  await root.plugin(ConversationEventRegistry).await()
  await root.plugin(ConversationViewRegistry).await()
  root.plugin({ inject: [...localeInject], apply: localeApply })
  root.plugin({ inject: [...trajectoryInject], apply: trajectoryApply })
  let face: ClientContext | undefined
  await root.plugin({
    inject: withLocaleEdge ? ['slots', 'sessions', 'locale'] : ['slots', 'sessions'],
    apply: (pluginCtx: ClientContext) => { face = pluginCtx },
  }).await()
  if (face === undefined) throw new Error('shell face did not activate')
  return face
}

describe('TrajectoryHost on the real cordis proxy', () => {
  it('renders the real toolbar through the declared locale inject and real dictionaries', async () => {
    const face = await realShellFace(fakeSession(vi.fn()), true)
    const { container } = render(<TrajectoryHost ctx={face} sessionId="session-main" />)
    // The REAL locale service resolves the active locale (jsdom's navigator
    // is en-US → the en dictionary); the bind path itself is what's pinned.
    const expectedAria = navigator.language.startsWith('zh') ? '轨迹工具栏' : 'Trajectory toolbar'
    await waitFor(() => {
      expect(container.querySelector(`[role="toolbar"][aria-label="${expectedAria}"]`)).not.toBeNull()
    })
  })

  it('keeps the toolbar usable (zh fallback) when the locale edge is missing from the inject', async () => {
    const face = await realShellFace(fakeSession(vi.fn()), false)
    // The gate that took the real panel down: an undeclared read throws.
    const read = (): unknown => (face as unknown as { locale: unknown }).locale
    expect(read).toThrow('cannot get property "locale" without inject')

    // The host's guarded read degrades to the zh dictionary instead.
    const { container } = render(<TrajectoryHost ctx={face} sessionId="session-main" />)
    await waitFor(() => {
      expect(container.querySelector('[role="toolbar"][aria-label="轨迹工具栏"]')).not.toBeNull()
    })
  })

  it('degrades to the friendly strip inside the host when the view crashes', async () => {
    const throwing = {
      sessionId: 'session-main',
      getSnapshot: (): never => { throw new Error('snapshot exploded') },
      subscribe: () => () => {},
      loadOlder: () => Promise.resolve(),
    } as unknown as SessionFace
    const face = await realShellFace(throwing, true)
    const { container } = render(<TrajectoryHost ctx={face} sessionId="session-main" />)
    await waitFor(() => {
      expect(container.textContent).toContain('轨迹视图暂时不可用')
    })
    expect(container.querySelector('[role="toolbar"]')).toBeNull()
  })
})
