'use client';

// ── 盤中戰情「🚀 漲停預測」分頁 ──────────────────────────────────────
// A榜：明日(盤中=今日收盤)漲停預測 Top30——回測實證 Top10 命中 20.5%(基準 7.6 倍)。
// B榜：今日已漲停者的連板持續評估（縮量鎖死連板 > 爆量首板）。
// scoreboard：每日預測自動對答案的真實成績。資料：/api/ai/limitup-forecast。非投資建議。

import { useEffect, useState } from 'react';
import StockTrendChart from '@/components/WatchlistTracker/StockTrendChart';
import { usePickControls, applyPick, PickBar, PickMore } from '@/components/shared/PickControls';
import AddCandidateButton from '@/components/Candidates/AddCandidateButton';
import OnlyCandidatesToggle from '@/components/Candidates/OnlyCandidatesToggle';
import { useAppStore } from '@/lib/store';

interface APick {
  code: string; name: string; market: string; price: number; chg: number;
  score: number; reasons: string[]; newsBonus: boolean; volX: number; luCnt5: number; limitPrice: number;
}
interface BPick {
  code: string; name: string; market: string; price: number; est: number; luCnt5: number;
  volX: number; fShare: number; streak: number; tag: '高' | '中' | '低'; note: string;
}
interface Scoreboard { days: number; hit10Rate: number; hit30Rate: number; contRate: number; last: { date: string; hit10: number; hit30: number; actualLU: number } | null }
interface LuStats {
  windowDays: number;
  kings: { code: string; name: string; n: number; ind: string | null; isKing: boolean }[];
  indRank: { ind: string; n: number }[];
  wind: { ind: string; cnt5: number; prev5: number; trend: '升溫' | '持平' | '降溫'; hot: boolean }[];
}
interface LuRotation {
  current: string | null; streak: number; transDays: number;
  nextLikely: { ind: string; n: number }[];
  heating: { ind: string; cnt5: number; prev5: number }[];
  igniting: { ind: string; n: number }[];
}
interface LuFlowItem { code: string; name: string; time: string; ind: string | null }
interface LuReview {
  date: string; predDate: string; hit10: number; hit30: number; actualLU: number;
  hits: { code: string; name: string }[];
  failed: { code: string; name: string; ind: string | null; chg: number | null; tags: string[] }[];
  missed: { code: string; name: string; ind: string | null; tag: string; prevChg: number | null; lu60: number }[];
  missTally: Record<string, number>;
}
interface LuData {
  found: boolean; updatedAt: number; mode: 'live' | 'close'; dataDate: string; mktLU: number;
  aList: APick[]; bList: BPick[]; stats?: LuStats; rotation?: LuRotation; flow?: LuFlowItem[]; flowDate?: string;
  review?: LuReview | null; scoreboard: Scoreboard | null;
  backtest: { top10: number; top30: number; lift10: number; base: number };
}

const TAG_COLOR: Record<BPick['tag'], string> = { 高: '#f03e3e', 中: '#f59e0b', 低: '#94a3b8' };

function isTwTradingHours(): boolean {
  const tw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const d = tw.getDay(); const v = tw.getHours() * 60 + tw.getMinutes();
  return d >= 1 && d <= 5 && v >= 9 * 60 && v < 13 * 60 + 35;
}

export default function LimitUpPanel() {
  const [data, setData] = useState<LuData | null>(null);
  const [view, setView] = useState<'a' | 'b' | 'stats' | 'review'>('a');
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [ctl, setCtl] = usePickControls();
  const [onlyCand, setOnlyCand] = useState(false);
  const candSet = new Set(useAppStore(st => st.compareCodes));

  useEffect(() => {
    let live = true;
    const load = () => fetch('/api/ai/limitup-forecast').then(r => (r.ok ? r.json() : null)).then(x => { if (live && x) setData(x); }).catch(() => {});
    load();
    const t = setInterval(load, isTwTradingHours() ? 60000 : 300000);
    return () => { live = false; clearInterval(t); };
  }, []);

  if (!data) return <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', padding: '16px 4px' }}>載入漲停預測…</div>;
  if (!data.found) return <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', padding: '16px 4px' }}>漲停預測尚無資料（常駐服務下一週期產生）。</div>;

  const sb = data.scoreboard;
  const mBadge = (m: string) => m === 'otc' ? { t: '櫃', c: '#f59e0b' } : { t: '市', c: '#3d8ef8' };
  const { rows: aRows, filteredTotal } = applyPick((onlyCand ? (data.aList || []).filter(x => candSet.has(x.code)) : (data.aList || [])), ctl, {
    price: p => p.price, chg: p => p.chg, vol: p => p.volX, foreign: () => 0, score: p => p.score,
  });

  return (
    <div style={{ flex: '1 1 100%', minWidth: 0, padding: '10px 12px', borderRadius: 12, background: 'rgba(240,62,62,0.05)', border: '1px solid rgba(240,62,62,0.22)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 900, color: '#fda4af' }}>🚀 漲停預測</span>
        <span style={{ fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)' }}>
          {data.mode === 'live' ? '盤中即時（預測今日收盤漲停）' : `盤後定案（預測下一交易日）· 資料日 ${data.dataDate}`} · 今日市場漲停 {data.mktLU} 家
        </span>
      </div>

      {/* 真實成績 + 回測揭露 */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 'calc(11.5px * var(--fz))', marginBottom: 8, padding: '6px 10px', borderRadius: 8, background: 'rgba(148,163,184,0.07)' }}>
        <span>回測驗證：Top10 命中 <b style={{ color: '#fbbf24' }}>{data.backtest.top10}%</b>（基準 {data.backtest.base}% 的 <b style={{ color: '#fbbf24' }}>{data.backtest.lift10} 倍</b>）</span>
        {sb && sb.days > 0 ? (
          <span>上線後實績（{sb.days} 日）：Top10 <b style={{ color: '#7dd3fc' }}>{sb.hit10Rate}%</b> · Top30 <b style={{ color: '#7dd3fc' }}>{sb.hit30Rate}%</b> · 連板 <b style={{ color: '#7dd3fc' }}>{sb.contRate}%</b>{sb.last && <span style={{ color: 'var(--text-muted)' }}>（昨榜命中 {sb.last.hit10}/10）</span>}</span>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>上線後每日自動對答案，實績累積中</span>
        )}
      </div>

      {/* A/B 榜切換 */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
        {([['a', `🎯 漲停預測榜 ${data.aList?.length ?? 0}`], ['b', `🔒 連板持續榜 ${data.bList?.length ?? 0}`], ['stats', '📊 統計·輪動·順序流'], ['review', '🧾 預測覆盤']] as const).map(([k, label]) => {
          const on = view === k;
          return (
            <button key={k} onClick={() => { setView(k); setCtl(c => ({ ...c, limit: 30 })); }}
              style={{ padding: '5px 12px', borderRadius: 16, fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, cursor: 'pointer',
                border: `1px solid ${on ? 'rgba(253,164,175,0.6)' : 'var(--border-primary)'}`,
                background: on ? 'rgba(253,164,175,0.12)' : 'transparent',
                color: on ? 'var(--text-primary)' : 'var(--text-muted)' }}>
              {label}
            </button>
          );
        })}
      </div>

      {view === 'stats' ? (
        <>
          <div style={{ fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)', marginBottom: 8 }}>
            近 {data.stats?.windowDays ?? 60} 個交易日漲停統計（確定性計算）。回測實證：<b style={{ color: '#fda4af' }}>3月≥6板的「漲停王」隔日再漲停率 2.9 倍</b>、top3 熱門族群 1.9 倍、冷族群僅 0.22 倍——漲停有強烈的個股慣性與族群群聚性，已以 0.3 阻尼納入模型。
          </div>
          {/* 漲停王 */}
          <div style={{ fontWeight: 800, fontSize: 'calc(12.5px * var(--fz))', color: '#fda4af', margin: '4px 0 6px' }}>👑 3個月漲停王（次數 Top20）</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            {(data.stats?.kings || []).map(k => (
              <span key={k.code} onClick={() => setOpenCode(c => c === k.code ? null : k.code)}
                style={{ cursor: 'pointer', padding: '3px 10px', borderRadius: 12, fontSize: 'calc(12px * var(--fz))', fontWeight: 700,
                  background: k.isKing ? 'rgba(240,62,62,0.12)' : 'rgba(148,163,184,0.08)',
                  border: `1px solid ${k.isKing ? 'rgba(240,62,62,0.4)' : 'var(--border-primary)'}`,
                  color: k.isKing ? '#fda4af' : 'var(--text-secondary)' }}>
                {k.code} {k.name} <b>×{k.n}</b>{k.ind ? <span style={{ fontSize: 'calc(10px * var(--fz))', color: 'var(--text-muted)' }}> {k.ind}</span> : null}
              </span>
            ))}
          </div>
          {openCode && (data.stats?.kings || []).some(k => k.code === openCode) && (() => {
            const k = (data.stats?.kings || []).find(x => x.code === openCode)!;
            return <div style={{ marginBottom: 12 }}><StockTrendChart code={k.code} name={k.name} closePrice={0} /></div>;
          })()}
          {/* 族群排行 */}
          <div style={{ fontWeight: 800, fontSize: 'calc(12.5px * var(--fz))', color: '#fda4af', margin: '4px 0 6px' }}>🏭 3個月族群漲停排行</div>
          <div style={{ display: 'grid', gap: 4, marginBottom: 12 }}>
            {(data.stats?.indRank || []).map((r, i) => {
              const max = data.stats?.indRank?.[0]?.n || 1;
              return (
                <div key={r.ind} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'calc(12.5px * var(--fz))' }}>
                  <span style={{ width: 18, fontWeight: 800, color: i < 3 ? '#fda4af' : 'var(--text-muted)' }}>{i + 1}</span>
                  <span style={{ minWidth: 92, fontWeight: 600 }}>{r.ind}</span>
                  <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'rgba(148,163,184,0.10)', overflow: 'hidden' }}>
                    <div style={{ width: `${Math.round(r.n / max * 100)}%`, height: '100%', background: i < 3 ? '#f03e3e' : '#64748b' }} />
                  </div>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, minWidth: 44, textAlign: 'right' }}>{r.n} 板</span>
                </div>
              );
            })}
          </div>
          {/* 風向 */}
          <div style={{ fontWeight: 800, fontSize: 'calc(12.5px * var(--fz))', color: '#fda4af', margin: '4px 0 6px' }}>🌪 族群漲停風向（近5日 vs 前5日）</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            {(data.stats?.wind || []).map(w => {
              const tc = w.trend === '升溫' ? '#f03e3e' : w.trend === '降溫' ? '#2f9e44' : '#94a3b8';
              return (
                <span key={w.ind} style={{ padding: '4px 10px', borderRadius: 10, fontSize: 'calc(12px * var(--fz))', fontWeight: 700,
                  background: `${tc}14`, border: `1px solid ${tc}55`, color: 'var(--text-primary)' }}>
                  {w.hot ? '🔥 ' : ''}{w.ind} <b style={{ color: tc }}>{w.trend === '升溫' ? '↑升溫' : w.trend === '降溫' ? '↓降溫' : '→持平'}</b>
                  <span style={{ color: 'var(--text-muted)', fontSize: 'calc(11px * var(--fz))' }}> 5日{w.cnt5}板(前5日{w.prev5})</span>
                </span>
              );
            })}
          </div>
          {/* 族群輪動轉換 */}
          {data.rotation && (
            <>
              <div style={{ fontWeight: 800, fontSize: 'calc(12.5px * var(--fz))', color: '#fda4af', margin: '4px 0 6px' }}>🔁 族群輪動轉換</div>
              <div style={{ padding: '8px 10px', borderRadius: 8, background: 'rgba(148,163,184,0.06)', fontSize: 'calc(12.5px * var(--fz))', lineHeight: 2, marginBottom: 12 }}>
                <div>目前主流：{data.rotation.current
                  ? <><b style={{ color: '#f03e3e' }}>{data.rotation.current}</b>（已連續 {data.rotation.streak} 日冠軍）</>
                  : <span style={{ color: 'var(--text-muted)' }}>今日無明顯主流（冠軍族群需單日≥3板）</span>}</div>
                {data.rotation.nextLikely.length > 0 && (
                  <div>歷史輪動去向：{data.rotation.current} 退潮後接棒 → {data.rotation.nextLikely.map((x, i) => (
                    <span key={x.ind}>{i > 0 && '、'}<b style={{ color: '#fbbf24' }}>{x.ind}</b><span style={{ color: 'var(--text-muted)', fontSize: 'calc(11px * var(--fz))' }}>({x.n}次)</span></span>
                  ))}<span style={{ color: 'var(--text-muted)', fontSize: 'calc(11px * var(--fz))' }}>（近{data.rotation.transDays}個有主流日的轉換統計·樣本小僅供參考）</span></div>
                )}
                {data.rotation.heating.length > 0 && (
                  <div>升溫中（輪動候選）：{data.rotation.heating.map((h, i) => (
                    <span key={h.ind}>{i > 0 && '、'}<b style={{ color: '#f03e3e' }}>{h.ind}</b><span style={{ color: 'var(--text-muted)', fontSize: 'calc(11px * var(--fz))' }}>(5日{h.cnt5}板←前5日{h.prev5})</span></span>
                  ))}</div>
                )}
                {data.rotation.igniting.length > 0 && (
                  <div>⚡ 此刻發動（30分內鎖停）：{data.rotation.igniting.map((g, i) => (
                    <span key={g.ind}>{i > 0 && '、'}<b style={{ color: '#f03e3e' }}>{g.ind} ×{g.n}</b></span>
                  ))}</div>
                )}
              </div>
            </>
          )}
          {/* 今日漲停順序流 */}
          <div style={{ fontWeight: 800, fontSize: 'calc(12.5px * var(--fz))', color: '#fda4af', margin: '4px 0 6px' }}>⏱ 今日漲停順序流{data.flowDate ? `（${data.flowDate}·首次鎖停時間）` : ''}</div>
          {(data.flow || []).length === 0 ? (
            <div style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>盤中逐分記錄；今日尚無鎖停紀錄（開盤後自動累積，可觀察族群點火順序）。</div>
          ) : (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {(data.flow || []).map(f => (
                <span key={f.code} onClick={() => setOpenCode(c => c === f.code ? null : f.code)}
                  style={{ cursor: 'pointer', padding: '3px 9px', borderRadius: 10, fontSize: 'calc(11.5px * var(--fz))', fontWeight: 700,
                    background: 'rgba(240,62,62,0.08)', border: '1px solid rgba(240,62,62,0.3)' }}>
                  <span style={{ color: '#fbbf24', fontFamily: 'JetBrains Mono, monospace' }}>{f.time}</span> {f.code} {f.name}
                  {f.ind && <span style={{ fontSize: 'calc(10px * var(--fz))', color: 'var(--text-muted)' }}> {f.ind}</span>}
                </span>
              ))}
            </div>
          )}
        </>
      ) : view === 'review' ? (
        <>
          {!data.review ? (
            <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', padding: '10px 4px' }}>
              尚無覆盤資料——第一份預測榜（{data.dataDate}）的答案要等下一個交易日收盤後自動比對產生。之後每天這裡會有：命中清單、預測失敗＋原因、漏網漲停＋原因。
            </div>
          ) : (
            <>
              <div style={{ fontSize: 'calc(12.5px * var(--fz))', marginBottom: 10, padding: '8px 10px', borderRadius: 8, background: 'rgba(148,163,184,0.07)' }}>
                <b>{data.review.date}</b> 覆盤（以 {data.review.predDate} 的預測對答案）：Top10 命中 <b style={{ color: '#fbbf24' }}>{data.review.hit10}/10</b> · Top30 命中 <b style={{ color: '#fbbf24' }}>{data.review.hit30}/30</b> · 當日全市場漲停 {data.review.actualLU} 家
              </div>
              {data.review.hits.length > 0 && (
                <>
                  <div style={{ fontWeight: 800, fontSize: 'calc(12.5px * var(--fz))', color: '#f03e3e', margin: '4px 0 6px' }}>✅ 命中（{data.review.hits.length}）</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                    {data.review.hits.map(h => <span key={h.code} style={{ padding: '3px 9px', borderRadius: 10, fontSize: 'calc(11.5px * var(--fz))', fontWeight: 700, background: 'rgba(240,62,62,0.10)', color: '#fda4af' }}>{h.code} {h.name}</span>)}
                  </div>
                </>
              )}
              <div style={{ fontWeight: 800, fontSize: 'calc(12.5px * var(--fz))', color: '#f59e0b', margin: '4px 0 6px' }}>❌ 預測未漲停（{data.review.failed.length}）＋原因</div>
              <div style={{ display: 'grid', gap: 3, marginBottom: 12 }}>
                {data.review.failed.map(f => (
                  <div key={f.code} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'calc(12px * var(--fz))', padding: '3px 8px', borderRadius: 6, background: 'rgba(148,163,184,0.05)', flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, minWidth: 40 }}>{f.code}</span>
                    <span style={{ minWidth: 64 }}>{f.name}</span>
                    {f.chg != null && <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: f.chg >= 0 ? '#f03e3e' : '#2f9e44', minWidth: 52 }}>{f.chg >= 0 ? '+' : ''}{f.chg}%</span>}
                    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                      {f.tags.map(tg => <span key={tg} style={{ fontSize: 'calc(10.5px * var(--fz))', padding: '1px 6px', borderRadius: 6, background: 'rgba(245,158,11,0.12)', color: '#fbbf24', fontWeight: 700 }}>{tg}</span>)}
                    </span>
                    {f.ind && <span style={{ marginLeft: 'auto', fontSize: 'calc(10.5px * var(--fz))', color: 'var(--text-muted)' }}>{f.ind}</span>}
                  </div>
                ))}
              </div>
              <div style={{ fontWeight: 800, fontSize: 'calc(12.5px * var(--fz))', color: '#7dd3fc', margin: '4px 0 6px' }}>🕳 漏網漲停（未預測到·{data.review.missed.length}）＋原因</div>
              {Object.keys(data.review.missTally || {}).length > 0 && (
                <div style={{ fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)', marginBottom: 6 }}>
                  漏網原因分布：{Object.entries(data.review.missTally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join('、')}（突發消息型＝模型天生抓不到；排名外＝可調 TopN；濾網外＝低量低價股不追）
                </div>
              )}
              <div style={{ display: 'grid', gap: 3 }}>
                {data.review.missed.map(m => (
                  <div key={m.code} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'calc(12px * var(--fz))', padding: '3px 8px', borderRadius: 6, background: 'rgba(148,163,184,0.05)', flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, minWidth: 40 }}>{m.code}</span>
                    <span style={{ minWidth: 64 }}>{m.name}</span>
                    <span style={{ fontSize: 'calc(10.5px * var(--fz))', padding: '1px 6px', borderRadius: 6, background: 'rgba(125,211,252,0.12)', color: '#7dd3fc', fontWeight: 700 }}>{m.tag}</span>
                    {m.prevChg != null && <span style={{ fontSize: 'calc(10.5px * var(--fz))', color: 'var(--text-muted)' }}>前日{m.prevChg >= 0 ? '+' : ''}{m.prevChg}%</span>}
                    {m.lu60 > 0 && <span style={{ fontSize: 'calc(10.5px * var(--fz))', color: 'var(--text-muted)' }}>3月{m.lu60}板</span>}
                    {m.ind && <span style={{ marginLeft: 'auto', fontSize: 'calc(10.5px * var(--fz))', color: 'var(--text-muted)' }}>{m.ind}</span>}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      ) : view === 'a' ? (
        <>
          <div style={{ fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)', marginBottom: 8 }}>
            依回測加權分排序的高潛力觀察名單——歷史上 Top10 每 5 檔約 1 檔隔日真漲停，<b>8 成不會漲停</b>，僅供排序觀察非保證。
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}><OnlyCandidatesToggle on={onlyCand} setOn={setOnlyCand} /></div>
          <PickBar ctl={ctl} setCtl={setCtl} priceOnly />
          {aRows.length === 0 ? (
            <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', padding: '10px 4px' }}>此價格區間無標的。</div>
          ) : (
            <div style={{ display: 'grid', gap: 4 }}>
              {aRows.map((p, i) => {
                const b = mBadge(p.market);
                const open = openCode === p.code;
                const rankNo = ctl.band === 0 ? i + 1 : null;
                return (
                  <div key={p.code} style={{ borderRadius: 8, background: open ? 'rgba(61,142,248,0.10)' : rankNo !== null && rankNo <= 10 ? 'rgba(240,62,62,0.06)' : 'rgba(148,163,184,0.06)', border: open ? '1px solid rgba(61,142,248,0.35)' : rankNo !== null && rankNo <= 10 ? '1px solid rgba(240,62,62,0.25)' : '1px solid transparent', ...(candSet.has(p.code) ? { boxShadow: '0 0 0 1.5px rgba(245,159,0,0.7)' } : {}) }}>
                    <div onClick={() => setOpenCode(c => c === p.code ? null : p.code)}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', fontSize: 'calc(13.5px * var(--fz))', flexWrap: 'wrap', cursor: 'pointer' }}>
                      <span style={{ fontSize: 'calc(11px * var(--fz))', color: 'var(--text-muted)', width: 12 }}>{open ? '▾' : '▸'}</span>
                      <span onClick={e => e.stopPropagation()}><AddCandidateButton code={p.code} variant="icon" /></span>
                      {rankNo && <span style={{ fontSize: 'calc(11px * var(--fz))', fontWeight: 800, color: rankNo <= 10 ? '#fda4af' : 'var(--text-muted)', width: 18 }}>{rankNo}</span>}
                      <span style={{ fontWeight: 800, minWidth: 42 }}>{p.code}</span>
                      <span style={{ fontWeight: 600, minWidth: 68 }}>{p.name}</span>
                      <span style={{ fontSize: 'calc(10px * var(--fz))', fontWeight: 700, padding: '1px 5px', borderRadius: 5, background: `${b.c}22`, color: b.c }}>{b.t}</span>
                      <span style={{ color: 'var(--text-secondary)' }}>{p.price}</span>
                      <span style={{ fontWeight: 800, color: p.chg >= 0 ? '#f03e3e' : '#2f9e44' }}>{p.chg >= 0 ? '+' : ''}{p.chg}%</span>
                      <span style={{ fontSize: 'calc(11.5px * var(--fz))', fontWeight: 800, color: '#fbbf24' }}>模型分 {p.score}</span>
                      {p.newsBonus && <span title="題材看漲加分(前瞻·未回測)" style={{ fontSize: 'calc(10.5px * var(--fz))', color: '#7dd3fc' }}>📰題材</span>}
                      <span style={{ marginLeft: 'auto', fontSize: 'calc(11px * var(--fz))', color: 'var(--text-muted)' }}>漲停價 {p.limitPrice}</span>
                    </div>
                    {open && (
                      <div style={{ padding: '4px 10px 10px' }} onClick={e => e.stopPropagation()}>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 'calc(11.5px * var(--fz))', marginBottom: 6 }}>
                          {p.reasons.map(r => (
                            <span key={r} style={{ padding: '2px 8px', borderRadius: 10, background: 'rgba(240,62,62,0.10)', color: '#fda4af', fontWeight: 700 }}>{r}</span>
                          ))}
                          {p.newsBonus && <span style={{ padding: '2px 8px', borderRadius: 10, background: 'rgba(125,211,252,0.10)', color: '#7dd3fc', fontWeight: 700 }}>題材看漲 +0.5（前瞻·未回測）</span>}
                        </div>
                        <StockTrendChart code={p.code} name={p.name} closePrice={p.price} changePercent={p.chg} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <PickMore ctl={ctl} setCtl={setCtl} filteredTotal={filteredTotal} />
        </>
      ) : (
        <>
          <div style={{ fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)', marginBottom: 8 }}>
            今日已漲停者的隔日連板機率（回測基準約 22%）。口訣：<b style={{ color: '#fda4af' }}>縮量鎖死連板(29%) &gt; 爆量首板(16%)</b>——爆量漲停＝有人在出貨。
          </div>
          {(data.bList || []).length === 0 ? (
            <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', padding: '10px 4px' }}>{data.mode === 'live' ? '目前無鎖漲停個股。' : '今日無收盤漲停個股。'}</div>
          ) : (
            <div style={{ display: 'grid', gap: 4 }}>
              {(data.bList || []).map(p => {
                const b = mBadge(p.market);
                const open = openCode === p.code;
                const tc = TAG_COLOR[p.tag];
                return (
                  <div key={p.code} style={{ borderRadius: 8, background: open ? 'rgba(61,142,248,0.10)' : 'rgba(148,163,184,0.06)', border: open ? '1px solid rgba(61,142,248,0.35)' : '1px solid transparent' }}>
                    <div onClick={() => setOpenCode(c => c === p.code ? null : p.code)}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', fontSize: 'calc(13.5px * var(--fz))', flexWrap: 'wrap', cursor: 'pointer' }}>
                      <span style={{ fontSize: 'calc(11px * var(--fz))', color: 'var(--text-muted)', width: 12 }}>{open ? '▾' : '▸'}</span>
                      <span style={{ fontSize: 'calc(11px * var(--fz))', fontWeight: 900, padding: '1px 7px', borderRadius: 6, background: `${tc}22`, color: tc }}>{p.tag} {p.est}%</span>
                      <span style={{ fontWeight: 800, minWidth: 42 }}>{p.code}</span>
                      <span style={{ fontWeight: 600, minWidth: 68 }}>{p.name}</span>
                      <span style={{ fontSize: 'calc(10px * var(--fz))', fontWeight: 700, padding: '1px 5px', borderRadius: 5, background: `${b.c}22`, color: b.c }}>{b.t}</span>
                      <span style={{ color: 'var(--text-secondary)' }}>{p.price}</span>
                      <span style={{ fontSize: 'calc(11.5px * var(--fz))', fontWeight: 700, color: '#fda4af' }}>{p.note}</span>
                      <span style={{ marginLeft: 'auto', fontSize: 'calc(11px * var(--fz))', color: 'var(--text-muted)' }}>量比{p.volX}x · 外資佔量{p.fShare}%</span>
                    </div>
                    {open && (
                      <div style={{ padding: '4px 10px 10px' }} onClick={e => e.stopPropagation()}>
                        <div style={{ fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-secondary)', marginBottom: 6 }}>
                          連板評估：近5日 {p.luCnt5} 板 · 量比 {p.volX}x{p.volX < 1 ? '(縮量鎖死+)' : p.volX >= 4 ? '(爆量−)' : ''} · 外資佔量 {p.fShare}% · 外資連買 {p.streak} 日 → 估計連板率 <b style={{ color: tc }}>{p.est}%</b>（乘數模型·回測校準）
                        </div>
                        <StockTrendChart code={p.code} name={p.name} closePrice={p.price} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      <div style={{ marginTop: 8, fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.7 }}>
        ⚠ 漲停預測為回測校準的確定性模型（92日·walk-forward 驗證），法人因子為 t-1 EOD；漲停股常鎖死買不到，追高風險極大、處置股禁入；題材加分未回測。每日預測自動存檔對答案。非投資建議。
      </div>
    </div>
  );
}
