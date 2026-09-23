'use client';

// ── 🤖 AI 實驗·波段持有（超級管理員專用）──────────────────────────────
// 盤後由本機 Ollama 從本站波段榜（波段起漲＋波段持有整合榜，排除處置股）挑 ≤5 檔 → D+1 開盤模擬買進；
// 選股當下凍結（含選股原因、LLM 模型名稱與 digest、完整 prompt 與原始回覆），5/10/20/60/120 日到期逐一結算、算完不改。
// 判斷 AI 有沒有用：看「選中的」有沒有贏「同一天整個候選池」。換模型的成績分開看。
import { useCallback, useEffect, useState } from 'react';
import { auth } from '@/lib/firebase';
import type { SwingLabDoc, SwingHorizonStat } from '../../../scripts/lib/ai-swing-lab.mjs';

const HS = [5, 10, 20, 60, 120];
interface Resp { found: boolean; stats: Record<string, SwingHorizonStat>; byModel: Record<string, Record<string, SwingHorizonStat>>; days: { date: string; model: string | null; picks: string[]; settled: number[]; hasNotes: boolean }[]; detail: SwingLabDoc | null; error?: string }

const NUM: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums', textAlign: 'right', whiteSpace: 'nowrap', padding: '3px 8px' };
const rC = (v: number | null | undefined) => (v == null ? 'var(--text-muted)' : v > 0 ? 'var(--color-up)' : v < 0 ? 'var(--color-down)' : 'var(--text-muted)');
const P = (v: number | null | undefined, u = '%') => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}${u}`);

async function authed(input: string, init: RequestInit = {}) {
  const token = (await auth.currentUser?.getIdToken()) ?? '';
  return fetch(input, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
}

function StatTable({ title, stats }: { title: string; stats: Record<string, SwingHorizonStat> }) {
  return (
    <div style={{ overflowX: 'auto', marginBottom: 8 }}>
      <table style={{ borderCollapse: 'collapse', minWidth: 640, fontSize: 'calc(12.5px * var(--fz))' }}>
        <thead><tr style={{ color: 'var(--text-muted)' }}>
          {[title, '已結算日數', '選股筆數', 'AI 平均', 'AI 勝率', '整池平均', '超額', '贏池比例'].map(h => <th key={h} style={{ padding: '3px 8px', textAlign: h === title ? 'left' : 'right', borderBottom: '1px solid var(--border-primary)' }}>{h}</th>)}
        </tr></thead>
        <tbody>{HS.map(h => { const s = stats[h]; return (
          <tr key={h}>
            <td style={{ padding: '3px 8px' }}>持有 {h} 日</td>
            <td style={NUM}>{s?.days ?? 0}</td>
            <td style={NUM}>{s?.n ?? 0}{(s?.n ?? 0) < 30 ? <span style={{ color: '#f59e0b' }}>*</span> : null}</td>
            <td style={{ ...NUM, color: rC(s?.avg) }}>{P(s?.avg)}</td>
            <td style={NUM}>{s?.win == null ? '—' : `${s.win}%`}</td>
            <td style={{ ...NUM, color: rC(s?.poolAvg) }}>{P(s?.poolAvg)}</td>
            <td style={{ ...NUM, color: rC(s?.excess), fontWeight: 800 }}>{P(s?.excess, 'pp')}</td>
            <td style={NUM}>{s?.beatPool == null ? '—' : `${s.beatPool}%`}</td>
          </tr>); })}</tbody>
      </table>
    </div>
  );
}

export default function AiSwingLab() {
  const [data, setData] = useState<Resp | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [draft, setDraft] = useState<HTMLTextAreaElement | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const load = useCallback(async (d: string | null) => {
    try { const r = await authed(`/api/admin/ai-swing-lab${d ? `?date=${d}` : ''}`); const j = await r.json(); setData(r.ok ? j : { ...j, found: false }); }
    catch { setData({ found: false, stats: {}, byModel: {}, days: [], detail: null, error: '載入失敗' }); }
  }, []);
  useEffect(() => { load(date); }, [load, date]);

  if (!data) return <div style={{ padding: 16, color: 'var(--text-muted)' }}>載入波段 AI 實驗…</div>;
  if (data.error) return <div style={{ padding: 16, color: '#ef4444' }}>{data.error}</div>;
  const d = data.detail;
  const save = async () => {
    if (!d || !draft) return;
    setMsg('儲存中…');
    const r = await authed('/api/admin/ai-swing-lab', { method: 'POST', body: JSON.stringify({ date: d.date, notes: draft.value }) });
    const j = await r.json().catch(() => ({}));
    setMsg(r.ok ? '✓ 已儲存（15 分鐘內同步到第二大腦）' : `✖ ${j.error || '儲存失敗'}`);
    if (r.ok) load(d.date);
  };
  return (
    <div style={{ fontSize: 'calc(13px * var(--fz))' }}>
      <div style={{ marginBottom: 10, lineHeight: 1.7, color: 'var(--text-muted)' }}>
        <b style={{ color: 'var(--text-primary)', fontSize: 'calc(15px * var(--fz))' }}>🤖 AI 實驗·波段持有</b>：每個交易日 17:00 後，本機 Ollama 從本站波段榜（波段起漲＋波段持有整合榜，排除處置股）挑最多 5 檔，
        隔日開盤模擬買進，持有 5／10／20／60／120 個交易日收盤結算（扣 0.4425%、除權息還原）。選股當下凍結：原因、LLM 模型與 digest、完整 prompt 與原始回覆都在記錄裡（第二大腦 <code>second-brain/swing-ai-lab/</code>）。
        <b>判斷 AI 有沒有用看「超額」（選中的 − 整池平均）</b>；n &lt; 30 只當假設。模擬交易，非投資建議。
      </div>
      {!data.found ? <div style={{ color: 'var(--text-muted)' }}>尚無記錄：下一個交易日 17:00 後開始。</div> : <>
        <StatTable title="全部模型" stats={data.stats} />
        {Object.keys(data.byModel).length > 1 && Object.entries(data.byModel).map(([m, s]) => <StatTable key={m} title={m} stats={s} />)}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '10px 0' }}>
          {data.days.map(x => (
            <button key={x.date} onClick={() => { setDate(x.date); setMsg(''); setShowPrompt(false); }}
              style={{ padding: '4px 10px', borderRadius: 8, border: '1px solid var(--border-primary)', cursor: 'pointer', background: d?.date === x.date ? 'rgba(125,211,252,0.15)' : 'transparent', color: 'var(--text-primary)', fontSize: 'calc(12px * var(--fz))' }}>
              {x.date.slice(5)} · {x.picks.length} 檔 · 已結算 {x.settled.length}/5{x.hasNotes ? ' 📝' : ''}
            </button>
          ))}
        </div>
        {d && (
          <div style={{ border: '1px solid var(--border-primary)', borderRadius: 10, padding: 10 }}>
            <div style={{ fontWeight: 800 }}>🔒 {d.date} 選股 <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 'calc(12px * var(--fz))' }}>
              · 模型 <b>{d.model?.name || '未知'}</b>（{d.model?.family || '—'}·{d.model?.parameterSize || '—'}·{d.model?.quantization || '—'}·{d.model?.digest ? d.model.digest.slice(0, 12) : '—'}）· 候選池 {d.pool.length} 檔 · {d.version}</span></div>
            <div style={{ color: 'var(--text-muted)', fontSize: 'calc(12px * var(--fz))', margin: '2px 0 6px' }}>大盤：{d.market || '—'}｜AI 整體看法：{d.note || '—'}</div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', minWidth: 900, fontSize: 'calc(12px * var(--fz))' }}>
                <thead><tr style={{ color: 'var(--text-muted)' }}>
                  {['個股', '信心', '預期', '選股原因', '風險', ...HS.map(h => `${h}日`)].map(h => <th key={h} style={{ padding: '3px 6px', textAlign: 'left', borderBottom: '1px solid var(--border-primary)' }}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {!d.picks.length && <tr><td colSpan={10} style={{ padding: 8, color: 'var(--text-muted)' }}>今日未選股</td></tr>}
                  {d.picks.map(p => (
                    <tr key={p.code} style={{ borderBottom: '1px dashed var(--border-primary)' }}>
                      <td style={{ padding: '3px 6px', whiteSpace: 'nowrap' }} title={p.sources.join('、')}>{p.code} {p.name}</td>
                      <td style={NUM}>{p.confidence}</td>
                      <td style={NUM}>{p.horizon ? `${p.horizon}日` : '—'}</td>
                      <td style={{ padding: '3px 6px', maxWidth: '26em' }}>{p.reason}</td>
                      <td style={{ padding: '3px 6px', color: '#f59e0b', maxWidth: '16em' }}>{p.risk}</td>
                      {HS.map(h => { const o = d.outcomes?.[h]?.picks.find(x => x.code === p.code); return (
                        <td key={h} title={o ? `${o.entryDate} 開 ${o.entryPx}${o.openMissing ? '（無開盤價，用收盤）' : ''} → ${o.exitDate} 收 ${o.exitPx}｜最深 ${o.maxDD}%／最高 ${o.maxUp}%${o.note ? `｜${o.note}` : ''}` : '未到期'}
                          style={{ ...NUM, color: rC(o?.net), fontWeight: p.horizon === h ? 800 : 400, textDecoration: p.horizon === h ? 'underline' : 'none' }}>{o ? P(o.net) : '…'}</td>); })}
                    </tr>
                  ))}
                  <tr style={{ color: 'var(--text-muted)' }}>
                    <td style={{ padding: '3px 6px' }} colSpan={5}>整池等權平均（同口徑基準）</td>
                    {HS.map(h => <td key={h} style={{ ...NUM, color: rC(d.outcomes?.[h]?.pool?.avg) }}>{d.outcomes?.[h]?.pool ? P(d.outcomes[h].pool!.avg) : '…'}</td>)}
                  </tr>
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 8 }}>
              <button onClick={() => setShowPrompt(v => !v)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#7dd3fc', fontSize: 'calc(12px * var(--fz))' }}>{showPrompt ? '▾' : '▸'} 稽核：完整 prompt 與 AI 原始回覆</button>
              {showPrompt && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 'calc(11.5px * var(--fz))', background: 'var(--bg-secondary)', padding: 8, borderRadius: 8, maxHeight: 360, overflow: 'auto' }}>{d.prompt || '（無）'}{'\n\n──── AI 原始回覆 ────\n'}{d.raw || '（無）'}</pre>}
            </div>
            <div style={{ marginTop: 10 }}>
              <div style={{ fontWeight: 800, marginBottom: 4 }}>📝 人工檢討與選股模型改進說明{d.adminNotesAt ? <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>（{d.adminBy}）</span> : null}</div>
              {/* 非受控：後台有即時監聽會重繪，受控輸入會把游標打回開頭（CLAUDE.md） */}
              <textarea key={d.date} ref={setDraft} defaultValue={d.adminNotes || ''} rows={5} maxLength={4000} placeholder="例：AI 偏好 60 日已漲 >70% 的強勢股，20 日超額為負；下一版 prompt 加入「60 日漲幅 >50% 不選」做對照"
                style={{ width: '100%', boxSizing: 'border-box', padding: 8, borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 'calc(13px * var(--fz))', lineHeight: 1.6 }} />
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 4 }}>
                <button onClick={save} style={{ padding: '4px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', background: 'rgba(125,211,252,0.2)', color: '#7dd3fc', fontWeight: 800 }}>儲存檢討</button>
                <span style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>{msg}</span>
              </div>
            </div>
          </div>
        )}
      </>}
    </div>
  );
}
