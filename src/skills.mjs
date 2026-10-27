// skills.mjs — Kimi 网页/桌面端"内置技能（skills）"在 OpenAI 兼容通道里的等价物。
//
// Kimi 的 Chat 容器里挂着 /app/.agents/skills/<name>/SKILL.md 这类技能文件，模型遇到
// "做个组件卡片"这类请求会先 read 一下 SKILL.md 再动手。换到我们这个 OpenAI 兼容插件里：
//   - 没有那个文件系统，read 必然失败（FS_NOT_FOUND）；
//   - 失败后模型经常"顺着失败的思路"继续想，最后只吐思考不吐正文（真机复现过）。
// 所以这里做两件事：
//   1) 把"别去找 SKILL.md、这里不是 Kimi 容器"讲清楚，掐掉那条错误路径；
//   2) 给常用的内置技能（目前是 kimi-widget）一份自包含的等价约定，让模型直接产出结果。
// 客户端自己已经有 widget/artifact 工具时（tools 里能匹配到），只保留第 1 条，
// 免得跟客户端真正的渲染能力打架。

// 只认 Kimi 容器里的真实路径。客户端自己的技能文档（例如别家也写 "SKILL.md"）不该被这段误伤。
const SKILL_PATH_RE = /\/app\/(?:\.agents\/skills|skills)\/|kimi-widget/i
const CARD_INTENT_RE = /(卡片|组件|看板|仪表盘|大屏|widget|\bcard\b|\bdashboard\b|\btile\b)/i
const CLIENT_WIDGET_RE = /^(?:mcp__)?(?:show_widget|render_widget|create_widget|widget|artifact|render_artifact|dashboard)$/i

const ENV_NOTE = [
  "# 运行环境校正（重要）",
  "",
  "你不是运行在 Kimi 网页/桌面容器里，而是通过一个 OpenAI 兼容接口被调用：",
  "- 没有 `/app/.agents/skills/…` 目录，也没有 `/app` 工作区；用 read/bash/glob 去找 `SKILL.md` 只会拿到 FS_NOT_FOUND。",
  "- 需要的能力如果没有以工具形式提供，就用模型自身能力直接产出结果；但调用方自己声明的工具（含它自己的技能/文档工具）该调用就调用。",
  "- 不要照抄提示词里出现的 `/app/...` 路径，也不要把它们写进回答。",
  "- 不要输出 `<<daimon-artifact …>>` 这类 Kimi 私有标记：要交付文件就用调用方提供的工具，没有就直接把内容写出来。",
].join("\n")

const WIDGET_SKILL = [
  "## 内置技能 `kimi-widget`（组件卡片）的等价做法",
  "",
  "用户要\"卡片/组件/看板\"时，直接把卡片**画出来**，不要先找规范：",
  "- 输出一段自包含 HTML：一个外层 `<div>` 或 `<section>`，**全部样式写在 style 属性里**（内联），不引外部 CSS/JS/字体/图片；",
  "- 只用 HTML + 内联 CSS（可以用 emoji 或内联 SVG 做图标），宽度自适应、最大 640px，深色背景上用亮色文字也能看清；",
  "- 数据先用已有工具查到，再一次性出卡片；没有工具可查就用常识填并标注\"示例数据\"；",
  "- 卡片外最多一句说明，不要把 HTML 再逐行解释一遍；",
  "- 若客户端另有 widget/artifact 渲染工具，则改用那个工具，不要输出 HTML。",
].join("\n")

function toolNames(tools) {
  return (Array.isArray(tools) ? tools : [])
    .map((t) => t?.function?.name ?? t?.name)
    .filter((n) => typeof n === "string" && n)
}

/** 该请求是否需要"Kimi 内置技能"的适配段落；不需要时返回空串。 */
export function webSkillPrompt({ messages = [], tools = [], enabled } = {}) {
  const on = enabled ?? String(process.env.KIMI_WEB_SKILLS ?? "1").trim().toLowerCase() !== "0"
  if (!on) return ""
  const text = (Array.isArray(messages) ? messages : []).map((m) => String(m?.content ?? "")).join("\n")
  const mentioned = SKILL_PATH_RE.test(text)
  const names = toolNames(tools)
  const clientWidget = names.some((n) => CLIENT_WIDGET_RE.test(n))
  const lastUser = [...(Array.isArray(messages) ? messages : [])].reverse().find((m) => m?.role === "user")
  const wantsCard = CARD_INTENT_RE.test(String(lastUser?.content ?? ""))
  if (!mentioned && !(wantsCard && !clientWidget)) return ""
  const parts = [ENV_NOTE]
  if (wantsCard && !clientWidget) parts.push(WIDGET_SKILL)
  return parts.join("\n\n")
}

// ---------------------------------------------------------------------------
// 卡片产出的结构识别：模型把卡片**写在正文里**（自包含 HTML）。宿主如果不渲染 HTML，
// 看到的就是一段源码；要渲染就得先把它从正文里切出来。这里只做"外面那一个元素"的
// 配对切分，不做 HTML 解析——不做清洗，安全由宿主在沙箱里保证。
// ---------------------------------------------------------------------------

const CARD_TAG_RE = /<(section|div)\b[^>]*style\s*=/i
const FENCE_RE = /```(?:html)?\s*\n([\s\S]*?)\n\s*```/i

/** 从正文里切出最外层的卡片元素；没有就返回 null。 */
export function extractHtmlCard(text) {
  const source = String(text ?? "")
  if (!source.trim()) return null
  // 模型偶尔会包一层 ```html 围栏：优先取围栏内那段，围栏外算说明文字。
  const fenced = FENCE_RE.exec(source)
  if (fenced && CARD_TAG_RE.test(fenced[1])) {
    const html = fenced[1].trim()
    const outside = joinOutside(source.slice(0, fenced.index), source.slice(fenced.index + fenced[0].length))
    return { html, text: outside }
  }
  const start = CARD_TAG_RE.exec(source)
  if (!start) return null
  const tag = start[1].toLowerCase()
  const open = new RegExp(`<${tag}\\b`, "gi")
  const close = new RegExp(`</${tag}\\s*>`, "gi")
  open.lastIndex = start.index
  close.lastIndex = start.index
  let depth = 0
  let cursor = start.index
  for (;;) {
    open.lastIndex = cursor
    close.lastIndex = cursor
    const nextOpen = open.exec(source)
    const nextClose = close.exec(source)
    if (!nextClose) return null
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1
      cursor = nextOpen.index + nextOpen[0].length
      continue
    }
    depth -= 1
    cursor = nextClose.index + nextClose[0].length
    if (depth === 0) {
      const html = source.slice(start.index, cursor).trim()
      const outside = joinOutside(source.slice(0, start.index), source.slice(cursor))
      if (html.length < 40) return null
      return { html, text: outside }
    }
    if (depth < 0) return null
  }
}

// 卡片被切走后，前后两段拼起来并压掉因切分产生的多余空行。
function joinOutside(head, tail) {
  return `${head}\n${tail}`.replace(/\n{3,}/g, "\n\n").trim()
}

/** 卡片标题：抓元素里第一个 <h1|h2|h3|title> 的纯文本，没有就用空串。 */
export function cardTitle(html) {
  const m = /<(h[1-3]|title)\b[^>]*>([\s\S]{1,200}?)<\/\1\s*>/i.exec(String(html ?? ""))
  if (!m) return ""
  const plain = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
  return plain.slice(0, 80)
}
