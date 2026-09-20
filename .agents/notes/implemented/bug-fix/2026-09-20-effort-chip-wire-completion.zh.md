# Agent Note：扩展的思考强度从来就没通过——三处断链，wire 级验证

Status: implemented

[English](2026-09-20-effort-chip-wire-completion.md) | 中文

## 问题

批96 的思考强度切换对真实用户从来没有生效过。链条上三处断点同时存在，每一处都遮住下一处：

1. **没有元数据。** 扩展的 Anthropic 适配器 `resolveModel` 不返回 `reasoning`，预设模型也没声明档位——于是 zhipu-coding 的 GLM 路由（composer 思考芯片的启用条件就是解析出的 reasoning 元数据）芯片永久禁用。批96 的门控「无元数据→禁用」忠实地实现了一条从未存在过的数据。
2. **wire 缺口。** 即使有元数据，Anthropic 适配器的请求构造也从不写 `thinking` 成员——对整条 anthropic 协议路由，选了档位 wire 上什么都没变。
3. **类型错位。** composer 用「字符串」过滤目录行里的 `efforts` 来派生菜单，但 wire 视图（ModelReasoningView）带的是 `{id, name}` 对象——过滤结果永远为空、永远回退到固定四档菜单，连有真实元数据的模型也显示它拒绝的档位。同一个字符串过滤还坐在启动自愈和切模型携带两处，把两者一起弄坏。

## 决策

预设模型获得可选的 `reasoningEfforts` 声明（zhipu-coding 的 GLM 模型声明 `['off', 'high']`——它们的思考是二值的）。Anthropic 适配器把声明的档位经 `resolveModel` 透出——与桌面适配器暴露 reasoning 的同一条 resolved 路径——并对声明了档位的模型把请求的 effort 映射为 wire `thinking`：`'off'` → `{type:'disabled'}`，其余档位 → `{type:'enabled'}`，未请求档位 → 完全不写该成员（供应商自己的默认生效）。enabled 形式不带 budget：预设路由的供应商接受裸 enabled。composer 现在用一个共享辅助函数在三处统一从 wire 对象解出档位 id。未声明的模型即使过期调用方发来档位也保持无档位，响亮拒绝的契约不变。

## 考虑过的替代

- **给 GLM 声明 off/low/high/max。** 否决：供应商思考是二值的；宣传 wire 无法区分的细粒度档位是虚假元数据。
- **enabled 形式附带 `budget_tokens`。** 暂缓：预设路由接受裸 enabled，`thinking` 内未知成员有硬拒风险；将来真实 Anthropic 路由声明档位时随声明自带 budget。
- **只修 composer 的字符串过滤。** 否决：那会让芯片为一个空集启用——GLM 路由仍缺元数据和 wire 映射，用户可见的坏的就是它们。

## 后果

- 思考芯片在 GLM zhipu-coding 路由端到端可用：芯片启用、按模型菜单（默认/关/高——没有低/中）、所选档位可在 wire 验证（带工具的主回合请求上捕获到 thinking enabled/disabled）。
- openai 路由上有元数据的模型菜单派生也修正了——DeepSeek 声明的 off/low/high/max 不再被回退列表遮住。
- 覆盖：适配器 spec 断言 thinking 映射（关/启用/缺席，未声明模型保持无档位）与 resolved reasoning 档位；composer spec 用 wire 形状的 `{id, name}` 行驱动按模型菜单；真机装置把 zhipu-coding 路由指向 anthropic-wire mock，切「高」再切「关」，捕获两份 wire 请求体，重启扩展，验证干净的新开与「关」姿态恢复。
