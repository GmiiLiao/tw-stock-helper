'use client';

// ── 資券借券＋模型判讀條（個股分析頁/共用·與工作台/推選榜同源）──────
// 資料：/api/ai/margin-snap?code=（daemon marginSnap/latest，t-1 EOD）
//   row: [融資餘,融資增減,融券餘,融券增減,借券餘,借券增減,前20日高,昨量張,t-5收盤,KD的K值,是否跌破5日線]
// ＋chip-verdict（tier/勝率/倒貨/外資）＋market-index（跟風）＋chip-character（性格）
// → 共用 computeComposite：個股頁的 🧬評分/徽章 與全站完全同源（使用者回饋：
//   個股資料缺量比等——一併補 量比/收位/5日漲幅 顯示）。
// 訊號（全部回測背書，門檻與盤中雷達一致）：
//   ⚡軋空啟動 setup=昨券增≥昨量0.5%；觸發=setup＋今日漲>2%（2年 46.0-47.7%·淨正）
//   🏔突破新高 觸發=現價>前20日高（46.0%/+0.44% 配強尾盤）
//   ⚠弱尾盤   今日收位≤0.2 且 |漲跌|>1%（隔日均 -0.5%/筆——迴避）

import { useEffect, useState } from 'react';
import { METRIC_TIPS } from '@/lib/metric-tips';
import { computeComposite } from '@/lib/composite-score';

interface Props { code: string; price?: number; changePercent?: number; high?: number; low?: number; volume?: number }

const fmtLots = (n: number | null | undefined) => n == null ? '—' : Math.round(n).toLocaleString();
const chgTag = (n: number | null | undefined) => n == null ? '' : n > 0 ? `(+${Math.round(n).toLocaleString()})` : n < 0 ? `(${Math.round(n).toLocaleString()})` : '(0)';
const chgColor = (n: number | null | undefined) => n == null || n === 0 ? 'var(--text-muted)' : n > 0 ? '#f03e3e' : '#2f9e44';

export default function MarginSignals({ code, price, changePercent, high, low, volume }: Props) {
  const [row, setRow] = useState<(number | null)[] | null>(null);
  const [dataDate, setDataDate] = useState('');
  const [miss, setMiss] = useState(false);
  const [v, setV] = useState<{ win?: number; tier?: string; dist?: number; f?: number } | null>(null);
  const [idxChg, setIdxChg] = useState<number | null>(null);
  const [charLabel, setCharLabel] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRow(null); setMiss(false);
    fetch(`/api/ai/margin-snap?code=${code}`).then(r => (r.ok ? r.json() : null)).then(x => {
      if (!live) return;
      if (x?.found && Array.isArray(x.row)) { setRow(x.row); setDataDate(x.dataDate || ''); }
      else setMiss(true);
    }).catch(() => { if (live) setMiss(true); });
    fetch(`/api/ai/chip-verdict?codes=${code}`).then(r => (r.ok ? r.json() : null)).then(x => {
      if (!live) return; const b = x?.byCode?.[code]; if (b) setV(b);
    }).catch(() => {});
    fetch('/api/twse/market-index').then(r => (r.ok ? r.json() : null)).then(x => {
      if (live && x?.weightedChangePercent != null) setIdxChg(+x.weightedChangePercent);
    }).catch(() => {});
    fetch(`/api/ai/chip-character?codes=${code}`).then(r => (r.ok ? r.json() : null)).then(x => {
      if (!live) return; const r0 = x?.rows?.find?.((y: { code: string }) => y.code === code); if (r0?.label) setCharLabel(r0.label);
    }).catch(() => {});
    return () => { live = false; };
  }, [code]);

  if (miss) return null; // 無資券資料（如 ETF）不佔版面
  if (!row) return null;

  const [mg, mgC, sh, shC, ln, lnC, hi20, yv, c5, k9, bm5] = row;   // k9＝KD(9) K值（daemon marginSnap index 9）
  const chg = changePercent ?? 0;
  const sqzSetup = mgC != null && shC != null && (yv || 0) >= 300 && (shC || 0) >= (yv || 0) * 0.005;
  const pos = high != null && low != null && high > low && price != null ? (price - low) / (high - low) : null;
  // 量比＝今量/昨量（口徑相依：明開賣越高越好、抱到收盤忌爆量）
  const volX = volume != null && (yv || 0) > 0 ? (volume / 1000) / (yv as number) : null;
  const ret5 = (c5 ?? 0) > 0 && (price ?? 0) > 0 ? ((price as number) / (c5 as number) - 1) * 100 : null;
  // 全站同源綜合評分（與決策工作台/籌碼推選同一個 computeComposite）
  const comp = computeComposite({
    baseWin: v?.win, tier: v?.tier, price, chg,
    high, low, hi20, sqzSetup, c5, mktChg: idxChg,
    mgChg: mgC, foreignToday: v?.f, distributedPct: v?.dist, charLabel, k9, belowMA5: bm5 as boolean | null,
  });
  const strongClose = pos != null && pos >= 0.8;
  const srRatio = mg && mg > 0 && sh != null ? sh / mg * 100 : null;

  const badge = (txt: string, c: string, title: string) => (
    <span key={txt} title={title} style={{ fontSize: 11, fontWeight: 800, padding: '2px 8px', borderRadius: 8, background: `${c}1f`, color: c, border: `1px solid ${c}55`, whiteSpace: 'nowrap' }}>{txt}</span>
  );
  // 徽章＝共用 computeComposite 產生（含破高/軋空/強尾/弱尾/接棒/過熱/跟風·全站同語意）
  const badges: React.ReactNode[] = comp.badges.map(b => badge(b.t, b.c, b.tip));

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '7px 10px', borderRadius: 8, background: 'rgba(167,139,250,0.07)', border: '1px solid rgba(167,139,250,0.25)', fontSize: 12 }}>
      <span style={{ fontWeight: 900, color: '#a78bfa' }}>🧬 模型判讀</span>
      <span title={METRIC_TIPS.勝率雷達分級} style={{ cursor: 'help', fontWeight: 900, color: comp.score >= 60 ? '#f03e3e' : comp.score <= 55 ? '#2f9e44' : '#eab308'  /* 2026-08-01 錨移：基準毛勝56% → ≥60強/≤55弱 */ }}>
        評分 {comp.score}{v?.tier ? `（${v.tier}級${v.win ? ` ${v.win}%` : ''}）` : ''}
      </span>
      {charLabel && <span style={{ fontSize: 11, fontWeight: 800, color: charLabel === '炒作型' ? '#f59e0b' : charLabel === '長期核心' ? '#7dd3fc' : 'var(--text-muted)' }}>{charLabel}</span>}
      {volX != null && <span title={METRIC_TIPS.量比 ?? '今量/昨量'} style={{ cursor: 'help' }}>量比 <b>{volX.toFixed(1)}</b></span>}
      {pos != null && <span title="收盤位置＝(現價−日低)/(日高−日低)。⚠貼高單獨非優勢（強尾−2），須配20日高突破" style={{ cursor: 'help' }}>收位 <b>{Math.round(pos * 100)}%</b></span>}
      {ret5 != null && <span title={METRIC_TIPS.過熱 ?? '5日累計漲幅'} style={{ cursor: 'help', color: ret5 >= 20 ? '#fb7185' : undefined }}>5日 <b>{ret5 >= 0 ? '+' : ''}{ret5.toFixed(1)}%</b></span>}
      <span title={METRIC_TIPS.融資} style={{ cursor: 'help' }}>融資 <b>{fmtLots(mg)}</b><b style={{ color: chgColor(mgC), fontSize: 11 }}>{chgTag(mgC)}</b></span>
      <span title={METRIC_TIPS.融券} style={{ cursor: 'help' }}>融券 <b>{fmtLots(sh)}</b><b style={{ color: chgColor(shC), fontSize: 11 }}>{chgTag(shC)}</b></span>
      <span title={METRIC_TIPS.借券} style={{ cursor: 'help' }}>借券 <b>{fmtLots(ln)}</b><b style={{ color: chgColor(lnC), fontSize: 11 }}>{chgTag(lnC)}</b></span>
      {srRatio != null && <span title={METRIC_TIPS.券資比} style={{ cursor: 'help' }}>券資比 <b>{srRatio.toFixed(1)}%</b></span>}
      <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', marginLeft: 'auto' }}>{badges}</span>
      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>t-1({dataDate})·張</span>
    </div>
  );
}
