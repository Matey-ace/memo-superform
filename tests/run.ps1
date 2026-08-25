param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$jsFiles = Get-ChildItem js -Filter *.js -File
foreach ($file in $jsFiles) { & node --check $file.FullName; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
& node tests/js-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& python -m compileall -q app.py codex_auth.py db.py launcher.py recommender.py server.py tts.py; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& python tests/test_regression.py; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& git diff --check; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output 'REGRESSION_SUITE_PASS'
