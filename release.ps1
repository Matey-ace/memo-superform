#Requires -Version 5.1
<#
.SYNOPSIS
  Memo Superform 自动打包发布脚本
.DESCRIPTION
  从已提交且干净的源码构建、验证并发布单个统一 EXE。脚本不会自动暂存或提交文件。
.PARAMETER Version
  版本号，如 0.25（不包含 v 前缀）
.PARAMETER Message
  Release 说明（可选），默认自动生成
.EXAMPLE
  .\release.ps1 -Version 0.25
  .\release.ps1 -Version 0.25 -Message "修复bug并新增功能"
#>
param(
    [Parameter(Mandatory=$true)]
    [string]$Version,
    [string]$Message = "统一 EXE：网页模式与桌面模式 + 手账页面修复"
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$tag = "v$Version"
$buildExeName = "MemoSuperform.exe"
$exeName = "MemoSuperform-$tag.exe"
$exePath = Join-Path $scriptDir "dist\$buildExeName"
$releaseDir = Join-Path $scriptDir "_release\$tag"
$releaseExe = Join-Path $releaseDir $exeName
$repo = "Matey-ace/memo-superform"

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Memo Superform Release $tag" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# ---- 1. 发布前保护与回归 ----
Write-Host "[1/7] 检查工作区、版本与回归测试..." -ForegroundColor Yellow
if ($Version -notmatch '^0\.\d+$') { throw "版本号必须类似 0.66（不包含 v 前缀）" }
if (git status --porcelain) { throw "工作区不是干净状态；请先明确提交源码，脚本不会执行 git add -A" }
git fetch origin main --tags 2>&1 | Out-Null
if (git rev-parse -q --verify "refs/tags/$tag") { throw "本地 Tag $tag 已存在，禁止覆盖" }
if (git ls-remote --exit-code --tags origin "refs/tags/$tag" 2>$null) { throw "远端 Tag $tag 已存在，禁止覆盖" }
try {
    Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/tags/$tag" -TimeoutSec 15 | Out-Null
    throw "GitHub Release $tag 已存在，禁止覆盖"
} catch {
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -ne 404) { throw }
}
& (Join-Path $scriptDir "tests\run.ps1")
if ($LASTEXITCODE -ne 0) { throw "回归测试失败" }

# ---- 2. 停止占用 8888 端口的旧进程 ----
Write-Host "[2/7] 检查端口占用..." -ForegroundColor Yellow
$conn = Get-NetTCPConnection -LocalPort 8888 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    if ($proc) {
        Write-Host "  停止 $($proc.ProcessName) (PID $($proc.Id)) 占用 8888 端口"
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
}

# ---- 3. PyInstaller 打包 ----
Write-Host "[3/7] PyInstaller 打包 exe..." -ForegroundColor Yellow
$pyArgs = @("--noconfirm", "--clean", "MemoSuperform.spec")
& python -m PyInstaller @pyArgs 2>&1 | Select-Object -Last 5
if ($LASTEXITCODE -ne 0) { Write-Host "  打包失败!" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $exePath)) { Write-Host "  exe 未生成!" -ForegroundColor Red; exit 1 }
$sizeMB = [math]::Round((Get-Item $exePath).Length / 1MB, 2)
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
Copy-Item -LiteralPath $exePath -Destination $releaseExe -Force
$sha256 = (Get-FileHash -LiteralPath $releaseExe -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "  打包成功: $exeName ($sizeMB MB, sha256:$sha256)" -ForegroundColor Green

# ---- 4. 推送已验证提交 ----
Write-Host "[4/7] 推送已验证提交..." -ForegroundColor Yellow
git push origin HEAD:main 2>&1 | Out-Null
Write-Host "  代码已推送" -ForegroundColor Green

# ---- 5. 创建并推送不可覆盖 Tag ----
Write-Host "[5/7] 创建 tag $tag..." -ForegroundColor Yellow
git tag -a $tag -m "$tag release" 2>&1 | Out-Null
git push origin $tag 2>&1 | Out-Null
Write-Host "  tag $tag 已推送" -ForegroundColor Green

# ---- 6. 创建 GitHub Release ----
Write-Host "[6/7] 创建 GitHub Release..." -ForegroundColor Yellow
$credInput = "protocol=https`nhost=github.com`n`n"
$cred = $credInput | git credential fill 2>$null
$token = ($cred | Where-Object { $_ -match '^password=' }) -replace '^password=',''
if (-not $token) { Write-Host "  无法获取 GitHub Token，请先 git push 一次以保存凭据" -ForegroundColor Red; exit 1 }

$headers = @{ "Authorization" = "token $token"; "Accept" = "application/vnd.github+json"; "X-GitHub-Api-Version" = "2022-11-28" }

$releaseBody = if ($Message) { $Message } else { "$tag release" }
$payload = @{ tag_name = $tag; target_commitish = "main"; name = $Version; body = $releaseBody; draft = $false; prerelease = $false; make_latest = "true" } | ConvertTo-Json -Depth 5
try {
    $resp = Invoke-WebRequest -Uri "https://api.github.com/repos/$repo/releases" -Method Post -Headers $headers -Body $payload -ContentType "application/json; charset=utf-8" -TimeoutSec 30 -UseBasicParsing -ErrorAction Stop
    $rel = $resp.Content | ConvertFrom-Json
    $relId = $rel.id
    $uploadUrl = $rel.upload_url
    Write-Host "  Release 创建成功: $($rel.html_url)" -ForegroundColor Green
} catch {
    Write-Host "  Release 创建失败: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# ---- 7. 上传并远端核验唯一 EXE ----
Write-Host "[7/7] 上传 $exeName..." -ForegroundColor Yellow
$assetEndpoint = $uploadUrl -replace '\{\?name,label\}', "?name=$exeName"
$bytes = [System.IO.File]::ReadAllBytes($releaseExe)
$upHeaders = @{ "Authorization" = "token $token"; "Accept" = "application/vnd.github+json" }
try {
    $upResp = Invoke-WebRequest -Uri $assetEndpoint -Method Post -Headers $upHeaders -Body $bytes -ContentType "application/vnd.microsoft.portable-executable" -TimeoutSec 900 -UseBasicParsing -ErrorAction Stop
    $asset = $upResp.Content | ConvertFrom-Json
    Write-Host "  上传成功: $($asset.browser_download_url)" -ForegroundColor Green
} catch {
    Write-Host "  上传失败: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
$remote = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/tags/$tag" -Headers $headers -TimeoutSec 30
$latest = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers $headers -TimeoutSec 30
if ($remote.draft -or $remote.prerelease -or $latest.tag_name -ne $tag) { throw "Release 未成为 Latest" }
if ($remote.assets.Count -ne 1 -or $remote.assets[0].name -ne $exeName) { throw "Release 必须且只能包含 $exeName" }
if ([int64]$remote.assets[0].size -ne (Get-Item $releaseExe).Length) { throw "远端 EXE 大小不一致" }
$digest = [string]$remote.assets[0].digest
if ($digest -and $digest -ne "sha256:$sha256") { throw "远端 EXE SHA256 不一致" }
Write-Host "  远端验证通过: Latest / 1 EXE / sha256:$sha256" -ForegroundColor Green
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  $tag 发布完成!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Release: $($rel.html_url)"
Write-Host "  下载:    $($asset.browser_download_url)"
Write-Host ""
