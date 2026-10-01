'use client';

// ── 全站共用：個股的「當沖資格」標示 ────────────────────────────────
// 使用者要求（2026-08-27）：依 TWSE 規定把可當沖股票與型態標示出來，避免因為
// 對不可當沖的股票下當沖單而構成違規。三種狀態全標（使用者指定）。
//
// 兩種用法：
//   <DayTradeBadge code="2330" />            → 徽章（名稱旁）
//   style={{ background: dayTradeTint(st) }} → 底色（表格列／卡片）
//
// ⚠ 名單未載入時 useDayTradeStatus 回 null，此元件回 null 不佔版面——
//   絕不可把「還沒載入」畫成「不可當沖」（見 useDayTradeCodes 的說明）。
import { useDayTradeStatus, statusOf, DT_STYLE, type DayTradeStatus, type DayTradeInfo } from '@/lib/useDayTradeCodes';

export default function DayTradeBadge({ code, size = 'sm' }: { code: string; size?: 'sm' | 'xs' }) {
  const st = useDayTradeStatus(code);
  if (st == null) return null;
  return <DayTradeMark status={st} size={size} />;
}

/** 列表用：外層已經拿到整份名單時用這支，避免每列各跑一次 hook。 */
export function DayTradeMark({ status, size = 'sm' }: { status: DayTradeStatus; size?: 'sm' | 'xs' }) {
  const s = DT_STYLE[status];
  const fs = 'calc(12.5px * var(--fz))';   // 2026-10-01 全站字級下限：原 9.5/11 寫死未乘 --fz，xs/sm 一律 12.5px
  return (
    <span
      title={s.title}
      style={{
        fontSize: fs, fontWeight: 700, color: s.fg, background: s.bg,
        border: `1px solid ${s.border}`, padding: size === 'xs' ? '0px 4px' : '1px 6px',
        borderRadius: 4, whiteSpace: 'nowrap',
      }}
    >
      {size === 'xs' ? s.short : s.label}
    </span>
  );
}

/** 表格列／卡片的底色。未載入（null）回 undefined，維持原本背景。 */
export function dayTradeTint(status: DayTradeStatus | null): string | undefined {
  return status == null ? undefined : DT_STYLE[status].bg;
}

/** 列表情境的便利包裝：把整份名單與 code 丟進來即可。 */
export function dayTradeTintOf(info: DayTradeInfo, code: string): string | undefined {
  return dayTradeTint(statusOf(info, code));
}
