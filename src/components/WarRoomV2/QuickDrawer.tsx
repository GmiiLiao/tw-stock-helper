'use client';

// ─────────────────────────────────────────────────────────────────────────────
// D1 快看抽屜（preview.html drawerHtml；第一階段）。點任一列 ui.openDrawer(code) 開啟；
//   桌機：右側 520px（.drawer，不推動版面）；手機：底部 70% 高（.sheet）。
// 內容：價格＋揭示章＋新聞燈｜停損（持有的才顯示；AI 停損規範 stop-v1.1，與 A1 同一支：生效停損與生效線、組成線、ATR 帶〔持股分析·
//       觸發線之一〕、是否還原除權息、Z2 判定口徑〔A7 單一裝置·暫算〕、影子期 daemon 試算對照）｜
//       新聞判別權重明細（AI 新聞識讀·媒體 M；權重先驗·未校準；官方重訊另列，見 DrawerNews.tsx）｜
//       1 分走勢（昨收虛線；VWAP 第一階段不畫）｜五檔（既有 OrderBookDepth）｜內外盤（取樣）｜
//       回本檔數（tw-fee＋你的券商折讓＋最低手續費＋當沖稅 0.15%，參考值）｜◆前交易日法人｜＋候選、📌 釘選、個股頁 →
// 開著才抓資料，關閉＝卸載＝停止（DrawerFeeds.ts）；本檔報價走匯流排快層（owner 'drawer'，nv=1）。
// 「瀏覽中」登記：15 分鐘內最多 3 個不同代號（critique M1），第 4 個起不登記並標「登記前為延遲資料」。
// Esc 由 WarRoomProvider 處理（先關放大層、再關抽屜）；開啟時焦點移到關閉鈕，關閉後還給開啟它的元素。
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useId, useRef } from 'react';
import { useAppStore } from '@/lib/store';
import { logActivity } from '@/lib/activity-logger';
import { calcFee, calcTax, isEtf, type BrokerSettings } from '@/lib/tw-fee';
import { tickSize, marketBadge } from '@/lib/twse-api';
import { useBrokerSettings } from '@/lib/useBrokerSettings';
import { useRiskCodes } from '@/lib/useRiskCodes';
import { useDayTradeCodes, statusOf } from '@/lib/useDayTradeCodes';
import OrderBookDepth from '@/components/shared/OrderBookDepth';
import { breakevenTicks } from '../../../scripts/lib/warroom-drawer.mjs';
import { lastCloseOf, stopJudgeText, type WarStopView } from '../../../scripts/lib/warroom-mine.mjs';
import { mmddText } from '../../../scripts/lib/ai-stoploss.mjs';
import type { ZoneProps } from './parts/ZoneFrame';
import Stamp from './parts/Stamp';
import { Badge, Indicative } from './parts/Badge';
import { fmtNet, fmtPct, fmtPrice, hhmm, mmdd, netToneOf, priceDecimals, toneClass, toneClassOf } from './parts/fmt';
import { useWarData, useWarUi } from './WarRoomContext';
import type { WarQuote } from './useWarRoomBus';
import type { WarSegment } from '@/lib/warroom/types';
import { riskTagOf, useDrawerStop, type DrawerStop, type DrawerEventLayer } from './MineModel';
import { DrawerNewsBlock, DrawerNewsLine } from './DrawerNews';
import DrawerChart from './DrawerChart';
import {
  useDrawerFlow, useDrawerInst, useDrawerIntraday, useDrawerRegistration,
  type FlowState, type InstState, type IntradayState, type RegState,
} from './DrawerFeeds';
import styles from './WarRoomV2.module.css';
import drawer from './QuickDrawer.module.css';

const DT_LABEL = { 1: '沖 雙向', 2: '沖 先買' } as const;
const DT_TITLE = { 1: '可現股當沖（先買後賣、先賣後買皆可）', 2: '暫停先賣後買：只能先買後賣' } as const;

const discountLabel = (b: BrokerSettings) => (b.discount >= 1 ? '全額' : `${+(b.discount * 10).toFixed(2)} 折`);

// ── 標頭 ──────────────────────────────────────────────────────────────────────

function PriceLine({ code, q, segment }: { code: string; q: WarQuote | null; segment: WarSegment }) {
  if (!q) return <div className={drawer.pxRow}><span className={drawer.bigPx}>—</span><span className={drawer.pxLabel}>報價載入中</span></div>;
  if (segment === 'pre' || segment === 'preclear') {
    return (
      <div className={drawer.pxRow}>
        <span className={drawer.bigPx}>{fmtPrice(lastCloseOf(q), code)}</span>
        <span className={drawer.pxLabel}>昨收（09:00 開盤後更新）</span>
      </div>
    );
  }
  const px = fmtPrice(q.price, code);
  return (
    <div className={drawer.pxRow}>
      <span className={drawer.bigPx}>{segment === 'auction' ? <Indicative>{px}</Indicative> : px}</span>
      <span className={toneClass(q.changePercent)}>{fmtPct(q.changePercent)}</span>
      <Stamp kind="quote" asOf={q.revealAt} openOnly liveLabel="揭示" />
    </div>
  );
}

// ── 區塊 ──────────────────────────────────────────────────────────────────────

function regNote(reg: RegState): string | null {
  if (reg.kind !== 'denied') return null;
  return `登記前為延遲資料：15 分鐘內已登記 ${reg.max} 檔（${reg.held.join('、')}），這檔未納入即時追蹤`;
}

function ChartBlock({ intraday, reg, refClose, height, digits }: {
  intraday: IntradayState; reg: RegState; refClose: number | null; height: number; digits: number;
}) {
  const note = regNote(reg);
  const delayed = intraday.source === 'yahoo+mis';
  return (
    <div className={drawer.block}>
      <div className={drawer.caption}>
        1 分走勢·虛線＝昨收
        {delayed ? '·前段含 Yahoo 延遲資料（約 20 分）' : ''}
      </div>
      {intraday.points.length >= 2
        ? <DrawerChart points={intraday.points} prevClose={refClose} height={height} digits={digits} />
        : (
          <div className={drawer.chartEmpty}>
            {intraday.status === 'loading' ? '走勢載入中…' : intraday.status === 'error' ? '走勢暫時讀不到' : '尚無分時資料'}
          </div>
        )}
      {note && <div className={drawer.note}>{note}</div>}
      {reg.kind === 'registered' && <div className={drawer.caption}>已登記即時追蹤（15 分鐘內 {reg.held.length}/{reg.max} 檔）</div>}
    </div>
  );
}

function FlowBlock({ flow, ymd }: { flow: FlowState; ymd: string }) {
  if (flow.status === 'na') return null;
  const head = <div className={drawer.caption}>內外盤（取樣近似：兩次掃描間的成交量依成交價對五檔判方向）</div>;
  if (flow.status !== 'ok' || flow.outerPct == null || flow.innerPct == null) {
    const msg = flow.status === 'loading' ? '載入中…' : flow.status === 'error' ? '暫時讀不到' : '此檔目前沒有內外盤樣本（只涵蓋持股、自選、瀏覽中）';
    return <div className={drawer.block}>{head}<div className={drawer.line}>{msg}</div></div>;
  }
  const prev = flow.date && flow.date !== ymd;
  const since = flow.since ? `自 ${hhmm(flow.since)} 起` : '';
  return (
    <div className={drawer.block}>
      {head}
      <div className={drawer.ratio} role="img" aria-label={`外盤 ${flow.outerPct}%，內盤 ${flow.innerPct}%`}>
        <i className={drawer.ratioOut} style={{ width: `${flow.outerPct}%` }} />
        <i className={drawer.ratioIn} style={{ width: `${flow.innerPct}%` }} />
      </div>
      <div className={drawer.line}>
        外盤 <b className={styles.up}>{flow.outerPct}%</b>　內盤 <b className={styles.dn}>{flow.innerPct}%</b>
        <span className={drawer.muted}>　{prev ? `◆ ${flow.date}` : since}</span>
      </div>
    </div>
  );
}

function BreakevenLine({ code, price, broker }: { code: string; price: number | null; broker: BrokerSettings }) {
  if (price == null || !(price > 0)) return <div className={drawer.line}>回本檔數：<span className={drawer.muted}>—（無報價）</span></div>;
  if (isEtf(code)) return <div className={drawer.line}>回本檔數：<span className={drawer.muted}>—（ETF 檔位與稅率不同，不估）</span></div>;
  const n = breakevenTicks(price, {
    fee: (p) => calcFee(p, 1, broker),
    tax: (p) => calcTax(p, 1, { dayTrade: true, code }),
    tick: tickSize,
  });
  return (
    <div className={drawer.line}>
      回本檔數：<b>{n == null ? '—' : `${n} 檔`}</b>{' '}
      <span className={drawer.muted}>（買 1 張當沖；手續費依你的券商{discountLabel(broker)}·最低 {broker.minFee} 元×2＋當沖稅 0.15%·參考值）</span>
    </div>
  );
}

/** 持股分析 ATR 帶（觸發線之一）沒有進到組成線時的說明（前端暫算才有；有套用時組成線列已寫出今日值） */
function bandLine(st: DrawerStop, v: WarStopView): string | null {
  if (v.mode !== 'front') return null;
  if (st.ratingBandText == null) {
    if (st.bandStatus === 'error') return 'ATR 帶（持股分析·觸發線之一）：暫時讀不到，停損只含成本線';
    if (st.bandStatus === 'loading' || st.bandStatus === 'slow') return 'ATR 帶（持股分析·觸發線之一）：讀取中，停損只含成本線';
    return 'ATR 帶（持股分析·觸發線之一）：持股分析沒有這檔的帶值，停損只含成本線';
  }
  if (v.res.lines.bandLine != null) return null;
  return `ATR 帶（持股分析·觸發線之一）${st.ratingBandText}：今日未套用（見口徑）`;
}

/** 依據＋是否已還原除權息（依據本身已寫「未含除權息調整」就不重複） */
function basisWithEx(v: WarStopView): string {
  const ex = v.exAdjusted ? '已還原除權息' : '未含除權息調整';
  return v.res.basisText.includes(ex) ? v.res.basisText : `${v.res.basisText}·${ex}`;
}

/** 四條組成線當日值（沒有的寫「—」；SKILL §1、實作計畫 §3.3） */
function linesText(v: WarStopView, code: string): string {
  const l = v.res.lines;
  const px = (n: number | null) => (n == null ? '—' : fmtPrice(n, code));
  return `組成線：成本線 ${px(l.costLine)}｜ATR 帶今日 ${px(l.bandLine)}｜保本線 ${px(l.beLine)}｜追蹤線 ${px(l.trailLine)}`;
}

/** 事件收緊一層（類別權重是新聞技能 §4.1 先驗，不是新聞影響權重 w；wording.md） */
function eventText(e: DrawerEventLayer, code: string): string {
  const w = e.weight != null ? `·類別權重 ${e.weight.toFixed(2)}（新聞技能 §4.1 先驗·未回測）` : '';
  return `事件收緊：${e.label ?? '規則類利空'}·${mmddText(e.effectiveFrom ?? '')} 起至 ${mmddText(e.expiresAfter ?? '')}·收緊線 ${e.line == null ? '—' : fmtPrice(e.line, code)}${w}`;
}

/** 影子期 daemon 試算值（只供對照；不參與任何判定） */
function shadowText(st: DrawerStop, code: string): string | null {
  const s = st.shadow;
  if (!s) return null;
  return `影子試算（daemon stop-v1.1·只記錄、不推播）：停損 ${fmtPrice(s.stop, code)}（${s.basisText}）·資料日 ${mmddText(s.dataDate ?? '')}`;
}

/**
 * 停損區塊（只在持有這檔時顯示）：生效停損與生效線、距停損、依據與是否已還原除權息、四條組成線、ATR 帶（持股分析·觸發線之一）、
 * 事件收緊（停損簿生效時）、今日判定、Z2 判定口徑（A7）、影子試算（影子期）。只描述事實。
 */
function StopBlock({ code, st }: { code: string; st: DrawerStop }) {
  const v = st.view;
  if (!v) return null;
  const caption = <div className={drawer.caption}>停損·AI 停損規範 stop-v1.1（{v.modeNote || v.res.basisText}）·非投資建議</div>;
  const shadow = shadowText(st, code);
  if (v.stop == null) {
    return <div className={drawer.block}>{caption}<div className={drawer.line}>停損：<span className={drawer.muted}>—（{v.res.basisText}）</span></div></div>;
  }
  const amber = v.level === 'hit' || v.level === 'near' ? drawer.stopAmber : undefined;
  const dist = v.distPct == null ? '—' : `${v.distPct < 0 ? '−' : ''}${Math.abs(v.distPct).toFixed(1)}%`;
  const band = bandLine(st, v);
  return (
    <div className={drawer.block}>
      {caption}
      <div className={drawer.line}>
        停損 <b>{fmtPrice(v.stop, code)}</b>（生效線：{v.source}）　距停損 <b className={amber}>{dist}</b>
        {v.atrMultiple != null && <span className={drawer.muted}>（{v.atrMultiple.toFixed(1)} ATR）</span>}
        <span className={drawer.muted}>（{st.priceLabel} {fmtPrice(st.calcPrice, code)}）</span>
      </div>
      <div className={drawer.line}><span className={drawer.muted}>依據：{basisWithEx(v)}</span></div>
      <div className={drawer.line}><span className={drawer.muted}>{linesText(v, code)}</span></div>
      {band && <div className={drawer.line}><span className={drawer.muted}>{band}</span></div>}
      {st.events.map((e) => <div key={e.key} className={drawer.line}><span className={drawer.muted}>{eventText(e, code)}</span></div>)}
      <div className={drawer.line}>狀態：<span className={amber}>{v.reason ?? stopJudgeText(v)}</span></div>
      <div className={drawer.line}><span className={drawer.muted}>{st.judgeNote}</span></div>
      {shadow && <div className={drawer.line}><span className={drawer.muted}>{shadow}</span></div>}
    </div>
  );
}

function InstLine({ inst, ymd }: { inst: InstState; ymd: string }) {
  if (inst.status === 'loading') return <div className={drawer.line}>法人：<span className={drawer.muted}>載入中…</span></div>;
  if (inst.status === 'error') return <div className={drawer.line}>法人：<span className={drawer.muted}>暫時讀不到</span></div>;
  if (inst.status === 'none') return <div className={drawer.line}>法人：<span className={drawer.muted}>{inst.dataDate ? `${inst.dataDate} ` : ''}無此檔資料</span></div>;
  const prev = inst.dataDate != null && inst.dataDate < ymd;
  const stamp = inst.dataDate ? `${prev ? '◆ 前交易日 ' : ''}${mmdd(Date.parse(`${inst.dataDate}T12:00:00+08:00`))}` : '';
  const cell = (label: string, v: number | null) => (
    <>{label} <b className={v == null ? undefined : toneClassOf(netToneOf(v))}>{v == null ? '—' : `${fmtNet(v)} 張`}</b>　</>
  );
  return (
    <div className={drawer.line}>
      {cell('外資', inst.foreign)}{cell('投信', inst.trust)}{cell('自營', inst.dealer)}
      <span className={drawer.muted}>{stamp}</span>
    </div>
  );
}

function Actions({ code, close }: { code: string; close: () => void }) {
  const inPool = useAppStore((s) => s.compareCodes.includes(code));
  const toggleCandidate = useAppStore((s) => s.toggleCandidate);
  const { isPinned, togglePin } = useWarUi();
  const pinned = isPinned(code);
  const onCandidate = () => { logActivity(inPool ? 'remove_candidate' : 'add_candidate', { code, from: 'warroom-drawer' }); toggleCandidate(code); };
  const onStock = () => { close(); useAppStore.getState().navigateTo('stock', code); };
  return (
    <div className={drawer.actions}>
      <button type="button" className={`${drawer.action} ${inPool ? drawer.actionOn : ''}`} aria-pressed={inPool} onClick={onCandidate}>
        {inPool ? '✓ 已在候選' : '＋候選'}
      </button>
      <button type="button" className={`${drawer.action} ${pinned ? drawer.actionOn : ''}`} aria-pressed={pinned} onClick={() => togglePin(code)}
        title="釘到「我的部位」（當日有效）">
        {pinned ? '📌 已釘選' : '📌 釘選'}
      </button>
      <button type="button" className={drawer.action} onClick={onStock}>個股頁 →</button>
    </div>
  );
}

// ── 面板（以代號為 key 掛載：換代號＝重掛，資料各自重抓）──────────────────────

function DrawerPanel({ code, variant }: { code: string; variant: 'desk' | 'mobile' }) {
  const { quotes, segment, clock } = useWarData();
  const { closeDrawer, setFastCodes } = useWarUi();
  const allStocks = useAppStore((s) => s.allStocks);
  const [broker] = useBrokerSettings();
  const risk = useRiskCodes();
  const dt = useDayTradeCodes();
  const intraday = useDrawerIntraday(code);
  const flow = useDrawerFlow(code);
  const inst = useDrawerInst(code);
  const reg = useDrawerRegistration(code);
  const stop = useDrawerStop(code);
  const closeRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();

  // 本檔報價走匯流排快層（nv=1，不登記瀏覽中；登記另由 useDrawerRegistration 控管配額）
  useEffect(() => {
    setFastCodes([code], 'drawer');
    return () => setFastCodes([], 'drawer');
  }, [code, setFastCodes]);
  // 開啟時把焦點移到關閉鈕（延一個畫格：外層先記下開啟它的元素）
  useEffect(() => {
    const id = requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
  }, []);

  const q = quotes[code] ?? null;
  const stock = allStocks.find((s) => s.code === code);
  const name = q?.name || stock?.name || '';
  const mkt = marketBadge({ code, market: stock?.market, name })?.t ?? null;
  const dtStatus = statusOf(dt, code);
  const riskTag = riskTagOf(risk, code);
  const pre = segment === 'pre' || segment === 'preclear';
  const basePrice = q ? (pre ? lastCloseOf(q) : q.price) : null;
  const refClose = q?.source === 'mis_realtime' && q.prevClose > 0 ? q.prevClose : intraday.prevClose;
  const digits = priceDecimals(basePrice ?? refClose ?? 100, code);

  return (
    <aside className={variant === 'mobile' ? styles.sheet : styles.drawer} role="dialog" aria-modal="false" aria-labelledby={headingId}>
      <button ref={closeRef} type="button" className={`${styles.closeBtn} ${drawer.closeBig}`} onClick={closeDrawer} aria-label="關閉快看">✕ Esc</button>
      <header className={drawer.head}>
        <div className={drawer.titleRow}>
          <span className={drawer.code}>{code}</span>
          <h2 id={headingId} className={drawer.name}>{name || '—'}</h2>
          {mkt && <span className={styles.mkt}>{mkt}</span>}
          {dtStatus === 1 || dtStatus === 2
            ? <Badge tone="dt" title={DT_TITLE[dtStatus]}>{DT_LABEL[dtStatus]}</Badge>
            : dtStatus === 0 ? <Badge title="不在交易所現股當沖名單（處置股屬此類）">不可沖</Badge> : null}
          {riskTag && <Badge tone="risk" title={riskTag.title}>{riskTag.label}</Badge>}
        </div>
        <PriceLine code={code} q={q} segment={segment} />
        <DrawerNewsLine code={code} />
      </header>
      <div className={drawer.body}>
        <StopBlock code={code} st={stop} />
        <DrawerNewsBlock code={code} />
        <ChartBlock intraday={intraday} reg={reg} refClose={refClose} height={variant === 'mobile' ? 110 : 150} digits={digits} />
        <div className={drawer.block}>
          <div className={drawer.caption}>五檔（只涵蓋持股、自選、瀏覽中；約 40–55 秒更新·掛單隨時可撤，非成交保證）</div>
          <OrderBookDepth code={code} price={q && !pre ? q.price : undefined} />
        </div>
        <FlowBlock flow={flow} ymd={clock.ymd} />
        <div className={drawer.block}>
          <BreakevenLine code={code} price={basePrice} broker={broker} />
          <InstLine inst={inst} ymd={clock.ymd} />
        </div>
        <Actions code={code} close={closeDrawer} />
        <div className={drawer.foot}>觀察工具·資料為交易所揭示與本站彙整·非投資建議</div>
      </div>
    </aside>
  );
}

export default function QuickDrawer({ variant = 'desk' }: ZoneProps) {
  const { drawerCode } = useWarUi();
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  // 焦點管理：開啟時記下開啟它的元素（子層延一畫格才搶焦點），關閉時還回去
  useEffect(() => {
    if (drawerCode && !wasOpen.current) {
      wasOpen.current = true;
      const el = typeof document !== 'undefined' ? document.activeElement : null;
      openerRef.current = el instanceof HTMLElement ? el : null;
    } else if (!drawerCode && wasOpen.current) {
      wasOpen.current = false;
      const el = openerRef.current;
      openerRef.current = null;
      if (el && el.isConnected) el.focus({ preventScroll: true });
    }
  }, [drawerCode]);

  if (!drawerCode) return null;
  return <DrawerPanel key={drawerCode} code={drawerCode} variant={variant} />;
}
