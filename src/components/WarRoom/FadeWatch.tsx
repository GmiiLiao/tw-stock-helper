'use client';

// ── 📉 即時轉空預測（即時漲跌頁子分頁；2026-09-23 使用者：用於盤中做空當沖）──────────
// 資料：即時漲跌頁已下載的全市場快照（開高低、即時價、量、成交金額），前端計算，不新增任何上游請求。
// 規則與數字來自 scripts/fade-intraday-lab.mjs 的 5 分 K 逐根回放（見下方 PATTERNS 註解）——
//   第一版用「收盤口徑、隔日收跌率」當證據，但做空當沖真正要的是「成立當下賣出、收盤回補」的淨報酬，已改。
//   只保留訓練段與樣本外**都為正**的型態；兩段都為負的列入「不建議放空」。不可先賣當沖的股票一律排除到該區。
import { useMemo, useState } from 'react';
import StockTrendChart from '@/components/WatchlistTracker/StockTrendChart';
import AddCandidateButton from '@/components/Candidates/AddCandidateButton';
import RiskBadge from '@/components/shared/RiskBadge';
import { useAppStore } from '@/lib/store';
import { useDayTradeCodes, statusOf } from '@/lib/useDayTradeCodes';
import { DayTradeMark } from '@/components/shared/DayTradeBadge';

export interface FadeSnap {
  code: string; name: string; price: number; change: number; changePercent: number;
  volume: number; volX: number | null; market: string; open: number; high: number; low: number; value?: number | null;
}

type Tier = 'A' | 'B' | 'C' | 'X';
interface Metrics { hiUp: number; give: number; chg: number; openUp: number; openFall: number; volX: number; pace: number; aboveVwap: boolean | null; hm: number }
interface Pattern { key: string; label: string; tier: Tier; oos: string; train: string; test: (m: Metrics) => boolean }

// ── 盤中做空回放實證（scripts/fade-intraday-lab.mjs，2026-07-03～09-23，5 分 K 逐根回放）──
//   成立當根收盤賣出（現股當沖先賣）、官方收盤回補，淨＝扣當沖成本 0.435%（未含折讓）。訓練＝前 60% 交易日、樣本外＝後 40%。
//   全部型態合併做空：訓練淨均 −0.08%、樣本外 −0.35% ⇒ 不分辨就放空是賠錢的；以下只留兩段都為正的，並把兩段都為負的列成「不建議放空」。
const PATTERNS: Pattern[] = [
  { key: 'luVwap', label: '漲停打開·仍在VWAP上', tier: 'A', oos: '樣本外淨 +1.89%／勝率 57%（n=68）', train: '訓練 +2.06%（n=196）', test: m => m.hiUp >= 9.4 && m.give >= 3 && m.aboveVwap === true },
  { key: 'luOpen', label: '漲停打開回落', tier: 'A', oos: '樣本外淨 +0.84%／勝率 51%（n=315）', train: '訓練 +0.53%（n=796）', test: m => m.hiUp >= 9.4 && m.give >= 3 },
  { key: 'earlyDeep', label: '早盤深回吐（10 點前回吐≥6）', tier: 'A', oos: '樣本外淨 +0.79%／勝率 51%（n=61）', train: '訓練 +1.25%（n=158）', test: m => m.hm < 600 && m.give >= 6 },
  { key: 'spikeVol', label: '沖高回落＋爆量', tier: 'B', oos: '樣本外淨 +0.29%／勝率 54%（n=894）', train: '訓練 +0.41%（n=1,561）', test: m => m.hiUp >= 5 && m.give >= 4 && m.pace >= 2 },
  { key: 'spike', label: '沖高回落（量未放大）', tier: 'C', oos: '樣本外淨 +0.04%（約損益兩平）', train: '訓練 +0.16%', test: m => m.hiUp >= 5 && m.give >= 4 },
];
// 兩段都為負：列出但標「不建議放空」
const AVOID: { key: string; label: string; why: string; test: (m: Metrics) => boolean }[] = [
  { key: 'flipped', label: '已翻黑', why: '追空已翻黑：訓練 −0.56%／樣本外 −1.32%', test: m => m.hiUp >= 3 && m.chg < 0 },
  { key: 'openFall', label: '開高走低', why: '訓練 −0.54%／樣本外 −0.68%', test: m => m.openUp >= 2 && m.openFall >= 2 },
  { key: 'lowPace', label: '量能不足', why: '量能節奏<2x：訓練 −0.58%／樣本外 −1.20%', test: m => m.hiUp >= 5 && m.give >= 4 && m.pace < 2 && m.hiUp < 9.4 },
];
const TIER_STYLE: Record<Tier, { c: string; bg: string; t: string }> = {
  A: { c: '#2f9e44', bg: 'rgba(47,158,68,0.20)', t: '強' },
  B: { c: '#4ade80', bg: 'rgba(74,222,128,0.12)', t: '中' },
  C: { c: 'var(--text-muted)', bg: 'rgba(148,163,184,0.12)', t: '弱' },
  X: { c: '#f59e0b', bg: 'rgba(245,158,11,0.12)', t: '避' },
};
const GRID = '12px 1.7em 3.8em minmax(6em, 9em) 2em 5em 4.8em 4.8em 4.4em 4.2em 3em minmax(9em, 1fr)';
const NUM = (color: string, weight = 600): React.CSSProperties => ({ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums', color, fontWeight: weight, whiteSpace: 'nowrap' });
const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

// 台北時間的「盤中分鐘數」與已過交易時段比例（量能節奏＝今日量比÷已過時段比例；時間規則只在盤中套用）
function sessionClock(marketOpen: boolean): { hm: number; frac: number } {
  if (!marketOpen) return { hm: 999, frac: 1 };
  const t = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const hm = t.getHours() * 60 + t.getMinutes();
  return { hm, frac: Math.min(1, Math.max(0.05, (hm - 540) / 270)) };
}

// compact 時數字欄包成第二行（跨整列、自己一套欄寬）
function FadeNums({ compact, children }: { compact: boolean; children: React.ReactNode }) {
  if (!compact) return <>{children}</>;
  return <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: GRID_C2, columnGap: 8, alignItems: 'center', paddingLeft: '3.2em' }}>{children}</div>;
}
type Row = { s: FadeSnap; m: Metrics; main: Pattern; also: Pattern[]; demote?: string };
type AvoidRow = { s: FadeSnap; m: Metrics; why: string };

// compact（多空同屏半寬欄）：每檔兩行——代號名稱＋型態一行、數字一行，560px 內全部欄位可見
const GRID_C1 = '12px 1.7em 3.8em minmax(0, 1fr) 2em';
const GRID_C2 = '5em 4.8em 4.8em 4.4em 4.2em 3em';
export default function FadeWatch({ snaps, marketOpen, compact = false }: { snaps: FadeSnap[]; marketOpen: boolean; compact?: boolean }) {
  const navigateTo = useAppStore(s => s.navigateTo);
  const dt = useDayTradeCodes();
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [minTier, setMinTier] = useState<Tier>('B');
  const [showAvoid, setShowAvoid] = useState(false);

  const { rows, avoid } = useMemo(() => {
    const { hm, frac } = sessionClock(marketOpen);
    const rank: Record<Tier, number> = { A: 0, B: 1, C: 2, X: 3 };
    const out: Row[] = []; const av: AvoidRow[] = [];
    for (const s of snaps) {
      if (!/^\d{4}$/.test(s.code) || s.code.startsWith('00')) continue;
      const prev = s.price - s.change;
      if (!(prev > 10) || !(s.high > 0) || !(s.price > 0)) continue;
      if ((s.volume || 0) / 1000 < 500) continue;   // 與回測同一流動性門檻
      const vwap = s.value && s.volume ? s.value / s.volume : null;
      const volX = s.volX ?? 0;
      const m: Metrics = {
        hiUp: (s.high / prev - 1) * 100, give: (s.high - s.price) / prev * 100, chg: s.changePercent,
        openUp: s.open > 0 ? (s.open / prev - 1) * 100 : 0, openFall: s.open > 0 ? (s.open - s.price) / s.open * 100 : 0,
        volX, pace: volX / frac, aboveVwap: vwap ? s.price > vwap : null, hm,
      };
      if (m.hiUp < 3) continue;
      const dts = statusOf(dt, s.code);
      if (dts != null && dts !== 1) { if (m.hiUp >= 5) av.push({ s, m, why: dts === 2 ? '僅先買後賣：不可先賣當沖（無法放空）' : '不可現股當沖（處置股等）：無法放空' }); continue; }
      const bad = AVOID.find(a => a.test(m));
      const hits = PATTERNS.filter(p => p.test(m));
      // 已翻黑／開高走低／量能不足：兩段都為負 ⇒ 除非同時是「漲停打開」這種兩段都為正的強型態，否則歸入不建議放空
      if (bad && !(hits[0] && hits[0].tier === 'A' && hits[0].key.startsWith('lu'))) { av.push({ s, m, why: `${bad.label}：${bad.why}` }); continue; }
      if (!hits.length) continue;
      const main = hits[0];
      let demote: string | undefined;
      if (marketOpen && hm >= 720) demote = '12:00 後進場：訓練 −0.52%／樣本外 −0.30%，勝率僅 30～35%';
      out.push({ s, m, main: demote ? { ...main, tier: 'X' } : main, also: hits.slice(1), demote });
    }
    return {
      rows: out.filter(r => rank[r.main.tier] <= rank[minTier] || (minTier === 'C' && r.main.tier === 'X'))
        .sort((a, b) => rank[a.main.tier] - rank[b.main.tier] || b.m.give - a.m.give).slice(0, 80),
      avoid: av.sort((a, b) => b.m.give - a.m.give).slice(0, 40),
    };
  }, [snaps, minTier, marketOpen, dt]);

  const rowView = (s: FadeSnap, m: Metrics, tag: React.ReactNode) => {
    const open = openCode === s.code;
    return (
      <div key={s.code} data-anchor={s.code} style={{ borderRadius: 8, background: open ? 'rgba(61,142,248,0.10)' : 'rgba(148,163,184,0.05)', marginBottom: 3 }}>
        <div onClick={() => setOpenCode(c => (c === s.code ? null : s.code))} title="點列展開即時走勢；點代號開個股"
          style={{ display: 'grid', gridTemplateColumns: compact ? GRID_C1 : GRID, columnGap: 8, rowGap: 3, alignItems: 'center', padding: '5px 8px', fontSize: 'calc(13.5px * var(--fz))', cursor: 'pointer' }}>
          <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{open ? '▾' : '▸'}</span>
          <span onClick={e => e.stopPropagation()}><AddCandidateButton code={s.code} variant="icon" /></span>
          <span onClick={e => { e.stopPropagation(); navigateTo('stock', s.code); }} style={{ fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", textDecoration: 'underline dotted' }}>{s.code}</span>
          <span title={s.name} style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name} {(() => { const st = statusOf(dt, s.code); return st == null ? null : <DayTradeMark status={st} size="xs" />; })()} <RiskBadge code={s.code} size="xs" /></span>
          <span style={{ fontSize: 'calc(12px * var(--fz))', textAlign: 'center', color: s.market === 'otc' ? '#f59e0b' : '#3d8ef8' }}>{s.market === 'otc' ? '櫃' : '市'}</span>
          <FadeNums compact={compact}>
          <span style={NUM('var(--text-primary)', 700)}>{s.price}</span>
          <span style={NUM(m.chg >= 0 ? 'var(--color-up)' : 'var(--color-down)', 800)}>{pct(m.chg)}</span>
          <span style={NUM('var(--color-up)')}>{pct(m.hiUp)}</span>
          <span style={NUM('var(--color-down)', 800)}>−{m.give.toFixed(1)}</span>
          <span title={`量比 ${m.volX.toFixed(1)}x ÷ 已過時段 → 全日節奏 ${m.pace.toFixed(1)}x`} style={NUM(m.pace >= 2 ? '#f59e0b' : 'var(--text-muted)')}>{m.pace ? `${m.pace.toFixed(1)}x` : '—'}</span>
          <span style={NUM(m.aboveVwap == null ? 'var(--text-muted)' : m.aboveVwap ? 'var(--color-up)' : 'var(--color-down)')}>{m.aboveVwap == null ? '—' : m.aboveVwap ? '上' : '下'}</span>
          </FadeNums>
          <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', fontSize: 'calc(12px * var(--fz))', gridColumn: compact ? '1 / -1' : undefined, paddingLeft: compact ? '3.2em' : undefined }}>{tag}</span>
        </div>
        {open && (
          <div style={{ padding: '4px 10px 10px' }} onClick={e => e.stopPropagation()}>
            <StockTrendChart code={s.code} name={s.name} closePrice={s.price} changePercent={s.changePercent} />
          </div>
        )}
      </div>
    );
  };

  const header = compact ? (
    <div style={{ display: 'grid', gridTemplateColumns: GRID_C2, columnGap: 8, padding: '2px 8px 4px 3.2em', fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-primary)', marginBottom: 4 }}>
      <span style={{ textAlign: 'right' }}>即時</span><span style={{ textAlign: 'right' }}>漲跌</span><span style={{ textAlign: 'right' }}>最高漲幅</span><span style={{ textAlign: 'right' }}>回吐</span><span style={{ textAlign: 'right' }}>量節奏</span><span style={{ textAlign: 'right' }}>VWAP</span>
    </div>
  ) : (
    <div style={{ display: 'grid', gridTemplateColumns: GRID, columnGap: 8, padding: '2px 8px 4px', fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-primary)', marginBottom: 4 }}>
      <span /><span /><span>代號</span><span>名稱</span><span style={{ textAlign: 'center' }}>市</span>
      <span style={{ textAlign: 'right' }}>即時</span><span style={{ textAlign: 'right' }}>漲跌</span>
      <span title="今日最高相對昨收" style={{ textAlign: 'right' }}>最高漲幅</span>
      <span title="自今日最高回吐的幅度（以昨收為基準，百分點）" style={{ textAlign: 'right' }}>回吐</span>
      <span title="量能節奏＝今日量比÷已過交易時段比例（全日步調）" style={{ textAlign: 'right' }}>量節奏</span>
      <span title="即時價相對今日 VWAP（成交金額÷成交量）" style={{ textAlign: 'right' }}>VWAP</span>
      <span>做空型態（盤中回放：成立即賣、收盤回補、扣當沖成本）</span>
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginBottom: 6 }}>
        <span>盤中強過、正在轉弱且<b>可先賣當沖</b>的股票{!marketOpen ? '· ⏸ 非盤中：顯示最後快照，時間規則（10 點前、12 點後）不套用' : ''}</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
          顯示
          {(['A', 'B', 'C'] as Tier[]).map(t => (
            <button key={t} onClick={() => { setMinTier(t); setOpenCode(null); }}
              style={{ padding: '2px 10px', borderRadius: 999, border: '1px solid var(--border-primary)', cursor: 'pointer', fontSize: 'calc(12px * var(--fz))', fontWeight: 700,
                background: minTier === t ? TIER_STYLE[t].bg : 'transparent', color: minTier === t ? TIER_STYLE[t].c : 'var(--text-muted)' }}>
              {t === 'A' ? '只看強訊號' : t === 'B' ? '強＋中' : '全部'}
            </button>
          ))}
        </span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <div style={{ minWidth: compact ? 0 : 820 }}>
          {header}
          {!rows.length
            ? <div style={{ padding: '14px 8px', color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))' }}>目前沒有符合的做空型態。</div>
            : rows.map(({ s, m, main, also, demote }) => {
              const st = TIER_STYLE[main.tier];
              return rowView(s, m, <>
                <span title={`${main.oos}；${main.train}${demote ? `\n⚠ ${demote}` : ''}`} style={{ padding: '1px 7px', borderRadius: 6, fontWeight: 700, background: st.bg, color: st.c }}>{st.t}·{main.label}</span>
                <span style={{ color: 'var(--text-muted)' }}>{main.oos}</span>
                {demote && <span style={{ color: '#f59e0b' }}>⚠ 12:00 後</span>}
                {also.length ? <span style={{ color: 'var(--text-muted)' }}>＋{also.map(p => p.label).join('、')}</span> : null}
              </>);
            })}
          {avoid.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <button onClick={() => setShowAvoid(v => !v)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#f59e0b', fontWeight: 700, fontSize: 'calc(12.5px * var(--fz))' }}>
                {showAvoid ? '▾' : '▸'} 🚫 不建議放空 {avoid.length} 檔（回放兩段皆為淨損，或不可先賣當沖）
              </button>
              {showAvoid && <div style={{ marginTop: 4, opacity: 0.85 }}>{avoid.map(({ s, m, why }) => rowView(s, m, <span style={{ color: '#f59e0b' }}>{why}</span>))}</div>}
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 8, fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.6 }}>
        數字來自 60 個交易日 5 分 K 逐根回放（2026-07-03～09-23；前 60% 日為訓練、後 40% 為樣本外）：型態<b>成立那一根</b>賣出、官方收盤回補，淨報酬已扣當沖成本 0.435%（手續費未含折讓、未含滑價）。
        不分辨型態一律放空的樣本外淨均為 −0.35%，本頁只列兩段皆為正者。停損：進場後逆向最大幅度中位 1.6～2.4%，回放中 3% 停損優於 2%。
        樣本只有 60 天、強訊號樣本外僅 60～70 筆，數字會隨時間修正；平盤下放空與券源限制依券商規定。非投資建議。
      </div>
    </div>
  );
}
