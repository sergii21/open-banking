#!/bin/sh
# Ledger Lens: start it with one command. Picks Node 24 itself, installs what is missing, starts the app and opens the browser.
#   ./start.sh            start (and open http://localhost:3000)
#   PORT=3100 ./start.sh  use another port
set -e
cd "$(dirname "$0")"
PORT="${PORT:-3000}"
URL="http://localhost:$PORT"

open_browser() {
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true
  else echo "Open $URL in your browser."; fi
}

# Already running? Just show it.
if curl -fs "$URL/readyz" >/dev/null 2>&1; then
  echo "Ledger Lens is already running at $URL"
  open_browser
  exit 0
fi

# Node 24 (Angular 22 refuses Node 25, which may be your default). nvm is used if it is there.
node_major() { node -v 2>/dev/null | sed 's/^v//; s/\..*//'; }
if [ "$(node_major)" != "24" ]; then
  NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
    nvm use 24 >/dev/null 2>&1 || nvm install 24
  else
    for candidate in "$HOME"/.nvm/versions/node/v24*/bin; do
      [ -x "$candidate/node" ] && PATH="$candidate:$PATH" && break
    done
  fi
fi
if [ "$(node_major)" != "24" ]; then
  echo "Ledger Lens needs Node 24 and could not find it."
  echo "Install it from https://nodejs.org (the 24.x line) or with nvm (https://github.com/nvm-sh/nvm), then run ./start.sh again."
  exit 1
fi

# Dependencies, once.
if [ ! -d node_modules ]; then
  echo "Installing dependencies (once, about a minute)..."
  npm ci --no-audit --no-fund
fi

# Open the browser as soon as the server answers.
(
  i=0
  while [ $i -lt 120 ]; do
    if curl -fs "$URL/readyz" >/dev/null 2>&1; then open_browser; exit 0; fi
    i=$((i + 1)); sleep 0.5
  done
) &

PORT="$PORT" exec npm run app --silent
