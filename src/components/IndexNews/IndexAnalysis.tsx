'use client';

// ── 📈 指數分析（2026-08-05 由「指數·新聞」獨立頁改為「市場總覽」分頁）──
// 加權/櫃買/費半/那指/S&P/道瓊/日經 日週月K＋MA5/20/60＋VOL/RSI/MACD/KD 副圖
// ＋確定性自動判讀（趨勢/乖離/位階/波動/價量/指標——規則計算、非 AI 生成）＋近 20 根歷史表。
//
// 為什麼併回市場總覽：指數就是「大盤背景」，而使用者看大盤時本來就在市場總覽。
// 讓它獨立一頁等於要人記住「看指數要換頁」——那正是使用習慣固定不下來的原因。
//
// ⚠ 指標口徑與誠實界線：RSI=Wilder 5/10（與全站一致）、KD=9日⅔平滑（同 calculateKD）、
//   MACD=EMA12/26/DEA9。本站實測（個股宇宙·bt-core）：MACD/KD 交叉類「確認型訊號」
//   無預測增量——副圖與判讀是**盤勢描述**，不是買賣訊號，文案不得暗示方向。

import { useCallback, useEffect, useMemo, useState } from 'react';

interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }

const SYMS = [
  { id: 'twii', label: '加權指數' }, { id: 'otc', label: '櫃買指數' },
  { id: 'sox', label: '費城半導體' }, { id: 'ixic', label: '那斯達克' },
  { id: 'gspc', label: 'S&P 500' }, { id: 'dji', label: '道瓊工業' }, { id: 'n225', label: '日經 225' },
];
const INTERVALS = [{ id: '1d', label: '日K' }, { id: '1wk', label: '週K' }, { id: '1mo', label: '月K' }] as const;
const WINDOWS = [60, 120, 250];
const UP = '#f03e3e', DOWN = '#2f9e44';

const fmtD = (t: number, iv: string) => {
  const d = new Date(t * 1000);
  return iv === '1mo' ? `${d.getFullYear()}/${d.getMonth() + 1}` : `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
};
const fmtN = (v: number) => v >= 10000 ? v.toLocaleString('zh-TW', { maximumFractionDigits: 0 }) : v.toLocaleString('zh-TW', { maximumFractionDigits: 2 });
const fmtV = (v: number) => v >= 1e8 ? `${(v / 1e8).toFixed(2)}億` : v >= 1e4 ? `${(v / 1e4).toFixed(1)}萬` : String(Math.round(v));

// 均線（尾端對齊）
function ma(bars: Bar[], p: number): (number | null)[] {
  const out: (number | null)[] = []; let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].c; if (i >= p) sum -= bars[i - p].c;
    out.push(i >= p - 1 ? sum / p : null);
  }
  return out;
}
function maOf(vals: number[], p: number): (number | null)[] {
  const out: (number | null)[] = []; let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i]; if (i >= p) sum -= vals[i - p];
    out.push(i >= p - 1 ? sum / p : null);
  }
  return out;
}

// RSI（Wilder·與全站/回測平台同口徑）
function rsiSeries(bars: Bar[], p: number): (number | null)[] {
  const out: (number | null)[] = [null];
  let g = 0, l = 0;
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].c - bars[i - 1].c;
    if (i <= p) {
      g += d > 0 ? d : 0; l += d < 0 ? -d : 0;
      out.push(i === p ? (l === 0 ? 100 : 100 - 100 / (1 + (g / p) / (l / p))) : null);
      if (i === p) { g /= p; l /= p; }
    } else {
      g = (g * (p - 1) + (d > 0 ? d : 0)) / p;
      l = (l * (p - 1) + (d < 0 ? -d : 0)) / p;
      out.push(l === 0 ? 100 : 100 - 100 / (1 + g / l));
    }
  }
  return out;
}

// MACD（EMA12/26·DEA=DIF 的 EMA9·OSC=DIF-DEA）
function macdSeries(bars: Bar[]): { dif: (number | null)[]; dea: (number | null)[]; osc: (number | null)[] } {
  const ema = (p: number) => {
    const k = 2 / (p + 1); const out: number[] = []; let e: number | null = null;
    for (const b of bars) { e = e == null ? b.c : b.c * k + e * (1 - k); out.push(e); }
    return out;
  };
  const e12 = ema(12), e26 = ema(26);
  const dif: (number | null)[] = [], dea: (number | null)[] = [], osc: (number | null)[] = [];
  let d9: number | null = null; const k9 = 2 / 10;
  for (let i = 0; i < bars.length; i++) {
    if (i < 26) { dif.push(null); dea.push(null); osc.push(null); continue; }
    const df = e12[i] - e26[i];
    d9 = d9 == null ? df : df * k9 + d9 * (1 - k9);
    dif.push(df); dea.push(d9); osc.push(df - d9);
  }
  return { dif, dea, osc };
}

// KD（9 日·⅔平滑——與站上 calculateKD 同口徑）
function kdSeries(bars: Bar[], p = 9): { K: (number | null)[]; D: (number | null)[] } {
  const K: (number | null)[] = [], D: (number | null)[] = [];
  let k = 50, d = 50;
  for (let i = 0; i < bars.length; i++) {
    if (i < p - 1) { K.push(null); D.push(null); continue; }
    let hi = -Infinity, lo = Infinity;
    for (let j = i - p + 1; j <= i; j++) { if (bars[j].h > hi) hi = bars[j].h; if (bars[j].l < lo) lo = bars[j].l; }
    const rsv = hi > lo ? (bars[i].c - lo) / (hi - lo) * 100 : 50;
    k = k * 2 / 3 + rsv / 3; d = d * 2 / 3 + k / 3;
    K.push(k); D.push(d);
  }
  return { K, D };
}

// 確定性判讀（規則計算·非AI）
function readIndex(bars: Bar[], name: string, iv: string): { headline: string; lines: string[]; ind: string[] } {
  const n = bars.length;
  if (n < 65) return { headline: '資料不足', lines: [], ind: [] };
  const c = bars[n - 1].c;
  const m5 = ma(bars, 5)[n - 1]!, m20 = ma(bars, 20)[n - 1]!, m60 = ma(bars, 60)[n - 1]!;
  const m60p = ma(bars, 60)[n - 6]!;
  const unit = iv === '1d' ? '日' : iv === '1wk' ? '週' : '月';
  const chg5 = (c - bars[n - 6].c) / bars[n - 6].c * 100;
  const chg20 = (c - bars[n - 21].c) / bars[n - 21].c * 100;
  const hi20 = Math.max(...bars.slice(-20).map(b => b.h)), lo20 = Math.min(...bars.slice(-20).map(b => b.l));
  const pos = hi20 > lo20 ? (c - lo20) / (hi20 - lo20) : 0.5;
  const bias20 = (c - m20) / m20 * 100;
  const amp = bars.slice(-20).reduce((s, b) => s + (b.h - b.l) / b.c, 0) / 20 * 100;
  const bull = c > m5 && m5 > m20 && m20 > m60, bear = c < m5 && m5 < m20 && m20 < m60;
  const trend60 = m60 > m60p ? '上揚' : m60 < m60p ? '下彎' : '走平';
  const headline = bull ? `多頭排列（價>MA5>MA20>MA60）· 季線${trend60}` : bear ? `空頭排列（價<MA5<MA20<MA60）· 季線${trend60}` : `均線糾結 · 季線${trend60}`;
  const lines = [
    `位階：收 ${fmtN(c)}，位於 20${unit}區間 ${fmtN(lo20)}~${fmtN(hi20)} 的 ${(pos * 100).toFixed(0)}% 高度${pos >= 0.85 ? '（貼近區間頂）' : pos <= 0.15 ? '（貼近區間底）' : ''}。`,
    `動能：近 5${unit} ${chg5 >= 0 ? '+' : ''}${chg5.toFixed(2)}%、近 20${unit} ${chg20 >= 0 ? '+' : ''}${chg20.toFixed(2)}%。`,
    `乖離：距 20${unit}均線 ${bias20 >= 0 ? '+' : ''}${bias20.toFixed(2)}%${Math.abs(bias20) >= 5 ? '——乖離偏大，追價/追空風險升高' : '，屬正常範圍'}。`,
    `波動：近 20${unit}平均振幅 ${amp.toFixed(2)}%/${unit}${amp >= 2.5 ? '（波動偏高，部位宜縮）' : ''}。`,
    `支撐/壓力參考：MA20 ${fmtN(m20)}、MA60 ${fmtN(m60)}；20${unit}高 ${fmtN(hi20)}、20${unit}低 ${fmtN(lo20)}。`,
  ];
  // 價量：Yahoo 當根量常延遲回補（今日收盤後仍可能為 0），
  // 回退到最後一根「有量」的 K 棒並標明是哪一根——寧可標日期，不要靜默不顯示。
  const vi = (() => { for (let i = n - 1; i >= n - 5 && i > 0; i--) if (bars[i].v > 0) return i; return -1; })();
  if (vi > 20) {
    const v1 = bars[vi].v;
    const av5 = bars.slice(vi - 5, vi).reduce((s, b) => s + b.v, 0) / 5;
    const av20 = bars.slice(vi - 20, vi).reduce((s, b) => s + b.v, 0) / 20;
    const vChg = (bars[vi].c - bars[vi - 1].c) / bars[vi - 1].c * 100;
    if (av5 > 0) {
      const vx = v1 / av5;
      const pv = vChg >= 0
        ? (vx >= 1.2 ? '量增價漲（多方有跟）' : vx <= 0.8 ? '量縮價漲（追價意願弱·漲勢待確認）' : '量平價漲')
        : (vx >= 1.2 ? '量增價跌（賣壓實在）' : vx <= 0.8 ? '量縮價跌（殺盤力道趨緩）' : '量平價跌');
      const stale = vi < n - 1 ? `（最新一${unit}量尚未回補，取 ${fmtD(bars[vi].t, iv)}）` : '';
      lines.push(`價量：${fmtV(v1)}＝5${unit}均量的 ${vx.toFixed(2)} 倍${av20 > 0 ? `（5${unit}均量/20${unit}均量 ${(av5 / av20).toFixed(2)}）` : ''}——${pv}${stale}。`);
    }
  }
  // 指標讀數（描述性·非訊號——見檔頭誠實界線）
  const r5 = rsiSeries(bars, 5), r10 = rsiSeries(bars, 10);
  const { dif, dea, osc } = macdSeries(bars);
  const { K, D } = kdSeries(bars);
  const ind: string[] = [];
  const R5 = r5[n - 1], R5p = r5[n - 2], R10 = r10[n - 1];
  if (R5 != null && R10 != null) {
    const st = R5 > 80 && R5p != null && R5p > 80 ? '（連2' + unit + '>80 高檔）'
      : R5 < 20 && R5p != null && R5p < 20 ? '（連2' + unit + '<20 低檔）' : '';
    ind.push(`RSI：RSI5 ${R5.toFixed(1)}、RSI10 ${R10.toFixed(1)}${st}。本站實測：指數層級超買≠將跌（動能延續居多），低檔連2${unit}僅在全市場恐慌時有反彈統計。`);
  }
  const DF = dif[n - 1], DE = dea[n - 1], OS = osc[n - 1], OSp = osc[n - 2];
  if (DF != null && DE != null && OS != null && OSp != null) {
    const cross = OSp <= 0 && OS > 0 ? '——DIF 上穿 DEA（黃金交叉）' : OSp >= 0 && OS < 0 ? '——DIF 下穿 DEA（死亡交叉）' : OS > 0 && OS > OSp ? '·紅柱放大' : OS > 0 ? '·紅柱收斂' : OS < OSp ? '·綠柱放大' : '·綠柱收斂';
    ind.push(`MACD：DIF ${DF.toFixed(0)}、DEA ${DE.toFixed(0)}、柱 ${OS >= 0 ? '+' : ''}${OS.toFixed(0)}${cross}。實測註記：交叉屬確認型（遲到），無預測增量，僅作趨勢描述。`);
  }
  const Kv = K[n - 1], Dv = D[n - 1], Kp = K[n - 2], Dp = D[n - 2];
  if (Kv != null && Dv != null && Kp != null && Dp != null) {
    const cross = Kp <= Dp && Kv > Dv ? '——K 上穿 D（金叉）' : Kp >= Dp && Kv < Dv ? '——K 下穿 D（死叉）' : '';
    const blunt = Kv > 80 ? '·高檔區' : Kv < 20 ? '·低檔區' : '';
    ind.push(`KD：K ${Kv.toFixed(1)}、D ${Dv.toFixed(1)}${blunt}${cross}。實測註記：KD 交叉/鈍化在本站個股回測無買賣增量（K>90 避開為個股層級結論），此處僅描述位置。`);
  }
  if (name === '加權指數' || name === '櫃買指數') lines.push('個股操作以大盤為背景風險：市場健康度 <40 時模型建議休兵（見市場總覽）。');
  return { headline, lines, ind };
}

// ── SVG 蠟燭圖＋均線＋VOL/RSI/MACD/KD 副圖 ──────────────────────
function CandleSvg({ bars, iv }: { bars: Bar[]; iv: string }) {
  const [tip, setTip] = useState<number | null>(null);
  const W = 860, H = 320, VH = 64, IH = 64, GAP = 18, PADL = 8, PADR = 64;
  const m5 = useMemo(() => ma(bars, 5), [bars]);
  const m20 = useMemo(() => ma(bars, 20), [bars]);
  const m60 = useMemo(() => ma(bars, 60), [bars]);
  const vma5 = useMemo(() => maOf(bars.map(b => b.v), 5), [bars]);
  const r5 = useMemo(() => rsiSeries(bars, 5), [bars]);
  const r10 = useMemo(() => rsiSeries(bars, 10), [bars]);
  const macd = useMemo(() => macdSeries(bars), [bars]);
  const kd = useMemo(() => kdSeries(bars), [bars]);
  if (bars.length < 2) return null;
  const hasVol = bars.some(b => b.v > 0);
  const lo = Math.min(...bars.map(b => b.l), ...[m20, m60].flatMap(m => m.filter((x): x is number => x != null)));
  const hi = Math.max(...bars.map(b => b.h), ...[m20, m60].flatMap(m => m.filter((x): x is number => x != null)));
  const vMax = Math.max(...bars.map(b => b.v), 1);
  const y = (p: number) => 8 + (H - 16) * (1 - (p - lo) / (hi - lo || 1));
  const bw = (W - PADL - PADR) / bars.length;
  const x = (i: number) => PADL + i * bw + bw / 2;
  const line = (m: (number | null)[], yFn: (v: number) => number) =>
    m.map((v, i) => v == null ? null : `${x(i).toFixed(1)},${yFn(v).toFixed(1)}`).filter(Boolean).join(' ');
  // 面板 Y 座標器
  const volY0 = H, rsiY0 = volY0 + (hasVol ? VH + GAP : 0), macdY0 = rsiY0 + IH + GAP, kdY0 = macdY0 + IH + GAP;
  const totalH = kdY0 + IH + 16;
  const pctY = (y0: number) => (v: number) => y0 + (IH - 4) * (1 - v / 100) + 2;
  const oscVals = macd.osc.filter((v): v is number => v != null);
  const difVals = [...macd.dif, ...macd.dea].filter((v): v is number => v != null);
  const mAbs = Math.max(...oscVals.map(Math.abs), ...difVals.map(Math.abs), 1e-9);
  const macdY = (v: number) => macdY0 + (IH - 4) * (1 - (v + mAbs) / (2 * mAbs)) + 2;
  const t = tip != null ? bars[tip] : null;
  const ti = tip ?? bars.length - 1;
  const paneLabel = (y0: number, txt: string) => (
    <text x={PADL} y={y0 + 11} fontSize="10" fontWeight={700} fill="var(--text-muted)">{txt}</text>
  );
  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-muted)', marginBottom: 2, flexWrap: 'wrap' }}>
        <span style={{ color: '#f6c945' }}>— MA5 {m5[bars.length - 1] != null ? fmtN(m5[bars.length - 1]!) : '—'}</span>
        <span style={{ color: '#3d8ef8' }}>— MA20 {m20[bars.length - 1] != null ? fmtN(m20[bars.length - 1]!) : '—'}</span>
        <span style={{ color: '#c084fc' }}>— MA60 {m60[bars.length - 1] != null ? fmtN(m60[bars.length - 1]!) : '—'}</span>
        {t && <span style={{ color: 'var(--text-secondary)' }}>{fmtD(t.t, iv)} 開{fmtN(t.o)} 高{fmtN(t.h)} 低{fmtN(t.l)} 收<b style={{ color: t.c >= t.o ? UP : DOWN }}>{fmtN(t.c)}</b>{hasVol ? ` 量${fmtV(t.v)}` : ''}</span>}
      </div>
      <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-muted)', marginBottom: 2, flexWrap: 'wrap', fontFamily: 'JetBrains Mono, monospace' }}>
        {r5[ti] != null && <span>RSI5 <b style={{ color: 'var(--text-secondary)' }}>{r5[ti]!.toFixed(1)}</b></span>}
        {r10[ti] != null && <span>RSI10 <b style={{ color: 'var(--text-secondary)' }}>{r10[ti]!.toFixed(1)}</b></span>}
        {kd.K[ti] != null && <span>K <b style={{ color: 'var(--text-secondary)' }}>{kd.K[ti]!.toFixed(1)}</b> D <b style={{ color: 'var(--text-secondary)' }}>{kd.D[ti]!.toFixed(1)}</b></span>}
        {macd.dif[ti] != null && <span>DIF <b style={{ color: 'var(--text-secondary)' }}>{macd.dif[ti]!.toFixed(1)}</b> 柱 <b style={{ color: (macd.osc[ti] ?? 0) >= 0 ? UP : DOWN }}>{(macd.osc[ti] ?? 0).toFixed(1)}</b></span>}
      </div>
      <svg viewBox={`0 0 ${W} ${totalH}`} style={{ width: '100%', height: 'auto', display: 'block' }}
        onMouseLeave={() => setTip(null)}
        onMouseMove={e => { const r = (e.target as SVGElement).closest('svg')!.getBoundingClientRect(); const i = Math.floor((e.clientX - r.left) / r.width * W / bw - PADL / bw); setTip(i >= 0 && i < bars.length ? i : null); }}>
        {/* 主圖：K棒＋均線 */}
        {[0.25, 0.5, 0.75].map(f => <line key={f} x1={PADL} x2={W - PADR} y1={8 + (H - 16) * f} y2={8 + (H - 16) * f} stroke="rgba(148,163,184,0.12)" />)}
        {[hi, lo + (hi - lo) / 2, lo].map((p, i) => <text key={i} x={W - PADR + 6} y={y(p) + 4} fontSize="11" fill="var(--text-muted)">{fmtN(p)}</text>)}
        {bars.map((b, i) => {
          const up = b.c >= b.o, col = up ? UP : DOWN;
          const bodyT = y(Math.max(b.o, b.c)), bodyB = y(Math.min(b.o, b.c));
          return (
            <g key={b.t}>
              <line x1={x(i)} x2={x(i)} y1={y(b.h)} y2={y(b.l)} stroke={col} strokeWidth={1} />
              <rect x={x(i) - Math.max(bw * 0.32, 0.8)} y={bodyT} width={Math.max(bw * 0.64, 1.6)} height={Math.max(bodyB - bodyT, 1)} fill={up ? col : 'var(--bg-primary, #0b1220)'} stroke={col} strokeWidth={1} />
            </g>
          );
        })}
        <polyline points={line(m5, y)} fill="none" stroke="#f6c945" strokeWidth={1.4} />
        <polyline points={line(m20, y)} fill="none" stroke="#3d8ef8" strokeWidth={1.4} />
        <polyline points={line(m60, y)} fill="none" stroke="#c084fc" strokeWidth={1.4} />
        {/* VOL 副圖＋5日均量線 */}
        {hasVol && <>
          {paneLabel(volY0, `VOL（— 5${iv === '1d' ? '日' : iv === '1wk' ? '週' : '月'}均量 ${vma5[bars.length - 1] != null ? fmtV(vma5[bars.length - 1]!) : '—'}）`)}
          {bars.map((b, i) => (
            <rect key={'v' + b.t} x={x(i) - Math.max(bw * 0.32, 0.8)} y={volY0 + 14 + (VH - 18) * (1 - b.v / vMax)} width={Math.max(bw * 0.64, 1.6)} height={(VH - 18) * (b.v / vMax)} fill={b.c >= b.o ? UP : DOWN} opacity={0.45} />
          ))}
          <polyline points={line(vma5, v => volY0 + 14 + (VH - 18) * (1 - v / vMax))} fill="none" stroke="#f6c945" strokeWidth={1.2} opacity={0.9} />
        </>}
        {/* RSI 副圖（Wilder 5/10·全站同口徑） */}
        {paneLabel(rsiY0, 'RSI（— 5 — 10·Wilder）')}
        {[20, 50, 80].map(v => <g key={'rg' + v}>
          <line x1={PADL} x2={W - PADR} y1={pctY(rsiY0)(v)} y2={pctY(rsiY0)(v)} stroke="rgba(148,163,184,0.14)" strokeDasharray={v === 50 ? '2 3' : undefined} />
          <text x={W - PADR + 6} y={pctY(rsiY0)(v) + 3.5} fontSize="10" fill="var(--text-muted)">{v}</text>
        </g>)}
        <polyline points={line(r5, pctY(rsiY0))} fill="none" stroke="#f6c945" strokeWidth={1.3} />
        <polyline points={line(r10, pctY(rsiY0))} fill="none" stroke="#7dd3fc" strokeWidth={1.3} />
        {/* MACD 副圖 */}
        {paneLabel(macdY0, 'MACD（12·26·9）柱=DIF-DEA')}
        <line x1={PADL} x2={W - PADR} y1={macdY(0)} y2={macdY(0)} stroke="rgba(148,163,184,0.2)" />
        {bars.map((b, i) => {
          const v = macd.osc[i]; if (v == null) return null;
          const y0 = macdY(0), y1 = macdY(v);
          return <rect key={'o' + b.t} x={x(i) - Math.max(bw * 0.28, 0.7)} y={Math.min(y0, y1)} width={Math.max(bw * 0.56, 1.4)} height={Math.max(Math.abs(y1 - y0), 0.5)} fill={v >= 0 ? UP : DOWN} opacity={0.55} />;
        })}
        <polyline points={line(macd.dif, macdY)} fill="none" stroke="#f6c945" strokeWidth={1.3} />
        <polyline points={line(macd.dea, macdY)} fill="none" stroke="#7dd3fc" strokeWidth={1.3} />
        {/* KD 副圖（9·⅔平滑） */}
        {paneLabel(kdY0, 'KD（9·⅔平滑）— K — D')}
        {[20, 80].map(v => <g key={'kg' + v}>
          <line x1={PADL} x2={W - PADR} y1={pctY(kdY0)(v)} y2={pctY(kdY0)(v)} stroke="rgba(148,163,184,0.14)" />
          <text x={W - PADR + 6} y={pctY(kdY0)(v) + 3.5} fontSize="10" fill="var(--text-muted)">{v}</text>
        </g>)}
        <polyline points={line(kd.K, pctY(kdY0))} fill="none" stroke="#f6c945" strokeWidth={1.3} />
        <polyline points={line(kd.D, pctY(kdY0))} fill="none" stroke="#7dd3fc" strokeWidth={1.3} />
        {/* 十字線與日期軸 */}
        {tip != null && <line x1={x(tip)} x2={x(tip)} y1={0} y2={totalH - 14} stroke="rgba(148,163,184,0.4)" strokeDasharray="3 3" />}
        {bars.map((b, i) => (i % Math.ceil(bars.length / 8) === 0) && <text key={'d' + b.t} x={x(i)} y={totalH - 2} fontSize="10" fill="var(--text-muted)" textAnchor="middle">{fmtD(b.t, iv)}</text>)}
      </svg>
    </div>
  );
}

// ── 指數分頁 ─────────────────────────────────────────────────────
export default function IndexAnalysis() {
  const [sym, setSym] = useState('twii');
  const [iv, setIv] = useState<'1d' | '1wk' | '1mo'>('1d');
  const [win, setWin] = useState(120);
  const [all, setAll] = useState<Bar[]>([]);
  const [name, setName] = useState('加權指數');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const j = await fetch(`/api/index/candles?sym=${sym}&interval=${iv}`).then(r => (r.ok ? r.json() : null));
      setAll(j?.candles || []); setName(j?.name || sym); setNote(j?.note || '');
    } catch { setAll([]); } finally { setLoading(false); }
  }, [sym, iv]);
  useEffect(() => { load(); }, [load]);

  const bars = useMemo(() => all.slice(-win), [all, win]);
  const read = useMemo(() => readIndex(all, name, iv), [all, name, iv]);
  const last = all[all.length - 1], prev = all[all.length - 2];
  const chg = last && prev ? (last.c - prev.c) / prev.c * 100 : 0;
  const hist = useMemo(() => [...all.slice(-20)].reverse(), [all]);

  const chip = (on: boolean) => ({ padding: '5px 12px', borderRadius: 14, fontSize: 12.5, fontWeight: 800 as const, cursor: 'pointer', border: `1px solid ${on ? 'rgba(125,211,252,0.6)' : 'var(--border-primary)'}`, background: on ? 'rgba(125,211,252,0.14)' : 'transparent', color: on ? 'var(--text-primary)' : 'var(--text-muted)' });

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {SYMS.map(s => <button key={s.id} onClick={() => setSym(s.id)} style={chip(sym === s.id)}>{s.label}</button>)}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {INTERVALS.map(i => <button key={i.id} onClick={() => setIv(i.id)} style={chip(iv === i.id)}>{i.label}</button>)}
        <span style={{ width: 8 }} />
        {WINDOWS.map(w => <button key={w} onClick={() => setWin(w)} style={chip(win === w)}>近{w}根</button>)}
        {last && (
          <span style={{ marginLeft: 'auto', fontSize: 14, fontWeight: 900 }}>
            {name} <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>{fmtN(last.c)}</span>{' '}
            <span style={{ color: chg >= 0 ? UP : DOWN }}>{chg >= 0 ? '+' : ''}{chg.toFixed(2)}%</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>{fmtD(last.t, iv)}</span>
          </span>
        )}
      </div>

      <div style={{ padding: '12px 14px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
        {loading ? <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: 24 }}>載入 {name} K 線…</div>
          : bars.length ? <CandleSvg bars={bars} iv={iv} /> : <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: 24 }}>無資料</div>}
        {note && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>ℹ {note}</div>}
      </div>

      {read.lines.length > 0 && (
        <div style={{ padding: '12px 14px', borderRadius: 12, background: 'rgba(125,211,252,0.06)', border: '1px solid rgba(125,211,252,0.3)', fontSize: 12.5, lineHeight: 1.9 }}>
          <div style={{ fontWeight: 900, marginBottom: 4 }}>🧭 自動判讀（規則計算·非 AI 生成）：{read.headline}</div>
          {read.lines.map((l, i) => <div key={i} style={{ color: 'var(--text-secondary)' }}>· {l}</div>)}
          {read.ind.length > 0 && <>
            <div style={{ fontWeight: 900, margin: '8px 0 2px' }}>📐 指標讀數（描述性·非買賣訊號）</div>
            {read.ind.map((l, i) => <div key={'i' + i} style={{ color: 'var(--text-secondary)' }}>· {l}</div>)}
          </>}
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>判讀為技術面描述，非預測、非投資建議。MACD/KD 交叉類為確認型指標，本站回測無預測增量。</div>
        </div>
      )}

      <div style={{ padding: '12px 14px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
        <div style={{ fontWeight: 900, fontSize: 13, marginBottom: 6 }}>📋 歷史資料（近 20 根{INTERVALS.find(i => i.id === iv)?.label}）</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'JetBrains Mono, monospace' }}>
            <thead><tr style={{ color: 'var(--text-muted)', textAlign: 'right' }}>
              <th style={{ textAlign: 'left', padding: '4px 6px' }}>日期</th><th>開盤</th><th>最高</th><th>最低</th><th>收盤</th><th>漲跌%</th><th>成交量</th><th>RSI5</th><th>K</th>
            </tr></thead>
            <tbody>
              {hist.map((b, i) => {
                const p = hist[i + 1]; const ch = p ? (b.c - p.c) / p.c * 100 : null;
                const gi = all.length - 1 - i;   // hist 是反轉切片 → 對回全序列索引
                const r5all = readCache(all, gi);
                return (
                  <tr key={b.t} style={{ textAlign: 'right', borderTop: '1px solid rgba(148,163,184,0.08)' }}>
                    <td style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--text-secondary)' }}>{fmtD(b.t, iv)}</td>
                    <td>{fmtN(b.o)}</td><td>{fmtN(b.h)}</td><td>{fmtN(b.l)}</td>
                    <td style={{ fontWeight: 700, color: b.c >= b.o ? UP : DOWN }}>{fmtN(b.c)}</td>
                    <td style={{ color: ch == null ? 'var(--text-muted)' : ch >= 0 ? UP : DOWN }}>{ch == null ? '—' : `${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%`}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{b.v > 0 ? fmtV(b.v) : '—'}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{r5all.r5 ?? '—'}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{r5all.k ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// 歷史表的 RSI/K 讀數：全序列算一次、模組級快取（避免每列重算 O(n²)）
let _rcKey: Bar[] | null = null;
let _rcVal: { r5: (number | null)[]; k: (number | null)[] } | null = null;
function readCache(all: Bar[], i: number): { r5: string | null; k: string | null } {
  if (_rcKey !== all) { _rcKey = all; _rcVal = { r5: rsiSeries(all, 5), k: kdSeries(all).K }; }
  const r = _rcVal!.r5[i], k = _rcVal!.k[i];
  return { r5: r == null ? null : r.toFixed(1), k: k == null ? null : k.toFixed(1) };
}
