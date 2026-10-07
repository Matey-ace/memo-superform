# Testable publication boundaries. These functions do not modify local processes.
function Get-ExistingRelease {
    param([string]$Uri)
    try { return Invoke-RestMethod -Uri $Uri -TimeoutSec 15 }
    catch {
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) { return $null }
        throw
    }
}

function New-DraftReleasePayload {
    param([string]$Tag, [string]$Version, [string]$Body)
    return @{ tag_name = $Tag; target_commitish = 'main'; name = $Version; body = $Body;
              draft = $true; prerelease = $false; make_latest = 'false' } | ConvertTo-Json -Depth 5
}

function Publish-VerifiedRelease {
    param($Release, [string]$ExeName, [int64]$Size, [string]$Sha256, [string]$Repository, $Headers)
    if (-not $Release.draft -or $Release.prerelease) { throw '发布候选应保持为稳定版草稿' }
    if ($Release.assets.Count -ne 1 -or $Release.assets[0].name -ne $ExeName) { throw '草稿资产名称或数量异常' }
    if ([int64]$Release.assets[0].size -ne $Size) { throw '草稿资产大小异常' }
    if ([string]$Release.assets[0].digest -ne "sha256:$Sha256") { throw '草稿资产 SHA256 缺失或不一致' }
    $payload = @{ draft = $false; make_latest = 'true' } | ConvertTo-Json
    return Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases/$($Release.id)" -Method Patch -Headers $Headers -Body $payload -ContentType 'application/json; charset=utf-8' -TimeoutSec 30
}
