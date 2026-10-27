import { test } from "node:test"
import assert from "node:assert/strict"
import { sseFrames } from "../src/stream.mjs"

function sseStream(chunks) {
  const encoder = new TextEncoder()
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]))
      else controller.close()
    },
  })
}

test("sseFrames parses frames split across chunk boundaries", async () => {
  const frames = []
  for await (const frame of sseFrames(sseStream([
    'data: {"a":1}\n\nevent: ping\ndata: {"b"',
    ':2}\n\ndata: [DONE]\n\n',
  ]))) frames.push(frame)
  assert.deepEqual(frames.map((f) => f.event), ["message", "ping", "message"])
  assert.deepEqual(frames.map((f) => f.data), ['{"a":1}', '{"b":2}', "[DONE]"])
})

test("sseFrames handles CRLF and trailing buffer", async () => {
  const frames = []
  for await (const frame of sseFrames(sseStream(['data: {"x":"y"}\r\n\r\ndata: tail']))) frames.push(frame)
  assert.equal(frames.length, 2)
  assert.equal(JSON.parse(frames[0].data).x, "y")
  assert.equal(frames[1].data, "tail")
})

test("sseFrames abort cancels the reader", async () => {
  const controller = new AbortController()
  const slow = new ReadableStream({
    pull: (c) => { c.enqueue(new TextEncoder().encode("data: {}\n\n")) ; return new Promise(() => {}) },
  })
  controller.abort(new Error("stop"))
  await assert.rejects(async () => {
    for await (const _ of sseFrames(slow, { signal: controller.signal })) { /* drain */ }
  }, /stop/)
})
