// 判讀欄位通用列（2026-10-08 hardcoded-to-real-spec §3.3）：左欄名、右「值＋狀態字」，下方提示／依據／揭露。
// ⚠ 前端不得自行決定方向字或補預設值——一切文字由 server 的 Reading 提供（src/lib/stock-readings.ts）。
//   reading 不存在（舊 JSON、讀取失敗）一律顯示「暫時無法取得」，不退回讀 legacy 鍵。
// ⚠ 手機 375px：label 與值可換行，不對整段 nowrap。
import { READING_TEXT, toneOf, type Reading } from '@/lib/stock-readings';

interface ReadingRowProps {
  reading: Reading | null | undefined;
  /** reading 不存在時的欄名 */
  fallbackLabel?: string;
  /** 最後一列不畫底線 */
  last?: boolean;
  /** 只在這個畫面成立的附註（例：個股頁「當日籌碼判讀見頁首」——趨勢面板沒有頁首籌碼判讀，所以不放共用 hint） */
  note?: string;
}

export default function ReadingRow({ reading, fallbackLabel, last = false, note }: ReadingRowProps) {
  const label = reading?.label ?? fallbackLabel ?? '判讀';
  const stateText = reading?.stateText ?? READING_TEXT.unavailable.stateText;
  const hint = reading?.hint ?? READING_TEXT.unavailable.hint;
  const tone = reading ? toneOf(reading.state, reading.palette) : 'var(--text-muted)';
  return (
    <div style={{ padding: '10px 0', borderBottom: last ? 'none' : '1px solid var(--border-primary)', minWidth: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: '4px 12px' }}>
        <span style={{ fontSize: 'calc(13.5px * var(--fz))', fontWeight: 600, color: 'var(--text-secondary)' }}>{label}</span>
        <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '4px 8px', alignItems: 'baseline', justifyContent: 'flex-end', minWidth: 0 }}>
          {reading?.value && (
            <span style={{ fontSize: 'calc(13.5px * var(--fz))', fontWeight: 700, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
              {reading.value}
            </span>
          )}
          <span style={{
            fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, color: tone,
            padding: '1px 8px', borderRadius: '999px', border: '1px solid currentColor',
            overflowWrap: 'anywhere',
          }}>
            {stateText}
          </span>
        </span>
      </div>
      <div style={{ marginTop: '4px', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.55, whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>
        {hint}{reading && note ? `\n${note}` : ''}
      </div>
      {reading?.basis && (
        <div style={{ marginTop: '3px', fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.5, opacity: 0.85, overflowWrap: 'anywhere' }}>
          依據：{reading.basis}
        </div>
      )}
      {reading?.caveat && (
        <div style={{ marginTop: '3px', fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.5, fontStyle: 'italic', opacity: 0.85, overflowWrap: 'anywhere' }}>
          {reading.caveat}
        </div>
      )}
    </div>
  );
}
