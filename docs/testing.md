# 上游同步测试门禁

用户要求：上游更新应用完成后，必须验证 OAuth 登录及原版 jg 功能。上游稳定版只在本地手动同步；`compatibility.yml` 是 PR、本仓库 main 分支 push、手动检查和发布复用的验证入口，Windows x64 和 Linux x64 glibc 都必须成功。Actions 只构建 `upstream.lock` 锁定的版本，不发现或更新上游版本。测试不调用真实模型服务、不使用真实用户配置。

| 层次 | 覆盖与验收 |
|---|---|
| 固定上游 | 从完整 SHA 检出，锁定依赖，`git am --3way` 三个 Patch；核心目录和参数解析器零差异 |
| Rust/N-API | cargo fmt、cargo test；真实 Node 进程加载 `.node`，不是 JS 替身 |
| 原版回归 | 上游类型/lint、参数、认证、输出、缓存、文件策略、检索、重试、限流、取消、源文件变更、Provider 协议、Python/Go/Rust/TS parser |
| OAuth 完整链路 | 实际 CLI 发起发现→PKCE 授权→回调→Token→DPoP `/systemone`→检索→退出；独立服务验签及检查绑定 |
| 认证失败 | 伪造/重复 state、重复 iss/code/error、code/error 并存、拒绝授权、错误 Token 类型、强制 PAR/不支持的认证方法、Nonce、403/令牌回显、HTTP 重定向、invalid_grant、相同 Refresh Token |
| 原生资源边界 | 无认证头导出，受限结构化输入、绑定模型/地址、最终字节冻结、Nonce 重试同正文新 jti、取消/超时中断真实 HTTP、响应大小/类型/分数校验及去除回显 |
| 会话与凭证 | 原 Provider 凭证字节不变，登录/账号切换缓存隔离、退出恢复；多进程刷新一次、过期会话清除、DPAPI/系统 keyring 存储 |
| 全新安装 | 在临时目录安装 CLI、loader 和平台 tarball。fixture 与未登记包运行各自的客户端回归。正式候选在两平台核对归档、已安装二进制摘要、版本、build ID 和 issuer，登录与真实业务路径由同包 B 验收。 |

全新安装通过本地 tarball overrides 提供当前平台包。临时 `@emrank` registry 只模拟另一个平台可选包尚未发布时的 404，避免远端查询超时；应来自 tarball 的包若访问该 registry 则验证失败。普通第三方依赖仍按正常 registry 解析；测试不发布任何包。

上游部分测试以 `JEVGREP_TEST_IN_DOCKER` 作为隔离测试开关。门禁在 scratch 用户状态和 CI runner 中开启它。Windows 不具备 POSIX chmod/FIFO/换行文件名语义，上游已有 POSIX 标记的测试保持 Linux 专属；另一个未标记的换行文件名 inventory 用例只在 Windows 运行器过滤，Linux 必须执行，不修改核心或降低断言。原版 registry package 用例直接调用其包管理器且断言官方包名，改由本项目的 Bun 安装测试承担定制包验证。真实 `jg skill` 联网安装器不执行；保留上游的解析和中断测试。

兼容性协议用例使用真正的 Rust 客户端、系统凭据存储和独立 Node 验签服务。当前 v2 协议的真实浏览器、网关和已安装包结果单独记录在 [Kiri A 客户端验收](kiri-a-cli.md)。A 使用本地 mock 上游；最终同一批四个包在生产 issuer 的真实 HTTPS 上完成 B，才可发布。

`reports/verification.json` 记录逐阶段结果。`verify` 先编译、验证并打包没有发行材料的 `--unregistered` 二进制，再单独编译旧 `--fixture` 执行本地回环协议和安装回归。两种都不读取正式发行秘密。注册过的候选另走受保护的 build 作业，一次构建、封存，再用同一批实际归档验收。

开发旧协议 fixture 时可运行 `bun run build`，设置 `EMRANK_TEST_EXPECT_FIXTURE=true` 后执行 `bun test --timeout 60000 tests/emrank`。验证未登记包则清除此标志，运行 `bun run build --unregistered` 和 `bun run pack --unregistered`；这类包无法登录。Linux CI 通过 `dbus-run-session -- bash scripts/verify/linux.sh` 使用隔离的 Secret Service。上述验证不代替真实候选或线上验收。

## 本地手动稳定版同步

`bun run check:upstream` 通过上游 GitHub Release 列表选取不低于当前锁定版本的最高正式 `vX.Y.Z`，过滤 draft、prerelease 及非正式标签，并解析完整提交 SHA。它只在 `.work/candidate.json` 保存候选信息，不修改锁定版本。`bun run sync:upstream` 显式写入 `upstream.lock`；没有更新时不重写锁文件，同一标签改指向时拒绝更新。`--main` 已移除，不再跟踪上游开发分支。

同步后运行 `bun run prepare:upstream`、`bun run build`、`bun run verify`，由维护者处理补丁冲突并手动提交、推送。上游检出始终使用锁文件的完整 SHA，保留 EMRank 的 owned glue、Rust 模块和三个补丁；同步脚本不读取或重写用户凭证，不执行 Git 提交、远端写入或包发布。完整验证仍包含浏览器回调、manual、刷新、退出、模型选择和安装包检查；测试使用独立凭证目录及协议 fixture。

原 `upstream-check.yml`、`upstream-main.yml`、自动建 PR 和 Actions 历史成功记录逻辑已移除；本地同步也拒绝在 GitHub Actions 内以 `--apply` 执行。`need_test`、`need_update_pr`、`force_test` 不再是现行配置，无需设置对应 Actions 变量。

正式包发布由 `release.yml` 在受保护 main 的固定 SHA 手动触发。`publish=false` 运行兼容检查、构建、双平台同包安装及网关 verify；`publish=true` 引用之前成功的 `candidate_run` 和已经人工核实的 `b_acceptance`，不重新构建。先发布 candidate 标签、比对 registry 字节，网关晋升后才推进 latest。维护者需给 `release` 和 `npm-release` 分别配置必需审批者：前者用应用范围的 `EMRANK_RELEASE_CREDENTIAL` 和配置 `EMRANK_APP_ID`、`EMRANK_ISSUER=https://emrank.tech`；后者才配置 `NPM_TOKEN`。没有给本机 A 配置这些线上凭据。

## 使用 act 在本地验证

前提是 Bun 与 Docker Linux 引擎可用。执行：

```sh
bun run test:actions              # 发版控制场景 + 完整 Linux 验证
bun run test:actions --quick      # 仅发版控制场景
bun run test:actions --skip-build # 已有本地镜像时复用
```

本地测试工具集中在 `tests/actions/`：`run.ts` 负责启动 Docker，`suite.ts` 在容器内组织发版 act 场景，`verify-stub.yml` 提供快速场景的可控测试 job。生产回归入口位于 `scripts/verify/run.ts`，Linux keyring 包装位于 `scripts/verify/linux.sh`。

镜像定义位于 `tests/actions/Dockerfile`，基于 `catthehacker/ubuntu:act-24.04`，安装校验过的 act 0.2.92、Bun 1.4.2 和 rustup。act 执行器也在 Linux 内运行，以避免 Windows 版 act 本地产物服务器的路径问题。由于 [act #6021](https://github.com/nektos/act/issues/6021) 尚不兼容 upload-artifact v6 的 blob 签名，本地快照将其替换为固定提交的 v5（`330a01c490aca151604b8cf639adc76d48f6c5d4`），实际上传 ZIP；生产工作流仍使用 v6。Docker socket 仅提供给本地执行器以创建任务容器，不挂入被执行的任务容器。

脚本在 `.work/act-*` 创建独立 Git 快照，不改变工作区的提交历史。编排场景沿用真实 `release.yml` 的 `publish` 输入、job 条件和依赖：创建候选与使用已有候选发布是两次独立 dispatch。验证兼容性失败阻止候选构建、B 回执被拒绝阻止后续发布，以及成功时 registry 核对、晋升、默认标签的顺序。所有发行 job 只保留条件和依赖，具体行为替换为本地标记；不读取发行或 npm 凭证，也不执行真实 B。快速场景用可控的测试 job 替代编译；完整场景恢复生产 `compatibility.yml`，通过 act 的 `--matrix os:ubuntu-24.04` 执行 Linux 部分。

完整场景保留当前 `upstream.lock`，实际执行上游检出、Patch、依赖安装、Rust/CLI 构建、全部 Linux 回归、OAuth/keyring、tarball 全新安装及 artifact 上传。act 默认使用 root，本地快照在 Linux 回归步骤降权为普通 `runner` 用户，以匹配 GitHub hosted runner 的文件权限语义；不可读文件、chmod 等上游断言照常执行。不传入真实 GitHub/npm 凭据，不推送代码、不发布包。稳定版发现与本地同步的版本筛选、显式写入、并发修改保护和失败行为由 `tests/upstream-compat/local-sync.test.ts` 独立验证。

逐场景结果和完整日志位于 `.work/act-*/results.json`、`logs/`，上传产物保存在同目录 `artifacts/`。最新摘要另存为 `reports/actions-local.json`；完整验证通过后，从实际上传的 ZIP 读取报告并保存到 `reports/actions-linux-verification.json`。Linux 本地执行不能代替 Windows runner，也不能验证 GitHub 托管环境的审批、仓库权限和 v6 产物服务；这些仍需上线后验证。
