# Agent Note：page_attach_screenshot——截图进入网页表单，不经模型中转

Status: implemented

[English](2026-09-12-page-attach-screenshot.md) | 中文

## 问题

`page_screenshot` 把截图作为图片块交付给模型，但浏览器 agent 经常需要反方向：把截图交还给页面——向表单的 `<input type="file">` 上传证据、把地图落点贴进纠错单。工具面没有任何向页面传字节的通道，而且架构让显然的路径不可能：模型收到的是图片不是数据，它无法重新输出自己看到的字节，于是自然语言指令（「把截图粘贴进平台」）无论模型规划得多好都会失败。

## 决策

- `page_screenshot` 在执行时把字节缓存进内存，键为持久 `attachmentId`（LRU，4 条；`rememberScreenshotBytes`）。
- 同族工具 `page_attach_screenshot { tab_id, attachment_id?, selector, filename? }` 读取缓存字节，经浏览器 seam 注入一段脚本：`atob → Uint8Array → File → DataTransfer`，赋值 `input.files`，派发 `input`/`change`。**字节从扩展直达页面，永不经模型**——模型只引用 id。
- `attachment_id` 可选：省略即「最近一次截图」（`readNewestScreenshot`，按插入序）。这贴合模型天性——真机运行两次观察到它臆造 `attachment_id: "latest"`——把这种天性变成受支持的路径。引用的 id 未命中缓存、或缓存为空时，大声失败并给出重新截图的指引，而不是悄悄截错页面。
- 两个截图工具都只在 `ctx.inject(['attachments'])` 下注册；工具目录生成器的 browser 块挂同一个目录附件存储标记，使这一对工具被收编（顺带修复 `page_screenshot` 此前从不出现在目录的欠账）。

## 落选方案

- **模型转发字节**：否——截图是数百 KB 的 base64，走 token 既浪费又失真，还是提示注入面。
- **CDP `DOM.setFileInputFiles`**：否——它需要磁盘文件路径，MV3 宿主对内存截图不持有路径；DataTransfer 路径纯在页面内完成。
- **要求在参数里回显完整 `ImageAttachmentRef` 并从持久存储读取**：否——模型会回显它可能幻觉的元数据；内存缓存未命中时大声失败并给恢复指引。

## 后果

- 贴图仅限 selector（顶层帧 `<input type="file">`，与 `page_type` 一致）且随引擎生命周期（重启清空缓存；未命中消息已说明）。
- 该工具写页面状态，因此从不并行；注入脚本运行在页面自身 CSP 下——无注入 `<style>`、无合成点击。
- 真机端到端验证：高德落点截图 → 贴图（453 KB 与 1.59 MB PNG）→ 页面缩略图渲染 → 提交回显携带截图文件名。
