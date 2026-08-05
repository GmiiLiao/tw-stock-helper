'use client';

// ── 📈 指數分析（2026-08-05 由「指數·新聞」獨立頁改為「市場總覽」分頁）──
// 加權/櫃買/費半/那指/S&P/道瓊/日經 日週月K＋MA5/20/60＋確定性自動判讀
// （趨勢/乖離/位階/波動——規則計算、非 AI 生成）＋近 20 根歷史表。
//
// 為什麼併回市場總覽：指數就是「大盤背景」，而使用者看大盤時本來就在市場總覽。
// 讓它獨立一頁等於要人記住「看指數要換頁」——那正是使用習慣固定不下來的原因。

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

// 均線（尾端對齊）
function ma(bars: Bar[], p: number): (number | null)[] {
  const out: (number | null)[] = []; let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].c; if (i >= p) sum -= bars[i - p].c;
    out.push(i >= p - 1 ? sum / p : null);
  }
  return out;
}

// 確定性判讀（規則計算·非AI）
function readIndex(bars: Bar[], name: string, iv: string): { headline: string; lines: string[] } {
  const n = bars.length;
  if (n < 65) return { headline: '資料不足', lines: [] };
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
  if (name === '加權指數' || name === '櫃買指數') lines.push('個股操作以大盤為背景風險：市場健康度 <40 時模型建議休兵（見市場總覽）。');
  return { headline, lines };
}

// ── SVG 蠟燭圖＋均線 ─────────────────────────────────────────────
function CandleSvg({ bars, iv }: { bars: Bar[]; iv: string }) {
  const [tip, setTip] = useState<number | null>(null);
  const W = 860, H = 320, VH = 54, PADL = 8, PADR = 64;
  const m5 = useMemo(() => ma(bars, 5), [bars]);
  const m20 = useMemo(() => ma(bars, 20), [bars]);
  const m60 = useMemo(() => ma(bars, 60), [bars]);
  if (bars.length < 2) return null;
  const lo = Math.min(...bars.map(b => b.l), ...[m20, m60].flatMap(m => m.filter((x): x is number => x != null)));
  const hi = Math.max(...bars.map(b => b.h), ...[m20, m60].flatMap(m => m.filter((x): x is number => x != null)));
  const vMax = Math.max(...bars.map(b => b.v), 1);
  const y = (p: number) => 8 + (H - 16) * (1 - (p - lo) / (hi - lo || 1));
  const bw = (W - PADL - PADR) / bars.length;
  const x = (i: number) => PADL + i * bw + bw / 2;
  const line = (m: (number | null)[]) => m.map((v, i) => v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`).filter(Boolean).join(' ');
  const t = tip != null ? bars[tip] : null;
  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-muted)', marginBottom: 2, flexWrap: 'wrap' }}>
        <span style={{ color: '#f6c945' }}>— MA5 {m5[bars.length - 1] != null ? fmtN(m5[bars.length - 1]!) : '—'}</span>
        <span style={{ color: '#3d8ef8' }}>— MA20 {m20[bars.length - 1] != null ? fmtN(m20[bars.length - 1]!) : '—'}</span>
        <span style={{ color: '#c084fc' }}>— MA60 {m60[bars.length - 1] != null ? fmtN(m60[bars.length - 1]!) : '—'}</span>
        {t && <span style={{ color: 'var(--text-secondary)' }}>{fmtD(t.t, iv)} 開{fmtN(t.o)} 高{fmtN(t.h)} 低{fmtN(t.l)} 收<b style={{ color: t.c >= t.o ? UP : DOWN }}>{fmtN(t.c)}</b></span>}
      </div>
      <svg viewBox={`0 0 ${W} ${H + VH}`} style={{ width: '100%', height: 'auto', display: 'block' }}
        onMouseLeave={() => setTip(null)}
        onMouseMove={e => { const r = (e.target as SVGElement).closest('svg')!.getBoundingClientRect(); const i = Math.floor((e.clientX - r.left) / r.width * W / bw - PADL / bw); setTip(i >= 0 && i < bars.length ? i : null); }}>
        {[0.25, 0.5, 0.75].map(f => <line key={f} x1={PADL} x2={W - PADR} y1={8 + (H - 16) * f} y2={8 + (H - 16) * f} stroke="rgba(148,163,184,0.12)" />)}
        {[hi, lo + (hi - lo) / 2, lo].map((p, i) => <text key={i} x={W - PADR + 6} y={y(p) + 4} fontSize="11" fill="var(--text-muted)">{fmtN(p)}</text>)}
        {bars.map((b, i) => {
          const up = b.c >= b.o, col = up ? UP : DOWN;
          const bodyT = y(Math.max(b.o, b.c)), bodyB = y(Math.min(b.o, b.c));
          return (
            <g key={b.t}>
              <line x1={x(i)} x2={x(i)} y1={y(b.h)} y2={y(b.l)} stroke={col} strokeWidth={1} />
              <rect x={x(i) - Math.max(bw * 0.32, 0.8)} y={bodyT} width={Math.max(bw * 0.64, 1.6)} height={Math.max(bodyB - bodyT, 1)} fill={up ? col : 'var(--bg-primary, #0b1220)'} stroke={col} strokeWidth={1} />
              <rect x={x(i) - Math.max(bw * 0.32, 0.8)} y={H + 4 + (VH - 8) * (1 - b.v / vMax)} width={Math.max(bw * 0.64, 1.6)} height={(VH - 8) * (b.v / vMax)} fill={col} opacity={0.45} />
            </g>
          );
        })}
        <polyline points={line(m5)} fill="none" stroke="#f6c945" strokeWidth={1.4} />
        <polyline points={line(m20)} fill="none" stroke="#3d8ef8" strokeWidth={1.4} />
        <polyline points={line(m60)} fill="none" stroke="#c084fc" strokeWidth={1.4} />
        {tip != null && <line x1={x(tip)} x2={x(tip)} y1={0} y2={H + VH} stroke="rgba(148,163,184,0.4)" strokeDasharray="3 3" />}
        {bars.map((b, i) => (i % Math.ceil(bars.length / 8) === 0) && <text key={'d' + b.t} x={x(i)} y={H + VH - 2} fontSize="10" fill="var(--text-muted)" textAnchor="middle">{fmtD(b.t, iv)}</text>)}
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
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>判讀為技術面描述，非預測、非投資建議。</div>
        </div>
      )}

      <div style={{ padding: '12px 14px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
        <div style={{ fontWeight: 900, fontSize: 13, marginBottom: 6 }}>📋 歷史資料（近 20 根{INTERVALS.find(i => i.id === iv)?.label}）</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'JetBrains Mono, monospace' }}>
            <thead><tr style={{ color: 'var(--text-muted)', textAlign: 'right' }}>
              <th style={{ textAlign: 'left', padding: '4px 6px' }}>日期</th><th>開盤</th><th>最高</th><th>最低</th><th>收盤</th><th>漲跌%</th>
            </tr></thead>
            <tbody>
              {hist.map((b, i) => {
                const p = hist[i + 1]; const ch = p ? (b.c - p.c) / p.c * 100 : null;
                return (
                  <tr key={b.t} style={{ textAlign: 'right', borderTop: '1px solid rgba(148,163,184,0.08)' }}>
                    <td style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--text-secondary)' }}>{fmtD(b.t, iv)}</td>
                    <td>{fmtN(b.o)}</td><td>{fmtN(b.h)}</td><td>{fmtN(b.l)}</td>
                    <td style={{ fontWeight: 700, color: b.c >= b.o ? UP : DOWN }}>{fmtN(b.c)}</td>
                    <td style={{ color: ch == null ? 'var(--text-muted)' : ch >= 0 ? UP : DOWN }}>{ch == null ? '—' : `${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%`}</td>
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
