'use client';

// ── 盤中戰情「🧬 籌碼推選」分頁（法人×資券×借券×實證訊號×綜合評分）──
// 五榜：分級排行(綜合評分)／累計總籌碼／布局排行／法人加碼統計／完整總表(法人分別已整合)。
// 資料：/api/ai/chip-picks（daemon chipPicks；法人 t-1、名稱價格即時）。非投資建議。

import { useEffect, useState } from 'react';
import StockTrendChart from '@/components/WatchlistTracker/StockTrendChart';
import { usePickControls, applyPick, PickBar, PickMore } from '@/components/shared/PickControls';
import { useAppStore } from '@/lib/store';
import AddCandidateButton from '@/components/Candidates/AddCandidateButton';
import OnlyCandidatesToggle from '@/components/Candidates/OnlyCandidatesToggle';
import { computeComposite, type SignalBadge } from '@/lib/composite-score';
import { METRIC_TIPS } from '@/lib/metric-tips';
import HitRate from '@/components/shared/HitRate';

interface Pick {
  code: string; name: string; market: string; price: number | null; chg: number;
  tier: 'S' | 'A' | 'B+' | 'B' | 'watch' | 'danger'; tierLabel: string; win: number | null; danger: boolean; streak: number;
  f: number; t: number; d: number; foreignCum: number; trustCum: number; dealerCum: number; totalCum: number; distributedPct: number;
  mg?: [number, number] | null; sh?: [number, number] | null; ln?: [number, number] | null; sqz?: boolean; hi20?: number | null; c5?: number | null; char?: string | null; k9?: number | null; bm5?: boolean | null; vol20?: number | null;
}
interface AccumItem {
  code: string; name: string; market: string; price: number;
  added: number; addedXVol: number | null; valueE8: number; buyDays: number; days: number;
  rise: number; dumpRisk: number; stage: string; lu60: number;
}
interface ChipPicks {
  found: boolean; updatedAt: number; dataDate: string;
  counts?: { graded: number; layout: number; universe: number };
  graded: Pick[]; totalCum: Pick[]; byForeign: Pick[]; byTrust: Pick[]; byDealer: Pick[]; layout: Pick[];
  accum?: AccumItem[]; accumAnchor?: { addLots: number; addXVol: number; days: number; risePct: number };
}

type View = 'graded' | 'totalCum' | 'layout' | 'accum' | 'character';

const VIEWS: { key: View; label: string; hint: string }[] = [
  { key: 'graded', label: '🏆 分級排行推選', hint: '勝率雷達分級（S/A/B+/B）×實證訊號綜合評分：🧬分數＝2年實測勝率基底(42~50)＋🏔破高×強尾+2/⚡軋空+2/💪強尾單獨−2/🪤接棒−2/倒貨≥30%−1（2026-07-19 稽核修正，僅留兩窗穩定項）。≥52＝相對最強分組，但單獨進場淨期望≈0——淨正做法＝高分∧撿尾盤定版濾網∧明早開盤賣；≤45 避開依舊有效。展開看資券借券。' },
  { key: 'totalCum', label: '📊 累計總籌碼', hint: '個股近 20 日三大法人累計淨買超（外＋投＋自）排行' },
  { key: 'layout', label: '🧭 布局排行', hint: '外資連買≥2 日、漲幅未過度、未倒貨的早期卡位（尚未噴出）' },
  { key: 'accum', label: '📈 法人加碼統計', hint: '60日布局全貌：加碼次數/總價量/布局天數/倒貨風險進度（實證錨點：中位加碼3倍日均量·28日·漲21%後倒貨）' },
  { key: 'character', label: '📋 完整總表', hint: '全部有法人部位個股一列看齊：外資／投信／自營 20 日累計與連買連賣（法人分別已整合於此，可依各法人排序）＋「炒作 vs 長期持有」分類與炒作分數。' },
];

// ── 完整總表：籌碼性格分類 × 三法人分別持有狀態 ──
interface CharRow {
  code: string; label?: '長期核心' | '炒作型' | '一般'; spec?: number; core?: number;
  corr?: number; share?: number; bias?: number;
  // 三法人近 20 日累計淨買（張）與連買(+)/連賣(-)日數（daemon 由當前籌碼填入）
  f20?: number; t20?: number; d20?: number; fStreak?: number; tStreak?: number; dStreak?: number;
}
interface CharData { found: boolean; updatedAt?: number | null; window?: { from?: string; to?: string; days?: number } | null; counts?: { core?: number; spec?: number; normal?: number } | null; rows?: CharRow[] }
const CHAR_LABELS = ['全部', '炒作型', '長期核心', '一般'] as const;
const CHAR_STYLE: Record<string, { c: string; bg: string }> = {
  炒作型: { c: '#f03e3e', bg: 'rgba(240,62,62,0.14)' },
  長期核心: { c: '#3d8ef8', bg: 'rgba(61,142,248,0.14)' },
  一般: { c: '#94a3b8', bg: 'rgba(148,163,184,0.12)' },
};
// 法人行為過濾（與性格分類交集 AND）
const INST_FILTERS = ['不限', '投信買超', '外資買超', '同買', '對作', '倒貨中'] as const;
type InstFilter = (typeof INST_FILTERS)[number];
type CharSort = 'spec' | 'core' | 'corr' | 'share' | 'f20' | 't20' | 'd20' | 'total' | 'chg' | 'price';
const CHAR_SORTS: { key: CharSort; label: string }[] = [
  { key: 'spec', label: '炒作分' }, { key: 'core', label: '長抱分' },
  { key: 'corr', label: '籌碼領先' }, { key: 'share', label: '週轉佔量' },
  { key: 'f20', label: '外資累計' }, { key: 't20', label: '投信累計' },
  { key: 'd20', label: '自營累計' }, { key: 'total', label: '總累計' },
  { key: 'chg', label: '漲跌幅' }, { key: 'price', label: '價格' },
];

const TIER_STYLE: Record<Pick['tier'], { c: string; bg: string }> = {
  S: { c: '#f03e3e', bg: 'rgba(240,62,62,0.15)' },
  A: { c: '#e8590c', bg: 'rgba(232,89,12,0.15)' },
  'B+': { c: '#f59e0b', bg: 'rgba(245,158,11,0.15)' },
  B: { c: '#3d8ef8', bg: 'rgba(61,142,248,0.15)' },
  watch: { c: '#94a3b8', bg: 'rgba(148,163,184,0.12)' },
  danger: { c: '#2f9e44', bg: 'rgba(47,158,68,0.12)' },
};

// ── 綜合評分：共用實證加權（lib/composite-score）────────────────────
function compositeOf(p: Pick, live?: { high?: number; low?: number }): { score: number; badges: SignalBadge[] } {
  return computeComposite({
    baseWin: p.win, tier: p.tier, price: p.price, chg: p.chg,
    high: live?.high, low: live?.low, hi20: p.hi20, sqzSetup: p.sqz, c5: p.c5, charLabel: p.char,
    mgChg: p.mg?.[1], foreignToday: p.f, distributedPct: p.distributedPct, k9: p.k9, belowMA5: p.bm5, vol20: p.vol20,
  });
}

function isTwTradingHours(): boolean {
  const tw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const d = tw.getDay(); const v = tw.getHours() * 60 + tw.getMinutes();
  return d >= 1 && d <= 5 && v >= 9 * 60 && v < 13 * 60 + 35;
}

// ── 完整總表：籌碼性格分類 × 三法人分別持有狀態 ──
interface StoreStock { code: string; name?: string; price?: number; changePercent?: number; market?: string }
// 單一法人持有狀態小格：累計淨張（紅買綠賣）＋連買/連賣日數
function InstCell({ label, lots, streak }: { label: string; lots?: number; streak?: number }) {
  const has = lots != null;
  const c = !has ? 'var(--text-muted)' : lots > 0 ? '#f03e3e' : lots < 0 ? '#2f9e44' : 'var(--text-muted)';
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', minWidth: 52, lineHeight: 1.15 }}>
      <span style={{ fontSize: 'calc(9px * var(--fz))', color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontSize: 'calc(11.5px * var(--fz))', fontWeight: 800, color: c }}>{has ? (lots > 0 ? '+' : '') + lots.toLocaleString() : '—'}</span>
      {!!streak && Math.abs(streak) >= 2 && (
        <span style={{ fontSize: 'calc(8.5px * var(--fz))', fontWeight: 700, color: streak > 0 ? '#f03e3e' : '#2f9e44' }}>{streak > 0 ? `連買${streak}` : `連賣${-streak}`}</span>
      )}
    </span>
  );
}
function CharacterTable({ charData, allStocks, navigateTo, filter, setFilter, instFilter, setInstFilter, sort, setSort, limit, setLimit, onlyCand, candSet }: {
  charData: CharData | null; allStocks: StoreStock[]; navigateTo: (p: 'stock', code: string) => void;
  filter: (typeof CHAR_LABELS)[number]; setFilter: (f: (typeof CHAR_LABELS)[number]) => void;
  instFilter: InstFilter; setInstFilter: (f: InstFilter) => void;
  sort: CharSort; setSort: (s: CharSort) => void; limit: number; setLimit: (n: number) => void;
  onlyCand: boolean; candSet: Set<string>;
}) {
  const RESERVED = '⏳ 多模態預留：目前分類服務「隔日沖」；未來當沖／長期／波段模式將沿用同一分類、套用各自權重。';
  if (!charData) return <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', padding: '14px 4px' }}>載入完整總表…</div>;
  if (!charData.found) {
    return (
      <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', padding: '16px 8px', lineHeight: 1.9 }}>
        📋 完整總表準備中——正在回填 3 年法人籌碼並計算「炒作 vs 長期持有」分類。
        <br />完成後此處將列出全部有法人部位的個股，一列同時看外資／投信／自營各自持有狀態＋分類標籤＋炒作活躍度。
        <div style={{ marginTop: 8, fontSize: 'calc(11.5px * var(--fz))' }}>{RESERVED}</div>
      </div>
    );
  }
  const nameMap = new Map(allStocks.map(s => [s.code, s]));
  const liveOf = (r: CharRow) => {
    const s = nameMap.get(r.code);
    const total = (r.f20 ?? 0) + (r.t20 ?? 0) + (r.d20 ?? 0);
    return { chg: s?.changePercent ?? -Infinity, price: s?.price ?? -Infinity, total };
  };
  // 法人行為過濾（與性格 AND）
  const passInst = (r: CharRow) => {
    const f = r.f20 ?? 0, t = r.t20 ?? 0, d = r.d20 ?? 0;
    switch (instFilter) {
      case '投信買超': return t > 0;
      case '外資買超': return f > 0;
      case '同買': return f > 0 && t > 0;
      case '對作': return (f > 0 && t < 0) || (f < 0 && t > 0);
      case '倒貨中': return (r.fStreak ?? 0) <= -2 || (r.tStreak ?? 0) <= -2 || (d < 0 && f < 0);
      default: return true;
    }
  };
  const sortVal = (r: CharRow) => {
    if (sort === 'total') return liveOf(r).total;
    if (sort === 'chg') return liveOf(r).chg;
    if (sort === 'price') return liveOf(r).price;
    return (r[sort] as number | undefined) ?? -Infinity;
  };
  const base = (charData.rows || [])
    .filter(r => (onlyCand ? candSet.has(r.code) : true))
    .filter(r => filter === '全部' ? true : r.label === filter);
  const rows = base.filter(passInst).sort((a, b) => sortVal(b) - sortVal(a));
  const shown = rows.slice(0, limit);
  const c = charData.counts || {};
  const countOf = (f: string) => f === '全部' ? ((c.core ?? 0) + (c.spec ?? 0) + (c.normal ?? 0))
    : f === '炒作型' ? (c.spec ?? 0) : f === '長期核心' ? (c.core ?? 0) : (c.normal ?? 0);
  const mBadge = (m?: string) => m === 'otc' ? { t: '櫃', c: '#f59e0b' } : { t: '市', c: '#3d8ef8' };

  return (
    <div>
      {/* 性格分類過濾 */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 5, alignItems: 'center' }}>
        <span style={{ fontSize: 'calc(10.5px * var(--fz))', color: 'var(--text-muted)', minWidth: 30 }}>性格</span>
        {CHAR_LABELS.map(f => {
          const on = filter === f;
          const st = CHAR_STYLE[f] || { c: '#7dd3fc', bg: 'rgba(125,211,252,0.14)' };
          return (
            <button key={f} onClick={() => { setFilter(f); setLimit(50); }}
              style={{ padding: '3px 11px', borderRadius: 14, fontSize: 'calc(12px * var(--fz))', fontWeight: 800, cursor: 'pointer',
                border: `1px solid ${on ? `${st.c}88` : 'var(--border-primary)'}`, background: on ? st.bg : 'transparent',
                color: on ? 'var(--text-primary)' : 'var(--text-muted)' }}>
              {f} {countOf(f).toLocaleString()}
            </button>
          );
        })}
      </div>
      {/* 法人行為過濾 */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 5, alignItems: 'center' }}>
        <span style={{ fontSize: 'calc(10.5px * var(--fz))', color: 'var(--text-muted)', minWidth: 30 }}>法人</span>
        {INST_FILTERS.map(f => {
          const on = instFilter === f;
          return (
            <button key={f} onClick={() => { setInstFilter(f); setLimit(50); }}
              style={{ padding: '3px 10px', borderRadius: 13, fontSize: 'calc(11.5px * var(--fz))', fontWeight: 700, cursor: 'pointer',
                border: `1px solid ${on ? 'rgba(125,211,252,0.55)' : 'var(--border-primary)'}`,
                background: on ? 'rgba(125,211,252,0.14)' : 'transparent', color: on ? 'var(--text-primary)' : 'var(--text-muted)' }}>
              {f}
            </button>
          );
        })}
      </div>
      {/* 排序 */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 'calc(10.5px * var(--fz))', color: 'var(--text-muted)', minWidth: 30 }}>排序</span>
        {CHAR_SORTS.map(s => {
          const on = sort === s.key;
          return (
            <button key={s.key} onClick={() => setSort(s.key)}
              style={{ padding: '2px 9px', borderRadius: 12, fontSize: 'calc(11px * var(--fz))', fontWeight: 700, cursor: 'pointer',
                border: `1px solid ${on ? 'rgba(246,160,106,0.6)' : 'var(--border-primary)'}`,
                background: on ? 'rgba(246,160,106,0.14)' : 'transparent', color: on ? 'var(--text-primary)' : 'var(--text-muted)' }}>
              {s.label}
            </button>
          );
        })}
      </div>

      <div style={{ display: 'grid', gap: 3 }}>
        {shown.map(r => {
          const st = nameMap.get(r.code);
          const chg = st?.changePercent;
          const b = mBadge(st?.market);
          const ls = CHAR_STYLE[r.label || '一般'] || CHAR_STYLE['一般'];
          const specBar = Math.max(0, Math.min(100, r.spec ?? 0));
          return (
            <div key={r.code} onClick={() => navigateTo('stock', r.code)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', fontSize: 'calc(13px * var(--fz))', flexWrap: 'wrap',
                cursor: 'pointer', borderRadius: 8, background: 'rgba(148,163,184,0.06)',
                ...(candSet.has(r.code) ? { boxShadow: '0 0 0 1.5px rgba(245,159,0,0.7)' } : {}) }}>
              <span onClick={e => e.stopPropagation()}><AddCandidateButton code={r.code} variant="icon" /></span>
              <span style={{ fontWeight: 800, minWidth: 42, color: '#7dd3fc' }}>{r.code}</span>
              <span style={{ fontWeight: 600, minWidth: 60 }}>{st?.name || '—'}</span>
              <span style={{ fontSize: 'calc(10px * var(--fz))', fontWeight: 700, padding: '1px 5px', borderRadius: 5, background: `${b.c}22`, color: b.c }}>{b.t}</span>
              {st?.price != null && <span style={{ color: 'var(--text-secondary)', minWidth: 40 }}>{st.price}</span>}
              {chg != null && <span style={{ fontWeight: 800, minWidth: 46, color: chg >= 0 ? '#f03e3e' : '#2f9e44' }}>{chg >= 0 ? '+' : ''}{chg.toFixed(1)}%</span>}
              <span style={{ fontSize: 'calc(11px * var(--fz))', fontWeight: 800, padding: '1px 7px', borderRadius: 6, background: ls.bg, color: ls.c }}>{r.label || '一般'}</span>
              {/* 三法人分別 20 日持有狀態 */}
              <span style={{ display: 'inline-flex', gap: 8, alignItems: 'flex-start', padding: '0 4px', borderLeft: '1px solid var(--border-primary)', borderRight: '1px solid var(--border-primary)' }}>
                <InstCell label="外資" lots={r.f20} streak={r.fStreak} />
                <InstCell label="投信" lots={r.t20} streak={r.tStreak} />
                <InstCell label="自營" lots={r.d20} streak={r.dStreak} />
              </span>
              {/* 炒作活躍度 */}
              <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 'calc(10px * var(--fz))', color: 'var(--text-muted)' }}>炒作</span>
                <span style={{ width: 52, height: 7, borderRadius: 4, background: 'rgba(148,163,184,0.15)', overflow: 'hidden', display: 'inline-block' }}>
                  <span style={{ display: 'block', width: `${specBar}%`, height: '100%', background: specBar >= 62 ? '#f03e3e' : specBar >= 40 ? '#f59e0b' : '#94a3b8' }} />
                </span>
                <span style={{ fontSize: 'calc(11px * var(--fz))', fontWeight: 800, color: specBar >= 62 ? '#f03e3e' : 'var(--text-secondary)', width: 20 }}>{r.spec ?? '—'}</span>
                {r.corr != null && <span style={{ fontSize: 'calc(10.5px * var(--fz))', color: 'var(--text-muted)' }}>領先{r.corr.toFixed(2)}</span>}
              </span>
            </div>
          );
        })}
        {shown.length === 0 && <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', padding: '10px 4px' }}>此「{filter}×{instFilter}」條件下無標的，換個過濾。</div>}
      </div>
      {rows.length > limit && (
        <button onClick={() => setLimit(limit + 50)}
          style={{ marginTop: 8, width: '100%', padding: '7px', borderRadius: 8, fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, cursor: 'pointer',
            border: '1px solid var(--border-primary)', background: 'transparent', color: 'var(--text-secondary)' }}>
          顯示更多（{Math.min(limit, rows.length)}/{rows.length.toLocaleString()}）
        </button>
      )}
      <div style={{ marginTop: 8, fontSize: 'calc(11px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.7 }}>
        分類窗 {charData.window?.from}→{charData.window?.to}（{charData.window?.days} 日）· 三法人為近 20 日累計淨張（紅買綠賣、連買/連賣日數）· 炒作分＝週轉佔量＋籌碼領先＋建倉倒貨週期。
        <br />{RESERVED} 非投資建議。
      </div>
    </div>
  );
}

export default function ChipPicksPanel() {
  const [data, setData] = useState<ChipPicks | null>(null);
  const [view, setView] = useState<View>('graded');
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [gradedSort, setGradedSort] = useState<'tier' | 'comp'>('comp');
  const [ctl, setCtl] = usePickControls();
  // 完整總表
  const allStocks = useAppStore(s => s.allStocks);
  const navigateTo = useAppStore(s => s.navigateTo);
  // 只看候選（所有榜共用；用候選便條在本頁角度評估）
  const compareCodes = useAppStore(s => s.compareCodes);
  const [onlyCand, setOnlyCand] = useState(false);
  const candSet = new Set(compareCodes);
  const [charData, setCharData] = useState<CharData | null>(null);
  const [charFilter, setCharFilter] = useState<(typeof CHAR_LABELS)[number]>('炒作型');
  const [charInst, setCharInst] = useState<InstFilter>('不限');
  const [charSort, setCharSort] = useState<CharSort>('spec');
  const [charLimit, setCharLimit] = useState(50);

  useEffect(() => {
    let live = true;
    const load = () => fetch('/api/ai/chip-picks').then(r => (r.ok ? r.json() : null)).then(x => { if (live && x) setData(x); }).catch(() => {});
    load();
    const t = setInterval(load, isTwTradingHours() ? 60000 : 300000);
    return () => { live = false; clearInterval(t); };
  }, []);

  // 完整總表資料（分類每日更新，非即時）
  useEffect(() => {
    if (view !== 'character' || charData) return;
    let live = true;
    fetch('/api/ai/chip-character').then(r => (r.ok ? r.json() : null)).then(x => { if (live && x) setCharData(x); }).catch(() => {});
    return () => { live = false; };
  }, [view, charData]);

  if (!data) return <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', padding: '16px 4px' }}>載入法人籌碼推選…</div>;
  if (!data.found) return <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', padding: '16px 4px' }}>法人籌碼推選尚無資料（常駐服務下一週期產生）。</div>;

  const liveMap = new Map(allStocks.map(st => [st.code, st]));
  const srcAll0: Pick[] = view === 'graded' ? data.graded : view === 'totalCum' ? data.totalCum : view === 'layout' ? data.layout : [];
  const srcAll = view === 'graded' && gradedSort === 'comp'
    ? [...(srcAll0 || [])].sort((a, b) => compositeOf(b, liveMap.get(b.code) as { high?: number; low?: number }).score - compositeOf(a, liveMap.get(a.code) as { high?: number; low?: number }).score)
    : srcAll0;
  const src = onlyCand ? (srcAll || []).filter(p => candSet.has(p.code)) : srcAll;
  // 排序由榜別子分頁決定(保留來源名次)；PickBar 僅做價格區間篩選＋顯示更多。
  const { rows, filteredTotal } = applyPick(src || [], ctl, {
    price: p => p.price ?? -1, chg: p => p.chg, vol: p => p.totalCum,
    foreign: p => p.foreignCum, score: p => p.win ?? -Infinity,
  });
  const accumSrc = onlyCand ? (data.accum || []).filter(p => candSet.has(p.code)) : (data.accum || []);
  const { rows: accumRows, filteredTotal: accumTotal } = applyPick(accumSrc, ctl, {
    price: p => p.price, chg: p => p.rise, vol: p => p.added, foreign: p => p.added, score: p => p.dumpRisk,
  });
  const meta = VIEWS.find(v => v.key === view)!;
  const mBadge = (m: string) => m === 'otc' ? { t: '櫃', c: '#f59e0b' } : { t: '市', c: '#3d8ef8' };
  const Lots = ({ label, v }: { label: string; v: number }) => {
    const c = v > 0 ? '#f03e3e' : v < 0 ? '#2f9e44' : 'var(--text-muted)';
    return <span style={{ color: c, fontWeight: 700 }}>{label}{v >= 0 ? '+' : ''}{v.toLocaleString()}</span>;
  };

  return (
    <div style={{ flex: '1 1 100%', minWidth: 0, padding: '10px 12px', borderRadius: 12, background: 'rgba(232,89,12,0.05)', border: '1px solid rgba(232,89,12,0.22)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 900, color: '#f6a06a' }}>🧬 籌碼推選</span>
        <span style={{ fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)' }}>
          資料日 {data.dataDate} · 法人為 t-1（EOD 累計）× 即時價 · 宇宙 {data.counts?.universe ?? '—'} 檔 · 非投資建議
        </span>
      </div>

      {/* 榜別切換 */}
      {/* 命中率：追蹤 graded（分級排行推選），也就是本頁的主榜 */}
      <HitRate list="chipPicks" label="籌碼推選(分級榜)" />

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
        {VIEWS.map(v => {
          const on = view === v.key;
          return (
            <button key={v.key} onClick={() => { setView(v.key); setCtl(c => ({ ...c, limit: 30 })); }}
              style={{ padding: '5px 12px', borderRadius: 16, fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, cursor: 'pointer',
                border: `1px solid ${on ? 'rgba(246,160,106,0.6)' : 'var(--border-primary)'}`,
                background: on ? 'rgba(246,160,106,0.14)' : 'transparent',
                color: on ? 'var(--text-primary)' : 'var(--text-muted)' }}>
              {v.label}
            </button>
          );
        })}
      </div>
      {/* 分級排行的排序切換：綜合評分（實證加權）vs 級別
          ⚠ 這一列少了 flexWrap（2026-08-11 手機回報）：同檔其他篩選列都有，只有這裡漏掉。
            「🧬 綜合評分(實證加權)」單顆就要 ~150px，加上「🏆 級別」與標籤超過手機寬度，
            不換行就會被壓縮成多行殘字。 */}
      {view === 'graded' && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
          <span style={{ fontSize: 'calc(10.5px * var(--fz))', color: 'var(--text-muted)', flexShrink: 0 }}>排序</span>
          {([['comp', '🧬 綜合評分(實證加權)'], ['tier', '🏆 級別']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setGradedSort(k)}
              style={{ padding: '3px 10px', borderRadius: 12, fontSize: 'calc(11.5px * var(--fz))', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                border: `1px solid ${gradedSort === k ? 'rgba(167,139,250,0.6)' : 'var(--border-primary)'}`,
                background: gradedSort === k ? 'rgba(167,139,250,0.14)' : 'transparent',
                color: gradedSort === k ? 'var(--text-primary)' : 'var(--text-muted)' }}>
              {label}
            </button>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)', flex: '1 1 auto' }}>{meta.hint}</span>
        <OnlyCandidatesToggle on={onlyCand} setOn={setOnlyCand} />
      </div>

      {view !== 'character' && <PickBar ctl={ctl} setCtl={setCtl} priceOnly />}

      {view === 'character' ? (
        <CharacterTable
          charData={charData} allStocks={allStocks} navigateTo={navigateTo}
          filter={charFilter} setFilter={setCharFilter} instFilter={charInst} setInstFilter={setCharInst}
          sort={charSort} setSort={setCharSort} limit={charLimit} setLimit={setCharLimit}
          onlyCand={onlyCand} candSet={candSet}
        />
      ) : view === 'accum' ? (
        accumRows.length === 0 ? (
          <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', padding: '10px 4px' }}>目前無符合「布局中」條件的個股（需 60 日加碼≥1000 張且未倒貨）。</div>
        ) : (
          <>
            <div style={{ display: 'grid', gap: 4 }}>
              {accumRows.map(p => {
                const b = mBadge(p.market);
                const open = openCode === p.code;
                const rc = p.dumpRisk >= 80 ? '#ef4444' : p.dumpRisk >= 50 ? '#f59e0b' : '#22c55e';
                return (
                  <div key={p.code} style={{ borderRadius: 8, background: open ? 'rgba(61,142,248,0.10)' : 'rgba(148,163,184,0.06)', border: open ? '1px solid rgba(61,142,248,0.35)' : '1px solid transparent', ...(candSet.has(p.code) ? { boxShadow: '0 0 0 1.5px rgba(245,159,0,0.7)' } : {}) }}>
                    <div onClick={() => setOpenCode(c => c === p.code ? null : p.code)}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', fontSize: 'calc(13.5px * var(--fz))', flexWrap: 'wrap', cursor: 'pointer' }}>
                      <span style={{ fontSize: 'calc(11px * var(--fz))', color: 'var(--text-muted)', width: 12 }}>{open ? '▾' : '▸'}</span>
                      <span onClick={e => e.stopPropagation()}><AddCandidateButton code={p.code} variant="icon" /></span>
                      <span style={{ fontWeight: 800, minWidth: 42 }}>{p.code}</span>
                      <span style={{ fontWeight: 600, minWidth: 68 }}>{p.name}</span>
                      <span style={{ fontSize: 'calc(10px * var(--fz))', fontWeight: 700, padding: '1px 5px', borderRadius: 5, background: `${b.c}22`, color: b.c }}>{b.t}</span>
                      <span style={{ color: 'var(--text-secondary)' }}>{p.price}</span>
                      <span style={{ fontSize: 'calc(12px * var(--fz))', fontWeight: 800, color: '#f6a06a' }}>加碼 {p.added.toLocaleString()} 張{p.addedXVol != null ? `(${p.addedXVol}x日均)` : ''}</span>
                      <span style={{ fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-secondary)' }}>{p.valueE8} 億 · 布局 {p.days} 日 · 買超 {p.buyDays} 天</span>
                      <span style={{ fontSize: 'calc(11.5px * var(--fz))', fontWeight: 700, color: p.rise >= 0 ? '#f03e3e' : '#2f9e44' }}>期間{p.rise >= 0 ? '+' : ''}{p.rise}%</span>
                      {p.lu60 > 0 && <span style={{ fontSize: 'calc(10.5px * var(--fz))', color: 'var(--text-muted)' }}>3月{p.lu60}板</span>}
                      {/* 倒貨風險進度條 */}
                      <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 64, height: 7, borderRadius: 4, background: 'rgba(148,163,184,0.15)', overflow: 'hidden', display: 'inline-block' }}>
                          <span style={{ display: 'block', width: `${Math.min(100, p.dumpRisk)}%`, height: '100%', background: rc }} />
                        </span>
                        <span style={{ fontSize: 'calc(10.5px * var(--fz))', fontWeight: 800, color: rc }}>{p.stage}</span>
                      </span>
                    </div>
                    {open && (
                      <div style={{ padding: '4px 10px 10px' }} onClick={e => e.stopPropagation()}>
                        <div style={{ fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-secondary)', marginBottom: 6, lineHeight: 1.8 }}>
                          布局全貌：{p.days} 日內三大法人淨加碼 <b style={{ color: '#f6a06a' }}>{p.added.toLocaleString()} 張</b>（約 {p.valueE8} 億、佔日均量 {p.addedXVol ?? '—'} 倍、買超 {p.buyDays} 天）、期間股價 {p.rise >= 0 ? '+' : ''}{p.rise}%。
                          <br />倒貨風險進度 <b style={{ color: rc }}>{Math.min(150, p.dumpRisk)}%</b>——實證錨點：444 個布局案例中位在「漲 21%／加碼 3 倍日均量」後開始倒貨（倒貨後股價中位 −10%）。{p.dumpRisk >= 80 ? '已接近實證倒貨點，追高需極度謹慎。' : p.dumpRisk >= 50 ? '布局中段，留意外資是否先轉賣。' : '布局早期。'}
                          {p.lu60 > 0 && <><br /><span style={{ color: 'var(--text-muted)' }}>3 個月漲停 {p.lu60} 次（參考資訊——實證法人加碼≠漲停訊號，漲停是短線動能事件）</span></>}
                        </div>
                        <StockTrendChart code={p.code} name={p.name} closePrice={p.price} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <PickMore ctl={ctl} setCtl={setCtl} filteredTotal={accumTotal} />
            <div style={{ marginTop: 6, fontSize: 'calc(11px * var(--fz))', color: 'var(--text-muted)' }}>
              ⚠ 實證：法人加碼是「週〜月」布局，與漲停（短線動能）為不同因素（漲停前法人買超佔比 58% vs 全市場 48%）——此榜用於跟隨布局與提防倒貨，非漲停預測（漲停請看 🚀 漲停預測分頁）。非投資建議。
            </div>
          </>
        )
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', padding: '10px 4px' }}>此條件下無符合標的，換個榜別或價格區間。</div>
      ) : (
        <div style={{ display: 'grid', gap: 4 }}>
          {rows.map((p, i) => {
            const b = mBadge(p.market);
            const ts = TIER_STYLE[p.tier];
            const open = openCode === p.code;
            const rankNo = ctl.sorts.length === 0 && ctl.band === 0 ? i + 1 : null; // 原始名次(未重排時)
            return (
              <div key={p.code} style={{ borderRadius: 8, background: open ? 'rgba(61,142,248,0.10)' : 'rgba(148,163,184,0.06)', border: open ? '1px solid rgba(61,142,248,0.35)' : '1px solid transparent', ...(candSet.has(p.code) ? { boxShadow: '0 0 0 1.5px rgba(245,159,0,0.7)' } : {}) }}>
                <div onClick={() => setOpenCode(c => c === p.code ? null : p.code)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', fontSize: 'calc(13.5px * var(--fz))', flexWrap: 'wrap', cursor: 'pointer' }}>
                  <span style={{ fontSize: 'calc(11px * var(--fz))', color: 'var(--text-muted)', width: 12 }}>{open ? '▾' : '▸'}</span>
                  <span onClick={e => e.stopPropagation()}><AddCandidateButton code={p.code} variant="icon" /></span>
                  {rankNo && <span style={{ fontSize: 'calc(11px * var(--fz))', fontWeight: 800, color: 'var(--text-muted)', width: 18 }}>{rankNo}</span>}
                  <span style={{ fontSize: 'calc(11px * var(--fz))', fontWeight: 900, padding: '1px 6px', borderRadius: 6, background: ts.bg, color: ts.c }}>{p.tier}</span>
                  <span style={{ fontWeight: 800, minWidth: 42 }}>{p.code}</span>
                  <span style={{ fontWeight: 600, minWidth: 68 }}>{p.name}</span>
                  <span style={{ fontSize: 'calc(10px * var(--fz))', fontWeight: 700, padding: '1px 5px', borderRadius: 5, background: `${b.c}22`, color: b.c }}>{b.t}</span>
                  {p.price != null && <span style={{ color: 'var(--text-secondary)' }}>{p.price}</span>}
                  <span style={{ fontWeight: 800, color: p.chg >= 0 ? '#f03e3e' : '#2f9e44' }}>{p.chg >= 0 ? '+' : ''}{p.chg}%</span>
                  {p.win != null && <span style={{ fontSize: 'calc(11.5px * var(--fz))', fontWeight: 700, color: '#7dd3fc' }}>勝率 {p.win}%</span>}
                  {view === 'graded' && (() => { const cmp = compositeOf(p, liveMap.get(p.code) as { high?: number; low?: number }); return (
                    <>
                      <span title="綜合評分＝勝率雷達基底＋實證訊號加減分（點展開看資券）" style={{ fontSize: 'calc(11.5px * var(--fz))', fontWeight: 900, padding: '1px 7px', borderRadius: 7, background: 'rgba(167,139,250,0.15)', color: '#c4b5fd' }}>🧬{cmp.score}</span>
                      {cmp.badges.map(b => <span key={b.t} title={b.tip} style={{ fontSize: 'calc(10.5px * var(--fz))', fontWeight: 800, color: b.c }}>{b.t}</span>)}
                    </>
                  ); })()}
                  {p.streak >= 2 && <span style={{ fontSize: 'calc(11px * var(--fz))', fontWeight: 700, color: '#f03e3e', background: 'rgba(240,62,62,0.12)', padding: '1px 5px', borderRadius: 5 }}>外資連{p.streak}日</span>}
                  {p.distributedPct >= 50 && <span style={{ fontSize: 'calc(11px * var(--fz))', fontWeight: 700, color: '#e8590c' }}>倒貨{p.distributedPct}%</span>}
                  {/* graded/布局→今日法人(與分級一致)；累計/分別→20日累計 */}
                  {view === 'graded' || view === 'layout' ? (
                    <span style={{ marginLeft: 'auto', fontSize: 'calc(12px * var(--fz))', display: 'inline-flex', gap: 8 }}>
                      <span style={{ fontSize: 'calc(10.5px * var(--fz))', color: 'var(--text-muted)' }}>今日</span>
                      <Lots label="外" v={p.f} /><Lots label="投" v={p.t} /><Lots label="自" v={p.d} />
                    </span>
                  ) : (
                    <span style={{ marginLeft: 'auto', fontSize: 'calc(12px * var(--fz))', display: 'inline-flex', gap: 8 }}>
                      <span style={{ fontSize: 'calc(10.5px * var(--fz))', color: 'var(--text-muted)' }}>20日</span>
                      <Lots label="外" v={p.foreignCum} /><Lots label="投" v={p.trustCum} /><Lots label="自" v={p.dealerCum} />
                    </span>
                  )}
                </div>
                {open && (
                  <div style={{ padding: '4px 10px 10px' }} onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 'calc(12px * var(--fz))', marginBottom: 6, padding: '6px 8px', borderRadius: 8, background: 'rgba(148,163,184,0.06)' }}>
                      <span>勝率雷達 <b style={{ color: ts.c }}>{p.tier}級 · {p.tierLabel}</b></span>
                      <span>近20日累計 外<b style={{ color: p.foreignCum >= 0 ? '#f03e3e' : '#2f9e44' }}>{p.foreignCum >= 0 ? '+' : ''}{p.foreignCum.toLocaleString()}</b>／投<b style={{ color: p.trustCum >= 0 ? '#f03e3e' : '#2f9e44' }}>{p.trustCum >= 0 ? '+' : ''}{p.trustCum.toLocaleString()}</b>／自<b style={{ color: p.dealerCum >= 0 ? '#f03e3e' : '#2f9e44' }}>{p.dealerCum >= 0 ? '+' : ''}{p.dealerCum.toLocaleString()}</b> 張</span>
                      <span>今日 外<b style={{ color: p.f >= 0 ? '#f03e3e' : '#2f9e44' }}>{p.f >= 0 ? '+' : ''}{p.f.toLocaleString()}</b></span>
                    </div>
                    {(p.mg || p.sh || p.ln) && (
                      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 'calc(12px * var(--fz))', marginBottom: 6, padding: '6px 8px', borderRadius: 8, background: 'rgba(167,139,250,0.07)' }}>
                        <span style={{ fontWeight: 800, color: '#a78bfa' }}>🧬 資券借券(t-1·張)</span>
                        {p.mg && <span title={METRIC_TIPS.融資} style={{ cursor: 'help' }}>融資 <b>{p.mg[0].toLocaleString()}</b><b style={{ fontSize: 'calc(11px * var(--fz))', color: p.mg[1] > 0 ? '#f03e3e' : p.mg[1] < 0 ? '#2f9e44' : 'var(--text-muted)' }}>({p.mg[1] >= 0 ? '+' : ''}{p.mg[1].toLocaleString()})</b></span>}
                        {p.sh && <span title={METRIC_TIPS.融券} style={{ cursor: 'help' }}>融券 <b>{p.sh[0].toLocaleString()}</b><b style={{ fontSize: 'calc(11px * var(--fz))', color: p.sh[1] > 0 ? '#f03e3e' : p.sh[1] < 0 ? '#2f9e44' : 'var(--text-muted)' }}>({p.sh[1] >= 0 ? '+' : ''}{p.sh[1].toLocaleString()})</b></span>}
                        {p.ln && <span title={METRIC_TIPS.借券} style={{ cursor: 'help' }}>借券 <b>{p.ln[0].toLocaleString()}</b><b style={{ fontSize: 'calc(11px * var(--fz))', color: p.ln[1] > 0 ? '#f03e3e' : p.ln[1] < 0 ? '#2f9e44' : 'var(--text-muted)' }}>({p.ln[1] >= 0 ? '+' : ''}{p.ln[1].toLocaleString()})</b></span>}
                        {p.mg && p.mg[0] > 0 && p.sh && <span title={METRIC_TIPS.券資比} style={{ cursor: 'help' }}>券資比 <b>{(p.sh[0] / p.mg[0] * 100).toFixed(1)}%</b></span>}
                        {p.hi20 != null && <span title={METRIC_TIPS['20日高']} style={{ cursor: 'help' }}>20日高 <b>{p.hi20}</b>{(p.price ?? 0) > p.hi20 ? <b style={{ color: '#f03e3e' }}>（已突破）</b> : null}</span>}
                      </div>
                    )}
                    <StockTrendChart code={p.code} name={p.name} closePrice={p.price ?? 0} changePercent={p.chg} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {view !== 'accum' && view !== 'character' && <PickMore ctl={ctl} setCtl={setCtl} filteredTotal={filteredTotal} />}
      <div style={{ marginTop: 8, fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.7 }}>
        ⚠ 法人籌碼為前一交易日 EOD 累計（台股無盤中法人）；分級/勝率為回測估計，非即時保證。進場鐵律：單筆風險≤1%。非投資建議。
      </div>
    </div>
  );
}
