# 快速上手

[English](quickstart.md) | 中文

OpenBrowserHarness 以 Chrome/Edge MV3 扩展形式发布。当前从源码构建并以解压缩方式加载。

## 环境要求

- Node.js ^22.19 或 ≥24 与 pnpm，用于构建。
- Chrome 或 Edge ≥134——侧边栏用到较新的 JavaScript 特性。

## 构建并加载

```sh
git clone https://github.com/clear2x/openbrowserharness.git openbrowserharness
cd openbrowserharness
pnpm install
pnpm run build:lib
pnpm run build:extension
```

在 Chrome 或 Edge 打开 `chrome://extensions`（或 `edge://extensions`），开启开发者模式，选择**加载解压缩的扩展**，选定 `apps/extension/dist`。

## 配置模型

点击扩展工具栏图标打开侧边栏，进入设置，选择供应商——内置 DeepSeek 与智谱 GLM 预设——然后填入 API Key。自定义端点与思考强度设置见[配置模型](./providers.zh.md)。

## 运行第一个任务

在输入框里输入一个任务，例如：「打开维基百科的 Google Chrome 条目，提炼三个要点。」

智能体会规划任务、打开标签页、读取页面，并在侧边栏给出回答。工作期间你能看到虚拟指针在真实页面上移动；浏览器会显示「开始调试」横幅，因为输入通过 Chrome DevTools Protocol 驱动。

## 审批

根据权限档位不同，工具操作要么立即执行，要么在侧边栏弹出审批卡并等待你的点击。新会话默认完全访问；随时可用输入框的盾牌芯片收紧为「仅变更确认」或「每次确认」。详见[权限与安全](./permissions.zh.md)。

## 会话可恢复

对话以事件溯源方式写入浏览器 IndexedDB。即使浏览器回收了智能体进程，下一条消息会修复会话并接着同一个对话继续。
