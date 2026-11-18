# jg CLI 本地就绪记录（2026-11-04）

> 本文记录当天较早的准备阶段；后续已按用户要求改为内置本地网站、浏览器登录后选择应用允许的模型。当前行为见 [最新说明](oauth-model-selection-2026-11-04.md)。

结论：隔离 jg CLI 已就绪；登录、doctor、query 和真实消费验收尚未启动。此次仅在本地核对安装和入口，没有向网关发送 HTTP 请求，没有修改网关仓库、网站配置或生产代码。

## 本地检查

- 安装：`E:/RUST_WORKSPACE/jg/.work/docker-oauth-e2e/client`，jg `0.8.5`；Node `v24.19.0`，PowerShell `7.5.4`。
- 三份现有 tarball 的 SHA-256 与 `client-install.json` 一致，无需重新安装或构建。
- `bin/jg.ps1` 的 `--help`、`--version`、`emrank --help`、`emrank --status` 均退出 0。
- `bin/jg.cmd --version` 从 agent-project 工作目录调用成功，不依赖仓库根目录。
- 本地状态：`authenticated=false`、`requiresLogin=false`，没有开始新授权。
- 原生模块只读标识检查：普通工作区 `protocolTestBuild=false`，隔离安装 `true`。这项检查不代表新的生产安全验收。

## 当前入口

在仓库根目录可运行以下本地命令：

```powershell
pwsh -NoProfile -File .work/docker-oauth-e2e/bin/jg.ps1 --version
pwsh -NoProfile -File .work/docker-oauth-e2e/bin/jg.ps1 --help
pwsh -NoProfile -File .work/docker-oauth-e2e/bin/jg.ps1 emrank --help
pwsh -NoProfile -File .work/docker-oauth-e2e/bin/jg.ps1 emrank --status
```

仍使用独立的凭据／配置／缓存目录，未安装全局命令。网站入口为 `http://127.0.0.1:5186/login`，OAuth 管理入口为 `http://127.0.0.1:5186/oauth`；本轮未打开浏览器或登录。

## 真实模型测试前的待办

已只读核对网关最新 `tests/e2e/oauth/README.md` 与 `docs/oauth-website-integration-2026-11-01.md`。网关现在走正式模型路由、日志及账务，已移除固定合成模型，且不会自动注册客户端、开启总开关或创建供应商。`resource_accepted` 仅表示安全准入，不能作为真实上游或计费成功证据。

本地 `.work/docker-oauth-e2e/settings.json` 保留 issuer `http://127.0.0.1:5186`、clientId `emrank-jevgrep`，已将旧 `fixture/oauth-noul` 清为 `model: null`，并设置 `realModelTestingConfirmed: false`。隔离包装脚本在未设置真实模型并记录用户确认前，只允许上列本地命令（另支持 `-h`），其余调用在启动 Node CLI 之前退出。没有新增生产开关，历史合成验收文档／证据保持原样。

下一轮需用户先提供 exact public model ID，并明确允许测试及实际额度消费；网站负责人自行完成供应商／模型、OAuth 总开关及应用注册启用。`emrank-jevgrep` 是本地预期 client_id，不表示已经确认网站上存在或启用该应用。专用镜像应用策略使用 `test-attested-dpop-v1`，正式 profile 的 attester／受保护 key／pin 门槛继续保留。

这些条件满足后，才更新本地 settings 并另行执行浏览器登录 → status → doctor → agent 查询 → 退出／撤销，核对真实响应、usage、请求日志、冻结倍率和账单。`doctor` 会发送推理请求，即使使用的是诊断问题，也不能在消费确认前运行。

本轮原始检查结果：`.work/docker-oauth-e2e/cli-readiness-2026-11-04.json`。其中不含凭据内容；网关服务就绪由网关侧回报，本线程没有重复执行重启或健康探测。
