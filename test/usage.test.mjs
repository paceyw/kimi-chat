import { test } from "node:test"
import assert from "node:assert/strict"
import { toUsageReport, recentUsageLine, DEFAULT_PLAN_CNY } from "../src/usage.mjs"

// 样本来自 2026-10-27 真实响应（GetSubscriptionStats）
const SAMPLE = {
  ratelimitCode5h: { ratio: 0.0025, enabled: true, resetTime: "2026-10-27T05:48:48.497897Z" },
  ratelimitCode7d: { ratio: 0.0005, enabled: true, resetTime: "2026-11-02T06:48:48.497897Z" },
  subscriptionBalance: {
    feature: "FEATURE_OMNI", type: "SUBSCRIPTION", unit: "UNIT_CREDIT",
    amountUsedRatio: 0.0688, kimiCodeUsedRatio: 0.0435,
    expireTime: "2026-11-20T06:48:48.500820Z",
  },
}

test("toUsageReport maps the monthly quota into one percent window plus yuan", () => {
  const r = toUsageReport(SAMPLE)
  assert.equal(r.plan, `Kimi 会员（月付 ¥${DEFAULT_PLAN_CNY}）`)
  assert.equal(r.until, "2026-11-20T06:48:48.500820Z")
  // 只输出月额度窗口：5 小时/每周限流计数不展示
  assert.equal(r.windows.length, 1)
  assert.deepEqual(r.windows, [{
    name: "月额度",
    used: 6.88,
    resetsAt: "2026-11-20T06:48:48.500820Z",
    display: `已用 6.88% ≈ ¥13.69 / ¥${DEFAULT_PLAN_CNY}`,
  }])
  assert.equal(r.balance, `月额度剩余 93.12%（≈¥185.31 / ¥${DEFAULT_PLAN_CNY}）`)
  assert.equal(r.error, "")
})

test("toUsageReport never surfaces the 5h / weekly ratelimit windows", () => {
  // 只有限流窗口、没有月额度时，windows 必须为空（而不是冒出来两条假窗口）
  const r = toUsageReport({
    ratelimitCode5h: { ratio: 0.5, enabled: true, resetTime: "2026-10-27T05:48:48.497897Z" },
    ratelimitCode7d: { ratio: 0.1, enabled: true, resetTime: "2026-11-02T06:48:48.497897Z" },
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
  assert.equal(r.windows[0].display, "已用 6.88% ≈ ¥6.81 / ¥99")
  assert.equal(toUsageReport(SAMPLE, { priceCny: 99, planName: "ExamplePlan" }).plan, "ExamplePlan（月付 ¥99）")
})

test("recentUsageLine summarises the newest balance action", () => {
  const line = recentUsageLine({ actions: [{ feature: "FEATURE_K3", title: "Kimi会员权益查询", items: [{ amountRatio: 0.0009 }] }, { title: "older", items: [{ amountRatio: 0.5 }] }] })
  assert.equal(line, "最近一次用量：Kimi会员权益查询 0.09%（≈¥0.18）")
  // Instant 档常缺 amountRatio，要跳到最近一条有扣费的记录，而不是显示 0%
  assert.equal(recentUsageLine({ actions: [{ title: "Instant: 问答 (3)", items: [{}] }, { title: "K3: 问答 (2)", items: [{ amountRatio: 0.0008 }] }] }), "最近一次用量：K3: 问答 (2) 0.08%（≈¥0.16）")
  assert.equal(recentUsageLine({ actions: [] }), "")
  assert.equal(recentUsageLine(null), "")
})
