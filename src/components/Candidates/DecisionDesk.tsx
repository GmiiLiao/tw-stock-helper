'use client';

// ── 決策工作台（選股流程終點）─────────────────────────────────────
// 帶著候選便條來這裡：逐檔彙整 籌碼判讀＋勝率＋性格分類＋今日量價＋預算試算，
// 給出隔日沖策略傾向，協助決策下單。資料不足者誠實標註。非投資建議。

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '@/lib/store';
import { useChipVerdicts, VerdictStrip, type Verdict } from '@/components/shared/ChipVerdict';
import StockTrendChart from '@/components/WatchlistTracker/StockTrendChart';
import TechnicalChart from '@/components/StockDetail/TechnicalChart';
import { fetchStockHistory, type CandleData, type StockInfo } from '@/lib/twse-api';
import { subMonths } from 'date-fns';
import AddCandidateButton from './AddCandidateButton';
import PageHelp from '@/components/Help/PageHelp';
import { logActivity } from '@/lib/activity-logger';
import { computeComposite } from '@/lib/composite-score';
import OrderBookDepth from '@/components/shared/OrderBookDepth';
import { METRIC_TIPS } from '@/lib/metric-tips';

interface CharRow { label?: string; spec?: number; corr?: number; f20?: number; t20?: number; d20?: number; fStreak?: number; tStreak?: number; dStreak?: number }

// 隔日沖策略傾向：由籌碼判讀行動＋級別＋勝率＋倒貨％＋今日法人綜合
function overnightStance(v?: Verdict | null): { t: string; c: string; note: string } {
  if (!v) return { t: '資料累積中', c: '#94a3b8', note: '此檔尚無回測背書的籌碼判讀（非熱門或資料未覆蓋），建議搭配技術面自行判斷。' };
  const bullishAct = v.a === '可加碼';
  const holdStrong = v.a === '續抱' && (v.tier === 'S' || v.tier === 'A') && v.f >= 0;
  const bearish = ['清倉', '優先減碼', '減碼', '觀望'].includes(v.a) || v.dist >= 60;
  if (bearish) return { t: '🟢 避開／偏空', c: '#2f9e44', note: `籌碼轉弱（${v.a}${v.dist >= 60 ? `、倒貨${v.dist}%` : ''}）——隔日沖追多風險高，這波該讓過或找強勢處減碼。` };
  if (bullishAct || holdStrong) return { t: '🔴 偏多可留意', c: '#f03e3e', note: `籌碼站多方（${v.a}、${v.tier}級${v.win ? ` 開賣漲${v.win}%` : ''}）——隔日沖偏多，仍守單筆風險≤1%、破前低停損。` };
  return { t: '⚪ 中性觀望', c: '#eab308', note: `訊號中性（${v.a}）——等籌碼或技術更明確再進，勿盲追。` };
}

export default function DecisionDesk() {
  const codes = useAppStore(s => s.compareCodes);
  const allStocks = useAppStore(s => s.allStocks);
  const clear = useAppStore(s => s.clearCandidates);
  const navigateTo = useAppStore(s => s.navigateTo);
  const setWarTab = useAppStore(s => s.setWarTab);
  const goPick = () => { setWarTab('risefall'); navigateTo('war'); };
  // 預算試算參數（沿用 Screener 的 compare 設定）
  const budget = useAppStore(s => s.compareBudget);
  const setBudget = useAppStore(s => s.setCompareBudget);
  const profitTarget = useAppStore(s => s.compareProfitTarget);
  const setProfitTarget = useAppStore(s => s.setCompareProfitTarget);
  const tradeDuration = useAppStore(s => s.compareTradeDuration);
  const setTradeDuration = useAppStore(s => s.setCompareTradeDuration);

  // 使用分析：進入工作台事件（每次掛載一次）
  useEffect(() => { logActivity('open_desk', { candidates: codes.length }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const verdicts = useChipVerdicts(codes);
  const [chars, setChars] = useState<Record<string, CharRow>>({});
  const [openCode, setOpenCode] = useState<string | null>(null);
  // 資券借券（t-1）：[資餘,資增,券餘,券增,借餘,借增,前20日高,昨量張]
  const [margins, setMargins] = useState<Record<string, (number | null)[]>>({});
  const [chartMode, setChartMode] = useState<Record<string, 'live' | 'kline'>>({});
  const [candlesMap, setCandlesMap] = useState<Record<string, CandleData[]>>({});
  const [candleLoading, setCandleLoading] = useState<Record<string, boolean>>({});

  // 展開時載入日 K（供均線讀值/停損參考/日K圖；4 個月足算 MA60）
  useEffect(() => {
    const code = openCode;
    if (!code || candlesMap[code] || candleLoading[code]) return;
    let live = true;
    setCandleLoading(m => ({ ...m, [code]: true }));
    (async () => {
      try {
        const all: CandleData[] = [];
        for (let m = 3; m >= 0; m--) {
          const d = subMonths(new Date(), m);
          const ds = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}01`;
          all.push(...await fetchStockHistory(code, ds));
          await new Promise(r => setTimeout(r, 250));
        }
        const seen = new Set<number>();
        const uniq = all.filter(c0 => { if (seen.has(c0.time)) return false; seen.add(c0.time); return true; }).sort((a, b) => a.time - b.time);
        if (live) setCandlesMap(m => ({ ...m, [code]: uniq }));
      } catch { /* 顯示 — */ }
      if (live) setCandleLoading(m => ({ ...m, [code]: false }));
    })();
    return () => { live = false; };
  }, [openCode]); // eslint-disable-line react-hooks/exhaustive-deps
  // 榜單出現：撿尾盤名次評分／漲停預測名次／雷達命中策略
  const [boards, setBoards] = useState<{ tail: Record<string, { rank: number; score?: number; grade?: string }>; lu: Record<string, number>; radar: Record<string, string[]> }>({ tail: {}, lu: {}, radar: {} });
  // 盤中即時報價（覆蓋 allStocks 快照）：評分/傾向/收位/試算全部跟著即時價動
  const [liveQ, setLiveQ] = useState<Record<string, { price: number; changePercent: number; high?: number; low?: number; volume?: number }>>({});
  const [liveAt, setLiveAt] = useState<number | null>(null);
  // 大盤 regime／事件檢查／族群強弱
  const [health, setHealth] = useState<{ up: number; down: number; health: number; mood: string; upRatio: number } | null>(null);
  const [idxChg, setIdxChg] = useState<number | null>(null);
  const [eventsBy, setEventsBy] = useState<Record<string, { date: string; title: string; type: string }[]>>({});
  const [riskBy, setRiskBy] = useState<Record<string, string>>({});
  const [indBy, setIndBy] = useState<Record<string, string>>({});
  const [wind, setWind] = useState<{ ind: string; trend: string; hot: boolean; cnt5: number }[]>([]);

  useEffect(() => {
    if (codes.length === 0) return;
    let live = true;
    const inHours = () => {
      const tw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
      const d = tw.getDay(); const v = tw.getHours() * 60 + tw.getMinutes();
      return d >= 1 && d <= 5 && v >= 9 * 60 && v < 13 * 60 + 35;
    };
    const tick = async () => {
      try {
        const j = await fetch(`/api/twse/mis-quote?codes=${codes.slice(0, 30).join(',')}`).then(r => (r.ok ? r.json() : null));
        if (!live || !Array.isArray(j?.quotes)) return;
        const m: Record<string, { price: number; changePercent: number; high?: number; low?: number; volume?: number }> = {};
        for (const q of j.quotes) if (q.price > 0) m[q.code] = { price: q.price, changePercent: q.changePercent, high: q.high, low: q.low, volume: q.volume };
        setLiveQ(m); setLiveAt(Date.now());
      } catch { /* 保留上次 */ }
      try { const h = await fetch('/api/ai/market-health').then(r => (r.ok ? r.json() : null)); if (live && h) setHealth(h); } catch { /* 保留 */ }
      try { const ix = await fetch('/api/twse/market-index').then(r => (r.ok ? r.json() : null)); if (live && ix?.weightedChangePercent != null) setIdxChg(+ix.weightedChangePercent); } catch { /* 保留 */ }
    };
    tick();
    const t = setInterval(tick, inHours() ? 30000 : 300000);
    return () => { live = false; clearInterval(t); };
  }, [codes.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (codes.length === 0) return;
    let live = true;
    Promise.all(codes.map(c => fetch(`/api/ai/margin-snap?code=${c}`).then(r => (r.ok ? r.json() : null)).catch(() => null)))
      .then(rs => {
        if (!live) return;
        const m: Record<string, (number | null)[]> = {};
        rs.forEach((x, i) => { if (x?.found && Array.isArray(x.row)) m[codes[i]] = x.row; });
        setMargins(m);
      });
    (async () => {
      try {
        const [tail, lu, radar] = await Promise.all([
          fetch('/api/twse/intraday-picks').then(r => (r.ok ? r.json() : null)).catch(() => null),
          fetch('/api/ai/limitup-forecast').then(r => (r.ok ? r.json() : null)).catch(() => null),
          fetch('/api/ai/intraday-radar').then(r => (r.ok ? r.json() : null)).catch(() => null),
        ]);
        if (!live) return;
        const t: Record<string, { rank: number; score?: number; grade?: string }> = {};
        (tail?.picks || []).forEach((x: { code: string; score?: number; grade?: string }, i: number) => { t[x.code] = { rank: i + 1, score: x.score, grade: x.grade }; });
        const l: Record<string, number> = {};
        (lu?.aList || []).forEach((x: { code: string }, i: number) => { l[x.code] = i + 1; });
        if (Array.isArray(lu?.stats?.wind)) setWind(lu.stats.wind);
        const rd: Record<string, string[]> = {};
        const meta = (radar?.strategies || {}) as Record<string, { name?: string }>;
        for (const k of Object.keys(radar?.groups || {})) for (const it of (radar.groups[k] || []) as { code: string }[]) (rd[it.code] ||= []).push(meta[k]?.name || k);
        setBoards({ tail: t, lu: l, radar: rd });
      } catch { /* 非盤中/無資料：榜單行顯示 — */ }
    })();
    // 盤中每 60 秒更新榜單（撿尾盤/雷達盤中會變動）
    const inHours = () => {
      const tw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
      const d = tw.getDay(); const v = tw.getHours() * 60 + tw.getMinutes();
      return d >= 1 && d <= 5 && v >= 9 * 60 && v < 13 * 60 + 35;
    };
    const t = inHours() ? setInterval(() => {
      Promise.all([
        fetch('/api/twse/intraday-picks').then(r => (r.ok ? r.json() : null)).catch(() => null),
        fetch('/api/ai/intraday-radar').then(r => (r.ok ? r.json() : null)).catch(() => null),
      ]).then(([tail, radar]) => {
        if (!live) return;
        setBoards(prev => {
          const t2 = { ...prev.tail };
          if (Array.isArray(tail?.picks)) { for (const k of Object.keys(t2)) delete t2[k]; tail.picks.forEach((x: { code: string; score?: number; grade?: string }, i: number) => { t2[x.code] = { rank: i + 1, score: x.score, grade: x.grade }; }); }
          const rd: Record<string, string[]> = {};
          const meta = (radar?.strategies || {}) as Record<string, { name?: string }>;
          for (const k of Object.keys(radar?.groups || {})) for (const it of (radar.groups[k] || []) as { code: string }[]) (rd[it.code] ||= []).push(meta[k]?.name || k);
          return { tail: t2, lu: prev.lu, radar: Object.keys(rd).length || !radar ? rd : prev.radar };
        });
      });
    }, 60000) : null;
    return () => { live = false; if (t) clearInterval(t); };
  }, [codes.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // 事件檢查（近3日除權息/法說等）＋處置/注意＋個股產業（隨候選變化）
  useEffect(() => {
    if (codes.length === 0) return;
    let live = true;
    (async () => {
      try {
        const cal = await fetch('/api/ai/catalyst-calendar').then(r => (r.ok ? r.json() : null));
        if (live && Array.isArray(cal?.events)) {
          const cut = new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10);
          const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
          const m: Record<string, { date: string; title: string; type: string }[]> = {};
          for (const e of cal.events) if (codes.includes(e.code) && e.date >= today && e.date <= cut) (m[e.code] ||= []).push({ date: e.date, title: e.title, type: e.type });
          setEventsBy(m);
        }
      } catch { /* 無事件 */ }
      try {
        const rk = await fetch('/api/twse/risk-stocks').then(r => (r.ok ? r.json() : null));
        if (live && rk) {
          const m: Record<string, string> = {};
          for (const x of (rk.disposition || [])) if (codes.includes(x.code)) m[x.code] = '處置中';
          for (const x of (rk.attention || [])) if (codes.includes(x.code) && !m[x.code]) m[x.code] = '注意股';
          setRiskBy(m);
        }
      } catch { /* 無 */ }
      try {
        const rs = await Promise.all(codes.slice(0, 12).map(c => fetch(`/api/ai/peer-comps?code=${c}`).then(r => (r.ok ? r.json() : null)).catch(() => null)));
        if (live) {
          const m: Record<string, string> = {};
          rs.forEach((x, i) => { if (x?.industry) m[codes[i]] = x.industry; });
          setIndBy(m);
        }
      } catch { /* 無 */ }
    })();
    return () => { live = false; };
  }, [codes.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // 性格分類（一次抓全表，join 候選）
  useEffect(() => {
    if (codes.length === 0) return;
    let live = true;
    fetch('/api/ai/chip-character').then(r => (r.ok ? r.json() : null)).then(x => {
      if (!live || !x?.found || !Array.isArray(x.rows)) return;
      const m: Record<string, CharRow> = {};
      for (const r of x.rows) m[r.code] = { label: r.label, spec: r.spec, corr: r.corr, f20: r.f20, t20: r.t20, d20: r.d20, fStreak: r.fStreak, tStreak: r.tStreak, dStreak: r.dStreak };
      setChars(m);
    }).catch(() => {});
    return () => { live = false; };
  }, [codes.length]);

  const cards = useMemo(() => codes.map(code => {
    const s = allStocks.find(x => x.code === code);
    const lq = liveQ[code];
    const v = verdicts[code];
    const price = lq?.price ?? s?.price ?? 0;
    const chgNow = lq?.changePercent ?? s?.changePercent;
    // 預算試算（張）：可買張數、成本、目標價、扣費稅純利
    const lots = price > 0 ? Math.floor(budget / (price * 1000)) : 0;
    const shares = lots * 1000;
    const cost = shares * price;
    const buyFee = shares > 0 ? Math.max(20, Math.floor(cost * 0.001425)) : 0;
    const sellPrice = price > 0 ? +(price * (1 + profitTarget / 100)).toFixed(2) : 0;
    const sellValue = shares * sellPrice;
    const sellFee = shares > 0 ? Math.max(20, Math.floor(sellValue * 0.001425)) : 0;
    const tax = Math.floor(sellValue * (tradeDuration === 'day' ? 0.0015 : 0.003));
    const net = shares > 0 ? Math.round(sellValue - cost - buyFee - sellFee - tax) : 0;
    // 弱尾盤偵測（全市場120日統計：隔日均 -0.5%/筆、勝率40%——強力迴避濾網）
    const hi = lq?.high ?? (s as { high?: number })?.high ?? 0, lo = lq?.low ?? (s as { low?: number })?.low ?? 0;
    const pos = hi > lo ? (price - lo) / (hi - lo) : null;
    const weakClose = pos != null && pos <= 0.2 && Math.abs(chgNow ?? 0) > 1;
    const row = margins[code];
    const sqzSetup = !!(row && row[3] != null && (row[7] || 0) >= 300 && (row[3] || 0) >= (row[7] || 0) * 0.005);
    const comp = computeComposite({
      baseWin: v?.win, tier: v?.tier, price, chg: chgNow,
      high: hi || undefined, low: lo || undefined, hi20: row?.[6], sqzSetup, c5: row?.[8], mktChg: idxChg, charLabel: chars[code]?.label,
      mgChg: row?.[1], foreignToday: v?.f, distributedPct: v?.dist, k9: row?.[9], belowMA5: row?.[10] as unknown as boolean | null, vol20: row?.[11],   // marginSnap[10]＝跌破5日線布林、[11]＝20日波動%
    });
    return { code, name: s?.name, market: s?.market, price, chg: chgNow, vol: lq?.volume ?? s?.volume, v, char: chars[code], lots, cost: cost + buyFee, sellPrice, net, weakClose, pos, row, comp };
  }), [codes, allStocks, verdicts, chars, budget, profitTarget, tradeDuration, margins, liveQ, idxChg]);

  const mBadge = (m?: string) => m === 'otc' ? { t: '櫃', c: '#f59e0b' } : { t: '市', c: '#3d8ef8' };

  return (
    <div style={{ padding: '14px 16px', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        <span style={{ fontSize: 20, fontWeight: 900 }}>🗒️ 決策工作台</span>
        <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>候選逐檔比對籌碼判讀＋勝率＋策略傾向＋預算試算 · 盤中 30 秒即時更新{liveAt ? `（${new Date(liveAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}）` : ''} · 非投資建議</span>
      </div>
      <PageHelp id="desk" />
      {/* 明日作戰四問：使用者核心需求的固定入口（明天買什麼／何時賣／想連抱／何時空手）。
          全部數字來自 audit-weights 2026-08-01 乾淨資料重測，滑鼠停留看完整版。 */}
      <div title={METRIC_TIPS.明日作戰四問} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0 10px', padding: '8px 12px', borderRadius: 10, background: 'rgba(125,211,252,0.07)', border: '1px solid rgba(125,211,252,0.25)', fontSize: 12, cursor: 'help', lineHeight: 1.7 }}>
        <b style={{ color: '#7dd3fc' }}>🎯 明日作戰四問</b>
        <span>①買什麼：撿尾盤濾網＋🥇A級（唯一費稅後淨正·開賣漲61%）</span>
        <span>②何時賣：隔日沖一律<b>明開盤賣</b></span>
        <span>③想連抱：波段起漲榜（空頭日限定·5日+1.10%）</span>
        <span>④空手：🚫危險級／🐑跟風／🔥過熱</span>
        <span style={{ color: 'var(--text-muted)' }}>（停留看實測依據）</span>
      </div>

      {codes.length === 0 ? (
        <div style={{ marginTop: 24, padding: '28px 20px', borderRadius: 14, textAlign: 'center', background: 'var(--bg-elevated)', border: '1px dashed var(--border-primary)', lineHeight: 2 }}>
          <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 6 }}>候選便條是空的</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            隔日沖選股流程：① 到 <b onClick={goPick} style={{ color: '#7dd3fc', cursor: 'pointer' }}>即時漲跌／法人籌碼</b> 分頁看資料<br />
            ② 看到有興趣的個股按「＋候選」撿進便條<br />
            ③ 回到這裡逐檔比對籌碼判讀與勝率，決策下單
          </div>
          <button onClick={goPick} style={{ marginTop: 14, padding: '9px 20px', borderRadius: 10, fontSize: 13, fontWeight: 800, cursor: 'pointer', border: 'none', background: 'linear-gradient(135deg,#3d8ef8,#7dd3fc)', color: '#fff' }}>→ 去即時漲跌撿股</button>
        </div>
      ) : (
        <>
          {/* 大盤 regime gate（回測：空頭日全體均 -0.43%/筆 vs 多頭日 -0.07%） */}
          {health && (() => {
            const h = health.health;
            const g = h >= 60 ? { t: '🟢 市場積極', c: '#f03e3e', note: '普漲環境——隔日沖順風，仍守單筆風險≤1%。' }
              : h >= 40 ? { t: '🟡 市場中性', c: '#eab308', note: '多空拉鋸——只挑最強訊號（🏔破高×強尾/⚡軋空），部位減半。' }
              : { t: '🔴 市場保守', c: '#2f9e44', note: '賣壓沉重——回測空頭日全體均 -0.43%/筆，隔日沖偏多建議休兵或極小部位。' };
            return (
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', margin: '10px 0 0', padding: '8px 12px', borderRadius: 10, background: `${g.c === '#eab308' ? 'rgba(234,179,8,0.08)' : g.c === '#f03e3e' ? 'rgba(240,62,62,0.07)' : 'rgba(47,158,68,0.08)'}`, border: `1px solid ${g.c}44`, fontSize: 12.5 }}>
                <b style={{ color: g.c === '#2f9e44' ? '#2f9e44' : g.c }}>{g.t}</b>
                <span>健康度 <b>{h}</b>/100 · {health.mood}</span>
                <span style={{ color: '#f03e3e' }}>▲{health.up.toLocaleString()}</span>
                <span style={{ color: '#2f9e44' }}>▼{health.down.toLocaleString()}</span>
                <span style={{ color: 'var(--text-muted)', flex: 1 }}>{g.note}</span>
              </div>
            );
          })()}

          {/* 試算參數列 */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', margin: '10px 0 14px', padding: '10px 12px', borderRadius: 10, background: 'rgba(148,163,184,0.06)', fontSize: 12.5 }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>預算
              <input type="number" value={budget} onChange={e => setBudget(+e.target.value)} step={10000}
                style={{ width: 100, padding: '3px 6px', borderRadius: 6, border: '1px solid var(--border-primary)', background: 'var(--bg-input)', color: 'var(--text-primary)' }} /> 元
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>獲利目標
              <input type="number" value={profitTarget} onChange={e => setProfitTarget(+e.target.value)} step={0.5}
                style={{ width: 60, padding: '3px 6px', borderRadius: 6, border: '1px solid var(--border-primary)', background: 'var(--bg-input)', color: 'var(--text-primary)' }} /> %
            </label>
            <span style={{ display: 'inline-flex', gap: 4 }}>
              {(['day', 'swing'] as const).map(d => (
                <button key={d} onClick={() => setTradeDuration(d)}
                  style={{ padding: '3px 10px', borderRadius: 10, fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
                    border: `1px solid ${tradeDuration === d ? 'rgba(246,160,106,0.6)' : 'var(--border-primary)'}`,
                    background: tradeDuration === d ? 'rgba(246,160,106,0.14)' : 'transparent', color: tradeDuration === d ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                  {d === 'day' ? '當沖(稅0.15%)' : '隔日/波段(稅0.3%)'}
                </button>
              ))}
            </span>
            <button onClick={clear} style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-muted)', background: 'transparent', border: '1px solid var(--border-primary)', borderRadius: 8, padding: '3px 10px', cursor: 'pointer' }}>清空候選</button>
          </div>

          <div style={{ display: 'grid', gap: 10 }}>
            {cards.map(c => {
              const b = mBadge(c.market);
              // 弱尾盤不再強制降級（2026-07-19 稽核：2年兩窗方向不穩，僅剩徽章提示）
              const stance = overnightStance(c.v);
              const open = openCode === c.code;
              return (
                <div key={c.code} style={{ borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', overflow: 'hidden' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 12px' }}>
                    <span onClick={() => navigateTo('stock', c.code)} style={{ fontWeight: 800, color: '#7dd3fc', cursor: 'pointer' }}>{c.code}</span>
                    <span onClick={() => navigateTo('stock', c.code)} style={{ fontWeight: 700, cursor: 'pointer' }}>{c.name || '—'}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 5, background: `${b.c}22`, color: b.c }}>{b.t}</span>
                    {c.price > 0 && <span style={{ color: 'var(--text-secondary)' }}>{c.price}</span>}
                    {c.chg != null && <span style={{ fontWeight: 800, color: c.chg >= 0 ? '#f03e3e' : '#2f9e44' }}>{c.chg >= 0 ? '+' : ''}{c.chg.toFixed(1)}%</span>}
                    {c.char?.label && <span style={{ fontSize: 10.5, fontWeight: 800, padding: '1px 7px', borderRadius: 6, background: c.char.label === '炒作型' ? 'rgba(240,62,62,0.14)' : c.char.label === '長期核心' ? 'rgba(61,142,248,0.14)' : 'rgba(148,163,184,0.12)', color: c.char.label === '炒作型' ? '#f03e3e' : c.char.label === '長期核心' ? '#3d8ef8' : '#94a3b8' }}>{c.char.label}{c.char.spec != null ? ` ${c.char.spec}` : ''}</span>}
                    {/* 策略傾向 + 勝率 */}
                    <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <span title="綜合評分＝勝率雷達基底＋實證訊號效應量（詳見說明書）" style={{ fontSize: 12, fontWeight: 900, padding: '1px 8px', borderRadius: 7, background: 'rgba(167,139,250,0.15)', color: '#c4b5fd' }}>🧬{c.comp.score}</span>
                      {c.v?.win != null && <span style={{ fontSize: 11.5, fontWeight: 700, color: '#7dd3fc' }}>開賣漲 {c.v.win}%</span>}
                      <span style={{ fontSize: 12.5, fontWeight: 900, color: stance.c }}>{stance.t}</span>
                      <AddCandidateButton code={c.code} variant="chip" />
                      <button onClick={() => setOpenCode(open ? null : c.code)} style={{ fontSize: 12, color: 'var(--text-muted)', background: 'transparent', border: '1px solid var(--border-primary)', borderRadius: 8, padding: '2px 8px', cursor: 'pointer' }}>{open ? '收合' : '展開'}</button>
                    </span>
                  </div>
                  {/* 判讀理由 + 策略註記 */}
                  <div style={{ padding: '0 12px 10px' }}>
                    {c.v ? <VerdictStrip v={c.v} /> : null}
                    {/* 實證訊號徽章＋收位 */}
                    {(c.comp.badges.length > 0 || c.comp.pos != null) && (
                      <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 11.5 }}>
                        {c.comp.badges.map(bd => <span key={bd.t} title={bd.tip} style={{ fontWeight: 800, padding: '1px 8px', borderRadius: 8, background: `${bd.c}1c`, color: bd.c, border: `1px solid ${bd.c}55` }}>{bd.t}</span>)}
                        {c.comp.pos != null && <span style={{ color: 'var(--text-muted)' }}>收位 {Math.round(c.comp.pos * 100)}%</span>}
                      </div>
                    )}
                    {/* 資券借券（t-1）＋三法人 20 日 */}
                    {(c.row || c.char?.f20 != null) && (
                      <div style={{ marginTop: 6, display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-secondary)', padding: '5px 8px', borderRadius: 8, background: 'rgba(167,139,250,0.06)' }}>
                        {c.row && <>
                          <span style={{ fontWeight: 800, color: '#a78bfa' }}>🧬 資券借券(張)</span>
                          <span title={METRIC_TIPS.融資} style={{ cursor: 'help' }}>融資 <b>{c.row[0]?.toLocaleString() ?? '—'}</b><b style={{ fontSize: 10.5, color: (c.row[1] ?? 0) > 0 ? '#f03e3e' : (c.row[1] ?? 0) < 0 ? '#2f9e44' : 'var(--text-muted)' }}>({(c.row[1] ?? 0) >= 0 ? '+' : ''}{c.row[1]?.toLocaleString() ?? 0})</b></span>
                          <span title={METRIC_TIPS.融券} style={{ cursor: 'help' }}>融券 <b>{c.row[2]?.toLocaleString() ?? '—'}</b><b style={{ fontSize: 10.5, color: (c.row[3] ?? 0) > 0 ? '#f03e3e' : (c.row[3] ?? 0) < 0 ? '#2f9e44' : 'var(--text-muted)' }}>({(c.row[3] ?? 0) >= 0 ? '+' : ''}{c.row[3]?.toLocaleString() ?? 0})</b></span>
                          <span title={METRIC_TIPS.借券} style={{ cursor: 'help' }}>借券 <b>{c.row[4]?.toLocaleString() ?? '—'}</b><b style={{ fontSize: 10.5, color: (c.row[5] ?? 0) > 0 ? '#f03e3e' : (c.row[5] ?? 0) < 0 ? '#2f9e44' : 'var(--text-muted)' }}>({(c.row[5] ?? 0) >= 0 ? '+' : ''}{c.row[5]?.toLocaleString() ?? 0})</b></span>
                          {(c.row[0] ?? 0) > 0 && c.row[2] != null && <span title={METRIC_TIPS.券資比} style={{ cursor: 'help' }}>券資比 <b>{(((c.row[2] ?? 0) / (c.row[0] ?? 1)) * 100).toFixed(1)}%</b></span>}
                          {c.row[6] != null && <span title={METRIC_TIPS['20日高']} style={{ cursor: 'help' }}>20日高 <b>{c.row[6]}</b>{c.price > (c.row[6] ?? Infinity) ? <b style={{ color: '#f03e3e' }}>（已突破）</b> : null}</span>}
                        </>}
                        {c.char?.f20 != null && (
                          <span style={{ display: 'inline-flex', gap: 8 }}>
                            <span style={{ fontWeight: 800, color: '#f6a06a' }}>20日</span>
                            {([['外', c.char.f20, c.char.fStreak], ['投', c.char.t20, c.char.tStreak], ['自', c.char.d20, c.char.dStreak]] as [string, number | undefined, number | undefined][]).map(([lb, v0, st]) => (
                              <span key={lb as string}>{lb}<b style={{ color: (v0 ?? 0) > 0 ? '#f03e3e' : (v0 ?? 0) < 0 ? '#2f9e44' : 'var(--text-muted)' }}>{(v0 ?? 0) >= 0 ? '+' : ''}{(v0 ?? 0).toLocaleString()}</b>{st != null && Math.abs(st) >= 2 ? <i style={{ fontSize: 10, fontStyle: 'normal', color: st > 0 ? '#f03e3e' : '#2f9e44' }}>({st > 0 ? `連買${st}` : `連賣${-st}`})</i> : null}</span>
                            ))}
                          </span>
                        )}
                      </div>
                    )}
                    {/* 榜單出現 */}
                    <div style={{ marginTop: 6, display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-muted)' }}>
                      <span>🪣 撿尾盤 {boards.tail[c.code] ? <b style={{ color: '#f03e3e' }}>#{boards.tail[c.code].rank}{boards.tail[c.code].grade ? `·${boards.tail[c.code].grade}` : ''}{boards.tail[c.code].score != null ? `(${boards.tail[c.code].score})` : ''}</b> : '未上榜'}</span>
                      <span>🚀 漲停預測 {boards.lu[c.code] ? <b style={{ color: '#fda4af' }}>#{boards.lu[c.code]}</b> : '未上榜'}</span>
                      <span>📡 雷達 {boards.radar[c.code]?.length ? <b style={{ color: '#7dd3fc' }}>{boards.radar[c.code].join('·')}</b> : '未命中'}</span>
                    </div>
                    {/* 事件檢查＋處置＋族群強弱 */}
                    {(eventsBy[c.code]?.length || riskBy[c.code] || indBy[c.code]) && (
                      <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 11.5 }}>
                        {riskBy[c.code] && <span style={{ fontWeight: 800, padding: '1px 8px', borderRadius: 8, background: 'rgba(240,62,62,0.12)', color: '#f87171', border: '1px solid rgba(240,62,62,0.4)' }}>🚨 {riskBy[c.code]}{riskBy[c.code] === '處置中' ? '（分盤撮合·流動性差）' : ''}</span>}
                        {(eventsBy[c.code] || []).map(e => (
                          <span key={e.date + e.title} style={{ fontWeight: 700, padding: '1px 8px', borderRadius: 8, background: 'rgba(245,159,0,0.10)', color: '#f59f00', border: '1px solid rgba(245,159,0,0.4)' }}>📅 {e.date.slice(5)} {e.title}</span>
                        ))}
                        {indBy[c.code] && (() => {
                          const norm = (x: string) => x.replace(/業|及|類/g, '');
                          const w = wind.find(w0 => norm(indBy[c.code]).includes(norm(w0.ind)) || norm(w0.ind).includes(norm(indBy[c.code])));
                          const wc = w ? (w.hot ? '#f03e3e' : w.trend === '升溫' ? '#f97316' : w.trend === '降溫' ? '#2f9e44' : '#94a3b8') : '#94a3b8';
                          return <span style={{ padding: '1px 8px', borderRadius: 8, background: `${wc}14`, color: wc, border: `1px solid ${wc}44`, fontWeight: 700 }}>🏭 {indBy[c.code]}{w ? ` · ${w.hot ? '熱' : w.trend}(5日${w.cnt5}板)` : ' · 冷'}</span>;
                        })()}
                      </div>
                    )}
                    <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>{stance.note}</div>
                    {/* 預算試算 */}
                    {c.price > 0 && (
                      <div style={{ marginTop: 6, display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-muted)' }}>
                        <span>可買 <b style={{ color: 'var(--text-primary)' }}>{c.lots > 0 ? `${c.lots} 張` : '預算不足'}</b></span>
                        {c.lots > 0 && <>
                          <span>成本 <b style={{ color: 'var(--text-primary)' }}>{c.cost.toLocaleString()} 元</b></span>
                          <span>目標價 <b style={{ color: '#7dd3fc' }}>{c.sellPrice}</b>（+{profitTarget}%）</span>
                          <span>扣費稅純利 <b style={{ color: c.net >= 0 ? '#f03e3e' : '#2f9e44' }}>{c.net >= 0 ? '+' : ''}{c.net.toLocaleString()} 元</b></span>
                        </>}
                      </div>
                    )}
                    {open && (() => {
                      const cds = candlesMap[c.code];
                      const closes = cds?.map(x => x.close) ?? [];
                      const maLast = (n: number) => closes.length >= n ? +(closes.slice(-n).reduce((a2, b2) => a2 + b2, 0) / n).toFixed(2) : null;
                      const ma5 = maLast(5), ma20 = maLast(20), ma60 = maLast(60);
                      const dev = (m: number | null) => m && c.price > 0 ? `${((c.price / m - 1) * 100) >= 0 ? '+' : ''}${((c.price / m - 1) * 100).toFixed(1)}%` : '—';
                      const stopRef = cds && cds.length >= 2 ? (c.price > cds[cds.length - 1].low ? cds[cds.length - 1].low : cds[cds.length - 2].low) : null;
                      const riskLots = stopRef != null && c.price > stopRef ? Math.max(0, Math.floor((budget * 0.01) / ((c.price - stopRef) * 1000))) : null;
                      const mode = chartMode[c.code] ?? 'live';
                      const stockInfo = allStocks.find(x2 => x2.code === c.code);
                      return (
                        <div style={{ marginTop: 8 }} onClick={e => e.stopPropagation()}>
                          {/* 五檔委買委賣（盤中即時，僅供當下參考） */}
                          <div style={{ marginBottom: 6 }}><OrderBookDepth code={c.code} price={c.price > 0 ? c.price : undefined} /></div>
                          {/* 均線讀值＋停損/1%風險部位（隔日沖鐵律工具化） */}
                          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-secondary)', padding: '5px 8px', borderRadius: 8, background: 'rgba(61,142,248,0.06)', marginBottom: 6 }}>
                            {candleLoading[c.code] && <span style={{ color: 'var(--text-muted)' }}>載入日K…</span>}
                            {cds && <>
                              <span>MA5 <b style={{ color: '#f59e0b' }}>{ma5 ?? '—'}</b><i style={{ fontStyle: 'normal', fontSize: 10.5, color: ma5 && c.price >= ma5 ? '#f03e3e' : '#2f9e44' }}>({dev(ma5)})</i></span>
                              <span>MA20 <b style={{ color: '#3d8ef8' }}>{ma20 ?? '—'}</b><i style={{ fontStyle: 'normal', fontSize: 10.5, color: ma20 && c.price >= ma20 ? '#f03e3e' : '#2f9e44' }}>({dev(ma20)})</i></span>
                              <span>MA60 <b style={{ color: '#a78bfa' }}>{ma60 ?? '—'}</b><i style={{ fontStyle: 'normal', fontSize: 10.5, color: ma60 && c.price >= ma60 ? '#f03e3e' : '#2f9e44' }}>({dev(ma60)})</i></span>
                              {ma5 != null && ma20 != null && <span style={{ fontWeight: 800, color: ma5 >= ma20 ? '#f03e3e' : '#2f9e44' }}>{ma5 >= ma20 ? '多頭排列' : '空頭排列'}{ma20 != null && ma60 != null ? (ma5 >= ma20 && ma20 >= ma60 ? '(全)' : '') : ''}</span>}
                              {stopRef != null && <span>停損參考(前低) <b style={{ color: '#fbbf24' }}>{stopRef}</b><i style={{ fontStyle: 'normal', fontSize: 10.5, color: 'var(--text-muted)' }}>(-{c.price > 0 ? ((1 - stopRef / c.price) * 100).toFixed(1) : '—'}%)</i></span>}
                              {riskLots != null && <span title={METRIC_TIPS.風險1} style={{ cursor: 'help' }}>1%風險建議 <b style={{ color: '#7dd3fc' }}>{Math.min(riskLots, c.lots) > 0 ? `${Math.min(riskLots, c.lots)} 張` : '不足1張'}</b></span>}
                            </>}
                          </div>
                          {/* 圖表切換：即時走勢 / 日K均線 */}
                          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                            {([['live', '📈 即時走勢'], ['kline', '📊 日K·均線']] as const).map(([k2, lb]) => (
                              <button key={k2} onClick={() => setChartMode(m2 => ({ ...m2, [c.code]: k2 }))}
                                style={{ padding: '3px 12px', borderRadius: 10, fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
                                  border: `1px solid ${mode === k2 ? 'rgba(125,211,252,0.55)' : 'var(--border-primary)'}`,
                                  background: mode === k2 ? 'rgba(125,211,252,0.12)' : 'transparent', color: mode === k2 ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                                {lb}
                              </button>
                            ))}
                          </div>
                          {mode === 'live'
                            ? <StockTrendChart code={c.code} name={c.name || c.code} closePrice={c.price} changePercent={c.chg} />
                            : (stockInfo && cds
                              ? <TechnicalChart candles={cds} stock={stockInfo as StockInfo} loading={!!candleLoading[c.code]} />
                              : <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '10px 4px' }}>{candleLoading[c.code] ? '日K載入中…' : '日K資料暫無法取得。'}</div>)}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ marginTop: 12, fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.8 }}>
            ⚠ 策略傾向由「回測背書的籌碼判讀（前一交易日 EOD）＋勝率雷達」綜合，非即時保證；勝率為歷史估計。
            試算費率：手續費 0.1425%（未計折讓）、證交稅 {tradeDuration === 'day' ? '0.15%（當沖）' : '0.3%'}。進場鐵律：單筆風險≤1%、破前低停損。非投資建議。
          </div>
        </>
      )}
    </div>
  );
}
