#!/usr/bin/env bash
# Portal Customizer one-click updater registration (macOS / Linux, current user only).
set -euo pipefail
HOST_NAME="io.github.lisyoen.portal_customizer"
DIR="$(cd "$(dirname "$0")" && pwd)"
HOST="$DIR/host.py"
chmod +x "$HOST"
# git is only needed for a git clone; a release-zip folder updates itself by download.
if [ -e "$DIR/../.git" ]; then command -v git >/dev/null || { echo "[!] git not found"; exit 1; }; fi
command -v python3 >/dev/null || { echo "[!] python3 not found"; exit 1; }

if [ "$(uname)" = "Darwin" ]; then
  TARGETS=("$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
           "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
           "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts")
else
  TARGETS=("$HOME/.config/google-chrome/NativeMessagingHosts"
           "$HOME/.config/chromium/NativeMessagingHosts"
           "$HOME/.config/microsoft-edge/NativeMessagingHosts")
fi
for t in "${TARGETS[@]}"; do
  mkdir -p "$t"
  cat > "$t/$HOST_NAME.json" <<JSON
{"name":"$HOST_NAME","description":"Portal Customizer one-click updater","type":"stdio","path":"$HOST","allowed_origins":["chrome-extension://cfbjnlfoibngobcpbepnpcmkefdippce/"]}
JSON
  echo "[OK] $t/$HOST_NAME.json"
done
