param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$jsFiles = Get-ChildItem js -Filter *.js -File
foreach ($file in $jsFiles) { & node --check $file.FullName; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
& node tests/js-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/js-role-upload-ui-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/live2d-renderer-diagnostics.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/tts-playback-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/tts-single-flight-persona-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/tts-cold-start-timeout-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tests/companion-language-regression.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& python -m compileall -q @((Get-ChildItem -File *.py).FullName); if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& python -m unittest discover -s tests -p "test_*.py" -v; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& git diff --check; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output 'REGRESSION_SUITE_PASS'
