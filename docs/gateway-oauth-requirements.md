# 网关 OAuth / DPoP 接入契约

本文记录 2026-10-31 的 v1 协议与 fixture，基于客户端 `b6641b3` 和网关 `0c8e387`。当时的协商与实现详见[客户端实施记录](client-security-follow-up.md)。正式发行使用 `native-build-dpop-v1` 2.0。当前登录配置与验收要求见[仓库说明](../README.md)和[发布门禁](testing.md)。

## 现状与范围

本线程对 `embedding-reranker-next` 保持只读；用户已授权两线程分别在各自仓库实施：

客户端已有授权码 + PKCE S256、DPoP ES256、可轮换 Refresh Token 及撤销基础能力。新 profile 使用 `attest_jwt_client_auth_dpop`，固定认证草案 -12，同实例 key 绑定 Attestation、DPoP 与 HTTP Signature。浏览器仅带 `client_id`／`request_uri`；原九字段改由原生 POST `/oauth/par` 推送。合成 attestation 仅在 `--fixture` 回环服务内签发和验证，不表示真实可信实例已验收。网关线程独立负责验证器与后续应用接线；LinuxDo Access Token、网页登录 Cookie 和系统管理 Token 均不得交给 jg 充当推理凭证。

## 交付范围与地址

以下各节保留早期基础 fixture 细节；涉及认证方法、PAR、正文签名、错误与版本的旧描述由文首的新基线替代，不作为生产兼容要求。

以下路径以根 issuer `https://gateway.example.com` 为例；三个 OAuth 端点的实际路径由 metadata 提供。

| 接口或功能 | 网关需提供的行为 |
|---|---|
| `GET /.well-known/oauth-authorization-server` | 公开 JSON metadata，无需登录 |
| `GET /oauth/authorize` 及授权确认页面 | 复用网页登录、校验授权请求、用户同意后发码 |
| `POST /oauth/token` | 授权码交换与 Refresh Token 轮换 |
| `POST /oauth/revoke` | 撤销授权 family，包含本契约约定的 DPoP 校验 |
| `POST /v1/systemone` | 接受 DPoP 绑定的 Access Token，接入现有推理/权限/计费链路 |
| 网页授权管理 | 用户查看并撤销自己的 CLI 授权会话，供设备丢失或离线退出后使用 |

当前客户端只给 **`POST <EMRANK_BASE_URL 去掉末尾斜杠>/systemone`** 签名，不访问 `/decisions`、`/models` 或其他推理路径。`resource` 则是完整 API base URL，例如 `https://gateway.example.com/v1`，不是完整的 `/systemone` 地址。网关应预先允许该 resource 并进行受众校验，不能接受客户端任意指定的地址。

Issuer、API base 和所有 metadata 中的 OAuth 端点必须同源（协议、主机、有效端口一致）。联调使用无末尾斜杠的规范 issuer/base；客户端只会去掉 issuer 的末尾斜杠，`resource` 按配置的 base 原样发送。默认 base 为 `<issuer>/v1`，不同部署路径须显式提供 `EMRANK_BASE_URL`。

## 客户端注册及登录流程

`emrank-jevgrep` 只作为应用注册数据，网关核心不按该名称做特判。当前基础协议使用无 client secret 的公共客户端及 `token_endpoint_auth_method=none`；该模式不能证明官方运行实例，不能单凭 client_id 获得新计划中的 OAuth 优惠或 RPM 豁免。正式强安全 profile 的认证方法、证明、信任根及可选强制 PAR 待共同定稿后替换此基础契约，不能为旧客户端保留无证明旁路。不要求动态客户端注册、Device Flow、OIDC ID Token 或 userinfo 接口。`offline_access` 在本契约中表示申请 Refresh Token，不代表启用 OIDC。

当前客户端通过浏览器 GET 发送以下查询参数，值均按 URL 表单规则编码：

| 参数 | 值或要求 |
|---|---|
| `client_id` / `response_type` | `emrank-jevgrep` / `code` |
| `redirect_uri` | `http://127.0.0.1:<动态端口>/callback` |
| `scope` | `inference:systemone offline_access` |
| `resource` | 配置的完整 API base URL |
| `state` | 随机值，成功或错误回调原样回传 |
| `code_challenge_method` / `code_challenge` | `S256` / `BASE64URL(SHA256(code_verifier))`，无填充 |
| `dpop_jkt` | 本次登录生成的 EC P-256 公钥的 RFC 7638 SHA-256 thumbprint |

本客户端要求同时获得这两个 scope；不能满足时拒绝授权，不要静默缩减。当前客户端不读取响应中的 `scope` 来协商降级。模型 ID 是客户端推理配置，不是授权请求参数；服务端仍须按当前账户权限检查每次请求的实际模型。

桌面客户端绑定 `127.0.0.1` 的动态端口；注册规则为 `http://127.0.0.1:{ephemeral-port}/callback`，其中占位符表示允许端口变化，不是可任意匹配的 URL 通配符。授权端严格匹配 IP、HTTP 协议和 `/callback` 路径；拒绝 localhost 域名、其他 IP、userinfo、query、fragment 和任意重定向。授权码交换中的 redirect_uri 必须与发码时逐字一致。client_id 或 redirect_uri 无效时在网关页面报错，不向未经验证的地址回跳。

浏览器端复用网关登录状态，并显示客户端名称、目标服务、模型推理范围、离线访问及授权撤销入口。用户确认授权必须有 CSRF 防护，不能把 Cookie 登录或静默重定向当作同意。账户禁用、角色/模型范围、余额与配额按现有规则检查；拒绝授权返回 `error=access_denied`。

成功后以浏览器重定向把 `code`、原样的 `state`、RFC 9207 `iss` 放在回调 URL 的 query 中；合法回调地址上的错误响应同样带 `state` 和 `iss`，例如 `error=access_denied`。每个参数只出现一次，不能同时返回 code 与 error；不使用 fragment 或 `form_post`。`iss` 与 metadata 的 issuer 完全一致。

授权码短时有效、原子地单次使用，绑定 client_id、redirect_uri、PKCE challenge、account、resource、scope、授权请求中的 `dpop_jkt`。先完成请求/DPoP/Nonce/PKCE 等校验，再消费授权码并发放 Token。客户端默认等待登录 180 秒（可配置 1–300 秒），取消或超时后关闭本机回调；`--no-browser` 只是手动打开同一授权 URL，仍需浏览器能访问 CLI 所在机器的回环端口。

## Discovery 与 Token 契约

RFC 8414 metadata：根 issuer 使用 `GET /.well-known/oauth-authorization-server`；例如 issuer 为 `https://gateway.example.com/tenant/a` 时，发现地址为 `https://gateway.example.com/.well-known/oauth-authorization-server/tenant/a`。以下是当前基础 fixture 的 metadata 示例；正式网关应按 v1 契约声明实际可用的强认证/PAR 能力，不复制该示例开放 `none` 入口。

```json
{
  "issuer": "https://gateway.example.com",
  "authorization_endpoint": "https://gateway.example.com/oauth/authorize",
  "token_endpoint": "https://gateway.example.com/oauth/token",
  "revocation_endpoint": "https://gateway.example.com/oauth/revoke",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "scopes_supported": ["inference:systemone", "offline_access"],
  "token_endpoint_auth_methods_supported": ["none"],
  "revocation_endpoint_auth_methods_supported": ["none"],
  "code_challenge_methods_supported": ["S256"],
  "dpop_signing_alg_values_supported": ["ES256"],
  "authorization_response_iss_parameter_supported": true
}
```

当前客户端要求 metadata 中 issuer 完全匹配，三个端点和 S256、ES256、iss 支持声明必填；端点与 issuer 同源、无 URL userinfo/query/fragment，使用 HTTPS。只有编译了 `test-http-loopback` feature 的隔离测试包，加上 `EMRANK_ALLOW_HTTP_LOOPBACK=1` 才接受 `127.0.0.1` HTTP；普通发行包忽略此降级开关并拒绝 HTTP。客户端不跟随发现、Token、撤销或资源请求的 HTTP 重定向；浏览器授权/登录过程可以正常重定向。不要依赖 HTTP→HTTPS、补末尾斜杠或跳转登录页来修正这些接口请求。

基础 fixture 的 `revocation_endpoint_auth_methods_supported` 显式声明 `none`，避免 metadata 的默认 `client_secret_basic` 与其公共客户端流程冲突。这里的 `none` 表示没有客户端 secret；Token 和撤销仍须验证 DPoP 密钥持有证明，尚不具备新 profile 要求的可信实例认证。原生客户端请求不携带网页登录 Cookie 或管理端 CSRF 头，不能套用网页登录接口的前置要求；浏览器授权确认页面仍须执行会话和 CSRF 校验。

当前客户端要求显式声明 Token/撤销认证方法；不包含已支持的 `none` 时拒绝登录。metadata 声明 `require_pushed_authorization_requests=true` 时同样明确拒绝，不绕过强制 PAR 去打开直接授权 URL。通用 attestation 机制与其他安全 profile 的完整协商等待共同契约，不把对已知 metadata 的拒绝检查当作已实现证明能力。

`POST token_endpoint` 使用 `application/x-www-form-urlencoded`；不发送 HTTP Basic、Bearer 或 client_secret。两种请求均带 `DPoP: <proof JWT>`，proof 不带 `ath`。

| 请求 | 表单字段 |
|---|---|
| 授权码交换 | `grant_type=authorization_code`、`client_id`、`resource`、`code`、`code_verifier`、`redirect_uri` |
| 刷新 | `grant_type=refresh_token`、`client_id`、`resource`、`refresh_token` |

刷新不再发送 `scope` 或 `redirect_uri`，沿用原授权的账户、客户端、范围、resource 和 DPoP 密钥绑定，不得提权。成功返回 HTTP 200 和 JSON：

```json
{
  "access_token": "opaque-or-jwt-bound-token",
  "token_type": "DPoP",
  "expires_in": 300,
  "refresh_token": "rotated-refresh-token",
  "account_id": "stable-opaque-account-id"
}
```

`account_id` 是本客户端约定的必填扩展字段，不代表 OIDC 身份证明，不是用户名；同一账户保持稳定，刷新不能改变该字段。当前客户端的响应约束如下：

- `access_token`、`refresh_token`：均必填，1–16384 字节，无空格/控制字符的可打印 ASCII；首次换码也必须返回 Refresh Token。
- `token_type`：`DPoP`，禁止退回 Bearer。
- `expires_in`：JSON 整数，31–86400 秒，建议 300 秒；实际服务端到期时间应与返回值一致。
- `account_id`：非空字符串，最多 256 个 UTF-8 字节。
- Discovery、Token 及客户端读取的撤销错误响应正文不超过 64 KiB；OAuth 错误为顶层字符串 `error`，例如 `{"error":"invalid_grant"}`，不能使用推理接口的嵌套错误格式或 HTML 登录页。

每次刷新**必须返回与旧值不同的 Refresh Token**；客户端检查其存在、格式及新旧值不同，收到相同值时清理本地秘密并保留重新登录标记。客户端不能验证服务端是否真的废弃旧值，轮换仍须由服务端验收证明。Token 响应设置 `Cache-Control: no-store`、`Pragma: no-cache`。客户端不解析 Access Token，不要求客户端使用 JWKS 或 introspection；网关 v1 已明确使用不透明 Token，不需要为客户端增加 JWT 兼容路径。

## 当前客户端的原生资源边界

JS 仅提交结构化 state 和相关性问题；原生入口不接受 URL、method、model、任意 HTTP header 或待签名正文。Rust 从登录会话选取地址和模型，生成最终 JSON、签署 DPoP、发送 HTTPS 并处理 Nonce。已移除 `authorizeRequest` / `acceptNonce` 导出，真实认证头、DPoP 和原始远端响应不返回 JS。

当前能力限于非空 JSON 对象 state 和 1–256 个 `noul` 问题；问题 ID 最长 128 字节，仅字母/数字/下划线/短横线，instructions 为 1–65536 字节。最终请求不超过 13 MiB；响应不超过 1 MiB，只接受 HTTP 200、无内容编码的 JSON，校验问题集合、类型、0–1 分数和非负整数用量后重建响应。未知字段、服务端返回的任意字符串和头不透传；错误保留 HTTP 状态及合法 Retry-After，并替换为固定的客户端说明。

操作有最长 60 秒总时限，沿用上游 SDK 的 AbortSignal；等待凭证锁、网络响应或响应正文时可以取消。已发出的刷新请求会完成轮换凭证落盘，然后才检查取消，避免丢失新 Refresh Token；取消后不继续发推理。Nonce 重试使用相同业务字节和新的 proof/jti；原生层不重试其他 HTTP 或网络错误，上游既有业务重试策略仍独立存在。

发现、Token、撤销、资源请求统一使用 Rust reqwest/rustls、内置公共信任根、正常证书链/域名校验和禁止跳转策略，不使用环境代理或自定义 CA/关闭验证选项。SPKI 固定与 HTTP Message Signatures 尚未实施；标准 DPoP 不覆盖正文。输入限制和原生封装减少认证材料暴露，**不证明其他进程不能调用同一原生模块，也不构成官方实例证明**。

## DPoP 校验及重放防护

按 RFC 9449 校验 `typ=dpop+jwt`、`alg=ES256`、公开 EC P-256 JWK，无私钥字段；禁止算法降级或算法混淆。校验签名、`htm`、规范化 `htu`（不含 query/fragment）、`iat` 窗口、随机 `jti`、Nonce。资源请求还需校验 `ath=BASE64URL(SHA256(access_token))`。

Access/Refresh Token、授权码与同一 JWK thumbprint 绑定。资源请求头为 `Authorization: DPoP <access_token>` 和 `DPoP: <proof JWT>`。资源端按 `cnf.jkt` 或等效服务端绑定验证，并检查 Token 的 issuer、受众、到期、scope、撤销及账户状态；不能因为 Token 有效就省略 proof。使用 Bearer 方案提交 DPoP Token 必须失败，原有 API Key Bearer 入口继续独立生效。

`(jkt,jti)` 必须在整个可接受窗口内跨实例原子去重（例如 Redis SET NX+TTL）；明确 iat 时钟偏差、有效窗口和 TTL，不能在 proof 仍可接受时提前删除去重记录。代理 URL 重构只信任明确配置的代理，按客户端看到的外部 HTTPS 地址校验 `htu`，不能信任任意转发头。拒绝重复/歧义的 Authorization 或 DPoP 头，不记录凭证原文。

授权服务器（AS）和资源服务器（RS）的 Nonce 作用域分开：

| 挑战位置 | 网关响应 | 客户端重试条件 |
|---|---|---|
| Token | HTTP 400，JSON `{"error":"use_dpop_nonce"}`，`DPoP-Nonce` | 三者齐全才重试；客户端也兼容 HTTP 401，但服务端按 RFC 9449 返回 400 |
| 撤销（本契约扩展） | 与 Token 挑战相同 | 校验错误码和 Nonce 后重试；首个请求可能携带此前的 AS Nonce |
| 资源 | HTTP 401，`WWW-Authenticate: DPoP error="use_dpop_nonce"`，`DPoP-Nonce` | 依靠状态码及两个响应头，只有 JSON 错误正文不会触发重试 |

Nonce 使用不可预测、无填充的 base64url 值，长度不超过 1024 字节；每个响应只发一个 `DPoP-Nonce` 头。客户端每次操作最多重试一次，每次重新签名并生成新 jti；Token/资源成功响应可携带下次使用的新 Nonce。服务端允许近期 Nonce 的合理并发窗口，不能让并发推理互相使 Nonce 失效。撤销端若不接受之前 Token 端的 AS Nonce，须通过一次挑战提供可用值。

**Nonce 挑战不得消费授权码或 Refresh Token，也不得先执行撤销、推理或计费。** 通过全部校验后，才原子消费授权码/旧 Refresh Token。签名错误、重放和未授权请求在推理及计费副作用前返回；不得向模型上游发送请求、扣费或重复结算。拒绝响应正文、应用/代理访问日志与跟踪记录不得回显 Token、proof、code、verifier 或私钥；授权 URL 和回调 query 也应按敏感信息脱敏。

## 轮换、退出和权限/计费

Refresh Token 使用高熵值，服务端只存不可逆摘要，记录 family、generation、账户、客户端、scope、resource、jkt、到期和撤销状态；保留已消费代的摘要和 family 关系用于重用检测，不能消费后直接丢失追踪。一次刷新以事务方式消费旧代并产生新代；验证 client_id 和密钥绑定后，检测旧 Token 重用时撤销整个 family 及其访问凭证，返回 HTTP 400 `invalid_grant`。明确 Refresh Token 的绝对/闲置有效期，不因轮换无限续期。

当前客户端在同一凭证目录内通过跨进程锁串行刷新，**下一次资源请求发现距过期不足或等于 30 秒时**刷新，没有后台定时任务。刷新收到 `invalid_grant` 或未轮换的相同 Refresh Token 后清除 Token/私钥、保留需重新登录的标记；网络错误和其他 OAuth 错误不会统一清除凭证，也不会自动切换 Provider。

资源端普通 401/403 会使本次请求失败，**不会立即强制刷新、清除本地会话或回退为 API Key/Bearer**；`--status` 只读本地状态，不检查远端撤销。网关必须自行即时拒绝失效凭证，不能依赖客户端收到错误后清理。授权失效后用户可重新登录；明确 `--logout` 或指定原 Provider 才恢复原 Provider。

撤销端采用 RFC 7009 表单：`token=<refresh_token>`、`token_type_hint=refresh_token`、`client_id`；不发送 `resource`、Cookie 或客户端 secret。请求带 DPoP proof，`htm=POST`、`htu=revocation_endpoint`，不带 `ath`。**RFC 7009 本身不规定 DPoP 撤销流程；密钥绑定、Nonce 挑战和 family 撤销是本接入契约的附加要求。**

先验证 proof/Nonce，对已知 Token 校验 client_id 和 jkt，撤销对应 family 及全部相关访问凭证，不撤销该账户其他设备的独立授权或网页登录会话。已撤销或未知 Token 在请求满足适用校验后仍返回 HTTP 200，正文可为空；重复撤销须使用新的 proof/jti，不能误当重放的同一 HTTP 请求放行。JWT Access Token 同样需要服务端撤销状态检查，不能仅等待自然过期。

`jg emrank --logout` 无论远端是否可达都会尝试清除本地凭证；输出 `remoteRevoked=false` 时用户需在网关授权管理页完成撤销。`remoteRevoked=true` 也可能表示本地没有会话或 Refresh Token，不能单独作为远端已撤销的证据。网页撤销入口必须独立于 CLI 本地凭证可用。

OAuth 资源身份必须进入现有 `AuthenticatedCaller` / billing 处理边界，明确账户、独立授权会话标识、客户端、授权范围、有效权限版本；不得借用无配额的“内部管理员”路径，也不能把系统管理 Token 复用为推理 Token。现有 caller key 的授权与计费继续有效，OAuth scope 不提升用户既有模型权限。授权撤销、账户禁用、配额/余额不足的生效时效需与现有 API Key 规则一致并可审计。

`inference:systemone` 首期只授权上述 POST 路径，不能因为 `/decisions` 与 `/systemone` 共用处理器而放行其他路径或操作。按最新共同计划，只有服务端完成可信客户端、账户和授权校验的 OAuth caller 才豁免本站消费 RPM，RPM 倍率为 1，再乘超管配置的每应用 `oauth_ratio`。API Key 保持原规则；账户余额、上游 429、容量保护和认证端点防滥用限制仍有效。客户端不发送、计算或决定优惠倍率/RPM 豁免，不通过重登生成 family 绕过账户额度；价格和授权状态以服务端为准。

网关按请求准入快照处理倍率和消费归属，现有模型/账户准入继续执行；目前没有依据声称已有逐账户模型 allowlist，新建此类能力须另列需求。审计使用内部 ID 而不是 Token 原文。

## 联调配置交付

网关侧需提供可直接填写的 `EMRANK_ISSUER`、`EMRANK_CLIENT_ID`（默认 `emrank-jevgrep`）、`EMRANK_BASE_URL`、可用的完整公开模型 ID `EMRANK_MODEL`、授权管理页面地址，以及 Token 生命周期、Nonce/时钟窗口和撤销生效规则。测试账户及额度通过既有安全渠道配置，不在文档、仓库或聊天中传递密码/Token。

浏览器只负责登录/同意/回跳；Token、撤销和推理由本机 Rust/Node 发起，当前 CLI 不依赖跨域浏览器 Fetch 或新增 CORS 放行。可用 `jg emrank --login` → `jg emrank --status` → `jg doctor` → 实际语义检索 → `jg emrank --logout` 作为正向联调入口。

## 联调与服务端验收（未执行）

2026-10-31 重新运行 `bun test --timeout 60000 tests/emrank`：5 项通过、71 个断言，使用现有 Windows 构建产物和本地协议 fixture。覆盖登录/拒绝/超时、PKCE/DPoP 正向链路、Nonce、跨进程刷新、invalid_grant、退出及原 Provider 共存。fixture 不是网关，不证明真实同意页面、完整恶意输入覆盖、family 重用撤销、撤销幂等/Nonce、跨实例去重、生产权限或计费已经实现。

真实测试环境需提供已注册客户端、测试账户、授权页面、可推理模型和受限测试额度，不使用生产账户。网关实现后补充独立真实环境工作流，以浏览器自动化完成登录/同意，再驱动发行包 `jg`：

1. 全新用户登录、已有 Cookie 登录、拒绝同意、取消、超时、回调端口冲突；页面 CSRF、错误 state/iss、重复参数、开放重定向攻击被拒绝。
2. 实际 `jg doctor` 和语义检索通过 `/v1/systemone`，账户、模型、scope、资源地址、计费/日志归属正确；原版 API Key Provider 同时正常。
3. 真实过期后的刷新、并发/多进程刷新、旧代重用撤销整个 family、重复/未知 Token 撤销、撤销端 Nonce、远端不可达退出、网页撤销、账户禁用后请求拒绝；不影响其他设备 family，失败不自动用原 Provider 发出代码。模拟刷新响应丢失，确认旧代不会继续换取新令牌。
4. 错 htm/htu/ath、错误签名/公钥、过期 iat、重放 jti、无 proof、跨 resource/client/account Token，以及授权码/Refresh Token 的跨密钥使用全部失败。
5. Token 和资源 Nonce 分别挑战；换码/刷新首次被挑战后仍可用同一 code/Refresh Token 重试，并发 Nonce 不互相干扰；不发生无限重试，拒绝请求不计费、不调模型，成功推理只计费一次。跨网关实例复用 proof 被拒绝。
6. 每个正式上游同步候选运行本仓库双平台测试；真实环境定期及发布前跑浏览器链路，任何失败都不得报告“真实 OAuth 已验收”。

## 标准依据与实现核对入口

- [RFC 8252 §7.3](https://www.rfc-editor.org/rfc/rfc8252.html#section-7.3)：桌面应用回环回调及动态端口；[RFC 7636](https://www.rfc-editor.org/rfc/rfc7636.html)：PKCE。
- [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414.html)：metadata 和发现路径；[RFC 9207](https://www.rfc-editor.org/rfc/rfc9207.html)：授权响应 iss；[RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html)：resource。
- [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html)：DPoP、AS/RS Nonce、dpop_jkt；[RFC 7638](https://www.rfc-editor.org/rfc/rfc7638.html)：公钥 thumbprint；[RFC 7009](https://www.rfc-editor.org/rfc/rfc7009.html)：撤销及幂等响应。
- 客户端入口：[配置与资源限制](../native/src/config.rs)、[登录与回调](../native/src/oauth.rs)、[Token/刷新/撤销](../native/src/token.rs)、[DPoP proof](../native/src/dpop.rs)、[原生授权](../native/src/lib.rs)、[请求与错误处理](../overlay/emrank.ts)。
- 协议 fixture 与现有回归：[server.ts](../tests/emrank/server.ts)、[login.test.ts](../tests/emrank/login.test.ts)。服务端验收须另行覆盖上述未实现/未验证的项目。
