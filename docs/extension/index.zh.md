---
layout: home

hero:
  name: OpenBrowserHarness
  text: 住在你浏览器里的 AI 智能体
  tagline: Chrome/Edge 浏览器智能体扩展——替你导航真实网页、填表单、提取内容；输入拟人化，全程受你审批。
  image:
    src: landing/sidepanel-task.jpg
    alt: 真实任务执行中——agent 打开维基百科的 Google Chrome 条目，并在侧边栏给出三点总结
  actions:
    - theme: brand
      text: 快速上手
      link: ./guide/quickstart
    - theme: alt
      text: 下载安装包
      link: https://github.com/clear2x/openbrowserharness/releases/latest
    - theme: alt
      text: GitHub
      link: https://github.com/clear2x/openbrowserharness

features:
  - icon: "<svg viewBox='0 0 24 24' width='28' height='28' fill='none' stroke='url(#ob1)' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><defs><linearGradient id='ob1' x1='2' y1='2' x2='22' y2='22' gradientUnits='userSpaceOnUse'><stop stop-color='#67e8f9'/><stop offset='1' stop-color='#818cf8'/></linearGradient></defs><path d='M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'/><path d='M8 10h.01M12 10h.01M16 10h.01'/></svg>"
    title: 侧边栏里的智能体
    details: 与会规划任务、调用工具、记录待办、汇报结果的智能体对话。会话本地持久化，浏览器重启后可恢复。
  - icon: "<svg viewBox='0 0 24 24' width='28' height='28' fill='none' stroke='url(#ob2)' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><defs><linearGradient id='ob2' x1='2' y1='2' x2='22' y2='22' gradientUnits='userSpaceOnUse'><stop stop-color='#67e8f9'/><stop offset='1' stop-color='#818cf8'/></linearGradient></defs><rect x='6' y='2.5' width='12' height='19' rx='6'/><path d='M12 6.5v4'/></svg>"
    title: 拟人化页面控制
    details: 贝塞尔鼠标轨迹带速度抖动、逐键输入、惯性滚动——通过 Chrome DevTools Protocol 驱动，不依赖任何 OS 级自动化。
  - icon: "<svg viewBox='0 0 24 24' width='28' height='28' fill='none' stroke='url(#ob3)' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><defs><linearGradient id='ob3' x1='2' y1='2' x2='22' y2='22' gradientUnits='userSpaceOnUse'><stop stop-color='#67e8f9'/><stop offset='1' stop-color='#818cf8'/></linearGradient></defs><path d='M9 9l5 12 1.8-5.2L21 14Z'/><path d='M7.2 2.2 8 5.1M5.1 8 2.2 7.2M14 4.1 12 6M6 12l-1.9 2'/></svg>"
    title: 可视化虚拟指针
    details: 每一次点击、按键、滚动都直接渲染在页面上——彗尾光标与点击冲击波，智能体的每一步都看得见。
  - icon: "<svg viewBox='0 0 24 24' width='28' height='28' fill='none' stroke='url(#ob4)' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><defs><linearGradient id='ob4' x1='2' y1='2' x2='22' y2='22' gradientUnits='userSpaceOnUse'><stop stop-color='#67e8f9'/><stop offset='1' stop-color='#818cf8'/></linearGradient></defs><path d='M3 7V5a2 2 0 0 1 2-2h2'/><path d='M17 3h2a2 2 0 0 1 2 2v2'/><path d='M21 17v2a2 2 0 0 1-2 2h-2'/><path d='M7 21H5a2 2 0 0 1-2-2v-2'/><circle cx='11' cy='11' r='3.5'/><path d='m13.8 13.8 2.9 2.9'/></svg>"
    title: 深度页面读取
    details: 快照穿透 Shadow DOM 与 iframe；截图供多模态模型使用；页内脚本执行用于结果验证。
  - icon: "<svg viewBox='0 0 24 24' width='28' height='28' fill='none' stroke='url(#ob5)' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><defs><linearGradient id='ob5' x1='2' y1='2' x2='22' y2='22' gradientUnits='userSpaceOnUse'><stop stop-color='#67e8f9'/><stop offset='1' stop-color='#818cf8'/></linearGradient></defs><path d='M2 18v3c0 .6.4 1 1 1h4v-3h3v-3h2l1.4-1.4a6.5 6.5 0 1 0-4-4Z'/><circle cx='16.5' cy='7.5' r='.5'/></svg>"
    title: 自带模型接入
    details: DeepSeek、智谱 GLM，或任意 OpenAI 兼容、Anthropic 协议、本地 Ollama 端点。API Key 只存本地扩展存储。
  - icon: "<svg viewBox='0 0 24 24' width='28' height='28' fill='none' stroke='url(#ob6)' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><defs><linearGradient id='ob6' x1='2' y1='2' x2='22' y2='22' gradientUnits='userSpaceOnUse'><stop stop-color='#67e8f9'/><stop offset='1' stop-color='#818cf8'/></linearGradient></defs><path d='M20 13c0 5-3.5 7.5-7.7 8.9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z'/><path d='m9 12 2 2 4-4'/></svg>"
    title: 控制权在你
    details: 三档权限、逐操作审批卡、可导出的会话日志。敏感步骤等你的点击。
---

# OpenBrowserHarness

[English](index.md) | 中文
