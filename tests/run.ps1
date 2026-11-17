param([switch]$Browser)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$previousMemoDataDir = $env:MEMO_DATA_DIR
if (-not $previousMemoDataDir) {
    $env:MEMO_DATA_DIR = Join-Path $root ('_verification\regression-' + [guid]::NewGuid().ToString('N'))
}
try {
$jsFiles = Get-ChildItem js -Filter *.js -File
foreach ($file in $jsFiles) { & node --check $file.FullName; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
& node tests/study-keyboard-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/js-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/dashboard-date-cache-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/api-connection-race-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/auth-state-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/auth-button-visibility-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/notebook-shared-path-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/standard-settings-nav-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/notebook-settings-nav-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/chart-palette-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/study-exit-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/layout-fullscreen-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/study-sync-session-race-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/js-role-upload-ui-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/tts-pack-mount-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/tts-status-race-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/live2d-renderer-diagnostics.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/tts-playback-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/tts-single-flight-persona-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/tts-cold-start-timeout-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/companion-tts-preload-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/companion-language-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/companion-reminder-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/app-update-ui-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/study-event-bridge-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/companion-progress-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/companion-settlement-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/article-vocab-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& (Join-Path $PSScriptRoot 'release-guards.ps1')
if ($env:OS -eq 'Windows_NT') {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'release-guards.ps1')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
if ($Browser) {
    & node tests/browser/study-keyboard.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & node tests/browser/quality-hardening.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & node tests/browser/dashboard-smoke.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & node tests/browser/companion-ui.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/browser/article-vocab-ui.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
# 原生程序把进度写到 stderr，在 $ErrorActionPreference='Stop' 下会被 PowerShell 5.1
# 当成终止错误。这里只对这几个原生调用放宽策略，失败仍由 $LASTEXITCODE 判定。
$nativePreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& python -m compileall -q @((Get-ChildItem -File *.py).FullName); $code = $LASTEXITCODE
if ($code -eq 0) { & python -m unittest discover -s tests -p "test_*.py" -v; $code = $LASTEXITCODE }
if ($code -eq 0) { & git diff --check; $code = $LASTEXITCODE }
$ErrorActionPreference = $nativePreference
if ($code -ne 0) { exit $code }
Write-Output 'REGRESSION_SUITE_PASS'
} finally {
    $env:MEMO_DATA_DIR = $previousMemoDataDir
}
