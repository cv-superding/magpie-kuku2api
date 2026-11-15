// The web endpoints the sign-in uses, behind the same `request` shape the
// community plugin's sign-in code expects.
//
// lib/protocol.mjs talks to the desktop transport, whose envelope check and
// headers are wrong for the activity endpoints: those are reached from
// kuku.baidu.com's own activity page, with a browser UA. Keeping them here means
// the native path stays untouched.
import { ORIGIN } from "../protocol.mjs"
import { parseCookies } from "../auth.mjs"
import { ACTIVITY_PAGE, UA, cookieHeader, safeMessage } from "./constants.mjs"

export class WebClient {
  constructor(auth, { signal, browserProfile, accountId } = {}) {
    // Magpie hands the loader an `{ access }` blob whose value is a JSON cookie
    // string; callers inside this plugin may pass a parsed object.
    const raw = auth?.cookies ?? auth?.access
    this.cookies = parseCookies(raw)
    if (!this.cookies.BDUSS || !this.cookies.STOKEN) {
      throw Object.assign(new Error("库库登录态缺少 BDUSS 或 STOKEN，请重新登录"), { status: 401, signIn: "expired" })
    }
    this.signal = signal
    this.browserProfile = browserProfile
    this.accountId = accountId
    this.fetcher = globalThis.fetch
  }

  async request(path, { method = "GET", json, form, activity = false, stream = false, timeout = 30000 } = {}) {
    // Never forward a Baidu session to a caller-controlled host or redirect.
    if (!path.startsWith("/") || path.startsWith("//")) throw Object.assign(new Error("拒绝非库库地址"), { status: 400 })
    const signal = AbortSignal.any([...(this.signal ? [this.signal] : []), AbortSignal.timeout(timeout)])
    const headers = {
      Cookie: cookieHeader(this.cookies),
      "User-Agent": UA,
      Origin: ORIGIN,
      Referer: activity ? ACTIVITY_PAGE : `${ORIGIN}/genflowpro`,
      "Accept-Language": "zh-CN,zh;q=0.9",
    }
    let body
    if (json !== undefined) {
      body = JSON.stringify(json)
      headers["Content-Type"] = "application/json;charset=utf-8"
    }
    if (form !== undefined) {
      body = new URLSearchParams(form).toString()
      headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8"
    }
    if (stream) headers.Accept = "text/event-stream"
    const res = await this.fetcher(ORIGIN + path, { method, headers, body, signal, redirect: "error" })
    if (res.status === 401) {
      throw Object.assign(new Error("库库登录态已失效，请重新登录"), { status: 401, signIn: "expired" })
    }
    if (!res.ok) {
      throw Object.assign(new Error(safeMessage(`库库接口返回 HTTP ${res.status}`, this.cookies)), {
        status: res.status === 429 ? 429 : 502,
      })
    }
    if (stream) {
      if (!res.headers.get("content-type")?.includes("text/event-stream")) {
        throw new Error("库库未返回对话事件流，请在官网检查账号状态")
      }
      return res
    }
    try {
      return await res.json()
    } catch {
      throw new Error("库库接口返回了无法解析的内容，请在官网检查登录或验证提示")
    }
  }
}
