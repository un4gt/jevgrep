# 本地 Docker OAuth 与 agent 联调

状态（2026-11-01，02:16 +08:00）：本地隔离端到端验收已通过。真实网页登录后，修复后的新 PAR 完成浏览器 consent／回环回调，安装后的 jg 通过 status、doctor 和实际查询，当前 agent 根据返回片段回答，随后 logout 确认本地清除与远端撤销。生产部署与真实证明／模型／账务不在本结果内。

网关负责自己的仓库、Docker 服务及测试账户；本线程只读网关仓库，负责客户端安装、真实浏览器登录和当前 agent 的实际 `jg` 查询。普通构建及旧会话的生产信任门槛保持不变。

## 接入条件

当前 `test-http-loopback` 专用构建需要 `EMRANK_ALLOW_HTTP_LOOPBACK=1`，issuer 必须为 `http://127.0.0.1:<端口>`。不接受 localhost、容器内部主机名或监听通配地址作为 issuer。Docker 映射仅绑定宿主 127.0.0.1；所有请求按这一真实外部 URL 生成 proof 与正文签名，不改写成 HTTPS。

| 项目 | 要求 |
|---|---|
| issuer / resource | 根 issuer；同源 `<issuer>/v1` |
| 发现 | `GET /.well-known/oauth-authorization-server` |
| OAuth | `/oauth/authorize`、`/oauth/par`、`/oauth/token`、`/oauth/revoke` |
| 资源 | `POST /v1/systemone`，仅 System One noul 响应 |
| 浏览器回调 | `http://127.0.0.1:<动态端口>/callback`，state、iss 校验 |
| profile | `attested-dpop-v1`，contract `1.0`，认证草案 `draft-ietf-oauth-attestation-based-client-auth-12` |
| 认证 | `attest_jwt_client_auth_dpop`、ES256、`dpop_combined`、强制 PAR |
| 完整性 / 错误 | `oauth-resource-v1` / `emrank-oauth-errors-v1` |

完整可用 metadata 构造参见 [profile-peer.ts](../tests/emrank/profile-peer.ts) 与 [server.ts](../tests/emrank/server.ts) 的基础字段。本地协议接口符合上述约定时，**无需新增客户端 transport/profile 开关**。

## 合成证明 API

只在本地隔离服务暴露 `POST /__fixture/attestation`：输入 JSON `{client_id, jwk}`，返回 HTTP 200 JSON `{attestation: "<compact JWT>"}`。jwk 是客户端新生成实例 key 的公钥，私钥不离开原生模块。

测试签发 key 为已公开 fixture 标量 32 个 `0x01`，不可用于生产。JOSE header 必须精确为：

```json
{"typ":"oauth-client-attestation+jwt","alg":"ES256","kid":"issuer-key-1"}
```

claims：`iss="https://attester.example.test"`（逻辑测试标识，不访问该域名）、`sub=client_id`、`cnf.jwk=请求公钥`、`https://emrank.tech/oauth/client-policy="native-test-policy-v1"`。iat 使用当前 Unix 整秒，满足 `iat <= now+5`、`iat < exp <= iat+300`、`now < exp`；不能沿用静态包的固定时钟。客户端实际校验公开 fixture 根签名、公钥绑定及期限。该 API 不代表平台证明服务已经实现。

## 已安装客户端

Windows 专用包位于 `.work/fixture-packages/win32-x64-msvc/`：

| 文件 | SHA-256 |
|---|---|
| `emrank-jevgrep-0.8.5.tgz` | `8a17cc54a9db5914a27803f637b8dec62c5fb3148bc7e58b03de62b241a52b8a` |
| `emrank-jevgrep-native-0.1.0.tgz` | `76283a24dea93c2f8198358cbaf0704f5c9dc316e1a90df7e12264024b8dc7dc` |
| `emrank-jevgrep-native-win32-x64-msvc-0.1.0.tgz` | `7a5415191ee6eb03bf130e2a2bf0fb031df162b8eead18e558033f9c696abce6` |

已使用 Bun 安装到 `E:/RUST_WORKSPACE/jg/.work/docker-oauth-e2e/client`，Node 探针确认 `protocolTestBuild=true`。未安装全局 jg，未覆盖主工作区普通 native，未使用既有用户凭据。安装证据在 `.work/docker-oauth-e2e/client-install.json`；本轮准备脚本与运行产物保存在忽略的 `.work`，未增加正式发行入口。

包装命令为 `.work/docker-oauth-e2e/bin/jg.ps1`，同目录 `jg.cmd` 可仅在测试 agent 子进程内加入 PATH。包装器验证回环 issuer，设置独立的 `EMRANK_HOME`、XDG 配置／缓存目录、`EMRANK_PROVIDER=emrank`、300 秒登录等待；不会回退到用户原 Provider 发请求。

已将网关公开参数写入 `.work/docker-oauth-e2e/settings.json`：`issuer=http://127.0.0.1:5186`、`clientId=emrank-jevgrep`、`model=fixture/oauth-noul`，资源 base 为 `http://127.0.0.1:5186/v1`。网站普通测试账户 role=1，凭据从受限本地 JSON 仅在浏览器内填入页面表单，不放入 settings、文档或消息正文。

运行命令：

```powershell
pwsh -NoProfile -File .work/docker-oauth-e2e/bin/jg.ps1 emrank --login --no-browser
# 在真实浏览器完成登录、consent 和动态回环回调后：
pwsh -NoProfile -File .work/docker-oauth-e2e/bin/jg.ps1 emrank --status
pwsh -NoProfile -File .work/docker-oauth-e2e/bin/jg.ps1 doctor
```

Token 成功响应须含 DPoP token_type、稳定 opaque account_id、`30 < expires_in <= 86400` 和轮换 refresh_token。资源成功响应为 `application/json` 的 `{model, answers:{questionId:{type:"noul",noul:0..1}}, usage:{input_tokens,output_tokens}}`，不能以 chat-completions 响应代替。

## agent 实际使用与验收

本机存在 codex、claude、opencode、gemini 命令，但本轮不预设这些独立进程的登录／模型配置可用。选用当前 T3/Codex agent 会话调用真实安装包，不另外购买模型或改写用户全局 agent 配置，也不把当前会话的调用冒称为另一个独立 agent CLI 进程。

隔离代码项目为 `.work/docker-oauth-e2e/agent-project`，含授权撤销、搜索入口及模型目录示例。其 AGENTS.md 要求 agent 先实际执行 jg，再根据返回的源代码片段说明撤销如何阻止后续搜索。OAuth 成功后，当前 agent 实际执行了：

```powershell
pwsh -NoProfile -File ../bin/jg.ps1 --no-cache "Where does revoking authorization prevent the next search?" .
```

工作目录为上述 agent-project。命令退出码 0，返回 `authorization.ts`、`search.ts`、`catalog.ts` 和 `AGENTS.md` 四个文件的片段。当前 agent 根据返回片段回答：`revokeAuthorization` 设置 `revokedAt`，`searchSources` 在返回结果前调用 `requireActiveAuthorization`，后者发现撤销时间非空即抛出拒绝错误，因此后续搜索在入口检查处终止。`catalog.ts` 与撤销判断无关。该说明针对受控示例，不冒称分析了网关内部实现。

合成模型和证明应在 Docker UI 与报告明确标识；成功只证明本地 OAuth、原生请求和 agent 工具调用链路，不证明生产 TLS pin、官方运行实例、真实模型质量、权限／倍率或账务验收。本轮不启用真实消费。

## 实际验收记录

首次网页登录成功后，consent 返回 `invalid_request / malformed_request`，CLI 最终超时，没有发出本次 Token。独立无凭据浏览器对照发现：相同普通 HTML form POST，在 `no-referrer` 下服务端收到字符串 `Origin: null`；在 `same-origin` 下收到正确同源 Origin。没有捕获首次失败的网关原始请求头，所以该对照准确证明的是浏览器机制。

网关将授权 HTML 改为 `Referrer-Policy: same-origin`，保留精确 Origin／CSRF 检查以及 303 callback 的 `no-referrer`，并交付镜像 `sha256:249229265a95ce4db5cace1bc0b260889246352dc5698d18fadb1b6e9fc4e003`。收到就绪通知后新建 PAR，复用网站登录 session，通过页面现有“同意授权”按钮的原生表单提交，成功跳回 `http://127.0.0.1:12615/callback`。未复用过期交易，也未改写 URI 或客户端生产开关。

| 步骤 | 实际结果 |
|---|---|
| 浏览器 consent／客户端换码 | 回环页显示返回终端；CLI 退出 0，`authenticated=true` |
| `emrank --status` | 退出 0，issuer／base／model 与交付值一致 |
| `doctor` | 退出 0，确认通过 `127.0.0.1:5186` 的自定义端点连接 |
| 当前 agent 的 `--no-cache` 查询 | 退出 0，获得四个文件片段并据此回答 |
| `emrank --logout` | 退出 0，`localCleared=true`、`remoteRevoked=true` |
| 退出后的 status | `authenticated=false`、`requiresLogin=false` |
| 网站 session 查询 `/oauth/grants` | 本次新增授权由 `revoked=false` 变为 `true` |
| 退出后重复同一查询 | 退出 1，要求登录；没有新增资源执行 |

`resource_accepted` 在新登录前为 9，登录后仍为 9，doctor 后为 10，实际查询后为 23，logout 及未登录查询后保持 23。因此 doctor 对应 1 次、agent 查询对应 13 次接受的资源请求；`grant_revoked` 是事件／错误累计，未用它推算授权数。普通工作区原生模块只读 probe 为 `protocolTestBuild=false`，隔离安装为 `true`。

未保留 Token 做退出后重放；本轮重复查询证明本地拒绝，远端撤销由 logout 回执及授权查询共同确认。网关旧 Token 拒绝、双应用、刷新与重启恢复由网关独立 HTTP smoke 覆盖，不冒称为本线程重新验证。合成模型对所有有效 noul 问题固定给 0.9，因此四个返回文件不能证明相关性质量。

首轮截图及 locator click 通道重复 15000 ms 超时，备用 CUA host 不可用；浏览器导航、DOM 读取／按钮触发及等待通道正常。本轮没有截图或录像，证据为实际页面 DOM、回环结果、CLI 输出及网关状态。已关闭本线程的诊断服务与浏览器标签，未停止网关 Docker。此轮 CLI 使用 Node 运行；结果不能解释或解除此前 Windows Bun 全门禁崩溃。

## 证据与复核

完整脱敏证据保留在本地忽略目录 `.work/docker-oauth-e2e/`，不包含密码、Token、code、state、PAR 句柄或私钥。主要入口：

| 文件（相对仓库） | SHA-256 |
|---|---|
| `.work/docker-oauth-e2e/client-browser-agent-e2e.json` | `b72b9b018f83690525dd039d2cb07892b80d026694c4db7b8b003060b95655a2` |
| `.work/docker-oauth-e2e/origin-probe-result.json` | `1b1736ad5ac676f309a744e753f3600fe5f52b57200dd901b9014a2f42af8f9d` |

JSON 包含真实命令／返回片段／agent 回答、浏览器流程、退出结果、各阶段计数、本次授权前后状态、构建标识和验收限制。安装路径与三包哈希另见 `client-install.json`。网关仓库全程只读；没有执行全仓测试、生产部署或全局安装。
