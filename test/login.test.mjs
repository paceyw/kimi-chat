import { test } from "node:test"
import assert from "node:assert/strict"
import { buildCredentials, decodeJwtPayload, parseLoginInput, tokenKind, userIdFromToken } from "../src/login.mjs"

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
const jwt = (payload) => [b64({ alg: "HS512", typ: "JWT" }), b64(payload), "sig"].join(".")

const ACCESS = jwt({ typ: "access", sub: "user-1", abstract_user_id: "user-1" })
const REFRESH = jwt({ typ: "refresh", sub: "user-1", abstract_user_id: "user-1" })

test("decodeJwtPayload / tokenKind / userIdFromToken", () => {
  assert.equal(decodeJwtPayload(ACCESS).sub, "user-1")
  assert.equal(tokenKind(ACCESS), "access")
  assert.equal(tokenKind(REFRESH), "refresh")
  assert.equal(userIdFromToken(REFRESH), "user-1")
  // 非 JWT / 坏 JWT 不抛，返回空
  assert.equal(decodeJwtPayload("abc"), null)
  assert.equal(userIdFromToken("abc"), "")
  assert.equal(tokenKind("abc"), "")
  assert.equal(decodeJwtPayload("a.b.c"), null)
})

test("parseLoginInput: bare refresh token, quotes, name= prefix", () => {
  let r = parseLoginInput(REFRESH)
  assert.equal(r.refreshToken, REFRESH)
  assert.equal(r.userId, "user-1")
  assert.equal(r.source, "refresh-jwt")
  // 从 DevTools 复制会带引号；localStorage 复制常带 name=
  assert.equal(parseLoginInput(`"${REFRESH}"`).refreshToken, REFRESH)
  assert.equal(parseLoginInput(`refresh_token=${REFRESH}`).refreshToken, REFRESH)
  assert.equal(parseLoginInput(`  refresh_token: ${REFRESH}  `).refreshToken, REFRESH)
  assert.equal(parseLoginInput("`" + REFRESH + "`").refreshToken, REFRESH)
})

test("parseLoginInput: JSON shapes", () => {
  const r = parseLoginInput(JSON.stringify({ refreshToken: REFRESH, accessToken: ACCESS }))
  assert.equal(r.refreshToken, REFRESH)
  assert.equal(r.accessToken, ACCESS)
  assert.equal(r.userId, "user-1")
  assert.equal(r.source, "json")
  // snake_case（早期导出的形状）
  const s = parseLoginInput(JSON.stringify({ refresh_token: REFRESH }))
  assert.equal(s.refreshToken, REFRESH)
  // 只有 accessToken 也接受，交给上层判断缺 refresh
  const a = parseLoginInput(JSON.stringify({ access_token: ACCESS }))
  assert.equal(a.refreshToken, "")
  assert.equal(a.accessToken, ACCESS)
  assert.equal(a.userId, "user-1")
})

test("parseLoginInput: access token gets a pointed error", () => {
  assert.throws(() => parseLoginInput(ACCESS), /refresh_token/)
})

test("parseLoginInput: rejects empty and junk", () => {
  assert.throws(() => parseLoginInput(""), /refresh_token/)
  assert.throws(() => parseLoginInput("   "), /refresh_token/)
  assert.throws(() => parseLoginInput("not a token"), /does not look like a Kimi token/)
  assert.throws(() => parseLoginInput("{oops"), /does not parse/)
  assert.throws(() => parseLoginInput("{}"), /No refreshToken\/accessToken/)
})

test("parseLoginInput: opaque refresh token is accepted (verified later by RefreshToken)", () => {
  const r = parseLoginInput("abcdefghijklmnop")
  assert.equal(r.refreshToken, "abcdefghijklmnop")
  assert.equal(r.source, "opaque")
})

test("buildCredentials: fills device ids, userId from token, keeps shield null", () => {
  const c = buildCredentials({ accessToken: ACCESS, refreshToken: REFRESH }, { webId: "w1", ssid: "s1" })
  assert.deepEqual(c, {
    accessToken: ACCESS, refreshToken: REFRESH, userId: "user-1",
    webId: "w1", ssid: "s1", shieldData: null, timezone: "Asia/Shanghai",
  })
  // 显式 userId 优先；缺设备 id 时保持空串（由调用方决定是否生成）
  const c2 = buildCredentials({ accessToken: ACCESS, refreshToken: REFRESH, userId: "explicit" })
  assert.equal(c2.userId, "explicit")
  assert.equal(c2.webId, "")
})
