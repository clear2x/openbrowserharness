# Agent Note: 回放在工具参数中反解 cwd token

Status: implemented

[English](2026-09-29-replay-cwd-token-resolution.md) | 中文

## 问题

回放夹具用 `{{cwd}}` 作为场景工作目录的可移植 token。header 路径早已反解它——`normalizeProjectedHeader` 把 header cwd 重写为 `/dsh-snapshot-cwd` 虚拟路径——但工具参数里的 token 没有被反解。`write` 工具调用回放时携带字面参数 `{{cwd}}/escalated.md`，文件系统 resolve 随后把未反解的 token 当作相对段拼接，产生双前缀显示路径 `<snap-cwd>/{{cwd}}/escalated.md`。`fs-escalation` 场景录制的 `<path>` 行因此在 live 录制与回放之间失配，任何经工具参数触文件的夹具都无法回放到录制状态。同样的缺口还藏在 bash 命令里（`mkdir -p {{cwd}} && printf … > {{cwd}}/note.txt`），回放的 bash 场景会把文件写进一个字面名为 `{{cwd}}` 的目录。

## 决策

`packages/test-support/llm-replay` 在条目级反解 token：新增的 `resolveCwdToken` 步骤在条目进入 scripted-entry 解析之前，把已物化 `ReplayEntry` 的字符串叶子中所有 `{{cwd}}` 出现替换为 `process.cwd()`。夹具保持 token 形态——它是与 live 捕获共享的可移植表示——反解是回放层的运行时职责，与既有的 `{{session:<id>}}` 物化并列。

随修复一起完成两处语料对齐：

- `ReplayAdapter.resolveModel` 改为从 `REASONING_EFFORT_META` 表派生 effort 名称与描述，不再回显裸 id，与 live DeepSeek provider 面一致。`fs-escalation` 的 config options 在 live 录制（带名 effort）与回放之间从此一致。
- `escalation-approved` 的 ACP catalog 镜像 live 的 `deepseek-v4-flash-vision-exp` 条目，录制到的三模型 catalog 清单可逐字回放。

`persistent-tools` 的工作区期望在 bash/pwsh 引导移植期间与夹具漂移：夹具的 `str_replace` 步骤只替换三行文件中的一行，最终工作区是 `alpha / replaced line / omega`，陈旧的单行 `workspace.expected/note.txt` 已对齐为该脚本结果。

## 备选方案

**夹具内写绝对路径。** 拒绝：夹具将失去跨检出可移植性，live 捕获也不再共享 token 表示。

**在 header 投影层反解 token。** 拒绝：该层负责 header cwd 重写；工具参数由工具实现消费，只有回放层能看到完整的夹具条目。

**在 assistant 回放分支合成 usage chunk。** 已试并撤销：`expandAssistantStream` 已展开录制流中的 usage chunk，二次插入使每次回放重复 usage，破坏 47 个 llm-replay 用例。

## 后果

回放条目的每个字符串叶子现在都反解 `{{cwd}}`，夹具无法在工具参数或文件内容中表达字面 `{{cwd}}`；当前没有场景需要它，未来需要时应先引入转义 token。`pnpm run test:snapshot` 131 用例全绿，起点是本批开始时的 17 红。
