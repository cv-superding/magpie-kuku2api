// Live check: the daily sign-in, as Magpie runs it.
//
// This really presses the activity page's button once. A risk-control block is a
// valid outcome here — the account was blocked earlier today — and what matters is
// that the run reports it instead of claiming a credit.
import { loadHook, report, finish } from "./_shared.mjs"

const { plugin, auth } = await loadHook()

const started = Date.now()
const result = await plugin.auth.checkin(async () => auth)
console.log(`took ${((Date.now() - started) / 1000).toFixed(1)}s`)
console.log("result:", JSON.stringify(result, null, 1))

const outcome = result?.outcome
report(
  "the sign-in returns one of the outcomes Magpie knows",
  ["claimed", "done", "inactive", "captcha", "failed"].includes(outcome),
  String(outcome),
)
// A failure must carry a reason; a success must carry the day it applies to.
if (outcome === "claimed" || outcome === "done") {
  report("a completed sign-in names its day", Boolean(result.until), String(result.until))
} else {
  report("a failure explains itself", Boolean(result.message), String(result.message ?? "").slice(0, 160))
}

finish()
