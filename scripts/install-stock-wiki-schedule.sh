#!/usr/bin/env bash
# ============================================================
# 安裝台股 wiki 排程（兩個 LaunchAgent，都不是常駐、跑完即結束）
#   com.gmii.twstock.wiki-nightly  每晚 23:40：年報逐步覆蓋＋重建
#   com.gmii.twstock.wiki-monthly  每月 1 日 20:30：重抓官方慢變數＋重建
#
#   bash scripts/install-stock-wiki-schedule.sh             # 安裝
#   bash scripts/install-stock-wiki-schedule.sh --uninstall # 移除
# 與 ai-daemon 完全分開：不重啟、不修改 daemon。以 node 直接執行（同 daemon；bash 讀 ~/Documents 可能被 TCC 擋）。
# 驗證：bash scripts/install-stock-wiki-schedule.sh && launchctl kickstart gui/$(id -u)/com.gmii.twstock.wiki-build-test（見下方 --test）
# ============================================================
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$HOME/Library/Logs/twstock-stock-wiki"   # 不放 ~/Documents（launchd TCC，見 install-ai-daemon.sh）
NODE_BIN="$(command -v node)"
NODE_DIR="$(dirname "$NODE_BIN")"
mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

write_plist() {   # label mode calendar-xml
  local label="$1" mode="$2" cal="$3" plist="$HOME/Library/LaunchAgents/$1.plist"
  cat > "$plist" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>$NODE_BIN</string><string>scripts/stock-wiki-nightly.mjs</string><string>$mode</string></array>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>StartCalendarInterval</key>
  $cal
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

if [[ "${1:-}" == "--test" ]]; then
  # 一次性測試：以 build 模式（只重建、零上游）經 launchd 跑一次，確認權限與路徑
  write_plist com.gmii.twstock.wiki-build-test build '<dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>4</integer><key>Month</key><integer>2</integer><key>Day</key><integer>30</integer></dict>'
  launchctl kickstart "gui/$(id -u)/com.gmii.twstock.wiki-build-test"
  echo "已觸發，看 $LOG_DIR/build.log；確認後 launchctl unload ~/Library/LaunchAgents/com.gmii.twstock.wiki-build-test.plist && rm 之"
  exit 0
fi
if [[ "${1:-}" == "--uninstall" ]]; then
  for l in com.gmii.twstock.wiki-nightly com.gmii.twstock.wiki-monthly; do
    launchctl unload "$HOME/Library/LaunchAgents/$l.plist" 2>/dev/null || true; rm -f "$HOME/Library/LaunchAgents/$l.plist"; echo "  ✓ 移除 $l"
  done
  exit 0
fi
write_plist com.gmii.twstock.wiki-nightly nightly '<dict><key>Hour</key><integer>23</integer><key>Minute</key><integer>40</integer></dict>'
write_plist com.gmii.twstock.wiki-monthly monthly '<dict><key>Day</key><integer>1</integer><key>Hour</key><integer>20</integer><key>Minute</key><integer>30</integer></dict>'
echo "日誌：$LOG_DIR"
