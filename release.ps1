#Requires -Version 5.1
<#
.SYNOPSIS
  Memo Superform 自动打包发布脚本
.DESCRIPTION
  一键完成：停止旧服务 -> PyInstaller 打包 exe -> git 提交推送 -> 创建 GitHub Release -> 上传 exe
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
    [string]$Message = ""
)

$ErrorActionPreference = "Continue"  # avoid PS5.1 treating native stderr as a fatal error
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$tag = "v$Version"
$exeName = "MemoSuperform.exe"
$exePath = Join-Path $scriptDir "dist\$exeName"
$repo = "Matey-ace/memo-superform"

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Memo Superform Release $tag" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# ---- 1. 停止占用 8888 端口的旧进程 ----
Write-Host "[1/6] 检查端口占用..." -ForegroundColor Yellow
$conn = Get-NetTCPConnection -LocalPort 8888 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    if ($proc) {
        Write-Host "  停止 $($proc.ProcessName) (PID $($proc.Id)) 占用 8888 端口"
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
}

# ---- 2. PyInstaller 打包 ----
Write-Host "[2/6] PyInstaller 打包 exe..." -ForegroundColor Yellow
$pyArgs = @("--noconfirm","--onefile","--name","MemoSuperform",
    "--add-data","index.html;.",
    "--add-data","css;css",
    "--add-data","js;js",
    "--add-data","vendor;vendor",
    "server.py")
& python -m PyInstaller @pyArgs 2>&1 | Select-Object -Last 5
if ($LASTEXITCODE -ne 0) { Write-Host "  打包失败!" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $exePath)) { Write-Host "  exe 未生成!" -ForegroundColor Red; exit 1 }
$sizeMB = [math]::Round((Get-Item $exePath).Length / 1MB, 2)
Write-Host "  打包成功: $exeName ($sizeMB MB)" -ForegroundColor Green

# ---- 3. Git 提交并推送 ----
Write-Host "[3/6] Git 提交推送..." -ForegroundColor Yellow
git add -A 2>&1 | Out-Null
$status = git status --porcelain 2>&1
if ($status) {
    if (-not $Message) { $Message = "$tag release" }
    git commit -m "$tag`: $Message" 2>&1 | Out-Null
}
git pull --rebase origin main 2>&1 | Out-Null
git push origin main 2>&1 | Out-Null
Write-Host "  代码已推送到 main" -ForegroundColor Green

# ---- 4. 创建并推送 tag ----
Write-Host "[4/6] 创建 tag $tag..." -ForegroundColor Yellow
git tag -d $tag 2>$null | Out-Null
git tag -a $tag -m "$tag release" 2>&1 | Out-Null
git push origin $tag 2>&1 | Out-Null
Write-Host "  tag $tag 已推送" -ForegroundColor Green

# ---- 5. 提取 GitHub Token ----
Write-Host "[5/6] 创建 GitHub Release..." -ForegroundColor Yellow
$credInput = "protocol=https`nhost=github.com`n`n"
$cred = $credInput | git credential fill 2>$null
$token = ($cred | Where-Object { $_ -match '^password=' }) -replace '^password=',''
if (-not $token) { Write-Host "  无法获取 GitHub Token，请先 git push 一次以保存凭据" -ForegroundColor Red; exit 1 }

$headers = @{ "Authorization" = "token $token"; "Accept" = "application/vnd.github+json"; "X-GitHub-Api-Version" = "2022-11-28" }

# 检查是否已有 release
try {
    $existing = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/tags/$tag" -Headers $headers -TimeoutSec 15
    if ($existing) {
        Write-Host "  Release $tag 已存在，删除后重建..." -ForegroundColor Yellow
        Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/$($existing.id)" -Method Delete -Headers $headers -TimeoutSec 15 | Out-Null
    }
} catch {}

$releaseBody = if ($Message) { $Message } else { "$tag release" }
$payload = @{ tag_name = $tag; name = $tag; body = $releaseBody; draft = $false; prerelease = $false } | ConvertTo-Json -Depth 5
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

# ---- 6. 上传 exe ----
Write-Host "[6/6] 上传 $exeName..." -ForegroundColor Yellow
$assetEndpoint = $uploadUrl -replace '\{\?name,label\}', "?name=$exeName"
$bytes = [System.IO.File]::ReadAllBytes($exePath)
$upHeaders = @{ "Authorization" = "token $token"; "Accept" = "application/vnd.github+json" }
try {
    $upResp = Invoke-WebRequest -Uri $assetEndpoint -Method Post -Headers $upHeaders -Body $bytes -ContentType "application/octet-stream" -TimeoutSec 120 -UseBasicParsing -ErrorAction Stop
    $asset = $upResp.Content | ConvertFrom-Json
    Write-Host "  上传成功: $($asset.browser_download_url)" -ForegroundColor Green
} catch {
    Write-Host "  上传失败: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  $tag 发布完成!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Release: $($rel.html_url)"
Write-Host "  下载:    $($asset.browser_download_url)"
Write-Host ""