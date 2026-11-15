// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from "node:child_process"
import { access, readFile, rm } from "node:fs/promises"
import { constants } from "node:fs"
import { tmpdir, homedir, platform } from "node:os"
import { join, resolve, dirname, basename } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { ORIGIN } from "../protocol.mjs"
import { parseCookies } from "../auth.mjs"
import { safeMessage } from "./constants.mjs"
import { createProfile, bindProfile, discardProfile } from "./profiles.mjs"

export function browserCandidates(os = platform(), env = process.env) {
  if (os === "win32") return [
    ...[env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean).flatMap(p => [
      join(p, "Google", "Chrome", "Application", "chrome.exe"), join(p, "Microsoft", "Edge", "Application", "msedge.exe"),
    ]),
  ]
  if (os === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", join(homedir(), ".local/bin/chromium")]
}
export async function findBrowser() {
  for (const p of browserCandidates()) { try { await access(p, constants.F_OK); return p } catch {} }
  throw new Error("库库网页登录需要本机 Chrome 或 Edge。请先安装其中一个浏览器，或选择手动导入 Cookie。")
}
export function safeDebugSocket(url) {
  const u = new URL(url)
  if (u.protocol !== "ws:" || u.hostname !== "127.0.0.1" || !u.port || !u.pathname.startsWith("/devtools/")) throw new Error("拒绝非本机浏览器调试地址")
  return u.href
}
export class CDP {
  constructor(socket, timeout = 5000) {
    this.socket = socket; this.next = 0; this.pending = new Map(); this.timeout = timeout; this.listeners = new Map()
    socket.addEventListener("message", event => {
      let msg
      try { msg = JSON.parse(String(event.data)) } catch { return }
      if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) {
          try { Promise.resolve(fn(msg.params, msg.sessionId)).catch(() => {}) } catch {}
        }
      }
      const p = this.pending.get(msg.id)
      if (!p) return
      clearTimeout(p.timer); this.pending.delete(msg.id)
      msg.error ? p.reject(new Error("浏览器登录通道返回错误")) : p.resolve(msg.result)
    })
    const closed = () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("登录窗口已关闭")) }; this.pending.clear() }
    socket.addEventListener("close", closed); socket.addEventListener("error", closed)
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set())
    this.listeners.get(method).add(fn)
    return () => this.listeners.get(method)?.delete(fn)
  }
  static async open(url) {
    const socket = new WebSocket(safeDebugSocket(url))
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("连接登录浏览器超时")) }, 5000)
      socket.addEventListener("open", () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("无法连接登录浏览器")) }, { once: true })
    })
    return new CDP(socket)
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.next
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("浏览器登录通道超时")) }, this.timeout)
      this.pending.set(id, { resolve, reject, timer })
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })) }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e) }
    })
  }
  close() { this.socket.close() }
}
export async function removeLoginProfile(profile, root = tmpdir()) {
  // Only the one throwaway directory created by this login is removable.
  const absolute = resolve(profile)
  if (dirname(absolute) !== resolve(root) || !basename(absolute).startsWith("magpie-kuku-login-")) throw new Error("拒绝清理非登录临时目录")
  await rm(absolute, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}
export async function closeBrowser(child, cdp, { grace = 3000 } = {}) {
  // Chrome must finish writing cookies/storage before this profile is reused.
  const wait = () => new Promise(resolve => {
    if (child.exitCode != null || child.signalCode != null) return resolve(true)
    const finish = stopped => {
      clearTimeout(timer); child.off("exit", exited); child.off("error", errored); resolve(stopped)
    }
    const exited = () => finish(true), errored = () => finish(true)
    const timer = setTimeout(() => finish(false), grace)
    child.once("exit", exited); child.once("error", errored)
  })
  if (cdp) { try { await cdp.send("Browser.close") } catch {}; cdp.close() }
  if (!await wait()) { child.kill(); await wait() }
}
export async function browserSignIn(validate, { timeout = 30 * 60 * 1000, signal } = {}) {
  signal?.throwIfAborted()
  const executable = await findBrowser()
  const createdProfile = await createProfile()
  const profile = createdProfile.path
  const child = spawn(executable, ["--user-data-dir=" + profile, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    "--no-first-run", "--no-default-browser-check", "--new-window", `${ORIGIN}/genflowpro`], { stdio: "ignore", windowsHide: true })
  let launchError, closed = false, cdp, timer, settled = false, cleaning, keepProfile = false
  child.on("error", e => { launchError = e })
  child.on("exit", () => { closed = true })
  const controller = new AbortController()
  const deadline = Date.now() + timeout
  const cleanup = () => cleaning ??= (async () => {
    clearTimeout(timer)
    controller.abort()
    await closeBrowser(child, cdp)
    if (!keepProfile) { try { await discardProfile(createdProfile.id) } catch {} }
  })()
  const abort = () => controller.abort()
  signal?.addEventListener("abort", abort, { once: true })
  const work = (async () => {
    try {
      let port, wsPath
      while (Date.now() < deadline) {
        if (launchError) throw new Error("无法启动独立登录浏览器")
        if (closed) throw new Error("库库登录窗口已关闭，请重新登录")
        try {
          const lines = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/)
          if (/^\d+$/.test(lines[0]) && lines[1]?.startsWith("/devtools/")) { [port, wsPath] = lines; break }
        } catch {}
        await delay(400, undefined, { signal: controller.signal })
      }
      if (!port) throw new Error("登录浏览器没有开启本机连接，请检查浏览器策略或改用 Cookie 导入")
      // Browser-level Storage.getCookies is restricted to THIS fresh profile.
      cdp = await CDP.open(`ws://127.0.0.1:${port}${wsPath}`)
      let lastAttempt = "", lastError = "", lastValidatedAt = 0
      while (Date.now() < deadline) {
        if (closed) throw new Error("库库登录窗口已关闭，请重新登录")
        const result = await cdp.send("Storage.getCookies")
        let cookies
        try { cookies = parseCookies(result.cookies) } catch {}
        if (cookies?.BDUSS && cookies.STOKEN) {
          const snapshot = JSON.stringify(cookies)
          if (snapshot !== lastAttempt || Date.now() - lastValidatedAt >= 15000) {
            lastAttempt = snapshot
            lastValidatedAt = Date.now()
            try {
              const auth = await validate(cookies, { signal: controller.signal })
              if (auth?.type !== "success") continue
              controller.signal.throwIfAborted()
              await bindProfile(createdProfile.id, String(auth.uid ?? auth.accountId ?? ""))
              keepProfile = true
              return { ...auth, browserProfile: createdProfile.id }
            }
            catch (e) { lastError = safeMessage(e, cookies) }
          }
        }
        await delay(1000, undefined, { signal: controller.signal })
      }
      throw new Error(lastError || "库库网页登录超时，请重新登录")
    } catch (e) { return { type: "failed", error: e.name === "AbortError" ? "库库网页登录超时或已取消" : safeMessage(e) } }
    finally { settled = true; signal?.removeEventListener("abort", abort); await cleanup() }
  })()
  // Authorize may be abandoned by the host. The deadline still cleans up.
  timer = setTimeout(() => controller.abort(), timeout)
  timer.unref?.()
  return { url: `${ORIGIN}/genflowpro`, opened: true, method: "auto",
    instructions: "请在独立的库库官网窗口登录百度账号，并进入库库工作台。验证后账号和该账号的专用浏览器环境会保留在本机，供每日签到复用。添加其他账号会使用独立环境。",
    callback: async (_input, { signal: callbackSignal } = {}) => {
      if (callbackSignal?.aborted) controller.abort()
      callbackSignal?.addEventListener("abort", abort, { once: true })
      try { return await work } finally { callbackSignal?.removeEventListener("abort", abort) }
    },
    // Supported by Magpie hosts with authorize cancellation; deadline covers older hosts.
    cancel: async () => { if (!settled) await cleanup() },
  }
}
