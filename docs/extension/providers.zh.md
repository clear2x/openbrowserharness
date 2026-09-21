# 配置模型

[English](providers.md) | 中文

扩展与你配置的 LLM 端点通信。API Key 保存在本机的 `chrome.storage.local`，只在你所选端点的请求里作为认证头离开本机。

## 内置预设

- **DeepSeek**——DeepSeek 平台 API。
- **智谱 GLM**——智谱 BigModel 开放平台，含 OpenAI 兼容与 Anthropic 协议两条路由（GLM Coding Plan 端点）。

在设置里选择预设，并填入供应商控制台签发的 API Key。

## 自定义端点

以下类型均可通过「添加自定义提供方」接入：

- OpenAI 兼容对话端点（base URL + Key），包括自建网关。
- Anthropic 协议端点。
- 本地 Ollama。

## 选择模型与思考强度

每个会话都可以在输入框的模型芯片里切换模型与思考强度。强度菜单只列出当前模型实际支持的档位。

模型的输入模态有差异：截图理解（[page_screenshot](./automation.zh.md)）需要接受图片的模型；纯文本端点会收到明确的报错，而不是静默丢图。

## 说明与限制

- 模型或 base URL 的变更作用于新建的智能体；进行中的会话沿用其启动时的路由。
- 供应商预设只是起点——端点、模型列表与定价由你所选的供应商掌握，发送的内容受其条款约束。
