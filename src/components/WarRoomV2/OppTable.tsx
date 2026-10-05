'use client';

// B1 盤中機會榜·桌機表格（做多＝雷達合併；做空＝轉空 A／B 級觀察）。
// 區塊高度固定、內部不捲動：依實際可用高度只畫放得下的列（ResizeObserver），其餘用「全部 →」開放大層。
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { FADE_PATTERNS } from '@/lib/fade-patterns';
import type { B1LongRow, B1ShortRow } from '@/lib/warroom/build-b1';
import {
  RADAR_STRAT_NAME, isConsensus, isNewRow, minutesOnBoard, type B1Extra,
} from '../../../scripts/lib/warroom-b1-view.mjs';
import { Badge, NewTag } from './parts/Badge';
import { fmtPct, toneClass } from './parts/fmt';
import {
  CodeButton, DtRiskBadges, LongGlyphs, MarketTag, PosBar, PriceCell, ShortGlyphs, fmtVol, type OppMarks,
} from './OppBits';
import styles from './WarRoomV2.module.css';
import css from './ZoneOpportunity.module.css';

const ROW_PX = 35;          // --wr-row-h 34px＋1px 底線（量不到列時的後備值）
const FALLBACK_ROWS = 12;   // 528px 區塊在 --fz 1.4 下約 12 列

// 欄寬照 preview renderB1（有時段額外欄時各欄讓一點）
const COLS = ['27%', '11%', '14%', '13%', '9%', '14%', '12%'];
const COLS_EXTRA = ['24%', '10%', '13%', '12%', '8%', '13%', '9%', '11%'];

const PATTERN_INFO = new Map(FADE_PATTERNS.map(p => [p.key, p]));

/** 量容器高度，算出放得下幾列 */
function useFitRows(hasRows: boolean): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState(FALLBACK_ROWS);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const head = el.querySelector('thead');
      const row = el.querySelector('tbody tr');
      const rowH = row ? row.getBoundingClientRect().height || ROW_PX : ROW_PX;
      const avail = el.clientHeight - (head ? head.getBoundingClientRect().height : 0);
      const n = Math.max(1, Math.floor((avail + 0.5) / rowH));
      setFit(prev => (prev === n ? prev : n));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasRows]);
  return [ref, fit];
}

function rowKeys(onOpen: (code: string) => void, code: string) {
  return {
    tabIndex: 0,
    onClick: () => onOpen(code),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(code); }
    },
  };
}

interface Common {
  extra: B1Extra;
  marks: OppMarks;
  /** 收盤競價：價格斜體標「指」 */
  indicative: boolean;
  onOpen: (code: string) => void;
}

function ExtraHead({ extra }: { extra: B1Extra }) {
  if (extra === 'gap') return <th title="開盤價相對昨收">缺口</th>;
  if (extra === 'tp') return <th title="日內位置（0＝今日最低、1＝今日最高）">尾盤位置</th>;
  return null;
}

function ExtraCell({ extra, gap, pos }: { extra: B1Extra; gap: number | null; pos: number | null }) {
  if (extra === 'gap') return <td className={toneClass(gap)}>{fmtPct(gap, 1)}</td>;
  if (extra === 'tp') return <td>{pos == null ? '—' : pos.toFixed(2)}</td>;
  return null;
}

function Head({ extra, last }: { extra: B1Extra; last: string }) {
  const cols = extra ? COLS_EXTRA : COLS;
  return (
    <>
      <colgroup>{cols.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
      <thead>
        <tr>
          <th>個股</th>
          <th className={styles.left}>沖／風險</th>
          <th>價</th>
          <th>漲跌</th>
          <th title="量比為線性估計（已過時段比例校正，早盤有偏差）">量比</th>
          <th>日內位置</th>
          <ExtraHead extra={extra} />
          <th className={styles.left}>{last}</th>
        </tr>
      </thead>
    </>
  );
}

export function LongTable({ rows, gold, now, asOf, ...c }: Common & {
  rows: readonly B1LongRow[]; gold: ReadonlySet<string>; now: number; asOf: number | null;
}) {
  const [ref, fit] = useFitRows(rows.length > 0);
  return (
    <div ref={ref} className={css.fill}>
      <table className={styles.table}>
        <Head extra={c.extra} last="策略" />
        <tbody>
          {rows.slice(0, fit).map(r => {
            const cons = isConsensus(r);
            const mins = minutesOnBoard(r.firstSeen, asOf);
            const title = `${r.code} ${r.name}·命中：${r.hits.map(k => RADAR_STRAT_NAME[k]).join('、')}${mins != null ? `·上榜 ${mins} 分` : ''}·點列開快看`;
            return (
              <tr key={r.code} className={gold.has(r.code) ? `${styles.row} ${css.row} ${css.gold}` : `${styles.row} ${css.row}`} title={title} {...rowKeys(c.onOpen, r.code)}>
                <td>
                  {cons && <span className={css.star} aria-label="共識">★</span>}
                  <CodeButton code={r.code} />
                  <span className={styles.name}>{r.name}</span>
                  {c.marks.watched(r.code) && <span className={css.watch} title="在你的自選">☆</span>}
                  {isNewRow(r.firstSeen, now) && <NewTag />}
                  <MarketTag market={r.market} />
                </td>
                <td className={styles.left}><DtRiskBadges code={r.code} marks={c.marks} /></td>
                <td><PriceCell price={r.price} code={r.code} limit={r.limit} indicative={c.indicative} /></td>
                <td className={toneClass(r.chg)}>{fmtPct(r.chg)}</td>
                <td>{fmtVol(r.volX)}</td>
                <td><PosBar pos={r.pos} /></td>
                <ExtraCell extra={c.extra} gap={r.gap} pos={r.pos} />
                <td className={styles.left}><LongGlyphs hits={r.hits} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 型態說明（滑鼠提示）：回放數字來自 fade-patterns 的 FADE_PATTERNS（唯一實作） */
export function shortTitle(r: B1ShortRow): string {
  const main = PATTERN_INFO.get(r.pattern);
  const also = r.also.map(k => PATTERN_INFO.get(k)?.label).filter(Boolean).join('、');
  const vwap = r.aboveVwap == null ? '' : r.aboveVwap ? '·在 VWAP 上' : '·在 VWAP 下';
  const facts = `最高 ${fmtPct(r.hiUp)}·自高點回吐 ${r.give == null ? '—' : r.give.toFixed(1)}${vwap}`;
  return `${r.code} ${r.name}·${r.tier} 級觀察·${main ? `${main.label}（${main.oos}）` : r.pattern}${also ? `＋${also}` : ''}·${facts}·非放空訊號`;
}

export function ShortTable({ rows, ...c }: Common & { rows: readonly B1ShortRow[] }) {
  const [ref, fit] = useFitRows(rows.length > 0);
  return (
    <div ref={ref} className={css.fill}>
      <table className={styles.table}>
        <Head extra={c.extra} last="型態" />
        <tbody>
          {rows.slice(0, fit).map(r => (
            <tr key={r.code} className={`${styles.row} ${css.row}`} title={shortTitle(r)} {...rowKeys(c.onOpen, r.code)}>
              <td>
                <CodeButton code={r.code} />
                <span className={styles.name}>{r.name}</span>
                {c.marks.watched(r.code) && <span className={css.watch} title="在你的自選">☆</span>}
                <span className={css.obs}><Badge title="觀察工具·非放空訊號">觀察</Badge></span>
                <MarketTag market={r.market} />
              </td>
              <td className={styles.left}><DtRiskBadges code={r.code} marks={c.marks} /></td>
              <td><PriceCell price={r.price} code={r.code} limit={r.limit} indicative={c.indicative} /></td>
              <td className={toneClass(r.chg)}>{fmtPct(r.chg)}</td>
              <td>{fmtVol(r.volX)}</td>
              <td><PosBar pos={r.pos} /></td>
              <ExtraCell extra={c.extra} gap={r.gap} pos={r.pos} />
              <td className={styles.left}><ShortGlyphs tier={r.tier} pattern={r.pattern} also={r.also} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
