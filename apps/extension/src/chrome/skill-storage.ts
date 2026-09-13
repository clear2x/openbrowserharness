/**
 * `chrome-skill-storage`: a dsh skill provider backed by chrome.storage
 * (through the SW-routed storage client), so users can add skills in the
 * extension and the model/user `/name` invocation flows work exactly as on
 * the Node host (catalog injection + skill tool via dsh-tool-skill).
 *
 * Skill record layout (one storage key per skill, prefix `dsh-skill:`):
 *   { name: kebab-case, description, whenToUse?, modelInvocable, userInvocable,
 *     content: markdown }
 * Frontmatter-less convenience: a record may also be a bare markdown string
 * with `---\nname: x\ndescription: y\n---` frontmatter (the filesystem
 * provider's authoring shape), parsed on read.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SkillCandidate, SkillDefinition, SkillProvider } from '@deepseek-ai/dsh-skill'
import { onStorageChanged, storageGet, storageRemove, storageSet } from './storage-client'

const PREFIX = 'dsh-skill:'
const RANK = 300

/** Serialized skill record. */
export interface StoredSkill {
  name: string
  description: string
  whenToUse?: string
  modelInvocable?: boolean
  userInvocable?: boolean
  content: string
}

export const name = 'chrome-skill-storage'
export const inject = ['skills']

export interface Config {}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Normalize one stored record into provider candidates; invalid → skipped. */
function toCandidate(record: StoredSkill, key: string): SkillCandidate | undefined {
  if (typeof record.name !== 'string' || !KEBAB.test(record.name)) return undefined
  if (typeof record.description !== 'string' || record.description.trim() === '') return undefined
  if (typeof record.content !== 'string' || record.content.trim() === '') return undefined
  return {
    name: record.name,
    description: record.description,
    ...(typeof record.whenToUse === 'string' && record.whenToUse !== '' ? { whenToUse: record.whenToUse } : {}),
    invocation: {
      modelInvocable: record.modelInvocable !== false,
      userInvocable: record.userInvocable !== false,
    },
    source: 'custom',
    provider: 'chrome-storage',
    rank: RANK,
    locator: key,
  }
}

/** Parse a bare markdown string with optional frontmatter into a record. */
function parseMarkdownSkill(text: string, fallbackName: string): StoredSkill {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  const front: Record<string, string> = {}
  let body = text
  if (match !== null) {
    body = text.slice(match[0].length)
    for (const line of (match[1] ?? '').split('\n')) {
      const idx = line.indexOf(':')
      if (idx === -1) continue
      front[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    }
  }
  return {
    name: front.name ?? fallbackName,
    description: front.description ?? '（无描述）',
    ...(front.whenToUse !== undefined ? { whenToUse: front.whenToUse } : {}),
    ...(front['disable-model-invocation'] === 'true' ? { modelInvocable: false } : {}),
    ...(front['disable-user-invocation'] === 'true' ? { userInvocable: false } : {}),
    content: body.trim(),
  }
}

/** Shared typed empty record: the storage-miss fallback keeps indexing legal. */
const EMPTY_RECORD: Record<string, unknown> = {}

async function readAllSkills(): Promise<Array<{ key: string; record: StoredSkill }>> {
  const items = await storageGet([`${PREFIX}`]).catch(() => EMPTY_RECORD)
  // chrome.storage.get with a bare prefix is not a prefix query; enumerate via
  // the single index key holding the roster instead.
  const roster = Array.isArray(items[`${PREFIX}`]) ? (items[`${PREFIX}`] as string[]) : []
  if (roster.length === 0) return []
  const detailed = await storageGet(roster.map(key => key)).catch(() => EMPTY_RECORD)
  const out: Array<{ key: string; record: StoredSkill }> = []
  for (const key of roster) {
    const raw = detailed[key]
    if (typeof raw === 'string') {
      out.push({ key, record: parseMarkdownSkill(raw, key.slice(PREFIX.length)) })
    } else if (raw !== null && typeof raw === 'object') {
      out.push({ key, record: raw as StoredSkill })
    }
  }
  return out
}

export function apply(ctx: Context, _config: Config): void {
  void _config

  const disposeProvider = ctx.skills.registerProvider((control) => {
    const provider: SkillProvider = {
      name: 'chrome-storage',
      async list() {
        const skills = await readAllSkills()
        return skills
          .map(({ key, record }) => toCandidate(record, key))
          .filter((candidate): candidate is SkillCandidate => candidate !== undefined)
      },
      async get(candidate: SkillCandidate): Promise<SkillDefinition | undefined> {
        const skills = await readAllSkills()
        const found = skills.find(entry => entry.key === candidate.locator || entry.record.name === candidate.name)
        if (found === undefined) return undefined
        const normalized = toCandidate(found.record, found.key)
        if (normalized === undefined) return undefined
        return { ...normalized, content: found.record.content }
      },
    }
    // Re-publish the catalog whenever the roster changes.
    onStorageChanged((area) => {
      if (area !== 'local') return
      control.invalidate()
    })
    return provider
  })

  ctx.effect(() => disposeProvider)
}

// ── management surface (consumed by the api-bridge / future options UI) ──

export async function listStoredSkills(): Promise<StoredSkill[]> {
  const skills = await readAllSkills()
  return skills.map(entry => entry.record)
}

export async function writeStoredSkill(record: StoredSkill): Promise<void> {
  if (!KEBAB.test(record.name)) {
    throw new Error(`技能名必须是小写 kebab-case：${record.name}`)
  }
  const key = `${PREFIX}${record.name}`
  const roster = new Set((await storageGet([PREFIX]).catch(() => EMPTY_RECORD))[PREFIX] as string[] | undefined ?? [])
  roster.add(key)
  await storageSet({ [key]: record, [PREFIX]: [...roster] })
}

export async function removeStoredSkill(skillName: string): Promise<void> {
  const key = `${PREFIX}${skillName}`
  const stored = await storageGet([PREFIX]).catch(() => EMPTY_RECORD)
  const roster = ((stored[PREFIX] as string[] | undefined) ?? []).filter(entry => entry !== key)
  await storageRemove([key])
  await storageSet({ [PREFIX]: roster })
}
