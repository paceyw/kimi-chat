import { test } from "node:test"
import assert from "node:assert/strict"
import { validateMessages, toPrompt, messageText, chunk, finishReason } from "../src/openai.mjs"

test("validateMessages accepts text roles and rejects unknown shapes", () => {
  validateMessages([
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello", tool_calls: [{ function: { name: "f", arguments: "{}" } }] },
    { role: "tool", content: "result" },
    { role: "assistant" },
  ])
  assert.throws(() => validateMessages([{ role: "wizard", content: "x" }]), /role is invalid/)
  assert.throws(() => validateMessages([{ role: "user", content: 42 }]), /content must be text/)
  assert.throws(() => validateMessages([{ role: "user", content: [{ type: "image_url" }] }]), /text messages only/)
})

test("toPrompt flattens history with tool calls and results", () => {
  const prompt = toPrompt([
    { role: "system", content: "sys" },
    { role: "user", content: "question" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "search", arguments: "{\"q\":\"x\"}" } }] },
    { role: "tool", content: "found it" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "again" },
  ])
  assert.ok(prompt.includes("sys"))
  assert.ok(prompt.includes("question"))
  // 历史工具调用用方括号叙述——不能出现 `<tool_call>`/`<function=…>`，
  // 否则上游会把标签照抄成正文（实测搜索问题）。
  assert.ok(prompt.includes("[called search with {\"q\":\"x\"}]"))
  assert.ok(!prompt.includes("<tool_call>"))
  assert.ok(!prompt.includes("<function="))
  assert.ok(prompt.includes("[tool result] found it"))
  assert.ok(prompt.includes("Assistant: answer"))
  assert.ok(prompt.includes("User: again"))
})

test("chunk and finishReason produce standard SSE semantics", () => {
  const line = chunk("id", 123, "kimi-fast", { content: "hi" }, null)
  assert.ok(line.startsWith("data: "))
  const parsed = JSON.parse(line.slice(6))
  assert.equal(parsed.choices[0].delta.content, "hi")
  assert.equal(parsed.choices[0].finish_reason, null)
  assert.equal(finishReason("FINISHED"), "stop")
  assert.equal(finishReason("CONTENT_FILTER"), "content_filter")
  assert.equal(finishReason("CONTEXT_LENGTH_EXCEEDED"), "length")
})

test("messageText joins multimodal text parts", () => {
  assert.equal(messageText({ content: [{ type: "text", text: "a" }, "b"] }), "ab")
})
