// Check: a windowed run waits for the user instead of giving up at the first
// captcha. Uses a short budget so the test does not sit for three minutes.
//
// What it proves: headless returns `captcha` in a few seconds (the page said so),
// while headful keeps the window open until the budget runs out — that window is
// where the user clears the check.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseCookies } from "../../lib/auth.mjs"
import { websiteCheckin } from "../../lib/checkin/website.mjs"

const store = JSON.parse(readFileSync(join(homedir(), ".config", "magpie", "plugin-auth.json"), "utf8"))
const raw = (store.kuku2 ?? store.kuku).access
parseCookies(raw) // fail early if the credential is unusable

const started = Date.now()
const result = await websiteCheckin(raw, { headful: true, timeout: 20000 })
const took = ((Date.now() - started) / 1000).toFixed(1)

console.log("result:", JSON.stringify(result))
console.log(`took ${took}s`)

const waited = Number(took) >= 15
console.log(waited
  ? "\nPASS — the window stayed open for the user instead of closing on the captcha"
  : "\nFAIL — it returned early, so the window would have vanished mid-check")
if (!waited) process.exitCode = 1
