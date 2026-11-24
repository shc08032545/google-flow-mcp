#!/usr/bin/env bash
set -euo pipefail

DISPLAY_NUM="${DISPLAY_NUM:-:99}"
CDP_PORT="${CDP_PORT:-9222}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
PROFILE_DIR="${PROFILE_DIR:-$HOME/.google-flow-chrome-profile}"
START_URL="${START_URL:-https://flow.google.com/}"

mkdir -p "$PROFILE_DIR"

# Clean up stale display lock if any
rm -f "/tmp/.X${DISPLAY_NUM#:}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM#:}" 2>/dev/null || true

cleanup() {
  echo "[vm-chrome-desktop] Shutting down..." >&2
  kill "${X11VNC_PID:-}" "${CHROME_PID:-}" "${FLUXBOX_PID:-}" "${XVFB_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[vm-chrome-desktop] Starting Xvfb on ${DISPLAY_NUM} (1366x820x24)..." >&2
Xvfb "$DISPLAY_NUM" -screen 0 1366x820x24 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!

for _ in $(seq 1 20); do
  if [[ -S "/tmp/.X11-unix/X${DISPLAY_NUM#:}" ]]; then
    break
  fi
  sleep 0.25
done

export DISPLAY="$DISPLAY_NUM"

echo "[vm-chrome-desktop] Starting fluxbox..." >&2
fluxbox >/tmp/fluxbox.log 2>&1 &
FLUXBOX_PID=$!
sleep 0.5

echo "[vm-chrome-desktop] Launching Google Chrome with CDP on 127.0.0.1:${CDP_PORT}..." >&2
/usr/bin/google-chrome \
  --remote-debugging-port="$CDP_PORT" \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --window-position=0,0 \
  --window-size=1366,820 \
  "$START_URL" >/tmp/chrome-vm.log 2>&1 &
CHROME_PID=$!
sleep 2

echo "[vm-chrome-desktop] Starting x11vnc on 127.0.0.1:${VNC_PORT}..." >&2
x11vnc \
  -display "$DISPLAY_NUM" \
  -localhost \
  -rfbport "$VNC_PORT" \
  -forever \
  -shared \
  -nopw \
  -noxdamage \
  -bg \
  -o /tmp/x11vnc.log
sleep 1

echo "[vm-chrome-desktop] Starting noVNC websockify on 127.0.0.1:${NOVNC_PORT}..." >&2
WEB_DIR="$HOME/.novnc-web"
if [[ ! -d "$WEB_DIR" ]]; then
  WEB_DIR="/usr/share/novnc"
fi
exec websockify --web="$WEB_DIR" "127.0.0.1:${NOVNC_PORT}" "127.0.0.1:${VNC_PORT}"
