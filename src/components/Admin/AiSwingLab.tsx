'use client';

// ── 🤖 AI 實驗·波段持有（超級管理員專用；2026-09-24 UX 重整）───────────────
// 閱讀順序：①各持有期結論卡（AI 平均、超額、淨損益元）②挑日期 ③每檔一張卡：選股原因 → 預計買進 → 5/10/20/60/120 日交易單
//          （買進 09:00 開盤／賣出 13:30 收盤、金額、費稅、淨損益、先選後買查核）④整池基準 ⑤稽核（prompt 與原始回覆）⑥我的檢討。
import { useCallback, useEffect, useRef, useState } from 'react';
import { auth } from '@/lib/firebase';
import type { SwingLabDoc, SwingHorizonStat, SwingPick } from '../../../scripts/lib/ai-swing-lab.mjs';
import { Kpi, TradeSlip, NotesBox, Section, ListTable, Collapse, MONO, upDn, twd, pct, tw } from './AiLabParts';
import CostReference from '@/components/shared/CostReference';

const HS = [5, 10, 20, 60, 120];
interface Acct { initial: number; realized: number; equity: number; openCost: number; cash: number; openN: number; closedN: number; retPct: number; receivable?: number; payable?: number; settledCash?: number; reservedBuys?: number; pendingSellEst?: number; freeCash?: number }
interface OpenPos { date: string; code: string; name: string; shares: number; status: string }
interface SLeg { at: number | null; px: number; amount: number; fee: number; tax?: number }
type PosState = 'held' | 'selling' | 'pending';
export interface Holding { date: string; code: string; name: string; shares: number; horizon: number | null; reason?: string; sellReason?: string | null; state?: PosState; fillSource?: string | null; fillRecordedAt?: number | null; status: string; entryDate: string | null; entryAt: number | null; entryPx: number | null; cost: number; lastDate: string | null; lastPx: number | null; mktValue: number | null; buyFee?: number | null; estSellCost?: number | null; netValue?: number | null; unrealized: number | null; unrealizedPct: number | null; heldDays: number }
export interface Closed { date: string; code: string; name: string; shares: number; sellReason?: string; buyReason?: string; sellOrderDate?: string; sellSource?: string | null; sellRecordedAt?: number | null; buySource?: string | null; buy: SLeg; sell: SLeg; costTwd: number; pnlTwd: number; retPct: number; exitDate: string }
export interface HistRow { date: string; holdings: number; selling?: number; pending: number; opened: number; closed: number; closedPnl: number; realized: number; unrealized: number; cash: number; mktValue: number; netMkt?: number; estSellCost?: number; total: number; dayPnl: number; cumRetPct: number; flow?: number; netInvested?: number; growth?: number }
/** 帳戶摘要（與每日戰績同一口徑；scripts/lib/ai-swing-history.mjs） */
export interface Summary { initial: number; cash: number; mktValue: number; netMkt: number; estSellCost: number; total: number; totalPnl: number; totalRetPct: number; realized: number; unrealized: number; held: number; selling: number; pending: number; closedN: number; pool: number; reservedBuys: number; pendingSellEst: number; freeCash: number; receivable: number; payable: number }
// provisional＝今日已即時成交、日線尚未歸檔：市值用盤中即時價（liveAt），收盤歸檔後改以官方收盤重算（2026-10-01）
export interface Snapshot { at: number; dataDate: string | null; holdings: Holding[]; closed: Closed[]; history?: HistRow[]; provisional?: boolean; liveAt?: number | null }
interface Resp { snapshot?: Snapshot | null; summary?: Summary | null; account?: Acct; openPositions?: OpenPos[]; found: boolean; stats: Record<string, SwingHorizonStat>; byModel: Record<string, Record<string, SwingHorizonStat>>; days: { date: string; model: string | null; picks: string[]; settled: number[]; hasNotes: boolean }[]; detail: SwingLabDoc | null; error?: string }

const stateOf = (h: Holding): PosState => h.state ?? (h.entryPx ? (h.sellReason != null || /賣出委託/.test(h.status) ? 'selling' : 'held') : 'pending');
const sum = <T,>(xs: T[], f: (x: T) => number | null | undefined) => xs.reduce((a, x) => a + (f(x) ?? 0), 0);

async function authed(input: string, init: RequestInit = {}) {
  const token = (await auth.currentUser?.getIdToken()) ?? '';
  return fetch(input, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
}

export default function AiSwingLab() {
  const [data, setData] = useState<Resp | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [audit, setAudit] = useState(false);
  // G3-15：重載失敗時若已有資料就保留、只顯示小字錯誤（不整頁換成「載入失敗」）；
  //   請求序號擋亂序——只採用最後發出的那一次回應。
  const [loadErr, setLoadErr] = useState('');
  const seq = useRef(0);
  const load = useCallback(async (d: string | null) => {
    const my = ++seq.current;
    const fail = (next: Resp, why: string) => {
      setData(prev => (prev && !prev.error ? prev : next));
      setLoadErr(why);
    };
    try {
      const r = await authed(`/api/admin/ai-swing-lab${d ? `?date=${d}` : ''}`); const j = await r.json();
      if (my !== seq.current) return;
      if (r.ok) { setData(j); setLoadErr(''); } else fail({ ...j, found: false }, j?.error || '載入失敗');
    } catch {
      if (my !== seq.current) return;
      fail({ found: false, stats: {}, byModel: {}, days: [], detail: null, error: '載入失敗' }, '載入失敗');
    }
  }, []);
  useEffect(() => { load(date); }, [load, date]);

  if (!data) return <div style={{ padding: 16, color: 'var(--text-muted)' }}>載入中…</div>;
  if (data.error) return <div style={{ padding: 16, color: '#ef4444' }}>{data.error}</div>;
  const d = data.detail;
  const save = async (notes: string) => {
    if (!d) return;
    setMsg('儲存中…');
    const r = await authed('/api/admin/ai-swing-lab', { method: 'POST', body: JSON.stringify({ date: d.date, notes }) });
    const j = await r.json().catch(() => ({}));
    setMsg(r.ok ? '✓ 已儲存，15 分鐘內同步到第二大腦' : `✖ ${j.error || '儲存失敗'}`);
    if (r.ok) load(d.date);
  };

  return (
    <div style={{ fontSize: 'calc(13px * var(--fz))', lineHeight: 1.6 }}>
      <Collapse id="swing-rules" title="📘 帳戶規則" sub="50 萬模擬帳戶·AI 主動操作·T+2·現金不為負（點開看全文）" defaultOpen={false}>
        <div style={{ color: 'var(--text-muted)' }}>
        模擬帳戶 <b>50 萬</b>（與當沖帳戶不互通），<b>由 AI 主動操作</b>（2026-09-28 起）：每個交易日 17:00 後，本機 Ollama 先檢視現有持股決定<b>續抱或賣出換股</b>，再從本站波段榜（排除處置股）挑最多 5 檔買進；
        買賣都在<b>下一交易日 09:00 開盤成交</b>（盤後決定、防偷看）。不設單檔上限，資金池（50 萬＋已實現損益）內的現金依買進檔數平均分配、可零股、低於 1 萬不建倉，<b>現金不為負</b>（成交時依池內金額減量）；<b>T+2 交割</b>，賣出款可抵同一交割日的買進，處置股須已交割現金預收款；賣出的本金與獲利再投入（09-24～09-28 的部位為當時單筆 10 萬口徑，已一併交由 AI 管理）。
        <b>AI 交易能力：看帳戶總值與目標追蹤</b>；<b>選股眼光：看各持有期「超額」</b>（同部位若持有 h 日 vs 整池平均，研究用）。決策在盤後凍結、早於成交——交易單「✓ 先選後買」即查核。模擬交易，非投資建議。
        </div>
      </Collapse>
      {loadErr && <div style={{ color: '#ef4444', fontSize: 'calc(12.5px * var(--fz))', marginBottom: 8 }}>⚠ 重新載入失敗（{loadErr}）——下方為上一次成功載入的資料</div>}

      {data.summary && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0 4px' }}>
          <Kpi label="🏦 帳戶總值（起始 50 萬）" value={`${data.summary.total.toLocaleString()} 元`} color={upDn(data.summary.totalPnl)}
            sub={`總損益 ${twd(data.summary.totalPnl)}（${pct(data.summary.totalRetPct)}）＝ 現金 ${data.summary.cash.toLocaleString()} ＋ 持倉淨市值 ${data.summary.netMkt.toLocaleString()}`}
            hint={`持倉淨市值＝市值 ${data.summary.mktValue.toLocaleString()} − 若現在賣出的手續費與證交稅 ${data.summary.estSellCost.toLocaleString()}。待進場的委託買單尚未成交，錢仍在現金裡，不計入。`} />
          <Kpi label="損益拆解（已實現／未實現）" value={`${twd(data.summary.realized)}／${twd(data.summary.unrealized)}`} color={upDn(data.summary.realized + data.summary.unrealized)}
            sub={`已實現＝${data.summary.closedN} 筆已賣出；未實現＝${data.summary.held + data.summary.selling} 檔持有中（已扣買賣費稅）`} />
          <Kpi label="可下單資金" value={`${data.summary.freeCash.toLocaleString()} 元`}
            sub={`＝ 現金 ${data.summary.cash.toLocaleString()} − 委託買單保留 ${data.summary.reservedBuys.toLocaleString()} ＋ 委託賣單估計回收 ${data.summary.pendingSellEst.toLocaleString()}`}
            hint={`資金池（本金＋已實現，不含未實現）${data.summary.pool.toLocaleString()} 元。T+2 未交割：應收 ${data.summary.receivable.toLocaleString()}、應付 ${data.summary.payable.toLocaleString()}（現金已先扣應付、計入應收；賣出款可抵同一交割日的買進）。`} />
          <Kpi label="部位" value={`持有 ${data.summary.held}｜賣出委託 ${data.summary.selling}｜待進場 ${data.summary.pending}`} sub="賣出委託與待進場都在下一交易日 09:00 開盤成交" />
        </div>
      )}

      <DailyHistory history={data.snapshot?.history || []} />

      <Positions snapshot={data.snapshot} />

      <ClosedTrades closed={data.snapshot?.closed || []} />
      {data.found && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {HS.map(h => { const s = data.stats[h]; return (
            <Kpi key={h} label={`持有 ${h} 日（未扣成本）`} value={s?.n ? pct(s.avg) : '未到期'} color={upDn(s?.avg)}
              sub={s?.n ? `超額 ${pct(s.excess, 'pp')} · ${s.n} 筆 · ${twd(s.pnlTwd)}${s.n < 30 ? ' · 樣本少' : ''}` : '尚無結算'} hint={s?.n ? `整池平均 ${pct(s.poolAvg)}·贏池比例 ${s.beatPool}%·勝率 ${s.win}%` : undefined} />); })}
        </div>
      )}
      {data.found && <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', marginTop: 4 }}><CostReference holdDays={[5, 10, 20, 60, 120]} /></div>}
      {Object.keys(data.byModel).length > 1 && <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', marginTop: 4 }}>
        依模型：{Object.entries(data.byModel).map(([m, s]) => `${m}（20 日超額 ${pct(s[20]?.excess, 'pp')}，n=${s[20]?.n ?? 0}）`).join('｜')}
      </div>}

      <Section title="日期" sub="點日期看當天選股與各持有期交易單">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {!data.days.length && <span style={{ color: 'var(--text-muted)' }}>尚無記錄：下一個交易日 17:00 後開始</span>}
          {data.days.map(x => (
            <button key={x.date} onClick={() => { setDate(x.date); setMsg(''); setAudit(false); }}
              style={{ textAlign: 'left', padding: '5px 10px', borderRadius: 10, cursor: 'pointer', border: `1px solid ${d?.date === x.date ? '#7dd3fc' : 'var(--border-primary)'}`, background: d?.date === x.date ? 'rgba(125,211,252,0.12)' : 'transparent', color: 'var(--text-primary)' }}>
              <div style={{ fontWeight: 800, fontSize: 'calc(13px * var(--fz))' }}>{x.date.slice(5)}{x.hasNotes ? ' 📝' : ''}</div>
              <div style={{ ...MONO, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>選 {x.picks.length} 檔 · 已結算 {x.settled.length}/5</div>
            </button>
          ))}
        </div>
      </Section>

      {d && (
        <div style={{ marginTop: 12, padding: 12, borderRadius: 12, border: '1px solid var(--border-primary)' }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <span style={{ fontWeight: 900, fontSize: 'calc(16px * var(--fz))' }}>🔒 {d.date} 盤後決策</span>
            <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
              凍結 {tw(d.frozenAt, true)} · 模型 <b>{d.model?.name || '未知'}</b>{d.model?.parameterSize ? `·${d.model.parameterSize}·${d.model.quantization}` : ''}{d.model?.digest ? `·${d.model.digest.slice(0, 12)}` : ''} · 候選池 {d.pool.length} 檔 · {d.version}
            </span>
          </div>
          <div style={{ fontSize: 'calc(13.5px * var(--fz))', color: 'var(--text-muted)', marginTop: 2 }}>大盤：{d.market || '—'}　AI 看法：{d.note || '—'}</div>

          {d.review && (
            <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 10, background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <div style={{ fontWeight: 900, fontSize: 'calc(14px * var(--fz))' }}>🔄 持股檢視：{d.review.holdings.length} 檔 → 賣出 {d.review.sells.length} 檔、續抱 {d.review.holdings.length - d.review.sells.length} 檔
                {d.cashForBuys != null && <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>　買進資金 {d.cashForBuys.toLocaleString()} 元（含賣出估計回收款）</span>}</div>
              {d.review.sells.map(x => <div key={x.key} style={{ fontSize: 'calc(13.5px * var(--fz))' }}>🔻 賣出 <b>{x.code} {x.name}</b> {x.shares.toLocaleString()} 股（決定時收盤 {x.estPx ?? '—'}）：{x.reason}</div>)}
              {d.review.holdings.filter(h => !d.review!.sells.some(x => x.key === h.key)).map(h => <div key={h.key} style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)' }}>✋ 續抱 {h.code} {h.name}（{pct(h.pnlPct)}·已持有 {h.heldDays ?? '—'} 日）</div>)}
            </div>
          )}
          {!d.picks.length && <div style={{ marginTop: 10, color: 'var(--text-muted)' }}>當天未買進。</div>}
          {d.picks.map(p => <PickCard key={p.code} p={p} doc={d} />)}

          <Section title="整池基準" sub="同一天丟給 AI 的所有候選，同口徑等權平均（未扣成本）">
            <div style={{ ...MONO, display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 'calc(12.5px * var(--fz))' }}>
              {HS.map(h => <span key={h}>{h} 日 <b style={{ color: upDn(d.outcomes?.[h]?.pool?.avgRet) }}>{d.outcomes?.[h]?.pool?.avgRet != null ? pct(d.outcomes[h].pool!.avgRet) : '未到期'}</b></span>)}
            </div>
          </Section>

          <button onClick={() => setAudit(v => !v)} style={{ background: 'none', border: 'none', padding: 0, marginTop: 10, cursor: 'pointer', color: '#7dd3fc', fontSize: 'calc(12.5px * var(--fz))' }}>{audit ? '▾' : '▸'} 稽核：完整 prompt 與 AI 原始回覆</button>
          {audit && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 'calc(12.5px * var(--fz))', background: 'var(--bg-secondary)', padding: 8, borderRadius: 8, maxHeight: 360, overflow: 'auto' }}>{d.prompt || '（無）'}{'\n\n──── AI 原始回覆 ────\n'}{d.raw || '（無）'}</pre>}

          <NotesBox key={d.date} initial={d.adminNotes || ''} meta={d.adminNotesAt ? `${d.adminBy}·${tw(d.adminNotesAt, true)}` : undefined} onSave={save} msg={msg}
            placeholder="例：AI 連續偏好 60 日已漲 >70% 的強勢股；20 日超額若為負，下一版 prompt 加「60 日漲幅 >50% 不選」做對照" />
        </div>
      )}
    </div>
  );
}

/** 成交來源標記：live-open＝開盤當下以即時開盤價成交並記錄；archive-open＝開盤時未即時記錄、盤後依官方開盤價補記 */
/** 每日戰績（每列：現金＋持倉淨市值＝帳戶總值）。會員帳戶有入金／提領時多一欄，累計報酬為時間加權（2026-10-01） */
export function DailyHistory({ history }: { history: HistRow[] }) {
  const hist = [...history].reverse();
  const flows = hist.some(r => r.flow != null);
  const base = (
    <Collapse id="swing-history" title="📈 每日戰績" count={`${hist.length} 日`} sub={flows ? '每列：現金＋持倉淨市值＝帳戶總值；當日損益不含入金／提領；累計報酬為時間加權（加碼不算獲利）' : '每列：現金＋持倉淨市值＝帳戶總值；買進／賣出＝當日實際成交筆數（委託不算）'}>
      <ListTable stickyFirst head={['日期', '持有', '待進場', '買進成交', '賣出成交', '賣出損益', '已實現累計', '未實現', '現金', '持倉淨市值', '帳戶總值', '當日損益', '累計報酬']} right={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]}
        empty="尚無戰績（每日收盤資料歸檔後更新）"
        rows={hist.map(r => [r.date, `${r.holdings}${r.selling ? `（含賣出委託 ${r.selling}）` : ''}`, r.pending || '—', r.opened || '—', r.closed || '—', r.closed ? twd(r.closedPnl) : '—', twd(r.realized),
          <span key="u" style={{ color: upDn(r.unrealized) }}>{twd(r.unrealized)}</span>, r.cash.toLocaleString(), (r.netMkt ?? r.total - r.cash).toLocaleString(), <b key="t">{r.total.toLocaleString()}</b>,
          <b key="d" style={{ color: upDn(r.dayPnl) }}>{twd(r.dayPnl)}</b>, <span key="c" style={{ color: upDn(r.cumRetPct) }}>{pct(r.cumRetPct)}</span>])} />
    </Collapse>
  );
  if (!flows) return base;
  const moves = hist.filter(r => r.flow);
  return (
    <>
      {base}
      <Collapse id="swing-flows" title="💵 入金／提領" count={`${moves.length} 筆`} sub="投入資金的變更；帳戶延續，報酬以時間加權計">
        <ListTable head={['日期', '入金／提領', '變更後淨投入']} right={[1, 2]} empty="尚無資金異動"
          rows={moves.map(r => [r.date, <b key="f" style={{ color: (r.flow ?? 0) > 0 ? 'var(--color-up)' : 'var(--color-down)' }}>{(r.flow ?? 0) > 0 ? '入金 ' : '提領 '}{Math.abs(r.flow ?? 0).toLocaleString()} 元</b>, (r.netInvested ?? 0).toLocaleString()])} />
      </Collapse>
    </>
  );
}

/** 部位：持有中／賣出委託／待進場，各自可收合、每列可展開 AI 理由與明細 */
export function Positions({ snapshot }: { snapshot?: Snapshot | null }) {
  const hs = snapshot?.holdings || [];
  const by: Record<PosState, Holding[]> = { held: [], selling: [], pending: [] };
  for (const h of hs) by[stateOf(h)].push(h);
  const asOf = snapshot?.provisional
    ? `市值以 ${snapshot.dataDate} 盤中即時價計${snapshot.liveAt ? `（${tw(snapshot.liveAt)}）` : '（暫無即時價者以成本計）'}，收盤歸檔後改以官方收盤重算`
    : snapshot?.dataDate ? `市值以 ${snapshot.dataDate} 收盤計（除權息還原價）` : '每日 17:00 後結算時更新';
  // 2026-10-01 使用者：「買進 時間·價」移到最右欄（數字欄先看、成交時間與來源標記放最後）
  const posHead = ['個股', '股數', '成本（含手續費）', '最新收盤', '淨市值', '淨未實現', '已持有／AI 預期', '買進 時間·價'];
  const posRows = (list: Holding[]) => list.map(h => [
    <b key="c">{h.code} {h.name}</b>, h.shares.toLocaleString(),
    h.cost.toLocaleString(), h.lastPx ?? '—', h.netValue != null ? h.netValue.toLocaleString() : '—',
    <b key="u" style={{ color: upDn(h.unrealized) }}>{h.unrealized != null ? `${twd(h.unrealized)}（${pct(h.unrealizedPct)}）` : '—'}</b>,
    `${h.heldDays} 日／${h.horizon ? `${h.horizon} 日` : '—'}`,
    h.entryPx ? <span key="b" style={MONO}>{tw(h.entryAt, true)} · {h.entryPx}<FillTag src={h.fillSource} at={h.fillRecordedAt} /></span> : '—']);
  const posDetails = (list: Holding[]) => list.map(h => (
    <div key={h.code}>
      <div>選股日 <b>{h.date}</b>{h.entryDate ? `·成交 ${h.entryDate}` : ''}　市值 {h.mktValue?.toLocaleString() ?? '—'} − 預估賣出費稅 {h.estSellCost?.toLocaleString() ?? '—'} ＝ 淨市值 {h.netValue?.toLocaleString() ?? '—'}{h.buyFee != null ? `　（成本含買進手續費 ${h.buyFee.toLocaleString()}）` : ''}</div>
      {h.sellReason && <div style={{ color: '#f59e0b' }}>🔻 AI 賣出理由：{h.sellReason}</div>}
      {h.reason && <div>🧠 AI 買進理由：{h.reason}</div>}
    </div>));
  const keysOf = (list: Holding[]) => list.map(h => `${h.date}:${h.code}`);
  const posFoot = (list: Holding[]) => ['合計', `${list.length} 檔`, sum(list, h => h.cost).toLocaleString(), '', sum(list, h => h.netValue).toLocaleString(), twd(sum(list, h => h.unrealized)), '', ''];
  return (
    <>
      <Collapse id="swing-held" title="📋 持有中" count={`${by.held.length} 檔`} sub={`${asOf}；淨市值與淨未實現已扣若賣出的手續費＋證交稅；點列展開看 AI 理由與明細`}>
        <ListTable stickyFirst head={posHead} right={[1, 2, 3, 4, 5]} empty="目前沒有持有中的部位" rows={posRows(by.held)} details={posDetails(by.held)} rowKeys={keysOf(by.held)} foot={by.held.length ? posFoot(by.held) : undefined} />
      </Collapse>
      {by.selling.length > 0 && (
        <Collapse id="swing-selling" title="🔻 賣出委託（下一交易日 09:00 開盤賣出）" count={`${by.selling.length} 檔`} tone="rgba(245,158,11,0.2)" sub="AI 盤後決定賣出、尚未成交；成交後移到「已賣出」">
          <ListTable stickyFirst head={posHead} right={[1, 2, 3, 4, 5]} rows={posRows(by.selling)} details={posDetails(by.selling)} rowKeys={keysOf(by.selling)} foot={posFoot(by.selling)} />
        </Collapse>
      )}
      {by.pending.length > 0 && (
        <Collapse id="swing-pending" title="🕘 待進場（下一交易日 09:00 開盤買進）" count={`${by.pending.length} 檔`} sub="委託中買單：尚未成交、不計入帳戶總值；開盤時依可用資金成交或裁減">
          <ListTable stickyFirst head={['個股', '計畫股數', '預估金額（含手續費）', '選股日', 'AI 預期持有']} right={[1, 2]}
            rows={by.pending.map(h => [<b key="c">{h.code} {h.name}</b>, h.shares.toLocaleString(), h.cost.toLocaleString(), h.date, h.horizon ? `${h.horizon} 日` : '—'])}
            details={by.pending.map(h => (h.reason ? <div key={h.code}>🧠 AI 買進理由：{h.reason}</div> : null))} rowKeys={keysOf(by.pending)}
            foot={['合計', '', sum(by.pending, h => h.cost).toLocaleString(), '', '']} />
        </Collapse>
      )}
    </>
  );
}

/** 已賣出：實際交易單（新→舊），每列可展開 AI 買賣理由與費稅拆解 */
export function ClosedTrades({ closed }: { closed: Closed[] }) {
  const cl = closed;
  return (
    <Collapse id="swing-closed" title="✅ 已賣出" count={`${cl.length} 筆`} sub="AI 下賣單、下一交易日開盤成交的實際交易單（新→舊）；點列展開看 AI 買賣理由">
      <ListTable stickyFirst head={['個股', '股數', '買進 時間·價·金額', '賣出 時間·價·金額', '費稅', '淨損益', '報酬', '選股日']} right={[1, 4, 5, 6]}
        empty="尚無賣出（AI 每日盤後檢視持股，決定賣出後於下一交易日開盤成交）"
        rows={cl.map(c => [
          <b key="c">{c.code} {c.name}</b>, c.shares.toLocaleString(),
          <span key="b" style={MONO}>{tw(c.buy.at, true)} · {c.buy.px} · {c.buy.amount.toLocaleString()}</span>,
          <span key="s" style={MONO}>{tw(c.sell.at, true)} · {c.sell.px} · {c.sell.amount.toLocaleString()}<FillTag src={c.sellSource} at={c.sellRecordedAt} /></span>,
          c.costTwd.toLocaleString(), <b key="p" style={{ color: upDn(c.pnlTwd) }}>{twd(c.pnlTwd)}</b>, <span key="r" style={{ color: upDn(c.retPct) }}>{pct(c.retPct)}</span>, c.date,
        ])}
        details={cl.map(c => (
          <div key={`${c.code}-${c.date}`}>
            <div style={{ color: '#f59e0b' }}>🔻 AI 賣出理由{c.sellOrderDate ? `（${c.sellOrderDate} 盤後決定）` : ''}：{c.sellReason || '—'}</div>
            {c.buyReason && <div>🧠 AI 買進理由：{c.buyReason}</div>}
            <div style={MONO}>費稅 {c.costTwd.toLocaleString()} 元＝買進手續費 {c.buy.fee.toLocaleString()} ＋ 賣出手續費 {c.sell.fee.toLocaleString()} ＋ 證交稅 {(c.sell.tax ?? 0).toLocaleString()}</div>
          </div>))}
        rowKeys={cl.map(c => `${c.date}:${c.code}:${c.exitDate}`)}
          foot={cl.length ? ['合計', `${cl.length} 筆`, '', '', sum(cl, c => c.costTwd).toLocaleString(), twd(sum(cl, c => c.pnlTwd)), '', ''] : undefined} />
    </Collapse>
  );
}

function FillTag({ src, at }: { src?: string | null; at?: number | null }) {
  if (src === 'live-open') return <span title="開盤當下以即時報價的今日開盤價成交並寫入記錄" style={{ marginLeft: 6, fontSize: 'calc(12.5px * var(--fz))', color: '#22c55e' }}>⚡即時{at ? `·記錄 ${tw(at, false)}` : ''}</span>;
  if (src === 'archive-open') return <span title="開盤時常駐服務未即時記錄，盤後依官方開盤價補記" style={{ marginLeft: 6, fontSize: 'calc(12.5px * var(--fz))', color: '#f59e0b' }}>⚠盤後補記</span>;
  return null;
}

function PickCard({ p, doc }: { p: SwingPick; doc: SwingLabDoc }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <span style={{ fontWeight: 900, fontSize: 'calc(14.5px * var(--fz))' }}>{p.code} {p.name}</span>
        <span style={{ color: 'var(--text-muted)' }}>信心 {p.confidence} · AI 預期持有 {p.horizon ? `${p.horizon} 日` : '—'} · 決定時價格 {p.priceAtDecision ?? '—'}</span>
        <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{p.sources.join('、')}</span>
      </div>
      <div style={{ marginTop: 2, fontSize: 'calc(13.5px * var(--fz))' }}><b>選股原因</b>：{p.reason}　<span style={{ color: '#f59e0b' }}>風險：{p.risk}</span></div>
      <div style={{ fontSize: 'calc(13px * var(--fz))', color: p.position && !p.position.shares ? '#f59e0b' : 'var(--text-muted)' }}>
        {p.position
          ? p.position.shares
            ? `🏦 部位：${p.position.lots ? `${p.position.lots} 張` : ''}${p.position.oddShares ? `${p.position.lots ? '＋' : ''}${p.position.oddShares} 股零股` : ''}（約 ${p.position.estCost.toLocaleString()} 元，預算 ${p.position.budget.toLocaleString()}）· ${doc.date} 之後第一個交易日 09:00 開盤買 · 之後由 AI 每日檢視決定何時賣出${p.position.note ? `｜${p.position.note}` : ''}`
            : `💰 ${p.position.reason || '資金不足'}，未建倉（研究數字仍照算報酬率）`
          : '預計買進：隔一交易日 09:00 開盤（本筆為帳戶設定前的記錄，以 1 張計）'}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
        {HS.map(h => { const o = doc.outcomes?.[h]?.picks.find(x => x.code === p.code); return (
          <span key={h} title="研究用：同部位若持有這一期的結果（帳戶實際出場以 AI 賣單為準）" style={{ ...MONO, padding: '2px 8px', borderRadius: 999, fontSize: 'calc(12.5px * var(--fz))', border: `1px solid ${p.horizon === h ? '#fbbf24' : 'var(--border-primary)'}`, color: o?.ledger ? upDn(o.ledger.pnlTwd) : 'var(--text-muted)' }}>
            {h} 日 {o?.ledger ? `${twd(o.ledger.pnlTwd)}（${pct(o.ledger.retPct)}）` : o ? o.note || '資料缺' : '未到期'}
          </span>); })}
      </div>
      {HS.some(h => doc.outcomes?.[h]?.picks.find(x => x.code === p.code)?.ledger) && (
        <>
          <button onClick={() => setOpen(v => !v)} style={{ background: 'none', border: 'none', padding: 0, marginTop: 4, cursor: 'pointer', color: '#7dd3fc', fontSize: 'calc(12.5px * var(--fz))' }}>{open ? '▾' : '▸'} 各持有期交易單（買賣時間·金額·費稅）</button>
          {open && HS.map(h => { const o = doc.outcomes?.[h]?.picks.find(x => x.code === p.code); return o?.ledger ? (
            <div key={h} style={{ marginTop: 6 }}>
              <div style={{ fontWeight: 800, fontSize: 'calc(13px * var(--fz))' }}>持有 {h} 日　<span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>期間最深 {pct(o.maxDD)}／最高 {pct(o.maxUp)}{o.openMissing ? '·進場日無開盤價，改用收盤' : ''}</span></div>
              <TradeSlip L={o.ledger} withDate />
            </div>) : null; })}
        </>
      )}
    </div>
  );
}
