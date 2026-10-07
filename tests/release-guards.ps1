$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'release-guards.ps1')
$script:mode = 'exists'
$script:publications = 0
function Invoke-RestMethod {
    param($Uri, $TimeoutSec, $Method, $Headers, $Body, $ContentType)
    if ($Method -eq 'Patch') { $script:publications++; return @{ id = 123 } }
    if ($script:mode -eq 'exists') { return @{ id = 123; draft = $true } }
    $exception = [Exception]::new('fixture query failed')
    if ($script:mode -ne 'network') {
        $exception | Add-Member -NotePropertyName Response -NotePropertyValue @{ StatusCode = [int]$script:mode }
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
