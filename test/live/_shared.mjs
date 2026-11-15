// Shared setup for the live (real-account) checks in this directory.
//
// These scripts hit the real upstream, so they are not part of `node --test`; run one directly:
//   node test/live/single-turn.mjs
// They require a stored Kuku session in Magpie's plugin-auth.json.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

export const MODEL = "gateway-deepseek-v4.1-flash-tencent"
export const URL_CHAT = "http://kuku.local/v1/chat/completions"

function storePath() {
  const dir = process.env.MAGPIE_CONFIG_DIR ?? join(homedir(), ".config", "magpie")
  return join(dir, "plugin-auth.json")
}

export async function loadHook() {
  const shipped = (await import(pathToFileURL(join(ROOT, "index.mjs")).href)).default
  // The default export is { id, server } because Magpie reads `id` to resolve the provider.
  const plugin = await shipped.server()
  const store = JSON.parse(readFileSync(storePath(), "utf8"))
  const auth = store.kuku ?? store["kuku"]
  if (!auth?.access) throw new Error(`no kuku session in ${storePath()} — log into the Kuku plugin first`)
  return { plugin, auth, hook: await plugin.auth.loader(async () => auth) }
}

export const tool = (name, description, properties, required) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
})

export function report(label, ok, detail = "") {
  console.log(`\n[${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) process.exitCode = 1
  return ok
}

// A parked bridge keeps the MCP control streams (and their sockets) open on purpose, so a live
// script would otherwise never exit. Draining after a short settle period is enough: every
// request has already resolved by the time the script reports.
export function finish(code = process.exitCode ?? 0) {
  setTimeout(() => process.exit(code), 250)
}
