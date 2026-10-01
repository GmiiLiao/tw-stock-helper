'use client';

// ── 🤖 AI 實驗·波段（會員；2026-10-01 使用者：開放高級會員、先開放波段，超級管理員逐一開通）─────────────
// 每位會員一位專屬 AI 交易員：每個交易日盤後（17:00 後）依你的帳戶、持股與獲利成長目標決定賣出與買進，
// 下一交易日 09:00 以開盤價模擬成交。會員可設：①投入資金（變更＝加碼／提領）②獲利期間（5～240 個交易日；
// 2026-10-01 使用者：取消當沖額度、改為獲利期間下拉）③獲利成長目標（每期要達成的帳戶成長 %；滾動期間，目標或期間變更＝重新起算）。
// 資料一律經 /api/ai/my-ai-lab（只讀得到自己的帳戶；設定由伺服器驗證）。模擬交易，非投資建議。
import { useCallback, useEffect, useRef, useState } from 'react';
import { auth } from '@/lib/firebase';
import { Kpi, Section, upDn, twd, pct, tw } from '@/components/Admin/AiLabParts';
import { DailyHistory, Positions, ClosedTrades, type Snapshot, type Summary } from '@/components/Admin/AiSwingLab';
import CostReference from '@/components/shared/CostReference';

interface Flow { date: string; amount: number; at?: number }
interface Settings { capital: number; growthTarget: number | null; goalDays: number | null; goalStartDate: string | null; flows: Flow[]; createdAt: number | null }
/** 獲利期間進度（scripts/lib/ai-lab-member.mjs goalProgress） */
interface Target {
  goal: number; days: number; startDate: string | null; period: number; day: number; daysLeft: number;
  periodStart: string | null; periodRetPct: number; cumRetPct: number | null; progress: number;
  lastPeriod: { n: number; retPct: number; achieved: boolean } | null;
}
interface DPick { code: string; name: string; confidence: number | null; horizon: number | null; reason: string; risk: string; priceAtDecision: number | null; shares: number; estCost: number; skipReason: string | null }
interface Decision { date: string; note: string | null; model: string | null; frozenAt: number | null; picks: DPick[]; sells: { code: string; name: string; reason: string; shares: number | null }[] }
interface Resp {
  access?: { swing: boolean; daytrade: boolean }; settings?: Settings; withdrawable?: number; pendingFlow?: number;
  snapshot?: Snapshot | null; summary?: Summary | null; target?: Target | null;
  decisions?: Decision[]; error?: string;
}

async function authed(input: string, init: RequestInit = {}) {
  const token = (await auth.currentUser?.getIdToken()) ?? '';
  return fetch(input, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
}
const money = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n).toLocaleString()} 元`);
const MUTED = 'var(--text-muted)';
/** 獲利期間選項：與 scripts/lib/ai-lab-member.mjs 的 GOAL_DAYS 一致（伺服器驗證） */
const GOAL_DAY_OPTIONS: { v: number; label: string }[] = [
  { v: 5, label: '5 日（約 1 週）' }, { v: 10, label: '10 日（約 2 週）' }, { v: 20, label: '20 日（約 1 個月）' },
  { v: 60, label: '60 日（約 1 季）' }, { v: 120, label: '120 日（約半年）' }, { v: 240, label: '240 日（約 1 年）' },
];
const DEFAULT_GOAL_DAYS = 20;

export default function MyAiLab() {
  const [data, setData] = useState<Resp | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [saveMsg, setSaveMsg] = useState('');   // 放在外層：儲存後重新載入會重建設定卡，訊息才不會被清掉（審查 LOW）
  const seq = useRef(0);
  const load = useCallback(async () => {
    const my = ++seq.current;
    try {
      const r = await authed('/api/ai/my-ai-lab'); const j: Resp = await r.json().catch(() => ({ error: '讀取失敗' }));
      if (my !== seq.current) return;
      if (r.ok || r.status === 403) { setData(j); setLoadErr(''); }
      else setLoadErr(j.error || '讀取失敗');   // 有舊資料就保留，只顯示小字錯誤
    } catch { if (my === seq.current) setLoadErr('讀取失敗，請稍後再試'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!data) return <div style={{ padding: 20, color: loadErr ? '#ef4444' : MUTED }}>{loadErr || '載入中…'}</div>;
  if (!data.settings) {   // 未開通、非高級會員（403 只帶 error）都走這裡
    return <div style={{ padding: 20, color: MUTED, lineHeight: 1.8 }}>🤖 AI 實驗尚未開通{data.error ? `（${data.error}）` : ''}。這是高級會員專屬功能，需由管理員開通；開通後會出現你的專屬 AI 交易員與模擬帳戶。</div>;
  }
  const st = data.settings, sm = data.summary, snap = data.snapshot;
  const history = snap?.history || [];
  const cum = history.length ? history[history.length - 1].cumRetPct : null;
  // 已開始＝曾經入金（2026-10-01 實測：開通後尚未入金的會員被寫了 0 元快照，畫面誤顯示 0 元卡片而非引導）
  const started = st.flows.length > 0;
  // 快照之後的入金／提領（daemon 每分鐘偵測設定變更後重算；這段期間總值與總損益先補上，避免顯示「總損益 −入金」）
  const pending = data.pendingFlow ?? 0;
  const total = sm ? sm.total + pending : 0;

  return (
    <div style={{ padding: '4px 2px', fontSize: 'calc(13px * var(--fz))', lineHeight: 1.6, width: '100%' }}>   {/* 滿版：跟投資組合頁同寬（2026-10-01 使用者） */}
      <h2 style={{ margin: '4px 0 6px', fontSize: 'calc(1.2rem * var(--fz))' }}>🤖 AI 實驗·波段 <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 400, color: MUTED }}>你的專屬 AI 交易員</span></h2>
      <div style={{ color: MUTED, marginBottom: 10 }}>
        每個交易日盤後（17:00 後），你的 AI 交易員依你的帳戶、持股與獲利目標，從本站波段候選池決定賣出與買進；下一個交易日 09:00 以開盤價模擬成交並即時記錄。
        費用照實扣：買賣手續費各 0.1425%、賣出證交稅 0.3%。<b>模擬交易，非投資建議；過去的模擬成績不代表未來。</b>
      </div>
      {loadErr && <div role="alert" style={{ color: '#ef4444', fontSize: 'calc(12px * var(--fz))', marginBottom: 8 }}>⚠ 重新載入失敗（{loadErr}）——下方為上一次成功載入的資料</div>}

      <SettingsCard key={`${st.capital}|${st.goalDays}|${st.growthTarget}`} settings={st} withdrawable={data.withdrawable ?? 0} hasAccount={started && !!sm} onSaved={load} msg={saveMsg} setMsg={setSaveMsg} />

      {!started ? (
        <div style={{ marginTop: 12, color: MUTED }}>設定投入資金後，AI 交易員會在下一個決策時段（交易日 17:00～隔日 08:30）做第一次決策，下一個交易日 09:00 開盤成交。</div>
      ) : !sm ? (
        <div style={{ marginTop: 12, color: MUTED }}>帳戶建立中（約 1 分鐘）：AI 交易員會在下一個決策時段（交易日 17:00～隔日 08:30）第一次決策，下一個交易日 09:00 開盤成交。</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <Kpi label="帳戶總值" value={money(total)}
              sub={pending ? `含剛${pending > 0 ? '入金' : '提領'} ${money(Math.abs(pending))}（明細約 1 分鐘內更新）` : `現金 ${money(sm.cash)}＋持倉淨市值 ${money(sm.netMkt)}`}
              hint="持倉淨市值已扣若賣出的手續費與證交稅" />
            <Kpi label="淨投入" value={money(st.capital)} sub="入金－提領" />
            <Kpi label="總損益" value={twd(total - st.capital)} color={upDn(total - st.capital)} sub={`已實現 ${twd(sm.realized)}·未實現 ${twd(sm.unrealized)}`} />
            <Kpi label="累積報酬（時間加權）" value={pct(cum)} color={upDn(cum)} sub={`${history.length} 個交易日`} hint="扣除入金／提領的影響，加碼不算獲利" />
          </div>
          {data.target && <GoalBar t={data.target} />}
          <div style={{ marginTop: 10 }}>
            <Positions snapshot={snap} />
            <ClosedTrades closed={snap?.closed || []} />
            <DailyHistory history={history} />
          </div>
        </>
      )}

      <Decisions decisions={data.decisions || []} />
      <div style={{ marginTop: 10, color: MUTED, fontSize: 'calc(12px * var(--fz))' }}>
        模擬交易僅供研究參考，非投資建議；AI 依本站資料決策，可能出錯。<CostReference holdDays={[5, 20]} />
      </div>
    </div>
  );
}

/** 設定：①投入資金（變更＝加碼／提領）②獲利期間 ③獲利成長目標（每期要達成的成長；目標或期間變更＝重新起算） */
function SettingsCard({ settings, withdrawable, hasAccount, onSaved, msg, setMsg }: {
  settings: Settings; withdrawable: number; hasAccount: boolean; onSaved: () => void; msg: string; setMsg: (m: string) => void;
}) {
  const [cap, setCap] = useState(String(settings.capital || ''));
  const [days, setDays] = useState(String(settings.goalDays ?? DEFAULT_GOAL_DAYS));
  const [goal, setGoal] = useState(settings.growthTarget == null ? '' : String(settings.growthTarget));
  const [busy, setBusy] = useState(false);
  const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(/,/g, '')));

  const save = async () => {
    const body: Record<string, number | null> = {};
    const c = num(cap), g = num(goal), gd = Number(days);
    if (c != null && c !== settings.capital) {
      if (!Number.isInteger(c) || c < 0) { setMsg('✖ 投入資金請填整數元'); return; }
      const delta = c - settings.capital;
      // 填 0 的實際金額以送出當下的可提領現金為準（頁面只在開啟時載入，數字可能已過時·審查 LOW）
      const verb = settings.capital === 0 ? `投入 ${c.toLocaleString()} 元開始` : c === 0 ? `提領全部可提領現金（金額以送出當下為準；頁面上次載入時約 ${withdrawable.toLocaleString()} 元）` : delta > 0 ? `加碼（入金）${delta.toLocaleString()} 元` : `提領 ${(-delta).toLocaleString()} 元`;
      if (!window.confirm(`確定${verb}？\n帳戶延續，報酬以時間加權計算。`)) return;
      body.capital = c;
    }
    if (gd !== (settings.goalDays ?? null)) body.goalDays = gd;
    if (g !== settings.growthTarget) { if (g != null && !(g > 0)) { setMsg('✖ 獲利成長目標請填大於 0 的百分比'); return; } body.growthTarget = g; }
    if (!Object.keys(body).length) { setMsg('沒有變更'); return; }
    const restart = g != null && (g !== settings.growthTarget || gd !== settings.goalDays);   // 伺服器同一規則：目標或期間變更＝重新起算
    setBusy(true); setMsg('儲存中…');
    try {
      const r = await authed('/api/ai/my-ai-lab', { method: 'POST', body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg(`✖ ${j.error || '儲存失敗'}`); return; }
      const parts = [j.flow ? `已${j.flow.amount > 0 ? '入金' : '提領'} ${Math.abs(j.flow.amount).toLocaleString()} 元（下一次 AI 決策起生效）` : '已儲存', restart ? '獲利期間自下一個交易日重新起算' : ''];
      setMsg(`✓ ${parts.filter(Boolean).join('；')}`);
      onSaved();
    } catch { setMsg('✖ 儲存失敗，請稍後再試'); }
    finally { setBusy(false); }
  };

  const field = { display: 'flex', flexDirection: 'column' as const, gap: 3, minWidth: 190, flex: '1 1 190px' };
  return (
    <Section title="⚙️ 我的設定" sub="變更投入資金＝加碼或提領（帳戶延續）；提領不可超過可提領現金；目標或期間變更＝重新起算">
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <label style={field}>
          <span>① 投入資金（元）</span>
          <input className="input" inputMode="numeric" value={cap} onChange={e => setCap(e.target.value)} placeholder="例：300000（最低 50,000）" aria-describedby="cap-hint" />
          <span id="cap-hint" style={{ fontSize: 'calc(11.5px * var(--fz))', color: MUTED }}>目前淨投入 {money(settings.capital)}{hasAccount ? `·可提領 ${money(withdrawable)}·填 0＝提領全部可提領現金` : ''}</span>
        </label>
        <label style={field}>
          <span>② 獲利期間</span>
          <select className="input" value={days} onChange={e => setDays(e.target.value)} aria-describedby="days-hint">
            {GOAL_DAY_OPTIONS.map(o => <option key={o.v} value={String(o.v)}>{o.label}</option>)}
          </select>
          <span id="days-hint" style={{ fontSize: 'calc(11.5px * var(--fz))', color: MUTED }}>以交易日計；每期到期自動進入下一期</span>
        </label>
        <label style={field}>
          <span>③ 獲利成長目標（%）</span>
          <input className="input" inputMode="decimal" value={goal} onChange={e => setGoal(e.target.value)} placeholder="例：10（空白＝不設）" aria-describedby="goal-hint" />
          <span id="goal-hint" style={{ fontSize: 'calc(11.5px * var(--fz))', color: MUTED }}>每個獲利期間要達成的帳戶成長；AI 交易員以此為目標，風險控制優先</span>
        </label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span aria-hidden style={{ visibility: 'hidden' }}>　</span>
          <button className="btn btn-buy" disabled={busy} onClick={save} style={{ height: 36 }}>儲存設定</button>
        </div>
      </div>
      {msg && <div role="status" style={{ marginTop: 6, fontSize: 'calc(12px * var(--fz))', color: msg.startsWith('✖') ? '#ef4444' : MUTED }}>{msg}</div>}
    </Section>
  );
}

/** 獲利目標進度（獲利期間·滾動）：第幾期第幾日、本期時間加權報酬 vs 目標、上一期結果 */
function GoalBar({ t }: { t: Target }) {
  const w = Math.max(0, Math.min(100, t.progress));
  const md = (d: string) => d.slice(5).replace('-', '/');
  const phase = t.day ? `第 ${t.period} 期${t.periodStart ? `（${md(t.periodStart)} 起）` : ''}·第 ${t.day}/${t.days} 日·剩 ${t.daysLeft} 日` : `第 ${t.period} 期自下一個交易日起算`;
  return (
    <div style={{ marginTop: 10 }} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={w}
      aria-label={`獲利目標每 ${t.days} 個交易日成長 ${t.goal}%，${phase}，本期 ${t.periodRetPct}%，達成 ${t.progress}%`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', fontSize: 'calc(12px * var(--fz))' }}>
        <span>🎯 每 <b>{t.days}</b> 個交易日成長 <b>+{t.goal}%</b>　<span style={{ color: MUTED }}>{phase}</span></span>
        <span>本期 <b style={{ color: upDn(t.periodRetPct) }}>{pct(t.periodRetPct)}</b><span style={{ color: MUTED }}>·達成 {t.progress}%</span></span>
      </div>
      <div style={{ height: 8, borderRadius: 999, background: 'var(--bg-tertiary)', overflow: 'hidden', marginTop: 4 }}>
        <div style={{ width: `${w}%`, height: '100%', background: t.progress >= 100 ? '#22c55e' : '#7dd3fc', transition: 'width .3s' }} />
      </div>
      {t.lastPeriod && (
        <div style={{ marginTop: 3, fontSize: 'calc(11.5px * var(--fz))', color: MUTED }}>
          上一期（第 {t.lastPeriod.n} 期）{pct(t.lastPeriod.retPct)}·{t.lastPeriod.achieved ? '✓ 達標' : '未達標'}
        </div>
      )}
    </div>
  );
}

/** 近期 AI 決策：每天賣出／買進與理由（AI 依當時資料判斷，可能出錯） */
function Decisions({ decisions }: { decisions: Decision[] }) {
  const [open, setOpen] = useState<string | null>(decisions[0]?.date ?? null);
  if (!decisions.length) return null;
  return (
    <Section title="🧠 AI 交易員的決策" sub="每個交易日盤後決定、下一交易日 09:00 開盤成交；點日期看理由">
      {decisions.map(d => {
        const buys = d.picks.filter(p => p.shares > 0), skipped = d.picks.filter(p => !(p.shares > 0));
        const isOpen = open === d.date;
        return (
          <div key={d.date} style={{ borderBottom: '1px solid var(--border-primary)', padding: '6px 0' }}>
            <button type="button" onClick={() => setOpen(isOpen ? null : d.date)} aria-expanded={isOpen}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-primary)', fontSize: 'calc(13px * var(--fz))', textAlign: 'left', width: '100%' }}>
              {isOpen ? '▾' : '▸'} <b>{d.date}</b>　賣 {d.sells.length ? d.sells.map(x => `${x.code} ${x.name}`).join('、') : '無'}｜買 {buys.length ? buys.map(p => `${p.code} ${p.name}`).join('、') : '無'}
              {d.frozenAt ? <span style={{ color: MUTED }}>　決策 {tw(d.frozenAt, true)}</span> : null}
            </button>
            {isOpen && (
              <div style={{ marginTop: 4, fontSize: 'calc(12.5px * var(--fz))' }}>
                {d.note && <div style={{ color: MUTED }}>💬 操作思路：{d.note}</div>}
                {d.sells.map(x => <div key={`s${x.code}`} style={{ color: '#f59e0b' }}>🔻 賣出 {x.code} {x.name}{x.shares ? `（${x.shares.toLocaleString()} 股）` : ''}：{x.reason || '—'}</div>)}
                {buys.map(p => (
                  <div key={`b${p.code}`}>🟢 買進 {p.code} {p.name}·{p.shares.toLocaleString()} 股（約 {money(p.estCost)}）·信心 {p.confidence ?? '—'}·預期持有 {p.horizon ? `${p.horizon} 日` : '—'}
                    <div style={{ color: MUTED, paddingLeft: 18 }}>理由：{p.reason || '—'}｜風險：{p.risk || '—'}</div>
                  </div>
                ))}
                {skipped.map(p => <div key={`k${p.code}`} style={{ color: MUTED }}>⏸ {p.code} {p.name} 未下單：{p.skipReason || '資金不足'}</div>)}
                {!d.sells.length && !d.picks.length && <div style={{ color: MUTED }}>今天不操作（持股全部續抱）</div>}
              </div>
            )}
          </div>
        );
      })}
    </Section>
  );
}
