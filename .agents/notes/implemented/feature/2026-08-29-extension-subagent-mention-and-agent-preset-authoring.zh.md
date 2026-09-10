# Agent Note：扩展侧子代理 @ 引用与 Agent 预设作者化

状态：已实现

[English](2026-08-29-extension-subagent-mention-and-agent-preset-authoring.md) | 中文

## 问题

两个桌面 wire 面在 MV3 扩展里仍是死端，原因各不相同：

- composer 无法点名子代理。扩展桥早已实现 `subagent.*` RPC 家族（list/history/prompt/interrupt），但 UI 没有任何入口产出 `subagent.prompt`——桌面通过接入 client 模块系统的输入触发菜单抵达它，而扩展壳不组装那套模块。
- 设置页的「Agent 预设」tab 渲染 `agentPreset.*` wire 面的返回值，而桥此前拒绝每个方法。桌面实现（`@deepseek-ai/dsh-agent-presets`）靠扫描文件系统目录发现预设，并从目录动态 import 插件模块（`node:fs/promises`、`dsh-home-paths`、`cordis-plugin-include`）；MV3 页面没有文件系统，CSP 禁止动态代码，扩展的 loader 是静态 module map。UI 永远为空，并非 UI 自身的问题。

## 决策

**@ 引用走既有斜杠管道路由。** `dispatchSendLine`（composer-bar）本就负责发送行解释（`/` 命令、`//` 逃逸），现在也识别行首 `@名字 ` 记号。`useSubagents` 在首次 `@` 键入时懒加载 `subagent.list` 并按会话缓存；弹出列表只列可继续候选（已结束且可恢复的子会话）。命中则发送 `subagent.prompt {parentSessionId, childSessionId, content}`；无命中回退主会话并给 notice，误打的 `@` 降级为普通消息而非报错。

**Agent 预设改为 chrome 存储花名册，而非移植文件系统。** 桥针对 `chrome.storage.local` 专用键（`dsh-agent-presets`）实现六个 wire 方法：`list`（内置 `default` 行加 user 行，broken 行保留可见）、`copy`（唯一的作者化写入——校验 id、保留 `default` 保留字、继承源定义）、`read`、`openDocument`（内置预设按只读拒绝；user 行回 `{opened:false, path}` 指明存储键，镜像桌面「事后到文件里编辑」、编辑器换成存储路径）、`remove`（拒绝内置；清理悬挂默认）、`select`（仅空白会话，否则 `agent-preset-locked`；追加 `agent-preset/selected`，针对会话类型目录本地补声明，全程无 cast）。消费发生在桌面同样的位置：`session.create` 把显式或存储默认的预设解析进会话头，`provider`/`model` 覆盖走既有 selections 机制，`systemPrompt` 段经 `agentCtx.systemPrompt.section()` 注册；冷恢复按「会话头 + 最后一条 `agent-preset/selected`」重放。定义子集（`provider`/`model`/`systemPrompt`）是桌面字段集减去静态 module map 承载不了的部分（每预设插件行、`tools`）。

默认选择字段本来就是 settings 的 `agent-presets.default` 字符串——旧 list 代码把它当布尔读；修复顺带纠正了这一点。

## 已考虑的替代方案

- **在 Node shim 后移植 `dsh-agent-presets`。** 否决：loader 对预设目录的动态 `import()` 恰是 MV3 CSP 禁止的东西；把 `node:fs` shim 到 IndexedDB 也仍然无法加载每预设插件代码，移植只会为无法激活的特性实现发现逻辑。
- **独立于斜杠管道再造一个 composer 弹层。** 否决：管道已拥有发送行解释与 `//` 逃逸；第二个解释器会分叉逃逸与回退语义，换不来任何行为收益。

## 后果

设置 tab 与 hero chip 对真实数据工作，UI 零改动——它们本来就在发这些调用。作者化深度与桌面「复制后到外部编辑」的模型一致：copy 复刻源定义，编辑走文档化的存储路径，因为扩展内没有组合编辑器。预设不携带插件行与 `tools` 子集；扩展组装的是固定插件集，这些字段无从选择。

没有可继续子会话的会话里 `@` 菜单保持空置——候选缺席是设计内的安静态，不是故障。

## 测试

`apps/extension/tests/composer-bar.spec.ts` 覆盖菜单组装、词边界触发、多词 label 解析与发送路由（命中 → `subagent.prompt`，未命中 → 回退 + notice）。`apps/extension/tests/api-bridge.spec.ts` 端到端钉住预设生命周期：copy 拒答/成功 → read → 悬挂 broken 行 → makeDefault → `session.create` 消费（模型覆盖可见、`assemble` 中出现 system-prompt 附加段）→ 空白会话 select 成功、已启动会话 `agent-preset-locked` → 内置 remove 拒答与悬挂默认清理。
