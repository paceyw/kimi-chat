// examples/html-card-renderer.js
//
// 宿主侧适配（客户端）：把插件下发的 `kimi_ui__render` × `component: "html-card"`
// 渲染成真正的卡片。零依赖、纯浏览器 ESM；Node 侧只用到 `findCardEnvelopes()` 做解析。
//
// 安全前提：`props.html` 是模型输出，属于**不可信内容**。这里一律走沙箱 iframe +
// `srcdoc` + CSP，脚本、表单、外部网络全部禁掉；绝不 `innerHTML` 进主文档。

export const UI_TOOL_PREFIX = "kimi_ui__"

/** 是否是 Agent UI Protocol 的信封（这类"工具调用"宿主不要真的去执行）。 */
export function isUiEnvelope(name) {
  return typeof name === "string" && name.startsWith(UI_TOOL_PREFIX)
}

/** 把一帧工具调用解析成卡片事件；不是卡片就返回 null。 */
export function parseCardEnvelope(name, args) {
  if (!isUiEnvelope(name)) return null
  let event = args
  if (typeof args === "string") {
    try { event = JSON.parse(args) } catch { return null }
  }
  if (!event || typeof event !== "object") return null
  if (event.component !== "html-card") return null
  const html = event.props?.html
  if (typeof html !== "string" || !html.trim()) return null
  return event
}

/** 从混流的工具调用里挑出卡片事件，按 seq 排序去重（patch 只保留最后一帧）。 */
export function findCardEnvelopes(calls) {
  const bySurface = new Map()
  for (const call of Array.isArray(calls) ? calls : []) {
    const name = call?.name ?? call?.function?.name
    const args = call?.arguments ?? call?.function?.arguments
    const event = parseCardEnvelope(name, args)
    if (!event) continue
    const key = `${event.surfaceId ?? ""}/${event.itemId ?? ""}`
    const prev = bySurface.get(key)
    if (!prev || (event.seq ?? 0) >= (prev.seq ?? 0)) bySurface.set(key, event)
  }
  return [...bySurface.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
}

/** 卡片文档的 CSP：不加载任何外部资源，只允许内联样式与 data: 图片。 */
export function cardCsp({ allowImages = true } = {}) {
  const img = allowImages ? "img-src data:;" : "img-src 'none';"
  return `default-src 'none'; style-src 'unsafe-inline'; ${img} font-src 'none'; script-src 'none'; frame-src 'none';`
}

/** 拼出要放进 iframe 的 srcdoc。 */
export function cardSrcDoc(props, options = {}) {
  const html = String(props?.html ?? "")
  const { allowImages = true, background = "transparent" } = options
  return [
    "<!doctype html>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${cardCsp({ allowImages })}">`,
    `<meta name="referrer" content="no-referrer">`,
    `<body style="margin:0;background:${background}">`,
    html,
    "</body>",
  ].join("")
}

/**
 * 渲染成沙箱 iframe。
 * @param {HTMLElement} target 容器
 * @param {{html: string, title?: string, text?: string, height?: number}} props
 * @param {{document?: Document, autoHeight?: boolean, onHeight?: (px: number) => void, maxHeight?: number}} options
 */
export function renderHtmlCard(target, props, options = {}) {
  const doc = options.document ?? globalThis.document
  if (!doc) throw new Error("renderHtmlCard needs a DOM (pass options.document)")
  const iframe = doc.createElement("iframe")
  // 关键三行：不放开 allow-scripts / allow-top-navigation / allow-popups。
  iframe.setAttribute("sandbox", "allow-same-origin")
  iframe.setAttribute("referrerpolicy", "no-referrer")
  iframe.setAttribute("loading", "lazy")
  if (props?.title) iframe.setAttribute("title", props.title)
  iframe.style.cssText = "width:100%;border:0;display:block;background:transparent"
  if (typeof props?.height === "number") iframe.style.height = `${props.height}px`
  iframe.srcdoc = cardSrcDoc(props, options)
  const measure = () => {
    const root = iframe.contentDocument?.documentElement
    if (!root) return
    const raw = root.scrollHeight
    const px = options.maxHeight ? Math.min(raw, options.maxHeight) : raw
    if (px > 0) {
      iframe.style.height = `${px}px`
      options.onHeight?.(px)
    }
  }
  if (options.autoHeight !== false) iframe.addEventListener("load", measure)
  if (typeof target?.append === "function") target.append(iframe)
  else if (typeof target?.appendChild === "function") target.appendChild(iframe)
  return iframe
}
