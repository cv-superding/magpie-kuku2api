# magpie-kuku2api

Magpie provider plugin for Baidu Kuku (库库) that speaks the **native desktop MCP channel**, so
agent clients can actually execute tools instead of answering once and stopping.

## How this differs from `magpie-kuku-auth`

The market already lists `magpie-kuku-auth` for the same Kuku channel. This package is a separate
entry, not a replacement, and the difference is narrow and concrete:

| | `magpie-kuku-auth` | this package |
| --- | --- | --- |
| Talks to | the web chat endpoint (`/v1/chat/completions` rewritten) | the **desktop client channel** (`genflowpro`: `sendmsg` + three SSE streams + MCP callback) |
| Client tools | refused — the chat module throws `400 库库插件目前支持文本对话，尚不支持原生工具调用` | accepted: `tools`, `tool_choice` and tool messages are honoured |
| `tool_call` in the catalog | hardcoded `false` | `true`, matching `capabilities.toolcall` |
| Effect in an agent client | one line of prose, then the turn ends (nothing to call) | `finish_reason: "tool_calls"`, the client runs the tool, the result resumes the same upstream turn |
| Sign-in | its own OAuth flow | its own flow **and** adopts an existing Kuku session, so no second scan |

If you only need text chat, the existing plugin is the simpler choice. If your client has to call
tools, that plugin cannot do it at all, because the capability is absent upstream of the chat
endpoint — this one drives the desktop channel where MCP actually exists.

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

## The account card

Two things sit on the provider's card besides the sign-in state.

**Points left.** `usage()` reads `/bizapi/gfpro/getgfvipremain` with the same credential the turns
spend, so the number shown and the number charged are the same account. A missing balance is
reported as an error rather than drawn as `0 积分` — a zero balance and an unreadable one mean
opposite things to someone deciding whether to keep working.

**The daily sign-in.** `checkin()` presses the activity page's own button.

Kuku's token endpoint answers `jsToken: null` on this account, so the pure-HTTP path its own web
app uses does not complete, and the sign-in falls back to a real browser on the activity page:
headless Chrome or Edge, the account's cookie, and a click on `button.pc-sign-btn`. Nothing
synthesises a risk-control proof or solves a captcha. A block comes back as `captcha` with the
site's own message, so the user knows to clear it on the site.

The browser profile is derived from the account id and kept under
`%LOCALAPPDATA%\Magpie\kuku-profiles`. A fresh profile per run would read as a new device every
day, which is the pattern the risk control looks for; one account keeps one identity. Override the
location with `MAGPIE_KUKU_PROFILE_ROOT`.

### When the sign-in is refused with 8001

`8001 账号存在风险，请切换账号或设备参加活动` is the **account's** state, not this plugin's
request. Measured on one blocked account, every route answers the same:

| Route | Result |
|---|---|
| plain HTTP `POST /act/v2/kukuai30/signin` | `8001` |
| same, with `gfprotpl=genflow` / no `gfprotpl` / `gfprotpl=genflowpro` | `8001` each |
| headless Chrome, stealth script, warm-up navigation | `8001` |
| headful Chrome — a visible window on a real profile | `8001` |

Another project's script author reached the same wall and wrote it down: the activity endpoint
needs a page-side anti-bot parameter, plain HTTP requests are answered with "账号异常", and the
only thing that works is pressing the page's own button. That is what this does — and when the
account is already flagged, even that is refused.

What is left is the one step no code can do for the account: clear the check once at
`https://kuku.baidu.com/operation/activitys/kukuPcSignAct/main`, which is the link the plugin
reports. Runs after that sign in normally, unattended.

Everything that can be made to look ordinary already is, and it costs nothing:

- `--disable-blink-features=AutomationControlled`, plus a script that runs before page scripts to
  clear `navigator.webdriver` and fill in the plugin and language lists
- one ordinary page navigation before the activity page, rather than landing on the campaign
- a persistent per-account profile instead of a new device each run
- `KUKU_CHECKIN_HEADFUL=1` opens a real window, which is what a person's browser looks like

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

### Three details that are easy to get wrong

- **The MCP control streams outlive a turn.** The upstream considers the client online only while
  they are connected. Tearing them down at the end of the first half made the model answer
  "your desktop client is offline" instead of reading the result. A handoff therefore parks them
  on the bridge, and the resumed turn (or the idle sweep / deadline) releases them.
- **A carried listener must not close over a finished turn.** The parked sandbox stream keeps the
  listeners that were installed by the previous turn, so they publish into the current turn
  through `bridge.turnState` rather than the locals of the turn that created them. The same
  applies to the transport signal: callbacks resolve it lazily, because the signal of the turn
  that issued the tool call is already aborted by the time the result is delivered.
- **A long conversation has to be cut, not refused.** The upstream reads the caller's transcript
  as one JSON blob inside a prompt and refuses anything past ~2 MiB. Raising that as an error was
  wrong twice over: the caller does not own the conversation it is being asked to compress, and
  by the time the error arrives the turn is already lost. `fitMessages` now drops the oldest
  turns instead, keeping the opening task and the turn being answered, and clips oversized tool
  results in place. A call is never separated from its result — a `tool_calls` entry with no
  matching `tool` message is what breaks the next request. A real 4.30 MiB transcript that used
  to fail now answers in 11 seconds.

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
| `index.mjs` | Plugin contract: `config` / `provider.models` / `auth.loader` / `auth.usage` / `auth.checkin` |
| `lib/protocol.mjs` | genflowpro desktop transport (sendmsg, SSE, MCP callback, close) and the points balance |
| `lib/tools.mjs` | OpenAI ⇄ MCP conversion, schema checks, tool fingerprints, transcript fitting |
| `lib/native.mjs` | Three-stream MCP orchestration and the handoff / resume state machine |
| `lib/chat.mjs` | OpenAI facade, bridge registry, text and tool paths |
| `lib/auth.mjs` | Session adoption and cookie parsing |
| `lib/checkin/web-client.mjs` | The activity endpoint client (browser UA, activity Referer) |
| `lib/checkin/checkin.mjs` | The daily sign-in, including the legacy login-reward fallback |
| `lib/checkin/website.mjs` | Presses the activity page's own sign-in button over CDP |
| `lib/checkin/browser.mjs` / `profiles.mjs` | Headless browser launch and the per-account profile |

## Verify

Offline contract tests (mock upstream, no account needed):

```bash
node --test "test/*.test.mjs"
```

Live checks against the real account (needs a stored Kuku session):

```bash
node test/live/provider.mjs      # contract + capability declarations
node test/live/single-turn.mjs   # one tool round-trip
node test/live/multi-turn.mjs    # consecutive tool rounds
node test/live/stream.mjs        # the SSE shape agent clients use
node test/live/oversized.mjs     # a 4 MiB transcript is cut down, not refused
node test/live/usage.mjs         # the points balance the account card draws
node test/live/checkin.mjs       # the daily sign-in (really presses the button)
```
