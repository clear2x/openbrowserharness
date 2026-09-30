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
  const items = await storageGet([PREFIX]).catch(() => EMPTY_RECORD)
  // chrome.storage.get with a bare prefix is not a prefix query; enumerate via
  // the single index key holding the roster instead.
  const roster = Array.isArray(items[PREFIX]) ? (items[PREFIX] as string[]) : []
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

  // Seed shipped skills once per revision; async, never blocks provider boot.
  void ensureShippedSkills()

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
      persist: {
        async write(input) {
          await writeStoredSkill({
            name: input.name,
            description: input.description,
            ...(input.whenToUse !== undefined && input.whenToUse !== '' ? { whenToUse: input.whenToUse } : {}),
            content: input.content,
          })
        },
        async remove(name) {
          await removeStoredSkill(name)
        },
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

/**
 * Skills shipped with the extension and seeded into the roster on boot.
 * Bump a skill's `revision` to re-seed it after edits; a user deletion sticks
 * because the revision marker outlives the roster entry.
 */
const SHIPPED_SKILLS: ReadonlyArray<{ revision: number; record: StoredSkill }> = [
  {
    revision: 1,
    record: {
      name: 'site-distill',
      description: '炼化站点：深度勘探一个网站的功能面与数据端点，沉淀成可复用的站点技能，后续任务直接按配方执行。',
      whenToUse: '用户要求「炼化/摸清/分析」某网站，或同一站点预期会反复执行任务时；输入是站点入口 URL（可选：要炼化的功能清单）。',
      content: `# 炼化站点（site-distill）

把一个网站炼化成可复用的技能资产：摸清功能面与数据端点，沉淀成一份站点技能。之后所有涉及该站点的任务直接按配方执行——一次 page_evaluate 直达数据，不再逐页摸索，大幅提速并节省 token。

## 第一步：勘探（收集证据）
1. 用 tabs_open 打开站点入口（或 tabs_switch 切到已打开的该站标签页）。
2. 立即 \`page_network\` \`{"action":"start","tab_id":<id>}\` 开始捕获。
3. 像用户一样把目标功能各操作一遍：打开列表页、执行一次搜索、进入一个详情页、翻一页……每步之间用 page_snapshot 确认页面状态（选择器同时记下来，作为 DOM 兜底配方）。
4. \`page_network\` \`{"action":"read","tab_id":<id>,"resource_type":"XHR"}\` 读取捕获（必要时补 Fetch/Document 类型）。重点识别：
   - 数据端点：方法（GET/POST）+ URL 模板 + 查询参数；响应字节在数 KB 以上的 XHR/Fetch 通常是数据接口；
   - POST 请求看 body 行，记录参数结构；
   - 忽略图片/字体/统计埋点。
5. 验证端点：用 page_evaluate 执行一次式 async fetch 片段确认返回可读 JSON（cookie 会自动携带；POST 端点带上 method/body）：
   \`\`\`
   const r = await fetch('端点URL?参数=值'); return await r.json()
   \`\`\`
6. 结束用 \`page_network\` \`{"action":"read","tab_id":<id>,"stop":true}\` 读完并停止捕获。

## 第二步：综合（一页纸能力清单）
把证据整理成：
- **端点速查**：能力名 → 方法 + URL 模板 + 关键参数 + 响应关键字段；
- **DOM 兜底配方**：端点不可用/反爬时的页面操作路径（用 page_snapshot 里验证过的 selector）；
- **前置条件**：登录态依赖（哪个 cookie）、翻页参数规律、频率限制等注意事项。

## 第三步：锻件（写入技能）
用 skill_write（action="write"）写入，name 规则 \`site-<域名中>-\` 用连字符连接（如 \`site-bilibili\`），description 写明站点与用途，content 按「能力清单」骨架组织，每个能力给出：
- 完整可复制的 page_evaluate fetch 片段（或 DOM 步骤序列）；
- 端点与参数说明；返回关键字段。
同名写入即更新。安全边界：**不要**把密码、cookie 值、token 字面量写进技能内容——登录态依赖 cookie 本身，配方里只写「需要登录态」。

## 第四步：回炉（真机验证）
对每个 fetch 配方在真站执行一次 page_evaluate 验证返回可用；失败配方先修参数，修不动就降级为 DOM 步骤并注明原因。全部验证后向用户汇报：炼化了哪些能力、技能名是什么、后续同类任务如何直接引用（skill 工具加载后照配方执行）。

## 注意
- 捕获期间只做与目标功能相关的操作，避免把无关流量搅进缓冲。
- 端点有签名/时效参数时，记录「参数从哪来」（页面状态/另一端点），并优先沉淀 DOM 兜底配方。
- 单次炼化聚焦一个站点；用户没指定功能清单时，炼化主路径（搜索/列表/详情/登录态读取）即可，并在汇报里建议下一步可炼化的功能。`,
    },
  },
]

/** Storage key holding the per-skill seeded revision marker. */
const SEED_KEY = 'dsh-skill-seed-revisions'

/** Shipped-skill revisions, exported for the seeding spec's assertions. */
export const SHIPPED_SKILL_REVISIONS: Readonly<Record<string, number>> = Object.fromEntries(
  SHIPPED_SKILLS.map(shipped => [shipped.record.name, shipped.revision]),
)

/**
 * Seed shipped skills into the roster. Idempotent: a skill seeds once per
 * revision; deleting the skill afterwards sticks until the revision bumps.
 */
export async function ensureShippedSkills(): Promise<void> {
  try {
    const stored = await storageGet([SEED_KEY]).catch(() => EMPTY_RECORD)
    const revisions: Record<string, unknown> = { ...((stored[SEED_KEY] as Record<string, unknown> | undefined) ?? {}) }
    let changed = false
    for (const shipped of SHIPPED_SKILLS) {
      if (revisions[shipped.record.name] === shipped.revision) continue
      await writeStoredSkill(shipped.record)
      revisions[shipped.record.name] = shipped.revision
      changed = true
    }
    if (changed) await storageSet({ [SEED_KEY]: revisions })
  } catch (err) {
    // Seeding is a convenience; a storage outage must not break provider boot.
    console.warn('[dsh-skill-storage] 预置技能写入失败：', err instanceof Error ? err.message : String(err))
  }
}

export async function removeStoredSkill(skillName: string): Promise<void> {
  const key = `${PREFIX}${skillName}`
  const stored = await storageGet([PREFIX]).catch(() => EMPTY_RECORD)
  const roster = ((stored[PREFIX] as string[] | undefined) ?? []).filter(entry => entry !== key)
  await storageRemove([key])
  await storageSet({ [PREFIX]: roster })
}
