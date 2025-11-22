#!/usr/bin/env bash
set -euo pipefail

# ── sanity ──────────────────────────────────────────────────────────────────────
ROOT="$(pwd)"
REQS=("server" "dashboard" "client")
for d in "${REQS[@]}"; do
  [[ -d "$ROOT/$d" ]] || { echo "❌ Expected $ROOT/$d"; exit 1; }
done

command -v node >/dev/null || { echo "❌ Node.js not found"; exit 1; }
command -v npm  >/dev/null || { echo "❌ npm not found"; exit 1; }

# ── prompts ─────────────────────────────────────────────────────────────────────
echo "Beatair setup — secrets never leave this terminal."
read -r -p "Spotify Client ID: " SPOTIFY_CLIENT_ID
read -r -s -p "Spotify Client Secret (hidden): " SPOTIFY_CLIENT_SECRET; echo
read -r -p "Server PORT [3001]: " PORT; PORT="${PORT:-3001}"
read -r -p "Redirect URI [http://localhost:${PORT}/auth/callback]: " SPOTIFY_REDIRECT_URI
SPOTIFY_REDIRECT_URI="${SPOTIFY_REDIRECT_URI:-http://localhost:${PORT}/auth/callback}"

# voting defaults you can tweak now (or later in Dashboard Settings)
read -r -p "Vote policy (perTrack|perRound|ttl) [perTrack]: " VOTE_POLICY; VOTE_POLICY="${VOTE_POLICY:-perTrack}"
read -r -p "TTL seconds (used when policy=ttl) [900]: " VOTE_TTL; VOTE_TTL="${VOTE_TTL:-900}"
read -r -p "Min votes to override [1]: " MIN_VOTES; MIN_VOTES="${MIN_VOTES:-1}"
read -r -p "Max track duration minutes [10]: " MAX_MIN; MAX_MIN="${MAX_MIN:-10}"
MAX_MS=$(( MAX_MIN * 60000 ))

# ── write env files ─────────────────────────────────────────────────────────────
cat > "$ROOT/server/.env" <<EOF
# --- Beatair server ---
SPOTIFY_CLIENT_ID=${SPOTIFY_CLIENT_ID}
SPOTIFY_CLIENT_SECRET=${SPOTIFY_CLIENT_SECRET}
SPOTIFY_REDIRECT_URI=${SPOTIFY_REDIRECT_URI}
PORT=${PORT}

# voting
VOTE_IP_POLICY=${VOTE_POLICY}
VOTE_IP_TTL_SECONDS=${VOTE_TTL}
MIN_VOTES_TO_OVERRIDE=${MIN_VOTES}
MAX_TRACK_DURATION_MS=${MAX_MS}
EOF

# dashboard points to server (works from LAN if you swap localhost)
cat > "$ROOT/dashboard/.env" <<EOF
VITE_SERVER_URL=http://localhost:${PORT}
EOF

echo "✅ Wrote server/.env and dashboard/.env"

# ── install deps ────────────────────────────────────────────────────────────────
echo "📦 Installing dependencies (server, dashboard, client)..."
( cd "$ROOT/server"    && npm i )
( cd "$ROOT/dashboard" && npm i )
( cd "$ROOT/client"    && npm i )

echo ""
echo "Install complete."
echo "Next: ./run.sh"