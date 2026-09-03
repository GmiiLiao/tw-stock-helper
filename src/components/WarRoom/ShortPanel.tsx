'use client';

import { useEffect, useState } from 'react';
import { useAppStore } from '@/lib/store';

// ── 🐻 做空風控候選（2026-09-03 第一期）────────────────────────────
// daemon 盤中每 10 分鐘刷新、盤後定榜（shortCandidates/latest）。
// 設計原則：風控過濾在選股之前——資格層（可先賣當沖/非處置/非回補期/流動性）
// 與風控層（軋空榜反查排除/券資比>15%排除）先砍，再以多訊號共振排序。
// ⚠ 第一期展示排序未經 OOT 驗證——分數僅供排列，不宣稱勝率。非投資建議。

interface ShortItem {
  code: string; name: string; price: number; chg: number; score: number;
  reasons: string[]; shortRatio: number | null; dayTradeShort: boolean | null;
}
interface ShortDoc {
  updatedAt: number; dataDate: string | null; mode: 'active' | 'watch';
  health: number | null; items: ShortItem[]; totalPassed: number;
  skippedFilters: string[]; note: string;
}

const isTwTradingHours = () => {
  const tw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const d = tw.getDay(); const v = tw.getHours() * 60 + tw.getMinutes();
  return d >= 1 && d <= 5 && v >= 9 * 60 && v < 13 * 60 + 45;
};

export default function ShortPanel() {
  const [data, setData] = useState<ShortDoc | null>(null);
  const navigateTo = useAppStore(s => s.navigateTo);

  useEffect(() => {
    let live = true;
    const load = () => fetch('/api/ai/short-candidates')
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (live && j) setData(j); })
      .catch(() => { /* 保留舊資料 */ });
    load();
    // 榜單 10 分鐘一更，60 秒輪詢足夠（非逐拍報價，不接 revealTick）
    const t = setInterval(load, isTwTradingHours() ? 60_000 : 300_000);
    return () => { live = false; clearInterval(t); };
  }, []);

  if (!data) return <div style={{ padding: 20, color: 'var(--text-muted)' }}>載入中…</div>;

  const active = data.mode === 'active';
  return (
    <div style={{ padding: '10px 4px' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{
          fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, padding: '3px 10px', borderRadius: 6,
          background: active ? 'rgba(239,68,68,0.15)' : 'rgba(148,163,184,0.15)',
          color: active ? '#f87171' : 'var(--text-muted)',
          border: `1px solid ${active ? 'rgba(239,68,68,0.35)' : 'rgba(148,163,184,0.3)'}`,
        }}>
          {active ? `🐻 偏空日（健康度 ${data.health}）· 空方順風` : `⏸ 觀察模式（健康度 ${data.health ?? '—'}≥50·多頭日放空逆風）`}
        </span>
        <span style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>
          資料日 {data.dataDate ?? '—'} · 過濾後 {data.totalPassed} 檔 · 入榜 {data.items.length}
        </span>
      </div>

      <div style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.6 }}>
        資格層：可先賣現股當沖·非處置股·非除權息回補期(14日)·20日均額&gt;5000萬｜
        風控層：<b>軋空候選榜反查排除</b>·券資比&gt;15%排除｜至少兩訊號共振才入榜。
        {data.skippedFilters?.length > 0 && (
          <span style={{ color: '#f59e0b' }}>　⚠ 本輪跳過濾網：{data.skippedFilters.join('、')}</span>
        )}
      </div>

      {data.items.length === 0 ? (
        <div style={{ padding: 24, color: 'var(--text-muted)', textAlign: 'center' }}>
          今日無符合條件的候選（過濾嚴格是設計，空榜是正常結果）
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {data.items.map((it, i) => (
            <div key={it.code} style={{
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              padding: '8px 10px', borderRadius: 8, background: 'var(--bg-secondary, rgba(30,41,59,0.5))',
              borderLeft: `3px solid ${i < 3 ? '#f87171' : 'rgba(148,163,184,0.35)'}`,
            }}>
              <button
                onClick={() => navigateTo('stock', it.code)}
                title={`開啟 ${it.code} 個股分析`}
                style={{
                  fontFamily: 'monospace', fontWeight: 700, fontSize: 'calc(14px * var(--fz))',
                  color: '#60a5fa', background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                }}
              >
                {it.code} {it.name} ↗
              </button>
              <span style={{ fontWeight: 700, color: it.chg < 0 ? 'var(--color-down, #22c55e)' : 'var(--color-up, #ef4444)' }}>
                {it.price}（{it.chg > 0 ? '+' : ''}{it.chg}%）
              </span>
              <span style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>
                分數 {it.score} · 券資比 {it.shortRatio ?? '—'}%
                {it.dayTradeShort === true ? ' · 可先賣當沖' : it.dayTradeShort === null ? ' · 當沖資格未知' : ''}
              </span>
              <span style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-secondary, #cbd5e1)', flexBasis: '100%' }}>
                {it.reasons.join('｜')}
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.6 }}>
        ⚠ 空單虧損不對稱（理論無上限）——本榜已先排除軋空候選與高券資比標的，但仍須自設停損。
        第一期為展示排序（未經 OOT/安慰劑驗證），分數僅供排列、不代表勝率；累積樣本後將依站規驗證。
        融券尚須留意券源與強制回補公告。僅供研究參考，非投資建議。
      </div>
    </div>
  );
}
