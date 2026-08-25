# 一键本地安装 dsh-usage 到当前 DSH 的 web profile
# 等价于在仓库根目录执行：dsh plugin --profile web add .
# 用法：powershell -ExecutionPolicy Bypass -File scripts\install-local.ps1
$ErrorActionPreference = 'Stop'
$scripts = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $scripts

Set-Location $root

if (Get-Command dsh -ErrorAction SilentlyContinue) {
    dsh plugin --profile web add .
} else {
    # dsh 不在 PATH 时，从源码仓库根目录经 pnpm 启动 CLI
    pnpm dsh plugin --profile web add .
}

Write-Host ''
Write-Host '安装完成。下一步：'
Write-Host '  1. 重启 dsh web（停止并重新启动 GUI 进程），插件随 boot 加载；'
Write-Host '  2. 浏览器硬刷新（Ctrl+Shift+R）；'
Write-Host '  3. 侧边栏底部 Settings 旁出现用量按钮。'
Write-Host '  自检（无需重启）：node test\standalone.test.mjs'
