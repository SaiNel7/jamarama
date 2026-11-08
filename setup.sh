#!/usr/bin/env bash
# Jamarama one-time setup.
#   ./setup.sh          full setup: band + Magenta RealTime 2 texture (Apple Silicon Mac)
#   ./setup.sh --lite   band only (any OS with Node 22+), skips Magenta
set -euo pipefail
cd "$(dirname "$0")"

say() { printf "\n\033[1m%s\033[0m\n" "$*"; }

# --- Node (the band, host page and phone controllers) ---
if ! command -v node >/dev/null; then
  echo "Node.js 22+ is required: https://nodejs.org (or: brew install node)"; exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node $NODE_MAJOR found; Jamarama needs Node 22+."; exit 1
fi
say "✓ Node $(node -v) (dependencies are bundled, no npm install needed)"

# --- Optional: cloudflared lets phones join from any network (not just same WiFi) ---
if ! command -v cloudflared >/dev/null; then
  if command -v brew >/dev/null; then
    say "Installing cloudflared (so phones can join from any network)…"
    brew install cloudflared || echo "  (skipped; phones will need to be on the same WiFi)"
  else
    echo "  cloudflared not found: phones will need to be on the same WiFi as this computer."
  fi
fi

if [ "${1:-}" = "--lite" ]; then
  say "Lite setup done. Run ./start.sh"; exit 0
fi

# --- Magenta RealTime 2 texture layer (needs Apple Silicon for MLX) ---
if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  say "Magenta texture needs an Apple Silicon Mac; set up the band only. Run ./start.sh"; exit 0
fi
if ! command -v uv >/dev/null; then
  say "Installing uv (Python package manager)…"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi
say "Creating Python env and installing the bundled magenta-rt…"
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python "./external/magenta-realtime[mlx]" sounddevice websocket-client scipy

say "Downloading Magenta RealTime 2 weights (a few GB, one time)…"
.venv/bin/mrt models init
.venv/bin/mrt models download mrt2_small

say "Checking the texture engine…"
(cd engine && ../.venv/bin/python texture_engine.py --test) || echo "  (engine check failed; ./start.sh will fall back to band-only)"

say "Setup done. Run ./start.sh"
