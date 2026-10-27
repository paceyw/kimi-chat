// KIMI_TRACE：逐帧取证开关。只验证「不改变对话结果 + 把帧原样写盘」。
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { complete, parseCredentials } from "../src/kimi-api.mjs"

const creds = parseCredentials({ accessToken: "at", refreshToken: "rt", webId: "w", ssid: "s" })

function fakeFrames() {
  return (async function* () {
    yield { op: 2, block: { id: "1", text: { content: "你好" } } }
    yield { op: 2, block: { id: "1", text: { content: "，世界" } } }
  })()
}

async function runWithTrace(tracePath) {
  const savedTransport = complete._transport
  const savedTrace = process.env.KIMI_TRACE
  complete._transport = async () => fakeFrames()
  process.env.KIMI_TRACE = tracePath
  try {
    let text = ""
    for await (const snap of complete({ tier: "fast", prompt: "hi", credentials: creds, search: false })) {
      text = snap.text
    }
    return text
  } finally {
    complete._transport = savedTransport
    if (savedTrace === undefined) delete process.env.KIMI_TRACE
    else process.env.KIMI_TRACE = savedTrace
  }
}

test("KIMI_TRACE writes the request header, every frame, and an end record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kimi-trace-"))
  const file = join(dir, "trace.jsonl")
  const text = await runWithTrace(file)
  assert.equal(text, "你好，世界")
  assert.ok(existsSync(file), "trace file should exist")
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l))
  assert.equal(lines.length, 4)
  assert.equal(lines[0].kind, "request")
  assert.equal(lines[0].promptChars, 2)
  assert.equal(lines[1].block.text.content, "你好")
  assert.equal(lines[2].block.text.content, "，世界")
  assert.equal(lines[3].kind, "end")
  assert.equal(lines[3].status, "FINISHED")
  assert.equal(lines[3].textChars, 5)
})

test("without KIMI_TRACE nothing is written and the answer is identical", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kimi-trace-"))
  const file = join(dir, "off.jsonl")
  const savedTransport = complete._transport
  const savedTrace = process.env.KIMI_TRACE
  complete._transport = async () => fakeFrames()
  delete process.env.KIMI_TRACE
  try {
    let text = ""
    for await (const snap of complete({ tier: "fast", prompt: "hi", credentials: creds, search: false })) {
      text = snap.text
    }
    assert.equal(text, "你好，世界")
    assert.equal(existsSync(file), false)
  } finally {
    complete._transport = savedTransport
    if (savedTrace !== undefined) process.env.KIMI_TRACE = savedTrace
  }
})
