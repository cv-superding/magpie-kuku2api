// Authentication for the native channel.
//
// The native desktop endpoints need the same BDUSS/STOKEN pair as the web plugin, so a user who
// already signed in to the official kuku plugin should not have to sign in twice. Magpie stores
// each plugin's credential under its provider id in plugin-auth.json; this module reads that
// store read-only and falls back to the normal interactive login only when nothing usable exists.
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { KukuNativeAccount, UpstreamError, ORIGIN } from "./protocol.mjs"

const PROVIDER = "kuku2"
const COOKIE_KEYS = new Set(["BDUSS", "STOKEN", "PTOKEN", "BDUSS_BFESS", "PTOKEN_BFESS", "BAIDUID"])

function authStorePath() {
  const home = process.env.MAGPIE_CONFIG_DIR ?? join(homedir(), ".config", "magpie")
  return join(home, "plugin-auth.json")
}

export function parseCookies(raw) {
  const out = Object.create(null)
  const put = (name, value) => {
    if (COOKIE_KEYS.has(name) && typeof value === "string" && value && !/[\r\n;]/.test(value)) out[name] = value
  }
  if (Array.isArray(raw)) {
    for (const c of [...raw].sort((a, b) => String(a.domain ?? "").length - String(b.domain ?? "").length)) {
      const domain = String(c.domain ?? "").replace(/^\./, "")
      if (domain && !(domain === "baidu.com" || domain === "kuku.baidu.com")) continue
      if (typeof c.expires === "number" && c.expires > 0 && c.expires * 1000 <= Date.now()) continue
      if (c.path && !"/genflowpro".startsWith(c.path)) continue
      put(c.name, c.value)
    }
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) put(k, v)
  } else if (typeof raw === "string") {
    const s = raw.trim()
    if (s.startsWith("[") || s.startsWith("{")) {
      try { return parseCookies(JSON.parse(s)) } catch { throw new UpstreamError("Cookie 格式无法解析", { status: 400 }) }
    }
    for (const part of s.replace(/^Cookie:\s*/i, "").split(";")) {
      const i = part.indexOf("=")
      if (i > 0) put(part.slice(0, i).trim(), part.slice(i + 1).trim())
    }
  }
  return out
}

// Reads the credential the official kuku plugin already persisted. Failure is expected and
// silent: a fresh install has no such file, and that is not an error.
export async function adoptExistingSession() {
  let store
  try {
    store = JSON.parse(await readFile(authStorePath(), "utf8"))
  } catch {
    return null
  }
  const candidates = [store?.kuku, store?.["kuku"], ...Object.values(store ?? {})]
  for (const entry of candidates) {
    if (!entry || typeof entry !== "object" || !entry.access) continue
    let cookies
    try { cookies = parseCookies(entry.access) } catch { continue }
    if (!cookies.BDUSS || !cookies.STOKEN) continue
    return {
      type: "success",
      access: JSON.stringify(cookies),
      refresh: "",
      expires: 0,
      accountId: entry.accountId ?? entry.uid,
      uid: entry.uid ?? entry.accountId,
      name: entry.name ?? entry.cardName,
      source: "kuku-native-adopt",
    }
  }
  return null
}

// Proves the pair works against the desktop endpoint, which — unlike the web session check —
// also confirms the account may use the native client and its models.
export async function verifyNative(auth, { signal } = {}) {
  const client = new KukuNativeAccount(auth, { signal })
  const catalog = await client.catalog()
  if (!catalog.models.length) {
    throw new UpstreamError("库库账号没有可用模型，请先在官网确认账号状态", { status: 401 })
  }
  return catalog
}

export async function verifyAccessString(input, { signal } = {}) {
  let cookies
  try { cookies = parseCookies(input) } catch (e) {
    return { type: "failed", error: "库库 Cookie 解析失败，请检查是否包含 BDUSS 与 STOKEN" }
  }
  if (!cookies.BDUSS || !cookies.STOKEN) {
    return { type: "failed", error: "缺少 STOKEN：原生工具通道必须同时提供 BDUSS 与 STOKEN" }
  }
  try {
    const client = new KukuNativeAccount(cookies, { signal })
    const probe = await client.probe()
    return {
      type: "success",
      access: JSON.stringify(cookies),
      refresh: "",
      expires: 0,
      accountId: String(probe?.uk ?? probe?.user_id ?? ""),
      uid: String(probe?.uk ?? probe?.user_id ?? ""),
      name: String(probe?.uname ?? probe?.username ?? ""),
      source: "kuku-native",
    }
  } catch (e) {
    const expired = e.status === 401 || Number(e.code) === 1000004
    return { type: "failed", error: expired ? "库库登录态已失效，请重新登录" : "库库原生通道校验失败，请稍后重试" }
  }
}

export { PROVIDER, ORIGIN }
