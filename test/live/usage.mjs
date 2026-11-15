// Live check: the account card's balance, as Magpie reads it.
import { loadHook, report, finish } from "./_shared.mjs"

const { plugin, auth } = await loadHook()

// usage() is what the account card draws; it must carry a number, not a
// capability count, and not a zero standing in for an unreadable balance.
const usage = await plugin.auth.usage(async () => auth)
console.log("usage:", JSON.stringify(usage, null, 1))

const window = usage?.windows?.[0]
report("usage reports a balance", Boolean(window?.display), window?.display ?? usage?.error)
report("the balance is not a stand-in zero", !/^0 积分$/.test(window?.display ?? ""), window?.display)
report("the account name comes back", Boolean(usage?.user), usage?.user)

finish()
