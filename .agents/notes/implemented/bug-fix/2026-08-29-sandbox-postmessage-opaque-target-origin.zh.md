# Agent Note: 沙箱 postMessage 必须以 '*' 指向 opaque origin

Status: implemented

[English](2026-08-29-sandbox-postmessage-opaque-target-origin.md) | 中文

## Problem

`user_plugin_write` 与 `user_plugin_toggle` 几乎每次调用都报 `沙箱运行响应超时（45000ms）`，但插件实际已写入、（toggle 场景）已激活——`user_plugin_list` 每次都能确认记录存在。长期的「超时 ≠ 失败」解读把 45s 窗口当成冷启动预算，先后放宽两次（15s → 45s）都没有触及失败本身。

机制：host→sandbox 方向的 postMessage（`run`/`emit`/`unload`）以**扩展 origin** 作为 `targetOrigin` 寻址 iframe window。而 `manifest.sandbox.pages` 声明的页面运行在 **opaque（"null"）origin** 上——按 HTML 规范，具体 origin 永远无法匹配 opaque 目标，user agent 静默丢包。出站代码旁边就是入站注释「Sandboxed frames report an opaque origin」；入站方向（`ready`、run 回包）用的是 `parentTarget()`（ancestor origins，否则 `'*'`）因此始终可达——这解释了为什么 10s ready 握手一直成功而每次 run 烧满 45s。

「超时 ≠ 失败」还有结构性原因：`write`/`toggle` 在沙箱激活**之前**就持久化插件记录，操作中耐久的另一半早已完成，挂起的只有激活那一半。用户看到的是超时报错，紧挨着的列表却显示插件在。

## Decision

所有 host→sandbox 的 post 一律以 `'*'` 为目标（`SANDBOX_TARGET_ORIGIN`），常量处注释写明 opaque-origin 约束。发送方身份从未依赖 `targetOrigin`：两个方向都把 `event.source` 与保留的 frame 引用严格比对，`'*'` 放宽的是谁可以**尝试**向该 frame 投递，不是谁会被采信。

同一变更顺带修复两个相邻缺陷：

- **被拒绝的 `readyPromise` 被永久缓存。** 握手超时会让后续所有操作复用这个旧拒绝，与 `start()` 注释宣称的「首次插件操作会重试」矛盾。超时路径现在清空缓存 promise 与 waiter、移除死 frame，下一次 `ensureReady()` 重建。
- 45s 的 `RUN_TIMEOUT_MS` 保留并带上 stuck-pipe-guard 注释：它是挂起检测器，不是性能预算。

`sandbox/main.ts` 与 `user-plugin-tools.ts` 无需改动——回包方向本就送达。

## Alternatives considered

- **去掉 `manifest.sandbox.pages` 沙箱让两侧共享扩展 origin。** 拒绝：沙箱是让不可信的用户插件代码得以求值的隔离边界；为修一个消息细节拆掉它，是用扩展的安全姿态换正确性修复。
- **保留具体 `targetOrigin` 并在运行时探测沙箱真实 origin。** 无从探测——opaque origin 的定义就是不可寻址。沙箱化 frame 内的 `iframe.contentWindow.origin` 报 `"null"`，没有可比对的东西。
- **继续调高 `RUN_TIMEOUT_MS`。** 已做过两次（15s → 45s）；激活前持久化的顺序决定了任何预算下成功都不可见。超时是挂起守卫，就该保持为挂起守卫。

## Consequences

write/toggle 及时返回真实结果：成功是快的，真正的激活失败会以「失败」含义的报错浮出，而不是超时旁边躺着一个成功。`'*'` 意味着任何文档都可以向沙箱 window **投递**，但沙箱的入站 handler 与宿主的回包 handler 都把 `event.source` 与保留 frame 比对，伪造投递会被忽略而非采信。

握手失败可恢复：死 frame 被拆除，下一次操作重建一个；此前首个超时会把 host 毒化到重载。

## Testing

`apps/extension/tests/user-plugins.spec.ts` 以红绿方式钉住机制：run 请求以 `'*'` 发出；回包按 id 匹配（boot 挂载、两笔并发 run、乱序回包、未知 id 忽略）；45s 守卫精确报错并忽略迟到回包；握手超时后下一次操作可恢复；emit/unload 同样 `'*'` 目标。
