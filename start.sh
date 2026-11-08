#!/usr/bin/env bash
# Start Jamarama. Uses the Magenta texture layer if it's set up; otherwise runs band-only.
set -euo pipefail
cd "$(dirname "$0")"

MAGENTA_ROOT="${MAGENTA_HOME:-$HOME/Documents/Magenta}/magenta-rt-v2"
if [ -x .venv/bin/python ] && ls -d "$MAGENTA_ROOT"/models/mrt2_small* >/dev/null 2>&1; then
  echo "▶ Magenta RealTime 2 found: full mode (band + generative texture)"
else
  echo "▶ Magenta not set up: band-only mode (run ./setup.sh on an Apple Silicon Mac for the texture layer)"
  export NO_TEXTURE=1 NO_PREBAKE=1
fi
[ -f app/.env ] || echo "  (optional) add ANTHROPIC_API_KEY to app/.env to personalize the texture from players' taste prompts"

echo "▶ Open http://localhost:${PORT:-3000} on this computer, click START THE JAM, then scan the QR with 1-3 phones."
cd app && exec npm start
