'use client';

import { useEffect, useState } from 'react';
import { useAppStore } from '@/lib/store';

// ── 🏦 第四法人：ETF 被動買賣盤影響 ──────────────────────────────
// 市值型 ETF(0050/006208) 追蹤市值前50 → 成分/權重、邊緣候選股、
// 季度調整行事曆、ETF 溢價申購熱潮。高股息型成分無法由市值推導(不硬編)。

interface Constituent { rank: number; code: string; name: string; mktCapYi: number; weight: number }
interface Edge { rank: number; code: string; name: string; mktCapYi: number; side: string }
interface PremIt { code: string; name: string; premium: number; nav: number; price: number }
interface Review { effIso: string; days: number; month: number; isReviewMonth: boolean }
interface FullData {
  date: string; marketOpen: boolean; review: Review | null; note: string;
  bigcapEtfs: { code: string; name: string; aum: string }[]; hidivEtfs: { code: string; name: string }[];
  constituents: Constituent[]; edge: Edge[]; premiumHot: PremIt[]; discountCold: PremIt[];
}

const fmtYi = (n: number) => n >= 10000 ? `${(n / 10000).toFixed(1)}兆` : `${n.toLocaleString()}億`;

// ── 個股模式：該股的第四法人身分 ──
function StockEtf({ code }: { code: string }) {
  const [d, setD] = useState<{ info: { mktRank: number; mktCapYi: number; weight: number | null; bigEtf: boolean; edge?: string } | null; review: Review | null } | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/ai/etf-influence?code=${code}`).then(r => (r.ok ? r.json() : null)).then(x => { if (live) setD(x); }).catch(() => {});
    return () => { live = false; };
  }, [code]);
  const info = d?.info;
  if (!info) return null;
  return (
    <div style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
      <div style={{ fontWeight: 900, fontSize: 'calc(0.95rem * var(--fz))', marginBottom: 6 }}>🏦 第四法人（ETF 被動盤）</div>
      <div style={{ fontSize: 'calc(13px * var(--fz))', lineHeight: 1.8, color: 'var(--text-secondary)' }}>
        市值排名 <b style={{ color: '#7dd3fc' }}>#{info.mktRank}</b>（{fmtYi(info.mktCapYi)}）
        {info.bigEtf && info.weight != null && (
          <> · 屬 <b style={{ color: '#f03e3e' }}>0050／006208 成分</b>，市值權重約 <b style={{ color: '#f03e3e' }}>{info.weight}%</b> → ETF 資金流入的被動買盤受益股</>
        )}
        {info.edge && (
          <div style={{ marginTop: 4, color: '#f59f00', fontWeight: 700 }}>
            ⚠️ {info.edge}：接近 0050 市值前50門檻，季度調整（{d?.review?.effIso ?? '3/6/9/12月'}）可能被動{info.edge.includes('納入') ? '納入 → 常見公布後隔日強漲' : '剔除 → 常見出清賣壓'}
          </div>
        )}
      </div>
      <div style={{ marginTop: 6, fontSize: 'calc(10.5px * var(--fz))', color: 'var(--text-muted)' }}>市值權重為近似(未做自由流通調整)，實際以發行商公告為準。非投資建議。</div>
    </div>
  );
}


// ── slot 佔位（2026-08-05）─────────────────────────────────────
// 市場總覽把本卡與另外兩張並排成欄。若這裡 return null，grid 會把後面的欄
// 往前遞補——版面位置每天都不一樣，使用者就記不住「我要的在第幾欄」。
// slot=true 時改為輸出同尺寸的佔位卡：**空的是內容，不是版面**。
const slotBox = (title: string, why: string) => (
  <div style={{ marginBottom: 14, padding: '12px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px dashed rgba(148,163,184,0.28)' }}>
    <div style={{ fontWeight: 900, fontSize: 'calc(1rem * var(--fz))', marginBottom: 4 }}>{title}</div>
    <div style={{ fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.7 }}>{why}</div>
  </div>
);

export default function EtfInfluence({ code, compact = false, slot = false }: { code?: string; compact?: boolean; slot?: boolean }) {
  const navigateTo = useAppStore(s => s.navigateTo);
  const [d, setD] = useState<FullData | null>(null);
  const [tab, setTab] = useState<'constituents' | 'edge' | 'premium'>('edge');
  const [loaded, setLoaded] = useState(false);   // 分辨「還在抓」與「今天真的沒有」

  useEffect(() => {
    if (code) return;
    let live = true;
    fetch('/api/ai/etf-influence').then(r => (r.ok ? r.json() : null)).then(x => { if (live && x) setD(x); }).catch(() => {}).finally(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [code]);

  if (code) return <StockEtf code={code} />;
  if (!d?.constituents?.length) return slot ? slotBox('🏦 第四法人（ETF）', loaded ? '市值型 ETF 被動買賣盤與成分股權重——尚未取得資料。' : '市值型 ETF 被動買賣盤 · 載入中…') : null;

  const jump = (c: string) => navigateTo('stock', c);
  const chip = (label: string, key: typeof tab) => (
    <span onClick={() => setTab(key)} style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, padding: '3px 12px', borderRadius: 20, cursor: 'pointer', color: tab === key ? '#fff' : 'var(--text-secondary)', background: tab === key ? '#3d8ef8' : 'rgba(148,163,184,0.1)' }}>{label}</span>
  );

  return (
    <div style={{ marginBottom: 14, padding: '12px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontWeight: 900, fontSize: 'calc(1rem * var(--fz))' }}>🏦 第四法人（ETF）</span>
        <span style={{ fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)' }}>市值型 ETF 被動買賣盤 · 資料日 {d.date}</span>
      </div>

      {/* 季度調整行事曆 */}
      {d.review && (
        <div style={{ padding: '8px 12px', borderRadius: 8, background: d.review.isReviewMonth ? 'rgba(245,159,0,0.12)' : 'rgba(61,142,248,0.08)', marginBottom: 10, fontSize: 'calc(13px * var(--fz))' }}>
          🗓 下次季度成分調整（0050/006208）：<b>{d.review.effIso}</b>（約 {d.review.days} 天後，預估生效日）
          {d.review.isReviewMonth && <b style={{ color: '#f59f00' }}> · 本月為調整月，留意邊緣股異動</b>}
          <div style={{ fontSize: 'calc(10.5px * var(--fz))', color: 'var(--text-muted)', marginTop: 2 }}>確切公布/生效日與成分異動以 FTSE 及發行商官方公告為準。</div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        {chip('🎯 邊緣候選股', 'edge')}
        {chip('📊 市值權重榜', 'constituents')}
        {chip('💠 溢價申購熱潮', 'premium')}
      </div>

      {tab === 'edge' && (
        <div style={{ fontSize: 'calc(12.5px * var(--fz))', lineHeight: 1.9 }}>
          <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>接近 0050 市值前50門檻，季度調整可能被動納入(強漲)/剔除(賣壓)：</div>
          <div style={{ display: 'grid', gap: 3 }}>
            {d.edge.map(e => (
              <div key={e.code} onClick={() => jump(e.code)} style={{ cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <b style={{ minWidth: 34, color: e.rank <= 50 ? '#f03e3e' : '#f59f00' }}>#{e.rank}</b>
                <b style={{ color: '#7dd3fc', minWidth: 96 }}>{e.code} {e.name}</b>
                <span style={{ color: 'var(--text-muted)' }}>{fmtYi(e.mktCapYi)}</span>
                <span style={{ color: e.rank <= 50 ? '#f03e3e' : '#f59f00', fontSize: 'calc(11.5px * var(--fz))' }}>{e.side}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'constituents' && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 'calc(12.5px * var(--fz))', lineHeight: 1.9 }}>
          {d.constituents.slice(0, compact ? 15 : 50).map(c => (
            <span key={c.code} onClick={() => jump(c.code)} style={{ cursor: 'pointer' }}>
              <span style={{ color: 'var(--text-muted)' }}>#{c.rank}</span> <b style={{ color: '#7dd3fc' }}>{c.code} {c.name}</b>
              <span style={{ color: '#f03e3e', marginLeft: 3 }}>{c.weight}%</span>
            </span>
          ))}
        </div>
      )}

      {tab === 'premium' && (
        <div style={{ fontSize: 'calc(12.5px * var(--fz))', lineHeight: 1.9 }}>
          <div style={{ color: '#f03e3e', fontWeight: 700 }}>溢價 &gt;1%（申購熱潮，資金流入其成份股）</div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
            {d.premiumHot.length ? d.premiumHot.map(x => (
              <span key={x.code} onClick={() => jump(x.code)} style={{ cursor: 'pointer' }}><b style={{ color: '#7dd3fc' }}>{x.code} {x.name}</b> <span style={{ color: '#f03e3e' }}>+{x.premium}%</span></span>
            )) : <span style={{ color: 'var(--text-muted)' }}>今日無明顯溢價</span>}
          </div>
          <div style={{ color: '#2f9e44', fontWeight: 700 }}>折價 &lt;-1%（贖回/賣壓）</div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {d.discountCold.length ? d.discountCold.map(x => (
              <span key={x.code} onClick={() => jump(x.code)} style={{ cursor: 'pointer' }}><b style={{ color: '#7dd3fc' }}>{x.code} {x.name}</b> <span style={{ color: '#2f9e44' }}>{x.premium}%</span></span>
            )) : <span style={{ color: 'var(--text-muted)' }}>今日無明顯折價</span>}
          </div>
        </div>
      )}

      <div style={{ marginTop: 8, fontSize: 'calc(10.5px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.6 }}>{d.note}</div>
    </div>
  );
}
