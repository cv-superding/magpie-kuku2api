// Offline contract tests: a mock upstream replays captured genflowpro frames. No live account,
// no network. The goal is to prove the two properties the old plugin violated:
//   1. a tools request produces finish_reason="tool_calls" with native-mcp provenance;
//   2. the follow-up delivers results on the still-open MCP callbacks and does not resend text.
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The plugin adopts an existing kuku session from Magpie's auth store when its own credential is
// missing. Point that store at an empty temp dir so these tests never read or depend on the
// developer's real login. Must be set before the module reads it.
const SANDBOX = mkdtempSync(join(tmpdir(), "kuku-plugin-test-"))
writeFileSync(join(SANDBOX, "plugin-auth.json"), "{}")
process.env.MAGPIE_CONFIG_DIR = SANDBOX

const { default: exportShape, KukuAgentPlugin } = await import("../index.mjs")
const { mockUpstream, sse } = await import("./harness.mjs")

// Magpie resolves a plugin by reading `id` off the default export, so the shape matters as much
// as the behaviour: a bare factory function leaves `id` undefined and the host silently skips it.
test("the default export carries the provider id and a server factory", () => {
  assert.equal(exportShape.id, "kuku2")
  assert.equal(typeof exportShape.server, "function")
})

const CRED = JSON.stringify({ BDUSS: "synthetic-bduss", STOKEN: "synthetic-stoken" })

async function loadPlugin() {
  const plugin = await KukuAgentPlugin()
  const getAuth = async () => ({ access: CRED, accountId: "42" })
  const { apiKey, fetch: fetchHook } = await plugin.auth.loader(getAuth)
  return { plugin, apiKey, fetchHook }
}

const TOOLS = [{
  type: "function",
  function: {
    name: "read_file",
    description: "Read a text file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
}]

test("models declare tool support and are never text-only", async () => {
  const { plugin } = await loadPlugin()
  const config = {}
  await plugin.config(config)
  assert.equal(config.provider.kuku2.models.auto.tool_call, true)
  assert.deepEqual(config.provider.kuku2.models.auto.modalities, { input: ["text"], output: ["text"] })

  // With no credential anywhere (own store empty, no adopted session) the static catalog is
  // returned unchanged so the provider stays selectable.
  const staticModels = { auto: { name: "auto" } }
  const runtime = await plugin.provider.models({ id: "kuku2", models: staticModels }, { auth: null })
  assert.equal(runtime, staticModels)

  // With a credential the live catalog is translated and every entry advertises tools.
  mockUpstream()
  const live = await plugin.provider.models({ id: "kuku2", models: staticModels }, { auth: { access: CRED } })
  const model = live["deepseek-v4.1-flash"]
  assert.ok(model, "the live catalog must be used when a credential is present")
  assert.equal(model.capabilities.toolcall, true)
  assert.equal(model.api.url, "https://kuku.baidu.com/v1")
  assert.equal(model.providerID, "kuku2")
})

test("an unauthorised kuku2 reuses the stored kuku session instead of going dark", async () => {
  // Magpie stores one credential per provider id, so a fresh install of this plugin has none
  // while the official kuku login is already present. Both the model list and the request path
  // must fall back to that stored session, otherwise the provider silently shows nothing.
  const { plugin } = await loadPlugin()
  const state = mockUpstream()
  const staticModels = { auto: { name: "auto" } }

  const withoutAdopted = await plugin.provider.models({ id: "kuku2", models: staticModels }, { auth: null })
  assert.equal(withoutAdopted, staticModels, "no stored session must leave the static catalog alone")

  // Simulate a signed-in official kuku plugin.
  writeFileSync(join(SANDBOX, "plugin-auth.json"), JSON.stringify({ kuku: { access: CRED, accountId: "42" } }))
  try {
    const adopted = await plugin.provider.models({ id: "kuku2", models: staticModels }, { auth: null })
    assert.ok(adopted["deepseek-v4.1-flash"], "the stored kuku session must drive the live catalog")
    assert.equal(state.calls.some(c => String(c.path).includes("model/list")), true)
  } finally {
    writeFileSync(join(SANDBOX, "plugin-auth.json"), "{}")
  }
})

test("a tools request returns finish_reason tool_calls and exposes the connector", async () => {
  const state = mockUpstream()
  const { fetchHook } = await loadPlugin()
  state.mode = "tool"

  const res = await fetchHook("https://kuku.baidu.com/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "deepseek-v4.1-flash", stream: false,
      messages: [{ role: "user", content: "读一下 notes.txt" }],
      tools: TOOLS,
    }),
  })
  assert.equal(res.status, 200)
  const json = await res.json()
  const choice = json.choices[0]
  assert.equal(choice.finish_reason, "tool_calls")
  assert.equal(choice.message.tool_calls.length, 1)
  assert.equal(choice.message.tool_calls[0].function.name, "read_file")
  assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), { path: "notes.txt" })

  // The upstream must have been told a custom connector exists.
  const send = state.calls.find(c => c.path === "/wenchain/genflowpro/sendmsg" && c.body.sub_type === "chat_create")
  assert.equal(send.body.data.connector_list.length, 1)
  assert.match(send.body.data.connector_list[0].name, /^external_agent_[0-9a-f]{24}$/)
  assert.equal(send.body.data.connector_list[0].type, "custom")

  // tools/list must have been answered with the caller's own definition.
  const listReply = state.calls.find(c => c.path === "/api/genflowprosse/callback" && c.body.task_id === "t-list")
  const payload = JSON.parse(listReply.body.payload[0])
  assert.equal(payload.data.result.tools[0].name, "read_file")
  assert.equal(payload.data.result.tools[0].inputSchema.required[0], "path")
})

test("the follow-up delivers results on the open callbacks without resending the prompt", async () => {
  const state = mockUpstream()
  const { fetchHook } = await loadPlugin()
  state.mode = "tool"

  const first = await (await fetchHook("https://kuku.baidu.com/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "m", stream: false, messages: [{ role: "user", content: "读笔记" }], tools: TOOLS }),
  })).json()
  const call = first.choices[0].message.tool_calls[0]
  const sendsAfterFirst = state.sendCount
  state.mode = "text"

  const second = await (await fetchHook("https://kuku.baidu.com/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "m", stream: false, tools: TOOLS,
      messages: [
        { role: "user", content: "读笔记" },
        { role: "assistant", content: first.choices[0].message.content, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: "HELLO_FROM_KUKU_NATIVE_MCP" },
      ],
    }),
  })).json()

  assert.equal(second.choices[0].finish_reason, "stop")
  assert.match(second.choices[0].message.content, /HELLO_FROM_KUKU_NATIVE_MCP/)

  // A resumed turn must not open a second upstream turn.
  assert.equal(state.sendCount, sendsAfterFirst)

  // The tool result must have travelled back through the MCP callback channel.
  const resultCallback = state.calls.filter(c => c.path === "/api/genflowprosse/callback")
    .map(c => JSON.parse(c.body.payload[0]))
    .find(p => p.data?.jsonrpc === "2.0" && String(p.data.id) === "r2")
  assert.ok(resultCallback, "the tools/call request must receive a JSON-RPC result")
  assert.equal(resultCallback.data.result.content[0].type, "text")
  assert.equal(resultCallback.data.result.content[0].text, "HELLO_FROM_KUKU_NATIVE_MCP")
})

test("streaming text path emits role, content and a terminal stop", async () => {
  const state = mockUpstream()
  const { fetchHook } = await loadPlugin()
  state.mode = "text"

  const res = await fetchHook("https://kuku.baidu.com/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "打个招呼" }] }),
  })
  assert.equal(res.status, 200)
  const text = await res.text()
  const lines = text.split("\n").filter(l => l.startsWith("data: ")).map(l => l.slice(6))
  assert.ok(lines.includes("[DONE]"))
  const payloads = lines.filter(l => l !== "[DONE]").map(l => JSON.parse(l))
  const content = payloads.map(p => p.choices?.[0]?.delta?.content ?? "").join("")
  assert.match(content, /HELLO_FROM_KUKU_NATIVE_MCP/)
  const terminal = payloads.at(-1)
  assert.equal(terminal.choices[0].finish_reason, "stop")
})

test("only chat/completions is served", async () => {
  mockUpstream()
  const { fetchHook } = await loadPlugin()
  const res = await fetchHook("https://kuku.baidu.com/v1/embeddings", { method: "POST", body: "{}" })
  assert.equal(res.status, 404)
})

test("an invalid tool schema is rejected before reaching upstream", async () => {
  const state = mockUpstream()
  const { fetchHook } = await loadPlugin()
  const res = await fetchHook("https://kuku.baidu.com/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "m", stream: false,
      messages: [{ role: "user", content: "x" }],
      tools: [{ type: "function", function: { name: "bad name", parameters: { type: "object" } } }],
    }),
  })
  assert.equal(res.status, 400)
  const json = await res.json()
  assert.equal(json.error.type, "invalid_request_error")
  assert.equal(state.calls.length, 0, "no upstream call may happen for an invalid request")
})
