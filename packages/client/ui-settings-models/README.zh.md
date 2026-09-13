---
description: "模型设置与产品引导插件：ZCode 风格的供应商栏与表单，以及版本化的内测通知。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-models

[English](README.md) | 中文


左栏分两组。「官方」列出唯一随附的预设（DeepSeek）；「自定义供应商」列出存储在 `llm-pi-ai` namespace 中的每条手工声明路由；栏底是一枚素色（hover 显底色）的「+ 添加供应商」chip。每行用一个 8px 状态点标示密钥状态：当提供方可以服务请求时为绿——其具名凭据已存储，或其 profile 不指名引用且路由活跃（提供方原生认证本就无需密钥）；否则为灰。一次出结果的「测试连接」会在本会话内把所选行的点重新涂绿，失败则以红字显示在表单旁。整分节路由的密钥引用来自其 namespace 的 base 层，其已配置事实来自 namespace 的 secret envelope。分节宽度低于 560px 时（container query——设置面板宽约 380–800px），左栏变为表单上方横向滚动的 chip 条。

右栏渲染三种表单之一。DeepSeek 官方表单是单独一个**只写**的 **API Key** 输入框，经 `credentials.set` 存入 `DEEPSEEK_API_KEY`，外加「测试连接」：以键入的密钥向 settings 联接所报告的端点（除非部署覆盖，否则即公共端点）调用 `llm.discoverModels`；绿色结论显示为 `✓ 可用 · N 个模型`，失败则以红色显示宿主消息。已声明路由的表单保持**路由 ID 只读**——它是 settings 的键、凭据引用的词干、每条已记录会话引用的名字——并就地编辑 profile：显示名称、Base URL、API Key、以三张可选卡呈现的协议（`Anthropic Messages (/v1/messages)` ↔ `anthropic`、`Chat Completions (/chat/completions)` ↔ `openai`、`Responses (/responses)` ↔ `openai-responses`，选项读自该 namespace 自己的 schema），以及以一条 `headersText` 多行文本承载的自定义请求头。编辑以最小化的 `settings.mutate` 路径 op 落盘，因此表单未展示的 profile 字段会保留。添加供应商向导从显示名称派生路由 ID（`slugOfName`），并在本地门控每一项创建字段——路由 ID 的形状与唯一性、公网 HTTP 的 Base URL、至少一个模型——因此失败会在用户仍看着该字段时以中文点名它；自定义请求头刻意只属于编辑面板，不属于创建向导。模型经内联的「+ 添加模型」小对话框起草（模型 ID、默认 1,000,000 的上下文窗口、默认 128,000 的最大输出 Token，以及输入模态开关——文本固定勾选、图片可选，勾选即存储 `input: ["text", "image"]`；输出仅文本且以固定态展示；坏行当场判定），随表单一起提交：一次 `settings.mutate` 在 `providers.<route>` 写入整个 profile，随后键入的密钥经 `credentials.set` 存入派生的 `<ROUTE>_API_KEY` 引用——仅当确实键入了密钥时，profile 才把它记录为 `apiKeyEnv`。留空密钥的路由因此保留提供方原生认证。

每次 settings 写入都携带面板当前的 `revision`，因此来自另一个标签页或对 `settings.yaml` 的外部编辑所产生的并发写入会以 `settings-conflict` 被拒绝；留空密钥声明的路由完全不具化凭据引用。键入的 API 密钥在它自己的字段上被判定：trim 之后每个字符必须是可打印 ASCII（`[\x21-\x7E]`）——这是 `@deepseek-ai/dsh-llm` 中 `normalizeApiKey` 的孪生体，因源码平面分割禁止直接引入而在此镜像；与整行粘贴的 `NAME=value` 环境变量匹配或成对引号包裹的值以同一条格式失败被拒绝，只含空白的输入框会失败而不是被静默丢弃。密钥字段没有可用内容时「测试连接」会在本地被拒绝，因此页面不会白花一次往返去换取字段上已经写明的答案。对已声明路由，宿主会把该路由已存储的自定义请求头附加到询问上，因此探测走的是与真实请求相同的路。删除已声明路由需要确认，且仅当 profile 指向页面派生的 `<ROUTE>_API_KEY` 目标时才清除已配置且可写的凭据，随后取消设置 profile；两项操作都具备幂等性，部分失败会停留在确认对话框中供重试。页面加载完成后会直接订阅转发的 owner 事件 `settings/document-updated`、`credentials/updated`、`llm/adapters-updated`，以及本地 `connection/reset`，因此外部编辑或第二个标签页都无需轮询即可收敛。

声明步骤在 `src/onboarding-copy.ts` 中持有完整文案和版本。回环访问会通过既有 settings API 比较并写入 `ui-onboarding.welcomeNoticeVersion`；只有明确点击「继续」才会记录当前版本。非回环浏览器无法使用这项仅限 Host 的 namespace，因此确认仅在当前进程有效，重载后声明会再次出现。

## 概述

模型设置与产品引导插件。同一个 client Cordis 插件会注册 Models 页面——一个仿 ZCode 的提供方管理界面：左侧供应商列表，右侧是所选供应商的表单——以及版本化内测声明。Models 平面把三个协议领域汇聚为一个共享快照：`llm.providers`（可配置提供方目录，含每条路由的存活／休眠状态）、`settings.describe`（序列化 schema、分层脱敏值、secret slot）与 `credentials.describe`（不含值的 configured/source/writable 徽标）；页面据此一次渲染一个表单，且不把路由存活状态呈现为提供方状态。

## 目录

- [模型体验](#模型体验)
- [已知限制与暂缓事项](#已知限制与暂缓事项)

## 模型体验

无。该分区渲染浏览器配置 UI；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **页面可编辑的只有表单展示的字段**：官方路由的 Base URL 与模型目录、推理等级及其他进阶字段仍留在 `settings.yaml` 中。写入是路径 op，profile 的隐藏字段会在编辑后保留，但本页不为它们提供控件。
- **协议三选卡只是选择器**：可用性探测始终以 OpenAI 兼容的 `GET {baseURL}/models` 形态询问（宿主唯一的列表格式），因此讲 Anthropic 协议、无法应答该形态的网关即使对话可用也会报告失败；模型需经小对话框手工填写。
- **headersText 草稿不参与探测**：宿主只会把已声明路由**已存储**的请求头附加到询问上，编辑后尚未保存的请求头行只有在「保存」之后才会到达端点。
- **凭据清理范围刻意保持狭窄**：删除路由时，仅当其引用与页面派生的 `<ROUTE>_API_KEY` 目标完全一致，才会清除已配置且可写的凭据。自定义引用、环境凭据和无法识别的目标会保留，因为该行无法证明自己拥有它们。
- **只有 pi-ai 路由可以手工声明**：向导写入 `llm-pi-ai`——唯一一个其 profile 描述整个提供方的 namespace。`llm-deepseek` 路由是组合面的事实，不是本页能创建的东西。
- **未声明的存活路由无处渲染**：未附带可配置提供方声明即注册的路由没有 settings 地址；它在各选择器中仍然可见，但不会出现在本页左栏中。

## 开发备注

本包为 fork 新增，随扩展发布节奏演进；接口变化时同步更新本页内容与目录。
