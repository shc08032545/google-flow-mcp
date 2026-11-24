#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-9222}"
PROFILE_DIR="${2:-$HOME/.google-flow-mcp-chrome-profile}"
URL="https://flow.google.com/"

mkdir -p "$PROFILE_DIR"

if [[ "$(uname)" == "Darwin" ]]; then
  CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
elif command -v google-chrome >/dev/null 2>&1; then
  CHROME_BIN="$(command -v google-chrome)"
elif command -v chromium >/dev/null 2>&1; then
  CHROME_BIN="$(command -v chromium)"
elif command -v chromium-browser >/dev/null 2>&1; then
  CHROME_BIN="$(command -v chromium-browser)"
else
  echo "Error: Google Chrome / Chromium not found in PATH." >&2
  exit 1
fi

echo "Launching Chrome with CDP on http://127.0.0.1:${PORT}"
echo "Profile directory: ${PROFILE_DIR}"
echo "Opening: ${URL}"

"$CHROME_BIN" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  "$URL" >/dev/null 2>&1 &

echo "Done! Sign in to Google Flow in the opened Chrome window, then call flow_status from your MCP client."
