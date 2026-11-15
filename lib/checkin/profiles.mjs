// SPDX-License-Identifier: AGPL-3.0-only
// A real browser profile for each sign-in: keep the site's own device/storage
// identity rather than presenting a newly-created device at every daily check-in.
import { mkdir, mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises"
import { join, resolve, dirname, basename } from "node:path"
import { homedir, platform } from "node:os"

export function profilesRoot() {
  const custom = process.env.MAGPIE_KUKU_PROFILE_ROOT
  if (custom) return resolve(custom)
  if (platform() === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Magpie", "kuku-profiles")
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "magpie-kuku", "profiles")
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "magpie-kuku", "profiles")
}
export function profilePath(id, root = profilesRoot()) {
  if (typeof id !== "string" || !/^kuku-[A-Za-z0-9]{6,}$/.test(id)) throw new Error("库库浏览器环境标识无效，请重新登录")
  const path = resolve(root, id)
  if (dirname(path) !== resolve(root)) throw new Error("拒绝访问非库库浏览器环境")
  return path
}
export async function createProfile(root = profilesRoot()) {
  await mkdir(root, { recursive: true })
  const path = await mkdtemp(join(root, "kuku-"))
  return { id: basename(path), path }
}
export async function bindProfile(id, uid, root = profilesRoot()) {
  if (typeof uid !== "string" || !uid) throw new Error("缺少库库账号标识，无法保存浏览器环境")
  const path = profilePath(id, root)
  await writeFile(join(path, ".magpie-kuku-profile.json"), JSON.stringify({ provider: "kuku", uid, version: 1 }), { mode: 0o600 })
}
export async function ownedProfile(id, uid, root = profilesRoot()) {
  const path = profilePath(id, root)
  let marker
  try {
    if (!(await stat(path)).isDirectory()) throw new Error()
    marker = JSON.parse(await readFile(join(path, ".magpie-kuku-profile.json"), "utf8"))
  } catch { throw new Error("库库专用浏览器环境不存在，请重新网页登录一次") }
  if (marker.provider !== "kuku" || !uid || marker.uid !== String(uid)) throw new Error("库库浏览器环境与当前账号不一致，已停止签到")
  return path
}
export async function discardProfile(id, root = profilesRoot()) {
  const path = profilePath(id, root)
  await rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}
const active = new Set()
export function lockProfile(id) {
  if (active.has(id)) throw new Error("这个库库账号的浏览器正在使用，请稍后重试")
  active.add(id)
  return () => active.delete(id)
}
