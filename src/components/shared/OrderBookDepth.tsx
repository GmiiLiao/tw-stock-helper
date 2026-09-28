'use client';

// ── 五檔委買委賣（盤中即時，僅供當下參考）─────────────────────────
// 資料：/api/twse/depth?code=（daemon 優先集掃描寫 bookDepth/latest，範圍＝
// 自選/持股/瀏覽中——本頁展開個股會自動被記錄進優先集，故候選皆可查）。
// 不歸檔：僅顯示「現在」的掛單。區塊自帶收合（點頭列）；非盤中時段（僅盤中
// 09:00–13:35 提供）整個功能自動關閉——不打 API、不顯示過期掛單，只留一行提示。
// 顏色刻意不用紅/綠（那是漲跌語意）：委買＝藍、委賣＝橙，避免與漲跌顏色混淆。

import { useEffect, useState } from 'react';
import { startLiveLoop, shouldPollThroughClose } from '@/lib/market-clock';

interface DepthRow { bid: [number, number][]; ask: [number, number][] }

function isTwTradingHours(): boolean {
  const tw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const d = tw.getDay(); const v = tw.getHours() * 60 + tw.getMinutes();
  return d >= 1 && d <= 5 && v >= 9 * 60 && v < 13 * 60 + 35;
}

export default function OrderBookDepth({ code, price }: { code: string; price?: number }) {
  // G3-19：原本 tradingNow 只在 render 時算——元件沒重繪就不會跨過 13:35 關閉（收盤後續打），
  // 盤前打開的也不會在 09:00 啟動。改成狀態＋每 30 秒對時（純本地判斷，不打網路；值不變時 React 不重繪）。
  const [tradingNow, setTradingNow] = useState(isTwTradingHours);
  useEffect(() => {
    const t = setInterval(() => setTradingNow(isTwTradingHours()), 30_000);
    return () => clearInterval(t);
  }, []);
  const [collapsed, setCollapsed] = useState(false); // 盤中預設展開，使用者可自行收合
  const [row, setRow] = useState<DepthRow | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [miss, setMiss] = useState(false);

  useEffect(() => {
    // 非盤中直接關閉：不打 API、不顯示過期掛單（掛單可隨時撤改，休市後毫無參考價值）。
    if (!tradingNow) return;
    let live = true;
    setRow(null); setMiss(false);
    const tick = () => fetch(`/api/twse/depth?code=${code}`).then(r => (r.ok ? r.json() : null)).then(x => {
      if (!live) return;
      if (x?.found && x.row) { setRow(x.row); setAt(x.at ?? null); } else setMiss(!x?.row);
    }).catch(() => { if (live) setMiss(true); });
    tick();   // 首次不設閘
    // 之後每拍：休市（含 13:30 後）或背景分頁不打；回前景立即補一次（startLiveLoop）
    const stop = startLiveLoop(() => { if (shouldPollThroughClose()) void tick(); }, () => 5000);
    return () => { live = false; stop(); };
  }, [code, tradingNow]);

  // 非盤中：功能關閉，僅留一行說明（不佔版面、不誤導）
  if (!tradingNow) {
    return (
      <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', padding: '5px 10px', borderRadius: 8, background: 'rgba(148,163,184,0.05)', border: '1px dashed var(--border-primary)' }}>
        📶 五檔委買委賣（非盤中已關閉——僅盤中 09:00–13:35 提供即時參考，休市掛單無意義）
      </div>
    );
  }

  const Header = ({ children }: { children?: React.ReactNode }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: collapsed ? 0 : 6, flexWrap: 'wrap', cursor: 'pointer' }}
      onClick={() => setCollapsed(c => !c)}>
      <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{collapsed ? '▸' : '▾'}</span>
      <span style={{ fontWeight: 900, fontSize: 'calc(12.5px * var(--fz))' }}>📶 五檔委買委賣</span>
      {children}
      <span style={{ marginLeft: 'auto', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{at ? new Date(at).toLocaleTimeString('zh-TW', { hour12: false }) : ''} · 即時參考不歸檔</span>
    </div>
  );

  if (miss && !row) {
    return (
      <div style={{ padding: '7px 10px', borderRadius: 8, background: 'rgba(148,163,184,0.06)', border: '1px solid var(--border-primary)' }}>
        <Header />
        {!collapsed && <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>此檔目前無五檔資料（非常駐優先掃描範圍或資料未到）。</div>}
      </div>
    );
  }
  if (!row) return <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', padding: '4px 0' }}>五檔載入中…</div>;

  const bid = row.bid || [], ask = row.ask || [];
  const bidVol = bid.reduce((s, [, v]) => s + v, 0);
  const askVol = ask.reduce((s, [, v]) => s + v, 0);
  const buyRatio = bidVol + askVol > 0 ? (bidVol / (bidVol + askVol)) * 100 : 50;
  const bestBid = bid[0]?.[0], bestAsk = ask[0]?.[0];
  const spread = bestBid != null && bestAsk != null ? +(bestAsk - bestBid).toFixed(2) : null;
  const maxVol = Math.max(1, ...bid.map(x => x[1]), ...ask.map(x => x[1]));
  const asksDesc = [...ask].reverse(); // 由劣到優，最靠近價格列的是最佳賣價

  const Level = ({ p, v, side }: { p: number; v: number; side: 'bid' | 'ask' }) => {
    const c = side === 'bid' ? '#3d8ef8' : '#f97316';
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'calc(12.5px * var(--fz))', fontFamily: 'JetBrains Mono, monospace' }}>
        {side === 'ask' && <span style={{ width: 38, height: 6, background: `${c}33`, borderRadius: 3, overflow: 'hidden', display: 'inline-block' }}><span style={{ display: 'block', height: '100%', width: `${(v / maxVol) * 100}%`, background: c, marginLeft: 'auto' }} /></span>}
        <span style={{ color: c, fontWeight: side === 'ask' ? 700 : 800, minWidth: 46, textAlign: side === 'bid' ? 'right' : 'left' }}>{side === 'bid' ? p.toFixed(2) : p.toFixed(2)}</span>
        <span style={{ color: 'var(--text-muted)', minWidth: 34 }}>{v.toLocaleString()}張</span>
        {side === 'bid' && <span style={{ width: 38, height: 6, background: `${c}33`, borderRadius: 3, overflow: 'hidden', display: 'inline-block' }}><span style={{ display: 'block', height: '100%', width: `${(v / maxVol) * 100}%`, background: c }} /></span>}
      </div>
    );
  };

  return (
    <div style={{ padding: '7px 10px', borderRadius: 8, background: 'rgba(148,163,184,0.06)', border: '1px solid var(--border-primary)' }}>
      <Header>
        {spread != null && <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>價差 {spread}{price ? `(${(spread / price * 100).toFixed(2)}%)` : ''}</span>}
      </Header>
      {!collapsed && <>
        {/* 委買委賣量比重（藍=委買 橙=委賣，非漲跌色） */}
        <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', marginBottom: 6, background: 'rgba(148,163,184,0.15)' }}>
          <div style={{ width: `${buyRatio}%`, background: '#3d8ef8' }} />
          <div style={{ width: `${100 - buyRatio}%`, background: '#f97316' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginBottom: 8 }}>
          <span>委買 {bidVol.toLocaleString()}張 ({buyRatio.toFixed(0)}%)</span>
          <span>委賣 {askVol.toLocaleString()}張 ({(100 - buyRatio).toFixed(0)}%)</span>
        </div>

        {/* 五檔階梯：賣（劣→優）在上，價格列在中，買（優→劣）在下 */}
        <div style={{ display: 'grid', gap: 2 }}>
          {asksDesc.map(([p, v]) => <Level key={`a${p}`} p={p} v={v} side="ask" />)}
          {price != null && <div style={{ margin: '3px 0', fontSize: 'calc(12.5px * var(--fz))', fontWeight: 900, color: 'var(--text-primary)', borderTop: '1px dashed var(--border-primary)', borderBottom: '1px dashed var(--border-primary)', padding: '3px 0', textAlign: 'center' }}>{price.toFixed(2)}</div>}
          {bid.map(([p, v]) => <Level key={`b${p}`} p={p} v={v} side="bid" />)}
        </div>
        <div style={{ marginTop: 6, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
          委買厚＝下方有撐；委賣壓大＝上方有壓。僅反映當下掛單，可隨時撤改，非成交保證。
        </div>
      </>}
    </div>
  );
}
