'use client';

import { useEffect, useState } from 'react';
import StockTrendChart from '@/components/WatchlistTracker/StockTrendChart';
import { usePickControls, applyPick, PickBar, PickMore } from '@/components/shared/PickControls';

// 台股 tick 與隔日漲跌停價（以今收為明日昨收，deterministic）
const _tick = (p: number) => p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5;
const nextLimitUp = (p: number) => { const t = _tick(p); return +(Math.floor(p * 1.1 / t) * t).toFixed(2); };
const nextLimitDown = (p: number) => { const t = _tick(p); return +(Math.ceil(p * 0.9 / t) * t).toFixed(2); };
const TAIL_AVG_RET = 1.55; // 實測撿尾盤型態隔日平均 +1.55%（作為建議賣出參考）

// ── 今日盤型（開盤即時）：即時性內容，主放於「即時追蹤」頁 ──
// 回答「今天怎麼出」（今日即時加權指數），與「選股策略」的前日盤後選股分離。
// 門檻（使用者拍板）：開高=跳空≥+0.15%、走低=盤中≤−0.2%、開平殺盤=|跳空|<0.15%且盤中≤−1%；
// 近5日盤中翻黑 ≥2天黃燈、≥3天紅燈。
interface MpDay { date: string; gapPct: number; intraPct: number; pattern: string }
interface TailPick { code: string; name: string; market: string; price: number; chg: number; pos: number; volX: number; fStreak?: number; char?: string | null; score?: number | null; winRate?: number; instF?: number; instT?: number; instD?: number; instTot?: number }
interface TailPicks { updatedAt: number; date: string; source: 'live' | 'close'; instDate?: string | null; buyable: TailPick[]; locked: TailPick[]; buyableTotal: number }
interface MpData { date: string; updatedAt: number; env: { level: 'red' | 'yellow' | 'neutral'; fadeCount: number; days: MpDay[] }; live?: { date: string; price: number; gapPct: number; intraPct: number; pattern: string; at: number }; tailPicks?: TailPicks }

export const MP_LABEL: Record<string, { name: string; icon: string; color: string }> = {
  fadeDown:   { name: '開高走低', icon: '🟠', color: '#f59e0b' },
  flatDown:   { name: '開平殺盤', icon: '🔻', color: '#ef4444' },
  downDown:   { name: '開低走低', icon: '⚠️', color: '#2f9e44' },
  reversalUp: { name: '開低走高', icon: '🔄', color: '#f03e3e' },
  upUp:       { name: '開高走高', icon: '🔥', color: '#f03e3e' },
  range:      { name: '平盤震盪', icon: '⚪', color: '#94a3b8' },
};
// 各盤型的出場紀律（開高走低組數字為 2 年 66 次實測）
const MP_OPS: Record<string, { text: string; strong?: boolean }[]> = {
  fadeDown: [
    { text: '① 昨日尾盤進場的隔日沖單 → 開盤 9:00–9:05 一律賣出（此盤型實測勝率 73%／平均 +1.48%）', strong: true },
    { text: '② 絕不抱到收盤：抱到收盤勝率掉到 40%、平均 −0.44%', strong: true },
    { text: '③ 早盤 9:00–10:30 進場的單：11:30 前未走強 → 收盤前先出，不留倉' },
    { text: '④ 持股要減碼的：反彈都在早盤，減碼在早盤執行，別等尾盤' },
  ],
  downDown: [
    { text: '① 開低走低（崩跌型）：隔日沖單開盤立即出，不等反彈', strong: true },
    { text: '② 今日不進場、不接刀；等盤型轉變再說' },
  ],
  flatDown: [
    { text: '① 開平殺盤（盤中殺逾 1%）：隔日沖單未出者立即出，不等反彈', strong: true },
    { text: '② 今日不進場、不接刀；持股減碼動作提前，別等尾盤更弱' },
  ],
  reversalUp: [
    { text: '① 開低走高（盤中反轉）：隔日沖仍以開盤賣為預設，開低直接認賠出' },
    { text: '② 尾盤策略卡條件成立可正常進場' },
  ],
  upUp: [
    { text: '① 開高走高（單邊多頭）：開盤賣出為預設；強勢者第一波衝高後跌破開盤價全出' },
    { text: '② 尾盤策略卡照 SOP 執行，多頭盤勝率最佳' },
  ],
  range: [
    { text: '① 平盤震盪：依各策略卡標準 SOP 執行（開盤 9:00–10:00 出、隔日必出）' },
  ],
};

// 盤中(09:00–13:35)才需每分鐘更新；盤後盤型/撿尾盤為靜態，放慢到 10 分省讀取/下載
function isTwTradingHours(): boolean {
  const tw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const d = tw.getDay(); const v = tw.getHours() * 60 + tw.getMinutes();
  return d >= 1 && d <= 5 && v >= 9 * 60 && v < 13 * 60 + 35;
}
// 共用 hook：抓 marketPattern
function useMarketPattern(): MpData | null {
  const [mp, setMp] = useState<MpData | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => fetch('/api/ai/market-pattern').then(r => (r.ok ? r.json() : null)).then(x => { if (live) setMp(x); }).catch(() => {});
    load();
    const t = setInterval(load, isTwTradingHours() ? 60000 : 600000);
    return () => { live = false; clearInterval(t); };
  }, []);
  return mp;
}

function deriveState(mp: MpData) {
  const taipeiNow = new Date(Date.now() + 8 * 3600e3);
  const today = taipeiNow.toISOString().slice(0, 10);
  const liveValid = !!(mp.live && mp.live.date === today);
  const closed = taipeiNow.getUTCHours() * 60 + taipeiNow.getUTCMinutes() >= 13 * 60 + 35;
  const env = mp.env;
  const liveWarn = liveValid && (mp.live!.pattern === 'fadeDown' || mp.live!.pattern === 'flatDown');
  const envColor = env.level === 'red' ? '#ef4444' : env.level === 'yellow' ? '#fbbf24' : 'var(--border-primary)';
  const borderColor = liveWarn ? (mp.live!.pattern === 'flatDown' ? '#ef4444' : '#f59e0b') : envColor;
  return { liveValid, closed, env, liveWarn, borderColor };
}

// 撿尾盤推薦股（尾盤買點清單）
function TailPicksSection({ tp }: { tp: TailPicks }) {
  const [collapsed, setCollapsed] = useState<boolean>(false);
  useEffect(() => { const s = localStorage.getItem('tailCollapsed'); if (s !== null) setCollapsed(s === '1'); }, []);
  const toggleCollapse = () => setCollapsed(c => { const n = !c; localStorage.setItem('tailCollapsed', n ? '1' : '0'); return n; });
  const mBadge = (m: string) => m === 'otc' ? { t: '櫃', c: '#f59e0b' } : { t: '市', c: '#3d8ef8' };
  // 台股慣例：買超(正)紅、賣超(負)綠
  const Lots = ({ label, v }: { label: string; v?: number }) => {
    if (v === undefined || v === null) return null;
    const c = v > 0 ? '#f03e3e' : v < 0 ? '#2f9e44' : 'var(--text-muted)';
    return <span style={{ color: c, fontWeight: 700 }}>{label}{v >= 0 ? '+' : ''}{v.toLocaleString()}</span>;
  };
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [ctl, setCtl] = usePickControls();
  const { rows: shownBuyable, filteredTotal } = applyPick(tp.buyable, ctl, {
    price: p => p.price, chg: p => p.chg, vol: p => p.volX,
    foreign: p => p.instF ?? -Infinity, score: p => p.score ?? -Infinity,
  });
  const renderRow = (p: TailPick) => {
    const b = mBadge(p.market);
    const hasInst = p.instF !== undefined || p.instT !== undefined;
    const open = openCode === p.code;
    const limUp = nextLimitUp(p.price), limDn = nextLimitDown(p.price);
    const sellRef = +(p.price * (1 + TAIL_AVG_RET / 100)).toFixed(2);
    return (
      <div key={p.code} style={{ borderRadius: 8, background: open ? 'rgba(61,142,248,0.10)' : 'rgba(148,163,184,0.06)', border: open ? '1px solid rgba(61,142,248,0.35)' : '1px solid transparent' }}>
        <div onClick={() => setOpenCode(c => c === p.code ? null : p.code)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', fontSize: 'calc(13.5px * var(--fz))', flexWrap: 'wrap', cursor: 'pointer' }}>
          <span style={{ fontSize: 'calc(11px * var(--fz))', color: 'var(--text-muted)', width: 12 }}>{open ? '▾' : '▸'}</span>
          <span style={{ fontWeight: 800, minWidth: 42 }}>{p.code}</span>
          <span style={{ fontWeight: 600, minWidth: 68 }}>{p.name}</span>
          <span style={{ fontSize: 'calc(10px * var(--fz))', fontWeight: 700, padding: '1px 5px', borderRadius: 5, background: `${b.c}22`, color: b.c }}>{b.t}</span>
          <span style={{ color: 'var(--text-secondary)' }}>{p.price}</span>
          <span style={{ fontWeight: 800, color: '#f03e3e' }}>+{p.chg}%</span>
          {p.score != null && (
            <span style={{ fontSize: 'calc(11.5px * var(--fz))', fontWeight: 800, color: p.score >= 80 ? '#f03e3e' : p.score >= 60 ? '#fbbf24' : 'var(--text-muted)' }}>評分 {p.score}</span>
          )}
          {p.char === '炒作型' && (
            <span title="籌碼性格：炒作型——定版濾網×炒作型 700日實測雙口徑淨正（開賣+0.29/收賣+0.15），榜單排序已+2優先" style={{ fontSize: 'calc(10.5px * var(--fz))', fontWeight: 800, color: '#f59e0b', border: '1px solid #f59e0b55', borderRadius: 4, padding: '0 4px' }}>炒作</span>
          )}
          {p.winRate != null && (
            <span style={{ fontSize: 'calc(11.5px * var(--fz))', fontWeight: 700, color: '#7dd3fc' }}>勝率 {p.winRate}%</span>
          )}
          {hasInst && (
            <span style={{ display: 'inline-flex', gap: 8, fontSize: 'calc(12px * var(--fz))' }}>
              <Lots label="外資" v={p.instF} />
              <Lots label="投信" v={p.instT} />
              <Lots label="自營" v={p.instD} />
            </span>
          )}
          {(p.fStreak ?? 0) >= 1 && <span style={{ fontSize: 'calc(11px * var(--fz))', fontWeight: 700, color: '#f03e3e', background: 'rgba(240,62,62,0.12)', padding: '1px 5px', borderRadius: 5 }}>外資連{p.fStreak}日</span>}
          <span style={{ marginLeft: 'auto', fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>量比 {p.volX}x · 收最高</span>
        </div>
        {open && (
          <div style={{ padding: '4px 10px 10px' }} onClick={e => e.stopPropagation()}>
            {/* 隔日沖建議賣價＋隔日漲跌停價 */}
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 'calc(12.5px * var(--fz))', marginBottom: 6, padding: '6px 8px', borderRadius: 8, background: 'rgba(245,158,11,0.08)' }}>
              <span>🎯 建議賣出參考 <b style={{ color: '#fbbf24' }}>{sellRef}</b> <span style={{ color: 'var(--text-muted)', fontSize: 'calc(11px * var(--fz))' }}>(回測均值 +{TAIL_AVG_RET}%；實務開盤 9:00–9:05 即賣)</span></span>
              <span>隔日漲停 <b style={{ color: '#f03e3e' }}>{limUp}</b></span>
              <span>隔日跌停 <b style={{ color: '#2f9e44' }}>{limDn}</b></span>
            </div>
            {/* 即時K線（預設即時，可切日/週/月） */}
            <StockTrendChart code={p.code} name={p.name} closePrice={p.price} changePercent={p.chg} />
          </div>
        )}
      </div>
    );
  };
  return (
    <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, background: 'rgba(61,142,248,0.06)', border: '1px solid rgba(61,142,248,0.25)' }}>
      <div onClick={toggleCollapse} style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: collapsed ? 0 : 6, cursor: 'pointer' }}>
        <span style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>{collapsed ? '▸' : '▾'}</span>
        <span style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 900, color: '#7dd3fc' }}>🪣 撿尾盤推薦股</span>
        <span style={{ fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)' }}>
          {collapsed
            ? <>共 {tp.buyableTotal} 檔 · 外資買超優先 · {tp.source === 'live' ? '尾盤即時' : '今日收盤'}</>
            : <>
                <span className="mobile-hide">收最高＋破5日高＋漲≥1%（型態實測 55%／+1.55%／PF2.02）· 外資買超優先排序 · {tp.source === 'live' ? '尾盤即時' : '今日收盤'} · 共 {tp.buyableTotal} 檔{tp.instDate && <span> · 三大法人張數為 {tp.instDate} 累計</span>}<span> · 評分=AI綜合分、勝率=依外資連買天數估(89日PIT-safe回測) · 點列展開即時K線</span></span>
                <span className="mobile-only">收最高＋破5日高＋漲≥1% · {tp.source === 'live' ? '尾盤即時' : '今日收盤'} · 共 {tp.buyableTotal} 檔 · 點列展開K線</span>
              </>}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 'calc(11.5px * var(--fz))', color: '#7dd3fc', fontWeight: 700 }}>{collapsed ? '展開 ▾' : '收合 ▸'}</span>
      </div>
      {!collapsed && <>
      {/* 畫面變動規則：三階段時間軸，高亮目前階段 */}
      {(() => {
        const tw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
        const v = tw.getHours() * 60 + tw.getMinutes();
        const isWeekday = tw.getDay() >= 1 && tw.getDay() <= 5;
        const cur = !isWeekday ? 2 : v < 12 * 60 + 45 ? 0 : v < 13 * 60 + 35 ? 1 : 2;
        const phases = [
          { t: '開盤～12:45', d: '顯示昨日定案清單（盤中選股請至 ⚡盤中戰情）' },
          { t: '12:45～13:35', d: '尾盤即時・每60秒更新（13:00–13:25 進場窗口）' },
          { t: '收盤後', d: '今日定案清單（15:00後含當日三大法人）' },
        ];
        return (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {phases.map((p, i) => (
              <div key={i} style={{
                flex: '1 1 180px', padding: '5px 9px', borderRadius: 8, fontSize: 'calc(11.5px * var(--fz))', lineHeight: 1.5,
                background: cur === i ? 'rgba(125,211,252,0.12)' : 'rgba(148,163,184,0.05)',
                border: `1px solid ${cur === i ? 'rgba(125,211,252,0.45)' : 'transparent'}`,
                color: cur === i ? 'var(--text-primary)' : 'var(--text-muted)',
              }}>
                <b style={{ color: cur === i ? '#7dd3fc' : 'var(--text-muted)' }}>{cur === i ? '▶ ' : ''}{p.t}</b>　{p.d}
              </div>
            ))}
          </div>
        );
      })()}
      {tp.buyable.length > 0 ? (
        <>
          <PickBar ctl={ctl} setCtl={setCtl} />
          {shownBuyable.length > 0 ? (
            <>
              <div style={{ display: 'grid', gap: 4 }}>
                {shownBuyable.map(renderRow)}
              </div>
              <PickMore ctl={ctl} setCtl={setCtl} filteredTotal={filteredTotal} />
            </>
          ) : (
            <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)' }}>此價格區間內無符合標的，換個區間看看。</div>
          )}
        </>
      ) : (
        <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)' }}>今日無符合條件、尾盤買得到的標的。</div>
      )}
      {tp.locked.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 'calc(12px * var(--fz))', fontWeight: 700, color: '#f59e0b', marginBottom: 4 }}>🔒 已鎖漲停（買不到，改用「漲停鎖死」策略排隊）</div>
          <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-secondary)', lineHeight: 1.8 }}>
            {tp.locked.map(p => `${p.code} ${p.name}`).join('、')}
          </div>
        </div>
      )}
      <div style={{ marginTop: 6, fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)' }}>
        ⚠ 尾盤 13:00–13:25 掛單買進、隔日 9:00–10:00 出場；單筆風險≤1%。非投資建議。
      </div>
      </>}
    </div>
  );
}

// 完整橫幅（即時追蹤頁）
export function MarketPatternBanner() {
  const mp = useMarketPattern();
  // 盤型紀律可收合，讓下方撿尾盤推薦股往上；記住上次選擇
  const [collapsed, setCollapsed] = useState<boolean>(true);
  useEffect(() => {
    const s = localStorage.getItem('mpCollapsed');
    if (s !== null) setCollapsed(s === '1');
  }, []);
  const toggle = () => setCollapsed(c => { const n = !c; localStorage.setItem('mpCollapsed', n ? '1' : '0'); return n; });

  if (!mp?.env) return null;
  const { liveValid, closed, env, liveWarn, borderColor } = deriveState(mp);
  const pat = liveValid ? MP_LABEL[mp.live!.pattern] : null;
  const opsKey = liveValid ? mp.live!.pattern : (env.level !== 'neutral' ? 'fadeDown' : 'range');
  const envText = env.level === 'red' ? '🔴 震盪盤紅燈' : env.level === 'yellow' ? '🟡 震盪盤黃燈' : '🟢 環境正常';

  return (
    <div style={{ marginBottom: 12, padding: '14px 16px', borderRadius: 12, border: `2px solid ${borderColor}`, background: 'var(--bg-elevated)', boxShadow: env.level !== 'neutral' || liveWarn ? `0 0 14px ${borderColor}44` : 'none' }}>
      {/* 標題列（可點擊收合/展開盤型紀律） */}
      <div onClick={toggle} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', cursor: 'pointer' }}>
        <span style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>{collapsed ? '▸' : '▾'}</span>
        <span style={{ fontSize: 'calc(1.1rem * var(--fz))', fontWeight: 900 }}>⏱️ 今日盤型</span>
        {pat ? (
          <span style={{ fontSize: 'calc(1.15rem * var(--fz))', fontWeight: 900, color: pat.color }}>{pat.icon} {pat.name}</span>
        ) : (
          <span style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', fontWeight: 600 }}>開盤後 09:00 起顯示即時判讀</span>
        )}
        {/* 收合時把環境燈號摘要併到標題列 */}
        {collapsed && <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, color: env.level === 'red' ? '#ef4444' : env.level === 'yellow' ? '#fbbf24' : 'var(--text-secondary)' }}>{envText}·近5日{env.fadeCount}天翻黑</span>}
        {liveValid && !collapsed && (
          <span style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>
            加權 {mp.live!.price.toFixed(0)} · 跳空 {mp.live!.gapPct >= 0 ? '+' : ''}{mp.live!.gapPct}% · 盤中 {mp.live!.intraPct >= 0 ? '+' : ''}{mp.live!.intraPct}% · {closed ? '今日最終' : '盤中即時'}
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 'calc(11.5px * var(--fz))', color: '#7dd3fc', fontWeight: 700 }}>{collapsed ? '展開紀律 ▾' : '收合 ▸'}</span>
      </div>
      {/* 近5日環境燈號（收合時隱藏） */}
      {!collapsed && <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        <span style={{ fontSize: 'calc(13.5px * var(--fz))', fontWeight: 800, color: env.level === 'red' ? '#ef4444' : env.level === 'yellow' ? '#fbbf24' : 'var(--text-secondary)' }}>
          {env.level === 'red' ? '🔴 震盪盤紅燈' : env.level === 'yellow' ? '🟡 震盪盤黃燈' : '🟢 環境正常'}：近 5 日 {env.fadeCount} 天盤中翻黑（開高走低／開平殺盤）
        </span>
        <span style={{ display: 'flex', gap: 4 }}>
          {env.days.map(dy => {
            const warn = dy.pattern === 'fadeDown' || dy.pattern === 'flatDown';
            return (
              <span key={dy.date} title={`${dy.date} 跳空${dy.gapPct}% 盤中${dy.intraPct}%`}
                style={{ fontSize: 'calc(11px * var(--fz))', padding: '2px 6px', borderRadius: 6, fontWeight: 700, background: warn ? 'rgba(245,158,11,0.18)' : 'rgba(148,163,184,0.10)', color: warn ? '#f59e0b' : 'var(--text-muted)', border: `1px solid ${warn ? 'rgba(245,158,11,0.5)' : 'transparent'}` }}>
                {dy.date.slice(5)} {MP_LABEL[dy.pattern]?.icon ?? '⚪'}
              </span>
            );
          })}
        </span>
      </div>
      {/* 操作說明：明顯配色＋加大字體 */}
      <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, background: 'rgba(245,158,11,0.06)' }}>
        <div style={{ fontSize: 'calc(13px * var(--fz))', fontWeight: 800, color: '#7dd3fc', marginBottom: 4 }}>📖 今日出場紀律（隔日沖）</div>
        {(MP_OPS[opsKey] ?? MP_OPS.range).map((op, i) => (
          <div key={i} style={{ fontSize: op.strong ? 15.5 : 14, fontWeight: op.strong ? 800 : 600, lineHeight: 1.9, color: op.strong ? '#fbbf24' : 'var(--text-secondary)' }}>
            {op.text}
          </div>
        ))}
      </div>
      </>}
      {/* 撿尾盤推薦股（收合與否都顯示） */}
      {mp.tailPicks && <TailPicksSection tp={mp.tailPicks} />}
    </div>
  );
}

// 精簡一行提示（選股策略頁，導向即時追蹤）
export function MarketPatternHint({ onNavigate }: { onNavigate?: () => void }) {
  const mp = useMarketPattern();
  if (!mp?.env) return null;
  const { liveValid, env, borderColor } = deriveState(mp);
  const pat = liveValid ? MP_LABEL[mp.live!.pattern] : null;
  const show = env.level !== 'neutral' || (pat && (mp.live!.pattern === 'fadeDown' || mp.live!.pattern === 'flatDown'));
  if (!show) return null; // 環境正常且盤中無警示時不佔版面

  return (
    <div onClick={onNavigate}
      style={{ marginBottom: 10, padding: '8px 12px', borderRadius: 10, border: `1px solid ${borderColor}`, background: 'var(--bg-elevated)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', cursor: onNavigate ? 'pointer' : 'default', fontSize: 'calc(13px * var(--fz))' }}>
      <span style={{ fontWeight: 800 }}>⏱️ 今日盤型</span>
      {pat && <span style={{ fontWeight: 900, color: pat.color }}>{pat.icon} {pat.name}</span>}
      <span style={{ fontWeight: 700, color: env.level === 'red' ? '#ef4444' : '#fbbf24' }}>
        {env.level === 'red' ? '🔴 震盪盤紅燈' : env.level === 'yellow' ? '🟡 震盪盤黃燈' : ''}·近5日{env.fadeCount}天翻黑
      </span>
      {onNavigate && <span style={{ marginLeft: 'auto', color: '#7dd3fc', fontWeight: 700 }}>詳見 📡 即時追蹤 ›</span>}
    </div>
  );
}
