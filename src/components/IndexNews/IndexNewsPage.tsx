'use client';

// ── 📰 指數·新聞頁（2026-07-23 使用者指定）────────────────────────
// ① 指數分析：加權/櫃買/費半/那指/S&P/道瓊/日經 日週月K＋MA5/20/60＋
//    確定性自動判讀（趨勢/乖離/位階/波動——規則計算、非 AI 生成）＋近20日歷史表。
// ② 每日新聞：daemon 每日 07:00 聚合（全球AI產業/全球局勢/美國建廠·NVIDIA
//    供應鏈/台灣產業），標題連結導回原媒體，AI 導讀僅歸納標題。非投資建議。

import { useCallback, useEffect, useMemo, useState } from 'react';
import PageHelp from '@/components/Help/PageHelp';
import { useAppStore } from '@/lib/store';

interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }
interface NewsItem { title: string; link: string; src: string; at: number }
interface NewsCat { key: string; label: string; brief: string; items: NewsItem[] }
interface Digest { found: boolean; date?: string; updatedAt?: number; newestAt?: number | null; cats?: NewsCat[]; note?: string }

// 相對時間（讓新鮮度看得見；使用者定案：每日新聞必須是當日最新）
const ago = (ms?: number) => {
  if (!ms) return '';
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return '剛剛';
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小時前`;
  return `${Math.floor(h / 24)} 天前`;
};

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
function IndexTab() {
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

// ── 新聞分頁 ─────────────────────────────────────────────────────
function NewsTab() {
  const [digest, setDigest] = useState<Digest | null>(null);
  const [dates, setDates] = useState<string[]>([]);
  const [sel, setSel] = useState<string>('');

  useEffect(() => {
    fetch('/api/ai/news-digest?list=1').then(r => (r.ok ? r.json() : null)).then(j => setDates(j?.dates || [])).catch(() => {});
  }, []);
  useEffect(() => {
    const q = sel ? `?date=${sel}` : '';
    setDigest(null);
    fetch(`/api/ai/news-digest${q}`).then(r => (r.ok ? r.json() : null)).then(j => setDigest(j)).catch(() => setDigest({ found: false }));
  }, [sel]);

  const chip = (on: boolean) => ({ padding: '4px 10px', borderRadius: 12, fontSize: 11.5, fontWeight: 800 as const, cursor: 'pointer', border: `1px solid ${on ? 'rgba(125,211,252,0.6)' : 'var(--border-primary)'}`, background: on ? 'rgba(125,211,252,0.14)' : 'transparent', color: on ? 'var(--text-primary)' : 'var(--text-muted)' });

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>日期：</span>
        <button onClick={() => setSel('')} style={chip(!sel)}>最新</button>
        {dates.slice(0, 10).map(d => <button key={d} onClick={() => setSel(d)} style={chip(sel === d)}>{d.slice(5)}</button>)}
      </div>
      {!digest && <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: 16 }}>載入新聞…</div>}
      {digest && !digest.found && <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: 16 }}>尚無新聞資料（每日上午 7:00 自動發布）。</div>}
      {digest?.found && (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.8 }}>
            📅 {digest.date} · 最後更新 <b style={{ color: (Date.now() - (digest.updatedAt || 0)) > 6 * 3600000 ? '#ff8787' : 'var(--text-secondary)' }}>{ago(digest.updatedAt)}</b>
            {' '}· 每日 07:00 首發、日間每 3 小時自動刷新<br />{digest.note}
          </div>
          {(digest.cats || []).map(cat => (
            <div key={cat.key} style={{ padding: '12px 14px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
              <div style={{ fontWeight: 900, fontSize: 13.5, marginBottom: 6 }}>{cat.label}</div>
              {cat.brief && (
                <div style={{ fontSize: 12.5, lineHeight: 1.8, color: 'var(--text-secondary)', padding: '8px 10px', borderRadius: 8, background: 'rgba(125,211,252,0.06)', border: '1px solid rgba(125,211,252,0.2)', marginBottom: 8 }}>
                  🧠 {cat.brief}
                </div>
              )}
              <div style={{ display: 'grid', gap: 4 }}>
                {cat.items.map((it, i) => (
                  <a key={i} href={it.link} target="_blank" rel="noopener noreferrer"
                    style={{ fontSize: 12.5, lineHeight: 1.7, color: 'var(--text-primary)', textDecoration: 'none', display: 'flex', gap: 6, alignItems: 'baseline' }}>
                    <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>·</span>
                    <span style={{ flex: 1 }}>{it.title} <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{it.src}{it.at ? ` · ${ago(it.at)}` : ''}</span></span>
                  </a>
                ))}
                {cat.items.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>本日此類無新聞。</div>}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ── 話題選股分頁（犀利媽5日線法 bt-core 定版 × 新聞話題層）─────────
interface TopicItem { code: string; name: string; price: number; chg: number | null; bias5: number; rsi5?: number; rsi10?: number; dualRsi?: boolean; deathX?: boolean; rsiHot?: boolean; triple?: boolean; volX?: number | null; instT1?: number | null; ind: string | null; newsN: number; hot: boolean; aboveM20: boolean }
interface TopicData { found: boolean; date?: string; mode?: string; updatedAt?: number; instDate?: string | null; instSameDay?: boolean; hotSectors?: { ind: string; n: number }[]; oversold?: TopicItem[]; overheat?: TopicItem[]; breakdown?: TopicItem[]; evidence?: Record<string, string> }

function TopicRow({ it }: { it: TopicItem }) {
  const navigateTo = useAppStore(s => s.navigateTo);
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12.5, padding: '4px 0', borderTop: '1px solid rgba(148,163,184,0.08)', flexWrap: 'wrap' }}>
      <button onClick={() => navigateTo('stock', it.code)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-primary)', fontWeight: 800, fontSize: 12.5, padding: 0 }}>
        {it.code} {it.name}
      </button>
      {it.triple && <span style={{ fontSize: 10.5, padding: '1px 6px', borderRadius: 8, background: 'rgba(240,62,62,0.18)', color: '#ff8787', fontWeight: 800 }} title="三重確認：RSI5<20 × 法人t-1買超 × 量比>1.5（網格唯一最強組合·5日淨均+1.11%·淨勝55%·兩窗同向）">⭐三重確認</span>}
      {it.dualRsi && <span style={{ fontSize: 10.5, padding: '1px 6px', borderRadius: 8, background: 'rgba(251,191,36,0.15)', color: '#fbbf24', fontWeight: 800 }} title="RSI5與RSI10同時<10（影片定義的稀有極端超跌·樣本小存證觀察）">⚡雙RSI&lt;10</span>}
      {it.deathX && <span style={{ fontSize: 10.5, padding: '1px 6px', borderRadius: 8, background: 'rgba(47,158,68,0.15)', color: '#69db7c', fontWeight: 800 }} title="RSI5於70以上下穿RSI10（高檔死亡交叉·RSI八命題唯一過關·隔日Δ-0.11/-0.18兩窗穩）">💀高檔死叉</span>}
      {it.hot && <span style={{ fontSize: 10.5, padding: '1px 6px', borderRadius: 8, background: 'rgba(240,62,62,0.12)', color: '#fda4af', fontWeight: 800 }}>🔥話題</span>}
      {it.ind && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{it.ind}</span>}
      {it.newsN >= 2 && <span style={{ fontSize: 10.5, color: '#7dd3fc' }}>📰新聞{it.newsN}則</span>}
      <span style={{ marginLeft: 'auto', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-secondary)' }}>{it.price}</span>
      {it.chg != null && <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: it.chg >= 0 ? UP : DOWN, minWidth: 56, textAlign: 'right' }}>{it.chg >= 0 ? '+' : ''}{it.chg}%</span>}
      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5, color: 'var(--text-muted)', minWidth: 78, textAlign: 'right' }}>乖離{it.bias5 >= 0 ? '+' : ''}{it.bias5}%</span>
      {it.rsi5 != null && <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: (it.rsi5 < 10 || it.rsi5 >= 90) ? '#fbbf24' : 'var(--text-muted)', minWidth: 96, textAlign: 'right' }}>RSI5/10：{it.rsi5}/{it.rsi10}</span>}
    </div>
  );
}

function TopicTab() {
  const [d, setD] = useState<TopicData | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => fetch('/api/ai/topic-picks').then(r => (r.ok ? r.json() : null)).then(j => { if (live && j) setD(j); }).catch(() => {});
    load();
    const t = setInterval(load, 180000);
    return () => { live = false; clearInterval(t); };
  }, []);
  if (!d) return <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: 16 }}>載入話題選股…</div>;
  if (!d.found) return <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: 16 }}>尚無資料（常駐服務數分鐘內產生）。</div>;
  const sect = (title: string, items: TopicItem[] | undefined, evidence: string | undefined, tone: string) => (
    <div style={{ padding: '12px 14px', borderRadius: 12, background: 'var(--bg-elevated)', border: `1px solid ${tone}` }}>
      <div style={{ fontWeight: 900, fontSize: 13.5, marginBottom: 2 }}>{title} <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>{items?.length ?? 0} 檔</span></div>
      {evidence && <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 6 }}>📐 實證：{evidence}</div>}
      {(items || []).map(it => <TopicRow key={it.code} it={it} />)}
      {(!items || items.length === 0) && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>目前無符合。</div>}
    </div>
  );
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <span>📅 {d.date} · {d.mode === 'live' ? '盤中即時' : '收盤定版'}</span>
        {d.instDate && (
          <span title="法人資料日決定「可執行版本」：含今日T86＝依此決策要明日才能買；前一交易日＝今日收盤可買">
            🏦 法人資料 {d.instDate}{d.instSameDay ? '（含今日T86 → 可執行版本＝明日買進）' : '（前一交易日 → 今日收盤可買）'}
          </span>
        )}
        <span>🔥 熱門族群：{(d.hotSectors || []).map(h => `${h.ind}(${h.n}板)`).join('、') || '—'}</span>
      </div>
      <div style={{ padding: '10px 14px', borderRadius: 12, background: 'rgba(125,211,252,0.06)', border: '1px solid rgba(125,211,252,0.3)', fontSize: 12, lineHeight: 1.8, color: 'var(--text-secondary)' }}>
        方法來源：犀利媽「短線只設5日線·RSI只看最高跟最低」——本站 720 日回測拆解：<b style={{ color: 'var(--text-primary)' }}>超跌反彈✅（乖離&lt;-5%最穩·⚡雙RSI&lt;10為稀有極端加強版）、跌破出場✅、過熱勿追✅（乖離&gt;+8%較RSI≥95穩）、拉回5日線接❌（不成立、不提供）</b>。話題層（熱門族群/新聞熱度）讓超跌反彈在多空市況皆為淨正。出場鐵律照舊：破前低停損、單筆風險≤1%。
      </div>
      {sect('🟥 話題×超跌反彈候選（乖離5日線 < -5%）', d.oversold, d.evidence?.oversold, 'rgba(240,62,62,0.3)')}
      {sect('🚪 出場參考（跌破5日線／💀高檔死亡交叉）', d.breakdown, d.evidence?.breakdown, 'rgba(148,163,184,0.25)')}
      {sect('⚠️ 過熱勿追（乖離 > +8% 或雙RSI≥90）', d.overheat, d.evidence?.overheat, 'rgba(47,158,68,0.3)')}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.8 }}>
        反彈策略左尾重（接刀型）：分批、小部位、破前低無條件停損。<br />
        ⚠ 雙RSI≥90 的正確讀法（720日實證）：<b>不是頂點</b>——今日即未來10日最高點的機率僅 22.6%（基準 21.1%）；但5日內≥5%回檔機率 50%（基準 27%）＝<b>波動放大</b>。持有者出場實測：隔日就賣 −0.53%（最差）、抱5日 +0.44%、抱10日 +1.18%（最佳）→ 移動停利勿隔日全出。非投資建議。
      </div>
    </div>
  );
}

// ── 🌊 波段起漲分頁（5日持有語意·與隔日沖口徑分離）────────────────
interface SwingItem { code: string; name: string; price: number; chg: number | null; rsi5: number; rsi10: number; volX: number | null; instT1: number; vol: number; posture60: number | null; deepPull: boolean; bigVol: boolean; vol20: number | null; kdState: 'gold' | 'dead' | 'above' | 'below' | null; breakRisk: 'low' | 'mid' | 'high' | null; tier: number }
interface SwingData { found: boolean; date?: string; mode?: string; breadth?: number | null; bearDay?: boolean | null; instDate?: string | null; instSameDay?: boolean; total?: number; crowded?: boolean; caveats?: string[]; horizon?: string; gate?: string; counts?: { t1: number; t2: number; t3: number }; items?: SwingItem[]; evidence?: Record<string, string> }

const TIER = [
  { n: 3, label: '⭐⭐⭐ 最嚴', color: '#f03e3e', key: 't3' },
  { n: 2, label: '⭐⭐ 強化', color: '#fbbf24', key: 't2' },
  { n: 1, label: '⭐ 三重確認', color: '#7dd3fc', key: 't1' },
];

interface StrengthItem { code: string; name: string; price: number; chg: number; rsi5: number; rsi10: number; spread: number; inst5: number; inst5Ratio: number; vol: number; vol20: number | null; lowVol: boolean }
interface StrengthData { found?: boolean; date?: string; total?: number; crowded?: boolean; horizon?: string; caveats?: string[]; instWindow?: string[]; items?: StrengthItem[]; evidence?: Record<string, string> }

// 波段追強（強勢整理）——2026-08-01 上榜。規則與所有數字見 evidence（verify-strength-oot 實測）。
function StrengthTab() {
  const navigateTo = useAppStore(s => s.navigateTo);
  const [d, setD] = useState<StrengthData | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => fetch('/api/ai/strength-picks').then(r => (r.ok ? r.json() : null)).then(j => { if (live && j) setD(j); }).catch(() => {});
    load();
    const t = setInterval(load, 180000);
    return () => { live = false; clearInterval(t); };
  }, []);
  if (!d) return <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: 16 }}>載入波段追強…</div>;
  const items = d.items || [];
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ padding: '10px 14px', borderRadius: 12, background: 'rgba(192,132,252,0.07)', border: '1px solid rgba(192,132,252,0.35)', fontSize: 12, lineHeight: 1.85, color: 'var(--text-secondary)' }}>
        <div style={{ fontWeight: 900, color: 'var(--text-primary)', fontSize: 13 }}>🚀 波段追強（強勢整理）· <span style={{ color: '#fbbf24' }}>持有 5 個交易日</span></div>
        <div>挑「10 日趨勢強、5 日剛回冷、法人連 5 日買」的強勢整理股——<b style={{ color: 'var(--text-primary)' }}>不是追過熱</b>（RSI10 必須高於 RSI5）。與 🌊起漲榜互補：起漲抄跌深、追強買強勢回檔，兩者皆 5 日語意。</div>
        <div>⚠ <b style={{ color: 'var(--text-primary)' }}>絕不可隔日沖</b>：隔日開賣 −0.07%——edge 全在第 5 日。</div>
      </div>
      {(d.caveats ?? []).map((c, i) => (
        <div key={i} style={{ padding: '9px 14px', borderRadius: 12, fontSize: 12, lineHeight: 1.75, fontWeight: 600,
          background: 'rgba(250,176,5,0.09)', border: '1px solid rgba(250,176,5,0.35)', color: 'var(--text-primary)' }}>{c}</div>
      ))}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-muted)' }}>
        <span>📅 {d.date} · 收盤定版</span>
        {d.instWindow && <span>🏦 法人視窗 {d.instWindow[d.instWindow.length - 1]}~{d.instWindow[0]}（t-1~t-5·與回測同口徑）</span>}
        <span>共 {d.total ?? 0} 檔</span>
      </div>
      <div style={{ padding: '12px 14px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid rgba(192,132,252,0.4)' }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 6 }}>📐 {d.evidence?.rule}</div>
        {items.map(it => (
          <div key={it.code} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12.5, padding: '4px 0', borderTop: '1px solid rgba(148,163,184,0.08)', flexWrap: 'wrap' }}>
            <button onClick={() => navigateTo('stock', it.code)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-primary)', fontWeight: 800, fontSize: 12.5, padding: 0 }}>{it.code} {it.name}</button>
            <span style={{ fontSize: 10.5, color: '#c084fc' }}>法人5日/均量 {(it.inst5Ratio * 100).toFixed(1)}%</span>
            {it.lowVol && <span title="20日波動<1.5%。實測此子集兩窗都較差（主窗 5日均-1.649%·中位-1.172%·淨勝37.8%；OOT 中位-0.735%·淨勝43.3%）。未設為 gate 是因為排除後對剩餘部位改善僅+0.31/+0.14pp 且 OOT 前半≈0，未達本站門檻——故只標記，請自行下修勝率。" style={{ fontSize: 10.5, color: '#2f9e44' }}>😴低波動{it.vol20}%</span>}
            <span style={{ marginLeft: 'auto', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-secondary)' }}>{it.price}</span>
            {it.chg != null && <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: it.chg >= 0 ? UP : DOWN, minWidth: 56, textAlign: 'right' }}>{it.chg >= 0 ? '+' : ''}{it.chg}%</span>}
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#fbbf24', minWidth: 92, textAlign: 'right' }}>RSI {it.rsi5}/{it.rsi10}</span>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: UP, minWidth: 82, textAlign: 'right' }}>法人+{it.inst5.toLocaleString()}</span>
          </div>
        ))}
        {items.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>今日無符合——本榜日均僅 1.6 檔，空榜是常態。</div>}
      </div>
      <div style={{ padding: '10px 14px', borderRadius: 12, background: 'rgba(240,62,62,0.06)', border: '1px solid rgba(240,62,62,0.25)', fontSize: 11.5, lineHeight: 1.85, color: 'var(--text-secondary)' }}>
        <div><b style={{ color: 'var(--text-primary)' }}>🔬 主窗</b>：{d.evidence?.main}</div>
        <div style={{ marginTop: 4 }}><b style={{ color: 'var(--text-primary)' }}>🔬 OOT</b>：{d.evidence?.oot}</div>
        <div style={{ marginTop: 4 }}><b style={{ color: 'var(--text-primary)' }}>🌐 Regime</b>：{d.evidence?.regime}</div>
        <div style={{ marginTop: 4 }}><b style={{ color: '#ff8787' }}>⚠ 風險</b>：{d.evidence?.risk}</div>
        <div style={{ marginTop: 4 }}><b style={{ color: '#ff8787' }}>🛡 否證記錄</b>：{d.evidence?.refuted}</div>
      </div>
    </div>
  );
}

function SwingTab() {
  const navigateTo = useAppStore(s => s.navigateTo);
  const [d, setD] = useState<SwingData | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => fetch('/api/ai/swing-picks').then(r => (r.ok ? r.json() : null)).then(j => { if (live && j) setD(j); }).catch(() => {});
    load();
    const t = setInterval(load, 180000);
    return () => { live = false; clearInterval(t); };
  }, []);
  if (!d) return <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: 16 }}>載入波段起漲…</div>;
  if (!d.found) return <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: 16 }}>尚無資料（常駐服務數分鐘內產生）。</div>;
  const items = d.items || [];
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ padding: '10px 14px', borderRadius: 12, background: 'rgba(125,211,252,0.06)', border: '1px solid rgba(125,211,252,0.3)', fontSize: 12, lineHeight: 1.85, color: 'var(--text-secondary)' }}>
        <div style={{ fontWeight: 900, color: 'var(--text-primary)', fontSize: 13 }}>🌊 波段起漲選股 · <span style={{ color: '#fbbf24' }}>持有 5 個交易日</span></div>
        <div>⚠ <b style={{ color: 'var(--text-primary)' }}>這不是隔日沖訊號</b>：本訊號隔日開盤賣 −0.06%／隔日收盤賣 −0.44%／持有5日 +1.10%——edge 全在第5日，用隔日沖方式操作會賺不到。也因此<b>不併入隔日沖綜合評分</b>。</div>
        <div>{d.horizon}</div>
      </div>
      <div style={{ padding: '9px 14px', borderRadius: 12, fontSize: 12.5, fontWeight: 700, lineHeight: 1.7,
        background: d.bearDay === false ? 'rgba(47,158,68,0.10)' : 'rgba(240,62,62,0.08)',
        border: `1px solid ${d.bearDay === false ? 'rgba(47,158,68,0.4)' : 'rgba(240,62,62,0.3)'}`,
        color: d.bearDay === false ? '#69db7c' : 'var(--text-primary)' }}>
        {d.gate}
      </div>
      {(d.caveats ?? []).map((c, i) => (
        <div key={i} style={{ padding: '9px 14px', borderRadius: 12, fontSize: 12, lineHeight: 1.75, fontWeight: 600,
          background: 'rgba(250,176,5,0.09)', border: '1px solid rgba(250,176,5,0.35)', color: 'var(--text-primary)' }}>
          {c}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-muted)' }}>
        <span>📅 {d.date} · {d.mode === 'live' ? '盤中即時' : '收盤定版'}</span>
        {d.instDate && <span>🏦 法人資料 {d.instDate}{d.instSameDay ? '（含今日T86 → 明日買進）' : '（前一交易日 → 今日收盤可買）'}</span>}
        <span>共 ⭐⭐⭐{d.counts?.t3 ?? 0} / ⭐⭐{d.counts?.t2 ?? 0} / ⭐{d.counts?.t1 ?? 0} 檔{d.crowded ? '（僅顯示前 30）' : ''}</span>
      </div>
      {TIER.map(t => {
        const list = items.filter(x => x.tier === t.n);
        return (
          <div key={t.n} style={{ padding: '12px 14px', borderRadius: 12, background: 'var(--bg-elevated)', border: `1px solid ${t.color}55` }}>
            <div style={{ fontWeight: 900, fontSize: 13.5, color: t.color }}>{t.label} <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>{list.length} 檔</span></div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, margin: '2px 0 6px' }}>📐 {d.evidence?.[t.key]}</div>
            {list.map(it => (
              <div key={it.code} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12.5, padding: '4px 0', borderTop: '1px solid rgba(148,163,184,0.08)', flexWrap: 'wrap' }}>
                <button onClick={() => navigateTo('stock', it.code)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-primary)', fontWeight: 800, fontSize: 12.5, padding: 0 }}>{it.code} {it.name}</button>
                {it.deepPull && <span style={{ fontSize: 10.5, color: '#c084fc' }}>深回檔 {(it.posture60! * 100).toFixed(0)}%</span>}
                {it.bigVol && <span style={{ fontSize: 10.5, color: '#7dd3fc' }}>量{it.vol.toLocaleString()}張</span>}
                {it.vol20 != null && <span title="20日日報酬標準差。本榜已套用 vol20≥1.5% 波動 gate——低波動股實測真起漲僅8.6%(基準18.9%)、5日均-1.268%，是純負貢獻，一律不上榜。" style={{ fontSize: 10.5, color: it.vol20 >= 3 ? '#fb923c' : '#94a3b8' }}>波動{it.vol20}%</span>}
                {it.breakRisk && <span title={'KD 交叉→5日內破今日最低的機率（實證·主窗/OOT）：金叉 57.4%/50.3%、無交叉≈基準 71.9%/65.6%、死叉 80.8%/75.3%。⚠這是破底風險不是漲幅——拆解檢定顯示 KD 交叉對「5日內漲≥5%」貢獻為零，推漲幅的是波動。用途：預估「破前低無條件停損」多久會觸發。'} style={{ fontSize: 10.5, color: it.breakRisk === 'low' ? '#22c55e' : it.breakRisk === 'high' ? '#f87171' : '#94a3b8' }}>破底風險{it.breakRisk === 'low' ? '低·KD金叉' : it.breakRisk === 'high' ? '高·KD死叉' : '中'}</span>}
                <span style={{ marginLeft: 'auto', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-secondary)' }}>{it.price}</span>
                {it.chg != null && <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: it.chg >= 0 ? UP : DOWN, minWidth: 56, textAlign: 'right' }}>{it.chg >= 0 ? '+' : ''}{it.chg}%</span>}
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#fbbf24', minWidth: 92, textAlign: 'right' }}>RSI {it.rsi5}/{it.rsi10}</span>
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--text-muted)', minWidth: 64, textAlign: 'right' }}>量比{it.volX}</span>
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: UP, minWidth: 78, textAlign: 'right' }}>法人+{it.instT1.toLocaleString()}</span>
              </div>
            ))}
            {list.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>目前無符合。</div>}
          </div>
        );
      })}
      <div style={{ padding: '10px 14px', borderRadius: 12, background: 'rgba(240,62,62,0.06)', border: '1px solid rgba(240,62,62,0.25)', fontSize: 11.5, lineHeight: 1.85, color: 'var(--text-secondary)' }}>
        <div><b style={{ color: 'var(--text-primary)' }}>🔬 驗證強度</b>：{d.evidence?.oot}</div>
        <div style={{ marginTop: 4 }}><b style={{ color: '#ff8787' }}>⚠ 風險</b>：{d.evidence?.risk}</div>
      </div>
    </div>
  );
}

export default function IndexNewsPage() {
  const [tab, setTab] = useState<'index' | 'news' | 'topic' | 'swing' | 'strength'>('index');
  return (
    <div style={{ padding: '12px 16px', maxWidth: 1100, margin: '0 auto' }}>
      <PageHelp id="indexnews" />
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        {([['index', '📈 指數分析'], ['news', '📰 每日新聞'], ['topic', '🎯 話題選股'], ['swing', '🌊 波段起漲'], ['strength', '🚀 波段追強']] as const).map(([k, label]) => {
          const on = tab === k;
          return (
            <button key={k} onClick={() => setTab(k)}
              style={{ padding: '7px 16px', borderRadius: 10, fontSize: 13.5, fontWeight: 900, cursor: 'pointer',
                border: `1px solid ${on ? 'rgba(125,211,252,0.6)' : 'var(--border-primary)'}`,
                background: on ? 'rgba(125,211,252,0.14)' : 'transparent',
                color: on ? 'var(--text-primary)' : 'var(--text-muted)' }}>
              {label}
            </button>
          );
        })}
      </div>
      {tab === 'index' ? <IndexTab /> : tab === 'news' ? <NewsTab /> : tab === 'topic' ? <TopicTab /> : tab === 'swing' ? <SwingTab /> : <StrengthTab />}
    </div>
  );
}
