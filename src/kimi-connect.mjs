// kimi-connect.mjs — connect-rpc streaming 信封 + 认证头 + token 刷新 + Chat RPC 调用。
// 传输事实见 PROTOCOL.md §1-§4。
import {
  encodeChatRequest, decodeChatResponse, reasonToError, varint,
  strField, bytesField, concat, fields,
} from "./kimi-proto.mjs";

const GATEWAY = "https://www.kimi.com";
const AUTH_BASE = "https://auth.kimi.com";
const CHAT_RPC = "/apiv2/kimi.gateway.chat.v1.ChatService/Chat";
const AUTH_RPC_REFRESH = "/api/account.gateway.v1.AuthService/RefreshToken";
const AUTH_RPC_QR_CREATE = "/api/account.gateway.v1.AuthService/CreateLoginQRCode";
const AUTH_RPC_QR_STATUS = "/api/account.gateway.v1.AuthService/GetLoginQRCodeStatus";

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- connect 5 字节信封 ----------
export function envelope(payload, flags = 0) {
  const head = new Uint8Array(5);
  head[0] = flags;
  const dv = new DataView(head.buffer);
  dv.setUint32(1, payload.length, false);
  const out = new Uint8Array(5 + payload.length);
  out.set(head, 0);
  out.set(payload, 5);
  return out;
}

// 流式解帧：feed(bytes) → 产出 {flags, payload} | {end: json}
export function createFrameParser() {
  let buf = new Uint8Array(0);
  const frames = [];
  return {
    feed(chunk) {
      const nb = new Uint8Array(buf.length + chunk.length);
      nb.set(buf, 0);
      nb.set(chunk, buf.length);
      buf = nb;
      for (;;) {
        if (buf.length < 5) break;
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const flags = buf[0];
        const len = dv.getUint32(1, false);
        if (buf.length < 5 + len) break;
        const payload = buf.subarray(5, 5 + len);
        if (flags & 0x02) {
          let json = null;
          try { json = JSON.parse(dec.decode(payload)); } catch { /* 忽略坏尾帧 */ }
          frames.push({ end: json ?? {} });
        } else {
          frames.push({ flags, payload: payload.slice() });
        }
        buf = buf.subarray(5 + len);
      }
    },
    take() { return frames.shift() ?? null; },
  };
}

// ---------- 认证头 ----------
export function authHeaders(auth, { includeShield = true } = {}) {
  const h = {
    "Content-Type": "application/connect+proto",
    "Connect-Protocol-Version": "1",
    "R-Timezone": auth.timezone || "Asia/Shanghai",
  };
  if (auth.accessToken) h["Authorization"] = `Bearer ${auth.accessToken}`;
  if (auth.userId) h["X-Traffic-Id"] = auth.userId;
  if (auth.webId) h["x-msh-device-id"] = auth.webId;
  if (auth.ssid) h["x-msh-session-id"] = auth.ssid;
  // Ge 白名单外 version/platform 恒定
  h["x-msh-version"] = "2.3.0";
  h["x-msh-platform"] = "web";
  if (includeShield && auth.shieldData) h["x-msh-shield-data"] = auth.shieldData;
  return h;
}

// ---------- RefreshToken（connect unary, application/proto） ----------
// RefreshTokenRequest{refresh_token=1 str} → RefreshTokenResponse{access_token=1, refresh_token=2}
export async function refreshToken(auth, { signal } = {}) {
  // 注意：refresh token 长度远超 127 字节，长度前缀必须是多字节 varint——
  // 早期用单字节 payload[1] = body.length 会截断，服务端报
  // "cannot parse invalid wire-format data"。
  const payload = strField(1, String(auth?.refreshToken ?? ""));
  const res = await fetch(`${AUTH_BASE}${AUTH_RPC_REFRESH}`, {
    method: "POST",
    headers: { "Content-Type": "application/proto", "Connect-Protocol-Version": "1" },
    body: payload,
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // auth.kimi.com 401 响应是 connect JSON：{"code":"unauthenticated","debug":{"reason":"REASON_INVALID_AUTH_TOKEN","localizedMessage":{"message":"Session expired..."}}}
    let sessionExpired = res.status === 401;
    let hint = "";
    try {
      const j = JSON.parse(text);
      const reason = String(j?.debug?.reason ?? "");
      if (reason && !/EXPIRED|INVALID_AUTH/i.test(reason)) sessionExpired = false;
      hint = String(j?.debug?.localizedMessage?.message ?? j?.message ?? "");
    } catch { /* 非 JSON，维持 http 状态提示 */ }
    const message = sessionExpired
      ? `Kimi session expired${hint ? ` (${hint})` : ""} — re-run: magpie plugin login kimi-chat`
      : `refresh http ${res.status}${text ? ` ${text.slice(0, 160)}` : ""}`;
    throw Object.assign(new Error(message), { kind: res.status === 401 ? "unauthorized" : "upstream_error" });
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const out = {};
  // 简易解析两个 length-delim 字段
  let i = 0;
  while (i < buf.length) {
    const key = buf[i++];
    const num = key >> 3, wt = key & 7;
    if (wt !== 2) { i = skipNonLen(buf, i); continue; }
    let len = 0, sh = 0;
    for (;;) { const b = buf[i++]; len |= (b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
    const val = dec.decode(buf.subarray(i, i + len));
    if (num === 1) out.accessToken = val;
    if (num === 2) out.refreshToken = val;
    i += len;
  }
  if (!out.accessToken) throw Object.assign(new Error("refresh response missing access_token"), { kind: "unauthorized" });
  return out;
}

function skipNonLen(buf, i) {
  let sh = 0;
  for (;;) { const b = buf[i++]; if (!(b & 0x80)) break; sh += 7; }
  return i;
}

// ---------- QR 登录（connect unary，无需已有凭据） ----------
// CreateLoginQRCodeRequest{} → {code=1 str}
// GetLoginQRCodeStatusRequest{code=1 str} → {status=1 enum PENDING=1/SCANNED=2/EXPIRED=3/SUCCESS=4,
//   access_token=2 optional, refresh_token=3, user_id=4}
// 实测（2026-10-26）：端点无鉴权可调，CreateLoginQRCode 返回 field1=UUID。
// 前端 QR 内容（BJ5rsBjP.js WechatQrPanel）：`${origin}/wechat/mp/auth?id=${code}&device_id=${webId}`
export async function createLoginQRCode({ signal } = {}) {
  const res = await fetch(`${AUTH_BASE}${AUTH_RPC_QR_CREATE}`, {
    method: "POST",
    headers: { "Content-Type": "application/proto", "Connect-Protocol-Version": "1" },
    body: new Uint8Array(0),
    signal,
  });
  if (!res.ok) throw Object.assign(new Error(`CreateLoginQRCode http ${res.status}`), { kind: "upstream_error" });
  const buf = new Uint8Array(await res.arrayBuffer());
  let i = 0;
  while (i < buf.length) {
    const key = buf[i++];
    const num = key >> 3, wt = key & 7;
    if (wt !== 2) { i = skipNonLen(buf, i); continue; }
    let len = 0, sh = 0;
    for (;;) { const b = buf[i++]; len |= (b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
    if (num === 1) return dec.decode(buf.subarray(i, i + len));
    i += len;
  }
  throw Object.assign(new Error("CreateLoginQRCode response missing code"), { kind: "upstream_error" });
}

export async function getLoginQRCodeStatus(code, { signal } = {}) {
  const body = enc.encode(code);
  const payload = new Uint8Array(2 + body.length);
  payload[0] = 0x0a; payload[1] = body.length;
  payload.set(body, 2);
  const res = await fetch(`${AUTH_BASE}${AUTH_RPC_QR_STATUS}`, {
    method: "POST",
    headers: { "Content-Type": "application/proto", "Connect-Protocol-Version": "1" },
    body: payload,
    signal,
  });
  if (!res.ok) throw Object.assign(new Error(`GetLoginQRCodeStatus http ${res.status}`), { kind: "upstream_error" });
  const buf = new Uint8Array(await res.arrayBuffer());
  const out = { status: 0, accessToken: "", refreshToken: "", userId: "" };
  let i = 0;
  while (i < buf.length) {
    const key = buf[i++];
    const num = key >> 3, wt = key & 7;
    if (wt === 0) { // varint（status=1）
      let v = 0, sh = 0;
      for (;;) { const b = buf[i++]; v |= (b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
      if (num === 1) out.status = v;
    } else if (wt === 2) {
      let len = 0, sh = 0;
      for (;;) { const b = buf[i++]; len |= (b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
      const val = dec.decode(buf.subarray(i, i + len));
      if (num === 2) out.accessToken = val;
      if (num === 3) out.refreshToken = val;
      if (num === 4) out.userId = val;
      i += len;
    } else {
      i = skipNonLen(buf, i);
    }
  }
  return out;
}

// ---------- 手机号 + 短信验证码登录（connect unary，无需已有凭据） ----------
// sms.proto: SendVerifyCodeRequest{scene=1(SCENE_LOGIN=1), phone=2 PhoneNumber, captcha=3 optional}
//   PhoneNumber{country_code=1 str, number=2 str}（country_code 必须 ^[1-9][0-9]{0,3}$，不带 +）
// auth.proto: LoginWithSMSRequest{phone=1, verify_code=2} → {access_token=1, refresh_token=2, new_user=3, user_id=4}
// 实测（2026-10-26）：SendVerifyCode 强制人机验证（REASON_ACCOUNT_CAPTCHA_VERIFY_FAILED），
//   而 LoginWithSMS 不校验 captcha——只要验证码正确就能换到 token。
export const AUTH_RPC_SMS_SEND = "/api/account.gateway.v1.SMSService/SendVerifyCode";
export const AUTH_RPC_SMS_LOGIN = "/api/account.gateway.v1.AuthService/LoginWithSMS";

function phoneNumberBytes(phone) {
  return concat([strField(1, phone.countryCode), strField(2, phone.number)]);
}

// connect 的错误体是 JSON（即便 content-type 是 text/plain）：{code, message, details}
async function readConnectError(res) {
  let text = "";
  try { text = await res.text(); } catch { /* 忽略：拿不到正文时只报状态码 */ }
  let code = "", message = "";
  try {
    const j = JSON.parse(text);
    code = j.code ?? "";
    message = j.message ?? j.error?.message ?? "";
    if (!message && j.details?.[0]?.debug?.localizedMessage?.message) message = j.details[0].debug.localizedMessage.message;
    if (!message && j.details?.[0]?.reason) message = String(j.details[0].reason);
  } catch { message = (text || "").slice(0, 300); }
  return { code, message };
}

// 发送短信验证码。成功 → {ok:true}；被要求人机验证 → {ok:false, captcha:true}（不能绕，需用户自己在官网发码）
export async function sendVerifyCode(phone, { signal } = {}) {
  const body = concat([Uint8Array.of(0x08, 0x01), bytesField(2, phoneNumberBytes(phone))]);
  const res = await fetch(`${AUTH_BASE}${AUTH_RPC_SMS_SEND}`, {
    method: "POST",
    headers: { "Content-Type": "application/proto", "Connect-Protocol-Version": "1" },
    body,
    signal,
  });
  if (res.ok) return { ok: true };
  const { code, message } = await readConnectError(res);
  const captcha = /CAPTCHA/i.test(message) || /captcha/i.test(code) || res.status === 400;
  return { ok: false, captcha, code, message };
}

// 用验证码换 token。成功 → {accessToken, refreshToken, userId, newUser}
export async function loginWithSMS(phone, code, { signal } = {}) {
  const body = concat([bytesField(1, phoneNumberBytes(phone)), strField(2, String(code ?? "").trim())]);
  const res = await fetch(`${AUTH_BASE}${AUTH_RPC_SMS_LOGIN}`, {
    method: "POST",
    headers: { "Content-Type": "application/proto", "Connect-Protocol-Version": "1" },
    body,
    signal,
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) {
    const text = dec.decode(buf);
    let code_ = "", message = "";
    try {
      const j = JSON.parse(text);
      code_ = j.code ?? "";
      message = j.message ?? j.details?.[0]?.debug?.localizedMessage?.message ?? "";
    } catch { message = text.slice(0, 300) }
    const kind = res.status === 401 ? "unauthorized" : "upstream_error";
    throw Object.assign(new Error(message || `LoginWithSMS http ${res.status}`), { kind, code: code_ });
  }
  const out = { accessToken: "", refreshToken: "", userId: "", newUser: false };
  for (const f of fields(buf)) {
    if (f.num === 1 && f.wt === 2) out.accessToken = dec.decode(f.buf);
    else if (f.num === 2 && f.wt === 2) out.refreshToken = dec.decode(f.buf);
    else if (f.num === 3 && f.wt === 0) out.newUser = Number(f.v) !== 0;
    else if (f.num === 4 && f.wt === 2) out.userId = dec.decode(f.buf);
  }
  if (!out.accessToken || !out.refreshToken) {
    throw Object.assign(new Error("LoginWithSMS response missing tokens"), { kind: "upstream_error" });
  }
  return out;
}

// 把用户输入解析成 {countryCode, number}。接受 "86 13800138000" / "+8613800138000" / "13800138000"。
export function parsePhoneNumber(raw) {
  const original = String(raw ?? "").trim();
  const hadPlus = original.startsWith("+");
  const s = original.replace(/[\s\-()]/g, "").replace(/^\+/, "");
  if (!/^\d{6,15}$/.test(s)) {
    throw Object.assign(new Error("手机号只能是数字（可以带国际区号，例如 86 13800138000）"), { kind: "bad_input" });
  }
  if (!hadPlus && !/\s|-|\(/.test(original) && s.length === 11 && s.startsWith("1")) {
    return { countryCode: "86", number: s }; // 大陆手机号，省略国家码
  }
  if (s.startsWith("86") && s.length === 13) return { countryCode: "86", number: s.slice(2) };
  // 其余：前 1-3 位当国家码（含空格/加号时用户已显式分开）
  for (const len of [3, 2, 1]) {
    const cc = s.slice(0, len);
    if (/^[1-9]\d*$/.test(cc) && s.length - len >= 6) return { countryCode: cc, number: s.slice(len) };
  }
  throw Object.assign(new Error("无法识别这个手机号；请按「国家码 号码」填写，例如 86 13800138000"), { kind: "bad_input" });
}

// ---------- GetAvailableModels（connect unary, Ge 白名单端点） ----------
// GetAvailableModelsRequest{scene=1 enum}（SCENE_KIMI_WORK=1）
// GetAvailableModelsResponse{available_models=1 repeated Model, default_scenario=2{scenario=2,model=4}, default_agent_model=3, default_chat_model=4, more_models=5}
// Model{kimi_plus_id=7, model_id=19, scenario=1, thinking=5}（DWIk3Xhs__9.txt）
export async function getAvailableModels(auth, { signal, scene = 1 } = {}) {
  // 请求体：field1 varint = scene。scene=null → 空 body（= 网页默认场景，
  // 才返回 default_chat_model/default_agent_model；带 SCENE_KIMI_WORK 时只有 work 那批模型）。
  const reqBody = scene == null ? new Uint8Array(0) : new Uint8Array([0x08, scene & 0x7f])
  const res = await fetch(`${GATEWAY}/apiv2/kimi.gateway.config.v1.ConfigService/GetAvailableModels`, {
    method: "POST",
    headers: { ...authHeaders(auth, { includeShield: false }), "Content-Type": "application/proto" },
    body: reqBody,
    signal,
  });
  if (!res.ok) throw Object.assign(new Error(`GetAvailableModels http ${res.status}`), { kind: "upstream_error" });
  const buf = new Uint8Array(await res.arrayBuffer());
  const out = { models: [], defaultChatModel: "", defaultAgentModel: "" };
  let i = 0;
  while (i < buf.length) {
    const key = buf[i++];
    const num = key >> 3, wt = key & 7;
    if (wt !== 2) { i = skipNonLen(buf, i); continue; }
    let len = 0, sh = 0;
    for (;;) { const b = buf[i++]; len |= (b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
    const sub = buf.subarray(i, i + len);
    if (num === 1 || num === 5) out.models.push(parseModelEntry(sub));
    else if (num === 3) out.defaultAgentModel = dec.decode(sub);
    else if (num === 4) out.defaultChatModel = dec.decode(sub);
    else if (num === 2) {
      // DefaultScenarioConfig{tip=1, scenario=2, thinking=3, model=4}
      let j = 0;
      while (j < sub.length) {
        const k2 = sub[j++]; const n2 = k2 >> 3, w2 = k2 & 7;
        if (w2 !== 2) { j = skipNonLen(sub, j); continue; }
        let l2 = 0, s2 = 0;
        for (;;) { const b = sub[j++]; l2 |= (b & 0x7f) << s2; if (!(b & 0x80)) break; s2 += 7; }
        if (n2 === 4) out.defaultChatModel = out.defaultChatModel || dec.decode(sub.subarray(j, j + l2));
        j += l2;
      }
    }
    i += len;
  }
  return out;
}

function parseModelEntry(buf) {
  // Model{scenario=1, display_name=2, thinking=5, kimi_plus_id=7, key=15, model_id=19}
  // 注意：model_id(19) 不是每个条目都有（默认场景的 K3 只有 key="k3"），所以调用方要回退到 key。
  // 注意：tag 本身是 varint——field≥16 的 tag 是两字节（如 field19 → 0x9a 0x01）
  const m = { scenario: 0, displayName: "", kimiPlusId: "", thinking: false, modelId: "", key: "" };
  let i = 0;
  while (i < buf.length) {
    let tag = 0, sh = 0;
    for (;;) { const b = buf[i++]; tag |= (b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
    const num = tag >> 3, wt = tag & 7;
    if (wt === 0) { let v = 0, sh2 = 0; for (;;) { const b = buf[i++]; v |= (b & 0x7f) << sh2; if (!(b & 0x80)) break; sh2 += 7; } if (num === 1) m.scenario = v; if (num === 5) m.thinking = !!v; continue; }
    if (wt !== 2) { i = skipNonLen(buf, i); continue; }
    let len = 0, sh2 = 0;
    for (;;) { const b = buf[i++]; len |= (b & 0x7f) << sh2; if (!(b & 0x80)) break; sh2 += 7; }
    const val = buf.subarray(i, i + len);
    if (num === 2) m.displayName = dec.decode(val);
    if (num === 7) m.kimiPlusId = dec.decode(val);
    if (num === 15) m.key = dec.decode(val);
    if (num === 19) m.modelId = dec.decode(val);
    i += len;
  }
  return m;
}

// ---------- MembershipService（connect unary, JSON 不是 proto 信封） ----------
// 订阅相关三个接口（2026-10-27 真机实测可用，鉴权同聊天：Bearer accessToken）：
//   GetSubscriptionStats{}                      → ratelimitCode5h/7d{ratio,enabled,resetTime}
//                                                 + subscriptionBalance{amountUsedRatio,expireTime,kimiCodeUsedRatio}
//   GetSubscription{}                           → subscription{subscriptionId,goods{title,durationDays,useRegion}}
//                                                 （goods.title = 套餐名，形如 "<plan name>"）
//   ListBalanceActions{page_size, filter{unit,balance_types}} → actions[]{feature,title,items[].amountRatio,timestamp}
// 注意：这两条是 application/json + Connect-Protocol-Version:1（不是 connect+proto 的 5B 帧信封）。
async function membershipJson(path, body, auth, { signal } = {}) {
  const headers = authHeaders(auth, { includeShield: false })
  headers["Content-Type"] = "application/json"
  const res = await fetch(`${GATEWAY}/apiv2/${path}`, {
    method: "POST", headers, body: JSON.stringify(body ?? {}), signal,
  })
  if (!res.ok) throw Object.assign(new Error(`membership ${path.split("/").pop()} http ${res.status}`),
    { kind: "upstream_error", status: res.status })
  const text = await res.text()
  try { return JSON.parse(text) } catch { throw Object.assign(new Error("membership: invalid JSON"), { kind: "upstream_error" }) }
}

export async function getSubscriptionStats(auth, { signal } = {}) {
  return membershipJson("kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats", {}, auth, { signal })
}

// 套餐名：goods.title。同一个 Connect-JSON 形态，请求体 {}。
export async function getSubscription(auth, { signal } = {}) {
  return membershipJson("kimi.gateway.membership.v2.MembershipService/GetSubscription", {}, auth, { signal })
}

export async function listBalanceActions(auth, { pageSize = 20, signal } = {}) {
  return membershipJson("kimi.gateway.membership.v2.MembershipService/ListBalanceActions",
    { page_size: pageSize, filter: { unit: "UNIT_CREDIT", balance_types: ["SUBSCRIPTION"] } }, auth, { signal })
}
// ---------- CancelChat（服务端取消；前端模式：断流 + fire-and-forget cancelChat） ----------
// CancelChatRequest{chat_id=1, message_id=2}（kimi.gateway.chat.v1）。吞错——与前端 catch{} 一致，
// 取消失败不影响客户端（上游最多继续生成到自然结束）。
export async function cancelChat(auth, { chatId, messageId, signal } = {}) {
  if (!chatId) return false
  const body = [strField(1, chatId)]
  if (messageId) body.push(strField(2, messageId))
  try {
    const res = await fetch(`${GATEWAY}${CHAT_RPC.replace(/\/Chat$/, "/CancelChat")}`, {
      method: "POST",
      headers: { ...authHeaders(auth), "Content-Type": "application/proto" },
      body: concat(body), // connect unary
      signal,
    })
    return res.ok
  } catch { return false }
}

// ---------- Chat 调用（connect streaming） ----------
// 返回 async generator：yield decodeChatResponse() 结果；流尾 end 帧带 error 时抛出。
// idleTimeoutMs：帧间空闲超时（上游有 Heartbeat 保活，正常流不会触发；网络挂起时兜底）。
export async function* chatStream(auth, req, { signal, onTokenRefresh, idleTimeoutMs = 120_000 } = {}) {
  let headers = authHeaders(auth);
  let res = await fetch(`${GATEWAY}${CHAT_RPC}`, {
    method: "POST",
    headers,
    body: envelope(encodeChatRequest(req)),
    signal,
  });
  if (res.status === 401 && auth.refreshToken) {
    const nt = await refreshToken(auth, { signal });
    Object.assign(auth, nt);
    if (onTokenRefresh) await onTokenRefresh(auth);
    res = await fetch(`${GATEWAY}${CHAT_RPC}`, {
      method: "POST",
      headers: authHeaders(auth),
      body: envelope(encodeChatRequest(req)),
      signal,
    });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // www.kimi.com 401 时 content-type 可能是 text/plain 但 body 是 connect JSON（PROTOCOL.md §8）
    let hint = "";
    try { hint = String(JSON.parse(text)?.message ?? ""); } catch { /* 非 JSON */ }
    const message = res.status === 401 && hint
      ? `Kimi rejected credentials: ${hint.slice(0, 160)}${auth.refreshToken ? "" : " — re-run: magpie plugin login kimi-chat"}`
      : `chat http ${res.status} ${text.slice(0, 200)}`;
    throw Object.assign(new Error(message), {
      kind: res.status === 401 ? "unauthorized" : res.status === 429 ? "rate_limited" : "upstream_error",
    });
  }
  if (!res.body) throw Object.assign(new Error("chat: empty body"), { kind: "upstream_error" });
  const parser = createFrameParser();
  const reader = res.body.getReader();
  // 空闲计时：每次读到新字节重置；超时视为上游挂起，主动断开
  const idle = new AbortController();
  const onOuterAbort = () => idle.abort(signal?.reason);
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  let timer = setTimeout(() => idle.abort(Object.assign(new Error(`kimi chat idle for ${idleTimeoutMs}ms`), { kind: "timeout" })), idleTimeoutMs);
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(Object.assign(new Error(`kimi chat idle for ${idleTimeoutMs}ms`), { kind: "timeout" })), idleTimeoutMs) }
  try {
    for (;;) {
      const { done, value } = await Promise.race([
        reader.read(),
        idle.signal.aborted ? Promise.reject(idle.signal.reason) : new Promise((_, reject) => {
          idle.signal.addEventListener("abort", () => reject(idle.signal.reason), { once: true })
        }),
      ]);
      if (done) break;
      bump();
      parser.feed(value);
      let f;
      while ((f = parser.take())) {
        if (f.end) {
          if (f.end.error) {
            const err = f.end.error;
            // connect 错误常把可读原因放在 details[].debug.localizedMessage / buf.validate 代码里
            let detail = "";
            for (const item of Array.isArray(err.details) ? err.details : []) {
              const v = item?.debug?.localizedMessage?.message ?? item?.debug?.reason ?? item?.value;
              if (typeof v === "string" && v) { detail = v; break; }
            }
            throw Object.assign(new Error(err.message || detail || "connect stream error"), {
              kind: "upstream_error",
              code: err.code,
              details: err.details,
            });
          }
          return;
        }
        yield decodeChatResponse(f.payload);
      }
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
    reader.cancel().catch(() => {});
  }
}



