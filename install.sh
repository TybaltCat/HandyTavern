#!/usr/bin/env bash
set -euo pipefail

step() {
  printf "[install] %s\n" "$1"
}

fail() {
  printf "[install] ERROR: %s\n" "$1" >&2
  exit 1
}

FORCE_ENV=0
if [[ "${1:-}" == "--force-env" ]]; then
  FORCE_ENV=1
fi

step "Checking Node.js"
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is not installed or not in PATH. Install Node 18+ and re-run this script."
fi
step "Node found: $(node --version)"

step "Checking npm"
if ! command -v npm >/dev/null 2>&1; then
  fail "npm is not available in PATH."
fi
step "npm found: $(npm --version)"

step "Installing dependencies"
npm install

if [[ ! -f ".env.example" ]]; then
  fail ".env.example not found."
fi

if [[ "$FORCE_ENV" -eq 1 || ! -f ".env" ]]; then
  step "Creating .env from .env.example"
  cp -f .env.example .env
else
  step ".env already exists; keeping existing file"
fi

printf "\nInstall complete.\n"
printf "Next steps:\n"
printf "1) Edit .env and set HANDY_CONNECTION_KEY.\n"
printf "2) Start bridge: npm start\n"
printf "3) In SillyTavern extension, set Bridge URL to http://127.0.0.1:8787 and click Connect Device.\n"
