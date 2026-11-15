// Live check: several consecutive tool rounds in one conversation.
// This is the shape agent clients use, and it exercises the parked MCP control streams that a
// handoff leaves open between rounds.
import { loadHook, MODEL, URL_CHAT, tool, report, finish } from "./_shared.mjs"

const { hook } = await loadHook()
const call = async body => (await hook.fetch(URL_CHAT, { method: "POST", body: JSON.stringify(body) })).json()

const tools = [
  tool("read_file", "Read a UTF-8 text file from the workspace.", { path: { type: "string" } }, ["path"]),
  tool("list_dir", "List files in a workspace directory.", { path: { type: "string" } }, ["path"]),
]
const canned = { list_dir: "a.txt\nb.txt\nREADME.md", read_file: "ALPHA-777" }

const messages = [{ role: "user", content: "先列出当前目录的所有文件，然后读取 a.txt 的内容告诉我。" }]
let rounds = 0

while (rounds < 5) {
  rounds++
  const r = await call({ model: MODEL, stream: false, tools, messages })
  if (r.error) { report(`round ${rounds}`, false, r.error.message); break }
  const choice = r.choices[0]
  const msg = choice.message
  messages.push(msg)
  const calls = msg.tool_calls ?? []
  console.log(`round ${rounds}: finish=${choice.finish_reason} tools=${calls.map(c => c.function.name).join(",") || "-"}`)
  if (!calls.length) {
    console.log("--- answer ---\n" + (msg.content ?? ""))
    report("multi-round tool loop reaches the final answer", /ALPHA-777/.test(msg.content ?? ""), `${rounds} rounds`)
    break
  }
  for (const c of calls) {
    const value = canned[c.function.name] ?? "unknown"
    messages.push({ role: "tool", tool_call_id: c.id, content: value })
    console.log(`  -> ${c.function.name} = ${JSON.stringify(value)}`)
  }
}

finish()
