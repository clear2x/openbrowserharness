/**
 * Companion-watch session state (the Sense Now loop's extension port): one
 * watch session at a time, agent-driven — every `watch` tool call captures a
 * bounded round and returns; the agent re-calls to keep watching (the queue
 * model replaces Sense Now's blocking watch). Pure bookkeeping — no chrome.
 *
 * @module sense-now/session
 */

import type { FrameGrid, WatchPace } from './grid.ts'

/** One live companion-watch session. */
export interface SenseWatchSession {
  sessionId: string
  /** The window the frames ride on (the user's active window at start). */
  windowId: number | undefined
  pace: WatchPace
  startedAt: number
  lastCaptureAt: number
  /** The most recent capture's grid (the diff base). */
  lastGrid: FrameGrid | undefined
  /** Frames kept since session start. */
  keptTotal: number
  /** Watch rounds completed (tool calls consumed). */
  rounds: number
}

/** The single-session watch registry (Sense Now watches one screen). */
export class SenseWatchSessions {
  private readonly sessions = new Map<string, SenseWatchSession>()
  private sequence = 0

  /**
   * Start (or resume) the watch session. An existing session keeps its id
   * and start time; a pace argument updates it in place.
   * @param windowId - the capture window, when known.
   * @param pace - the requested pace (undefined keeps the current one).
   * @returns the live session.
   */
  start(windowId: number | undefined, pace: WatchPace | undefined): SenseWatchSession {
    const existing = this.sessions.values().next().value
    if (existing !== undefined) {
      existing.windowId = windowId ?? existing.windowId
      if (pace !== undefined) existing.pace = pace
      return existing
    }
    this.sequence += 1
    const session: SenseWatchSession = {
      sessionId: `watch-${String(this.sequence).padStart(4, '0')}`,
      windowId,
      pace: pace ?? 'normal',
      startedAt: Date.now(),
      lastCaptureAt: 0,
      lastGrid: undefined,
      keptTotal: 0,
      rounds: 0,
    }
    this.sessions.set(session.sessionId, session)
    return session
  }

  /**
   * Fetch one session.
   * @param sessionId - the session id.
   * @returns the session, or undefined when stopped/absent.
   */
  get(sessionId: string): SenseWatchSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * The live session, when one exists.
   * @returns the single active session or undefined.
   */
  active(): SenseWatchSession | undefined {
    return this.sessions.values().next().value
  }

  /**
   * Stop one session.
   * @param sessionId - the session id.
   * @returns whether a live session was removed.
   */
  stop(sessionId: string): boolean {
    return this.sessions.delete(sessionId)
  }
}
