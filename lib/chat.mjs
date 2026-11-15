// OpenAI-compatible facade over the native protocol.
//
// Two distinct paths:
//   - no client tools  -> a single text turn on the desktop endpoint (cheap, no MCP channels)
//   - client tools     -> the native MCP bridge, which keeps the upstream turn alive across
//                         the tool round-trip and returns finish_reason="tool_calls"
// The previous plugin rejected every tools request; that restriction is what made agent
// clients answer once and stop.
import { randomUUID } from "node:crypto"
import { KukuNativeAccount, UpstreamError, frameToDelta, turnError } from "./protocol.mjs"
import { prepareAgent, textContent, callerInstructions } from "./tools.mjs"
import { nativeAgentTurn, nativeAgentResume } from "./native.mjs"

const SESSION_IDLE_MS = 10 * 60_000

// Bounded map of live tool bridges, keyed by the tool_call ids handed to the caller. A
// follow-up request is matched by looking for any reserved id in the transcript tail.
const bridges = new Map()
const CALL_PREFIX = "call_kuku_mcp_"

function sweepBridges() {
  const now = Date.now()
  for (const [id, state] of bridges) {
    if (state.session.closed || state.session.expired || now - state.session.lastUsedAt > SESSION_IDLE_MS) {
      // Releasing is mandatory: a bridge idle for ten minutes still holds the MCP control
      // streams, which the upstream counts as an online client for this account.
      state.session.releaseControl()
      bridges.delete(id)
    }
  }
}

export function reserveCallIds(turn) {
  return turn.tool_calls.map(call => ({ ...call, id: `${CALL_PREFIX}${randomUUID().replaceAll("-", "")}` }))
}

function tailToolResults(messages) {
  let start = messages.length
  while (start && messages[start - 1].role === "tool") start--
  const results = messages.slice(start)
  return results.length ? { boundary: start, results } : null
}

function matchBridge(messages) {
  sweepBridges()
  const tail = tailToolResults(messages)
  if (!tail) return null
  const ids = tail.results.map(r => r.tool_call_id).filter(id => id.startsWith(CALL_PREFIX))
  if (!ids.length) return null
  const state = bridges.get(ids[0])
  if (!state) return null
  if (ids.some(id => bridges.get(id) !== state)) return null
  if (tail.results.some(r => typeof r.content !== "string")) return null
  return { state, ids, results: tail.results }
}

function textPrompt(messages, instructions) {
  const labelled = messages.map(m => {
    const label = { system: "系统指令", developer: "开发者指令", assistant: "助手之前的回复", user: "用户", tool: "工具结果" }[m.role]
    return `[${label ?? m.role}] ${m.content}`
  }).join("\n\n")
  const custom = callerInstructions(messages, instructions)
  return custom ? `${custom}\n\n${labelled}` : labelled
}

function normalizeText(body) {
  if (!Array.isArray(body.messages) || !body.messages.length) throw new UpstreamError("messages 不能为空", { status: 400 })
  for (const m of body.messages) {
    if (m.role === "tool" || m.tool_calls?.length) throw new UpstreamError("缺少 tools 时不能发送工具消息", { status: 400 })
  }
  return body.messages.map(m => {
    if (!["system", "developer", "user", "assistant"].includes(m.role)) throw new UpstreamError("不支持的消息角色", { status: 400 })
    return { role: m.role, content: textContent(m.content) }
  })
}

function sseChunk(id, created, model, delta, finishReason = null, extra = {}) {
  return {
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta, finish_reason: finishReason, ...(extra.logprobs ? { logprobs: null } : {}) }],
    ...(extra.usage ? { usage: extra.usage } : {}),
  }
}

function wire(encoder, value) {
  return encoder.encode(`data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`)
}

// Text-only turn: one sendmsg + one conversation stream, no control channels.
async function textTurn({ client, model, thinkMode, messages, instructions, signal, onDelta }) {
  const ids = await client.allocateIds("genfp", 3, { signal })
  const clientSessionId = randomUUID()
  const replyId = (await client.allocateIds("genfp", 3, { signal })).query_id
  const args = {
    session_id: ids.chat_id, reply_id: replyId, client_session_id: clientSessionId,
    device_id: `magpie-kuku-${randomUUID()}`, text: textPrompt(messages, instructions),
    model_name: model.model_name, model_display_name: model.display_name, think_mode: thinkMode,
    custom_instructions: callerInstructions(messages, instructions), signal,
  }
  await client.sendmsg(args)
  let text = "", reasoning = "", usage = null, finished = false
  for await (const frame of client.sse(args)) {
    const type = frame.data?.type
    if (frame.data?.data?.reply_id != null && String(frame.data.data.reply_id) !== String(replyId)) continue
    if (frame.event === "done" || type === "TURN_DONE" || type === "FINISH") { finished = true; break }
    const delta = frameToDelta(frame)
    if (!delta) continue
    if (delta.usage) usage = delta.usage
    if (delta.error) throw turnError(delta.error)
    if (delta.commercial) throw new UpstreamError("库库积分不足或商业限制", { status: 402, code: delta.commercial.errno ?? 11002, insufficient_balance: true })
    if (delta.content) { text += delta.content; onDelta({ content: delta.content }) }
    if (delta.reasoning_content) { reasoning += delta.reasoning_content; onDelta({ reasoning_content: delta.reasoning_content }) }
  }
  if (!finished && !text) throw new UpstreamError("库库未返回文本回复", { status: 502 })
  return { content: text, reasoning, usage, reply_id: replyId, session_id: ids.chat_id }
}

export async function chatResponse(auth, body, options = {}) {
  // `options.signal` belongs to the HTTP request that is already being answered. It is only
  // meaningful for the duration of this call, so it is forwarded but never stored on an object
  // that outlives it — a stored, already-aborted signal would kill the next tool round.
  const signal = options.signal
  const client = new KukuNativeAccount(auth)
  const modelId = String(body.model ?? "auto")
  const model = { model_name: modelId, display_name: modelId }
  const thinkMode = Number.isFinite(Number(body.think_mode)) ? Number(body.think_mode) : 3
  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const wantsTools = Array.isArray(body.tools) && body.tools.length > 0 && body.tool_choice !== "none"

  if (!wantsTools) {
    const messages = normalizeText(body)
    if (!body.stream) {
      const turn = await textTurn({ client, model, thinkMode, messages, instructions: body.instructions, signal, onDelta: () => {} })
      if (!turn.content) throw new UpstreamError("库库未返回文本回复", { status: 502 })
      return Response.json({
        id, object: "chat.completion", created, model: modelId,
        choices: [{ index: 0, message: { role: "assistant", content: turn.content }, finish_reason: "stop" }],
        ...(turn.usage ? { usage: turn.usage } : {}),
      })
    }
    const encoder = new TextEncoder()
    let started = false, finished = false, sawText = false, usage = null
    const queue = []
    let notify = null
    let ended = false, failure = null
    const turnPromise = textTurn({
      client, model, thinkMode, messages, instructions: body.instructions, signal,
      onDelta: d => { queue.push(d); notify?.(); },
    }).then(turn => { usage = turn.usage; ended = true; notify?.() }, e => { failure = e; ended = true; notify?.() })
    return new Response(new ReadableStream({
      async pull(controller) {
        if (finished) return
        if (!started) { started = true; controller.enqueue(wire(encoder, sseChunk(id, created, modelId, { role: "assistant" }))); return }
        try {
          while (true) {
            if (queue.length) {
              const delta = queue.shift()
              controller.enqueue(wire(encoder, sseChunk(id, created, modelId, delta)))
              if (delta.content) sawText = true
              return
            }
            if (ended) {
              if (failure) throw failure
              if (!sawText) throw new UpstreamError("库库未返回文本回复", { status: 502 })
              finished = true
              controller.enqueue(wire(encoder, sseChunk(id, created, modelId, {}, "stop", { usage: usage ?? undefined })))
              controller.enqueue(wire(encoder, "[DONE]"))
              controller.close()
              return
            }
            await new Promise(resolve => { notify = resolve })
            notify = null
          }
        } catch (e) {
          finished = true
          controller.enqueue(wire(encoder, { error: { type: "upstream_error", message: e.message ?? "库库对话流失败" } }))
          controller.enqueue(wire(encoder, "[DONE]"))
          controller.close()
          turnPromise.catch(() => {})
        }
      },
      async cancel() { finished = true },
    }), { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" } })
  }

  // ---- native MCP path ----
  // The tool path deliberately ignores the caller's request signal. Magpie aborts that signal
  // as soon as the first response body is consumed, which would tear down the MCP control
  // streams that the follow-up request needs. Bounded by the bridge's own deadline instead.
  const agent = prepareAgent(body, "chat")
  const matched = matchBridge(agent.messages)

  let turn
  if (matched) {
    // Continuation: the caller returned tool results for a reserved batch. Reuse the live
    // bridge so the upstream keeps generating in the same turn instead of replaying history.
    const { state, ids, results } = matched
    try {
      turn = await nativeAgentResume({
        session: state.session, agent, callbacks: state.callbacks, results: results.map(r => r.content),
        onDelta: () => {},
      })
    } catch (e) {
      // The upstream may have already retired the reply (a TURN_DONE that raced the handoff).
      // That is recoverable: the caller's transcript is complete, so replay it as a fresh turn
      // rather than failing the round-trip. Everything else is a real error.
      const recoverable = e?.code === "agent_continuation_unavailable"
        || e?.code === "upstream_incomplete"
        || /aborted/i.test(String(e?.message))
      if (!recoverable) throw e
      turn = await nativeAgentTurn({ client, model, agent, thinkMode, onDelta: () => {} })
    } finally {
      for (const key of ids) bridges.delete(key)
    }
  } else {
    turn = await nativeAgentTurn({ client, model, agent, thinkMode, onDelta: () => {} })
  }

  // Reserved ids make the bridge discoverable on the follow-up request.
  const calls = turn.tool_calls.length ? reserveCallIds(turn) : []
  if (turn.handoff && calls.length) {
    for (const call of calls) bridges.set(call.id, { session: turn.bridge, callbacks: turn.callbacks })
  } else if (matched) {
    // The continuation produced a final answer, so nothing is left to resume into. Release the
    // parked MCP streams instead of waiting for the idle sweep.
    matched.state.session.releaseControl()
    matched.state.session.closed = true
  }

  const message = {
    role: "assistant",
    content: turn.content || null,
    ...(calls.length ? { tool_calls: calls } : {}),
    ...(turn.reasoning ? { reasoning_content: turn.reasoning } : {}),
  }

  if (!body.stream) {
    return Response.json({
      id, object: "chat.completion", created, model: modelId,
      choices: [{ index: 0, message, finish_reason: calls.length ? "tool_calls" : "stop" }],
    })
  }

  const encoder = new TextEncoder()
  const chunks = []
  chunks.push(sseChunk(id, created, modelId, { role: "assistant" }))
  if (turn.reasoning) chunks.push(sseChunk(id, created, modelId, { reasoning_content: turn.reasoning }))
  if (turn.content) chunks.push(sseChunk(id, created, modelId, { content: turn.content }))
  if (calls.length) {
    chunks.push(sseChunk(id, created, modelId, {
      tool_calls: calls.map((call, index) => ({
        index, id: call.id, type: "function",
        function: { name: call.function.name, arguments: call.function.arguments },
      })),
    }))
  }
  chunks.push(sseChunk(id, created, modelId, {}, calls.length ? "tool_calls" : "stop"))
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(wire(encoder, chunk))
      controller.enqueue(wire(encoder, "[DONE]"))
      controller.close()
    },
  }), { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" } })
}

export { CALL_PREFIX }
