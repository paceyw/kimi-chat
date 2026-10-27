// OpenAI message helpers: validation, prompt flattening, SSE chunk shaping.
// Text-only in phase 1 (same boundary as the reference plugin).

export function messageText(message) {
  if (typeof message?.content === "string") return message.content
  if (Array.isArray(message?.content)) return message.content.map((part) => typeof part === "string" ? part : part?.text ?? "").join("")
  return ""
}

export function validateMessages(messages) {
  for (const message of messages ?? []) {
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Kimi requires message objects")
    if (!["system", "developer", "user", "assistant", "tool"].includes(message.role)) throw new Error("Kimi message role is invalid")
    if (message.content == null && message.role === "assistant") continue
    if (typeof message.content !== "string" && !Array.isArray(message.content)) throw new Error("Kimi message content must be text")
    if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (typeof part === "string" || (part?.type === "text" && typeof part.text === "string")) continue
        throw new Error("Kimi Chat provider currently supports text messages only")
      }
    }
  }
}

// Flatten an OpenAI history into a single web-chat prompt. Used when we cannot
// continue an upstream conversation (fresh session or history resend).
export function toPrompt(messages, from = 0) {
  const parts = []
  let userSpoke = false
  for (const message of (messages ?? []).slice(from)) {
    const text = messageText(message)
    if (!text && !(message.role === "assistant" && message.tool_calls?.length)) continue
    if (message.role === "system" || message.role === "developer") parts.push(text)
    else if (message.role === "assistant") {
      // 用方括号叙述历史工具调用，不用 `<tool_call>`/`<function=…>` 之类的 XML 标签：
      // 上游不了解这些标签，看到它们反而会照抄成正文（实测搜索问题会吐出
      // "<tool_call><function=web_search>…" 纯文本）。方括号是普通文字，不会被模仿成协议。
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls.map((call) => {
        const fn = call?.function
        if (!fn?.name) return ""
        const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {})
        return `[called ${fn.name} with ${args}]`
      }).filter(Boolean).join("\n") : ""
      parts.push([text ? `Assistant: ${text}` : "", calls].filter(Boolean).join("\n"))
    }
    else if (message.role === "tool") parts.push(`[tool result] ${text}`)
    else { parts.push(userSpoke ? `User: ${text}` : text); userSpoke = true }
  }
  return parts.join("\n\n")
}

export function chunk(id, created, model, delta, finish_reason = null) {
  return `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`
}

export function finishReason(status) {
  switch (status) {
    case "CONTENT_FILTER": return "content_filter"
    case "CONTEXT_LENGTH_EXCEEDED":
    case "INCOMPLETE":
    case "TIMEOUT": return "length"
    default: return "stop"
  }
}
