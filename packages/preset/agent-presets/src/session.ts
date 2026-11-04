/**
 * The session-log record of which preset a session actually runs.
 *
 * The creation header names the preset a session STARTED with, and it is
 * deep-frozen because that is a creation fact. A session may still change
 * preset while it is blank, and the effect of that change outlives the blank
 * window: the first turn — and every turn after it — runs under the newly
 * mounted composition. Recording the change is what keeps the log honest, and
 * it is required outright by the repo's model-visible ⟺ logged rule, since the
 * preset decides the tool schemas and prompt sections the model sees.
 *
 * Reconstruction reads the `agentPreset` Session projection, never the header
 * alone.
 * @module @deepseek-ai/dsh-agent-presets/session
 */

// The `agent-preset/selected` SessionEventMap member and this projection are
// owned by the upstream registry package now; the fork composition re-exports
// the single declaration so both event faces stay one.
export { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-preset-registry/src/session.ts'
