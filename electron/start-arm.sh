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

# Raspberry Pi / ARM: Electron requires a display server.
# On headless setups, start a virtual framebuffer or use --no-sandbox.
ARCH="$(uname -m)"
echo "Detected architecture: $ARCH"

ELECTRON_FLAGS="--no-sandbox"

# On Pi with a real display (HDMI), DISPLAY is usually set already.
# On headless/kiosk setups without a compositor, we need --disable-gpu.
if [[ -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
  echo "No display server detected. If running headless, set up a framebuffer first."
  echo "For a real display, make sure you are running inside a desktop session."
  ELECTRON_FLAGS="$ELECTRON_FLAGS --disable-gpu"
fi

echo "Starting Wall Display (ARM)..."
./node_modules/.bin/electron . $ELECTRON_FLAGS
