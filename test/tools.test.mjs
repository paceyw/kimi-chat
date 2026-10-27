import { test } from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_MAX_TOOL_CHARS, paramSignature, scanToolCalls, slimDescription, toolCallDelta, toolPrompt, trimPartialMarker } from "../src/tools.mjs"

const tool = (name, description, properties = {}, required = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
})

test("toolPrompt returns an empty string when there are no tools", () => {
  assert.equal(toolPrompt(undefined), "")
  assert.equal(toolPrompt([]), "")
  assert.equal(toolPrompt([{ type: "function", function: {} }]), "")
})

test("full mode keeps the complete JSON schema", () => {
  const defs = [tool("echo", "Echo text back.", { text: { type: "string" } }, ["text"])]
  const text = toolPrompt(defs, { compact: false })
  assert.match(text, /^- echo: Echo text back\.$/m)
  assert.match(text, /parameters: \{"type":"object","properties":\{"text":\{"type":"string"\}\},"required":\["text"\]\}/)
})

test("compact mode renders one line per tool with an abbreviated signature", () => {
  const defs = [
    tool("fs_read", "Read an existing file before overwriting it with write. Call again for more.", {
      path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" },
    }, ["path"]),
    tool("ask", "Ask the user a question.", { mode: { type: "string", enum: ["a", "b"] } }),
    tool("noargs", "No arguments."),
  ]
  const text = toolPrompt(defs, { maxChars: 0 })
  assert.match(text, /^- fs_read\(path\*:str, offset:int, limit:int\): Read an existing file before overwriting it with write\.$/m)
  assert.match(text, /^- ask\(mode:"a"\|"b"\): Ask the user a question\.$/m)
  assert.match(text, /^- noargs\(\): No arguments\.$/m)
  assert.doesNotMatch(text, /parameters:/)
})

test("compact mode caps a huge parameter list", () => {
  const props = {}
  for (let i = 0; i < 12; i++) props[`p${i}`] = { type: "string" }
  const text = toolPrompt([tool("wide", "Wide tool.", props)], { maxChars: 0 })
  assert.match(text, /^- wide\(p0:str, p1:str, p2:str, p3:str, p4:str, p5:str, p6:str, p7:str, \+4\)/m)
})

test("slimDescription drops the harness calling-convention boilerplate and caps length", () => {
  const long = slimDescription("Search files. " + "More detail that should be dropped. ".repeat(20))
  assert.ok(long.length <= 160, `expected <=160 chars, got ${long.length}`)
  const conv = slimDescription("Read a file. Calling convention: pass path then offset.")
  assert.equal(conv, "Read a file.")
})

test("a 300-tool corpus fits the budget while every name survives", () => {
  const defs = []
  for (let i = 0; i < 300; i++) {
    defs.push(tool(`tool_${i}`, `Tool number ${i} does something moderately verbose for the caller. ` + "Extra prose. ".repeat(12), { a: { type: "string" }, b: { type: "number" } }, ["a"]))
  }
  const full = toolPrompt(defs, { compact: false })
  const text = toolPrompt(defs, {})
  assert.ok(text.length <= DEFAULT_MAX_TOOL_CHARS + 200, `compact ${text.length} should fit the budget`)
  assert.ok(text.length * 3 < full.length, `compact ${text.length} should be far smaller than full ${full.length}`)
  for (const def of defs) assert.ok(text.includes(def.function.name), `missing ${def.function.name}`)
})

test("a tiny budget still lists every tool name", () => {
  const defs = []
  for (let i = 0; i < 120; i++) defs.push(tool(`t${i}`, "x".repeat(400)))
  const text = toolPrompt(defs, { maxChars: 1500 })
  for (const def of defs) assert.ok(text.includes(def.function.name), `missing ${def.function.name}`)
})

test("KIMI_TOOLS_MODE=full restores the schema rendering", () => {
  const defs = [tool("echo", "Echo.", { text: { type: "string" } })]
  const old = process.env.KIMI_TOOLS_MODE
  try {
    process.env.KIMI_TOOLS_MODE = "full"
    assert.match(toolPrompt(defs), /parameters:/)
    process.env.KIMI_TOOLS_MODE = "auto"
    assert.doesNotMatch(toolPrompt(defs), /parameters:/)
  } finally {
    if (old === undefined) delete process.env.KIMI_TOOLS_MODE
    else process.env.KIMI_TOOLS_MODE = old
  }
})

test("scanToolCalls strips the call block out of the visible text", () => {
  const text = 'Let me check.\n<tool_call>{"name":"bash","arguments":{"command":"ls -la"}}</tool_call>'
  const out = scanToolCalls(text)
  assert.equal(out.text.trim(), "Let me check.")
  assert.equal(out.calls.length, 1)
  assert.equal(out.calls[0].name, "bash")
  assert.equal(out.calls[0].arguments, '{"command":"ls -la"}')
})

test("scanToolCalls handles several calls and nested JSON", () => {
  const text = '<tool_call>{"name":"a","arguments":{"n":{"deep":[1,2]}}}</tool_call>mid<tool-call>{"name":"b","arguments":{}}</tool-call>'
  const out = scanToolCalls(text)
  assert.equal(out.calls.length, 2)
  assert.deepEqual(JSON.parse(out.calls[0].arguments), { n: { deep: [1, 2] } })
  assert.equal(out.calls[1].name, "b")
  assert.equal(out.text, "mid")
})

test("an unclosed or partially written call never leaks into the answer", () => {
  assert.equal(scanToolCalls('<tool_call>{"name":"bash","argum').text, "")
  assert.equal(trimPartialMarker("done <tool_ca"), "done ")
  assert.equal(trimPartialMarker("a < b"), "a < b")
})

test("malformed call payloads are dropped instead of forwarded", () => {
  const out = scanToolCalls('<tool_call>not json at all</tool_call>hi')
  assert.equal(out.calls.length, 0)
  assert.equal(out.text, "hi")
})

test("toolCallDelta builds an OpenAI tool_call delta", () => {
  const delta = toolCallDelta({ name: "fs_read", arguments: '{"path":"x"}' }, 2)
  assert.equal(delta.index, 2)
  assert.equal(delta.type, "function")
  assert.equal(delta.function.name, "fs_read")
  assert.equal(delta.function.arguments, '{"path":"x"}')
  assert.match(delta.id, /^call_2_fs_read/)
})

test("paramSignature abbreviates nested objects and arrays", () => {
  assert.equal(paramSignature({ type: "object", properties: { a: { type: "object", properties: {} }, b: { type: "array", items: { type: "string" } } } }), "(a:obj, b:arr)")
  assert.equal(paramSignature(undefined), "()")
})
