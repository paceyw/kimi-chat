# Changelog

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
