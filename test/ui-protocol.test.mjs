import { test } from "node:test"
import assert from "node:assert/strict"
import { UI_OPS, UI_COMPONENTS, uiEvent, uiToolCall, validateProps, UI_TOOL_PREFIX } from "../src/ui-protocol.mjs"

test("uiEvent builds valid envelopes and rejects bad ops", () => {
  const event = uiEvent("create", { surfaceId: "s1", itemId: "i1", seq: 1, component: "preview-card", props: { title: "T" } })
  assert.equal(event.v, 1)
  assert.equal(event.op, "create")
  assert.throws(() => uiEvent("explode", { surfaceId: "s", itemId: "i", seq: 1 }), /invalid UI op/)
  assert.throws(() => uiEvent("create", { surfaceId: "s", itemId: "i", seq: "1", component: "c" }), /integer seq/)
  assert.throws(() => uiEvent("patch", { surfaceId: "s", itemId: "i", seq: 2 }), /requires component/)
})

test("validateProps checks whitelist schemas", () => {
  assert.equal(validateProps("search-results", {
    query: "q",
    results: [{ title: "t", url: "https://a", snippet: "s" }],
  }), null)
  assert.match(validateProps("search-results", { query: "q", results: [{ title: "t" }] }), /url: required/)
  assert.match(validateProps("no-such", {}), /unknown component/)
  assert.match(validateProps("data-chart", { kind: "pie", points: [{ x: 1 }] }), /expected one of/)
  assert.match(validateProps("citation-list", { citations: [{ index: 0, title: "t", url: "u" }] }), /below minimum/)
})

test("uiToolCall wraps events with reserved prefix", () => {
  const call = uiToolCall(uiEvent("create", { surfaceId: "s", itemId: "i", seq: 3, component: "agent-timeline", props: { steps: [{ kind: "search", label: "x" }] } }))
  assert.ok(call.function.name.startsWith(UI_TOOL_PREFIX))
  assert.equal(JSON.parse(call.function.arguments).seq, 3)
})
