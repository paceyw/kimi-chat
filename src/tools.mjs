// tools.mjs — 客户端工具定义（OpenAI tools）↔ Kimi 网页对话的桥。
//
// Kimi 网页 Chat 没有 OpenAI 那样的一等工具调用协议：模型只输出文本。
// 因此我们做两件事：
//   1) 把客户端声明的工具渲染成提示词里的一段"工具手册"，规定唯一输出格式；
//   2) 从模型正文里把 <tool_call>{...}</tool_call> 抠出来，转成 OpenAI tool_calls。
// 这样可以在任意 OpenAI 兼容客户端里跑通工具循环，而不依赖上游私有工具系统。

export const TOOL_CALL_OPEN = "<tool_call>"
export const TOOL_CALL_CLOSE = "</tool_call>"

// 兼容模型常见的几种"自创"写法：<tool_call>、<tool-call>、（偶发）```tool_call 围栏
const OPEN_RE = /<(?:tool[-_]call|tool_call)>/i
const CLOSE_RE = /<\/(?:tool[-_]call|tool_call)>/i

/** 把 OpenAI tools 数组渲染成提示词段落；没有工具时返回空串。 */
export function toolPrompt(tools) {
  const defs = (Array.isArray(tools) ? tools : [])
    .map((t) => t?.function ?? t)
    .filter((f) => f && typeof f.name === "string" && f.name)
  if (!defs.length) return ""
  const lines = [
    "# Tool calling",
    "",
    "You may call exactly one tool per reply. To call a tool, output ONLY this block and nothing after it:",
    TOOL_CALL_OPEN + '{"name":"<tool name>","arguments":{<json arguments>}}' + TOOL_CALL_CLOSE,
    "",
    "Rules:",
    "- Use a tool only when it is needed to answer or to make progress; otherwise answer normally in prose.",
    "- `arguments` must be a single JSON object that satisfies the tool's JSON schema.",
    "- Never wrap the block in code fences, never explain the call, and never write anything after the closing tag.",
    "- After you output the block, the caller will run the tool and return its result as a `[tool result]` message.",
    "",
    "Available tools:",
  ]
  for (const f of defs) {
    const desc = String(f.description ?? "").replace(/\s+/g, " ").trim()
    const params = f.parameters && typeof f.parameters === "object" ? JSON.stringify(f.parameters) : '{"type":"object","properties":{}}'
    lines.push(`- ${f.name}: ${desc || "(no description)"}`)
    lines.push(`  parameters: ${params}`)
  }
  return lines.join("\n")
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

/**
 * 从累计正文里切出"干净的正文"和"已完成的工具调用"。
 * 约定：正文是所有 <tool_call> 块之外的文本；未闭合的块（流式常见）整段先不暴露，
 * 保证对外正文单调增、不会漏出半截标记。
 */
// 流式下标记会被切成两半（"...<tool_call" 还没有 ">"）。这段尾巴必须扣住不发，
// 否则客户端会看到半截原始标记，而且下一帧的干净文本前缀会错位。
const MARKERS = ["<tool_call>", "</tool_call>", "<tool-call>", "</tool-call>"]
function trimPartialMarker(s) {
  let cut = s.length
  for (const m of MARKERS) {
    for (let len = Math.min(m.length - 1, s.length); len > 1; len--) {
      if (s.endsWith(m.slice(0, len))) { cut = Math.min(cut, s.length - len); break }
    }
  }
  return s.slice(0, cut)
}

export function scanToolCalls(text) {
  const src = String(text ?? "")
  if (!src) return { text: "", calls: [] }
  let out = ""
  const calls = []
  let i = 0
  for (;;) {
    const open = src.slice(i).search(OPEN_RE)
    if (open < 0) { out += trimPartialMarker(src.slice(i)); break }
    const abs = i + open
    out += src.slice(i, abs)
    const rest = src.slice(abs)
    const close = rest.search(CLOSE_RE)
    if (close < 0) break // 未闭合：丢弃这一段尾巴（下一帧再说）
    const openTag = rest.match(OPEN_RE)[0]
    const rawInner = rest.slice(openTag.length, close)
    const call = parseCallArgs(rawInner)
    if (call) calls.push(call)
    i = abs + close + rest.slice(close).match(CLOSE_RE)[0].length
  }
  return { text: out, calls }
}

let callSeq = 0
/** OpenAI 流式 tool_calls 增量 */
export function toolCallDelta(call, index) {
  return {
    index,
    id: `call_${(callSeq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  }
}
