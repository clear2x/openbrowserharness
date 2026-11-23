# 商店提交通知单（Chrome Web Store + Microsoft Edge Add-ons）

[English](SUBMISSION.md) | 中文

上传件与全部粘贴材料已备齐，照本单逐步执行即可。两商店共用同一上传件与同一套 listing 材料。

## 上传件（两商店同一包）

从 [Releases · extension-v0.8.1](https://github.com/clear2x/openbrowserharness/releases/tag/extension-v0.8.1) 下载：

- `OpenBrowserHarness-extension-v0.8.1.webstore.zip` — Chrome Web Store 上传件
- 同目录 `.zip`（解压版结构）— Edge Add-ons 上传件（Edge 接受同一 manifest 结构）

后续每个新版本：改三处版本号 → tag → CI 自动出包 → 回到两商店开发者后台「上传新版本」。若由 tag 触发的发版工作流失败，在 `main` 上修掉原因后手动触发「Extension release」工作流，它会按 `apps/extension/package.json` 中的版本发布当前代码树。

## 粘贴材料（全部现成，逐字段对应）

| 材料 | 位置 |
| --- | --- |
| 双语 listing 全字段（名称/类别/语言/描述） | [listing.zh.md](listing.zh.md) |
| 权限理由逐项（12 项权限加主机权限） | [listing.zh.md](listing.zh.md) 「逐权限论证」节（CWS 隐私权页签直接粘贴） |
| 商店图标（128×128，无 alpha） | [screenshots/store-icon-128.png](screenshots/store-icon-128.png) |
| 商店 logo（300×300，Edge 必交） | [screenshots/store-logo-300.png](screenshots/store-logo-300.png) |
| 大图（1400×560） | [screenshots/promo-marquee-1400x560.png](screenshots/promo-marquee-1400x560.png) |
| 小图（440×280） | [screenshots/promo-tile-440x280.png](screenshots/promo-tile-440x280.png) |
| 截图（每个 locale 4 张，1280×800，中英各一套） | [screenshots/shot-s1~s4(-en).png](screenshots/) |
| 隐私政策 URL（两商店都填） | `https://clear2x.github.io/openbrowserharness/en/reference/privacy` |
| 官网 / 支持页 | `https://clear2x.github.io/openbrowserharness/` · `https://github.com/clear2x/openbrowserharness/issues` |

## 一、Chrome Web Store（$5 一次性注册费）

1. **注册开发者**：打开 `https://chrome.google.com/webstore/devconsole/register`，用你的 Google 账号登录，缴 $5 一次性注册费（需一张信用卡；此步只能你本人操作）。
2. **上传**：开发者后台 → 「New item」→ 上传 `webstore.zip`。
3. **Store listing 标签**：按 [listing.zh.md](listing.zh.md) 逐字段粘贴（描述填在英文 locale 下；另加简体中文 locale 粘贴中文文本）；上传商店图标、大图与截图。
4. **Privacy 标签**：
   - Privacy policy URL 粘贴上方链接；
   - 「Single purpose」填：*Run an AI agent that automates browsing on the pages the user directs it to*；
   - 权限理由逐项粘贴 [listing.zh.md](listing.zh.md)「逐权限论证」各条；
   - 数据披露：勾选「does not sell / not used for unrelated purposes」，声明页面内容仅发送到用户自己配置的 LLM 端点。
5. **Distribution 标签**：公开（Public）；默认全球。
6. **Submit for review**。`debugger` 权限属深度审查项，首次审核通常 1–7 天；审核意见会发到注册邮箱，按意见补说明重提即可。

## 二、Microsoft Edge Add-ons（免费）

1. **注册开发者**：打开 `https://partner.microsoft.com/dashboard/registration`，用微软账号登录，开发者类型选 **Individual**（个人免费），完成手机/身份验证（此步只能你本人操作）。
2. **创建扩展**：Partner Center → 「Create a new extension」→ 上传 `.zip`（Edge 接受与 CWS 同构包）。
3. **Submissions 表单**：Name/Description 按 [listing.zh.md](listing.zh.md)（Edge 中国区流量高，建议描述先中文）；Store logo（300×300）与宣传图同上；隐私政策 URL 同上。
4. **审核**：提交后 1–3 个工作日；状态在 Partner Center 的 Submission 页。

## 三、版本更新节奏

之后每次发版（改版本号 → tag → CI 出包）：两商店后台分别「上传新版本」→ 复用既有 listing（仅更新"新版本说明"可选）→ 提交。更新审核通常快于首次。CWS 的特点：有待审提交期间「商品详情」页签为只读，图标与截图的更换要等那次审核结束；仅改商品详情（图标、截图、简介）会单独走一次审核，线上软件包不受影响；手工上传的商店图标会覆盖包内图标，品牌标识变更后若不手工替换，商店页面永远不会显示新图标。

## 审核风险与应对

- **`debugger` 权限**是两商店的共同深审点。应对已内建：权限理由明确「仅附加到任务目标标签页、会话结束即分离」；listing 与官网均强调「可见、可审批、日志可导出」。若被拒，回复审核邮件补充演示视频（可用探针录制的 GIF）即可。
- **端侧 AI（v0.8.0）**给扩展 CSP 加了 `'wasm-unsafe-eval'`，并按需下载模型权重。应对已内建：审核员说明写明该关键字只放行 WebAssembly、模型是由包内运行时加载的数据，并逐项列出全部网络端点。每次发版都要保证这些陈述属实，复用说明前先在构建产物里重新统计 `new Function`。
- **首次提交建议**：先提 Edge（免费、快）验证 listing 措辞，再提 Chrome，降低 $5 后的来回修改成本。
