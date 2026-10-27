// kimi-connect 错误路径测试：真实探测响应格式的解析（PROTOCOL.md §8 样本）
import { test } from "node:test";
import assert from "node:assert/strict";

// 直接测 refreshToken 的 401 解析：mock fetch
test("refreshToken 成功 → 解析 access/refresh token 对", async () => {
  const { refreshToken } = await import("../src/kimi-connect.mjs");
  const origFetch = globalThis.fetch;
  let seenBody = null;
  globalThis.fetch = async (_url, init) => {
    seenBody = new Uint8Array(await new Request("http://x", { method: "POST", body: init.body }).arrayBuffer());
    // 响应：field1="new-access", field2="new-refresh"
    const enc = new TextEncoder();
    const a = enc.encode("new-access"), r = enc.encode("new-refresh");
    const body = new Uint8Array([0x0a, a.length, ...a, 0x12, r.length, ...r]);
    return new Response(body, { status: 200, headers: { "content-type": "application/proto" } });
  };
  try {
    const out = await refreshToken({ refreshToken: "probe-refresh-token" });
    assert.equal(out.accessToken, "new-access");
    assert.equal(out.refreshToken, "new-refresh");
    // 请求体应是 field1 string 的合法 protobuf
    assert.equal(seenBody[0], 0x0a);
    assert.equal(new TextDecoder().decode(seenBody.subarray(2)), "probe-refresh-token");
  } finally { globalThis.fetch = origFetch; }
});

test("refreshToken 长 token → 长度前缀是多字节 varint（回归：曾被截断成 1 字节）", async () => {
  const { refreshToken } = await import("../src/kimi-connect.mjs");
  const { fields, pickStr } = await import("../src/kimi-proto.mjs");
  const origFetch = globalThis.fetch;
  const longToken = "r".repeat(300); // > 127，单字节长度会溢出
  let seen = null;
  globalThis.fetch = async (_url, init) => {
    seen = new Uint8Array(await new Request("http://x", { method: "POST", body: init.body }).arrayBuffer());
    const enc = new TextEncoder();
    const a = enc.encode("new-access"), r = enc.encode("new-refresh");
    const body = new Uint8Array([0x0a, a.length, ...a, 0x12, r.length, ...r]);
    return new Response(body, { status: 200, headers: { "content-type": "application/proto" } });
  };
  try {
    await refreshToken({ refreshToken: longToken });
    // 服务端视角：按 protobuf 解开必须还原出完整 token
    assert.equal(pickStr(fields(seen), 1), longToken);
    // 字节级：tag 后第一个长度字节应有 continuation 位
    assert.equal(seen[0], 0x0a);
    assert.ok((seen[1] & 0x80) === 0x80, "length prefix must be multi-byte varint");
  } finally { globalThis.fetch = origFetch; }
});

test("refreshToken 401 → unauthorized + 可操作提示", async () => {
  const { refreshToken } = await import("../src/kimi-connect.mjs");
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ code: "unauthenticated", debug: { reason: "REASON_INVALID_AUTH_TOKEN", localizedMessage: { locale: "en-US", message: "Session expired. Please log in again." } } }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
  try {
    await refreshToken({ refreshToken: "probe-invalid-token" });
    assert.fail("should throw");
  } catch (e) {
    assert.equal(e.kind, "unauthorized");
    assert.match(e.message, /session expired|log in again|plugin login/i);
  } finally { globalThis.fetch = origFetch; }
});

test("getAvailableModels 解析 models/default_chat_model（wire 级）", async () => {
  const { getAvailableModels } = await import("../src/kimi-connect.mjs");
  const origFetch = globalThis.fetch;
  const enc = new TextEncoder();
  // 构造：available_models[0]{scenario=K2D5(9) varint, model_id="k2d5"} + default_chat_model="k2d5-real"
  const modelId = enc.encode("k2d5");
  // field19 wire2 tag = varint(19<<3|2=154) = 0x9a 0x01
  const model = [0x08, 0x09, 0x9a, 0x01, modelId.length, ...modelId];
  const dcm = enc.encode("k2d5-real");
  const body = new Uint8Array([
    0x0a, model.length, ...model,
    0x22, dcm.length, ...dcm, // field4 default_chat_model
  ]);
  globalThis.fetch = async () => new Response(body, { status: 200, headers: { "content-type": "application/proto" } });
  try {
    const out = await getAvailableModels({ accessToken: "t" });
    assert.equal(out.models.length, 1);
    assert.equal(out.models[0].modelId, "k2d5");
    assert.equal(out.models[0].scenario, 9);
    assert.equal(out.defaultChatModel, "k2d5-real");
  } finally { globalThis.fetch = origFetch; }
});

test("chatStream 401（无 refresh token）→ unauthorized + 上游 message", async () => {
  const { chatStream } = await import("../src/kimi-connect.mjs");
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ code: "unauthenticated", message: "invalid user token: token is malformed: token contains an invalid number of segments", details: [{}] }),
    { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } },
  );
  try {
    const it = chatStream({ accessToken: "probe-invalid-token" }, { scenario: 1, prompt: "x" });
    await it.next();
    assert.fail("should throw");
  } catch (e) {
    assert.equal(e.kind, "unauthorized");
    assert.match(e.message, /invalid user token|malformed|plugin login/i);
  } finally { globalThis.fetch = origFetch; }
});

test("chatStream idle timeout → kind=timeout，挂起的上游流被切断", async () => {
  const { chatStream } = await import("../src/kimi-connect.mjs");
  const origFetch = globalThis.fetch;
  // body 永不产出新字节：模拟网络挂起
  const hanging = new ReadableStream({ start() {} });
  globalThis.fetch = async () => new Response(hanging, { status: 200, headers: { "content-type": "application/connect+proto" } });
  try {
    const it = chatStream({ accessToken: "t" }, { scenario: 1, prompt: "x" }, { idleTimeoutMs: 40 });
    await assert.rejects(
      () => it.next(),
      (e) => e.kind === "timeout" || /idle/i.test(e.message),
    );
  } finally { globalThis.fetch = origFetch; }
});

// ---------- QR 登录 wire 测试（实测协议样本：CreateLoginQRCode→field1 UUID；Status→08 01 PENDING） ----------

test("createLoginQRCode → 解析 field1 code（空请求体）", async () => {
  const { createLoginQRCode } = await import("../src/kimi-connect.mjs");
  const origFetch = globalThis.fetch;
  let seenUrl = null, seenBody = null;
  globalThis.fetch = async (url, init) => {
    seenUrl = String(url);
    seenBody = init.body;
    const enc = new TextEncoder();
    const code = enc.encode("8f3c2e1a-9b4d-4c6e-b7f8-112233445566");
    return new Response(new Uint8Array([0x0a, code.length, ...code]), { status: 200, headers: { "content-type": "application/proto" } });
  };
  try {
    const code = await createLoginQRCode();
    assert.equal(code, "8f3c2e1a-9b4d-4c6e-b7f8-112233445566");
    assert.match(seenUrl, /CreateLoginQRCode$/);
    // 空消息请求体：空 Uint8Array
    assert.ok(seenBody instanceof Uint8Array && seenBody.length === 0);
  } finally { globalThis.fetch = origFetch; }
});

test("getLoginQRCodeStatus → 解析 status varint + SUCCESS 时 token 对（wire 级）", async () => {
  const { getLoginQRCodeStatus } = await import("../src/kimi-connect.mjs");
  const origFetch = globalThis.fetch;
  let seenBody = null;
  const enc = new TextEncoder();
  const at = enc.encode("qr-access-token"), rt = enc.encode("qr-refresh-token"), uid = enc.encode("user-42");
  // status=SUCCESS(4) varint | access_token=2 | refresh_token=3 | user_id=4
  const body = new Uint8Array([
    0x08, 0x04,
    0x12, at.length, ...at,
    0x1a, rt.length, ...rt,
    0x22, uid.length, ...uid,
  ]);
  globalThis.fetch = async (_url, init) => {
    seenBody = new Uint8Array(await new Request("http://x", { method: "POST", body: init.body }).arrayBuffer());
    return new Response(body, { status: 200, headers: { "content-type": "application/proto" } });
  };
  try {
    const st = await getLoginQRCodeStatus("probe-qr-code");
    assert.equal(st.status, 4);
    assert.equal(st.accessToken, "qr-access-token");
    assert.equal(st.refreshToken, "qr-refresh-token");
    assert.equal(st.userId, "user-42");
    // 请求体：field1 str code
    assert.equal(seenBody[0], 0x0a);
    assert.equal(new TextDecoder().decode(seenBody.subarray(2)), "probe-qr-code");
  } finally { globalThis.fetch = origFetch; }
});

test("getLoginQRCodeStatus → PENDING 实测样本 08 01", async () => {
  const { getLoginQRCodeStatus } = await import("../src/kimi-connect.mjs");
  const origFetch = globalThis.fetch;
  // 2026-10-26 实测：真实端点对任意 code 返回 08 01（status=PENDING）
  globalThis.fetch = async () => new Response(new Uint8Array([0x08, 0x01]), { status: 200, headers: { "content-type": "application/proto" } });
  try {
    const st = await getLoginQRCodeStatus("anything");
    assert.equal(st.status, 1);
    assert.equal(st.accessToken, "");
  } finally { globalThis.fetch = origFetch; }
});
