// SPDX-License-Identifier: AGPL-3.0-only
// Endpoint sequence adapted from ProvidersPlugin/Agent2Providers.
import { setTimeout as delay } from "node:timers/promises"
import { assertOK, codeOf, beijingTomorrow, numberOrNull, safeMessage } from "./constants.mjs"
import { websiteCheckin, signinResponse } from "./website.mjs"

export function activityConfig(v) {
  for (const row of Array.isArray(v?.data) ? v.data : []) {
    let c = row.conf_value
    if (typeof c === "string") { try { c = JSON.parse(c) } catch { continue } }
    const tid = c?.activityTid
    if ((typeof tid === "number" || typeof tid === "string") && String(tid)) return { tid: String(tid), point: numberOrNull(c.signPoint) }
  }
  return null
}
export function extractJsToken(raw) {
  // The vendor returns an encoded function call. Extract its argument; never eval.
  if (typeof raw !== "string" || raw.length > 100000) return null
  let s
  try { s = decodeURIComponent(raw) } catch { return null }
  const m = s.match(/\(\s*["']([A-Za-z0-9._~-]{1,8192})["']\s*\)\s*;?\s*$/)
  return m?.[1] ?? null
}
function refusal(v, cookies) {
  const c = Number(codeOf(v))
  const msg = safeMessage(v?.show_msg ?? v?.errmsg ?? v?.status?.msg ?? "签到未获确认", cookies)
  if (signinResponse(v, cookies).state === "captcha" || /人机/i.test(msg))
    return { outcome: "captcha", message: `库库风控拦截（${Number.isFinite(c) ? c : "缺少状态码"}）：${msg}；请在库库官网人工验证或手动签到` }
  return { outcome: "failed", message: `库库签到失败（${Number.isFinite(c) ? c : "缺少状态码"}）：${msg}` }
}
export async function checkin(client, { browserCheckin = websiteCheckin } = {}) {
  const until = beijingTomorrow()
  const conf = await client.request("/act/api/conf?conf_key=kukuSignConf", { activity: true })
  // Auth/business failures are not evidence that the campaign has ended.
  if (codeOf(conf) != null && Number(codeOf(conf)) !== 0) { assertOK(conf, "库库签到配置") }
  const config = activityConfig(conf)
  if (!config) return legacyLogin(client, until)
  const suffix = `tid=${encodeURIComponent(config.tid)}`
  const read = () => client.request(`/act/v2/kukuai30/homepage?${suffix}`, { activity: true })
  const home = await read()
  if ([-6, -7, 110, 111].includes(Number(codeOf(home)))) assertOK(home, "库库签到状态")
  if (Number(codeOf(home)) === 151004) return { outcome: "inactive", until, message: "库库当前没有可用的签到活动" }
  if (Number(codeOf(home)) !== 0) return refusal(home, client.cookies)
  const streak = numberOrNull(home.data?.continuous_days)
  if (home.data?.signed_today === true) return { outcome: "done", streak, until, message: "今日已签到" }
  if (home.data?.signed_today !== false) return { outcome: "failed", message: "库库未返回今日签到状态，未重复提交" }
  const tokenResponse = await client.request("/operation/activitys/api/getJsToken", { activity: true })
  if (codeOf(tokenResponse) != null && Number(codeOf(tokenResponse)) !== 0) return refusal(tokenResponse, client.cookies)
  const token = extractJsToken(tokenResponse?.data?.jsToken)
  if (!token) {
    const result = await browserCheckin(client.cookies, { signal: client.signal, profile: client.browserProfile, uid: client.accountId })
    // The browser merely presses the website's own daily sign-in button.
    // Only the independent server read is authoritative.
    let confirmed = await read()
    // A successful website response can arrive before homepage state propagates.
    // Poll reads only; never submit a second sign-in to confirm the first one.
    if (result.state === "submitted") for (let attempt = 0; attempt < 3 && Number(codeOf(confirmed)) === 0 && confirmed.data?.signed_today === false; attempt++) {
      await delay(350, undefined, { signal: client.signal })
      confirmed = await read()
    }
    if (Number(codeOf(confirmed)) === 0 && confirmed.data?.signed_today === true)
      return { outcome: "claimed", ...(config.point !== null ? { credit: config.point } : {}),
        streak: numberOrNull(confirmed.data?.continuous_days), until, message: "已通过库库官网完成今日签到" }
    if (result.state === "captcha") return { outcome: "captcha", message: `库库风控拦截${result.code ? `（${result.code}）` : ""}${result.message ? `：${result.message}` : ""}；请在官网人工验证后再试${client.browserProfile ? "" : "，并重新网页登录一次以保存专用浏览器环境"}` }
    if (result.state === "login") return { outcome: "failed", message: "库库签到页面未接受登录态，请重新登录" }
    if (result.state === "timeout") return { outcome: "failed", message: "库库官网签到超时，服务器尚未确认结果，请稍后重试" }
    return { outcome: "failed", message: result.message || "库库官网尚未确认签到，请在官网核对后重试" }
  }
  const signed = await client.request(`/act/v2/kukuai30/signin?${suffix}&jsToken=${encodeURIComponent(token)}&aid=15459`, { method: "POST", form: {}, activity: true })
  if (Number(codeOf(signed)) === 10152) return { outcome: "done", streak, until, message: "今日已签到" }
  if (Number(codeOf(signed)) !== 0) return refusal(signed, client.cookies)
  // HTTP 200 / errno 0 alone is insufficient; confirm the business result.
  const confirmed = signed.data?.signed_today === true || (await read()).data?.signed_today === true
  if (!confirmed) return { outcome: "failed", message: "库库尚未确认签到结果，请在官网核对后重试" }
  return { outcome: "claimed", ...(config.point !== null ? { credit: config.point } : {}),
    streak: numberOrNull(signed.data?.continuous) ?? streak, until, message: "库库今日签到成功" }
}
async function legacyLogin(client, until) {
  // Only LOGIN is eligible here. Never claim CHAT / invitation / paid tasks
  // without the user actually doing them.
  const home = await client.request("/api/genflowpro/freepoint/homenew?clienttype=400&app_id=123971023&web=1&channel=chunlei&version=1.4.4")
  const data = assertOK(home, "库库每日登录活动")
  let task
  for (const activity of data?.activities ?? []) for (const tab of activity.tabs ?? [])
    task ??= tab.tasks?.find(x => x.task_type === "LOGIN")
  if (!task) return { outcome: "inactive", until, message: "库库当前没有每日登录奖励" }
  if (["FINISHED", "BADGE_ALREADY_RECEIVED"].includes(task.task_status)) return { outcome: "done", until }
  const result = await client.request("/api/genflowpro/freepoint/taskComplete?clienttype=400&app_id=123971023&web=1&channel=chunlei&version=1.4.4", { method: "POST", form: { task_type: "LOGIN" } })
  const d = assertOK(result, "库库每日登录奖励")
  if (d?.complete_status === "BADGE_ALREADY_RECEIVED") return { outcome: "done", until }
  const credit = numberOrNull(d?.reward_point)
  if (d?.complete_status === "SUCCESS" && credit !== null && credit >= 0)
    return { outcome: credit > 0 ? "claimed" : "done", credit, until, message: "每日登录奖励" }
  return { outcome: "failed", message: "库库未确认每日登录奖励" }
}
