#!/usr/bin/env bash
# WorldMonitor 每週五 ≥17:00 同步（使用者 2026-09-04 指定，Claude 執行）
#   步驟 1：把 github.com/koala73/worldmonitor 迭代備份到第二大腦（含程式碼，可 fetch 更新）
#   步驟 2：列出「技能依據檔」有無變更 → 決定哪些 .claude/skills/wm-* 要修訂（不機械覆寫）
#   步驟 3：（人工）用更新後的技能正向＋反向掃描全站 → docs/WM-SCAN-<date>.md → 通知使用者
# 淺層 clone 無法跨週 diff，故以「依據檔 blob 清單 + CHANGELOG 副本」自行比對。
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DST="$ROOT/second-brain/worldmonitor"
META="$ROOT/second-brain/worldmonitor-sync.json"
PREV_CHANGELOG="$ROOT/second-brain/worldmonitor-prev-CHANGELOG.md"
PREV_MANIFEST="$ROOT/second-brain/worldmonitor-prev-manifest.txt"
SOURCES="$ROOT/scripts/wm-skill-sources.txt"
URL=https://github.com/koala73/worldmonitor.git

if [ ! -d "$DST/.git" ]; then
  echo "▶ 首次備份：clone --depth 1"; git clone -q --depth 1 "$URL" "$DST"
fi
PREV=$(git -C "$DST" rev-parse --short HEAD)
[ -f "$DST/CHANGELOG.md" ] && cp "$DST/CHANGELOG.md" "$PREV_CHANGELOG"
git -C "$DST" ls-tree -r HEAD --format='%(objectname) %(path)' > "$PREV_MANIFEST.tmp"
grep -vE '^\s*(#|$)' "$SOURCES" | sed 's/[[:space:]]*$//' | awk 'NR==FNR{s[$1]=1;next} ($2 in s)' - "$PREV_MANIFEST.tmp" > "$PREV_MANIFEST"; rm "$PREV_MANIFEST.tmp"

echo "▶ fetch origin/main（淺層）"
git -C "$DST" fetch -q --depth 1 origin main
git -C "$DST" reset -q --hard origin/main
NOW=$(git -C "$DST" rev-parse --short HEAD)
VER=$(node -p "require('$DST/package.json').version")
DATE=$(git -C "$DST" log -1 --format=%cs)
FILES=$(git -C "$DST" ls-files | wc -l | tr -d ' ')

echo "▶ 技能依據檔變更（前次 $PREV → 本次 $NOW）"
git -C "$DST" ls-tree -r HEAD --format='%(objectname) %(path)' > /tmp/wm-now-manifest.txt
CHANGED=0
while read -r src; do
  [ -z "$src" ] && continue
  old=$(awk -v p="$src" '$2==p{print $1}' "$PREV_MANIFEST"); new=$(awk -v p="$src" '$2==p{print $1}' /tmp/wm-now-manifest.txt)
  if [ -z "$new" ]; then echo "  ❌ 消失：$src（技能依據失效，必須修訂）"; CHANGED=$((CHANGED+1))
  elif [ "$old" != "$new" ]; then echo "  ✎ 變更：$src"; CHANGED=$((CHANGED+1)); fi
done < <(grep -vE '^\s*(#|$)' "$SOURCES" | awk '{print $1}')
[ "$CHANGED" = 0 ] && echo "  （依據檔無變更——技能內容本週不需修訂，仍需讀 CHANGELOG 判斷新技術族）"

echo "▶ 技術棧增刪偵測（依賴套件／頂層目錄／lint 閘門／CI workflow）——使用者 2026-09-04：上游增刪技術棧本地技能也要同步"
INV="$ROOT/second-brain/worldmonitor-prev-inventory.txt"
inventory() {
  ( cd "$DST"
    node -e 'const p=require("./package.json");for(const k of Object.keys({...p.dependencies,...p.devDependencies}).sort())console.log("dep "+k);for(const s of Object.keys(p.scripts).filter(s=>/^(lint|check|audit|verify|bundle|agent):?/.test(s)).sort())console.log("gate "+s)'
    git ls-files | awk -F/ 'NF>1{print "dir "$1}' | sort -u
    ls .github/workflows 2>/dev/null | sed 's/^/ci /' ) | sort
}
if [ -f "$INV" ]; then
  inventory > /tmp/wm-inv-now.txt
  ADDED=$(comm -13 "$INV" /tmp/wm-inv-now.txt); REMOVED=$(comm -23 "$INV" /tmp/wm-inv-now.txt)
  [ -n "$ADDED" ] && echo "  ＋新增：" && echo "$ADDED" | sed 's/^/     /'
  [ -n "$REMOVED" ] && echo "  －移除：" && echo "$REMOVED" | sed 's/^/     /'
  [ -z "$ADDED$REMOVED" ] && echo "  （無增刪）"
  echo "  → 有新增：判斷是否構成新技術族，是則新增 .claude/skills/wm-*；有移除：對應技能標退役或刪除（先查本站引用，不要修A錯B）"
  mv /tmp/wm-inv-now.txt "$INV"
else
  inventory > "$INV"; echo "  （首次建立清單，下週起比對）"
fi

echo "▶ CHANGELOG 新增段落"
if [ -f "$PREV_CHANGELOG" ]; then diff "$PREV_CHANGELOG" "$DST/CHANGELOG.md" | sed -n 's/^> /  + /p' | head -80 || true; fi

cat > "$META" <<EOF
{ "syncedAt": "$(date +%FT%T%z)", "version": "$VER", "commit": "$NOW", "prevCommit": "$PREV", "upstreamDate": "$DATE", "files": $FILES, "skillSourcesChanged": $CHANGED }
EOF
echo "▶ 完成：v$VER $NOW（$DATE）$FILES 檔；依據檔變更 $CHANGED → $META"
echo "   下一步：修訂受影響的 .claude/skills/wm-*/SKILL.md（每條改動附上游檔案依據）→ 跑全站正反掃描 → docs/WM-SCAN-$(date +%F).md → 通知使用者等決定"
