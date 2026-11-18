# 手动粘贴授权码登录

```powershell
jg emrank --login
jg emrank --login --manual
jg emrank --model
```

默认登录自动打开浏览器并接收本机回调。`--manual` 显示链接，用户打开链接、登录并同意授权后，复制网页显示的一次性授权码，回终端粘贴并按 Enter。终端隐藏输入；手动模式不打开浏览器、不监听本地端口。旧 `--no-browser` 已移除，不再作为兼容别名。

两种方式成功后都进入应用允许的模型选择。模型目录为空或用户取消选择时仍保留登录，可在网站配置模型后运行 `jg emrank --model`。登录、读取目录、选择模型不运行推理；`doctor` 和查询仍需另行确认真实消费。

登录成功的提示现在仅为 `Hello <username>`，不再自动打印会话 JSON、accountId、cacheNamespace、expiresAt 等授权信息。用户名来自本次 Token 响应的可选顶层 `username` 字段，只用于显示；原生模块剔除控制字符、双向文本控制及凭据回显等不安全值。旧响应／旧会话缺少用户名时只显示 `Hello`，不会用账户 ID 代替，也不会影响已有凭据使用。登录后的模型菜单保持；单独运行 `--model` 仅确认所选模型，不输出会话 JSON。

## 网站配置

本地地址仍为 `http://127.0.0.1:5186`；正式地址只在显式发行时由 Actions 构建配置注入。无需终端用户填写地址或凭据环境变量。

网关需实现并公告手动授权扩展，且 OAuth 应用 `emrank-jevgrep` 需显式勾选“允许手动粘贴授权码”。保留已有 `loopback:/callback` 回调，才能继续使用默认登录。

按网关当前管理规则，保存回调设置变更会停用应用并使旧授权失效。用户保存后须重新启用，再发起新登录。倍率、模型名单和启用状态由用户设置；客户端不会自动改网站配置。本轮实现授权不代表已授权修改现有应用或进行消费。

## 双方确认的协议

这是 EMRank 的手动授权响应扩展，不宣称是标准 OAuth OOB 或 Device Flow。

- PAR 仍为原九字段，手动模式固定 `redirect_uri=urn:emrank:oauth:manual`；浏览器 URL 仍只含 `client_id` 和 `request_uri`。
- metadata 的 `emrank_oauth.manual_authorization` 精确为 `{"version":"1","redirect_uri":"urn:emrank:oauth:manual","response_format":"emrank-manual-v1"}`。缺少或不支持该声明时，客户端在 PAR 前拒绝手动模式。没有新增标准 `response_modes_supported`。
- 网关注册项为 `{"kind":"manual"}`，无自定义 URI。沿用 PKCE S256、客户端证明、DPoP、本机实例 key、原 Token 端点和 nonce 规则。
- 同意或拒绝后，`POST /oauth/consent` 返回同源 HTTP 200 结果页，`Cache-Control:no-store`、`Referrer-Policy:no-referrer`，无 `Location`。
- 可复制串为 `emrank1.` 加无 padding base64url 编码的 UTF-8 JSON，JSON 恰为 `{iss,state,code}` 或 `{iss,state,error:"access_denied"}`。禁止重复键和额外字段，顺序不限。总长最多 4096 个 ASCII 字符，成功 code 为 43 个 base64url 字符。
- 客户端在原生模块验证精确 issuer、当前 pending state、字段与格式；不接受任意回调 URL、裸 Token 或其他登录事务的串。兑换仍携带同一个 redirect URI、PKCE verifier 与实例 key。
- PAR 90 秒、浏览器事务 300 秒、签发的授权码 60 秒及一次兑换限制不变。CLI 等待默认 180 秒，取消、超时、格式错误后清除该次待登录状态，不自动重试授权或延期。取消本地等待不等于服务端撤销已创建的授权。

输入不作为命令行参数，不回显，不写文件、日志、配置或缓存；Access/Refresh Token 继续只在原生模块内处理并加密保存。终端支持隐藏交互输入，也支持有上限的 stdin 行输入用于自动化。过期后须重新发起登录，不能反复兑换旧码。

## 验证范围

源码测试已覆盖默认浏览器回调和手动模式。手动模式包括成功登录与模型选择、拒绝、错误 issuer/state、重复/未知字段、code 与 error 并存、错误编码、任意 URL、输入超限、EOF、取消、客户端超时、服务端授权码过期、重复兑换和跨事务 code 绑定。

独立 Node 协议 peer 检查原生客户端的 PAR、DPoP、PKCE、密钥绑定及模型目录签名，测试不会访问生产站点或发起真实模型消费。普通发行仍在可信证明、受保护 key 和 TLS pin 未交付时拒绝两种登录方式。

部署网关互操作和最终安装结果以本轮后续交付记录为准；临时协议 peer 的结果不等同于现有 Docker 应用已启用手动授权。

## 客户端交付记录

- 本地源码 OAuth 回归：34 项通过、2 项发行专属检查跳过、0 项失败。
- 三份 tarball 的干净安装后 OAuth 回归：34 项通过、2 项跳过、0 项失败。
- 普通发行边界：4 项通过，确认默认与手动入口都在未配置信任条件时拒绝发送；验证使用 `https://release-test.invalid`，随后已恢复内置本地地址的构建。
- Rust：10 项通过、1 项旧离线互操作测试按原约定忽略。两个 TypeScript 项目的类型检查与格式检查通过。
- 真实 Windows PTY：全局 jg 的密码式输入框只显示圆点；提交合成无效串后原生模块安全拒绝，没有回显串，也没有调用模型。临时测试服务和 CLI 均已结束。
- Bun 全局 `jg` 及 `.work/docker-oauth-e2e/client` 已更新；实际加载的原生二进制 SHA-256 与构建一致，`completeManualLogin` 可用，内置 issuer 均为 `http://127.0.0.1:5186`。全局其他应用保留，`opencode-ai` 仍为 1.1.23。
- 原全局 manifest 与锁文件备份：`.work/global-before-manual-20261104/`。包固定副本：`.work/fixture-packages/win32-x64-msvc-manual-20261104/`，包含 SHA256SUMS。

安装证据：`.work/docker-oauth-e2e/manual-install-20261104.json`，SHA-256 `15daec58fdf8dd1257a70608d29d8caa34190829ca0b7a32fb91ae4185d81c22`。本次客户端验证没有对已部署网关发起登录或推理，没有修改应用设置。

## 网关最终交付与首次使用

网关已交付本地镜像 `emrank-oauth-e2e:20261104-manual`，镜像 ID 为 `sha256:dfcdbf514447df787602376a410a9435943b7a76337787b7c30eb33f4e2c38dc`。网关回报服务健康，MUI 成功／拒绝结果页、复制、60 秒到期隐藏及管理开关均已接线；仅替换 gateway，没有执行初始化、种子或迁移，也没有修改现有应用和网站配置。

本线程另外只读 GET 了当前本地 metadata，确认 manual 扩展的三个字段与约定完全相同；只读数据库确认 `emrank-jevgrep` 已启用，但 redirects 仍仅有 `loopback:/callback`。未发起现网 PAR、Token、目录或推理请求。

首次使用步骤：

1. 打开 `http://127.0.0.1:5186/oauth`，编辑 `myjevgrep`／`emrank-jevgrep`。
2. 保留 `loopback:/callback` 及原倍率、模型名单、profile、resource，勾选“允许手动粘贴授权码”，保存。
3. 保存安全注册会停用应用、使旧授权和凭据失效；再次启用该应用。
4. 执行 `jg emrank --login --manual`，打开链接并同意授权，60 秒内将完整一次性授权码粘贴回终端。

网关独立验证回执为 10 项协议／冻结 wire、12 项 runtime fixture、2 项注册、5 组拦截式浏览器检查与 7 项部署后只读 HTTP 检查通过。其文档为 `E:/RUST_WORKSPACE/embedding-reranker-next/docs/oauth-manual-login-2026-11-04.md`，SHA-256 `35755999a1f3ab1eab080472cc3e53ae3d4d45599be891edc8b3787ae54648c0`。

网关本轮没有提供独立 HTTP peer。因此客户端 native 与实际网关的 manual 成功互通仍未验收：上述测试不能替代这一项，也不会为补齐验收而修改用户应用注册。用户完成配置后才能进行真实手动登录验证；真实模型消费仍不在本轮范围内。

## 后续登录问候更新

按用户要求，普通／手动登录后的会话 JSON 已移除，改为 `Hello <username>`。登录选模型完成后也不额外打印会话或模型确认行；显式 `--model` 只打印模型确认。新字段为成功 Token 响应中的可选顶层 `username:string`，来自当前账户 username，既不使用 display_name，也不替换用于安全绑定的 account_id。没有字段或存在不安全展示值时回退 `Hello`，不阻断登录。

此更新的源码和 tarball 干净安装回归均为 35 项通过、2 项发行专属分支跳过、0 项失败；覆盖两种登录无会话输出、用户名缺失、ANSI／双向控制／超长文本／Token 回显，以及刷新后的用户名变化和稳定 account_id。Rust 为 10 项通过、1 项旧离线测试忽略，类型检查通过。Bun 全局及隔离安装均已更新，包固定副本为 `.work/fixture-packages/win32-x64-msvc-greeting-20261104/`；安装证据为 `.work/docker-oauth-e2e/greeting-install-20261104.json`，SHA-256 `4a84b6cfbe7ddec82440c49f6c37c0d50658fc33a1fc96d5c877e1e15fe72aa0`。

网关已同步更新本地镜像 `emrank-oauth-e2e:20261104-username`，image ID 为 `sha256:f15fd5825de4ae940bcb573037a37bea0025b594d85072a4f08cfa472b6cc453`。其回执为 14 项 fixture 测试及 4 项只读部署检查通过，没有修改应用配置。说明位于 `E:/RUST_WORKSPACE/embedding-reranker-next/docs/oauth-token-username-2026-11-04.md`，SHA-256 `5cbf49a147a0252249facd5d7ba74922456f71ace0ff9e79ac31d85215ff9c82`，已核对。两侧均未为本次显示变更发起现网登录或模型请求，不能将临时 peer 检查写成实际用户登录显示已验收。
