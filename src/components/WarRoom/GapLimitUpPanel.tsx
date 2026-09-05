'use client';

import { useEffect, useState } from 'react';
import { useAppStore } from '@/lib/store';
import { useLiveQuotes } from '@/lib/useLiveQuotes';
import { isLimitUp } from '@/lib/twse-api';
import { getSession, isForeground } from '@/lib/market-clock';

// ── 🎯 縮量跳空漲停（2026-09-05·EXPERIMENTS ⑨）────────────────────────
// 事件日＝漲停 ∧ 今低>昨高 ∧ 當日量<2×前20日均量（★<1×）。daemon 13:36 定榜＋推播。
// 實測（排除全市場漲停日·去重·t+1 開盤進場·扣成本）：20 日淨 +6.89%·中位 +1.46%·勝率 53.6%·
// +30% 命中 28%·5 日最深 −8.8%·22% 隔日開盤鎖漲停買不到。不做評分卡：右尾與均值皆正但回撤深。
// 隔日盤中：用 useLiveQuotes 標「鎖漲停買不到／可買／已破停損線」。非投資建議。

interface Item {
  code: string; name: string; price: number; chg: number; volX: number; star: boolean;
  run: number; baseUp: number; range20: number; eventLow: number; eventHigh: number; open: number;
  queueUp: boolean; punish: boolean;
}
interface ReviewDay { date: string; n: number; unbuyable: number; n20: number; win20: number | null; avg20: number | null; avg5: number | null; hit30: number | null; stopHit: number }
interface Doc {
  date: string; at: number; source: string; items: Item[]; luTotal: number; excludedHighVol: number; marketEvent: boolean;
  rule: string; stats: string; reviewHistory?: ReviewDay[]; reviewSummary?: { n: number; win20: number; avg20: number; hit30: number } | null;
}

export default function GapLimitUpPanel() {
  const [data, setData] = useState<Doc | null>(null);
  const [err, setErr] = useState('');
  const navigateTo = useAppStore(s => s.navigateTo);
  const live = useLiveQuotes(data?.items?.map(x => x.code) ?? []);

  useEffect(() => {
    let alive = true;
    const load = () => fetch('/api/ai/gap-limit-up')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(j => { if (alive && j) { setData(j); setErr(''); } })
      .catch(e => { if (alive) setErr(String(e.message || e)); });   // 保留舊資料，只標記
    load();
    // 榜單一天只變兩次（13:36／15:10），背景分頁不打（CLAUDE.md 前端輪詢 gate）
    const t = setInterval(() => { if (isForeground()) load(); }, getSession() === 'regular' ? 120_000 : 600_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!data) return <div style={{ padding: 20, color: 'var(--text-muted)' }}>{err ? `載入失敗：${err}` : '載入中…'}</div>;
  const inMarket = getSession() === 'regular';
  const isEventToday = data.date === new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' })).toISOString().slice(0, 10);

  return (
    <div style={{ padding: '10px 4px' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, padding: '3px 10px', borderRadius: 6, background: 'rgba(245,158,11,0.15)', color: '#fbbf24', border: '1px solid rgba(245,158,11,0.35)' }}>
          🎯 縮量跳空漲停 · 事件日 {data.date}（{data.source}）
        </span>
        <span style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>
          今日漲停 {data.luTotal} 檔 · 入榜 {data.items.length} · 爆量剔除 {data.excludedHighVol}
          {data.marketEvent && <b style={{ color: '#f87171' }}>　⚠ 全市場事件日（漲停 &gt;60 檔）——此訊號在這種日子失效，不推播</b>}
          {err && <span style={{ color: '#fbbf24' }}>　⚠ 更新失敗（{err}），顯示上次資料</span>}
        </span>
      </div>
      <div style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.6 }}>
        {data.rule}。<br />{data.stats}
      </div>
      {data.reviewSummary && (
        <div style={{ fontSize: 'calc(12.5px * var(--fz))', marginBottom: 10, padding: '6px 10px', borderRadius: 6, background: 'rgba(30,41,59,0.6)' }}>
          📋 樣本外對答案（上線後累積）：{data.reviewSummary.n} 筆完成 20 日 → 勝率 <b style={{ color: data.reviewSummary.win20 >= 50 ? '#4ade80' : '#f87171' }}>{data.reviewSummary.win20}%</b>
          ·均 {data.reviewSummary.avg20}%·+30% 命中 {data.reviewSummary.hit30}%
          {data.reviewHistory && data.reviewHistory.length > 0 && <span style={{ color: 'var(--text-muted)' }}>　最近：{data.reviewHistory.slice(0, 5).map(d => `${d.date.slice(5)} ${d.n}檔${d.avg5 != null ? ` 5日均${d.avg5}%` : ''}${d.unbuyable ? ` 買不到${d.unbuyable}` : ''}`).join('｜')}</span>}
        </div>
      )}
      {data.items.length === 0 ? (
        <div style={{ padding: 24, color: 'var(--text-muted)', textAlign: 'center' }}>{data.date} 無符合條件的個股（空榜是正常結果——多數日子沒有縮量跳空漲停）</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {data.items.map(it => {
            const q = live[it.code];
            const showLive = inMarket && !isEventToday && q && q.price > 0;   // 事件日隔天起才有「買得到／停損」的即時語意
            const locked = showLive ? isLimitUp(q.price, q.change) : false;
            const broke = showLive ? q.low > 0 && q.low < it.eventLow : false;
            return (
              <div key={it.code} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 10px', borderRadius: 8, background: 'var(--bg-secondary, rgba(30,41,59,0.5))', borderLeft: `3px solid ${it.star ? '#fbbf24' : 'rgba(148,163,184,0.35)'}` }}>
                <button onClick={() => navigateTo('stock', it.code)} title={`開啟 ${it.code} 個股分析`}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-primary)', fontWeight: 800, fontSize: 'calc(14px * var(--fz))', padding: 0, fontFamily: 'inherit' }}>
                  {it.star ? '★ ' : ''}{it.code} {it.name}
                </button>
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 'calc(13px * var(--fz))' }}>{it.price.toFixed(2)} <span style={{ color: '#ef4444' }}>+{it.chg}%</span></span>
                <span style={{ fontSize: 'calc(12px * var(--fz))', color: it.volX < 1 ? '#fbbf24' : 'var(--text-muted)' }} title="事件日成交量 ÷ 前 20 日均量；<1× 為縮量鎖死（實測最強）">量 {it.volX}×</span>
                <span style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }} title="事件日前連續收>開天數（加分項，OOT 有效）">連陽 {it.run}</span>
                <span style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }} title="昨收距 20 日最低收；實測已漲一段者反而較佳">底部 +{it.baseUp}%</span>
                <span style={{ fontSize: 'calc(12px * var(--fz))', color: '#f87171', fontWeight: 700 }} title="事件日最低價：跌破必出（真起漲定義即以此為底）">停損 {it.eventLow}</span>
                {it.queueUp && <span style={{ fontSize: 'calc(11.5px * var(--fz))', padding: '1px 6px', borderRadius: 6, background: 'rgba(239,68,68,0.15)', color: '#f87171' }}>買一貼停·明日恐買不到</span>}
                {it.punish && <span style={{ fontSize: 'calc(11.5px * var(--fz))', padding: '1px 6px', borderRadius: 6, background: 'rgba(148,163,184,0.2)', color: 'var(--text-muted)' }}>處置股</span>}
                {showLive && (
                  <span style={{ marginLeft: 'auto', fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, color: broke ? '#f87171' : locked ? '#fbbf24' : '#4ade80' }}>
                    {broke ? `⛔ 已破停損 ${q.price.toFixed(2)}` : locked ? `🔒 鎖漲停 ${q.price.toFixed(2)} 買不到` : `● 可買 ${q.price.toFixed(2)} (${q.changePercent >= 0 ? '+' : ''}${q.changePercent.toFixed(2)}%)`}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div style={{ fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)', marginTop: 10 }}>
        影片「四特徵」在台股的實測：精確條件（含倍量、平底）20 日 −4.2%／勝率 29%；害它輸的是「倍量」——本榜刻意只收縮量。停損＝事件日最低，跌破無條件出。非投資建議。
      </div>
    </div>
  );
}
