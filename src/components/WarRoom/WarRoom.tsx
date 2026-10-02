'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { storageGet, storageSet } from '@/lib/safe-storage';
import { useIsPremium } from '@/lib/view-as';
import { MarketPatternHint } from '@/components/MarketPattern/MarketPatternBanner';
import PortfolioAlerts from '@/components/Portfolio/PortfolioAlerts';
import StockTrendChart from '@/components/WatchlistTracker/StockTrendChart';
import MarketWind from '@/components/MarketWind/MarketWind';
import ChipPicksPanel from '@/components/WarRoom/ChipPicksPanel';
import LimitUpPanel from '@/components/WarRoom/LimitUpPanel';
import SqueezePanel from '@/components/WarRoom/SqueezePanel';
import ShortPanel from '@/components/WarRoom/ShortPanel';
import GapLimitUpPanel from '@/components/WarRoom/GapLimitUpPanel';
import VolSurgePanel from '@/components/WarRoom/VolSurgePanel';
import RiseFallPanel from '@/components/WarRoom/RiseFallPanel';
import DecisionDesk from '@/components/Candidates/DecisionDesk';
import { usePickControls, applyPick, PickBar, PickMore } from '@/components/shared/PickControls';
import { auth } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';
import { getChangeColor } from '@/lib/twse-api';
import { logActivity } from '@/lib/activity-logger';
import PageHelp from '@/components/Help/PageHelp';
import HitRate from '@/components/shared/HitRate';
import { useDayTradeCodes, statusOf } from '@/lib/useDayTradeCodes';
import { startLiveLoop, revealTick, shouldPollThroughClose, isForeground } from '@/lib/market-clock';
import { DayTradeMark } from '@/components/shared/DayTradeBadge';

// 等級清單已集中到 lib/view-as（PREMIUM_LEVELS）——此處不再各自定義，避免模擬只改到一半
const TRIAL_DAYS = 14; // 與選股策略一致

// ── ⚡ 盤中戰情：獨立盤中看盤頁（與撿尾盤分離）──────────────────
// 主榜＝盤中雷達（現行策略：起漲偵測 ignite，60秒更新；strategy 欄位預留切換）。
// 右側備選區：掉出主榜的股票自動保留續盯；點選過(展開)的釘住整日；
// 未釘住的超過 TTL 或超過數量上限自動排除（皆可設定）。

interface RadarItem { code: string; name: string; market: string; price: number; chg: number; volX: number; pos: number; toHi5: number | null; gap: number; maRel: number | null; yForeign: number; yTrust: number; score: number | null; signal: string | null; strategies: string[]; firstSeen: number }
interface Breadth { up: number; down: number; flat: number; limitUp: number; limitDown: number; upRatio: number; health: number; mood: string; newHigh: number }
interface StratMeta { name: string; icon: string; note: string; total: number }
interface RadarData { updatedAt: number; date: string; strategies: Record<string, StratMeta>; groups: Record<string, RadarItem[]> }
const STRAT_ORDER = ['ignite', 'volSurge', 'openStrong', 'ma5Bounce', 'followThru', 'chipIgnite', 'squeeze', 'breakHigh'];
// 前端 fallback（雷達文件未生成時仍顯示中文名與條件）
const STRAT_FALLBACK: Record<string, { name: string; icon: string; note: string }> = {
  ignite:     { name: '起漲偵測',     icon: '🚀', note: '量能超前≥2x＋漲0.5~3.5%未噴出＋買盤佔優＋逼近5日高（發動前）' },
  volSurge:   { name: '爆量長紅',     icon: '🔥', note: '量能超前≥3x＋漲3.5~8.5%未鎖停＋長紅實體＋貼日內高（初動確認）' },
  openStrong: { name: '開盤強勢延續', icon: '📈', note: '跳空開高≥1.5%＋未回補缺口＋守住開盤價（缺口續勢）' },
  ma5Bounce:  { name: '五日線回踩反彈', icon: '🌊', note: '價在5日線上＋今日曾踩5日線±1%＋自低點反彈≥1%（拉回買點）' },
  followThru: { name: '昨強今續',     icon: '💪', note: '昨日收漲≥2%＋今日續漲0~4%＋量能≥1.5x（動能第2日）' },
  chipIgnite: { name: '外資昨買今動', icon: '🧲', note: '昨日外資買超≥500張＋今日漲≥1%＋量能≥1.5x（籌碼共振）' },
  squeeze:    { name: '軋空啟動',     icon: '⚡', note: '昨日融券增≥昨量0.5%＋今日漲>2%（2年稽核 46.0-47.7%·淨+0.33~0.48%/筆·兩窗穩定·僅上市）' },
  breakHigh:  { name: '突破新高',     icon: '🏔', note: '突破20日新高＋貼日內高（2年稽核 45.4-48.2%·淨+0.3~0.6%/筆；⚠單獨突破未配強尾44%低於基準）' },
};
interface BenchItem { code: string; name: string; market: string; addedAt: number; pinned: boolean; lastPrice: number; lastChg: number }

const isTwTradingHours = () => {
  const tw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const d = tw.getDay(); const v = tw.getHours() * 60 + tw.getMinutes();
  return d >= 1 && d <= 5 && v >= 9 * 60 && v < 13 * 60 + 35;
};
const todayTw = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

export default function WarRoom() {
  const dt = useDayTradeCodes();   // 當沖資格：必須在任何 early return 之前
  const user = useAppStore(st => st.user);
  const navigateTo = useAppStore(st => st.navigateTo);
  const [radar, setRadar] = useState<RadarData | null>(null);
  const [breadth, setBreadth] = useState<Breadth | null>(null);
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [bench, setBench] = useState<BenchItem[]>([]);
  const [ttlMin, setTtlMin] = useState(30);
  const [benchMax, setBenchMax] = useState(12);
  // 策略開關（預設全開），persist localStorage
  const [toggles, setToggles] = useState<Record<string, boolean>>(Object.fromEntries(STRAT_ORDER.map(k => [k, true])));
  const [pickCtl, setPickCtl] = usePickControls();
  // 主分頁存 store：讓候選便條能從任何頁一鍵切到「決策工作台」分頁
  const mainTab = useAppStore(st => st.warTab) as 'radar' | 'chip' | 'limitup' | 'lulive' | 'volsurge' | 'risefall' | 'desk' | 'squeeze' | 'short' | 'gaplu';
  const setMainTab = useAppStore(st => st.setWarTab);
  const prevCodes = useRef<Map<string, RadarItem>>(new Map());

  // 設定與備選區還原（備選區跨日清空）
  useEffect(() => {
    try {
      const s = JSON.parse(storageGet('warBenchCfg') || '{}');
      if (s.ttlMin) setTtlMin(s.ttlMin); if (s.benchMax) setBenchMax(s.benchMax);
      const b = JSON.parse(storageGet('warBench') || 'null');
      if (b?.date === todayTw() && Array.isArray(b.items)) setBench(b.items);
      const t = JSON.parse(storageGet('warStrategyToggles') || 'null');
      if (t && typeof t === 'object') setToggles(cur => ({ ...cur, ...t }));
    } catch { /* ignore */ }
  }, []);
  const flipToggle = (k: string) => setToggles(cur => {
    const next = { ...cur, [k]: !cur[k] };
    storageSet('warStrategyToggles', JSON.stringify(next));
    return next;
  });
  const saveBench = useCallback((items: BenchItem[]) => {
    setBench(items);
    storageSet('warBench', JSON.stringify({ date: todayTw(), items }));
  }, []);
  const saveCfg = (t: number, m: number) => { setTtlMin(t); setBenchMax(m); storageSet('warBenchCfg', JSON.stringify({ ttlMin: t, benchMax: m })); };

  // 備選區修剪：未釘住者逾時或超量(舊者先出)；釘住者保留
  const prune = useCallback((items: BenchItem[], ttl: number, max: number) => {
    const now = Date.now();
    let out = items.filter(b => b.pinned || now - b.addedAt < ttl * 60000);
    const unpinned = out.filter(b => !b.pinned).sort((a, b) => a.addedAt - b.addedAt);
    let excess = out.length - max;
    for (const u of unpinned) { if (excess <= 0) break; out = out.filter(x => x.code !== u.code); excess--; }
    return out;
  }, []);

  // 雷達輪詢＋掉榜自動入備選＋備選報價更新
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const r = await fetch('/api/ai/intraday-radar').then(x => (x.ok ? x.json() : null));
        if (!live || !r) return;
        setRadar(r);
        // 全策略聯集（開關只影響顯示，不影響備選判定）
        const uni = new Map<string, RadarItem>();
        for (const k of Object.keys(r.groups || {})) for (const it of (r.groups[k] || [])) uni.set(it.code, it);
        const nowCodes = new Set(uni.keys());
        // 掉出主榜 → 進備選區（沿用最後報價）
        const dropped: BenchItem[] = [];
        for (const [code, it] of prevCodes.current) {
          if (!nowCodes.has(code)) dropped.push({ code, name: it.name, market: it.market, addedAt: Date.now(), pinned: false, lastPrice: it.price, lastChg: it.chg });
        }
        prevCodes.current = uni;
        setBench(cur => {
          let next = [...cur];
          for (const d of dropped) if (!next.some(b => b.code === d.code) && !nowCodes.has(d.code)) next.push(d);
          next = prune(next, ttlMin, benchMax);
          storageSet('warBench', JSON.stringify({ date: todayTw(), items: next }));
          return next;
        });
      } catch { /* ignore */ }
    };
    const quotes = async () => {
      try {
        const codes = JSON.parse(storageGet('warBench') || '{}')?.items?.map((b: BenchItem) => b.code) || [];
        if (!codes.length) return;
        const j = await fetch(`/api/twse/mis-quote?codes=${codes.slice(0, 30).join(',')}&t=${revealTick()}`).then(x => (x.ok ? x.json() : null));
        const qs: { code: string; price: number; changePercent: number }[] = j?.quotes || [];
        if (!live || !qs.length) return;
        setBench(cur => cur.map(b => { const q = qs.find(x => x.code === b.code); return q && q.price > 0 ? { ...b, lastPrice: q.price, lastChg: q.changePercent } : b; }));
      } catch { /* ignore */ }
    };
    const loadBreadth = async () => {
      try { const b = await fetch('/api/ai/market-health').then(x => (x.ok ? x.json() : null)); if (live && b) setBreadth(b); } catch { /* ignore */ }
    };
    // 備選區逾時修剪原本搭在 load() 裡；休市跳過雷達請求時仍要照常修剪（不打網路）
    const pruneOnly = () => setBench(cur => {
      const next = prune(cur, ttlMin, benchMax);
      storageSet('warBench', JSON.stringify({ date: todayTw(), items: next }));
      return next;
    });
    load(); quotes(); loadBreadth();   // 首次載入不設閘：盤後打開也要看到資料
    // 間隔每拍重算（G3-03：原本三元在掛載時算死）＋閘門：
    //   雷達只在盤中變 ⇒ shouldPollThroughClose（含 13:30–13:45 收盤定價窗）；大盤寬度 daemon 盤後批次仍會重算 ⇒ 只擋背景分頁。
    const stopL = startLiveLoop(() => {
      if (shouldPollThroughClose()) load(); else pruneOnly();
      if (isForeground()) loadBreadth();
    }, () => (isTwTradingHours() ? 30000 : 300000));
    // 報價與榜單分離（使用者 2026-09-02「盤中為 3 秒更新」）：榜單/寬度 30 秒即可，
    // 但**價格**要鎖相在 MIS 揭示邊界+3s——揭示 5 秒一拍，邊界+1s 快線已抓、
    // +3s 時各層快取已回填，此時打恰好每拍都拿到最新價。盤外退回 5 分鐘。
    const stopQ = startLiveLoop(() => { if (shouldPollThroughClose()) quotes(); });   // 鎖相＋回前景立即恢復（標準件）
    return () => { live = false; stopL(); stopQ(); };
  }, [ttlMin, benchMax, prune]);

  // 點選(展開)主榜列 → 釘住到備選區（之後掉榜也保留）
  const toggleOpen = (it: RadarItem) => {
    setOpenCode(c => (c === it.code ? null : it.code));
    setBench(cur => {
      const exist = cur.find(b => b.code === it.code);
      const next = exist
        ? cur.map(b => (b.code === it.code ? { ...b, pinned: true } : b))
        : [...cur, { code: it.code, name: it.name, market: it.market, addedAt: Date.now(), pinned: true, lastPrice: it.price, lastChg: it.chg }];
      storageSet('warBench', JSON.stringify({ date: todayTw(), items: next }));
      return next;
    });
  };
  const benchPin = (code: string) => saveBench(bench.map(b => (b.code === code ? { ...b, pinned: !b.pinned } : b)));
  const benchRemove = (code: string) => saveBench(bench.filter(b => b.code !== code));

  const mBadge = (m: string) => (m === 'otc' ? { t: '櫃', c: '#f59e0b' } : { t: '市', c: '#3d8ef8' });
  const staleMs = radar ? Date.now() - radar.updatedAt : 0;

  // 高級會員限定（含 14 天新會員體驗）：導覽已隱藏，此為直連守門
  const isPremiumUser = useIsPremium();   // 受身分模擬影響（見 lib/view-as）
  const trialActive = (() => {
    if (isPremiumUser || !user?.uid) return false;
    const ct = (auth as { currentUser?: { metadata?: { creationTime?: string } } })?.currentUser?.metadata?.creationTime;
    return !!ct && (Date.now() - new Date(ct).getTime()) / 86400000 < TRIAL_DAYS;
  })();
  if (!isPremiumUser && !trialActive) {
    return (
      <div style={{ padding: '36px 20px', textAlign: 'center', border: '1px solid var(--border-primary)', borderRadius: 12, background: 'var(--bg-elevated)', maxWidth: 560, margin: '40px auto' }}>
        <div style={{ fontSize: 'calc(28px * var(--fz))', marginBottom: 8 }}>🔒</div>
        <div style={{ fontWeight: 800, fontSize: 'calc(1.05rem * var(--fz))', marginBottom: 6 }}>盤中戰情為高級會員功能</div>
        <div style={{ fontSize: 'calc(13.5px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.6 }}>
          6 種盤中即時策略雷達（起漲偵測／爆量長紅／開盤強勢延續…）、<br />
          策略開關篩選、⭐多重共識、備選區續盯，60 秒即時更新。
        </div>
        <div style={{ marginTop: 10, fontSize: 'calc(13px * var(--fz))', fontWeight: 700, color: '#fbbf24' }}>
          🎁 新註冊會員可免費體驗 14 天（自註冊日起自動生效）
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <h1 style={{ fontSize: 'calc(1.25rem * var(--fz))', fontWeight: 900 }}>⚡ 盤中戰情</h1>
        <span className="mobile-hide" style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>盤中專用（撿尾盤請至 📡 即時追蹤）· 盤中 09:00–13:35 每 60 秒更新</span>
      </div>
      <PageHelp id="war" />

      {/* ── 主分頁切換（置頂：手機上才不會被下方卡片埋掉）── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'nowrap', overflowX: 'auto', marginBottom: 10, paddingBottom: 2, scrollbarWidth: 'none' }}>
        {([['radar', '📡 盤中雷達'], ['risefall', '📈 即時漲跌'], ['chip', '🧬 籌碼推選'], ['limitup', '🚀 漲停預測'], ['squeeze', '🩳 軋空候選'], ['short', '🐻 空方候選'], ['gaplu', '🎯 跳空漲停'], ['volsurge', '⚡ 盤中爆量'], ['desk', '🗒️ 決策工作台']] as const).map(([k, label]) => {
          const on = mainTab === k;
          return (
            <button key={k} onClick={() => { setMainTab(k); logActivity('war_tab', { tab: k }); }}
              style={{ padding: '6px 14px', borderRadius: 10, fontSize: 'calc(13.5px * var(--fz))', fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                border: `1px solid ${on ? 'rgba(125,211,252,0.6)' : 'var(--border-primary)'}`,
                background: on ? 'rgba(125,211,252,0.14)' : 'transparent',
                color: on ? 'var(--text-primary)' : 'var(--text-muted)' }}>
              {label}
            </button>
          );
        })}
      </div>

      {/* 即時漲跌家數＋警示＋風向：只在盤中雷達分頁顯示（其他分頁內容直接跟在分頁列下）*/}
      {mainTab === 'radar' && breadth && (() => {
        const tot = Math.max(1, breadth.up + breadth.down + breadth.flat);
        const upPct = breadth.up / tot * 100, dnPct = breadth.down / tot * 100;
        return (
          <div style={{ marginBottom: 10, padding: '9px 14px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', fontSize: 'calc(13px * var(--fz))' }}>
              <span style={{ fontWeight: 800 }}>📊 大盤家數</span>
              <span style={{ color: '#f03e3e', fontWeight: 800 }}>▲ 上漲 {breadth.up.toLocaleString()}</span>
              <span style={{ color: '#2f9e44', fontWeight: 800 }}>▼ 下跌 {breadth.down.toLocaleString()}</span>
              <span style={{ color: 'var(--text-muted)' }}>持平 {breadth.flat}</span>
              <span style={{ color: '#f03e3e' }}>漲停 {breadth.limitUp}</span>
              <span style={{ color: '#2f9e44' }}>跌停 {breadth.limitDown}</span>
              <span style={{ color: 'var(--text-secondary)' }}>創高 {breadth.newHigh}</span>
              <span style={{ marginLeft: 'auto', fontWeight: 800, color: breadth.health >= 50 ? '#f03e3e' : '#fbbf24' }}>
                市場健康度 {breadth.health}／100 · {breadth.mood}
              </span>
            </div>
            {/* 紅綠比例條 */}
            <div style={{ display: 'flex', height: 6, borderRadius: 4, overflow: 'hidden', marginTop: 7, background: 'rgba(148,163,184,0.15)' }}>
              <div style={{ width: `${upPct}%`, background: '#f03e3e' }} />
              <div style={{ width: `${100 - upPct - dnPct}%`, background: '#64748b' }} />
              <div style={{ width: `${dnPct}%`, background: '#2f9e44' }} />
            </div>
            <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginTop: 4 }}>
              上漲佔比 {breadth.upRatio}%{breadth.up < breadth.down ? ' · 賣壓偏重，起漲股恐易回落，進場更保守' : breadth.up > breadth.down * 1.5 ? ' · 買氣熱絡，追蹤起漲股勝率較高' : ''}
            </div>
          </div>
        );
      })()}

      {mainTab === 'radar' && (
        <>
          {user?.uid && <PortfolioAlerts />}
          <MarketPatternHint onNavigate={() => navigateTo('tracker')} />
          <MarketWind compact />
        </>
      )}

      {mainTab === 'desk' ? <DecisionDesk /> : mainTab === 'risefall' ? <RiseFallPanel /> : mainTab === 'lulive' ? <RiseFallPanel initialView="forecast" /> : mainTab === 'volsurge' ? <VolSurgePanel /> : mainTab === 'limitup' ? <LimitUpPanel /> :  mainTab === 'squeeze' ? <SqueezePanel /> : mainTab === 'short' ? <ShortPanel /> : mainTab === 'gaplu' ? <GapLimitUpPanel /> : mainTab === 'chip' ? <ChipPicksPanel /> : (
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* ── 主榜：盤中雷達（多策略開關篩選） ── */}
        <div style={{ flex: '1 1 640px', minWidth: 0, padding: '10px 12px', borderRadius: 12, background: 'rgba(61,142,248,0.06)', border: '1px solid rgba(61,142,248,0.25)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
            <span style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 900, color: '#7dd3fc' }}>📡 盤中雷達</span>
            <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
              開關篩選策略 · 命中≥2策略＝⭐共識(金框優先){staleMs > 150000 ? ' · ⏸ 非盤中(最後一次結果)' : ''}
            </span>
          </div>
          {/* 命中率：追蹤「命中≥2 策略」的⭐共識股，也就是面板金框優先的那一組 */}
          <HitRate list="radar" label="雷達⭐共識" />
          {/* 策略開關列 */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {STRAT_ORDER.map(k => {
              const m = radar?.strategies?.[k] || { ...STRAT_FALLBACK[k], total: undefined as unknown as number };
              const on = !!toggles[k];
              return (
                <button key={k} onClick={() => flipToggle(k)} title={m?.note || ''}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 16, fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, cursor: 'pointer',
                    border: `1px solid ${on ? 'rgba(125,211,252,0.55)' : 'var(--border-primary)'}`,
                    background: on ? 'rgba(125,211,252,0.12)' : 'transparent',
                    color: on ? 'var(--text-primary)' : 'var(--text-muted)', opacity: on ? 1 : 0.6 }}>
                  <span>{m?.icon || '·'} {m?.name || k}</span>
                  {m.total != null ? <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: on ? '#7dd3fc' : 'var(--text-muted)' }}>{m.total}</span> : null}
                  <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: on ? '#22c55e' : 'var(--text-muted)' }}>{on ? 'ON' : 'OFF'}</span>
                </button>
              );
            })}
          </div>
          {(() => {
            // 合併去重：只取開啟策略的命中，命中數多者優先、再依量能
            const map = new Map<string, RadarItem & { hitOn: string[] }>();
            for (const k of STRAT_ORDER) {
              if (!toggles[k]) continue;
              for (const it of (radar?.groups?.[k] || [])) {
                const cur = map.get(it.code) || { ...it, hitOn: [] };
                if (!cur.hitOn.includes(k)) cur.hitOn.push(k);
                map.set(it.code, cur);
              }
            }
            const rows = [...map.values()].sort((a, b) => b.hitOn.length - a.hitOn.length || b.volX - a.volX);
            if (!rows.length) return (
              <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', padding: '14px 4px' }}>
                目前無符合已開啟策略的個股（盤中 09:00 起每 60 秒掃描（開盤 10 分鐘內為 1 分 K 輪間方向偵測）；非盤中時段顯示最後一次結果）。
              </div>
            );
            const { rows: shownRows, filteredTotal } = applyPick(rows, pickCtl, {
              price: it => it.price, chg: it => it.chg, vol: it => it.volX,
              foreign: it => it.yForeign ?? -Infinity, score: it => it.score ?? -Infinity,
            });
            return (
              <>
              <PickBar ctl={pickCtl} setCtl={setPickCtl} />
              {shownRows.length === 0 ? (
                <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', padding: '10px 4px' }}>此價格區間內無符合標的，換個區間看看。</div>
              ) : (
              <div style={{ display: 'grid', gap: 4 }}>
                {shownRows.map(it => {
                  const b = mBadge(it.market);
                  const open = openCode === it.code;
                  const isNew = Date.now() - it.firstSeen < 3 * 60000;
                  const mins = Math.max(0, Math.round((Date.now() - it.firstSeen) / 60000));
                  const consensus = it.hitOn.length >= 2;
                  return (
                    <div key={it.code} style={{ borderRadius: 8,
                      background: open ? 'rgba(61,142,248,0.10)' : consensus ? 'rgba(251,191,36,0.08)' : 'rgba(148,163,184,0.06)',
                      border: open ? '1px solid rgba(61,142,248,0.35)' : consensus ? '1px solid rgba(251,191,36,0.45)' : '1px solid transparent' }}>
                      <div onClick={() => toggleOpen(it)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', fontSize: 'calc(13.5px * var(--fz))', flexWrap: 'wrap', cursor: 'pointer' }}>
                        <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', width: 12 }}>{open ? '▾' : '▸'}</span>
                        {consensus && <span style={{ fontSize: 'calc(12.5px * var(--fz))' }}>⭐</span>}
                        <span style={{ fontWeight: 800, minWidth: 42 }}>{it.code}</span>
                        <span style={{ fontWeight: 600, minWidth: 68 }}>{it.name}</span>
                        <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, padding: '1px 5px', borderRadius: 5, background: `${b.c}22`, color: b.c }}>{b.t}</span>
                        <span style={{ color: 'var(--text-secondary)' }}>{it.price}</span>
                        <span style={{ fontWeight: 800, color: '#f03e3e' }}>+{it.chg}%</span>
                        <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: '#fbbf24', fontWeight: 700 }}>量能 {it.volX}x</span>
                        {it.score != null && <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, color: it.score >= 80 ? '#f03e3e' : it.score >= 60 ? '#fbbf24' : 'var(--text-muted)' }}>評分 {it.score}</span>}
                        {/* 昨日法人籌碼(可目測) */}
                        {(it.yForeign || it.yTrust) ? (
                          <span style={{ fontSize: 'calc(12.5px * var(--fz))', display: 'inline-flex', gap: 6 }}>
                            {it.yForeign ? <span style={{ color: it.yForeign > 0 ? '#f03e3e' : '#2f9e44', fontWeight: 700 }}>外資{it.yForeign > 0 ? '+' : ''}{it.yForeign.toLocaleString()}</span> : null}
                            {it.yTrust ? <span style={{ color: it.yTrust > 0 ? '#f03e3e' : '#2f9e44', fontWeight: 700 }}>投信{it.yTrust > 0 ? '+' : ''}{it.yTrust.toLocaleString()}</span> : null}
                          </span>
                        ) : null}
                        {it.toHi5 != null && <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: it.toHi5 >= 0 ? '#f03e3e' : 'var(--text-secondary)' }}>{it.toHi5 >= 0 ? `破5日高+${it.toHi5}%` : `距5日高${it.toHi5}%`}</span>}
                        {/* 命中策略徽章 */}
                        <span style={{ display: 'inline-flex', gap: 3 }}>
                          {it.hitOn.map(k => <span key={k} title={(radar?.strategies?.[k] || STRAT_FALLBACK[k])?.name} style={{ fontSize: 'calc(12.5px * var(--fz))' }}>{(radar?.strategies?.[k] || STRAT_FALLBACK[k])?.icon}</span>)}
                        </span>
                        {isNew && <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, color: '#22c55e', background: 'rgba(34,197,94,0.15)', padding: '1px 6px', borderRadius: 5 }}>NEW</span>}
                        <span style={{ marginLeft: 'auto', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>上榜 {mins} 分</span>
                      </div>
                      {open && (
                        <div style={{ padding: '4px 10px 10px' }} onClick={e => e.stopPropagation()}>
                          {/* 目測判斷資訊列 */}
                          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 'calc(12.5px * var(--fz))', marginBottom: 6, padding: '6px 8px', borderRadius: 8, background: 'rgba(148,163,184,0.06)' }}>
                            <span>訊號 <b style={{ color: it.signal === 'STRONG_BUY' || it.signal === 'BUY' ? '#f03e3e' : it.signal === 'SELL' ? '#2f9e44' : '#fbbf24' }}>{it.signal || '—'}</b></span>
                            <span>開盤 <b style={{ color: getChangeColor(it.gap) }}>{it.gap > 0 ? '跳空+' : ''}{it.gap}%</b></span>
                            <span>日內位置 <b>{it.pos >= 0.85 ? '收最高附近' : it.pos >= 0.6 ? '偏高檔' : it.pos >= 0.4 ? '中段' : '偏低檔'}（{Math.round(it.pos * 100)}%）</b></span>
                            {it.maRel != null && <span>距5日線 <b style={{ color: it.maRel >= 0 ? '#f03e3e' : '#2f9e44' }}>{it.maRel >= 0 ? '+' : ''}{it.maRel}%</b></span>}
                          </div>
                          <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-secondary)', marginBottom: 4 }}>
                            命中：{it.hitOn.map(k => `${(radar?.strategies?.[k] || STRAT_FALLBACK[k])?.icon} ${(radar?.strategies?.[k] || STRAT_FALLBACK[k])?.name}`).join('、')}
                          </div>
                          <StockTrendChart code={it.code} name={it.name} closePrice={it.price} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              )}
              <PickMore ctl={pickCtl} setCtl={setPickCtl} filteredTotal={filteredTotal} />
              </>
            );
          })()}
          <div style={{ marginTop: 8, fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.6 }}>
            ⚠ 盤中偵測為即時掃描、未經隔日回測驗證（點開關可看各策略條件）；進場鐵律：單筆風險≤1%、11:30 前未走強收盤前先出、隔日 9:00–9:05 必出。非投資建議。
          </div>
        </div>

        {/* ── 右側備選區 ── */}
        <div style={{ flex: '0 1 300px', minWidth: 0, padding: '10px 12px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 800, fontSize: 'calc(13.5px * var(--fz))' }}>👁 備選區</span>
            <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>掉榜自動保留 · 點選過📌釘住整日</span>
          </div>
          {/* 設定：TTL / 上限 */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginBottom: 8 }}>
            <span>未釘住保留</span>
            <select value={ttlMin} onChange={e => saveCfg(+e.target.value, benchMax)} style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)', borderRadius: 6, fontSize: 'calc(12.5px * var(--fz))', padding: '2px 4px' }}>
              {[15, 30, 60].map(v => <option key={v} value={v}>{v} 分</option>)}
            </select>
            <span>上限</span>
            <select value={benchMax} onChange={e => saveCfg(ttlMin, +e.target.value)} style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)', borderRadius: 6, fontSize: 'calc(12.5px * var(--fz))', padding: '2px 4px' }}>
              {[8, 12, 20].map(v => <option key={v} value={v}>{v} 檔</option>)}
            </select>
          </div>
          {bench.length === 0 ? (
            <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', padding: '8px 0' }}>尚無備選。主榜掉出的股票會自動出現在這裡續盯。</div>
          ) : (
            <div style={{ display: 'grid', gap: 4 }}>
              {[...bench].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.addedAt - a.addedAt).map(b => (
                <div key={b.code} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 8, background: b.pinned ? 'rgba(251,191,36,0.08)' : 'rgba(148,163,184,0.06)', fontSize: 'calc(12.5px * var(--fz))' }}>
                  <span onClick={() => benchPin(b.code)} title={b.pinned ? '取消釘住' : '釘住(不會被自動排除)'} style={{ cursor: 'pointer', fontSize: 'calc(12.5px * var(--fz))', opacity: b.pinned ? 1 : 0.35 }}>📌</span>
                  <span onClick={() => navigateTo('stock', b.code)} style={{ fontWeight: 800, cursor: 'pointer', color: '#7dd3fc' }}>{b.code}</span>
                  <span onClick={() => navigateTo('stock', b.code)} style={{ fontWeight: 600, cursor: 'pointer' }}>{b.name}</span>
              {(() => { const st = statusOf(dt, b.code); return st == null ? null : <DayTradeMark status={st} size="xs" />; })()}
                  <span style={{ marginLeft: 'auto', color: 'var(--text-secondary)' }}>{b.lastPrice}</span>
                  <span style={{ fontWeight: 700, color: getChangeColor(b.lastChg) }}>{b.lastChg > 0 ? '+' : ''}{b.lastChg?.toFixed?.(1) ?? b.lastChg}%</span>
                  <span onClick={() => benchRemove(b.code)} title="移除" style={{ cursor: 'pointer', color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))' }}>✕</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
