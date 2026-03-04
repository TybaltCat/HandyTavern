param(
  [switch]$ForceEnv
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host "[install] $Message" -ForegroundColor Cyan
}

function Fail {
  param([string]$Message)
  Write-Host "[install] ERROR: $Message" -ForegroundColor Red
  exit 1
}

Write-Step "Checking Node.js"
try {
  $nodeVersion = node --version
  Write-Step "Node found: $nodeVersion"
} catch {
  Fail "Node.js is not installed or not in PATH. Install Node 18+ and re-run this script."
}

Write-Step "Checking npm"
try {
  $npmVersion = npm --version
  Write-Step "npm found: $npmVersion"
} catch {
  Fail "npm is not available in PATH."
}

Write-Step "Installing dependencies"
npm install

$envPath = Join-Path $PSScriptRoot ".env"
$envExamplePath = Join-Path $PSScriptRoot ".env.example"
if (!(Test-Path $envExamplePath)) {
  Fail ".env.example not found."
}

if ($ForceEnv -or !(Test-Path $envPath)) {
  Write-Step "Creating .env from .env.example"
  Copy-Item -Force $envExamplePath $envPath
} else {
  Write-Step ".env already exists; keeping existing file"
}

Write-Host ""
Write-Host "Install complete." -ForegroundColor Green
Write-Host "Next steps:"
Write-Host "1) Edit .env and set HANDY_CONNECTION_KEY."
Write-Host "2) Start bridge: npm start"
Write-Host "3) In SillyTavern extension, set Bridge URL to http://127.0.0.1:8787 and click Connect Device."
