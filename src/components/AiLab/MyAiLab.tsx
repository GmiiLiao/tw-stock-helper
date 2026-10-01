'use client';

// ── 🤖 AI 實驗·波段（會員；2026-10-01 使用者：開放高級會員、先開放波段，超級管理員逐一開通）─────────────
// 每位會員一位專屬 AI 交易員：每個交易日盤後（17:00 後）依你的帳戶、持股與獲利成長目標決定賣出與買進，
// 下一交易日 09:00 以開盤價模擬成交。會員可設：①投入資金（變更＝加碼／提領）②當沖額度（當沖開放後生效）③獲利成長目標。
// 資料一律經 /api/ai/my-ai-lab（只讀得到自己的帳戶；設定由伺服器驗證）。模擬交易，非投資建議。
import { useCallback, useEffect, useRef, useState } from 'react';
import { auth } from '@/lib/firebase';
import { Kpi, Section, upDn, twd, pct, tw } from '@/components/Admin/AiLabParts';
import { DailyHistory, Positions, ClosedTrades, type Snapshot, type Summary } from '@/components/Admin/AiSwingLab';
import CostReference from '@/components/shared/CostReference';

interface Flow { date: string; amount: number; at?: number }
interface Settings { capital: number; daytradeLimit: number; growthTarget: number | null; flows: Flow[]; createdAt: number | null }
interface DPick { code: string; name: string; confidence: number | null; horizon: number | null; reason: string; risk: string; priceAtDecision: number | null; shares: number; estCost: number; skipReason: string | null }
interface Decision { date: string; note: string | null; model: string | null; frozenAt: number | null; picks: DPick[]; sells: { code: string; name: string; reason: string; shares: number | null }[] }
interface Resp {
  access?: { swing: boolean; daytrade: boolean }; settings?: Settings; withdrawable?: number; pendingFlow?: number;
  snapshot?: Snapshot | null; summary?: Summary | null; target?: { goal: number; cumRetPct: number | null; progress: number } | null;
  decisions?: Decision[]; error?: string;
}

async function authed(input: string, init: RequestInit = {}) {
  const token = (await auth.currentUser?.getIdToken()) ?? '';
  return fetch(input, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
}
const money = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n).toLocaleString()} 元`);
const MUTED = 'var(--text-muted)';

export default function MyAiLab() {
  const [data, setData] = useState<Resp | null>(null);
  const [loadErr, setLoadErr] = useState('');
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
  const started = st.capital > 0 || !!sm;
  // 快照之後的入金／提領（daemon 每分鐘偵測設定變更後重算；這段期間總值與總損益先補上，避免顯示「總損益 −入金」）
  const pending = data.pendingFlow ?? 0;
  const total = sm ? sm.total + pending : 0;

  return (
    <div style={{ padding: '4px 2px', fontSize: 'calc(13px * var(--fz))', lineHeight: 1.6, maxWidth: 1180 }}>
      <h2 style={{ margin: '4px 0 6px', fontSize: 'calc(1.2rem * var(--fz))' }}>🤖 AI 實驗·波段 <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 400, color: MUTED }}>你的專屬 AI 交易員</span></h2>
      <div style={{ color: MUTED, marginBottom: 10 }}>
        每個交易日盤後（17:00 後），你的 AI 交易員依你的帳戶、持股與獲利成長目標，從本站波段候選池決定賣出與買進；下一個交易日 09:00 以開盤價模擬成交並即時記錄。
        費用照實扣：買賣手續費各 0.1425%、賣出證交稅 0.3%。<b>模擬交易，非投資建議；過去的模擬成績不代表未來。</b>
      </div>
      {loadErr && <div role="alert" style={{ color: '#ef4444', fontSize: 'calc(12px * var(--fz))', marginBottom: 8 }}>⚠ 重新載入失敗（{loadErr}）——下方為上一次成功載入的資料</div>}

      <SettingsCard key={`${st.capital}|${st.daytradeLimit}|${st.growthTarget}`} settings={st} withdrawable={data.withdrawable ?? 0} hasAccount={!!sm} onSaved={load} />

      {!started ? (
        <div style={{ marginTop: 12, color: MUTED }}>設定投入資金後，AI 交易員會在下一個交易日盤後開始操作。</div>
      ) : !sm ? (
        <div style={{ marginTop: 12, color: MUTED }}>帳戶建立中：AI 交易員會在下一個交易日盤後第一次決策，帳戶快照每 10 分鐘～1 小時更新。</div>
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
          {data.target && <GoalBar goal={data.target.goal} cum={data.target.cumRetPct} progress={data.target.progress} />}
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

/** 設定：投入資金（變更＝加碼／提領）、當沖額度（當沖開放後生效）、獲利成長目標 */
function SettingsCard({ settings, withdrawable, hasAccount, onSaved }: { settings: Settings; withdrawable: number; hasAccount: boolean; onSaved: () => void }) {
  const [cap, setCap] = useState(String(settings.capital || ''));
  const [dt, setDt] = useState(String(settings.daytradeLimit || ''));
  const [goal, setGoal] = useState(settings.growthTarget == null ? '' : String(settings.growthTarget));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(/,/g, '')));

  const save = async () => {
    const body: Record<string, number | null> = {};
    const c = num(cap), d = num(dt), g = num(goal);
    if (c != null && c !== settings.capital) {
      if (!Number.isInteger(c) || c < 0) { setMsg('✖ 投入資金請填整數元'); return; }
      const delta = c - settings.capital;
      const verb = settings.capital === 0 ? `投入 ${c.toLocaleString()} 元開始` : c === 0 ? `提領全部可提領現金（${withdrawable.toLocaleString()} 元）` : delta > 0 ? `加碼（入金）${delta.toLocaleString()} 元` : `提領 ${(-delta).toLocaleString()} 元`;
      if (!window.confirm(`確定${verb}？\n帳戶延續，報酬以時間加權計算。`)) return;
      body.capital = c;
    }
    if ((d ?? 0) !== settings.daytradeLimit) { if (d != null && (!Number.isInteger(d) || d < 0)) { setMsg('✖ 當沖額度請填整數元'); return; } body.daytradeLimit = d ?? 0; }
    if (g !== settings.growthTarget) { if (g != null && !(g > 0)) { setMsg('✖ 獲利成長目標請填大於 0 的百分比'); return; } body.growthTarget = g; }
    if (!Object.keys(body).length) { setMsg('沒有變更'); return; }
    setBusy(true); setMsg('儲存中…');
    try {
      const r = await authed('/api/ai/my-ai-lab', { method: 'POST', body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg(`✖ ${j.error || '儲存失敗'}`); return; }
      setMsg(j.flow ? `✓ 已${j.flow.amount > 0 ? '入金' : '提領'} ${Math.abs(j.flow.amount).toLocaleString()} 元，下一次 AI 決策起生效` : '✓ 已儲存');
      onSaved();
    } catch { setMsg('✖ 儲存失敗，請稍後再試'); }
    finally { setBusy(false); }
  };

  const field = { display: 'flex', flexDirection: 'column' as const, gap: 3, minWidth: 190, flex: '1 1 190px' };
  return (
    <Section title="⚙️ 我的設定" sub="變更投入資金＝加碼或提領（帳戶延續）；提領不可超過可提領現金">
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={field}>
          <span>① 投入資金（元）</span>
          <input className="input" inputMode="numeric" value={cap} onChange={e => setCap(e.target.value)} placeholder="例：300000（最低 50,000）" aria-describedby="cap-hint" />
          <span id="cap-hint" style={{ fontSize: 'calc(11.5px * var(--fz))', color: MUTED }}>目前淨投入 {money(settings.capital)}{hasAccount ? `·可提領 ${money(withdrawable)}·填 0＝提領全部可提領現金` : ''}</span>
        </label>
        <label style={field}>
          <span>② 當沖額度（元）</span>
          <input className="input" inputMode="numeric" value={dt} onChange={e => setDt(e.target.value)} placeholder="例：1000000" aria-describedby="dt-hint" />
          <span id="dt-hint" style={{ fontSize: 'calc(11.5px * var(--fz))', color: MUTED }}>當沖功能尚未開放，設定先保存、開放後生效</span>
        </label>
        <label style={field}>
          <span>③ 獲利成長目標（%）</span>
          <input className="input" inputMode="decimal" value={goal} onChange={e => setGoal(e.target.value)} placeholder="例：30（空白＝不設）" aria-describedby="goal-hint" />
          <span id="goal-hint" style={{ fontSize: 'calc(11.5px * var(--fz))', color: MUTED }}>AI 交易員會把它當作目標，頁面追蹤進度</span>
        </label>
        <button className="btn btn-buy" disabled={busy} onClick={save} style={{ height: 36 }}>儲存設定</button>
      </div>
      {msg && <div role="status" style={{ marginTop: 6, fontSize: 'calc(12px * var(--fz))', color: msg.startsWith('✖') ? '#ef4444' : MUTED }}>{msg}</div>}
    </Section>
  );
}

function GoalBar({ goal, cum, progress }: { goal: number; cum: number | null; progress: number }) {
  const w = Math.max(0, Math.min(100, progress));
  return (
    <div style={{ marginTop: 10 }} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={w}
      aria-label={`獲利成長目標 ${goal}%，目前 ${cum ?? 0}%，達成 ${progress}%`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'calc(12px * var(--fz))' }}>
        <span>🎯 獲利成長目標 <b>+{goal}%</b>·目前 <b style={{ color: upDn(cum) }}>{pct(cum)}</b></span>
        <span style={{ color: MUTED }}>達成 {progress}%</span>
      </div>
      <div style={{ height: 8, borderRadius: 999, background: 'var(--bg-tertiary)', overflow: 'hidden', marginTop: 4 }}>
        <div style={{ width: `${w}%`, height: '100%', background: progress >= 100 ? '#22c55e' : '#7dd3fc', transition: 'width .3s' }} />
      </div>
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
