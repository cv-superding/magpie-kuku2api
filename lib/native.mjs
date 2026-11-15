// Native MCP bridge: keeps one upstream turn alive across a client-side tool round-trip.
//
// Flow: open two control SSE streams (sandbox = JSON-RPC tool tasks, base = conversation
// events), send the turn declaring a custom connector, answer initialize / tools.list from the
// caller's own tool definitions, and when the model issues tools.call hand control back to the
// OpenAI layer. The caller's tool results are then delivered as JSON-RPC callbacks on the same
// streams, and the same upstream reply_id continues producing text (resumed, prompt_bytes 0).
import { randomUUID } from "node:crypto"
import { UpstreamError, frameToDelta, turnError } from "./protocol.mjs"
import { renderAgent, validateAgentTurn, toolFingerprint, callerInstructions } from "./tools.mjs"

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

function failure(message, code = "upstream_requires_client") {
  const status = code === "upstream_timeout" ? 504 : code === "session_account_mismatch" ? 409 : 502
  return new UpstreamError(message, { status, code })
}

export const CONNECTOR_PREFIX = "external_agent_"

// A single bounded bridge instance. `maxMs` caps total wall clock for the whole tool loop.
export class NativeAgentSession {
  constructor({ client, model, thinkMode, maxMs = 30 * 60_000, idleMs = 300_000 }) {
    this.client = client
    this.model = model
    this.thinkMode = thinkMode
    this.maxMs = maxMs
    this.idleMs = idleMs
    this.deadline = Date.now() + maxMs
    this.closed = false
    this.createdAt = Date.now()
    this.lastUsedAt = Date.now()
    // Teardown for the MCP control streams. They are owned by the bridge, not by a turn: the
    // upstream registers this client as online for as long as they are connected, and a tool
    // result POSTed after they close is rejected with "client offline". A handoff therefore
    // parks them here and the resumed turn (or the deadline) releases them.
    this.control = null
  }

  // Tears down the parked control streams. Idempotent.
  releaseControl() {
    const held = this.control
    this.control = null
    if (!held) return
    held.abort.abort()
    held.done?.catch?.(() => {})
  }

  get expired() {
    return this.closed || Date.now() > this.deadline
  }

  touch() {
    this.lastUsedAt = Date.now()
  }
}

// Runs one assistant turn. Returns as soon as the model either answers or emits a validated
// batch of tool calls. When tool calls are present the returned `handoff` object is used to
// deliver results in a follow-up call; `session` must be reused for that follow-up.
export async function nativeAgentTurn({
  client, model, agent, thinkMode, signal, onDelta = () => {},
  ownsAccount = () => true, beforeSend = () => {},
  session = null, pendingCallbacks = null, pendingResults = null,
}) {
  const started = performance.now()
  const timing = { think_mode: thinkMode, tool_count: agent.tools.length, tool_list_count: 0, tool_call_count: 0, resumed: Boolean(pendingCallbacks) }
  const mark = key => { if (timing[key] == null) timing[key] = Math.round(performance.now() - started) }

  const bridge = session ?? new NativeAgentSession({ client, model, thinkMode })
  const abort = new AbortController()
  // Control channels and the conversation stream are aborted independently: a handoff keeps the
  // conversation open for the resumed turn while the MCP streams are torn down, and the reverse
  // happens on a normal answer. One shared controller would kill the survivor.
  //
  // A resumed turn reuses the control streams parked by the handoff. They are the reason the
  // upstream still considers this client online; closing them between turns is what made the
  // model answer "your desktop client is offline" instead of reading the tool result.
  const carried = Boolean(pendingCallbacks) ? bridge.control : null
  const controlAbort = carried?.abort ?? new AbortController()
  if (carried) bridge.control = null
  const remaining = Math.max(1_000, bridge.deadline - Date.now())
  const deadline = AbortSignal.timeout(Math.min(remaining, bridge.maxMs))
  const turnSignals = signal ? [abort.signal, deadline, signal] : [abort.signal, deadline]
  const combined = AbortSignal.any([...turnSignals, controlAbort.signal])
  // The conversation stream outlives control teardown on a handoff, so it deliberately excludes
  // controlAbort and keeps only the turn-level cancellation and deadline.
  const conversationSignal = AbortSignal.any(turnSignals)
  // Callbacks escape the turn that created them (see `listen`): they are replayed by the next
  // request. They must NOT capture this turn's `combined`, which includes the per-turn
  // `controlAbort` and is torn down in `finally`; they resolve the transport signal lazily from
  // the bridge instead, which now holds a signal that survives the handoff.
  bridge.liveSignal = conversationSignal
  const liveSignal = () => {
    const current = bridge.liveSignal
    return current && !current.aborted ? current : conversationSignal
  }
  const cancelled = deferred()
  const onAbort = () => {
    cancelled.reject(
      combined.reason?.code === "agent_continuation_unavailable"
        ? combined.reason
        : failure("库库原生工具轮次被取消或超时", "upstream_timeout"),
    )
  }
  combined.addEventListener("abort", onAbort, { once: true })
  if (combined.aborted) onAbort()

  // Reusing a session keeps the same ids: the resumed turn must stay on the original reply.
  const baseId = bridge.baseId ?? randomUUID()
  const sandboxId = bridge.sandboxId ?? randomUUID()
  const deviceId = bridge.deviceId ?? `magpie-kuku2api-${randomUUID()}`
  bridge.baseId = baseId
  bridge.sandboxId = sandboxId
  bridge.deviceId = deviceId

  const broken = deferred(), sandboxReady = deferred(), baseReady = deferred(), handoff = deferred()
  const calls = [], seen = bridge.seen ?? new Set(), callbacks = []
  bridge.seen = seen
  // A carried control stream keeps its listeners from an earlier turn. Those listeners must
  // publish into the turn that is running NOW, so they read the collect state through the
  // bridge instead of closing over this turn's locals.
  const turnState = { calls, callbacks, handoff, handedOff: false, batchTimer: null }
  const collect = () => bridge.turnState ?? turnState
  bridge.turnState = turnState
  let pointBase = bridge.latestPoints ?? 0, latestPoints = pointBase, resumed = Boolean(pendingCallbacks)
  let connectTimer, generationTimer, ids = bridge.ids, replyId = bridge.replyId
  // A resumed turn re-subscribes to the same reply, and depending on how far the upstream has
  // already generated it may replay a prefix of what the caller already received. The replay is
  // detected by matching the known carrying text rather than by a fixed byte cut, because the
  // upstream often sends only the new text.
  let args, sent = false, closed = false, complete = false, handedOff = false
  let content = ""
  let reasoning = ""
  const carryText = resumed
    ? { content: bridge.carry?.content ?? "", reasoning: bridge.carry?.reasoning ?? "" }
    : null

  // Returns only the part of `full` that the caller has not already seen. A replay is assumed
  // only while the accumulated text is still a prefix of the carried text.
  const freshText = (full, key) => {
    if (!carryText) return full
    const seen = carryText[key]
    if (!seen) return full
    if (full.length <= seen.length) {
      return seen.startsWith(full) ? "" : full
    }
    const matched = seen.startsWith(full.slice(0, seen.length))
    return matched ? full.slice(seen.length) : full
  }

  const available = agent.choice === "none" ? [] : agent.tools.filter(tool => typeof agent.choice !== "object" || tool.name === agent.choice.name)
  const { tools, fingerprint } = toolFingerprint(available)
  const connector = `${CONNECTOR_PREFIX}${fingerprint}`
  timing.tool_fingerprint = fingerprint
  timing.tool_definition_bytes = Buffer.byteLength(JSON.stringify(tools))

  const listen = async (kind, payload, ready) => {
    try {
      for await (const frame of client.controlStream(kind, payload, combined, { timeoutMs: Math.min(remaining, 180_000) })) {
        const envelope = frame.data
        if (!envelope) continue
        if (envelope.type === "connected" || envelope.sub_type === "connected") { ready.resolve(); continue }
        if (envelope.type === "error" || envelope.errno || (envelope.code != null && Number(envelope.code) !== 0)) {
          throw new UpstreamError("库库原生工具通道拒绝连接", { code: Number(envelope.code ?? envelope.errno), status: 502 })
        }
        if (kind !== "sandbox" || envelope.type !== "sandbox" || envelope.sub_type !== "task") continue
        let request = envelope.data
        if (typeof request === "string") {
          try { request = JSON.parse(request) } catch { throw failure("原生工具任务负载无效", "invalid_tool_response") }
        }
        const params = request?.params
        // One account may have several real desktop clients attached; never answer their tasks.
        if (!ids || params?.session_id !== ids.chat_id || params.device_id !== deviceId) continue
        if (!ownsAccount()) throw failure("工具轮次期间账号身份已变化", "session_account_mismatch")
        if (typeof envelope.task_id !== "string" || !envelope.task_id) throw failure("原生工具任务缺少 task_id", "invalid_tool_response")
        if (seen.has(envelope.task_id)) continue
        seen.add(envelope.task_id)
        // The callback must NOT capture this turn's `combined` signal. A handed-off turn tears
        // that signal down in `finally` (controlAbort), yet these callbacks outlive the turn:
        // they are replayed by `nativeAgentResume` on the *next* request. Capturing `combined`
        // therefore made every tool result POST carry an already-aborted signal, which surfaced
        // as `network: This operation was aborted` on the continuation round.
        // `liveSignal` is rebound at the start of each turn so the callback always uses the
        // signal of the turn that is actually delivering it.
        const callback = result => client.nativeToolResult({
          task_id: envelope.task_id, device_id: deviceId, client_session_id: sandboxId,
          request_id: params.request_id, ...result, signal: liveSignal(),
        })
        if (request.method !== "local_connector" || params.server_name !== connector) {
          // Built-in filesystem / shell connectors are refused, never executed.
          await callback({ errno: 2001 })
          throw failure("模型请求了内置桌面工具；未向调用方暴露此类能力")
        }
        if (params.sub_method === "tools/list") {
          mark("tool_list_ms")
          timing.tool_list_count++
          await callback({ result: { tools } })
          mark("tools_ready_ms")
        } else if (params.sub_method === "initialize") {
          await callback({ result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: connector, version: "1" } } })
        } else if (params.sub_method === "tools/call") {
          const live = collect()
          if (live.handedOff) throw failure("工具批次在交接后发生变化；未执行迟到的调用", "invalid_tool_response")
          mark("tool_call_ms")
          const tool = available.find(t => t.name === params.tool_name)
          if (!tool) throw failure("模型选择了未定义的工具", "invalid_tool_response")
          let args_ = params.arguments
          if (typeof args_ === "string") {
            try { args_ = JSON.parse(args_) } catch { throw failure("原生工具参数无效", "invalid_tool_response") }
          }
          live.calls.push(tool.type === "custom" ? { name: tool.name, input: args_?.input } : { name: tool.name, arguments: args_ })
          live.callbacks.push(callback)
          validateAgentTurn({ content, tool_calls: live.calls }, agent)
          timing.tool_call_count = live.calls.length
          // The model may request independent tools together; collect the whole batch.
          if (!live.batchTimer) live.batchTimer = setTimeout(() => live.handoff.resolve(), 80)
        } else {
          throw failure("不支持的原生连接器方法", "invalid_tool_response")
        }
      }
      if (!combined.aborted) throw failure("原生工具通道提前结束", "upstream_incomplete")
    } catch (error) {
      if (!combined.aborted) { ready.reject(error); broken.reject(error) }
    }
  }

  const sandbox = carried
    ? carried.sandbox
    : listen("sandbox", {
        client_session_id: sandboxId, device_type: 401, device_id: deviceId,
        device_name: "magpie kuku agent", os_name: "linux", client_version: "1.6.5.130",
      }, sandboxReady)
  const base = carried ? carried.base : listen("base", { client_session_id: baseId, device_type: 401 }, baseReady)
  if (carried) { sandboxReady.resolve(); baseReady.resolve() }

  let iterator, next, cancelConnection
  // Hands the MCP control streams to the bridge instead of tearing them down. The upstream
  // considers this client online only while they are connected, so closing them between the
  // two halves of a tool round-trip is exactly what produced "your desktop client is offline".
  const parkControl = () => {
    bridge.control = { sandbox, base, abort: controlAbort }
    bridge.liveSignal = conversationSignal
  }
  const close = async () => {
    // A handed-off turn stays open on purpose: the caller's tool results arrive on the MCP
    // callbacks and the same reply_id must keep generating. Closing here would end the turn.
    if (!sent || closed || complete || handedOff) return
    mark("close_started_ms")
    try { await client.closeTurn({ ...args, signal: AbortSignal.timeout(10_000) }) } catch { /* terminal close is best-effort */ }
    closed = true
    bridge.closed = true
    mark("close_done_ms")
  }

  try {
    const ready = Promise.race([
      Promise.all([sandboxReady.promise, baseReady.promise]).then(() => mark("controls_ready_ms")),
      broken.promise,
      new Promise((_, reject) => {
        connectTimer = setTimeout(() => reject(failure("原生工具通道连接超时", "upstream_timeout")), 15_000)
        connectTimer.unref?.()
        cancelConnection = () => reject(failure("工具轮次被取消", "upstream_timeout"))
        if (combined.aborted) cancelConnection()
        else combined.addEventListener("abort", cancelConnection, { once: true })
      }),
    ]).finally(() => { clearTimeout(connectTimer); combined.removeEventListener("abort", cancelConnection) })

    const preparation = (async () => {
      if (!ids) {
        // A resumed turn reuses the ids so the assistant continues the same reply.
        const allocated = await Promise.all([
          client.allocateIds("genfp", 3, { signal: combined }),
          client.allocateIds("genfp", 3, { signal: combined }),
        ])
        ids = allocated[0]
        replyId = allocated[1].query_id
        bridge.ids = ids
        bridge.replyId = replyId
      }
      args = {
        session_id: ids.chat_id, reply_id: replyId, client_session_id: baseId, device_id: deviceId,
        text: renderAgent(agent, connector, available),
        model_name: model.model_name, model_display_name: model.display_name, think_mode: thinkMode,
        custom_instructions: callerInstructions(agent.messages, agent.instructions, { labelRoles: true }),
        memory_sign: false, skill_dig_sign: false,
        connector_list: tools.length ? [{ name: connector, description: "Client tools for the caller workspace.", type: "custom" }] : [],
        signal: combined, streamTimeoutMs: Math.min(remaining, 180_000),
      }
      timing.prompt_bytes = Buffer.byteLength(args.text)
    })()

    await Promise.all([preparation, ready])
    mark("prepared_ms")
    if (!ownsAccount()) throw failure("发送前账号身份已变化", "session_account_mismatch")
    beforeSend()
    sent = true
    mark("send_started_ms")
    if (!resumed) await client.sendmsg({ ...args, msg_id: undefined })
    mark("send_ack_ms")

    // The conversation stream and the two control streams share the turn deadline, but each
    // needs its own controller: teardown must be able to abort the long-lived control channels
    // without killing the conversation stream a resumed turn is still reading.
    iterator = client.sse({ ...args, msg_id: bridge.msgId, signal: conversationSignal })[Symbol.asyncIterator]()
    next = iterator.next()

    // Deliver pending tool results from the previous assistant turn. MCP expects a CallToolResult
    // shaped `{ content: [{ type: "text", text }] }` — a bare string is silently dropped by the
    // model, which then answers as if the tool returned nothing.
    if (pendingCallbacks?.length) {
      if (pendingResults?.length !== pendingCallbacks.length) {
        throw failure("工具结果数量与待完成的调用不匹配", "invalid_tool_history")
      }
      for (const [index, callback] of pendingCallbacks.entries()) {
        const raw = pendingResults[index]
        await callback({ result: { content: [{ type: "text", text: String(raw ?? "") }], isError: false } })
      }
      timing.tool_call_count = pendingCallbacks.length
      mark("results_delivered_ms")
    }

    while (true) {
      // A pending tool batch always wins: the caller must receive the calls before the upstream
      // turn is allowed to finish, otherwise there is nothing left to resume into.
      const event = calls.length
        ? await Promise.race([
            handoff.promise.then(() => ({ handoff: true })),
            next.then(value => ({ value })),
            broken.promise,
            cancelled.promise,
          ])
        : await Promise.race([
            next.then(value => ({ value })),
            handoff.promise.then(() => ({ handoff: true })),
            broken.promise,
            cancelled.promise,
          ])
      if (event.handoff) {
        if (!ownsAccount()) throw failure("工具交接期间账号身份已变化", "session_account_mismatch")
        clearTimeout(turnState.batchTimer)
        handedOff = true
        turnState.handedOff = true
        mark("total_ms")
        const emitted = freshText(content, "content")
        const thought = freshText(reasoning, "reasoning")
        const turn = { ...validateAgentTurn({ content: emitted, tool_calls: calls }, agent), reasoning: thought, tool_adapter: "native-mcp", handoff: true }
        bridge.carry = { content, reasoning }
        bridge.touch()
        parkControl()
        return {
          ...turn,
          session_id: ids.chat_id, reply_id: replyId,
          callbacks: callbacks.splice(0),
          bridge,
        }
      }
      if (event.value?.done) throw failure("原生对话在收到完成标记前结束", "upstream_incomplete")
      const frame = event.value.value, type = frame.data?.type
      mark("first_event_ms")
      if (!ownsAccount()) throw failure("对话期间账号身份已变化", "session_account_mismatch")
      if (frame.data?.data?.reply_id != null && String(frame.data.data.reply_id) !== String(replyId)) {
        next = iterator.next()
        continue
      }
      if (type === "MODEL_CALL_START") resumed = false
      // Once a tool batch has been handed to the caller, later frames belong to a turn the
      // caller is already driving. Honouring a TURN_DONE here would close the reply the
      // follow-up must resume into, so the handoff wins the race unconditionally.
      if (handedOff) { next = iterator.next(); continue }
      if (frame.event === "done" || ((type === "TURN_DONE" || type === "FINISH")
        && (frame.data.data?.reply_id == null || String(frame.data.data.reply_id) === String(replyId)))) {
        complete = true
        if (!ownsAccount()) throw failure("对话期间账号身份已变化", "session_account_mismatch")
        const emitted = freshText(content, "content")
        const thought = freshText(reasoning, "reasoning")
        const turn = validateAgentTurn({ content: emitted, tool_calls: calls }, agent)
        // A turn that ends while tool calls are pending is still a handoff: the bridge must
        // survive teardown, otherwise the follow-up has nothing to resume into. Only a genuine
        // final answer may close the upstream turn.
        if (calls.length) {
          handedOff = true
          bridge.carry = { content, reasoning }
          bridge.touch()
          return {
            ...turn,
            reasoning: thought,
            session_id: ids.chat_id,
            reply_id: replyId,
            callbacks: callbacks.splice(0),
            bridge,
            handoff: true,
          }
        }
        return { ...turn, reasoning: thought, session_id: ids.chat_id, reply_id: replyId }
      }
      const delta = frameToDelta(frame)
      if (delta?.consume_points != null) {
        latestPoints = Math.max(latestPoints, delta.consume_points)
        bridge.latestPoints = latestPoints
      }
      if (delta?.content) content += delta.content
      if (delta?.reasoning_content) reasoning += delta.reasoning_content
      if (Buffer.byteLength(content) + Buffer.byteLength(reasoning) > 4 * 1024 * 1024) {
        throw failure("原生响应超过 4 MiB", "invalid_tool_response")
      }
      // A registered MCP call legitimately waits for the caller. Only an unregistered wait is
      // an error, and sandbox tasks can arrive after the wait frame on the parallel stream.
      if (delta?.requires_client && !calls.length && !resumed) {
        let arrivalTimer
        try {
          if (!available.length) throw failure("模型请求了桌面输入，但调用方没有提供工具")
          await Promise.race([handoff.promise, broken.promise, cancelled.promise,
            new Promise((_, reject) => {
              arrivalTimer = setTimeout(() => reject(failure("原生桌面等待没有匹配的客户端工具任务")), 3_000)
            })])
        } finally { clearTimeout(arrivalTimer) }
      }
      if (delta?.error) throw turnError(delta.error)
      if (delta?.commercial) {
        const drained = delta.commercial.reason === "insufficient_balance" || Number(delta.commercial.errno) === 11002
        throw new UpstreamError("库库积分不足或商业限制", { status: 402, code: delta.commercial.errno ?? 11002, insufficient_balance: drained })
      }
      if (!combined.aborted && (delta?.content || delta?.reasoning_content)) {
        if (delta.content) mark("first_text_ms")
        onDelta({
          ...(delta.content ? { content: delta.content } : {}),
          ...(delta.reasoning_content ? { reasoning_content: delta.reasoning_content } : {}),
        })
      }
      next = iterator.next()
    }
  } catch (error) {
    if (sent && !error.definitiveRefusal) error.retryUnsafe = true
    throw error
  } finally {
    clearTimeout(turnState.batchTimer)
    clearTimeout(connectTimer)
    clearTimeout(generationTimer)
    if (cancelConnection) combined.removeEventListener("abort", cancelConnection)
    try { await close() } catch { /* preserve the original error */ }
    // The control streams are long-lived: they must be aborted, never awaited. Awaiting them
    // would hang the handoff forever, which is exactly what a live sandbox stream looks like.
    // On a handoff they were just parked on the bridge and must stay connected, otherwise the
    // upstream marks this client offline and refuses the tool result the caller is about to send.
    if (!handedOff) controlAbort.abort()
    // On a handoff the conversation stream is deliberately left open so the resumed turn can
    // keep reading the same reply; only a finished or failed turn cancels it.
    if (!handedOff) abort.abort()
    // A turn that ends without handing off has nothing left to resume, so any control stream
    // parked by an earlier handoff is released here.
    if (!handedOff) bridge.releaseControl()
    // Bounded teardown: a stalled body must never hold the client response open. A parked
    // stream never settles, so it is excluded rather than merely raced.
    if (!handedOff) {
      const settled = await Promise.race([
        Promise.allSettled([sandbox, base, next]),
        new Promise(resolve => { const t = setTimeout(() => resolve("timeout"), 2_000); t.unref?.() }),
      ])
      void settled
    }
    combined.removeEventListener("abort", onAbort)
  }
}

// A resumed turn re-delivers tool results to the still-open MCP callbacks. The upstream never
// re-reads history: it keeps the original turn and prompt_bytes stays 0.
export async function nativeAgentResume({ session, agent, callbacks, results, signal, onDelta = () => {}, ownsAccount = () => true, beforeSend = () => {} }) {
  if (session.expired) {
    throw new UpstreamError("原生工具续接已失效，请新建对话", { status: 409, code: "agent_continuation_unavailable" })
  }
  if (!results.length || results.length !== callbacks.length) {
    throw new UpstreamError("工具结果数量与待完成的调用不匹配", { status: 400, code: "invalid_tool_history" })
  }
  return nativeAgentTurn({
    client: session.client, model: session.model, agent, thinkMode: session.thinkMode,
    signal, onDelta, ownsAccount, beforeSend,
    session, pendingCallbacks: callbacks, pendingResults: results,
  })
}
