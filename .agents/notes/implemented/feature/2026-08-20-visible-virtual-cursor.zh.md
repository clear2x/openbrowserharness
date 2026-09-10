# Agent Note: 拟人化手势渲染可见的虚拟指针与轨迹

Status: implemented

[English](2026-08-20-visible-virtual-cursor.md) | 中文

## 问题

扩展用 CDP 合成输入（`Input.dispatchMouseEvent`）驱动页面。这些事件携带全部拟人化特征——贝塞尔轨迹、缓动节奏、到位停顿——但 CDP 从不移动操作系统指针：任何旁观浏览器的人看到的都是悬停态亮起、点击落点出现，**却看不到任何光标**。手势的仿真度是隐形的；而且页面若把指针位置与事件坐标对照，会在本应有指针的地方看到空无。

## 决策

手势可见性由虚拟指针 overlay **在页面内、与输入流同一时间轴**渲染：

- `apps/extension/src/background/virtual-cursor.ts` 向**顶层框架**注入幂等安装器（`Runtime.evaluate`）：一个 fixed 全视口根节点，`pointer-events: none`、最大 z-index，内含一块 canvas 与一个指针箭头（div 内 SVG）。
- 每次移动手势前，SW 先用**与 `Input.dispatchMouseEvent` 流完全相同的路径点和时长**调用 `showGesture(tabId, path, durationMs)`，随后开始派发。两条时间轴共享同一起点，绘制的指针与派发坐标的偏差不超过一次 evaluate 往返；页面侧在 rAF 循环里按归一化时间对路径插值。
- 轨迹是 canvas 上的渐隐折线（700ms 尾巴，越新越粗越蓝）；点击在同一 canvas 上绘制扩散涟漪（`showClick`，在 `mousePressed` 之后触发、不 await，保持按压节奏纯净）。
- overlay 只使用 CSSOM 属性写入与 canvas 绘制——没有 `<style>`、没有 `@keyframes`、没有内联事件——严格的页面 CSP 也无法拦截；手势静止后自行隐去（透明度渐隐 + canvas 清空）。

全部 best-effort：overlay 帮助函数吞掉一切错误；某个页面拒绝 evaluate 也绝不破坏真实手势。

## 曾考虑的替代方案

- **改派 DOM 合成事件流**（真实 `MouseEvent` 携带页面可观察的坐标）—— 否决：丧失 CDP 级保真（原生悬停/焦点驱动），且极易与可信输入区分。
- **逐事件位置同步**（每个 `mouseMoved` 一次 evaluate）—— 否决：每个手势多出 12~30 次往返，拉长按压节奏；一次 kickoff + 共享时间轴在视觉上无法区分。
- **Chrome 扩展光标 API / 操作系统级指针控制** —— 扩展不存在此类 API；仅 DevTools 协议的替代方案超出范围。

## 结果

- 自动化期间旁观浏览器能看到移动的指针、其轨迹与点击涟漪，且与真实输入坐标一致。
- overlay 只存在于顶层框架：进入同源 iframe 的手势仍正确派发，但绘制的是顶层视口投影（坐标一致；iframe 内容本身没有第二个光标）。
- 键盘输入无需视觉对应物：逐键 `Input.dispatchKeyEvent` 已经以可见的打字文本呈现。
- 手势中途页面导航会连同文档销毁 overlay；下一次手势自动重装（安装器对每个文档幂等）。
