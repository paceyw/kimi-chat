# Kimi Chat 网页协议事实表

> 逆向结论（2026-10-26 起持续更新）。来源：kimi.com 前端静态 JS（web 版本串 2.3.0）内嵌的 protobuf-es descriptor + connect-es 客户端代码，以及单账号下的活体实测。
> 性质：**只读推断 + 活体复验**。标注 `[抓包验证]` 的项已由实测确认，未标注的仍属推断。

## 1. 端点拓扑

| 域名 | 路径前缀 | 协议 | 用途 |
|---|---|---|---|
| `https://www.kimi.com` | `/apiv2/` | connect-rpc (proto) | 业务网关：`kimi.gateway.chat.v1.ChatService/*`、`kimi.gateway.config.v1.ConfigService/*` |
| `https://auth.kimi.com` | `/api/` | connect-rpc (proto/json) | 认证：`account.gateway.v1.AuthService/*`、`account.gateway.v1.DeviceService/*` |
| `https://www.kimi.com` | `/api/` | connect-rpc | refreshToken 客户端 `rt()` 的 baseUrl（`Qe()=${ce}/api`，`ce=window.AUTH_API_HOST||https://auth.kimi.com`）[抓包验证：refresh 实际域名] |

区域路由：cookie `K` 存区域 origin（如 kimi.ai），`Pn()` 读取，`Nn(origin,'api'|'apiv2')` 拼接。默认 `www.kimi.com`。

## 2. 认证（account.gateway.v1.AuthService，auth.kimi.com/api）

RPC（从上游前端 bundle 解码得到）：
- `CreateLoginQRCode()` → `{qr_code_url, expire_in_s}`（推断字段名 [抓包验证]）
- `GetLoginQRCodeStatus(qr_code_url)` → `{status: WAITING|SCANED|CONFIRMED|EXPIRED|SUCCESS, access_token, refresh_token, user_id}` [字段名抓包验证]
- `RefreshToken(refresh_token)` → `{access_token, refresh_token}` —— 前端 `rt().refreshToken({refreshToken})`，单飞去重，失败查 details 中 ACCOUNT_BANNED/SUSPENDED/DISABLED/SERVICE_MAINTENANCE
- `GetSSOAuthorization(identifier, redirect_uri)` → `{authorization_url}`
- 其余：Login/Captcha/VerifyResetCaptcha/GetUserStatus/RegisterDevice(推送设备，web 静默失败，**非必需**)

Token 存储（前端 localStorage）：`access_token`、`refresh_token`、`msh_user_id`。

## 3. 请求头集（拦截器 `Ye(e)`，BG6Dk6Y3.js）

每请求注入：
```
Authorization: Bearer <access_token>          # 无 token 则不发
X-Traffic-Id: <userId>                        # 字节 collect SDK user_unique_id
x-msh-device-id: <webId>                      # collect SDK web_id
x-msh-session-id: <ssid>                      # collect SDK ssid
R-Timezone: <Intl tz>
x-msh-version: 2.3.0                          # Ge 白名单端点才真实上报
x-msh-platform: web                           # Ge 白名单端点才真实上报
X-Language: <可选>
x-msh-shield-data: <L>:<getinfo()>            # 数美 SDK；不可用则整个头缺省（Je 1s 超时→null）
```
Ge 白名单（仅此 3 个端点上报真实 platform/version）：`/device/register`、`/apiv2/kimi.gateway.config.v1.ConfigService/GetConfig`、`/apiv2/kimi.gateway.config.v1.ConfigService/GetAvailableModels`。其余端点 version=2.3.0 恒定、platform 按 UA 判断（web 恒 `web`）。

设备三件套来源：`window.collectEvent('getToken', cb)` → `{userId:user_unique_id, webId:web_id, ssid, tobid}`，缓存 localStorage。**Provider 侧方案：从用户浏览器登录后一次性导出这四值 + token 对，透传。不合成。**

shield-data：数美风控指纹，浏览器外不可生成。前端容错缺省。**是否强制 [抓包验证]；若强制则透传浏览器抓到的真实值，不伪造。**

## 4. Chat RPC（kimi.gateway.chat.v1.ChatService，www.kimi.com/apiv2）

### 4.1 传输
connect streaming：`Content-Type: application/connect+proto`；请求体 5 字节信封（1B flags=0 + 4B 大端长度）+ ChatRequest protobuf；响应同为信封帧序列，每帧一个 ChatResponse，流尾 flags=0x02 的 EndStreamResponse JSON `{error?, metadata?}`。`Connect-Protocol-Version: 1`。

### 4.2 ChatRequest（ChFG9O1A__1.txt，gateway 版）
```proto
ChatRequest {
  string chat_id = 1;            # 空 = 新会话
  string kimiplus_id = 6;        # [抓包验证：普通 chat 的默认值，可能空或官方 id]
  Scenario scenario = 2;         # CHAT=1 THINK=2 DEEP_RESEARCH=3 K2=5 K3=13 ...
  repeated Tool tools = 3;       # {type: Search{force}|GenImage{name}, ...}
  ChatMessage message = 4;       # 本轮用户消息 {role:user, blocks:[TextBlock{content}]}
  ChatRequestOptions options = 5;
  string project_id = 7 optional;
}
ChatRequestOptions {
  thinking = 3;                  # bool
  system_prompt = 4;
  enable_plugin = 7;
  ReasoningEffort reasoning_effort = 8;  # NONE=1..MAX=7
  ContextLength context_length = 9;      # XXS=1..XXL=7
  model = 10;                    # [抓包验证：模型串形态]
  Speed speed = 15;              # STANDARD=1 FAST=5 MAX=10  ← 快速模式在此
  arena/slides/kimi_bot/design 等 = 11..14
}
```
user 消息 blocks 构造：`TextBlock{content}` + 可选 Reference/文件 [抓包验证细节]。

**会话创建：不需要预调用 CreateChat。** `CreateChat` 只存在于 `kimi.chat.v1`（desc 里能看到，但前端聊天不走它），而前端实际聊天走的是 `kimi.gateway.chat.v1.ChatService/Chat`（bundle 已证 URL）。gateway 版 `ChatRequest.chat_id` 是可省略 string；首条消息留空，服务端创建会话后在 `ChatResponse.chat.id` 返回，provider 存入会话映射供后续复用。`kimi.chat.v1` 是另一套服务，不在本插件调用路径上。

### 4.3 ChatResponse（patch-based 流式）
```proto
ChatResponse {
  Operator op = 1;               # set=1 / append=2
  FieldMask mask = 2;            # 指明更新字段
  uint32 event_offset = 11;
  Chat chat = 3;                 # 会话元数据（新会话首个事件给 chat_id）
  ChatMessage message = 4;       # 消息级状态
  Block block = 5;               # 增量单元：id/message_id/text|search|think|tool|artifact...
  Ref ref = 6;                   # 引用：search(SearchChunkBrief)/image/url/...
  Usage usage = 7;               # Research{limit,used,remain}
  Notification notification = 8; # TYPE_ROUTE_TO_AGENT/UPGRADE/MODEL_DEGRADE...
  Done done = 9;                 # 结束信号
  Heartbeat heartbeat = 10;
}
```
Block 关键类型（ByvlHBJO__21.txt）：`text{content,tips}`、`think{content,summary}`、`search{keywords,web_pages[SearchResultBase]}`、`tool{tool_call_id,name,args,status PENDING/RUNNING/DONE,contents}`、`artifact{artifact_id,type,content,version}`、`error{Error}`、`stage/multi_stage`、`agent_message`、`explorer_research(=100)`。TextBlock.content 用 op=append 追加 → 天然映射 token 流。

**patch 归并语义（ChFG9O1A.js 前端证实）**：`op=append` + text/think → `content += delta`（纯字符串拼接）；`op=set` + `mask=["block"]` → 整块替换；`op=set` + 细粒度 mask（如 `block.artifact.version`、`block.tool.args`）→ 只替换该字段；`mask=["message"]` 单字段特判 → message 状态更新（status 变化）；Ref → `refs.searchChunks.push()` / `refs.images.push()`。未知 block id + append → push 新块到 blocks。

**取消语义（ChFG9O1A.js 前端证实）**：前端 stop = 本地 AbortController.abort()（断开 connect 流）+ fire-and-forget `cancelChat({chatId, messageId})`（catch{} 吞错）。**断流≠服务端停止**——插件实现：客户端 abort → 断流 + 异步 cancelChat（`kimi-connect.mjs`，CancelChatRequest{chat_id=1, message_id=2}，connect unary，吞错）；正常完成不调。

引用：message.references + ref.search(SearchChunkBrief{base:SearchResultBase, ref_index})。**行内标记格式已确认**（T0ufiYEK.js 正则）：私有区码点 `\uE3A0(type)[\uE3A1\uE3A2\uE3A4](payload)\uE3A8`，模型输出流内嵌；前端渲染时 matchAll 替换为上标。插件出口 `sanitizeInlineRefs()` 按出现顺序转 `[n]`，与 citations 数组对齐。

### 4.4 错误
`kimi.chat.v1.Reason` 19 值：CONTENT_FILTER/TOKEN_LENGTH_TOO_LONG/COMPLETION_OVERLOADED/REQUEST_ERROR/TEXT_USAGE_EXCEEDED/THINK_USAGE_EXCEEDED/K2_USAGE_EXCEEDED/REQUEST_RATE_EXCEEDED/RESEARCH_TASK_CONCURRENT_LIMIT/DEEP_RESEARCH_USAGE_EXCEEDED/ANONYMOUS_USAGE_EXCEEDED/ABNORMAL_USER_USAGE_EXCEEDED/ABNORMAL_USER_SURVEY_REQUIRED/EXCEED_TOOL_CALL_MAX_ROUNDS/RATE_LIMIT_EXCEEDED/CHAT_INTERRUPTED/CHAT_FATAL_ERROR/LLM_UNAVAILABLE。
Usage 限流类 → magpie rate_limited；CONTENT_FILTER → content_filter；CHAT_INTERRUPTED → cancelled。

### 4.5 逐帧样例：快速模型 + 进阶思考（2026-10-27 真机）

请求（插件发往 `kimi.gateway.chat.v1.ChatService/Chat` 的 options，与网页同构）：

```
A 低档  {model:"k28-instant", scenario:1, thinking:true, reasoningEffort:3, speed:5}
B 进阶  {model:"k28-instant", scenario:1, thinking:true, reasoningEffort:5, speed:5}
```

同一问句（「你好，今天是几号，北京天气如何」）的差异：

| | 思考档 | 帧数 | 思考字数 | 工具帧 | 耗时 | 结果 |
|---|---|---|---|---|---|---|
| A | 低 (3) | 135 | 240 | 0 | 5.7 s | 凭记忆作答，不带检索 |
| B | 进阶 (5) | 1284 | 2621 | 17 | 24–46 s | 真去调用 web_search，带检索结果与引用 |

B 的关键帧（`op=1 set / 2 append`，`eventOffset` 单调递增）：

```
9   op=1 block={id:"1", messageId:"1a17d689-…"}                      # 建空块（段落/消息骨架）
10  op=1 block={id:"2", …}
11  op=2 block=3 THINK +2 …（每帧 +1~+10 字，累计 2621 字）           # 思考字流
128 op=1 block=4 tool{name:"web_search", status:1, args:""}         # PENDING：发起工具调用
129 op=2 block=4 tool{args:"{"}                                      # 参数按字符 append（JSON 文本）
…
142 op=2 block=4 tool{args:"}"}
144 op=1 block=4 tool{status:2, args:"{"queries":["北京天气 2026年10月27日"]}"}   # RUNNING：参数完整
147 op=1 block=4 tool{status:3, contents:[12 条 SearchResultBase]}   # DONE：结果回填
…   op=2 block=6 TEXT +1 …                                            # 正文流，内含 <REF>cite✦tools://web_search:…#…</REF>
```

- `tool.status`：**1=PENDING / 2=RUNNING / 3=DONE**；`tool.args` 是流式追加的 JSON 字符串，`tool.contents` 才是结果。
- 思考档位只有**同时** `thinking=true` 时上游才会挂 `web_search`；低档（3）即使 `tools:[{Search:{force:true}}]` 也不搜（见 §12.1）。
- 引用不是独立 Ref 块，而是正文里内嵌的 `\uE3A0…` 私有区码点 `<REF>` 标记，前端替换成上标，插件用 `sanitizeInlineRefs()` 转 `[n]`。
- 取证开关：`KIMI_TRACE=1` 或 `KIMI_TRACE=<path>` 会把 request 摘要 + 每一帧原文 + end 摘要写成 jsonl（`src/kimi-api.mjs` 的 `openTrace`），用于复现以上结论。
### 4.6 两个上游行为：只思考不回答 / 标题请求各开一个会话

**（1）只思考不回答（empty answer）**。快速模型 + 进阶思考在「工具刚报错、紧接着要求排版一段结果」这类上下文里，会先正常流完一整段思考，然后 `finish=stop`、正文 0 字、也没有工具调用。2026-10-27 两个真机会话都复现：

- 客户端视角：一轮思考动画播完，回答区是空的；客户端自己重发一次（台账里同一 step 出现两行，prompt 多 8 个 token），第二次仍是空的。
- 直接打网关复现（同一段「工具返回 FS_NOT_FOUND → 请用组件卡片展示天气」的消息）：`finish=stop text=0 reasoning=87 toolDelta=0`、`finish=tool_calls text=0 reasoning=130`，两次都没有正文。
- 插件现在的处理：正文为空、没有工具调用、但有思考时，在同一会话里追加一句「请直接在正文里给出最终答复，不要再只输出思考」再要一次（第二次的思考不再重复推给客户端）；第二次仍为空才返回空结果。宁可多花一轮小的，也不把空白丢给用户。

**（2）标题请求各开一个会话**。客户端（如 DSH）每轮会额外发一次「给会话起标题」的请求，system 里带 `Create a concise title…`。它的消息前缀与正文不同，早期按普通会话逻辑处理，于是 Kimi 网页里每轮都会多出一个「Create a concise title…」开头的会话（用户看到「为什么有两个对话」）。现在按 magpie 会话记一个专用标题 chat `titleSessions`：同一会话的标题请求都续在同一个 chat 里，每会话最多多一个会话，且不覆盖正文会话的绑定。

## 5. 模型档映射（2026-10-26 无鉴权 GetAvailableModels 实测定稿）

**实测方法**：`GetAvailableModels` 无需鉴权（空 body=默认场景）。返回 `default_chat_model="k2d6-chat"`、`default_agent_model="k3-agent"`。

| magpie 模型 | scenario | options |
|---|---|---|
| `kimi-fast` | **CHAT(1)** | `model:"k2d6-chat"` + speed=FAST(5)（Instant："Fast chat, quick replies"，支持图片；网页默认 High(3)，老套餐快速模式取 FAST(5)） |
| `kimi-thinking` | **OK_COMPUTER(6)** + `kimiplus_id:"ok-computer"` | `model:"k3-agent"` + thinking=true + reasoning_effort 默认 HIGH(5)（前端 ChFG9O1A.js 证实 `thinking:!0` 恒真硬编码——思考非独立场景，是同模型+更高 effort；OpenAI `reasoning_effort: low/medium/high` → 3/4/5 覆盖默认，未知值回退 high；仅 thinking 档透传） |
| `kimi-agent` | **OK_COMPUTER(6)** + `kimiplus_id:"ok-computer"` | `model:"k3-agent"` + speed=FAST(5)（=K3 default_speed；⚠️ CRN2 请求枚举只有 1/5/10，展示刻度 3/5/7 勿直接填）+ enable_plugin（K3："Chat & Agent, flagship all-rounder"） |

**Model entry 字段（实测修正）**：field1=scenario、field2=display、field7=kimi_plus_id、field15=短串("k2d6"/"k3")、field17=speed_options(speed_value,label)、field18=default_speed、field20=context 档(5=Standard/6=1M)、field21=default_context、**field22=id（请求 model 串：`k2d6-chat`/`k3-agent`/`k28-agent-preview`/`k3-agent-ultra`/`k3-agent-swarm`/`k2d8-preview`）**、field26=swarm。⚠️ 两套 speed 刻度：ChatRequestOptions.speed 用 CRN2 刻度（1/5/10），Model.speed_options 是展示刻度（1/3/5/7）。

**模型选择机制**（前端 Cp9WvEkU2/DfF3vhMd2）：`requestParams={model: modelId, scenario, kimiPlusId}`；speed/reasoningEffort/contextLength 由模型条目派生；`kimiplus_id`（field 6）默认空串，特殊入口填命名 ID（w 表）。

搜索：`tools=[{type:Search(1), search:{force:false}}]`——前端 tt() 证实 `e.search` 为真才 push SEARCH Tool，force 默认 false（服务端自行决定是否搜索）；force=true 为强制每次搜索（我们未启用）。tools 初始 `[]`，另有 IMAGE_GENERATION/AUDIO 分支（本插件不做）。用户消息构造：`{role:user(2), blocks:[{TextBlock{content}}], scenario, labels, references, isGoal}`，文件走独立 file blocks。

## 6. 登录引导（2026-10-27 改版：网页登录 + 验证码，扫码已下线）

**主路径（网页登录 + 短信验证码，oauth `method:"code"`，`prompts:[phone]`）**：`magpie plugin login kimi-chat` 选 "手机验证码登录（推荐）" → 宿主打开 `https://www.kimi.com/login` → 插件先试 `SendVerifyCode`：

- 允许直接发码 → 短信即刻到达，用户只需回填 6 位码；
- 要求人机验证（`REASON_ACCOUNT_CAPTCHA_VERIFY_FAILED`，实测常见）→ 用户在刚打开的网页里走「登录 → 手机号 → 发送验证码」，再把 6 位码回填 magpie。

插件收到验证码后调 `LoginWithSMS`（**该校验不检查 captcha**，只要码正确就换得到 token）→ 拿到 `access_token` / `refresh_token` / `user_id`，直接落 oauth 形状。**全程不需要用户复制任何 token**，`accountId` 用返回的 `user_id`。

**备选路径（粘贴 `refresh_token`，oauth `method:"code"` 无 prompts）**：标签 "高级：粘贴网页 refresh_token（备用）"。宿主打开 `https://www.kimi.com/login`，用户登录后在 DevTools 的 **Application → Storage → Local Storage → `https://www.kimi.com`** 里对 `refresh_token` 右键 **Copy value**（Console 里 `copy(localStorage.refresh_token)` 同样可行），回 magpie 粘贴；插件立刻调 `RefreshToken` 活体验证（401 当场拒绝、网络故障不假装成功），`userId` 取新 access token JWT 的 `sub`。粘贴形状容忍：裸 JWT、带引号、`refresh_token=<值>`、`{"refreshToken":...}` JSON；把 `access_token` 粘进来会被明确拒绝（它 15 分钟就过期，存下来等于假登录）。
**界面文案（2026-10-27 实测修正）**：两条方法的 `label` / `instructions` / 报错都是中文。宿主的登录弹窗把 `instructions` 放在 `.signing .s` 里，该规则只有 `color` / `font-size` / `overflow-wrap: anywhere`，**没有 `white-space: pre-wrap`**，所以 `\n` 会被折叠成一个空格（U+2028 / U+2029 在 Chromium 里同样折叠，U+0085 / U+000B 会显示成方块，都试过）——写不出一行一步。文案因此写成一个自然段 + `① ② ③ ④` 行内编号。
**为什么需要复制的值不放在弹窗的复制按钮上**：插件 `authorize()` 能返回的字段只有 `{session, url, instructions, method, opened}`（`internal/plugin/providers.go` 的 `Authorization`），宿主弹窗里唯一带复制按钮的 `signlink` 固定绑定 `url`；`signing.code` 是宿主用正则 `(?i:\bcode):?\s+([A-Z0-9]+(?:-[A-Z0-9]+)+|[A-Z0-9]{6,})\b` 从 `instructions` 里抽出来的设备码（`codeIn()`），只认大写字母数字，塞不进命令。所以：复制动作改到 DevTools 里「右键 → Copy value」，用户不需要从弹窗文字里选中任何东西。

**已下线：QR 扫码**（原 `CreateLoginQRCode` + `GetLoginQRCodeStatus` 轮询）。原因：`/wechat/mp/auth` 是微信专用确认页（chunk `CdQwmZoy2.js` 只有一张「open in WeChat」图 + 文案，无任何 RPC），桌面浏览器走不通；按产品要求改由验证码方式承接。`kimi-connect.mjs` 里的两个 QR 原语与其 wire 测试保留（未被登录流程引用）。

**凭据存储形状**：两条登录路径都交回 oauth 形状 `{type:"oauth", refresh:<凭据JSON串>, access:<access token>, expires:0, accountId:<userId>}`（宿主 `secretOf` 取 `refresh ?? access`）；早期 api 形状 `{type:"api", key, metadata}` 仍可读（`authRaw()` 两种都吃）。`auth.refresh()` 交回 `{refresh, access, expires}` 由宿主 `save()` 落盘；请求中途刷新的结果先挂 `pendingRefresh` 交给下一次 `auth.refresh()`，避免与聊天轮抢写。

### 6.2 网页登录的最小凭据集（2026-10-27 真机活体实测）

同一 prompt（"只回四个字：验证通过"）三种凭据形状都能完成快速档对话：

| 形状 | 字段 | 结果 |
|---|---|---|
| A full | accessToken+refreshToken+userId+webId+ssid | 2848ms / 4ch |
| B noUserId | 去掉 userId（即不发 `X-Traffic-Id`） | 1630ms / 4ch |
| C bare | 只有 refreshToken，webId/ssid 现场随机 | 3550ms / 4ch |

→ **只要 `refresh_token` 就能登录**；`X-Traffic-Id`（userId）与设备指纹都不是必需，可以本地生成。

令牌都是 HS512 JWT（解 payload 不验签即可用）：

```json
{"iss":"account","aud":["kimi.com"],"exp":1793062986,"typ":"access","sub":"<userId>","abstract_user_id":"<userId>","membership":{"level":<n>}}
```

- `typ` = `access` / `refresh` → 用来判断用户粘错没粘错；
- `sub` = userId → 账号归属与 `X-Traffic-Id` 的来源；
- `membership.level` = 账号会员等级（各账号不同）→ 等级不足时超长上下文会以 `permission_denied` 被拒。
- `RefreshTokenResponse` 只有 `access_token=1` / `refresh_token=2`，**没有 user_id**（有 user_id 的只有 `LoginWithSMS/ThirdParty/OneClick/GetLoginQRCodeStatus`），所以网页登录必须从 JWT 里取 userId。

登录页可用性（2026-10-27）：`/` 200、`/login` 200、`/signin` 302→`/`；`kimi.moonshot.cn` 302→`www.kimi.com`。


### 6.3 为什么不能用「Kimi Code 的 OAuth 设备授权」自动拿网页 token（2026-10-27 实测，已排除）

背景：想要「网页上点一下登录 → 插件自动拿到 token」，最像现成答案的是 Kimi 自己的 **OAuth 2.0 Device Authorization Grant**（网页 `/code/authorize_device` 页面 + `account/gateway/v1/oauth.proto` 的 `OAuthService.GetDeviceGrant/ApproveDeviceGrant/RejectDeviceGrant`，前端 chunk `Fck5pvyN.js`；CLI 侧实现在 `MoonshotAI/kimi-cli` 的 `src/kimi_cli/auth/oauth.py`）。整条链路确实能跑通：

1. `POST https://auth.kimi.com/api/oauth/device_authorization`，form `client_id=17e5f671-d194-4dfb-9706-5516cb48c098`（Kimi Code CLI 的公开 client_id）
   → `{"device_code":"…","user_code":"XXXX-XXXX","verification_uri":"https://www.kimi.com/code/authorize_device","verification_uri_complete":"https://www.kimi.com/code/authorize_device?user_code=XXXX-XXXX","expires_in":1800,"interval":5}`
2. 用户在 `verification_uri_complete` 页面登录并点「登录」（内部即 `ApproveDeviceGrant`）。
3. `POST https://auth.kimi.com/api/oauth/token`，form `client_id` + `device_code` + `grant_type=urn:ietf:params:oauth:grant-type:device_code`
   - 未批准：`400 {"error":"authorization_pending","error_description":"Authorization is pending"}`
   - 已批准：`200 {access_token, refresh_token, expires_in:900, scope:"kimi-code", token_type:"Bearer"}`

**但签发出来的令牌网页聊天接口不认**——实测（真机，用户点过确认）：

```
scope: kimi-code
claims: {"client_id":"17e5f671-…","user_id":"<userId>","scope":"kimi-code","type":"access",
         "iss":"kimi-auth","sub":"<userId>","region":"cn","exp":…}
Chat  → 401 unauthorized
GetSubscriptionStats → 401
```

对比网页 token 的 `iss:"account"` / `aud:["kimi.com"]` / `typ:"access"` / 带 `roles`，可见两条令牌体系不同源：设备授权发放的是 **Kimi Code 产品**的 OAuth 令牌（`iss=kimi-auth`），网页 Chat RPC 只接受网页会话令牌（`iss=account`）。因此「自动取网页 token」在协议层不存在可用通道，除非能读到浏览器本地存储（需要浏览器扩展或 CDP，不属于插件能力）。

补充：自助批准（不用人点）也没有可用入口——`www.kimi.com/api/account.gateway.v1.OAuthService/ApproveDeviceGrant` 回 `404 {"detail":"Cannot POST /account.gateway.v1.OAuthService/ApproveDeviceGrant"}`，`/apiv2/...` 回 `404 page not found`，`auth.kimi.com/api/...`（proto/json、补 Origin/`x-msh-platform` 等浏览器头）一律 `415`。

## 6.1 登录后冒烟测试

```bash
# 任意能访问 magpie 的设备上（本机 / 容器宿主 / ssh 进去都行）
magpie plugin list                 # 插件应为 on，且 provider 已登录
magpie provider models kimi-chat   # 应列出 kimi-fast / kimi-thinking / kimi-agent 及动态入口
curl -s http://127.0.0.1:<端口>/v1/models | grep kimi   # 网关侧应能看见这些模型
```

再发一条流式补全（含搜索）确认：正文流 → `search-results` UI 事件 → `citation-list` 引用 → 未知模型报错文案。
模型没暴露时：`magpie provider models kimi-chat +kimi-fast +kimi-thinking +kimi-agent`。

## 7. 已闭合的实现参数

- connect 错误码映射：401→Unauthenticated、429→Unavailable、400→Internal（connect-es 标准表）
- 帧格式：5B 信封 `flags(1)+len(4 BE)`；EndStreamResponse flags=0b10
- 心跳：Heartbeat 帧，忽略即可（实现侧：帧到达即重置 idle 计时器，故 Heartbeat 同时充当保活信号，`idleTimeoutMs=120s` 不会误杀长思考）
- `event_offset`：断线续传（ResumeChat/SubscribeMessageStream）用
- 超时与上限（已实现）：chatStream 帧间空闲超时 120s（`idleTimeoutMs`，可调）→ `kind=timeout`；正文+思考累计超 `LIMITS.maxOutputCharacters`(1M) → 主动断流，状态 TRUNCATED

## 8. 已验证的端点行为（2026-10-26 无效凭据干跑，服务器出口）

| 端点 | 请求 | 响应 |
|---|---|---|
| `https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken` | `application/proto` + `RefreshToken{refresh_token:"probe-invalid-token"}` | **HTTP 401** `application/json`：`{"code":"unauthenticated","debug":{"reason":"REASON_INVALID_AUTH_TOKEN","localizedMessage":{"message":"Session expired. Please log in again."}}}` |
| `https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat`（无 Authorization） | `application/connect+proto` 信封 | **HTTP 401** `text/plain`（body 仍是 connect JSON）：`{"code":"unauthenticated","message":"","details":[{}]}` |
| 同上（无效 Bearer） | 同上 | **HTTP 401**：`{"code":"unauthenticated","message":"invalid user token: token is malformed: token contains an invalid number of segments","details":[{}]}` |

结论：(a) 两个端点存在且走 connect 协议；(b) 错误响应是 connect 标准 JSON（unary RefreshToken 带 `debug.reason`）；(c) 401 时 Chat 端点 `content-type: text/plain` 但 body 是 JSON——客户端解析需容忍；(d) 未触发风控/Captcha（无效 token 直接 401，无 shield-data 也放行到鉴权层）。真实凭据下的 Chat 流式信封（5B 帧 + EndStreamResponse）仍未验证，登录后首次调用核对。

## 9. 待抓包验证清单（Phase 1 首次真实调用核对；§8 已核掉一部分）

**状态：9 项已闭合 7 项。剩余 2 项（#4/#5）+ 1 观察项（#8）均需真实凭据，登录后 smoke 即验。**

1. ~~Chat 请求实际 Content-Type 与信封~~ **已闭合**（框架级证据）：connect streaming 实现完整确认——`application/connect+proto`、帧头 `getUint8(0)`+`getUint32(1)`（1B flags+4B 长度）、EndStreamResponse 处理（framework-CZXkfdOm.js）。401 响应在 headers 阶段返回 text/plain+JSON（connect 错误降级）。真实凭据下的帧序时序（SET/APPEND 顺序）仍待 smoke 观察。
2. ~~model 字符串~~ **已全部实测闭合**：default_chat_model=`k2d6-chat`、default_agent_model=`k3-agent`、思考档=K3+effort（前端 thinking:!0 恒真）。§5 表定稿。
3. ~~user blocks 里文本与引用的构造~~ **已闭合**（前端证据）：用户消息 = `{role:user, blocks:[TextBlock{content}]}`（DFB70GDY.js Ut 构造：content 字符串直传 TextBlock；引用/文件经 refs 不经 blocks）。与我们实现一致。
4. 文内 citation 标记格式 ↔ ref_index 对应（标记格式已从 T0ufiYEK.js 确认：\uE3A0..\uE3A8；与 ref_index 的数值对应待实测）
5. shield-data 是否强制（§8 已证无 shield-data 可到鉴权层；有效 token 下是否强制待验）
6. ~~RefreshToken 实际域名~~（§8 已证实 auth.kimi.com/api）
7. ~~QR 登录响应字段名~~ **已实测闭合**（无鉴权可调）：`auth.kimi.com/api/.../CreateLoginQRCode` → field1=UUID code；`GetLoginQRCodeStatus{code}` → `08 01`=status PENDING(1)。proto 声明与 wire 一致（PENDING=1/SCANNED=2/EXPIRED=3/SUCCESS=4 + token 对）。可做原生扫码登录（二期）。
8. 快速模式是否额外发信号（speed=FAST 是否足够）
9. ~~搜索 force 语义~~ **已闭合**（前端证据，round 37）：`Tool.Search{force}` 默认 false；仅用户显式选"联网搜索"时前端传 `search:{force:!0}`（DFB70GDY.js：`Ut(n.value,{type:'chat',content,...,search:r?{force:!0}:null})`，r=UI 搜索开关）。force=false 时模型自主决定是否搜索。我们 search_enabled=true → force:true 正确对应显式搜索档；false 时直接不发 Tool（而非 force:false）是合理简化。

## 10. 首次真实凭据下的实测结论（2026-10-27，真机活体）

真机（单账号、快速模式权益）端到端跑通，三档模型 + 联网搜索 + 引用全部工作：

- 请求：`POST https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat`，`application/connect+proto`，5B 帧信封；正文首帧 45~60ms 到达，整体 20~60s。
- 响应：`ChatResponse` patch 流，`op=set/append`；`ToolBlock{status, contents[]}` 为工具结果载体（搜索结果落在 `contents[].searchResult.base`）。
- 实测修正的 4 个实现缺陷（均已修复 + 回归测试）：
  1. **oauth 形状取原文**：`auth.key ?? auth.metadata.key` 对 oauth 存储为空 → 中途 401 刷新时抛 "credentials are empty"，整轮变错误帧。改用 `authRaw()`。
  2. **工具完成帧身份丢失**：`tool_call_id/name/args` 只在起始帧出现，带 `contents` 的完成帧只有 `block.id`。需按 `Block.id` 记忆身份，否则搜索结果永远发不出卡片。
  3. **多 TextBlock 交错**：一条回答拆成"搜索前铺垫 + 搜索后正文"两个 TextBlock，两者增量帧交错到达；全局累加会串行成乱码，必须按 block 分开累积、按首次出现顺序拼接。
  4. **`<REF>cite✦tools://web_search:1#N:~:text=…</REF>` 泄漏**：`#N` = `SearchResultBase.index`，映射到 citations 序号替换为 `[n]`；流式下需 holdback 未闭合标记，保证对外文本单调增。
- 搜索确证：`Tool{type=SEARCH, search{force=true}}` 在 CHAT 场景下真实触发联网抓取（`web_search` 工具块，10~19 条来源），并在正文产生 `[n]` 行内引用。
- 客户端工具（OpenAI `tools`）：请求侧把 `tools` 渲染进提示词并约定 `<tool_call>…</tool_call>` 输出格式，响应侧解析为 `tool_calls` 增量（详见 §11）。

## 11. 工具调用回传格式（OpenAI 兼容层的自造协议）

上游没有 OpenAI 的 `tools/tool_calls` 通道，故这一层由插件模拟：

- 请求：`src/tools.mjs` 把 `body.tools` 渲染成提示词里的调用说明（名字/签名/一句描述），并声明用 `<tool_call>{"name":…,"arguments":{…}}</tool_call>` 输出。
- 响应：流式路径按"可能被帧切断"的方式缓冲，遇到闭合标签才产出 `choices[].delta.tool_calls[]`（`index/id/function.name/arguments`）；非流式路径产出 `message.tool_calls[]` + `finish_reason="tool_calls"`。
- 客户端把 `role:"tool"` 结果回传时，`toPrompt` 渲染成自然语言（`[tool result] …`），绝不复述 XML 标签——早期版本直接拼 `<tool_call>`，模型会照抄成正文。

### 11.1 工具手册的渲染格式与预算（2026-10-27）

默认 `compact` 渲染，一行一个工具：

```
- fs_read(path*:str, offset:int, limit:int): Read an existing file before overwriting it with write.
```

- 签名取自 `parameters.properties`：`*` 标必填（`required`），类型缩写 `str/num/int/bool/arr/obj/null`，字符串枚举 ≤4 个时直接写 `"a"|"b"`，参数多于 8 个时截断为 `+N`。
- 说明只保留第一句（首个 `.`/`。`/`!`/`？`/`；` 结尾），并砍掉各家客户端的 `Calling convention:` / `调用约定:` 之后那段 run_code 样板（与选工具无关）。单条上限 160 字。
- 预算默认 48,000 字符（`KIMI_TOOLS_MAX_CHARS`，`0` 关闭）。超预算按阶梯**整体缩短**说明：160 → 120 → 96 → 72 → 56 → 40 字；仍超才从最长的行开始退到"只有名字"；再超就按 `mcp__server__*` 前缀合并成一行。
- **工具名永不丢弃**：预算是软目标，名字消失等于工具不存在（模型会转而脑补不存在的工具）。
- 真机数据（DSH 声明 305 个工具）：完整 schema 330,230 字符 → 默认预算下 45,381 字符（7 倍）。
- 真机闭环（`tools/probe-compact-live.mjs` / `tools/probe-tool-loop.mjs`，网关 `127.0.0.1:3425`，`kimi-fast` + `effort=low`）：305 工具请求 `http 200`、`usage.prompt_tokens=11,385`；单工具请求模型正确发出 `get_weather({"city":"北京","unit":"c"})`；把结果按 `role:"tool"` 回填后第二跳正常收尾（正文 53 字符 + 「16℃」）。
- `KIMI_TOOLS_MODE=full` 回到完整 JSON schema 渲染（旧行为，仅排查用）。

### 11.2 网页端内置技能的适配（2026-10-27，`src/skills.mjs`）

Kimi 网页/桌面容器内挂 `/app/.agents/skills/<name>/SKILL.md`。经 OpenAI 兼容通道调用时该路径不存在（真机 `read` 返回 `FS_NOT_FOUND`），且失败后模型常"顺着错思路"只吐思考不吐正文（会话 `session-72ea02fe…` 的空白回答）。插件按需在提示词最前面插入两段：

| 触发 | 注入内容 |
| --- | --- |
| 提示词中出现 Kimi 容器路径（`/app/.agents/skills/` 或 `/app/skills/`）或 `kimi-widget` | 环境校正：不是 Kimi 容器、没有该目录、不要为读规范去调工具、不要照抄 `/app/...` 路径；调用方自己声明的工具（含它自己的技能工具）照常可用 |
| 最后一条用户消息含「卡片/组件/看板/仪表盘/widget/card/dashboard」且客户端未提供 `show_widget`/`render_widget`/`artifact` 类工具 | 追加 `kimi-widget` 等价做法：自包含 HTML、全内联样式、先取数再一次性出卡片、卡片外最多一句说明 |

`KIMI_WEB_SKILLS=0` 关闭整段注入。客户端自带 widget/artifact 工具时只注入第一条，避免与真实渲染能力冲突。触发条件只认 Kimi 容器里的真实路径（以及 `kimi-widget` 这个技能名），客户端自己的"读 SKILL.md"约定不会被误伤——DSH 的真实请求里 `SKILL.md` 出现 0 次，只有模型自己脑补时才会出现。

真机对照（`tools/probe-compact-live.mjs` 的 B 段，问句就是 `session-72ea02fe…` 里那句）：

| 版本 | 行为 |
| --- | --- |
| 0.4.3 | 模型先 `read("/app/.agents/skills/kimi-widget/SKILL.md")` → `FsError FS_NOT_FOUND` → 第二跳只吐 619 字符思考、正文为空 |
| 0.5.0 | 一次成型：正文 2,249 字符（内联样式 HTML 卡片 + 真实天气 16℃/1℃ + `[2][10]` 引用），无 `/app`、无 `SKILL.md` |

### 11.3 卡片渲染：`html-card` 组件（2026-10-27，0.6.0）

0.5.0 起卡片就是正文里的自包含 HTML，插件不改写它。为了让宿主能把它渲染成真正的卡片，0.6.0 在正文之后补一帧 UI 事件：

```
tool_calls[] += { function: { name: "kimi_ui__render", arguments: JSON.stringify({
  v: 1, surfaceId: "card", itemId: "card", seq: <n>, op: "create", component: "html-card",
  props: { html: "<section style=…>…</section>", title: "北京天气", text: "卡片外那句说明", height?: 360 }
}) } }
```

| 项 | 约定 |
| --- | --- |
| 触发 | 本轮 `finish_reason` 不是 `tool_calls`，且正文里能切出**最外层带 `style=` 的 `<section>`/`<div>`**（含 ```` ```html ```` 围栏内的写法） |
| 切分 | `extractHtmlCard()` 配对同名标签（支持同名嵌套），`html` 原样下发、**不清洗不改写**；围栏外的文字进 `props.text` |
| `title` | 元素里第一个 `<h1~h3>`/`<title>` 的纯文本，截 80 字；没有就省略该字段 |
| 时机 | 正文全部推完之后、`finish_reason` 帧之前；`finish_reason` 保持 `stop` |
| 非流式 | 同一事件追加进 `message.tool_calls`；`message.content` 仍是 HTML 原文 |
| 不触发 | 工具轮（`tool_calls`）、纯 Markdown 表格、无 `style=` 的裸标签、未闭合元素（宁可退化也不猜） |
| 安全 | `html` 是不可信内容：宿主必须放进沙箱 iframe（`sandbox` 不含 `allow-scripts`）并在 srcdoc 里加 `default-src 'none'` 的 CSP；未知组件退回文本摘要 |

真机：`tools/probe-compact-live.mjs` 的 B 段（「…请用一个组件卡片展示」）在网关侧可看到 1 帧 `kimi_ui__render` + `component: "html-card"`，正文 2,456 字符、`finish_reason` 仍为 `stop`。
## 12. 参数刻度实测（2026-10-27，真机）

网页端的"思考强度 / 对话长度 / 速度"三组选项并非都能透传，逐值实测定死的结论：

| 参数 | 请求字段 | 可用值 | 实测被拒的值 |
| --- | --- | --- | --- |
| 思考强度 | `options.reasoningEffort` (8) | 3=LOW、5=HIGH、7=MAX | —（未发现拒绝） |
| 对话长度 | `options.contextLength` (9) | 5=L（标准档；插件固定使用） | 6 → `connect stream error`；7 → `Invalid parameter`（更高档位需要账号权限，插件不做选项） |
| 速度 | `options.speed` (15) | 1=Standard、5=Fast | 3、7 → `enum.defined_only`；10 → `Invalid parameter` |

要点：
- `Model.speed_options` 里出现的 1/3/5/7 是**展示刻度**，不能回填 `options.speed`（3/7 会被上游拒）。这条曾导致一次误判：探针把 7 传进去却被插件丢弃，回落到 5，看起来"7 也能用"。
- 对话长度受账号权限限制，超限值只能丢弃（回落服务端默认），否则整轮请求失败——实现里用 `KIMI_MAX_CONTEXT_LENGTH`（默认 5）做上限。插件默认不做这个选项：超长上下文消耗成倍增长，且几乎没有客户端能传该参数。
- 客户端可用 `reasoning_effort` / `speed` / `context_length` 覆盖；非法值静默丢弃，绝不发给上游。

### 12.1 思考档位矩阵（2026-10-27 用户前端确认）

逐个模型对照网页前端的思考档位核对，结论是**按模型分两档集合**：

| 模型 | `model_id` | `scenario` | 思考档位（`options.reasoningEffort`） |
| --- | --- | --- | --- |
| Instant | `k28-instant` | 1（CHAT） | Low(3) / High(5) |
| K2.8 | `k2d8-preview` | 6（OK_COMPUTER） | Low(3) / High(5) / Max(7) |
| K3.1 Pro | `k3d1-agent` | 6（OK_COMPUTER） | Low(3) / High(5) / Max(7) |
| K3 | `k3` | 6（OK_COMPUTER） | Low(3) / High(5) / Max(7) |

配套结论：

- **对话长度不做选项（产品决策）**：默认固定 L(5)。超长档位消耗成倍增长、适配的客户端极少，
  需要时由运维用 `KIMI_MAX_CONTEXT_LENGTH` 调上限（受账号权限限制，见 §12 的 `contextLength` 实测），不暴露给客户端。
- **速度不做选项（产品决策）**：请求枚举只接受 1=Standard / 5=Fast（3/7/10 会被上游拒，见 §12），更快的档位与更高消耗绑定、
  且只有部分模型提供；各档显式钉 FAST(5)，不暴露开关。
- **套餐名接口**：`POST /apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscription`
  （Connect-JSON，请求体 `{}`）→ `subscription.goods.title`。套餐名取 `subscription.goods.title`（各账号/地区返回值不同），
  用于 `auth.usage` 的 `plan` 字段（见 §14）。
- **实现**：`buildCatalog` 给每个模型与 spec 带 `reasoningEfforts`（Instant=[3,5]，其余=[3,5,7]），
  `tierToRequest` 按该集合夹取——集合内原样透传、超上界夹到上界（Instant 传 7 → 5）、
  非法/缺失不发（交上游默认）。magpie 的 `/v1/models` 里 `supported_reasoning_levels` 由 magpie
  自己的目录派生，插件模型条目没有对应字段，所以档位矩阵只在请求层强制。
- **给了档位就必须把 `thinking` 打开（2026-10-27 真机实测，重要）**：`options.thinking=false` 时，
  即使请求里显式带 `search{force:true}`，上游也**不会**给这次请求挂 `web_search` 工具，
  模型只能回答"我没有实时数据"；`thinking=true` 时同样的问句会触发 19~54 个 `web_search` 工具块，
  并返回真实天气。也就是说 Instant 的「思考」和「服务端联网搜索」是同一个开关。
  实测记录（`tools/probe-search-force.mjs`）：E(thinking=false, force=true) → `toolBlocks=0`；
  F(thinking=true, force=true) → `think=2224ch toolBlocks=19`；G(thinking=true, force=false) → `think=2198ch toolBlocks=54`。
  因此 fast 分支与 spec 分支在收到档位时都会写 `req.options.thinking = true`。
- **token 用量不是上游给的**：`ChatResponse.usage = 7` 对应的是 `kimi.chat.v1.Usage{research:1}`
  （联网搜索配额：`id/name/type/status/limit/used`），**没有任何 token 计数**；全仓唯一带
  `prompt_tokens/completion_tokens` 的 `kimi.chatty.v1.Usage` 属于另一个服务，不在本调用链上。
  所以插件按文本估算 `usage`（`src/tokens.mjs`：CJK 逐字≈1、其余 4 字符≈1），
  `cached_tokens` 恒 0，`reasoning_tokens` 单独估算；magpie 的 `usage.jsonl` 记的就是这份估算值。

## 13. 模型清单：按上游实际返回生成（2026-10-27 实测）

magpie 里 `kimi-chat` 的模型列表不再是三档硬编码，而是"三档语义入口 + 上游清单里的每个模型"：

- 数据源：`ConfigService/GetAvailableModels`，匿名可调（带鉴权同样可调，内容一致）。
- **默认场景（不带 scene）只回"菜单项"**：`K3.1 Pro / K2.8 / Instant / K3`，有 `display_name`（field 2）
  但 `model_id`（field 19）为空——这正是网页模型菜单的内容。
- **Work 场景（`scene=1`，请求体 `08 01`）才有 model_id**：`K3.1 Pro → k3d1-agent`、`K2.8 Preview → k2d8-preview`。
  两边的名字不完全一致（"K2.8" vs "K2.8 Preview"），所以匹配是"先精确、再前缀"（`matchModelId`）。
- 兜底：仍匹配不上时按场景取默认值（scenario=1 用 `default_chat_model`，其余用 `default_agent_model`）。
- 结果（实测）：`kimi-k3d1-agent`、`kimi-k2d8-preview`、`kimi-k28-instant` 三个动态入口，
  加上稳定三档 `kimi-fast` / `kimi-thinking` / `kimi-agent`，共 6 个；三档向后兼容旧客户端。
- 路由：动态入口带自己的 `scenario` / `kimiplus_id` / `model_id` / `thinking`（`spec` 直达 `tierToRequest`），
  不靠档位猜；三个语义档仍走档位逻辑，且底层 id 由清单每 10 分钟刷新（防服务端换挡）。
- **清单刷新必须覆盖已安装条目**：宿主 `config` 钩子里用 `??=` 时，`plugin-providers.json` 里的旧条目不会更新，
  表现为"代码加了动态清单，`/v1/models` 仍只有三档"。改为 `{...prev, ...config}` 显式覆盖 `models`。
- 思考档固定用 `k3-agent`：同场景下它的 think 块最完整（700+ 字级），而 `k3d1-agent` 思考极短。

## 14. 订阅用量与费用换算（2026-10-27 实测，用户抓包 + 活体复验）

两个 MembershipService 端点（Connect-JSON，**不是** chat 的 5B proto 信封；
`Content-Type: application/json` + `Connect-Protocol-Version: 1`，鉴权仍用聊天同一个 Bearer accessToken）：

| 用途 | 方法 | 请求体 |
| --- | --- | --- |
| 额度窗口 | `POST /apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats` | `{}` |
| 使用明细 | `POST /apiv2/kimi.gateway.membership.v2.MembershipService/ListBalanceActions` | `{"page_size":3,"filter":{"unit":"UNIT_CREDIT","balance_types":["SUBSCRIPTION"]}}` |

`GetSubscriptionStats` 返回（形状示例，数值已占位）：

```json
{
  "ratelimitCode5h": {"ratio": 0.00xx, "enabled": true, "resetTime": "<ISO8601>"},
  "ratelimitCode7d": {"ratio": 0.00xx, "enabled": true, "resetTime": "<ISO8601>"},
  "subscriptionBalance": {
    "feature": "FEATURE_OMNI", "type": "SUBSCRIPTION", "unit": "UNIT_CREDIT",
    "amountUsedRatio": 0.0xxx, "kimiCodeUsedRatio": 0.0xxx,
    "expireTime": "<ISO8601>"
  }
}
```

- `ratio` / `amountUsedRatio` 都是**已用比例**（0–1），乘 100 就是网页显示的百分比。
- 月额度扣费用 `amountUsedRatio`；5 小时/每周限流用 `ratelimitCode5h/7d.ratio`。
- `ListBalanceActions.actions[]` 每条形如
  `{"feature":"FEATURE_AGENT","title":"<chat title>","items":[{"balanceId":"…","amountRatio":0.00xx,"unit":"UNIT_CREDIT"}],"status":"DONE","timestamp":"…"}`。
  便宜档（Instant/`FEATURE_CHAT`）常没有 `amountRatio`（记为 0%），所以取摘要时要跳过缺省项。

插件映射（`src/usage.mjs` → `auth.usage`）：

- `plan` = 套餐名 + 价格：`<plan name>（月付 ¥<price>）`（套餐名取 `GetSubscription.subscription.goods.title`，
  拿不到退回 `Kimi 会员`；价格由环境变量 `KIMI_PLAN_CNY` 设置，默认 199，仅用于把额度百分比折算成金额）
- `balance` = `月额度剩余 <pct>%（≈¥<amount> / ¥<price>）`
- `windows[]` = **只有月额度一项**（`used` 为百分比，带 `display` 文本 `已用 <pct>% ≈ ¥<amount> / ¥<price>`）；
  `ratelimitCode5h/7d` 是限流器内部计数，不作为面向用户的展示项，故不映射
- `user` = 会话映射数（`<n> active / <m> mapped session(s)`），不再拼接"最近一次用量"

套餐名接口（实测，Connect-JSON 同上）：

| 用途 | 方法 | 请求体 | 关键字段 |
| --- | --- | --- | --- |
| 套餐名 | `MembershipService/GetSubscription` | `{}` | `subscription.goods.title`（如 `<plan name>`） |

注意：这两条接口的 access token 过期会返回 401；`usage()` 内部临时刷新一次（**不写回存储**，
避免和聊天轮的 `onTokenRefresh` 抢写），失败则只报 `error`，不影响聊天。

离线验证：`node test/usage.test.mjs`（纯函数映射）；真机验证在已登录的 magpie 实例上调一次
`auth.usage()`（或在客户端里看「额度」页），应得到 `{plan, until, balance, windows:[月额度…]}`。
