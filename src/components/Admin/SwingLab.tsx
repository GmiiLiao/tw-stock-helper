'use client';

import { useEffect, useState } from 'react';
import { auth } from '@/lib/firebase';

// ── 🧪 波段技巧實驗室（superadmin 專用）──────────────────────────────
// 「技巧 → 回測實證 → 視覺驗證 → 判定 pass 才生成 skill」的驗證視窗。
// 資料：scripts/swing-lab.mjs 事件驅動回測 → swingLab/latest。
// 判定門檻（缺一即 fail）：主窗淨均>0、主窗前後半同向且皆有樣本、
// OOT 獨立年段淨均>0、主窗與 OOT 都贏過同宇宙偽隨機基準。
// SVG 鐵則：preserveAspectRatio="none" 內零文字，標籤在 HTML 層。

interface Stat { n: number; netAvg?: number; netMed?: number; winRate?: number; avgHold?: number; p10?: number; p90?: number }
interface Tech {
  id: string; name: string; desc: string; verdict: 'pass' | 'fail' | 'insufficient';
  main: Stat; oot: Stat; half1: Stat; half2: Stat;
  years: Array<{ y: string; n: number; netAvg: number; winRate: number }>;
  curve: Array<[string, number]>;
  recent: Array<{ code: string; dEntry: string; dExit: string; held: number; net: number }>;
}
interface Report { found: boolean; date: string; mainStart: string; baseline: { main: Stat; oot: Stat }; techniques: Tech[] }

const VERDICT = {
  pass: { t: '✅ 實證通過 → 可生成 skill', c: '#22c55e' },
  fail: { t: '❌ 未過（不推上線）', c: '#ef4444' },
  insufficient: { t: '⚠ 樣本不足', c: '#f59e0b' },
} as const;

function Curve({ pts }: { pts: Array<[string, number]> }) {
  if (pts.length < 2) return null;
  const vals = pts.map(p => p[1]);
  const lo = Math.min(...vals, 0), hi = Math.max(...vals, 0);
  const W = 560, H = 120;
  const x = (i: number) => (i / (pts.length - 1)) * W;
  const y = (v: number) => H - ((v - lo) / (hi - lo || 1)) * H;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  const up = pts[pts.length - 1][1] >= 0;
  return (
    <div style={{ position: 'relative', marginTop: 6 }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 96, display: 'block', background: 'var(--bg-secondary)', borderRadius: 8 }}>
        <line x1="0" y1={y(0)} x2={W} y2={y(0)} stroke="var(--text-muted)" strokeDasharray="4 4" strokeWidth="1" vectorEffect="non-scaling-stroke" opacity="0.6" />
        <path d={d} fill="none" stroke={up ? '#f03e3e' : '#2f9e44'} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      </svg>
      <span style={{ position: 'absolute', left: 6, top: 2, fontSize: 10, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono',monospace" }}>{pts[0][0]}</span>
      <span style={{ position: 'absolute', right: 6, top: 2, fontSize: 10, color: up ? '#f03e3e' : '#2f9e44', fontFamily: "'JetBrains Mono',monospace" }}>
        累計 {pts[pts.length - 1][1] >= 0 ? '+' : ''}{pts[pts.length - 1][1]}%（逐筆淨%加總）
      </span>
      <span style={{ position: 'absolute', right: 6, bottom: 2, fontSize: 10, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono',monospace" }}>{pts[pts.length - 1][0]}</span>
    </div>
  );
}

const fmt = (v: number | undefined | null, sign = true) => v == null ? '—' : `${sign && v >= 0 ? '+' : ''}${v}`;
const cellC = (v: number | undefined | null) => (v ?? 0) >= 0 ? 'var(--color-up)' : 'var(--color-down)';

export default function SwingLab() {
  const [rep, setRep] = useState<Report | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    (async () => {
      try {
        const token = (await auth.currentUser?.getIdToken()) ?? '';
        const r = await fetch('/api/admin/swing-lab', { headers: { Authorization: `Bearer ${token}` } });
        const j = await r.json();
        if (!r.ok) setErr(j.error || `HTTP ${r.status}`); else setRep(j);
      } catch (e) { setErr(String(e)); }
    })();
  }, []);

  if (err) return <div style={{ padding: 16, color: '#ef4444' }}>載入失敗：{err}</div>;
  if (!rep) return <div style={{ padding: 16, color: 'var(--text-muted)' }}>載入中…</div>;
  if (!rep.found) return <div style={{ padding: 16, color: 'var(--text-muted)' }}>尚無回測結果——在 Mac 上執行 node scripts/swing-lab.mjs 產生。</div>;

  const B = rep.baseline;
  return (
    <div style={{ fontSize: 'calc(12.5px * var(--fz))', lineHeight: 1.7 }}>
      <div style={{ padding: '10px 12px', borderRadius: 10, background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.25)', marginBottom: 12 }}>
        <b>🧪 波段技巧實驗室</b>——技巧先過回測、視覺驗證後才生成 skill。資料至 <b>{rep.date}</b>；
        主窗＝近 480 交易日（{rep.mainStart} 起）拆前後半、OOT＝更早獨立年段；全部扣費稅 0.4425%、排除漲停日、量≥300 張、同碼不重疊持倉。
        <div style={{ marginTop: 4, color: 'var(--text-muted)' }}>
          同宇宙偽隨機基準（持有5日）：主窗 <b style={{ color: cellC(B.main.netAvg) }}>{fmt(B.main.netAvg)}%</b>（勝 {B.main.winRate}%·n={B.main.n}）｜
          OOT <b style={{ color: cellC(B.oot.netAvg) }}>{fmt(B.oot.netAvg)}%</b>（勝 {B.oot.winRate}%·n={B.oot.n}）——技巧必須兩窗都贏過它。
        </div>
      </div>

      {rep.techniques.map(t => {
        const v = VERDICT[t.verdict];
        return (
          <div key={t.id} style={{ marginBottom: 14, padding: '12px 14px', borderRadius: 12, background: 'var(--bg-card)', border: `1px solid ${t.verdict === 'pass' ? 'rgba(34,197,94,0.45)' : 'var(--border-primary)'}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <b style={{ fontSize: 'calc(0.9rem * var(--fz))' }}>{t.name}</b>
              <span style={{ padding: '2px 10px', borderRadius: 999, fontWeight: 800, fontSize: 'calc(12.5px * var(--fz))', color: v.c, border: `1px solid ${v.c}`, background: `${v.c}14` }}>{v.t}</span>
            </div>
            <div style={{ color: 'var(--text-muted)', margin: '2px 0 8px' }}>{t.desc}</div>

            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', fontFamily: "'JetBrains Mono',monospace", fontSize: 'calc(12.5px * var(--fz))', whiteSpace: 'nowrap' }}>
                <thead><tr style={{ color: 'var(--text-muted)' }}>
                  {['窗', 'n', '淨均%', '淨中位%', '勝率%', '均持有(日)', 'P10/P90'].map(h => <th key={h} style={{ padding: '2px 12px', textAlign: 'right', borderBottom: '1px solid var(--border-primary)' }}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {([['主窗', t.main], ['·前半', t.half1], ['·後半', t.half2], ['OOT', t.oot]] as Array<[string, Stat]>).map(([lb, s]) => (
                    <tr key={lb}>
                      <td style={{ padding: '2px 12px', textAlign: 'right', color: 'var(--text-secondary)' }}>{lb}</td>
                      <td style={{ padding: '2px 12px', textAlign: 'right' }}>{s.n}</td>
                      <td style={{ padding: '2px 12px', textAlign: 'right', color: cellC(s.netAvg), fontWeight: 700 }}>{fmt(s.netAvg)}</td>
                      <td style={{ padding: '2px 12px', textAlign: 'right', color: cellC(s.netMed) }}>{fmt(s.netMed)}</td>
                      <td style={{ padding: '2px 12px', textAlign: 'right' }}>{s.winRate ?? '—'}</td>
                      <td style={{ padding: '2px 12px', textAlign: 'right' }}>{s.avgHold ?? '—'}</td>
                      <td style={{ padding: '2px 12px', textAlign: 'right', color: 'var(--text-muted)' }}>{s.p10 != null ? `${s.p10} / ${s.p90}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Curve pts={t.curve} />

            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              {t.years.map(yr => (
                <span key={yr.y} style={{ padding: '2px 8px', borderRadius: 6, background: 'var(--bg-secondary)', fontFamily: "'JetBrains Mono',monospace", fontSize: 'calc(12.5px * var(--fz))' }}>
                  {yr.y}：<b style={{ color: cellC(yr.netAvg) }}>{fmt(yr.netAvg)}%</b> <span style={{ color: 'var(--text-muted)' }}>勝{yr.winRate}%·n{yr.n}</span>
                </span>
              ))}
            </div>

            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))' }}>最近 15 筆成交（抽查用）</summary>
              <div style={{ overflowX: 'auto', marginTop: 4, fontFamily: "'JetBrains Mono',monospace", fontSize: 'calc(12.5px * var(--fz))' }}>
                {t.recent.map((r, i) => (
                  <div key={i} style={{ display: 'flex', gap: 14, whiteSpace: 'nowrap' }}>
                    <span>{r.code}</span><span>{r.dEntry} → {r.dExit}</span><span>{r.held}日</span>
                    <b style={{ color: cellC(r.net) }}>{fmt(r.net)}%</b>
                  </div>
                ))}
              </div>
            </details>
          </div>
        );
      })}
      <div style={{ color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))' }}>
        ⚠ 只有標 ✅ 的技巧會被做成 skill 上線；❌ 者記錄在案避免重測。事件驅動回測·出場依規則逐日跟蹤·非投資建議。
      </div>
    </div>
  );
}
