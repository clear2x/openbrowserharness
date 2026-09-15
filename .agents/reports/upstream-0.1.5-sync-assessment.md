# 上游 dsh 0.1.5 同步专项：冲突面评估报告

生成：2026-09-12（批52 分析）。基准：本地 `abe560f81e`（release(dsh): 0.1.0-rc.5）vs 上游 `upstream/master`（含 dsh-v0.1.5-rc.2）。

## 总量

- 上游变更：10763 个文件（3432 commits）
- 本 fork 变更：431 个文件
- **双方都改（真实冲突面）：168 个文件**

## 冲突面分类（按解决难度）

### 低难度（机械合并/我方独有可保留）

- `.agents/notes/**`（~15 个双语 Note/sidecar）：上游移动或编辑了 Note，我方照单接收上游版 + 我方新增保留。
- `README*`、`THIRD_PARTY_NOTICES.md`、`.gitignore`、`.gitattributes`：我方版本为准（身份文档），接收上游新增行。
- `docs/**`（catalog 类生成物）：重新跑生成器 + 我方新增段（browser.md 等）保留。

### 中难度（我方改动与上游重构在同文件）

- `packages/client/ui-conversation/src/client/chat/ChatNodeSeat.tsx`：我方加了 `data-chat-flow-producer` 投影；上游可能改了同文件其他逻辑。
- `packages/client/ui-conversation/tests/chat-view.client.spec.tsx`：测试断言合并。
- `packages/core/session/src/known-event-types.ts`：上游新增了 session 格式迁移管线（format migration decoder pipeline），我方加过事件类型——合并时按事件名合并集合。
- `packages/llm/llm-deepseek/src/adapter.ts` `serialize.ts` + 测试：上游 pi-ai/serialize 演进与我方多 Provider 适配的交点。
- `packages/llm/llm-pi-ai/src/adapter.ts` `catalog.ts`：上游 0.84→0.1.5 内嵌版本可能又演进了（我方在 0.84.1）。
- `packages/goal/tool-goal/src/index.ts` + README：我方刚加的停泊目标护栏指引（批52）vs 上游指引演进的冲突——保留我方新句。

### 高难度（结构性，需专项设计）

- **`packages/client/ui-settings-models/**`（约 17 个文件）**：上游把模型设置整组重写了（ModelListEditor/DeepSeekOnboardingDialog/ProviderEditor 等我方已删的文件在上游被重构）。我方扩展壳的模型设置面板走自己的 ns 布线——需要决定「跟上游新结构」还是「保留扩展壳自有面板」。
- **ui-conversation 的 composer 栈**（上游 Lexical composer 替换 textarea 栈，不在上面 168 文件清单里是因为我方删了这些文件——但上游新增的 Lexical 结构会以「新文件」形式进来）：**最大风险项**。扩展壳的 `.dshx-caps-body` 剥离规则按旧 textarea 栈的 data-slot/class 写，上游换 Lexical 后这些 hook 全部失效。
- **`packages/core/session` 的格式迁移管线**：上游引入 session 格式版本迁移，我方的 IndexedDB 持久化（session-persistence-indexeddb）需要适配新解码管线。

## 建议策略

1. **先做「无冲突面」合并**：上游 3432 commits 中不触碰我方 168 个冲突文件的变更可以先行 merge（由 git 自动合并），拿到上游的安全修复/性能改进/新能力的大部分。
2. **168 个冲突文件逐个专项解决**，按上面三档排序：低难度批量过 → 中难度逐个过 → 高难度（settings-models、composer 栈、session 迁移）专项设计。
3. **Composer 栈决策单独评估**：上游 Lexical composer 若明显优于我方自定义 composer-bar，可考虑反向——放弃壳剥离规则、直接用上游 composer + 少量样式覆盖。这是本次同步最大的单项决策。
4. 每 200~300 个文件一批推进，批间跑全量测试 + 真机冒烟。

## 数据

- 上游变更清单：`/tmp/upstream-changes.txt`（10763 行）
- 我方变更清单：`/tmp/our-changes.txt`（431 行）
- 冲突交集：`/tmp/conflict-files.txt`（168 行）
