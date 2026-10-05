'use client';

// ─────────────────────────────────────────────────────────────────────────────
// A1 我的部位（preview.html renderA1；第一階段）：持股＋當日釘選。
//   KPI：持股數｜今日 %＋金額（毛額，可遮罩）｜逼近停損｜處置/注意｜利空新聞 n／未判別 m
//   每列：代號名稱市場別｜現價（價齡點／舊／無成交）｜漲跌%｜損益%（扣費稅淨額，同投資組合頁）｜距停損（AI 停損規範 stop-v1·成本線·前端暫算）｜風險＋新聞燈＋重訊
//   新聞燈＝AI 新聞識讀（媒體 M）方向＋強弱（影響權重 rankMediaVerdicts，先驗·未校準，只表強弱、不進排序）；
//   重訊＝官方公告（O）獨立徽章，不併入新聞權重（tw-news-impact-analyst §2）。
//   左色條只由走勢與部位觸發（琥珀＝距停損 ≤2%、今日觸及或價格在停損下）；處置／注意只在風險欄；原因短句（事實句）放第二行。
//   點代號＝個股頁；點整列＝快看抽屜。持股＋釘選登記快層（最多 40 檔，持股優先）。
// 資料計算在 MineModel.ts；這裡只負責畫。
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useAppStore } from '@/lib/store';
import ZoneFrame, { type ZoneProps } from './parts/ZoneFrame';
import Stamp from './parts/Stamp';
import { Badge, Indicative, RowAgeMark } from './parts/Badge';
import { MoreButton } from './parts/Chip';
import { fmtPct, fmtPrice, fmtSigned, hhmm, toneClass } from './parts/fmt';
import { useWarData, useWarUi } from './WarRoomContext';
import { FAST_CODES_MAX } from './useWarRoomBus';
import { useMineModel, type MineKpi, type MineModel, type MineRow } from './MineModel';
import { NewsCellLamp } from './NewsLamp';
import { useMopsIndex } from './NewsModel';
import { NEWS_WEIGHT_NOTE } from '../../../scripts/lib/warroom-news.mjs';
import styles from './WarRoomV2.module.css';
import mine from './ZoneMine.module.css';

const CODE_RE = /^\d{4,6}$/;
const MOBILE_ROWS = 5;
// 桌機列高（與 WarRoomV2.module.css 的 --wr-row-h 34px、subRow 24px、groupRow 26px 對齊，多留 1px 給框線）
const HEAD_H = 28;
const ROW_H = 35;
const SUB_H = 25;
const GROUP_H = 27;
const UNMEASURED_ROWS = 10;
const MASK = '••••';
const PNL_TITLE = '損益＝現價全數賣出、扣買賣手續費（依你的券商折讓、含最低手續費）與證交稅後的淨額，與投資組合頁「持倉明細」同口徑；毛額見各列提示';
const STOP_TITLE = '距停損＝(現價−停損)÷現價。停損依 AI 停損規範 stop-v1：成本線＝買進均價 −8% 向上取合法檔位（停損簿未上線：前端暫算、未含除權息調整）；'
  + '觸停損只認今日成交更新的最低價，試撮與收盤競價窗不判定；舊「AI 停損」（ATR 浮動帶）改稱結構參考價、非停損。daemon 停損推播仍是舊算法。非投資建議';
const STOP_BADGE_TITLE = '停損依 AI 停損規範 stop-v1：成本線（買進均價 −8%）。成本未還原除權息（停損簿未上線，前端暫算）；逼近＝距停損 ≤2%（沒有 ATR14）。非投資建議';

const isPre = (r: MineRow) => r.priceMode === 'yclose';
/** 盤前（試撮）與 08:55–09:00 清空窗：價格欄顯示昨收 */
function usePreSegment(): boolean {
  const { segment } = useWarData();
  return segment === 'pre' || segment === 'preclear';
}
const openStock = (code: string) => useAppStore.getState().navigateTo('stock', code);
const money = (n: number) => `${fmtSigned(Math.round(n), 0)} 元`;

/** 持股（先）＋當日釘選 登記快層（owner 'mine'，最多 40 檔） */
function useRegisterFastCodes() {
  const holdings = useAppStore((s) => s.holdings);
  const { pinned, setFastCodes } = useWarUi();
  const key = useMemo(() => {
    const seen = new Set<string>();
    for (const h of holdings) if (CODE_RE.test(h.code)) seen.add(h.code);
    for (const c of pinned) if (CODE_RE.test(c)) seen.add(c);
    return [...seen].slice(0, FAST_CODES_MAX).join(',');
  }, [holdings, pinned]);
  useEffect(() => { setFastCodes(key ? key.split(',') : [], 'mine'); }, [key, setFastCodes]);
}

/** 區塊內容高度（ResizeObserver）；尚未量到為 0 */
function useBoxHeight() {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0]?.contentRect.height ?? 0);
      setH((prev) => (prev === next ? prev : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, h] as const;
}

/** 放得下幾列（區塊固定高、不捲動；放不下的用「全部 →」開放大層） */
function fitRows(rows: readonly MineRow[], pins: readonly MineRow[], height: number) {
  if (height <= 0) {
    const r = rows.slice(0, UNMEASURED_ROWS);
    const p = r.length === rows.length ? pins.slice(0, Math.max(0, UNMEASURED_ROWS - r.length)) : [];
    return { rows: r, pins: p, hidden: rows.length + pins.length - r.length - p.length };
  }
  let budget = height - HEAD_H;
  const outRows: MineRow[] = [];
  for (const r of rows) {
    const cost = ROW_H + (r.reason ? SUB_H : 0);
    if (cost > budget) break;
    budget -= cost;
    outRows.push(r);
  }
  const outPins: MineRow[] = [];
  if (outRows.length === rows.length && pins.length && budget >= GROUP_H + ROW_H) {
    budget -= GROUP_H;
    for (const p of pins) {
      if (ROW_H > budget) break;
      budget -= ROW_H;
      outPins.push(p);
    }
  }
  return { rows: outRows, pins: outPins, hidden: rows.length + pins.length - outRows.length - outPins.length };
}

// ── 小格 ──────────────────────────────────────────────────────────────────────

const mopsTitle = (m: readonly [number, string]) =>
  `官方重訊 ${hhmm(m[0])}：${m[1]}（公開資訊觀測站·未經 AI 判讀，不併入新聞權重）`;

/** 今日官方重訊徽章（O 管線；只標「有公告」，不給方向） */
function MopsBadge({ code }: { code: string }) {
  const m = useMopsIndex()[code];
  return m ? <Badge title={mopsTitle(m)}>重訊</Badge> : null;
}

function PriceCell({ r }: { r: MineRow }) {
  if (r.price == null) return <span className={styles.muted} title="尚無報價">—</span>;
  const px = fmtPrice(r.price, r.code);
  if (r.priceMode === 'yclose') return <span className={styles.muted} title="昨收（盤前）">{px}</span>;
  if (r.priceMode === 'indicative') return <Indicative>{px}</Indicative>;
  return <>{px}<RowAgeMark age={r.age} /></>;
}

function ChgText({ r }: { r: MineRow }) {
  if (isPre(r) || r.chgPct == null) return <span className={styles.muted}>—</span>;
  const cls = [toneClass(r.chgPct), r.priceMode === 'indicative' ? styles.ital : ''].filter(Boolean).join(' ');
  return <span className={cls}>{fmtPct(r.chgPct)}</span>;
}

function pnlTitle(r: MineRow, masked: boolean): string {
  const parts: string[] = [];
  if (r.netAmount != null && !masked) parts.push(`淨額 ${money(r.netAmount)}`);
  if (r.grossPct != null) parts.push(`毛額 ${fmtPct(r.grossPct, 1)}${r.grossAmount != null && !masked ? `（${money(r.grossAmount)}）` : ''}`);
  parts.push(`均價 ${r.avgCost.toFixed(2)}·${Number(r.lots.toFixed(3))} 張`);
  if (r.calcNote) parts.push(r.calcNote);
  return parts.join('·');
}

function PnlText({ r, masked, digits = 1 }: { r: MineRow; masked: boolean; digits?: number }) {
  if (r.netPct == null) return <span className={styles.muted}>—</span>;
  return <span className={toneClass(r.netPct)} title={pnlTitle(r, masked)}>{fmtPct(r.netPct, digits)}</span>;
}

function distText(d: number): string {
  return `${d < 0 ? '−' : ''}${Math.abs(d).toFixed(1)}%`;
}

function stopTitle(r: MineRow): string {
  const parts = [r.stop?.title ?? ''];
  if (r.structRef != null) parts.push(`結構參考價 ${fmtPrice(r.structRef, r.code)}（非停損）`);
  if (r.calcNote) parts.push(r.calcNote);
  return parts.filter(Boolean).join('·');
}

function StopText({ r }: { r: MineRow }) {
  if (r.dist == null || !r.stop) return <span className={styles.muted} title={r.stopNote ?? undefined}>—</span>;
  return <span className={r.amber ? mine.distAmber : mine.distOk} title={stopTitle(r)}>{distText(r.dist)}</span>;
}

function RiskCell({ r, lamp = true }: { r: MineRow; lamp?: boolean }) {
  return (
    <span className={mine.riskCell}>
      {r.risk && <Badge tone="risk" title={r.risk.title}>{r.risk.label}</Badge>}
      {lamp && <NewsCellLamp news={r.news} />}
      {lamp && <MopsBadge code={r.code} />}
    </span>
  );
}

// ── KPI ───────────────────────────────────────────────────────────────────────

function newsKpiTitle(kpi: MineKpi): string {
  if (kpi.newsBear == null) return '新聞判別暫時讀不到';
  const old = kpi.newsOld ? `；另 ${kpi.newsOld} 檔是承接、前一交易日或沒走四角色挑戰（可能是舊聞回退）的判別（◆，不計入）` : '';
  return `利空新聞＝今日持股中 AI 讀完內文、走過四角色挑戰判利空的檔數（不含承接${old}）；未判別＝持股中 AI 尚未判別或資訊不足（判別範圍未擴大，ETF 等不做個股新聞識讀不計）。`
    + `燈的強弱依影響權重（${NEWS_WEIGHT_NOTE}），不是分數。非投資建議`;
}

function KpiBar({ kpi, masked }: { kpi: MineKpi; masked: boolean }) {
  const d = kpi.day;
  const dayTitle = `${kpi.dayLabel}部位變動（毛額，不含費稅）＝(現價−昨收)×股數；今天買進的那筆以買價為基準${kpi.dayMissing ? `；${kpi.dayMissing} 檔尚無報價未計入` : ''}`;
  return (
    <>
      <span className={mine.kpiItem}>持股 <b>{kpi.holdings}</b></span>
      <span className={mine.kpiItem} title={dayTitle}>
        {kpi.dayLabel}{' '}
        {d ? (
          <>
            <b className={toneClass(d.pct)}>{fmtPct(d.pct)}</b>{' '}
            <span className={`${styles.mono} ${toneClass(d.amount)}`}>{masked ? MASK : fmtSigned(Math.round(d.amount), 0)}</span>
            {kpi.dayMissing > 0 && <span className={styles.muted}>*</span>}
          </>
        ) : <b className={styles.muted}>—</b>}
      </span>
      <span className={mine.kpiItem} title={`${kpi.hit ? `含今日觸及或價格在停損下 ${kpi.hit} 檔；` : ''}距停損 ≤2%（規範 stop-v1·成本線·未含除權息調整）`}>逼近停損 <b className={mine.amber}>{kpi.near}</b></span>
      <span className={mine.kpiItem} title={kpi.riskIncomplete ? '處置／注意名單未載入或可能不完整' : '處置／注意（交易所公告）'}>
        處置/注意 <b className={mine.riskTxt}>{kpi.risk}</b>{kpi.riskIncomplete && <span className={styles.muted}>?</span>}
      </span>
      <span className={mine.kpiItem} title={newsKpiTitle(kpi)}>
        利空新聞 <b className={kpi.newsBear ? styles.dn : undefined}>{kpi.newsBear ?? '—'}</b>
        <span className={styles.muted}>／未判別 </span><b>{kpi.newsMissing ?? '—'}</b>
      </span>
      <span className={`${mine.kpiItem} ${styles.muted}`} title={STOP_BADGE_TITLE}>停損 v1·成本線·未還原除權息</span>
    </>
  );
}

// ── 桌機表格 ──────────────────────────────────────────────────────────────────

function rowKeyDown(code: string, open: (c: string) => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;   // 列內的代號按鈕自己處理（Enter＝個股頁）
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(code); }
  };
}

function HoldingRows({ r, masked, open }: { r: MineRow; masked: boolean; open: (c: string) => void }) {
  const sc = { '--wr-sc': r.amber ? 'var(--wr-amber)' : 'transparent' } as CSSProperties;
  return (
    <>
      <tr className={`${styles.row} ${mine.rowFocus}`} tabIndex={0} onClick={() => open(r.code)} onKeyDown={rowKeyDown(r.code, open)}
        aria-label={`${r.code} ${r.name}，開啟快看`}>
        <td className={mine.first} style={sc}>
          <button type="button" className={mine.codeBtn} title="個股頁" onClick={(e) => { e.stopPropagation(); openStock(r.code); }}>{r.code}</button>
          <span className={styles.name}>{r.name}</span>{r.mkt && <span className={styles.mkt}>{r.mkt}</span>}
        </td>
        <td><PriceCell r={r} /></td>
        <td><ChgText r={r} /></td>
        <td>{isPre(r) ? <span className={styles.muted}>—</span> : <PnlText r={r} masked={masked} />}</td>
        <td><StopText r={r} /></td>
        <td className={styles.left}><RiskCell r={r} /></td>
      </tr>
      {r.reason && (
        <tr className={styles.subRow}>
          <td colSpan={6} className={r.amber ? mine.subAmber : undefined}>└ {r.reason}</td>
        </tr>
      )}
    </>
  );
}

function PinRow({ r, open }: { r: MineRow; open: (c: string) => void }) {
  return (
    <tr className={`${styles.row} ${mine.rowFocus}`} tabIndex={0} onClick={() => open(r.code)} onKeyDown={rowKeyDown(r.code, open)}
      aria-label={`${r.code} ${r.name}，開啟快看`}>
      <td className={mine.first}>
        <button type="button" className={mine.codeBtn} title="個股頁" onClick={(e) => { e.stopPropagation(); openStock(r.code); }}>{r.code}</button>
        <span className={styles.name}>{r.name}</span>{r.mkt && <span className={styles.mkt}>{r.mkt}</span>}
      </td>
      <td><PriceCell r={r} /></td>
      <td><ChgText r={r} /></td>
      <td><span className={styles.muted}>—</span></td>
      <td><span className={styles.muted}>—</span></td>
      <td className={styles.left}><RiskCell r={r} lamp={false} /></td>
    </tr>
  );
}

function MineTable({ rows, pins, masked, pre }: { rows: readonly MineRow[]; pins: readonly MineRow[]; masked: boolean; pre: boolean }) {
  const { openDrawer } = useWarUi();
  return (
    <table className={styles.table}>
      <colgroup>
        <col style={{ width: '27%' }} /><col style={{ width: '17%' }} /><col style={{ width: '14%' }} />
        <col style={{ width: '14%' }} /><col style={{ width: '13%' }} /><col style={{ width: '15%' }} />
      </colgroup>
      <thead>
        <tr>
          <th>個股</th>
          <th>{pre ? '昨收' : '現價'}</th>
          <th>漲跌</th>
          <th title={PNL_TITLE}>損益</th>
          <th title={STOP_TITLE}>距停損</th>
          <th className={styles.left}>風險</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => <HoldingRows key={r.code} r={r} masked={masked} open={openDrawer} />)}
        {pins.length > 0 && <tr className={styles.groupRow}><td colSpan={6}>釘選（當日）</td></tr>}
        {pins.map((r) => <PinRow key={`p${r.code}`} r={r} open={openDrawer} />)}
      </tbody>
    </table>
  );
}

function EmptyMine() {
  return (
    <div className={styles.empty}>
      <div>
        尚無持股與當日釘選
        <div className={styles.muted}>持股取自投資組合頁；快看抽屜的 📌 可把個股釘到這裡（當日有效）</div>
      </div>
    </div>
  );
}

function DeskMine({ model }: { model: MineModel }) {
  const { pnlMasked, openZoom } = useWarUi();
  const [boxRef, height] = useBoxHeight();
  const fit = fitRows(model.rows, model.pins, height);
  const total = model.rows.length + model.pins.length;
  const pre = usePreSegment();
  return (
    <ZoneFrame
      area="a1"
      title="我的部位"
      extra={<MoreButton onClick={() => openZoom('mine')}>{fit.hidden > 0 ? `全部 ${total} →` : '全部 →'}</MoreButton>}
      stamp={<Stamp kind="quote" asOf={model.asOf} openOnly liveLabel="揭示" />}
      top={<KpiBar kpi={model.kpi} masked={pnlMasked} />}
    >
      <div ref={boxRef} className={mine.fill}>
        {total === 0 ? <EmptyMine /> : <MineTable rows={fit.rows} pins={fit.pins} masked={pnlMasked} pre={pre} />}
      </div>
    </ZoneFrame>
  );
}

// ── 手機：52px 兩行卡，前 5 列 ───────────────────────────────────────────────

function MineCard({ r, masked, open }: { r: MineRow; masked: boolean; open: (c: string) => void }) {
  const pre = isPre(r);
  return (
    <div className={`${styles.card} ${r.amber ? mine.cardAmber : ''}`} role="button" tabIndex={0}
      onClick={() => open(r.code)} onKeyDown={rowKeyDown(r.code, open)} aria-label={`${r.code} ${r.name}，開啟快看`}>
      <div className={styles.cardA}>
        <span className={styles.code}>{r.code}</span>
        <span className={styles.name}>{r.name}</span>
        {r.risk && <Badge tone="risk" title={r.risk.title}>{r.risk.label}</Badge>}
        {r.isHolding && <NewsCellLamp news={r.news} />}
        <span className={styles.cardPx}><PriceCell r={r} /></span>
        <span className={mine.cardChg}><ChgText r={r} /></span>
      </div>
      <div className={styles.cardB}>
        {r.isHolding ? (
          <>
            <span>損益 {pre ? <span className={styles.muted}>—</span> : <PnlText r={r} masked={masked} />}</span>
            <span>距停損 <StopText r={r} /></span>
            {r.reason && <span className={r.amber ? mine.amber : undefined}>{r.reason}</span>}
          </>
        ) : <span>釘選（當日）</span>}
      </div>
    </div>
  );
}

function MobileMine({ model }: { model: MineModel }) {
  const { pnlMasked, openZoom, openDrawer } = useWarUi();
  const all = [...model.rows, ...model.pins];
  const shown = all.slice(0, MOBILE_ROWS);
  const d = model.kpi.day;
  return (
    <ZoneFrame
      area="a1"
      variant="mobile"
      title="我的部位"
      extra={d ? <span className={mine.mHeadPct}>{model.kpi.dayLabel} <span className={toneClass(d.pct)}>{fmtPct(d.pct)}</span></span> : null}
      stamp={<Stamp kind="quote" asOf={model.asOf} openOnly liveLabel="揭示" />}
    >
      {all.length === 0 ? <EmptyMine /> : shown.map((r) => <MineCard key={`${r.isHolding ? 'h' : 'p'}${r.code}`} r={r} masked={pnlMasked} open={openDrawer} />)}
      {all.length > MOBILE_ROWS && (
        <div className={mine.mobileMore}><MoreButton onClick={() => openZoom('mine')}>{`全部 ${all.length} →`}</MoreButton></div>
      )}
    </ZoneFrame>
  );
}

export default function ZoneMine({ variant = 'desk' }: ZoneProps) {
  useRegisterFastCodes();
  const model = useMineModel();
  return variant === 'mobile' ? <MobileMine model={model} /> : <DeskMine model={model} />;
}
