#!/usr/bin/env bash
set -euo pipefail

ROOT="$(pwd)"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

# read server port from .env (fallback 3001)
PORT="${PORT:-$(grep -E '^PORT=' "$ROOT/server/.env" 2>/dev/null | cut -d= -f2 || true)}"
PORT="${PORT:-3001}"
DASH_URL="http://localhost:5173"
API_URL="http://localhost:${PORT}"

# kill children on exit
pids=()
cleanup() {
  echo ""
  echo "🧹 Stopping background processes..."
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

echo "🚀 Starting Beatair..."
echo "   Server:   ${API_URL}"
echo "   Dashboard ${DASH_URL}"
echo "   Expo app: will run in foreground"

# 1) server (background)
( cd "$ROOT/server" && npm run dev > "$LOG_DIR/server.log" 2>&1 ) &
pids+=($!)
sleep 1

# 2) dashboard (background)
( cd "$ROOT/dashboard" && npm run dev > "$LOG_DIR/dashboard.log" 2>&1 ) &
pids+=($!)
sleep 1

echo "📝 Logs: $LOG_DIR/server.log, $LOG_DIR/dashboard.log"
echo "🌐 Dashboard will be on ${DASH_URL} (proxy targets ${API_URL})"
echo ""

# 3) expo (foreground so you can scan the QR)
cd "$ROOT/client"
echo "📱 Launching Expo (Ctrl+C to stop; this also stops server & dashboard)..."
# You can add --tunnel if your network is spicy:
# npm start -- --tunnel
npm start