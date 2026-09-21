# Agent Note：设置面紧凑化 + 权限区需要的 describe wire

Status: implemented

[English](2026-09-22-settings-compaction.md) | 中文

## 问题

设置面在 420px 侧边栏里按桌面尺度渲染，节奏在两个极端间跳动：外观主题方块（figma 276×82、`flex: 1 1 180px` + wrap）堆成三张巨卡占掉半屏，相邻的 字号大小 输入框却 tiny——同时 权限 区直接显示原始拒绝文本（`此方法在扩展宿主中不可用：settings/describe`）和一个死掉的 不可用 下拉。拒绝与 agentPresets 是同一类词汇缺口：设置面经斜线风格 remote 名驱动文档，而桥只有点式处理器。

## 决策

两个杠杆。桥注册设置文档处理器的斜线风格别名——`settings/describe`、`settings/update`、`settings/replace`、`settings/mutate`、`settings/openSettingsDocument`——权限区（以及未来任何文档读取方）解析到真实描述符而不是不可用拒绝。外壳追加侧边栏宽度的紧凑化块，按属性选择主题包自己稳定的类名词干（`[class*="cubeRow"]`、`[class*="themeCube"]`）：方块收成一行等宽小按钮，padding 与字号同步缩小。属性词干在 css-module 哈希下保持稳定；限制 SHELL_CSS 不得含 `[class*="overlay"/"panel"]` 设置面板分叉的既有守卫继续满足（面板级样式归 ui-settings-general 本体）。

## 考虑过的替代

- **直接改 ui-theme 的 AppearanceRow.module.css。** 否决：桌面布局依赖 180px 换行的方块行；改共享样式表会波及所有宿主。覆盖样式放在有窄约束的宿主里。
- **隐藏权限区。** 否决：describe 别名让真控件渲染；隐藏可用设置是另一种回归。

## 后果

- 通用设置页呈现统一节奏：紧凑主题行、等尺寸下拉与输入框、无错误卡。
- 权限预设区拿到真实描述符；模式控件从活设置数据渲染。
- 覆盖：既有 caps-css 守卫（SHELL_CSS 无 `[class*="overlay"/"panel"]`）+ 扩展全量、typecheck、lint 全绿；真机截图循环在侧边栏宽度下抓全部四个设置页签做视觉确认。
