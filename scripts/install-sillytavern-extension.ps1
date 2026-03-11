param(
  [string]$SillyTavernPath = ""
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host "[install:st] $Message" -ForegroundColor Cyan
}

function Fail {
  param([string]$Message)
  Write-Host "[install:st] ERROR: $Message" -ForegroundColor Red
  exit 1
}

function Resolve-SillyTavernPath {
  param([string]$ProvidedPath)

  if ($ProvidedPath) {
    return $ProvidedPath.Trim('"').Trim()
  }

  if ($env:TAVERNPLUG_SILLYTAVERN_PATH) {
    return $env:TAVERNPLUG_SILLYTAVERN_PATH.Trim('"').Trim()
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

$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceDir = Join-Path $repoRoot "sillytavern-extension\tavernplug-handy"

if (!(Test-Path (Join-Path $repoRoot "scripts\sync-extension.mjs"))) {
  Fail "sync-extension.mjs not found."
}

Write-Step "Syncing root extension files"
Push-Location $repoRoot
try {
  node .\scripts\sync-extension.mjs
} finally {
  Pop-Location
}

if (!(Test-Path $sourceDir)) {
  Fail "Packaged extension folder not found at $sourceDir"
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

Write-Step "Copying HandyTavern files into SillyTavern"
Copy-Item -Force (Join-Path $sourceDir "manifest.json") (Join-Path $extensionPath "manifest.json")
Copy-Item -Force (Join-Path $sourceDir "index.js") (Join-Path $extensionPath "index.js")
Copy-Item -Force (Join-Path $sourceDir "style.css") (Join-Path $extensionPath "style.css")

Write-Host ""
Write-Host "HandyTavern was copied to SillyTavern." -ForegroundColor Green
Write-Host "Installed to: $extensionPath"
Write-Host "Next step: refresh SillyTavern with Ctrl+F5."
