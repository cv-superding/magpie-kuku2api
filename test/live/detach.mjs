// Check: checkin returns at once and leaves the window running.
//
// The window has to outlive the request that asked for it — a caller's patience
// is not how long a person takes to clear a check. This asserts the answer comes
// back immediately while the browser is still on screen.
import { loadHook, report, finish } from "./_shared.mjs"

const { plugin, auth } = await loadHook()

const started = Date.now()
const result = await plugin.auth.checkin(async () => auth)
const took = Date.now() - started

console.log(`returned in ${took}ms`)
console.log("result:", JSON.stringify(result))

// Anything above a few seconds means the caller is again waiting for the browser.
report("the caller is answered at once", took < 5000, `${took}ms`)
report("the answer tells the user what to do", Boolean(result?.message), result?.message)

// Give the window a moment, then confirm a Chrome is actually up on our profile.
await new Promise((r) => setTimeout(r, 4000))
const { execFile } = await import("node:child_process")
const list = await new Promise((resolve) => {
  execFile("tasklist", ["/FI", "IMAGENAME eq chrome.exe", "/FO", "CSV", "/NH"], (e, out) => resolve(e ? "" : out))
})
const running = /chrome\.exe/i.test(list)
report("a browser window is running after the request returned", running)

// Deliberately not killing it: matching on the image name would close the user's
// own windows too. The run closes its own browser when the budget expires.
if (running) console.log("\nleaving the window to close itself when the run ends")

finish()
