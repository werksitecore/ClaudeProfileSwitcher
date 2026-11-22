# Isolated write-pattern probe (constraint 0, docs/STORAGE_ARCHITECTURE.md 5c amendments).
# Opens two windows:
#   1. "PROBE WATCHER": logs how Claude writes its history files.
#   2. "ISOLATED CLAUDE PROBE": the official Claude CLI with a synthetic home and its own config directory.
# Nothing here reads or changes your real ~/.claude or ~/.claude-profile-switcher.
# Sign in ONLY with a test account. Delete .isolated-write-probe afterwards to remove that sign-in.
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$root = Join-Path $repo '.isolated-write-probe'
foreach ($folder in @('home', 'appdata', 'localappdata', 'temp', 'config-a', 'workspace')) {
  New-Item -ItemType Directory -Force (Join-Path $root $folder) | Out-Null
}
$config = Join-Path $root 'config-a'
$log = Join-Path $root 'write-pattern.jsonl'
$claude = Get-ChildItem "$env:USERPROFILE\.vscode\extensions\anthropic.claude-code-*-win32-x64\resources\native-binary\claude.exe" -ErrorAction SilentlyContinue |
  Sort-Object FullName | Select-Object -Last 1 -ExpandProperty FullName
if (-not $claude) { $claude = (Get-Command claude -CommandType Application | Select-Object -First 1).Source }
if (-not $claude) { throw 'Claude CLI not found.' }
# Guard: the probe must never point at real data.
foreach ($path in @($config, (Join-Path $root 'home'))) {
  if ($path -notlike "$root*") { throw "Refusing: $path is outside the probe folder." }
}
Set-Content -Path (Join-Path $root 'workspace\probe.txt') -Value 'line one' -Encoding utf8
$envBlock = @"
`$env:USERPROFILE = '$root\home'; `$env:HOME = '$root\home'; `$env:APPDATA = '$root\appdata'; `$env:LOCALAPPDATA = '$root\localappdata'
`$env:TEMP = '$root\temp'; `$env:TMP = '$root\temp'; `$env:CLAUDE_CONFIG_DIR = '$config'
Remove-Item Env:ANTHROPIC_API_KEY, Env:ANTHROPIC_AUTH_TOKEN, Env:CLAUDE_CODE_OAUTH_TOKEN -ErrorAction SilentlyContinue
"@
$node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
Start-Process powershell -ArgumentList '-NoExit', '-Command', "`$host.UI.RawUI.WindowTitle = 'PROBE WATCHER'; & '$node' '$PSScriptRoot\watch.js' '$config' '$log'"
Start-Process powershell -WorkingDirectory (Join-Path $root 'workspace') -ArgumentList '-NoExit', '-Command', "$envBlock; `$host.UI.RawUI.WindowTitle = 'ISOLATED CLAUDE PROBE'; Write-Host 'Config:' `$env:CLAUDE_CONFIG_DIR; & '$claude'"
Write-Host "Probe started. Log: $log"
Write-Host 'Follow the steps in tools\isolated-write-probe\STEPS.md.'
