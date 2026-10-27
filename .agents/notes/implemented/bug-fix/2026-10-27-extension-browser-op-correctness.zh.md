# Agent Note：五处浏览器操作正确性与等待效率修复

Status: implemented

[English](2026-10-27-extension-browser-op-correctness.md) | 中文

## 问题

扩展浏览器操作面上的五个相互独立的正确性/效率缺陷，每个都有用户可感知的失败形态：

- **scroll settle 超时双滚。** 页内 settle 轮询打到 2.5s 预算（resolve null）时，`scroll()` 把 `settled` 回退成 `before`——把未知移动当成零移动。已部分滚动的 gesture 在预算耗尽后还在继续跑，全量补滚又压在已滚过的部分上（双滚）。
- **attach 进行中发 CDP 命令假性失败。** `attaching` 里已有该 tab 时，`send()` 跳过 join 直接发命令——命令落进调试会话尚不存在的窗口，Chrome 以 Not attached 拒绝，翻译成误导性的「调试会话已断开」，模型看到的是一个坏会话。
- **type_text 撞平的 30s 死线。** provider 的每次调用死线是平的 30s；拟人化串键每个字符最多吃一个 maxDelay（150ms），200+ 字符的合法输入可能活过上限，打字明明在正常推进却被误报为浏览器操作超时。
- **skip 读回视同成功。** 键入目标选择器解析到包裹层（非文本输入元素）时，值读回返回 `skip`，`ensureInputValue` 当作校验通过——而键入事件实际落在 `document.activeElement` 上（也可能哪儿都没落）。静默的错误定向输入。
- **每个已满足的轮询都白付一个 interval。** `pollUntilExpression` 先注册 `setInterval` 再调 `check()`，已满足的条件（元素已在、页面已 complete）也总是等满一拍——waitFor（200ms）、scroll settle（150ms）、settleNavigation（120ms）的每次快路径都在付。

## 决策

- **scroll（mouse.ts）：** settle 超时视为未知移动：补一次普通 `window.scrollY` 读数，按实际位置算 residual；补读也失败（页面已导航、执行环境已销毁）才按零移动降级。residual 计算、±1 容差、批39/40 对丢弃/部分/反向 gesture 的语义全部不变。
- **CDP attach（cdp.ts）：** `send()` 在未 attached 时无条件走 `attach(tabId)`——`attach()` 本就幂等且会把进行中的任务递回来，并发 send 共享一次 attach，命令等会话存在后再发。`handleDetached` 保留进行中的 `attaching` 条目（onDetach 通知取消不了正在跑的 `doAttach`；删掉条目会让后来者发起第二个被拒的 attach）。attach 完成后的真实 detach 保持原有「调试会话已断开」报错不变。
- **type_text 死线（browser-provider.ts）：** 拟人化输入能力开启时，`type_text` 的死线为 `30s + 码点数 × maxDelayMs`，`maxDelayMs` 从 op params 读取（默认 150，与 ops.ts、keyboard.ts 同一默认）。拟人化关闭、或从 op params 读不到文本时，回落平的 30s。不加 provider→SW 取消信号——死线之后 SW 侧仍在打字；本修复只是让模型不再被误导。
- **skip 降级（keyboard.ts）：** `skip` 读回改为校验 `document.activeElement`——键入事件真正到达的元素——匹配语义与目标元素读回一致（分隔符不敏感），但不做回写（该元素从未被模型点名，静默修复可能写进无关字段）。仍不可编辑则抛「目标不是可输入元素」；可编辑但值不一致则抛带长度的标准 mismatch 错误。
- **poll 首拍（dom-snapshot.ts）：** 轮询体抽成导出的闭包自由函数 `pollUntilBody`（注册 interval 前同步调用一次 `check()`，命中即 resolve），`pollUntilExpression` 变成它的一行序列化——线上表达式形状不变，且无需动态执行即可单测。waitFor / scroll settle / settleNavigation 三个消费方零改动继承快路径。

测试锁定随同更新：旧的「degrades to safe defaults」scroll 用例改写为新语义（超时→补读→按实际位置；补读也失败才按零移动），新增「超时但已部分滚动不再双滚」；新建 `cdp-attach.spec.ts` 锁 60ms attach 竞态窗口与 handleDetached 的进行中条目保证；`keyboard-error-passthrough.spec.ts` 锁 wrapper-skip 的校验通过/抛错一对；`browser-provider.spec.ts` 锁伸缩死线与 30s 回落；`navigation-settle.spec.ts` 锁已满足条件零 interval。受影响的 JSDoc 契约在同一次编辑里更新（send/handleDetached、ensureInputValue、scroll、provider 死线条目）。

## 考虑过的替代

- **provider→SW 取消信号，让超时的 type_text 真正停下。** 本批否决：需要新 wire 消息与逐 op 管道；死线伸缩已消除用户可见的误报，取消是中期项。
- **skip 分支 mismatch 时把文本回写到 `document.activeElement`。** 否决：聚焦元素从未被模型点名——静默修复可能覆盖无关字段；只校验让失败响亮且可归因。
- **经 `new Function` 执行序列化表达式来测 poll。** 否决：仓库的注入安全门拦动态执行；抽出 `pollUntilBody` 直接测同一语义，序列化器保持一份表达式形状。

## 后果

- settle 超时不再双滚；部分 gesture 只补差额，完全读不到的页面照旧按零移动降级。
- 两个命令撞上慢 attach 都能成功，不再有一个报坏会话；进行中的 detach 通知无法分裂 attach 任务。
- 长文本拟人化打字不再在正常推进时误报浏览器操作超时；短/快路径维持 30s 上限。
- 包裹层选择器的键入要么按实际聚焦元素校验通过，要么报「目标不是可输入元素」——静默错误输入不复存在。
- 每条快路径轮询不再吃 interval（快路径上 waitFor 省 200ms、scroll settle 省 150ms、settleNavigation 省 120ms）。
