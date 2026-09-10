# Agent Note: 扩展 SidePanel 内的设置面为全出血扁平形态

Status: implemented

[English](2026-08-29-settings-surface-flat-redesign.md) | 中文

## Problem

`SettingsRoot` 按「网页弹窗」设计：灰色 mask 遮罩 + 内缩的 max-width 重阴影圆角白卡。挂进 387px 的扩展 SidePanel 后，这个形态被读成「一个灰色大容器里浮着白卡」——用户原话：内卡四周一圈巨大灰隙，毫无高级感。三个加重因素：分区 tab 行溢出成横向滚动条；内卡自带 × 与壳的关闭重复；卡内表面再次嵌套——options 容器、section 区块、rail 卡、formGroup 卡、最后才是输入框，每层都有自己的底色/边框/圆角，且 `.section { height: 100% }` 把短内容下方拉伸出大片空白灰区。AX 树止于请求头 textarea：下方的节点已挂载但不可达。

## Decision

宿主宽度 ≤768px 时，设置面是一张全出血的 sheet，并且是扁平的。

- **全出血。** mask `display: none`；`.panel` 以 `bg-base` 铺满 100%×100%，无圆角/边框/阴影，tab 带与壳 header 齐平——sheet 是壳的延续，不是覆盖其上的对话框。`@media` 与 `@container`（overlay 即 inline-size 容器） twins 携带完全相同的规则，断点从 559px 迁到壳中央表的 768px。>768px 保留居中卡片形态并收紧：r16、1px label-8% hairline、`--dsw-shadow-lv2` 替代重板。
- **一条 36px 顶栏。** 「设置」标题行删除（视觉隐藏 seat 保留 dialog 的 `aria-labelledby`）；顶栏承载 tabs、操作 seat 与唯一的 ×。tab 为下划线式——12.5px 文字压 2px 品牌色下划线，下划线覆盖顶栏自身的 hairline——滚动条用饥饿法移除：收紧间距、≤430px 隐图标（文字标签保留，它们是 tab 的可访问名）、最后 ellipsis。
- **扁平内容。** `ui-settings-models` 内不再有卡片：rail 是裸 chip 条，editor 与 form 组直接坐在 `bg-base` 上，模型目录行是普通行 + 内联 ghost 添加按钮，组之间以保存区上方的 1px label-8% hairline 分隔。输入框为 tint 填充——`interactive-bg-hover[-solid]`、r8、34px、静息透明边、品牌 focus ring——所有按钮 `white-space: nowrap`。
- **字阶整体下调**：页标题 15/600、组标题 12/600、正文与输入 13px、提示 12px muted。

设置读写逻辑与 wire 载荷零改动；本变更只涉及呈现与表面。`ModelsSection` 同日供应商工作的分组结构保留——扁平化改变表面外观，不改变分组内容。

## Alternatives considered

- **把 tab 行移进壳 header 行**（用户的第一个建议）。设置面是 `position: fixed; inset: 0` 的模态层，盖住壳 header；共享 header 行意味着取消模态化并重改已定稿的 header，还会破坏 >768px 的居中卡片形态。所选的等效方案——删除设置面自己的标题行、让 36px tab 带齐平坐在壳 header 之下——以极小的改动量获得同样的阅读效果。
- **壳侧类茎覆盖（`[class*="overlay"]`、`[class*="panel"]`）。** 这是壳的既有模式，但那会让弹窗卡设计继续作为事实源、在它旁边拴一个扩展专用的反向设计。直接修 `SettingsRoot.module.css` 让 dsh web 的窄窗口同样受益，并保持单一事实源。壳侧现在 pin 了一条守卫：此槽不得长出 `[class*="overlay"/"panel"]` 类茎覆盖。
- **按第一版规格用 `bg-layer-1` 做输入框填充。** 浅色主题下不可见：`bg-layer-1` 等于 `bg-base`，填充会消失。填充改用 `--dsw-alias-interactive-bg-hover[-solid]`——应用标准的 6–8% tint，明暗主题都呈现填充感。
- **formGroup 用 tint 卡。** Round-1 截图显示 tint 组面叠在 tint 输入框上方会重新引入重设计要消灭的嵌套感。组是扁平的：12/600 muted 标题压在字段上。

## Consequences

扩展设置读起来像原生设置页：无灰隙、无嵌套卡、内容端到端可滚动（AX 树能到达模型行、添加模型按钮、测试连接与保存——此前止于请求头 textarea）。去卡化后对话框语义仍在：可访问名走隐藏 seat，Escape 关闭，唯一 × 是指针关闭路径（全出血形态下不存在点 mask 关闭）。宽宿主保留卡片形态，点 mask 关闭的路径在彼处成立。

dsh web 应用继承此变更：窄 web 窗口得到同样的全出血 sheet，宽窗口得到收紧后的卡片。一个 headless-Chrome 截图 harness（建于 `/tmp/dsh-settings-flat/`，可再生成）以真实 module.css 在 387/494/900、明暗两主题下渲染，经两轮视觉迭代；harness 还发现了自身的坑——headless Chrome 最小窗宽 500px，「387px」截图必须把文档装进 iframe，媒体查询才会响应 iframe viewport。

## Testing

`packages/client/ui-settings-general/tests/styles.client.spec.ts` 钉住全出血 twins、token 纪律（无字面色）、无滚动条 tab 带与图标降级阶梯；`settings-root.client.spec.tsx` 钉住顶栏结构与隐藏标题 seat；`packages/client/ui-settings-models/tests/styles.client.spec.ts` 钉住扁平纪律（rail/editor/formGroup/catalog 无卡面、tint 填充透明静息边输入、按钮 nowrap）与供应商分组；`apps/extension/tests/caps-css.spec.ts` 钉住壳挂载类与「无类茎覆盖」。三个套件同时全绿（变更点 34 文件 305 用例）。
