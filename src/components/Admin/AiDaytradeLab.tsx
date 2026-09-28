'use client';

// ── 🤖 AI 實驗·當沖（超級管理員專用；2026-09-24 UX 重整）─────────────────────
// 閱讀順序：①結論數字（AI 成交淨損益、AI 放棄的反事實、判斷加值）②挑日期 ③逐筆交易單（買賣時間／金額／費稅／淨損益＋先決定後成交查核）
//          ④AI 理由收合 ⑤程式判定的對錯與 AI 總評 ⑥我的檢討。
import { useCallback, useEffect, useRef, useState } from 'react';
import { auth } from '@/lib/firebase';
import type { AiLabRecord, AiLabStats } from '../../../scripts/lib/ai-daytrade-lab.mjs';
import { Kpi, TradeSlip, NotesBox, Section, ListTable, MONO, upDn, twd, pct, tw } from './AiLabParts';

interface DayRow { date: string; n: number; stats: AiLabStats['all']; summary: string | null; hasNotes: boolean; frozenAt: number | null }
interface LabDoc {
  date: string; version?: string; model?: string; modelInfo?: { name: string; digest: string | null; parameterSize: string | null; quantization: string | null } | null; deskVersion?: string;
  records: AiLabRecord[]; stats: AiLabStats; review?: { summary: string; improvements: string[] } | null; facts?: { worked: string[]; failed: string[] };
  reviewNote?: string | null; frozenAt?: number; adminNotes?: string; adminNotesAt?: number; adminBy?: string; updatedAt?: number;
}
interface Acct { initial: number; realized: number; equity: number; openCost: number; cash: number; retPct: number; trades: number }
interface Leg { at: number | null; px: number; amount: number; fee: number; tax?: number }
interface TradeRow { date: string; code: string; name: string; side: 'long' | 'short'; type: string; decidedAt: number | null; shares: number; buy: Leg | null; sell: Leg | null; legs: number | null; costTwd: number | null; pnlTwd: number | null; retPct: number | null; exitReason: string | null; open: boolean; noLookahead: boolean | null }
interface DailyRow { wins: number; losses: number; dayRetPct: number; cumRetPct: number; date: string; n: number; open: number; buyAmt: number; sellAmt: number; fee: number; tax: number; pnl: number; equity: number }
interface Resp { tradeList?: TradeRow[]; daily?: DailyRow[]; account?: Acct; found: boolean; days: DayRow[]; cumulative: AiLabStats | null; confidence: { range: string; n: number; avgR: number | null }[]; live: LabDoc | null; detail: LabDoc | null; error?: string }

const R = (v: number | null | undefined) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}R`);
const STATUS: Record<string, { t: string; c: string }> = {
  filled: { t: '✅ AI 成交', c: '#22c55e' }, skipped: { t: '⏭ AI 放棄', c: 'var(--text-muted)' }, missed: { t: '⌛ 回覆太慢·錯過', c: '#f59e0b' },
  error: { t: '⚠ 決策失敗', c: '#ef4444' }, 'no-cash': { t: '💰 資金不足·未成交', c: '#f59e0b' }, quota: { t: '額度已滿', c: 'var(--text-muted)' }, 'out-of-window': { t: '時段外', c: 'var(--text-muted)' }, pending: { t: '… 決策中', c: '#7dd3fc' },
};

async function authed(input: string, init: RequestInit = {}) {
  const token = (await auth.currentUser?.getIdToken()) ?? '';
  return fetch(input, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
}

export default function AiDaytradeLab() {
  const [data, setData] = useState<Resp | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
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
      const r = await authed(`/api/admin/ai-daytrade-lab${d ? `?date=${d}` : ''}`); const j = await r.json();
      if (my !== seq.current) return;
      if (r.ok) { setData(j); setLoadErr(''); } else fail({ ...j, found: false }, j?.error || '載入失敗');
    } catch {
      if (my !== seq.current) return;
      fail({ found: false, days: [], cumulative: null, confidence: [], live: null, detail: null, error: '載入失敗' }, '載入失敗');
    }
  }, []);
  useEffect(() => { load(date); }, [load, date]);

  if (!data) return <div style={{ padding: 16, color: 'var(--text-muted)' }}>載入中…</div>;
  if (data.error) return <div style={{ padding: 16, color: '#ef4444' }}>{data.error}</div>;
  const c = data.cumulative?.all;
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const liveToday = data.live && data.live.date === today && !data.days.some(d => d.date === today) ? data.live : null;
  const doc = liveToday && !date ? liveToday : data.detail;
  const gain = c && c.taken.aiAvgR != null && c.skipped.ruleAvgR != null ? c.taken.aiAvgR - c.skipped.ruleAvgR : null;

  const save = async (d: string, notes: string) => {
    setMsg('儲存中…');
    const r = await authed('/api/admin/ai-daytrade-lab', { method: 'POST', body: JSON.stringify({ date: d, notes }) });
    const j = await r.json().catch(() => ({}));
    setMsg(r.ok ? '✓ 已儲存，15 分鐘內同步到第二大腦' : `✖ ${j.error || '儲存失敗'}`);
    if (r.ok) load(d);
  };

  return (
    <div style={{ fontSize: 'calc(13px * var(--fz))', lineHeight: 1.6 }}>
      <div style={{ color: 'var(--text-muted)', marginBottom: 10 }}>
        盤中當沖工作台規則觸發後，由本機 Ollama 決定做或不做（多、空各 ≤5 筆）。模擬帳戶 <b>50 萬</b>（與波段帳戶不互通）：單筆上限 25 萬、只下整張，買不起 1 張記「資金不足」；成交＝AI 回覆當下的快線即時價，出場沿用工作台規則（1R／2R／3R 各賣 1/3）。
        AI 放棄的觸發另列「反事實」交易單（規則照做會怎樣）。<b>AI 有沒有用：看「成交」是否比「放棄」好。</b>模擬交易，非投資建議。
      </div>
      {loadErr && <div style={{ color: '#ef4444', fontSize: 'calc(12px * var(--fz))', marginBottom: 8 }}>⚠ 重新載入失敗（{loadErr}）——下方為上一次成功載入的資料</div>}

      {c && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {data.account && <Kpi label="🏦 當沖帳戶淨值（起始 50 萬·與波段不互通）" value={`${Math.round(data.account.equity).toLocaleString()} 元`} color={upDn(data.account.realized)} sub={`已實現 ${twd(data.account.realized)}（${pct(data.account.retPct)}）· 可用 ${Math.round(data.account.cash).toLocaleString()} 元`} hint="單筆上限 25 萬、只下整張；買不起 1 張記資金不足" />}
          <Kpi label="AI 成交·累積淨損益" value={twd(c.taken.pnlTwd)} color={upDn(c.taken.pnlTwd)} sub={`${c.taken.n} 筆 · 勝率 ${c.taken.aiWin ?? '—'}% · 平均 ${R(c.taken.aiAvgR)}`} />
          <Kpi label="AI 放棄·反事實淨損益" value={twd(c.skipped.cfPnlTwd)} color={upDn(c.skipped.cfPnlTwd)} sub={`${c.skipped.n} 筆 · 規則照做平均 ${R(c.skipped.ruleAvgR)}`} hint="AI 沒做的觸發，如果照規則做會賺賠多少" />
          <Kpi label="AI 判斷加值" value={gain == null ? '—' : R(gain)} color={upDn(gain)} sub={c.taken.n + c.skipped.n < 30 ? '樣本 < 30，只當假設' : '成交平均 − 放棄反事實平均'} />
          <Kpi label="錯過／失敗" value={String(c.missed)} sub="回覆逾 3 分鐘或格式錯" />
        </div>
      )}

      <Section title="🕒 交易時間清單" sub="AI 實際成交（新→舊）；做空為先賣後買">
        <ListTable head={['日期', 'AI 決定', '方向', '個股', '股數', '買進 時間·價·金額', '賣出 時間·價·金額', '費稅', '淨損益', '報酬', '出場原因', '查核']} right={[4, 7, 8, 9]}
          empty="尚無 AI 成交（AI 放棄的觸發在下方「日期」逐筆查看反事實交易單）"
          rows={(data.tradeList || []).map(t => [
            t.date.slice(5), <span key="d" style={MONO}>{tw(t.decidedAt)}</span>,
            <span key="s" style={{ fontWeight: 800, color: t.side === 'long' ? 'var(--color-up)' : 'var(--color-down)' }}>{t.side === 'long' ? '多' : '空'}</span>,
            `${t.code} ${t.name}`, t.shares.toLocaleString(),
            t.buy ? <span key="b" style={MONO}>{tw(t.buy.at)} · {t.buy.px} · {t.buy.amount.toLocaleString()}</span> : '—',
            t.sell ? <span key="x" style={MONO}>{tw(t.sell.at)} · {t.sell.px} · {t.sell.amount.toLocaleString()}</span> : (t.open ? '持倉中' : '—'),
            t.costTwd != null ? t.costTwd.toLocaleString() : '—',
            <b key="p" style={{ color: upDn(t.pnlTwd) }}>{twd(t.pnlTwd)}</b>, <span key="r" style={{ color: upDn(t.retPct) }}>{pct(t.retPct)}</span>,
            t.exitReason ? `${t.exitReason}${t.legs && t.legs > 2 ? '（分批）' : ''}` : '—',
            t.noLookahead == null ? '—' : t.noLookahead ? <span key="v" style={{ color: '#22c55e' }}>✓</span> : <span key="v" style={{ color: '#ef4444' }}>⚠</span>,
          ])} />
      </Section>

      <Section title="📈 每日戰績與結算" sub="AI 成交的勝負、買賣總額、費稅、淨損益、當日與累計報酬、結算後帳戶淨值（無成交的日子也列出）">
        <ListTable head={['日期', '成交', '勝／負', '買進總額', '賣出總額', '手續費', '證交稅', '淨損益', '當日報酬', '累計報酬', '結算後淨值']} right={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]}
          rows={(data.daily || []).map(x => [x.date, `${x.n}${x.open ? `（持倉 ${x.open}）` : ''}`, x.n ? `${x.wins}／${x.losses}` : '—', x.buyAmt.toLocaleString(), x.sellAmt.toLocaleString(), x.fee.toLocaleString(), x.tax.toLocaleString(),
            <b key="p" style={{ color: upDn(x.pnl) }}>{twd(x.pnl)}</b>, <span key="d" style={{ color: upDn(x.dayRetPct) }}>{pct(x.dayRetPct)}</span>, <span key="c" style={{ color: upDn(x.cumRetPct) }}>{pct(x.cumRetPct)}</span>, x.equity.toLocaleString()])}
          foot={data.daily?.length ? ['合計', String(data.daily.reduce((a, x) => a + x.n, 0)), `${data.daily.reduce((a, x) => a + x.wins, 0)}／${data.daily.reduce((a, x) => a + x.losses, 0)}`, data.daily.reduce((a, x) => a + x.buyAmt, 0).toLocaleString(), data.daily.reduce((a, x) => a + x.sellAmt, 0).toLocaleString(),
            data.daily.reduce((a, x) => a + x.fee, 0).toLocaleString(), data.daily.reduce((a, x) => a + x.tax, 0).toLocaleString(), twd(data.daily.reduce((a, x) => a + x.pnl, 0)), '', pct(data.daily[0]?.cumRetPct), (data.daily[0]?.equity ?? 500000).toLocaleString()] : undefined} />
      </Section>

      <Section title="日期" sub="點日期看當天每一筆交易單">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {liveToday && <DayChip active={doc === liveToday} onClick={() => { setDate(null); setMsg(''); }} label={`今天 · 盤中`} sub={`${liveToday.records.length} 筆`} />}
          {data.days.map(d => <DayChip key={d.date} active={doc?.date === d.date && doc !== liveToday} onClick={() => { setDate(d.date); setMsg(''); }}
            label={`${d.date.slice(5)}${d.hasNotes ? ' 📝' : ''}`} sub={`成交 ${d.stats.taken.n}｜${twd(d.stats.taken.pnlTwd)}`} color={upDn(d.stats.taken.pnlTwd)} />)}
          {!data.days.length && !liveToday && <span style={{ color: 'var(--text-muted)' }}>尚無記錄</span>}
        </div>
      </Section>

      {doc && <DayView doc={doc} live={doc === liveToday} onSave={notes => save(doc.date, notes)} msg={msg} />}
    </div>
  );
}

function DayChip({ label, sub, active, onClick, color }: { label: string; sub: string; active: boolean; onClick: () => void; color?: string }) {
  return (
    <button onClick={onClick} style={{ textAlign: 'left', padding: '5px 10px', borderRadius: 10, cursor: 'pointer', border: `1px solid ${active ? '#7dd3fc' : 'var(--border-primary)'}`, background: active ? 'rgba(125,211,252,0.12)' : 'transparent', color: 'var(--text-primary)' }}>
      <div style={{ fontWeight: 800, fontSize: 'calc(12.5px * var(--fz))' }}>{label}</div>
      <div style={{ ...MONO, fontSize: 'calc(11.5px * var(--fz))', color: color || 'var(--text-muted)' }}>{sub}</div>
    </button>
  );
}

function DayView({ doc, live, onSave, msg }: { doc: LabDoc; live: boolean; onSave: (n: string) => void; msg: string }) {
  const filled = doc.records.filter(r => r.status === 'filled');
  const skipped = doc.records.filter(r => r.status === 'skipped' || r.status === 'missed');
  const other = doc.records.filter(r => !['filled', 'skipped', 'missed'].includes(r.status));
  const s = doc.stats?.all;
  const mi = doc.modelInfo;
  return (
    <div style={{ marginTop: 12, padding: 12, borderRadius: 12, border: `1px solid ${live ? 'rgba(125,211,252,0.45)' : 'var(--border-primary)'}` }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <span style={{ fontWeight: 900, fontSize: 'calc(16px * var(--fz))' }}>{live ? '⏳ 今天（盤中，尚未凍結）' : `🔒 ${doc.date}`}</span>
        <span style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>
          模型 <b>{mi?.name || doc.model || '未知'}</b>{mi?.parameterSize ? `·${mi.parameterSize}·${mi.quantization}` : ''}{mi?.digest ? `·${mi.digest.slice(0, 12)}` : ''} · {doc.version}{doc.frozenAt ? ` · 凍結 ${tw(doc.frozenAt)}` : doc.updatedAt ? ` · 更新 ${tw(doc.updatedAt)}` : ''}
        </span>
      </div>
      {s && <div style={{ ...MONO, fontSize: 'calc(12.5px * var(--fz))', marginTop: 4 }}>
        當日：AI 成交 {s.taken.n} 筆 <b style={{ color: upDn(s.taken.pnlTwd) }}>{twd(s.taken.pnlTwd)}</b>　·　AI 放棄 {s.skipped.n} 筆（反事實 <b style={{ color: upDn(s.skipped.cfPnlTwd) }}>{twd(s.skipped.cfPnlTwd)}</b>）　·　錯過 {s.missed}
      </div>}

      <Section title="✅ AI 成交" sub={filled.length ? `${filled.length} 筆` : '無'}>{filled.map(r => <TradeCard key={r.id} r={r} />)}</Section>
      <Section title="⏭ AI 放棄或錯過（反事實交易單）" sub="規則照做會怎樣——不是 AI 的交易">{skipped.length ? skipped.map(r => <TradeCard key={r.id} r={r} />) : <span style={{ color: 'var(--text-muted)' }}>無</span>}</Section>
      {other.length > 0 && <Section title="其他觸發" sub="額度已滿／時段外／決策失敗，未交易">
        {other.map(r => <div key={r.id} style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}><span style={MONO}>{tw(r.triggerAt)}</span> {r.side === 'long' ? '多' : '空'} {r.code} {r.name} {r.type}：{STATUS[r.status]?.t}｜{r.reason}</div>)}
      </Section>}

      {!live && (
        <Section title="檢討">
          <div><b style={{ color: '#22c55e' }}>做對（程式判定）</b>：{doc.facts?.worked.length ? doc.facts.worked.join('；') : '無'}</div>
          <div><b style={{ color: '#ef4444' }}>做錯（程式判定）</b>：{doc.facts?.failed.length ? doc.facts.failed.join('；') : '無'}</div>
          {doc.review
            ? <div style={{ marginTop: 4 }}><b>AI 總評</b><span style={{ color: 'var(--text-muted)' }}>（AI 撰寫、未經驗證，數字以上方為準）</span>：{doc.review.summary}
                {doc.review.improvements.length > 0 && <ol style={{ margin: '2px 0 0 1.2em', padding: 0 }}>{doc.review.improvements.map((x, i) => <li key={i}>{x}</li>)}</ol>}</div>
            : <div style={{ color: 'var(--text-muted)' }}>{doc.reviewNote || 'AI 總評產生失敗'}</div>}
          <NotesBox key={doc.date} initial={doc.adminNotes || ''} meta={doc.adminNotesAt ? `${doc.adminBy}·${tw(doc.adminNotesAt, true)}` : undefined} onSave={onSave} msg={msg}
            placeholder="例：AI 放棄的 3 筆突破回踩反事實都賺（+0.8R、+0.82R、+1.32R），下一版 prompt 對「分數≥60 的突破回踩」降低放棄傾向" />
        </Section>
      )}
    </div>
  );
}

function TradeCard({ r }: { r: AiLabRecord }) {
  const [open, setOpen] = useState(false);
  const L = r.ledger || r.cfLedger || null;
  const st = STATUS[r.status];
  return (
    <div style={{ marginBottom: 8, padding: '8px 10px', borderRadius: 10, background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <span style={{ ...MONO, color: 'var(--text-muted)' }}>觸發 {tw(r.triggerAt + 60_000)}</span>
        <span style={{ fontWeight: 900, color: r.side === 'long' ? 'var(--color-up)' : 'var(--color-down)' }}>{r.side === 'long' ? '做多' : '做空'}</span>
        <span style={{ fontWeight: 800 }}>{r.code} {r.name}</span>
        <span style={{ color: 'var(--text-muted)' }}>{r.type}</span>
        <span style={{ fontWeight: 800, color: st?.c }}>{st?.t}</span>
        {r.confidence != null && <span style={{ color: 'var(--text-muted)' }}>信心 {r.confidence}</span>}
        {r.shares ? <span style={{ ...MONO, fontWeight: 800 }}>{r.shares / 1000} 張</span> : null}
        <span style={{ color: 'var(--text-muted)' }}>AI 決定 {tw(r.decidedAt ?? null)}{r.lagMs != null ? `（觸發後 ${Math.round(r.lagMs / 1000)} 秒）` : ''}</span>
        <span style={{ marginLeft: 'auto', ...MONO, color: upDn(r.ruleNetR) }}>規則 {R(r.ruleNetR)}{r.aiNetR != null ? <span style={{ color: upDn(r.aiNetR) }}>　AI {R(r.aiNetR)}</span> : null}</span>
      </div>
      <div style={{ marginTop: 6 }}>
        {L ? <TradeSlip L={L} muted={!r.ledger} note={r.ledgerNote} /> : <span style={{ color: 'var(--text-muted)' }}>{r.status === 'no-cash' ? r.reason : r.cfNote || (r.exitAt ? '無交易單' : '尚未出場')}</span>}
        {r.ledger && r.cashBefore != null && <div style={{ fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)' }}>成交前可用現金 {r.cashBefore.toLocaleString()} 元 · 本筆預算 {r.budget?.toLocaleString()} 元（上限 25 萬、整張）</div>}
      </div>
      {r.exitReason && <div style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)', marginTop: 2 }}>出場原因：{r.exitReason}（工作台規則）· 結構停損 {r.stop} · 觸發價 {r.triggerPx}{r.fillPx != null ? ` · AI 成交價 ${r.fillPx}${r.fillSource ? `（${r.fillSource}${r.fillQuoteAt ? `，報價時戳 ${tw(r.fillQuoteAt)}` : ''}）` : ''}` : ''}</div>}
      <button onClick={() => setOpen(v => !v)} style={{ background: 'none', border: 'none', padding: 0, marginTop: 2, cursor: 'pointer', color: '#7dd3fc', fontSize: 'calc(12px * var(--fz))' }}>{open ? '▾' : '▸'} AI 理由與觸發條件</button>
      {open && <div style={{ fontSize: 'calc(12px * var(--fz))', marginTop: 2 }}>
        <div>理由：{r.reason || '—'}</div><div style={{ color: '#f59e0b' }}>風險：{r.risk || '—'}</div>
        <div style={{ color: 'var(--text-muted)' }}>觸發：{r.why}｜規則符合度 {r.score.total}/{r.score.knownMax}{r.score.missing.length ? `（缺：${r.score.missing.join('、')}）` : ''}{r.warnings.length ? `｜警訊：${r.warnings.join('、')}` : ''}</div>
        {r.aiNetPct != null && <div style={{ color: 'var(--text-muted)' }}>報酬 {pct(r.aiNetPct)}</div>}
      </div>}
    </div>
  );
}
