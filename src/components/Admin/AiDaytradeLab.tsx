'use client';

// ── 🤖 當沖 AI 實驗（超級管理員專用）──────────────────────────────────
// 每個交易日盤中：當沖工作台規則觸發 → 本機 Ollama 決定做／不做（多空各 ≤5）→ 模擬成交；
// 盤後 13:40 凍結成交易記錄檔（aiDaytradeLab/{date}＋second-brain/daytrade-ai-lab/）並附 AI 檢討。
// 這裡查對記錄、看累積成效（AI 做的 vs 不做的反事實 vs 規則全做）、留人工檢討（另存，不改 AI 原始記錄）。
import { useCallback, useEffect, useState } from 'react';
import { auth } from '@/lib/firebase';
import type { AiLabRecord, AiLabStats, AiLabSideStats } from '../../../scripts/lib/ai-daytrade-lab.mjs';

interface DayRow { date: string; n: number; stats: AiLabSideStats; summary: string | null; hasNotes: boolean; frozenAt: number | null }
interface LabDoc { date: string; version?: string; model?: string; deskVersion?: string; records: AiLabRecord[]; stats: AiLabStats; review?: { summary: string; improvements: string[] } | null; facts?: { worked: string[]; failed: string[] }; reviewNote?: string | null; frozenAt?: number; adminNotes?: string; adminNotesAt?: number; adminBy?: string; updatedAt?: number }
interface Resp { found: boolean; days: DayRow[]; cumulative: AiLabStats; confidence: { range: string; n: number; avgR: number | null }[]; live: LabDoc | null; detail: LabDoc | null; error?: string }

const NUM: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums', textAlign: 'right', whiteSpace: 'nowrap' };
const rC = (v: number | null | undefined) => (v == null ? 'var(--text-muted)' : v > 0 ? 'var(--color-up)' : v < 0 ? 'var(--color-down)' : 'var(--text-muted)');
const R = (v: number | null | undefined) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`);
const hhmm = (t?: number | null) => (t ? new Date(t + 8 * 3600000).toISOString().slice(11, 16) : '—');
const STATUS: Record<string, { t: string; c: string }> = {
  filled: { t: '✅ 做', c: '#22c55e' }, skipped: { t: '⏭ 不做', c: 'var(--text-muted)' }, missed: { t: '⌛ 錯過', c: '#f59e0b' },
  error: { t: '⚠ 失敗', c: '#ef4444' }, quota: { t: '額度滿', c: 'var(--text-muted)' }, 'out-of-window': { t: '時段外', c: 'var(--text-muted)' }, pending: { t: '… 決策中', c: '#7dd3fc' },
};

async function authed(input: string, init: RequestInit = {}) {
  const token = (await auth.currentUser?.getIdToken()) ?? '';
  return fetch(input, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
}

export default function AiDaytradeLab() {
  const [data, setData] = useState<Resp | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const load = useCallback(async (d: string | null) => {
    try {
      const r = await authed(`/api/admin/ai-daytrade-lab${d ? `?date=${d}` : ''}`);
      const j = await r.json();
      setData(r.ok ? j : { ...j, found: false });
    } catch { setData({ found: false, days: [], cumulative: null as unknown as AiLabStats, confidence: [], live: null, detail: null, error: '載入失敗' }); }
  }, []);
  useEffect(() => { load(date); }, [load, date]);

  if (!data) return <div style={{ padding: 16, color: 'var(--text-muted)' }}>載入當沖 AI 實驗…</div>;
  if (data.error) return <div style={{ padding: 16, color: '#ef4444' }}>{data.error}</div>;
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const liveToday = data.live && data.live.date === today && !data.days.some(d => d.date === today) ? data.live : null;
  const c = data.cumulative;

  const saveNotes = async (d: string, notes: string) => {
    setMsg('儲存中…');
    const r = await authed('/api/admin/ai-daytrade-lab', { method: 'POST', body: JSON.stringify({ date: d, notes }) });
    const j = await r.json().catch(() => ({}));
    setMsg(r.ok ? '✓ 已儲存（15 分鐘內同步到第二大腦）' : `✖ ${j.error || '儲存失敗'}`);
    if (r.ok) load(d);
  };

  return (
    <div style={{ fontSize: 'calc(13px * var(--fz))' }}>
      <div style={{ marginBottom: 10, lineHeight: 1.7, color: 'var(--text-muted)' }}>
        <b style={{ color: 'var(--text-primary)', fontSize: 'calc(15px * var(--fz))' }}>🤖 當沖 AI 實驗</b>
        ：盤中當沖工作台的規則觸發（已通過全部否決）後，由本機 Ollama 決定做或不做，做多、做空各最多 5 筆；進場價＝AI 回覆當下的即時價，回覆超過 3 分鐘視為錯過；
        出場沿用工作台規則。盤後 13:40 凍結成記錄檔（第二大腦 <code>second-brain/daytrade-ai-lab/</code>），並由 AI 寫檢討。
        <b>判斷 AI 有沒有用，看「AI 做的」有沒有比「AI 不做的（反事實）」好</b>；各格 n &lt; 30 只當假設。模擬交易，非投資建議。
      </div>

      {c && (
        <div style={{ overflowX: 'auto', marginBottom: 12 }}>
          <table style={{ borderCollapse: 'collapse', minWidth: 620 }}>
            <thead><tr style={{ color: 'var(--text-muted)', fontSize: 'calc(12px * var(--fz))' }}>
              {['累積（近 60 日）', 'AI 做 n', 'AI 平均', 'AI 勝率', '不做 n', '不做（反事實）', '規則全做', '錯過／失敗'].map(h => <th key={h} style={{ padding: '4px 10px', textAlign: h.startsWith('累積') ? 'left' : 'right', borderBottom: '1px solid var(--border-primary)' }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {(['long', 'short', 'all'] as const).map(k => (
                <tr key={k} style={{ fontWeight: k === 'all' ? 800 : 400 }}>
                  <td style={{ padding: '3px 10px' }}>{k === 'long' ? '做多' : k === 'short' ? '做空（鏡像）' : '合計'}</td>
                  <td style={{ ...NUM, padding: '3px 10px' }}>{c[k].taken.n}{c[k].taken.n < 30 ? <span style={{ color: '#f59e0b' }}>*</span> : null}</td>
                  <td style={{ ...NUM, padding: '3px 10px', color: rC(c[k].taken.aiAvgR) }}>{R(c[k].taken.aiAvgR)}</td>
                  <td style={{ ...NUM, padding: '3px 10px' }}>{c[k].taken.aiWin == null ? '—' : `${c[k].taken.aiWin}%`}</td>
                  <td style={{ ...NUM, padding: '3px 10px' }}>{c[k].skipped.n}</td>
                  <td style={{ ...NUM, padding: '3px 10px', color: rC(c[k].skipped.ruleAvgR) }}>{R(c[k].skipped.ruleAvgR)}</td>
                  <td style={{ ...NUM, padding: '3px 10px', color: rC(c[k].allRule.ruleAvgR) }}>{R(c[k].allRule.ruleAvgR)}</td>
                  <td style={{ ...NUM, padding: '3px 10px' }}>{c[k].missed}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)', marginTop: 4 }}>
            信心分組（AI 做的）：{data.confidence.map(b => `${b.range}：n=${b.n} ${R(b.avgR)}`).join('｜')}——信心越高應該越好，否則信心不可用。
          </div>
        </div>
      )}

      {liveToday && <DayDetail doc={liveToday} live onSave={saveNotes} msg={msg} />}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '10px 0' }}>
        {!data.days.length && <span style={{ color: 'var(--text-muted)' }}>尚無凍結記錄：從下一個交易日盤中開始累積，13:40 後凍結。</span>}
        {data.days.map(d => (
          <button key={d.date} onClick={() => { setDate(d.date); setMsg(''); }}
            style={{ padding: '4px 10px', borderRadius: 8, border: '1px solid var(--border-primary)', cursor: 'pointer', background: data.detail?.date === d.date ? 'rgba(125,211,252,0.15)' : 'transparent', color: 'var(--text-primary)', fontSize: 'calc(12px * var(--fz))' }}>
            {d.date.slice(5)} · 做 {d.stats.taken.n} <span style={{ color: rC(d.stats.taken.aiAvgR) }}>{R(d.stats.taken.aiAvgR)}</span>{d.hasNotes ? ' 📝' : ''}
          </button>
        ))}
      </div>
      {data.detail && <DayDetail key={data.detail.date} doc={data.detail} onSave={saveNotes} msg={msg} />}
    </div>
  );
}

function DayDetail({ doc, live = false, onSave, msg }: { doc: LabDoc; live?: boolean; onSave: (d: string, n: string) => void; msg: string }) {
  const [draft, setDraft] = useState<HTMLTextAreaElement | null>(null);
  return (
    <div style={{ border: `1px solid ${live ? 'rgba(125,211,252,0.4)' : 'var(--border-primary)'}`, borderRadius: 10, padding: 10, marginBottom: 10 }}>
      <div style={{ fontWeight: 800, marginBottom: 6 }}>
        {live ? '⏳ 今日盤中（尚未凍結）' : '🔒 凍結記錄'} {doc.date}
        <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 'calc(12px * var(--fz))' }}> · 模型 {doc.model} · {doc.version} · 規則 {doc.deskVersion}{doc.frozenAt ? ` · 凍結 ${hhmm(doc.frozenAt)}` : doc.updatedAt ? ` · 更新 ${hhmm(doc.updatedAt)}` : ''}</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', minWidth: 980, fontSize: 'calc(12px * var(--fz))' }}>
          <thead><tr style={{ color: 'var(--text-muted)' }}>
            {['觸發', '方向', '個股', 'Setup', 'AI', '信心', '理由／風險', '觸發價', '成交價', '延遲', '停損', '出場', '規則R', 'AI R'].map(h => <th key={h} style={{ padding: '3px 6px', textAlign: 'left', borderBottom: '1px solid var(--border-primary)' }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {!doc.records.length && <tr><td colSpan={14} style={{ padding: 8, color: 'var(--text-muted)' }}>{doc.reviewNote || '今日無觸發'}</td></tr>}
            {doc.records.map(r => (
              <tr key={r.id} style={{ borderBottom: '1px dashed var(--border-primary)' }}>
                <td style={{ ...NUM, textAlign: 'left', padding: '3px 6px' }}>{hhmm(r.triggerAt)}</td>
                <td style={{ padding: '3px 6px', color: r.side === 'long' ? 'var(--color-up)' : 'var(--color-down)' }}>{r.side === 'long' ? '多' : '空'}</td>
                <td style={{ padding: '3px 6px', whiteSpace: 'nowrap' }}>{r.code} {r.name}</td>
                <td style={{ padding: '3px 6px' }} title={r.why}>{r.type}</td>
                <td style={{ padding: '3px 6px', color: STATUS[r.status]?.c, fontWeight: 700, whiteSpace: 'nowrap' }}>{STATUS[r.status]?.t ?? r.status}</td>
                <td style={{ ...NUM, padding: '3px 6px' }}>{r.confidence ?? '—'}</td>
                <td style={{ padding: '3px 6px', maxWidth: '22em' }}>{r.reason}{r.risk ? <span style={{ color: '#f59e0b' }}>｜{r.risk}</span> : null}</td>
                <td style={{ ...NUM, padding: '3px 6px' }}>{r.triggerPx}</td>
                <td style={{ ...NUM, padding: '3px 6px' }}>{r.fillPx ?? '—'}</td>
                <td style={{ ...NUM, padding: '3px 6px' }}>{r.lagMs != null ? `${Math.round(r.lagMs / 1000)}s` : '—'}</td>
                <td style={{ ...NUM, padding: '3px 6px' }}>{r.stop}</td>
                <td style={{ padding: '3px 6px', whiteSpace: 'nowrap' }}>{r.exitReason ? `${hhmm(r.exitAt)} ${r.exitReason} @${r.exitPx}` : '—'}</td>
                <td style={{ ...NUM, padding: '3px 6px', color: rC(r.ruleNetR) }}>{R(r.ruleNetR)}</td>
                <td style={{ ...NUM, padding: '3px 6px', color: rC(r.aiNetR), fontWeight: 800 }}>{R(r.aiNetR)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!live && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(22em, 1fr))', gap: 12, marginTop: 10 }}>
          <div>
            <div style={{ fontWeight: 800, marginBottom: 4 }}>🤖 檢討</div>
            <div style={{ lineHeight: 1.7 }}>
              <div><b style={{ color: '#22c55e' }}>做對（程式判定）</b>：{doc.facts?.worked.length ? doc.facts.worked.join('；') : '無'}</div>
              <div><b style={{ color: '#ef4444' }}>做錯（程式判定）</b>：{doc.facts?.failed.length ? doc.facts.failed.join('；') : '無'}</div>
              {doc.review ? <>
                <div style={{ marginTop: 4 }}><b>AI 總評</b><span style={{ color: 'var(--text-muted)' }}>（AI 撰寫，未經驗證）</span>：{doc.review.summary}</div>
                {doc.review.improvements.length > 0 && <div><b style={{ color: '#fbbf24' }}>AI 改進建議（下一日檢驗）</b>：<ol style={{ margin: '2px 0 0 1.2em', padding: 0 }}>{doc.review.improvements.map((x, i) => <li key={i}>{x}</li>)}</ol></div>}
              </> : <div style={{ color: 'var(--text-muted)' }}>{doc.reviewNote || 'AI 總評產生失敗（Ollama 未回覆或格式錯誤）'}</div>}
            </div>
          </div>
          <div>
            <div style={{ fontWeight: 800, marginBottom: 4 }}>📝 人工檢討與改進說明{doc.adminNotesAt ? <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>（{doc.adminBy}·{new Date(doc.adminNotesAt + 8 * 3600000).toISOString().slice(5, 16).replace('T', ' ')}）</span> : null}</div>
            {/* 非受控：後台有即時監聽會重繪，受控輸入會把游標打回開頭（CLAUDE.md） */}
            <textarea ref={setDraft} defaultValue={doc.adminNotes || ''} rows={6} maxLength={4000} placeholder="例：AI 在 10 點後的突破回踩一律做，但反事實顯示這類平均 −0.5R；下週測試「10 點後只做分數 ≥70」"
              style={{ width: '100%', boxSizing: 'border-box', padding: 8, borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 'calc(13px * var(--fz))', lineHeight: 1.6 }} />
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 4 }}>
              <button onClick={() => draft && onSave(doc.date, draft.value)} style={{ padding: '4px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', background: 'rgba(125,211,252,0.2)', color: '#7dd3fc', fontWeight: 800 }}>儲存檢討</button>
              <span style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>{msg}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
