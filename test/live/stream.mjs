// Live check: the streaming shape, which is what agent clients request by default.
// Both the tool_calls emission and the continuation must survive SSE framing.
import { loadHook, MODEL, URL_CHAT, tool, report, finish } from "./_shared.mjs"

const { hook } = await loadHook()

async function sse(body, label) {
  const res = await hook.fetch(URL_CHAT, { method: "POST", body: JSON.stringify({ ...body, stream: true }) })
  const text = await res.text()
  let content = "", finish = null
  const calls = []
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const raw = line.slice(6)
    if (raw === "[DONE]") continue
    let frame
    try { frame = JSON.parse(raw) } catch { continue }
    if (frame.error) { report(label, false, frame.error.message); return { content, finish, calls } }
    const choice = frame.choices?.[0]
    if (!choice) continue
    if (choice.delta?.content) content += choice.delta.content
    if (choice.delta?.tool_calls) calls.push(...choice.delta.tool_calls)
    if (choice.finish_reason) finish = choice.finish_reason
  }
  console.log(`\n== ${label} == finish=${finish} contentLen=${content.length}`)
  return { content, finish, calls }
}

const tools = [tool("read_file", "Read a UTF-8 text file from the workspace.", { path: { type: "string" } }, ["path"])]
const user = { role: "user", content: "读取 notes.txt 并告诉我内容。" }

const t1 = await sse({ model: MODEL, tools, messages: [user] }, "round 1")
report("streaming round 1 emits tool_calls", t1.finish === "tool_calls" && t1.calls.length > 0)

if (t1.calls.length) {
  const call = t1.calls[0]
  const t2 = await sse({
    model: MODEL, tools,
    messages: [
      user,
      { role: "assistant", content: null, tool_calls: [{ id: call.id, type: "function", function: call.function }] },
      { role: "tool", tool_call_id: call.id, content: "OMEGA-999" },
    ],
  }, "round 2")
  console.log("--- answer ---\n" + t2.content)
  report("streaming round 2 delivers the tool result", t2.content.includes("OMEGA-999"), `${t2.content.length} chars`)
}

finish()
