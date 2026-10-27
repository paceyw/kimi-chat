// Generic SSE frame reader shared by upstream parsing. Copied in spirit from
// the reference plugin; no Kimi specifics here.

const MAX_FRAME_CHARACTERS = 1_048_576

function parseFrame(block) {
  let event = "message"
  const lines = []
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim()
    if (line.startsWith("data:")) lines.push(line.slice(5).replace(/^ /, ""))
  }
  return lines.length ? { event, data: lines.join("\n") } : null
}

export async function* sseFrames(body, { signal } = {}) {
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let exhausted = false
  const abort = () => {
    try { Promise.resolve(reader.cancel(signal.reason)).catch(() => {}) } catch {}
  }
  signal?.addEventListener("abort", abort, { once: true })
  try {
    signal?.throwIfAborted()
    for (;;) {
      const { value, done } = await reader.read()
      signal?.throwIfAborted()
      if (done) { exhausted = true; buffer += decoder.decode(); break }
      buffer += decoder.decode(value, { stream: true })
      let separator
      while ((separator = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
        signal?.throwIfAborted()
        if (separator.index > MAX_FRAME_CHARACTERS) throw new Error("Kimi stream frame exceeds size limit")
        const block = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator[0].length)
        const frame = parseFrame(block)
        if (frame) yield frame
      }
      if (buffer.length > MAX_FRAME_CHARACTERS) throw new Error("Kimi stream frame exceeds size limit")
    }
    if (buffer.trim()) {
      const frame = parseFrame(buffer)
      if (frame) yield frame
    }
  } finally {
    signal?.removeEventListener("abort", abort)
    try { if (!exhausted) await reader.cancel() }
    finally { reader.releaseLock() }
  }
}
