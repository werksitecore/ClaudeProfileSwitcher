param([ValidateSet('environment','continuation','command')][string]$Mode = 'environment')
$ErrorActionPreference = 'Stop'
$probeRoot = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path '.isolated-cli-probe'
foreach ($folder in @('driver','extensions','workspace','home','user-data')) {
  New-Item -ItemType Directory -Force (Join-Path $probeRoot $folder) | Out-Null
}
Copy-Item (Join-Path $PSScriptRoot 'driver/*') (Join-Path $probeRoot 'driver') -Force
$env:USERPROFILE = Join-Path $probeRoot 'home'
$env:HOME = $env:USERPROFILE
$env:APPDATA = Join-Path $probeRoot 'appdata'
$env:LOCALAPPDATA = Join-Path $probeRoot 'localappdata'
$env:PROBE_NODE = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$env:CLAUDE_CONFIG_DIR = Join-Path $probeRoot 'home\inherited-wrong-profile'
$env:ANTHROPIC_API_KEY = 'synthetic-fixture-not-a-secret'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$testFile = switch ($Mode) { 'continuation' { 'continuation.js' }; 'command' { 'production.js' }; default { 'run.js' } }
$resultFile = switch ($Mode) { 'continuation' { 'result-continuation.json' }; 'command' { 'result-cli-command.json' }; default { 'result-updated.json' } }
$probeArgs = @('--user-data-dir',"`"$probeRoot\user-data`"",'--extensions-dir',"`"$probeRoot\extensions`"",'--extensionDevelopmentPath',"`"$probeRoot\driver`"",'--extensionTestsPath',"`"$probeRoot\driver\$testFile`"",'--disable-workspace-trust','--skip-welcome','--skip-release-notes','--disable-updates','--disable-telemetry','--new-window',"`"$probeRoot\workspace`"")
$probeProcess = Start-Process 'C:\Program Files\Microsoft VS Code\Code.exe' -ArgumentList $probeArgs -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput "$probeRoot\stdout.log" -RedirectStandardError "$probeRoot\stderr.log"
Get-Content "$probeRoot\$resultFile"
exit $probeProcess.ExitCode
