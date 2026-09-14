# 一键重启 dsh web（默认端口 3080）并验证 dsh-usage 插件是否完整生效。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\restart-web.ps1 [-Port 3080]
#
# 适配 dsh >= 0.1.5：Web UI 与 /api 都在「进程令牌栅栏」之后，干净 URL 会返回
# "dsh web authentication required"。令牌只出现在 dsh web 启动时打印的地址里
# （dsh web: http://127.0.0.1:3080/?token=…），所以本脚本把服务输出落到日志、
# 从日志里取回带令牌的地址，再交给 verify-install.mjs 用。
param(
    [int]$Port = 3080
)
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
    Write-Host '错误：PATH 里找不到 dsh。先安装：npm i -g @deepseek-ai/dsh@next'
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

# 2) 启动全局安装的 dsh（不再是 pnpm 源码构建）。--no-open 让本脚本自己开浏览器，
#    这样能把带令牌的地址交给用户，而不是让 dsh 开一个我们拿不到的页面。
#
# 重定向交给 cmd 自己做（`> log 2> err`），不要用 Start-Process 的
# -RedirectStandardOutput：那会在 PowerShell 里建匿名管道再拷贝到文件，而长命的
# 服务进程会继承管道写端，管道永不关闭，调用本脚本的终端会一直等下去。
$log = Join-Path $scriptDir 'web-restart.log'
$errLog = Join-Path $scriptDir 'web-restart.err.log'
Remove-Item $log, $errLog -Force -ErrorAction SilentlyContinue
$cmdline = 'dsh web --no-open --port ' + $Port + ' > "' + $log + '" 2> "' + $errLog + '"'
Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $cmdline) -WorkingDirectory $scriptDir -WindowStyle Hidden | Out-Null
Write-Host "launched: dsh web --no-open --port $Port (log: $log)"

# 3) 等启动时打印的带令牌地址
$authUrl = $null
foreach ($i in 1..60) {
    Start-Sleep -Milliseconds 500
    if (-not (Test-Path $log)) { continue }
    $m = Select-String -Path $log -Pattern 'dsh web:\s*(http://127\.0\.0\.1:\d+/\?token=\S+)' -AllMatches -ErrorAction SilentlyContinue |
        Select-Object -Last 1
    if ($m -and $m.Matches.Count -gt 0) { $authUrl = $m.Matches[$m.Matches.Count - 1].Groups[1].Value; break }
}

if (-not $authUrl) {
    Write-Host 'server did not print an authenticated URL within 30s; tail of logs:'
    if (Test-Path $log) { Get-Content $log -Tail 20 }
    if (Test-Path $errLog) { Get-Content $errLog -Tail 20 }
    exit 1
}
$token = ([uri]$authUrl).Query.TrimStart('?') -replace '^token=', ''
Write-Host "server up: $authUrl"

# 4) 验证插件
Push-Location $scriptDir
node verify-install.mjs $Port $token
$code = $LASTEXITCODE
Pop-Location
Write-Host "open in browser: $authUrl"
exit $code
