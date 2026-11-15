// Magpie provider plugin: Baidu Kuku AI with the native MCP tool channel.
//
// What this fixes versus the text-only plugin:
//   1. models declare tool_call/toolcall = true, so agent clients stop guessing (the old plugin
//      hard-coded false while its config() fallback left the field undefined, which the host
//      filled with `tool_call ?? true` — an inconsistent pair that produced a one-line answer
//      followed by silence in agent clients);
//   2. chat/completions accepts tools / tool_choice / tool messages instead of rejecting them;
//   3. tools are executed by the caller through a real MCP connector, not emulated in prompt.
import { ORIGIN, UpstreamError, KukuNativeAccount } from "./lib/protocol.mjs"
import { chatResponse, CALL_PREFIX } from "./lib/chat.mjs"
import { adoptExistingSession, verifyAccessString, verifyNative, parseCookies, PROVIDER } from "./lib/auth.mjs"
import { WebClient } from "./lib/checkin/web-client.mjs"
import { checkin as runCheckin } from "./lib/checkin/checkin.mjs"
import { bindProfile, ownedProfile, profilePath } from "./lib/checkin/profiles.mjs"
import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"

const ID = PROVIDER
const NAME = "库库 AI（原生工具）"
const WINDOW_OPTION = "signInWindow"

// The sign-in activity is pressed by a real browser, and a freshly-made profile
// reads as a new device at every check-in — which is what the risk control is
// watching for. The id is derived from the account instead, so one account keeps
// one browser identity across runs.
async function signInProfile(uid) {
  if (!uid) return undefined
  const id = "kuku-" + createHash("sha256").update(String(uid)).digest("hex").slice(0, 12)
  try {
    await ownedProfile(id, uid)
    return id
  } catch {
    // Not made yet, or made for another account: build it for this one.
    try {
      await mkdir(profilePath(id), { recursive: true })
      await bindProfile(id, uid)
      return id
    } catch {
      return undefined // a browser profile is an optimisation, not a requirement
    }
  }
}

const catalogModel = (name) => ({
  name,
  tool_call: true,
  attachment: false,
  modalities: { input: ["text"], output: ["text"] },
})

const fallback = () => ({ auto: catalogModel("库库自动选择（目录未刷新）") })

// Magpie's host derives the runtime capability from `tool_call` (falling back to true) and passes
// the same value through as `toolcall`. Both are set explicitly so no layer can disagree.
const runtimeModel = (provider, m) => ({
  id: m.id,
  name: m.name,
  providerID: provider.id ?? ID,
  api: { id: m.id, url: `${ORIGIN}/v1`, npm: "@ai-sdk/openai-compatible" },
  capabilities: {
    temperature: false,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, output: 0 },
  options: {},
  headers: {},
  status: "active",
  release_date: "",
  variants: {},
})

function safeMessage(error, cookies = {}) {
  let msg = String(error?.message ?? error ?? "未知错误")
  for (const value of Object.values(cookies)) if (typeof value === "string" && value) msg = msg.split(value).join("[redacted]")
  return msg.replace(/(BDUSS|STOKEN|PTOKEN|bdstoken|uinfo)(?:_BFESS)?\s*[=:]\s*[^\s;&"']+/gi, "$1=[redacted]").slice(0, 300)
}

export const KukuAgentPlugin = async () => ({
  async config(config) {
    config.provider ??= {}
    const was = config.provider[ID] ?? {}
    config.provider[ID] = {
      ...was,
      name: NAME,
      npm: "@ai-sdk/openai-compatible",
      api: `${ORIGIN}/v1`,
      models: { ...fallback(), ...(was.models ?? {}) },
    }
  },

  provider: {
    id: ID,
    async models(provider, { auth } = {}) {
      // Without a credential the static catalog keeps the provider selectable; every entry
      // still advertises tool support so a client never falls back to text-only behaviour.
      // `auth` is empty until kuku2 is authorised, so the stored kuku session is tried too —
      // otherwise a working account would show an empty model list.
      const effective = auth?.access ? auth : await adoptExistingSession().catch(() => null)
      if (!effective?.access) return provider.models
      try {
        const catalog = await verifyNative(effective)
        return Object.fromEntries(catalog.models.map(m => [m.id, runtimeModel(provider, m)]))
      } catch (e) {
        if (e instanceof UpstreamError && e.status === 401) throw e
        return provider.models
      }
    },
  },

  auth: {
    provider: ID,
    options: [
      {
        key: WINDOW_OPTION,
        label: "Open a browser window for the sign-in",
        description:
          "Pressing 立即签到 opens a real Chrome window on the activity page, presses the button, and waits for you. If Kuku's risk control stops it, clear the check in that window and the run finishes by itself. Turn this off for an invisible, unattended sign-in.",
        labels: { zh: "签到弹出浏览器窗口" },
        descriptions: {
          zh: "点「立即签到」时打开一个真实的 Chrome 窗口停在活动页，替你点按钮后等你操作。若被库库风控拦下，在窗口里过一次验证即可，签到会自动完成。关闭则不弹窗，后台静默签到。",
        },
      },
    ],
    methods: [
      {
        type: "oauth",
        label: "复用已登录的库库插件（推荐）",
        authorize: async () => {
          const adopted = await adoptExistingSession()
          if (!adopted) {
            return {
              type: "failed",
              error: "没有找到已登录的库库插件会话。请先登录「百度库库 AI」插件，或使用手动导入 Cookie。",
            }
          }
          try {
            await verifyNative(adopted)
            return adopted
          } catch (e) {
            if (e instanceof UpstreamError && e.status === 401) {
              return { type: "failed", error: "已找到库库会话但已失效，请先重新登录库库插件" }
            }
            // A transient upstream failure must not discard a credential that parsed correctly.
            return adopted
          }
        },
      },
      {
        type: "oauth",
        label: "手动导入库库 Cookie",
        authorize: async () => ({
          url: `${ORIGIN}/genflowpro`,
          method: "code",
          instructions:
            "在库库官网登录后粘贴 Cookie 或 Cookie 编辑器导出的 JSON。原生工具通道需要同时包含 BDUSS 与 STOKEN（仅有 BDUSS 时网页聊天可用，但工具调用不可用）。凭证只保存在本机 Magpie。",
          callback: async input => verifyAccessString(input),
        }),
      },
    ],

    async loader(getAuth) {
      // Magpie keeps one credential per provider id, so a freshly installed kuku2 starts
      // unauthenticated even when the official kuku plugin is already signed in. Rather than
      // forcing a second authorisation for the same account, fall back to the stored kuku
      // session at request time. The explicit login methods still win when they exist.
      const credential = async () => {
        const own = await getAuth().catch(() => null)
        if (own?.access) return own
        return await adoptExistingSession()
      }
      return {
        apiKey: "kuku-native-session",
        async fetch(input, init = {}) {
          let cookies = {}
          try {
            const a = await credential()
            if (!a?.access) {
              return Response.json({ error: { message: "请先登录库库账号（或在库库插件中登录后重试）", type: "authentication_error" } }, { status: 401 })
            }
            cookies = parseCookies(a.access)
            const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
            if (!url.pathname.endsWith("/chat/completions")) {
              return Response.json({ error: { message: `库库插件仅提供 /v1/chat/completions（收到 ${url.pathname}）`, type: "invalid_request_error" } }, { status: 404 })
            }
            const text = init.body ?? (input instanceof Request ? await input.text() : "")
            const body = JSON.parse(typeof text === "string" ? text : new TextDecoder().decode(text))
            const signal = init.signal ?? (input instanceof Request ? input.signal : undefined)
            return await chatResponse(a, body, { signal })
          } catch (e) {
            const status = e instanceof UpstreamError ? e.status ?? 502 : e.status ?? 502
            const type = status === 401 ? "authentication_error" : status === 400 ? "invalid_request_error" : "api_error"
            return Response.json({ error: { message: safeMessage(e, cookies), type, code: e?.code } }, { status })
          }
        },
      }
    },

    // The account's remaining points, from the same credential the turns spend.
    // What was here before reported "可用模型 13 个", which is a capability count,
    // not a balance — the card had no number a user could act on.
    async usage(getAuth) {
      try {
        const own = await getAuth().catch(() => null)
        const a = own?.access ? own : await adoptExistingSession()
        if (!a?.access) return { error: "请先登录库库", signIn: "kept" }
        const b = await new KukuNativeAccount(a).balance()
        return {
          plan: NAME,
          user: b.name || a.name || a.accountId || "库库账号",
          windows: [{ name: "库库积分", used: 0, display: `${b.balance} 积分`, aside: true }],
        }
      } catch (e) {
        return { error: safeMessage(e), signIn: e?.status === 401 ? "expired" : "kept" }
      }
    },

    // The daily points. Kuku's own token endpoint answers `jsToken: null` on this
    // account, so the sign-in is pressed the way a person presses it: the
    // activity page's own button, in a browser holding this account's profile.
    // Nothing here synthesises a proof or solves a captcha — a risk-control block
    // is reported as one and left for the user to clear on the site.
    async checkin(getAuth) {
      let client
      try {
        const own = await getAuth().catch(() => null)
        const a = own?.access ? own : await adoptExistingSession()
        if (!a?.access) return { outcome: "failed", message: "库库：请先登录" }
        const uid = String(a.uid ?? a.accountId ?? "")
        client = new WebClient(a, { accountId: uid, browserProfile: await signInProfile(uid) })
        // A window the user can see is the default: it is what a person's browser
        // looks like, and when risk control does stop the press, they can clear the
        // check in it and the run finishes on its own. Turning the option off keeps
        // the sign-in invisible and unattended.
        const headful = globalThis.magpie?.option?.(ID, WINDOW_OPTION) !== false
        return await runCheckin(client, { headful })
      } catch (e) {
        return { outcome: "failed", message: safeMessage(e, client?.cookies) }
      }
    },
  },
})

export default { id: ID, server: KukuAgentPlugin }
export { CALL_PREFIX }
