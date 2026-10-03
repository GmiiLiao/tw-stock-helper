// 重啟前的「上游故障中」掃描（2026-10-03）：daemon 有些後備是**程序記憶體**的 stale-if-error 快取，
//   上游故障期間重啟＝快取蒸發。實案：本機 DNS 解析不到 www.tpex.org.tw，13:50 重啟後全站上櫃整批消失。
//   掃 daemon 日誌最近 windowMs 內的「正在靠快取／後備撐著」訊息；有就不該重啟（除非明確 --ack-outage）。
export const OUTAGE_RE = /stale-if-error|沿用上一份快取|完全無來源|改用本地備份|宇宙殘缺|鏡像重試 \d+ 次仍失敗/;

/** 日誌全文 → 最近 windowMs 內符合的行（行首須為 ISO 時間戳） */
export function recentOutageLines(text, nowMs, windowMs = 15 * 60000) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (nowMs - t <= windowMs && t <= nowMs + 60000 && OUTAGE_RE.test(line)) out.push(line);
  }
  return out;
}
