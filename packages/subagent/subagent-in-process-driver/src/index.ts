/**
 * Thin one-shot entry over the activation manager for in-process subagent runs.
 * The manager owns child materialization, prompt delivery, settlement capture,
 * structured output, and disposal; this module only maps its caller-facing
 * activation receipt onto the provider-run shape the in-process backends hand
 * to direct callers.
 *
 * The selected provider must be a continuable-creation provider registered on
 * `ctx.subagents` (the shipped in-process spawn and fork backends are); a
 * provider's `prepareContinuable` supplies any seed, and the manager's
 * `outputSchema` runtime captures `SubagentResult.structured`.
 *
 * @module @deepseek-ai/dsh-subagent-in-process-driver
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import type {
  SubagentRun,
  SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'

/** The caller-facing start request, unchanged from the subagent seam's shape. */
export type InProcessStartRequest = SubagentStartRequest

/** One managed run plus the child Agent the manager published for it. */
export type InProcessSubagentRun = SubagentRun & { readonly localAgent: Agent }

/** Options the direct caller supplies to select a registered backend. */
export interface InProcessRunOptions {
  /** Registered `ctx.subagents` provider name; defaults to `spawn`. */
  readonly provider?: string
}

/**
 * Start one one-shot in-process child through the activation manager and map
 * its receipt onto a published run. The child is resident when this resolves;
 * the manager disposes it at natural settlement, so `result` settling already
 * implies the run's resources were released and `localAgent` is no longer live
 * in the registry. `dispose` before settlement cancels the child instead.
 * @param request - the trusted typed start request, including its required signal.
 * @param options - the registered provider to run on.
 * @returns a manager-owned run.
 * @throws {SubagentError} `CONTINUATION_UNAVAILABLE` when the parent's context
 *   carries no subagent runtime, or any start rejection the seam reports
 *   (provider absence, capability, depth, cancellation).
 */
export async function startInProcessRun(
  request: InProcessStartRequest,
  options: InProcessRunOptions = {},
): Promise<InProcessSubagentRun> {
  const provider = options.provider ?? 'spawn'
  const parent = request.parent
  const subagents = parent.ctx.get('subagents')
  if (subagents === undefined) {
    throw new SubagentError(
      'in-process subagent runs require the subagent runtime (load @deepseek-ai/dsh-subagent)',
      'CONTINUATION_UNAVAILABLE',
    )
  }
  const activation = await subagents.startActivation({
    provider,
    label: request.label ?? provider,
    prompt: request.prompt,
    parent,
    signal: request.signal,
    delivery: 'caller',
    ...request.cwd !== undefined ? { cwd: request.cwd } : {},
    ...request.agentPreset !== undefined ? { agentPreset: request.agentPreset } : {},
    ...request.agentOptions !== undefined ? { agentOptions: request.agentOptions } : {},
    ...request.outputSchema !== undefined ? { outputSchema: request.outputSchema } : {},
    ...request.maxDepth !== undefined ? { maxDepth: request.maxDepth } : {},
  })
  const localAgent = parent.ctx.get('agents')?.get(activation.childId)
  if (localAgent === undefined) {
    throw new SubagentError(
      `the activation manager published no resident agent for "${activation.childId}"`,
      'CHILD_AGENT_MISSING',
    )
  }
  return {
    id: activation.childId,
    localAgent,
    result: activation.result,
    dispose: (): Promise<void> => activation.dispose(),
  }
}
