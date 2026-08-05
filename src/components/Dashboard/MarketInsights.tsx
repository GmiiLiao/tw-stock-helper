'use client';

import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db as fsdb } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';

// ── 第二大腦衍生洞察（常駐 daemon 計算 → Firestore → GET 端點）──
// 產業輪動 / 法人連買 / 回測勝率 / RS選股 / 當沖隔日沖 / 外資期貨 / AI盤後總結

interface SectorLeader { code: string; name: string; changePercent: number }
interface Sector { industry: string; avgChangePct: number; up: number; down: number; flat: number; leaders: SectorLeader[] }
interface Streak { code: string; name: string; days: number; lots: number }
interface Backtest { evaluatedSignals: number; sampleStocks: number; holdingPeriods: Record<string, { signals: number; winRate: number; avgReturnPct: number }>; strategies?: Record<string, { signals: number; winRate: number; avgReturnPct: number }> }
interface MajorHolder { code: string; ratio: number; people: number }
interface DivItem { code: string; name: string; date: string; type: string; cash: string }
interface LendItem { code: string; avail: number }
interface MarketHealth { health: number; mood: string; up: number; down: number; limitUp: number; limitDown: number; upRatio: number; newHigh: number }
interface DivStock { code: string; name: string; yield: number; pe: number; pb: number }
interface MTItem { code: string; name: string }
interface RisingItem { code: string; ratio: number; change: number }
interface RSItem { code: string; name: string; rs: number; ret60: number }
interface TradeItem { code: string; name: string; close: number; changePct: number; amplitude: number; closePos: number }
interface Taifex { date?: string; foreignTxfNetOI: number | null; putCallRatio: number | null }
interface DailyPost { date?: string; post: string; breadth?: { up: number; down: number } }
interface ScanItem { code: string; name: string; close: number; changePct: number; volX?: number }
interface Scanner { newHigh52: ScanItem[]; volBreakout: ScanItem[]; maBull: ScanItem[]; goldenCross: ScanItem[]; gapUp: ScanItem[]; strong: ScanItem[] }
interface GMarket { sym: string; name: string; price: number; changePct: number }
interface GlobalMarkets { markets: GMarket[]; expectation: string }
interface RevItem { code: string; name: string; yoy: number; mom: number }
interface CalEvent { date: string; type: string; code?: string; name?: string; title: string; impact: string }
interface PeerRow { code: string; name: string; changePct: number | null; pe: number | null; revYoY: number; score: number | null }
interface EtfPremRow { code: string; name: string; nav: number; price: number; premium: number }
interface MarginItem { code: string; name: string; shortRatio: number; marginChg: number }

const card: React.CSSProperties = { background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-lg, 12px)', padding: '16px 18px' };
const title: React.CSSProperties = { fontWeight: 700, fontSize: '0.95rem', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 };
const up = 'var(--color-up)';
const down = 'var(--color-down)';
const sign = (v: number) => (v >= 0 ? '+' : '');
const col = (v: number) => (v > 0 ? up : v < 0 ? down : 'var(--color-flat)');

export default function MarketInsights() {
  const [inst, setInst] = useState<{ foreign: Streak[]; trust: Streak[]; latestDate?: string } | null>(null);
  const [bt, setBt] = useState<Backtest | null>(null);
  const [taifex, setTaifex] = useState<Taifex | null>(null);
  const [post, setPost] = useState<DailyPost | null>(null);
  const [gm, setGm] = useState<GlobalMarkets | null>(null);
  const [major, setMajor] = useState<{ date?: string; top: MajorHolder[] } | null>(null);
  const [div, setDiv] = useState<DivItem[]>([]);
  const [lend, setLend] = useState<LendItem[]>([]);
  const [health, setHealth] = useState<MarketHealth | null>(null);
  const [mtf, setMtf] = useState<MTItem[]>([]);
  const [rising, setRising] = useState<RisingItem[]>([]);
  const [note, setNote] = useState<{ date: string; content: string; forecast?: { bullish: { sector: string; reason: string }[]; bearish: { sector: string; reason: string }[]; model: string } | null } | null>(null);
  const [noteOpen, setNoteOpen] = useState(true);
  const [advOpen, setAdvOpen] = useState(false); // 進階指標區塊(月營收/籌碼/回測…)預設收合，降低資訊過載
  const [fcHits, setFcHits] = useState<{ code: string; name: string; industry: string; side: string }[]>([]);
  const user = useAppStore(s => s.user);
  useEffect(() => {
    if (!user?.uid || !fsdb || typeof (fsdb as { type?: unknown }).type === 'undefined') return;
    const unsub = onSnapshot(doc(fsdb, 'users', user.uid, 'data', 'forecastHits'), snap => setFcHits(snap.exists() ? (snap.data().hits || []) : []), () => {});
    return () => unsub();
  }, [user?.uid]);
  const [cal, setCal] = useState<CalEvent[]>([]);
  const [dt, setDt] = useState<{ date: string; high: { code: string; name: string; ratio: number }[] } | null>(null);
  const [adr, setAdr] = useState<{ code: string; name: string; premium: number; implied: number; twPrice: number }[]>([]);
  const [etfPrem, setEtfPrem] = useState<{ premiumTop: EtfPremRow[]; discountTop: EtfPremRow[] } | null>(null);
  const navigateTo = useAppStore(s => s.navigateTo);
  const allStocks = useAppStore(s => s.allStocks);
  const nameOf = (code: string) => allStocks.find(s => s.code === code)?.name || code;

  useEffect(() => {
    let live = true;
    const get = (url: string, set: (d: unknown) => void) => fetch(url).then(r => r.ok ? r.json() : null).then(d => { if (live) set(d); }).catch(() => {});
    const load = () => {
      get('/api/ai/institutional-streaks', (d: any) => d && setInst({ foreign: d.foreign || [], trust: d.trust || [], latestDate: d.latestDate }));
      get('/api/ai/backtest', (d: any) => setBt(d));
      get('/api/ai/taifex', (d: any) => setTaifex(d));
      get('/api/ai/daily-post', (d: any) => setPost(d));
      get('/api/ai/global-markets', (d: any) => setGm(d));
      get('/api/ai/major-holders', (d: any) => { if (d) { setMajor({ date: d.date, top: d.top || [] }); setRising(d.rising || []); } });
      get('/api/ai/dividend-calendar', (d: any) => d && setDiv(d.upcoming || []));
      get('/api/ai/lending', (d: any) => d && setLend(d.top || []));
      get('/api/ai/market-health', (d: any) => setHealth(d));
      get('/api/ai/multi-timeframe', (d: any) => d && setMtf(d.resonant || []));
      get('/api/ai/morning-note', (d: any) => d?.content && setNote({ date: d.date, content: d.content, forecast: d.forecast || null }));
      get('/api/ai/catalyst-calendar', (d: any) => d && setCal(d.events || []));
      get('/api/ai/daytrade-ratio', (d: any) => d && setDt({ date: d.date, high: d.high || [] }));
      get('/api/ai/adr-premium', (d: any) => d?.items && setAdr(d.items));
      get('/api/ai/etf-premium', (d: any) => d && setEtfPrem({ premiumTop: d.premiumTop || [], discountTop: d.discountTop || [] }));
    };
    load();
    const id = setInterval(load, 180000);
    return () => { live = false; clearInterval(id); };
  }, []);

  const hasAny = inst || bt || taifex || post || gm || major || div.length || lend.length || health || mtf.length || rising.length;
  // ── 固定分節（2026-08-03 頁面整理）─────────────────────────────
  // 整理前這裡是 21 張卡以 grid auto-fit 排成一片，其中 17 張「有資料才顯示」——
  // 缺一張，後面整排位置就跳，使用者永遠記不住「往下滑幾下是我要的」。
  // 現在固定成三段（盤前 → 大盤體質 → 參考資料），段落標題永遠在，
  // 段內沒資料就顯示原因而不是整段消失。
  const Section = ({ icon, name, hint }: { icon: string; name: string; hint: string }) => (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '22px 0 10px', flexWrap: 'wrap' }}>
      <span style={{ fontWeight: 900, fontSize: '1rem' }}>{icon} {name}</span>
      <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{hint}</span>
      <div style={{ flex: 1, height: 1, background: 'rgba(148,163,184,0.18)', marginLeft: 4, minWidth: 20 }} />
    </div>
  );
  const rocMMDD = (d: string) => (d && d.length >= 7 ? `${d.slice(3, 5)}/${d.slice(5, 7)}` : d);
  if (!hasAny) return null;

  return (
    <div style={{ marginBottom: 20 }}>
      <Section icon="🌅" name="盤前" hint="開盤前該看的：晨報風向 · 隔夜美股 · ADR 溢價（日韓早盤在本頁最上方）" />
      {/* 盤前晨報（daemon 開盤前 70 分生成，按日期保存於第二大腦） */}
      {note?.content && (
        <div style={{ ...card, marginBottom: 16, borderColor: 'rgba(56,189,248,0.35)' }}>
          <div style={title}>🌅 盤前晨報
            <span style={{ fontWeight: 400, fontSize: '0.7rem', color: 'var(--text-muted)' }}>{note.date} · 開盤前70分上報</span>
            <button onClick={() => setNoteOpen(o => !o)} style={{ marginLeft: 'auto', fontSize: 12, padding: '2px 10px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', cursor: 'pointer' }}>{noteOpen ? '收合' : '展開'}</button>
          </div>

          {/* 今日風向推測 — 大字醒目、收合也顯示 */}
          {note.forecast && (note.forecast.bullish.length > 0 || note.forecast.bearish.length > 0) && (
            <div style={{ margin: '2px 0 10px', padding: '12px 16px', borderRadius: 10, background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>📰 今日風向推測（依國際盤＋新聞，AI 推測非事實）</div>
              {note.forecast.bullish.length > 0 && (
                <div style={{ fontSize: '1.05rem', fontWeight: 900, color: 'var(--color-up)', lineHeight: 1.7 }}>
                  🔴 看漲：{note.forecast.bullish.map(x => x.sector).join('、')}
                  <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>{note.forecast.bullish.map(x => x.reason).join('；')}</span>
                </div>
              )}
              {note.forecast.bearish.length > 0 && (
                <div style={{ fontSize: '1.05rem', fontWeight: 900, color: 'var(--color-down)', lineHeight: 1.7 }}>
                  🟢 看跌：{note.forecast.bearish.map(x => x.sector).join('、')}
                  <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>{note.forecast.bearish.map(x => x.reason).join('；')}</span>
                </div>
              )}
            </div>
          )}

          {/* 我的持股與風向的關聯 — 最高優先醒目提示 */}
          {fcHits.length > 0 && (
            <div style={{ margin: '0 0 10px', padding: '12px 16px', borderRadius: 10, background: fcHits.some(h => h.side === 'bear') ? 'rgba(47,158,68,0.12)' : 'rgba(240,62,62,0.10)', border: `2px solid ${fcHits.some(h => h.side === 'bear') ? 'var(--color-down)' : 'var(--color-up)'}` }}>
              {fcHits.filter(h => h.side === 'bear').length > 0 && (
                <div style={{ fontSize: '1.1rem', fontWeight: 900, color: 'var(--color-down)', lineHeight: 1.7 }}>
                  🚨 你的持股 {fcHits.filter(h => h.side === 'bear').map(h => `${h.code} ${h.name}（${h.industry}）`).join('、')} 屬今日看跌族群 — 開盤請留意
                </div>
              )}
              {fcHits.filter(h => h.side === 'bull').length > 0 && (
                <div style={{ fontSize: '1.05rem', fontWeight: 800, color: 'var(--color-up)', lineHeight: 1.7 }}>
                  ✨ 你的持股 {fcHits.filter(h => h.side === 'bull').map(h => `${h.code} ${h.name}（${h.industry}）`).join('、')} 屬今日看漲族群
                </div>
              )}
            </div>
          )}

          {noteOpen && <div style={{ fontSize: '0.86rem', lineHeight: 1.8, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{note.content.replace(/^#+ /gm, '').replace(/^- /gm, '· ')}</div>}
        </div>
      )}

      {/* 國際盤連動 (隔夜美股/費半/匯率) */}
      {gm && gm.markets.length > 0 && (
        <div style={{ ...card, marginBottom: 16 }}>
          <div style={title}>🌏 國際盤連動
            <span style={{ marginLeft: 'auto', fontSize: '0.78rem', fontWeight: 700, color: gm.expectation.includes('多') ? up : gm.expectation.includes('空') ? down : 'var(--text-muted)' }}>開盤預期：{gm.expectation}</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {gm.markets.map(m => (
              <div key={m.sym} style={{ flex: '1 1 110px', textAlign: 'center', padding: '8px 4px', background: 'var(--bg-tertiary)', borderRadius: 8 }}>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{m.name}</div>
                <div style={{ fontSize: '0.9rem', fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>{m.price.toLocaleString()}</div>
                <div style={{ fontSize: '0.74rem', fontWeight: 700, color: col(m.changePct) }}>{sign(m.changePct)}{m.changePct}%</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* AI 盤後總結貼文 (全寬) */}
      {post?.post && (
        <div style={{ ...card, marginBottom: 16 }}>
          <div style={title}>📝 AI 盤後總結 <span style={{ fontWeight: 400, fontSize: '0.7rem', color: 'var(--text-muted)' }}>{post.date}</span></div>
          <div style={{ fontSize: '0.86rem', lineHeight: 1.7, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{post.post}</div>
        </div>
      )}

      <Section icon="📊" name="大盤體質與行事曆" hint="健康度 · 多時間框架 · 事件日曆 · 風險警示（選股清單已移至「選股 → 📋 訊號榜單」）" />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
        {/* 催化劑事件日曆（未來 35 天） */}
        {cal.length > 0 && (
          <div style={card}>
            <div style={title}>📅 事件日曆 <span style={{ fontWeight: 400, fontSize: '0.7rem', color: 'var(--text-muted)' }}>除權息·股東會·財報·FOMC</span></div>
            <div style={{ maxHeight: 260, overflowY: 'auto' }}>
              {cal.slice(0, 25).map((e, i) => (
                <div key={`${e.date}-${e.type}-${e.code || i}`} onClick={() => e.code && navigateTo('stock', e.code)}
                  style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '5px 0', borderBottom: '1px solid var(--border-primary)', fontSize: 13, cursor: e.code ? 'pointer' : 'default' }}>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12, color: '#7dd3fc', flexShrink: 0 }}>{e.date.slice(5)}</span>
                  <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title}</span>
                  {e.impact === 'H' && <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 700, color: '#f59e0b', flexShrink: 0 }}>高</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ADR 溢價（開盤先行指標） */}
        {adr.length > 0 && (
          <div style={card}>
            <div style={title}>🌉 ADR 溢價 <span style={{ fontWeight: 400, fontSize: '0.7rem', color: 'var(--text-muted)' }}>開盤先行指標</span></div>
            {adr.map(x => (
              <div key={x.code} onClick={() => navigateTo('stock', x.code)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: '0.82rem', padding: '5px 0', cursor: 'pointer' }}>
                <span style={{ color: 'var(--text-secondary)' }}><b style={{ color: '#e2e8f0' }}>{x.code}</b> {x.name}</span>
                <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '0.78rem', color: 'var(--text-muted)' }}>{x.implied} vs {x.twPrice}</span>
                <span style={{ fontWeight: 800, color: x.premium > 0 ? 'var(--color-up)' : 'var(--color-down)', fontFamily: "'JetBrains Mono',monospace" }}>{x.premium > 0 ? '+' : ''}{x.premium}%</span>
              </div>
            ))}
          </div>
        )}

        {/* 當沖出貨警示（比率≥40%） */}
        {dt && dt.high.length > 0 && (
          <div style={card}>
            <div style={title}>🌀 高當沖警示 <span style={{ fontWeight: 400, fontSize: '0.7rem', color: 'var(--text-muted)' }}>比率≥40% 隔日賣壓 · {dt.date}</span></div>
            {dt.high.slice(0, 8).map(x => (
              <div key={x.code} onClick={() => navigateTo('stock', x.code)} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', padding: '4px 0', cursor: 'pointer' }}>
                <span style={{ color: 'var(--text-secondary)' }}><span style={{ color: '#e2e8f0', fontWeight: 700 }}>{x.code}</span> {x.name}</span>
                <span style={{ fontWeight: 700, color: '#f97316', fontFamily: "'JetBrains Mono',monospace" }}>{x.ratio}%</span>
              </div>
            ))}
          </div>
        )}

        {/* ETF 折溢價 */}
        {etfPrem && (etfPrem.premiumTop.length > 0 || etfPrem.discountTop.length > 0) && (
          <div style={card}>
            <div style={title}>💠 ETF 折溢價 <span style={{ fontWeight: 400, fontSize: '0.7rem', color: 'var(--text-muted)' }}>市價 vs 淨值 · 溢價買貴/折價機會</span></div>
            {etfPrem.premiumTop.slice(0, 4).map(x => (
              <div key={x.code} onClick={() => navigateTo('stock', x.code)} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', padding: '3px 0', cursor: 'pointer' }}>
                <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><b style={{ color: '#e2e8f0' }}>{x.code}</b> {x.name}</span>
                <span style={{ fontWeight: 700, color: 'var(--color-up)', fontFamily: "'JetBrains Mono',monospace", whiteSpace: 'nowrap' }}>溢 +{x.premium}%</span>
              </div>
            ))}
            {etfPrem.discountTop.slice(0, 4).map(x => (
              <div key={x.code} onClick={() => navigateTo('stock', x.code)} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', padding: '3px 0', cursor: 'pointer' }}>
                <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><b style={{ color: '#e2e8f0' }}>{x.code}</b> {x.name}</span>
                <span style={{ fontWeight: 700, color: 'var(--color-down)', fontFamily: "'JetBrains Mono',monospace", whiteSpace: 'nowrap' }}>折 {x.premium}%</span>
              </div>
            ))}
          </div>
        )}

        {/* 大盤健康度 */}
        {health && (
          <div style={card}>
            <div style={title}>❤️ 大盤健康度</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 }}>
              <div style={{ fontSize: 34, fontWeight: 900, color: health.health >= 65 ? up : health.health >= 45 ? '#f59e0b' : down, fontFamily: "'JetBrains Mono',monospace" }}>{health.health}</div>
              <div>
                <div style={{ fontWeight: 700, color: health.health >= 65 ? up : health.health >= 45 ? '#f59e0b' : down }}>{health.mood}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>上漲比例 {health.upRatio}%</div>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-muted)' }}>
              <span>漲 <b style={{ color: up }}>{health.up}</b> / 跌 <b style={{ color: down }}>{health.down}</b></span>
              <span>漲停 <b style={{ color: up }}>{health.limitUp}</b> / 跌停 <b style={{ color: down }}>{health.limitDown}</b></span>
              <span>創新高 <b>{health.newHigh}</b></span>
            </div>
          </div>
        )}

        {/* 多時間框架共振 */}
        {mtf.length > 0 && (
          <div style={card}>
            <div style={title}>🔭 多時間框架共振 <span style={{ fontWeight: 400, fontSize: '0.7rem', color: 'var(--text-muted)' }}>日/週/月三線齊揚</span></div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {mtf.slice(0, 16).map(x => (
                <span key={x.code} style={{ fontSize: '0.78rem', padding: '3px 8px', borderRadius: 6, background: 'rgba(34,197,94,0.12)', color: up, whiteSpace: 'nowrap' }}>{x.name}</span>
              ))}
            </div>
          </div>
        )}





      </div>

      {/* 進階指標（月營收/籌碼/回測…）— 預設收合，降低資訊過載 */}
      <div onClick={() => setAdvOpen(o => !o)} style={{ ...card, marginTop: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, padding: '12px 18px' }}>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{advOpen ? '▾' : '▸'}</span>
        <span style={{ fontWeight: 700, fontSize: '0.92rem' }}>📚 進階指標</span>
        <span style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>月營收 · 軋空 · 千張大戶 · 除權息 · 借券 · 外資期貨 · 回測</span>
        <span style={{ marginLeft: 'auto', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{advOpen ? '收合' : '展開'}</span>
      </div>

      {advOpen && (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, marginTop: 16 }}>


        {/* 除權息行事曆 */}
        {div.length > 0 && (
          <div style={card}>
            <div style={title}>📅 除權息行事曆 <span style={{ fontWeight: 400, fontSize: '0.7rem', color: 'var(--text-muted)' }}>近期</span></div>
            {div.slice(0, 8).map(x => (
              <div key={x.code + x.date} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.8rem', padding: '4px 0' }}>
                <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <b style={{ color: 'var(--text-muted)', marginRight: 6 }}>{rocMMDD(x.date)}</b>{x.name}
                </span>
                <span style={{ whiteSpace: 'nowrap', marginLeft: 6 }}>
                  <span style={{ fontSize: '0.7rem', padding: '1px 6px', borderRadius: 6, background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}>{x.type}</span>
                  {x.cash && <b style={{ color: up, marginLeft: 6 }}>{x.cash}元</b>}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* 借券可賣量 */}
        {lend.length > 0 && (
          <div style={card}>
            <div style={title}>📉 借券可賣量 <span style={{ fontWeight: 400, fontSize: '0.7rem', color: 'var(--text-muted)' }}>當日可借券賣出</span></div>
            {lend.slice(0, 8).map(x => (
              <div key={x.code} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.8rem', padding: '4px 0' }}>
                <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.code} {nameOf(x.code)}</span>
                <b style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap', marginLeft: 6 }}>{Math.round(x.avail / 1000).toLocaleString()} 張</b>
              </div>
            ))}
          </div>
        )}

        {/* 集保千張大戶 */}
        {major && major.top.length > 0 && (
          <div style={card}>
            <div style={title}>👑 千張大戶持股 <span style={{ fontWeight: 400, fontSize: '0.7rem', color: 'var(--text-muted)' }}>籌碼集中 · {major.date}</span></div>
            {major.top.slice(0, 6).map(x => (
              <div key={x.code} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.8rem', padding: '4px 0' }}>
                <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.code} {nameOf(x.code)}</span>
                <b style={{ color: '#a78bfa', whiteSpace: 'nowrap', marginLeft: 6 }}>{x.ratio}%</b>
              </div>
            ))}
            {rising.length > 0 && (
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border-primary)' }}>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 4 }}>📈 大戶週增持（籌碼集中升高）</div>
                {rising.slice(0, 4).map(x => (
                  <div key={x.code} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', padding: '2px 0' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>{x.code} {nameOf(x.code)}</span>
                    <span style={{ whiteSpace: 'nowrap' }}><b style={{ color: up }}>+{x.change}%</b> <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>→{x.ratio}%</span></span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 法人連續買超 */}
        {inst && (inst.foreign.length > 0 || inst.trust.length > 0) && (
          <div style={card}>
            <div style={title}>🏦 法人連續買超 <span style={{ fontWeight: 400, fontSize: '0.7rem', color: 'var(--text-muted)' }}>≥3日 · {inst.latestDate}</span></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              {([['外資', inst.foreign], ['投信', inst.trust]] as const).map(([lbl, list]) => (
                <div key={lbl}>
                  <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginBottom: 6 }}>{lbl}</div>
                  {list.slice(0, 6).map(x => (
                    <div key={x.code} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', padding: '3px 0' }}>
                      <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.name}</span>
                      <span style={{ color: up, fontWeight: 700, whiteSpace: 'nowrap', marginLeft: 6 }}>{x.days}日</span>
                    </div>
                  ))}
                  {list.length === 0 && <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>—</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 外資期貨 / 選擇權多空 */}
        {taifex && (taifex.foreignTxfNetOI != null || taifex.putCallRatio != null) && (
          <div style={card}>
            <div style={title}>🌐 外資期貨 / 選擇權 <span style={{ fontWeight: 400, fontSize: '0.7rem', color: 'var(--text-muted)' }}>{taifex.date}</span></div>
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1, textAlign: 'center', padding: '12px 4px', background: 'var(--bg-tertiary)', borderRadius: 8 }}>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>外資期貨淨部位</div>
                <div style={{ fontSize: '1.1rem', fontWeight: 800, color: col(taifex.foreignTxfNetOI ?? 0), fontFamily: "'JetBrains Mono', monospace" }}>
                  {taifex.foreignTxfNetOI != null ? `${sign(taifex.foreignTxfNetOI)}${taifex.foreignTxfNetOI.toLocaleString()}` : '—'}
                </div>
                <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>{(taifex.foreignTxfNetOI ?? 0) >= 0 ? '淨多單(口)' : '淨空單(口)'}</div>
              </div>
              <div style={{ flex: 1, textAlign: 'center', padding: '12px 4px', background: 'var(--bg-tertiary)', borderRadius: 8 }}>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Put/Call 比</div>
                <div style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--text-primary)', fontFamily: "'JetBrains Mono', monospace" }}>{taifex.putCallRatio ?? '—'}</div>
                <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>{(taifex.putCallRatio ?? 0) > 100 ? '偏多' : '偏空'}</div>
              </div>
            </div>
          </div>
        )}

        {/* 策略回測勝率 */}
        {bt && bt.holdingPeriods && (
          <div style={card}>
            <div style={title}>📊 波段訊號回測勝率</div>
            <div style={{ display: 'flex', gap: 10, marginBottom: 8 }}>
              {['5', '10', '20'].map(h => {
                const p = bt.holdingPeriods[h]; if (!p) return null;
                return (
                  <div key={h} style={{ flex: 1, textAlign: 'center', padding: '10px 4px', background: 'var(--bg-tertiary)', borderRadius: 8 }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>持有{h}日</div>
                    <div style={{ fontSize: '1.2rem', fontWeight: 800, color: col(p.winRate - 50), fontFamily: "'JetBrains Mono', monospace" }}>{p.winRate}%</div>
                    <div style={{ fontSize: '0.66rem', color: col(p.avgReturnPct) }}>{sign(p.avgReturnPct)}{p.avgReturnPct}%</div>
                  </div>
                );
              })}
            </div>
            {bt.strategies && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 4 }}>多策略對照（持有10日勝率）</div>
                {([['swing', '波段BUY'], ['breakout', '創新高突破'], ['goldenCross', '黃金交叉']] as const).map(([k, lbl]) => {
                  const p = bt.strategies![k]; if (!p) return null;
                  return (
                    <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', padding: '2px 0' }}>
                      <span style={{ color: 'var(--text-secondary)' }}>{lbl}</span>
                      <span style={{ whiteSpace: 'nowrap' }}><b style={{ color: col(p.winRate - 50) }}>{p.winRate}%</b> <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>({p.signals})</span></span>
                    </div>
                  );
                })}
              </div>
            )}
            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{bt.sampleStocks} 檔回測。歷史數據不代表未來績效。</div>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
