/**
 * `chrome-skill-write`: exposes the chrome.storage skill roster to the MODEL
 * as an authoring tool. The `skill` loader tool is read-only by design, and
 * the `skill.write` / `skill.remove` RPC surface only serves the SidePanel —
 * without this registration the model has no way to author a skill on
 * request ("记住这套流程" / "把这条沉淀为技能" dead-ends). Handlers delegate
 * to the same {@link writeStoredSkill} / {@link removeStoredSkill} the bridge
 * resolves, so every lane shares one roster and one refresh path.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { removeStoredSkill, writeStoredSkill } from '../chrome/skill-storage.ts'

/** Tools carry no config today; the seam exists for a future quota policy. */
export interface Config {}

/** Accessing ctx.tools requires the dependency to be declared (cordis gate). */
export const inject = ['tools']

export const name = 'chrome-skill-write'

/** Validated, host-shaped authoring record derived from the model arguments. */
interface SkillWriteRecord {
  name: string
  description: string
  content: string
  whenToUse?: string
  modelInvocable?: boolean
  userInvocable?: boolean
}

export function apply(ctx: Context, _config: Config): void {
  void _config

  ctx.tools.register(defineTool({
    name: 'skill_write',
    description: [
      '创建、更新或删除一个可复用技能（chrome.storage 名册，写入后热加载进 skill 目录）。',
      'action="write" 需要 name（小写 kebab-case）、description（一句话说明何时使用）与 content（完整 Markdown 指令正文）；同名即更新。',
      'action="remove" 只需要 name。写入后技能目录自动刷新，模型可在后续回合用 `skill` 工具加载该技能。',
    ].join('\n'),
    parameters: {
      action: { type: 'string', required: true, description: '"write"（创建/更新）或 "remove"（删除）。' },
      name: { type: 'string', required: true, description: '技能名，小写 kebab-case。' },
      description: { type: 'string', description: 'action=write 时必填：一句话说明技能何时使用。' },
      content: { type: 'string', description: 'action=write 时必填：完整 Markdown 指令正文。' },
      whenToUse: { type: 'string', description: '可选：更细的使用时机说明。' },
      modelInvocable: { type: 'boolean', description: '可选：模型可否自主加载，默认 true。' },
      userInvocable: { type: 'boolean', description: '可选：用户可否以 /name 调用，默认 true。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          name: { type: 'string', required: true },
          written: { type: 'boolean' },
          removed: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.action === 'remove'
          ? `技能 ${value.name} 已删除。`
          : `技能 ${value.name} 已写入并热加载，可在技能目录中看到。`,
      }],
    },
    async execute(args) {
      const action = typeof args.action === 'string' ? args.action : ''
      const name = typeof args.name === 'string' ? args.name : ''
      if (action !== 'write' && action !== 'remove') {
        throw new Error('skill_write：action 必须是 "write" 或 "remove"')
      }
      if (!isSkillName(name)) {
        throw new Error('skill_write：name 必须是小写 kebab-case')
      }
      if (action === 'remove') {
        await removeStoredSkill(name)
        return { action: 'remove', name, removed: true }
      }
      const description = typeof args.description === 'string' ? args.description.trim() : ''
      const content = typeof args.content === 'string' ? args.content : ''
      if (description === '') throw new Error('skill_write：action=write 时 description 必填且不能为空白')
      if (content.trim() === '') throw new Error('skill_write：action=write 时 content 必填且不能为空白')
      const record: SkillWriteRecord = { name, description, content }
      if (typeof args.whenToUse === 'string' && args.whenToUse !== '') record.whenToUse = args.whenToUse
      if (args.modelInvocable === false) record.modelInvocable = false
      if (args.userInvocable === false) record.userInvocable = false
      await writeStoredSkill(record)
      return { action: 'write', name, written: true }
    },
    presentCall: args => ({
      card: 'generic',
      title: args.action === 'remove' ? '删除技能' : '写入技能',
      kind: args.action === 'remove' ? 'delete' : 'edit',
    }),
  }))
}
