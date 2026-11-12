param([ValidateSet('first','restart')][string]$Phase = 'first')
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$root = Join-Path $repo '.isolated-vscode'
foreach ($folder in @('driver','extensions/fixture.claude-code','workspace','home','user-data/User')) {
    New-Item -ItemType Directory -Force (Join-Path $root $folder) | Out-Null
}
Copy-Item -Path (Join-Path $PSScriptRoot 'driver/*') -Destination (Join-Path $root 'driver') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'fixture/package.json') -Destination (Join-Path $root 'extensions/fixture.claude-code/package.json') -Force
# Run this script in a child PowerShell. Only that child's environment is changed.
$env:USERPROFILE = Join-Path $root 'home'
$env:HOME = $env:USERPROFILE
$env:APPDATA = Join-Path $root 'appdata'
$env:LOCALAPPDATA = Join-Path $root 'localappdata'
$env:SWITCHER_TEST_PHASE = $Phase
Remove-Item Env:CLAUDE_CONFIG_DIR,Env:ANTHROPIC_API_KEY,Env:ANTHROPIC_AUTH_TOKEN,Env:CLAUDE_CODE_OAUTH_TOKEN,Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$argsList = @('--user-data-dir', "`"$root\user-data`"", '--extensions-dir', "`"$root\extensions`"", '--extensionDevelopmentPath', "`"$root\driver`"", '--extensionTestsPath', "`"$root\driver\run.js`"", '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-telemetry', '--new-window', "`"$root\workspace`"")
$proc = Start-Process -FilePath 'C:\Program Files\Microsoft VS Code\Code.exe' -ArgumentList $argsList -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput "$root\$Phase.stdout.log" -RedirectStandardError "$root\$Phase.stderr.log"
Get-Content "$root\result-$Phase.json"
exit $proc.ExitCode
