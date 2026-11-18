# EMRank jevgrep Overlay

按 [refrence/jg.md](refrence/jg.md) 维护的 jevgrep 定制发行版。上游源码只在忽略的 `.work/upstream` 中检出，当前固定正式版 `v0.8.5` / `2d9bce074f9c5f4423e2e33e146fddb5fe117d2d`。自定义内容是三个 Git Patch、TypeScript 调用胶水和 Rust N-API 模块。没有修改网关仓库。

本地测试只需在 PowerShell 设置网站根地址，再运行普通登录命令。改端口不需要重建或重装：

```powershell
$env:EMRANK_ISSUER = 'http://127.0.0.1:5816'
jg emrank --login
```

正式发行由 GitHub Actions 在构建时读取 Repository Variable `EMRANK_ISSUER`（`https://emrank.tech`）；发行包不读取用户终端里的同名变量。浏览器授权地址从该站点的 OAuth metadata 获取，不单独配置 `/login`。

## 本地构建

需要 Git、Bun 1.4.2、Node.js 22.20+、Rust stable；Windows 需要 MSVC 构建工具。当前 Linux 预编译包基于 Ubuntu 24.04，要求 glibc 2.39+、`libdbus-1.so.3` 和 Secret Service（开发包 `libdbus-1-dev`、运行时 `gnome-keyring` / 同类服务）；未声称支持更旧的 glibc。

```powershell
bun install --frozen-lockfile
bun run prepare:upstream
bun run build
bun run verify
node .work/upstream/apps/cli/dist/bin/index.js --help
```

`prepare:upstream` 在本地检出锁定的稳定版本后应用三个补丁。`bun run build` 生成支持本机 HTTP 网关的测试包；`--unregistered` 用于无发行秘密的兼容性检查，不能登录。`--a` 只用于[独立 HTTPS 验收环境](docs/kiri-a-cli.md)。正式发行用 `--release`，用户安装后无需配置网站或 CA。原版 API Key 可继续使用。

## 开发脚本

日常操作使用 `package.json` 中的 `bun run` 命令。脚本按职责放置，共享的仓库路径与进程工具集中在 `scripts/common.ts`：

| 目录 | 职责 | 常用入口 |
|---|---|---|
| `scripts/build/` | Rust 原生模块与 CLI 构建 | `bun run build` |
| `scripts/upstream/` | 本地稳定版检测、更新锁定版本和补丁检出 | `bun run check:upstream`、`bun run sync:upstream`、`bun run prepare:upstream` |
| `scripts/release/` | 打包、安装验证和审批后的发布 | `bun run pack`；发布由工作流调用 |
| `scripts/verify/` | 完整回归与 Linux keyring 环境 | `bun run verify` |
| `tests/actions/` | act 启动器、发版流程场景与测试镜像 | `bun run test:actions` |

## 使用方式

```powershell
# 原版功能
jg auth
jg doctor
jg files . --list
jg "Where is authentication implemented?" .

# 直接登录内置网站，浏览器授权后从菜单选择应用允许的模型
jg emrank --login
jg emrank --status
# 之后可重新选择模型，不必重新登录
jg emrank --model
# doctor 和查询会调用模型，确认消费授权后再执行
jg doctor
jg "Where is authentication implemented?" .
jg emrank --logout
```

每次 `jg "问题" [目录]` 搜索默认最多同时发出 **4** 个模型请求，EMRank 和原版 Provider 共用这个默认值。可用 `--concurrency N` 为单次搜索指定其他正整数。

原生发行包使用 `native-build-dpop-v1`：浏览器或 `jg emrank --login --manual` 授权后，Rust 绑定安装密钥与本次发行挑战。发行激活提高批量仿用成本，不证明加载模块的是官方进程。正式上线以固定线上 issuer 的同一批安装包另行验收为准。

登录前不要求模型。授权成功后，原生模块通过认证的 `GET /v1/models` 获取“全局当前可用 ∩ OAuth 应用允许”的模型；终端只展示 `kind=decision` 供选择，选定后与会话一起加密保存。空白名单表示全部拒绝，会提示管理员配置；取消选择或没有可用模型会保留登录，但查询被阻止，可稍后运行 `jg emrank --model`。修改模型会更换缓存命名空间。自动化可用 `--login --model <exact-id>` 或登录后 `--model <exact-id>`，仍由原生模块重新读取目录、验证应用权限。旧的登录前 issuer／model 配置文件不再读取。登录及模型列表读取不执行推理。

登录成功后默认使用 EMRank；退出后恢复原版保存的 Provider。`jg auth` 仍只管理上游凭证，不覆盖 EMRank。登录期间临时使用原 Provider：`$env:EMRANK_PROVIDER = 'original'`；清除此变量恢复自动选择，`emrank` 值则强制要求已登录。两个凭证域独立。每次成功登录重新分配缓存空间；原版 `jg cache clear` 会清理整个缓存树。

刷新返回 `invalid_grant` 或未轮换的相同 Refresh Token 后会清除会话 Token，保留独立安装密钥，保留需要重新登录的状态。正式协议下，只有网关在刷新事务开始前明确拒绝（HTTP 429、`emrank_security_rate_limited`、`control_rate_limited`）才会允许稍后再次刷新。刷新返回 503 或无法确认结果时，即便有 `Retry-After`，jg 也不会重用旧凭证；请运行 `jg emrank --login` 重新登录。资源端普通 401/403 只使本次请求失败，不会立即刷新或清除会话；`--status` 仅反映本地状态。失败不会自动把源码发送到原 Provider；只有明确退出或指定 `EMRANK_PROVIDER=original` 才切回。离线退出会额外提示在网关授权管理页完成远端撤销。

`jg emrank --login --manual` 打印登录链接，不自动打开浏览器，也不监听本机回调。打开链接并授权后，将网页显示的一次性授权码粘贴回终端（输入隐藏）；授权码签发后 60 秒失效，只能兑换一次。网站需先为此应用开启“允许手动粘贴授权码”，网关也必须公告对应扩展。旧 `--no-browser` 已移除。等待超时默认 180 秒，Ctrl+C 取消。状态输出不会包含 Token、私钥。Windows 使用当前用户 DPAPI，Linux 使用 Secret Service，禁止静默降级为明文文件。

两种方式登录成功后仅以 `Hello <username>` 问候，不自动打印会话 JSON、账户 ID、缓存标识或过期时间；随后按需选择模型。用户名取自网关当前账户，旧响应缺少用户名时仅显示 `Hello`，不使用账户 ID 替代。单独更换模型只显示所选模型，不输出会话信息。

发行 client_id 固定 `emrank-jevgrep`，resource 为网站根地址下的 `/v1`。`EMRANK_HOME` 可指定凭证根目录；不同网站及应用的会话分别保存。正式包和独立 A 包均只允许各自固定的 HTTPS issuer；本地 HTTP 测试包使用 `EMRANK_ISSUER` 指定的 `127.0.0.1` 站点。所有原生 HTTP 请求禁止重定向，不读取环境代理配置。

资源请求的序列化、DPoP、Content-Digest、HTTP Message Signatures、HTTP 发送及响应校验均在 Rust 完成，JS 不取得认证头；取消信号和超时会传入原生操作。当前发行协议为 `native-build-dpop-v1`（2.0）：强制 PAR，用安装密钥绑定 DPoP，在授权后完成发行挑战激活，按服务器给定的固定截止时间刷新。旧 `attested-dpop-v1` 仅用于历史 fixture。正式协议使用系统 HTTPS 信任，不依赖平台证明或 SPKI 固定值。客户端不决定 OAuth 倍率或 RPM 优惠，网关按应用可信策略和服务端计费规则判定。

## 同步、测试与发行

上游同步只在本地手动执行，只跟正式稳定版；不跟 main、草稿版或预发布版。GitHub Actions 不再定时查版本、生成同步 PR 或保存同步测试缓存。操作顺序：

```powershell
bun run check:upstream     # 查看最新稳定版，不改 upstream.lock
bun run sync:upstream      # 将最新稳定版的完整 SHA 写入 upstream.lock
bun run prepare:upstream   # 检出锁定版本并应用现有 EMRank 补丁
bun run build
bun run verify
```

`sync:upstream` 只更新锁文件和 `.work/candidate.json`，不会提交、推送、发版或修改用户登录凭证。没有更新时保留锁文件原字节；锁定标签被改指向时失败，要求人工核对。同步后保留 `overlay/`、`native/`、`patches/` 中的 EMRank 登录、授权及配置实现。补丁冲突或旧检出目录存在修改时保留现场，先人工处理，再重新准备和验证。确认后手动提交并推送同步改动。

`compatibility.yml` 保留 PR、main 分支 push 及手动运行的 Windows x64 / Linux x64 glibc 检查，只验证已经提交的 `upstream.lock`。这里的 main 是本仓库分支，不表示跟踪上游 main。jg CLI 发版继续由 GitHub Actions 的 `Reviewed release` 工作流手动触发：仅受保护的固定 main SHA 可登记和构建发行候选。验收与发布必须使用同一份 CLI、loader 和两个平台包：候选标签发布后核对 registry 原始字节，网关晋升成功后才推进默认标签。构建或登记作业没有 npm 发布令牌；上游同步仍只在本地手动进行。

平台包通过 `optionalDependencies` 分发。当前目标是 Windows x64 MSVC 和 Linux x64 glibc；musl、macOS、ARM64 尚未列入支持矩阵。

包名为 `@emrank/jevgrep`、`@emrank/jevgrep-native` 和对应平台包。未执行注册表发布。发布后使用 `bun add --global @emrank/jevgrep`；不要和原版全局安装争用同名 `jg`。原版 `jg skill` 的安装器实现保留上游行为，本项目不运行该联网安装器；同步测试验证其参数及取消边界。

详细范围和证据见 [验收记录](docs/acceptance.md)、[测试门禁](docs/testing.md)。
