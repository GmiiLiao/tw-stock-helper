#!/usr/bin/env bash
# ============================================================
# 安裝／更新第二大腦官方鏡像排程（四個 LaunchAgent，跑完即結束、非常駐）
#   com.gmii.twstock.official-mirror.daily     平日 22:40＋週六 10:00（2026-10-04 由 22:15 改，避開 daemon 21:40–22:35 窗）
#   com.gmii.twstock.official-mirror.retry     週二～週六 06:45
#   com.gmii.twstock.official-mirror.backfill  每晚 23:20＋週末 11:00
#   com.gmii.twstock.official-mirror.ticks     平日 17:10（期交所 30 日逐筆 zip；2026-10-09 新增）
# 範本在 scripts/official-mirror/launchd/*.plist（版控的唯一來源）；本腳本把範本的 WorkingDirectory／node 路徑換成
# 本機實際值後寫進 ~/Library/LaunchAgents，再 unload＋load。與 ai-daemon 完全分開：不重啟、不修改 daemon。
#
#   bash scripts/install-official-mirror-schedule.sh              # 安裝／更新（需要使用者本人執行）
#   bash scripts/install-official-mirror-schedule.sh --dry-run    # 只印出會寫入的內容差異，不寫檔、不 launchctl
#   bash scripts/install-official-mirror-schedule.sh --uninstall  # 移除
# 測試用：LAUNCH_AGENTS_DIR=<暫存目錄> … --no-load（寫到別處、不呼叫 launchctl）
# ============================================================
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$PROJECT_DIR/scripts/official-mirror/launchd"
LA_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LOG_DIR="$HOME/Library/Logs/twstock-official-mirror"   # 不放 ~/Documents（launchd TCC，見 install-ai-daemon.sh）
NODE_BIN="$(command -v node)"
LABELS=(com.gmii.twstock.official-mirror.daily com.gmii.twstock.official-mirror.retry com.gmii.twstock.official-mirror.backfill com.gmii.twstock.official-mirror.ticks)
MODE="install"; LOAD=1; ALLOW_WT=0
for a in "$@"; do
  case "$a" in
    --dry-run) MODE="dry" ;;
    --uninstall) MODE="uninstall" ;;
    --no-load) LOAD=0 ;;
    --allow-worktree) ALLOW_WT=1 ;;
    *) echo "未知參數：$a" >&2; exit 2 ;;
  esac
done

# 只准在主 checkout 安裝（2026-10-04 審查 L4）：WorkingDirectory 取本腳本所在的 repo，在 worktree 執行會讓 LaunchAgent
# 指向之後會被刪掉的 worktree ⇒ 排程靜默失效。git common dir 必須就是 $PROJECT_DIR/.git（realpath 比）。
if [[ "$MODE" != "uninstall" && $ALLOW_WT -eq 0 ]]; then
  common="$(git -C "$PROJECT_DIR" rev-parse --git-common-dir 2>/dev/null || true)"
  [[ -n "$common" && "$common" != /* ]] && common="$PROJECT_DIR/$common"
  real_common="$( [[ -d "$common" ]] && cd "$common" && pwd -P || echo "")"
  real_git="$( [[ -d "$PROJECT_DIR/.git" ]] && cd "$PROJECT_DIR/.git" && pwd -P || echo "")"
  if [[ -z "$real_common" || "$real_common" != "$real_git" ]]; then
    echo "✖ $PROJECT_DIR 不是主 checkout（git common dir＝${real_common:-讀不到}）——LaunchAgent 會指向之後可能被刪的 worktree。" >&2
    echo "  請到主 checkout 執行：cd <主 checkout>/tw-stock-app && bash scripts/install-official-mirror-schedule.sh" >&2
    echo "  （確定要指向這個目錄，加 --allow-worktree）" >&2
    exit 3
  fi
fi

render() {   # 範本 → 本機版：換 WorkingDirectory 與 node 路徑（範本寫的是主 checkout 與 /opt/homebrew/bin/node）
  sed -e "s#<key>WorkingDirectory</key><string>[^<]*</string>#<key>WorkingDirectory</key><string>$PROJECT_DIR</string>#" \
      -e "s#<string>/opt/homebrew/bin/node</string>#<string>$NODE_BIN</string>#" "$1"
}

if [[ "$MODE" == "uninstall" ]]; then
  for l in "${LABELS[@]}"; do
    [[ $LOAD -eq 1 ]] && launchctl unload "$LA_DIR/$l.plist" 2>/dev/null || true
    rm -f "$LA_DIR/$l.plist"; echo "  ✓ 移除 $l"
  done
  exit 0
fi

mkdir -p "$LOG_DIR"
[[ "$MODE" == "install" ]] && mkdir -p "$LA_DIR"
for l in "${LABELS[@]}"; do
  src="$SRC_DIR/$l.plist"; dst="$LA_DIR/$l.plist"
  [[ -f "$src" ]] || { echo "✖ 找不到範本 $src" >&2; exit 1; }
  tmp="$(mktemp)"; render "$src" > "$tmp"
  plutil -lint "$tmp" >/dev/null || { echo "✖ $l 範本轉換後不是合法 plist" >&2; rm -f "$tmp"; exit 1; }
  if [[ "$MODE" == "dry" ]]; then
    echo "── $l（$dst）"
    if [[ -f "$dst" ]]; then diff -u "$dst" "$tmp" || true; else echo "  （尚未安裝，將新建）"; fi
    rm -f "$tmp"; continue
  fi
  [[ $LOAD -eq 1 ]] && launchctl unload "$dst" 2>/dev/null || true
  mv "$tmp" "$dst"
  [[ $LOAD -eq 1 ]] && launchctl load "$dst"
  echo "  ✓ $l"
done
[[ "$MODE" == "install" ]] && echo "日誌：$LOG_DIR；確認：launchctl list | grep official-mirror"
exit 0
