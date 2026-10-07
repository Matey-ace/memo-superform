$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'release-guards.ps1')
$script:mode = 'exists'
$script:publications = 0
function Invoke-RestMethod {
    param($Uri, $TimeoutSec, $Method, $Headers, $Body, $ContentType)
    if ($Method -eq 'Patch') { $script:publications++; return @{ id = 123 } }
    if ($script:mode -eq 'exists') { return @{ id = 123; draft = $true } }
    if ($script:mode -eq 'draft-list' -and $Uri -like '*?per_page=*') {
        return @(@{id=456;tag_name='v0.88';draft=$true})
    }
    if ($script:mode -eq 'empty-list' -and $Uri -like '*?per_page=*') { return ,@() }
    if ($script:mode -eq 'duplicate-draft' -and $Uri -like '*?per_page=*') {
        return @(@{id=456;tag_name='v0.88'},@{id=457;tag_name='v0.88'})
    }
    if ($script:mode -eq 'paged-draft' -and $Uri -like '*?per_page=*') {
        if ($Uri -like '*page=1') { return @(1..100 | ForEach-Object { @{id=$_;tag_name=('v1.' + $_)} }) }
        return @(@{id=456;tag_name='v0.88';draft=$true})
    }
    $exception = [Exception]::new('fixture query failed')
    if ($script:mode -ne 'network') {
        $status = if ($script:mode -in @('draft-list','empty-list','duplicate-draft','paged-draft')) { 404 } else { [int]$script:mode }
        $exception | Add-Member -NotePropertyName Response -NotePropertyValue @{ StatusCode = $status }
    }
    throw $exception
}
if (-not (Get-ExistingRelease 'fixture')) { throw 'Existing draft must be returned, not swallowed' }
foreach ($mode in @('403', '500', 'network')) {
    $script:mode = $mode
    $raised = $false
    try { Get-ExistingRelease 'fixture' | Out-Null } catch { $raised = $true }
    if (-not $raised) { throw "Query failure was swallowed: $mode" }
}
$script:mode = '404'
if (Get-ExistingRelease 'fixture') { throw '404 must mean absent' }
$script:mode = 'draft-list'
$draft = Get-ExistingRelease 'https://api.github.com/repos/fixture/repo/releases/tags/v0.88' @{Authorization='fixture'}
if ($draft.id -ne 456 -or -not $draft.draft) { throw 'A tag query 404 must not hide an existing untagged draft' }
$script:mode = 'empty-list'
if (Get-ExistingRelease 'https://api.github.com/repos/fixture/repo/releases/tags/v0.88' @{Authorization='fixture'}) { throw 'Empty authorized list must mean absent' }
$script:mode = 'duplicate-draft'
$raised=$false
try { Get-ExistingRelease 'https://api.github.com/repos/fixture/repo/releases/tags/v0.88' @{Authorization='fixture'} | Out-Null } catch { $raised=$true }
if (-not $raised) { throw 'Duplicate drafts must require explicit recovery' }
$script:mode='paged-draft'
$draft=Get-ExistingRelease 'https://api.github.com/repos/fixture/repo/releases/tags/v0.88' @{Authorization='fixture'}
if ($draft.id -ne 456) { throw 'A draft on page two must be detected' }
$draft=Get-ExistingRelease 'https://api.github.com/repos/fixture/repo/releases/tags/v2.0' @{Authorization='fixture'}
if ($draft) { throw 'A different draft must not match the requested tag' }
$payload = New-DraftReleasePayload 'v0.88' '0.88' 'fixture' | ConvertFrom-Json
if (-not $payload.draft -or $payload.make_latest -ne 'false') { throw 'Initial release must remain unpublished' }
$release = @{ id=123; draft=$true; prerelease=$false; assets=@(@{name='app.exe';size=3;digest='sha256:abc'}) }
foreach ($digest in @('', 'sha256:wrong')) {
    $release.assets[0].digest = $digest
    $raised = $false
    try { Publish-VerifiedRelease $release 'app.exe' 3 'abc' 'fixture/repo' @{} | Out-Null } catch { $raised = $true }
    if (-not $raised -or $script:publications -ne 0) { throw 'Invalid asset reached publication' }
}
$release.assets[0].digest = 'sha256:abc'
Publish-VerifiedRelease $release 'app.exe' 3 'abc' 'fixture/repo' @{} | Out-Null
if ($script:publications -ne 1) { throw 'Verified draft should publish once' }
$tokens = $null; $parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Split-Path -Parent $PSScriptRoot) 'release.ps1'), [ref]$tokens, [ref]$parseErrors) | Out-Null
if ($parseErrors) { throw ($parseErrors | Out-String) }
Write-Output 'RELEASE_GUARDS_PASS'
