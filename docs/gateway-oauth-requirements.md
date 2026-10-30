# 网关 OAuth / DPoP 需求（本轮仅设计，不修改网关）

## 现状与范围

只读核对 `E:\RUST_WORKSPACE\embedding-reranker-next`：

- `crates/emrank-app/src/identity/auth/mod.rs` 是网关作为 LinuxDo OAuth **客户端**进行网页登录，并非面向 jg 的授权服务器。
- `crates/emrank-app/src/identity/access_keys.rs:378` 的推理鉴权只接受 `Bearer`（Gemini 路由另支持 `x-goog-api-key`），尚未接受 `Authorization: DPoP`。
- `crates/emrank-app/src/http/handlers.rs:65` 注册 `/v1/systemone` 与 `/v1/decisions`。jg 的 TypeSafe SDK 向 base URL 追加 `/systemone`，因此默认 base 为 `<issuer>/v1`。

后续网关需新增公共客户端授权码 + PKCE S256、DPoP ES256、可轮换 Refresh Token 及撤销接口。保持现有账户、登录、API Key、权限、配额、计费、请求日志和模型路由语义；本需求不授权数据库迁移或上线，也不要求将 LinuxDo Access Token 交给 jg。

## 客户端注册及登录流程

注册公共客户端 `emrank-jevgrep`，无 client secret。只允许 `response_type=code`，强制 PKCE S256，`token_endpoint_auth_method=none`。首次范围为 `inference:systemone offline_access`，resource 为配置的完整 API base URL，如 `https://gateway.example.com/v1`。

桌面客户端绑定 `127.0.0.1` 的动态端口；注册回调模板为 `http://127.0.0.1:{ephemeral-port}/callback`。授权端严格匹配 IP、HTTP 协议和 `/callback` 路径，允许端口变化；拒绝 localhost 域名、其他 IP、userinfo、fragment 和任意重定向。授权码交换中的 redirect_uri 必须与发码时逐字一致。

浏览器端复用网关登录状态，并显示客户端名称、目标服务、模型推理范围、离线访问及授权撤销入口。用户确认授权必须有 CSRF 防护，不能把 Cookie 登录或静默重定向当作同意。账户禁用、角色/模型范围、余额与配额按现有规则检查；拒绝授权返回 `error=access_denied`。

成功回调包含 `code`、原样的 `state`、RFC 9207 `iss`；错误回调同样带 `state` 和 `iss`。授权码短时有效、单次使用，绑定 client_id、redirect_uri、PKCE challenge、account、resource、scope、授权请求中的 `dpop_jkt`。授权码泄露者没有 verifier 和 DPoP 私钥仍不能换取令牌。

## Discovery 与 Token 契约

RFC 8414 metadata：根 issuer 使用 `GET /.well-known/oauth-authorization-server`；含路径 issuer 使用 RFC 8414 的 well-known 插入规则。

```json
{
  "issuer": "https://gateway.example.com",
  "authorization_endpoint": "https://gateway.example.com/oauth/authorize",
  "token_endpoint": "https://gateway.example.com/oauth/token",
  "revocation_endpoint": "https://gateway.example.com/oauth/revoke",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "token_endpoint_auth_methods_supported": ["none"],
  "code_challenge_methods_supported": ["S256"],
  "dpop_signing_alg_values_supported": ["ES256"],
  "authorization_response_iss_parameter_supported": true
}
```

当前客户端要求 metadata 中 issuer 完全匹配、各端点与 issuer 同源、无 URL userinfo/query/fragment；使用 HTTPS。只有显式开启本地测试选项时接受 `127.0.0.1` HTTP。客户端不跟随发现、Token、撤销或资源请求的 HTTP 重定向。

`POST token_endpoint` 使用 `application/x-www-form-urlencoded`，包含 client_id、resource、grant_type；授权码交换另含 code、code_verifier、redirect_uri；刷新另含 refresh_token。两种请求均带 DPoP proof，Token 请求 proof 不带 `ath`。

```json
{
  "access_token": "opaque-or-jwt-bound-token",
  "token_type": "DPoP",
  "expires_in": 300,
  "refresh_token": "rotated-refresh-token",
  "account_id": "stable-opaque-account-id"
}
```

`account_id` 是本客户端约定的必填扩展字段，不代表 OIDC 身份证明，不是用户名；刷新不能改变该字段。成功响应要求 31–86400 秒的有效期（建议 300 秒）、非空 Token，**每次刷新必须返回新的 Refresh Token**。禁止退回 Bearer。响应设置 `Cache-Control: no-store`，不返回第三方登录 Token。

## DPoP 校验及重放防护

按 RFC 9449 校验 `typ=dpop+jwt`、`alg=ES256`、公开 EC P-256 JWK，无私钥字段；禁止算法降级或算法混淆。校验签名、`htm`、规范化 `htu`（不含 query/fragment）、`iat` 窗口、随机 `jti`、Nonce。资源请求还需校验 `ath=BASE64URL(SHA256(access_token))`。

Access/Refresh Token、授权码与同一 JWK thumbprint 绑定。资源端按 `cnf.jkt` 或等效服务端绑定验证，不能因为 Token 有效就省略 proof。`(jkt,jti)` 必须在整个有效窗口内跨实例原子去重（例如 Redis SET NX+TTL）；代理 URL 重构只信任明确配置的代理，不能信任任意转发头。

授权服务器和资源服务器的 Nonce 作用域分开。Token/撤销挑战返回 HTTP 400 或 401、JSON `{"error":"use_dpop_nonce"}`、`DPoP-Nonce`。资源挑战返回 HTTP 401、`WWW-Authenticate: DPoP error="use_dpop_nonce"` 和 `DPoP-Nonce`。客户端最多重试一次，每次重新签名并生成新 jti；可以接受成功响应里的新 Nonce。Nonce 应允许合理并发窗口，不能让并发推理互相使 Nonce 失效。

Nonce 挑战、签名错误、重放和未授权请求必须在推理及计费副作用前返回。网关拒绝时不得向模型上游发送请求、扣费或重复结算。响应正文与日志不得回显 Token、proof、code、verifier 或私钥。

## 轮换、退出和权限/计费

Refresh Token 使用高熵值，服务端只存不可逆摘要，记录 family、generation、账户、客户端、scope、resource、jkt、到期和撤销状态。一次刷新以事务方式消费旧代并产生新代；检测旧 Token 重用时撤销整个 family，返回 `invalid_grant`。客户端通过跨进程锁串行刷新，并在过期前 30 秒刷新；刷新失败不会回退为 API Key 或 Bearer。`invalid_grant` 后清除 Token/私钥但保留需要重新登录的状态，直到用户重新登录、显式退出或指定原 Provider。

RFC 7009 撤销端接收 token、token_type_hint=refresh_token、client_id，必须验证 DPoP 和密钥绑定；撤销 family 及相关访问凭证。重复撤销仍成功。`jg emrank --logout` 无论远端可达与否都会尝试清除本地凭证；输出 `remoteRevoked=false` 时用户需在网关会话页完成远端撤销。

OAuth 资源身份必须进入现有 `AuthenticatedCaller` / billing 处理边界，明确账户、独立授权会话标识、客户端、授权范围、有效权限版本；不得借用无配额的“内部管理员”路径，也不能把系统管理 Token 复用为推理 Token。现有 caller key 的授权与计费继续有效，OAuth scope 不提升用户既有模型权限。授权撤销、账户禁用、配额/余额不足的生效时效需与现有 API Key 规则一致并可审计。

## 联调与服务端验收（未执行）

真实测试环境需提供已注册客户端、测试账户、授权页面、可推理模型和受限测试额度；不在仓库保存密码/Token，不使用生产账户。网关实现后补充独立真实环境工作流，以浏览器自动化完成登录/同意，再驱动发行包 `jg`，区分协议 fixture 与真实验收：

1. 全新用户登录、已有 Cookie 登录、拒绝同意、取消、超时、回调端口冲突；页面 CSRF、错误 state/iss、重复参数、开放重定向攻击被拒绝。
2. 实际 `jg doctor` 和语义检索通过 `/v1/systemone`，账户、模型、scope、资源地址、计费/日志归属正确；原版 API Key Provider 同时正常。
3. 真实过期后的刷新、并发/多进程刷新、轮换重用检测、退出撤销、账户禁用后请求拒绝；失败不自动用原 Provider 发出代码。
4. 错 htm/htu/ath、错误签名/公钥、过期 iat、重放 jti、无 proof、跨 resource/client/account Token，以及授权码/Refresh Token 的跨密钥使用全部失败。
5. Token 和资源 Nonce 分别挑战；不发生无限重试，拒绝请求不计费、不调模型；成功推理只计费一次。
6. 每个正式上游同步候选运行本仓库双平台测试；真实环境定期及发布前跑浏览器链路，任何失败都不得报告“真实 OAuth 已验收”。
