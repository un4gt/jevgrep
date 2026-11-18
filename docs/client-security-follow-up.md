# 客户端协同实施记录

2026-10-31，依据网关 `docs/oauth-jg-client-follow-up.md`、`docs/oauth-implementation-plan.md` 和 `docs/oauth-research-2026-10-31.md`。用户明确本轮先完成不依赖可信证明服务、信任根、TLS 固定值和请求签名 profile 的部分。网关仓库保持只读；本文不表示网关已实现或真实安全链已验收。

收尾时只读复查发现网关已新增 [通用 OAuth 接入契约 v1](../../embedding-reranker-next/docs/oauth-contract-v1.md) 和 [实施记录](../../embedding-reranker-next/docs/oauth-progress-2026-10-31.md)。前者给出了 `attested-dpop-v1`、强制 PAR 和正文签名子集的实现基线，同时明确真实证明链尚未上线、pin 轮换未验收。这是下一轮协商的具体输入；本轮按用户决定不接入这些扩展，也不把基础 fixture 当作与该 profile 兼容。

后续协商状态：已收到并核对 [网关协商回执](../../embedding-reranker-next/docs/oauth-negotiation-2026-10-31.md)，客户端确认其中协议规则及分工，详见末节。协议已确认，相关客户端接线和真实证明／pin／在线环境仍未完成；本次确认不启动开发、测试或部署。

## 本轮实现

| 事项 | 当前实现与边界 |
|---|---|
| J0 契约同步 | 更新公共注册数据、强认证/PAR 的不支持错误、服务端每应用倍率及消费 RPM 豁免边界；不自定尚未冻结的协议字段 |
| J2 原生请求 | JS 不再取得 Authorization/DPoP；Rust 接收 state 和相关性问题，限制能力、选择会话中的模型/地址、最终序列化、发送及过滤响应 |
| J2 取消与重试 | 一次性操作句柄，最长 60 秒总时限；AbortSignal 可取消真实 HTTP，最多一次 RS Nonce 重试，重用业务字节并更新 jti |
| J3 已确定的传输要求 | 发现/Token/撤销/资源统一 reqwest/rustls、公共根、链与域名验证、无重定向/环境代理；HTTP 仅在专用测试构建开放回环 |
| J4 登录与刷新 | 拒绝重复回调参数、code/error 并存及错误 issuer；拒绝相同 Refresh Token；保留跨进程锁、账户绑定及 Provider 选择 |
| J4 状态与退出 | 普通资源失败不改 Provider；本地 status 不代表远端有效；离线退出清除本地并提示远端撤销未确认；撤销 Nonce 由原生处理 |
| J5 回归与打包 | 新用例进入已有 verify/双平台同步工作流；协议测试包与普通发行包分开，测试包标为 private 且禁止发布 |

普通 OAuth 基础协议继续用于协议 fixture。metadata 要求强制 PAR 或仅声明当前不支持的客户端认证方法时，在进入浏览器前失败，不静默改成直接 GET 或无证明换码。当前客户端没有实现新安全 profile，不能据此宣称已满足网关“仅可信官方客户端享 OAuth 待遇”的要求。

## 原生 API 与限制

`beginEvaluation(namespace, {stateJson, questions}, timeoutMs?)` 返回一次性本地操作句柄；`completeEvaluation(handle)` 返回校验重建后的业务响应；`cancelEvaluation(handle)` 取消操作。namespace 只是会话一致性检查，不是秘密或进程身份证明。

原生输入不包含目标 URL、method、model、任意头或通用签名内容。只支持 jg 实际使用的结构化 state 和 `noul` 相关性评估；问题类型、ID、数量、文本大小、最终请求字节以及响应大小均有界。原生冻结输入后，JS 修改原对象不会改变发送字节。

成功响应仅返回对应问题的数值结果、受限用量和本地已选模型；未知字符串及响应头不能携带凭证回到 JS。普通 401/403、429、5xx 保留状态，错误正文换成固定说明；只有合法 Retry-After 可传回。这里的校验不是独立响应签名。

原生操作最多同时保留 64 个句柄，总超时包含准备/刷新、Nonce 重试及读取正文。取消不能撤回服务端已经执行的推理；服务端仍须保证挑战不执行业务、不扣费。为避免旋转后丢失新凭据，已发出的刷新会完成落盘，但取消后的操作不再发推理。上游原有网络/业务重试未被改写，不承诺跨请求计费幂等已由客户端独立解决。

## 测试构建与发行隔离

正常 `bun run build` 不启用 Cargo feature；`EMRANK_ALLOW_HTTP_LOOPBACK=1` 无法让普通二进制发送 HTTP。独立协议验证使用：

```powershell
bun scripts/build/cli.ts --fixture
$env:EMRANK_TEST_EXPECT_FIXTURE = 'true'
bun test --timeout 60000 tests
bun scripts/release/pack.ts --fixture
Remove-Item Env:EMRANK_TEST_EXPECT_FIXTURE
bun run build
```

完整 `bun run verify` 自动执行普通包边界检查→测试构建/协议回归→测试 tarball 全新安装→恢复普通构建→普通 tarball 安装与 HTTP 拒绝检查。测试 tarball 只保存在 `.work/fixture-packages/<platform>`；`artifacts/` 只放普通构建。打包器检查实际原生 build 标记，发布器拒绝 private/测试包。

全新安装使用 CLI、loader 和当前平台的真实 tarball。为避免尚未发布的另一个平台可选包拖延安装，仅在临时安装目录为 `@emrank` 配置回环 registry，明确返回该可选包不存在；其他依赖仍正常解析，任何应来自 tarball 的包转向 registry 都会使验证失败。该 fixture 不代表 npm 注册表发布已验收。

协议 fixture、测试二进制及测试 tarball 不能作为生产证明链、正式 TLS pin 轮换或真实浏览器授权的证据。普通发行包的真实 HTTPS OAuth 登录需后续共同测试环境，不能将测试构建的 HTTP 成功记为正式网关联调成功。

## 本轮验证结果

| 验证 | 实际结果 |
|---|---|
| Windows 本仓库测试 | 39 项通过、1 项按构建模式跳过，254 个断言；Rust 单元测试 3 项通过 |
| Windows 测试 tarball | 全新安装后同样 39 项通过、254 个断言；结束后恢复普通构建 |
| Windows 普通 tarball | 命令与拒绝 HTTP 两项通过，10 个断言；构建标记为非测试模式 |
| Linux 完整 act | `release-full-linux` 成功；上传的报告中 35 个阶段全部通过，包含上游回归、parser、OAuth/keyring、两种 tarball 安装和恢复普通构建 |
| 跨平台发布前检查 | 四个普通发行归档通过 `publish --check`，共享 CLI/loader 解包内容一致；测试包被明确拒绝，无实际发布 |
| Windows 完整门禁 | 未通过：Bun 1.4.2 在未修改的上游 Evaluator 用例原生崩溃；没有跳过该门禁，双平台发布要求不变 |

Linux 首次运行在安装阶段查询尚未发布的另一个平台可选包，超过阶段时限；修正临时 registry fixture 后完整复跑成功。日志同时保留失败与成功记录。最终 Linux 快照与当前 49 个源码/构建/测试相关文件逐字节核对一致；其后的文档补充不改变受测实现。

本地机器可查看 [本轮验证摘要](../reports/client-follow-up-validation.json)、[Linux 阶段报告](../reports/actions-linux-verification.json) 和 [Windows 崩溃日志](../.work/verify-client-follow-up-windows.log)。报告及产物是忽略文件；本文保留可随源码审阅的结论。完整 Linux 日志为 `.work/verify-client-follow-up-linux-final.log`，实际上传 ZIP 位于 `.work/act-ANdPUX/artifacts/1/compatibility-ubuntu-24.04/`。本轮没有执行真实网关/模型请求、远端 PR、推送或发布。

## 后续共同定稿事项

下表保留发起协商时的清单；协议规则与外部依赖的最新状态以末节确认记录为准。

| 依赖 | 需要网关/客户端共同确认的内容 |
|---|---|
| J1 可信实例身份 | Windows/Linux 可用的 attester、证明对象/威胁模型、信任根、实例和 DPoP 密钥的不可替换绑定、生命周期与真实平台证据 |
| 新认证与 PAR | 固定的规范版本、metadata/认证方法、证明获取/更新/撤销、request_uri 生命周期、错误和状态语义、互操作向量 |
| TLS 固定 | 可信配置来源、当前/备用 SPKI、正常链/域名验证、证书切换、失效及可信更新流程；不通过环境变量输入任意信任根 |
| 请求完整性 | HTTP Message Signatures + Content-Digest 的最终组件、字节/编码/重复字段规则、时间窗和密钥绑定；双方共享正反测试向量 |
| 真实验收 | 双平台受测执行环境、代理/篡改/复制/撤销攻击、第二个注册应用、完整浏览器登录、真实权限/倍率/账务 |

普通软件密钥、DPAPI/keyring、受限 N-API 或隐藏 Token 都不能证明 Node 代码未修改，也不能阻止有本机权限的其他脚本调用官方原生模块。当前原生用例本身由独立 Node 脚本调用该模块完成评估；这是功能与边界证据，不是“拒绝模拟客户端”的通过证据。

不使用自签 attestation、内置共享私钥、进程名/路径/包哈希字符串来替代证明；不单方面增加应用层加密协议。J1、SPKI 固定与内容签名接线留待后续实施，其中真实证明和 pin 仍需外部条件。

## 2026-10-31 协商提案与回执

用户已授权与网关线程直接协商。以下保留首次发送的六项客户端提案；网关已完成逐项回执，客户端的一次核对结论见下方“客户端确认”。协商不触发代码接入或生产配置变更。

| 议题 | 客户端提案 | 需要网关回执 |
|---|---|---|
| 版本与发现 | 以 `attested-dpop-v1` 作为待共同确认的实现基线 | 固定认证草案版本、完整 metadata、扩展字段和升级规则 |
| PAR 与失败语义 | 强制 PAR；Nonce 最多重试一次；按已确认错误处理，不统一刷新/重登 | 请求/响应/浏览器跳转示例、90 秒生命周期、状态码与机器错误码矩阵 |
| 最终字节签名 | 采纳现有 `sig1` 组件顺序、digest、jkt/jti 绑定和 60 秒窗口 | 确认 P1363 编码、URI/Structured Fields/时间规则，以及正反向量的固定版本与哈希 |
| 可信证明 | 先验证真实 attester 与双平台运行环境的可行性 | 候选服务、证明对象、挑战/证据接口、密钥绑定、生命周期及具体实验分工 |
| TLS 固定 | 保留正常 TLS 校验，使用可信来源的主/备用 SPKI 与更新策略 | 同源拓扑、配置提供方、轮换/回滚方案和实际就绪条件；不填写假 pin |
| 推进顺序 | 可先做离线协议互操作；真实证明链与生产准入门槛保留 | 协议包、向量、隔离 HTTPS 环境、第二应用及公开联调配置的交付方和条件 |

客户端只读核对的现有 `tests/fixtures/generate.mjs` 已使用 `ieee-p1363`；请求正文向量 SHA-256 为 `93e91907eb4962a25888986b6dbbed9251daf204c9a74e63d3205e05dfad9ae1`，对应网关 `crates/emrank-oauth/tests/fixtures/node-profile-v1.json` 的当前文件字节。它是协议互操作证据，不是实际平台证明。源文档 `oauth-contract-v1.md` 本次发送时的 SHA-256 为 `f631ffd9429b3ad8b89d76f905e708a1b9c2423f4c798a5161073a2b0df6dbcc`；后续修订应明确新版本。

客户端负责原生接线、取消/刷新/凭据语义和双平台验证；网关负责验证端、发现/错误契约、授权与计费准入；证明服务和 TLS 配置由具备相应部署权限的一方交付。若真实证明要求受管环境、缩减平台或改变桌面产品部署方式，先提出具体方案与代价，留给用户决定，不由协议协商默认批准。

### 客户端确认

状态：**协议规则与分工已确认；实现、真实证明及部署配置未验收**。确认对象是 [oauth-negotiation-2026-10-31.md](../../embedding-reranker-next/docs/oauth-negotiation-2026-10-31.md)，原始文件 SHA-256 为 `d3e5e0d9c96be7ccece89bd69c83fc86af84c3e462cc837c0114e2ac5a2dd1ad`。该回执与本确认共同构成后续实施基线；原 `oauth-contract-v1.md` 的历史内容不因此被冒称为已经完成接线。

本次只读核对回执、现有签名／DPoP／attestation 校验代码及输入向量版本，**没有发现阻断后续互操作的协议异议**。接受第 1–3 节的新增精确规则；接受第 4–6 节的职责、实验边界和就绪条件，但不把候选 attester API、evidence 格式或 pin 配置签名格式升级为已冻结、可用的实现。

| 事项 | 客户端确认 |
|---|---|
| 认证与版本 | 固定 `attested-dpop-v1`、`attest_jwt_client_auth_dpop`、认证草案 `draft-ietf-oauth-attestation-based-client-auth-12` 及 commit `3cf806abbc6b0aebc0f90430b5a89a3c70518567`。`emrank_oauth`、policy claim、错误扩展按回执显式识别；未知安全版本在浏览器前拒绝，不降级 |
| combined mode | 同一受保护实例 key 绑定 attestation 和标准 DPoP；恰有一个裸 JWT Token Item 的 Attestation 头和一个 DPoP 头；禁止额外 Attestation-PoP；PAR 的 dpop_jkt 只用于一致性校验，不替代 proof |
| PAR／取消 | 九字段 form、201 响应、90 秒首次兑换、单条最长 300 秒浏览器事务及 60 秒 code；浏览器只带 client_id/request_uri；本地取消不等于服务端撤销 |
| 错误与重试 | 接受回执错误矩阵及允许列表；普通 401/403、证明过期、网络失败不触发通用自动刷新／重登。仅合法 nonce 挑战自动重试一次，维持原时限和取消；挑战无业务、授权消费或计费副作用 |
| 正文签名 | 固定 sig1 及组件／参数顺序；64 字节 P1363 r||s；HTTP Signature/digest 使用标准带 padding Base64，JWS 使用无 padding base64url；LF 签名 base 无末尾 LF。按固定外部 URL 和最终业务字节签名，nonce 重试更新 proof/jti/正文签名 |
| 时间 | 接受回执的整秒不等式：DPoP iat／正文 created 至多未来 5 秒、过去 60 秒；正文窗口最长 60 秒、attestation 最长 300 秒；到 expires/exp 即失效，不追加宽限 |
| 证明与 TLS | 接受 Windows VBS Enclave 与 Linux TPM2/Keylime/IMA 作为待授权实验路线；必须覆盖独立脚本借用入口。issuer/resource 保持同源，正常证书链／域名校验与真实主／备用 SPKI 同时成立；异源 attester 单独固定 origin、端点及信任策略 |

后续交付顺序与未完成项：

1. 网关提供带固定时钟和预期错误的独立静态负向 wire 包，并补齐 combined-mode 额外 PoP 头的拒绝检查；现有 Rust 反例定义不替代该跨语言交付包。
2. 在后续获准实施轮次，客户端接 PAR、正文签名和 Rust 内受控错误解析；双方只做新增及受影响模块的定向互操作。本次没有启动该轮开发或测试。
3. 经资源授权后并行进行证明与 pin 实验。候选 attester 的挑战 transcript、平台 evidence schema、真实签发方／信任根、pin 及可信配置包仍待交付／确认；受管设备或平台版本收窄、BFF／受控服务变化、云租户／硬件和 TLS 终止／信任配置变化由用户或有权限方决定。
4. 网关／运维交付真实隔离 HTTPS issuer/base、注册 client_id、精确模型 ID、第二应用及可打开的授权管理页。`.example.test`、`client-alpha/client-beta`、`test/model` 继续仅作 fixture，不以生产站点代替测试环境。

真实 profile ready、发放真实 OAuth 凭据／待遇及阶段 1 的证明门槛保持。Windows 全门禁的既有 Bun 崩溃仍未解决；本次文档确认没有改变任何测试结论。凭据及敏感设备证据另走安全渠道。

## 2026-11-01 协议实施与直接互操作

用户在双方确认后明确授权进入开发／测试／部署阶段；已通知网关线程同步实施。本节更新此前“等待实施轮次”的状态，不改写历史回执或旧测试结果。客户端只写 jg；网关仓库保持只读。

客户端新增 `profile.rs`、`integrity.rs`、`protocol.rs`，并接入现有 OAuth／资源模块：

- 严格检查 profile、1.0 契约、认证草案 -12、认证方法、PAR、资源与签名／错误版本；未知安全字段或不匹配在浏览器前失败。
- 原生发送九字段 PAR，检查 201／90 秒／opaque URN，浏览器仅带 client_id 和 request_uri。PAR、token、revoke 使用 combined Attestation＋标准 DPoP，不发送额外 PoP；AS 只接受合法 400 nonce 挑战并最多重试一次，保持原表单及截止时间。
- Rust 冻结 System One JSON 字节后使用同 key 生成 Content-Digest、sig1 和 64 字节 P1363 签名。资源 nonce 重试保留字节，更新 proof/jti/正文签名；JS 没有凭据或通用签名接口。
- 原生允许列表处理 error/reason；RS 401/403 还须与唯一 WWW-Authenticate 一致。证明过期不重发当前业务，后续操作才能同 key 更新证明；撤销／非法实例／应用停用停止调用，用户撤销清除秘密保留 Provider。普通 401/403 和未知错误不清会话、不自动刷新／重登，不透传远端描述。
- 普通构建及恢复的旧会话在所有 OAuth 发送入口失败关闭：真实 attester、受保护实例 key、TLS pin 尚未配置，不能靠存储字段或环境开关放行。`test-http-loopback` 构建只允许显式启用的 127.0.0.1 HTTP fixture；其合成证明签发路由、公开测试根与软件 key 均不构成生产证明。

网关已完成额外 Attestation-PoP 拒绝、离线组合验证、metadata／错误契约和 PAR 内存事务约束，交付 [wire-v1 包](../../embedding-reranker-next/tests/oauth/wire-v1/README.md)。manifest SHA-256 为 `86e78d3bd50f9c53975874a5e4cb4b66d8e3b152c93e521535cfbe6c997870b6`。客户端只读核验全部包文件哈希，执行网关现成离线程序核对 **80 个场景、85 次请求** 均符合 expected。未运行生成器、未改变固定包。

另用 [Rust 测试适配器](../native/src/interop.rs) 调用实际原生 serializer／DPoP encoder／HTTP signer／PAR serializer，在固定 HTTPS 目标和测试时钟下生成最终 wire，逐行交给网关程序。两个注册应用共 **10 次实际生成请求**：各完成资源 401 nonce → 同体新 proof／签名 204 → 原样重放 401 `dpop_replayed`；PAR 400 nonce → 同表单新 proof 201、expires_in=90。挑战与重放没有 fixture effect。没有改写回环 URL，也没有通过 JS 导出签名能力。

直接互操作记录：[client-gateway-native-wire.json](../reports/client-gateway-native-wire.json)，SHA-256 `c1fc056a2b16cf14841e122b1e0c48195eabaa30d72415c8667dde7011885b0b`；使用网关 exe SHA-256 `c20187c3a2ce87e4cc7014ede11ba1d88f7a8518a354cfd045f4770152ce2e8f`。记录仅含公开合成测试材料，已回传网关留档。该显式测试平时标为 ignored，因为依赖外部交付的可执行程序；本轮已单独执行通过，不以默认跳过替代验证。固定旧正向 `93e91907…` 另外保存在 `native/fixtures/node-profile-v1.json`，普通 Rust 单测核对规范签名 base、digest 与 P1363 验签。

可复现直接检查（仅在 Rust 测试进程中选固定时钟，不提供运行时环境绕过）：

```powershell
$env:EMRANK_OFFLINE_GATEWAY = 'E:/RUST_WORKSPACE/embedding-reranker-next/target/debug/examples/offline_gateway.exe'
$env:EMRANK_WIRE_PACKAGE = 'E:/RUST_WORKSPACE/embedding-reranker-next/tests/oauth/wire-v1'
$env:EMRANK_INTEROP_REPORT = 'E:/RUST_WORKSPACE/jg/reports/client-gateway-native-wire.json'
cargo test --locked --manifest-path native/Cargo.toml --lib actual_native_wire_against_gateway -- --ignored
```

再次执行会生成新的随机 jti／nonce／PAR handle，因此生成新报告，不能要求其文件哈希等于本轮记录。静态 wire 包则必须保持原哈希。

部署边界没有撤销：网关离线 204 只表示密码与完整性接受，201 只创建内存 PAR；其 token/revoke 仍返回 503。真实 attester／受保护 key／pin、隔离 HTTPS 注册与模型参数、共享 replay、持久化授权／刷新／撤销、权限／账务／UI 尚未交付。未连接生产或发放真实 OAuth Token／待遇，未部署生产。现有 Windows 完整上游门禁的 Bun 原生崩溃仍保留，定向验证不能覆盖它。

### 本轮最终验证与产物

| 检查 | 本轮结果 |
|---|---|
| Rust 原生单测 | Windows／Linux 各 7 项通过；外部网关互操作测试默认单独列为 ignored，已在 Windows 显式执行 1 项通过 |
| 源码定向 OAuth 回归 | Windows／Linux 各 24 项、374 个断言通过 |
| 实际测试 tarball 全新安装 | 两平台各 26 项通过、1 项按构建模式跳过、381 个断言；跳过的普通包 HTTP 边界在下一行独立执行 |
| 实际普通 tarball 全新安装 | 两平台各 3 项、13 个断言通过；HTTP 开关不能降级，未配置 HTTPS profile 在联网前拒绝 |
| 质量检查 | Rust fmt、Clippy all-targets/all-features `-D warnings`、TypeScript、git diff 检查通过 |
| 跨平台一致性 | 36 个源码／构建／协议测试文件哈希一致；四种普通发行归档通过 `publish --check`，共享 CLI／loader 解包内容一致；测试包发布被拒绝 |

Linux 使用独立 `emrank-jg-act:local` Ubuntu 24.04 容器，补齐与 Compatibility CI 相同的 Rust／D-Bus／Secret Service 依赖；本轮运行定向命令，没有重跑完整 act 或上游门禁。最终日志 `.work/profile-linux-final.log`。Windows 包日志为 `.work/profile-windows-fixture-install.log` 与 `.work/profile-windows-production-install.log`。第一次 Windows 直接执行曾误用已安装的旧普通 native，重建 CLI fixture 后纠正；最终以全新 tarball 安装的上述结果为准。Linux 环境准备时发现工具链／系统依赖缺失，补齐后重新执行成功，不把准备失败记作测试通过。

普通产物位于 `artifacts/`（Windows）及 `artifacts/linux/`（Linux），附平台 SHA256SUMS；工作区 native 已恢复普通构建。结构化摘要为 [client-profile-validation.json](../reports/client-profile-validation.json)，源码快照哈希为 [client-profile-source-sha256.json](../reports/client-profile-source-sha256.json)。这些忽略文件供本地交接，不替代本节可随源码审阅的结论。未提交、推送、注册表发布或生产部署；无远端地址、真实联调配置及完整发行门禁通过证据时，不把可安装产物称为已发布服务。
