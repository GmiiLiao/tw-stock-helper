'use client';

// A2 盤中「當沖觀察」（09:30–12:45）與尾盤「當沖成立中＋撿尾盤」（12:45–13:25）。
// 當沖觀察：daytradeAlerts/live 多空各前 5「成立中／剛出場」（成立中優先）；等待條件只顯示筆數；每列標「觀察」。
//   回放扣成本後為負 ⇒ 一律是觀察工具、不是買賣訊號（頁尾寫明）。完整工作台在放大層（全部 →）。
// 尾盤：當沖成立中置頂到 13:20（13:10 起顯示平倉倒數），下面是撿尾盤候選 marketPattern/latest.tailPicks（12:45 起產出）。
import { useMemo, type ReactNode } from 'react';
import { focusPartActive, FOCUS_WINDOW } from '../../../scripts/lib/warroom-focus-codec.mjs';
import type { Section } from '@/lib/warroom/types';
import type { FocusData, FocusDtRow, FocusTailItem } from '@/lib/warroom/build-focus';
import { useWarData, useWarUi } from './WarRoomContext';
import Stamp from './parts/Stamp';
import { Badge } from './parts/Badge';
import { MoreButton } from './parts/Chip';
import { fmtPct, fmtPrice, toneClass, hhmm } from './parts/fmt';
import { FocusFrame, FocusMsg, CodeLink, type FocusShell } from './FocusFrame';
import { useFocusUniverse, type FocusUniverse } from './useFocusUniverse';
import styles from './WarRoomV2.module.css';
import css from './ZoneFocus.module.css';

const DT_ROWS_DESK = 6;
const ROWS_MOBILE = 5;
const TAIL_ROWS_DESK = 5;          // 兩條分組列＋5 列＝328px 區塊放得下
const TAIL_DT_MAX = 2;             // 尾盤段當沖成立中最多佔 2 列
const STOP_KEEP_MS = 15 * 60_000;  // 剛出場保留 15 分（與工作台同口徑；伺服器已篩，這裡依前端時鐘再篩一次）
const DT_FLAT_MIN = 13 * 60 + 20;  // 13:20 當沖平倉
const DT_COUNTDOWN_FROM = 13 * 60 + 10;
const MINUS = '−';

const fmtR = (r: number | null) => (r == null ? '—' : `${r > 0 ? '+' : r < 0 ? MINUS : ''}${Math.abs(r).toFixed(1)}R`);
const sideText = (s: FocusDtRow['side']) => (s === 'long' ? '多' : '空');

/** 成立中（新到舊）在前、剛出場（新到舊）在後 */
function mergeRows(focus: FocusData, now: number): FocusDtRow[] {
  const dt = focus.daytrade && focus.daytrade.ok ? focus.daytrade.data : null;
  if (!dt) return [];
  const all = [...dt.long.rows, ...dt.short.rows].filter((r) => r.phase === 'on' || (r.t != null && now - r.t < STOP_KEEP_MS));
  const on = all.filter((r) => r.phase === 'on').sort((a, b) => (b.since ?? 0) - (a.since ?? 0));
  const out = all.filter((r) => r.phase === 'stop').sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
  return [...on, ...out];
}

function DtTable({ rows, u, onRow }: { rows: FocusDtRow[]; u: FocusUniverse; onRow: (code: string) => void }) {
  return (
    <table className={`${styles.table} ${css.tbl}`}>
      <thead>
        <tr>
          <th className={`${css.wDir} ${css.txtL}`}>向</th>
          <th className={css.wTime}>成立</th>
          <th className={`${css.wStock} ${css.txtL}`}>個股</th>
          <th className={`${css.wType} ${css.colType} ${css.txtL}`}>型態</th>
          <th className={css.wPlan} title="假設進場價／目前停損（1R 後上移）">進場／停損</th>
          <th className={css.wR} title="成立中＝以現價估算、扣成本；出場＝日誌口徑">淨 R</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const on = r.phase === 'on';
          const typeText = on ? r.type ?? '—' : `${sideText(r.side)}·${r.reason ?? '出場'}`;
          const rowTitle = on
            ? `${sideText(r.side)}·${r.type ?? '型態未提供'}·成立 ${r.t != null ? hhmm(r.t) : '—'}`
            : `${typeText}${r.exitPx != null ? ` @${fmtPrice(r.exitPx, r.code)}` : ''}·出場 ${r.t != null ? hhmm(r.t) : '—'}`;
          return (
            <tr key={`${r.side}:${r.code}:${r.phase}`} className={styles.row} onClick={() => onRow(r.code)} title={rowTitle}>
              <td className={css.txtL}>
                {on ? <Badge tone={r.side === 'long' ? 'dt' : 'plain'}>{sideText(r.side)}</Badge> : <Badge>出</Badge>}
              </td>
              <td>{r.t != null ? hhmm(r.t) : '—'}</td>
              <td className={css.txtL}>
                <CodeLink code={r.code} /> <span className={styles.name}>{r.name || u.nameOf(r.code)}</span> <Badge>觀察</Badge>
              </td>
              <td className={`${css.colType} ${css.txtL}`}>{typeText}</td>
              <td>{on ? `${fmtPrice(r.entry, r.code)}／${fmtPrice(r.stop, r.code)}` : r.exitPx != null ? `出 ${fmtPrice(r.exitPx, r.code)}` : '—'}</td>
              <td className={toneClass(r.netR)}>{fmtR(r.netR)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function DtCards({ rows, u, onRow }: { rows: FocusDtRow[]; u: FocusUniverse; onRow: (code: string) => void }) {
  return (
    <>
      {rows.map((r) => {
        const on = r.phase === 'on';
        return (
          <div key={`${r.side}:${r.code}:${r.phase}`} className={styles.card} role="button" tabIndex={0}
            onClick={() => onRow(r.code)} onKeyDown={(e) => { if (e.key === 'Enter') onRow(r.code); }}>
            <div className={styles.cardA}>
              {on ? <Badge tone={r.side === 'long' ? 'dt' : 'plain'}>{sideText(r.side)}</Badge> : <Badge>出</Badge>}
              <CodeLink code={r.code} mobile /><span className={styles.name}>{r.name || u.nameOf(r.code)}</span><Badge>觀察</Badge>
              <span className={`${styles.cardPx} ${toneClass(r.netR)}`}>{fmtR(r.netR)}</span>
            </div>
            <div className={styles.cardB}>
              <span>{r.t != null ? hhmm(r.t) : '—'}</span>
              <span>{on ? r.type ?? '—' : `${sideText(r.side)}·${r.reason ?? '出場'}`}</span>
              {on && <span>進 {fmtPrice(r.entry, r.code)}／停 {fmtPrice(r.stop, r.code)}</span>}
            </div>
          </div>
        );
      })}
    </>
  );
}

/** 共用：part 為 null（不在時窗）／讀取中／錯誤 的訊息；可顯示時回 null */
function partMsg(focus: Section<FocusData> | null | undefined, part: 'daytrade' | 'tail', minute: number, trading: boolean, name: string): ReactNode | null {
  if (!focus) return <FocusMsg big="載入中…" />;
  if (!focus.ok) return <FocusMsg big={focus.error} />;
  const p = focus.data[part];
  if (p) return p.ok ? null : <FocusMsg big={p.error} />;
  return focusPartActive(part, minute, trading)
    ? <FocusMsg big="資料更新中">每 30 秒更新一次</FocusMsg>
    : <FocusMsg big={`${name}於 ${FOCUS_WINDOW[part].label} 提供`}>目前不在提供時段</FocusMsg>;
}

export function FocusDaytradeView({ shell, focus }: { shell: FocusShell; focus: Section<FocusData> | null | undefined }) {
  const { now, clock, segment } = useWarData();
  const { openDrawer, openZoom } = useWarUi();
  const u = useFocusUniverse();
  const mobile = shell.variant === 'mobile';
  const fd = focus?.ok ? focus.data : null;
  const dt = fd?.daytrade && fd.daytrade.ok ? fd.daytrade.data : null;
  const rows = useMemo(() => (fd ? mergeRows(fd, now) : []), [fd, now]);
  const wait = dt ? dt.long.wait + dt.short.wait : 0;
  const monitored = dt ? dt.long.monitored + dt.short.monitored : 0;
  const max = mobile ? ROWS_MOBILE : DT_ROWS_DESK;

  let body: ReactNode = partMsg(focus, 'daytrade', clock.minute, segment !== 'nontrading', '當沖觀察');
  if (!body) {
    if (!dt || dt.date !== clock.ymd) body = <FocusMsg big="今日當沖觀察尚未產生">09:00 起由當沖工作台每分鐘評估</FocusMsg>;
    else if (!rows.length) body = <FocusMsg big="目前沒有成立中或剛出場的觀察">監控 {monitored} 檔·等待條件 {wait} 筆</FocusMsg>;
    else body = mobile ? <DtCards rows={rows.slice(0, max)} u={u} onRow={openDrawer} /> : <DtTable rows={rows.slice(0, max)} u={u} onRow={openDrawer} />;
  }
  const hidden = Math.max(0, rows.length - max);
  const foot = (
    <>
      <span className={css.footTxt}>觀察工具·回放扣成本為負·非買賣訊號·等待條件 {wait} 筆{hidden ? `·另 ${hidden} 列` : ''}</span>
      <MoreButton onClick={() => openZoom('daytrade')} />
    </>
  );
  return (
    <FocusFrame shell={shell} kind="daytrade" stamp={<Stamp kind="list" asOf={fd?.daytrade && fd.daytrade.ok ? fd.daytrade.asOf : null} openOnly />} foot={foot}>
      {body}
    </FocusFrame>
  );
}

function tailNote(x: FocusTailItem): string {
  if (x.fStreak != null && x.fStreak > 0) return `外資◆連買${x.fStreak}`;
  if (x.volX != null) return `量 ×${x.volX.toFixed(1)}`;
  return x.char ?? '—';
}

export function FocusTailView({ shell, focus }: { shell: FocusShell; focus: Section<FocusData> | null | undefined }) {
  const { now, clock, segment } = useWarData();
  const { openDrawer, openZoom } = useWarUi();
  const u = useFocusUniverse();
  const mobile = shell.variant === 'mobile';
  const trading = segment !== 'nontrading';
  const fd = focus?.ok ? focus.data : null;
  const minute = clock.minute;
  const showDt = minute < DT_FLAT_MIN;
  const dtOn = useMemo(() => (fd && showDt ? mergeRows(fd, now).filter((r) => r.phase === 'on') : []), [fd, now, showDt]);
  const tailSec = fd?.tail ?? null;
  const tail = tailSec && tailSec.ok ? tailSec.data : null;
  const tailToday = tail && tail.date === clock.ymd ? tail : null;
  const countdown = minute >= DT_COUNTDOWN_FROM && minute < DT_FLAT_MIN ? `·距平倉 ${Math.ceil(DT_FLAT_MIN - minute)} 分` : '';

  const dtShown = dtOn.slice(0, mobile ? 2 : TAIL_DT_MAX);
  // 桌機 328px：兩條分組列＋5 列；13:20 後只剩一條分組列 ⇒ 6 列；當沖空著時那條「目前沒有」佔掉一列
  const tailMax = mobile ? ROWS_MOBILE - dtShown.length
    : showDt ? TAIL_ROWS_DESK - dtShown.length - (dtShown.length ? 0 : 1) : TAIL_ROWS_DESK + 1;
  const picks = tailToday ? tailToday.items.slice(0, Math.max(0, tailMax)) : [];
  const dtHeader = `當沖成立中（置頂到 13:20${countdown}）${dtOn.length > dtShown.length ? `·共 ${dtOn.length} 筆` : ''}`;
  const tailHeader = `撿尾盤候選（破 20 日高 × 位置 ≥0.7 × 漲 3–7%）${tailToday ? `·共 ${tailToday.total} 檔${tailToday.locked ? `·鎖漲停 ${tailToday.locked} 檔未列` : ''}` : ''}`;
  const tailEmpty = !tailSec ? (focusPartActive('tail', minute, trading) ? '資料更新中（每 30 秒）' : `撿尾盤於 ${FOCUS_WINDOW.tail.label} 提供`)
    : !tailSec.ok ? tailSec.error
      : !tailToday ? '12:45 起產出今日候選（約每 1–2 分鐘更新）'
        : !tailToday.items.length ? '目前沒有符合條件的個股' : null;

  let body: ReactNode;
  if (!focus) body = <FocusMsg big="載入中…" />;
  else if (!focus.ok) body = <FocusMsg big={focus.error} />;
  else if (mobile) {
    body = (
      <>
        {showDt && <div className={css.notice}>{dtHeader}</div>}
        {showDt && (dtShown.length ? <DtCards rows={dtShown} u={u} onRow={openDrawer} /> : <div className={`${css.notice} ${styles.muted}`}>目前沒有成立中的當沖觀察</div>)}
        <div className={css.notice}>{tailHeader}</div>
        {tailEmpty ? <div className={`${css.notice} ${styles.muted}`}>{tailEmpty}</div> : picks.map((x) => (
          <div key={x.code} className={styles.card} role="button" tabIndex={0} onClick={() => openDrawer(x.code)} onKeyDown={(e) => { if (e.key === 'Enter') openDrawer(x.code); }}>
            <div className={styles.cardA}>
              <CodeLink code={x.code} mobile /><span className={styles.name}>{x.name || u.nameOf(x.code)}</span>
              <span className={styles.cardPx}>{fmtPrice(x.px, x.code)}</span>
              <span className={`${styles.mono} ${toneClass(x.chg)}`}>{fmtPct(x.chg)}</span>
            </div>
            <div className={styles.cardB}><span>位置 {x.pos != null ? x.pos.toFixed(2) : '—'}</span><span>{tailNote(x)}</span></div>
          </div>
        ))}
      </>
    );
  } else {
    body = (
      <table className={`${styles.table} ${css.tbl}`}>
        <thead>
          <tr>
            <th className={`${css.tStock} ${css.txtL}`}>個股</th>
            <th className={css.tPx}>現價</th>
            <th className={css.tChg}>漲跌</th>
            <th className={css.tPos} title="日內位置 0–1（(現價−最低)÷(最高−最低)）">位置</th>
            <th className={`${css.tNote} ${css.txtR}`}>說明</th>
          </tr>
        </thead>
        <tbody>
          {showDt && <tr className={styles.groupRow}><td colSpan={5}>{dtHeader}</td></tr>}
          {showDt && !dtShown.length && <tr className={styles.groupRow}><td colSpan={5} className={styles.muted}>目前沒有成立中的當沖觀察</td></tr>}
          {dtShown.map((r) => (
            <tr key={`${r.side}:${r.code}`} className={styles.row} onClick={() => openDrawer(r.code)} title={`${sideText(r.side)}·${r.type ?? ''}·成立 ${r.t != null ? hhmm(r.t) : '—'}`}>
              <td className={css.txtL}><CodeLink code={r.code} /> <span className={styles.name}>{r.name || u.nameOf(r.code)}</span> <Badge>觀察</Badge></td>
              <td>{fmtPrice(r.px, r.code)}</td>
              <td className={toneClass(r.chg)}>{fmtPct(r.chg)}</td>
              <td>{r.pos != null ? r.pos.toFixed(2) : '—'}</td>
              <td className={`${css.txtR} ${toneClass(r.netR)}`} title="淨 R：以現價估算、扣成本">{sideText(r.side)} {fmtR(r.netR)}</td>
            </tr>
          ))}
          <tr className={styles.groupRow}><td colSpan={5}>{tailHeader}</td></tr>
          {tailEmpty && <tr className={styles.groupRow}><td colSpan={5} className={styles.muted}>{tailEmpty}</td></tr>}
          {picks.map((x) => (
            <tr key={x.code} className={styles.row} onClick={() => openDrawer(x.code)}>
              <td className={css.txtL}><CodeLink code={x.code} /> <span className={styles.name}>{x.name || u.nameOf(x.code)}</span></td>
              <td>{fmtPrice(x.px, x.code)}</td>
              <td className={toneClass(x.chg)}>{fmtPct(x.chg)}</td>
              <td>{x.pos != null ? x.pos.toFixed(2) : '—'}</td>
              <td className={css.txtR} title={x.char ? `籌碼性格：${x.char}` : undefined}>{tailNote(x)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  const foot = (
    <>
      <span className={css.footTxt}>當沖觀察 13:20 起強制沖銷·撿尾盤為描述性清單·外資◆＝前交易日法人·非投資建議</span>
      <MoreButton onClick={() => openZoom('tailPicks')} />
    </>
  );
  const asOf = tailSec && tailSec.ok && tailSec.asOf != null ? tailSec.asOf : fd?.daytrade && fd.daytrade.ok ? fd.daytrade.asOf : null;
  return (
    <FocusFrame shell={shell} kind="tail" stamp={<Stamp kind="list" asOf={asOf} openOnly />} foot={foot}>
      {body}
    </FocusFrame>
  );
}
