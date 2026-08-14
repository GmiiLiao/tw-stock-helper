'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { shouldPollNow } from '@/lib/market-clock';

// ── 大盤即時走勢浮動窗（2026-08-14 使用者需求）──────────────────────
// 點左上「台股加權指數」卡片彈出：指數線＋平盤紅綠填色＋每分鐘成交值量條
// ＋游標查價（時間/成交價/成交值），上市/上櫃切換。
// 資料：/api/twse/index-intraday（daemon 每 ~55 秒累積一點，重啟自還原）。
// SVG 鐵則：preserveAspectRatio="none" 的 SVG 內零文字，標籤全在 HTML 層。

type Pt = [number, number, number];   // [epochMs, 指數, 累積成交值(億)]
interface IdxDoc {
  date: string; updatedAt: number;
  prevCloseTse: number; prevCloseOtc: number | null;
  tseJson: string; otcJson: string;
}

const W = 760, H = 300, PH = 200, VH = 70;   // 價格區 0..200、量條由底部向上最多 70

export default function IndexIntradayModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [doc, setDoc] = useState<IdxDoc | null>(null);
  const [market, setMarket] = useState<'tse' | 'otc'>('tse');
  const [tipIdx, setTipIdx] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const load = (force = false) => {
      if (!force && !shouldPollNow()) return;
      fetch('/api/twse/index-intraday').then(r => (r.ok ? r.json() : null)).then(d => { if (live && d?.tseJson) setDoc(d); }).catch(() => {});
    };
    load(true);   // 開窗必載一次（休市顯示最近交易日）
    const t = setInterval(() => load(), 60000);
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => { live = false; clearInterval(t); window.removeEventListener('keydown', esc); };
  }, [open, onClose]);

  const view = useMemo(() => {
    if (!doc) return null;
    const pts: Pt[] = JSON.parse((market === 'tse' ? doc.tseJson : doc.otcJson) || '[]');
    const prev = market === 'tse' ? doc.prevCloseTse : (doc.prevCloseOtc || 0);
    if (!pts.length || !(prev > 0)) return { pts: [] as Pt[], prev, empty: true } as const;
    // x 域固定 09:00–13:35（依資料日）
    const d0 = new Date(pts[0][0]);
    const dayStart = new Date(d0); dayStart.setHours(9, 0, 0, 0);
    const span = (13 * 60 + 35 - 9 * 60) * 60000;
    const x = (t: number) => Math.max(0, Math.min(1, (t - dayStart.getTime()) / span)) * W;
    let lo = prev, hi = prev;
    for (const p of pts) { if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1]; }
    const pad = Math.max((hi - lo) * 0.08, prev * 0.001);
    hi += pad; lo -= pad;
    const y = (v: number) => PH - ((v - lo) / (hi - lo)) * PH;
    const yPrev = y(prev);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
    const area = `${line}L${x(pts[pts.length - 1][0]).toFixed(1)},${yPrev.toFixed(1)}L${x(pts[0][0]).toFixed(1)},${yPrev.toFixed(1)}Z`;
    // 每點成交值增量（億）→ 量條
    const vols = pts.map((p, i) => Math.max(0, p[2] - (i ? pts[i - 1][2] : 0)));
    const vMax = Math.max(...vols, 0.001);
    const bw = Math.max(1.2, W / Math.max(pts.length, 60) * 0.7);
    const last = pts[pts.length - 1];
    const chg = last[1] - prev;
    return { pts, prev, empty: false, x, y, yPrev, line, area, vols, vMax, bw, hi, lo, last, chg } as const;
  }, [doc, market]);

  if (!open) return null;
  const fmtT = (t: number) => new Date(t).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' });
  const up = 'var(--color-up)', down = 'var(--color-down)';
  const tip = view && !view.empty && tipIdx != null ? view.pts[Math.min(tipIdx, view.pts.length - 1)] : null;
  const tipVol = tip && view && !view.empty ? view.vols[Math.min(tipIdx!, view.vols.length - 1)] : 0;

  const onMove = (e: React.PointerEvent) => {
    if (!view || view.empty || !wrapRef.current) return;
    const r = wrapRef.current.getBoundingClientRect();
    const ratio = (e.clientX - r.left) / r.width;
    // 找最接近游標 x 的點（點依時間非等距，需以 x 值搜尋）
    let best = 0, bd = Infinity;
    for (let i = 0; i < view.pts.length; i++) {
      const d = Math.abs(view.x(view.pts[i][0]) / W - ratio);
      if (d < bd) { bd = d; best = i; }
    }
    setTipIdx(best);
  };

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(0,0,0,0.55)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: '48px 12px 12px' }}>
      <div onClick={e => e.stopPropagation()}
        style={{ width: 'min(820px, 100%)', background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-lg)', padding: '14px 16px', boxShadow: '0 18px 60px rgba(0,0,0,0.5)' }}>
        {/* 標頭 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
          {(['tse', 'otc'] as const).map(m => (
            <button key={m} onClick={() => { setMarket(m); setTipIdx(null); }}
              style={{ padding: '4px 14px', borderRadius: 999, border: '1px solid', cursor: 'pointer', fontWeight: 700, fontSize: 'calc(0.82rem * var(--fz))',
                borderColor: market === m ? 'var(--accent-blue)' : 'var(--border-primary)',
                background: market === m ? 'rgba(59,130,246,0.15)' : 'transparent',
                color: market === m ? 'var(--accent-blue)' : 'var(--text-secondary)' }}>
              {m === 'tse' ? '加權指數' : '櫃買指數'}
            </button>
          ))}
          {view && !view.empty && (
            <span style={{ fontFamily: "'JetBrains Mono',monospace", fontWeight: 800, fontSize: 'calc(1.05rem * var(--fz))', color: view.chg >= 0 ? up : down }}>
              {view.last[1].toLocaleString('zh-TW', { minimumFractionDigits: 2 })}
              <span style={{ fontSize: 'calc(0.8rem * var(--fz))', marginLeft: 8 }}>
                {view.chg >= 0 ? '+' : ''}{view.chg.toFixed(2)}（{view.chg >= 0 ? '+' : ''}{((view.chg / view.prev) * 100).toFixed(2)}%）
              </span>
            </span>
          )}
          <span style={{ marginLeft: 'auto', fontSize: 'calc(0.72rem * var(--fz))', color: 'var(--text-muted)' }}>
            {doc?.date}{view && !view.empty ? ` ・ 成交值累計 ${view.last[2].toLocaleString('zh-TW', { maximumFractionDigits: 0 })} 億` : ''}
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 'calc(1.1rem * var(--fz))', lineHeight: 1 }}>✕</button>
        </div>

        {!view || view.empty ? (
          <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'calc(0.85rem * var(--fz))' }}>
            {market === 'otc' && view ? '櫃買序列尚未累積' : '盤中序列於開盤後開始累積（每分鐘一點），今日尚無資料。'}
          </div>
        ) : (
          <div ref={wrapRef} onPointerMove={onMove} onPointerLeave={() => setTipIdx(null)}
            style={{ position: 'relative', width: '100%', touchAction: 'pan-y' }}>
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 'auto', display: 'block' }}>
              <defs>
                <clipPath id="idx-above"><rect x="0" y="0" width={W} height={Math.max(0, view.yPrev)} /></clipPath>
                <clipPath id="idx-below"><rect x="0" y={view.yPrev} width={W} height={Math.max(0, PH - view.yPrev)} /></clipPath>
              </defs>
              {/* 平盤上下填色（同一面積路徑分別裁剪） */}
              <path d={view.area} fill="rgba(240,62,62,0.18)" clipPath="url(#idx-above)" />
              <path d={view.area} fill="rgba(47,158,68,0.18)" clipPath="url(#idx-below)" />
              {/* 平盤虛線 */}
              <line x1="0" y1={view.yPrev} x2={W} y2={view.yPrev} stroke="var(--text-muted)" strokeDasharray="5 4" strokeWidth="1" vectorEffect="non-scaling-stroke" opacity="0.7" />
              {/* 指數線 */}
              <path d={view.line} fill="none" stroke={view.chg >= 0 ? '#f03e3e' : '#2f9e44'} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
              {/* 量條 */}
              {view.pts.map((p, i) => {
                const h = (view.vols[i] / view.vMax) * (VH - 4);
                return <rect key={i} x={view.x(p[0]) - view.bw / 2} y={H - h} width={view.bw} height={h} fill="rgba(245,158,11,0.65)" />;
              })}
              {/* 游標十字 */}
              {tip && (
                <line x1={view.x(tip[0])} y1="0" x2={view.x(tip[0])} y2={H} stroke="var(--text-secondary)" strokeDasharray="3 3" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              )}
            </svg>
            {/* HTML 標籤層 */}
            <div style={{ position: 'absolute', left: 2, top: 0, fontSize: 'calc(0.65rem * var(--fz))', color: 'var(--text-muted)', fontFamily: "'JetBrains Mono',monospace" }}>{view.hi.toFixed(0)}</div>
            <div style={{ position: 'absolute', left: 2, top: `${(view.yPrev / H) * 100}%`, transform: 'translateY(-100%)', fontSize: 'calc(0.65rem * var(--fz))', color: 'var(--text-muted)', fontFamily: "'JetBrains Mono',monospace" }}>{view.prev.toFixed(0)}</div>
            <div style={{ position: 'absolute', left: 2, top: `${(PH / H) * 100}%`, transform: 'translateY(-100%)', fontSize: 'calc(0.65rem * var(--fz))', color: 'var(--text-muted)', fontFamily: "'JetBrains Mono',monospace" }}>{view.lo.toFixed(0)}</div>
            <div style={{ position: 'absolute', right: 2, top: 0, fontSize: 'calc(0.65rem * var(--fz))', color: up, fontFamily: "'JetBrains Mono',monospace" }}>+{(((view.hi - view.prev) / view.prev) * 100).toFixed(1)}%</div>
            <div style={{ position: 'absolute', right: 2, top: `${(view.yPrev / H) * 100}%`, transform: 'translateY(-100%)', fontSize: 'calc(0.65rem * var(--fz))', color: 'var(--text-muted)', fontFamily: "'JetBrains Mono',monospace" }}>0%</div>
            <div style={{ position: 'absolute', right: 2, top: `${(PH / H) * 100}%`, transform: 'translateY(-100%)', fontSize: 'calc(0.65rem * var(--fz))', color: down, fontFamily: "'JetBrains Mono',monospace" }}>−{(((view.prev - view.lo) / view.prev) * 100).toFixed(1)}%</div>
            {['09:00', '10:00', '11:00', '12:00', '13:00'].map((t, i) => (
              <div key={t} style={{ position: 'absolute', left: `${((i * 60) / 275) * 100}%`, bottom: -2, fontSize: 'calc(0.62rem * var(--fz))', color: 'var(--text-muted)', fontFamily: "'JetBrains Mono',monospace" }}>{t}</div>
            ))}
            {/* 游標資訊卡 */}
            {tip && (
              <div style={{ position: 'absolute', top: 8, left: view.x(tip[0]) / W > 0.55 ? 8 : undefined, right: view.x(tip[0]) / W > 0.55 ? undefined : 8,
                background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)', borderRadius: 8, padding: '6px 10px', fontSize: 'calc(0.74rem * var(--fz))', fontFamily: "'JetBrains Mono',monospace", pointerEvents: 'none' }}>
                <div style={{ color: 'var(--text-muted)' }}>時間：{fmtT(tip[0])}</div>
                <div style={{ color: tip[1] >= view.prev ? up : down }}>成交價：{tip[1].toLocaleString('zh-TW', { minimumFractionDigits: 2 })}（{tip[1] >= view.prev ? '+' : ''}{(tip[1] - view.prev).toFixed(2)}）</div>
                <div style={{ color: '#f59e0b' }}>成交值：{tipVol.toFixed(2)} 億</div>
              </div>
            )}
          </div>
        )}
        <div style={{ marginTop: 8, fontSize: 'calc(0.66rem * var(--fz))', color: 'var(--text-muted)' }}>約每分鐘一點・資料源：daemon MIS 指數輪詢・非投資建議</div>
      </div>
    </div>
  );
}
