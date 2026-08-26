'use client';

// ── 個股「💰 財務體檢」分頁：近2年8季財報＋體質分＋本益比評價 ──────────
// 資料：/api/ai/fin-report（MOPS 官方，累計已換算單季）。確定性計算，非投資建議。

import { useEffect, useState } from 'react';

interface Q { y: number; s: number; rev?: number | null; ni?: number | null; eps?: number | null; gm?: number | null; om?: number | null; nm?: number | null; bps?: number | null; equity?: number | null; assets?: number | null; debt?: number | null }
interface Quality {
  score: number; profit: number; growth: number; stable: number; valuation: number;
  ttmEps: number | null; pe: number | null; pb: number | null; roe: number | null;
  epsYoY: number | null; revYoY: number | null; streak: number; lossQ: number; debtRatio: number | null; gm: number | null; nm: number | null;
}
interface FinData { found: boolean; name?: string; quarters?: Q[]; singles?: Q[]; quality?: Quality | null }

const scoreColor = (s: number) => s >= 70 ? '#f03e3e' : s >= 50 ? '#fbbf24' : s >= 30 ? '#94a3b8' : '#2f9e44';

export default function FinHealth({ code, price }: { code: string; price: number }) {
  const [data, setData] = useState<FinData | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/ai/fin-report?code=${code}&price=${price || 0}`)
      .then(r => (r.ok ? r.json() : null)).then(x => { if (live) setData(x || { found: false }); }).catch(() => { if (live) setData({ found: false }); });
    return () => { live = false; };
  }, [code, price]);

  if (!data) return <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 'calc(13px * var(--fz))' }}>載入財報…</div>;
  if (!data.found || !data.singles?.length) return <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 'calc(13px * var(--fz))' }}>此標的無財報資料（ETF/新上市/金融特殊格式）。</div>;
  const q = data.quality;
  const singles = data.singles.filter(x => x && (x.eps != null || x.rev != null));
  const fmtRev = (v?: number | null) => v == null ? '—' : v >= 1e6 ? `${(v / 1e6).toFixed(0)}百萬` : `${(v / 1e3).toFixed(0)}千`;
  const cell = (v?: number | null, suffix = '', red = 0) => v == null ? <span style={{ color: 'var(--text-muted)' }}>—</span>
    : <span style={{ color: v > red ? '#f03e3e' : v < 0 ? '#2f9e44' : 'var(--text-secondary)', fontWeight: 600 }}>{v}{suffix}</span>;

  return (
    <div style={{ padding: '4px 2px' }}>
      {q && (
        <>
          {/* 體質分 */}
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', padding: '12px 14px', borderRadius: 12, background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', marginBottom: 10 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 'calc(30px * var(--fz))', fontWeight: 900, color: scoreColor(q.score) }}>{q.score}</div>
              <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>財務體質分 /100</div>
            </div>
            <div style={{ flex: 1, minWidth: 220, display: 'grid', gap: 4 }}>
              {([['獲利性', q.profit, 30], ['成長性', q.growth, 30], ['穩定性', q.stable, 20], ['評價', q.valuation, 20]] as const).map(([label, v, max]) => (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'calc(12.5px * var(--fz))' }}>
                  <span style={{ minWidth: 44, color: 'var(--text-secondary)' }}>{label}</span>
                  <div style={{ flex: 1, height: 7, borderRadius: 4, background: 'rgba(148,163,184,0.12)', overflow: 'hidden' }}>
                    <div style={{ width: `${v / max * 100}%`, height: '100%', background: scoreColor(q.score) }} />
                  </div>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', minWidth: 44, textAlign: 'right' }}>{v}/{max}</span>
                </div>
              ))}
            </div>
          </div>
          {/* 關鍵指標 */}
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 'calc(12.5px * var(--fz))', padding: '8px 12px', borderRadius: 10, background: 'rgba(148,163,184,0.06)', marginBottom: 10 }}>
            <span>TTM EPS <b>{q.ttmEps ?? '—'}</b> 元</span>
            <span>本益比 <b style={{ color: '#fbbf24' }}>{q.pe ?? '—'}</b> 倍</span>
            <span>股價淨值比 <b>{q.pb ?? '—'}</b></span>
            <span>ROE(近4季) {cell(q.roe, '%')}</span>
            <span>EPS年增 {cell(q.epsYoY, '%')}</span>
            <span>營收年增 {cell(q.revYoY, '%')}</span>
            <span>連續成長 <b>{q.streak}</b> 季</span>
            <span>負債比 {cell(q.debtRatio, '%', 101)}</span>
            {q.lossQ > 0 && <span style={{ color: '#2f9e44', fontWeight: 700 }}>近8季虧損 {q.lossQ} 季</span>}
          </div>
        </>
      )}
      {/* 8季單季表 */}
      <div style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, color: 'var(--text-secondary)', margin: '4px 0 6px' }}>單季財報（新→舊·MOPS 官方，累計已換算單季）</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'calc(12.5px * var(--fz))', fontFamily: 'JetBrains Mono, monospace' }}>
          <thead>
            <tr style={{ color: 'var(--text-muted)', textAlign: 'right' }}>
              <th style={{ textAlign: 'left', padding: '4px 6px' }}>季度</th>
              <th style={{ padding: '4px 6px' }}>EPS(元)</th>
              <th style={{ padding: '4px 6px' }}>營收</th>
              <th style={{ padding: '4px 6px' }}>毛利率</th>
              <th style={{ padding: '4px 6px' }}>營益率</th>
              <th style={{ padding: '4px 6px' }}>純益率</th>
              <th style={{ padding: '4px 6px' }}>每股淨值</th>
            </tr>
          </thead>
          <tbody>
            {singles.map(x => (
              <tr key={`${x.y}Q${x.s}`} style={{ borderTop: '1px solid var(--border-primary)', textAlign: 'right' }}>
                <td style={{ textAlign: 'left', padding: '4px 6px', fontWeight: 700 }}>{x.y}Q{x.s}</td>
                <td style={{ padding: '4px 6px' }}>{cell(x.eps)}</td>
                <td style={{ padding: '4px 6px', color: 'var(--text-secondary)' }}>{fmtRev(x.rev)}</td>
                <td style={{ padding: '4px 6px' }}>{cell(x.gm, '%')}</td>
                <td style={{ padding: '4px 6px' }}>{cell(x.om, '%')}</td>
                <td style={{ padding: '4px 6px' }}>{cell(x.nm, '%')}</td>
                <td style={{ padding: '4px 6px', color: 'var(--text-secondary)' }}>{x.bps ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 10, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.7 }}>
        ⚠ 體質分已回測（2 個財報事件·公布後20日）：最低分組顯著跑輸、高分組跑贏——價值在「避開爛財報」；本益比實證在短線為反向指標，僅供評價位階參考。已以「重罰低分、輕獎高分」×1.5 併入選股AI排序。季報每季更新。非投資建議。
      </div>
    </div>
  );
}
