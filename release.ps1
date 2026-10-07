#Requires -Version 5.1
<#
.SYNOPSIS
  Memo Superform 自动打包发布脚本
.DESCRIPTION
  从已提交且干净的源码构建、验证并发布单个统一 EXE。脚本不会自动暂存或提交文件。
.PARAMETER Version
  版本号，如 0.25 或 1.0（不包含 v 前缀）
.PARAMETER Message
  Release 说明（可选），默认自动生成
.EXAMPLE
  .\release.ps1 -Version 0.25
  .\release.ps1 -Version 0.25 -Message "修复bug并新增功能"
#>
param(
    [Parameter(Mandatory=$true)]
    [string]$Version,
    [string]$Message = "统一 EXE：SQLite 增量数据中心、Windows 托盘运行状态、单实例唤醒与Anon的笔记本页面兼容；详情见 CHANGELOG.md"
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir
. (Join-Path $scriptDir 'release-guards.ps1')

function Invoke-GitChecked {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $output = & git @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previous
    if ($exitCode -ne 0) {
        throw "git $($Arguments -join ' ') failed (exit $exitCode): $($output -join ' ')"
    }
    return $output
}

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
if ($Version -notmatch '^\d+\.\d+(?:\.\d+)?$') { throw "版本号必须类似 0.79、1.0 或 1.0.1（不包含 v 前缀）" }
$buildInfoPath = Join-Path $scriptDir "build_info.py"
if (-not (Test-Path $buildInfoPath)) { throw "缺少 build_info.py，无法验证发布版本" }
$buildInfoText = Get-Content -LiteralPath $buildInfoPath -Raw -Encoding UTF8
$buildInfoMatch = [regex]::Match($buildInfoText, 'BUILD_VERSION\s*=\s*["'']([^"'']+)["'']')
if (-not $buildInfoMatch.Success) { throw "build_info.py 中缺少 BUILD_VERSION" }
if ($buildInfoMatch.Groups[1].Value -ne $Version) {
    throw "发布版本 $Version 与 build_info.py 中的 BUILD_VERSION $($buildInfoMatch.Groups[1].Value) 不一致"
}
# 公开 OAuth Client ID 必须随发布 EXE 一起固化。只在构建机设置环境变量不会把
# 它带进用户下载的 EXE，因此在打包前直接检查源码中的审核配置与业务 scope。
$maimemoAuthPath = Join-Path $scriptDir "maimemo_auth.py"
if (-not (Test-Path $maimemoAuthPath)) { throw "缺少 maimemo_auth.py，无法验证墨墨 OAuth 配置" }
$oauthConfigJson = & python -c "import json, maimemo_auth; print(json.dumps({'client_id': maimemo_auth.MAIMEMO_CLIENT_ID, 'scopes': maimemo_auth.DEFAULT_SCOPES}))"
if ($LASTEXITCODE -ne 0) { throw "读取墨墨 OAuth 发布配置失败" }
try { $oauthConfig = $oauthConfigJson | ConvertFrom-Json } catch { throw "墨墨 OAuth 发布配置格式错误" }
$oauthClientId = [string]$oauthConfig.client_id
if ($oauthClientId -notmatch '^[A-Za-z0-9._-]{8,200}$' -or $oauthClientId -eq '__MAIMEMO_CLIENT_ID__') {
    throw "未配置有效的墨墨公开 Client ID；请先写入已审核应用的 client_id"
}
$oauthScopes = @([string]$oauthConfig.scopes -split '\s+' | Where-Object { $_ })
foreach ($requiredScope in @('openid', 'profile', 'offline_access', 'open.memo.study', 'open.memo.content')) {
    if ($oauthScopes -notcontains $requiredScope) {
        throw "墨墨 OAuth 发布配置缺少获批 scope：$requiredScope"
    }
}
if (git status --porcelain) { throw "工作区不是干净状态；请先明确提交源码，脚本不会执行 git add -A" }
# Existing local historical tags may intentionally point at rewritten release
# commits; fetch only the publication branch and query the target tag remotely
# below, avoiding tag-clobber failures during ordinary release preparation.
Invoke-GitChecked fetch origin main --no-tags | Out-Null
if (git rev-parse -q --verify "refs/tags/$tag") { throw "本地 Tag $tag 已存在，禁止覆盖" }
if (git ls-remote --exit-code --tags origin "refs/tags/$tag" 2>$null) { throw "远端 Tag $tag 已存在，禁止覆盖" }
$existingRelease = Get-ExistingRelease "https://api.github.com/repos/$repo/releases/tags/$tag"
if ($existingRelease) { throw "GitHub Release $tag 已存在，禁止覆盖；未完成的草稿请核验后单独恢复" }
& (Join-Path $scriptDir "tests\run.ps1") -Browser
if ($LASTEXITCODE -ne 0) { throw "回归测试失败" }

# ---- 2. 报告端口占用（构建无需关闭运行中的程序） ----
Write-Host "[2/7] 检查端口占用..." -ForegroundColor Yellow
$conn = Get-NetTCPConnection -LocalPort 8888 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    if ($proc) {
        Write-Host "  8888 由 $($proc.ProcessName) (PID $($proc.Id)) 使用；构建继续，运行实例保持原状"
    }
}

# ---- 3. PyInstaller 打包 ----
Write-Host "[3/7] PyInstaller 打包 exe..." -ForegroundColor Yellow
$pyArgs = @("--noconfirm", "--clean", "MemoSuperform.spec")
$previousEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$buildOutput = & python -m PyInstaller @pyArgs 2>&1
$buildExit = $LASTEXITCODE
$ErrorActionPreference = $previousEap
$buildOutput | Select-Object -Last 5
if ($buildExit -ne 0) { Write-Host "  打包失败!" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $exePath)) { Write-Host "  exe 未生成!" -ForegroundColor Red; exit 1 }
$buildReport = Join-Path $scriptDir '_verification\release-build-report.json'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $buildReport) | Out-Null
$buildProcess = Start-Process -FilePath $exePath -ArgumentList @('--verify-build', ('"' + $buildReport + '"')) -WindowStyle Hidden -PassThru
if (-not $buildProcess.WaitForExit(120000)) { $buildProcess.Kill(); throw '冻结包验收超时，发布中止' }
if ($buildProcess.ExitCode -ne 0) { throw '冻结包验收失败，发布中止；详见 _verification/release-build-report.json' }
$verification = Get-Content -LiteralPath $buildReport -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $verification.passed -or -not $verification.frozen -or $verification.version -ne $Version) { throw '冻结包验收记录与发布版本不一致' }
$sizeMB = [math]::Round((Get-Item $exePath).Length / 1MB, 2)
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
Copy-Item -LiteralPath $exePath -Destination $releaseExe -Force
$sha256 = (Get-FileHash -LiteralPath $releaseExe -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "  打包成功: $exeName ($sizeMB MB, sha256:$sha256)" -ForegroundColor Green

# ---- 4. 推送已验证提交 ----
Write-Host "[4/7] 推送已验证提交..." -ForegroundColor Yellow
Invoke-GitChecked push origin HEAD:main | Out-Null
Write-Host "  代码已推送" -ForegroundColor Green

# ---- 5. 创建并推送不可覆盖 Tag ----
Write-Host "[5/7] 创建 tag $tag..." -ForegroundColor Yellow
Invoke-GitChecked -Arguments @('tag', '-a', $tag, '-m', "$tag release") | Out-Null
Invoke-GitChecked push origin $tag | Out-Null
Write-Host "  tag $tag 已推送" -ForegroundColor Green

# ---- 6. 创建 GitHub Release ----
Write-Host "[6/7] 创建 GitHub Release..." -ForegroundColor Yellow
$credInput = "protocol=https`nhost=github.com`n`n"
$cred = $credInput | git credential fill 2>$null
$token = ($cred | Where-Object { $_ -match '^password=' }) -replace '^password=',''
if (-not $token) { Write-Host "  无法获取 GitHub Token，请先 git push 一次以保存凭据" -ForegroundColor Red; exit 1 }

$headers = @{ "Authorization" = "token $token"; "Accept" = "application/vnd.github+json"; "X-GitHub-Api-Version" = "2022-11-28" }

$releaseBody = if ($Message) { $Message } else { "$tag release" }
$payload = New-DraftReleasePayload $tag $Version $releaseBody
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
$remote = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/$relId" -Headers $headers -TimeoutSec 30
Publish-VerifiedRelease $remote $exeName (Get-Item $releaseExe).Length $sha256 $repo $headers | Out-Null
$latest = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers $headers -TimeoutSec 30
if ($latest.tag_name -ne $tag) { throw "公开 Release 后 Latest 核验失败，请检查发布状态" }
Write-Host "  远端验证通过: Latest / 1 EXE / sha256:$sha256" -ForegroundColor Green
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  $tag 发布完成!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Release: $($rel.html_url)"
Write-Host "  下载:    $($asset.browser_download_url)"
Write-Host ""
