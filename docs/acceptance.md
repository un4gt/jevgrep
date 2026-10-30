# 实施与验收记录

本记录对应 `refrence/jg.md` 的 PR0–PR5 顺序；本次只修改 `jg` 工作区，网关源码仅只读核对。当前客户端实现可构建，真实网关 OAuth 仍待服务端按需求落地后验收。

| 阶段 | 已实现 | 验收边界 |
|---|---|---|
| PR0 | Overlay、upstream.lock、三个 `git format-patch`、`git am --3way`、固定 SHA 构建 | 已重新从固定 SHA 应用全部 Patch 并构建；核心源码和 args 零改动 |
| PR1 | `jg emrank --login/--status/--logout`、原版分发保留 | 构建后 Node CLI 命令测试；原版 auth/doctor/files/search/cache 参数及输出回归 |
| PR2 | Rust NAPI-RS、异步导出、Windows DPAPI、Linux Secret Service、平台包加载 | Windows 和 WSL Ubuntu Linux x64 glibc 真实原生加载、完整安装测试通过 |
| PR3 | PKCE S256、浏览器入口/手动地址、本机回调、state/iss、发现与 Token 交换、超时/取消、刷新/退出 | 协议 fixture 通过；真实授权页面和网关授权服务器未实现，不能标记真实登录通过 |
| PR4 | ES256 DPoP、授权码/Token 密钥绑定契约、AS/RS Nonce、Fetch 替换 Bearer、账号缓存隔离 | fixture 的 `/v1/systemone` doctor/search 已通过；真实计费及模型调用待网关联调 |
| PR5 | Windows/Linux 双平台工作流、安装包测试、每天 Release/main 检查、成功后 PR、人工发布门禁 | 工作流文件已实现；尚未关联远端仓库执行 Actions，也未创建真实 PR、自动合并或发布包 |

## 本地验证

- Windows：Node 24.19.0 / Bun 1.4.2 / Rust 1.97.1，真实 `.node` 加载，DPAPI 存储。
- Linux：WSL Ubuntu 24.04 x64，Node 22.22.2 / Bun 1.4.2 / Rust 1.96.0。独立临时源码/构建目录、隔离 D-Bus/Secret Service；上游回归、49 项 parser 用例、OAuth 与安装包测试通过。
- `readelf` 确认当前 Linux 产物需要 glibc 2.39 和 libdbus 运行库，CI 固定 Ubuntu 24.04，旧 glibc 和 musl 未验收。本地验证安装了 WSL 的 libdbus 开发包及 gnome-keyring；验证完成后清理临时构建目录。
- 上游 `v0.8.5` 的参数解析器及 `packages/core` 未修改。三个 Patch 只修改 CLI 入口、构建 external 配置、CLI 包名与原生依赖；owned glue 由构建脚本复制。
- 上游初次同进程跨文件运行时卡在 Evaluator；该文件独立执行 19/19 通过，逐文件门禁也通过。运行器改为按测试文件独立进程执行并设置进程级超时，保留所有断言；没有把运行器卡住归因到核心实现缺陷。
- Windows 中上游未标记的换行文件名 inventory 用例无法创建 fixture，保留为 Linux 必跑项；原版 registry 安装用例由定制包 Bun tarball 安装验收替代。
- 新增 OAuth/DPoP 命令链路测试、刷新并发、错误 grant、Nonce、账户缓存隔离、凭证共存、超时和全新包安装回归。
- 过期/撤销的会话清除 Token/私钥但保留重新登录标记；通过先失败后修复的测试证明后续命令不会静默切回原 Provider。单词 `emrank` 和带原版检索参数的查询继续走原检索入口。
- 两平台发行包安装后的 7 项场景测试均通过（89 个断言）；额外的无参数字面查询检查由命令测试覆盖。Actions YAML 经 actionlint 1.7.12 校验，公开上游版本检测已实际运行。
- Linux 最终安装包复核包含无参数字面查询，共 91 个断言。共享 CLI/loader 归档的解包文件逐字节一致；平台归档元数据可不同。`publish --check` 已验证四个发行包和发布顺序，不执行注册表写入。
- 首个命令测试在原版 CLI 上观察到退出码 1，增加入口及原生实现后通过；测试服务会实际拒绝错误的 PKCE、ES256、htm/htu/ath、jti、Token 类型和密钥绑定。
- GitHub Release 查询曾返回低于锁定标签的 `v0.8.0`；已新增版本比较回归，禁止自动降级或静默接受锁定标签改指向。

完整日志、阶段结果和发行包保存在忽略的 `reports/`、`artifacts/`。构建及测试不访问真实模型；不把 fixture 的协议结果当作真实 OAuth、权限或计费验收。

## 启用远端前的配置

把本 Overlay 推送到用户选定的 GitHub 仓库，允许 Actions 创建 PR；在分支保护中要求双平台 Compatibility，通过 `release` Environment 的 required reviewers 控制发布，配置注册表发布凭证。此工作区没有用户指定的远端地址，因此本轮未推送、未触发线上工作流。

网关后续开发使用 [gateway-oauth-requirements.md](gateway-oauth-requirements.md)，并补充真实测试环境浏览器登录和 `/v1/systemone` 的授权/计费验收。musl、macOS 和 ARM64 不在本轮发行矩阵，不能安装相应平台的原生包。
