// tools.mjs — 客户端工具定义（OpenAI tools）↔ Kimi 网页对话的桥。
//
// Kimi 网页 Chat 没有 OpenAI 那样的一等工具调用协议：模型只输出文本。
// 因此我们做两件事：
//   1) 把客户端声明的工具渲染成提示词里的一段"工具手册"，规定唯一输出格式；
//   2) 从模型正文里把 <tool_call>{...}</tool_call> 抠出来，转成 OpenAI tool_calls。
// 这样可以在任意 OpenAI 兼容客户端里跑通工具循环，而不依赖上游私有工具系统。
//
// 关于体积：真实客户端（如 DSH）一次会声明 300+ 个工具，完整 JSON schema 渲染出来
// 是 33 万字符级别（约 8 万 token），既贵又容易把模型带偏（它会把不存在的工具名
// 一起"脑补"出来）。所以默认走 compact 渲染：每个工具一行 `名字(参数:类型)` + 一句
// 说明，并在超出预算时自动降级（先丢说明，再只留名字），保证工具清单永远完整可见。

export const TOOL_CALL_OPEN = "<tool_call>"
export const TOOL_CALL_CLOSE = "</tool_call>"

// 兼容模型常见的几种"自创"写法：<tool_call>、<tool-call>、（偶发）```tool_call 围栏
const OPEN_RE = /<(?:tool[-_]call|tool_call)>/i
const CLOSE_RE = /<\/(?:tool[-_]call|tool_call)>/i

// 整个工具手册的默认字符预算（0 = 不限制）。
// 参考真机数据：DSH 声明 305 个工具，完整 JSON schema 渲染是 330,230 字符（约 8 万 token）；
// 48,000 字符约 1.2 万 token（7 倍压缩），每个工具仍是"一行签名 + 一句 72 字以内的说明"。
export const DEFAULT_MAX_TOOL_CHARS = 48000
const DESC_LIMIT = 160
const MAX_PARAMS_SHOWN = 8

const TYPE_ABBREV = { string: "str", number: "num", integer: "int", boolean: "bool", array: "arr", object: "obj", null: "null" }

const RULES = [
  "Rules:",
  "- Use a tool only when it is needed to answer or to make progress; otherwise answer normally in prose.",
  "- `arguments` must be a single JSON object that satisfies the tool's JSON schema.",
  "- Never wrap the block in code fences, never explain the call, and never write anything after the closing tag.",
  "- After you output the block, the caller will run the tool and return its result as a `[tool result]` message.",
]

const COMPACT_NOTE = [
  "Signatures are abbreviated: `name:type` pairs inside the parentheses, `*` marks a required property,",
  "`str/num/int/bool/arr/obj` are the JSON types, `+N` means N more properties omitted, and `\"a\"|\"b\"` lists an enum.",
]

function mode() {
  const v = String(process.env.KIMI_TOOLS_MODE ?? "auto").trim().toLowerCase()
  return v === "full" ? "full" : "compact"
}

function budget() {
  const raw = process.env.KIMI_TOOLS_MAX_CHARS
  if (raw === undefined || raw === "") return DEFAULT_MAX_TOOL_CHARS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MAX_TOOL_CHARS
}

function normalize(def) {
  const f = def?.function ?? def
  if (!f || typeof f.name !== "string" || !f.name) return null
  const params = f.parameters && typeof f.parameters === "object" ? f.parameters : { type: "object", properties: {} }
  return { name: f.name, description: String(f.description ?? ""), params }
}

function typeLabel(schema) {
  if (!schema || typeof schema !== "object") return "any"
  const e = schema.enum
  if (Array.isArray(e) && e.length > 0 && e.length <= 4 && e.every((v) => typeof v === "string")) {
    return e.map((v) => JSON.stringify(v)).join("|")
  }
  const t = schema.type
  if (Array.isArray(t)) return t.map((x) => TYPE_ABBREV[x] ?? x).join("|")
  if (typeof t === "string") return TYPE_ABBREV[t] ?? t
  if (schema.properties) return "obj"
  if (schema.items) return "arr"
  return "any"
}

/** 把 parameters 压成 `(a*, b:str, c:obj, +3)` 这样的签名。 */
export function paramSignature(params) {
  const props = params?.properties
  if (!props || typeof props !== "object") return "()"
  const required = new Set(Array.isArray(params.required) ? params.required : [])
  const names = Object.keys(props)
  if (!names.length) return "()"
  const shown = names.slice(0, MAX_PARAMS_SHOWN)
  const parts = shown.map((n) => `${n}${required.has(n) ? "*" : ""}:${typeLabel(props[n])}`)
  if (names.length > shown.length) parts.push(`+${names.length - shown.length}`)
  return `(${parts.join(", ")})`
}

/** 说明压成"第一句"：去掉调用约定的样板尾巴，压空白，限长。 */
export function slimDescription(desc, limit = DESC_LIMIT) {
  let s = String(desc ?? "").replace(/\s+/g, " ").trim()
  if (!s) return ""
  // 各家的"Calling convention:"/"调用约定:"后面是给 run_code 场景的样板文字，跟选工具无关。
  const cut = s.search(/(?:calling convention|调用约定)\s*[:：]/i)
  if (cut > 8) s = s.slice(0, cut).trim()
  const m = s.match(/^.*?[.!?。！？；](?=\s|$)/)
  if (m && m[0].length >= 12) s = m[0]
  if (s.length > limit) s = s.slice(0, limit - 1).trimEnd() + "…"
  return s.replace(/\s+$/, "")
}

// 说明的压缩阶梯：先保住"全都有说明"，再逐级整体缩短。
const DESC_LADDER = [DESC_LIMIT, 120, 96, 72, 56, 40]

/** 把说明截到 limit 字，尽量在词/句边界断开，必要时补省略号。 */
function capText(s, limit) {
  if (!s || s.length <= limit) return s ?? ""
  let cut = s.slice(0, limit - 1)
  const m = cut.match(/[\s，,、;；]/g)
  if (m) {
    const last = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("，"), cut.lastIndexOf(", "), cut.lastIndexOf("、"), cut.lastIndexOf("；"))
    if (last >= limit * 0.5) cut = cut.slice(0, last)
  }
  return cut.trimEnd().replace(/[，,、;；:：]+$/, "") + "…"
}

function buildCompact(defs, maxChars) {
  const items = defs.map((d) => ({ name: d.name, sig: paramSignature(d.params), desc: slimDescription(d.description) }))
  const head = ["# Tool calling", "",
    "You may call exactly one tool per reply. To call a tool, output ONLY this block and nothing after it:",
    TOOL_CALL_OPEN + '{"name":"<tool name>","arguments":{<json arguments>}}' + TOOL_CALL_CLOSE,
    "",
    ...RULES,
    "",
    ...COMPACT_NOTE,
    "",
    "Available tools:"].join("\n")
  const lineFor = (it, cap) => {
    const desc = cap > 0 ? capText(it.desc, cap) : ""
    return `- ${it.name}${it.sig}${desc ? ": " + desc : ""}`
  }
  const render = (cap) => [head, ...items.map((it) => lineFor(it, cap))].join("\n")
  if (!maxChars) return render(DESC_LIMIT)
  // 预算的用法：先"整体缩短说明"，而不是"把一批工具的说明整条丢掉"。
  // 说明是模型选工具的主要依据，梯度缩到 40 字左右仍远好于让一半工具变成光秃秃的名字。
  for (const cap of DESC_LADDER) {
    const text = render(cap)
    if (text.length <= maxChars) return text
  }
  // 连 40 字说明都放不下：从最长的一行开始，退到"只留名字"（仍然保留工具存在性）。
  const lines = items.map((it) => lineFor(it, DESC_LADDER[DESC_LADDER.length - 1]))
  const bare = items.map((it) => `- ${it.name}`)
  const newlineCost = 1
  let total = head.length + newlineCost + lines.reduce((a, l) => a + l.length + newlineCost, 0)
  const order = items.map((_, i) => i).sort((a, b) => lines[b].length - lines[a].length)
  for (const i of order) {
    if (total <= maxChars) break
    total -= lines[i].length - bare[i].length
    lines[i] = bare[i]
  }
  if (total <= maxChars) return [head, ...lines].join("\n")
  {
    // 极端预算：连"名字全列"都放不下时，按命名空间合并，保住工具的"存在性"。
    const grouped = new Map()
    for (const it of items) {
      const parts = it.name.split("__")
      const key = parts.length > 2 ? `${parts[0]}__${parts[1]}__*` : it.name
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key).push(parts.length > 2 ? parts.slice(2).join("__") : it.name)
    }
    const glines = []
    for (const [key, members] of grouped) glines.push(key === members[0] ? `- ${key}` : `- ${key}: ${members.join(", ")}`)
    // 预算是"软"的：宁可轻微超预算，也不让工具名从清单里消失（模型看不见就等于不存在）。
    return [head, ...glines].join("\n")
  }
}

function buildFull(defs) {
  const lines = ["# Tool calling", "",
    "You may call exactly one tool per reply. To call a tool, output ONLY this block and nothing after it:",
    TOOL_CALL_OPEN + '{"name":"<tool name>","arguments":{<json arguments>}}' + TOOL_CALL_CLOSE,
    "",
    ...RULES,
    "",
    "Available tools:"]
  for (const d of defs) {
    const desc = String(d.description ?? "").replace(/\s+/g, " ").trim()
    lines.push(`- ${d.name}: ${desc || "(no description)"}`)
    lines.push(`  parameters: ${JSON.stringify(d.params)}`)
  }
  return lines.join("\n")
}

/**
 * 把 OpenAI tools 数组渲染成提示词段落；没有工具时返回空串。
 *
 * 选项（都可被环境变量覆盖，便于线上临时调参而不用改代码）：
 *   compact  默认 true；`KIMI_TOOLS_MODE=full` 可回到旧的完整 schema 渲染
 *   maxChars 字符预算，默认 24000；`KIMI_TOOLS_MAX_CHARS=0` 关闭预算
 */
export function toolPrompt(tools, options = {}) {
  const defs = (Array.isArray(tools) ? tools : []).map(normalize).filter(Boolean)
  if (!defs.length) return ""
  const compact = options.compact ?? mode() !== "full"
  if (!compact) return buildFull(defs)
  const maxChars = options.maxChars ?? budget()
  return buildCompact(defs, maxChars)
}

function parseCallArgs(raw) {
  const t = String(raw ?? "").trim()
  if (!t) return null
  let obj = null
  try { obj = JSON.parse(t) } catch {
    // 容错：模型偶尔在 JSON 前后加解释或围栏
    const s = t.indexOf("{"), e = t.lastIndexOf("}")
    if (s >= 0 && e > s) { try { obj = JSON.parse(t.slice(s, e + 1)) } catch { obj = null } }
  }
  if (!obj || typeof obj !== "object") return null
  const name = typeof obj.name === "string" ? obj.name : typeof obj.tool === "string" ? obj.tool : ""
  if (!name) return null
  let args = obj.arguments ?? obj.args ?? obj.parameters ?? {}
  if (typeof args === "string") {
    // 有些模型把 arguments 再序列化成字符串
    const s = args.trim()
    if (s.startsWith("{")) { try { args = JSON.parse(s) } catch { /* 保留原串 */ } }
  }
  return { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) }
}

// 所有可能出现在正文里的标记写法（大小写与连字符变体）。
const MARKERS = [TOOL_CALL_OPEN, TOOL_CALL_CLOSE, "<tool-call>", "</tool-call>"]

/**
 * 流式安全：把结尾处"刚写了一半"的标记扣住不发。
 * 否则客户端会先收到 "&lt;tool_cal"，等标记闭合后又从正文里消失，UI 会闪一下。
 */
export function trimPartialMarker(text) {
  const s = String(text ?? "")
  const i = s.lastIndexOf("<")
  if (i < 0) return s
  const tail = s.slice(i)
  if (!tail.includes(">")) {
    const lower = tail.toLowerCase()
    for (const m of MARKERS) if (m.startsWith(lower) || m.toLowerCase().startsWith(lower)) return s.slice(0, i)
  }
  return s
}

/**
 * 从模型正文里抠出完整的 &lt;tool_call&gt;{...}&lt;/tool_call&gt;，返回剥离后的正文与调用列表。
 * - 未闭合的标记（流式中途）一律从正文里扣掉，等闭合后再判断；
 * - 参数解析失败（模型编造的 JSON）静默丢弃，不当成调用，避免把坏参数透给客户端。
 */
export function scanToolCalls(text) {
  const src = String(text ?? "")
  const calls = []
  let out = ""
  let cursor = 0
  const open = /<(?:tool[-_]call)>/gi
  const close = /<\/(?:tool[-_]call)>/gi
  for (;;) {
    open.lastIndex = cursor
    const o = open.exec(src)
    if (!o) break
    close.lastIndex = o.index + o[0].length
    const c = close.exec(src)
    out += src.slice(cursor, o.index)
    if (!c) { cursor = src.length; break }
    const call = parseCallArgs(src.slice(o.index + o[0].length, c.index))
    if (call) calls.push(call)
    cursor = c.index + c[0].length
  }
  out += src.slice(cursor)
  return { text: trimPartialMarker(out), calls }
}

/** 转成 OpenAI 流式增量里的 tool_calls 元素（index 由调用方给，跨 UI 事件共用一套序号）。 */
export function toolCallDelta(call, index) {
  const name = String(call?.name ?? "")
  return {
    index,
    id: call?.id ?? `call_${index}_${name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40)}`,
    type: "function",
    function: { name, arguments: call?.arguments ?? "{}" },
  }
}
