import { test } from "node:test"
import assert from "node:assert/strict"
import { buildUsage, estimateTokens } from "../src/tokens.mjs"

test("estimateTokens counts CJK per character and latin per ~4 characters", () => {
  assert.equal(estimateTokens(""), 0)
  assert.equal(estimateTokens("北京天气"), 4)
  assert.equal(estimateTokens("hello world"), 3)
  assert.ok(estimateTokens("今天 weather 怎么样") > 4)
})

test("buildUsage returns OpenAI-shaped counters with zero cached tokens", () => {
  const usage = buildUsage({ promptText: "你好", outputText: "今天是 2026 年", reasoningText: "" })
  assert.equal(usage.prompt_tokens, 2)
  assert.ok(usage.completion_tokens > 0)
  assert.equal(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens)
  assert.deepEqual(usage.prompt_tokens_details, { cached_tokens: 0 })
  assert.deepEqual(usage.completion_tokens_details, { reasoning_tokens: 0 })
})

test("buildUsage folds reasoning text into completion tokens", () => {
  const plain = buildUsage({ outputText: "答案" })
  const withThink = buildUsage({ outputText: "答案", reasoningText: "先想一想再说" })
  assert.equal(withThink.completion_tokens_details.reasoning_tokens, 6)
  assert.ok(withThink.completion_tokens > plain.completion_tokens)
})
