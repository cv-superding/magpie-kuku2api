// Live check: the Magpie plugin contract.
// The bug this plugin exists to fix was a capability declaration mismatch, so it is asserted
// directly: config() must seed a tool-capable fallback and every catalog model must say so.
import { loadHook, report, finish } from "./_shared.mjs"

const { plugin, auth } = await loadHook()

const cfg = { provider: {} }
await plugin.config(cfg)
report("config() seeds the kuku2 provider", Boolean(cfg.provider.kuku2))
report("fallback model advertises tool_call", cfg.provider.kuku2?.models?.auto?.tool_call === true)

const models = await plugin.provider.models({ id: "kuku2", models: {} }, { auth })
const ids = Object.keys(models)
const missing = ids.filter(id => models[id].capabilities?.toolcall !== true)
console.log(`\nmodels: ${ids.length}`)
report("every catalog model advertises toolcall", ids.length > 0 && missing.length === 0, missing.join(", "))

const target = models["gateway-deepseek-v4.1-flash-tencent"]
report("the routed model is present and tool-capable", Boolean(target) && target.capabilities.toolcall === true,
  target ? `${target.name} -> ${target.api.url}` : "missing")

const usage = await plugin.auth.usage(async () => auth)
report("auth.usage reports the account", !usage?.error, usage?.user ?? usage?.error)

finish()
