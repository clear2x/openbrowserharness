// OAuth 回调中转页脚本。外链文件：MV3 扩展页默认 CSP（script-src 'self'）
// 禁止内联脚本执行——内联版曾让本页永远停在静态占位文案，转发从未发起。
//
// 平台把授权重定向到回环地址，declarativeNetRequest 拦截规则把它重定向到本
// 页（code/state 在查询串里）。本页把结果直接转发给引擎宿主（offscreen）的
// web-server shim，由它送进账号 Host 的 webserver/request 瀑布完成 PKCE 交
// 换。端口与 SW 拦截规则同源（shared/protocol.ts 的 OAUTH_LOOPBACK_PORT）。
//
// 本页不在面板的 locale 服务之内：文案按浏览器语言选取——首个主语言子标签为
// zh 的标签取中文、为 en 的取英文，其余一律英文（与登录请求携带的
// navigator.language 同一口径）。

const OAUTH_LOOPBACK_PORT = 47099

const TEXT = {
  zh: {
    lang: 'zh-CN',
    title: 'OpenBrowserHarness — 登录回调',
    completing: '正在完成登录…',
    forwarding: '正在把登录结果转发给 OpenBrowserHarness 引擎。',
    failed: '登录回调失败',
    missingParams: '回调缺少 code/state 参数，请从扩展的登录流程重新发起。',
    attempt: (n) => `正在转发（第 ${n} 次）…`,
    timeout: '转发超时',
    done: '登录已完成',
    doneDetail: '凭据已交给 OpenBrowserHarness，可以关闭本页回到面板。',
    rejected: '引擎拒绝了本次回调（校验未通过），请回到面板重新发起登录。',
    notReceived: (last) => '扩展未能接收回调：' + last,
    forwardFailed: (message) => '转发失败：' + message,
  },
  en: {
    lang: 'en',
    title: 'OpenBrowserHarness — sign-in callback',
    completing: 'Completing sign-in…',
    forwarding: 'Forwarding the sign-in result to the OpenBrowserHarness engine.',
    failed: 'Sign-in callback failed',
    missingParams: 'The callback is missing its code/state parameters. Start sign-in again from the extension.',
    attempt: (n) => `Forwarding (attempt ${n})…`,
    timeout: 'forwarding timed out',
    done: 'Signed in',
    doneDetail: 'Your credentials were handed to OpenBrowserHarness. You can close this tab and return to the panel.',
    rejected: 'The engine refused this callback (verification failed). Return to the panel and start sign-in again.',
    notReceived: (last) => 'The extension did not accept the callback: ' + last,
    forwardFailed: (message) => 'Forwarding failed: ' + message,
  },
}

/** 本页文案：按浏览器语言顺序取首个能判定的主语言，判定不了取英文。 */
function pickText() {
  const tags = navigator.languages.length > 0 ? navigator.languages : [navigator.language]
  for (const tag of tags) {
    const primary = String(tag).split('-')[0].toLowerCase()
    if (primary === 'zh') return TEXT.zh
    if (primary === 'en') return TEXT.en
  }
  return TEXT.en
}

const text = pickText()
document.documentElement.lang = text.lang
document.title = text.title

const params = new URLSearchParams(window.location.search)
const code = params.get('code')
const state = params.get('state')

const status = document.getElementById('status')
const detail = document.getElementById('detail')
status.textContent = text.completing
detail.textContent = text.forwarding

function fail(message) {
  status.textContent = text.failed
  status.className = 'err'
  detail.textContent = message
}

if (code === null || state === null) {
  fail(text.missingParams)
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
      let last = text.timeout
      for (let attempt = 0; attempt < 6; attempt++) {
        if (attempt > 0) await new Promise(resolve => { setTimeout(resolve, 1000) })
        detail.textContent = attempt > 0 ? text.attempt(attempt + 1) : detail.textContent
        const result = await once()
        if (!result.settled) { last = text.timeout; continue }
        const response = result.response
        if (response?.ok === true && (response.status === undefined || response.status < 400)) {
          status.textContent = text.done
          status.className = 'ok'
          detail.textContent = text.doneDetail
          last = ''
          break
        }
        if (response?.ok === true && typeof response.status === 'number' && response.status >= 400) {
          // 引擎已收到但拒绝本次回调（state 校验失败等）——重试无意义。
          fail(text.rejected)
          last = ''
          break
        }
        last = String(response?.error ?? 'no response')
      }
      if (last !== '') fail(text.notReceived(last))
    } catch (err) {
      fail(text.forwardFailed(String(err?.message ?? err)))
    }
  })()
}
