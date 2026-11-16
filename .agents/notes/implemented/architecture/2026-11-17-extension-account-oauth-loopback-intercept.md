# 2026-11-17 扩展账号 OAuth 回环拦截换道

EN: The browser extension's DeepSeek account sign-in pivoted from a docs-site bridge page to a loopback redirect intercepted by declarativeNetRequest, after the platform was empirically shown to reject non-loopback redirect URIs.

## 决策

B4 OAuth 对齐最初拍板「文档站建桥页 + externally_connectable」。实测推翻其前提：
`auth_init` 对 `redirect_uri` 只接受回环 HTTP origin——`https://clear2x.github.io/oauth/callback`
返回 `PAYLOAD_SCHEMA_MISMATCH`（50005），`http://127.0.0.1:<port>` 与 `http://localhost:<port>`
均通过（curl 二分 + 面板内 fetch 双验证）。桥页方案在平台侧不可达，换道为：

- redirect_uri 固定 `http://127.0.0.1:47099`（`shared/protocol.ts` 单一来源）。
- SW 启动即注册一条 declarativeNetRequest 动态规则：正则匹配该回环回调 URL，
  `regexSubstitution` 把导航重定向到扩展内 `public/oauth-relay.html`（code/state 随查询串保留）。
- 中转页 `chrome.runtime.sendMessage` 直达 offscreen 的 web-server shim；shim 以合成
  request/response 把回调重派到上游账号 Host 的 `webserver/request` 瀑布——host/path/state
  校验、PKCE 交换、凭据提交全部是上游原码。
- 前一版的 fork 补丁（`loginOrigin` 额外来源白名单 + 监听器协议推导）与文档站桥页已回退，
  上游 `packages/credentials/deepseek-account` 保持 pristine。

## 代价与坑

- manifest 增加 `declarativeNetRequest` 权限（host_permissions 已有 `<all_urls>`）；
  商店审核需一条回调拦截用途说明。
- DNR 规则省略 `resourceTypes` 时不匹配 `main_frame`——导航拦截必须显式声明。
- 挂载约定：loader 行的模块以「namespace + `apply` 导出」挂载；只导出 default class 的
  namespace 不会实例化（chrome-skill-storage 是正确模板）。
- buffer shim 缺 `Buffer.concat` 时，上游响应读取的 TypeError 被吞成
  `stage=parse-json` 的 protocol 失败——上游诊断会点名 stage，offscreen 控制台不可见时
  可在自有模块临时包一层 `console.error` 落存储供探针回读（诊断后已移除）。
- api-bridge 对可选 seam 一律懒解析（`ctx.get` + 未挂载结构化报错），声明进 `inject`
  会在缺行的组合（如测试夹具）里把 fiber 钉在 pending——泄漏断言当场暴露。
