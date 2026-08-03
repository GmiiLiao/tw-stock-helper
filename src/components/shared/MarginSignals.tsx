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
import { useAppStore } from '@/lib/store';
import { MODES, canShowScore } from '@/lib/trading-mode';
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

  const [mg, mgC, sh, shC, ln, lnC, hi20, yv, c5, k9, bm5, vol20, rsiSt] = row;   // k9＝KD(9) K值（daemon marginSnap index 9）、vol20＝20日波動%（index 11）、rsiSt＝RSI狀態向量（index 12）
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
    mgChg: mgC, foreignToday: v?.f, distributedPct: v?.dist, charLabel, k9, belowMA5: bm5 as boolean | null, vol20,
  });
  const strongClose = pos != null && pos >= 0.8;
  const srRatio = mg && mg > 0 && sh != null ? sh / mg * 100 : null;

  const badge = (txt: string, c: string, title: string) => (
    <span key={txt} title={title} style={{ fontSize: 11, fontWeight: 800, padding: '2px 8px', borderRadius: 8, background: `${c}1f`, color: c, border: `1px solid ${c}55`, whiteSpace: 'nowrap' }}>{txt}</span>
  );
  // 徽章＝共用 computeComposite 產生（含破高/軋空/強尾/弱尾/接棒/過熱/跟風·全站同語意）
  const badges: React.ReactNode[] = comp.badges.map(b => badge(b.t, b.c, b.tip));

  // ── 模式感知（2026-08-03 模式化）────────────────────────────────
  // 評分是**隔日沖口徑**的產物。在波段/當沖模式顯示它會讓人以為那個數字
  // 適用於自己的持有期——那正是本站最貴的一類誤用。無評分模型的模式一律不顯示。
  const _mode = useAppStore(s => s.tradingMode);
  const _M = MODES[_mode], _canScore = canShowScore(_mode);

  // ── 波段技巧：勿買在高點（2026-08-03）──────────────────────────────
  // ⚠**只顯示不計分**。這是波段口徑（持有5日）的實證，隔日沖綜合評分不含它——
  //   本站鐵律「5日持有語意與隔日沖口徑隔離」，混進去會讓兩個口徑互相污染。
  // 實證（screen-rsi85-exit.mjs·可交易宇宙 chg≤8.5%·扣費稅 0.4425%·買後5日）：
  //   基準 主窗 -0.125%/中位-0.693%、OOT +0.448%/-0.051%
  //   RSI5>85 主窗 -0.356%/-1.236%（Δ-0.231/-0.543）、OOT +0.194%/-0.443%（Δ-0.254/-0.392）
  //   雙高>85 主窗 -0.268%/-1.160%（Δ-0.143/-0.467）、OOT +0.164%/-0.641%（Δ-0.284/-0.590）
  //   三組在兩窗、均數與中位數**全部**較差 ⇒ 支持「勿買在高點」。
  // ⚠但對**已經持有的人**結論相反：續抱10日均 +1.0~+2.8%、真頂點率僅 1.1~1.35x
  //   ——高檔不是賣訊。同一個訊號對買方與持有者意義相反，這正是此技巧的重點。
  const liveRsi = (() => {
    const st = rsiSt as unknown as number[] | null | undefined;
    if (!Array.isArray(st) || st.length < 7 || !(price != null && price > 0) || !(st[6] > 0)) return null;
    const ch = price - st[6], g = Math.max(ch, 0), l = Math.max(-ch, 0);
    const u5 = (st[2] * 4 + g) / 5, d5 = (st[3] * 4 + l) / 5;
    const u10 = (st[4] * 9 + g) / 10, d10 = (st[5] * 9 + l) / 10;
    return { r5: +(u5 / (u5 + d5) * 100).toFixed(1), r10: +(u10 / (u10 + d10) * 100).toFixed(1) };
  })();
  const hotBuy = liveRsi && liveRsi.r5 > 85;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '7px 10px', borderRadius: 8, background: 'rgba(167,139,250,0.07)', border: '1px solid rgba(167,139,250,0.25)', fontSize: 12 }}>
      <span style={{ fontWeight: 900, color: '#a78bfa' }} title={`目前口徑：${_M.icon}${_M.label}（${_M.horizon}·${_M.exit.replace(/\*\*/g, '').split('——')[0]}）。本站每個數字都綁在一個口徑上，換模式就換一套實證。`}>
        🧬 模型判讀 <span style={{ fontSize: 10, fontWeight: 700, opacity: 0.85 }}>{_M.icon}{_M.label}</span>
      </span>
      {!_canScore && (
        <span title={`${_M.label}模式尚無經本站關卡驗證的評分模型，因此不顯示分數——顯示了就是憑空捏造。下方徽章仍為各自獨立驗證過的訊號。`}
          style={{ fontSize: 10.5, fontWeight: 800, color: '#fbbf24' }}>
          本模式無評分模型
        </span>
      )}
      {hotBuy && (
        <span
          title={`【波段技巧·只提醒不計分】RSI5 ${liveRsi!.r5}／RSI10 ${liveRsi!.r10}（>85 為高檔）。

買方實測（可交易宇宙·扣費稅·買後5日）：
· 基準 主窗 -0.125%／中位 -0.693%；OOT +0.448%／-0.051%
· RSI5>85 主窗 -0.356%／-1.236%；OOT +0.194%／-0.443%
· 雙高>85 主窗 -0.268%／-1.160%；OOT +0.164%／-0.641%
三組在兩窗、均數與中位數全部較差 → 現在買進的期望值低於隨機挑一檔。

⚠對「已經持有」的人結論相反：續抱10日均 +1.0~+2.8%、真頂點率僅 1.1~1.35x 基準——高檔不是賣訊。
同一個訊號對買方與持有者意義相反，這是本技巧的重點。

此為波段口徑（持有5日），不併入隔日沖綜合評分。非投資建議。`}
          style={{ cursor: 'help', fontSize: 11, fontWeight: 800, padding: '2px 8px', borderRadius: 8, background: '#fb923c1f', color: '#fb923c', border: '1px solid #fb923c55', whiteSpace: 'nowrap' }}
        >
          🌡勿買高點 RSI{liveRsi!.r5}{liveRsi!.r10 > 85 ? `/${liveRsi!.r10}` : ''}
        </span>
      )}
      {_canScore && (
        <span title={METRIC_TIPS.勝率雷達分級} style={{ cursor: 'help', fontWeight: 900, color: comp.score >= 60 ? '#f03e3e' : comp.score <= 55 ? '#2f9e44' : '#eab308'  /* 2026-08-01 錨移：基準毛勝56% → ≥60強/≤55弱 */ }}>
          評分 {comp.score}{v?.tier ? `（${v.tier}級${v.win ? ` ${v.win}%` : ''}）` : ''}
        </span>
      )}
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
