/**
 * Trajectory view host (extension SidePanel): mounts the shipped
 * `ui-trajectory` TrajectoryView against the shared runtime Session window —
 * the same turn-aware assembled records the desktop conversation shell reads,
 * so no extra backend surface exists.
 *
 * Why a host at all: the desktop view tab ring renders inside
 * ui-conversation's `conversation.session` seat, which this shell keeps
 * MOUNTED but hidden (its ChatView duplicates the extension-native
 * transcript). That seat's store handle and render authorization are
 * ui-conversation-private, so the shell can neither read the ring's active
 * view nor drive it; instead this host mounts the view component directly and
 * binds the two things a `conversation.view` entry normally gets from the
 * framework:
 * - `useSession` — a selector hook over the bridged Session's observable
 *   snapshot (the same source the standard kit binds for session-scoped
 *   entries), and
 * - the TrajectoryViewInjected share — `loadOlder` and the duration
 *   preference store — rebuilt from the public session face exactly like the
 *   plugin's own registration does (same `dsh.trajectory.duration` persist
 *   key, so the preference reads back what the desktop writes).
 *
 * `createSnapshotStore` rides the client-store package: the runtime package's
 * `/client` subpath resolves to its `__ModuleLoader__` registration bundle in
 * this workspace, which is not an importable module (the connection-module
 * precedent in boot.ts). Vite compiles the source; tsc reads the built
 * declarations through the project-reference redirect.
 *
 * The remaining framework seats on the view props (sessionId, useSessions,
 * useInput, inputActions) are never read by TrajectoryView; the assembled
 * props object casts the consumed subset once, at the single mount site, so
 * the type lie cannot spread.
 */

import { Component, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the LocaleNamespaceMap 'trajectory' augmentation the
// locale.bind call below types against (declared by the plugin's locales).
import type {} from '../../../../packages/client/ui-trajectory/src/client/locales.ts'
// Runtime: the zh dictionary is the guarded-locale fallback translate below.
import { zh as trajectoryZh } from '../../../../packages/client/ui-trajectory/src/client/locales.ts'
// Type-only: pulls the ConversationViewSnapshotMap 'trajectory' augmentation
// so the loadOlder probe below can read the view target off the snapshot.
import type {} from '../../../../packages/client/ui-trajectory/src/client/trajectory-contract.ts'
import { EMPTY_TRAJECTORY_SNAPSHOT } from '../../../../packages/client/ui-trajectory/src/client/trajectory-snapshot-builder.ts'
import type { TrajectorySnapshot } from '../../../../packages/client/ui-trajectory/src/client/trajectory-contract.ts'
import { TrajectoryView } from '../../../../packages/client/ui-trajectory/src/client/TrajectoryView.tsx'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** The view component's composed props as the built declaration types them. */
type TrajectoryViewProps = Parameters<typeof TrajectoryView>[0]

/**
 * Fallback translate when the locale seat is unreachable on the reader's
 * inject: the toolbar keeps its zh copy instead of raw dictionary keys. The
 * REAL registration (the plugin's `ctx.locale.register`) still wins whenever
 * the bind succeeds.
 */
function fallbackTrajectoryT(key: string): string {
  return (trajectoryZh as Record<string, string>)[key] ?? key
}

/**
 * Inner crash wall for the view itself: a render/effect failure degrades to
 * the friendly loading-style strip INSIDE this host instead of climbing to
 * the shell's generic slot fallback. Keyed remounts (per session) reset it.
 */
class TrajectoryViewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.warn('[trajectory-host]', '轨迹视图渲染失败，已降级：', error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return <div className="dshx-trajectory dshx-trajectory--loading">轨迹视图暂时不可用，请切回对话后重试。</div>
    }
    return this.props.children
  }
}

/** Browser-wide trajectory duration preference (the plugin's own store semantics). */
let durationStore: SnapshotStore<boolean> | undefined

/** Create (once per panel lifecycle) the persisted actual-duration toggle. */
export function trajectoryDurationStore(): SnapshotStore<boolean> {
  durationStore ??= createSnapshotStore<boolean>(false, { persist: { name: 'dsh.trajectory.duration' } })
  return durationStore
}

/**
 * Whether the ui-trajectory plugin has its `conversation.view` ring entry up
 * (the same occupancy signal the tab label registration carries). Probes the
 * plain-string slot inspection face — the slot's typed declaration lives in
 * ui-conversation's compile boundary — with the bound-receiver rule from
 * useCapabilityOccupied (ctx.slots is a cordis traceable proxy; a free call
 * loses `this` and throws during effect commit).
 */
export function useTrajectoryAvailable(ctx: ClientContext | undefined): boolean {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    if (ctx === undefined) return undefined
    const slots = ctx.slots
    const snapshot = (slots.snapshot as unknown as
      (this: unknown, key: string) => readonly { occupants?: readonly { id?: string }[] }[])
      .bind(slots)
    const subscribe = (slots.subscribe as unknown as
      (this: unknown, key: string, fn: () => void) => () => void)
      .bind(slots)
    const read = (): void => {
      const node = snapshot('conversation.view')[0]
      setAvailable(node?.occupants?.some(occupant => occupant.id === 'trajectory') === true)
    }
    read()
    const off = subscribe('conversation.view', read)
    return () => { off() }
  }, [ctx])
  return available
}

/**
 * Resolve the bridged session's outward face, materializing with the runtime
 * window the same way usePendingCount does: poll until the binding exists,
 * then follow the list so a teardown (engine restart, session removal) drops
 * the stale face.
 */
function useSessionFace(ctx: ClientContext | undefined, sessionId: string): SessionFace | undefined {
  const [session, setSession] = useState<SessionFace | undefined>(undefined)
  useEffect(() => {
    if (ctx === undefined) return undefined
    setSession(undefined)
    let offList: (() => void) | undefined
    // Attach once immediately, then retry on the interval until the runtime
    // window knows the session (the useSessionBridge retry cadence); the
    // interval self-clears on the first successful attach.
    const attach = (): boolean => {
      const sessions = ctx.sessions as unknown as ISessions
      const binding = sessions.binding(sessionId as SessionId)
      if (binding === undefined) return false
      setSession(binding.session)
      offList = sessions.list.subscribe(() => {
        if (sessions.binding(sessionId as SessionId) === undefined) setSession(undefined)
      })
      return true
    }
    const attached = attach()
    const timer = setInterval(() => { if (attached || attach()) clearInterval(timer) }, 1500)
    return () => {
      clearInterval(timer)
      offList?.()
    }
  }, [ctx, sessionId])
  return session
}

/**
 * The plugin-shaped `loadOlder`: extend the history window backwards and
 * report whether the trajectory view actually grew (the affordance stays
 * honest when a page loads nothing new). Probes the session snapshot
 * identity — 0.1.5 faces expose no per-view table, so the whole snapshot
 * reference is the growth signal.
 */
export function trajectoryLoadOlder(session: SessionFace): () => Promise<boolean> {
  return async (): Promise<boolean> => {
    const before = session.getSnapshot()
    await session.loadOlder()
    return session.getSnapshot() !== before
  }
}

/**
 * The SidePanel trajectory surface: the shipped view over the bridged
 * session, or a quiet loading strip while the runtime window materializes.
 * Callers wrap it in the shell's slot error boundary, so a view crash
 * degrades to the quiet notice instead of taking the panel down.
 */
export function TrajectoryHost({ ctx, sessionId }: { ctx: ClientContext | undefined; sessionId: string }): JSX.Element {
  const session = useSessionFace(ctx, sessionId)
  // Dictionary registration is the plugin's own apply (ctx.locale.register(NS, ...));
  // binding the namespace hands the view the same localized toolbar the
  // desktop renders, following the active locale at call time. The read is
  // guarded: the cordis traceable proxy throws for service reads outside the
  // reader's declared inject (the shell's sessionLogDownload guarded-read
  // precedent), and the zh fallback keeps the view usable regardless.
  const t = useMemo(() => {
    if (ctx === undefined) return undefined
    try {
      return ctx.locale.bind('trajectory')
    } catch {
      return fallbackTrajectoryT
    }
  }, [ctx])
  const duration = useMemo(() => trajectoryDurationStore(), [])
  const subscribeSession = useMemo(
    () => session === undefined ? undefined : (fn: () => void) => session.subscribe(fn),
    [session],
  )
  // The framework binds selector hooks over this exact observable for
  // conversation.view entries; every selector TrajectoryView hands in returns
  // a stable reference between publishes, so a raw uSES pairing is faithful.
  // The face snapshot is a SessionSnapshot; the fork's props cast below owns
  // the mismatch (the consumed selector subset is interaction-faithful).
  const useSession = useMemo(
    () =>
      session === undefined || subscribeSession === undefined
        ? undefined
        : function useSession<T>(selector: (snapshot: ConversationSnapshot) => T): T {
          return useSyncExternalStore(
            subscribeSession,
            () => selector(session.getSnapshot() as unknown as ConversationSnapshot),
          )
        },
    [session, subscribeSession],
  )
  const useDuration = useMemo(
    // The store's subscribe face is a closure (not this-dependent); the arrow
    // wrapper keeps the unbound-method rule quiet without changing behavior.
    () => function useDuration<T>(selector: (value: boolean) => T): T {
      return useSyncExternalStore(fn => duration.subscribe(fn), () => selector(duration.getSnapshot()))
    },
    [duration],
  )
  // The plugin's own inject shape: `trajectoryLoadOlder` above.
  const loadOlder = useMemo(
    () => session === undefined ? undefined : trajectoryLoadOlder(session),
    [session],
  )
  // 0.1.5 TrajectoryView reads the assembled ledger through useTrajectory —
  // the uiConversation binding's 'trajectory' target. Bound per session when
  // the conversation machinery is composed; without it the host shows the
  // loading strip (the ledger cannot be derived client-side).
  const useTrajectory = useMemo(() => {
    if (ctx === undefined || session === undefined) return undefined
    try {
      const uiConversation = (ctx as unknown as {
        uiConversation?: {
          binding(id: string): {
            target(key: string): {
              getSnapshot(): TrajectorySnapshot | undefined
              subscribe(listener: () => void): () => void
            }
          }
        }
      }).uiConversation
      if (uiConversation === undefined) return undefined
      const target = uiConversation.binding(sessionId).target('trajectory')
      if (target === undefined) return undefined
      return function useTrajectory<T>(selector: (snapshot: TrajectorySnapshot) => T): T {
        return useSyncExternalStore(
          fn => target.subscribe(fn),
          () => selector(target.getSnapshot() ?? EMPTY_TRAJECTORY_SNAPSHOT),
        )
      }
    } catch {
      return undefined
    }
  }, [ctx, session, sessionId])

  if (
    ctx === undefined || t === undefined || session === undefined
    || useSession === undefined || loadOlder === undefined || useTrajectory === undefined
  ) {
    return <div className="dshx-trajectory dshx-trajectory--loading">轨迹加载中…</div>
  }
  const props = {
    sessionId: sessionId as SessionId,
    useSession,
    useTrajectory,
    useDuration,
    loadOlder,
    setActualDuration: (value: boolean) => { duration.set(value) },
    inspect: null,
    onInspectDone: () => {},
    t,
  } as unknown as TrajectoryViewProps
  return (
    <div className="dshx-trajectory">
      {/* Keyed per session: a boundary flip never survives a session switch. */}
      <TrajectoryViewBoundary key={sessionId}>
        <TrajectoryView {...props} />
      </TrajectoryViewBoundary>
    </div>
  )
}
