# Agent Note：智能模型配置——ZCode 规则引擎、种子与添加流程自动检测（已实现切片）

Status: implemented

[English](2026-09-22-smart-model-config-port-implemented.md) | 中文

## Problem

给供应商路由添加模型目前完全靠手工：pi-ai 目录只对它恰好认识的精确 id 给默认值，改名上游、网关别名、beta 后缀都要手填 `contextWindow`、`maxTokens`、模态与思考档位，编辑器也没有「推荐值」的概念（完整论证见[移植提案](../../proposed/feature/2026-09-21-smart-model-config-port.zh.md)）。本篇交付移植的首个用户可见切片：添加供应商、添加模型、自动检测配置，均由内置分层规则知识库驱动。

## Decision

- **规则引擎**（`ui-settings-models/src/client/model-rules.ts`）：ZCode `ModelConfigRules` 的有序 overlay `resolve`，压缩到本表面编辑的字段——id 模式规则加 api 类型/base URL 门控层，`^(?:pattern)$` 大小写不敏感匹配，base URL 归一化（主机大小写、默认端口、尾斜杠），深层叶子 overlay，编译守卫跳过不可编译 pattern 而非整个面拒绝。
- **内置种子**（`model-rules-seed.json`，41 KB）：ZCode builtin release（revision 30）的供应商无关层——84 条 id 模式模型规则、72 条 api 类型门控规则、20 个带常规 base URL 与 wire 协议的供应商模板。ZCode 专属层（template-model、provider-site、精确 provider id）有意不打包。
- **添加模型自动检测**（`ModelDialog`）：模型 id 停顿 1.2 秒后，内置规则解析并填写用户未触碰的字段——上下文窗口、最大输出、图片输入——附 3.5 秒反馈条（已按内置模型知识库自动填写）。对话框接收路由的 wire 协议与 base URL，api 门控规则得以参与。
- **添加供应商模板**（`NewProviderPanel`）：模板 chip 行（Z.ai / BigModel / Kimi / MiniMax / DeepSeek / 阿里云百炼 / …）预填 base URL、wire 协议与尚未输入的显示名。

## 与提案的偏差

- 引擎放在 `ui-settings-models` 内（当今唯一消费者）而非新建 `llm-model-rules` 包；resolve 面是纯函数，日后晋升容易。
- 解析为客户端本地折叠内置种子：无 Remote resolve 缝（提案第 5 阶段）、无远程 release 更新循环（第 6 阶段）。「用户编辑字段 > 规则」的优先级由对话框内 touched 字段跟踪执行。
- 种子整体保留 ZCode 的模型族事实（它们与供应商无关），而非从 pi-ai 目录再生规则。

## Alternatives considered

**为引擎新建 `llm-model-rules` 包。** 暂时落选：`ui-settings-models` 是当今唯一消费者，resolve 面是纯函数，出现第二个消费者时晋升为包是机械动作。

**提案的 Remote resolve 缝与远程 release 更新循环（第 5、6 阶段）。** 本切片落选：解析为客户端本地折叠内置种子，不带更新路径——代价记录在 Consequences。

**从已安装 pi-ai 目录再生种子。** 落选：种子整体保留 ZCode 的模型族事实，因为它们与供应商无关；目录再生只会复述目录已带的精确 id 知识。

## Consequences

知识库按重建速度前进，而非 npm 发布或远程更新速度：种子冻结在 ZCode builtin revision 30，直到有人再生成；ZCode 专属层（template-model、provider-site、精确 provider id）不生效。「用户编辑 > 规则」的优先级活在对话框的 touched 字段跟踪里，而非服务端规则。包体增加 41 KB 种子。作为回报，内置供应商的手工配置三缺口关闭，且优先级契约完全在客户端可测。

## 验证

包 spec 覆盖目录（有序种类、失败着色、未知类型跳过）与 mock RPC 的对话框行为；真机 harness 驱动真实向导：模板 chip 预填 bigmodel.cn，输入 `glm-5.3-flash` 自动勾选图片输入并显示提示，草稿以检测值提交。扩展全量套件、typecheck、lint 全绿。
