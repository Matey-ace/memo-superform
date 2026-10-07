# Testable publication boundaries. These functions do not modify local processes.
function Get-ExistingRelease {
    param([string]$Uri, $Headers = @{})
    try { return Invoke-RestMethod -Uri $Uri -Headers $Headers -TimeoutSec 15 }
    catch {
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) {
            # 尚无 tag ref 的 draft 可能不出现在按标签查询中；授权列表仍会返回它。
            if ($Headers.Count -and $Uri -match '^(https://api\.github\.com/repos/[^/]+/[^/]+/releases)/tags/([^/?]+)$') {
                $listUri = $Matches[1]
                $tagName = [Uri]::UnescapeDataString($Matches[2])
                for ($page = 1; $page -le 100; $page++) {
                    $response = Invoke-RestMethod -Uri "${listUri}?per_page=100&page=$page" -Headers $Headers -TimeoutSec 15
                    $releases = @($response)
                    foreach ($item in $releases) {
                        if (-not $item.id -or -not $item.tag_name) { throw 'Release 列表格式异常，发布中止' }
                    }
                    $matching = @($releases | Where-Object { $_.tag_name -eq $tagName })
                    if ($matching.Count -gt 1) { throw '同一版本存在多个草稿，请先明确恢复对象' }
                    if ($matching.Count -eq 1) { return $matching[0] }
                    if ($releases.Count -lt 100) { return $null }
                }
                throw 'Release 列表未完整核验，发布中止'
            }
            return $null
        }
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
