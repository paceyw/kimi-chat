# Changelog

## 0.6.0 — 2026-10-27

**卡片以 `html-card` 组件交给客户端渲染（保留 HTML 产出）**

- 0.5.0 让模型把「组件卡片」直接写成正文里的自包含 HTML；对不做 HTML 渲染的客户端，那就只是一段源码。
  这一版在不改变正文的前提下，**再补一帧 Agent UI Protocol 事件**：`kimi_ui__render` ×
  `component: "html-card"`、`props: { html, title?, text?, height? }`，宿主据此渲染真正的卡片。
- 新增 `src/ui-protocol.mjs` 白名单组件 `html-card`（`html` 必填，`title`/`text`/`height` 可选）。
- 新增 `src/skills.mjs` 的 `extractHtmlCard(text)` / `cardTitle(html)`：按最外层带 `style=` 的
  `<section>`/`<div>` 做配对切分（支持同名嵌套、```` ```html ```` 围栏），切出来的 HTML 原样下发，
  **不清洗、不改写**——安全由宿主在沙箱里保证。正文本身不改：HTML 仍然照常流式发出。
- 流式：卡片帧在正文之后、`finish_reason` 之前发出；`finish_reason` 仍是 `stop`（卡片不是工具调用，
  不会让宿主进入工具循环）。非流式：`message.tool_calls` 里追加同一事件，`content` 保持 HTML。
- 工具调用轮（`finish_reason: "tool_calls"`）不产卡片帧，避免和真正的工具结果混淆。
- 测试：`test/skills.test.mjs` 加 3 条（切分/围栏/忽略无关标记），`test/provider.test.mjs` 加 2 条
  （流式补帧且 `finish_reason` 不变、非流式 content 不变并挂上事件）。全量 **136 条通过**。

## 0.5.0 — 2026-10-27

**工具手册压缩（7 倍）+ Kimi 网页端技能适配**

- 工具渲染改为默认「一行一个工具」的紧凑手册：`- name(path*:str, offset:int): 第一句说明`，
  不再把每个工具的完整 JSON Schema 灌进提示词。真机数据（DSH 声明 305 个工具）：
  完整 schema 330,230 字符 → 默认预算下 45,381 字符（约 8 万 token → 1.2 万），且每个工具都保留签名与说明。
  - 预算默认 48,000 字符（`KIMI_TOOLS_MAX_CHARS`，`0` 关闭）；超预算时按 160→120→96→72→56→40 字
    整体缩短说明，仍超才从最长行退到"只有名字"，最后按 `mcp__server__*` 前缀合并。
  - **工具名永不丢弃**（预算是软目标）：让工具从清单里消失，模型就会转去脑补不存在的工具。
  - `KIMI_TOOLS_MODE=full` 回到旧的完整 JSON Schema 渲染。
- 新增 `src/skills.mjs`：Kimi 网页/桌面容器里的 `/app/.agents/skills/<name>/SKILL.md` 在我们的通道里不存在
  （真机 `read` 报 `FS_NOT_FOUND`），模型失败后常"顺着错思路"只思考不回答（见 `session-72ea02fe…`）。
  现在按需注入环境校正；当用户要「卡片/组件/看板」而客户端没有 widget/artifact 工具时，
  附上 `kimi-widget` 的等价做法（自包含 HTML + 全内联样式 + 先取数再出卡片）。`KIMI_WEB_SKILLS=0` 关闭。
  触发只认 Kimi 容器真实路径（`/app/.agents/skills/`、`/app/skills/`）或 `kimi-widget`：DSH 的真实请求里 `SKILL.md`
  出现 0 次，只有模型自己脑补时才出现，所以别家的"读 SKILL.md"约定不会被误伤。
- 提示词前缀统一为「工具手册 + 技能适配 + 原提示词」，两者都只在需要时出现。
- 测试：新增 `test/tools.test.mjs`（14 条：签名缩写、说明瘦身、预算降级、300 工具语料、标记切分容错）
  与 `test/skills.test.mjs`（6 条）；`test/provider.test.mjs` 加 2 条（工具手册进入提示词、技能适配注入）。
  全量 131 条通过，`npm run check` 覆盖全部 16 个源文件。

## 0.4.3 — 2026-10-27

**空回答自动补一次；标题请求不再逐轮新开 Kimi 会话**

- 上游偶发「只思考不回答」：思考块正常流完，`finish=stop`、正文 0 字、没有工具调用。
  两个真机会话都复现（工具报错后要求排版结果时必现），客户端自己重发一次也还是空的，等于白花两轮。
  现在插件检测到「有思考、无正文、无工具调用」时，在同一会话里追加一句
  「请直接在正文里给出最终答复」再要一次，第二次的思考不重复推给客户端；第二次仍为空才返回空结果。
- 客户端每轮都会额外发一次「给会话起标题」的请求，消息前缀和正文不同，早期会各开一个上游会话，
  Kimi 网页里就多出「Create a concise title…」的对话。现在同一 magpie 会话的标题请求共用一个专用
  chat（`titleSessions`），每会话最多多一个会话，且不影响正文会话的续聊绑定。
- 两个行为都补了离线测试（provider：空回答重试一次、始终为空只重试一次、标题请求续同一 chat）。

## 0.4.2 — 2026-10-27

**推理档夹取补齐「档位之间」的情况**

- 旧逻辑：`reasoning_effort` 不在模型支持的集合里（例如 OpenAI 常见的 `medium`=4，而 Instant 只有 3/5）
  就整个丢掉——结果是客户端明明要了思考，插件既没发档位也没打开 thinking，静默退化成普通快速对话。
- 新逻辑：落在两档之间取最近的一档（并列取高档），所以 `medium`→5、`xhigh`(6)→7（三档模型）；
  超过上界仍夹到上界（`max`→5 for Instant），低于下界（`minimal` 及以下）仍视为“不要思考”。
- 文档：README 的模型表补上「网页里叫 / 上游 id / 场景 / 估算单价」，并写明 `variants` 为空、档位需客户端显式传。
- 测试：`test/tier.test.mjs` 增加 3 条（medium 就近取档并开思考、低于下界不发、xhigh 取 max），全量 106 条。

## 0.4.1 — 2026-10-27

**逐帧取证开关（KIMI_TRACE）+ 快速模型思考档的实测记录**

- 新增 `KIMI_TRACE`：`=1` 写到 `<tmpdir>/kimi-chat-traces/<时间戳>.jsonl`，`=<path>` 写到指定文件。
  内容是 request 摘要（model / scenario / thinking / reasoningEffort / speed / prompt 长度）、
  每一帧 `ChatResponse` 原文、末尾 `end` 摘要（状态 / 正文字数 / 思考字数 / 引用数）。
  令牌与 Authorization 从不落盘，IO 失败静默忽略，不影响对话。
- `PROTOCOL.md` 新增 §4.5：快速模型（`k28-instant`）+ 进阶思考（`reasoningEffort=5`、`thinking=true`）
  的真机逐帧样例，含 `tool.status` 1/2/3 语义、args 流式追加、低档（3）不触发 web_search 的对照数据。
- 测试：新增 `test/trace.test.mjs`（2 条），全量 103 条。

## 0.4.0 — 2026-10-27

**思考档真正生效（连带联网搜索）+ token 记账**

- 修：`reasoning_effort` 之前只写进 `options.reasoningEffort`，没有打开上游 `thinking`，于是快速档
  “静默不思考”。更关键的是：`thinking=false` 时上游不会给这次请求挂 `web_search`，
  所以即使客户端要求联网，快速档也只会回答“我没有实时数据”。现在给了档位就写 `options.thinking = true`
  （fast 与 spec 两条分支都改），实测同一问句从“无工具”变成 19~54 个工具块 + 真实天气 + 引用。
- 修：响应里从来没有 `usage`，magpie 记账全是 `in=0/out=0`，客户端显示「用量 0 tok」且没有价格。
  新增 `src/tokens.mjs` 估算 token：非流式响应带 `usage`；流式在 `stream_options.include_usage`
  时补一帧 `choices: []` + `usage`（OpenAI 标准收尾帧）。`cached_tokens` 恒 0（上游无缓存计数，不编造）。
- 新：识别「给会话起标题」这类请求（system 含 `Create a concise title…`），自动关掉思考与联网搜索，
  不浪费额度。
- 测试：`test/tier.test.mjs`（档位夹取 + thinking 联动，5 条）、`test/tokens.test.mjs`（3 条）、
  provider 追加 3 条 usage 断言；共 101 条全绿。
- 文档：README 记下「思考与联网是同一个开关」「usage 是估算」；PROTOCOL §12.1 补实测数据与
  `kimi.chat.v1.Usage`（搜索配额，非 token）的字段证据。

## 0.3.2 — 2026-10-27

**登录说明排版修正**

- 弹窗正文是普通段落（宿主 `.signing .s` 没有 `white-space: pre-wrap`），换行会被折叠成一个空格，
  `第 1 步…` 整片挤成一段。两条方式的说明改为单段 + `① ② ③ ④` 行内编号，折行后仍能看出步骤边界。
- 粘贴方式不再要求用户从说明文字里选中命令：改为 DevTools → Application → Local Storage →
  `refresh_token` → 右键 **Copy value**，复制的就是浏览器里的真实令牌（Console 的
  `copy(localStorage.refresh_token)` 保留为可选的快捷方式）。
- 文档同步：README 与 `PROTOCOL.md` §6 记下「弹窗不能保留换行」与「插件 `authorize()` 没有可用的复制字段」
  这两条宿主限制，避免以后再写成一行一步。

## 0.3.1 — 2026-10-27

**登录界面**

- 两条登录方式的 `label`、分步说明（`instructions`）与报错文案全部改为中文。
- 说明改成一行一步：手机验证码方式按「第 1 步…第 4 步」列出（等短信 / 填 6 位码 / 插件自己换凭据），
  粘贴方式按「第 1 步…第 4 步」列出（登录 / F12 控制台 / 复制命令 / 粘贴），Console 命令单独占一行。
- 手机号与粘贴内容的校验、失败提示同步中文化（例如「验证码不正确或已过期，请重新获取一次」）。

## 0.3.0 — 2026-10-27

**登录**

- 新的默认方式「Sign in on the Kimi website (phone code)」：magpie 打开 `https://www.kimi.com/login`，用户填手机号 →
  收到 6 位短信验证码 → 填回 magpie。插件用 `LoginWithSMS` 直接把验证码换成会话令牌，**不需要复制任何 token**。
  当 Kimi 要求人机验证时（常见），用户就在刚打开的页面里发码，其余流程不变。
- 移除扫码登录（`CreateLoginQRCode`/`GetLoginQRCodeStatus` 轮询）：`/wechat/mp/auth` 是微信专用确认页，桌面浏览器无法完成。
- 原网页登录改为备用项「Advanced: paste a refresh_token from the website」，仅在收不到短信/号码不支持时使用。
- 记录并排除「Kimi Code OAuth 设备授权」方案：该通道能自动换 token，但签发 `scope=kimi-code`（`iss=kimi-auth`），
  网页 Chat 与用量接口都回 401（见 `PROTOCOL.md` §6.3）。

## 0.2.0 — 2026-10-27

**登录**

- 新增「网页登录」并设为默认方式：magpie 打开 `https://www.kimi.com/login`，用户在网页里登录后粘贴
  `refresh_token`（或在 Console 里 `copy(JSON.stringify({accessToken, refreshToken}))`）。插件交换令牌做活体验证，
  账号归属从 JWT 的 `sub` 取，不再需要手填 userId。
- 粘错令牌会被明确拒绝（粘成 `access_token`、空输入、乱码各有独立文案）；网络故障不再被当成登录成功。
- 保留扫码与短信两种方式；移除旧的「粘贴整段 DevTools JSON」独立方法（已被网页登录覆盖）。

**模型**

- 模型清单按上游 `GetAvailableModels` 实际返回动态生成，`kimi-<slug>` 入口自动出现，三个稳定档位不再被遮蔽。
- 思考档按模型区分：Instant 为低/高，其余为低/高/最高，请求层按模型夹取。

**用量**

- `auth.usage` 只报月额度窗口（已用百分比、套餐名、到期时间），按套餐价折算金额；不再展示 5 小时 / 每周限流窗口。

**包**

- 包名改为 `kimi-chat`，供应商显示名改为 `Kimi Chat (Web)`；补齐 `repository`/`homepage`/`bugs`、`magpie.icon`、
  `exports["./server"]`、MIT LICENSE。

## 0.1.0 — 2026-10-26

- 首版：三档模型（fast / thinking / agent）、流式对话、联网搜索与引用、生成式 UI 事件、客户端工具调用。
