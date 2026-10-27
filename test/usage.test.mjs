import { test } from "node:test"
import assert from "node:assert/strict"
import { toUsageReport, recentUsageLine, DEFAULT_PLAN_CNY } from "../src/usage.mjs"

// 构造样本（数值全部虚构，只用于验证换算逻辑，不对应任何真实账号）
const SAMPLE = {
  ratelimitCode5h: { ratio: 0.02, enabled: true, resetTime: "2026-01-01T00:00:00.000000Z" },
  ratelimitCode7d: { ratio: 0.05, enabled: true, resetTime: "2026-01-07T00:00:00.000000Z" },
  subscriptionBalance: {
    feature: "FEATURE_OMNI", type: "SUBSCRIPTION", unit: "UNIT_CREDIT",
    amountUsedRatio: 0.25, kimiCodeUsedRatio: 0.01,
    expireTime: "2026-02-01T00:00:00.000000Z",
  },
}

test("toUsageReport maps the monthly quota into one percent window plus yuan", () => {
  const r = toUsageReport(SAMPLE)
  assert.equal(r.plan, `Kimi 会员（月付 ¥${DEFAULT_PLAN_CNY}）`)
  assert.equal(r.until, "2026-02-01T00:00:00.000000Z")
  // 只输出月额度窗口：5 小时/每周限流计数不展示
  assert.equal(r.windows.length, 1)
  assert.deepEqual(r.windows, [{
    name: "月额度",
    used: 25,
    resetsAt: "2026-02-01T00:00:00.000000Z",
    display: `已用 25.00% ≈ ¥49.75 / ¥${DEFAULT_PLAN_CNY}`,
  }])
  assert.equal(r.balance, `月额度剩余 75.00%（≈¥149.25 / ¥${DEFAULT_PLAN_CNY}）`)
  assert.equal(r.error, "")
})

test("toUsageReport never surfaces the 5h / weekly ratelimit windows", () => {
  // 只有限流窗口、没有月额度时，windows 必须为空（而不是冒出来两条假窗口）
  const r = toUsageReport({
    ratelimitCode5h: { ratio: 0.5, enabled: true, resetTime: "2026-01-01T00:00:00.000000Z" },
    ratelimitCode7d: { ratio: 0.1, enabled: true, resetTime: "2026-01-07T00:00:00.000000Z" },
  })
  assert.deepEqual(r.windows, [])
  assert.equal(r.balance, "")
  assert.equal(r.until, "")
})

test("toUsageReport passes the plan name from GetSubscription through", () => {
  const r = toUsageReport(SAMPLE, { planName: "ExamplePlan" })
  assert.equal(r.plan, `ExamplePlan（月付 ¥${DEFAULT_PLAN_CNY}）`)
  // 套餐名缺失/空白 → 退回泛称
  assert.equal(toUsageReport(SAMPLE, { planName: "  " }).plan, `Kimi 会员（月付 ¥${DEFAULT_PLAN_CNY}）`)
  assert.equal(toUsageReport(SAMPLE, { planName: null }).plan, `Kimi 会员（月付 ¥${DEFAULT_PLAN_CNY}）`)
})

test("toUsageReport honours a custom plan price", () => {
  const r = toUsageReport(SAMPLE, { priceCny: 99 })
  assert.equal(r.plan, "Kimi 会员（月付 ¥99）")
  assert.equal(r.windows[0].display, "已用 25.00% ≈ ¥24.75 / ¥99")
  assert.equal(toUsageReport(SAMPLE, { priceCny: 99, planName: "ExamplePlan" }).plan, "ExamplePlan（月付 ¥99）")
})

test("recentUsageLine summarises the newest balance action", () => {
  const line = recentUsageLine({ actions: [{ feature: "FEATURE_CHAT", title: "Example: chat (3)", items: [{ amountRatio: 0.0009 }] }, { title: "older", items: [{ amountRatio: 0.5 }] }] })
  assert.equal(line, "最近一次用量：Example: chat (3) 0.09%（≈¥0.18）")
  // 便宜档常缺 amountRatio，要跳到最近一条有扣费的记录，而不是显示 0%
  assert.equal(recentUsageLine({ actions: [{ title: "Example: instant (3)", items: [{}] }, { title: "Example: agent (2)", items: [{ amountRatio: 0.0008 }] }] }), "最近一次用量：Example: agent (2) 0.08%（≈¥0.16）")
  assert.equal(recentUsageLine({ actions: [] }), "")
  assert.equal(recentUsageLine(null), "")
})
