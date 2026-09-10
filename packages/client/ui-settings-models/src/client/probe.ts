/**
 * Endpoint probe shared by every panel: one `llm.discoverModels` round trip
 * against what the form currently shows — including a key typed but not yet
 * stored — so "test availability" answers the draft, never a saved profile
 * behind it. The outcome is reported upward as well, because the provider rail
 * paints the same verdict on its status dot.
 * @module @deepseek-ai/dsh-client-ui-settings-models/probe
 */

import { useCallback, useState } from 'react'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { messageOf } from './store.ts'

/** The request a probe sends, exactly the wire face's optional shape. */
export interface ProbeRequest {
  /** Settings namespace whose adapter family serves the endpoint. */
  settingsNs: string
  /**
   * Saved route id, when the panel edits one. The host may answer from its own
   * registry for such a route when no baseURL travels, and attaches the route's
   * stored custom headers to a live interrogation.
   */
  provider?: string
  /** Endpoint as the form currently shows it. */
  baseURL?: string
  /** Wire protocol (`openai` | `anthropic`) as the form currently names it. */
  api?: string
  /** Key typed into the form and not yet stored, when there is one. */
  apiKey?: string
}

/** Probe lifecycle of one panel, rendered verbatim under the fields. */
export type ProbeState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'ok'; count: number }
  | { kind: 'failed'; message: string }

/** What the owning panel reports back so the rail dot can follow the verdict. */
export type ProbeSummary = Extract<ProbeState, { kind: 'ok' | 'failed' }>

/**
 * Bundle the in-flight guard and the wire call, keeping panels free of the
 * transport failure handling (a rejected call must end the busy state with a
 * readable message, never leave the button spinning).
 * @param api - wire face carrying the llm domain.
 * @returns `[state, run]`; `run` resolves after the state has settled.
 */
export function useEndpointProbe(
  api: Pick<IApiClient, 'llm'>,
): readonly [ProbeState, ((request: ProbeRequest) => Promise<ProbeSummary>) ] {
  const [state, setState] = useState<ProbeState>({ kind: 'idle' })
  const run = useCallback(async (request: ProbeRequest): Promise<ProbeSummary> => {
    setState({ kind: 'busy' })
    try {
      const response = await api.llm.discoverModels(request)
      if (!response.result.ok) {
        const failed: ProbeSummary = { kind: 'failed', message: response.result.error.message }
        setState(failed)
        return failed
      }
      const ok: ProbeSummary = { kind: 'ok', count: response.result.value.models.length }
      setState(ok)
      return ok
    } catch (error) {
      // A transport rejection (disconnect) refuses rather than answering; it
      // must settle the same way a business rejection does.
      const failed: ProbeSummary = { kind: 'failed', message: messageOf(error) }
      setState(failed)
      return failed
    }
  }, [api])
  return [state, run] as const
}
