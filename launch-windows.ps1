param(
  [string]$SillyTavernPath = "",
  [switch]$ForceEnv,
  [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host "[launcher] $Message" -ForegroundColor Cyan
}

function Write-Warn {
  param([string]$Message)
  Write-Host "[launcher] WARNING: $Message" -ForegroundColor Yellow
}

function Fail {
  param([string]$Message)
  Write-Host "[launcher] ERROR: $Message" -ForegroundColor Red
  exit 1
}

function Test-Command {
  param([string]$Name)
  try {
    & $Name --version | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Resolve-SillyTavernPath {
  param([string]$ProvidedPath)

  if ($ProvidedPath) {
    return $ProvidedPath.Trim('"').Trim()
  }

  $candidates = @(
    "$env:USERPROFILE\Desktop\SillyTavern",
    "$env:USERPROFILE\Desktop\SillyTavern-main\SillyTavern",
    "$env:USERPROFILE\Documents\SillyTavern",
    "C:\SillyTavern"
  )

  foreach ($candidate in $candidates) {
    if (Test-Path (Join-Path $candidate "public\scripts\extensions\third-party")) {
      Write-Step "Auto-detected SillyTavern at: $candidate"
      return $candidate
    }
  }

  Write-Host ""
  Write-Host "Enter your SillyTavern root folder path." -ForegroundColor White
  Write-Host "Example: C:\Users\YourName\Desktop\SillyTavern" -ForegroundColor DarkGray
  $manual = Read-Host "SillyTavern path"
  return $manual.Trim('"').Trim()
}

Write-Step "Checking Node.js"
if (-not (Test-Command "node")) {
  Fail "Node.js is not installed or not in PATH. Install Node 18+ and re-run this script."
}
Write-Step "Node found: $(node --version)"

Write-Step "Checking npm"
if (-not (Test-Command "npm")) {
  Fail "npm is not available in PATH."
}
Write-Step "npm found: $(npm --version)"

Write-Step "Installing dependencies"
npm install

$envPath = Join-Path $PSScriptRoot ".env"
$envExamplePath = Join-Path $PSScriptRoot ".env.example"
if (!(Test-Path $envExamplePath)) {
  Fail ".env.example not found in $PSScriptRoot"
}

if ($ForceEnv -or !(Test-Path $envPath)) {
  Write-Step "Creating .env from .env.example"
  Copy-Item -Force $envExamplePath $envPath
} else {
  Write-Step ".env already exists; keeping current file"
}

$resolvedSillyTavernPath = Resolve-SillyTavernPath -ProvidedPath $SillyTavernPath
if (-not $resolvedSillyTavernPath) {
  Fail "SillyTavern path is required."
}

$thirdPartyPath = Join-Path $resolvedSillyTavernPath "public\scripts\extensions\third-party"
if (!(Test-Path $thirdPartyPath)) {
  Fail "Could not find '$thirdPartyPath'. Make sure you passed the SillyTavern root folder."
}

$extensionPath = Join-Path $thirdPartyPath "HandyTavern"
if (!(Test-Path $extensionPath)) {
  Write-Step "Creating extension folder: $extensionPath"
  New-Item -ItemType Directory -Path $extensionPath -Force | Out-Null
}

Write-Step "Copying extension files into SillyTavern"
Copy-Item -Force (Join-Path $PSScriptRoot "manifest.json") (Join-Path $extensionPath "manifest.json")
Copy-Item -Force (Join-Path $PSScriptRoot "index.js") (Join-Path $extensionPath "index.js")
Copy-Item -Force (Join-Path $PSScriptRoot "style.css") (Join-Path $extensionPath "style.css")

$envContent = Get-Content $envPath -Raw
if ($envContent -match "(?m)^\s*ENABLE_DEVICE\s*=\s*false\s*$") {
  Write-Warn "ENABLE_DEVICE is set to false in .env. Bridge will start in simulation mode until you change it back to true."
}

if (-not $NoLaunch) {
  Write-Step "Starting bridge in a new PowerShell window"
  $escapedRepoPath = $PSScriptRoot.Replace("'", "''")
  Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$escapedRepoPath'; npm start"
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "Next steps:"
Write-Host "1) In SillyTavern, refresh the page."
Write-Host "2) Open HandyTavern extension."
Write-Host "3) Paste your Handy Connection Key."
Write-Host "4) Set Bridge URL to http://127.0.0.1:8787"
Write-Host "5) Click Connect Device, then Check Bridge."
