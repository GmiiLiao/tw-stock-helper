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
  industry?: string | null; support?: number; supportPct?: number;
  resist?: number; resistPct?: number; lend?: number | null; lendChgPct?: number | null;
  coverDays?: number | null; newAt?: string; verdictReason?: string; verdictQuote?: string;
}
interface ReviewDay { date: string; boardDate: string; n: number; winRate: number; avgChg: number; mode: string }
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
  const [review, setReview] = useState<{ latestDay?: ReviewDay; history?: ReviewDay[] } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const navigateTo = useAppStore(s => s.navigateTo);

  useEffect(() => {
    let live = true;
    const load = () => fetch('/api/ai/short-candidates')
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (live && j) setData(j); })
      .catch(() => { /* 保留舊資料 */ });
    const loadReview = () => fetch('/api/ai/short-review')
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (live && j) setReview(j); })
      .catch(() => { /* 無 review 不擋榜 */ });
    load(); loadReview();
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

      {review?.latestDay && (
        <div style={{ fontSize: 'calc(12.5px * var(--fz))', marginBottom: 10, padding: '6px 10px', borderRadius: 6,
          background: 'rgba(30,41,59,0.6)', color: 'var(--text-secondary, #cbd5e1)' }}>
          📋 昨日榜回顧（{review.latestDay.boardDate}·{review.latestDay.n} 檔）：
          今日<b style={{ color: review.latestDay.winRate >= 50 ? '#4ade80' : '#f87171' }}>勝率 {review.latestDay.winRate}%</b>
          ·平均 {review.latestDay.avgChg}%（空方勝=跌）
          {(review.history?.length ?? 0) >= 5 && (() => {
            const h = review.history!.slice(0, 20);
            const w = h.reduce((s2, d) => s2 + d.winRate, 0) / h.length;
            return <span>　近 {h.length} 日均勝率 {w.toFixed(1)}%</span>;
          })()}
          <span style={{ color: 'var(--text-muted)' }}>　前瞻累積中·未經 OOT</span>
        </div>
      )}
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
              {it.newAt && <span style={{ fontSize: 'calc(11px * var(--fz))', fontWeight: 700, color: '#fbbf24', border: '1px solid rgba(251,191,36,0.4)', borderRadius: 4, padding: '1px 5px' }}>NEW {it.newAt}</span>}
              {it.industry && <span style={{ fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)' }}>{it.industry}</span>}
              <span style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>
                分數 {it.score} · 券資比 {it.shortRatio ?? '—'}%
                {it.dayTradeShort === true ? ' · 可先賣當沖' : it.dayTradeShort === null ? ' · 當沖資格未知' : ''}
                {it.coverDays != null && <b style={{ color: '#f59e0b' }}> · ⏳回補倒數{it.coverDays}日</b>}
              </span>
              <span style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-secondary, #cbd5e1)', flexBasis: '100%' }}>
                {it.reasons.join('｜')}
                {it.verdictReason && (
                  <button onClick={() => setExpanded(expanded === it.code ? null : it.code)}
                    style={{ marginLeft: 6, background: 'none', border: 'none', color: '#60a5fa', cursor: 'pointer', fontSize: 'inherit', padding: 0 }}>
                    {expanded === it.code ? '收合' : '判別內容 ▾'}
                  </button>
                )}
              </span>
              {it.support != null && (
                <span style={{ fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)', flexBasis: '100%' }}>
                  近月支撐 {it.support}（{it.supportPct}%·參考獲利區）｜MA20 壓力 {it.resist}（{(it.resistPct ?? 0) > 0 ? '+' : ''}{it.resistPct}%·參考停損）
                  {it.lend != null && <span>｜借券餘 {it.lend?.toLocaleString?.() ?? it.lend}{it.lendChgPct != null ? `（日增 ${it.lendChgPct}% 均量）` : ''}</span>}
                </span>
              )}
              {expanded === it.code && it.verdictReason && (
                <div style={{ flexBasis: '100%', fontSize: 'calc(12px * var(--fz))', color: 'var(--text-secondary, #cbd5e1)',
                  background: 'rgba(15,23,42,0.6)', borderRadius: 6, padding: '6px 10px', lineHeight: 1.6 }}>
                  🤖 AI 利空判別：{it.verdictReason}
                  {it.verdictQuote && <div style={{ color: 'var(--text-muted)' }}>「{it.verdictQuote}」</div>}
                </div>
              )}
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
