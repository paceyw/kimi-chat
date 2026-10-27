# kimi-chat

`kimi.com` 网页版 Kimi Chat → OpenAI Chat Completions / Responses 的 **magpie 原生 provider 插件**。
用你自己 kimi.com 账号的会员额度对话：不用官方 API key，也不是 Kimi Code / Kimi API 的转发。

- 供应商 id：`kimi-chat`（客户端里写作 `kimi-chat/kimi-fast` 这样）
- 上游：`https://www.kimi.com/apiv2`（connect-rpc over protobuf，私协议，见 [PROTOCOL.md](PROTOCOL.md)）
- 能力：流式对话、思考档、联网搜索 + 引用、客户端工具调用（`tools`）、生成式 UI 事件、月额度与费用估算
- 当前版本：**0.3.1**（变更见 [CHANGELOG.md](CHANGELOG.md)）；Node ≥ 20.3，无运行时依赖，纯 ESM

## 安装

```bash
# 方式一：直接从 GitHub 装当前代码（不用等 npm 发布）
magpie plugin add github:paceyw/kimi-chat

# 方式二：桌面端「插件 → 发现」里点安装
# 本仓库打了 magpie-plugin topic，会出现在「非官方插件 · GitHub」列表里

# 方式三：npm 发布之后
magpie plugin add kimi-chat
```

装好后供应商列表里出现 **Kimi Chat (Web)**（id `kimi-chat`），点「添加账号」就进入登录流程（见下一节）。

装完可以三条命令自检，都通过再往下走：

```bash
magpie plugin list                        # 应列出 kimi-chat，7 models
magpie provider test kimi-chat kimi-fast  # 应打印 ✓ chat <毫秒>
magpie quota                              # 应出现「月额度」窗口与剩余百分比
```

> 插件是纯 ESM，没有构建步骤；从 GitHub 装时用的是仓库当前代码，所以本机不需要 `npm install`。
>
> 注意 spec 要带来源前缀：`github:paceyw/kimi-chat`（或 GitHub 仓库链接）。若把 `plugins.json` 里的 spec 写成裸包名
> `kimi-chat` 而 npm 上还没有这个包，magpie 重启时会因解析不到而把这条 spec 丢掉，插件就从列表里消失了。

## 它登录什么

登录的是**你在 kimi.com 的网页账号**（同一份会员/订阅额度，也就是网页里聊天消耗的那个月额度）。
插件不做账号池、不做多人共享、不代注册；一个 magpie 账号 = 一个 Kimi 账号。

## 怎么登录

### 方式 A：网页登录 + 短信验证码（推荐）

1. magpie → 供应商 `kimi-chat` → 添加账号，选 **“手机验证码登录（推荐）”**，填手机号（带国家码，例如 `86 13800138000`）。
2. magpie 会打开 <https://www.kimi.com/login>。如果 Kimi 允许插件直接发码，短信会立刻到你手机；如果它要求人机验证（常见），就在刚打开的页面里走一遍「登录 → 手机号 → 发送验证码」，把码发出来。
3. 回到 magpie，填你收到的 6 位验证码。

插件拿这 6 位码当场换取会话令牌（`access_token` + `refresh_token`），**不需要你复制任何 token**；账号归属（`accountId`）取自令牌，不用填 ID。magpie 里显示的就是上面这份分步说明（第 1 步…第 4 步），一行一步。

### 方式 B：粘贴 `refresh_token`（备用）

上面的验证码方式走不通时（换号、收不到短信、号码不在支持地区），可以选 **“高级：粘贴网页 refresh_token（备用）”**：

1. magpie 打开 <https://www.kimi.com/login>，在页面里正常登录。
2. DevTools（F12）→ **Application → Local Storage → `https://www.kimi.com`** → 复制 `refresh_token` 的值；
   或直接在 **Console** 里执行

   ```js
   copy(localStorage.getItem('refresh_token'))
   ```

3. 粘贴回 magpie。插件会立刻用它换新的 `access_token`：换成功才存，401（已登出/值不对）当场报错，不会留下几分钟后就失效的坏凭据。

只粘 `refresh_token` 一个值就够：`access_token` 由插件自己换，设备指纹（device/session id）由插件本地生成。

> 为什么没有「扫码」和「一键自动回传」：扫码方式的确认页是微信专用入口，桌面浏览器无法完成；而 kimi.com 的网页登录没有对第三方开放的回调通道，令牌只会落在浏览器本地存储里，插件读不到——Kimi Code 那套 OAuth 设备授权虽然能自动换 token，但签发的是 `scope=kimi-code` 的令牌，网页聊天接口不认（实测 401，见 `PROTOCOL.md` §6.3）。所以能在「不复制 token」前提下工作的最短路径就是上面的验证码方式。

## 登录信息存在哪里

全部只存在本机 magpie 的配置目录里，插件不上传、不写日志：

| 位置 | 内容 |
|---|---|
| `plugin-auth.json`（macOS 默认 `~/Library/Application Support/magpie/`，Linux `~/.config/magpie/`，Docker 部署是 `/config/magpie/`；设置了 `XDG_CONFIG_HOME` 时以它为准；权限 600） | `kimi-chat` 条目：`{type:"oauth", refresh:"<整份凭据 JSON>", access:"", expires:0, accountId:"<userId>"}` |
| 上面 `refresh` 字段里的 JSON | `accessToken`、`refreshToken`、`userId`、`webId`、`ssid`、`timezone` |
| 同目录的 `plugin-providers.json` | 只放供应商/模型/登录状态等元数据，**不含令牌** |

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
模型支持推理时，这些档位就是 magpie 里的推理档（`variants`），客户端也可以直接传 `kimi-chat/kimi-fast` 这样的 `provider/model`。

一个已登录账号通常能看到 7 个入口（随上游返回变化，缓存 10 分钟）：

| 入口 | 上游 | 思考档 |
|---|---|---|
| `kimi-fast` | Instant（`k2d6-chat` / `k28-instant`） | 低 / 高 |
| `kimi-thinking` | Agent（`k3-agent`）+ `thinking=true` | 低 / 高 / 最高 |
| `kimi-agent` | Agent（`scenario=OK_COMPUTER`）+ 插件能力 | 低 / 高 / 最高 |
| `kimi-k3d1-agent` | K3.1 Pro（默认 Agent 模型） | 低 / 高 / 最高 |
| `kimi-k2d8-preview` | K2.8 Preview（Work 场景 id） | 低 / 高 / 最高 |
| `kimi-k28-instant` | Instant 的动态入口（`key=k28-instant`） | 低 / 高 |
| `kimi-k3` | K3（`kimi_plus_id=ok-computer`） | 低 / 高 / 最高 |

其它固定事实（实测，见 PROTOCOL.md §12）：

- **对话长度**：**默认不支持选择**，固定用标准档（L）。超长上下文会让单次请求的消耗成倍上涨，而且几乎没有客户端能传这个额外参数；需要时可在服务端用 `KIMI_MAX_CONTEXT_LENGTH` 调高上限（取决于账号权限）。
- **速度**：**默认不支持选择**，固定用上游的 FAST 档（请求枚举 5）。更快的档位与更高消耗绑定、且只有部分模型提供，客户端也很少能传这个参数，所以不做开关。
- **客户端工具**：不是上游一等能力，但插件支持：把请求里的 `tools` 渲染成提示词里的工具手册，再把模型输出的 `<tool_call>` 还原成 OpenAI `tool_calls`（`finish_reason: "tool_calls"`），能力位因此报 `toolcall: true`。复杂工具流建议用 Agent 档。
- **联网搜索**：默认开启，搜索结果以 `search-results` UI 事件 + `annotations` 引用返回；`search_enabled: false` 可关。
- **生成式 UI**：搜索/引用/时间线/产物以 `agent-timeline`、`citation-list`、`preview-card` 等白名单组件的事件流输出（Agent UI Protocol v1），未适配的客户端只看到文本 + 工具调用。

## 用量与费用

`auth.usage` 只返回**月额度**一项（不含 5 小时 / 每周滚动窗口，那两个是限流器内部计数，展示出来只会误导）：已用百分比、套餐名（从订阅接口取，如 `<plan name>`）、到期时间，以及本机的会话映射条数。
换算口径：月额度 100% = 你所用套餐的价格（环境变量 `KIMI_PLAN_CNY`，默认 199，不同套餐/地区请自行设置）→ 按 199 计 1% ≈ ¥1.99；每模型单价写在 `src/models.mjs` 的 `DEFAULT_PRICING`（¥ / 1M tokens，由额度百分比反推的估算价），作为 magpie 的 `cost` 回传。

## 不包含

- 不是官方 Kimi API / Kimi Code：没有官方 API 的稳定性承诺，私协议变动会同步更新到 [PROTOCOL.md](PROTOCOL.md)。
- 不做图片/文件多模态上传（网页侧未验证），不做多人共享账号池，不做代理池。
- 不保证并发：网页账号的并发能力有限，`magpie.maxConcurrency` 保守设为 2。
- 不默认启用“超长上下文”与“更快的速度档”（消耗大、客户端支持少，见上面的固定事实）。

## 开发与验证

```bash
npm run check     # 11 个源文件语法检查
npm test          # 单元测试（10 个文件 / 90 条，全部离线：假 transport，不需要登录、不打真实网络）
```

测试覆盖：wire 级 protobuf 编解码、Chat 流解析、工具调用标记切分、登录输入解析（含中文提示文案）、模型目录映射、用量换算、UI 事件信封、多轮会话映射。
CI 在 Node 20 / 22 / 24 上跑同一套（`.github/workflows/test.yml`）。本地不需要 `npm install`（零依赖），也不需要登录 Kimi。

协议事实表（端点 / proto / 认证头 / 参数刻度 / 错误码 / 待验证项）见 [PROTOCOL.md](PROTOCOL.md)。

## 许可

MIT（见 [LICENSE](LICENSE)）。`src/qrcode-generator.mjs` 是 Kazuhiko Arase 的 MIT 版二维码生成器，原样保留，
版权与许可声明见文件头与 [THIRD_PARTY.md](THIRD_PARTY.md)。

本项目与 Kimi / 月之暗面无关，也未获其背书；使用它意味着你用自己的账号、按自己的会员条款使用该服务。
