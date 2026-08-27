'use client';

import { useEffect, useState } from 'react';
import { useAppStore } from '@/lib/store';
import { useDayTradeCodes, statusOf } from '@/lib/useDayTradeCodes';
import { DayTradeMark } from '@/components/shared/DayTradeBadge';

// ── 🧪 波段第 2 套預選機制：PID 斜率曲線分型 ──────────────────────────────
// 使用者指定（2026-08-11）：用 PID 找出 5/20 日最高勝率漲幅的斜率曲線（至少 5 種），
// 依曲線相似度預選推薦股，並做 60 日記錄後看哪一種勝率高。
//
// ⚠ 這張卡**必須**和已驗證的「波段起漲／追強」在視覺上區分開：
//   歷史三窗檢定中，八種曲線**沒有任何一種**通過「淨報酬Δ與勝率Δ皆為正」，
//   它現在的身分是「觀察中的實驗」，裁判是 60 日前瞻實記。
//   若做成和其他榜單一樣的樣式，使用者會把它當成同級訊號用——
//   所以標題掛 🧪、底色用中性灰、進度條與揭露文字一律不可省。
//
// ⚠ 最大累計成長（使用者要求的欄位）一律與**同期最大回檔**成對顯示。
//   單看成長會讓高波動分型看起來最強，但那也是回檔最深的一群
//   （前一版 analog 實驗已實測：Top10% 回檔 -6.58% vs 宇宙 -4.07%）。

interface Pick { code: string; name: string; price: number; dist: number; sigma: number }
interface Hist { net5: number; win5: number; net20: number; win20: number; grow5: number; grow20: number; draw5: number; draw20: number }
interface Curve { id: number; name: string; curve: number[]; score5: number | null; score20: number | null; hist: Hist | null }
interface Board { d5?: { n: number; winRate: number; avgNet: number; avgGrow: number; avgDraw: number }; d20?: { n: number; winRate: number; avgNet: number; avgGrow: number; avgDraw: number }; name: string }
interface Data {
  found: boolean; date?: string; universe?: number; note?: string;
  curves?: Curve[];
  byCurve?: Record<string, { name: string; total: number; picks: Pick[] }>;
  scoreboard?: { recordedDays: number; targetDays: number; byCurve: Record<string, Board>;
    leader5: { id: number; name: string; winRate: number } | null;
    leader20: { id: number; name: string; winRate: number } | null; note?: string } | null;
}

const UP = '#f03e3e', DOWN = '#2f9e44';
const sign = (v: number | null | undefined, d = 2) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}`);

// 分型平均曲線的縮圖。20 個點、等比縮放，只表達形狀。
function Spark({ pts, color }: { pts: number[]; color: string }) {
  if (!pts?.length) return null;
  const lo = Math.min(...pts), hi = Math.max(...pts), span = hi - lo || 1;
  const d = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i / (pts.length - 1) * 100).toFixed(1)},${(26 - (v - lo) / span * 22).toFixed(1)}`).join(' ');
  return (
    // preserveAspectRatio="none" 讓它填滿寬度；這裡沒有任何文字，
    // 所以不會踩到「非等比縮放把字壓扁」那個坑（個股K線圖是活教材）。
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" style={{ width: '100%', height: 28, display: 'block' }}>
      <line x1={0} x2={100} y1={26 - (0 - lo) / span * 22} y2={26 - (0 - lo) / span * 22} stroke="rgba(148,163,184,0.35)" strokeDasharray="3 3" strokeWidth={0.6} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export default function SwingCurveBoard() {
  const dt = useDayTradeCodes();   // 當沖資格：必須在任何 early return 之前
  const navigateTo = useAppStore(s => s.navigateTo);
  const [d, setD] = useState<Data | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/ai/swing-curves').then(r => (r.ok ? r.json() : null))
      .then(x => { if (live && x) setD(x); }).catch(() => {});
    return () => { live = false; };
  }, []);

  if (!d?.found || !d.curves?.length) return null;
  const sb = d.scoreboard;
  const progress = sb ? Math.min(sb.recordedDays / sb.targetDays, 1) : 0;

  return (
    <div style={{ border: '1px dashed var(--border-primary)', borderRadius: 12, background: 'rgba(148,163,184,0.05)', padding: '12px 14px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, rowGap: 2, flexWrap: 'wrap', marginBottom: 4, minWidth: 0 }}>
        <span style={{ fontWeight: 900, fontSize: 'calc(0.9rem * var(--fz))', whiteSpace: 'nowrap' }}>🧪 第 2 套預選：PID 斜率曲線</span>
        <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: '#fbbf24', whiteSpace: 'nowrap' }}>觀察中·非已驗證訊號</span>
        {d.date && <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{d.date}·宇宙 {d.universe} 檔</span>}
      </div>

      {/* 實記進度：這是本實驗的裁判，放在最上面 */}
      {sb && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', columnGap: 8, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginBottom: 3 }}>
            <span style={{ whiteSpace: 'nowrap' }}>60 日實記進度 {sb.recordedDays}/{sb.targetDays} 日</span>
            <span style={{ whiteSpace: 'nowrap' }}>
              {sb.leader5 ? `5日領先 ${sb.leader5.name} ${sb.leader5.winRate}%` : '5日：樣本未達判定門檻'}
            </span>
          </div>
          <div style={{ height: 5, borderRadius: 3, background: 'var(--bg-tertiary)', overflow: 'hidden' }}>
            <div style={{ width: `${progress * 100}%`, height: '100%', background: '#7dd3fc', transition: 'width .3s' }} />
          </div>
        </div>
      )}

      <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: '#fbbf24', lineHeight: 1.65, marginBottom: 8 }}>
        {d.note}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(230px, 100%), 1fr))', gap: 8, minWidth: 0 }}>
        {d.curves.map(c => {
          const picks = d.byCurve?.[String(c.id)];
          const live5 = sb?.byCurve?.[String(c.id)]?.d5;
          const strong = (c.score5 ?? 0) + (c.score20 ?? 0);
          const col = strong >= 8 ? '#7dd3fc' : strong <= 2 ? DOWN : 'var(--text-secondary)';
          return (
            <div key={c.id} style={{ border: '1px solid var(--border-primary)', borderRadius: 9, padding: '8px 9px', background: 'var(--bg-elevated)', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, rowGap: 2, flexWrap: 'wrap', minWidth: 0 }}>
                <b style={{ fontSize: 'calc(12.5px * var(--fz))', color: col, whiteSpace: 'nowrap' }}>曲線{c.id} {c.name}</b>
                <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                  一致性 {c.score5}/6·{c.score20}/6
                </span>
              </div>
              <Spark pts={c.curve} color={col} />
              {c.hist && (
                <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.7, marginTop: 3 }}>
                  {/* 成長與回檔成對——單看成長會誤導 */}
                  <div style={{ whiteSpace: 'nowrap' }}>歷史5日 淨{sign(c.hist.net5)}pp 勝{sign(c.hist.win5)}pp</div>
                  <div style={{ whiteSpace: 'nowrap' }}>歷史20日 淨{sign(c.hist.net20)}pp 勝{sign(c.hist.win20)}pp</div>
                  <div style={{ whiteSpace: 'nowrap' }}>
                    最大成長 <b style={{ color: UP }}>{c.hist.grow20.toFixed(1)}%</b>
                    <span style={{ margin: '0 3px' }}>／</span>
                    回檔 <b style={{ color: DOWN }}>{c.hist.draw20.toFixed(1)}%</b>
                    <span style={{ color: 'var(--text-muted)' }}>（20日）</span>
                  </div>
                  {live5 && <div style={{ whiteSpace: 'nowrap', color: '#7dd3fc' }}>實記5日 勝率 {live5.winRate}%·成長 {live5.avgGrow}%·n={live5.n}</div>}
                </div>
              )}
              {picks?.picks?.length ? (
                <>
                  <div style={{ marginTop: 5, display: 'grid', gap: 1 }}>
                    {picks.picks.slice(0, open === c.id ? 20 : 4).map(p => (
                      <div key={p.code} onClick={() => navigateTo('stock', p.code)}
                        style={{ display: 'flex', justifyContent: 'space-between', columnGap: 6, cursor: 'pointer', fontSize: 'calc(12.5px * var(--fz))', minWidth: 0 }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          <b style={{ color: '#7dd3fc' }}>{p.code}</b> {p.name} {(() => { const st = statusOf(dt, p.code); return st == null ? null : <DayTradeMark status={st} size="xs" />; })()}
                        </span>
                        <span style={{ whiteSpace: 'nowrap', fontFamily: "'JetBrains Mono',monospace", color: 'var(--text-secondary)' }}>{p.price}</span>
                      </div>
                    ))}
                  </div>
                  <button onClick={() => setOpen(open === c.id ? null : c.id)}
                    style={{ marginTop: 4, background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0, fontFamily: 'inherit', fontSize: 'calc(12.5px * var(--fz))' }}>
                    {open === c.id ? '收合 ▴' : `展開全部 ${picks.picks.length} 檔（同型共 ${picks.total} 檔）▾`}
                  </button>
                </>
              ) : <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginTop: 4 }}>今日無此型</div>}
            </div>
          );
        })}
      </div>

      <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.65, marginTop: 8 }}>
        📐 PID＝把 20 日走勢除以該檔自身波動後分解：P 現況（對 5 日均線的偏離）、I 累積、D 斜率、D2 加速度。
        分型中心以 2022-07~2024-03 擬合後凍結，再套用到後續兩窗，避免分型偷看未來。
        「一致性 n/6」＝3 個歷史窗 × {'{'}淨報酬Δ、勝率Δ{'}'} 為正的項數。
        最大成長為期間最高點的上界（賣不到），故一律附同期最大回檔。歷史統計非未來保證，非投資建議。
      </div>
    </div>
  );
}
