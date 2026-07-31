#!/usr/bin/env bash
# ============================================================
# Install the resident AI daemon as a macOS LaunchAgent so it
# auto-starts on login and is kept alive (restarts if it dies).
#
#   bash scripts/install-ai-daemon.sh          # install + start
#   bash scripts/install-ai-daemon.sh --uninstall
#
# Prereqs: `gcloud auth application-default login` (ADC) + Ollama running.
# ============================================================
set -euo pipefail

LABEL="com.gmii.twstock.ai-daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node || true)"
# Log 放 ~/Library/Logs（非 TCC 保護）。放 ~/Documents 會讓 launchd 在開機情境下
# 無法開檔→EX_CONFIG(78)，daemon 開機自啟失敗。
LOG_DIR="$HOME/Library/Logs/twstock-ai-daemon"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✓ Uninstalled $LABEL"
  exit 0
fi

[[ -n "$NODE_BIN" ]] || { echo "✖ node not found in PATH"; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

# Service-account key → durable Firestore auth that NEVER expires (gcloud user
# ADC expires every few hours with invalid_rapt, stalling the snapshot). Prefer
# an explicit GOOGLE_APPLICATION_CREDENTIALS; else auto-detect a downloaded
# Firebase Admin SDK key in common locations.
SA_KEY="${GOOGLE_APPLICATION_CREDENTIALS:-}"
if [[ -z "$SA_KEY" ]]; then
  for f in "$HOME/Documents/GCP_憑證檔案"/tw-stock-helper-firebase-adminsdk-*.json "$HOME/.config/gcloud/tw-stock-sa.json"; do
    [[ -f "$f" ]] && { SA_KEY="$f"; break; }
  done
fi
GAC_LINE=""
if [[ -n "$SA_KEY" && -f "$SA_KEY" ]]; then
  GAC_LINE="    <key>GOOGLE_APPLICATION_CREDENTIALS</key><string>$SA_KEY</string>"
  echo "  ✓ service-account key (durable auth): $SA_KEY"
else
  echo "  ⚠ no service-account key found — falling back to gcloud ADC (expires periodically)"
fi

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>--env-file=.env.local</string>
    <string>scripts/ai-daemon.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/ai-daemon.out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/ai-daemon.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
$GAC_LINE
  </dict>
</dict>
</plist>
PLISTEOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "✓ Installed & started $LABEL"
echo "  plist: $PLIST"
echo "  node:  $NODE_BIN"
echo "  logs:  $LOG_DIR/ai-daemon.{out,err}.log"
echo "  status: launchctl list | grep $LABEL"
