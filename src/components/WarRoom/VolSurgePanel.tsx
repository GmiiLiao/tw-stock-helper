'use client';

// ── 盤中戰情「⚡ 盤中爆量」分頁 ──────────────────────────────────────
// 量能異常榜，明確正名：非三大法人。即時 feed 只有累計成交量、無交易人身分，
// 此為單位時間量能暴增（上市≥500張級、上櫃依比例），官方三大法人 15:00 後才公布。

import { useEffect, useState } from 'react';
import StockTrendChart from '@/components/WatchlistTracker/StockTrendChart';
import { usePickControls, applyPick, PickBar, PickMore } from '@/components/shared/PickControls';
import AddCandidateButton from '@/components/Candidates/AddCandidateButton';
import OnlyCandidatesToggle from '@/components/Candidates/OnlyCandidatesToggle';
import { useAppStore } from '@/lib/store';
import HitRate from '@/components/shared/HitRate';

interface Surge {
  code: string; name: string; market: string; price: number; chg: number;
  surgeLots: number; volX: number | null; rateX: number; dir: 'up' | 'down';
}
interface VsData { found: boolean; updatedAt: number; date: string; mode: string; items: Surge[] }

function isTwTradingHours(): boolean {
  const tw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const d = tw.getDay(); const v = tw.getHours() * 60 + tw.getMinutes();
  return d >= 1 && d <= 5 && v >= 9 * 60 && v < 13 * 60 + 35;
}

export default function VolSurgePanel() {
  const [data, setData] = useState<VsData | null>(null);
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [ctl, setCtl] = usePickControls();
  const [onlyCand, setOnlyCand] = useState(false);
  const candSet = new Set(useAppStore(st => st.compareCodes));

  useEffect(() => {
    let live = true;
    const load = () => fetch('/api/ai/vol-surge').then(r => (r.ok ? r.json() : null)).then(x => { if (live && x) setData(x); }).catch(() => {});
    load();
    const t = setInterval(load, isTwTradingHours() ? 30000 : 120000);
    return () => { live = false; clearInterval(t); };
  }, []);

  const mBadge = (m: string) => m === 'otc' ? { t: '櫃', c: '#f59e0b' } : { t: '市', c: '#3d8ef8' };
  const { rows, filteredTotal } = applyPick((onlyCand ? (data?.items || []).filter(x => candSet.has(x.code)) : (data?.items || [])), ctl, {
    price: p => p.price, chg: p => p.chg, vol: p => p.surgeLots, foreign: () => 0, score: p => p.surgeLots,
  });

  return (
    <div style={{ flex: '1 1 100%', minWidth: 320, padding: '10px 12px', borderRadius: 12, background: 'rgba(168,139,250,0.05)', border: '1px solid rgba(168,139,250,0.22)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontSize: 14.5, fontWeight: 900, color: '#c4b5fd' }}>⚡ 盤中爆量</span>
        <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
          量能異常·<b style={{ color: '#c4b5fd' }}>非三大法人</b>（官方法人 15:00 後公布）{!isTwTradingHours() ? ' · ⏸ 非盤中(最後結果)' : data?.updatedAt ? ` · ${new Date(data.updatedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}` : ''}
        </span>
      </div>
      {/* 命中率：只追蹤 dir==='up' 的爆量（向上才是進場候選） */}
      <HitRate list="volSurge" label="盤中爆量(向上)" />
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 8, padding: '6px 10px', borderRadius: 8, background: 'rgba(148,163,184,0.06)' }}>
        單位時間量能暴增（上市≥500張級／上櫃依比例）。即時行情只有累計量、看不到單筆與交易人身分——這是<b>量能異常</b>、不是法人買賣；方向僅以當下漲跌描述。大量來源含隔日沖大戶/主力/中實戶。作官方資料校正前的參考。
      </div>

      {!data ? (
        <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '14px 4px' }}>載入盤中爆量…</div>
      ) : !data.found || rows.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '14px 4px' }}>
          {isTwTradingHours() ? '目前無爆量個股（盤中每 30 秒偵測單位時間量能暴增）。' : '非盤中時段——爆量偵測僅在 9:00–13:35 運作。'}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}><OnlyCandidatesToggle on={onlyCand} setOn={setOnlyCand} /></div>
          <PickBar ctl={ctl} setCtl={setCtl} priceOnly />
          <div style={{ display: 'grid', gap: 4 }}>
            {rows.map(p => {
              const b = mBadge(p.market);
              const open = openCode === p.code;
              const dc = p.dir === 'up' ? '#f03e3e' : '#2f9e44';
              return (
                <div key={p.code} style={{ borderRadius: 8, background: open ? 'rgba(61,142,248,0.10)' : 'rgba(148,163,184,0.06)', border: open ? '1px solid rgba(61,142,248,0.35)' : '1px solid transparent', ...(candSet.has(p.code) ? { boxShadow: '0 0 0 1.5px rgba(245,159,0,0.7)' } : {}) }}>
                  <div onClick={() => setOpenCode(c => c === p.code ? null : p.code)}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', fontSize: 13.5, flexWrap: 'wrap', cursor: 'pointer' }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 12 }}>{open ? '▾' : '▸'}</span>
                    <span onClick={e => e.stopPropagation()}><AddCandidateButton code={p.code} variant="icon" /></span>
                    <span style={{ fontSize: 11, fontWeight: 900, padding: '1px 6px', borderRadius: 6, background: `${dc}22`, color: dc }}>{p.dir === 'up' ? '急拉' : '急殺'}</span>
                    <span style={{ fontWeight: 800, minWidth: 42 }}>{p.code}</span>
                    <span style={{ fontWeight: 600, minWidth: 68 }}>{p.name}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 5, background: `${b.c}22`, color: b.c }}>{b.t}</span>
                    <span style={{ color: 'var(--text-secondary)' }}>{p.price}</span>
                    <span style={{ fontWeight: 800, color: dc }}>{p.chg >= 0 ? '+' : ''}{p.chg}%</span>
                    <span style={{ fontSize: 12, fontWeight: 800, color: '#c4b5fd' }}>爆量 +{p.surgeLots.toLocaleString()} 張</span>
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>{p.rateX}x 常態/分{p.volX != null ? ` · 今日量比 ${p.volX}x` : ''}</span>
                  </div>
                  {open && (
                    <div style={{ padding: '4px 10px 10px' }} onClick={e => e.stopPropagation()}>
                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 6 }}>
                        本區間量能暴增 <b style={{ color: '#c4b5fd' }}>{p.surgeLots.toLocaleString()} 張</b>（達常態每分量 {p.rateX} 倍）。⚠ 量能異常非法人，來源可能是大戶/主力/隔日沖。
                      </div>
                      <StockTrendChart code={p.code} name={p.name} closePrice={p.price} changePercent={p.chg} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <PickMore ctl={ctl} setCtl={setCtl} filteredTotal={filteredTotal} />
        </>
      )}
    </div>
  );
}
