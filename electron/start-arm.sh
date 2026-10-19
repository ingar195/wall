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

ARCH="$(uname -m)"
echo "Detected architecture: $ARCH"

# --no-sandbox  : required on Pi OS — kernel user namespaces are disabled by default.
# --disable-gpu : prevents gbm_wrapper / dma_buf crashes on VideoCore/Mesa.
#                 Electron falls back to software (SwiftShader) compositing which
#                 is fast enough for a kiosk display and avoids the GPU driver issues
#                 present on all current Pi GPU stacks.
ELECTRON_FLAGS="--no-sandbox --disable-gpu --disable-gpu-compositing"

# ── Display server detection ──────────────────────────────────────────────────
#
# SSH sessions don't inherit DISPLAY / WAYLAND_DISPLAY even when a desktop is
# live on the physical screen.  Probe the sockets directly and reconstruct auth.

resolve_xauthority() {
  [[ -n "${XAUTHORITY:-}" && -f "${XAUTHORITY}" ]] && return
  [[ -f "${HOME}/.Xauthority" ]] && { export XAUTHORITY="${HOME}/.Xauthority"; return; }
  # Pull the auth file path out of the running Xorg process args
  local p
  p=$(ps -eo args= 2>/dev/null | grep -oP '(?<=-auth )\S+' | head -1 || true)
  [[ -n "$p" && -f "$p" ]] && { export XAUTHORITY="$p"; return; }
  echo "Warning: could not locate Xauthority — display may refuse the connection."
}

# This app positions one native window per zone with absolute screen
# coordinates (win.setBounds({x,y,...})). Native Wayland does not let clients
# set absolute toplevel position — only the compositor decides placement —
# so under Wayland every zone window lands wherever the compositor's own
# placement policy puts it (typically a cascade/offset from the previous
# window), completely ignoring the configured grid. X11 (either a real X
# server or XWayland, which labwc/wayfire normally provide alongside native
# Wayland) honors absolute positioning, so it is strongly preferred even
# when WAYLAND_DISPLAY is also set.
unset USE_WAYLAND

# Probe for an X11 socket directly if DISPLAY isn't already exported (SSH
# sessions don't inherit it even when a desktop/XWayland is running).
if [[ -z "${DISPLAY:-}" ]]; then
  for candidate in 0 1 2; do
    if [[ -S "/tmp/.X11-unix/X${candidate}" ]]; then
      export DISPLAY=":${candidate}"
      break
    fi
  done
fi

if [[ -n "${DISPLAY:-}" ]]; then
  echo "Display: X11 (${DISPLAY})"
  resolve_xauthority
  echo "Xauthority: ${XAUTHORITY:-<none>}"
  # Chromium's ozone "auto" platform selection prefers Wayland whenever
  # WAYLAND_DISPLAY is set — even with no --ozone-platform flag at all —
  # which is exactly the case in an XWayland session where both DISPLAY and
  # WAYLAND_DISPLAY are present. Force X11 explicitly and unset
  # WAYLAND_DISPLAY for the child process so it cannot be auto-selected.
  ELECTRON_FLAGS="$ELECTRON_FLAGS --ozone-platform=x11"
  unset WAYLAND_DISPLAY

elif [[ -n "${WAYLAND_DISPLAY:-}" ]]; then
  echo "Display: Wayland (${WAYLAND_DISPLAY}) — no X11 DISPLAY found"
  echo "WARNING: native Wayland does not support absolute window positioning;"
  echo "zone placement will not match the configured grid. Install/enable"
  echo "XWayland for this session, or set DISPLAY to its socket, for correct layout."
  USE_WAYLAND=1

else
  # No DISPLAY and no WAYLAND_DISPLAY at all — probe a Wayland socket
  # directly as a last resort before giving up.
  RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  for candidate in wayland-0 wayland-1; do
    if [[ -S "${RUNTIME_DIR}/${candidate}" ]]; then
      export WAYLAND_DISPLAY="${candidate}"
      export XDG_RUNTIME_DIR="${RUNTIME_DIR}"
      echo "Display: Wayland auto-detected (${WAYLAND_DISPLAY}) — no X11 DISPLAY found"
      echo "WARNING: zone placement will not match the configured grid under native Wayland."
      USE_WAYLAND=1
      break
    fi
  done

  if [[ -z "${WAYLAND_DISPLAY:-}" ]]; then
    echo
    echo "ERROR: No display server found."
    echo
    echo "If a desktop is running on the HDMI screen, set one of these and retry:"
    echo "  export DISPLAY=:0                      # X11 / XWayland (required for correct zone layout)"
    echo "  export WAYLAND_DISPLAY=wayland-0       # Wayland fallback (zone positions will be wrong)"
    echo
    exit 1
  fi
fi

if [[ -n "${USE_WAYLAND:-}" ]]; then
  ELECTRON_FLAGS="$ELECTRON_FLAGS --ozone-platform=wayland --enable-features=UseOzonePlatform"
fi

echo "Starting Wall Display (ARM)..."
exec ./node_modules/.bin/electron . $ELECTRON_FLAGS
