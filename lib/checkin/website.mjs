// SPDX-License-Identifier: AGPL-3.0-only
// When the legacy token endpoint is empty, use the official activity page's
// own button and JavaScript. Never synthesize risk-control proofs or solve a captcha.
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { CDP, findBrowser, removeLoginProfile, closeBrowser } from "./browser.mjs"
import { parseCookies } from "../auth.mjs"
import { ORIGIN } from "../protocol.mjs"
import { ACTIVITY_PAGE, safeMessage } from "./constants.mjs"
import { ownedProfile, lockProfile } from "./profiles.mjs"

export function signinResponse(value, cookies = {}) {
  const code = value?.errno ?? value?.status?.code
  const message = safeMessage(value?.show_msg ?? value?.errmsg ?? value?.status?.msg ?? "", cookies)
  if ([8001, 8002, 8011, 8024].includes(Number(code)) || /验证码|风控|风险|captcha/i.test(message))
    return { state: "captcha", code: Number(code), message }
  if ([-6, -7, 110, 111].includes(Number(code))) return { state: "login", code: Number(code) }
  if (Number(code) === 10152) return { state: "signed", already: true }
  if (code != null && Number(code) === 0) return { state: "submitted" }
  return { state: "failed", ...(code != null ? { code: Number(code) } : {}), message }
}

// A headless browser announces itself: `navigator.webdriver` is true, the plugin
// list is empty, and `window.chrome` is missing. The site's risk control reads
// those, and the sign-in endpoint refuses with 8001 "账号存在风险" for anything it
// decides is not a person — including, as another project's script author found,
// every plain HTTP request to it.
//
// This does not fake a proof or answer a captcha; it only stops the browser from
// volunteering that it is automated.
export const stealthExpression = `(() => {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    if (!window.chrome) window.chrome = { runtime: {} };
    const query = window.navigator.permissions?.query;
    if (query) window.navigator.permissions.query = (p) =>
      p && p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : query.call(window.navigator.permissions, p);
  } catch {}
})()`

// Select only the official daily sign-in button observed on the activity page.
// No lottery, membership, make-up, invitation or reward-claim button is clicked.
export const pageStateExpression = `(() => {
  if (location.origin !== 'https://kuku.baidu.com' || !location.pathname.startsWith('/operation/activitys/kukuPcSignAct/')) return {state:'wrong-page'};
  const button = document.querySelector('button.pc-sign-btn');
  const text = button?.innerText?.trim() || '';
  if (text === '今日已签') return {state:'signed'};
  if (text === '登录领奖') return {state:'login'};
  const visible = e => e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
  if ([...document.querySelectorAll('iframe[src*="captcha"], .geetest_panel, .vcode-dialog, .verify-dialog')].some(visible)) return {state:'captcha'};
  const tip = document.querySelector('.pc-sign-tip__text')?.innerText || '';
  if (/验证|风控|风险|频繁|异常/.test(tip)) return {state:'captcha'};
  if (text === '立即签到' && !window.__magpieKukuPressed && visible(button)) {
    window.__magpieKukuPressed = true;
    button.click();
    return {state:'pressed'};
  }
  if (window.__magpieKukuPressed && /失败|结束/.test(tip)) return {state:'failed'};
  return {state:'waiting'};
})()`

export async function websiteCheckin(rawCookies, { signal, timeout = 30000, profile: profileId, uid } = {}) {
  const cookies = parseCookies(rawCookies), executable = await findBrowser()
  signal?.throwIfAborted()
  const persistent = !!profileId
  const profile = persistent ? await ownedProfile(profileId, uid) : await mkdtemp(join(tmpdir(), "magpie-kuku-login-"))
  const unlock = lockProfile(persistent ? profileId : profile)
  let child, closed = false, launchError, cdp, lastState, submission
  const unsubscribe = []
  const controller = new AbortController(), abort = () => controller.abort()
  signal?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(abort, timeout)
  try {
    // A persistent profile may still contain the port from its previous run.
    // Remove only this checked profile's discovery file before starting Chrome.
    await rm(join(profile, "DevToolsActivePort"), { force: true })
    controller.signal.throwIfAborted()
    // `--headless=new` is the default because it costs the user nothing, but it is
    // also the shape risk control expects from a script. KUKU_CHECKIN_HEADFUL=1
    // opens a real window instead, which is what a person's browser looks like.
    const headful = process.env.KUKU_CHECKIN_HEADFUL === "1"
    const args = [
      ...(headful ? [] : ["--headless=new"]),
      "--user-data-dir=" + profile,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      // Chrome flags its own automation here; the flag removes the marker it sets.
      "--disable-blink-features=AutomationControlled",
      "--lang=zh-CN",
      "about:blank",
    ]
    if (process.env.KUKU_CHECKIN_DEBUG) console.error("[checkin] launching", headful ? "headful" : "headless")
    child = spawn(executable, args, { stdio: "ignore", windowsHide: true })
    child.on("exit", () => { closed = true }); child.on("error", e => { launchError = e })
    let lines
    while (!controller.signal.aborted) {
      if (closed || launchError) throw new Error("签到浏览器无法启动，请关闭该账号正在使用的库库窗口后重试")
      try {
        const found = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/)
        if (/^\d+$/.test(found[0]) && found[1]?.startsWith("/devtools/")) { lines = found; break }
      } catch {}
      await delay(200, undefined, { signal: controller.signal })
    }
    controller.signal.throwIfAborted()
    if (!lines || !/^\d+$/.test(lines[0])) throw new Error("签到浏览器无法连接")
    if (process.env.KUKU_CHECKIN_DEBUG) console.error("[checkin] exe:", executable, "| profile:", profile, "| port:", lines[0], lines[1])
    cdp = await CDP.open(`ws://127.0.0.1:${lines[0]}${lines[1]}`)
    if (process.env.KUKU_CHECKIN_DEBUG) console.error("[checkin] cdp connected")
    const { targetInfos } = await cdp.send("Target.getTargets")
    if (process.env.KUKU_CHECKIN_DEBUG) console.error("[checkin] targets:", targetInfos.map(t => t.type).join(","))
    const target = targetInfos.find(t => t.type === "page")
    if (!target) throw new Error("签到浏览器没有页面")
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })
    const page = (method, params) => cdp.send(method, params, sessionId)
    const pendingResponses = new Set()
    unsubscribe.push(cdp.on("Network.responseReceived", (p, sid) => {
      if (sid !== sessionId) return
      let url
      try { url = new URL(p.response.url) } catch { return }
      if (url.origin === "https://kuku.baidu.com" && url.pathname === "/act/v2/kukuai30/signin") pendingResponses.add(p.requestId)
    }))
    unsubscribe.push(cdp.on("Network.loadingFinished", async (p, sid) => {
      if (sid !== sessionId || !pendingResponses.delete(p.requestId)) return
      try {
        const response = await page("Network.getResponseBody", { requestId: p.requestId })
        const text = response.base64Encoded ? Buffer.from(response.body, "base64").toString("utf8") : response.body
        submission = signinResponse(JSON.parse(text), cookies)
      } catch {}
    }))
    await page("Network.enable", {})
    await page("Page.enable", {})
    // Runs before any page script on every navigation, so the site sees a plain
    // browser rather than one that says it is driven.
    await page("Page.addScriptToEvaluateOnNewDocument", { source: stealthExpression })
    await page("Network.setCookies", { cookies: Object.entries(cookies).map(([name, value]) => ({ name, value,
      domain: name === "STOKEN" ? ".kuku.baidu.com" : ".baidu.com", path: "/", secure: true, httpOnly: name !== "BAIDUID" })) })
    // Landing straight on the activity page is a pattern of its own. One ordinary
    // page first, then the activity, costs a second and reads like a person
    // opening the product and going to the campaign.
    await page("Page.navigate", { url: `${ORIGIN}/` })
    await delay(1200, undefined, { signal: controller.signal }).catch(() => {})
    controller.signal.throwIfAborted()
    await page("Page.navigate", { url: ACTIVITY_PAGE })
    while (!controller.signal.aborted) {
      if (closed) return { state: "failed", message: "签到浏览器已退出，专用环境可能正在使用" }
      if (submission) return submission
      const v = await page("Runtime.evaluate", { expression: pageStateExpression, returnByValue: true })
      const state = v.result?.value?.state
      lastState = state
      // Prefer the actual server response over a generic website toast.
      if (state === "failed") { await delay(300, undefined, { signal: controller.signal }); return submission ?? { state } }
      if (["signed", "captcha", "login"].includes(state)) return submission ?? { state }
      await delay(500, undefined, { signal: controller.signal })
    }
    return { state: "timeout", lastState }
  } catch (e) {
    if (e.name === "AbortError") return { state: "timeout", lastState }
    throw e
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", abort)
    for (const off of unsubscribe) off()
    if (child) await closeBrowser(child, cdp)
    if (!persistent) { try { await removeLoginProfile(profile) } catch {} }
    unlock()
  }
}
