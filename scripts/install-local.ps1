# 一键本地安装 dsh-usage 到当前 DSH 的 web profile（以 link: 方式指向本仓库）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\install-local.ps1
$ErrorActionPreference = 'Stop'
$scripts = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $scripts

Set-Location $root

# `dsh plugin` 把参数经 shell 转发给 pnpm 且不加引号（apps/cli/src/plugin.ts 的
# spawnSync(..., { shell: true })）：含空格的路径会被拆成多个 spec——例如
# D:\Software\DeepSeek Harness\dsh-usage-plugin 会变成 link:D:/Software/DeepSeek
# 加一个假依赖 Harness\dsh-usage-plugin，并让插件从 dsh.profile.bundles 里消失。
#
# 给参数补引号并不能解决：从 PowerShell 5.1 到 cmd、再到 dsh.cmd 与 node 的每一层
# 都会重新解析引号，实测仍会被拆开。可靠做法是让传给 dsh 的路径本身不含空格——
# 路径含空格时改用 %LOCALAPPDATA%\dsh-plugins 下的 junction 作安装源。
$source = $root
if ($root -match '\s') {
    $linkRoot = Join-Path $env:LOCALAPPDATA 'dsh-plugins'
    $source = Join-Path $linkRoot 'dsh-usage-plugin'
    New-Item -ItemType Directory -Force -Path $linkRoot | Out-Null
    if (Test-Path $source) {
        Write-Host ('复用无空格 junction: ' + $source + '（若它指向别的目录，先删除它再运行本脚本）')
    } else {
        New-Item -ItemType Junction -Path $source -Target $root | Out-Null
        Write-Host ('仓库路径含空格，已建立无空格 junction: ' + $source)
    }
}

if (Get-Command dsh -ErrorAction SilentlyContinue) {
    dsh plugin --profile web add $source
} else {
    # dsh 不在 PATH 时，从源码仓库根目录经 pnpm 启动 CLI
    pnpm dsh plugin --profile web add $source
}

$manifest = Join-Path $env:USERPROFILE '.dsh\profiles\web\package.json'
if (Test-Path $manifest) {
    $m = Get-Content $manifest -Raw | ConvertFrom-Json
    $dep = $m.dependencies.'dsh-usage-plugin'
    $bundles = @($m.dsh.profile.bundles)
    Write-Host ('profile 依赖: ' + $dep)
    Write-Host ('profile 层  : ' + ($bundles -join ', '))
    if (-not $dep -or $dep -notlike 'link:*') {
        Write-Warning '未按 link: 写入 profile——路径可能仍被空格拆开，检查上面的 pnpm 输出'
    }
    if ($bundles -notcontains 'dsh-usage-plugin') {
        Write-Warning 'dsh.profile.bundles 里没有 dsh-usage-plugin，插件不会被挂载'
    }
}

Write-Host ''
Write-Host '安装完成（link: 指向本仓库，改源码后重启即生效）。下一步：'
Write-Host '  1. 重启 dsh web（停止并重新启动 GUI 进程），插件随 boot 加载；'
Write-Host '  2. 浏览器硬刷新（Ctrl+Shift+R）；'
Write-Host '  3. 侧边栏底部 Settings 旁出现用量按钮。'
Write-Host '  自检：node test\standalone.test.mjs（无需重启）或 scripts\restart-web.ps1（含重启）'
