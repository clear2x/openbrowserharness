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
      name: 'site-remix',
      description: '改造当前网站：按需求实时注入样式/布局/交互定制（油猴脚本式），即时看效果，满意可保存为站点配方供下次一键重放。',
      whenToUse: '用户要求「改造/美化/定制当前网页」——去干扰元素、暗色模式、布局重排、隐藏模块、加快捷增强等；输入是改动需求（默认当前标签页）。',
      content: `# 改造当前网站（site-remix）

按用户需求定制当前标签页里的网站：实时注入 CSS/DOM 改动，即时看效果、逐步迭代；满意后保存成「站点配方」，以后一句话或一条斜杠就能重放。油猴脚本的工作方式，但配方由 Agent 生成与管理。

## 硬性边界
- 只动当前页面的 DOM、CSS 与前端交互行为；**不给站点注入对外请求**、不上传页面数据、不改后端语义。
- 用户凭据（cookie/token/表单值）绝不写入配方或任何输出。
- 注入只作用于当前标签页（刷新即还原）；持久化靠第四步的配方保存，重放即恢复效果。

## 第一步：现状勘探
1. page_snapshot 读当前页面结构，定位要改的区块与选择器（改前先记原样，便于还原）。
2. 需求含糊时先给 1-2 个方案让用户挑（例：信息流去噪 / 暗色 / 加宽正文），确认再动手。

## 第二步：实时应用
样式类改动用 page_evaluate 注入托管样式节点（幂等：先移除旧节点再注入，可反复执行）：

\`\`\`
(() => {
  document.getElementById('obh-remix')?.remove()
  const style = document.createElement('style')
  style.id = 'obh-remix'
  style.textContent = [
    '/* 用户确认过的 CSS 规则，逐条对应需求 */',
    '.selector-a { display: none !important; }',
    '.selector-b { max-width: 720px; margin: 0 auto; }',
  ].join('\\n')
  document.documentElement.append(style)
  return 'applied'
})()
\`\`\`

结构类改动（删除/移动/加按钮）同样走 page_evaluate 的 DOM 操作，改动前记录原结构；每一步操作后 page_snapshot 核对效果，不要凭想象断言成功。

## 第三步：迭代
把效果描述给用户（做了什么、改了哪里），让用户看真实页面反馈；调整就改样式节点内容重建注入，或补 DOM 操作。用户说「不对/还原」时，移除注入节点（即上面配方的第一行）即可恢复原样。

## 第四步：保存配方（用户满意后）
把最终方案整理成站点配方，用 skill_write 保存：
- name：\`remix-<域名>\`（域名 kebab 化，如 \`remix-www-example-com\`）；
- description：一句话说清站点与效果；
- content 按此骨架：宿主与生效范围 → 效果清单（逐条对应需求）→ **完整可复制的幂等应用表达式**（上面第二步的最终版，含全部 CSS 与 DOM 操作）→ 还原方式 → 已知边界（哪些页面区域没覆盖、改版可能失效的选择器）。

保存后告知用户用法：以后进入该站说一句「按配方改造」，或直接 \`/remix-<域名>\`，Agent 会加载配方并重放注入表达式，效果即刻恢复。

## 注意
- 选择器优先用稳定的语义特征（id、data-*、role），脆弱的样式链选择器在配方里标注「改版易失效」。
- 一次任务聚焦一个站点；用户要改多个站就逐站来，每站独立配方。
- 配方里的表达式只做页面内改动：不新增对外请求、不写存储、不注册全局事件——超范围的需求先说明再征得同意。`,
    },
  },
  {
    revision: 2,
    record: {
      name: 'site-api-crawl',
      description: '站点接口递归爬取：从入口 URL 广度+深度+由页面守卫递归抓取整站源码，只从 HTML/JS 文本解析接口，去重抽验后自动下载成 JSON+清单。',
      whenToUse: '用户要求「爬取/枚举某网站的所有接口/API」，或安全梳理某站点的数据面时；输入是入口 URL（可选：页数与深度上限）。',
      content: `# 站点接口递归爬取（site-api-crawl）

从入口 URL 出发广度+深度+递归爬取一个网站，**只从 HTML 与 JS 源码文本**解析出全部接口，去重、抽验后自动下载成文件。

## 硬性边界（先读）
- 只解析 HTML/JS 源码文本；本技能**不用**流量捕获类工具（接口只能来自 html/js 解析）。
- **每次请求前先过守卫**，六条全过才准发：①协议仅 http/https；②主机非 localhost；③非环回（127.*/::1）；④非私网（10.*、172.16-31.*、192.168.*）；⑤非链路本地与保留（169.254.*、0.*、*.local、*.internal、IPv6 fc00::/7）；⑥与入口同源（协议+域名+端口一致）。任一不过：跳过并记录原因。
- 礼貌爬取：页间至少间隔 1 秒；默认上限 30 页、深度 2 层（用户明确要求可放宽到 50 页/3 层）。
- 登录态：页面内请求自动携带浏览器 cookie，需登录的接口照常能测。

## 第一步：入口
1. \`tabs_open\` 打开入口 URL（记 tab_id），page_snapshot 确认可读；记录入口 location.origin 作为本次任务的唯一同源范围。
2. 维护两个队列：待爬页面（同源链接）、已解析页面；入口入队。外域链接只记录域名不跟进。

## 第二步：抓源码（页面守卫式请求）
用 page_evaluate 实现「源码抓取表达式」——契约：**入参一个同源 URL；先执行六条守卫校验（全过才继续）；然后以 include 凭据对该 URL 发起文本请求并返回响应文本**。实现由你现场完成，校验代码必须出现在请求代码之前。每个 URL 都必须先过这个守卫，没有例外。

在会话里对拿到的 HTML/JS 文本按这些规则解析接口（规则要点）：
- 请求调用形态：引号包裹的以 \`/\` 开头的路径出现在请求调用第一参/URL 位（XHR/axios 类库形态都算）；
- URL 字面量：引号包裹的 \`/api/...\`、\`/v1/...\`、\`/gateway/...\`、\`/service/...\` 路径，以及同源完整 https URL；
- 资源引用：<script src>、<link href> 指向的同源 .js 入「待解析 JS」队列；<img src> 等二进制只记录不跟进；
- 表单 action 与 meta refresh 也算端点证据。

每条端点记录：\`{url, method（有调用证据才标，否则 "?"）, source（来自哪个页面/JS 文件）, raw（命中片段 ≤120 字）}\`；按去参后 URL 去重。**JS 文件是接口的最大来源，队列里一个都不能漏**。

## 第三步：递归与抽验
广度优先处理队列直到上限。GET 且疑似返回 JSON 的端点抽样验证（每类至多 5 条）：用同一守卫式请求看 status/content-type/响应前 200 字，POST 端点只记录不盲发（避免副作用）。带签名/时效参数的端点标注「参数来源待查」。

## 第四步：下载交付
用 **download_file 工具**直接把两份产物下载到用户浏览器的「下载」目录（内容为文本，走本地数据通道不经网络）：
- \`site-<域名>-apis.json\`：全部端点数组（含抽验 status/content-type），mime 用 application/json；
- \`site-<域名>-apis.md\`：按功能分组清单 + 抽验摘要 + 覆盖统计（爬了几页/几个 JS/多少端点），mime 用 text/markdown。

download_file 失败时回落 write 工具写文件（已选本地文件夹写 /local/，否则写工作区根目录并汇报路径）。最后汇报：下载的文件名、端点总数与分组概览。`,
    },
  },
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
  {
    revision: 2,
    record: {
      name: 'bili-up-digest',
      description: 'B 站 UP 主动态批量抓取：抓多个 UP 主的空间最新动态，视频条目必读内容（元数据+字幕/热评合成摘要），可配定时任务做增量监控。',
      whenToUse: '用户要求「看看/总结/监控某些 UP 主的最新动态/投稿」，要求批量过一遍多个 UP 主，或要求定时检查更新时；输入是 UP 主 UID 列表或 space 链接。',
      content: `# B 站 UP 主动态批量抓取（bili-up-digest）

批量抓取多个 B 站 UP 主的空间最新动态；**视频条目必须读内容**——打开视频页提取元数据+字幕/热评合成摘要，不得只看标题。前提：浏览器已登录 B 站（登录态在 cookie 里，页面自动携带）；未登录时动态列表为空——先提示用户登录，不要反复重试。

## 单 UP 动态抓取配方（一次 page_evaluate 直达）

1. \`tabs_open\` \`{"url":"https://space.bilibili.com/<UID>/dynamic"}\` 打开 UP 主动态页（记下返回的 tab_id）。
2. 等列表渲染（约 2-3 秒），然后 \`page_evaluate\` 执行下面的表达式（把返回 JSON 原样呈给用户即可）：

\`\`\`
(() => {
  const q = (scope, sel) => Array.from((scope || document).querySelectorAll(sel))
  const cards = q(null, ".bili-dynamic-list .bili-dynamic-list-item, .space-dynamic__left .space-dynamic-inner, [class*='bili-dynamic-card']")
  if (cards.length === 0) {
    const body = document.body.textContent || ""
    const empty = body.includes("好像没有东西") || body.includes("正在玩命加载")
    return { items: [], hint: empty ? "动态列表为空——UP 主可能暂无动态，或未登录 B 站" : "未识别到动态卡片，页面结构可能已改版" }
  }
  const items = cards.slice(0, 10).map((card) => {
    const text = (card.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 300)
    const link = card.querySelector('a[href*="/video/"], a[href*="/opus/"], a[href*="b23.tv"]')
    const time = card.querySelector("[class*='time'], time")
    return {
      when: time ? (time.textContent || "").trim() : "",
      text,
      link: link ? (link.href || link.getAttribute("href") || "") : "",
    }
  })
  return { count: items.length, items }
})()
\`\`\`

## 视频内容必读（视频条目不可跳过）

动态里的视频条目（link 含 /video/BV…）逐个打开读内容，合成摘要：
1. \`tabs_open\` 打开视频页，等 2-3 秒，page_evaluate 读页面元数据对象：
\`\`\`
(() => { const v = window.__INITIAL_STATE__?.videoData ?? {}; return { bvid: v.bvid, title: v.title, desc: (v.desc || "").slice(0, 500), durationSec: v.duration, tname: v.tname?.name ?? v.tname, pubdate: v.pubdate, up: v.owner?.name } })()
\`\`\`
2. 字幕：读播放器字幕面板可得性（页面已有字幕 DOM/数据时提取文本，取前 60 段拼接）；页面没有现成字幕数据时跳过，不要自己另发接口请求。
3. 热评：滚动评论区两屏，等渲染后读评论 DOM（作者+点赞+文本，取点赞前 8 条）。
4. 摘要 = 标题 + 简介 + 字幕要点（可得时）+ 热评风向，3-5 句；字幕与热评不可得时基于简介如实说明「未能读取字幕/评论」。

## 批量多 UP（通用能力）

输入是多个 UP 主（UID/链接清单）时：逐个执行单 UP 配方（每个 UP 一页动态，不翻页轰炸），**每个 UP 的视频条目都过「视频内容必读」**，最后合并成一份简报：
- 按 UP 分组：新动态条目 + 视频摘要；
- 顶部给跨 UP 汇总（今日更新了几条、值得优先看的 2-3 条）。

## 增量监控自动化（schedule 组合）

用户要「每天/定时检查更新」时，用 schedule_create 建任务：
- rrule 用 \`DTSTART:<今天 UTC>\nRRULE:FREQ=DAILY\`（或用户指定节奏）；
- prompt 模板：\`用 bili-up-digest 技能批量抓取 UP 主 <UID 清单> 的动态，视频条目必读内容；与上一条投递对比只总结新条目，无更新回“无更新”。\`
- target 用 this_session 或 new_once。

## 注意
- B 站页面高频改版：选择器多重候选已内置；返回「未识别」时降级 page_snapshot 读可见文本并如实说明。
- 每个 UP 只抓一页（最新在前）；视频读取每任务至多 5 个，超出先报告清单让用户挑。
- 不要把 cookie、SESSDATA 值写进任何输出或技能内容——登录态依赖 cookie 本身。
- 未登录的会话里配方返回空列表加提示；提醒用户登录一次即可。`,
    },
  },
  {
    revision: 2,
    record: {
      name: 'site-auth-export',
      description: '站点认证参数导出：从当前站点收集 cookie/存储/请求头里的认证凭据，默认脱敏、可完整导出，自动下载成 JSON 文件。',
      whenToUse: '用户要求「导出某网站的登录态/token/cookie/认证参数」，做会话迁移、调试或备份时；输入是目标站点（默认当前标签页）。',
      content: `# 站点认证参数导出（site-auth-export）

从目标站点收集认证相关参数并自动下载成 JSON。**默认脱敏**：凭据值只显示前 4 + 后 4 字符与总长；用户明确说「完整导出/不脱敏」才写明文。

## 第一步：定位目标
\`tabs_switch\` 切到目标站点的标签页（没有就 tabs_open 打开站点首页）。记录站点域名。

## 第二步：采集（三条渠道）
1. **网页存储**：page_evaluate 读取：
\`\`\`
(() => {
  const dump = (s) => Object.fromEntries(Array.from({ length: s.length }, (_, i) => s.key(i)).map((k) => [k, (s.getItem(k) || "").slice(0, 500)]))
  return { cookie: document.cookie, local: dump(localStorage), session: dump(sessionStorage) }
})()
\`\`\`
2. **请求头捕获**：\`page_network\` \`{"action":"start","tab_id":<id>}\`，在页面上做一次轻操作（刷新一次），然后 \`{"action":"read","tab_id":<id>}\`——从捕获里挑认证相关请求头：Cookie、Authorization、X-Token、X-Csrf、Api-Key 等命名的头，记录「请求 URL 路径 + 头名 + 值（按脱敏规则处理）」。读完 \`{"action":"read","tab_id":<id>,"stop":true}\` 停止。
3. **表单痕迹**：页面里可见的 csrf/token 元字段（meta[name=csrf] 等）一并记录。

## 第三步：整理
按 \`{site, items: [{name, source: cookie|local|session|header|meta, masked, value}]}\` 组织；标注哪些来自 httpOnly（document.cookie 读不到、只在捕获头里出现），这些是会话恢复最关键的。

## 第四步：下载
用 **download_file 工具**直接下载（mime 用 application/json）：
- \`auth-<域名>.json\`：整理后的完整结构。

download_file 失败时回落 write 工具写文件（已选本地文件夹写 /local/，否则工作区根目录并汇报路径）。汇报：条目数、各来源计数、是否含 httpOnly 凭据、文件名。**提醒用户**：导出文件等同登录凭证，妥善保管、用完即删。

## 安全边界
- 凭据明文绝不写入任何技能内容、对话回显或远程上报；只存在于导出文件里（用户明确要求完整导出时）。
- 不访问与目标站点无关的域；不把导出内容发送到任何网络端点。`,
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
