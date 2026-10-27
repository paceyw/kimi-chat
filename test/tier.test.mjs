// 思考档位 → 上游请求：选了档位就必须把 thinking 打开（Instant 的思考与联网搜索是一体的，
// 实测 2026-10-27：thinking=false 时服务端不挂 web_search 工具，force=true 也不搜）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { tierToRequest } from "../src/kimi-api.mjs"

const models = { chatModel: "k28-instant", agentModel: "k3d1-agent", thinkingModel: "k3-agent" }

test("fast tier: an explicit effort switches thinking on", () => {
  const req = tierToRequest("fast", "hi", { search: true, reasoningEffort: "low", models })
  assert.equal(req.options.model, "k28-instant")
  assert.equal(req.options.reasoningEffort, 3)
  assert.equal(req.options.thinking, true)
})

test("fast tier: no effort keeps the plain (non-thinking) request", () => {
  const req = tierToRequest("fast", "hi", { search: true, models })
  assert.equal(req.options.thinking, undefined)
  assert.equal(req.options.reasoningEffort, undefined)
})

test("fast tier: an effort above the Instant range is clamped and still thinks", () => {
  const req = tierToRequest("fast", "hi", { reasoningEffort: "max", models })
  assert.equal(req.options.reasoningEffort, 5)
  assert.equal(req.options.thinking, true)
})

test("dynamic spec: effort turns thinking on even when the catalog says thinking=false", () => {
  const spec = { scenario: 1, modelId: "k28-instant", thinking: false, reasoningEfforts: [3, 5] }
  const req = tierToRequest("kimi-k28-instant", "hi", { spec, reasoningEffort: "high", models })
  assert.equal(req.options.model, "k28-instant")
  assert.equal(req.options.thinking, true)
  assert.equal(req.options.reasoningEffort, 5)
})

test("dynamic spec: without effort the catalog's thinking flag wins", () => {
  const spec = { scenario: 6, kimiplusId: "ok-computer", modelId: "k3d1-agent", thinking: true, reasoningEfforts: [3, 5, 7] }
  const req = tierToRequest("kimi-k3d1-agent", "hi", { spec, models })
  assert.equal(req.options.model, "k3d1-agent")
  assert.equal(req.options.thinking, true)
  assert.equal(req.kimiplusId, "ok-computer")
})
