'use client';

// B1 盤中機會榜·手機 52px 兩行卡（第一行：代號 名稱 徽章……價 漲跌；第二行：量比·策略·★共識）。
// 整列點擊＝開底部快看抽屜（＋候選／釘選在抽屜內，避免誤觸）；點擊目標 ≥44px。
import type { KeyboardEvent } from 'react';
import type { B1LongRow, B1ShortRow } from '@/lib/warroom/build-b1';
import { isConsensus, isNewRow, minutesOnBoard } from '../../../scripts/lib/warroom-b1-view.mjs';
import { Badge, NewTag } from './parts/Badge';
import { fmtPct, toneClass } from './parts/fmt';
import { LongGlyphs, PriceCell, ShortGlyphs, fmtVol, type OppMarks } from './OppBits';
import { shortTitle } from './OppTable';
import styles from './WarRoomV2.module.css';
import css from './ZoneOpportunity.module.css';

export const MOBILE_ROWS = 6;

interface Common { marks: OppMarks; indicative: boolean; onOpen: (code: string) => void }

function cardKeys(onOpen: (code: string) => void, code: string) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: () => onOpen(code),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(code); }
    },
  };
}

function RiskBadge({ code, marks }: { code: string; marks: OppMarks }) {
  const rk = marks.risk(code);
  return rk ? <Badge tone="risk" title={rk.title}>{rk.text}</Badge> : null;
}

export function LongCards({ rows, now, asOf, ...c }: Common & { rows: readonly B1LongRow[]; now: number; asOf: number | null }) {
  return (
    <>
      {rows.slice(0, MOBILE_ROWS).map(r => {
        const cons = isConsensus(r);
        const mins = minutesOnBoard(r.firstSeen, asOf);
        return (
          <div key={r.code} className={`${styles.card} ${css.card}`} aria-label={`${r.code} ${r.name}，開快看`} {...cardKeys(c.onOpen, r.code)}>
            <div className={styles.cardA}>
              {cons && <span className={css.star} aria-label="共識">★</span>}
              <span className={styles.code}>{r.code}</span>
              <span className={styles.name}>{r.name}</span>
              <RiskBadge code={r.code} marks={c.marks} />
              {c.marks.watched(r.code) && <span className={css.watch} title="在你的自選">☆</span>}
              {isNewRow(r.firstSeen, now) && <NewTag />}
              <span className={styles.cardPx}>
                <PriceCell price={r.price} code={r.code} limit={r.limit} indicative={c.indicative} />
                {' '}<span className={toneClass(r.chg)}>{fmtPct(r.chg)}</span>
              </span>
            </div>
            <div className={styles.cardB}>
              <span>量比 {fmtVol(r.volX)}</span>
              <span><LongGlyphs hits={r.hits} /></span>
              {cons && <span>★共識</span>}
              {mins != null && <span className={css.cardTxt}>上榜 {mins} 分</span>}
            </div>
          </div>
        );
      })}
    </>
  );
}

export function ShortCards({ rows, ...c }: Common & { rows: readonly B1ShortRow[] }) {
  return (
    <>
      {rows.slice(0, MOBILE_ROWS).map(r => (
        <div key={r.code} className={`${styles.card} ${css.card}`} title={shortTitle(r)} aria-label={`${r.code} ${r.name}，開快看`} {...cardKeys(c.onOpen, r.code)}>
          <div className={styles.cardA}>
            <span className={styles.code}>{r.code}</span>
            <span className={styles.name}>{r.name}</span>
            <RiskBadge code={r.code} marks={c.marks} />
            <span className={styles.cardPx}>
              <PriceCell price={r.price} code={r.code} limit={r.limit} indicative={c.indicative} />
              {' '}<span className={toneClass(r.chg)}>{fmtPct(r.chg)}</span>
            </span>
          </div>
          <div className={styles.cardB}>
            <Badge title="觀察工具·非放空訊號">觀察</Badge>
            <ShortGlyphs tier={r.tier} pattern={r.pattern} also={r.also} />
            <span>量比 {fmtVol(r.volX)}</span>
            <span className={css.cardTxt}>回吐 {r.give == null ? '—' : r.give.toFixed(1)}</span>
          </div>
        </div>
      ))}
    </>
  );
}
