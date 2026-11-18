# 本机 Kiri A：用已经安装的 jg 登录和查询

两份安装都是 `0.1.0`，仅连接 `https://127.0.0.1:15816` 的普通双节点网关；选择 `subq/snap-1.2` 后，只有本地可计数的 mock 接收推理请求。Windows 和 WSL 已分别退出，保留各自安装身份。下面的入口不使用全局 `jg` 或 5816 的配置。

在 `E:\RUST_WORKSPACE\jg` 的 **PowerShell 7** 中运行：

```powershell
.\scripts\verify\kiri-jg.ps1 emrank --status
.\scripts\verify\kiri-jg.ps1 emrank --login
```

普通 `--login` 会在本地网关停止时尝试恢复原环境，然后自动用专用 Chrome/Edge 窗口打开本次授权页。保留当前终端，在网页的密码入口使用普通测试账号登录并同意授权，再回终端选择 `subq/snap-1.2`。这个窗口只对本次实验的证书例外放行，不改变系统证书或日常浏览器配置。

`--login --manual` 只显示链接，不自动打开浏览器。如需在本机打开，可在另一个 PowerShell 中运行网关的 `tests/e2e/oauth-native/jg-lab/Open-Browser.ps1` 并粘贴链接；网页同意后，60 秒内把**完整一次性码**粘回原终端。测试账号位置和手动开浏览器的命令见[网关实验说明](../../embedding-reranker-next/tests/e2e/oauth-native/jg-lab/README.md)。

以下命令是用户按需操作的入口；`doctor` 和搜索会增加**本地** mock 与账单计数：

```powershell
$batch = Get-Content -Raw .work/native-a/current.json | ConvertFrom-Json
.\scripts\verify\kiri-jg.ps1 doctor
.\scripts\verify\kiri-jg.ps1 'Where is an event appended to the events list?' (Join-Path $batch.root 'sample') --concurrency 2 --max-requests 12 --no-cache
.\scripts\verify\kiri-jg.ps1 emrank --logout
```

同一个批次的 **WSL Ubuntu-24.04** 原安装使用自己的 Secret Service。下列命令在 Ubuntu 中运行；浏览器仍可在 Windows 用上述专用入口打开。

```bash
cd /mnt/e/RUST_WORKSPACE/jg
batch=.work/native-a/jg-a-20261117213246
install=$(cat "$batch/linux-install-path.txt" | tr -d '\r\n')
jg_a() { bash scripts/verify/kiri-linux.sh "$install" "$@"; }
jg_a emrank --status
jg_a emrank --login --manual
# 选定模型后可在本机 mock 上复验：
jg_a doctor
jg_a 'Where is an event appended to the events list?' "$batch/sample" --concurrency 2 --max-requests 12 --no-cache
jg_a emrank --logout
```

## 已实际验证的批次

`jg-a-20261117213246` 的[封存安装包和清单](../.work/native-a/jg-a-20261117213246/sealed/)对应上游稳定版 `v0.8.5`（`2d9bce074f9c5f4423e2e33e146fddb5fe117d2d`），overlay 为实际编译输入的 Git tree `83df63f64832dd82945c68e683d11443e7f53ba0`。Windows 的原安装在该批次的 `installed-windows/`；Linux 的原安装路径在 `linux-install-path.txt`。两份 manifest 列出同一 CLI、同一 loader 和各自平台包的完整 SHA-256。

| 观察 | 结果 |
| --- | --- |
| Windows loopback / Linux manual | 均从未登录浏览器授权，激活、读取目录、选定模型通过。Linux 在 WSL 运行 CLI，授权网页由 Windows 的独立 Chrome 打开。 |
| 已安装 CLI 的真实业务路径 | 每平台 doctor 1 次、微型目录搜索 4 次，均定位 `events.ts:recordEvent`。两端共新增 10 次 mock；同时在途峰值 1。 |
| 自然刷新与撤销 | 等同一个五分钟自然到期窗口，两端各用两个进程并发操作，各自只轮换一代，最后两端有效授权均为 0。 |
| A 账务（网关独立核对） | 10 张账单与 10 条流水成对，模拟金额 50 对 −50，差异 0；待结算、待核对均 0。 |
| Linux 首次文件断言 | **fail**：Windows 调 WSL 时丢了文件名分隔符。原整份失败 JSON 未另外归档；网关当时读取到的错误及时间和后续核对均留在下方记录。 |
| Linux 原钥匙环独立核对 | **pass**：原 `.node` 与封存摘要一致；原 CLI 已退出；两个会话槽都为 0，实例槽 A 为 1、B 为 0，磁盘标记指向 A。所有集合可见且已解锁，检查未请求任何秘密值。 |
| 正式发行物 B、真实供应商/支出、npm 发布 | **not_run**。A 是本机 HTTPS、普通网关和 mock；不覆盖线上 LinuxDO 或所有故障注入项。 |

| 原始记录 | SHA-256 |
| --- | --- |
| [Windows manifest](../.work/native-a/jg-a-20261117213246/sealed/windows.json) | `969f4c94dc3bf93c35a4c940e4ab85c9ef2f1af63f5135715cb5b8c1a1e6cf84` |
| [Linux manifest](../.work/native-a/jg-a-20261117213246/sealed/linux.json) | `0218717dc3b1dc802d8776233c420f376797093ae6786fabcf6ea531e1614b84` |
| [已安装 CLI 的两端结果](../.work/native-a/jg-a-20261117213246/cli-acceptance.json) | `2ce94d0b82dd1b598509797e4327deaaeb25b875fc46fec5fe848334992251f1` |
| [退出断言的两次观察及来源](../.work/native-a/jg-a-20261117213246/logout-observations.json) | `00bdd993a647b61da6242ba7b91cbb996462dabfffb35fd9926d9b74525076c9` |
| [Linux Secret Service 独立核对](../.work/native-a/jg-a-20261117213246/linux-logout-independent.json) | `8e18dc6ad1bc5a7d56a56132cd2b255a59ffa4e14b5531604dac414551293f5f` |

退出后，如需自行核对原安装的钥匙环，可在前述 Ubuntu 终端运行以下只读检查。它只输出锁定/未锁定条目数、布尔结果与发行物摘要，不会登录、撤销或请求推理；重新登录后会如实报告条件不符。批次下的 `.work` 文件均为本机证据，未放入 Git 或发行包。

```bash
/usr/bin/python3 "$batch/verify-linux-logout.py" "$install" "$batch/sealed/linux.json" scripts/verify/kiri-linux.sh
```
