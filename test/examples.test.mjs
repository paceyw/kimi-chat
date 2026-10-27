import { test } from "node:test"
import assert from "node:assert/strict"
import {
  cardCsp,
  cardSrcDoc,
  findCardEnvelopes,
  isUiEnvelope,
  parseCardEnvelope,
  renderHtmlCard,
} from "../examples/html-card-renderer.js"

const envelope = (props, extra = {}) => JSON.stringify({ v: 1, surfaceId: "card", itemId: "card", seq: 0, op: "create", component: "html-card", props, ...extra })

function fakeDom() {
  const listeners = {}
  const attrs = {}
  const iframe = {
    attrs,
    style: {},
    srcdoc: "",
    setAttribute(key, value) { attrs[key] = String(value) },
    getAttribute(key) { return attrs[key] },
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn) },
    fire(type) { for (const fn of listeners[type] ?? []) fn() },
    contentDocument: { documentElement: { scrollHeight: 240 } },
  }
  const document = { createElement: (tag) => (tag === "iframe" ? iframe : { tag }) }
  return { document, iframe }
}

test("isUiEnvelope only matches the reserved prefix", () => {
  assert.equal(isUiEnvelope("kimi_ui__render"), true)
  assert.equal(isUiEnvelope("kimi_ui__patch"), true)
  assert.equal(isUiEnvelope("get_weather"), false)
  assert.equal(isUiEnvelope(undefined), false)
})

test("parseCardEnvelope accepts only well-formed html-card frames", () => {
  const event = parseCardEnvelope("kimi_ui__render", envelope({ html: "<section style=\"padding:8px\">hi</section>", title: "T" }))
  assert.equal(event.component, "html-card")
  assert.equal(event.props.title, "T")
  // 非 UI 信封 / 其它组件 / 坏 JSON / 空 html 都不算卡片
  assert.equal(parseCardEnvelope("get_weather", envelope({ html: "<section></section>" })), null)
  assert.equal(parseCardEnvelope("kimi_ui__render", JSON.stringify({ component: "citation-list", props: {} })), null)
  assert.equal(parseCardEnvelope("kimi_ui__render", "{not json"), null)
  assert.equal(parseCardEnvelope("kimi_ui__render", envelope({ html: "   " })), null)
})

test("findCardEnvelopes keeps the newest frame per surface and sorts by seq", () => {
  const calls = [
    { name: "get_weather", arguments: "{}" },
    { function: { name: "kimi_ui__render", arguments: envelope({ html: "<section style=\"a:1\">old</section>" }, { seq: 0 }) } },
    { function: { name: "kimi_ui__patch", arguments: envelope({ html: "<section style=\"a:1\">new</section>" }, { seq: 3, op: "patch" }) } },
    { function: { name: "kimi_ui__render", arguments: envelope({ html: "<div style=\"b:2\">x</div>" }, { seq: 1, surfaceId: "other", itemId: "other" }) } },
  ]
  const found = findCardEnvelopes(calls)
  assert.equal(found.length, 2)
  assert.deepEqual(found.map((e) => e.seq), [1, 3])
  assert.match(found[1].props.html, /new/)
})

test("cardCsp hard-blocks scripts and the network", () => {
  const csp = cardCsp()
  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /script-src 'none'/)
  assert.match(csp, /img-src data:/)
  assert.match(cardCsp({ allowImages: false }), /img-src 'none'/)
})

test("cardSrcDoc wraps the html with a CSP and no referrer", () => {
  const doc = cardSrcDoc({ html: "<section style=\"padding:8px\">hi</section>" })
  assert.match(doc, /^<!doctype html>/)
  assert.match(doc, /Content-Security-Policy/)
  assert.match(doc, /name="referrer" content="no-referrer"/)
  assert.ok(doc.includes("<section style=\"padding:8px\">hi</section>"))
})

test("renderHtmlCard mounts a sandboxed iframe and auto-sizes it", () => {
  const { document, iframe } = fakeDom()
  const appended = []
  const target = { append: (node) => appended.push(node) }
  const rendered = renderHtmlCard(target, { html: "<section style=\"x:1\">hi</section>", title: "北京天气" }, { document })
  assert.equal(rendered, iframe)
  assert.equal(appended[0], iframe)
  assert.equal(iframe.getAttribute("sandbox"), "allow-same-origin")
  assert.doesNotMatch(iframe.getAttribute("sandbox"), /allow-scripts/)
  assert.equal(iframe.getAttribute("title"), "北京天气")
  assert.ok(iframe.srcdoc.includes("<section style=\"x:1\">hi</section>"))
  iframe.fire("load")
  assert.equal(iframe.style.height, "240px")
})

test("renderHtmlCard honours an explicit height and the maxHeight cap", () => {
  const { document, iframe } = fakeDom()
  renderHtmlCard({ append() {} }, { html: "<div style=\"x:1\">hi</div>", height: 180 }, { document, autoHeight: false })
  assert.equal(iframe.style.height, "180px")

  const second = fakeDom()
  renderHtmlCard({ append() {} }, { html: "<div style=\"x:1\">hi</div>" }, { document: second.document, maxHeight: 100 })
  second.iframe.fire("load")
  assert.equal(second.iframe.style.height, "100px")
})
