/**
 * Model-config rules engine (ported from ZCode's layered provider/model
 * knowledge base): ordered pattern rules that resolve a model id (plus the
 * route's wire protocol and base URL) into recommended model facts — context
 * window, output cap, image input, reasoning levels.
 *
 * Layer order is the whole engine: exact-ish id-pattern rules first come from
 * the seed order, each matching rule overlays its config leaves onto the
 * running result; later rules refine earlier ones. Matching is
 * `^(?:pattern)$` case-insensitive; base URLs normalize (host case, default
 * port, trailing slash) so they cannot change a hit.
 *
 * The bundled seed encodes audited facts about public model families and is
 * provider-agnostic (id-pattern and api-type layers only) — safe to apply to
 * any hand-declared route.
 */

import seedJson from './model-rules-seed.json'

/** One hand-declared supplier template: prefill facts for the add wizard. */
export interface ProviderTemplate {
  /** Stable template id (also a fine display fallback). */
  readonly id: string
  /** Chinese display name from the release. */
  readonly name: string
  /** English display name from the release. */
  readonly nameEn: string
  /** Wire protocol the template's endpoint speaks. */
  readonly apiType: string
  /** Conventional base URL for the endpoint. */
  readonly baseUrl: string
}

/** Supplier templates from the release, declaration order (ZCode parity). */
export const PROVIDER_TEMPLATES: readonly ProviderTemplate[] = seedJson.providerTemplates.map(template => ({
  id: template.id,
  name: template.name,
  nameEn: template.nameEn,
  apiType: template.apiType,
  baseUrl: template.baseUrl,
}))

/** One leaf-shaped rule as bundled: a match pattern plus a config overlay. */
interface ModelRuleSeed {
  modelMatch: string
  apiTypeMatch?: string
  baseUrlMatch?: string
  config: Record<string, unknown>
}

/** The recommendation surfaced to the add-model dialog. */
export interface ModelRecommendation {
  /** Context window in tokens. */
  contextWindow?: number
  /** Per-request output cap in tokens. */
  maxTokens?: number
  /** Image input support. */
  supportsImage?: boolean
  /** Selectable reasoning levels, provider-spelled, in display order. */
  reasoningLevels?: readonly string[]
}

/** The resolution input: the model id plus whatever route facts are known. */
export interface ModelRulesInput {
  modelId: string
  apiType?: string | undefined
  baseURL?: string | undefined
}

/** Rules that failed the compile guard, for diagnostics only. */
const skippedPatterns = new Set<string>()

/** Compile one anchored case-insensitive pattern; a non-compiling rule is skipped, never fatal. */
function compile(pattern: string): RegExp | undefined {
  try {
    return new RegExp(`^(?:${pattern})$`, 'i')
  } catch {
    skippedPatterns.add(pattern)
    return undefined
  }
}

const compiled: ReadonlyArray<{
  rule: ModelRuleSeed
  model: RegExp
  api: RegExp | undefined
  base: RegExp | undefined
}> = (() => {
  const rules: Array<{ rule: ModelRuleSeed; model: RegExp; api: RegExp | undefined; base: RegExp | undefined }> = []
  for (const rule of [...seedJson.modelRules, ...seedJson.modelApiRules]) {
    const record = rule as ModelRuleSeed
    if (typeof record.modelMatch !== 'string') continue
    const model = compile(record.modelMatch)
    if (model === undefined) continue
    rules.push({
      rule: record,
      model,
      api: typeof record.apiTypeMatch === 'string' ? compile(record.apiTypeMatch) : undefined,
      base: typeof record.baseUrlMatch === 'string' ? compile(record.baseUrlMatch) : undefined,
    })
  }
  return rules
})()

/** Normalize a base URL the way rule matching expects: trailing slashes off, search/hash preserved. */
export function normalizeBaseURLForRuleMatch(value: string): string | undefined {
  try {
    const parsed = new URL(value)
    const suffix = `${parsed.search}${parsed.hash}`
    const serialized = parsed.toString()
    const endpoint = suffix.length === 0 ? serialized : serialized.slice(0, -suffix.length)
    return `${endpoint.replace(/\/+$/, '')}${suffix}`
  } catch {
    return undefined
  }
}

/** Deep-merge JSON leaves: scalars and arrays replace, plain objects recurse. */
function overlayLeaf(base: unknown, next: unknown): unknown {
  if (typeof base !== 'object' || base === null || Array.isArray(base)
    || typeof next !== 'object' || next === null || Array.isArray(next)) {
    return next === undefined ? base : next
  }
  const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(next as Record<string, unknown>)) {
    merged[key] = overlayLeaf(merged[key], value)
  }
  return merged
}

/**
 * Resolve the recommendation for one model id on the given route. Returns
 * `undefined` when no rule matched (the dialog keeps its own defaults).
 */
export function resolveModelRecommendation(input: ModelRulesInput): ModelRecommendation | undefined {
  const modelId = input.modelId.trim()
  if (modelId === '') return undefined
  const baseURL = input.baseURL === undefined || input.baseURL === ''
    ? undefined
    : normalizeBaseURLForRuleMatch(input.baseURL)
  let config: Record<string, unknown> = {}
  for (const { rule, model, api, base } of compiled) {
    if (!model.test(modelId)) continue
    if (api !== undefined) {
      if (input.apiType === undefined || input.apiType === '' || !api.test(input.apiType)) continue
    }
    if (base !== undefined) {
      if (baseURL === undefined || !base.test(baseURL)) continue
    }
    config = overlayLeaf(config, rule.config) as Record<string, unknown>
  }
  if (Object.keys(config).length === 0) return undefined
  const recommendation: ModelRecommendation = {}
  const properties = (config['properties'] ?? {}) as Record<string, unknown>
  if (typeof properties['contextWindow'] === 'number') recommendation.contextWindow = properties['contextWindow']
  const inputFormat = properties['inputFormat'] as Record<string, unknown> | undefined
  if (inputFormat?.['supportsImage'] === true) recommendation.supportsImage = true
  const optionSpecs = (config['optionSpecs'] ?? {}) as Record<string, unknown>
  const maxOutput = optionSpecs['maxOutputTokens'] as { max?: unknown } | undefined
  if (typeof maxOutput?.['max'] === 'number') recommendation.maxTokens = maxOutput['max']
  const reasoning = optionSpecs['reasoningLevel'] as { values?: unknown } | undefined
  if (Array.isArray(reasoning?.['values'])) {
    recommendation.reasoningLevels = reasoning['values'].filter(
      (value): value is string => typeof value === 'string',
    )
  }
  return recommendation
}
