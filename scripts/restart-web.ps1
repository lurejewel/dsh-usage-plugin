# 一键重启 dsh web（端口 3080）并验证 dsh-usage 插件是否完整生效。
# 需要设置 $env:DSH_SOURCE_ROOT 指向你的 deepseek-harness 源码目录
# （即 `pnpm dsh web` 的启动目录），否则无法启动服务器。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\restart-web.ps1
param(
    [int]$Port = 3080,
    [string]$SourceRoot = $env:DSH_SOURCE_ROOT
)
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $SourceRoot) {
    Write-Host '错误：未设置 DSH_SOURCE_ROOT（指向 deepseek-harness 源码目录）。'
    Write-Host '示例：$env:DSH_SOURCE_ROOT = "D:\path\to\deepseek-harness"'
    exit 2
}

# 1) 结束占用端口的旧进程
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
    Stop-Process -Id $conn.OwningProcess -Force
    Write-Host "killed old dsh web (PID $($conn.OwningProcess)) on port $Port"
    Start-Sleep -Seconds 2
} else {
    Write-Host "no listener on port $Port (nothing to kill)"
}

# 2) 分离式重启：源码构建（pnpm dsh web）
$log = Join-Path $scriptDir 'web-restart.log'
Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', 'pnpm dsh web') -WorkingDirectory $SourceRoot -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err"
Write-Host "relaunched dsh web (source build) -> http://127.0.0.1:$Port (log: $log)"

# 3) 等待就绪并验证插件
$ok = $false
foreach ($i in 1..25) {
    Start-Sleep -Seconds 2
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/dsh-usage/stats" -UseBasicParsing -TimeoutSec 3
        if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch { }
}
if (-not $ok) {
    Write-Host "server did not come up in 50s; tail of log:"
    if (Test-Path $log) { Get-Content $log -Tail 20 }
    if (Test-Path "$log.err") { Get-Content "$log.err" -Tail 20 }
    exit 1
}
Write-Host "server up. running verification..."
Push-Location $scriptDir
node verify-install.mjs $Port
$code = $LASTEXITCODE
Pop-Location
Write-Host "open http://127.0.0.1:$Port and look for the usage button at the sidebar bottom."
exit $code
