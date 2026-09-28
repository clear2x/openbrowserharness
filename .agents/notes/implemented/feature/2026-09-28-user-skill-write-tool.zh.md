# Agent Note: user_skill_write——模型可以编写与删除技能

Status: implemented

[English](2026-09-28-user-skill-write-tool.md) | 中文

## Problem

智能体只能读技能、不能写：`tool-skill` 只暴露加载工具，浏览器存储提供方在接缝处只读，唯一的管理面是一个零调用方的 api-bridge RPC。用户想让智能体记住一段可复用流程，只能自己粘进面板；而「自循环」目标（智能体改进自身工具）在技能编写这条腿上是缺的。

## Decision

技能写入接缝贯穿能力的三个角色：

- **服务定义**（`packages/skill/skill`）：`SkillProvider` 增加可选 `persist` 能力（`write(input)` / `remove(name)`），`SKILL_NAME_PATTERN` 与 `SkillWriteInput` 成为包级名称与载荷契约。registry 新增 `ctx.skills.writeSkill(input, options)` 与 `ctx.skills.removeSkill(name, options)`：在接缝处校验（kebab-case 名称、非空 description/content、空串 `whenToUse` 拒绝），按读取相同的合并顺序选第一个可写提供方，委托后使目录失效，下一次查找与会话目录即包含新技能。由存储变更事件驱动的提供方会双重失效；无害。
- **浏览器提供方**（`chrome-skill-storage`）：实现 `persist`，委托既有的 `writeStoredSkill`/`removeStoredSkill` 管理函数——模型写入落到的正是 api-bridge RPC 路径写的同一批记录，提供方的存储变更监听会自动重发目录。
- **消费者工具**（`tool-skill`）：`user_skill_write` 接收 `action: "write" | "remove"` 加 `name`、`description`、可选 `whenToUse` 与 `content`；把 registry 的校验错误与无可写提供方错误透出为工具错误，结果卡片显示「saved」/「removed」。

扩展组合除重建 lib 外无需改动：chrome 插件注册提供方，工具随 `tool-skill` 的挂载点注册。

## Alternatives considered

**扩展原生工具直连 chrome.storage。** 否决：仓库的工具面都在共享包里走 ctx 缝（浏览器工具族消费 `ctx.browser` 同理），扩展专属工具既要开挂载先例，又要复刻提供方已拥有的存储逻辑。

**仅运行时注册（`ctx.skills.register`）不做持久化。** 否决：运行时技能随会话消亡、没有存储生命周期；要点正是跨会话存活的技能，而存储提供方本就持久化。

**拆成独立的 `user_skill_remove` 工具。** 暂时否决：单工具加封闭 `action` 联合让目录保持精简，也贴合模型对同一对象保存/删除的推理方式；若提示词出现混淆再拆分也很容易。

## Consequences

模型现在可以保存与删除技能，保存的技能经失效后进入下一轮的会话目录。代价：写入接缝是新的公共 registry 面（校验错误模型可见，必须保持清晰）；覆盖率需维持 100%（registry 与工具 spec 覆盖包括无可写提供方在内的每个分支）； recorded-session 快照语料在本改动前于 `main` 上已是红的（模型配置线未重录的提示词导致 HEAD 102 个失败），下次在环境对齐后重录时，工具 schema 会额外编码本工具——此处尝试的部分重录未半绿提交，已回滚。

## Verification

Registry spec 覆盖委托、合并顺序偏好、失效驱动的查找、每个校验分支与无提供方错误（43 测试）。工具 spec 经真实 ToolRuntime 加活 registry 覆盖写入/删除、空 `whenToUse` 省略、全部错误分支、展示卡片与双工具 schema 清单（38 测试）。根 typecheck 与 lint 干净，工具目录双语再生，重建的引擎包含该工具。
