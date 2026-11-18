# 实施与验收记录

截至 2026-11-18，Kiri A 的已安装 Windows/Linux 客户端已通过普通本地 HTTPS 网关的登录、激活、选模、搜索、自然刷新和退出验证。详见[原安装的使用入口及证据](kiri-a-cli.md)。真实上游与生产发行物 B 尚未执行。

下列 PR0–PR5 为 `refrence/jg.md` 对应的历史阶段记录。

| 阶段 | 已实现 | 验收边界 |
|---|---|---|
| PR0 | Overlay、upstream.lock、三个 `git format-patch`、`git am --3way`、固定 SHA 构建 | 已重新从固定 SHA 应用全部 Patch 并构建；核心源码和 args 零改动 |
| PR1 | `jg emrank --login/--status/--logout`、原版分发保留 | 构建后 Node CLI 命令测试；原版 auth/doctor/files/search/cache 参数及输出回归 |
| PR2 | Rust NAPI-RS、异步导出、Windows DPAPI、Linux Secret Service、平台包加载 | Windows 和 WSL Ubuntu Linux x64 glibc 真实原生加载、完整安装测试通过 |
| PR3 | PKCE S256、浏览器入口/手动地址、本机回调、state/iss、发现与 Token 交换、超时/取消、刷新/退出 | 协议 fixture 通过；真实授权页面和网关授权服务器尚未联合验收，不能标记真实登录通过 |
| PR4 | ES256 DPoP、授权码/Token 密钥绑定契约、AS/RS Nonce、Rust 资源请求、账号缓存隔离 | fixture 的 `/v1/systemone` doctor/search 已通过；真实计费及模型调用待网关联调 |
| PR5 | Windows/Linux 双平台工作流、安装包测试、本地手动稳定版同步、Actions 人工发布门禁 | 已移除定时同步及自动 PR；尚未关联远端仓库执行 Actions，也未创建真实 PR、自动合并或发布包 |

## 首轮本地验证（本次安全补齐之前）

- Windows：Node 24.19.0 / Bun 1.4.2 / Rust 1.97.1，真实 `.node` 加载，DPAPI 存储。
- Linux：WSL Ubuntu 24.04 x64，Node 22.22.2 / Bun 1.4.2 / Rust 1.96.0。独立临时源码/构建目录、隔离 D-Bus/Secret Service；上游回归、49 项 parser 用例、OAuth 与安装包测试通过。
- `readelf` 确认当前 Linux 产物需要 glibc 2.39 和 libdbus 运行库，CI 固定 Ubuntu 24.04，旧 glibc 和 musl 未验收。本地验证安装了 WSL 的 libdbus 开发包及 gnome-keyring；验证完成后清理临时构建目录。
- 上游 `v0.8.5` 的参数解析器及 `packages/core` 未修改。三个 Patch 只修改 CLI 入口、构建 external 配置、CLI 包名与原生依赖；owned glue 由构建脚本复制。
- 上游初次同进程跨文件运行时卡在 Evaluator；该文件独立执行 19/19 通过，逐文件门禁也通过。运行器改为按测试文件独立进程执行并设置进程级超时，保留所有断言；没有把运行器卡住归因到核心实现缺陷。
- Windows 中上游未标记的换行文件名 inventory 用例无法创建 fixture，保留为 Linux 必跑项；原版 registry 安装用例由定制包 Bun tarball 安装验收替代。
- 新增 OAuth/DPoP 命令链路测试、刷新并发、错误 grant、Nonce、账户缓存隔离、凭证共存、超时和全新包安装回归。
- 刷新返回 `invalid_grant` 时清除 Token/私钥但保留重新登录标记；资源端普通 401/403 不触发即时刷新或清除。通过先失败后修复的测试证明后续命令不会静默切回原 Provider。单词 `emrank` 和带原版检索参数的查询继续走原检索入口。
- 两平台发行包安装后的 7 项场景测试均通过（89 个断言）；额外的无参数字面查询检查由命令测试覆盖。Actions YAML 经 actionlint 1.7.12 校验，公开上游版本检测已实际运行。
- Linux 最终安装包复核包含无参数字面查询，共 91 个断言。共享 CLI/loader 归档的解包文件逐字节一致；平台归档元数据可不同。`publish --check` 已验证四个发行包和发布顺序，不执行注册表写入。
- 首个命令测试在原版 CLI 上观察到退出码 1，增加入口及原生实现后通过；测试服务会实际拒绝错误的 PKCE、ES256、htm/htu/ath、jti、Token 类型和密钥绑定。
- GitHub Release 查询曾返回低于锁定标签的 `v0.8.0`；已新增版本比较回归，禁止自动降级或静默接受锁定标签改指向。

完整日志、阶段结果和发行包保存在忽略的 `reports/`、`artifacts/`。构建及测试不访问真实模型；不把 fixture 的协议结果当作真实 OAuth、权限或计费验收。

## 2026-10-31 客户端安全补齐

实现范围见 [客户端协同实施记录](client-security-follow-up.md)：原生资源请求、回调歧义校验、Refresh Token 换值检查、统一传输策略，以及测试包/普通包隔离。四项依赖共同协议的能力按用户决定留待后续。

本轮 Windows 原生单元测试 3 项通过；本仓库测试 39 项通过、1 项按构建模式跳过，共 254 个断言。测试 tarball 安装后重跑相同用例通过；普通发行包独立安装的命令与拒绝 HTTP 检查 2 项通过、10 个断言。上述跳过的是测试构建无法承担的普通包 HTTP 边界检查，已在普通构建单独执行。

**本轮 Windows 完整门禁没有通过。** Bun 1.4.2 在未修改的上游 `test/evaluator.test.ts` 出现 `Segmentation fault at address 0xFFFFFFFFFFFFFFFF`；隔离复跑同样出现运行时崩溃/卡住。没有删用例、跳过该文件或把此前的历史成功作为本轮成功。保留逐文件门禁和失败日志 `.work/verify-client-follow-up-windows.log`，远端双平台发布要求仍然有效。

Linux 使用 Ubuntu 24.04 Docker 镜像，通过 act 的 `release-full-linux` 实际执行固定上游 SHA 的检出、Patch、构建、上游回归、OAuth/keyring、测试/普通 tarball 安装和产物上传；最终 35 个阶段全部通过。首次安装因查询另一个平台尚未发布的可选包超时，修正临时 registry fixture 后完整复跑通过。正式工作流的测试用例未被削减。

两平台普通包的 `publish --check` 通过：四个归档齐全，共享 CLI/loader 文件一致，测试包被拒绝。没有实际发布。准确的本轮结果保存在 `reports/client-follow-up-validation.json`，Linux 上传报告为 `reports/actions-linux-verification.json`；该摘要明确 `overallReleaseGatePassed=false`，不能用 Linux 成功替代 Windows 完整门禁。当前工作区原生模块已恢复普通构建。真实证明链、SPKI 与签名 profile 接入和真实 HTTPS OAuth 联调仍未验收。

## 启用远端前的配置

2026-11-01 新一轮已完成严格 profile／PAR／正文签名／错误接线和网关直接离线互操作。两平台定向 OAuth 各 24 项通过；测试 tarball 安装各 26 项通过、1 项按模式跳过，普通包安装各 3 项通过；四种普通归档通过发布前内容核对。网关静态 85 次请求与客户端 Rust 实际生成的双应用 10 次请求均已验证。详细新证据见 [协同记录末节](client-security-follow-up.md)。本轮未重跑全量门禁；生产 profile 及旧会话发送入口因真实 attester／key／pin 未交付继续失败关闭。上一节的 Windows 完整门禁阻断仍有效。

把本 Overlay 推送到用户选定的 GitHub 仓库；上游稳定版由维护者本地同步并提交，Actions 不再需要创建同步 PR 的权限。在分支保护中要求双平台 Compatibility，通过 `release` Environment 的 required reviewers 控制发布，配置 `EMRANK_ISSUER=https://emrank.tech` 和注册表发布凭证。此工作区没有用户指定的远端地址，因此本轮未推送、未触发线上工作流。

网关后续开发使用 [gateway-oauth-requirements.md](gateway-oauth-requirements.md)，并补充真实测试环境浏览器登录和 `/v1/systemone` 的授权/计费验收。musl、macOS 和 ARM64 不在本轮发行矩阵，不能安装相应平台的原生包。

## 2026-11-16 本地稳定版同步与 Actions 发版

按用户最新决定，上游只在本地手动同步正式稳定版；不跟上游 main、草稿版和预发布版。已删除两个定时同步工作流、自动更新 PR 和 Actions 历史成功记录脚本；保留 PR／本仓库 main 分支的兼容性检查和 `Reviewed release` 手动发版。发布仍须通过当次双平台验证与 `release` Environment 审批。

新增 `bun run sync:upstream`，与只读检查 `bun run check:upstream` 共用稳定版发现逻辑。没有发现高于已锁定 `v0.8.5` 的正式 Release，锁文件原字节保持不变；已重新获取 `2d9bce074f9c5f4423e2e33e146fddb5fe117d2d` 并成功应用当前三个 EMRank 补丁。旧的本地检出及其未提交修改完整保存在 `.work/upstream-before-local-sync-20261116`。上游核心和参数解析器与原 SHA 零差异。

EMRank 浏览器／manual 登录、授权、模型选择、刷新、退出及 issuer 规则保留；没有修改用户凭证、全局安装或网关应用配置。本地构建最终恢复为 `http://127.0.0.1:5186`，发行模式单独使用保留测试域名检查安全边界。

本轮验证：测试构建下 46 项通过、2 项普通包专属检查跳过；随后普通发行构建的 4 项检查全部通过，包含这两项。act 在 Linux 容器中的 3 个发版控制场景通过：仅验证、验证后允许发布、验证失败阻止发布；发布步骤使用本地标记，不访问注册表。仓库与上游类型检查、上游 lint、actionlint 和 `git diff --check` 通过；上游 lint 保留原有的 1 条控制字符正则警告。首次测试因漏设 fixture 标志出现模式不匹配，已按正确模式完整重跑并修正文档。

上述为本轮定向验证，没有重跑完整双平台发行门禁，也没有重新执行真实网站登录或模型消费；不覆盖历史完整门禁的阻断事实。没有推送、触发线上 Actions 或实际发布。汇总见 `reports/local-stable-sync-2026-11-16.json`，协议回归日志位于 `.work/local-sync-fixture-tests-20261116.log`，普通包检查日志位于 `.work/local-sync-production-tests-20261116.log`，act 结果位于 `reports/actions-local.json`。
