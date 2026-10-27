# kimi-chat

`kimi.com` 网页版 Kimi Chat → OpenAI Chat Completions / Responses 的 **magpie 原生 provider 插件**。
用你自己 kimi.com 账号的会员额度对话：不用官方 API key，也不是 Kimi Code / Kimi API 的转发。

- 供应商 id：`kimi-chat`（客户端里写作 `kimi-chat/kimi-fast` 这样）
- 上游：`https://www.kimi.com/apiv2`（connect-rpc over protobuf，私协议，见 [PROTOCOL.md](PROTOCOL.md)）
- 能力：流式对话、思考档、联网搜索 + 引用、客户端工具调用（`tools`）、生成式 UI 事件、月额度与费用估算

## 安装

```bash
# 直接从 GitHub 装（浅克隆当前代码，无需等 npm 发布）
magpie plugin add github:paceyw/kimi-chat

# 发布到 npm 之后也可以用包名
magpie plugin add kimi-chat
```

装好后在供应商列表里会出现 **Kimi Chat (Web)**，点进去添加账号即可（下一步就是登录）。仓库打了 `magpie-plugin` topic，
所以在 magpie 的「插件 → 发现 → 非官方插件 · GitHub」里也能直接找到。

## 它登录什么

登录的是**你在 kimi.com 的网页账号**（同一份会员/订阅额度，也就是网页里聊天消耗的那个月额度）。
插件不做账号池、不做多人共享、不代注册；一个 magpie 账号 = 一个 Kimi 账号。

## 怎么登录

### 方式 A：网页登录（推荐）

1. magpie → 供应商 `kimi-chat` → 添加账号，选 **“Sign in on the Kimi website”**。
2. magpie 会打开 <https://www.kimi.com/login>，在页面里用手机号 / 微信 / 密码正常登录。
3. 回到 magpie 的输入框，粘贴你的 `refresh_token`：

   - DevTools（F12）→ **Application → Local Storage → `https://www.kimi.com`** → 复制键 `refresh_token` 的值；
   - 或者更快：在 DevTools 的 **Console** 里执行

     ```js
     copy(localStorage.getItem('refresh_token'))
     ```

     令牌会直接进剪贴板，回到 magpie 粘贴即可。

4. 插件立刻拿这个 `refresh_token` 去换 `access_token`：
   - 换成功 → 登录完成，账号归属（`accountId`）取自令牌里的 `sub`，不需要你填任何 ID；
   - 换失败（401 / 已登出）→ 当场报错，不会存下一个几分钟后就失效的坏凭据。

只粘 `refresh_token` 一个值就够了：`access_token` 由插件自己换，设备指纹（device/session id）由插件本地生成。

### 方式 B：扫码（Kimi App / 微信）

添加账号时选 `Kimi Chat app sign-in (scan the QR code)`，在打开的 kimi.com 页面里用 Kimi App 或微信扫码确认，**全自动完成**（二维码过期会自动换新，总窗口 5 分钟）。

### 方式 C：手机号 + 短信验证码

选 `Sign in with phone number (SMS code)`：如果 Kimi 允许直接发码，插件会发；如果要人机验证（常见），插件会提示你**自己在官网发码**（在网页里过人机验证），然后把收到的 6 位码填回 magpie。

## 登录信息存在哪里

全部只存在本机 magpie 的配置目录里，插件不上传、不写日志：

| 位置 | 内容 |
|---|---|
| `~/.config/magpie/plugin-auth.json`（容器部署时是 `magpie` 的 `/config/magpie/plugin-auth.json`，权限 600） | `kimi-chat` 条目：`{type:"oauth", refresh:"<整份凭据 JSON>", access:"", expires:0, accountId:"<userId>"}` |
| 上面 `refresh` 字段里的 JSON | `accessToken`、`refreshToken`、`userId`、`webId`、`ssid`、`timezone` |
| `~/.config/magpie/plugin-providers.json` | 只放供应商/模型/登录状态等元数据，**不含令牌** |

凭据是明文文件（与 magpie 其它插件一致），所以按普通密钥对待：别提交到仓库、别贴到公开 issue。
想换账号：再登录一次即可（`accountId` 相同会替换旧账号）；想彻底撤销：在 kimi.com 网页里登出，再删掉 `plugin-auth.json` 里的 `kimi-chat` 条目。

## 凭证生命周期

- `refresh_token` 是长期凭据，`access_token` 只有约 15 分钟寿命。
- 插件在每次请求前按需刷新（magpie `auth.refresh`），请求中途遇到 401 也会刷新一次并继续那一轮，所以正常使用不需要你重新登录。
- 只有上游明确拒绝（登出 / refresh_token 失效）才判定“需要重新登录”，网络抖动不会被当成分手。

## 请求走到哪里

- 对话：`POST https://www.kimi.com/apiv2/kimi.chatty.ChatService/Chat`（流式，connect 协议）
- 模型清单：`ConfigService/GetAvailableModels`；刷新令牌：`https://auth.kimi.com/.../AuthService/RefreshToken`
- 额度：`MembershipService/GetSubscription` + `GetSubscriptionStats` + `ListBalanceActions`
- 只对 `www.kimi.com` 与 `auth.kimi.com` 发请求；不跟重定向，不把令牌发到别的主机。

## 模型

模型清单**按上游实际返回动态生成**（`GetAvailableModels`，缓存 10 分钟），并始终保留三个稳定入口：

| 入口 | 上游 | 思考档 | 说明 |
|---|---|---|---|
| `kimi-fast` | Instant（`scenario=CHAT`） | 低 / 高 | 日常对话，最省额度 |
| `kimi-thinking` | Agent 模型 + `thinking=true` | 低 / 高 / 最高 | 思考输出 → `reasoning_content` |
| `kimi-agent` | Agent（`scenario=OK_COMPUTER`）+ 插件能力 | 低 / 高 / 最高 | 联网、工具、时间线 |
| `kimi-<slug>` | 上游返回的其它模型（如 K3.1 Pro / K2.8 Preview） | 低 / 高 / 最高 | 由 `display_name` 派生，不覆盖上面三档 |

思考档通过 `reasoning_effort` 传（`low`/`high`/`max` → 上游 3/5/7，按模型夹取；Instant 只有低/高）。

其它固定事实（实测，见 PROTOCOL.md §12）：

- **对话长度**：你的套餐里所有模型的“超长上下文”都不可选（需要更高会员等级，实测被 403 拒绝），所以插件固定用标准档（L），不做这个选项。
- **速度**：只有 K3.1 Pro 有“标准/高速”，高速更贵，插件对 agent 档固定用高速请求头、快速档用标准，不额外暴露开关。
- **客户端工具**：不是上游一等能力，但插件支持：把请求里的 `tools` 渲染成提示词里的工具手册，再把模型输出的 `<tool_call>` 还原成 OpenAI `tool_calls`（`finish_reason: "tool_calls"`），能力位因此报 `toolcall: true`。复杂工具流建议用 Agent 档。
- **联网搜索**：默认开启，搜索结果以 `search-results` UI 事件 + `annotations` 引用返回；`search_enabled: false` 可关。
- **生成式 UI**：搜索/引用/时间线/产物以 `agent-timeline`、`citation-list`、`preview-card` 等白名单组件的事件流输出（Agent UI Protocol v1），未适配的客户端只看到文本 + 工具调用。

## 用量与费用

`auth.usage` 只返回**月额度**一项（不含 5 小时 / 每周滚动窗口，那两个是限流器内部计数，展示出来只会误导）：已用百分比、套餐名（从订阅接口取，如 `<plan name>`）、到期时间，以及本机的会话映射条数。
换算口径：月额度 100% = 套餐价（`KIMI_PLAN_CNY`，默认 ¥199）→ 1% ≈ ¥1.99；每模型单价写在 `src/models.mjs` 的 `DEFAULT_PRICING`（¥ / 1M tokens，由额度百分比反推的估算价），作为 magpie 的 `cost` 回传。

## 不包含

- 不是官方 Kimi API / Kimi Code：没有官方 API 的稳定性承诺，私协议变动会同步更新到 [PROTOCOL.md](PROTOCOL.md)。
- 不做图片/文件多模态上传（网页侧未验证），不做多人共享账号池，不做代理池。
- 不保证并发：网页账号的并发能力有限，`magpie.maxConcurrency` 保守设为 2。
- 不替你做“超长上下文”与“高速档”的越权尝试（已确认会被拒）。

## 开发与验证

```bash
npm run check     # 11 个源文件语法检查
npm test          # 单元测试（10 个文件，全部离线：假 transport，不需要登录、不打真实网络）
```

测试覆盖：wire 级 protobuf 编解码、Chat 流解析、工具调用标记切分、登录输入解析、模型目录映射、用量换算、UI 事件信封、多轮会话映射。
CI 在 Node 20 / 22 / 24 上跑同一套（`.github/workflows/test.yml`）。

协议事实表（端点 / proto / 认证头 / 参数刻度 / 错误码 / 待验证项）见 [PROTOCOL.md](PROTOCOL.md)。

## 许可

MIT（见 [LICENSE](LICENSE)）。`src/qrcode-generator.mjs` 是 Kazuhiko Arase 的 MIT 版二维码生成器，原样保留，
版权与许可声明见文件头与 [THIRD_PARTY.md](THIRD_PARTY.md)。

本项目与 Kimi / 月之暗面无关，也未获其背书；使用它意味着你用自己的账号、按自己的会员条款使用该服务。
