'use client';

// ── 上櫃收盤第三方後備的來源註記（使用者 2026-10-09 裁定 A）──────────────────
// 只在「這份數據真的用到後備」時出現一行小字；官方資料時回傳 null、不佔版面。
// 來源字樣全站只准出現在這個檔案（scripts/lib/otc-source-note.test.mjs 會掃）。
// source 一律由同一份數據算出（API 回應的 otcSource、allStocks 的 otcGrade、盤勢報告 meta.otc），不另存狀態。
import { shouldShowOtcNote, type OtcSource } from '@/lib/otc-source';

export default function ThirdPartyNote({ source }: { source: OtcSource | null | undefined }) {
  if (!shouldShowOtcNote(source)) return null;
  return (
    <div
      title={source?.dataDate ? `上櫃收盤資料日 ${source.dataDate}` : undefined}
      style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.5, padding: '2px 4px' }}
    >
      部分上櫃資料來源：FinMind
    </div>
  );
}
