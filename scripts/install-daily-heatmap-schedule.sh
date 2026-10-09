#!/usr/bin/env bash
# ============================================================
# 安裝每日熱力排程（兩個 LaunchAgent，跑完即結束，與 ai-daemon 完全分開）
#   com.gmii.twstock.daily-heatmap-poll   週一～五 22:45 起：先等官方鏡像 daily（22:40）跑完再輪詢（避開 daemon 21:40–22:35 窗）
#   com.gmii.twstock.daily-heatmap-retry  週二～六 06:50 補班（接鏡像 retry 06:45）
#   bash scripts/install-daily-heatmap-schedule.sh             # 安裝
#   bash scripts/install-daily-heatmap-schedule.sh --uninstall # 移除
# 以 node 直接執行（bash 讀 ~/Documents 可能被 TCC 擋）；日誌放 ~/Library/Logs。
# ============================================================
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$HOME/Library/Logs/twstock-daily-heatmap"
NODE_BIN="$(command -v node)"; NODE_DIR="$(dirname "$NODE_BIN")"
mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

cal() {   # 參數：Hour Minute weekday...
  local h="$1" m="$2"; shift 2; local out="<array>"
  for w in "$@"; do out+="<dict><key>Weekday</key><integer>$w</integer><key>Hour</key><integer>$h</integer><key>Minute</key><integer>$m</integer></dict>"; done
  echo "$out</array>"
}
write_plist() {   # label mode calendar-xml
  local label="$1" mode="$2" calx="$3" plist="$HOME/Library/LaunchAgents/$1.plist"
  cat > "$plist" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>$NODE_BIN</string><string>scripts/daily-heatmap-run.mjs</string><string>$mode</string></array>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>StartCalendarInterval</key>
  $calx
  <key>StandardOutPath</key><string>$LOG_DIR/$mode.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/$mode.err.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$NODE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
</dict>
</plist>
PLISTEOF
  launchctl unload "$plist" 2>/dev/null || true
  launchctl load "$plist"
  echo "  ✓ $label"
}
if [[ "${1:-}" == "--uninstall" ]]; then
  for l in com.gmii.twstock.daily-heatmap-poll com.gmii.twstock.daily-heatmap-retry; do
    launchctl unload "$HOME/Library/LaunchAgents/$l.plist" 2>/dev/null || true; rm -f "$HOME/Library/LaunchAgents/$l.plist"; echo "  ✓ 移除 $l"
  done; exit 0
fi
write_plist com.gmii.twstock.daily-heatmap-poll  poll  "$(cal 22 45 1 2 3 4 5)"
write_plist com.gmii.twstock.daily-heatmap-retry retry "$(cal 6 50 2 3 4 5 6)"
echo "日誌：$LOG_DIR"
