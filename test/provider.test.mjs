import { test } from "node:test"
import assert from "node:assert/strict"
import { server } from "../src/index.mjs"
import { complete, parseCredentials, classifyError, safeErrorMessage } from "../src/kimi-api.mjs"
import { refreshToken } from "../src/kimi-connect.mjs"

const encoder = new TextEncoder()

// 造一个 Kimi 形状的 JWT（不签名；插件只解 payload，不验签）
function jwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return [b64({ alg: "HS512", typ: "JWT" }), b64(payload), "sig"].join(".")
}

function sseBody(lines) {
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`data: ${line}\n\n`))
      controller.close()
    },
  })
}

async function loaderFetch(messages, { stream = false, session, transport, model, extra } = {}) {
  const app = await server()
  const headers = {}
  await app["chat.headers"]({ model: { providerID: "kimi-chat" }, sessionID: session }, { headers })
  const loadAuth = async () => ({ key: "token=test" })
  const loader = await app.auth.loader(loadAuth)
  const saved = complete._transport
  if (transport) complete._transport = transport
  try {
    return await loader.fetch(new Request("https://local/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...(session ? { "x-magpie-session": headers["x-magpie-session"] } : {}) },
      body: JSON.stringify({ model: model ?? "kimi-fast", messages, stream, ...(extra ?? {}) }),
    }))
  } finally {
    if (transport) complete._transport = saved
  }
}

const happyTransport = async () => new Response(sseBody([
  JSON.stringify({ session_id: "kimi-1", message_id: "m1" }),
  JSON.stringify({ delta: "Hel" }),
  JSON.stringify({ delta: "lo" }),
  JSON.stringify({ status: "FINISHED" }),
]), { headers: { "content-type": "text/event-stream" } })

test("non-streaming happy path returns chat.completion", async () => {
  const response = await loaderFetch([{ role: "user", content: "hi" }], { transport: happyTransport })
  assert.equal(response.status, 200)
  const body = JSON.parse(await response.text())
  assert.equal(body.object, "chat.completion")
  assert.equal(body.choices[0].message.content, "Hello")
  assert.equal(body.choices[0].finish_reason, "stop")
})

test("streaming happy path emits incremental SSE with DONE", async () => {
  const response = await loaderFetch([{ role: "user", "content": "hi" }], { stream: true, transport: happyTransport })
  assert.match(response.headers.get("content-type"), /text\/event-stream/)
  const text = await new Response(response.body).text()
  const events = text.split("\n\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)))
  const content = events.map((e) => e.choices?.[0]?.delta?.content ?? "").join("")
  assert.equal(content, "Hello")
  assert.ok(text.includes("data: [DONE]"))
  const last = events[events.length - 1]
  assert.equal(last.choices[0].finish_reason, "stop")
})

test("search UI events stream as kimi_ui__ tool calls", async () => {
  const { complete } = await import("../src/kimi-api.mjs")
  const saved = complete._transport
  complete._transport = async function* () {
    yield { op: 2, block: { id: "s1", search: { keywords: ["k"], webPages: [{ title: "T", url: "https://e", snippet: "s" }] } } }
    yield { op: 2, block: { id: "b1", text: { content: "answer" } } }
    yield { done: {} }
  }
  try {
    const response = await loaderFetch([{ role: "user", content: "q" }], { stream: true })
    const text = await new Response(response.body).text()
    const events = text.split("\n\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)))
    const calls = events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? [])
    assert.ok(calls.length >= 1, "search must surface as a tool call")
    assert.match(calls[0].function.name, /^kimi_ui__/)
    const payload = JSON.parse(calls[0].function.arguments)
    assert.equal(payload.op, "create")
    assert.equal(payload.component, "search-results")
    assert.equal(payload.props.results[0].url, "https://e")
  } finally { complete._transport = saved }
})

test("reasoning deltas go to reasoning_content channel", async () => {
  const response = await loaderFetch([{ role: "user", content: "think" }], {
    stream: true,
    transport: async () => new Response(sseBody([
      JSON.stringify({ reasoning: "step 1" }),
      JSON.stringify({ reasoning: "step 2" }),
      JSON.stringify({ delta: "answer" }),
    ])),
  })
  const text = await new Response(response.body).text()
  const events = text.split("\n\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)))
  const reasoning = events.map((e) => e.choices?.[0]?.delta?.reasoning_content ?? "").join("")
  assert.equal(reasoning, "step 1step 2")
  const content = events.map((e) => e.choices?.[0]?.delta?.content ?? "").join("")
  assert.equal(content, "answer")
})

test("session mapping stores upstream session id and reuses it", async () => {
  const { _internal } = await import("../src/index.mjs")
  _internal.sessions.clear()
  await loaderFetch([{ role: "user", content: "one" }], { transport: happyTransport, session: "s-1" })
  assert.equal(_internal.sessions.get("s-1").kimiSessionId, "kimi-1")
  let seenSession = null
  await loaderFetch([{ role: "user", content: "one" }, { role: "assistant", content: "ok" }, { role: "user", content: "two" }], {
    session: "s-1",
    transport: async (args) => { seenSession = args.sessionId; return happyTransport() },
  })
  assert.equal(seenSession, "kimi-1")
})

test("citations stream as citation-list UI events and annotations", async () => {
  const saved = complete._transport
  complete._transport = async function* () {
    yield { ref: { id: "r1", search: { base: { title: "Docs", url: "https://d", snippet: "q" }, refIndex: "1" } } }
    yield { op: 2, block: { id: "b1", text: { content: "see [1]" } } }
    yield { done: {} }
  }
  try {
    const response = await loaderFetch([{ role: "user", content: "q" }], { stream: true })
    const text = await new Response(response.body).text()
    const events = text.split("\n\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)))
    const calls = events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? [])
    const cite = calls.find((c) => c.function?.name?.startsWith("kimi_ui__") && JSON.parse(c.function.arguments).component === "citation-list")
    assert.ok(cite, "citations must surface as citation-list UI event")
    const payload = JSON.parse(cite.function.arguments)
    assert.equal(payload.props.citations[0].url, "https://d")

    const response2 = await loaderFetch([{ role: "user", content: "q" }], { stream: false })
    const body = JSON.parse(await response2.text())
    assert.equal(body.choices[0].message.annotations?.[0].url, "https://d")
  } finally { complete._transport = saved }
})

test("web_search tool block surfaces search-results UI and citations", async () => {
  const saved = complete._transport
  const toolArgs = '{"queries":["杭州天气"]}'
  complete._transport = async function* () {
    yield { op: 1, block: { id: "t1", tool: { toolCallId: "web_search:1", name: "web_search", args: toolArgs, status: 2 } } }
    yield {
      op: 2,
      block: {
        id: "t1",
        tool: {
          toolCallId: "web_search:1", name: "web_search", args: toolArgs, status: 3,
          contents: [
            { searchResult: { index: "1", base: { title: "杭州天气", url: "https://weather.example/hz", snippet: "晴" }, refKey: "web_search:1#0" } },
            { searchResult: { index: "2", base: { title: "浙江气象", url: "https://zj.example/w", snippet: "多云" }, refKey: "web_search:1#1" } },
          ],
        },
      },
    }
    yield { op: 2, block: { id: "b1", text: { content: "今天杭州晴" } } }
    yield { done: {} }
  }
  try {
    const response = await loaderFetch([{ role: "user", content: "杭州天气" }], { stream: true })
    const text = await new Response(response.body).text()
    const events = text.split("\n\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)))
    const calls = events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? [])
    const payloads = calls.filter((c) => c.function?.name?.startsWith("kimi_ui__")).map((c) => JSON.parse(c.function.arguments))
    const search = payloads.find((p) => p.component === "search-results")
    assert.ok(search, "web_search results must surface as search-results card")
    assert.equal(search.props.query, "杭州天气")
    assert.equal(search.props.results.length, 2)
    assert.equal(search.props.results[0].url, "https://weather.example/hz")
    const cite = payloads.find((p) => p.component === "citation-list")
    assert.ok(cite, "search results must also feed citation-list")
    assert.equal(cite.props.citations.length, 2)

    const response2 = await loaderFetch([{ role: "user", content: "杭州天气" }], { stream: false })
    const body = JSON.parse(await response2.text())
    assert.equal(body.choices[0].message.annotations?.[0].url, "https://weather.example/hz")
  } finally { complete._transport = saved }
})

test("tool completion frame without tool_call_id still surfaces search-results", async () => {
  // 回归（活体实测发现）：上游 patch 语义下，tool_call_id/name/args 只在起始帧出现，
  // 带 contents 的完成帧只有 block.id + status + contents。若按帧内字段判身份，
  // 完成帧会被当"匿名工具"，search-results 卡片永远不会发出。
  const saved = complete._transport
  complete._transport = async function* () {
    yield { op: 1, block: { id: "blk-1", tool: { toolCallId: "web_search:1", name: "web_search", args: '{"queries":["杭州天气"]}', status: 2 } } }
    yield { op: 2, block: { id: "blk-1", tool: { status: 2 } } }
    yield {
      op: 2,
      block: {
        id: "blk-1",
        tool: {
          status: 3,
          contents: [
            { searchResult: { index: "0", base: { title: "杭州天气", url: "https://m.nmc.cn/hz", snippet: "多云转晴" } } },
            { searchResult: { index: "1", base: { title: "中国天气网", url: "https://www.weather.com.cn/hz", snippet: "14~22℃" } } },
          ],
        },
      },
    }
    yield { op: 2, block: { id: "b1", text: { content: "今天多云转晴" } } }
    yield { done: {} }
  }
  try {
    const response = await loaderFetch([{ role: "user", content: "杭州天气" }], { stream: true })
    const text = await new Response(response.body).text()
    const events = text.split("\n\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)))
    const calls = events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? [])
    const payloads = calls.filter((c) => c.function?.name?.startsWith("kimi_ui__")).map((c) => JSON.parse(c.function.arguments))
    const search = payloads.find((p) => p.component === "search-results")
    assert.ok(search, "contents-bearing frame must still be recognised as web_search")
    assert.equal(search.props.results.length, 2)
    assert.equal(search.props.query, "杭州天气", "query comes from args seen on the earlier frame")
    assert.equal(payloads.find((p) => p.component === "citation-list").props.citations.length, 2)
  } finally { complete._transport = saved }
})

test("inline <REF>cite✹tools://…</REF> markers become [n] and never leak raw", async () => {
  // 活体实测：正文里会带 <REF>cite✦tools://web_search:1#4:~:text=…</REF>。
  // #4 是 SearchResultBase.index，应映射到 citations 序号并渲染成 [n]。
  const saved = complete._transport
  complete._transport = async function* () {
    yield { op: 1, block: { id: "blk-1", tool: { toolCallId: "web_search:1", name: "web_search", args: '{"queries":["杭州天气"]}', status: 2 } } }
    yield {
      op: 2,
      block: {
        id: "blk-1",
        tool: {
          status: 3,
          contents: [
            { searchResult: { index: "0", base: { title: "杭州天气", url: "https://a.example/hz" } } },
            { searchResult: { index: "4", base: { title: "浙江气象", url: "https://b.example/zj" } } },
          ],
        },
      },
    }
    yield { op: 2, block: { id: "b1", text: { content: "今天多云<REF>cite✦tools://web_search:1#4:~:text=多云转晴</REF>转晴" } } }
    yield { done: {} }
  }
  try {
    const response = await loaderFetch([{ role: "user", content: "杭州天气" }], { stream: true })
    const text = await new Response(response.body).text()
    const events = text.split("\n\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)))
    const deltas = events.flatMap((e) => e.choices?.[0]?.delta?.content ?? []).join("")
    assert.ok(!deltas.includes("<REF>"), "raw REF markup must not reach the client")
    assert.equal(deltas, "今天多云[2]转晴", "marker maps to the citation number of SearchResultBase.index 4")
  } finally { complete._transport = saved }
})

test("interleaved text blocks stay coherent (per-block buffers, first-seen order)", async () => {
  // 活体实测：一条回答会拆成两个 TextBlock（搜索前铺垫 + 搜索后正文），两者的增量帧
  // 交错到达。若把所有 text 增量追加进同一个缓冲区，正文会互相插队成乱码。
  const saved = complete._transport
  complete._transport = async function* () {
    yield { op: 1, block: { id: "a", text: { content: "我来帮您查询一下。" } } }
    yield { op: 1, block: { id: "b", text: { content: "今天杭州" } } }
    yield { op: 2, block: { id: "a", text: { content: "稍等。" } } } // 交错：a 的尾巴晚到
    yield { op: 2, block: { id: "b", text: { content: "多云转晴。" } } }
    yield { done: {} }
  }
  try {
    const response = await loaderFetch([{ role: "user", content: "天气" }], { stream: false })
    const body = JSON.parse(await response.text())
    assert.equal(body.choices[0].message.content, "我来帮您查询一下。稍等。今天杭州多云转晴。")
  } finally { complete._transport = saved }
})

test("client tools: definitions reach the prompt, <tool_call> becomes tool_calls", async () => {
  const saved = complete._transport
  const seen = []
  complete._transport = async function* ({ prompt }) {
    seen.push(prompt)
    yield { op: 1, block: { id: "t1", text: { content: "我查一下。\n" } } }
    yield { op: 2, block: { id: "t1", text: { content: '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>' } } }
    yield { done: {} }
  }
  const tools = [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }]
  try {
    const response = await loaderFetch([{ role: "user", content: "读一下 a.txt" }], { stream: true, extra: { tools } })
    const text = await new Response(response.body).text()
    const events = text.split("\n\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)))
    const calls = events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? [])
    const content = events.flatMap((e) => e.choices?.[0]?.delta?.content ?? []).join("")
    const finish = events.at(-1)?.choices?.[0]?.finish_reason
    assert.match(seen[0], /# Tool calling/, "tool contract must be injected")
    assert.match(seen[0], /read_file/, "tool name must be listed")
    assert.equal(content.includes("<tool_call>"), false, "raw marker must not leak as content")
    const call = calls.find((c) => c.function?.name === "read_file")
    assert.ok(call, "tool call must be emitted")
    assert.deepEqual(JSON.parse(call.function.arguments), { path: "a.txt" })
    assert.equal(finish, "tool_calls")
  } finally { complete._transport = saved }
})

test("client tools: tool role results are narrated back to the model", async () => {
  const saved = complete._transport
  const seen = []
  complete._transport = async function* ({ prompt }) {
    seen.push(prompt)
    yield { op: 1, block: { id: "t1", text: { content: "文件里是 hello" } } }
    yield { done: {} }
  }
  try {
    await loaderFetch([
      { role: "user", content: "读一下 a.txt" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "hello" },
    ], { stream: false })
    assert.match(seen[0], /\[called read_file with/, "history tool call should be narrated")
    assert.match(seen[0], /\[tool result\] hello/)
  } finally { complete._transport = saved }
})

test("client tools: marker split across frames never leaks as content", async () => {
  const saved = complete._transport
  complete._transport = async function* () {
    yield { op: 1, block: { id: "t1", text: { content: "我查一下。" } } }
    yield { op: 2, block: { id: "t1", text: { content: "<tool_call" } } } // 半截标记
    yield { op: 2, block: { id: "t1", text: { content: '>{"name":"read_file","arguments"' } } }
    yield { op: 2, block: { id: "t1", text: { content: ':{"path":"a.txt"}}</tool_call>' } } }
    yield { done: {} }
  }
  const tools = [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }]
  try {
    const response = await loaderFetch([{ role: "user", content: "读 a.txt" }], { stream: true, extra: { tools } })
    const text = await new Response(response.body).text()
    const events = text.split("\n\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)))
    const content = events.flatMap((e) => e.choices?.[0]?.delta?.content ?? []).join("")
    const calls = events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? []).filter((c) => !c.function?.name?.startsWith("kimi_ui__"))
    assert.equal(content, "我查一下。", "half marker must be held back")
    assert.equal(calls.length, 1)
    assert.equal(calls[0].function.name, "read_file")
  } finally { complete._transport = saved }
})

test("session continuation sends only new messages", async () => {
  const seen = []
  const saved = complete._transport
  complete._transport = async function* ({ prompt, sessionId }) {
    seen.push({ prompt, sessionId })
    yield { chat: { id: "chat-upstream-1" }, op: 2, block: { id: "b1", text: { content: "ok" } } }
    yield { done: {} }
  }
  try {
    // 第一轮（全量）：user 问 1
    await loaderFetch([{ role: "system", content: "be brief" }, { role: "user", content: "first question" }], { stream: false, session: "s1" })
    // 第二轮（全量重发模式）：system + user1 + assistant + user2
    await loaderFetch([
      { role: "system", content: "be brief" },
      { role: "user", content: "first question" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second question" },
    ], { stream: false, session: "s1" })
    assert.equal(seen.length, 2)
    assert.equal(seen[0].sessionId, null, "first turn creates upstream session")
    assert.equal(seen[1].sessionId, "chat-upstream-1", "second turn reuses upstream session")
    assert.ok(!seen[1].prompt.includes("first question"), "continuation must not resend old user turns")
    assert.ok(seen[1].prompt.includes("be brief"), "system prompt is retained on continuation")
    assert.ok(seen[1].prompt.includes("second question"), "continuation sends new turn")

    // 第三轮（客户端裁剪过历史，前缀不匹配）→ 开新上游会话，全量压平
    seen.length = 0
    await loaderFetch([{ role: "user", content: "trimmed history, new question" }], { stream: false, session: "s1" })
    assert.equal(seen[0].sessionId, null, "prefix mismatch falls back to fresh upstream session")
    assert.ok(seen[0].prompt.includes("trimmed history"), "fresh session sends full flattened history")
  } finally { complete._transport = saved }
})

test("failed continuation clears mapping so next turn starts fresh", async () => {
  const { _internal } = await import("../src/index.mjs")
  _internal.sessions.clear()
  const saved = complete._transport
  let calls = 0
  complete._transport = async function* ({ prompt, sessionId }) {
    calls++
    if (calls === 1) {
      yield { chat: { id: "chat-gone" }, op: 2, block: { id: "b1", text: { content: "ok" } } }
      yield { done: {} }
    } else if (calls === 2) {
      // 上游会话已删除：抛非鉴权类错误
      throw Object.assign(new Error("chat not found"), { kind: "upstream_error" })
    } else {
      yield { chat: { id: "chat-new" }, op: 2, block: { id: "b1", text: { content: "fresh" } } }
      yield { done: {} }
    }
  }
  try {
    const history = [{ role: "user", content: "q1" }]
    await loaderFetch(history, { stream: false, session: "sx" })
    assert.ok(_internal.sessions.has("sx"), "mapping recorded after first turn")
    // 第二轮续聊失败（会话上游被删）
    await loaderFetch([...history, { role: "assistant", content: "ok" }, { role: "user", content: "q2" }], { stream: false, session: "sx" })
      .catch(() => "expected failure")
    assert.ok(!_internal.sessions.has("sx"), "mapping cleared after failed continuation")
    // 第三轮：无映射 → 开新上游会话，全量压平
    const res = await loaderFetch([...history, { role: "assistant", content: "ok" }, { role: "user", content: "q3" }], { stream: false, session: "sx" })
    const body = JSON.parse(await res.text())
    assert.equal(body.choices[0].message.content, "fresh")
    assert.equal(_internal.sessions.get("sx").kimiSessionId, "chat-new")
  } finally { complete._transport = saved }
})

test("website sign-in: pasted refresh_token is exchanged, accountId taken from the token", async () => {
  const app = await server()
  // 按 label 取（methods 顺序会随新增登录方式变化）
  const method = app.auth.methods.find(m => /paste/i.test(m.label))
  const origFetch = globalThis.fetch
  // 用户回传的是 refresh JWT（真实形状：typ=refresh、sub=userId）
  const pasted = jwt({ typ: "refresh", sub: "u-42" })
  const enc = new TextEncoder()
  const newAt = jwt({ typ: "access", sub: "u-42" })
  const atBytes = enc.encode(newAt)
  const rtBytes = enc.encode("rotated-rt")
  globalThis.fetch = async (url) => {
    assert.match(String(url), /AuthService\/RefreshToken$/)
    // protobuf: field1=access_token field2=refresh_token
    return new Response(
      new Uint8Array([10, atBytes.length, ...atBytes, 18, rtBytes.length, ...rtBytes]),
      { status: 200, headers: { "content-type": "application/proto" } },
    )
  }
  try {
    const grant = await method.authorize()
    assert.equal(grant.method, "code", "magnet opens the page, user pastes the token")
    assert.match(grant.url, /\/login$/)
    assert.match(grant.instructions, /refresh_token/)
    let ok = await grant.callback(pasted)
    assert.equal(ok.type, "success")
    const creds = JSON.parse(ok.refresh)
    assert.equal(creds.accessToken, newAt)
    assert.equal(creds.refreshToken, "rotated-rt")
    assert.equal(creds.userId, "u-42", "userId comes from the token's sub claim")
    assert.match(creds.webId, /^[0-9a-f]{32}$/)
    assert.match(creds.ssid, /^[0-9a-f]{32}$/)
    assert.equal(ok.accountId, "u-42")
    // `refresh_token=...` 前缀与 JSON 两种粘贴形状都要能吃
    ok = await grant.callback("refresh_token=  " + pasted)
    assert.equal(ok.type, "success")
    ok = await grant.callback(JSON.stringify({ refreshToken: pasted }))
    assert.equal(ok.type, "success")
  } finally { globalThis.fetch = origFetch }
})

test("website sign-in: rejects the wrong token and unreachable Kimi honestly", async () => {
  const app = await server()
  const method = app.auth.methods.find(m => /paste/i.test(m.label))
  const grant = await method.authorize()
  const origFetch = globalThis.fetch
  try {
    // access_token 寿命只有分钟级：当场提示换 refresh_token，而不是存下一分钟后失效
    const wrong = await grant.callback(jwt({ typ: "access", sub: "u-1" }))
    assert.equal(wrong.type, "failed")
    assert.match(wrong.error, /refresh_token/)
    const junk = await grant.callback("not a token")
    assert.equal(junk.type, "failed")
    // 401：过期/登出 → 可操作提示
    globalThis.fetch = async () => new Response(JSON.stringify({ code: "unauthenticated" }), { status: 401 })
    const expired = await grant.callback(jwt({ typ: "refresh", sub: "u-1" }))
    assert.equal(expired.type, "failed")
    assert.match(expired.error, /sign in again/i)
    // 网络故障不能假装登录成功
    globalThis.fetch = async () => { throw new TypeError("fetch failed") }
    const netfail = await grant.callback(jwt({ typ: "refresh", sub: "u-1" }))
    assert.equal(netfail.type, "failed")
    assert.match(netfail.error, /Could not reach Kimi/)
  } finally { globalThis.fetch = origFetch }
})

test("invalid requests fail fast with clear errors", async () => {
  await assert.rejects(loaderFetch([], { transport: happyTransport }), /at least one message/)
  await assert.rejects(
    loaderFetch([{ role: "user", content: "x" }], { model: "nope", transport: async () => { throw new Error("should not be called") } }),
    /unknown model/,
  )
})

test("client tool definitions are accepted (no longer rejected)", async () => {
  const app = await server()
  const loader = await app.auth.loader(async () => ({ key: "token=t" }))
  const saved = complete._transport
  complete._transport = async function* () {
    yield { op: 1, block: { id: "t1", text: { content: "ok" } } }
    yield { done: {} }
  }
  try {
    const response = await loader.fetch(new Request("https://local", {
      method: "POST",
      body: JSON.stringify({ model: "kimi-fast", stream: false, messages: [{ role: "user", content: "x" }], tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }] }),
    }))
    const body = await response.json()
    assert.equal(body.choices[0].message.content, "ok")
  } finally { complete._transport = saved }
})

test("error frames carry redacted message and classification", async () => {
  const response = await loaderFetch([{ role: "user", content: "boom" }], {
    stream: true,
    transport: async () => { const e = new Error("upstream blew token=abc123"); e.status = 502; throw e },
  })
  const text = await new Response(response.body).text()
  const dataLines = text.split("\n\n").filter((l) => l.startsWith("data: "))
  const errorEvent = dataLines.map((l) => JSON.parse(l.slice(6))).find((e) => e.error)
  assert.equal(errorEvent.error.code, "upstream_error")
  assert.match(errorEvent.error.message, /\[redacted\]/)
})

test("client abort aborts the upstream iterator", async () => {
  const app = await server()
  const loader = await app.auth.loader(async () => ({ key: "token=t" }))
  const controller = new AbortController()
  let upstreamCancelled = false
  complete._transport = async ({ signal }) => {
    signal.addEventListener("abort", () => { upstreamCancelled = true })
    return new Response(new ReadableStream({
      pull: (c) => { c.enqueue(encoder.encode('data: {"delta":"a"}\n\n')); return new Promise(() => {}) },
    }))
  }
  const response = await loader.fetch(new Request("https://local", {
    method: "POST",
    signal: controller.signal,
    body: JSON.stringify({ model: "kimi-fast", messages: [{ role: "user", content: "x" }], stream: true }),
  }))
  const reader = response.body.getReader()
  await reader.read()
  controller.abort(new Error("client cancelled"))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(upstreamCancelled)
  await assert.rejects(reader.read())
  complete._transport = undefined
})

test("parseCredentials and helpers", () => {
  const creds = parseCredentials(JSON.stringify({ accessToken: "at", refreshToken: "rt", userId: "u", webId: "w", ssid: "s" }))
  assert.equal(creds.accessToken, "at")
  assert.equal(creds.refreshToken, "rt")
  assert.equal(parseCredentials("bare").accessToken, "bare")
  assert.throws(() => parseCredentials("  "), /empty/)
  assert.throws(() => parseCredentials(JSON.stringify({})), /accessToken|refreshToken/)
  assert.equal(classifyError(Object.assign(new Error("x"), { status: 429 })), "rate_limited")
  assert.equal(classifyError(Object.assign(new Error("x"), { kind: "rate_limited" })), "rate_limited")
  assert.equal(classifyError(Object.assign(new Error("x"), { name: "AbortError" })), "cancelled")
  assert.match(safeErrorMessage("failed token=zzz Bearer abc.def"), /\[redacted\]/)
})

test("tierToRequest maps model tiers to ChatRequest options", async () => {  const { tierToRequest } = await import("../src/kimi-api.mjs")
  const fast = tierToRequest("kimi-fast", "hi", { sessionId: "c1", search: true })
  assert.equal(fast.chatId, "c1")
  // 无鉴权 GetAvailableModels 实测：default_chat_model="k2d6-chat"（Instant），scenario CHAT(1)
  assert.equal(fast.scenario, 1)
  assert.equal(fast.options.model, "k2d6-chat")
  assert.equal(fast.options.speed, 5)
  assert.ok(fast.useSearch)
  const think = tierToRequest("kimi-thinking", "hi", {})
  // 前端证实：thinking 恒真非独立场景；思考档=K3 + 默认 HIGH effort（前端 ChFG9O1A thinking:!0 硬编码）
  assert.equal(think.scenario, 6)
  assert.equal(think.kimiplusId, "ok-computer")
  assert.equal(think.options.model, "k3-agent")
  assert.equal(think.options.thinking, true)
  assert.equal(think.options.reasoningEffort, 5) // 默认 high
  const agent = tierToRequest("kimi-agent", "hi", {})
  // default_agent_model="k3-agent"（OK_COMPUTER(6) + kimiPlusId "ok-computer"）
  assert.equal(agent.scenario, 6)
  assert.equal(agent.kimiplusId, "ok-computer")
  assert.equal(agent.options.model, "k3-agent")
  assert.equal(agent.options.speed, 5) // CRN2 枚举（1/5/10）合法值，= K3 default_speed
  assert.equal(agent.options.enablePlugin, true)
  // OpenAI reasoning_effort → kimi ReasoningEffort（LOW=3/MEDIUM=4/HIGH=5），覆盖思考档默认
  const thinkHigh = tierToRequest("kimi-thinking", "hi", { reasoningEffort: "high" })
  assert.equal(thinkHigh.options.reasoningEffort, 5)
  const thinkLow = tierToRequest("kimi-thinking", "hi", { reasoningEffort: "low" })
  assert.equal(thinkLow.options.reasoningEffort, 3)
  const thinkJunk = tierToRequest("kimi-thinking", "hi", { reasoningEffort: "ultra" })
  assert.equal(thinkJunk.options.reasoningEffort, 5) // 未知值回退默认 high
  // Instant 也透传 effort，但只支持 Low(3)/High(5)：high → 5，max(7) 夹到 5
  const fastEffort = tierToRequest("kimi-fast", "hi", { reasoningEffort: "high" })
  assert.equal(fastEffort.options.reasoningEffort, 5)
  const fastMax = tierToRequest("kimi-fast", "hi", { reasoningEffort: "max" })
  assert.equal(fastMax.options.reasoningEffort, 5) // 7 超过 Instant 上界 → 夹到 5
  // agent 档是 K3 系：三档都透传
  const agentMax = tierToRequest("kimi-agent", "hi", { reasoningEffort: 7 })
  assert.equal(agentMax.options.reasoningEffort, 7)
  // 速度/对话长度：字符串枚举名与数字都接受；非法或超套餐上限一律丢弃
  // （实测：speed=3 → enum.defined_only 报错、speed=10 → Invalid parameter、
  //   context_length=6/7 → stream error / Invalid parameter，故只有 1/5/7 与 ≤L 可信）
  const tuned = tierToRequest("kimi-thinking", "hi", { speed: "standard", contextLength: "l" })
  assert.equal(tuned.options.speed, 1) // SPEED.STANDARD
  assert.equal(tuned.options.contextLength, 5) // CONTEXT_LENGTH.L
  // speed=7 曾被误判为"Max"可用：实测上游 enum.defined_only 直接拒（Model.speed_options 的
  // 7 是展示刻度），故 7 必须被丢弃而不是发给上游。
  const tunedNum = tierToRequest("kimi-agent", "hi", { speed: 5, contextLength: 5 })
  assert.equal(tunedNum.options.speed, 5) // SPEED.FAST
  assert.equal(tunedNum.options.contextLength, 5)
  const tunedMax = tierToRequest("kimi-agent", "hi", { speed: "max" })
  assert.equal(tunedMax.options.speed, 5) // agent 档默认 FAST，非法覆盖丢弃后仍是 5
  const tunedJunk = tierToRequest("kimi-thinking", "hi", { speed: "warp", contextLength: "gigantic" })
  assert.equal(tunedJunk.options.speed, 5) // thinking 钉住默认 FAST，非法覆盖被丢弃
  assert.equal(tunedJunk.options.contextLength, undefined)
  // 网页上确有"极致/XXL"选项，但本账号实测会被上游拒 → 超上限值静默丢弃而非整轮失败
  const tunedOverCap = tierToRequest("kimi-thinking", "hi", { speed: 10, contextLength: "xxl" })
  assert.equal(tierToRequest("kimi-thinking", "hi", { speed: 7 }).options.speed, 5) // 7 被拒 → 回落默认 FAST
  assert.equal(tunedOverCap.options.speed, 5)
  assert.equal(tunedOverCap.options.contextLength, undefined)
  // 动态模型入口（服务端清单里的单个模型）：场景/kimiplus_id/model/thinking 全部取自清单
  const specReq = tierToRequest("k3-agent", "hi", {
    spec: { scenario: 6, kimiplusId: "ok-computer", modelId: "k3-agent", thinking: true },
    speed: "standard", contextLength: "l",
  })
  assert.equal(specReq.scenario, 6)
  assert.equal(specReq.kimiplusId, "ok-computer")
  assert.equal(specReq.options.model, "k3-agent")
  assert.equal(specReq.options.thinking, true)
  assert.equal(specReq.options.speed, 1)
  assert.equal(specReq.options.contextLength, 5)
  // CHAT 场景的模型没有 kimiplusId，不应凭空塞一个
  const chatSpec = tierToRequest("k2d6-chat", "hi", { spec: { scenario: 1, kimiplusId: "", modelId: "k2d6-chat", thinking: false } })
  assert.equal(chatSpec.scenario, 1)
  assert.equal(chatSpec.kimiplusId, undefined)
  assert.equal(chatSpec.options.thinking, false)
})

test("tierToRequest 使用动态解析的模型 id（服务端换挡时不再写死）", async () => {
  const { tierToRequest, FALLBACK_MODELS, _resetModelCache } = await import("../src/kimi-api.mjs")
  assert.ok(FALLBACK_MODELS.chatModel && FALLBACK_MODELS.agentModel)
  // 服务端清单换成新 id（2026-10-27 实测 default_chat_model 已从 k2d6-chat → k28-instant）
  const models = { chatModel: "k28-instant", agentModel: "k3d1-agent" }
  const fast = tierToRequest("kimi-fast", "hi", { models })
  assert.equal(fast.options.model, "k28-instant")
  assert.equal(fast.options.speed, 5) // 速度档仍显式钉住，不依赖服务端默认
  const think = tierToRequest("kimi-thinking", "hi", { models })
  assert.equal(think.options.model, "k3d1-agent")
  const agent = tierToRequest("kimi-agent", "hi", { models })
  assert.equal(agent.options.model, "k3d1-agent")
  // 未拿到清单 → 固定兜底（宁可参数不最优，也不能让请求缺 model 字段）
  const fallback = tierToRequest("kimi-fast", "hi", { models: null })
  assert.equal(fallback.options.model, FALLBACK_MODELS.chatModel)
  _resetModelCache()
})

test("tierToRequest 接受 config.MODELS 里的短 tier 名（回归：短名曾静默落默认分支）", async () => {
  const { tierToRequest } = await import("../src/kimi-api.mjs")
  const { MODELS } = await import("../src/config.mjs")
  // 线上 gateway 传的正是 model.tier（"fast"/"thinking"/"agent"），
  // 早期只比较 "kimi-*" 全名 → 三档全退化成 CHAT 默认模型（不思考、不启插件）。
  for (const [id, model] of Object.entries(MODELS)) {
    const short = tierToRequest(model.tier, "hi", { search: true })
    const full = tierToRequest(id, "hi", { search: true })
    assert.deepEqual(short, full, `${id}: 短名 ${model.tier} 应与全名等价`)
  }
  const fastShort = tierToRequest("fast", "hi", {})
  assert.equal(fastShort.options.model, "k2d6-chat")
  const thinkShort = tierToRequest("thinking", "hi", {})
  assert.equal(thinkShort.options.model, "k3-agent")
  assert.equal(thinkShort.options.thinking, true)
  const agentShort = tierToRequest("agent", "hi", {})
  assert.equal(agentShort.options.enablePlugin, true)
  // 未知档兜底也必须钉住模型，不能留给服务端默认
  const unknown = tierToRequest("whatever", "hi", {})
  assert.equal(unknown.options.model, "k2d6-chat")
})

// 直接抓上游 ChatRequest 的线上字节（假 fetch，不起网络）：连接层是 5 字节信封 + proto body，
// 这里解出 options(5) 里的 reasoning_effort(8)，断言请求里到底发了什么。
async function captureChatRequest({ tier, spec, reasoningEffort, model }) {
  const { complete } = await import("../src/kimi-api.mjs")
  const { fields, pick, pickNum } = await import("../src/kimi-proto.mjs")
  const savedFetch = globalThis.fetch
  const savedTransport = complete._transport
  const savedModels = complete._models
  let sent = null
  complete._transport = undefined
  complete._models = { chatModel: "k28-instant", agentModel: "k3-agent", thinkingModel: "k3-agent" }
  globalThis.fetch = async (_url, init) => {
    sent = new Uint8Array(init.body)
    // 空流：只关心请求，无需构造完整响应帧
    return new Response(new ReadableStream({ start(c) { c.close() } }), { status: 200, headers: { "content-type": "application/connect+proto" } })
  }
  try {
    for await (const _ of complete({ credentials: "tok", tier, prompt: "hi", reasoningEffort, spec })) { /* drain */ }
  } finally {
    globalThis.fetch = savedFetch
    complete._transport = savedTransport
    complete._models = savedModels
  }
  assert.ok(sent?.length > 5, "upstream request body must be captured")
  const top = fields(sent.subarray(5)) // 跳过 5 字节 connect 信封
  const optBuf = pick(top, 5)
  const opts = optBuf ? fields(optBuf) : []
  const has = opts.some((f) => f.num === 8 && f.wt === 0)
  return { payload: top, optionFields: opts, hasEffort: has, effort: has ? pickNum(opts, 8) : undefined, model: (() => { const b = pick(opts, 10); return b ? new TextDecoder().decode(b) : "" })() }
}

test("reasoning_effort 7 on Instant is clamped to 5 in the encoded request", async () => {
  // Instant（CHAT 场景）只支持 Low(3)/High(5)，前端传 Max(7) 必须夹到 5 再发
  const instant = await captureChatRequest({
    tier: "k28-instant", reasoningEffort: 7,
    spec: { scenario: 1, kimiplusId: "", modelId: "k28-instant", thinking: false, reasoningEfforts: [3, 5] },
  })
  assert.equal(instant.model, "k28-instant")
  assert.equal(instant.effort, 5)
  // 清单没带档位表时按场景默认（CHAT → [3,5]），同样夹到 5
  const noSpec = await captureChatRequest({
    tier: "k28-instant", reasoningEffort: 7,
    spec: { scenario: 1, kimiplusId: "", modelId: "k28-instant", thinking: false },
  })
  assert.equal(noSpec.effort, 5)
  // fast 档（Instant 语义档）也一样
  const fast = await captureChatRequest({ tier: "kimi-fast", reasoningEffort: 7 })
  assert.equal(fast.effort, 5)
  assert.equal(fast.model, "k28-instant")
})

test("reasoning_effort 7 on K3 passes through unchanged in the encoded request", async () => {
  const k3 = await captureChatRequest({
    tier: "k3", reasoningEffort: 7,
    spec: { scenario: 6, kimiplusId: "ok-computer", modelId: "k3", thinking: true, reasoningEfforts: [3, 5, 7] },
  })
  assert.equal(k3.model, "k3")
  assert.equal(k3.hasEffort, true)
  assert.equal(k3.effort, 7)
  // 未传 effort：动态入口不发该字段（交上游默认），不要凭空塞一个档位
  const implicit = await captureChatRequest({
    tier: "k3",
    spec: { scenario: 6, kimiplusId: "ok-computer", modelId: "k3", thinking: true, reasoningEfforts: [3, 5, 7] },
  })
  assert.equal(implicit.hasEffort, false)
})

test("sanitizeInlineRefs converts private-use citation markers to [n]", async () => {
  const { sanitizeInlineRefs } = await import("../src/kimi-api.mjs")
  const PU = (type, payload) => `\uE3A0${type}\uE3A1${payload}\uE3A8`
  const text = `答案甲${PU("search_citation", "0")}与答案乙${PU("search_citation", "1")}。`
  assert.equal(sanitizeInlineRefs(text), "答案甲[1]与答案乙[2]。")
  // 无标记原样返回；自定义 marker
  assert.equal(sanitizeInlineRefs("plain"), "plain")
  assert.equal(sanitizeInlineRefs(PU("t", "x"), { marker: (i) => `<sup>${i}</sup>` }), "<sup>0</sup>")
})

test("connect frame stream drives complete() end to end", async () => {
  const saved = complete._transport
  complete._transport = async function* () {
    yield { op: 2, block: { id: "b1", text: { content: "Hel" } } }
    yield { op: 2, block: { id: "b1", text: { content: "lo" } } }
    yield { chat: { id: "kimi-9" }, message: { id: "m9", status: 2 } }
    yield { done: {} }
  }
  try {
    let last
    for await (const snap of complete({ credentials: "tok", tier: "kimi-fast", prompt: "hi", sessionId: "" })) last = snap
    assert.equal(last.text, "Hello")
    assert.equal(last.status, "COMPLETED")
    assert.equal(last.sessionId, "kimi-9")
    assert.equal(last.messageId, "m9")
  } finally { complete._transport = saved }
})

const CREDS = JSON.stringify({ accessToken: "acc", refreshToken: "ref", userId: "u1" })

test("auth.refresh persists a rotated token pair", async () => {
  const { refreshToken } = await import("../src/kimi-connect.mjs")
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => {
    const enc = new TextEncoder()
    const a = enc.encode("acc-2"), r = enc.encode("ref-2")
    return new Response(new Uint8Array([0x0a, a.length, ...a, 0x12, r.length, ...r]), { status: 200, headers: { "content-type": "application/proto" } })
  }
  try {
    const app = await server()
    const out = await app.auth.refresh({ key: CREDS })
    const parsed = JSON.parse(out.key)
    assert.equal(parsed.accessToken, "acc-2")
    assert.equal(parsed.refreshToken, "ref-2")
    assert.equal(parsed.userId, "u1")
    assert.equal(out.metadata.key, out.key)
  } finally { globalThis.fetch = origFetch }
})

test("auth.refresh on expired session signals signIn expired", async () => {
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(
    JSON.stringify({ code: "unauthenticated", debug: { reason: "REASON_INVALID_AUTH_TOKEN", localizedMessage: { message: "Session expired. Please log in again." } } }),
    { status: 401, headers: { "content-type": "application/json" } },
  )
  try {
    const app = await server()
    await assert.rejects(app.auth.refresh({ key: CREDS }), (e) => e.signIn === "expired")
  } finally { globalThis.fetch = origFetch }
})

test("auth.refresh handles oauth-shaped auth (QR login storage)", async () => {
  // QR 登录后宿主存 {type:"oauth", refresh: <JSON串>, access, expires}——refresh() 必须读 refresh 字段
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => {
    const enc = new TextEncoder()
    const a = enc.encode("acc-3"), r = enc.encode("ref-3")
    return new Response(new Uint8Array([0x0a, a.length, ...a, 0x12, r.length, ...r]), { status: 200, headers: { "content-type": "application/proto" } })
  }
  try {
    const app = await server()
    const out = await app.auth.refresh({ type: "oauth", refresh: CREDS, access: "acc", expires: 0 })
    const parsed = JSON.parse(out.refresh)
    assert.equal(parsed.accessToken, "acc-3")
    assert.equal(parsed.refreshToken, "ref-3")
    assert.equal(out.access, "acc") // 原值保留（宿主用新轮换前的 access）
  } finally { globalThis.fetch = origFetch }
})

test("loader reads oauth-shaped auth (QR login) as well as api-shaped", async () => {
  const app = await server()
  // oauth 形状：凭据 JSON 在 auth.refresh；api 形状：在 auth.key。两者都要能取到凭据
  const oauthLoader = await app.auth.loader(async () => ({ type: "oauth", refresh: CREDS, access: "acc", expires: 0 }))
  assert.equal(oauthLoader.apiKey, "kimi-chat-local")
  // loader.fetch 完整链路用 oauth 形状跑通（mock transport，非流式）
  const saved = complete._transport
  complete._transport = async function* () {
    yield { op: 2, block: { id: "b1", text: { content: "ok" } } }
    yield { done: {} }
  }
  try {
    const res = await oauthLoader.fetch(new Request("https://local/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "kimi-fast", messages: [{ role: "user", content: "hi" }], stream: true }),
    }))
    assert.equal(res.status, 200)
    // 流式读完整 SSE，验证末段包含 "ok" 与 [DONE]
    const text = await res.text()
    assert.match(text, /ok/)
    assert.match(text, /\[DONE\]/)
  } finally { complete._transport = saved }
})

test("token refresh merges onto oauth-shaped storage (no empty-key throw)", async () => {
  // 回归：请求中途 401 刷新后要把新凭据并回 oauth 形状的 storage。
  // 旧代码用 auth?.key ?? auth?.metadata?.key ?? "" 取原文，oauth 形状两者都空
  // → mergeCredentials("") 抛 "Kimi credentials are empty"，整轮请求变成错误帧。
  const { _internal } = await import("../src/index.mjs")
  const oauthAuth = { type: "oauth", refresh: CREDS, access: "acc", expires: 0 }
  const raw = _internal.authRaw(oauthAuth)
  assert.ok(raw.length > 0, "authRaw must read the oauth refresh JSON")
  const merged = JSON.parse(_internal.mergeCredentials(raw, { accessToken: "new-at", refreshToken: "new-rt" }))
  assert.equal(merged.accessToken, "new-at")
  assert.equal(merged.refreshToken, "new-rt")
  assert.equal(merged.userId, "u1", "untouched fields must survive the merge")
})

test("phone-code sign-in: opens the website, exchanges the SMS code, no token copying", async () => {
  const app = await server()
  const enc = new TextEncoder()
  const at = enc.encode("sms-at"), rt = enc.encode("sms-rt"), uid = enc.encode("sms-user")
  const tokenBody = new Uint8Array([
    0x0a, at.length, ...at,
    0x12, rt.length, ...rt,
    0x22, uid.length, ...uid,
  ])
  const seen = []
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    seen.push(u)
    if (u.endsWith("SendVerifyCode")) {
      // Kimi 强制人机验证：400 → 插件转而让用户在官网发码
      return new Response(new Uint8Array([0x08, 0x01]), { status: 400, headers: { "content-type": "application/proto" } })
    }
    if (u.endsWith("LoginWithSMS")) {
      return new Response(tokenBody, { status: 200, headers: { "content-type": "application/proto" } })
    }
    throw new Error("unexpected fetch " + u)
  }
  try {
    const method = app.auth.methods.find(m => /phone code/i.test(m.label))
    assert.ok(method, "phone-code method must exist")
    const grant = await method.authorize({ phone: "86 13800138000" })
    assert.equal(grant.method, "code")
    assert.equal(grant.url, "https://www.kimi.com/login")
    assert.match(grant.instructions, /human check/i, "must explain the captcha step")
    assert.doesNotMatch(JSON.stringify(grant.instructions), /localStorage|copy\(/i, "instructions must not ask for token copying")

    const result = await grant.callback("123456")
    assert.equal(result.type, "success")
    const creds = JSON.parse(result.refresh)
    assert.equal(creds.accessToken, "sms-at")
    assert.equal(creds.refreshToken, "sms-rt")
    assert.equal(creds.userId, "sms-user")
    assert.match(creds.webId, /^[0-9a-f]{32}$/)
    assert.match(creds.ssid, /^[0-9a-f]{32}$/)
    assert.equal(result.accountId, "sms-user")
  } finally { globalThis.fetch = origFetch }
})

test("phone-code sign-in: sends the SMS itself when Kimi allows it", async () => {
  const app = await server()
  const enc = new TextEncoder()
  const at = enc.encode("at3"), rt = enc.encode("rt3")
  const tokenBody = new Uint8Array([0x0a, at.length, ...at, 0x12, rt.length, ...rt])
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.endsWith("SendVerifyCode")) return new Response(new Uint8Array([]), { status: 200, headers: { "content-type": "application/proto" } })
    if (u.endsWith("LoginWithSMS")) return new Response(tokenBody, { status: 200, headers: { "content-type": "application/proto" } })
    throw new Error("unexpected fetch " + u)
  }
  try {
    const grant = await app.auth.methods.find(m => /phone code/i.test(m.label)).authorize({ phone: "86 13800138000" })
    assert.match(grant.instructions, /was sent/i, "no captcha path must say the code was sent")
    assert.equal((await grant.callback("654321")).type, "success")
  } finally { globalThis.fetch = origFetch }
})

test("phone-code sign-in: a rejected code fails honestly, never pretends to sign in", async () => {
  const app = await server()
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.endsWith("SendVerifyCode")) return new Response(new Uint8Array([]), { status: 200, headers: { "content-type": "application/proto" } })
    if (u.endsWith("LoginWithSMS")) return new Response(new Uint8Array([]), { status: 401, headers: { "content-type": "application/proto" } })
    throw new Error("unexpected fetch " + u)
  }
  try {
    const grant = await app.auth.methods.find(m => /phone code/i.test(m.label)).authorize({ phone: "86 13800138000" })
    const result = await grant.callback("000000")
    assert.equal(result.type, "failed")
    assert.match(result.error, /rejected the verification code/i)
    assert.equal(result.refresh, undefined)
  } finally { globalThis.fetch = origFetch }
})

test("repeated search blocks for the same id patch instead of recreating", async () => {
  const saved = complete._transport
  const page = (i) => ({ title: `p${i}`, url: `https://e/${i}`, snippet: "s" })
  complete._transport = async function* () {
    yield { op: 2, block: { id: "s1", search: { keywords: ["k"], webPages: [page(1)] } } }
    yield { op: 2, block: { id: "s1", search: { keywords: ["k"], webPages: [page(1), page(2)] } } }
    yield { done: {} }
  }
  try {
    const events = []
    for await (const snap of complete({ credentials: "tok", tier: "kimi-fast", prompt: "q", sessionId: "" })) events.push(...snap.events)
    const searchEvents = events.filter((e) => e.surfaceId === "search")
    const creates = searchEvents.filter((e) => e.op === "create")
    const patches = searchEvents.filter((e) => e.op === "patch")
    assert.equal(creates.length, 1, "same search block must create only once")
    assert.ok(patches.length >= 1, "later updates must be patches")
    // 白名单组件名（客户端 UI_COMPONENTS 的键），不是裸 surfaceId
    assert.equal(searchEvents[0].component, "search-results")
    // props 形状符合 search-results schema
    assert.equal(typeof searchEvents[0].props.query, "string")
    assert.ok(Array.isArray(searchEvents[0].props.results))
  } finally { complete._transport = saved }
})



