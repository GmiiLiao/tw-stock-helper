'use client';

// ── 📉 即時轉空預測（即時漲跌頁子分頁，2026-09-23 使用者）──────────────
// 資料：即時漲跌頁已下載的全市場快照（open/high/low/即時價/量比），前端計算，不新增任何上游請求。
// 口徑：「今天盤中強過、現在正在轉弱」的型態偵測。每個型態附上 250 日歷史對答案——
//   同型態在「收盤」成立後，隔日收盤低於當日收盤的比率（基準：全體 49.8%）。
//   這是**收盤口徑的代理驗證**：盤中偵測到的當下離收盤還有時間，實際結果可能不同；型態偵測不是訓練過的模型。
// 2026-09-23 回測（2025-10-01～2026-09-22，chipArchive，價>10、日量≥500 張）：
//   沖高回落＋爆量 n=5,087 隔日收跌 56.8%（均 −0.22%）；漲停打開回落 n=2,812 55.9%；沖高回落 n=10,554 54.2%；
//   翻黑＋爆量 n=2,999 52.8%；開高走低 n=8,500 51.5%；翻黑 n=10,091 50.5%。隔日**開盤**平均仍為正（不預示跳空開低）。
import { useMemo, useState } from 'react';
import StockTrendChart from '@/components/WatchlistTracker/StockTrendChart';
import AddCandidateButton from '@/components/Candidates/AddCandidateButton';
import RiskBadge from '@/components/shared/RiskBadge';
import { useAppStore } from '@/lib/store';

export interface FadeSnap {
  code: string; name: string; price: number; change: number; changePercent: number;
  volume: number; volX: number | null; market: string; open: number; high: number; low: number;
}

type Tier = 'A' | 'B' | 'C';
interface Pattern { key: string; label: string; tier: Tier; hist: number; n: number; test: (m: Metrics) => boolean }
interface Metrics { hiUp: number; give: number; chg: number; openUp: number; openFall: number; volX: number }

// 由強到弱排列；一檔可能同時符合多個，取最強那個當主型態、其餘列為附帶標籤
const PATTERNS: Pattern[] = [
  { key: 'spikeVol', label: '沖高回落＋爆量', tier: 'A', hist: 56.8, n: 5087, test: m => m.hiUp >= 5 && m.give >= 4 && m.volX >= 2 },
  { key: 'luOpen', label: '漲停打開回落', tier: 'A', hist: 55.9, n: 2812, test: m => m.hiUp >= 9.4 && m.give >= 3 },
  { key: 'spike', label: '沖高回落', tier: 'B', hist: 54.2, n: 10554, test: m => m.hiUp >= 5 && m.give >= 4 },
  { key: 'flipVol', label: '翻黑＋爆量', tier: 'B', hist: 52.8, n: 2999, test: m => m.hiUp >= 3 && m.chg < 0 && m.volX >= 2 },
  { key: 'openFall', label: '開高走低', tier: 'C', hist: 51.5, n: 8500, test: m => m.openUp >= 2 && m.openFall >= 2 },
  { key: 'flip', label: '翻黑', tier: 'C', hist: 50.5, n: 10091, test: m => m.hiUp >= 3 && m.chg < 0 },
];
const TIER_STYLE: Record<Tier, { c: string; bg: string; t: string }> = {
  A: { c: '#2f9e44', bg: 'rgba(47,158,68,0.18)', t: '強' },
  B: { c: '#4ade80', bg: 'rgba(74,222,128,0.12)', t: '中' },
  C: { c: 'var(--text-muted)', bg: 'rgba(148,163,184,0.12)', t: '弱' },
};
const GRID = '12px 1.7em 3.8em minmax(5em, 8em) 2em 5em 4.8em 4.8em 4.4em 3.8em minmax(8em, 1fr)';
const NUM = (color: string, weight = 600): React.CSSProperties => ({ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums', color, fontWeight: weight, whiteSpace: 'nowrap' });
const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

export default function FadeWatch({ snaps, marketOpen }: { snaps: FadeSnap[]; marketOpen: boolean }) {
  const navigateTo = useAppStore(s => s.navigateTo);
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [minTier, setMinTier] = useState<Tier>('B');

  const rows = useMemo(() => {
    const out: { s: FadeSnap; m: Metrics; main: Pattern; also: Pattern[] }[] = [];
    for (const s of snaps) {
      if (!/^\d{4}$/.test(s.code) || s.code.startsWith('00')) continue;
      const prev = s.price - s.change;
      if (!(prev > 10) || !(s.high > 0) || !(s.price > 0)) continue;
      if ((s.volume || 0) / 1000 < 500) continue;   // 與回測同一流動性門檻
      const m: Metrics = {
        hiUp: (s.high / prev - 1) * 100,
        give: (s.high - s.price) / prev * 100,
        chg: s.changePercent,
        openUp: s.open > 0 ? (s.open / prev - 1) * 100 : 0,
        openFall: s.open > 0 ? (s.open - s.price) / s.open * 100 : 0,
        volX: s.volX ?? 0,
      };
      const hits = PATTERNS.filter(p => p.test(m));
      if (!hits.length) continue;
      out.push({ s, m, main: hits[0], also: hits.slice(1) });
    }
    const rank: Record<Tier, number> = { A: 0, B: 1, C: 2 };
    return out
      .filter(r => rank[r.main.tier] <= rank[minTier])
      .sort((a, b) => rank[a.main.tier] - rank[b.main.tier] || b.m.give - a.m.give)
      .slice(0, 80);
  }, [snaps, minTier]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) c[r.main.key] = (c[r.main.key] || 0) + 1;
    return c;
  }, [rows]);

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginBottom: 6 }}>
        <span>今天盤中強過、現在正在轉弱的股票（型態偵測，前端即時計算）{!marketOpen ? '· ⏸ 非盤中，顯示最後快照' : ''}</span>
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
        <div style={{ minWidth: 760 }}>
          <div style={{ display: 'grid', gridTemplateColumns: GRID, columnGap: 8, padding: '2px 8px 4px', fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-primary)', marginBottom: 4 }}>
            <span /><span /><span>代號</span><span>名稱</span><span style={{ textAlign: 'center' }}>市</span>
            <span style={{ textAlign: 'right' }}>即時</span><span style={{ textAlign: 'right' }}>漲跌</span>
            <span title="今日最高相對昨收" style={{ textAlign: 'right' }}>最高漲幅</span>
            <span title="自今日最高回吐的幅度（以昨收為基準，百分點）" style={{ textAlign: 'right' }}>回吐</span>
            <span title="今日量對 20 日均量" style={{ textAlign: 'right' }}>量比</span>
            <span>型態（歷史隔日收跌率）</span>
          </div>
          {!rows.length ? (
            <div style={{ padding: '14px 8px', color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))' }}>目前沒有符合的轉弱型態。</div>
          ) : rows.map(({ s, m, main, also }) => {
            const open = openCode === s.code;
            const st = TIER_STYLE[main.tier];
            return (
              <div key={s.code} data-anchor={s.code} style={{ borderRadius: 8, background: open ? 'rgba(61,142,248,0.10)' : 'rgba(148,163,184,0.05)', marginBottom: 3 }}>
                <div onClick={() => setOpenCode(c => (c === s.code ? null : s.code))} title="點列展開即時走勢；點代號開個股"
                  style={{ display: 'grid', gridTemplateColumns: GRID, columnGap: 8, alignItems: 'center', padding: '5px 8px', fontSize: 'calc(13.5px * var(--fz))', cursor: 'pointer' }}>
                  <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{open ? '▾' : '▸'}</span>
                  <span onClick={e => e.stopPropagation()}><AddCandidateButton code={s.code} variant="icon" /></span>
                  <span onClick={e => { e.stopPropagation(); navigateTo('stock', s.code); }} style={{ fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", textDecoration: 'underline dotted' }}>{s.code}</span>
                  <span title={s.name} style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name} <RiskBadge code={s.code} size="xs" /></span>
                  <span style={{ fontSize: 'calc(12px * var(--fz))', textAlign: 'center', color: s.market === 'otc' ? '#f59e0b' : '#3d8ef8' }}>{s.market === 'otc' ? '櫃' : '市'}</span>
                  <span style={NUM('var(--text-primary)', 700)}>{s.price}</span>
                  <span style={NUM(m.chg >= 0 ? 'var(--color-up)' : 'var(--color-down)', 800)}>{pct(m.chg)}</span>
                  <span style={NUM('var(--color-up)')}>{pct(m.hiUp)}</span>
                  <span style={NUM('var(--color-down)', 800)}>−{m.give.toFixed(1)}</span>
                  <span style={NUM(m.volX >= 2 ? '#f59e0b' : 'var(--text-muted)')}>{m.volX ? `${m.volX.toFixed(1)}x` : '—'}</span>
                  <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', fontSize: 'calc(12px * var(--fz))' }}>
                    <span title={`250 日回測：收盤出現此型態 n=${main.n.toLocaleString()}，隔日收盤低於當日 ${main.hist}%（基準 49.8%）`}
                      style={{ padding: '1px 7px', borderRadius: 6, fontWeight: 700, background: st.bg, color: st.c }}>{st.t}·{main.label} {main.hist}%</span>
                    {also.map(p => <span key={p.key} style={{ color: 'var(--text-muted)' }}>{p.label}</span>)}
                  </span>
                </div>
                {open && (
                  <div style={{ padding: '4px 10px 10px' }} onClick={e => e.stopPropagation()}>
                    <StockTrendChart code={s.code} name={s.name} closePrice={s.price} changePercent={s.changePercent} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ marginTop: 8, fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.6 }}>
        {Object.keys(counts).length ? <>本頁：{PATTERNS.filter(p => counts[p.key]).map(p => `${p.label} ${counts[p.key]}`).join('、')}。</> : null}
        百分比＝250 日回測中，同型態在<b>收盤</b>成立後，隔日收盤低於當日收盤的比率（全體基準 49.8%）。
        這是收盤口徑的代理驗證：盤中偵測到時離收盤還有時間，結果可能不同；隔日<b>開盤</b>平均仍偏正，不代表會跳空開低。
        型態偵測不是訓練過的模型，最強的訊號優勢也只有約 7 個百分點。非投資建議。
      </div>
    </div>
  );
}
