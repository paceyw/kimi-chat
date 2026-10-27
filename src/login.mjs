// 网页登录（browser sign-in）的输入解析：用户在 kimi.com 网页里登录完成后，
// 只需要把浏览器里存的 refresh_token 回传给插件；插件自己换 access token、补设备指纹。
//
// 实测依据（PROTOCOL.md §6.2，2026-10-27 真机活体）：
//   - 只有 refresh_token（无 userId/webId/ssid）也能换出可用凭据并完成对话；
//     X-Traffic-Id 不是必需头，webId/ssid 可以现生成。
//   - access / refresh 都是 JWT，payload 里 `typ` 区分（"access" / "refresh"），
//     `sub`（= abstract_user_id）就是 userId —— 所以账号归属不需要用户手填。
//
// 解析器容忍用户的各种粘贴形状：裸 token、带引号、`refresh_token=...`、
// localStorage 的 JSON、DevTools 导出的整段对象。

const JWT_RE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/

/** 解 JWT payload（只读，不验签）。失败返回 null。 */
const b64decode = (s) => {
  // Bun/Node 有 Buffer；少数宿主只有 atob —— 两条都支持，别让解 payload 依赖运行时。
  if (typeof Buffer !== "undefined") return Buffer.from(s, "base64").toString("utf8")
  return decodeURIComponent(escape(atob(s)))
}

export function decodeJwtPayload(token) {
  const parts = String(token ?? "").trim().split(".")
  if (parts.length !== 3) return null
  try {
    const json = b64decode(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
    const payload = JSON.parse(json)
    return payload && typeof payload === "object" ? payload : null
  } catch {
    return null
  }
}

/** 从任何 Kimi 令牌里取 userId（JWT 的 sub / abstract_user_id）。取不到返回 ""。 */
export function userIdFromToken(token) {
  const p = decodeJwtPayload(token)
  if (!p) return ""
  for (const key of ["sub", "abstract_user_id", "user_id", "userId"]) {
    const v = p[key]
    if (typeof v === "string" && v) return v
  }
  return ""
}

/** JWT 类型：'access' | 'refresh' | ''（非 JWT 或没有 typ 声明）。 */
export function tokenKind(token) {
  const p = decodeJwtPayload(token)
  const typ = p?.typ
  return typeof typ === "string" ? typ : ""
}

const strip = (v) =>
  String(v ?? "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim()

/**
 * 把一个以 `name=value` / `name: value` 开头的粘贴串剥成值。
 * 覆盖 `refresh_token=xxx`、`refresh_token: xxx`、`"refresh_token": "xxx"`。
 */
function unwrapNamed(raw) {
  const m = /^(?:refresh[_-]?token|token|value)\s*[:=]\s*(.+)$/i.exec(raw)
  return m ? strip(m[1]) : raw
}

/** 从 JSON 对象里按大小写/下划线变体取第一个非空字符串。 */
function pick(obj, keys) {
  for (const key of keys) {
    const v = obj?.[key]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return ""
}

/**
 * 解析用户回传的登录输入。
 * @returns {{ refreshToken: string, accessToken: string, userId: string, source: string }}
 *   source: 'json' | 'refresh-jwt' | 'access-jwt' | 'opaque'
 * @throws {Error} 输入为空 / 明显不是令牌
 */
export function parseLoginInput(input) {
  const raw = strip(input)
  if (!raw) throw new Error("Paste the refresh_token value from the Kimi website")
  // 1) JSON（DevTools 导出 / 我们自己的凭据 JSON）
  if (raw.startsWith("{")) {
    let o
    try { o = JSON.parse(raw) } catch { throw new Error("That looks like JSON but does not parse; copy just the refresh_token value") }
    const refreshToken = pick(o, ["refreshToken", "refresh_token", "refresh"])
    const accessToken = pick(o, ["accessToken", "access_token", "access"])
    if (!refreshToken && !accessToken) throw new Error("No refreshToken/accessToken field found in that JSON")
    return { refreshToken, accessToken, userId: userIdFromToken(refreshToken) || userIdFromToken(accessToken), source: "json" }
  }
  // 2) 单个令牌
  const token = unwrapNamed(raw)
  if (JWT_RE.test(token)) {
    const kind = tokenKind(token)
    if (kind === "access") {
      throw new Error("That is the access_token, which expires in minutes. Copy refresh_token instead (DevTools → Application → Local Storage → refresh_token)")
    }
    return { refreshToken: token, accessToken: "", userId: userIdFromToken(token), source: kind === "refresh" ? "refresh-jwt" : "json" }
  }
  // 3) 不透明令牌（非 JWT）：当作 refresh token，由调用方用 RefreshToken RPC 验真
  if (/^[A-Za-z0-9._~+/=-]{16,}$/.test(token)) {
    return { refreshToken: token, accessToken: "", userId: "", source: "opaque" }
  }
  throw new Error("That does not look like a Kimi token; copy the value of refresh_token from the Kimi website")
}

/**
 * 拼装插件内部的凭据 JSON（parseCredentials 的形状）。
 * access/refresh 用刷新后的最新值；userId 优先取新 access token 的 sub；
 * webId/ssid 没有就现生成（两者只是设备指纹，实测不影响登录）。
 */
export function buildCredentials({ accessToken, refreshToken, userId, webId, ssid, timezone } = {}, device = {}) {
  const access = String(accessToken ?? "")
  const refresh = String(refreshToken ?? "")
  return {
    accessToken: access,
    refreshToken: refresh,
    userId: String(userId ?? "") || userIdFromToken(access) || userIdFromToken(refresh),
    webId: String(webId ?? "") || device.webId || "",
    ssid: String(ssid ?? "") || device.ssid || "",
    shieldData: null,
    timezone: String(timezone ?? "") || "Asia/Shanghai",
  }
}
