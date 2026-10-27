export const PROVIDER = "kimi-chat"
export const NAME = "Kimi Chat (Web)"
export const ORIGIN = process.env.KIMI_CHAT_ORIGIN || "https://www.kimi.com"

// 稳定的三档入口（真实上游 model id 由 GetAvailableModels 动态解析，见 kimi-api.resolveModels）：
//   kimi-fast     = Instant 对话档（scenario CHAT）
//   kimi-thinking = 思考档（复用 agent 模型，思考长度实测最稳）
//   kimi-agent    = Agent 档（scenario OK_COMPUTER）
// 上游返回的其他模型会另生成 kimi-<slug> 入口，不覆盖这三档。
export const MODELS = {
  "kimi-fast": { tier: "fast", thinking: false, name: "Kimi Chat Fast", search: true },
  "kimi-thinking": { tier: "thinking", thinking: true, name: "Kimi Chat Thinking", search: true },
  "kimi-agent": { tier: "agent", thinking: true, name: "Kimi Chat Light Agent", search: true },
}

export const LIMITS = {
  maxMessages: 512,
  maxPromptCharacters: 500_000,
  maxOutputCharacters: 1_000_000,
  requestTimeoutMs: 120_000,
}
