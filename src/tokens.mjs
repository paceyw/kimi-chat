// Token 估算：Kimi 的 Chat gRPC 流里没有任何 token 计数
// （ChatResponse.usage 只有 usage.research = 联网搜索配额；
//   唯一的 prompt_tokens/completion_tokens/cached_tokens 在 kimi.chatty.v1.Usage，
//   那个服务不在我们的调用链上）。所以这里按字符估算，只用于让客户端/网关
//   能看到"大致用量 + 按价目折算的价格"，不是上游账单口径。
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\u31f0-\u31ff\uac00-\ud7af]/

export function estimateTokens(text) {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of String(text)) {
    if (CJK.test(ch)) cjk++
    else other++
  }
  // 中文/日文/韩文大约 1 字 ≈ 1 token；拉丁文大约 4 字符 ≈ 1 token
  return Math.max(1, Math.round(cjk + other / 4))
}

// OpenAI 形状的 usage。cached_tokens 恒 0：网页版对同一会话做服务端前缀缓存，
// 但接口不回报命中量，这里不编造。
export function buildUsage({ promptText = "", outputText = "", reasoningText = "" } = {}) {
  const prompt = estimateTokens(promptText)
  const reasoning = estimateTokens(reasoningText)
  const completion = estimateTokens(outputText) + reasoning
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: reasoning },
  }
}
