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

if [[ -n "${WAYLAND_DISPLAY:-}" ]]; then
  echo "Display: Wayland (${WAYLAND_DISPLAY})"
  ELECTRON_FLAGS="$ELECTRON_FLAGS --ozone-platform=wayland --enable-features=UseOzonePlatform"

elif [[ -n "${DISPLAY:-}" ]]; then
  echo "Display: X11 (${DISPLAY})"
  resolve_xauthority
  echo "Xauthority: ${XAUTHORITY:-<none>}"

else
  # ── SSH / no-env path: probe sockets on the physical machine ─────────────

  for candidate in 0 1 2; do
    if [[ -S "/tmp/.X11-unix/X${candidate}" ]]; then
      export DISPLAY=":${candidate}"
      resolve_xauthority
      echo "Display: X11 auto-detected (${DISPLAY}), Xauthority: ${XAUTHORITY:-<none>}"
      break
    fi
  done

  if [[ -z "${DISPLAY:-}" ]]; then
    RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
    for candidate in wayland-0 wayland-1; do
      if [[ -S "${RUNTIME_DIR}/${candidate}" ]]; then
        export WAYLAND_DISPLAY="${candidate}"
        export XDG_RUNTIME_DIR="${RUNTIME_DIR}"
        echo "Display: Wayland auto-detected (${WAYLAND_DISPLAY})"
        ELECTRON_FLAGS="$ELECTRON_FLAGS --ozone-platform=wayland --enable-features=UseOzonePlatform"
        break
      fi
    done
  fi

  if [[ -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
    echo
    echo "ERROR: No display server found."
    echo
    echo "If a desktop is running on the HDMI screen, set one of these and retry:"
    echo "  export DISPLAY=:0                      # X11 / LXDE"
    echo "  export WAYLAND_DISPLAY=wayland-0       # Wayland (labwc / wayfire)"
    echo
    exit 1
  fi
fi

echo "Starting Wall Display (ARM)..."
exec ./node_modules/.bin/electron . $ELECTRON_FLAGS
