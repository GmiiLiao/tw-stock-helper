'use client';

import AddCandidateButton from '@/components/Candidates/AddCandidateButton';
import { useEffect, useState } from 'react';
import { useAppStore } from '@/lib/store';
import { useLiveQuotes } from '@/lib/useLiveQuotes';
import { isLimitUp, getChangeColor } from '@/lib/twse-api';
import { getSession, isForeground, isTwTradingHours, startLiveLoop } from '@/lib/market-clock';
import { prepFetchJson, fetchErrorText } from '@/components/PrepRoom/prepFetch';
import StockTrendChart from '@/components/WatchlistTracker/StockTrendChart';
import CostReference from '@/components/shared/CostReference';

// ── 🎯 影片形態：平底 → 緊鄰連陽 → 漲停跳空（2026-09-06 順序＋形狀版·EXPERIMENTS ⑨）────
// 使用者要的是影片「箭頭那一根」：先平底、再一串小陽線、緊接著漲停＋跳空。daemon 依此順序比對，
// 並用 21 日走勢與影片模板的相似度（Pearson ≥0.8）過濾。倍量／縮量只作標籤（強制倍量實測反而較差）。
// 實測（排除全市場漲停日·去重·t+1 開盤進場·扣成本·n=48）：20 日淨 +7.7%·中位 +3.1%·勝率 56.3%·10 日 +7.2%·
// +30% 命中 17%·5 日最深 −6.7%（安慰劑 +2.2%／48%）。不做評分卡。
// 隔日盤中：用 useLiveQuotes 標「鎖漲停買不到／可買／已破停損線」。非投資建議。

interface Item {
  code: string; name: string; price: number; chg: number; volX: number; star: boolean; heavy: boolean;
  runAdj: number; runGain: number | null; baseFlat: number | null; shape: number | null;
  baseUp: number; eventLow: number; eventHigh: number; open: number;
  queueUp: boolean; punish: boolean; why?: string; branch?: '主線' | '強勢連陽';
}
interface ReviewDay { date: string; n: number; unbuyable: number; n20: number; win20: number | null; avg20: number | null; avg5: number | null; hit30: number | null; stopHit: number }
interface Doc {
  date: string; at: number; source: string; items: Item[]; near?: Item[]; luTotal: number; marketEvent: boolean;
  rule: string; stats: string; reviewHistory?: ReviewDay[]; reviewSummary?: { n: number; win20: number; avg20: number; hit30: number } | null;
}

// 輪詢節奏（2026-10-05 修正：原本間隔在掛載時用三元算死——盤中打開的分頁收盤後仍每 2 分鐘打、盤前打開的整天 10 分鐘）。
// 名單一天只變幾次（13:36 定榜、收盤歸檔後重算）⇒ 只擋背景分頁；09:00–13:45 每 2 分鐘（接住 13:36 定榜）、其餘 10 分鐘，間隔每拍重算。
const GAP_MS_OPEN = 120_000;
const GAP_MS_IDLE = 600_000;
const GAP_FAST_END_MIN = 13 * 60 + 45;
const NO_DOC = '尚無資料';

export default function GapLimitUpPanel() {
  const [data, setData] = useState<Doc | null>(null);
  const [err, setErr] = useState('');
  const [openCode, setOpenCode] = useState<string | null>(null);   // 點名稱就地展開/收合即時走勢（同漲停預測頁）
  const navigateTo = useAppStore(s => s.navigateTo);
  // register:false＝整張榜單只讀價、不把整榜登記成「瀏覽中」搶 daemon 快線名額（mis-quote nv=1）
  const live = useLiveQuotes(data?.items?.map(x => x.code) ?? [], 60, { register: false });

  useEffect(() => {
    let alive = true;
    const load = (signal?: AbortSignal): Promise<void> => prepFetchJson('/api/ai/gap-limit-up', signal)
      .then(j => {
        if (!alive) return;
        if (j && typeof j === 'object' && Array.isArray((j as Partial<Doc>).items)) { setData(j as Doc); setErr(''); }
        else if (j == null) setErr(NO_DOC);   // 文件尚未產生
      })
      .catch(e => { if (alive && !signal?.aborted) setErr(fetchErrorText(e)); throw e; });   // 保留舊資料只標記；丟回去讓 startLiveLoop 退避
    const ac = new AbortController();
    load(ac.signal).catch(() => { /* 已標記 err */ });   // 首次載入不設閘（盤後／休市打開也看得到）
    const stop = startLiveLoop(
      signal => (isForeground() ? load(signal) : undefined),
      () => (isTwTradingHours(GAP_FAST_END_MIN) ? GAP_MS_OPEN : GAP_MS_IDLE),
    );
    return () => { alive = false; ac.abort(); stop(); };
  }, []);

  if (!data) return <div style={{ padding: 20, color: 'var(--text-muted)' }}>{err === NO_DOC ? '跳空漲停尚無資料（常駐服務下一週期產生）。' : err ? `載入失敗：${err}，稍後自動重試。` : '載入中…'}</div>;
  const inMarket = getSession() === 'regular';
  const isEventToday = data.date === new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' })).toISOString().slice(0, 10);

  return (
    <div style={{ padding: '10px 4px' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, padding: '3px 10px', borderRadius: 6, background: 'rgba(245,158,11,0.15)', color: '#fbbf24', border: '1px solid rgba(245,158,11,0.35)' }}>
          🎯 影片形態：平底→連陽→漲停跳空 · 事件日 {data.date}（{data.source}）
        </span>
        <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
          今日漲停 {data.luTotal} 檔 · 符合順序＋形狀 {data.items.length} · 形似但順序不完整 {data.near?.length ?? 0}
          {data.marketEvent && <b style={{ color: '#f87171' }}>　⚠ 全市場事件日（漲停 &gt;60 檔）——此訊號在這種日子失效，不推播</b>}
          {err && err !== NO_DOC && <span style={{ color: '#fbbf24' }}>　⚠ 更新失敗（{err}），顯示上次資料</span>}
        </span>
      </div>
      <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.6 }}>
        {data.rule}。<br />{data.stats}
      </div>
      {data.reviewSummary && (
        <div style={{ fontSize: 'calc(13px * var(--fz))', marginBottom: 10, padding: '6px 10px', borderRadius: 6, background: 'rgba(30,41,59,0.6)' }}>
          📋 樣本外對答案（上線後累積·未扣成本）：{data.reviewSummary.n} 筆完成 20 日 → 勝率 <b style={{ color: data.reviewSummary.win20 >= 50 ? 'var(--color-up)' : 'var(--color-down)' }}>{data.reviewSummary.win20}%</b>
          ·均 {data.reviewSummary.avg20}%·+30% 命中 {data.reviewSummary.hit30}%
          {data.reviewHistory && data.reviewHistory.length > 0 && <span style={{ color: 'var(--text-muted)' }}>　最近：{data.reviewHistory.slice(0, 5).map(d => `${d.date.slice(5)} ${d.n}檔${d.avg5 != null ? ` 5日均${d.avg5}%` : ''}${d.unbuyable ? ` 買不到${d.unbuyable}` : ''}`).join('｜')}</span>}
        </div>
      )}
      {data.reviewSummary && <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', marginBottom: 8 }}><CostReference holdDays={[5, 20]} /></div>}
      {data.items.length === 0 ? (
        <div style={{ padding: 24, color: 'var(--text-muted)', textAlign: 'center' }}>{data.date} 無完整符合「平底→連陽→漲停跳空」的個股（空榜是正常結果；下方「形似但順序不完整」僅供觀察）</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {data.items.map(it => {
            const q = live[it.code];
            const showLive = inMarket && !isEventToday && q && q.price > 0;   // 事件日隔天起才有「買得到／停損」的即時語意
            const locked = showLive ? isLimitUp(q.price, q.change) : false;
            const broke = showLive ? q.low > 0 && q.low < it.eventLow : false;
            return (
              <div key={it.code} data-anchor={it.code} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 10px', borderRadius: 8, background: 'var(--bg-secondary, rgba(30,41,59,0.5))', borderLeft: `3px solid ${it.star ? '#fbbf24' : 'rgba(148,163,184,0.35)'}` }}>
                <button onClick={() => setOpenCode(c => c === it.code ? null : it.code)} title="點擊展開／收合即時走勢"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-primary)', fontWeight: 800, fontSize: 'calc(14px * var(--fz))', padding: 0, fontFamily: 'inherit', textDecoration: 'underline dotted' }}>
                  {it.star ? '★ ' : ''}{it.code} {it.name} {openCode === it.code ? '▴' : '▾'}
                </button>
                <button onClick={() => navigateTo('stock', it.code)} title="開啟個股分析" style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#60a5fa', fontSize: 'calc(12.5px * var(--fz))' }}>↗</button>
                <AddCandidateButton code={it.code} variant="icon" />
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 'calc(13px * var(--fz))' }}>{it.price.toFixed(2)} <span style={{ color: '#ef4444' }}>+{it.chg}%</span></span>
                {it.branch === '強勢連陽' && <span style={{ fontSize: 'calc(12.5px * var(--fz))', padding: '1px 6px', borderRadius: 6, background: 'rgba(249,115,22,0.15)', color: '#f97316', fontWeight: 700 }} title="支線：連陽段漲 15–40%（連陽裡已含漲停）。實測 20 日 +8.3%／勝率 53%，但 5 日均 −0.2%、最深 −9%——進場後常先回檔">強勢連陽</span>}
                <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, color: '#a78bfa' }} title="近 21 日走勢與影片模板（15 天平底→5 天緩升→跳升）的相似度，≥0.8 才入榜">形狀 {it.shape ?? '—'}</span>
                <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }} title="緊鄰事件日的連續小陽線根數與段漲幅（影片：連陽）">連陽 {it.runAdj}{it.runGain != null ? `（+${it.runGain}%）` : ''}</span>
                <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }} title="連陽之前 15 日的高低差（影片：平底盤整）">底平 {it.baseFlat ?? '—'}%</span>
                <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: it.heavy ? '#f97316' : it.star ? '#fbbf24' : 'var(--text-muted)' }} title="事件日成交量 ÷ 前 20 日均量。影片說倍量；本站實測強制倍量反而較差，故只作標籤">量 {it.volX}×{it.heavy ? ' 倍量' : it.star ? ' 縮量' : ''}</span>
                <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: '#f87171', fontWeight: 700 }} title="事件日最低價：跌破必出（真起漲定義即以此為底）">停損 {it.eventLow}</span>
                {it.queueUp && <span style={{ fontSize: 'calc(12.5px * var(--fz))', padding: '1px 6px', borderRadius: 6, background: 'rgba(239,68,68,0.15)', color: '#f87171' }}>買一貼停·明日恐買不到</span>}
                {it.punish && <span style={{ fontSize: 'calc(12.5px * var(--fz))', padding: '1px 6px', borderRadius: 6, background: 'rgba(148,163,184,0.2)', color: 'var(--text-muted)' }}>處置股</span>}
                {showLive && (
                  <span style={{ marginLeft: 'auto', fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, color: broke ? '#f87171' : locked ? '#fbbf24' : '#4ade80' }}>
                    {broke ? `⛔ 已破停損 ${q.price.toFixed(2)}` : locked ? `🔒 鎖漲停 ${q.price.toFixed(2)} 買不到` : <>{`● 可買 ${q.price.toFixed(2)} (`}<span style={{ color: getChangeColor(q.changePercent) }}>{`${q.changePercent > 0 ? '+' : ''}${q.changePercent.toFixed(2)}%`}</span>{')'}</>}
                  </span>
                )}
                {openCode === it.code && (
                  <div style={{ flexBasis: '100%' }}>
                    <StockTrendChart code={it.code} name={it.name} closePrice={it.price} changePercent={it.chg} livePrice={q?.price} volume={q?.volume} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {(data.near?.length ?? 0) > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>形似但順序不完整（{data.near!.length} 檔·不推播·僅供觀察）</summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
            {data.near!.map(it => (
              <div key={it.code} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', padding: '5px 10px', borderRadius: 6, background: 'rgba(30,41,59,0.35)', fontSize: 'calc(12.5px * var(--fz))' }}>
                <button onClick={() => setOpenCode(c => c === it.code ? null : it.code)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-secondary, #cbd5e1)', fontWeight: 700, fontSize: 'calc(12.5px * var(--fz))', textDecoration: 'underline dotted' }}>{it.code} {it.name} {openCode === it.code ? '▴' : '▾'}</button>
                <span style={{ color: '#a78bfa' }}>形狀 {it.shape ?? '—'}</span>
                <span style={{ color: 'var(--text-muted)' }}>連陽 {it.runAdj}</span>
                <span style={{ color: 'var(--text-muted)' }}>量 {it.volX}×</span>
                <span style={{ color: '#f59e0b' }}>落選：{it.why}</span>
                {openCode === it.code && <div style={{ flexBasis: '100%' }}><StockTrendChart code={it.code} name={it.name} closePrice={it.price} changePercent={it.chg} /></div>}
              </div>
            ))}
          </div>
        </details>
      )}
      <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', marginTop: 10 }}>
        順序＋形狀版是影片畫面的忠實量化；「倍量」在台股實測是反效果（強制倍量 20 日 +4.2% vs 不限量 +7.7%），故只標不擋。停損＝事件日最低，跌破無條件出；隔日開盤鎖漲停＝買不到。非投資建議。
      </div>
    </div>
  );
}
