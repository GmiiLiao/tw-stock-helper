'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { auth } from '@/lib/firebase';

// ── 🚀 起漲影子名單（超級管理員）────────────────────────────────────
// 研究模型（GBDT，目標＝隔日收漲停）每個交易日盤後凍結名單（sha256 封印），隔一交易日收盤後對答案。
// 資料：scripts/surge-lab/a35_shadow_publish.mjs → surgeShadow/* → /api/admin/surge-shadow。
// 影子模式：不取代站上漲停預測；「歷史回推」是事後用同一套流程重算的名單，不是事前凍結的成績。

interface Cell { n: number; hit: number; buy: number }
interface DaySum { id: string; scoringDay: string; targetDay: string; kind: string; sha12: string; scored: boolean; nLimitUp: number | null; top10: Cell | null; top30: Cell | null; site10: Cell | null; site30: Cell | null }
interface HistCell { n: number; hit: number; buy: number; precision: number | null; wilson: [number, number] | null; block: [number, number] | null; buyable: number | null }
interface Index {
  generatedAt: string; days: DaySum[]; historyStatus?: 'ok' | 'mismatch' | 'missing';
  forward: { days: number; scored: number; top10: Cell; top30: Cell; site10: Cell; site30: Cell };
  history: { from: string | null; to: string | null; days: number; blockDays: number | null; lists: Record<string, HistCell> } | null;
}
interface Row { rank: number | null; code: string; name: string; market: string | null; close: number | null; chgPct: number | null; score: number | null; limitUpAtS: boolean | null; luStreakAtS: number | null; oneWordLockAtS: boolean | null; closeAtHigh: boolean | null; siteRank: number | null; lu: boolean | null; buyable: boolean | null }
interface Day {
  scoringDay: string; targetDay: string; kind: string; sha256: string; generatedAt: string | null;
  training: { trainCutoff: string | null; retrain: string | null };
  universe: { pool: number | null; poolByMarket: { tse: number | null; otc: number | null }; alreadyLimitUpInPool: number | null };
  site: { top30: string[]; dataDate: string | null };
  lists: Record<string, Row[]>;
  outcome: null | { nLimitUp: number | null; nBuyableLimitUp: number | null; baseRatePool: { all?: { rate: number | null } } | null; stats: Record<string, Record<string, Cell>>; siteTop30: Array<{ code: string; lu: boolean | null; buyable: boolean | null }>; warnings: string[] };
}
export interface Resp { found: boolean; index?: Index; day?: Day | null; dayId?: string | null; error?: string }

const LISTS: Array<[string, string]> = [
  ['overallTop30', '整體'], ['twseTop30', '上市'], ['tpexTop30', '上櫃'],
  ['freshTop30', '新起漲'], ['continuationTop30', '延續'], ['researchUniverseTop30', '研究母體'],
];
const KIND: Record<string, string> = { 'frozen-forward': '事前凍結', 'historical-would-have-been': '歷史回推' };
const MONO = "'JetBrains Mono',monospace";
const pct = (c: Cell | null | undefined) => (c && c.n ? `${c.hit}/${c.n}（${((c.hit / c.n) * 100).toFixed(1)}%）` : '—');
const p1 = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const ci = (v: [number, number] | null | undefined) => (v ? `${(v[0] * 100).toFixed(1)}～${(v[1] * 100).toFixed(1)}%` : '—');

function stateAtS(r: Row) {
  if (r.limitUpAtS) return `${r.oneWordLockAtS ? '一字' : ''}漲停${(r.luStreakAtS ?? 0) > 1 ? `·連${r.luStreakAtS}` : ''}`;
  return r.closeAtHigh ? '收最高' : '—';
}
function outcomeText(r: Row, scored: boolean): [string, string] {
  if (r.lu === null) return scored ? ['—', 'var(--text-muted)'] : ['待對答案', 'var(--text-muted)'];
  if (!r.lu) return ['✖ 未漲停', 'var(--text-muted)'];
  return r.buyable ? ['✅ 漲停·開盤買得到', 'var(--color-up)'] : ['🔒 漲停（開盤即鎖）', '#f59e0b'];
}

function Summary({ ix }: { ix: Index }) {
  const f = ix.forward; const h = ix.history; const L = h?.lists || {};
  return (
    <div style={{ padding: '10px 12px', borderRadius: 10, background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.25)', marginBottom: 12 }}>
      <b>🚀 起漲影子名單</b>：研究模型每個交易日<b>盤後凍結</b>「隔日會收漲停」的名單（sha256 封印、事後不可改），隔一交易日收盤後對答案。不取代站上漲停預測。
      <div style={{ marginTop: 6 }}>
        <b>事前凍結（真正的前向成績）</b>：{f.days} 日、已對答案 {f.scored} 日｜整體前10 {pct(f.top10)}{f.top10.n ? `（可買 ${f.top10.buy}）` : ''}、前30 {pct(f.top30)}｜同日站上前10 {pct(f.site10)}、前30 {pct(f.site30)}
        {f.scored < 20 && <span style={{ color: '#f59e0b' }}>　⚠ 樣本太少，還不能下結論</span>}
      </div>
      {ix.historyStatus === 'mismatch' && (
        <div style={{ marginTop: 4, color: '#f59e0b' }}>⚠ 歷史回推的合併統計與目前名單不一致（名單重產後尚未重跑對答案），暫不顯示合併數字。</div>
      )}
      {h && (
        <div style={{ marginTop: 4, color: 'var(--text-muted)' }}>
          <b>歷史回推</b>（{h.from}～{h.to}，{h.days} 日；事後用同一套流程重算，<u>不是</u>事前凍結）：整體前10 {p1(L['overallTop30@10']?.precision)}（{h.blockDays ?? 5} 日區塊 95% {ci(L['overallTop30@10']?.block)}；可買 {p1(L['overallTop30@10']?.buyable)}）vs 站上前10 {p1(L['site_top10@10']?.precision)}｜
          前30 {p1(L['overallTop30@30']?.precision)} vs 站上 {p1(L['site_top30@30']?.precision)}｜新起漲前10 {p1(L['freshTop30@10']?.precision)}、延續前10 {p1(L['continuationTop30@10']?.precision)}
        </div>
      )}
      <div style={{ marginTop: 4, color: 'var(--text-muted)' }}>「可買」＝隔日漲停且開盤價低於漲停價（開盤即鎖死的買不到）。命中多來自前一天已漲停的延續股。未扣成本；非投資建議。</div>
    </div>
  );
}

function ListTable({ rows, scored }: { rows: Row[]; scored: boolean }) {
  const th = { padding: '3px 10px', textAlign: 'right' as const, borderBottom: '1px solid var(--border-primary)', fontWeight: 600 };
  const td = { padding: '3px 10px', textAlign: 'right' as const };
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontFamily: MONO, fontSize: 'calc(13px * var(--fz))', whiteSpace: 'nowrap' }}>
        <thead><tr style={{ color: 'var(--text-muted)' }}>
          {['#', '代號', '名稱', '市場', '收盤', '漲跌%', '打分日', '分數', '站上名次', '隔日結果'].map(h => <th key={h} style={h === '名稱' || h === '隔日結果' ? { ...th, textAlign: 'left' } : th}>{h}</th>)}
        </tr></thead>
        <tbody>
          {rows.map(r => {
            const [t, c] = outcomeText(r, scored);
            return (
              <tr key={r.code} style={{ borderBottom: '1px solid var(--border-primary)' }}>
                <td style={td}>{r.rank ?? '—'}</td>
                <td style={{ ...td, fontWeight: 700 }}>{r.code}</td>
                <td style={{ ...td, textAlign: 'left' }}>{r.name}</td>
                <td style={td}>{r.market === 'otc' ? '櫃' : r.market === 'tse' ? '市' : '—'}</td>
                <td style={td}>{r.close ?? '—'}</td>
                <td style={{ ...td, color: (r.chgPct ?? 0) >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>{r.chgPct == null ? '—' : `${r.chgPct >= 0 ? '+' : ''}${r.chgPct}`}</td>
                <td style={td}>{stateAtS(r)}</td>
                <td style={td}>{r.score ?? '—'}</td>
                <td style={td}>{r.siteRank ?? '—'}</td>
                <td style={{ ...td, textAlign: 'left', color: c, fontWeight: r.lu ? 700 : 400 }}>{t}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DayView({ day }: { day: Day }) {
  const [list, setList] = useState('overallTop30');
  const o = day.outcome; const st = o?.stats || {};
  const siteMarks = o ? o.siteTop30.map(s => `${s.code}${s.lu ? (s.buyable ? '✅' : '🔒') : ''}`).join(' ') : day.site.top30.join(' ');
  return (
    <div>
      <div style={{ color: 'var(--text-muted)', marginBottom: 6 }}>
        {day.scoringDay} 盤後 → 預測 {day.targetDay}｜{KIND[day.kind] ?? day.kind}｜{day.kind === 'frozen-forward' ? '凍結' : '產生（事後重算）'} {day.generatedAt ?? '—'}｜封印 {day.sha256.slice(0, 12)}｜訓練截止 {day.training.trainCutoff ?? '—'}｜
        候選池 {day.universe.pool ?? '—'} 檔（上市 {day.universe.poolByMarket.tse ?? '—'}／上櫃 {day.universe.poolByMarket.otc ?? '—'}；當日已漲停 {day.universe.alreadyLimitUpInPool ?? '—'}）
      </div>
      {o ? (
        <div style={{ marginBottom: 8 }}>
          <b>{day.targetDay} 對答案</b>：全市場漲停 {o.nLimitUp ?? '—'} 檔（開盤買得到 {o.nBuyableLimitUp ?? '—'}）、候選池基準 {p1(o.baseRatePool?.all?.rate)}｜
          本榜前10 {pct(st[list]?.['10'])}、前30 {pct(st[list]?.['30'])}｜站上前10 {pct(st.site_top10?.['10'])}、前30 {pct(st.site_top30?.['30'])}
          {o.warnings.length > 0 && <div style={{ color: '#f59e0b' }}>⚠ {o.warnings.join('；')}</div>}
        </div>
      ) : <div style={{ marginBottom: 8, color: '#f59e0b' }}>⏳ 尚未對答案（{day.targetDay} 收盤、兩市資料到齊後才對）</div>}
      <div role="tablist" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {LISTS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={list === k} onClick={() => setList(k)}
            style={{ padding: '3px 12px', borderRadius: 999, border: '1px solid var(--border-primary)', cursor: 'pointer', fontWeight: 700, fontSize: 'calc(12.5px * var(--fz))', background: list === k ? 'rgba(125,211,252,0.18)' : 'transparent', color: list === k ? '#7dd3fc' : 'var(--text-muted)' }}>{l}</button>
        ))}
      </div>
      <ListTable rows={day.lists[list] || []} scored={!!o} />
      <div style={{ marginTop: 8, color: 'var(--text-muted)', wordBreak: 'break-all' }}>同日站上漲停預測前30（{day.site.dataDate ?? '—'}）：{siteMarks || '—'}</div>
    </div>
  );
}

interface ViewProps { data: Resp; onPick: (dayId: string) => void; pendingId?: string | null; err?: string; onRetry?: () => void }

/** 純顯示（不碰驗證／網路）：資料由容器 SurgeShadow 讀 API 後傳入；切日中／切日失敗時保留原畫面。 */
export function SurgeShadowView({ data, onPick, pendingId = null, err = '', onRetry }: ViewProps) {
  if (!data.found || !data.index) return <div style={{ padding: 16, color: 'var(--text-muted)' }}>尚無影子名單——在 Mac 上執行 node scripts/surge-lab/a35_shadow_publish.mjs 發佈。</div>;
  const ix = data.index;
  return (
    <div style={{ fontSize: 'calc(13.5px * var(--fz))', lineHeight: 1.7 }}>
      <Summary ix={ix} />
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ color: 'var(--text-muted)' }}>打分日</span>
        <select value={pendingId ?? data.dayId ?? ''} onChange={e => onPick(e.target.value)}
          style={{ maxWidth: '100%', padding: '4px 8px', borderRadius: 8, background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)', fontFamily: MONO }}>
          {ix.days.map(d => (
            <option key={d.id} value={d.id}>{d.scoringDay}→{d.targetDay}｜{KIND[d.kind] ?? d.kind}｜{d.scored ? `前10 ${pct(d.top10)}` : '待對答案'}</option>
          ))}
        </select>
        {pendingId && <span style={{ color: 'var(--text-muted)' }}>載入中…</span>}
        {err && <span style={{ color: '#ef4444' }}>載入失敗：{err}{onRetry && <button type="button" onClick={onRetry} style={{ marginLeft: 8, padding: '1px 10px', borderRadius: 999, border: '1px solid #ef4444', background: 'transparent', color: '#ef4444', cursor: 'pointer' }}>重試</button>}</span>}
      </label>
      {data.day ? <DayView key={data.dayId ?? ''} day={data.day} /> : <div style={{ color: 'var(--text-muted)' }}>這一天沒有資料。</div>}
      <div style={{ marginTop: 10, color: 'var(--text-muted)' }}>影子實驗：研究模型名單，不取代站上漲停預測、不構成推薦；未扣成本；非投資建議。</div>
    </div>
  );
}

export default function SurgeShadow() {
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [lastWanted, setLastWanted] = useState<string | undefined>(undefined);
  const seq = useRef(0);   // 只接受最後一次請求的回應：快速切日時較晚抵達的舊回應不可蓋掉新選擇
  const load = useCallback(async (dayId?: string) => {
    const my = ++seq.current;
    setPendingId(dayId ?? null); setLastWanted(dayId); setErr('');
    try {
      const token = (await auth.currentUser?.getIdToken()) ?? '';
      const r = await fetch(`/api/admin/surge-shadow${dayId ? `?day=${encodeURIComponent(dayId)}` : ''}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
      let j: Resp | null = null;
      try { j = (await r.json()) as Resp; } catch { j = null; }
      if (my !== seq.current) return;
      if (!r.ok || !j) { setErr(`HTTP ${r.status}${j?.error ? `：${j.error}` : ''}`); setPendingId(null); return; }
      setData(j); setPendingId(null);
    } catch (e) {
      if (my !== seq.current) return;
      setErr(e instanceof Error ? e.message : String(e)); setPendingId(null);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const retry = () => void load(lastWanted);

  if (!data) {
    if (err) return <div style={{ padding: 16, color: '#ef4444' }}>載入失敗：{err} <button type="button" onClick={retry} style={{ marginLeft: 8, padding: '1px 10px', borderRadius: 999, border: '1px solid #ef4444', background: 'transparent', color: '#ef4444', cursor: 'pointer' }}>重試</button></div>;
    return <div style={{ padding: 16, color: 'var(--text-muted)' }}>載入中…</div>;
  }
  return <SurgeShadowView data={data} onPick={id => void load(id)} pendingId={pendingId} err={err} onRetry={retry} />;
}
