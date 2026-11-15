// Live check: one tool round-trip against the real account.
// Verifies that a tools request returns finish_reason=tool_calls and that the tool result
// reaches the model on the continuation.
import { loadHook, MODEL, URL_CHAT, tool, report, finish } from "./_shared.mjs"

const { hook } = await loadHook()
const call = async body => (await hook.fetch(URL_CHAT, { method: "POST", body: JSON.stringify(body) })).json()

const tools = [tool("read_file", "Read a UTF-8 text file from the workspace.", { path: { type: "string" } }, ["path"])]
const user = { role: "user", content: "调用 read_file 读取 notes.txt，然后用一句话告诉我内容。" }

const r1 = await call({ model: MODEL, stream: false, tools, messages: [user] })
const choice1 = r1.choices?.[0]
const tc = choice1?.message?.tool_calls?.[0]
report("round 1 returns a tool call", choice1?.finish_reason === "tool_calls" && Boolean(tc),
  tc ? `${tc.function.name} ${tc.function.arguments}` : r1.error?.message)

if (tc) {
  const r2 = await call({
    model: MODEL, stream: false, tools,
    messages: [user, choice1.message, { role: "tool", tool_call_id: tc.id, content: "SECRET123" }],
  })
  const content = r2.choices?.[0]?.message?.content ?? ""
  console.log("--- answer ---\n" + content)
  report("round 2 delivers the tool result to the model", content.includes("SECRET123"), `${content.length} chars`)
}

finish()
