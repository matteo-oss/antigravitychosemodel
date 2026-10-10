# Close Antigravity first. All arguments are forwarded to the shared installer.
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'scripts/deploy.mjs') @args
exit $LASTEXITCODE
