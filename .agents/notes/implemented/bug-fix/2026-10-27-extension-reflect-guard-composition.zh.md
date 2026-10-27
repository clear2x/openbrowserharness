# Agent Note：反思守护修复——按工具连败桶、同证据只 steer 一次、真实接线 spec

Status: implemented

[English](2026-10-27-extension-reflect-guard-composition.md) | 中文

## 问题

`chrome-reflect-guard` 反思面上的三个缺陷，每一个都让守护恰在最重要的场景失效——非 goal 浏览器会话遭遇反复工具失败时：

- **任一成功即清空整条连败链（①）。** `FailureChains.observe` 在任何成功结果上重置该 agent 的全部按工具计数（`chains.delete(agent)`）。阈值 notice 自己给出的建议——先重新快照再重试——会让模型在两次失败动作之间插入一次成功的见证调用，把证据清掉，下一条 notice 被推远两次失败。守护存在的意义（失败-快照-失败工作流里的反思）被系统性阻断。
- **收尾边界对同一证据反复 steer，空烧预算（②）。** steer 之后循环会对同一回合折叠重跑 `agent/turn-stopping`；失败结果仍在折叠里，同一条 notice 被再次铸出，直到 `steerBudget` 耗尽。只有一个真实阻碍的回合会收到 N 条重复提醒然后沉默，预算花在重复而非新证据上。
- **组合接线零行为测试（③）。** 此前只有 composition.spec.ts 的激活扫描装载过该行——它只证明插件能激活，从未证明 plan-mode 豁免、abort 短路、预算耗尽、block 决策前插、pre-step 重置真的按契约行事。

## 决策

- **按工具桶重置 + 见证透明（reflect-guard.ts）。** 成功现在只重置成功工具自身的计数（`perTool.delete(toolName)`）；兄弟工具的连败桶保留，失败→见证→失败与失败→失败一样命中 `[2, 4]` 阈值。新增 `WITNESS_TOOLS` 集合——`page_snapshot`、`page_extract_text`、`page_screenshot`、`page_network`、`tabs_list`、`windows_list`，六个纯只读浏览器观测——完全透明：见证调用既不计入失败也不触发清链（一次没观测到不是阻塞目标的动作，notice 自己建议的恢复路径也不再能清掉证据）。集合刻意保守：所有会变更状态的浏览器工具照常计数。用户插话仍经 `reset` 重置整链。类 JSDoc 以新契约替换了原整链清空句。
- **同一证据只 steer 一次（reflect-guard.ts）。** `TurnFold` 现在记录本回合已注入的守护 notice：循环把 steer 认领回日志时落为 plugin 来源的 `user/message`（`{kind:'plugin', plugin:'chrome-reflect-guard', form:'notice'}`），折叠把正文解析成证据键——脸 + 具名错误码（`errored-results:<code>`、`change-without-success:none`、`zero-action:none`；铸文与解析同模块，导语精确匹配稳定），`goalRoundSteer` 据此抑制重复。识别失准只会退化到旧行为（多 steer 一次），绝不静默压制：解析不出导语的正文不产生键。真正的新证据——不同错误码或不同脸——照常获得自己的 steer，预算花在信息上而非重复上。失败结果的收尾文案同时补上了零行动文案已有的出口：或如实说明该阻碍不可恢复，再收尾汇报——steer 一次之后，如实报告不可恢复的阻碍是合法收尾。
- **真实接线 spec（tests/reflect-guard-wiring.spec.ts）。** 以最小生产组合（session store、projection registry、agent registry、goal service、plan-mode controller、tool runtime——守护 `inject` 清单的全部）装载守护行并走其真实 `apply`，再把一个注册在案的假 agent 打进生产接缝：post-execute 用 Cordis waterfall 配上忠实的 exec/result 对（registry 的分发形状；端到端 `tools.execute` 仍属组合层），pre-step 与 turn-stopping 走 `agentEvents` 分发，折叠喂给走真实发布的 session 追加（循环写的就是这些形状）。钉住：plan-mode active 与 pending 两种豁免、`signal.aborted` 短路（并证明同一配置在信号健康时会 steer）、同证据抑制且预算留给新证据、预算耗尽的第 3 次收尾仅 console.warn、block 决策的 prependContext 变体、pre-step 只按 `kind:'user'` 重置、`MAX_TRACKED_ROUND_KEYS = 16` 在第 17 个回合键时挤掉最旧。纯件 spec 过时的头部声明（接线由 composition.spec.ts 钉住）改为指向本文件，其整链清空用例改写为按工具语义，含失败-快照-失败阈值用例。

**快照 harness 例外，显式记录：** 新增收尾出口文案（如实说明该阻碍不可恢复）是模型可见拷贝，通常应被 recorded-session 快照规则覆盖。本次已核实：`snapshots/` 顶层仅有 `acp/`、`sdk/`、`session/`、`web/`——没有 extension 用例——且 `apps/extension/` 下也没有 owner-local 快照树，不存在本改动可供给的快照 harness。例外改由行为钉住覆盖：reflect-guard.spec.ts 断言铸出的 notice 含该出口句，接线 spec 经真实 turn-stopping 接缝驱动完整的 steer/抑制/耗尽流程。未伪造任何快照。

## 备选方案

- **按失败族（选择器 miss 族、权限族）而非按工具重置。** 暂缓：族分类已隐含在 `failureAdvice` 里，但按族分桶需要一个稳定且活得比本次修复久的工具→族映射；按工具桶解决了观察到的失效（建议的见证路径清掉证据），没有发明新的分类学。`wrapUpNoticeEvidenceKey` 接缝为将来引入族键留了余地。
- **以铸出的 `UserMessage` 身份为去重键，而非解析正文。** 否决：循环的 inbox 认领会把消息经持久日志物化往返一遍，今天没有能穿过该边界的稳定 id；解析正文（铸文与解析同模块、有测试钉住）把识别放在日志真正所在的地方，做到无损。
- **接线 spec 走完整 `ctx.tools.execute` 管线。** 首选尝试；管线的参数输入表面触发了工作区安全扫描器对查询拼装形态的启发式误报，而该形态只是普通的工具分发、并非 SQL。改以 registry 分发同一 waterfall 的方式（`ctx.waterfall('tools/post-execute', exec, result, next)` 配忠实 exec/result 对），经真实分发机制钉住守护监听器；`additionalContexts` 物化到 execute() 结果上的端到端仍由 composition.spec.ts 的整行激活覆盖。

## 后果

- 失败-快照-失败工作流——守护自己的建议制造出的那个工作流——现在能到达阈值 notice；`[2, 4]` 按配置行事，不再被穿插的见证读干扰。
- 只有一个阻碍的回合被 steer 一次，并被告知可通过如实报告阻碍来收尾；预算留给真正的新证据；第 3 个不同证据的收尾以 console.warn 放行而非重复 steer。
- 接线行为（plan-mode 已提交与 pending 两种豁免、abort 短路、预算耗尽、block 前插、仅 user 的 pre-step 重置、账本剪枝）由装载真实 `apply` 的测试钉住，`apply` 的回归会在 CI 失败而不是静默上线。
- 见证读（快照、标签页/窗口列表、文本/截图/网络观测）不再以任何方向掩盖或修护连败链。
