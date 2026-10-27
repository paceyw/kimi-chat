import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildCatalog, matchModelId, toProviderModels, TIER_MODELS, DEFAULT_PRICING,
  REASONING_EFFORTS, INSTANT_EFFORTS,
} from "../src/models.mjs"

test("buildCatalog keeps the three stable tiers even when the upstream list is empty", () => {
  const c = buildCatalog({ list: [] })
  assert.deepEqual(Object.keys(c.models).sort(), Object.keys(TIER_MODELS).sort())
  assert.deepEqual(c.specs, {})
  // 三档必须仍可路由（旧客户端按 kimi-fast 调用）
  assert.equal(c.models["kimi-fast"].tier, "fast")
  assert.equal(c.models["kimi-thinking"].thinking, true)
})

test("buildCatalog exposes every upstream model with its own request spec", () => {
  const c = buildCatalog({
    list: [
      { modelId: "k2d6-chat", displayName: "Instant", scenario: 1, kimiPlusId: "", thinking: false },
      { modelId: "k28-preview", displayName: "K2.8 Preview", scenario: 2, kimiPlusId: "", thinking: true },
      { modelId: "k3-agent", displayName: "K3.1 Pro", scenario: 6, kimiPlusId: "ok-computer", thinking: true },
    ],
  })
  assert.ok(c.models["kimi-k2d6-chat"])
  assert.equal(c.models["kimi-k28-preview"].name, "K2.8 Preview")
  assert.equal(c.models["kimi-k3-agent"].name, "K3.1 Pro")
  assert.deepEqual(c.specs["kimi-k3-agent"], {
    scenario: 6, kimiplusId: "ok-computer", modelId: "k3-agent", thinking: true,
    reasoningEfforts: REASONING_EFFORTS,
  })
  // 清单里的模型也要能带上“无 kimiplusId”的场景（CHAT 场景）
  assert.equal(c.specs["kimi-k2d6-chat"].kimiplusId, "")
})

test("buildCatalog deduplicates model ids and never shadows the stable tiers", () => {
  const c = buildCatalog({
    list: [
      { modelId: "k3-agent", displayName: "first", scenario: 6, thinking: true },
      { modelId: "k3-agent", displayName: "second", scenario: 6, thinking: true },
      // 服务端若真返回 kimi-fast 这种 id，slug 后正好撞上稳定档位 → 稳定档优先
      { modelId: "fast", displayName: "collide", scenario: 1, thinking: false },
    ],
  })
  assert.equal(c.models["kimi-k3-agent"].name, "first")
  assert.equal(c.models["kimi-fast"].name, TIER_MODELS["kimi-fast"].name)
  assert.equal(c.specs["kimi-fast"], undefined)
})

test("toProviderModels reports reasoning/tool capability per model", () => {
  const c = buildCatalog({ list: [{ modelId: "k2d6-chat", displayName: "Instant", thinking: false }] })
  const out = toProviderModels(c.models)
  assert.equal(out["kimi-k2d6-chat"].reasoning, false)
  assert.equal(out["kimi-thinking"].reasoning, true)
  assert.equal(out["kimi-fast"].tool_call, true)
  assert.deepEqual(out["kimi-fast"].cost, { input: 0, output: 0 })
})

test("matchModelId matches exact names first, then by prefix", () => {
  const pairs = [["K3.1 Pro", "k3d1-agent"], ["K2.8 Preview", "k2d8-preview"], ["Instant", "k28-instant"]]
  assert.equal(matchModelId("K2.8 Preview", pairs), "k2d8-preview")
  // 默认场景的菜单项只写 "K2.8"，Work 场景写 "K2.8 Preview" → 前缀匹配
  assert.equal(matchModelId("K2.8", pairs), "k2d8-preview")
  assert.equal(matchModelId("Instant", pairs), "k28-instant")
  // "K3" 太短，前缀匹配会把它错配到 "K3.1 Pro" → 故意不匹配，交给调用方用 Model.key 兜底
  assert.equal(matchModelId("K3", pairs), "")
  assert.equal(matchModelId("K9", pairs), "") // 无任何对应项时返回空，由调用方兜底
  assert.equal(matchModelId("", pairs), "")
})


test("buildCatalog falls back to Model.key when model_id is absent (K3 case)", () => {
  // 真实返回里默认场景的 "K3" 只有 key="k3"，没有 model_id
  const c = buildCatalog({
    list: [
      { modelId: "", key: "k3", displayName: "K3", scenario: 6, kimiPlusId: "ok-computer", thinking: false },
      { modelId: "k28-instant", key: "k28-instant", displayName: "Instant", scenario: 1, thinking: false },
    ],
  })
  assert.ok(c.models["kimi-k3"], "K3 不能因为缺 model_id 被丢掉")
  assert.equal(c.specs["kimi-k3"].modelId, "k3")
  // scenario=6（OK_COMPUTER）的模型才有思考强度选项；Instant(scenario=1) 没有
  assert.equal(c.models["kimi-k3"].thinking, true)
  assert.equal(c.models["kimi-k28-instant"].thinking, false)
})

test("buildCatalog tags every model with the reasoning efforts the front end offers", () => {
  // 2026-10-27 用户前端确认：Instant 只有 Low(3)/High(5)，其余三个模型 Low/High/Max(3/5/7)
  const c = buildCatalog({
    list: [
      { modelId: "k28-instant", displayName: "Instant", scenario: 1, thinking: false },
      { modelId: "k2d8-preview", displayName: "K2.8", scenario: 6, kimiPlusId: "ok-computer", thinking: true },
      { modelId: "k3d1-agent", displayName: "K3.1 Pro", scenario: 6, kimiPlusId: "ok-computer", thinking: true },
      { modelId: "", key: "k3", displayName: "K3", scenario: 6, kimiPlusId: "ok-computer", thinking: false },
    ],
  })
  // Instant（CHAT 场景）只开两档
  assert.deepEqual(c.models["kimi-k28-instant"].reasoningEfforts, INSTANT_EFFORTS)
  assert.deepEqual(c.specs["kimi-k28-instant"].reasoningEfforts, INSTANT_EFFORTS)
  // 其余三个模型三档齐全（models 与 specs 都带，请求层才拿得到）
  for (const id of ["kimi-k2d8-preview", "kimi-k3d1-agent", "kimi-k3"]) {
    assert.deepEqual(c.models[id].reasoningEfforts, REASONING_EFFORTS, `${id} models`)
    assert.deepEqual(c.specs[id].reasoningEfforts, REASONING_EFFORTS, `${id} specs`)
  }
  // 三档语义入口同样带档位：fast=Instant 两档，thinking/agent 三档
  assert.deepEqual(c.models["kimi-fast"].reasoningEfforts, INSTANT_EFFORTS)
  assert.deepEqual(c.models["kimi-thinking"].reasoningEfforts, REASONING_EFFORTS)
  assert.deepEqual(c.models["kimi-agent"].reasoningEfforts, REASONING_EFFORTS)
  // 常量本身：3=LOW / 5=HIGH / 7=MAX
  assert.deepEqual(REASONING_EFFORTS, [3, 5, 7])
  assert.deepEqual(INSTANT_EFFORTS, [3, 5])
})

test("toProviderModels takes prices from DEFAULT_PRICING and falls back to 0", () => {
  const c = buildCatalog({
    list: [
      { modelId: "k28-instant", displayName: "Instant", scenario: 1, thinking: false },
      { modelId: "k2d8-preview", displayName: "K2.8", scenario: 6, thinking: true },
      { modelId: "k3d1-agent", displayName: "K3.1 Pro", scenario: 6, thinking: true },
    ],
  })
  // DEFAULT_PRICING 覆盖了实测的四个 model_id 入口 + 三档
  for (const id of ["kimi-k28-instant", "kimi-k2d8-preview", "kimi-k3d1-agent", "kimi-k3", "kimi-fast", "kimi-thinking", "kimi-agent"]) {
    assert.ok(DEFAULT_PRICING[id], `${id} 应有价格常量`)
  }
  assert.deepEqual(DEFAULT_PRICING["kimi-k28-instant"], { input: 2, output: 8 })
  assert.deepEqual(DEFAULT_PRICING["kimi-k2d8-preview"], { input: 4, output: 16 })
  assert.deepEqual(DEFAULT_PRICING["kimi-k3"], { input: 8, output: 32 })
  const out = toProviderModels(c.models, { pricing: DEFAULT_PRICING })
  assert.deepEqual(out["kimi-k28-instant"].cost, { input: 2, output: 8 })
  assert.deepEqual(out["kimi-k2d8-preview"].cost, { input: 4, output: 16 })
  assert.deepEqual(out["kimi-k3d1-agent"].cost, { input: 8, output: 32 })
  assert.deepEqual(out["kimi-fast"].cost, { input: 2, output: 8 })
  // 表里没有的模型不猜价，记 0（仍可正常列出）
  const unknown = toProviderModels({ "kimi-new-model": { name: "new", thinking: true } }, { pricing: DEFAULT_PRICING })
  assert.deepEqual(unknown["kimi-new-model"].cost, { input: 0, output: 0 })
})

