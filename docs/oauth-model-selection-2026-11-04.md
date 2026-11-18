# 登录后选择模型与构建地址

这是 2026-11-04 的流程记录。本文中的本地端口和构建变量属于当时的安装；现在本地测试包运行时读取 `EMRANK_ISSUER`，正式包由 Actions 在构建时读取同名 Repository Variable。当前命令见[仓库说明](../README.md)。

## 用户操作

```powershell
jg emrank --login
# 浏览器登录、同意授权后，回到终端用方向键选择模型并按 Enter
jg emrank --status
jg emrank --model
```

`--model` 可在之后更换模型，不要求重新授权。菜单展示应用允许且当前全局可用的 `decision` 模型。选定值与会话一起由原生模块加密保存，修改模型会更换缓存命名空间。

用户取消模型选择或没有可用模型时，授权仍保留，`--status` 显示 `requiresModelSelection=true`；推理命令要求先选模型，不自动使用其他 Provider。空名单提示管理员到网站为 OAuth 应用配置模型。自动化可用 `--login --manual --model <exact-id>` 或 `--model <exact-id>`，仍须通过原生目录校验，不能指定名单外模型。

登录和读取模型目录不发送推理，不扣费。`doctor` 和实际查询会调用模型，仍须获得实际消费授权。本轮没有调用现有 Docker 的真实模型。

## 本地与发行

- `bun run build`：默认本地专用构建，内置 `http://127.0.0.1:5186`，使用合成证明。构建时若需更换本机端口，使用 `EMRANK_LOCAL_ISSUER`；该模式忽略线上 `EMRANK_ISSUER`。
- `bun run build --release`：显式普通发行构建，从构建环境 `EMRANK_ISSUER` 固化地址。GitHub Actions 映射仓库变量 `vars.EMRANK_ISSUER`，线上取值为 `https://emrank.tech`。
- 运行时 `EMRANK_ISSUER`、旧 `emrank-login.json` 不再决定终端用户的登录网站；模型也不再是 OAuth 登录前置条件。
- 自动化临时端口使用仅本地测试构建识别的 `EMRANK_TEST_ISSUER`；正式发行包忽略它。旧会话与当前内置网站不匹配时拒绝发送。
- 本地检查发行边界时仅使用保留域名 `https://release-test.invalid`，不访问正式网站。普通发行包仍不开放尚未交付的真实证明／受保护 key／pin；本地专用包不能发布到注册表。
- 修改 Actions 中的构建 issuer 会改变测试缓存键，避免复用另一个发行地址的成功记录。

## 与网关的一致约定

客户端在登录后以原生 Token、实例 key、Attestation 和 DPoP 发送 `GET {resource}/models`，实际正文为零字节；同时签名 `GET`、实际 URI、Content-Type、空正文 SHA-256 与 DPoP，使用 P1363。Resource nonce 最多重试一次，并生成新的 proof、jti 和签名。认证信息不进入 JS，错误正文不直接透传。

metadata 必须同时登记 `POST /v1/systemone` 和 `GET /v1/models`，scope 均为 `inference:systemone`。目录返回全局可用与应用 `allowed_models` 的交集；客户端只展示 `kind=decision`。实际提交选择时再次取目录校验，服务端对推理请求继续强制执行名单。模型删除或移出名单的 403／404 会提示重新选择，不误当 Token 失效。

网关负责应用管理页面的模型多选和后端名单约束。其候选目录复用全局 `/v1/models` 的生成逻辑，通过管理员接口 `/api/oauth/models` 提供；空 `allowed_models=[]` 表示全部拒绝。

## 验证记录

- 客户端／相关回归：48 项通过、2 项发行专属分支在本地构建中跳过。
- 普通发行边界（保留域名、无线上请求）：4 项通过，随后恢复本地构建。
- Rust：9 项通过，1 项旧离线网关互操作测试保持显式忽略（包括新增的并发回调端口检查）。
- 实际 PTY：临时独立协议服务完成授权后显示两项 decision 模型；方向键选择第二项，随后新进程 status 确认保存，再 logout。未运行推理。
- 类型检查、修改文件 lint、actionlint 及 diff 空白检查通过。

以上协议／菜单测试使用临时回环服务，不代表已经对更新后的现有 Docker 完成真实账户或消费验收。

## 安装交付与网关就绪

- `bun scripts/release/pack.ts --fixture --oauth-only` 最终通过：实际 tarball 干净安装后 29 项通过、2 项发行专属检查跳过、0 项失败；三份包的 SHA-256 已生成并逐项复核。
- Bun 全局入口 `C:/Users/MT308/.bun/bin/jg.exe` 和 `.work/docker-oauth-e2e/client` 均已更新为这次本地专用包；实际加载模块确认 `protocolTestBuild=true`、`configuredIssuer=http://127.0.0.1:5186`，模型目录与选择 API 可用，原生二进制哈希与构建产物相同。原有全局 `opencode-ai@1.1.23` 保留。
- 全局 `jg --help` 已列出登录／状态／退出／模型命令；两个安装入口的 `emrank --status` 都显示本地 issuer 和未登录状态。这些检查不访问网关。
- 隔离包装器继续使用独立凭据／配置／缓存；允许用户执行登录、选模型和退出，不再把预填模型作为登录条件。`doctor`／查询仍受其真实消费确认限制。
- 网关已通知镜像 `emrank-oauth-e2e:20261104-models` 健康、账户迁移为 12，当前全局可用模型数为 0、应用白名单为空。此时登录成功后应提示没有可用模型，并保留会话；用户在网站添加模型并为应用选入名单后，再执行 `jg emrank --model`。
- 本线程仅记录网关就绪，没有自行向当前 Docker 发起登录、目录或推理请求，没有修改网站配置。真实消费验收仍未执行。

安装核对证据：`.work/docker-oauth-e2e/model-selection-install-20261104.json`；包与校验文件：`.work/fixture-packages/win32-x64-msvc/`。旧全局 manifest／锁文件已备份到 `.work/global-before-model-menu-20261104/`。

安装验证期间两次出现 Node Fetch `bad port`：一次位于授权重定向，一次位于临时授权服务的初始请求。本机 TCP 动态端口范围实查为 `1024–15000`，包含浏览器／Fetch 禁用端口；旧回调和测试服务均使用端口 0。现将两处改为在 `49152–65535` 内有限重试、直接绑定可用端口，避免探测后重新绑定的竞争。完成修复后整套安装检查通过；该错误与此前 Bun 原生崩溃不是同一问题。

## 首次实际登录发现的应用注册缺口

用户随后执行 `jg emrank --login`，在打开浏览器之前遇到 `fixture attester rejected request`。只读查询本地账户库确认：唯一未删除应用的 `client_id` 是 `release-desc`，没有客户端固定使用的 `emrank-jevgrep`。其余本地 profile／resource／callback 均符合约定；模型名单为空不导致本次拒绝。

用临时公钥对本地证明接口发起一次请求，确认 `client_id=emrank-jevgrep` 返回 HTTP 400、`invalid_request`／`malformed_request`。该检查没有创建 PAR、授权或 Token，也没有发起模型目录或推理请求。网关 `Core::attest` 在未知 client_id 时确实返回此错误。

此前“安装入口就绪”和“存在一个启用应用”不足以证明该应用就是 jg 的注册记录。已向网关线程集中反馈，建议保留用户现有 `release-desc`，单独核对 jg 注册，不自动复用另一应用的倍率／权限，也不要求终端用户设置环境变量。网站应用修改仍需遵守用户授权。

客户端对应错误现包含 HTTP 状态、准确 client_id、本地 `/oauth` 配置入口及所需 profile／resource，不透传证明服务响应正文。它提示管理员检查配置，而不把所有证明服务错误武断归为未注册。

本次更新的 tarball 安装检查为 30 项通过、2 项发行专属检查跳过、0 项失败；更新后的 Bun 全局安装又通过“未知应用明确提示、零 PAR／Token／推理”的定向回归。全局和隔离安装均确认原生二进制与本次构建哈希一致，内置地址仍是 `http://127.0.0.1:5186`。本次包固定副本位于 `.work/fixture-packages/win32-x64-msvc-registration-hint-20261104/`，核对证据位于 `.work/docker-oauth-e2e/client-registration-diagnosis-20261104.json`；此前安装记录保留为历史快照。

网关回执确认相同根因及配置方案。独立 jg 应用使用空模型名单、`loopback:/callback` 和原 scope；OAuth 倍率不从其他应用复制，新增／启用及倍率等待用户确认。本轮不改网站应用，未验收真实浏览器登录或模型消费。
