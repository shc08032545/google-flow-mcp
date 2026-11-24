param(
  [int]$Port = 9222,
  [string]$ProfileDir = "$env:USERPROFILE\.google-flow-mcp-chrome-profile"
)

$ErrorActionPreference = "Stop"
$Url = "https://flow.google.com/"

$Candidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)

$ChromeExe = $Candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $ChromeExe) {
  Write-Error "Google Chrome not found. Please install Chrome or update the path."
  exit 1
}

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

Write-Host "Launching Chrome with CDP on http://127.0.0.1:$Port"
Write-Host "Profile directory: $ProfileDir"
Write-Host "Opening: $Url"

Start-Process -FilePath $ChromeExe -ArgumentList @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=$ProfileDir",
  "--no-first-run",
  "--no-default-browser-check",
  $Url
)

Write-Host "Done! Sign in to Google Flow in Chrome, then run flow_status from your MCP client."
