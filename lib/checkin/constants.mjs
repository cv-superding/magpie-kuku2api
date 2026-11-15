// The web-side constants and reply inspection the daily sign-in needs.
//
// The desktop transport in lib/protocol.mjs speaks genflowpro; the activity
// endpoints are on the same origin but answer in a different envelope, and one of
// them is only ever reached from the activity page — hence its own Referer.
import { ORIGIN } from "../protocol.mjs"
import { parseCookies } from "../auth.mjs"

export const WEB_QUERY = "clienttype=400&app_id=123971023&web=1&channel=chunlei&version=1.4.4"
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
export const ACTIVITY_PAGE = `${ORIGIN}/operation/activitys/kukuPcSignAct/main`

export function cookieHeader(cookies) {
  return Object.entries(parseCookies(cookies)).map(([k, v]) => `${k}=${v}`).join("; ") + "; gfprotpl=genflowpro"
}

// Every message that leaves this module is shown to a user or written to a log, so
// a credential that found its way into an upstream error is redacted first.
export function safeMessage(error, cookies = {}) {
  let msg = String(error?.message ?? error ?? "未知错误")
  for (const value of Object.values(cookies)) if (typeof value === "string" && value) msg = msg.split(value).join("[redacted]")
  return msg.replace(/(BDUSS|STOKEN|PTOKEN|bdstoken|uinfo)(?:_BFESS)?\s*[=:]\s*[^\s;&"']+/gi, "$1=[redacted]").slice(0, 300)
}

export const beijingTomorrow = (now = Date.now()) =>
  (Math.floor((now + 28800000) / 86400000) + 1) * 86400000 - 28800000

export const numberOrNull = (v) => (v !== "" && v != null && Number.isFinite(Number(v)) ? Number(v) : null)

export function codeOf(v) {
  return v?.status?.code ?? v?.errno ?? v?.error_code
}

// A business failure arrives as HTTP 200 with a non-zero code, so the code is what
// is checked. Only a login failure is reported as 401; everything else is a refusal
// to show the user rather than an authentication problem.
export function assertOK(value, label) {
  const code = codeOf(value)
  if (code == null || Number(code) !== 0) {
    const msg = String(value?.status?.msg ?? value?.errmsg ?? value?.show_msg ?? value?.message ?? "响应格式异常")
    const expired = [-6, -7, 110, 111].includes(Number(code)) || /未登录|登录.*失效|登录.*过期/.test(msg)
    throw Object.assign(new Error(`${label}失败（${code ?? "缺少状态码"}）：${msg}`), {
      status: expired ? 401 : 502,
      signIn: expired ? "expired" : undefined,
    })
  }
  return value.data
}
