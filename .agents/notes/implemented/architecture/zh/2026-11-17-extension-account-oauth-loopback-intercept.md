# Agent Note: 扩展账号 OAuth 回环拦截换道

Status: implemented

[English](../2026-11-17-extension-account-oauth-loopback-intercept.md) | 中文

## Problem

B4 OAuth 对齐需要把 DeepSeek 账号登录带进浏览器扩展。最初拍板的方案是文档站建桥页 + `externally_connectable`：平台把授权重定向到文档站的回调页，该页经 `chrome.runtime.sendMessage` 把 code/state 转回扩展。实现进行到 PKCE 对接时被平台实测否决：`auth_init` 对 `redirect_uri` 只接受回环 HTTP origin——`https://clear2x.github.io/oauth/callback` 返回 `PAYLOAD_SCHEMA_MISMATCH`（50005），而 `http://127.0.0.1:<port>` 与 `http://localhost:<port>` 均通过（curl 二分 + 面板内 fetch 双验证）。桥页方案在平台侧不可达，且浏览器宿主无法绑定回环端口接收回调。

## Decision

放弃桥页，换道回环拦截架构：

- redirect_uri 固定 `http://127.0.0.1:47099`（`shared/protocol.ts` 单一来源）。
- Service Worker 启动即注册一条 declarativeNetRequest 动态规则：正则匹配该回环回调 URL，`regexSubstitution` 把导航重定向到扩展内 `public/oauth-relay.html`（code/state 经查询串保留）。
- 中转页 `chrome.runtime.sendMessage` 直达 offscreen 的 web-server shim；shim 以合成 request/response 把回调重派到上游账号 Host 的 `webserver/request` 瀑布——host/path/timing-safe state 校验、PKCE 交换、凭据提交全部是上游原码。
- 前一版的 fork 补丁（`loginOrigin` 额外来源白名单 + 监听器协议推导）与文档站桥页全部回退，上游 `packages/credentials/deepseek-account` 保持 pristine。

## Consequences

- manifest 增加 `declarativeNetRequest` 权限（host_permissions 已有 `<all_urls>`）；商店审核需要一条回调拦截用途说明。
- DNR 规则省略 `resourceTypes` 时不匹配 `main_frame`——导航拦截必须显式声明。
- loader 行的模块以「namespace + `apply` 导出」挂载；只导出 default class 的 namespace 不会实例化（chrome-skill-storage 是正确模板）。
- buffer shim 缺 `Buffer.concat` 时，上游响应读取的 TypeError 被吞成 `stage=parse-json` 的 protocol 失败——上游诊断会点名 stage；offscreen 控制台对探针不可见时，可在自有模块临时包一层 `console.error` 落存储供探针回读（诊断后移除）。
- api-bridge 对可选 seam 一律懒解析（`ctx.get` + 未挂载结构化报错）：声明进 `inject` 会在缺行的组合（如测试夹具）里把 fiber 钉在 pending，泄漏断言当场暴露。
- 端口固定 47099 与本仓 dist 绑定；若与其他本地服务冲突，浏览器导航先被 DNR 拦截，冲突面仅限同路径访问。

## Alternatives considered

- **注册平台回调（撤销换道的前提）**：需要 DeepSeek 侧为客户注册 web origin，外部决策不可控且周期不可预估；即便注册成功，桥页方案仍比回环拦截多一跳外部依赖（文档站可用性）。
- **overlay/ext-`webRequest` 拦截**：MV3 的 `webRequest` 仅可观察不可重定向；`declarativeNetRequest` 是唯一声明式重定向面。
- **fork 侧放宽 `loginOrigin` 接受 web origin**：即便本地放行，平台 schema 仍拒绝非回环 redirect_uri——修上游不解决平台约束，只增加 fork diff。
