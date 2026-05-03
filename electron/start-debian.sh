#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "ERROR: Node.js is not installed."
  echo "Install it with: sudo apt update && sudo apt install -y nodejs npm"
  echo
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo
  echo "ERROR: npm is not installed."
  echo "Install it with: sudo apt update && sudo apt install -y npm"
  echo
  exit 1
fi

if [[ ! -x "node_modules/.bin/electron" ]]; then
  echo "Installing dependencies..."
  npm install
fi

echo "Starting Wall Display..."
./node_modules/.bin/electron .
