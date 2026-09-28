# Agent Note: 扩展发布管线与商店提交材料包

Status: implemented

[English](2026-09-28-extension-release-pipeline-and-store-kit.md) | 中文

## Problem

商店提交需要一个可复现的发布产物和可粘贴的 listing 材料，而仓库两者皆无：没有扩展的发布 workflow（既有 `release-publish.yml` 发的是 npm tarball）、没有商店 listing 文案、没有审核员打得开的隐私政策页、也没有截图。首个发布的 zip（`extension-v0.2.0`）还早于会话删除功能，商店候选版必须从一次从未构建过的版本上切出。

## Decision

- **发布工作流**（`.github/workflows/extension-release.yml`）：`extension-v*` tag 推送或手动 dispatch；dispatch 按 `apps/extension/package.json` 的版本发布。每个 release 附带三份资产：供 Load-unpacked 用户的文件夹包裹 zip、`manifest.json` 位于压缩包根目录的 `.webstore.zip`（商店上传表单要求的布局）、以及 `SHA256SUMS.txt`。npm 序列沿用 `dsh-v*` tag；纯 `v*` 留空。
- **商店提交材料包**（`docs/store/`，刻意不上站）：逐字段映射的双语 listing 文案（名称、实测长度简介、详细描述、单一目的）、九条逐权限论证、声明页面内容将传输至用户自配 LLM 端点的数据披露答案、远程代码声明、审核员说明、素材对照表。
- **渲染素材**：中英两套精确 1280x800 的截图（品牌 HTML 模板经 Playwright 逐元素截图）、CWS 可选促销小图（440x280）与横幅（1400x560）、以及用 resvg 从单一源 `icon.svg` 渲染的 300x300 Edge logo。
- **审核员说明**记录包扫描结论：仅有的网络端点是用户自配供应商（默认 api.deepseek.com、open.bigmodel.cn），五处 `new Function` 全部属于 Schemastery 库——一处 try/catch 的 `allowsEval` 探测（在扩展页 CSP 下降级为 jitless 模式）、四处 `typeof === "string"` 加 try/catch 双守卫的字符串回调编译（内置真函数配置下不可达）。用户插件只在 manifest 声明的沙箱页执行。
- **随包 manifest 说产品名**（v0.2.2）：description 与工具栏提示去掉了审核员会在 `chrome://extensions` 里看到的内部「dsh」简称。

### 发版 SOP

在根 `package.json`（喂 `__DSH_VERSION__` 构建注入）、`apps/extension/package.json`（命名 release）、`apps/extension/public/manifest.json`（随包发行）三处升版本号——三者同升或缺一不可；更新 `CHANGELOG.md`；commit、push；打 `extension-vX.Y.Z` tag；推送 tag。以下载已发布的校验和与实际 zip 验证为准，不信任 run 状态。

### 冒烟测试

发布的 `.webstore.zip` 本体经 `launchPersistentContext` 加一次性 profile 装进真实 Edge：service worker 注册、侧栏页启动到欢迎视图、composer 渲染完成。面板 composer 是 shell 的 `textarea` 而非 contenteditable——按后者断言会超时。唯一控制台报错（`cannot get required service "sessions" in inactive context`）是已知的 `AgentPresetSeatController` 残留，非本构建引入。

## Alternatives considered

**在 release 上发 `.crx` 文件。** 否决：Chrome/Edge 稳定版在 Windows/macOS 封杀非商店来源 CRX（除企业策略或 Linux 拖拽），且扩展 ID 由打包私钥决定，不带持久化 `.pepk` 重打包会变 ID、更新时用户数据分家。zip 到处可 Load-unpacked，也正是商店接受的产物。

**只发一个 zip（不做 `.webstore.zip`）。** 否决：商店上传表单要 `manifest.json` 在压缩包根目录而用户要文件夹；同一 dist 出两种布局，省掉每次提交前手工重打包一步。

**第三方 release action（softprops/action-gh-release）。** 否决：`gh release create/upload` 配 workflow token 把供应链保持在第一方 action 加预装 CLI，与仓库既有 release workflow 一致。

**本地打包手工上传。** 否决：tag 触发的 CI 构建可复现且一键，本地 `dist` 会过期——首次冒烟就误指了过期本地构建（还是 0.2.0），之后才改指发布产物。

## Consequences

切版本现在是一次 tag 推送，商店候选版已构建、发布、校验和验证、冒烟装载。代价：四处版本号必须一起动（v0.2.2 那轮漏了 manifest 版本，因为同一提交改了它的 description 掩盖了遗漏，几分钟后强制移动 tag——对分钟龄的自有 tag 安全，workflow 以 clobber 重发资产）；listing 一变，材料包的计数与文案就要重新核验；reviewer notes 必须随未来包变更保持如实。
