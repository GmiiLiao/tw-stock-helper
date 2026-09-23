'use client';

// ── ⚔️ 多空同屏（即時漲跌子分頁；2026-09-23 使用者）──────────────────────────
// 「做多與做空的內容統一高度與格式，讓用戶有足夠的判別資料可以識讀」
// 「做多轉上漲時背景反白閃爍，做空亦同；現象停止時 icon 提醒出貨；預測有 2% 以上空間要提前反應；由 1 分 K 與價量即時判斷」
//
// 左右兩欄用**同一個列模板**（DualRowView）與**同一個高度**：
//   第 1 行：警示 icon · 名次 · 代號 · 名稱＋徽章 · 即時價 · 漲跌
//   第 2 行（兩邊同六欄）：VWAP 乖離 · 1 分量比 · 預估空間 · 最高漲幅 · 回吐 · 評分
//   第 3 行：警示狀態（成立／出貨）或入榜理由，單行不折行（全文在 title）
// 資料：做多＝盤中漲停預測 A 榜；做空＝即時轉空型態（src/lib/fade-patterns.ts）；
//   警示＝daemon 以 5 秒快線自組 1 分 K 判訊號（scripts/lib/daytrade-signals.mjs，回放：scripts/daytrade-alert-lab.mjs）。
// 價格一律用即時漲跌頁已下載的全市場快照（含 5 秒快線覆蓋），本元件只多兩支小 API：預測 60 秒、警示 5 秒（CDN 3 秒層）。
import { useEffect, useMemo, useState } from 'react';
import StockTrendChart from '@/components/WatchlistTracker/StockTrendChart';
import AddCandidateButton from '@/components/Candidates/AddCandidateButton';
import RiskBadge from '@/components/shared/RiskBadge';
import { DayTradeMark } from '@/components/shared/DayTradeBadge';
import { useAppStore } from '@/lib/store';
import { useDayTradeCodes, statusOf } from '@/lib/useDayTradeCodes';
import { useRiskCodes, taipeiToday } from '@/lib/useRiskCodes';
import { startLiveLoop, isForeground, getSession } from '@/lib/market-clock';
import { classifyFade, TIER_STYLE, TIER_RANK, type FadeSnap } from '@/lib/fade-patterns';

type Side = 'long' | 'short';
interface AlertSt { phase: 'on' | 'stop'; since: number; entry: number; best: number; room: number; stopAt: number | null; stopPx: number | null; ret: number | null; n: number }
interface AlertM { at: number; c: number; chg: number; vwap: number | null; vwapDev: number | null; volX: number | null; roomUp: number; roomDn: number; hiUp: number; give: number; bars: number }
interface AlertRow { code: string; name: string; st: AlertSt | null; m: AlertM | null }
interface AlertEvent { t: number; code: string; name: string; side: Side; kind: 'on' | 'stop'; px: number; room: number | null; ret: number | null }
interface Bucket { trN: number; teN: number; trHit2: number; teHit2: number; trStop: number; teStop: number; teWin: number; trClose: number; teClose: number }
interface SideEvidence { all: Bucket; early: Bucket; late: Bucket }
interface Evidence { days: number; from: string; to: string; cut: string; verdict: string; long: SideEvidence; short: SideEvidence }
interface AlertDoc { found: boolean; date?: string; at?: number; params?: { volK: number; lookback: number; minRoom: number; exitBars: number }; evidence?: Evidence | null; long?: AlertRow[]; short?: AlertRow[]; events?: AlertEvent[] }
interface LuPick { code: string; name: string; market: string; price: number; chg: number; score: number; reasons: string[]; limitPrice: number }

interface DualRow {
  side: Side; code: string; name: string; market: string; rank: number | null;
  price: number | null; chg: number | null;
  vwapDev: number | null; volX1m: number | null; room: number | null; hiUp: number | null; give: number | null;
  score: string; scoreColor: string; reason: string;
  alert: AlertSt | null;
}

const FLASH_ON_MS = 90_000;     // 成立後強閃 90 秒，之後常亮
const FLASH_STOP_MS = 60_000;   // 現象停止後琥珀閃 60 秒
const STOP_KEEP_MS = 15 * 60_000;   // 出貨/回補 icon 置頂 15 分鐘
const M_FRESH_MS = 3 * 60_000;
const SHORT_N = 30;   // 做空欄與做多欄同為 30 檔  // 1 分 K 指標超過 3 分鐘視為過期（不顯示量比）
const LINE1 = '2em 1.6em 3.7em minmax(0, 1fr) 5em 5.4em';
const LINE2 = 'repeat(6, minmax(0, 1fr))';
const NUM: React.CSSProperties = { textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const pct = (v: number | null, d = 2) => (v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`);
const upDn = (v: number | null) => (v == null ? 'var(--text-muted)' : v >= 0 ? 'var(--color-up)' : 'var(--color-down)');
const hhmm = (t: number | null | undefined) => (t ? new Date(t).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' }) : '—');

function useAlertDoc(): [AlertDoc | null, number] {
  const [doc, setDoc] = useState<AlertDoc | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    const load = () => {
      setNow(Date.now());
      if (!isForeground()) return;
      fetch('/api/ai/daytrade-alerts').then(r => (r.ok ? r.json() : null)).then(d => { if (alive && d) setDoc(d); }).catch(() => {});
    };
    load();
    const stop = startLiveLoop(load);   // 盤中 5 秒鎖相、休市 10 分鐘、背景暫停（間隔每拍重算）
    return () => { alive = false; stop(); };
  }, []);
  return [doc, now];
}

function useLuLive(): LuPick[] {
  const [list, setList] = useState<LuPick[]>([]);
  useEffect(() => {
    let alive = true;
    // aMore＝備位 31～60 名：前 30 有不可當沖／處置股時遞補，做多欄才湊得滿 30 檔
    const load = () => fetch('/api/ai/limitup-live').then(r => (r.ok ? r.json() : null)).then(d => { if (alive && d?.found) setList([...(d.aList || []), ...(d.aMore || [])] as LuPick[]); }).catch(() => {});
    load();
    const stop = startLiveLoop(load, () => (isForeground() && getSession() !== 'closed' ? 60_000 : 600_000));   // 每拍重算
    return () => { alive = false; stop(); };
  }, []);
  return list;
}

export default function DualBoard({ snaps, marketOpen, wide }: { snaps: FadeSnap[]; marketOpen: boolean; wide: boolean }) {
  const [doc, now] = useAlertDoc();
  const lu = useLuLive();
  const dt = useDayTradeCodes();
  const risk = useRiskCodes();
  // 處置股（進行中＋已公告待生效）一律不列：交易所當沖名單在處置生效前一天仍列可當沖（2026-09-23 大甲實案）
  const disp = useMemo(() => { const t = taipeiToday(); return new Set([...risk.disposition].filter(c => (risk.dispEnd.get(c) ?? '9999') >= t)); }, [risk]);
  const snapMap = useMemo(() => { const m: Record<string, FadeSnap> = {}; for (const s of snaps) m[s.code] = s; return m; }, [snaps]);
  const alertMap = useMemo(() => {
    const m: Record<Side, Record<string, AlertRow>> = { long: {}, short: {} };
    for (const r of doc?.long || []) m.long[r.code] = r;
    for (const r of doc?.short || []) m.short[r.code] = r;
    return m;
  }, [doc]);

  const longRows = useMemo<DualRow[]>(() => {
    const out: DualRow[] = []; const seen = new Set<string>();
    const build = (code: string, name: string, market: string, rank: number | null, p: LuPick | null): DualRow => {
      const s = snapMap[code]; const a = alertMap.long[code];
      const mFresh = a?.m && now - a.m.at < M_FRESH_MS ? a.m : null;
      const price = s?.price ?? mFresh?.c ?? p?.price ?? null;
      const prev = s ? s.price - s.change : p ? p.price / (1 + p.chg / 100) : null;
      const vwap = s?.vwap ?? mFresh?.vwap ?? null;
      return {
        side: 'long', code, name, market, rank,
        price, chg: s?.changePercent ?? p?.chg ?? mFresh?.chg ?? null,
        vwapDev: price && vwap ? (price / vwap - 1) * 100 : null,
        volX1m: mFresh?.volX ?? null,
        room: price && p?.limitPrice ? (p.limitPrice - price) / price * 100 : mFresh?.roomUp ?? null,
        hiUp: s && prev ? (s.high / prev - 1) * 100 : mFresh?.hiUp ?? null,
        give: s && prev ? (s.high - s.price) / prev * 100 : mFresh?.give ?? null,
        score: p ? p.score.toFixed(1) : '—', scoreColor: '#fbbf24',
        reason: p ? p.reasons.slice(0, 4).join('·') : '1 分 K 監控（不在預測榜）',
        alert: a?.st ?? null,
      };
    };
    // 只列能當沖的（使用者 2026-09-23）：做多＝可先買後賣（1 可當沖、2 僅先買後賣）。名單未載入前一律不列。
    const canLong = (code: string) => { if (disp.has(code)) return false; const st = statusOf(dt, code); return st === 1 || st === 2; };
    let rank = 0;
    for (const p of lu) { if (rank >= 30) break; if (!canLong(p.code)) continue; seen.add(p.code); out.push(build(p.code, p.name, p.market, ++rank, p)); }
    for (const r of doc?.long || []) if (r.st && !seen.has(r.code) && canLong(r.code)) out.push(build(r.code, r.name, snapMap[r.code]?.market || 'tse', null, null));
    return out;
  }, [lu, snapMap, alertMap, doc, dt, disp, now]);

  const shortRows = useMemo<DualRow[]>(() => {
    const { rows, avoid } = classifyFade(snaps, marketOpen, dt);
    // 30 檔（與做多同數，使用者 2026-09-23）：型態全層級（強→中→弱→12 點後降級）優先
    const picked = rows.sort((a, b) => TIER_RANK[a.main.tier] - TIER_RANK[b.main.tier] || b.m.give - a.m.give);
    const out: DualRow[] = []; const seen = new Set<string>();
    const build = (s: FadeSnap | undefined, code: string, name: string, rank: number | null, tier: { t: string; c: string; label: string; oos: string } | null): DualRow => {
      const a = alertMap.short[code];
      const mFresh = a?.m && now - a.m.at < M_FRESH_MS ? a.m : null;
      const price = s?.price ?? mFresh?.c ?? null;
      const prev = s ? s.price - s.change : null;
      const vwap = s?.vwap ?? mFresh?.vwap ?? null;
      const target = prev != null ? Math.max(vwap ?? 0, prev) : null;
      return {
        side: 'short', code, name, market: s?.market || 'tse', rank,
        price, chg: s?.changePercent ?? mFresh?.chg ?? null,
        vwapDev: price && vwap ? (price / vwap - 1) * 100 : null,
        volX1m: mFresh?.volX ?? null,
        room: price && target ? (price - target) / price * 100 : mFresh?.roomDn ?? null,
        hiUp: s && prev ? (s.high / prev - 1) * 100 : mFresh?.hiUp ?? null,
        give: s && prev ? (s.high - s.price) / prev * 100 : mFresh?.give ?? null,
        score: tier ? tier.t : '—', scoreColor: tier ? tier.c : 'var(--text-muted)',
        reason: tier ? `${tier.label}｜${tier.oos}` : '1 分 K 監控（未成立轉空型態）',
        alert: a?.st ?? null,
      };
    };
    // 只列能先賣當沖的（狀態 1）；classifyFade 在名單未載入時會放行 null，這裡一律擋下
    const canShort = (code: string) => !disp.has(code) && statusOf(dt, code) === 1;
    let rank = 0;
    for (const r of picked) { if (rank >= SHORT_N) break; if (!canShort(r.s.code)) continue; seen.add(r.s.code); const ts = TIER_STYLE[r.main.tier]; out.push(build(r.s, r.s.code, r.s.name, ++rank, { t: ts.t, c: ts.c, label: r.main.label, oos: r.main.oos })); }
    // 補足：今日曾漲≥5%、尚未成立型態的「觀察」股（與 daemon 做空監控同一母體，依成交值）；
    //   最後才用回放兩段皆負的「不建議放空」股墊底，並把理由寫在第 3 行——不讓它們冒充候選。
    const avoidWhy = new Map(avoid.map(a => [a.s.code, a.why]));
    const watch = snaps.filter(q => {
      if (seen.has(q.code) || avoidWhy.has(q.code) || !/^\d{4}$/.test(q.code) || q.code.startsWith('00') || !canShort(q.code)) return false;
      const prev = q.price - q.change;
      return prev > 10 && q.high > 0 && (q.volume || 0) / 1000 >= 500 && (q.high / prev - 1) * 100 >= 5;
    }).sort((a, b) => b.price * b.volume - a.price * a.volume);
    for (const q of watch) { if (rank >= SHORT_N) break; seen.add(q.code); out.push(build(q, q.code, q.name, ++rank, { t: '觀察', c: 'var(--text-muted)', label: '曾漲≥5%·尚未成立轉空型態', oos: '回放未驗證，僅監控' })); }
    for (const a of avoid.filter(x => canShort(x.s.code) && !seen.has(x.s.code)).sort((x, y) => y.s.price * y.s.volume - x.s.price * x.s.volume)) {
      if (rank >= SHORT_N) break; seen.add(a.s.code); out.push(build(a.s, a.s.code, a.s.name, ++rank, { t: '避', c: '#f59e0b', label: '⚠ 不建議放空', oos: a.why }));
    }
    for (const r of doc?.short || []) if (r.st && !seen.has(r.code) && canShort(r.code)) out.push(build(snapMap[r.code], r.code, r.name, null, null));
    return out;
  }, [snaps, marketOpen, dt, disp, alertMap, doc, snapMap, now]);

  // 排序：成立中（新→舊）→ 15 分鐘內的出貨/回補 → 其餘依原名次
  const order = (rows: DualRow[]) => {
    const w = (r: DualRow) => (r.alert?.phase === 'on' ? 0 : r.alert?.phase === 'stop' && r.alert.stopAt && now - r.alert.stopAt < STOP_KEEP_MS ? 1 : 2);
    return [...rows].sort((a, b) => w(a) - w(b) || (w(a) === 0 ? (b.alert!.since - a.alert!.since) : w(a) === 1 ? (b.alert!.stopAt! - a.alert!.stopAt!) : (a.rank ?? 999) - (b.rank ?? 999)));
  };

  const stale = marketOpen && doc?.found && doc.at ? Math.floor((now - doc.at) / 60000) : 0;
  const events = (doc?.events || []).slice(0, 6);

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginBottom: 8, minHeight: '1.8em' }}>
        <b style={{ color: 'var(--text-primary)' }}>⚡ 即時警示</b>
        {!doc?.found ? <span>今日警示尚未啟動（09:05 起，每檔需先累積 5 根 1 分 K）</span>
          : !events.length ? <span>{marketOpen ? '監控中，尚無訊號' : `非盤中·最後更新 ${hhmm(doc.at)}`}</span>
          : events.map(e => (
            <span key={`${e.side}${e.code}${e.t}${e.kind}`} style={{ padding: '1px 8px', borderRadius: 999, fontWeight: 700,
              background: e.kind === 'stop' ? 'rgba(245,158,11,0.14)' : e.side === 'long' ? 'rgba(240,62,62,0.14)' : 'rgba(47,158,68,0.14)',
              color: e.kind === 'stop' ? '#f59e0b' : e.side === 'long' ? 'var(--color-up)' : 'var(--color-down)' }}>
              {hhmm(e.t)} {e.kind === 'stop' ? '🏁' : e.side === 'long' ? '▲' : '▼'} {e.code} {e.name} {e.kind === 'stop' ? `${e.side === 'long' ? '出貨' : '回補'} ${pct(e.ret)}` : `${e.side === 'long' ? '轉強' : '轉弱'} 空間 ${(e.room ?? 0).toFixed(1)}%`}
            </span>
          ))}
        {stale >= 3 && <span style={{ color: '#f59e0b', fontWeight: 700 }}>⚠ 警示資料已 {stale} 分鐘未更新</span>}
        {doc?.evidence?.verdict && <span style={{ marginLeft: 'auto', color: '#f59e0b' }}>⚠ {doc.evidence.verdict}</span>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: wide ? 'minmax(0, 1fr) minmax(0, 1fr)' : '1fr', gap: 12 }}>
        <DualColumn side="long" rows={order(longRows)} now={now} evidence={doc?.evidence?.long ?? null} ev={doc?.evidence ?? null} dtLoaded={dt.loaded} />
        <DualColumn side="short" rows={order(shortRows)} now={now} evidence={doc?.evidence?.short ?? null} ev={doc?.evidence ?? null} dtLoaded={dt.loaded} />
      </div>

      <div style={{ marginTop: 8, fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.6 }}>
        <b>警示怎麼判</b>：每收完一根 1 分 K 判一次。做多▲＝突破前 {doc?.params?.lookback ?? 5} 根高點、該根量 ≥ 前 10 根均量 {doc?.params?.volK ?? 2} 倍、站上 VWAP、距漲停仍有 ≥{doc?.params?.minRoom ?? 2}% 空間；
        做空▼＝今日曾漲 ≥5%、跌破前 {doc?.params?.lookback ?? 5} 根低點、同樣放量。
        🏁＝現象停止（做多：收盤跌破前 {doc?.params?.exitBars ?? 3} 根最低；做空：收盤站上前 {doc?.params?.exitBars ?? 3} 根最高）：做多提醒出貨、做空提醒回補。
        回放（22 個交易日 1 分 K）顯示這組量價訊號扣成本後沒有正期望，10 點前兌現率明顯較高；請當成盯盤提示搭配型態與模型分判斷。
        VWAP 為常駐服務取樣累積（交易所不提供個股成交金額），取樣不足當日量 80% 時顯示「—」。1 分量比只有監控中的個股才有（多、空各約 18 檔，搭 5 秒快線、不另打交易所）。非投資建議。
      </div>
    </div>
  );
}

function DualColumn({ side, rows, now, evidence, ev, dtLoaded }: { side: Side; rows: DualRow[]; now: number; evidence: SideEvidence | null; ev: Evidence | null; dtLoaded: boolean }) {
  const isLong = side === 'long';
  const color = isLong ? 'var(--color-up)' : 'var(--color-down)';
  const [openCode, setOpenCode] = useState<string | null>(null);
  const active = rows.filter(r => r.alert?.phase === 'on').length;
  return (
    <section style={{ minWidth: 0, borderRadius: 10, border: `1px solid ${isLong ? 'rgba(240,62,62,0.35)' : 'rgba(47,158,68,0.35)'}`, background: isLong ? 'rgba(240,62,62,0.03)' : 'rgba(47,158,68,0.03)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '8px 10px 4px', minHeight: '3.6em' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 900, color, fontSize: 'calc(14px * var(--fz))' }}>{isLong ? '▲ 做多當沖' : '▼ 做空當沖'}</span>
          <span style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>{isLong ? '盤中漲停預測（A 榜＋備位）·僅列可先買後賣當沖、排除處置股' : '即時轉空型態→觀察→不建議·僅列可先賣當沖、排除處置股'} · {rows.length} 檔{active ? <b style={{ color }}> · 成立中 {active}</b> : null}</span>
        </div>
        <div style={{ fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)', marginTop: 2 }}>
          {evidence && ev
            ? <>警示回放（{ev.from}～{ev.to}·樣本外 n={evidence.all.teN}）：成立後收盤前達 +2% <b>{evidence.all.teHit2}%</b>（10 點前 {evidence.early.teHit2}%／後 {evidence.late.teHit2}%）；跟 🏁 出場淨 <b style={{ color: upDn(evidence.all.teStop) }}>{pct(evidence.all.teStop)}</b>、抱到收盤 <b style={{ color: upDn(evidence.all.teClose) }}>{pct(evidence.all.teClose)}</b>（已扣當沖成本）</>
            : '1 分 K 警示回放證據尚未寫入'}
        </div>
      </div>
      {/* 表頭：第 2 行六欄標籤（兩欄同一組），sticky 讓捲動時仍對得到欄位 */}
      <div style={{ height: 'max(480px, calc(100vh - 330px))', overflowY: 'auto', padding: '0 6px 6px' }}>
        <div style={{ position: 'sticky', top: 0, zIndex: 1, background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-primary)', padding: '4px 8px', fontSize: 'calc(11px * var(--fz))', color: 'var(--text-muted)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: LINE1, columnGap: 6 }}>
            <span>警示</span><span>#</span><span>代號</span><span>名稱</span><span style={{ textAlign: 'right' }}>即時</span><span style={{ textAlign: 'right' }}>漲跌</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: LINE2, columnGap: 6 }}>
            <span title="即時價相對今日 VWAP 的乖離" style={{ textAlign: 'right' }}>VWAP乖離</span>
            <span title="最近一根 1 分 K 量 ÷ 前 10 根均量（僅監控中個股）" style={{ textAlign: 'right' }}>1分量比</span>
            <span title={isLong ? '距漲停價的空間；<2% 不發警示（回放：貼漲停者 0% 能再漲 2%）' : '距下檔目標（VWAP 與昨收取高者）的空間，僅供參考'} style={{ textAlign: 'right' }}>空間</span>
            <span style={{ textAlign: 'right' }}>最高漲幅</span>
            <span title="自今日最高回吐（以昨收為基準，百分點）" style={{ textAlign: 'right' }}>回吐</span>
            <span title={isLong ? '漲停預測模型分' : '轉空型態強度：強／中／弱＝回放兩段皆正；觀察＝未成立型態；避＝回放兩段皆負'} style={{ textAlign: 'right' }}>{isLong ? '模型分' : '型態'}</span>
          </div>
        </div>
        {!rows.length
          ? <div style={{ padding: '16px 8px', color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))' }}>{!dtLoaded ? '當沖資格名單載入中（或暫時無法取得）：確認可當沖前不列任何個股。' : isLong ? '盤中漲停預測名單中目前沒有可當沖的個股。' : '目前沒有可先賣當沖且符合的做空型態。'}</div>
          : rows.map(r => <DualRowView key={r.code} r={r} now={now} ev={evidence} open={openCode === r.code} onToggle={() => setOpenCode(c => (c === r.code ? null : r.code))} />)}
      </div>
    </section>
  );
}

function DualRowView({ r, now, ev, open, onToggle }: { r: DualRow; now: number; ev: SideEvidence | null; open: boolean; onToggle: () => void }) {
  const navigateTo = useAppStore(s => s.navigateTo);
  const dt = useDayTradeCodes();
  const isLong = r.side === 'long';
  const a = r.alert;
  const isOn = a?.phase === 'on';
  const isStop = a?.phase === 'stop' && !!a.stopAt && now - a.stopAt < STOP_KEEP_MS;
  const flash = (isOn && now - a!.since < FLASH_ON_MS) || (isStop && now - a!.stopAt! < FLASH_STOP_MS);
  const cls = ['dt-row', isOn ? (isLong ? 'dt-on-long' : 'dt-on-short') : isStop ? 'dt-stop' : '', flash ? 'dt-flash' : ''].filter(Boolean).join(' ');
  const dts = statusOf(dt, r.code);
  const icon = isOn ? (isLong ? '▲' : '▼') : isStop ? '🏁' : '';
  const iconColor = isOn ? (isLong ? 'var(--color-up)' : 'var(--color-down)') : '#f59e0b';
  // 第 3 行：警示優先，其次入榜理由
  const bestMove = a ? (isLong ? (a.best / a.entry - 1) * 100 : (1 - a.best / a.entry) * 100) : null;
  // 該警示所屬時段的回放兌現率（10 點前／後差很多：多 54% vs 31%）
  const bucket = a && ev ? (new Date(a.since + 8 * 3600000).getUTCHours() < 10 ? ev.early : ev.late) : null;
  const odds = bucket ? ` · 歷史達+2% ${bucket.teHit2}%` : '';
  const line3 = isOn ? <span style={{ color: isLong ? 'var(--color-up)' : 'var(--color-down)', fontWeight: 800 }}>{isLong ? '▲ 轉強' : '▼ 轉弱'} {hhmm(a!.since)} · {isLong ? '進' : '空'} {a!.entry} · 空間 {a!.room.toFixed(1)}% · 至今{isLong ? '最高' : '最大'} {pct(bestMove)}{odds}</span>
    : isStop ? <span style={{ color: '#f59e0b', fontWeight: 800 }}>🏁 {isLong ? '出貨' : '回補'} {hhmm(a!.stopAt)} @{a!.stopPx} · 訊號區間 {pct(a!.ret)}（未扣成本）</span>
    : <span style={{ color: 'var(--text-muted)' }}>{r.reason}</span>;
  return (
    <div className={cls} data-anchor={r.code} style={{ borderRadius: 8, marginTop: 3, ...(cls === 'dt-row' ? { background: open ? 'rgba(61,142,248,0.10)' : 'rgba(148,163,184,0.05)' } : {}) }}>
      <div onClick={onToggle} title="點列展開即時走勢；點代號開個股" style={{ padding: '5px 8px', cursor: 'pointer', fontSize: 'calc(13.5px * var(--fz))' }}>
        <div style={{ display: 'grid', gridTemplateColumns: LINE1, columnGap: 6, alignItems: 'center' }}>
          <span style={{ fontWeight: 900, color: iconColor, textAlign: 'center' }}>{icon}</span>
          <span style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)', fontWeight: 700 }}>{r.rank ?? '·'}</span>
          <span onClick={e => { e.stopPropagation(); navigateTo('stock', r.code); }} style={{ fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", textDecoration: 'underline dotted' }}>{r.code}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
            <span title={r.name} style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{r.name}</span>
            <span style={{ fontSize: 'calc(11px * var(--fz))', color: r.market === 'otc' ? '#f59e0b' : '#3d8ef8', flexShrink: 0 }}>{r.market === 'otc' ? '櫃' : '市'}</span>
            {dts != null && <span style={{ flexShrink: 0 }}><DayTradeMark status={dts} size="xs" /></span>}
            <span style={{ flexShrink: 0 }}><RiskBadge code={r.code} size="xs" /></span>
            <span onClick={e => e.stopPropagation()} style={{ flexShrink: 0 }}><AddCandidateButton code={r.code} variant="icon" /></span>
          </span>
          <span style={{ ...NUM, fontWeight: 700 }}>{r.price ?? '—'}</span>
          <span style={{ ...NUM, fontWeight: 800, color: upDn(r.chg) }}>{pct(r.chg)}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: LINE2, columnGap: 6, alignItems: 'center', fontSize: 'calc(12.5px * var(--fz))', marginTop: 2 }}>
          <span style={{ ...NUM, color: upDn(r.vwapDev) }}>{pct(r.vwapDev)}</span>
          <span style={{ ...NUM, color: (r.volX1m ?? 0) >= 2 ? '#f59e0b' : 'var(--text-muted)', fontWeight: (r.volX1m ?? 0) >= 2 ? 800 : 600 }}>{r.volX1m != null ? `${r.volX1m.toFixed(1)}x` : '—'}</span>
          <span style={{ ...NUM, fontWeight: 800, color: r.room == null ? 'var(--text-muted)' : r.room >= 2 ? (isLong ? 'var(--color-up)' : 'var(--color-down)') : 'var(--text-muted)' }}>{r.room != null ? `${r.room.toFixed(1)}%` : '—'}</span>
          <span style={{ ...NUM, color: 'var(--color-up)' }}>{pct(r.hiUp, 1)}</span>
          <span style={{ ...NUM, color: 'var(--color-down)' }}>{r.give != null ? `−${r.give.toFixed(1)}` : '—'}</span>
          <span style={{ ...NUM, fontWeight: 800, color: r.scoreColor }}>{r.score}</span>
        </div>
        <div title={r.reason} style={{ fontSize: 'calc(12px * var(--fz))', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{line3}</div>
      </div>
      {open && (
        <div style={{ padding: '4px 10px 10px' }} onClick={e => e.stopPropagation()}>
          <StockTrendChart code={r.code} name={r.name} closePrice={r.price ?? 0} changePercent={r.chg ?? 0} />
        </div>
      )}
    </div>
  );
}
