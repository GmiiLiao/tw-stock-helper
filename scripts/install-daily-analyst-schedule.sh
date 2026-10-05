#!/usr/bin/env bash
# ============================================================
# 安裝每日 AI 分析師團隊排程（兩個 LaunchAgent，跑完即結束，與 ai-daemon 完全分開、不搶鎖）
#   com.gmii.twstock.daily-analyst-evening  週一～五 23:20 起跑（盤後版；腳本內每 10 分鐘輪詢，硬死線 00:30）
#   com.gmii.twstock.daily-analyst-morning  週二～六 06:10 起跑（晨間定版；腳本內每 10 分鐘輪詢，硬死線 07:30）
#
#   bash scripts/install-daily-analyst-schedule.sh             # 安裝
#   bash scripts/install-daily-analyst-schedule.sh --print     # 只印兩份 plist 到 stdout，不寫檔、不 launchctl（檢查用）
#   bash scripts/install-daily-analyst-schedule.sh --uninstall # 移除
#
# 排程方式（擇一並說明）：StartCalendarInterval **只設一個起跑時刻**，輪詢（每 10 分鐘看資料到齊否、到硬死線為止）
#   由 scripts/analyst-desk-run.mjs 自己做——與 daily-heatmap-run.mjs 同型。不用「每 10 分鐘一個 StartCalendarInterval」：
#   一輪 AI 撰稿可能超過 10 分鐘，多個實例會重疊搶同一份定版；單一實例＋內部輪詢天然序列化，且 .lock 另有保護。
#
# 時窗檢查（CLAUDE.md launchd 盤點表）：官方鏡像與 daemon 的禁跑窗是 平日 07:30–15:30、16:25–16:55、21:40–22:35——
#   evening 23:20–00:30、morning 06:10–07:30 皆不在其內。同刻已有：官方鏡像 backfill 23:20、wiki-nightly 23:40、
#   官方鏡像 retry 06:45、熱力 retry 06:50、surge-shadow 07:05（皆為本機檔案／官方鏡像工作，本排程對上游 0 請求，
#   引擎 claude -p 走雲端、不碰 Ollama，所以 daemon 23:00–01:15 的新聞盤後趟與 07:00 晨間趟佔用 Ollama 不影響主引擎）。
# 先決條件：官方鏡像 daily 22:40 與熱力 poll 22:30 起已安裝；`claude` 已登入（claude -p 可用）；plist 的 PATH 含 claude 所在目錄。
# 以 node 直接執行（bash 讀 ~/Documents 可能被 TCC 擋）；日誌放 ~/Library/Logs。
# ============================================================
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$HOME/Library/Logs/twstock-daily-analyst"
NODE_BIN="$(command -v node)"; NODE_DIR="$(dirname "$NODE_BIN")"
CLAUDE_BIN="$(command -v claude || true)"
CLAUDE_DIR="${CLAUDE_BIN:+$(dirname "$CLAUDE_BIN")}"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.local/bin}"        # 找不到時退回 Claude Code 預設安裝位置（plist 仍含它）
AGENTS="$HOME/Library/LaunchAgents"
LABEL_EVE="com.gmii.twstock.daily-analyst-evening"
LABEL_MOR="com.gmii.twstock.daily-analyst-morning"

cal() {   # 參數：Hour Minute weekday...
  local h="$1" m="$2"; shift 2; local out="<array>"
  for w in "$@"; do out+="<dict><key>Weekday</key><integer>$w</integer><key>Hour</key><integer>$h</integer><key>Minute</key><integer>$m</integer></dict>"; done
  echo "$out</array>"
}
plist_xml() {   # label edition calendar-xml
  local label="$1" edition="$2" calx="$3"
  cat <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>$NODE_BIN</string><string>scripts/analyst-desk-run.mjs</string><string>$edition</string></array>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>StartCalendarInterval</key>
  $calx
  <key>StandardOutPath</key><string>$LOG_DIR/$edition.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/$edition.err.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$CLAUDE_DIR:$NODE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
</dict>
</plist>
PLISTEOF
}
install_one() {   # label edition calendar-xml
  local plist="$AGENTS/$1.plist"
  plist_xml "$1" "$2" "$3" > "$plist"
  launchctl unload "$plist" 2>/dev/null || true
  launchctl load "$plist"
  echo "  ✓ $1"
}
EVE_CAL="$(cal 23 20 1 2 3 4 5)"
MOR_CAL="$(cal 6 10 2 3 4 5 6)"

if [[ "${1:-}" == "--print" ]]; then
  plist_xml "$LABEL_EVE" evening "$EVE_CAL"; echo; plist_xml "$LABEL_MOR" morning "$MOR_CAL"; exit 0
fi
if [[ "${1:-}" == "--uninstall" ]]; then
  for l in "$LABEL_EVE" "$LABEL_MOR"; do
    launchctl unload "$AGENTS/$l.plist" 2>/dev/null || true; rm -f "$AGENTS/$l.plist"; echo "  ✓ 移除 $l"
  done; exit 0
fi
mkdir -p "$AGENTS" "$LOG_DIR"
[[ -n "$CLAUDE_BIN" ]] || echo "  ⚠ 找不到 claude 指令（PATH 退回 $CLAUDE_DIR）——請確認 claude -p 可用，否則引擎會降級"
install_one "$LABEL_EVE" evening "$EVE_CAL"
install_one "$LABEL_MOR" morning "$MOR_CAL"
echo "日誌：$LOG_DIR"
