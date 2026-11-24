/**
 * Locale keys for the shipped agent presets' display name and description,
 * keyed by preset id. The roster (`shared/shipped-agent-presets.ts`) carries
 * the zh wording only; a user-authored preset has no entry and renders its
 * stored text.
 *
 * @module extension-shell-locales-preset-labels
 */
import type { ShellLocaleKey, ShellTranslate } from './index.ts'

/** Dictionary keys of one shipped preset's display name and description. */
export interface AgentPresetLabelKeys {
  readonly nameKey: ShellLocaleKey
  readonly descriptionKey: ShellLocaleKey
}

/** Dictionary keys of each shipped preset, by preset id. */
export const AGENT_PRESET_LABEL_KEYS: Readonly<Record<string, AgentPresetLabelKeys>> = {
  standard: { nameKey: 'presetLabel.standard.name', descriptionKey: 'presetLabel.standard.description' },
  ptc: { nameKey: 'presetLabel.ptc.name', descriptionKey: 'presetLabel.ptc.description' },
  minimal: { nameKey: 'presetLabel.minimal.name', descriptionKey: 'presetLabel.minimal.description' },
  cordis: { nameKey: 'presetLabel.cordis.name', descriptionKey: 'presetLabel.cordis.description' },
  'web-research': { nameKey: 'presetLabel.webResearch.name', descriptionKey: 'presetLabel.webResearch.description' },
  'page-monitor': { nameKey: 'presetLabel.pageMonitor.name', descriptionKey: 'presetLabel.pageMonitor.description' },
  'dev-probe': { nameKey: 'presetLabel.devProbe.name', descriptionKey: 'presetLabel.devProbe.description' },
  'stock-watcher': { nameKey: 'presetLabel.stockWatcher.name', descriptionKey: 'presetLabel.stockWatcher.description' },
  'bilibili-assistant': { nameKey: 'presetLabel.bilibiliAssistant.name', descriptionKey: 'presetLabel.bilibiliAssistant.description' },
}

/**
 * The display name of a preset row in the active locale.
 * @param t - the shell translate.
 * @param preset - a roster row (a shipped preset reads the dictionary, any other row its stored name).
 * @returns the localized name, the stored name, or the id when the row carries none.
 */
export function agentPresetName(
  t: ShellTranslate,
  preset: { readonly id: string; readonly name?: string | undefined },
): string {
  const keys = AGENT_PRESET_LABEL_KEYS[preset.id]
  return keys === undefined ? preset.name ?? preset.id : t(keys.nameKey)
}

/**
 * The description of a preset row in the active locale.
 * @param t - the shell translate.
 * @param preset - a roster row.
 * @returns the localized description of a shipped preset, else the stored one.
 */
export function agentPresetDescription(
  t: ShellTranslate,
  preset: { readonly id: string; readonly description?: string | undefined },
): string | undefined {
  const keys = AGENT_PRESET_LABEL_KEYS[preset.id]
  return keys === undefined ? preset.description : t(keys.descriptionKey)
}
