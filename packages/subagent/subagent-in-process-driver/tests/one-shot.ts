/** Shared request helpers for the in-process driver specs. */
import { SUBAGENT_DESCRIPTOR_VERSION, type SubagentDescriptorData } from '@deepseek-ai/dsh-subagent'

/**
 * The one-shot descriptor the driver appends inside the child's initial turn.
 * `snapshotSubagentDescriptor` is the continuable path only, so a one-shot
 * payload is stamped directly.
 * @param provider - the registering provider's name.
 * @param label - the delegation's short task label.
 * @returns the versioned one-shot descriptor payload.
 */
export function oneShotDescriptor(provider: string, label: string): SubagentDescriptorData {
  return { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'one-shot', provider, label }
}
