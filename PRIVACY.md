# Privacy / 隐私说明

English | 中文（下文）

## English

OpenBrowserHarness runs entirely on your machine. The extension does **not** operate any server and does **not** send telemetry, analytics, or crash reports anywhere.

- **Page content you ask the agent to work on** (snapshots, screenshots, extracted text) is sent only to the **LLM endpoint you configured** (for example DeepSeek or 智谱). Those requests use your own API key and are governed by the provider's privacy policy.
- **API keys and settings** are stored in `chrome.storage.local` on your machine and never leave it except as authentication headers to your chosen provider.
- **Session history** (your conversations and tool results) is persisted in the browser's IndexedDB on your machine. Use *Session log* to export or inspect it; clearing browser data for the site removes it.
- **The `debugger` permission** is used to drive the active tab (mouse, keyboard, page reading) through the Chrome DevTools Protocol. The "is being debugged" banner is expected while the agent works; the extension attaches only to tabs it operates on.

## 中文

OpenBrowserHarness 完全运行在你的机器上。扩展**不**运营任何服务器，也**不**发送遥测、统计或崩溃报告。

- **你让智能体处理的页面内容**（快照、截图、提取的文本）只会发送到**你自己配置的 LLM 端点**（如 DeepSeek 或智谱）。这些请求使用你自己的 API Key，受对应供应商隐私政策约束。
- **API Key 与设置**保存在本机的 `chrome.storage.local`，除作为你所选供应商的认证头外不会离开本机。
- **会话历史**（对话与工具结果）持久化在本机浏览器的 IndexedDB。可用 *Session log* 导出或检查；清除浏览器站点数据即删除。
- **`debugger` 权限**用于通过 Chrome DevTools Protocol 驱动活动标签页（鼠标、键盘、页面读取）。智能体工作期间出现"正在调试此浏览器"横幅属预期行为；扩展只 attach 它正在操作的目标标签页。
