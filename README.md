# EMRank jevgrep Overlay

按 [refrence/jg.md](refrence/jg.md) 维护的 jevgrep 定制发行版。上游源码只在忽略的 `.work/upstream` 中检出，当前固定正式版 `v0.8.5` / `2d9bce074f9c5f4423e2e33e146fddb5fe117d2d`。自定义内容是三个 Git Patch、TypeScript 调用胶水和 Rust N-API 模块。没有修改网关仓库。

## 本地构建

需要 Git、Bun 1.4.2、Node.js 22.20+、Rust stable；Windows 需要 MSVC 构建工具。当前 Linux 预编译包基于 Ubuntu 24.04，要求 glibc 2.39+、`libdbus-1.so.3` 和 Secret Service（开发包 `libdbus-1-dev`、运行时 `gnome-keyring` / 同类服务）；未声称支持更旧的 glibc。

```powershell
bun install --frozen-lockfile
bun run prepare:upstream
bun run build
bun run verify
node .work/upstream/apps/cli/dist/bin/index.js --help
```

`prepare:upstream` 检查来源和工作区，安装原版锁定依赖后执行 `git am --3way`；冲突时失败并保留现场，不自动重置修改。`build` 编译真实 `.node` 并将原生包设为 bundle external。`verify` 检查上游代码和客户端 OAuth，打包后还会在独立目录用 Bun 安装 tarball、用 Node 重跑完整客户端测试。所有包管理操作使用 Bun。

## 开发脚本

日常操作使用 `package.json` 中的 `bun run` 命令。脚本按职责放置，共享的仓库路径与进程工具集中在 `scripts/common.ts`：

| 目录 | 职责 | 常用入口 |
|---|---|---|
| `scripts/build/` | Rust 原生模块与 CLI 构建 | `bun run build` |
| `scripts/upstream/` | 上游检出、版本检测、成功记录与更新 PR | `bun run prepare:upstream`、`bun run check:upstream` |
| `scripts/release/` | 打包、安装验证和审批后的发布 | `bun run pack`；发布由工作流调用 |
| `scripts/verify/` | 完整回归与 Linux keyring 环境 | `bun run verify` |
| `tests/actions/` | act 启动器、模拟接口、流程场景与测试镜像 | `bun run test:actions` |

## 使用方式

```powershell
# 原版功能
jg auth
jg doctor
jg files . --list
jg "Where is authentication implemented?" .

# 首次 OAuth 登录前，填写网关正式提供的配置
$env:EMRANK_ISSUER = 'https://gateway.example.com'
$env:EMRANK_MODEL = 'your-public-model-id'
jg emrank --login
jg emrank --status
jg doctor
jg "Where is authentication implemented?" .
jg emrank --logout
```

**网关目前没有这里需要的客户端授权服务器接口，真实登录尚不能验收。** 实现契约见 [网关需求](docs/gateway-oauth-requirements.md)。本地自动测试使用独立协议服务，没有改动或调用真实网关、没有消费真实模型额度。

登录成功后默认使用 EMRank；退出后恢复原版保存的 Provider。`jg auth` 仍只管理上游凭证，不覆盖 EMRank。登录期间临时使用原 Provider：`$env:EMRANK_PROVIDER = 'original'`；清除此变量恢复自动选择，`emrank` 值则强制要求已登录。两个凭证域独立。每次成功登录重新分配缓存空间；原版 `jg cache clear` 会清理整个缓存树。

授权失效后会清除 Token 和私钥，保留需要重新登录的状态。后续命令会提示登录，不会自动把源码发送到原 Provider；只有明确退出或指定 `EMRANK_PROVIDER=original` 才切回。

`--no-browser` 打印授权地址后等待本机回调，适合手动打开浏览器；回调仍须能到达运行 CLI 的 `127.0.0.1`。超时默认 180 秒，Ctrl+C 取消。状态输出不会包含 Token、私钥。Windows 使用当前用户 DPAPI，Linux 使用 Secret Service，禁止静默降级为明文文件。

可选配置：`EMRANK_CLIENT_ID` 默认 `emrank-jevgrep`；`EMRANK_BASE_URL` 默认 `<issuer>/v1`，必须与 issuer 同源；`EMRANK_HOME` 是独立凭证目录的绝对路径。Issuer、端点、模型随登录保存，已有会话不接受环境变量静默改写。`EMRANK_ALLOW_HTTP_LOOPBACK=1` 仅开放 `http://127.0.0.1` 供本地协议测试，公网端点必须 HTTPS。每个资源请求都检查完整目标地址，签名 Fetch 禁止跟随重定向。

## 同步、测试与发行

每日检查正式 Release，检测任务通过 job outputs 的 `need_test` / `need_update_pr` 决定是否测试、创建更新 PR。候选 SHA 必须通过 Windows x64 / Linux x64 glibc 的构建、上游回归、OAuth/DPoP、打包安装检查。成功记录绑定上游 SHA、本仓库 SHA 和检查渠道，保留 7 天；相同组合在记录有效期内复用结果，代码变化、失败、记录过期或手动勾选 `force_test` 时重新验证。已有更新 PR 不重复创建。`main` 每日只做兼容性预警，不发布。没有自动合并。失败日志和测试报告保留在 Actions artifacts。

本地可使用 [nektos/act](https://nektosact.com/) 验证工作流。启动 Docker 的 Linux 引擎后运行 `bun run test:actions`，会构建 Ubuntu 24.04 测试镜像并运行控制流程场景与完整 Linux 构建、测试和打包。快速检查任务控制逻辑可用 `bun run test:actions --quick`。上游版本/历史记录 API 与创建 PR 使用本地 fixture；完整场景的源码检出、构建、回归和产物上传真实执行，不向远端创建 PR 或发布包。具体范围见 [测试门禁](docs/testing.md)。

发布工作流先生成可审查的发行包，发布到注册表须经过 GitHub `release` Environment 的维护者审批；应在仓库设置中启用 required reviewers。平台包通过 `optionalDependencies` 分发。当前目标是 Windows x64 MSVC 和 Linux x64 glibc；musl、macOS、ARM64 尚未列入支持矩阵。

包名为 `@emrank/jevgrep`、`@emrank/jevgrep-native` 和对应平台包。未执行注册表发布。发布后使用 `bun add --global @emrank/jevgrep`；不要和原版全局安装争用同名 `jg`。原版 `jg skill` 的安装器实现保留上游行为，本项目不运行该联网安装器；同步测试验证其参数及取消边界。

详细范围和证据见 [验收记录](docs/acceptance.md)、[测试门禁](docs/testing.md)。
