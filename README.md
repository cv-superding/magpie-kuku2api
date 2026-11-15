# magpie-kuku2api

Magpie provider plugin for Baidu Kuku (库库) that speaks the **native desktop MCP channel**, so
agent clients can actually execute tools instead of answering once and stopping.

## The problem it fixes

The text-only Kuku plugin advertises models but cannot run tools. Agent clients (Qoder CN, DSH)
then behave like this: the model emits one line of prose, the client has nothing to call, and the
turn ends. Worse, the plugin's `config()` fallback left `tool_call` undefined while the hardcoded
catalog entry said `false`, and Magpie derives the runtime capability with `tool_call ?? true` —
an inconsistent pair no client can act on.

Three things change here:

1. every model declares `tool_call: true` **and** `capabilities.toolcall: true`, so no layer can
   disagree;
2. `chat/completions` accepts `tools` / `tool_choice` / tool messages instead of rejecting them;
3. tools run for real through an MCP connector on the desktop channel — the model's `tools/call`
   becomes an OpenAI `finish_reason: "tool_calls"`, and the caller's result is delivered back to
   the still-open upstream turn.

## How the round-trip works

```
caller ──POST /v1/chat/completions (tools)──▶ plugin
                                              ├── open sandbox SSE  (JSON-RPC tool tasks)
                                              ├── open base SSE     (conversation events)
                                              └── open conversation SSE (reply frames)
                        ◀── finish_reason: tool_calls ──┘
caller executes tools
caller ──POST /v1/chat/completions (tool results)──▶ plugin ──▶ MCP callback ──▶ same reply
                        ◀── final answer ──┘
```

The second request is matched back to the first by the reserved `call_kuku_mcp_*` ids in the
transcript tail. The bridge then delivers the results on the original MCP callbacks, so the
upstream keeps generating in the **same** turn instead of replaying history.

### Two details that are easy to get wrong

- **The MCP control streams outlive a turn.** The upstream considers the client online only while
  they are connected. Tearing them down at the end of the first half made the model answer
  "your desktop client is offline" instead of reading the result. A handoff therefore parks them
  on the bridge, and the resumed turn (or the idle sweep / deadline) releases them.
- **A carried listener must not close over a finished turn.** The parked sandbox stream keeps the
  listeners that were installed by the previous turn, so they publish into the current turn
  through `bridge.turnState` rather than the locals of the turn that created them. The same
  applies to the transport signal: callbacks resolve it lazily, because the signal of the turn
  that issued the tool call is already aborted by the time the result is delivered.

## Install

From npm:

```bash
npm install -g magpie-kuku2api
```

Or add the package to `~/.config/magpie/plugins.json`:

```json
{ "spec": "magpie-kuku2api@latest" }
```

For local development, point the spec at the checkout instead:

```json
{ "spec": "F:/Code/CodeBuddy-Project/magpie-kuku-agent" }
```

Then restart Magpie. The provider appears as `kuku2`.

### Auth

The first method reuses an existing login from the original `magpie-kuku` plugin — no second
scan. The native channel needs **both** `BDUSS` and `STOKEN`; `BDUSS` alone is enough for web
chat but not for tools. The second method accepts a pasted cookie string or the editor's JSON.

## Layout

| File | Role |
| --- | --- |
| `index.mjs` | Plugin contract: `config` / `provider.models` / `auth.loader` / `auth.usage` |
| `lib/protocol.mjs` | genflowpro desktop transport (sendmsg, SSE, MCP callback, close) |
| `lib/tools.mjs` | OpenAI ⇄ MCP conversion, schema checks, tool fingerprints |
| `lib/native.mjs` | Three-stream MCP orchestration and the handoff / resume state machine |
| `lib/chat.mjs` | OpenAI facade, bridge registry, text and tool paths |
| `lib/auth.mjs` | Session adoption and cookie parsing |

## Verify

Offline contract tests (mock upstream, no account needed):

```bash
node --test test/plugin.test.mjs
```

Live checks against the real account (needs a stored Kuku session):

```bash
node test/live/provider.mjs      # contract + capability declarations
node test/live/single-turn.mjs   # one tool round-trip
node test/live/multi-turn.mjs    # consecutive tool rounds
node test/live/stream.mjs        # the SSE shape agent clients use
```
