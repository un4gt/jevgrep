# 上游同步测试门禁

用户要求：上游更新应用完成后，必须验证 OAuth 登录及原版 jg 功能。`compatibility.yml` 是 PR、正式 Release 同步、main 预警和发布复用的同一入口，Windows x64 和 Linux x64 glibc 都必须成功。测试不调用真实模型服务、不使用真实用户配置。

| 层次 | 覆盖与验收 |
|---|---|
| 固定上游 | 从完整 SHA 检出，锁定依赖，`git am --3way` 三个 Patch；核心目录和参数解析器零差异 |
| Rust/N-API | cargo fmt、cargo test；真实 Node 进程加载 `.node`，不是 JS 替身 |
| 原版回归 | 上游类型/lint、参数、认证、输出、缓存、文件策略、检索、重试、限流、取消、源文件变更、Provider 协议、Python/Go/Rust/TS parser |
| OAuth 完整链路 | 实际 CLI 发起发现→PKCE 授权→回调→Token→DPoP `/systemone`→检索→退出；独立服务验签及检查绑定 |
| 认证失败 | 伪造 state、拒绝授权、错误 Token 类型、超时、Nonce 挑战、重复 Nonce、403/令牌回显、HTTP 重定向、invalid_grant |
| 会话与凭证 | 原 Provider 凭证字节不变，登录/账号切换缓存隔离、退出恢复；多进程刷新一次、过期会话清除、DPAPI/系统 keyring 存储 |
| 全新安装 | Bun 打包 CLI、原生 loader、平台包；在临时目录安装 tarball、Node 启动并重跑客户端测试，证明 optionalDependency 加载及 parser 资产完整 |

上游部分测试以 `JEVGREP_TEST_IN_DOCKER` 作为隔离测试开关。门禁在 scratch 用户状态和 CI runner 中开启它。Windows 不具备 POSIX chmod/FIFO/换行文件名语义，上游已有 POSIX 标记的测试保持 Linux 专属；另一个未标记的换行文件名 inventory 用例只在 Windows 运行器过滤，Linux 必须执行，不修改核心或降低断言。原版 registry package 用例直接调用其包管理器且断言官方包名，改由本项目的 Bun 安装测试承担定制包验证。真实 `jg skill` 联网安装器不执行；保留上游的解析和中断测试。

所有 OAuth 用例使用真正的 Rust 客户端与系统安全存储。测试服务是外部协议替身，使用 Node crypto 独立验证 ES256、PKCE、jti/htm/htu/ath、DPoP key binding、Nonce 和刷新轮换。浏览器侧由 HTTP 重定向驱动本机回调，不宣称验证了网关登录页面。生产浏览器页面和真实服务端的验收见 [网关需求](gateway-oauth-requirements.md)。

`reports/verification.json` 记录逐阶段结果。任何阶段失败都让进程非零退出，阻止同步 PR 和发布。Actions 保存日志、报告、Patch 冲突和 tarball；通知使用 GitHub Actions 失败通知，需要维护者在仓库开启工作流通知。创建 PR 不自动合并。建议分支保护要求 `Compatibility / verify` 两个平台检查，以及 `release` Environment required reviewers。

当前 fixture 契约随网关协议版本共同维护。网关落地后，真实环境验收也应列为发布检查；不要因暂时缺少服务端就把 fixture 的通过当成真实 OAuth 成功。

## 同步去重与 job outputs

定时频率保持不变：北京时间每日 11:17 检查正式版，11:47 检查 main。检测任务输出 `need_test`、`need_update_pr`、候选 SHA、`test_key` 和历史验证链接；后续 job 使用 `needs.detect.outputs` 与显式的 `'true'` 比较，不修改仓库 Actions 变量，不需要额外的 PAT。

测试标识由版本化格式、渠道、上游完整 SHA 和本仓库完整 SHA 组成。本仓库任何提交都会使旧结果失效。两个平台成功后才运行 `remember`，上传保留 7 天的 `upstream-verified-v1-<key>` artifact。查询时验证 artifact 未过期、默认分支、源码提交、所属仓库、工作流路径、触发事件，以及最近一次运行尝试的记账 job 成功状态；PR、分叉仓库、其他工作流和未完成运行的记录均不能跳过测试。记录失效时重测，也使滚动工具链能定期重新验证。

测试已成功但同一次运行的创建 PR 步骤失败时，下次可复用测试结果补建 PR，报告链接指向原验证运行。如果这份成功记录之后，同渠道、同本仓库 SHA 又出现失败或取消的运行，则保守地重新测试；因此强制重测失败既会阻止本次创建 PR，也不会在第二天被旧成功记录覆盖。测试被跳过时，`propose` 显式要求匹配的历史成功记录；这也避免 GitHub 默认将依赖 skipped job 的后续任务一并跳过。已关闭的更新 PR 同样视为已处理，不每天重新创建。两个同步工作流分别设置 concurrency，避免同渠道重叠执行。

手动运行同步工作流时可勾选 `force_test`。正式包发布仍由 `release.yml` 的独立验证和 `release` Environment 审批控制，同步成功记录不绕过发布门禁。

## 使用 act 在本地验证

前提是 Bun 与 Docker Linux 引擎可用。执行：

```sh
bun run test:actions              # 控制流程场景 + 完整 Linux 验证
bun run test:actions --quick      # 仅控制流程场景
bun run test:actions --skip-build # 已有本地镜像时复用
```

本地测试工具集中在 `tests/actions/`：`run.ts` 负责启动 Docker，`suite.ts` 在容器内组织 act 场景，`verify-stub.yml` 提供快速场景的可控测试 job。生产回归入口位于 `scripts/verify/run.ts`，Linux keyring 包装位于 `scripts/verify/linux.sh`；本地 Linux 验证统一复用 act 工作流。

镜像定义位于 `tests/actions/Dockerfile`，基于 `catthehacker/ubuntu:act-24.04`，安装校验过的 act 0.2.92、Bun 1.4.2 和 rustup。act 执行器也在 Linux 内运行，以避免 Windows 版 act 本地产物服务器的路径问题。由于 [act #6021](https://github.com/nektos/act/issues/6021) 尚不兼容 upload-artifact v6 的 blob 签名，本地快照将其替换为固定提交的 v5（`330a01c490aca151604b8cf639adc76d48f6c5d4`），实际上传 ZIP；生产工作流仍使用 v6。Docker socket 仅提供给本地执行器以创建任务容器，不挂入被执行的任务容器。

脚本在 `.work/act-*` 创建独立 Git 快照，不改变工作区的提交历史。流程场景使用真实的同步工作流、检测脚本、job outputs、依赖条件和成功记录上传，覆盖新版本、已通过候选、已有 PR、没有更新、测试失败、有旧成功记录但强制重测失败，以及 main 的缓存命中和强制重测。快速场景用可控的测试 job 替代编译；完整场景恢复生产 `compatibility.yml`，通过 act 的 `--matrix os:ubuntu-24.04` 执行 Linux 部分。

完整场景模拟从旧版本更新到 `upstream.lock` 当前锁定的真实 SHA，实际执行上游检出、Patch、依赖安装、Rust/CLI 构建、全部 Linux 回归、OAuth/keyring、tarball 全新安装及 artifact 上传，然后再次验证相同候选会跳过测试。act 默认使用 root，本地快照在 Linux 回归步骤降权为普通 `runner` 用户，以匹配 GitHub hosted runner 的文件权限语义；不可读文件、chmod 等上游断言照常执行。GitHub 上游版本/历史记录 API 由本地只读服务模拟，创建 PR 步骤替换为本地标记；不传入真实 GitHub/npm 凭据，不推送代码、不发布包。act 的本地产物服务不提供完整 GitHub 历史查询 API，因此跨运行查找的 API 契约通过 fixture 和独立单元测试验证。

逐场景结果和完整日志位于 `.work/act-*/results.json`、`logs/`，上传产物保存在同目录 `artifacts/`。最新摘要另存为 `reports/actions-local.json`；完整验证通过后，从实际上传的 ZIP 读取报告并保存到 `reports/actions-linux-verification.json`。Linux 本地执行不能代替 Windows runner，也不能验证 GitHub 托管环境的审批、仓库权限、定时调度和 v6 产物服务；这些仍需上线后验证。
