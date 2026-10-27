// Kimi web upstream adapter. ALL private-protocol knowledge lives here.
// Protocol facts: PROTOCOL.md (passive archaeology, 2026-10-26).
// Emit contract (consumed by index.mjs loader.fetch):
//   yield { text, reasoning, status, sessionId, messageId, events: [uiEvent...], citations }
// text/reasoning are cumulative snapshots; events are ui-protocol envelopes.

import { chatStream, getAvailableModels, refreshToken } from "./kimi-connect.mjs"
import { matchModelId, REASONING_EFFORTS, INSTANT_EFFORTS } from "./models.mjs"
import {
  SCENARIO, SPEED, REASONING_EFFORT, CONTEXT_LENGTH, reasonToError,
} from "./kimi-proto.mjs"
import { LIMITS } from "./config.mjs"

// kimi-api 内部用位置参数 (op, surface, item, props)，适配 ui-protocol 的对象签名。
// seq 取自 state 单调计数，保证客户端可排序去重。
// component 必须落在 UI_COMPONENTS 白名单内（search-results/agent-timeline/preview-card…），
// 否则客户端会按未知组件降级为纯文本——发射前用 validateProps 校验，校验失败的事件
// 降级为 agent-timeline 文本步骤，保证信息不丢。
import { uiEvent as uiEventRaw, validateProps } from "./ui-protocol.mjs"

const uiEvent = (state, op, surfaceId, itemId, props, component) => {
  const comp = component ?? COMPONENT_BY_SURFACE[surfaceId] ?? surfaceId
  const err = validateProps(comp, props)
  if (err) {
    // 白名单校验失败：降级为 agent-timeline 文本步骤，绝不发射非法组件
    const summary = `${surfaceId}: ${JSON.stringify(props).slice(0, 200)}`
    return uiEventRaw(op === "create" ? "patch" : op, {
      surfaceId: "timeline", itemId: `degraded-${surfaceId}`, seq: state._surfaceSeq++,
      component: "agent-timeline",
      props: { steps: [{ kind: "write", label: summary }] },
    })
  }
  return uiEventRaw(op, { surfaceId, itemId, seq: state._surfaceSeq++, component: comp, props })
}

// surfaceId → 白名单组件名（UI_COMPONENTS 的键）
const COMPONENT_BY_SURFACE = {
  search: "search-results",
  timeline: "agent-timeline",
  preview: "preview-card",
}

// Credentials: JSON pasted by the user after browser login (PROTOCOL.md §6):
// { accessToken, refreshToken, userId, webId, ssid, shieldData?, timezone? }
// Also accepts cookie-style string for backward compat with early tests.
export function parseCredentials(raw) {
  const value = String(raw ?? "").trim()
  if (!value) throw new Error("Kimi credentials are empty")
  if (value.startsWith("{")) {
    const o = JSON.parse(value)
    const auth = {
      accessToken: str(o.accessToken ?? o.access_token),
      refreshToken: str(o.refreshToken ?? o.refresh_token),
      userId: str(o.userId ?? o.user_id ?? o.trafficId),
      webId: str(o.webId ?? o.web_id ?? o.deviceId),
      ssid: str(o.ssid ?? o.sessionId),
      shieldData: str(o.shieldData ?? o.shield_data) || null,
      timezone: str(o.timezone) || "Asia/Shanghai",
    }
    if (!auth.accessToken && !auth.refreshToken) throw new Error("Kimi credentials JSON needs accessToken or refreshToken")
    return auth
  }
  // Bare token fallback
  return { accessToken: value, refreshToken: "", userId: "", webId: "", ssid: "", shieldData: null, timezone: "Asia/Shanghai" }
}

const str = v => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "")

export function classifyError(error) {
  if (error?.kind) return error.kind
  if (error?.status === 401) return "unauthorized"
  if (error?.status === 429) return "rate_limited"
  if (error?.name === "AbortError" || error?.code === "ABORT_ERR") return "cancelled"
  return "upstream_error"
}

export function safeErrorMessage(message) {
  return String(message ?? "Kimi upstream request failed")
    .replace(/(token|cookie|authorization)=?[^;\s]*/gi, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
}

// ---------- tier → ChatRequest ----------
// ---------- 动态模型 id（GetAvailableModels） ----------
// 服务端会换挡：2026-10-26 实测 default_chat_model=k2d6-chat，10-27 已换成 k28-instant。
// 硬编码默认值迟早静默失效（表现是上游用服务端默认模型回话，参数全被忽略），
// 所以这里把清单结果缓存 10 分钟；取清单失败时退回缓存或固定兜底，绝不打断对话。
export const FALLBACK_MODELS = { chatModel: "k2d6-chat", agentModel: "k3-agent" }
const MODEL_TTL_MS = 10 * 60_000
const modelCache = { at: 0, chatModel: "", agentModel: "", list: [] }

export function _resetModelCache() {
  modelCache.at = 0
  modelCache.chatModel = ""
  modelCache.agentModel = ""
  modelCache.list = []
}

export async function resolveModels(auth, { signal, force = false, onRefresh } = {}) {
  const fresh = Date.now() - modelCache.at < MODEL_TTL_MS && !!modelCache.chatModel
  if (fresh && !force) return modelCache
  let out = null
  // 1) 免鉴权调用优先：ConfigService 允许匿名（2026-10-27 实测 200 + 1057B），
  //    且默认档位（default_chat_model/default_agent_model）就在这个响应里。
  try {
    out = await getAvailableModels({ timezone: auth?.timezone || "Asia/Shanghai" }, { signal, scene: null })
  } catch { out = null }
  // 2) 匿名失败（网络/接口变更）再走带鉴权路径；accessToken 过期（1h）先刷新一次。
  if (!out) {
    try {
      out = await getAvailableModels(auth, { signal, scene: null })
    } catch (e) {
      if (/401/.test(String(e?.message))) {
        const nt = await refreshToken(auth, { signal }).catch(() => null)
        if (nt?.accessToken) {
          onRefresh?.(nt)
          Object.assign(auth, nt)
          // 带鉴权响应只回 available_models（实测无默认档字段），仅作为清单补充。
          out = await getAvailableModels(auth, { signal, scene: null }).catch(() => null)
        }
      }
    }
  }
  if (out) {
    modelCache.at = Date.now()
    modelCache.chatModel = out.defaultChatModel || modelCache.chatModel || FALLBACK_MODELS.chatModel
    modelCache.agentModel = out.defaultAgentModel || modelCache.agentModel || FALLBACK_MODELS.agentModel
    // 默认场景（scene=0）回的只是"模型菜单项"：有 display_name 却没有 model_id
    // （2026-10-27 实测：K3.1 Pro / K2.8 / Instant / K3 四条，model_id 全空）。
    // 真正带 id 的是 Work 场景（scene=1）的响应。这里补一次 scene=1，把 id 按 display_name 对上，
    // 仍对不上的按场景兜底（CHAT→默认 chat 模型，其余→默认 agent 模型）。
    let workOut = null
    try { workOut = await getAvailableModels({ timezone: auth?.timezone || "Asia/Shanghai" }, { signal, scene: 1 }) } catch { workOut = null }
    const idPairs = (workOut?.models ?? []).filter((m) => m.modelId).map((m) => [m.displayName || "", m.modelId])
    modelCache.list = (out.models ?? modelCache.list).map((m) => ({
      ...m,
      // 先按 display_name 对 Work 场景的 id；对不上的退回条目自己的 key（默认场景的 K3 只有 key="k3"），
      // 再不行才用场景默认模型兜底——否则 "K3" 会被误标成 K3.1 Pro 的 id 并被去重丢掉。
      modelId: m.modelId || matchModelId(m.displayName, idPairs) || m.key || (Number(m.scenario) === 1 ? modelCache.chatModel : modelCache.agentModel),
    }))
    // 思考档专用模型：k3-agent 实测会流式吐完整 think 块（702 字级），
    // 而 k3d1-agent 在 OK_COMPUTER+thinking 下思考极短——思考档用它等于把"思考"变成空壳。
    // 清单里没有 k3-agent 也照样用它（接口仍接受），取不到才退回 k3 系/默认 agent。
    modelCache.thinkingModel = "k3-agent"
  } else {
    // 网络抖动/接口变更：保留缓存，首次失败用固定兜底（宁可参数不最优，也不能让对话直接失败）。
    modelCache.chatModel ||= FALLBACK_MODELS.chatModel
    modelCache.agentModel ||= FALLBACK_MODELS.agentModel
  }
  return modelCache
}

// ---------- reasoning_effort（思考档位）----------
// 上游只认 3=LOW / 5=HIGH / 7=MAX 三档，且 Instant（CHAT 场景）只支持 3/5
// （2026-10-27 用户前端确认，见 PROTOCOL.md §12.1）。
// 客户端可能传 OpenAI 语义名（low/medium/high/max）、数字或数字字符串，先归一化成档位数字。
function effortValue(v) {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v) : undefined
  if (typeof v !== "string") return undefined
  const s = v.trim().toUpperCase()
  if (!s) return undefined
  if (Object.prototype.hasOwnProperty.call(REASONING_EFFORT, s)) return REASONING_EFFORT[s]
  const n = Number(s)
  return Number.isFinite(n) ? Math.round(n) : undefined
}

// 按模型允许集合夹取：
//   集合内 → 原样透传；超过上界 → 夹到上界（Instant 传 7 → 5）；
//   其余（非法、低于下界、档位不在集合里）→ 走 fallback（档位语义默认），fallback 为 undefined
//   时干脆不发该字段，交给上游默认——绝不把非法枚举送给上游（那样是整请求报错，不是回落默认）。
function clampEffort(value, allowed, fallback) {
  const raw = effortValue(value)
  const set = Array.isArray(allowed) && allowed.length ? allowed : REASONING_EFFORTS
  const max = Math.max(...set)
  if (raw === undefined) return fallback
  if (set.includes(raw)) return raw
  if (raw > max) return max
  return fallback
}

export function tierToRequest(tier, prompt, { sessionId, search, searchForce, reasoningEffort, models, speed, contextLength, spec }) {
  // tier 有两种写法在项目里都出现过：模型档名 "kimi-thinking" 与 config.MODELS 里的
  // tier 短名 "thinking"。统一归一化——早期只比较全名，短名静默落入默认分支，
  // 导致三档全部退化成 CHAT/默认模型（think 不思考、agent 不启插件）。
  const t = String(tier ?? "fast").replace(/^kimi-/, "")
  // 可选参数（客户端可经 body.speed / body.context_length 覆盖；未知值一律丢弃，
  // 绝不把非法枚举送给上游——上游对非法值是整请求报错，不是回落默认）。
  const pickEnum = (map, v) => (typeof v === "number" ? (Object.values(map).includes(v) ? v : undefined) : map[String(v ?? "").toUpperCase()])
  // speed 只允许实测通过的值（1/5）；3/7 会被上游 enum.defined_only 拒，10 被 "Invalid parameter" 拒。
  const speedAllowed = new Set([SPEED.STANDARD, SPEED.FAST])
  const speedRaw = pickEnum(SPEED, speed)
  const speedEnum = speedAllowed.has(speedRaw) ? speedRaw : undefined
  // 对话长度：默认固定 L(5)、不对客户端开放——超长档位消耗成倍增长，且几乎没有客户端能传该参数。
  // 上游对无权使用的档位直接报错（6 → connect stream error，7 → "Invalid parameter"），
  // 所以超上限值一律丢弃（回落服务端默认，不让整轮失败）；需要时由 KIMI_MAX_CONTEXT_LENGTH 调上限。
  const contextCap = Number(process.env.KIMI_MAX_CONTEXT_LENGTH ?? CONTEXT_LENGTH.L)
  const contextRaw = pickEnum(CONTEXT_LENGTH, contextLength)
  const contextEnum = contextRaw && contextRaw <= contextCap ? contextRaw : undefined
  // 模型 id 来自 GetAvailableModels（缓存 10 分钟），未拿到时用固定兜底值。
  const chatModel = models?.chatModel || FALLBACK_MODELS.chatModel
  const agentModel = models?.agentModel || FALLBACK_MODELS.agentModel
  const thinkingModel = models?.thinkingModel || agentModel
  const req = {
    chatId: sessionId || undefined,
    scenario: SCENARIO.CHAT,
    useSearch: !!search,
    prompt,
    options: {},
  }
  // 联网搜索：search=true 声明 SEARCH 工具（服务端决定是否真搜）；
  // searchForce=true 时每次都强制搜（对应网页"联网搜索"开关打开）。
  if (searchForce) req.options.searchForce = true
  // 动态模型入口：清单里每个上游模型都可单独选用，场景/kimiPlusId/model/thinking 全部
  // 来自 GetAvailableModels 的实际返回（不再靠档位猜）。此处直接返回，不走档位分支。
  if (spec?.modelId) {
    req.scenario = spec.scenario || SCENARIO.CHAT
    if (spec.kimiplusId) req.kimiplusId = spec.kimiplusId
    req.options.model = spec.modelId
    // 思考档位按该模型的允许集合夹取（清单没带就按场景默认：CHAT=Instant 两档，其余三档）
    const specEfforts = Array.isArray(spec.reasoningEfforts) && spec.reasoningEfforts.length
      ? spec.reasoningEfforts
      : (req.scenario === SCENARIO.CHAT ? INSTANT_EFFORTS : REASONING_EFFORTS)
    const specEffort = clampEffort(reasoningEffort, specEfforts, undefined)
    // 选了思考档位就必须真的开思考：Instant 的思考和联网是一体的
    // （见下方 fast 分支注释；2026-10-27 实测 thinking=false 时不会挂 web_search）。
    req.options.thinking = !!spec.thinking || specEffort !== undefined
    if (specEffort !== undefined) req.options.reasoningEffort = specEffort
    req.options.speed = speedEnum ?? SPEED.FAST
    if (contextEnum) req.options.contextLength = contextEnum
    return req
  }
  if (t === "thinking") {
    // 前端 ChFG9O1A.js：ChatRequestOptions{thinking:!0（恒真）, reasoningEffort, ...}——
    // 思考不是独立场景，是同模型 + 更高 reasoning effort。思考档底层是 K3 系（三档都支持），
    // 默认 HIGH(5)；用户可用 reasoning_effort 覆盖（max/7 → 7）。
    req.scenario = SCENARIO.OK_COMPUTER
    req.kimiplusId = "ok-computer"
    req.options.model = thinkingModel
    req.options.thinking = true
    const thinkEffort = clampEffort(reasoningEffort, REASONING_EFFORTS, REASONING_EFFORT.HIGH)
    if (thinkEffort !== undefined) req.options.reasoningEffort = thinkEffort
    req.options.speed = SPEED.FAST // 5=Fast（K3 网页默认档；显式钉住，不依赖服务端默认）
    if (speedEnum) req.options.speed = speedEnum
    if (contextEnum) req.options.contextLength = contextEnum
  } else if (t === "agent") {
    // 无鉴权 GetAvailableModels 实测：default_agent_model="k3-agent"（display "K3"，scenario OK_COMPUTER(6)，
    // kimi_plus_id="ok-computer"，speed 3=Standard/5=High/7=Max default 5；Model.id=22 是请求 model 串）
    req.scenario = SCENARIO.OK_COMPUTER
    req.kimiplusId = "ok-computer"
    req.options.model = agentModel
    req.options.speed = SPEED.FAST // 5：CRN2 枚举合法值，且 = K3 default_speed(5)。CRN2 无 3，勿用展示刻度值
    req.options.enablePlugin = true
    // Agent 档同样是 K3 系：允许 Low/High/Max，未传就交给上游默认
    const agentEffort = clampEffort(reasoningEffort, REASONING_EFFORTS, undefined)
    if (agentEffort !== undefined) req.options.reasoningEffort = agentEffort
    if (speedEnum) req.options.speed = speedEnum
    if (contextEnum) req.options.contextLength = contextEnum
  } else {
    // fast 与任何未知档的兜底：显式钉住模型与速度，绝不静默依赖服务端默认。
    // 无鉴权 GetAvailableModels 实测（2026-10-26）：default_chat_model="k2d6-chat"（display "Instant",
    // "Fast chat, quick replies"，支持图片），scenario CHAT(1)，speed 档 1=Standard/3=High，default_speed=3。
    // 用户"老套餐快速模式无限量" → Instant 模型 + FAST(5)（高于网页默认 High(3)，仍未到 Max(7)）
    req.scenario = SCENARIO.CHAT
    req.options.model = chatModel
    req.options.speed = SPEED.FAST
    // Instant 也透传思考档位，但只认 Low(3)/High(5)；7 夹到 5，非法值不发
    const fastEffort = clampEffort(reasoningEffort, INSTANT_EFFORTS, undefined)
    if (fastEffort !== undefined) req.options.reasoningEffort = fastEffort
    // 网页端的"进阶思考"= Instant + thinking=true + reasoningEffort。实测（2026-10-27）：
    //   thinking=false 时服务端根本不挂联网搜索工具（force=true 也不搜），模型会自称"没有联网工具"；
    //   thinking=true 时立刻出现 web_search ToolBlock + 真实搜索结果（天气问题 19~54 个工具块）。
    // 所以客户端一旦选了档位，就必须把 thinking 打开——否则"进阶思考"只是个空转的枚举。
    if (fastEffort !== undefined) req.options.thinking = true
  }
  return req
}

// ---------- main: complete() ----------
export async function* complete({ origin, credentials, tier, prompt, sessionId, signal, search = true, reasoningEffort, speed, contextLength, spec, onTokenRefresh }) {
  const auth = typeof credentials === "string" ? parseCredentials(credentials) : credentials
  // 模型 id 动态解析（失败不影响对话，退回缓存/兜底）。
  // complete._models 供测试注入；注入了 transport 的测试也不打真实网络（保持单测离线）。
  const models = complete._models ?? (complete._transport ? null : await resolveModels(auth, { signal, onRefresh: onTokenRefresh }))
  const req = tierToRequest(tier, prompt, { sessionId, search, reasoningEffort, models, speed, contextLength, spec })
  const state = {
    rawText: "", textBlocks: new Map(), textOrder: [], reasoning: "", status: null,
    sessionId: sessionId ?? null, messageId: null,
    events: [], citations: [],
    _blocks: new Map(),   // blockId → {kind, snapshot}
    _surfaceSeq: 0,
  }
  const transport = complete._transport  // test injection: Response(SSE) | async generator
  let stream
  if (transport) {
    const out = await transport({ origin, credentials: auth, tier, prompt, sessionId, search, signal })
    stream = out instanceof Response ? legacySseToFrames(out, signal) : out
  } else {
    stream = chatStream(auth, req, { signal, onTokenRefresh })
  }

  for await (const resp of stream) {
    applyResponse(state, resp)
    if (state.status === "ERROR") {
      throw Object.assign(new Error(state.errorMessage || "Kimi upstream error"), {
        kind: reasonToError(state.errorReason ?? 0),
      })
    }
    // 输出上限保护：超限即停（UI 事件不计数，只算正文+思考）
    if (textLength(state) + state.reasoning.length > LIMITS.maxOutputCharacters) {
      yield snapshot(state, true)
      state.status = "TRUNCATED"
      await stream.return?.()
      break
    }
    yield snapshot(state)
  }
  state.status ??= "FINISHED"
  yield snapshot(state, true)
}

function snapshot(state, final = false) {
  return {
    text: displayText(state, final), reasoning: state.reasoning, status: state.status,
    sessionId: state.sessionId, messageId: state.messageId,
    events: state.events.splice(0), citations: state.citations.slice(),
  }
}

// Kimi 前端用私有区码点标记行内引用：\uE3A0(type)[\uE3A1\uE3A2\uE3A4](payload)\uE3A8
// （T0ufiYEK.js 正则证实）。普通 OpenAI 客户端不认识这些码点——按顺序替换为 [n]，
// 与 citations 数组对齐（第 n 次出现的 ref 标记 → citations[n-1]）。
const INLINE_REF = /\uE3A0([^\uE3A0-\uE3A8]+)[\uE3A1\uE3A2\uE3A4]([^\uE3A0-\uE3A8]+)\uE3A8/g
// 另一种行内引用标记（活体实测出现）：<REF>cite✦tools://web_search:1#4:~:text=...</REF>
// #4 是这条搜索结果在 ToolBlock.contents 里的 index，可映射到 citations 序号。
const TEXT_REF = /<REF>(\s*cite[^<]*)<\/REF>/g
export function sanitizeInlineRefs(text, { marker = (i) => `[${i + 1}]`, refMap } = {}) {
  if (!text) return text
  let out = text
  if (out.includes("\uE3A0")) {
    let i = 0
    out = out.replace(INLINE_REF, () => marker(i++))
  }
  if (out.includes("<REF>")) {
    out = out.replace(TEXT_REF, (_match, inner) => {
      const hit = /^cite\s*✦\s*(?:tools:\/\/)?([^#\s]+)#(\d+)/.exec(inner)
      const n = hit ? refMap?.get(`${hit[1]}#${hit[2]}`) : undefined
      return n ? `[${n}]` : ""
    })
  }
  return out
}

// 流式安全边界：正文里的引用标记可能被帧切两半（"<REF>cite✦…" 未闭合）。
// 只清洗到最后一个完整边界为止，未闭合尾巴先不发——这样对外文本单调增，
// 客户端按 sentLength 切片不会错位，也不会漏出半截原始标记。
function safeCut(raw) {
  let cut = raw.length
  const open = raw.lastIndexOf("<REF>")
  if (open !== -1 && raw.indexOf("</REF>", open) === -1) cut = Math.min(cut, open)
  const start = raw.lastIndexOf("\uE3A0")
  if (start !== -1 && raw.indexOf("\uE3A8", start) === -1) cut = Math.min(cut, start)
  return cut
}

function textLength(state) {
  let n = 0
  for (const v of state.textBlocks?.values() ?? []) n += v.length
  return n
}

function displayText(state, final) {
  const raw = (state.textOrder ?? []).map((id) => state.textBlocks.get(id) ?? "").join("")
  const cut = safeCut(raw)
  const body = sanitizeInlineRefs(raw.slice(0, cut), { refMap: state.refMap })
  if (!final || cut >= raw.length) return body
  // 收尾：把未闭合的标记整段丢掉，其余补偿性发出（前缀不变，保证 sentLength 切片正确）
  const tail = raw.slice(cut).replace(/<REF>[\s\S]*$/, "").replace(/[\uE3A0-\uE3A8][\s\S]*$/, "")
  return body + sanitizeInlineRefs(tail, { refMap: state.refMap })
}

// 旧式 mock 传输（SSE Response，测试用）→ 归一化帧
async function* legacySseToFrames(response, signal) {
  const { sseFrames } = await import("./stream.mjs")
  for await (const frame of sseFrames(response.body, { signal })) {
    let payload = null
    try { payload = JSON.parse(frame.data) } catch { continue }
    // legacy JSON 帧 → ChatResponse-ish 形状
    const resp = {}
    if (typeof payload.session_id === "string") resp.chat = { id: payload.session_id }
    if (payload.message_id != null) resp.message = { id: String(payload.message_id), status: 2 }
    if (typeof payload.status === "string" && payload.status === "FINISHED") { resp.message = { id: resp.message?.id ?? "", status: 2 } }
    const delta = payload.delta ?? payload.content
    if (typeof delta === "string") {
      resp.block = { id: "t0", text: { content: delta } }
      resp.op = 2
    }
    if (typeof payload.reasoning === "string" && payload.reasoning) {
      resp.block = { id: "th0", think: { content: payload.reasoning } }
      resp.op = 2
    }
    if (Array.isArray(payload.citations)) {
      resp.ref = { search: { base: { url: payload.citations[0]?.url ?? "", title: payload.citations[0]?.title }, refIndex: "1" } }
    }
    yield resp
  }
  yield { done: {} }
}

// ChatResponse patch 应用：op(set/append) + block/ref 增量 → 状态 + UI 事件
function applyResponse(state, resp) {
  if (globalThis.__kimiDebug && resp.block) console.error("[kimi-debug] blk=" + Object.keys(resp.block).join(",") + " op=" + resp.op + " think=" + JSON.stringify(resp.block.think ?? null).slice(0, 80))
  if (resp.chat?.id) state.sessionId = resp.chat.id
  if (resp.message?.id) state.messageId = resp.message.id
  if (resp.message) {
    const st = ["", "GENERATING", "COMPLETED", "CANCELLED", "TRUNCATED", "ERROR", "PENDING"][resp.message.status]
    if (st) state.status = st
  }
  if (resp.block) applyBlock(state, resp.block, resp.op)
  if (resp.ref?.search) {
    const s = resp.ref.search
    if (s.base?.url) {
      state.citations.push({
        index: Number(s.refIndex) || state.citations.length + 1,
        title: s.base.title || s.base.url,
        url: s.base.url,
        quote: s.base.snippet || "",
      })
    }
  }
  if (resp.usage?.research) {
    // usage/status 非白名单组件：直接降级为 agent-timeline 文本步骤（信息不丢）
    state.events.push(uiEvent(state, "patch", "usage", "research", { used: resp.usage.research.used, limit: resp.usage.research.limit }))
  }
  if (resp.notification) {
    state.events.push(uiEvent(state, "patch", "status", "notice", { type: resp.notification.type, message: resp.notification.message }))
  }
  if (resp.block?.error) {
    state.status = "ERROR"
    state.errorReason = resp.block.error.reason
    state.errorMessage = resp.block.error.message
  }
}

function applyBlock(state, block, op) {
  const id = block.id
  if (block.text) {
    // 一条回答可能跨多个 TextBlock（例：搜索前一句铺垫 + 搜索后正文），且两个 block 的增量
    // 帧会交错到达。必须按 block 分别累积、按首次出现顺序拼接，否则正文会互相插队。
    const content = block.text.content ?? ""
    if (!state.textBlocks.has(id)) { state.textBlocks.set(id, ""); state.textOrder.push(id) }
    const cur = state.textBlocks.get(id)
    if (op === 2 /* append */) state.textBlocks.set(id, cur + content)
    else if (content.length >= cur.length) state.textBlocks.set(id, content) // set：只在没缩短时采纳，保证对外单调增
  }
  if (block.think) {
    const content = block.think.content ?? ""
    state.reasoning = op === 2 ? state.reasoning + content : replaceTail(state.reasoning, state._blocks.get("think:" + id) ?? "", content)
    state._blocks.set("think:" + id, op === 2 ? (state._blocks.get("think:" + id) ?? "") + content : content)
  }
  if (block.search) {
    const key = "search:" + (id || "default")
    const seen = state._blocks.has(key)
    state._blocks.set(key, true)
    state.events.push(uiEvent(state, seen ? "patch" : "create", "search", id || "search", {
      query: block.search.keywords.join(" ") || "",
      results: block.search.webPages.map(p => ({ title: p.title, url: p.url, snippet: p.snippet })),
    }))
  }
  if (block.tool) {
    // patch 语义：tool_call_id / name 只在起始帧出现，后续帧（尤其带 contents 的完成帧）
    // 只带增量字段——必须按 Block.id 记住身份，否则完成帧会被当成"匿名工具"。
    const meta = state._blocks.get("toolmeta:" + id) ?? {}
    if (block.tool.toolCallId) meta.tid = block.tool.toolCallId
    if (block.tool.name) meta.name = block.tool.name
    if (block.tool.args) meta.args = block.tool.args
    state._blocks.set("toolmeta:" + id, meta)
    const tid = meta.tid || id
    const name = meta.name || ""
    const args = block.tool.args || meta.args || ""
    const key = "tool:" + tid
    const steps = state._blocks.get(key) ?? []
    const status = ["", "pending", "running", "done"][block.tool.status] ?? "running"
    const label = `${name || "tool"} (${tid})`
    const existing = steps.find(s => s.label === label)
    const step = { kind: "tool", label, detail: args || status }
    if (existing) Object.assign(existing, step)
    else steps.push(step)
    state._blocks.set(key, steps)
    state.events.push(uiEvent(state, state._blocks.has("timeline-seen:" + tid) ? "patch" : "create", "timeline", "timeline", { steps: [...steps] }))
    state._blocks.set("timeline-seen:" + tid, true)

    // web_search 结果落在 ToolBlock.contents[].searchResult（不是 SearchBlock）：
    // 抽成 search-results 卡片 + 引用列表，正文之外的"来源"才不会丢。
    const isSearchTool = /web_search/i.test(tid) || /search/i.test(name)
    if (isSearchTool && block.tool.contents?.length) {
      const results = []
      const refIndexes = [] // 与 results 一一对应：SearchResultBase.index（行内 <REF>#n 用的就是它）
      for (const c of block.tool.contents) {
        const b = c.searchResult?.base
        if (b?.url) {
          results.push({ title: b.title || b.url, url: b.url, snippet: b.snippet || "" })
          refIndexes.push(c.searchResult?.index ?? String(results.length - 1))
        }
      }
      if (results.length) {
        let query = ""
        try {
          const a = JSON.parse(args || "{}")
          query = Array.isArray(a.queries) ? a.queries.join(" ") : String(a.query ?? "")
        } catch { /* args 非 JSON：留空 */ }
        const skey = "search:" + tid
        state.events.push(uiEvent(state, state._blocks.has(skey) ? "patch" : "create", "search", tid, { query, results }))
        state._blocks.set(skey, true)
        state.refMap ??= new Map()
        results.forEach((r, n) => {
          const key = `${tid}#${refIndexes[n]}`
          const hit = state.citations.find(c => c.url === r.url)
          if (hit) { state.refMap.set(key, hit.index); return }
          const cite = { index: state.citations.length + 1, title: r.title, url: r.url, quote: r.snippet }
          state.citations.push(cite)
          state.refMap.set(key, cite.index)
        })
      }
    }
  }
  if (block.artifact) {
    const key = "artifact:" + (block.artifact.artifactId || id)
    const seen = state._blocks.has(key)
    state._blocks.set(key, true)
    state.events.push(uiEvent(state, seen ? "patch" : "create", "preview", block.artifact.artifactId || id, {
      title: block.artifact.title || "artifact",
      body: typeof block.artifact.content === "string" ? block.artifact.content : JSON.stringify(block.artifact.type ?? ""),
    }))
  }
}

// set(全量) 更新：旧快照可能已并入 state.text，取尾部替换
function replaceTail(text, oldSnap, newSnap) {
  if (!oldSnap) return newSnap
  if (text.endsWith(oldSnap)) return text.slice(0, text.length - oldSnap.length) + newSnap
  return newSnap // 无法定位旧值，退化为整体替换
}

















