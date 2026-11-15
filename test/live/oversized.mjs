// Live check: a transcript past the upstream's 2 MiB limit.
//
// This is the request qoder-cn actually produced (759,714 input tokens) that used
// to come back as 400 "工具上下文超过 2 MiB，请压缩对话". It now has to be cut down
// and answered. The answer itself is barely the point — getting one at all is.
//
//   node test/live/oversized.mjs
import { loadHook, MODEL, URL_CHAT, tool, report, finish } from "./_shared.mjs"

const { hook } = await loadHook()
const call = async (body) => (await hook.fetch(URL_CHAT, { method: "POST", body: JSON.stringify(body) })).json()

const tools = [tool("read_file", "Read a UTF-8 text file.", { path: { type: "string" } }, ["path"])]

// ~3 MB of transcript, shaped like a real agent session: an opening task, many
// tool round trips, and a question at the end.
const filler = (n) => "日志内容 ".repeat(Math.ceil(n / 13))
const messages = [{ role: "user", content: "把项目里的配置都检查一遍。MARKER-OPENING" }]
for (let i = 0; i < 30; i++) {
  messages.push({
    role: "assistant",
    content: null,
    tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "read_file", arguments: `{"path":"f${i}.log"}` } }],
  })
  // Chinese is three bytes a character in UTF-8, so this is ~150 KB per result.
  messages.push({ role: "tool", tool_call_id: `call_${i}`, content: filler(150_000) })
}
messages.push({ role: "user", content: "最后用一句话总结你看到了什么。ANSWER-ME" })

const size = Buffer.byteLength(JSON.stringify(messages))
console.log(`transcript: ${(size / 1024 / 1024).toFixed(2)} MiB, ${messages.length} messages`)
report("the fixture really is over the old limit", size > 2 * 1024 * 1024, `${size} bytes`)

const started = Date.now()
const result = await call({ model: MODEL, stream: false, tools, messages })
const took = ((Date.now() - started) / 1000).toFixed(1)
console.log(`upstream took ${took}s`)

if (result.error) {
  report("an oversized transcript is answered, not refused", false, `${result.error.code ?? ""} ${result.error.message ?? JSON.stringify(result.error)}`.trim())
} else {
  const choice = result.choices?.[0]
  const content = choice?.message?.content ?? ""
  console.log("--- answer ---\n" + content.slice(0, 400))
  report("an oversized transcript is answered, not refused", Boolean(choice), `finish_reason=${choice?.finish_reason}`)
}

finish()
