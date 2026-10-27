// 模型目录：把上游 GetAvailableModels 的真实返回映射成 magpie 的模型入口 + 请求规格。
//
// 为什么需要这一层：
//   - 三个固定档（fast/thinking/agent）是稳定的语义入口，但要"钉死"底层 model id 必须
//     用服务端当次返回的 id（历史上 default_chat_model 从 k2d6-chat 漂到 k28-instant）。
//   - 用户希望 magpie 里的模型清单与服务端实际返回、网页前端选项对得上，所以清单里
//     每个上游模型都单独暴露一个入口，路由时用该模型自己的 scenario/kimiplus_id/model id。
//
// 这里只做纯映射（无网络、无全局状态），便于单测。

// 思考档位（ChatRequestOptions.reasoning_effort(8)）：3=LOW / 5=HIGH / 7=MAX。
// 2026-10-27 用户前端确认（PROTOCOL.md §12.1）：
//   Instant（scenario=CHAT(1)）只有 Low/High 两档；其余三个模型（OK_COMPUTER(6)）有 Low/High/Max。
export const REASONING_EFFORTS = [3, 5, 7]
export const INSTANT_EFFORTS = [3, 5]

// 按场景选档位集合：CHAT(1) = Instant 只有低/高；其它场景（OK_COMPUTER 等）给全三档。
export const reasoningEffortsFor = (scenario) => (Number(scenario) === 1 ? INSTANT_EFFORTS : REASONING_EFFORTS)

export const TIER_MODELS = {
  "kimi-fast": { tier: "fast", thinking: false, name: "Kimi Fast (Instant)", reasoningEfforts: INSTANT_EFFORTS },
  "kimi-thinking": { tier: "thinking", thinking: true, name: "Kimi Thinking", reasoningEfforts: REASONING_EFFORTS },
  "kimi-agent": { tier: "agent", thinking: true, name: "Kimi Agent", reasoningEfforts: REASONING_EFFORTS },
}

// magpie 费用估算用的单价（¥ / 1M tokens）。
// 由月额度百分比反推的估算单价（¥/1M tokens），非官方公布价，仅用于 magpie 费用估算：
//   按 199/月 估算：100% 额度 → 1% ≈ ¥1.99；实测 K3 档一轮（14 帧 ≈ 2–3k 输出 token）扣 0.05%–0.08%
//   额度（≈¥0.10–¥0.16）→ 输出约 ¥32–53/1M，输入按 1/4 折算。这里先取保守下界（宁少不多），
//   等账单实测再校准。
// 键是 magpie 侧的模型 id（三档 + 2026-10-27 实测的四个上游 model_id 入口）；
// 清单里出现未列出的新 id 时按 0 计（不猜价），后续按实测补表。
export const DEFAULT_PRICING = {
  "kimi-fast": { input: 2, output: 8 },          // Instant
  "kimi-k28-instant": { input: 2, output: 8 },   // Instant（动态入口）
  "kimi-k2d8-preview": { input: 4, output: 16 }, // K2.8
  "kimi-k3": { input: 8, output: 32 },           // K3
  "kimi-k3d1-agent": { input: 8, output: 32 },   // K3.1 Pro
  "kimi-thinking": { input: 8, output: 32 },     // 三档 agent 走 K3 系
  "kimi-agent": { input: 8, output: 32 },
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")

// 默认场景的菜单项名与 Work 场景的名不完全一致（"K2.8" vs "K2.8 Preview"），
// 先精确匹配，再退一步做前缀匹配（任一侧是另一侧的前缀即视为同一模型）。
export function matchModelId(displayName, pairs) {
  const name = String(displayName ?? "").trim()
  if (!name) return ""
  for (const [n, id] of pairs) if (n === name) return id
  // 前缀兜底只对足够长的名字生效："K3"（2 字符）会被错配到 "K3.1 Pro"，
  // 导致 K3 与 K3.1 Pro 抢同一个 model id 而被去重丢掉。短名字交给调用方按 key 兜底。
  if (name.length >= 4) {
    for (const [n, id] of pairs) if (n.startsWith(name) || name.startsWith(n)) return id
  }
  return ""
}

export function buildCatalog({ list = [] } = {}) {
  // 三档始终保留：老客户端按这三个 id 调用，删掉会直接 404 式失败。
  const models = { ...TIER_MODELS }
  const specs = {}
  const seen = new Set()
  for (const m of Array.isArray(list) ? list : []) {
    // model_id(19) 缺失时回退到 key(15)：默认场景的 "K3" 条目只有 key="k3"，
    // 不回退会整条被丢掉（网页菜单里有、我们的清单里没有）。
    const modelId = String(m?.modelId || m?.key || "").trim()
    if (!modelId || seen.has(modelId)) continue
    seen.add(modelId)
    const id = `kimi-${slug(modelId)}`
    if (models[id]) continue // 与三档 id 撞车时让稳定档位优先
    // 思考强度是否存在：Model.thinking(5) 是模型级开关，另外 scenario=6（OK_COMPUTER）
    // 的模型才带 reasoningEffort 选项（K3.1 Pro / K2.8 / K3），Instant(scenario=1) 只有低/高两档。
    const thinking = !!m.thinking || Number(m.scenario) === 6
    const reasoningEfforts = reasoningEffortsFor(m.scenario)
    models[id] = {
      // tier 放上游 model id：真正路由用 specs[id]，tier 只作标记与日志。
      tier: modelId,
      thinking,
      name: m.displayName || modelId,
      search: true,
      reasoningEfforts,
    }
    specs[id] = {
      scenario: Number(m.scenario) || 0,
      kimiplusId: m.kimiPlusId || "",
      modelId,
      thinking,
      // 请求层按这张表夹取 reasoning_effort（tierToRequest）：模型不支持高档就不发/夹到上界。
      reasoningEfforts,
    }
  }
  return { models, specs }
}

// magpie 的模型描述（provider.models 的形状）：能力位与限额来自本地配置。
// 成本按调用方传入的 pricing 表（DEFAULT_PRICING）算，缺失的模型记 0（不猜价）。
//
// 注意：magpie 的模型条目形状里没有"可选思考档位"字段——/v1/models 的
// `supported_reasoning_levels` 由 magpie 自己的目录（models.dev）派生，插件传的
// `reasoning` 布尔也不被采用（2026-10-27 实测：kimi-chat/* 全是空数组）。所以这里
// 不塞猜测字段；档位矩阵维护在 catalog/specs，由 tierToRequest 在请求层夹取。
export function toProviderModels(models, { context = 128_000, output = 32_768, pricing = {} } = {}) {
  return Object.fromEntries(Object.entries(models).map(([id, model]) => [id, {
    name: model.name,
    reasoning: !!model.thinking,
    tool_call: true,
    attachment: false,
    limit: { context, output },
    cost: pricing[id] ?? { input: 0, output: 0 },
  }]))
}
