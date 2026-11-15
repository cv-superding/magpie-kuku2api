// Cutting a transcript to fit the upstream's 2 MiB limit.
//
// The upstream reads the caller's conversation as one JSON blob inside a prompt.
// Past that size it refuses, and the old behaviour was to raise — a refusal the
// caller cannot act on, because it does not own the conversation. These tests pin
// what replaced it: drop the oldest turns, keep the task and the turn being
// answered, and never separate a tool call from its result.

import test from "node:test"
import assert from "node:assert/strict"

const { fitMessages, prepareAgent, renderAgent } = await import("../lib/tools.mjs")

const bytes = (value) => Buffer.byteLength(JSON.stringify(value))

// filler builds a message of roughly `size` bytes of prose.
const filler = (role, size, extra = {}) => ({
  role,
  content: "x".repeat(Math.max(1, size - 40)),
  ...extra,
})

test("a transcript that already fits is returned untouched", () => {
  const messages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  ]
  assert.equal(fitMessages(messages, 1024 * 1024), messages)
})

test("an oversized transcript is cut to the budget", () => {
  const messages = []
  for (let i = 0; i < 40; i++) {
    messages.push({ role: "user", content: `task ${i} ` + "a".repeat(50_000) })
    messages.push({ role: "assistant", content: "ok " + "b".repeat(50_000) })
  }
  const budget = 300_000
  assert.ok(bytes(messages) > budget, "the fixture is over budget to begin with")
  const out = fitMessages(messages, budget)
  assert.ok(bytes(out) <= budget * 1.1, `still too big: ${bytes(out)} vs ${budget}`)
  assert.ok(out.length < messages.length, "something was dropped")
})

test("the opening task and the newest turn both survive", () => {
  const messages = [{ role: "user", content: "OPENING-TASK " + "a".repeat(40_000) }]
  for (let i = 0; i < 30; i++) {
    messages.push({ role: "user", content: `middle ${i} ` + "m".repeat(40_000) })
    messages.push({ role: "assistant", content: "ok " + "b".repeat(40_000) })
  }
  messages.push({ role: "user", content: "NEWEST-QUESTION" })
  const out = fitMessages(messages, 200_000)
  const text = JSON.stringify(out)
  assert.ok(text.includes("OPENING-TASK"), "the task statement was lost")
  assert.ok(text.includes("NEWEST-QUESTION"), "the turn being answered was lost")
})

test("a tool call never survives without its result, or the reverse", () => {
  const messages = [{ role: "user", content: "start" }]
  for (let i = 0; i < 25; i++) {
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "bash", arguments: `{"cmd":"step${i}"}` } }],
    })
    messages.push({ role: "tool", tool_call_id: `call_${i}`, content: "r".repeat(60_000) })
  }
  messages.push({ role: "user", content: "final question" })
  const out = fitMessages(messages, 250_000)
  const callIDs = new Set()
  const resultIDs = new Set()
  for (const message of out) {
    for (const call of message.tool_calls ?? []) callIDs.add(call.id)
    if (message.role === "tool" && message.tool_call_id) resultIDs.add(message.tool_call_id)
  }
  for (const id of callIDs) assert.ok(resultIDs.has(id), `call ${id} kept but its result dropped`)
  for (const id of resultIDs) assert.ok(callIDs.has(id), `result ${id} kept but its call dropped`)
})

test("one oversized turn is shrunk in place, keeping its calls", () => {
  const messages = [
    { role: "user", content: "read the big file" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_big", type: "function", function: { name: "read_file", arguments: '{"p":"a"}' } }],
    },
    { role: "tool", tool_call_id: "call_big", content: "z".repeat(900_000) },
  ]
  assert.ok(bytes(messages) > 800_000)
  const out = fitMessages(messages, 200_000)
  assert.ok(bytes(out) <= 220_000, `still too big: ${bytes(out)}`)
  const call = out.find((m) => m.tool_calls)
  assert.ok(call, "the call was dropped")
  assert.equal(call.tool_calls[0].id, "call_big")
  const result = out.find((m) => m.role === "tool")
  assert.ok(result, "the result was dropped")
  assert.equal(result.tool_call_id, "call_big")
  assert.match(result.content, /characters omitted/, "the result should say it was cut")
})

test("prepareAgent trims instead of refusing an oversized request", () => {
  const huge = "z".repeat(3_000_000)
  const body = {
    model: "kuku2/test",
    messages: [
      { role: "user", content: "the task" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"cmd":"cat"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: huge },
      { role: "user", content: "now answer" },
    ],
    tools: [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: {} } } }],
  }
  let agent
  assert.doesNotThrow(() => {
    agent = prepareAgent(body)
  }, "an oversized request must be cut, not refused")
  assert.equal(agent.trimmed, true)
  const rendered = renderAgent(agent, "external_agent", agent.tools)
  assert.ok(Buffer.byteLength(rendered) <= 2 * 1024 * 1024, `still over the limit: ${Buffer.byteLength(rendered)}`)
  assert.match(rendered, /Earlier turns were dropped/, "the model should be told the transcript was cut")
})

test("a request that fits is not marked as trimmed", () => {
  const body = {
    model: "kuku2/test",
    messages: [{ role: "user", content: "small" }],
    tools: [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: {} } } }],
  }
  const agent = prepareAgent(body)
  assert.equal(agent.trimmed, undefined)
  const rendered = renderAgent(agent, "external_agent", agent.tools)
  assert.ok(!rendered.includes("Earlier turns were dropped"))
})
