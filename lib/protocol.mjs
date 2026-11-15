// Native genflowpro protocol layer for the Kuku desktop client.
// Deliberately independent of the web (clienttype=400) path used by the text-only plugin:
// the native MCP connector channel only exists on the desktop client (clienttype=401).
const APP_ID = "123971023"
const CLIENT_TYPE = "401"
const VERSION = "1.6.5.130"
const CHANNEL = "kuku_pc_genflowpro_v1"
const PROTOCOL_V = "cd1755270722192e4536f605"
const UA = "genflow;1.6.5;PC;PC-Windows;10.0.26200;GenFlowPro"

export const ORIGIN = "https://kuku.baidu.com"

export class UpstreamError extends Error {
  constructor(message, { code, status, body, network = false, insufficient_balance = false, retryUnsafe = false, definitiveRefusal = false } = {}) {
    super(message)
    this.name = "UpstreamError"
    this.code = code
    this.status = status
    this.body = body
    this.network = network
    this.retryUnsafe = retryUnsafe
    this.definitiveRefusal = definitiveRefusal
    this.insufficient_balance = insufficient_balance
  }
}

function logid() {
  return Buffer.from(`${Math.floor(Date.now() / 1000)},${1000 + Math.floor(Math.random() * 89999)}`).toString("base64")
}

export function qs(extra = {}) {
  return new URLSearchParams({
    app_id: APP_ID,
    clienttype: CLIENT_TYPE,
    channel: "00000000000000000000000000000000",
    version: VERSION,
    logid: logid(),
    ...extra,
  }).toString()
}

function requestSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export function turnError(data) {
  const candidate = data?.code ?? data?.errno ?? data?.error_code ?? data?.status?.code
  const raw = ["number", "string"].includes(typeof candidate) ? String(candidate) : ""
  const code = /^-?\d{1,10}$/.test(raw) && Number(candidate) !== 0 ? Number(candidate) : "upstream_turn_error"
  return new UpstreamError("库库对话生成失败，请稍后重试", { code, status: 502, retryUnsafe: true })
}

function networkError(error, signal, retryUnsafe = false) {
  const timeout = signal.aborted && signal.reason?.name === "TimeoutError"
  return new UpstreamError(
    timeout ? "库库请求超时；结果可能尚未确认，请勿自动重试同一对话" : `network: ${error.message}`,
    { network: true, code: timeout ? "upstream_timeout" : undefined, status: timeout ? 504 : 502, retryUnsafe },
  )
}

// Ports the desktop client's own transport. Only the pieces needed for a chat turn plus the
// native MCP control channels are implemented; balance/checkin stay on the web client.
export class KukuNativeAccount {
  constructor(auth = {}, { requestTimeoutMs = 30_000, streamTimeoutMs = 180_000 } = {}) {
    // Magpie hands the loader an `{ access }` blob whose value is a JSON cookie string; callers
    // inside this plugin may also pass an already-parsed cookie object.
    const raw = auth?.cookies ?? auth?.access
    let parsed
    if (raw != null) {
      if (typeof raw === "string") {
        try { parsed = JSON.parse(raw) } catch {
          parsed = Object.fromEntries(raw.replace(/^Cookie:\s*/i, "").split(";").map(part => {
            const i = part.indexOf("=")
            return i > 0 ? [part.slice(0, i).trim(), part.slice(i + 1).trim()] : null
          }).filter(Boolean))
        }
      } else if (typeof raw === "object") {
        parsed = raw
      }
    }
    this.setCredential({ bduss: auth?.bduss, stoken: auth?.stoken, cookies: parsed })
    this.requestTimeoutMs = requestTimeoutMs
    this.streamTimeoutMs = streamTimeoutMs
  }

  setCredential({ bduss, stoken, cookies } = {}) {
    const clean = (v) => String(v ?? "").replace(/[\s;]/g, "")
    const source = cookies && typeof cookies === "object" ? cookies : {}
    const nextBduss = bduss !== undefined ? clean(bduss) : clean(source.BDUSS) || this.bduss
    const nextStoken = stoken !== undefined ? clean(stoken) : clean(source.STOKEN) || this.stoken
    if (!nextBduss || !nextStoken) throw new UpstreamError("库库登录态缺少 BDUSS 或 STOKEN，请重新登录", { status: 401 })
    this.bduss = nextBduss
    this.stoken = nextStoken
  }

  // The credential pair identifies the account; a rotation changes it.
  get fingerprint() {
    return `${this.bduss}\u0000${this.stoken}`
  }

  headers(extra = {}) {
    return {
      Cookie: `BDUSS=${this.bduss}; STOKEN=${this.stoken}; gfprotpl=genflowpro`,
      "User-Agent": UA,
      Accept: "*/*",
      "Content-Type": "application/json",
      ...extra,
    }
  }

  // Business failures arrive as HTTP 200 with a non-zero code. The two endpoint families use
  // different envelopes, so both are inspected rather than trusting the HTTP status alone.
  async json(path, { method = "GET", body, form, query, signal } = {}) {
    const url = `${ORIGIN}${path}?${qs(query)}`
    const payload = form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined
    const headers = form ? this.headers({ "Content-Type": "application/x-www-form-urlencoded" }) : this.headers()
    const deadline = requestSignal(signal, this.requestTimeoutMs)
    let res, text
    try {
      res = await fetch(url, { method, headers, body: payload, signal: deadline })
      text = await res.text()
    } catch (e) {
      throw networkError(e, deadline, path === "/wenchain/genflowpro/sendmsg")
    }
    if (!res.ok) {
      throw new UpstreamError(`库库接口返回 HTTP ${res.status}`, {
        status: res.status === 401 ? 401 : 502,
        body: text,
        retryUnsafe: path === "/wenchain/genflowpro/sendmsg" && ![400, 401, 403, 429].includes(res.status),
        definitiveRefusal: path === "/wenchain/genflowpro/sendmsg" && [400, 401, 403, 429].includes(res.status),
      })
    }
    if (process.env.KUKU_AGENT_DEBUG && !res.ok) console.error("[kuku-http]", path, res.status, text.slice(0, 200))
    let parsed
    try { parsed = JSON.parse(text) } catch {
      throw new UpstreamError("库库接口返回了无法解析的内容", { status: 502, body: text, retryUnsafe: path === "/wenchain/genflowpro/sendmsg" })
    }
    const st = parsed.status
    const code = st ? st.code : parsed.errno
    if (code !== 0) {
      const msg = (st ? st.msg : parsed.show_msg ?? parsed.errmsg) ?? ""
      const refused = code != null && Number.isFinite(Number(code)) && Number(code) !== 0
      throw new UpstreamError(`库库返回 code=${code}${msg ? ` ${msg}` : ""}`, {
        code, status: 502, body: parsed,
        definitiveRefusal: path === "/wenchain/genflowpro/sendmsg" && refused,
        retryUnsafe: path === "/wenchain/genflowpro/sendmsg" && !refused,
        insufficient_balance: Number(code) === 11002,
      })
    }
    return parsed.data ?? {}
  }

  allocateIds(channel = "genfp", genType = 3, { signal } = {}) {
    return this.json("/wenchain/genflow/idallochstr", { method: "POST", body: { channel, gen_type: genType }, signal })
  }

  // Read-only liveness probe: answers 1000004 for a dead credential, costs no points.
  probe() {
    return this.json("/wenchain/genflowpro/clientmessage/list", { method: "POST", body: {} })
  }

  modelList() {
    return this.json("/wenchain/genflowpro/model/list", { query: { channel: "genfp" } })
  }

  // Model list carries the model_name/model_display_name pair plus the think modes the
  // account may select. Both are read from one response so ids never diverge.
  async catalog() {
    const data = await this.modelList()
    const list = data.model_list ?? []
    const think = data.think_list ?? []
    const models = new Map()
    for (const m of list) {
      const id = m.model_name ?? m.modelName ?? m.modelId
      if (typeof id !== "string" || !id.trim()) continue
      models.set(id, { id, name: String(m.model_display_name ?? m.display_name ?? m.displayName ?? id), think_mode: m.think_mode })
    }
    return {
      models: [...models.values()],
      think_list: think.map(x => ({ id: Number(x.id), description: String(x.description ?? "") })).filter(x => Number.isFinite(x.id)),
      default_think_id: Number.isFinite(Number(data.default_think_id)) ? Number(data.default_think_id) : null,
      default_model_id: data.default_model_id ?? null,
    }
  }

  sendmsg({ session_id, reply_id, client_session_id, device_id, text, model_name, model_display_name, think_mode, project_type = 1, custom_instructions = "", memory_sign = false, skill_dig_sign = false, connector_list, attachments = [], signal }) {
    const block = { id: "textId", version: "1.0", type: "text", text, data: { content: text } }
    const imageBlocks = attachments.map((file, index) => ({ id: `image${index}`, version: "1.0", type: "file", text: file.name,
      data: { fsId: String(file.fsId), name: file.name } }))
    const data = {
      project_type,
      text,
      rich_input_params: [block, ...imageBlocks],
      fsid: attachments.map(f => String(f.fsId)),
      quotes: [],
      skills: [],
      experts: [],
      model_name,
      model_display_name,
      think_mode: Number(think_mode),
      show_text: "",
      device_id,
      premake_data: {},
      custom_instructions,
      memory_sign,
      skill_dig_sign,
      ...(connector_list ? { connector_list } : {}),
      client_added: JSON.stringify({ client_session_id, permission_type: 0, clienttype: CLIENT_TYPE, version: VERSION, device_os: "windows" }),
    }
    return this.json("/wenchain/genflowpro/sendmsg", { method: "POST", signal, body: {
      type: "message", sub_type: "chat_create", client_session_id, session_id, reply_id,
      uk: "", cid: 0, channel: CHANNEL, device_type: Number(CLIENT_TYPE), created_at: Date.now(),
      msg_type: 1, sync_type: 0, sync_id: "", v: PROTOCOL_V, data,
    } })
  }

  async *sse({ text, session_id, reply_id, client_session_id, device_id, model_name, model_display_name, think_mode, msg_id, custom_instructions = "", memory_sign = false, skill_dig_sign = false, connector_list, attachments = [], signal, streamTimeoutMs }) {
    const imageBlocks = attachments.map((file, index) => ({ id: `image${index}`, version: "1.0", type: "file", text: file.name,
      data: { fsId: String(file.fsId), name: file.name } }))
    const payload = {
      project_type: 1,
      text,
      rich_input_params: [{ id: "textId", version: "1.0", type: "text", text, data: { content: text } }, ...imageBlocks],
      fsid: attachments.map(f => String(f.fsId)),
      quotes: [], skills: [], experts: [],
      model_name, model_display_name, think_mode: Number(think_mode),
      show_text: "",
      device_id, premake_data: {},
      session_id, custom_instructions, memory_sign, skill_dig_sign,
      ...(connector_list ? { connector_list } : {}),
      msg_type: 1, reply_id, client_session_id, traceparent: "",
      ...(msg_id ? { msg_id } : {}),
    }
    yield* this.stream("/wenchain/genflowpro/sse/getchatcontent", payload, signal, { timeoutMs: streamTimeoutMs })
  }

  // Two independent control channels carry the native MCP handshake:
  //   sandbox -> client tool tasks (JSON-RPC), base -> conversation-level events.
  controlStream(kind, payload, signal, options) {
    const path = kind === "sandbox" ? "/api/genflowprosse/call" : "/wenchain/genflowpro/sse/msgexchange"
    return this.stream(path, payload, signal, options)
  }

  nativeToolResult({ task_id, device_id, client_session_id, request_id, result, errno = 0, signal }) {
    return this.json("/api/genflowprosse/callback", { method: "POST", signal, body: {
      type: "sandbox", sub_type: "result", task_id, device_id, client_session_id, client_type: Number(CLIENT_TYPE),
      payload: [JSON.stringify({
        logid: logid(),
        errno,
        errmsg: errno ? "This tool is not available to this client" : "",
        data: errno ? null : { jsonrpc: "2.0", id: request_id, result },
      })],
    } })
  }

  closeTurn({ session_id, reply_id, client_session_id, signal }) {
    return this.json("/wenchain/genflowpro/sendmsg", { method: "POST", signal, body: {
      type: "message", sub_type: "close", session_id, reply_id, client_session_id, channel: CHANNEL,
      device_type: Number(CLIENT_TYPE), msg_type: 1, data: { session_id, reply_id },
    } })
  }

  async *stream(path, payload, signal, { timeoutMs = this.streamTimeoutMs } = {}) {
    const url = `${ORIGIN}${path}?${qs()}`
    const controller = new AbortController()
    const deadline = requestSignal(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, timeoutMs)
    try {
      const res = await fetch(url, { method: "POST", headers: this.headers(), body: JSON.stringify(payload), signal: deadline })
      if (!res.ok) throw new UpstreamError(`库库事件流返回 HTTP ${res.status}`, { status: res.status === 401 ? 401 : 502 })
      const ctype = res.headers.get("content-type") ?? ""
      if (!ctype.includes("event-stream")) {
        const body = await res.text()
        let code
        try { code = JSON.parse(body).status?.code } catch {}
        throw new UpstreamError(`库库未返回对话事件流（${ctype}）`, { code, body, status: 502 })
      }
      let buf = ""
      const dec = new TextDecoder("utf-8")
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true })
        let separator
        while ((separator = /\r?\n\r?\n/.exec(buf))) {
          const blk = buf.slice(0, separator.index)
          buf = buf.slice(separator.index + separator[0].length)
          const frame = parseSseBlock(blk)
          if (frame) yield frame
        }
      }
      if (buf.trim()) {
        const frame = parseSseBlock(buf)
        if (frame) yield frame
      }
    } catch (e) {
      if (e instanceof UpstreamError) throw e
      throw networkError(e, deadline, true)
    } finally {
      controller.abort()
    }
  }
}

export function parseSseBlock(block) {
  let event, id
  const data = []
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("id:")) id = line.slice(3).trim()
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
  }
  if (!data.length) return null
  const raw = data.join("\n")
  if (raw.trim() === "[DONE]") return { event: "done", id }
  let json
  try { json = JSON.parse(raw) } catch { return null }
  return { event, id, data: json }
}

// Maps an upstream frame to a delta the OpenAI bridge can consume.
export function frameToDelta(frame) {
  const d = frame?.data
  if (!d || typeof d !== "object") return null
  switch (d.type) {
    case "TEXT_BLOCK_DELTA":
      return { content: d.data?.delta ?? "" }
    case "THINKING_BLOCK_DELTA":
      return { reasoning_content: d.data?.delta ?? "" }
    case "MODEL_CALL_END": {
      const u = d.data ?? {}
      return {
        usage: {
          prompt_tokens: u.input_tokens ?? 0,
          completion_tokens: u.output_tokens ?? 0,
          total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
          reasoning_tokens: u.reasoning_tokens ?? 0,
          cache_read_tokens: u.cache_read_tokens ?? 0,
        },
        finish_reason: mapFinish(u),
      }
    }
    case "ACTUAL_POINT":
      return { consume_points: d.data?.consume_points ?? null }
    case "REQUIRE_EXTERNAL_EXECUTION":
    case "AWAITING_INPUT":
      return { requires_client: true }
    case "COMMERCIAL_NOTICE":
      return { commercial: { reason: d.data?.reason ?? null, text: d.data?.text ?? "", errno: null } }
    case "COMMERCIAL":
      return { commercial: { reason: d.data?.reason ?? null, text: "", errno: d.data?.errno ?? null } }
    case "ERROR":
    case "STREAM_ERROR":
      return { error: d.data ?? {} }
    default:
      return null
  }
}

function mapFinish(u) {
  const r = u.finished_reason ?? (Array.isArray(u.finish_reasons) ? u.finish_reasons[0] : undefined)
  if (!r || r === "completed" || r === "stop") return "stop"
  if (r === "length") return "length"
  return r
}
