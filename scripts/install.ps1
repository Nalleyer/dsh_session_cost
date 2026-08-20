# dsh-session-cost install helper: link this package into a dsh profile as a
# junction so the running `dsh web` can resolve it, without copying files.
# 安装助手：把本包以 junction 链接进 dsh profile，运行中的 `dsh web` 即可解析，
# 无需复制文件。
#
# Usage / 用法:
#   powershell -ExecutionPolicy Bypass -File scripts/install.ps1 [-Profile web] [-DshHome <path>]
#
# Notes / 说明:
# - 创建 $DshHome/profiles/<Profile>/node_modules/dsh-session-cost 指向本仓库的
#   junction，并把包加入 profile 的 `dsh.profile.bundles`（其 cordis.patch.yml
#   即提供插件行）。正式分发安装推荐官方方式：
#   `dsh plugin --profile <name> add https://github.com/Nalleyer/dsh_session_cost`。
# - 创建 $DshHome/profiles/<Profile>/node_modules/dsh-session-cost as a junction
#   pointing at this repository, and appends the package to the profile's
#   `dsh.profile.bundles` (its cordis.patch.yml then supplies the plugin row).

param(
    [string]$Profile = "web",
    [string]$DshHome = ""
)

$ErrorActionPreference = "Stop"

if ($DshHome -eq "") {
    $DshHome = if ($env:DSH_HOME -and $env:DSH_HOME.Trim() -ne "") { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }
}
$repoRoot = Split-Path -Parent $PSScriptRoot
$profileDir = Join-Path $DshHome "profiles\$Profile"
$manifestPath = Join-Path $profileDir "package.json"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "DSH profile '$Profile' is not initialized at '$profileDir'. Run 'dsh web' once (or initialize this profile with dsh) and retry."
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($null -eq $manifest.dsh -or $null -eq $manifest.dsh.profile -or $null -eq $manifest.dsh.profile.bundles) {
    throw "DSH profile manifest '$manifestPath' has no dsh.profile.bundles list."
}

$linkDir = Join-Path $DshHome "profiles\$Profile\node_modules"
$link = Join-Path $linkDir "dsh-session-cost"

New-Item -ItemType Directory -Force -Path $linkDir | Out-Null
if (Test-Path $link) {
    $item = Get-Item $link -Force
    if ($item.LinkType -eq "Junction" -or $item.LinkType -eq "SymbolicLink") {
        Write-Host "Replacing existing link: $link"
        Remove-Item $link -Force
    } else {
        Write-Host "ERROR: $link exists and is not a link; remove it manually first."
        exit 1
    }
}
New-Item -ItemType Junction -Path $link -Target $repoRoot | Out-Null
Write-Host "Linked: $link -> $repoRoot"

# Register the bundle layer so its cordis.patch.yml supplies the plugin row.
# 注册组合包层，使其 cordis.patch.yml 提供插件行。
$bundles = @($manifest.dsh.profile.bundles)
if ($bundles -notcontains "dsh-session-cost") {
    $manifest.dsh.profile.bundles = @($bundles + "dsh-session-cost")
    # 关键：PowerShell 5.1 的 Set-Content -Encoding utf8 会写入 BOM，导致 dsh
    # 解析 package.json 失败。改用 .NET UTF8Encoding(false) 写出无 BOM 的 UTF-8。
    $json = $manifest | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($manifestPath, $json, [System.Text.UTF8Encoding]::new($false))
    Write-Host "Added dsh-session-cost to dsh.profile.bundles in $manifestPath"
}

Write-Host "Done. Restart 'dsh web' to activate. / 完成，重启 'dsh web' 生效。"
