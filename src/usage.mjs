// 订阅用量 → magpie `auth.usage` 的映射（纯函数，便于单测）。
//
// 数据来自 MembershipService（2026-10-27 实测，见 PROTOCOL.md §14）：
//   GetSubscriptionStats{} → {
//     ratelimitCode5h: { ratio, enabled, resetTime },     // 5 小时限流窗口
//     ratelimitCode7d: { ratio, enabled, resetTime },     // 每周限流窗口
//     subscriptionBalance: { amountUsedRatio, expireTime, kimiCodeUsedRatio, ... }  // 月额度
//   }
// 只对外输出**月额度**一个窗口：回答"这个月花了多少 / 还剩多少"。
// ratelimitCode5h/7d 是限流器的内部计数（高频请求时才会动），展示出来只会误导，故直接不映射。
// magpie 的 usage 契约里 windows[].used 是"百分比 0–100"，所以这里要 ×100。
// 金额换算用套餐价（环境变量 KIMI_PLAN_CNY，默认 199），只作展示，不参与任何限流判断。

export const DEFAULT_PLAN_CNY = 199

const pct = (ratio) => Number((Number(ratio) * 100).toFixed(2))

export function toUsageReport(stats, { priceCny = DEFAULT_PLAN_CNY, planName = "" } = {}) {
  const windows = []
  const sb = stats?.subscriptionBalance ?? {}
  const usedRatio = typeof sb.amountUsedRatio === "number" ? sb.amountUsedRatio : null
  let balance = ""
  if (usedRatio !== null && Number.isFinite(priceCny) && priceCny > 0) {
    const usedPct = pct(usedRatio)
    const spent = usedRatio * priceCny
    const left = (1 - usedRatio) * priceCny
    windows.push({
      name: "月额度",
      used: usedPct,
      resetsAt: sb.expireTime || undefined,
      // 同时给出"百分比 ≈ 多少钱"，省得客户端再算
      display: `已用 ${usedPct.toFixed(2)}% ≈ ¥${spent.toFixed(2)} / ¥${priceCny}`,
    })
    balance = `月额度剩余 ${(100 - usedPct).toFixed(2)}%（≈¥${left.toFixed(2)} / ¥${priceCny}）`
  }
  // 套餐名来自 MembershipService/GetSubscription 的 goods.title（形如 "<plan name>"）；
  // 拿不到就退回泛称，不显示空括号。
  const name = String(planName ?? "").trim()
  const plan = !(Number.isFinite(priceCny) && priceCny > 0)
    ? "Kimi 会员"
    : name
      ? `${name}（月付 ¥${priceCny}）`
      : `Kimi 会员（月付 ¥${priceCny}）`
  return {
    plan,
    until: sb.expireTime || "",
    balance,
    windows,
    error: "",
  }
}

// 明细最近一条：`ListBalanceActions` 返回 actions[]（最新的在前），
// 每条形如 { feature, title, items: [{ amountRatio }], timestamp }。
// 只取最近一次扣费做一行摘要，用于回答"这轮大概花了多少"（`auth.usage` 不再拼进 user，
// 只保留函数供按需调用/单测）。
export function recentUsageLine(actions, { priceCny = DEFAULT_PLAN_CNY } = {}) {
  const list = actions?.actions ?? []
  const ratioOf = (a) => {
    const r = Number(a?.items?.[0]?.amountRatio ?? a?.amountRatio)
    return Number.isFinite(r) ? r : null
  }
  // 便宜档（Instant）常被记成 0%（amountRatio 缺省），所以取"最近一条有扣费记录的"，
  // 全都缺省时退回第一条按 0% 显示，避免整行消失。
  const a = list.find((x) => ratioOf(x) !== null) ?? list[0]
  if (!a) return ""
  const ratio = ratioOf(a) ?? 0
  const pct = (ratio * 100).toFixed(2)
  const yuan = Number.isFinite(priceCny) && priceCny > 0 ? `（≈¥${(ratio * priceCny).toFixed(2)}）` : ""
  // title 本身已带档位前缀（如 "<tier>: xxx"），不要再拼 feature
  const title = String(a.title ?? a.name ?? "").trim()
  return `最近一次用量：${title || "未命名会话"} ${pct}%${yuan}`
}
