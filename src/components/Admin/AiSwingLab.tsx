'use client';

// ── 🤖 AI 實驗·波段持有（超級管理員專用；2026-09-24 UX 重整）───────────────
// 閱讀順序：①各持有期結論卡（AI 平均、超額、淨損益元）②挑日期 ③每檔一張卡：選股原因 → 預計買進 → 5/10/20/60/120 日交易單
//          （買進 09:00 開盤／賣出 13:30 收盤、金額、費稅、淨損益、先選後買查核）④整池基準 ⑤稽核（prompt 與原始回覆）⑥我的檢討。
import { useCallback, useEffect, useState } from 'react';
import { auth } from '@/lib/firebase';
import type { SwingLabDoc, SwingHorizonStat, SwingPick } from '../../../scripts/lib/ai-swing-lab.mjs';
import { Kpi, TradeSlip, NotesBox, Section, ListTable, MONO, upDn, twd, pct, tw } from './AiLabParts';

const HS = [5, 10, 20, 60, 120];
interface Acct { initial: number; realized: number; equity: number; openCost: number; cash: number; openN: number; closedN: number; retPct: number }
interface OpenPos { date: string; code: string; name: string; shares: number; estCost: number; exitH: number }
interface SLeg { at: number | null; px: number; amount: number; fee: number; tax?: number }
interface Holding { date: string; code: string; name: string; shares: number; exitH: number; status: string; entryDate: string | null; entryAt: number | null; entryPx: number | null; cost: number; lastDate: string | null; lastPx: number | null; mktValue: number | null; unrealized: number | null; unrealizedPct: number | null; heldDays: number; daysLeft: number }
interface Closed { date: string; code: string; name: string; shares: number; exitH: number; buy: SLeg; sell: SLeg; costTwd: number; pnlTwd: number; retPct: number; exitDate: string }
interface Snapshot { at: number; dataDate: string | null; holdings: Holding[]; closed: Closed[] }
interface Resp { snapshot?: Snapshot | null; account?: Acct; openPositions?: OpenPos[]; found: boolean; stats: Record<string, SwingHorizonStat>; byModel: Record<string, Record<string, SwingHorizonStat>>; days: { date: string; model: string | null; picks: string[]; settled: number[]; hasNotes: boolean }[]; detail: SwingLabDoc | null; error?: string }

async function authed(input: string, init: RequestInit = {}) {
  const token = (await auth.currentUser?.getIdToken()) ?? '';
  return fetch(input, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
}

export default function AiSwingLab() {
  const [data, setData] = useState<Resp | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [audit, setAudit] = useState(false);
  const load = useCallback(async (d: string | null) => {
    try { const r = await authed(`/api/admin/ai-swing-lab${d ? `?date=${d}` : ''}`); const j = await r.json(); setData(r.ok ? j : { ...j, found: false }); }
    catch { setData({ found: false, stats: {}, byModel: {}, days: [], detail: null, error: '載入失敗' }); }
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
      <div style={{ color: 'var(--text-muted)', marginBottom: 10 }}>
        每個交易日 17:00 後，本機 Ollama 從本站波段榜（排除處置股）挑最多 5 檔。模擬帳戶 <b>50 萬</b>（與當沖帳戶不互通）：單筆上限 10 萬、可零股、低於 1 萬不建倉；<b>隔日 09:00 開盤買進</b>，帳戶在 AI 指定的持有期（🏦）<b>13:30 收盤賣出</b>，其他持有期（5／10／20／60／120 日）為同部位的研究數字（除權息還原價）。
        選股在盤後凍結，時間早於隔日開盤——交易單上的「✓ 先選後買」就是查核。<b>AI 有沒有用：看「超額」（選中的 − 整池平均）。</b>模擬交易，非投資建議。
      </div>

      {data.account && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <Kpi label="🏦 波段帳戶淨值（起始 50 萬·與當沖不互通）" value={`${Math.round(data.account.equity).toLocaleString()} 元`} color={upDn(data.account.realized)} sub={`已實現 ${twd(data.account.realized)}（${pct(data.account.retPct)}）· 已平倉 ${data.account.closedN} 筆`} />
          <Kpi label="可用現金" value={`${Math.round(data.account.cash).toLocaleString()} 元`} sub={`持倉成本 ${Math.round(data.account.openCost).toLocaleString()} 元 · ${data.account.openN} 檔`} hint="單筆上限 10 萬、可零股、低於 1 萬不建倉" />
        </div>
      )}
      <Section title="📋 持有清單" sub={data.snapshot?.dataDate ? `市值以 ${data.snapshot.dataDate} 收盤計（除權息還原價）` : '每日 17:00 後結算時更新'}>
        <ListTable head={['選股日', '個股', '狀態', '股數', '買進 時間·價', '成本', '最新收盤', '市值', '未實現損益', '已持有／剩餘']} right={[3, 5, 6, 7, 8]}
          empty="目前沒有持倉"
          rows={(data.snapshot?.holdings || []).map(h => [
            h.date.slice(5), `${h.code} ${h.name}`, <span key="s" style={{ color: h.entryPx ? 'var(--text-primary)' : '#7dd3fc' }}>{h.status}</span>, h.shares.toLocaleString(),
            h.entryPx ? <span key="b" style={MONO}>{tw(h.entryAt, true)} · {h.entryPx}</span> : '—', h.cost.toLocaleString(), h.lastPx ?? '—',
            h.mktValue != null ? h.mktValue.toLocaleString() : '—', <b key="u" style={{ color: upDn(h.unrealized) }}>{h.unrealized != null ? `${twd(h.unrealized)}（${pct(h.unrealizedPct)}）` : '—'}</b>,
            `${h.heldDays} 日／剩 ${h.daysLeft} 日（${h.exitH} 日出場）`,
          ])}
          foot={data.snapshot?.holdings?.length ? ['合計', `${data.snapshot.holdings.length} 檔`, '', '', '', data.snapshot.holdings.reduce((a, h) => a + h.cost, 0).toLocaleString(), '',
            data.snapshot.holdings.reduce((a, h) => a + (h.mktValue ?? 0), 0).toLocaleString() || '—', twd(data.snapshot.holdings.reduce((a, h) => a + (h.unrealized ?? 0), 0)), ''] : undefined} />
      </Section>

      <Section title="✅ 結算清單" sub="帳戶在 AI 指定持有期出場的實際交易單（新→舊）">
        <ListTable head={['選股日', '個股', '股數', '買進 時間·價·金額', '賣出 時間·價·金額', '費稅', '淨損益', '報酬', '持有']} right={[2, 5, 6, 7]}
          empty="尚無已結算部位（最快在進場後第 5 個交易日收盤）"
          rows={(data.snapshot?.closed || []).map(c => [
            c.date.slice(5), `${c.code} ${c.name}`, c.shares.toLocaleString(),
            <span key="b" style={MONO}>{tw(c.buy.at, true)} · {c.buy.px} · {c.buy.amount.toLocaleString()}</span>,
            <span key="s" style={MONO}>{tw(c.sell.at, true)} · {c.sell.px} · {c.sell.amount.toLocaleString()}</span>,
            c.costTwd.toLocaleString(), <b key="p" style={{ color: upDn(c.pnlTwd) }}>{twd(c.pnlTwd)}</b>, <span key="r" style={{ color: upDn(c.retPct) }}>{pct(c.retPct)}</span>, `${c.exitH} 日`,
          ])}
          foot={data.snapshot?.closed?.length ? ['合計', `${data.snapshot.closed.length} 筆`, '', '', '', data.snapshot.closed.reduce((a, c) => a + c.costTwd, 0).toLocaleString(), twd(data.snapshot.closed.reduce((a, c) => a + c.pnlTwd, 0)), '', ''] : undefined} />
      </Section>
      {data.found && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {HS.map(h => { const s = data.stats[h]; return (
            <Kpi key={h} label={`持有 ${h} 日`} value={s?.n ? pct(s.avg) : '未到期'} color={upDn(s?.avg)}
              sub={s?.n ? `超額 ${pct(s.excess, 'pp')} · ${s.n} 筆 · ${twd(s.pnlTwd)}${s.n < 30 ? ' · 樣本少' : ''}` : '尚無結算'} hint={s?.n ? `整池平均 ${pct(s.poolAvg)}·贏池比例 ${s.beatPool}%·勝率 ${s.win}%` : undefined} />); })}
        </div>
      )}
      {Object.keys(data.byModel).length > 1 && <div style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)', marginTop: 4 }}>
        依模型：{Object.entries(data.byModel).map(([m, s]) => `${m}（20 日超額 ${pct(s[20]?.excess, 'pp')}，n=${s[20]?.n ?? 0}）`).join('｜')}
      </div>}

      <Section title="日期" sub="點日期看當天選股與各持有期交易單">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {!data.days.length && <span style={{ color: 'var(--text-muted)' }}>尚無記錄：下一個交易日 17:00 後開始</span>}
          {data.days.map(x => (
            <button key={x.date} onClick={() => { setDate(x.date); setMsg(''); setAudit(false); }}
              style={{ textAlign: 'left', padding: '5px 10px', borderRadius: 10, cursor: 'pointer', border: `1px solid ${d?.date === x.date ? '#7dd3fc' : 'var(--border-primary)'}`, background: d?.date === x.date ? 'rgba(125,211,252,0.12)' : 'transparent', color: 'var(--text-primary)' }}>
              <div style={{ fontWeight: 800, fontSize: 'calc(12.5px * var(--fz))' }}>{x.date.slice(5)}{x.hasNotes ? ' 📝' : ''}</div>
              <div style={{ ...MONO, fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)' }}>選 {x.picks.length} 檔 · 已結算 {x.settled.length}/5</div>
            </button>
          ))}
        </div>
      </Section>

      {d && (
        <div style={{ marginTop: 12, padding: 12, borderRadius: 12, border: '1px solid var(--border-primary)' }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <span style={{ fontWeight: 900, fontSize: 'calc(16px * var(--fz))' }}>🔒 {d.date} 盤後選股</span>
            <span style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>
              凍結 {tw(d.frozenAt, true)} · 模型 <b>{d.model?.name || '未知'}</b>{d.model?.parameterSize ? `·${d.model.parameterSize}·${d.model.quantization}` : ''}{d.model?.digest ? `·${d.model.digest.slice(0, 12)}` : ''} · 候選池 {d.pool.length} 檔 · {d.version}
            </span>
          </div>
          <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginTop: 2 }}>大盤：{d.market || '—'}　AI 看法：{d.note || '—'}</div>

          {!d.picks.length && <div style={{ marginTop: 10, color: 'var(--text-muted)' }}>當天未選股。</div>}
          {d.picks.map(p => <PickCard key={p.code} p={p} doc={d} />)}

          <Section title="整池基準" sub="同一天丟給 AI 的所有候選，同口徑等權平均">
            <div style={{ ...MONO, display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 'calc(12.5px * var(--fz))' }}>
              {HS.map(h => <span key={h}>{h} 日 <b style={{ color: upDn(d.outcomes?.[h]?.pool?.avg) }}>{d.outcomes?.[h]?.pool ? pct(d.outcomes[h].pool!.avg) : '未到期'}</b></span>)}
            </div>
          </Section>

          <button onClick={() => setAudit(v => !v)} style={{ background: 'none', border: 'none', padding: 0, marginTop: 10, cursor: 'pointer', color: '#7dd3fc', fontSize: 'calc(12px * var(--fz))' }}>{audit ? '▾' : '▸'} 稽核：完整 prompt 與 AI 原始回覆</button>
          {audit && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 'calc(11.5px * var(--fz))', background: 'var(--bg-secondary)', padding: 8, borderRadius: 8, maxHeight: 360, overflow: 'auto' }}>{d.prompt || '（無）'}{'\n\n──── AI 原始回覆 ────\n'}{d.raw || '（無）'}</pre>}

          <NotesBox key={d.date} initial={d.adminNotes || ''} meta={d.adminNotesAt ? `${d.adminBy}·${tw(d.adminNotesAt, true)}` : undefined} onSave={save} msg={msg}
            placeholder="例：AI 連續偏好 60 日已漲 >70% 的強勢股；20 日超額若為負，下一版 prompt 加「60 日漲幅 >50% 不選」做對照" />
        </div>
      )}
    </div>
  );
}

function PickCard({ p, doc }: { p: SwingPick; doc: SwingLabDoc }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <span style={{ fontWeight: 900, fontSize: 'calc(14.5px * var(--fz))' }}>{p.code} {p.name}</span>
        <span style={{ color: 'var(--text-muted)' }}>信心 {p.confidence} · AI 預期持有 {p.horizon ? `${p.horizon} 日` : '—'} · 決定時價格 {p.priceAtDecision ?? '—'}</span>
        <span style={{ fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)' }}>{p.sources.join('、')}</span>
      </div>
      <div style={{ marginTop: 2 }}><b>選股原因</b>：{p.reason}　<span style={{ color: '#f59e0b' }}>風險：{p.risk}</span></div>
      <div style={{ fontSize: 'calc(12px * var(--fz))', color: p.position && !p.position.shares ? '#f59e0b' : 'var(--text-muted)' }}>
        {p.position
          ? p.position.shares
            ? `🏦 部位：${p.position.lots ? `${p.position.lots} 張` : ''}${p.position.oddShares ? `${p.position.lots ? '＋' : ''}${p.position.oddShares} 股零股` : ''}（約 ${p.position.estCost.toLocaleString()} 元，預算 ${p.position.budget.toLocaleString()}）· ${doc.date} 之後第一個交易日 09:00 開盤買 · 帳戶於 ${p.position.exitH} 日出場${p.position.note ? `｜${p.position.note}` : ''}`
            : `💰 ${p.position.reason || '資金不足'}，未建倉（研究數字仍照算報酬率）`
          : '預計買進：隔一交易日 09:00 開盤（本筆為帳戶設定前的記錄，以 1 張計）'}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
        {HS.map(h => { const o = doc.outcomes?.[h]?.picks.find(x => x.code === p.code); return (
          <span key={h} title={(p.position?.exitH ?? null) === h ? '帳戶實際在這一期出場' : '研究用：同部位若在這一期出場的結果'} style={{ ...MONO, padding: '2px 8px', borderRadius: 999, fontSize: 'calc(12px * var(--fz))', border: `1px solid ${(p.position?.exitH ?? p.horizon) === h ? '#fbbf24' : 'var(--border-primary)'}`, color: o?.ledger ? upDn(o.ledger.pnlTwd) : 'var(--text-muted)' }}>
            {(p.position?.exitH ?? null) === h ? '🏦 ' : ''}{h} 日 {o?.ledger ? `${twd(o.ledger.pnlTwd)}（${pct(o.ledger.retPct)}）` : o ? o.note || '資料缺' : '未到期'}
          </span>); })}
      </div>
      {HS.some(h => doc.outcomes?.[h]?.picks.find(x => x.code === p.code)?.ledger) && (
        <>
          <button onClick={() => setOpen(v => !v)} style={{ background: 'none', border: 'none', padding: 0, marginTop: 4, cursor: 'pointer', color: '#7dd3fc', fontSize: 'calc(12px * var(--fz))' }}>{open ? '▾' : '▸'} 各持有期交易單（買賣時間·金額·費稅）</button>
          {open && HS.map(h => { const o = doc.outcomes?.[h]?.picks.find(x => x.code === p.code); return o?.ledger ? (
            <div key={h} style={{ marginTop: 6 }}>
              <div style={{ fontWeight: 800, fontSize: 'calc(12px * var(--fz))' }}>持有 {h} 日　<span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>期間最深 {pct(o.maxDD)}／最高 {pct(o.maxUp)}{o.openMissing ? '·進場日無開盤價，改用收盤' : ''}</span></div>
              <TradeSlip L={o.ledger} withDate />
            </div>) : null; })}
        </>
      )}
    </div>
  );
}
