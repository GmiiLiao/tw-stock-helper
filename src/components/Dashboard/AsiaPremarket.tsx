'use client';

import { useEffect, useState } from 'react';

// ── 日韓早盤風向卡（台股開盤前）──────────────────────────────────
// 時區事實：日本與韓國都是 UTC+9，09:00 開盤＝台北 08:00；台股 09:00 才開盤，
//   所以開盤前有 30~60 分鐘的日韓實盤資訊，這是真的領先窗口。
// ⚠本卡的預測力是**初步**（n=54 交易日，遠低於本站 480日主窗＋OOT 標準），
//   所有數字與警語都由 daemon 帶下來，UI 不自行加工也不自行下結論。
// 非投資建議。

const UP = '#f03e3e', DOWN = '#2f9e44';
const col = (v: number | null | undefined) => (v == null ? 'var(--text-muted)' : v >= 0 ? UP : DOWN);
const sign = (v: number | null | undefined) => (v == null ? '--' : `${v >= 0 ? '+' : ''}${v}%`);

interface Idx { sym: string; name: string; mkt: string; price: number; gap: number | null; drift: number | null; total: number }
interface Sector { sector: string; twPeers: string; leaders: string; chg: number }
interface Bell { sym: string; name: string; sector: string; twPeers: string; total: number }
interface Payload {
  found?: boolean; date?: string; updatedAt?: number; twOpenIn?: number;
  indices?: Idx[]; bellwethers?: Bell[]; sectors?: Sector[];
  score?: number | null; bias?: 'bull' | 'bear' | 'neutral' | null; biasNote?: string | null;
  sox?: number | null; soxNote?: string | null;
  horizon?: string; evidence?: string; caveats?: string[];
}

const BIAS_STYLE: Record<string, { t: string; c: string }> = {
  bull: { t: '偏多', c: UP }, bear: { t: '偏空', c: DOWN }, neutral: { t: '中性', c: '#94a3b8' },
};

export default function AsiaPremarket() {
  const [d, setD] = useState<Payload | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () => fetch('/api/ai/asia-premarket')
      .then(r => (r.ok ? r.json() : null))
      .then(x => { if (live && x?.found !== false) setD(x); })
      .catch(() => {});
    load();
    // 只在台股開盤前後才有新資料，其餘時間輪詢是浪費——5 分一次已足夠。
    const id = setInterval(load, 300000);
    return () => { live = false; clearInterval(id); };
  }, []);

  if (!d || !d.indices?.length) return null;
  const b = d.bias ? BIAS_STYLE[d.bias] : null;
  const stale = d.updatedAt ? (Date.now() - d.updatedAt) / 60000 : 999;

  return (
    <div style={{ border: '1px solid rgba(148,163,184,0.18)', borderRadius: 10, padding: '10px 12px', margin: '10px 0', background: 'var(--bg-card, rgba(148,163,184,0.04))' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 800, fontSize: 13 }}>🌏 日韓早盤風向</span>
        <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
          日韓 09:00 開盤＝台北 08:00{d.twOpenIn != null && d.twOpenIn > 0 ? `，距台股開盤 ${d.twOpenIn} 分` : ''}
        </span>
        {b && (
          <span style={{ marginLeft: 'auto', fontWeight: 800, fontSize: 13, color: b.c }}>
            綜合 {sign(d.score)} → {b.t}
          </span>
        )}
      </div>

      {stale > 180 && (
        <div style={{ fontSize: 10.5, color: '#fbbf24', marginTop: 4 }}>
          ⚠資料為 {d.date}（已逾 {Math.round(stale / 60)} 小時未更新）——非今日盤前即時值，僅供回看。
        </div>
      )}
      {d.biasNote && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 5, lineHeight: 1.6 }}>📐 {d.biasNote}</div>}
      {d.soxNote && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.6 }}>🇺🇸 {d.soxNote}</div>}

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8 }}>
        {d.indices.map(x => (
          <div key={x.sym} style={{ fontSize: 12 }}>
            <span style={{ fontWeight: 700 }}>{x.name}</span>{' '}
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 800, color: col(x.total) }}>{sign(x.total)}</span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>
              (跳空{sign(x.gap)}·開後{sign(x.drift)})
            </span>
          </div>
        ))}
      </div>

      {!!d.sectors?.length && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 3 }}>產業風向（日韓龍頭 → 台股對應族群）</div>
          {d.sectors.map(s => (
            <div key={s.sector} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11.5, padding: '2px 0', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, minWidth: 68 }}>{s.sector}</span>
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 800, color: col(s.chg), minWidth: 54, textAlign: 'right' }}>{sign(s.chg)}</span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{s.leaders}</span>
              <span style={{ fontSize: 10, color: '#7dd3fc', marginLeft: 'auto' }}>→ {s.twPeers}</span>
            </div>
          ))}
        </div>
      )}

      <button onClick={() => setOpen(o => !o)} style={{ background: 'none', border: 'none', color: '#7dd3fc', fontSize: 10.5, cursor: 'pointer', padding: '6px 0 0', textAlign: 'left' }}>
        {open ? '▾ 收起實證與限制' : '▸ 實證數字與限制（務必先看）'}
      </button>
      {open && (
        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', lineHeight: 1.7, marginTop: 3 }}>
          {d.horizon && <div>⏱ {d.horizon}</div>}
          {d.evidence && <div style={{ marginTop: 3 }}>📊 {d.evidence}</div>}
          {d.caveats?.map((c, i) => <div key={i} style={{ marginTop: 3 }}>{c}</div>)}
          <div style={{ marginTop: 4 }}>非投資建議。</div>
        </div>
      )}
    </div>
  );
}
