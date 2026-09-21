# Agent Note: Smart model config — port ZCode's layered provider/model knowledge base

Status: proposed

[English](2026-09-21-smart-model-config-port.md) | 中文

## Problem

当前向供应商路由添加一个模型是完全手动的。已安装的 `@earendil-works/pi-ai` 目录只为它恰好认识的精确 id 提供默认值;任何其他模型 id——上游改名、网关别名、beta 后缀——都必须在路由的 `models`/`modelOverrides` 中手工声明 `contextWindow`、`maxTokens`、输入模态与推理档位(`packages/llm/llm-pi-ai/src/catalog.ts`)。由此产生三个缺口:

- **未知 id 得不到任何配置。** 精确 id 查找无法表达"id 以 `[1m]` 结尾的模型上下文窗口是 1M"或"在这个 base URL 的 `openai-completions` 端点上,`claude-*` 支持会话中途 system"。事实存在,却没有载体。
- **知识库以 npm 发版速度前进。** pi-ai 的目录随依赖一起发布。供应商今天改了一个能力,就要错到下一次升级;没有远程、带 revision 的更新通道。
- **编辑器没有推荐面。** 设置 UI 把 namespace schema 渲染成裸字段,没有"这是推荐值;改写它这一项就归你"的概念——用户分不清继承默认值和自己必须选的值。

ZCode 工作区(同机兄弟检出 `../ZCode`)有一套同时解决这三个问题的设计:分层正则规则引擎、带 bundled/LKG 回退的远程可更新 release,以及"智能配置"编辑器——推荐值以占位符呈现,手动改写任一字段即转为个人覆盖。本篇笔记将该设计移植进 harness,规则载荷沿用 pi-ai 的 profile 形状,让两个知识源保持兼容。

## Proposal

移植四块内容,映射到现有 dsh 结构。规则载荷是 `PiAiModelProfile` 形状的 overlay(可直接套用 `PiAiModelOverride`),因此解析出的推荐值无需并行的配置类型即可喂给现有物化器。

| ZCode 概念 | ZCode 源码(兄弟检出 `../ZCode`) | dsh 落点 |
|---|---|---|
| 分层规则引擎(`ModelConfigRules`:6 类规则、按序 overlay、`^(?:pattern)$` 大小写不敏感匹配、baseUrl 归一化) | `packages/provider/src/config/model-config.ts`、`rule-data-schema.ts`、`config-overlay.ts` | 新包 `packages/llm/llm-model-rules`——纯逻辑,Host 与 Client 均可用 |
| 规则数据 schema(zod:pattern 校验、同一 provider+model 智能互斥) | `rule-data-schema.ts`、`schema.ts`(`parseZCodeBuiltinModelConfigRules` / `parsePersonalModelConfigRules`) | 同一包;在 settings 边界用 `@deepseek-ai/schemastery` 校验,内部保持无 zod(视仓库偏好) |
| Release 编解码(`schemaVersion`/`revision`/`config{providerConfigRules, modelConfigRules}`、已退出供应商整份拒绝) | `packages/provider-node/src/zcode-builtin-release.ts` | 同一包(`release.ts`) |
| 远程下载 + LKG + 多进程租约同步(控制面 → 仅 https 的 CDN URL、不跟随重定向、20 秒预算;成功 1 小时间隔、失败指数退避、共享控制文件租约) | `packages/provider-node/src/zcode-builtin-download.ts`、`zcode-builtin-remote-synchronizer.ts`、`zcode-builtin-provider-config-source.ts` | `packages/llm/llm-model-rules` 内的 cordis 插件(或 `packages/boot/app-boot` 接线);LKG 文件放 harness 数据根目录,复用仓库现有原子写工具 |
| 模型配置叶子(`properties.{contextWindow,inputFormat,outputFormat,supports*}`、`optionSpecs.{reasoningLevel,maxOutputTokens}`) | `packages/shared/src/model-config.ts` | 已由 `PiAiModelProfile` 字段覆盖;reasoning 的 `map`(wire 拼写)映射到 `reasoningEfforts`,逐字段 `compat` 开关映射到 `PiAiCompatProfile` |
| 解析缝(`resolveModelConfig`:添加模型预览 `{providerId, modelId}`;编辑预览 `{originalModelId, modelId, personalConfig}` 含改名 + setExact(useRecommended) 预览) | `packages/provider/src/facades.ts:239`、`packages/services/src/model-provider/providerFacadeServices.ts:128` | Host 侧解析器:输入规则 + 路由上下文(`api`、`baseURL`、modelId),经 Remote settings 缝暴露在 `llm-pi-ai` namespace 旁 |
| 智能配置 UX(占位符即推荐、逐字段 `overriddenFields` 跟踪、停止输入 1.2 秒触发解析且 blur/Enter flush、generation+identity 防竞态、3.5 秒"已匹配"反馈、恢复) | `packages/ui/src/settings/model-provider-section/`:`useIdleTrigger.ts`、`useModelConfigResolution.ts`、`useProviderModelDraft.ts`、`ProviderModelDraftState.ts`、`ProviderModelMetadata.ts`、`ProviderModelMetadataDialog.tsx`、`ProviderFormControls.tsx` | `llm-pi-ai` namespace 的 Web 设置页;settings 的 `user` section 本就以"字段存在"标记覆盖——UI 直接采用它作为覆盖指示,不再造第二个标记 |
| 供应商模板(选模板预填 `api.type`/`baseUrl`/展示名) | `ProviderTemplatePicker.tsx` + release 中的 `templateRules` | 路由预设随 release 下发;添加路由流程在裸表单之前先提供它们 |
| 种子知识库(revision N 时 84 条 modelRules / 72 条 modelApiRules / 52 条 providerSiteRules / 244 条 templateModelRules) | `config/provider/zcode-builtin.json` | 不要整体照抄:其中编码了 ZCode 的供应商 id 与模板。用脚本把已安装 pi-ai 目录转换成规则数据作种子,release 之后再独立增长 |

## Porting manual

按阶段编号,每阶段以验证步骤收尾。ZCode 路径相对兄弟检出 `../ZCode`,读自当前工作树;若该树有移动,请重新核对行号锚点。

1. **按此顺序读源码。** `model-config.ts`(`ModelConfigRules.resolve`——整个引擎约 40 行:精确规则匹配 `providerId+modelId`,然后 `template-model`,再按 `apiTypeMatch`/`baseUrlMatch` 门控的正则规则,全部按序逐叶子 overlay);`rule-data-schema.ts`(pattern 的 `z.string().refine(new RegExp('^(?:'+p+')$'))` 编译检查与智能/手动互斥的 `superRefine`);`zcode-builtin-release.ts`;`useModelConfigResolution.ts` + `useProviderModelDraft.ts` + `ProviderModelDraftState.ts`(UX 状态机);`facades.ts:239-298`(两种解析入参形状)。验证:不重读代码也能说清,为什么手动规则在 overlay 前要先 `clearManualModelConfig` 合成结果(系统叶子不得泄漏进完全手动的配置)。
2. **搭建 `packages/llm/llm-model-rules`。** 按 `docs/cookbook/adding-a-package.md` 执行。内容:overlay 原语(或复用仓库现有深合并 JSON 工具——先查 `packages/util`)、规则类型、`ModelRules.resolve({ route: { provider, api, baseURL, modelId } })` 返回 `PiAiModelOverride` 形状的 partial、release 编解码、schema 门禁。验证:`pnpm typecheck` 与 `pnpm lint` 通过;单测覆盖按序 overlay、大小写不敏感正则、baseUrl 归一化(尾部斜杠、默认端口)、非法 pattern 拒绝、智能/手动互斥。
3. **生成 bundled release 种子。** 写一次性脚本,遍历 `@earendil-works/pi-ai/providers/all` 的 `getBuiltinModels()`/`getBuiltinProviders()`,产出规则数据(种子阶段每个目录模型 id 一条精确 `model` 规则即可;pi-ai id 覆盖不到的后缀约定,之后再补手写正则规则)。JSON 打包进包内;绝不在模块加载时取网。验证:脚本幂等(重跑字节一致),bundled JSON 通过 release 编解码 round-trip。
4. **把解析器接进 `llm-pi-ai` 配置解析。** 在 `catalog.ts` 中,当路由命中的模型在已安装目录中不存在时,先经规则引擎解析(路由 `api`/`baseURL` + model id),再回落到路由默认值。存储读取保持延迟解析——规则未命中产生诊断而非硬失败,与现状一致。验证:既有 `llm-pi-ai` 测试保持绿色;新增测试钉住"规则解析的推荐绝不覆盖用户显式字段"。
5. **经 Remote 暴露解析缝。** 在 `llm-pi-ai` settings namespace 旁新增 resolve 操作,入参 `{ routeKey, modelId, personalDraft }`,返回 `{ recommended: PiAiModelOverride, effective, issues }`——ZCode 的两种入参形状在此合并为一种,因为路由本身携带 `api`/`baseURL`。读取基于已应用的 release 快照;resolve 绝不改写 settings。验证:API 网关 Typert 契约可构建,且操作可从 client 面触达。
6. **移植远程更新循环。** cordis 服务,启动时拉起:取控制面 → CDN(仅 https、credentials-omit、不跟随重定向、受仓库超时工具约束),解码 release,原子写 LKG 文件,重新解析受影响路由,发出 settings UI 已在监听的 cordis 刷新事件。配置:endpoint 与间隔放在一个 settings namespace(无密钥);失败退避对齐 ZCode 的 60 秒 → 1 小时封顶。若 dsh 为单进程,去掉租约文件、退避状态留在内存;不移植进程拓扑用不上的机制。验证:运行中断网——harness 继续用 last-good release,失败被记录而非抛进请求路径。
7. **移植智能配置编辑器 UX。** 在 `llm-pi-ai` 的 Web 设置表单中:推荐值渲染为输入框占位符(绝不渲染为值);触碰某字段即把该路径写入 namespace 的 `user` section(settings 缝已把 user-section 存在性当作覆盖标记——复用它,不要加 `overriddenFields` 孪生标记);1.2 秒 idle 触发器调度解析,blur/Enter flush;进行中的解析由 generation 计数器与 identity 对象守卫,`A→B→A` 绝不重放旧回包;命中解析显示瞬时反馈;恢复动作按当前草稿重新解析。验证:竞态测试——快速输入 `a`、`ab` 再回到 `a`,断言最终占位符只反映最后一次 generation。
8. **加路由预设选择器。** 创建路由时,在裸表单之前提供 release 声明的模板(名称映射、协议、base URL);选中即预填路由的 `api`/`baseURL`。验证:从模板创建并输入规则认识的 id,无需手碰 schema 字段即得到完整推荐。

开 PR 前跑 `pnpm check:all`;同一变更内写本篇笔记的 `implemented/` 对应版,按笔记迁移规则把本手册的计划节改写为现在时事实。

## Alternatives considered

- **维持手写 profile + 仅 pi-ai 目录(现状)。** 失去:已安装目录不认识的全部 id 事实,以及任何快于 npm 的更新通道。目录保留——它成为 release 的种子层——所以这个替代本质是"冻结基础层"。
- **配置时从供应商 API 发现能力(`GET /models` 等)。** 失去:这些端点枚举的是 id 而非能力;各供应商形状不一;而且填表单也变成需要网络与有效凭据的流程。ZCode 的静态规则编码的是经过审计的事实,这也是它们能在 diff 里被评审的原因。
- **扩展 pi-ai 本身而不是加规则层。** 否决:pi-ai 是 vendored 第三方面(`@earendil-works/pi-ai`),目录随依赖升级更新——恰是本功能要移除的限制——远程配置也不属于通用适配器库。

## Acceptance criteria

- 用户在协议/base URL 已知的路由上添加已安装目录不认识的模型 id,停止输入约 1.2 秒内看到 `contextWindow`、`maxTokens`、模态与推理档位的推荐占位符,全程未手写任何字段。
- 编辑推荐字段只把该字段转为用户覆盖(settings `user` section),未触碰的字段继续跟随 release 更新;关闭智能模式即钉住当前全部推荐值,且不丢弃进行中的编辑。
- harness 自带 bundled release;刷新 release 无需升级应用即可改变推荐;取数失败时 last-good release 继续服务并记录告警。
- 两条路由同一模型 id 但 `api`/`baseURL` 不同,可对该 id 解析出不同推荐(`model-api`/`provider-site` 规则层端到端可观察)。
- 含不可编译正则 pattern、或对同一 provider+model 声明智能/手动冲突的规则数据在边界被拒并给出具名 issue,无关模型继续服务。

## Risks

- **正则安全。** 规则是远程下发的 pattern,经 `new RegExp` 编译。在边界缓解:编译检查之外加长度上限与嵌套量词拒绝清单(或 safe-regex 扫描),通过后才应用 release;写明匹配在"停顿后"运行而非逐键。
- **两个知识源、一个答案。** pi-ai 已安装目录与 release 可能不一致(如目录 128k、release 200k)。优先级固定——用户显式字段 > release 规则 > 已安装目录 > 路由默认——且必须同时写进本包 README 与 `llm-pi-ai` 配置文档;评审要盯住这一陈述的漂移。
- **远程配置是攻击面。** release 改变请求整形行为。控制面取数不带凭据、CDN URL 仅 https 且拒绝重定向、编解码 schema 严格、记录"拒绝 release 回落 bundled/LKG 而非空"的路径。
- **UX 表面积增长。** 占位符即推荐的前提是设置表单能区分"来自推荐的占位符"与"作为提示的占位符"。现有表单把占位符当静态提示;移植必须迁移这些字段,不能让一个属性叠两层含义。
- **ZCode 耦合。** 种子不得引入 ZCode 的供应商 id(`builtin:*`、模板)——它们在这里无意义,整体照抄只会发运死规则。第 3 阶段的转换脚本就是边界。
