# 配置模型

[English](providers.md) | 中文

本指南假定你已按照[根 README](../../../README.zh.md#install-from-source)启动 Web UI。模型变更在下一个请求生效，无需重启服务器。

## 配置 DeepSeek

打开**设置 → 模型**。DeepSeek 卡片提供一个 API 密钥字段；输入密钥并保存。

![模型页：DeepSeek 卡片，以及添加提供方与添加自定义提供方两个入口](providers-models-page.zh.png)

密钥是只写的。保存后，页面只会收到脱敏描述符，永远不会收到明文密钥。密钥存储在 `$DSH_HOME/.credentials.yaml` 中，settings 只保留它的凭据引用。

## 添加目录提供方

选择**添加提供方**，从 dsh 自带的列表中选择；列表展示 `anthropic`、`openai`、Kimi 的 `moonshotai`、GLM 的 `zai` 等提供方 id。输入其 API 密钥并保存。已安装目录会提供端点、协议和模型列表。

使用 OAuth 登录的提供方（如 Codex）此处暂不支持。

## 添加自定义提供方

公司网关、自托管服务器或已安装目录中缺席的提供方，选择**添加自定义提供方**。填写小写的提供方 ID、base URL、API 协议、凭据以及至少一个模型。**API 协议**必须是你的网关所讲的协议，表单提供三种：OpenAI Chat Completions 用 `openai-completions`，OpenAI Responses API 用 `openai-responses`，Anthropic Messages API 用 `anthropic-messages`。一个提供方只讲一种协议，因此同时提供两种协议的网关需要两个提供方。

![自定义提供方表单：提供方 ID、显示名、base URL、API 协议与 API 密钥](providers-custom-form.zh.png)

提供方 ID 是永久的，因为请求、已保存的会话、模型默认值与凭据引用都用它。要重命名提供方，新增一个并删除旧的。显示名、base URL、协议、凭据与模型保持可编辑。

### 发现模型

在**模型目录**下选择**获取可用模型**，向端点询问它提供哪些模型。请求使用表单里当前的 base URL、协议与密钥（或已保存提供方的存储密钥），回复会打开一个可搜索的选择器：搜索、勾选想要的模型，然后选择**添加所选**。在你保存或创建提供方之前，不会存储任何内容。

发现功能读取常见网关发布的清单格式，但并非每个端点都会以其中一种格式应答，所以把它当作便利功能而非保证：当它失败或列表为空时，手动添加模型 id 即可，效果完全相同。内置提供方始终从已安装目录应答，即使它的 base URL 指向某个网关——想看网关真正提供什么，请通过自定义提供方获取。

## 选择模型

已配置的提供方出现在模型选择器中。选择一个模型也会将其设为新会话的默认值。已发送过请求的会话保留其自身日志中记录的模型。

如果保存的默认值指向已删除的提供方，composer 会显示**选择模型**并阻塞输入，直到选择另一个模型。

## 进阶配置

生成的[插件配置目录](../../config-catalog.zh.md)列出每个插件支持的每个字段与默认值；[`dsh-llm-pi-ai`](../../config-catalog.zh.md#deepseek-aidsh-llm-pi-ai) 就是本页配置的提供方分节。[`dsh-llm-pi-ai`](../../../packages/llm/llm-pi-ai/README.zh.md) 与 [`dsh-llm-deepseek`](../../../packages/llm/llm-deepseek/README.zh.md) 参考文档负责直接的 `settings.yaml` 配置、目录解析、推理控制、凭据与适配器错误。

::: tip 表单刻意保持精简
模型页只暴露一条路由存在所需的内容：API 密钥、显示名、base URL、API 协议，以及每个模型的 id、显示名、上下文窗口和最大输出 token。其余所有字段——推理强度档位、图片输入、请求兼容性开关、请求头、超时、重试策略——都写在 `$DSH_HOME/settings.yaml`，也就是本页面写入的同一份文档。直接编辑它即可；当浏览器与服务器在同一台机器上时，也可以用设置页头的**打开配置文件**打开；适配器在下一个请求时重新读取，因此什么都不需要重启。下面的小节覆盖多数网关需要的字段。
:::

### 图片输入

手动输入的模型在它自己声明之前会被视为纯文本，因为没有任何机制能询问端点接受哪些模态。给这样的模型附加图片会在发送前被拒绝，并指名该模型。

因此自定义提供方上的视觉模型需要一行声明。表单里没有这个字段；在 `$DSH_HOME/settings.yaml` 中给模型加上 `input`：

```yaml
llm-pi-ai:
  providers:
    my-gateway:
      apiKeyEnv: GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://gateway.example/v1
      models:
        - id: legacy-chat
        - id: vision-preview
          input: [text, image]
```

`input` 接受 `text` 与 `image`，且只作用于该模型本身，因此一条路由可以同时服务两类模型。省略它——或写一个等价的空列表——会保留已安装目录为该模型记录的内容；目录没有描述的模型则回退到路由的 `defaultInput`。

如果手动输入的每个模型都接受图片，可以在路由上设置一次回退值，而不必逐个声明：

```yaml
llm-pi-ai:
  providers:
    vision-gateway:
      apiKeyEnv: GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://vision.example/v1
      defaultInput: [text, image]
      models:
        - id: first-model
        - id: second-model
```

`defaultInput` 是回退而非覆盖，默认为 `[text]`：在内置提供方上它只为目录没有描述的模型作答，所以绝不会从目录已声明图片的模型上移除图片。要收窄其中某个模型，用该模型自己的 `input`。内置提供方没有可写 `models` 列表，因此写在 `modelOverrides` 下、按模型 id 作键：

```yaml
llm-pi-ai:
  providers:
    anthropic:
      modelOverrides:
        claude-sonnet-4-5:
          input: [text]
```

除模型自身的列表外，每个列表必须至少命名一种模态；模型自身列表的空列表与省略等价。未知模态无论写在哪里都会被拒绝。

两个字段都是对你端点的声明而非校验。声明了端点实际不提供的图片的模型不会在这里被拦截；提供方会转而拒绝该请求。

### 思考强度

对声明了推理档位的模型，模型选择器会提供**强度**菜单。内置提供方的模型从已安装目录继承档位；手动输入的模型没有声明，菜单里不会出现强度入口，由端点自身的默认值决定模型是否思考。用 `$DSH_HOME/settings.yaml` 里的 `reasoningEfforts` 声明档位：

```yaml
llm-pi-ai:
  providers:
    my-gateway:
      apiKeyEnv: GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://gateway.example/v1
      reasoning: high
      models:
        - id: my-reasoner
          reasoningEfforts:
            off:
            high: high
            max: max
```

每个键都是菜单提供的一个档位，其值是线上作为 `reasoning_effort` 发送时的拼写，因此 `max: xhigh` 可以为使用自有词汇的网关重命名一个档位。只有 `off` 可以留空，因为对多数端点而言「不思考」就是该参数缺位。路由的 `reasoning` 是会话尚未选择时使用的档位；在选择器里选择一个强度会连同模型一起保存为新会话的默认值。

留空的 `off` 不发送任何内容，这只对「按需思考」的模型生效；给了值的 `off` 会以该值作为 `reasoning_effort` 发送。对「默认思考、除非被告知不要」的模型——例如 OpenAI 兼容网关背后的 DeepSeek V4——需要 `compat.thinkingFormat: deepseek`，它让 `off` 发送 `thinking: {type: disabled}`，其余档位在强度旁边发送 `thinking: {type: enabled}`：

```yaml
      models:
        - id: deepseek-v4-pro
          compat:
            thinkingFormat: deepseek
          reasoningEfforts:
            off:
            high: high
            max: max
```

内置提供方中网关不支持推理的模型，用 `modelOverrides` 下的 `reasoningEfforts: false` 移除其档位；之后为它选择强度会被拒绝为 `UNSUPPORTED_REASONING_EFFORT`。DeepSeek 官方路由不需要这些：其模型已提供 `off`、`low`、`high`、`max`，`llm-deepseek.reasoningEffort` 设置选择器的起始默认值：

```yaml
llm-deepseek:
  reasoningEffort: max
```

### 请求兼容性

网关可能在可达地址上持有有效密钥，却拒绝每一个请求。pi-ai 依据端点的 URL 决定请求的形态——哪个角色承载系统提示词、哪个字段封顶输出、思考级别如何传递——而它不认识的地址会被当作 OpenAI 本身来对待。多数 OpenAI 兼容网关至少拒绝一件 OpenAI 接受的事。

其中两件占了大多数：声明推理的模型的系统提示词会以 `role: "developer"` 发送，许多网关直接拒绝；输出上限会以 `max_completion_tokens` 发送，只认识 `max_tokens` 的服务器会拒绝。表单里没有这两个字段；在 `$DSH_HOME/settings.yaml` 的路由上纠正：

```yaml
llm-pi-ai:
  providers:
    my-gateway:
      apiKeyEnv: GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://gateway.example/v1
      compat:
        supportsDeveloperRole: false
        maxTokensField: max_tokens
      models:
        - id: my-model
```

路由的 `compat` 是其模型的默认值，模型自己的设置逐字段覆盖，因此只需为一个模型修正而无需重述整条路由：

```yaml
      models:
        - id: my-model
        - id: my-reasoner
          compat:
            thinkingFormat: deepseek
```

两者都未设置的字段保留已安装目录为该模型记录的值；目录没有描述的则交给 pi-ai 的探测。你写下的每个开关都必须有值：留空的键（`supportsDeveloperRole:`）会被拒绝而非忽略，因为空值会在什么都没说的情况下抹掉目录已知的内容。协议不认识的开关名同样被拒绝，报错消息会列出该协议可用的开关。

每个开关归属于声明它的协议，因此在一个 `api` 上有效的开关在另一个上可能被拒绝——报错会点名该协议实际提供的开关。与上面的 `input` 一样，开关是对你端点的声明而非校验：设置一个网关实际不需要的开关，只是让请求长得不一样。

每个开关、其接受的取值以及采用它的协议，都列在[生成的 `dsh-llm-pi-ai` 配置参考](../../config-catalog.zh.md#deepseek-aidsh-llm-pi-ai)的 `PiAiCompatProfile` 下——它从源码派生，因此不会落后于适配器实际接受的内容。

## 排错

- **`MISSING_CREDENTIAL`**：通过模型页存储提供方密钥，或提供被引用的环境变量。
- **`UNKNOWN_MODEL`**：选择已配置的模型，或向自定义提供方添加缺失的模型。
- **获取可用模型返回 401**：检查密钥。模型发现会调用 OpenAI 兼容的 `GET /models` 端点；对于不提供该端点的服务，请手动输入模型。
- **获取可用模型报告既无 `data` 数组也无 `models` 对象**：端点的清单格式不在发现功能可读取的范围内。手动输入模型 id。
- **密钥和 URL 都正确但网关拒绝每个请求**：其请求形态与 OpenAI 不同。在路由上先加 `compat.supportsDeveloperRole: false` 和 `compat.maxTokensField: max_tokens`。
- **只有推理模型失败**：pi-ai 以 `developer` 角色发送其系统提示词，网关拒绝。设置 `compat.supportsDeveloperRole: false`。
- **手动输入的模型不出现强度菜单**：它未声明任何档位。在该模型的 `settings.yaml` 中添加 `reasoningEfforts`。
- **`off` 不能阻止 DeepSeek 模型思考**：留空的 `off` 完全不发送推理字段，而默认思考的端点会继续思考。在模型或路由上设置 `compat.thinkingFormat: deepseek`。
- **compat 开关被拒绝为没有值**：键的冒号后什么都没写。给它一个值，或删除该键以保留已安装目录的行为。
- **图片在发送前被拒绝**：该模型未声明图片模态。请给自定义提供方的模型加上 `input: [text, image]`；DeepSeek 自身的路由请从已配置目录中选择支持图片的型号（默认 `deepseek-flash`），并确认你的网关以图片输入提供该模型。
- **提供方拒绝了带图片的请求**：该模型声明了其端点实际并不提供的图片能力。请从授予它图片能力的那个列表中移除 `image`——可能是模型的 `input`，也可能是路由的 `defaultInput`——然后开一个新会话：附加的图片已留在会话日志中，同一请求会重复出现，直到会话离开它。
