// Shared offline upstream mock: replays captured genflowpro frame shapes with no network access.
import { ReadableStream } from "node:stream/web"

export function sse(frames) {
  const body = frames.map(f => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join("")
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
}

// Real control channels stay open for the whole turn; a mock that closes right after the
// handshake would look like "channel ended prematurely" to the bridge. The stream registry is
// passed in so this helper has no ordering dependency on the caller's state object. The stream
// must also honour abort, exactly like a real fetch body, or teardown would wait forever.
// `gate` lets a test defer task frames until the turn has been sent, because the device id and
// connector name are only known after sendmsg.
function holdOpen(frames, registry, signal, gate = null) {
  const encoder = new TextEncoder()
  let controller = null
  let cursor = 0
  let timer = null
  const flush = () => {
    if (!controller) return
    while (cursor < frames.length) {
      try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(frames[cursor++])}\n\n`)) } catch { return }
    }
  }
  return new ReadableStream({
    start(c) {
      controller = c
      flush()
      registry.push(c)
      signal?.addEventListener("abort", () => {
        clearInterval(timer)
        try { c.close() } catch { /* already closed */ }
      }, { once: true })
      if (gate) {
        timer = setInterval(() => {
          if (!gate.ready()) return
          clearInterval(timer)
          gate.then()
          flush()
        }, 2)
        timer.unref?.()
      }
    },
    // The upstream keeps the connection open with no further data; pull simply parks briefly
    // and returns, which lets the reader loop continue without closing the stream.
    pull() {
      return new Promise(resolve => { setTimeout(resolve, 25).unref?.() })
    },
  })
}

export function mockUpstream({ onSend, onToolResult, delayMs = 0 } = {}) {
  const calls = []
  let sendCount = 0
  let replySeq = 0
  const state = { calls, streams: [], mode: "text", deviceId: null, connector: null, get sendCount() { return sendCount } }
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const path = url.pathname
    const body = init.body ? JSON.parse(init.body) : {}
    calls.push({ path, body })

    if (path === "/wenchain/genflow/idallochstr") {
      replySeq += 1
      return Response.json({ status: { code: 0 }, data: { chat_id: "session-1", query_id: `reply-${replySeq}` } })
    }
    if (path === "/wenchain/genflowpro/sendmsg") {
      if (body.sub_type === "close") return Response.json({ status: { code: 0 }, data: {} })
      sendCount += 1
      state.deviceId = body.data.device_id
      state.connector = body.data.connector_list?.[0]?.name ?? null
      onSend?.(body, sendCount)
      return Response.json({ status: { code: 0 }, data: {} })
    }
    if (path === "/wenchain/genflowpro/sse/getchatcontent") {
      const replyId = body.reply_id
      if (state.mode === "tool") {
        return new Response(sse([
          { type: "TEXT_BLOCK_DELTA", data: { delta: "让我读一下文件。", reply_id: replyId } },
          { type: "REQUIRE_EXTERNAL_EXECUTION", data: { reply_id: replyId } },
          { type: "TURN_DONE", data: { reply_id: replyId } },
        ]), { headers: { "content-type": "text/event-stream" } })
      }
      return new Response(sse([
        { type: "TEXT_BLOCK_DELTA", data: { delta: "文件内容是 ", reply_id: replyId } },
        { type: "TEXT_BLOCK_DELTA", data: { delta: "HELLO_FROM_KUKU_NATIVE_MCP", reply_id: replyId } },
        { type: "MODEL_CALL_END", data: { reply_id: replyId, input_tokens: 11, output_tokens: 7 } },
        { type: "TURN_DONE", data: { reply_id: replyId } },
      ]), { headers: { "content-type": "text/event-stream" } })
    }
    if (path === "/api/genflowprosse/call") {
      const task = (taskId, requestId, subMethod, extra = {}) => ({
        type: "sandbox", sub_type: "task", task_id: taskId,
        data: JSON.stringify({
          method: "local_connector",
          params: {
            session_id: "session-1", device_id: state.deviceId, server_name: state.connector,
            sub_method: subMethod, request_id: requestId, arguments: {}, ...extra,
          },
        }),
      })
      // Upstream only issues tool tasks after the turn has been sent, so the device id and
      // connector name are unknown until then. Wait for the sendmsg before framing tasks.
      const frames = [{ type: "connected", sub_type: "connected" }]
      const emit = () => {
        frames.push(task("t-init", "r0", "initialize"), task("t-list", "r1", "tools/list"))
        if (state.mode === "tool") {
          frames.push(task("t-call", "r2", "tools/call", { tool_name: "read_file", arguments: { path: "notes.txt" } }))
        }
      }
      return new Response(holdOpen(frames, state.streams, init.signal, {
        ready: () => state.deviceId && state.connector,
        then: emit,
      }), { headers: { "content-type": "text/event-stream" } })
    }
    if (path === "/wenchain/genflowpro/sse/msgexchange") {
      return new Response(holdOpen([{ type: "connected", sub_type: "connected" }], state.streams, init.signal), { headers: { "content-type": "text/event-stream" } })
    }
    if (path === "/api/genflowprosse/callback") {
      onToolResult?.(body)
      return Response.json({ errno: 0, data: {} })
    }
    if (path === "/wenchain/genflowpro/clientmessage/list") {
      return Response.json({ errno: 0, data: { uk: 42, uname: "tester" } })
    }
    if (path === "/wenchain/genflowpro/model/list") {
      return Response.json({ status: { code: 0 }, data: {
        model_list: [{ model_name: "deepseek-v4.1-flash", model_display_name: "DeepSeek V4.1 Flash" }],
        think_list: [{ id: 3, description: "默认" }],
      } })
    }
    throw new Error(`unmocked upstream path: ${path}`)
  }
  return state
}
