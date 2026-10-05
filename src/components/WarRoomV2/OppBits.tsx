'use client';

// B1 盤中機會榜的共用小元件與標記（桌機表格與手機卡片共用）。
// 沖＝交易所當沖名單（useDayTradeCodes；未載入不標）；風險＝注意／處置（useRiskCodes；未載入不標）；☆＝在你的自選。
import { useMemo, type MouseEvent } from 'react';
import { useAppStore } from '@/lib/store';
import { useDayTradeCodes, statusOf, type DayTradeStatus } from '@/lib/useDayTradeCodes';
import { useRiskCodes, isDispositionPending, shortRiskDate, type RiskInfo } from '@/lib/useRiskCodes';
import {
  RADAR_STRAT_GLYPH, RADAR_STRAT_NAME, shortGlyphs, type RadarStratKey,
} from '../../../scripts/lib/warroom-b1-view.mjs';
import type { B1Limit, B1Market, FadeTier } from '@/lib/warroom/build-b1';
import { Badge, Indicative } from './parts/Badge';
import { fmtPrice } from './parts/fmt';
import styles from './WarRoomV2.module.css';
import css from './ZoneOpportunity.module.css';

export interface RiskMark { text: '處' | '注'; title: string }

export interface OppMarks {
  /** 當沖狀態：1 可現股當沖、2 僅先買後賣、0 不在名單；名單未載入回 null（不可當成「不可當沖」） */
  dt: (code: string) => DayTradeStatus | null;
  risk: (code: string) => RiskMark | null;
  watched: (code: string) => boolean;
  /** 處置已生效（做空清單再擋一次：交易所當沖名單在處置生效前一天仍列為可當沖） */
  dispActive: (code: string) => boolean;
}

function riskMarkOf(r: RiskInfo, code: string): RiskMark | null {
  if (!r.loaded) return null;
  const inDisp = r.disposition.has(code);
  const pending = inDisp && isDispositionPending(r, code);
  if (inDisp && !pending) {
    const until = shortRiskDate(r.dispEnd.get(code));
    return { text: '處', title: `處置股票${until ? `，處置至 ${until}` : ''}（交易受限）` };
  }
  if (pending) return { text: '注', title: `已公告處置，${shortRiskDate(r.dispStart.get(code))} 起（生效前仍為注意股）` };
  if (r.attention.has(code)) {
    const until = shortRiskDate(r.attEnd.get(code));
    return { text: '注', title: `注意股票（交易異常警示）${until ? `，至 ${until}` : ''}` };
  }
  return null;
}

export function useOppMarks(): OppMarks {
  const dt = useDayTradeCodes();
  const risk = useRiskCodes();
  const watchlist = useAppStore(s => s.watchlist);
  const groups = useAppStore(s => s.watchlistGroups);
  const watchSet = useMemo(() => {
    const set = new Set<string>();
    for (const w of watchlist ?? []) if (w?.code) set.add(w.code);
    for (const g of groups ?? []) for (const w of g?.stocks ?? []) if (w?.code) set.add(w.code);
    return set;
  }, [watchlist, groups]);
  return useMemo<OppMarks>(() => ({
    dt: code => statusOf(dt, code),
    risk: code => riskMarkOf(risk, code),
    watched: code => watchSet.has(code),
    dispActive: code => risk.loaded && risk.disposition.has(code) && !isDispositionPending(risk, code),
  }), [dt, risk, watchSet]);
}

const DT_TITLE: Record<DayTradeStatus, string> = {
  1: '可現股當沖（先買後賣、先賣後買皆可）',
  2: '僅先買後賣（交易所暫停先賣後買）',
  0: '不在交易所當沖名單：不可現股當沖',
};

/** 沖／風險徽章 */
export function DtRiskBadges({ code, marks }: { code: string; marks: OppMarks }) {
  const st = marks.dt(code);
  const rk = marks.risk(code);
  return (
    <span className={css.badges}>
      {st != null && <Badge tone={st === 0 ? 'plain' : 'dt'} title={DT_TITLE[st]}>{st === 0 ? '非沖' : '沖'}</Badge>}
      {rk && <Badge tone="risk" title={rk.title}>{rk.text}</Badge>}
    </span>
  );
}

/** 點代號＝開個股頁（不觸發整列的開抽屜） */
export function CodeButton({ code }: { code: string }) {
  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    useAppStore.getState().navigateTo('stock', code);
  };
  return <button type="button" className={css.codeBtn} onClick={onClick} title="開個股頁">{code}</button>;
}

export function MarketTag({ market }: { market: B1Market | null }) {
  if (!market) return null;
  return <span className={styles.mkt}>{market === 'otc' ? '櫃' : '市'}</span>;
}

/** 價格格：漲停紅底、跌停綠底實心格；收盤競價斜體標「指」 */
export function PriceCell({ price, code, limit, indicative }: { price: number; code: string; limit: B1Limit; indicative: boolean }) {
  const txt = fmtPrice(price, code);
  if (limit === 'up') return <span className={styles.limitCell} title="漲停">{txt}</span>;
  if (limit === 'down') return <span className={styles.limitDnCell} title="跌停">{txt}</span>;
  if (indicative) return <Indicative>{txt}</Indicative>;
  return <>{txt}</>;
}

/** 日內位置條（0＝今日最低、1＝今日最高） */
export function PosBar({ pos }: { pos: number | null }) {
  if (pos == null) return <span className={styles.muted}>—</span>;
  const pct = Math.round(pos * 100);
  return (
    <span className={css.posbar} role="img" aria-label={`日內位置 ${pct}%`} title={`日內位置 ${pos.toFixed(2)}（0＝今日最低、1＝今日最高）`}>
      <i style={{ left: `calc(${pct}% - 2px)` }} />
    </span>
  );
}

export function LongGlyphs({ hits }: { hits: readonly RadarStratKey[] }) {
  return <>{hits.map(k => <span key={k} className={css.st} title={RADAR_STRAT_NAME[k]}>{RADAR_STRAT_GLYPH[k]}</span>)}</>;
}

export function ShortGlyphs({ tier, pattern, also, title }: { tier: FadeTier; pattern: string; also: readonly string[]; title?: string }) {
  return (
    <span title={title}>
      <span className={tier === 'A' ? css.tier : `${css.tier} ${css.tierB}`}>{tier}</span>
      {shortGlyphs({ pattern, also }).map(g => <span key={g} className={`${css.st} ${css.stShort}`}>{g}</span>)}
    </span>
  );
}

/** 量比：'2.4'；缺值 '—' */
export function fmtVol(v: number | null): string {
  return v == null ? '—' : v.toFixed(1);
}
