# Changelog

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
