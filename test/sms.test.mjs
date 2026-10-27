import test from "node:test"
import assert from "node:assert/strict"
import { parsePhoneNumber, loginWithSMS, sendVerifyCode } from "../src/kimi-connect.mjs"
import { fields, pickStr } from "../src/kimi-proto.mjs"

const dec = new TextDecoder()

test("parsePhoneNumber accepts the shapes people actually type", () => {
  assert.deepEqual(parsePhoneNumber("13800138000"), { countryCode: "86", number: "13800138000" })
  assert.deepEqual(parsePhoneNumber("86 13800138000"), { countryCode: "86", number: "13800138000" })
  assert.deepEqual(parsePhoneNumber("+86 13800138000"), { countryCode: "86", number: "13800138000" })
  assert.deepEqual(parsePhoneNumber("8613800138000"), { countryCode: "86", number: "13800138000" })
  assert.deepEqual(parsePhoneNumber("852 61234567"), { countryCode: "852", number: "61234567" })
  assert.throws(() => parsePhoneNumber("abc"), /只能是数字/)
})

test("loginWithSMS encodes PhoneNumber and the code, then parses both tokens", async () => {
  const orig = globalThis.fetch
  let seen = null
  try {
    globalThis.fetch = async (url, init) => {
      seen = { url: String(url), body: new Uint8Array(init.body) }
      // LoginWithSMSResponse: field1="at" field2="rt" field4="u9"
      return new Response(new Uint8Array([10, 2, 97, 116, 18, 2, 114, 116, 34, 2, 117, 57]), {
        status: 200, headers: { "content-type": "application/proto" },
      })
    }
    const r = await loginWithSMS({ countryCode: "86", number: "13800138000" }, " 123456 ")
    assert.match(seen.url, /\/api\/account\.gateway\.v1\.AuthService\/LoginWithSMS$/)
    const outer = fields(seen.body)
    const phoneField = outer.find(f => f.num === 1)
    assert.equal(phoneField.wt, 2)
    const inner = fields(phoneField.buf)
    assert.equal(pickStr(inner, 1), "86")
    assert.equal(pickStr(inner, 2), "13800138000")
    assert.equal(pickStr(outer, 2), "123456")
    assert.deepEqual(r, { accessToken: "at", refreshToken: "rt", userId: "u9", newUser: false })
  } finally { globalThis.fetch = orig }
})

test("loginWithSMS surfaces the upstream reason", async () => {
  const orig = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ code: "invalid_argument", message: "Invalid verification code" }),
      { status: 400, headers: { "content-type": "text/plain" } },
    )
    await assert.rejects(
      loginWithSMS({ countryCode: "86", number: "13800138000" }, "000000"),
      (e) => /Invalid verification code/.test(e.message) && e.kind === "upstream_error",
    )
  } finally { globalThis.fetch = orig }
})

test("sendVerifyCode reports the human-check wall instead of pretending success", async () => {
  const orig = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ code: "failed_precondition", message: "Captcha verification failed, please try again." }),
      { status: 400, headers: { "content-type": "text/plain" } },
    )
    const r = await sendVerifyCode({ countryCode: "86", number: "13800138000" })
    assert.equal(r.ok, false)
    assert.equal(r.captcha, true)
    globalThis.fetch = async () => new Response(new Uint8Array(0), { status: 200 })
    assert.equal((await sendVerifyCode({ countryCode: "86", number: "13800138000" })).ok, true)
  } finally { globalThis.fetch = orig }
})

test("the phone sign-in method walks phone → code and stores the session", async () => {
  const { server } = await import("../src/index.mjs")
  const app = await server()
  const method = app.auth.methods.find(m => /手机验证码/.test(m.label))
  assert.ok(method, "phone method exists")
  const orig = globalThis.fetch
  try {
    // 1) 发码被 captcha 挡住：instructions 必须告诉用户去官网自己发
    globalThis.fetch = async () => new Response(
      JSON.stringify({ code: "failed_precondition", message: "Captcha verification failed, please try again." }),
      { status: 400, headers: { "content-type": "text/plain" } },
    )
    const a = await method.authorize({ phone: "13800138000" })
    assert.equal(a.method, "code")
    assert.match(a.instructions, /kimi\.com/)
    assert.match(a.instructions, /\+86 13800138000/)
    // 2) 用户填验证码 → 换到 token
    globalThis.fetch = async () => new Response(
      new Uint8Array([10, 5, 97, 116, 45, 48, 48, 18, 5, 114, 116, 45, 48, 48, 34, 3, 117, 45, 49]),
      { status: 200, headers: { "content-type": "application/proto" } },
    )
    const r = await a.callback("123456")
    assert.equal(r.type, "success")
    assert.equal(r.access, "at-00")
    const stored = JSON.parse(r.refresh)
    assert.equal(stored.accessToken, "at-00")
    assert.equal(stored.refreshToken, "rt-00")
    assert.equal(stored.userId, "u-1")
    assert.match(stored.webId, /^[0-9a-f]{32}$/)
  } finally { globalThis.fetch = orig }
})
