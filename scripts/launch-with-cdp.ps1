param(
  [int]$Port = 9222
)

$candidates = @(
  "$env:LOCALAPPDATA\Programs\Antigravity\Antigravity.exe",
  "$env:ProgramFiles\Antigravity\Antigravity.exe"
)

$exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) {
  Write-Error "[agy-fork-explorer] Antigravity.exe not found in default install locations."
  exit 1
}

Write-Host "[agy-fork-explorer] Launching $exe with --remote-debugging-port=$Port ..."
Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$Port"
