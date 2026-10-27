// Kimi Chat provider plugin for Magpie. Phase-1 skeleton: message validation,
// session mapping via chat.headers + x-magpie-session, streaming/non-streaming
// OpenAI responses, abort propagation, usage reporting. Upstream protocol is
// provisional until Phase 1 capture (see kimi-api.mjs).

import { LIMITS, PROVIDER, NAME, ORIGIN, MODELS } from "./config.mjs"
import { buildCatalog, toProviderModels, DEFAULT_PRICING } from "./models.mjs"
import { chunk, finishReason, messageText, toPrompt, validateMessages } from "./openai.mjs"
import { classifyError, complete, parseCredentials, resolveModels, safeErrorMessage } from "./kimi-api.mjs"
import {
  cancelChat, refreshToken,
  sendVerifyCode, loginWithSMS, parsePhoneNumber, getSubscriptionStats, getSubscription,
} from "./kimi-connect.mjs"
import { uiToolCall, uiEvent as uiEventRaw } from "./ui-protocol.mjs"
import { toUsageReport, DEFAULT_PLAN_CNY } from "./usage.mjs"
import { scanToolCalls, toolCallDelta, toolPrompt } from "./tools.mjs"
import { buildCredentials, parseLoginInput } from "./login.mjs"

const sessions = new Map() // sessionId -> { kimiSessionId, updatedAt, fingerprint }
// 会话映射淘汰：容量上限 256 + 24h 过期，防止内存无界增长
const MAX_SESSIONS = 256
const SESSION_TTL = 24 * 3600_000
function evictSessions() {
  const now = Date.now()
  for (const [k, v] of sessions) if (now - v.updatedAt > SESSION_TTL) sessions.delete(k)
  if (sessions.size <= MAX_SESSIONS) return
  const byAge = [...sessions.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)
  for (let i = 0; i < byAge.length - MAX_SESSIONS; i++) sessions.delete(byAge[i][0])
}

// 请求中途 401 刷新得到的新凭据，供 auth.refresh() 在下次 magpie 调用时持久化
let pendingRefresh = null

// QR 登录用设备指纹：webId 每插件实例生成一次（存 auth metadata 由 authorize 写入），
// ssid 每次登录随机。宿主 save() 把 authorize 结果的 refresh/access/expires 存为
// {type:"oauth", refresh, access, expires}，loader 的 getAuth() 据此读取。
function fingerprint(auth) {
  return authRaw(auth)
}

function randomId() {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return [...b].map(x => x.toString(16).padStart(2, "0")).join("")
}

function deviceWebId() {
  return randomId()
}

// 宿主存两种形状（宿主 save()）：api → {key}；oauth → {refresh, access, expires}。
// 我们的凭据 JSON 都放在其中的字符串字段里。
function authRaw(auth) {
  return String(auth?.key ?? auth?.refresh ?? auth?.metadata?.key ?? "")
}

// 消息前缀指纹：role + 文本内容哈希（FNV-1a 32bit），用于判断客户端是否全量重发
function prefixFingerprint(messages) {
  let h = 0x811c9dc5
  for (const m of messages ?? []) {
    const text = messageText(m) ?? ""
    for (const part of [m.role ?? "", text]) {
      for (let i = 0; i < part.length; i++) { h ^= part.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
      h ^= 0x1f; h = Math.imul(h, 0x01000193) >>> 0
    }
  }
  return h.toString(36)
}

// 把刷新后的凭据对象序列化回登录时的 JSON 形状（保留未变字段）
function mergeCredentials(raw, refreshed) {
  const base = parseCredentials(raw)
  return JSON.stringify({
    accessToken: refreshed.accessToken || base.accessToken,
    refreshToken: refreshed.refreshToken || base.refreshToken,
    userId: base.userId, webId: base.webId, ssid: base.ssid,
    shieldData: base.shieldData, timezone: base.timezone,
  })
}

export const server = async () => {
  // 模型清单按上游 GetAvailableModels 的实际返回生成（匿名可调、10 分钟缓存）。
  // 拿不到清单就退回三档固定入口——绝不让模型目录把插件启动拖死。
  let catalog = { models: MODELS, specs: {} }
  try {
    const resolved = await Promise.race([
      resolveModels({ timezone: "Asia/Shanghai" }),
      new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
    ])
    if (resolved?.list?.length) catalog = buildCatalog({ list: resolved.list })
  } catch {}
  const providerModelMap = toProviderModels(catalog.models, {
    context: 128_000,
    output: LIMITS.maxOutputCharacters,
    // magpie 的费用估算按这张表算（¥/1M tokens，由月额度百分比反推，见 models.mjs 注释）
    pricing: DEFAULT_PRICING,
  })
  const config = { name: NAME, api: ORIGIN, models: providerModelMap }
  return {
    config(cfg) {
      cfg.provider ??= {}
      // 已安装过的账号在 plugin-providers.json 里已有条目，`??=` 会原样保留旧的 models 列表，
      // 于是模型清单永远停在"首次安装那一刻"（实测：动态清单加进来了，/v1/models 仍只有三档）。
      // 这里用当次清单覆盖 models，同时保留条目里由宿主写入的字段（签名状态/accountId/usage 等）。
      const prev = cfg.provider[PROVIDER]
      cfg.provider[PROVIDER] = { ...(prev && typeof prev === "object" ? prev : {}), ...config }
    },
    async "chat.headers"(input, output) {
      if (input?.model?.providerID === PROVIDER && input.sessionID) output.headers["x-magpie-session"] = input.sessionID
    },
    auth: {
      provider: PROVIDER,
      // 官方站点图标（pwa-192.png）：magpie 的 iconOf 读取 auth.icon，
      // 支持 https URL 或 data:image；Web UI 直接 <img src> 展示。
      icon: "https://www.kimi.com/pwa-192.png",
      methods: [
        {
          // 主登录方式：magpie 打开官方登录页 → 用户用手机验证码登录 → 插件自动换 token。
          // 实测（PROTOCOL.md §6.3）：SendVerifyCode 强制人机验证，短信一般要在官网页面发；
          // 但 LoginWithSMS 不校验 captcha，验证码正确就能换到 web token ——
          // 用户全程不需要复制 token，只需要输入收到的 6 位验证码。
          type: "oauth",
          label: "手机验证码登录（推荐）",
          prompts: [{
            type: "text",
            key: "phone",
            message: "Kimi 账号的手机号，带国际区号（例如 86 13800138000）",
            placeholder: "86 13800138000",
            validate: (value) => {
              try { parsePhoneNumber(value); return undefined } catch (e) { return e.message }
            },
          }],
          async authorize(inputs = {}) {
            let phone
            try { phone = parsePhoneNumber(inputs.phone) } catch (error) { return { type: "failed", error: error.message } }
            const shown = `+${phone.countryCode} ${phone.number}`
            // 先试着直接发码；Kimi 会要求人机验证（不绕）——那就让用户在官网自己发码
            let sent = { ok: false, captcha: true, message: "" }
            try { sent = await sendVerifyCode(phone) } catch (error) { sent = { ok: false, captcha: true, message: error?.message ?? "" } }
            const instructions = sent.ok
              ? [
                  `验证码已发送到 ${shown}。`,
                  "",
                  "第 1 步　稍等几秒，查看手机短信。",
                  `第 2 步　在下方输入框填入收到的 6 位数字，然后确认。`,
                  "第 3 步　插件会用这个验证码自己换取登录凭据，全程不需要复制任何 token。",
                ].join("\n")
              : [
                  "Kimi 发送短信前要求先过人机验证，所以验证码要在网页里发。",
                  "",
                  "第 1 步　在弹出的 Kimi 网页（https://www.kimi.com/login）里选择手机号验证码登录。",
                  `第 2 步　填入手机号 ${shown}，完成滑块或人机验证，点「发送验证码」。`,
                  "第 3 步　回到这里，在下方输入框填入短信里的 6 位数字，然后确认。",
                  "第 4 步　插件会用这个验证码自己换取登录凭据，全程不需要复制任何 token。",
                ].join("\n")
            return {
              // 跳转官方网页登录：这一页既能完成人机验证发码，也让用户看清登录的是哪个账号。
              url: `${ORIGIN}/login`,
              instructions,
              method: "code",
              async callback(code) {
                const digits = String(code ?? "").replace(/\D/g, "")
                if (!digits) return { type: "failed", error: "请先输入短信里的验证码" }
                let r
                try {
                  r = await loginWithSMS(phone, digits)
                } catch (error) {
                  const why = error?.kind === "unauthorized"
                    ? "验证码不正确或已过期，请重新获取一次"
                    : (error?.message ?? String(error))
                  return { type: "failed", error: why }
                }
                const webId = deviceWebId()
                const creds = {
                  accessToken: r.accessToken,
                  refreshToken: r.refreshToken,
                  userId: r.userId || webId,
                  webId,
                  ssid: randomId(),
                  timezone: "Asia/Shanghai",
                }
                const key = JSON.stringify(creds)
                return { type: "success", refresh: key, access: r.accessToken, expires: 0, accountId: r.userId || webId }
              },
            }
          },
        },
        {
          // 备用登录：在官网登录后把 refresh_token 贴进来。
          // 只要 refresh_token 就够（实测 PROTOCOL.md §6.2：X-Traffic-Id / webId / ssid 都不是必需），
          // userId 从刷新后的 access token（JWT）的 sub 里取，账号归属不用用户手填。
          type: "oauth",
          label: "高级：粘贴网页 refresh_token（备用）",
          async authorize() {
            return {
              url: `${ORIGIN}/login`,
              instructions: [
                "备用方式。上面的「手机验证码登录」不需要复制任何东西，建议优先用它。",
                "",
                "第 1 步　在弹出的 Kimi 网页里登录你的账号（手机号、微信、密码都可以）。",
                "第 2 步　登录成功后按 F12 打开开发者工具，切到 Console（控制台）标签。",
                "第 3 步　在控制台粘贴下面这一行并回车，refresh_token 会直接进剪贴板：",
                "　　　copy(localStorage.getItem('refresh_token'))",
                "第 4 步　回到这里，在下方输入框粘贴（Ctrl+V），然后确认。",
                "",
                "如果想一次粘贴两个 token，第 3 步改用这一行：",
                "　　　copy(JSON.stringify({accessToken: localStorage.getItem('access_token'), refreshToken: localStorage.getItem('refresh_token')}))",
              ].join("\n"),
              method: "code",
              async callback(input) {
                let parsed
                try {
                  parsed = parseLoginInput(input)
                } catch (error) {
                  return { type: "failed", error: error.message }
                }
                const device = { webId: deviceWebId(), ssid: randomId() }
                if (!parsed.refreshToken) {
                  return { type: "failed", error: "这里只拿到了 access_token，请改粘贴 refresh_token" }
                }
                // 活体验证：拿 refresh_token 当场换新 access token。
                // 401 = 粘贴的值不对/已登出；网络故障不能假装登录成功。
                let nt
                try {
                  nt = await refreshToken({ refreshToken: parsed.refreshToken })
                } catch (error) {
                  if (error?.kind === "unauthorized") {
                    return { type: "failed", error: "Kimi 拒绝了这个 refresh_token（已过期或已退出登录），请重新登录后复制最新的值" }
                  }
                  return { type: "failed", error: "连接 Kimi 失败：" + safeErrorMessage(error?.message ?? error) }
                }
                const creds = buildCredentials(
                  {
                    accessToken: nt.accessToken,
                    refreshToken: nt.refreshToken || parsed.refreshToken,
                    userId: parsed.userId,
                    timezone: "Asia/Shanghai",
                  },
                  device,
                )
                const key = JSON.stringify(creds)
                return { type: "success", refresh: key, access: nt.accessToken, expires: 0, accountId: creds.userId || "kimi-web-account" }
              },
            }
          },
        },
      ],
      // magpie 在请求前调用：主动续期并把新凭据交还持久化（"magpie saves what this gives"）
      async refresh(auth) {
        const raw = authRaw(auth)
        const creds = parseCredentials(raw)
        if (!creds.refreshToken) return undefined
        // 优先消费请求中途已刷新的结果，避免重复打 auth 端点
        if (pendingRefresh) { const key = pendingRefresh; pendingRefresh = null; return { key, metadata: { key } } }
        try {
          const nt = await refreshToken(creds)
          const key = mergeCredentials(raw, nt)
          // oauth 形状（QR 登录）交回 refresh 字段；api 旧形状交回 key
          return auth?.type === "oauth" && !auth?.key
            ? { refresh: key, access: creds.accessToken, expires: 0, metadata: { key } }
            : { key, metadata: { key } }
        } catch (error) {
          if (error.kind === "unauthorized") throw Object.assign(new Error(safeErrorMessage(error.message)), { signIn: "expired" })
          return undefined // 临时故障不打断，下次请求再试
        }
      },
      async loader(getAuth) {
        const auth = await getAuth()
        const credentials = parseCredentials(authRaw(auth))
        const active = fingerprint(auth)
        return {
          baseURL: ORIGIN,
          apiKey: "kimi-chat-local",
          async fetch(input, init) {
            const request = input instanceof Request ? input : new Request(input, init)
            const requestAbort = new AbortController()
            const abortRequest = () => requestAbort.abort(request.signal.reason ?? new Error("Request cancelled"))
            if (request.signal.aborted) abortRequest()
            else request.signal.addEventListener("abort", abortRequest, { once: true })
            const cleanupAbort = () => request.signal.removeEventListener("abort", abortRequest)
            const invalid = (message) => { cleanupAbort(); throw new Error(message) }
            let body
            try { body = await request.json() } catch { return invalid("Kimi expects a JSON chat completion request") }
            if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("Kimi expects a JSON chat completion object")
            const modelId = body.model ?? "kimi-fast"
            const model = MODELS[modelId] ?? catalog.models[modelId]
            if (!model) return invalid(`Kimi unknown model ${modelId}`)
            if (!Array.isArray(body.messages) || body.messages.length === 0) return invalid("Kimi requires at least one message")
            if (body.messages.length > LIMITS.maxMessages) return invalid(`Kimi accepts at most ${LIMITS.maxMessages} messages`)
            // 客户端工具（OpenAI tools）不是上游的一等能力：渲染成提示词里的工具手册，
            // 再把模型输出的 <tool_call> 转回 OpenAI tool_calls（见 tools.mjs）。
            const toolBlock = toolPrompt(body.tools)
            try { validateMessages(body.messages) } catch (error) { return invalid(error.message) }

            const id = `chatcmpl-${Math.random().toString(36).slice(2, 12)}`
            const created = Math.floor(Date.now() / 1000)
            const sessionId = request.headers.get("x-magpie-session") || null
            const bound = sessionId ? sessions.get(sessionId) : null
            // 续聊条件：客户端重发的消息前缀与上一轮完全一致（全量重发模式）。
            // 前缀不匹配（客户端裁剪过历史/只发增量）→ 开新上游会话，全量压平，避免历史重复。
            const prefixMatch = !!(bound && bound.fingerprint === active && bound.prefixHash === prefixFingerprint(body.messages.slice(0, bound.consumedMessages)))
            const useState = prefixMatch ? bound : null
            const skip = useState?.consumedMessages ?? 0
            const head = skip > 0 ? body.messages.slice(0, skip).filter((m) => m.role === "system" || m.role === "developer") : []
            let tail = body.messages.slice(skip)
            let prompt = head.length ? [...head.map((m) => messageText(m)), toPrompt(tail)].filter(Boolean).join("\n\n") : toPrompt(tail)
            // 客户端原样重发同一段历史（没有新增消息）时，裁剪会把内容全裁掉——退回全量压平，
            // 让上游接着聊，而不是抛 "requires non-empty text"。
            if (!prompt.trim() && skip > 0) {
              tail = body.messages.slice()
              prompt = head.length ? [...head.map((m) => messageText(m)), toPrompt(tail)].filter(Boolean).join("\n\n") : toPrompt(tail)
            }
            if (!prompt.trim()) return invalid("Kimi requires non-empty text")
            if (toolBlock) prompt = `${toolBlock}\n\n${prompt}`
            if (prompt.length > LIMITS.maxPromptCharacters) return invalid("Kimi prompt is too large")
            let step0 = {}

            const run = async (emit) => {
              let upstreamChatId = null, upstreamMessageId = null
              const iterator = complete({
                origin: ORIGIN,
                credentials,
                tier: model.tier,
                spec: catalog.specs[modelId],
                prompt,
                sessionId: useState?.kimiSessionId ?? null,
                search: body.search_enabled !== false,
                // 思考档位：OpenAI 语义名（low/medium/high/max）、数字（3/5/7）都接受，
                // 由 tierToRequest 按该模型支持的档位集合夹取（Instant 只有 3/5）。
                reasoningEffort: body.reasoning_effort ?? body.reasoningEffort,
                // 网页端"速度/对话长度"两个刻度：客户端可显式覆盖（字符串枚举名或数字），
                // 未知值由 tierToRequest 丢弃，绝不会把非法枚举发给上游。
                speed: body.speed ?? body.kimi_speed,
                contextLength: body.context_length ?? body.contextLength,
                signal: requestAbort.signal,
                onTokenRefresh: (nt) => { pendingRefresh = mergeCredentials(authRaw(auth), nt) },
              })
              // 客户端取消时通知上游停止生成（前端模式：断流 + fire-and-forget cancelChat，吞错）
              const upstreamCancel = () => { if (upstreamChatId) void cancelChat(credentials, { chatId: upstreamChatId, messageId: upstreamMessageId ?? undefined }).catch(() => {}) }
              requestAbort.signal.addEventListener("abort", upstreamCancel, { once: true })
              try {
                for (;;) {
                  const step = await iterator.next()
                  if (step.done) break
                  if (step.value?.sessionId) upstreamChatId = step.value.sessionId
                  if (step.value?.messageId) upstreamMessageId = step.value.messageId
                  await emit(step.value)
                }
              } catch (error) {
                // 续聊失败（上游会话可能已被删除/过期）：清除映射，下一轮自动回退全量压平开新会话
                if (sessionId && useState && error?.kind !== "unauthorized" && error?.kind !== "cancelled") {
                  sessions.delete(sessionId)
                }
                throw error
              } finally {
                requestAbort.signal.removeEventListener("abort", upstreamCancel)
                await iterator.return?.()
              }
              // 记录本轮已消费的消息数，供下一轮续聊裁剪；仅在同一会话指纹下生效
              if (sessionId && step0.sessionId) {
                sessions.set(sessionId, { kimiSessionId: step0.sessionId, updatedAt: Date.now(), fingerprint: active, consumedMessages: body.messages.length, prefixHash: prefixFingerprint(body.messages) })
                evictSessions()
              }
            }

            if (body.stream === false) {
              try {
                let text = "", reasoning = "", status = "FINISHED", events = [], citations = [], clientCalls = 0
                await run((state) => { step0 = state; text = state.text; reasoning = state.reasoning; status = state.status ?? status; events.push(...(state.events ?? [])); if (state.citations?.length) citations = state.citations.slice() })
                const message = { role: "assistant", content: text }
                if (reasoning) message.reasoning_content = reasoning
                if (toolBlock) {
                  const scanned = scanToolCalls(text)
                  message.content = scanned.text
                  clientCalls = scanned.calls.length
                  if (clientCalls) message.tool_calls = scanned.calls.map((call, index) => toolCallDelta(call, index))
                }
                if (events.length) {
                  message.tool_calls ??= []
                  const base = message.tool_calls.length
                  for (const [index, event] of events.entries()) message.tool_calls.push(uiToolCall(event, { index: base + index }))
                }
                if (citations.length) {
                  message.tool_calls ??= []
                  message.tool_calls.push(uiToolCall(uiEventRaw("create", { surfaceId: "citations", itemId: "citations", seq: events.length, component: "citation-list", props: { citations } }), { index: message.tool_calls.length }))
                  message.annotations = citations.map((c) => ({ type: "url_citation", url: c.url, title: c.title }))
                }
                return new Response(JSON.stringify({ id, object: "chat.completion", created, model: modelId, choices: [{ index: 0, message, finish_reason: clientCalls ? "tool_calls" : finishReason(status) }] }), { headers: { "content-type": "application/json" } })
              } finally { cleanupAbort() }
            }

            const output = new TransformStream(undefined, { highWaterMark: 1 }, { highWaterMark: 64 * 1024, size(value) { return value.byteLength } })
            const writer = output.writable.getWriter()
            const abortOutput = () => { writer.abort(requestAbort.signal.reason).catch(() => {}) }
            requestAbort.signal.addEventListener("abort", abortOutput, { once: true })
            writer.closed.catch((error) => {
              if (!requestAbort.signal.aborted) requestAbort.abort(error ?? new Error("Client cancelled the stream"))
            })
            const encoder = new TextEncoder()
            const write = async (value) => {
              requestAbort.signal.throwIfAborted()
              await writer.write(encoder.encode(value))
            }
            void (async () => {
              let sentText = 0, sentReasoning = 0, role = false, status = "FINISHED", uiIndex = 0, sentCitations = 0, citationsSeen = false, uiSeq = 0, sentCalls = 0, toolCallsSeen = false
              const seqNext = () => uiSeq++
              try {
                await run(async (state) => {
                  step0 = state
                  if (!role) { role = true; await write(chunk(id, created, modelId, { role: "assistant", content: "" })) }
                  status = state.status ?? status
                  if (state.reasoning.length > sentReasoning) { const value = state.reasoning.slice(sentReasoning); sentReasoning = state.reasoning.length; await write(chunk(id, created, modelId, { reasoning_content: value })) }
                  // 客户端工具：从累计正文里剥离 <tool_call> 块，正文照常流式，调用转成 tool_calls 增量
                  const scanned = toolBlock ? scanToolCalls(state.text) : { text: state.text, calls: [] }
                  if (scanned.text.length > sentText) { const value = scanned.text.slice(sentText); sentText = scanned.text.length; await write(chunk(id, created, modelId, { content: value })) }
                  if (scanned.calls.length > sentCalls) {
                    for (; sentCalls < scanned.calls.length; sentCalls++) {
                      await write(chunk(id, created, modelId, { tool_calls: [toolCallDelta(scanned.calls[sentCalls], uiIndex++)] }))
                      toolCallsSeen = true
                    }
                  }
                  // UI 事件以 kimi_ui__* 工具调用信封发出，由客户端拦截渲染
                  for (const event of state.events ?? []) {
                    await write(chunk(id, created, modelId, { tool_calls: [uiToolCall(event, { index: uiIndex++ })] }))
                  }
                  // 引用列表：新增引用到达时以 citation-list 组件 patch（首次 create）
                  if (state.citations.length > sentCitations) {
                    const citations = state.citations.slice()
                    sentCitations = citations.length
                    await write(chunk(id, created, modelId, { tool_calls: [uiToolCall(uiEventRaw(
                      citationsSeen ? "patch" : "create",
                      { surfaceId: "citations", itemId: "citations", seq: seqNext(), component: "citation-list", props: { citations } },
                    ), { index: uiIndex++ })] }))
                    citationsSeen = true
                  }
                })
                await write(chunk(id, created, modelId, {}, toolCallsSeen ? "tool_calls" : finishReason(status)))
                await write("data: [DONE]\n\n")
                await writer.close()
              } catch (error) {
                if (requestAbort.signal.aborted) {
                  await writer.abort(requestAbort.signal.reason ?? error).catch(() => {})
                } else {
                  try {
                    await write(`data: ${JSON.stringify({ error: { message: safeErrorMessage(error?.message), type: "upstream_error", code: classifyError(error) } })}\n\n`)
                    await writer.close()
                  } catch {}
                }
              } finally {
                requestAbort.signal.removeEventListener("abort", abortOutput)
                cleanupAbort()
              }
            })()
            return new Response(output.readable, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } })
          },
        }
      },
      // 订阅用量：magpie 设置页会展示 plan / until / balance / windows。
      // 只读 MembershipService 的两个接口（不是 token 计数，也不是聊天帧里的 usage）：
      //   GetSubscriptionStats → 月额度百分比；GetSubscription → 套餐名（goods.title）。
      // windows 只有月额度一项：5 小时/每周限流是限流器内部计数，不作为展示项。
      async usage(getAuth) {
        const mapped = [...sessions.values()]
        const now = Date.now()
        const live = mapped.filter((s) => now - s.updatedAt < 6 * 3600_000).length
        const sessionLine = mapped.length ? `${live} active / ${mapped.length} mapped session(s)` : "no active sessions"
        const priceCny = Number(process.env.KIMI_PLAN_CNY ?? DEFAULT_PLAN_CNY)
        try {
          const stored = typeof getAuth === "function" ? await getAuth() : null
          let auth = parseCredentials(authRaw(stored))
          const timeout = () => AbortSignal.timeout(15_000)
          // access token 可能刚过期：临时刷新一次重试，但**不写回存储**——
          // 下一轮对话的 onTokenRefresh 会正常保存，避免统计请求抢写凭据。
          const call = async (fn) => {
            try {
              return await fn(auth)
            } catch (error) {
              if (!/http 401/.test(String(error?.message))) throw error
              const rotated = await refreshToken(auth, { signal: timeout() })
              auth = { ...auth, ...rotated }
              return fn(auth)
            }
          }
          const stats = await call((a) => getSubscriptionStats(a, { signal: timeout() }))
          // 套餐名拿不到不算错误：退回泛称「Kimi 会员」
          const sub = await call((a) => getSubscription(a, { signal: timeout() })).catch(() => null)
          const planName = String(sub?.subscription?.goods?.title ?? "").trim()
          return { ...toUsageReport(stats, { priceCny, planName }), user: sessionLine }
        } catch (error) {
          return { plan: "", balance: "", until: "", windows: [], user: sessionLine, error: safeErrorMessage(error?.message) }
        }
      },
    },
    provider: { id: PROVIDER, async models() { return providerModelMap } },
  }
}

export default { id: PROVIDER, server }
export const _internal = { sessions, fingerprint, authRaw, mergeCredentials }







