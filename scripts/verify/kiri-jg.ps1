# Run the already installed Windows CLI from the active Kiri A batch in its own environment.
# Requires PowerShell 7. All arguments are forwarded to jg without shell interpolation.
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$artifacts = Join-Path $project '.work/native-a'
$batch = Get-Content -Raw -LiteralPath (Join-Path $artifacts 'current.json') | ConvertFrom-Json
if ($batch.run -notmatch '^jg-a-[A-Za-z0-9_-]+$') { throw 'Invalid Kiri A batch directory.' }
$runDir = Join-Path $artifacts $batch.run
$install = Join-Path $runDir 'installed-windows'
$manifest = Get-Content -Raw -LiteralPath (Join-Path $runDir 'sealed/windows.json') | ConvertFrom-Json
$cli = (Resolve-Path -LiteralPath (Join-Path $install 'node_modules/@emrank/jevgrep/dist/bin/index.js')).Path
$binary = Join-Path $install 'node_modules/@emrank/jevgrep-native-win32-x64-msvc/jevgrep-native.node'
if ($manifest.run_id -cne $batch.run -or $manifest.issuer -cne 'https://127.0.0.1:15816' -or
    $manifest.native_sha256 -ne (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash) {
    throw 'The Windows installation does not match this local A batch.'
}
$start = [System.Diagnostics.ProcessStartInfo]::new()
$start.FileName = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$start.WorkingDirectory = (Get-Location).ProviderPath
$start.UseShellExecute = $false
if ($args.Count -ge 2 -and $args[0] -ceq 'emrank' -and $args[1] -ceq '--login') {
    $gateway = Join-Path (Split-Path $project) 'embedding-reranker-next'
    $lab = Join-Path $gateway 'tests/e2e/oauth-native/jg-lab'
    if (-not (Test-Path -LiteralPath (Join-Path $gateway '.preview/jg-native-a/environment.json') -PathType Leaf)) {
        throw '找不到这个安装包对应的本地 A 环境，请先恢复原环境。'
    }
    # Start.ps1 reuses the existing lab and volumes; an already healthy lab needs no startup.
    $probe = [System.Net.Sockets.TcpClient]::new()
    try {
        $probe.Connect([ipaddress]::Loopback, 15816)
    } catch [System.Net.Sockets.SocketException] {
        if ($_.Exception.SocketErrorCode -ne [System.Net.Sockets.SocketError]::ConnectionRefused) { throw }
        Write-Host '正在启动本地测试网关…'
        & (Join-Path $lab 'Start.ps1') | Out-Null
        if ($LASTEXITCODE -ne 0) { throw '本地测试网关未能启动。' }
    } finally { $probe.Dispose() }

    if ($args -cnotcontains '--manual') {
        $start.ArgumentList.Add('--require')
        $start.ArgumentList.Add((Join-Path $PSScriptRoot 'kiri-browser.cjs'))
        $start.Environment['EMRANK_A_BROWSER_DIR'] = $lab
        $start.Environment['EMRANK_A_EXTERNAL_BROWSER'] = '1'
    }
}
$start.ArgumentList.Add($cli)
foreach ($argument in $args) { $start.ArgumentList.Add([string]$argument) }
$start.Environment['EMRANK_PROVIDER'] = 'emrank'
$start.Environment['EMRANK_HOME'] = Join-Path $install 'credentials'
$start.Environment['XDG_CONFIG_HOME'] = Join-Path $install 'config'
$start.Environment['XDG_CACHE_HOME'] = Join-Path $install 'cache'
$child = [System.Diagnostics.Process]::Start($start)
try {
    $child.WaitForExit()
    $exitCode = $child.ExitCode
} finally { $child.Dispose() }
exit $exitCode
