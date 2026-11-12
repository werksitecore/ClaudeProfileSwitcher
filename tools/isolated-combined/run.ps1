$ErrorActionPreference='Stop'
$root=Join-Path (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path '.isolated-live'
New-Item -ItemType Directory -Force (Join-Path $root 'combined-driver') | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'driver/*') (Join-Path $root 'combined-driver') -Force
$env:USERPROFILE=Join-Path $root 'home'
$env:HOME=$env:USERPROFILE
$env:APPDATA=Join-Path $root 'appdata'
$env:LOCALAPPDATA=Join-Path $root 'localappdata'
foreach($name in @('CLAUDE_CONFIG_DIR','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','ELECTRON_RUN_AS_NODE','PROBE_SETUP_CLI')){Remove-Item "Env:$name" -ErrorAction SilentlyContinue}
$testArgs=@('--user-data-dir',"`"$root\combined-user-data`"",'--extensions-dir',"`"$root\extensions`"",'--extensionDevelopmentPath',"`"$root\combined-driver`"",'--extensionTestsPath',"`"$root\combined-driver\run.js`"",'--disable-workspace-trust','--skip-welcome','--skip-release-notes','--disable-updates','--disable-telemetry','--new-window',"`"$root\workspace`"")
$testProcess=Start-Process 'C:\Program Files\Microsoft VS Code\Code.exe' -ArgumentList $testArgs -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput "$root\combined.stdout.log" -RedirectStandardError "$root\combined.stderr.log"
Get-Content "$root\combined-result.json"
exit $testProcess.ExitCode
