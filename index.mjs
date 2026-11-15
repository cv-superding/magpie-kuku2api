// Magpie provider plugin: Baidu Kuku AI with the native MCP tool channel.
//
// What this fixes versus the text-only plugin:
//   1. models declare tool_call/toolcall = true, so agent clients stop guessing (the old plugin
//      hard-coded false while its config() fallback left the field undefined, which the host
//      filled with `tool_call ?? true` — an inconsistent pair that produced a one-line answer
//      followed by silence in agent clients);
//   2. chat/completions accepts tools / tool_choice / tool messages instead of rejecting them;
//   3. tools are executed by the caller through a real MCP connector, not emulated in prompt.
import { ORIGIN, UpstreamError } from "./lib/protocol.mjs"
import { chatResponse, CALL_PREFIX } from "./lib/chat.mjs"
import { adoptExistingSession, verifyAccessString, verifyNative, parseCookies, PROVIDER } from "./lib/auth.mjs"

const ID = PROVIDER
const NAME = "库库 AI（原生工具）"

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

    async usage(getAuth) {
      try {
        const own = await getAuth().catch(() => null)
        const a = own?.access ? own : await adoptExistingSession()
        if (!a?.access) return { error: "请先登录库库", signIn: "kept" }
        const catalog = await verifyNative(a)
        return {
          plan: NAME,
          user: a.name || a.accountId || "库库账号",
          windows: [{ name: "可用模型", used: 0, display: `${catalog.models.length} 个`, aside: true }],
        }
      } catch (e) {
        return { error: safeMessage(e), signIn: e?.status === 401 ? "expired" : "kept" }
      }
    },
  },
})

export default { id: ID, server: KukuAgentPlugin }
export { CALL_PREFIX }
