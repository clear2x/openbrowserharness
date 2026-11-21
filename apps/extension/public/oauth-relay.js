// OAuth 回调中转页脚本。外链文件：MV3 扩展页默认 CSP（script-src 'self'）
// 禁止内联脚本执行——内联版曾让本页永远停在静态占位文案，转发从未发起。
//
// 平台把授权重定向到回环地址，declarativeNetRequest 拦截规则把它重定向到本
// 页（code/state 在查询串里）。本页把结果直接转发给引擎宿主（offscreen）的
// web-server shim，由它送进账号 Host 的 webserver/request 瀑布完成 PKCE 交
// 换。端口与 SW 拦截规则同源（shared/protocol.ts 的 OAUTH_LOOPBACK_PORT）。

const OAUTH_LOOPBACK_PORT = 47099

const params = new URLSearchParams(window.location.search)
const code = params.get('code')
const state = params.get('state')

const status = document.getElementById('status')
const detail = document.getElementById('detail')

function fail(message) {
  status.textContent = '登录回调失败'
  status.className = 'err'
  detail.textContent = message
}

if (code === null || state === null) {
  fail('回调缺少 code/state 参数，请从扩展的登录流程重新发起。')
} else {
  // 转发竞态防护：DNR 重定向刚落地的瞬间，接收端上下文可能尚未应答（实测
  // 首次 sendMessage 会悬空）。带超时重试，最多 6 次。
  const once = async () => await new Promise((resolve) => {
    let done = false
    chrome.runtime.sendMessage({
      channel: 'oauth-callback-forward',
      code,
      state,
      originHost: '127.0.0.1:' + String(OAUTH_LOOPBACK_PORT),
      callbackPath: '/oauth/callback',
    }, (response) => {
      done = true
      resolve({ settled: true, response })
    })
    setTimeout(() => { if (!done) resolve({ settled: false }) }, 2000)
  })

  void (async () => {
    try {
      let last = '转发超时'
      for (let attempt = 0; attempt < 6; attempt++) {
        if (attempt > 0) await new Promise(resolve => { setTimeout(resolve, 1000) })
        detail.textContent = attempt > 0 ? `正在转发（第 ${attempt + 1} 次）…` : detail.textContent
        const result = await once()
        if (!result.settled) { last = '转发超时'; continue }
        const response = result.response
        if (response?.ok === true && (response.status === undefined || response.status < 400)) {
          status.textContent = '登录已完成'
          status.className = 'ok'
          detail.textContent = '凭据已交给 OpenBrowserHarness，可以关闭本页回到面板。'
          last = ''
          break
        }
        if (response?.ok === true && typeof response.status === 'number' && response.status >= 400) {
          // 引擎已收到但拒绝本次回调（state 校验失败等）——重试无意义。
          fail('引擎拒绝了本次回调（校验未通过），请回到面板重新发起登录。')
          last = ''
          break
        }
        last = String(response?.error ?? 'no response')
      }
      if (last !== '') fail('扩展未能接收回调：' + last)
    } catch (err) {
      fail('转发失败：' + String(err?.message ?? err))
    }
  })()
}
