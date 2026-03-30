#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/home/ubuntu/ScavBot"
SERVICE_NAME="scavbot"

cd "$APP_DIR"

NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ] && command -v systemctl >/dev/null 2>&1; then
  EXEC_LINE="$(systemctl show -p ExecStart --value "$SERVICE_NAME" 2>/dev/null | awk -F';' '{print $1}')"
  if [ -n "$EXEC_LINE" ]; then
    set -- $EXEC_LINE
    NODE_BIN="$1"
  fi
fi

if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi

if [ -z "$NODE_BIN" ]; then
  NODE_BIN="/usr/bin/node"
fi

NPM_BIN="${NPM_BIN:-}"
if [ -z "$NPM_BIN" ]; then
  NODE_DIR="$(dirname "$NODE_BIN")"
  if [ -x "$NODE_DIR/npm" ]; then
    NPM_BIN="$NODE_DIR/npm"
  else
    NPM_BIN="$(command -v npm 2>/dev/null || true)"
  fi
fi

if [ -z "$NPM_BIN" ]; then
  NPM_BIN="/usr/bin/npm"
fi

echo "==> Pull"
git pull --ff-only

echo "==> Install deps"
if [ -f package-lock.json ]; then
  "$NPM_BIN" ci
else
  "$NPM_BIN" install
fi

echo "==> Build"
"$NPM_BIN" run build

echo "==> Restart service"
sudo systemctl restart "$SERVICE_NAME"

echo "==> Status"
sudo systemctl --no-pager --full status "$SERVICE_NAME"
