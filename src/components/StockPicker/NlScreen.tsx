'use client';

import { useEffect, useRef, useState } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';

// ── 自然語言選股：使用者用白話描述條件 → daemon 用 LLM 轉成篩選條件 + 套用全市場
//    評分/RS/殖利率/新高/外資連買/月營收 → 回傳符合清單。 ──

const PREMIUM = ['premium', 'admin', 'superadmin'];

interface Result {
  code: string; name: string; score: number; signal: string; rs: number | null; yield: number | null;
  rsi5?: number; rsi10?: number;
  rng60?: number; hi60?: number; lo60?: number; offHigh60?: number; offLow60?: number;
}
interface Doc { query: string; status: string; at?: number; results?: Result[]; count?: number; filters?: Record<string, unknown>; error?: string; note?: string; interpreted?: string }

const SIG: Record<string, { t: string; c: string }> = {
  STRONG_BUY: { t: '強力買進', c: '#dc2626' }, BUY: { t: '買進', c: '#f97316' },
  WATCH: { t: '觀察', c: '#f59e0b' }, NEUTRAL: { t: '中性', c: '#94a3b8' },
};
const EXAMPLES = [
  '外資連買且月營收年增超過30%',
  '近60日最高與最低差距超過60%',
  '從60日高點回檔超過三成',
  '評分80以上、創新高的股票',
  '殖利率5%以上的便宜股',
  'RSI5在60~75且RSI10大於60',
];

export default function NlScreen() {
  const user = useAppStore(st => st.user);
  const navigateTo = useAppStore(st => st.navigateTo);
  const isPremium = !!user && PREMIUM.includes(user.level);
  const [data, setData] = useState<Doc | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);   // 預設收合，見下方註解
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!user?.uid || !db || typeof (db as { type?: unknown }).type === 'undefined') return;
    const ref = doc(db, 'users', user.uid, 'data', 'nlScreen');
    const unsub = onSnapshot(ref, snap => setData(snap.exists() ? (snap.data() as Doc) : null), () => {});
    return () => unsub();
  }, [user?.uid]);

  // 這一輪是不是使用者自己按了「選股」（而不是 onSnapshot 把上次的舊結果帶進來）
  const selfSubmitted = useRef(false);

  // ⚠ 必須放在任何 early return **之前**（Hook 規則：每次渲染呼叫順序要一致）。
  //   送出後要自動展開，否則使用者看不到任何回應會以為壞掉；
  //   但**不能**因為 Firestore 帶回「上一次的查詢結果」就展開——
  //   nlScreen 這份文件是常駐的，status 會一直停在 'done'，於是每次進選股頁
  //   這一區都是打開的，等於「預設收合」從來沒有生效過（2026-08-12 使用者回報）。
  //   ⇒ 只有兩種情況自動展開：①這一次是自己送出的 ②查詢真的還在跑（5 分鐘內的 pending）。
  useEffect(() => {
    const st = data?.status;
    if (!st) return;
    const stillRunning = st === 'pending' && data?.at != null && Date.now() - data.at < 5 * 60_000;
    if (selfSubmitted.current || stillRunning) setOpen(true);
  }, [data?.status, data?.at]);

  const run = async () => {
    if (!q.trim() || !user?.uid || sending) return;
    selfSubmitted.current = true;   // 之後的 status 變化才算「我造成的」
    setSending(true);
    try { await setDoc(doc(db, 'users', user.uid, 'data', 'nlScreen'), { query: q.trim().slice(0, 120), status: 'pending', at: Date.now() }); }
    catch { alert('送出失敗'); }
    setSending(false);
  };

  if (!isPremium) return (
    <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', border: '1px solid var(--border-primary)', borderRadius: 12, marginBottom: 16 }}>
      🔒 自然語言選股為高級會員功能
    </div>
  );

  const pending = data?.status === 'pending';
  return (
    <div style={{ marginBottom: 18, padding: open ? '14px 16px' : '10px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
      {/* ⚠ 預設收合（2026-08-11 使用者要求「問 AI 要可以收合查詢內容」）：
          這一區平時只是入口，卻固定佔掉輸入框＋範例鈕＋結果清單的高度，
          把下面真正每天在用的分頁列一路往下推。
          收起時只留一行標題（仍顯示「上次：…→ N 檔」摘要），只有這次送出才自動展開。 */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: 0,
          background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', textAlign: 'left',
          fontWeight: 700, marginBottom: open ? 8 : 0, fontSize: 'calc(14px * var(--fz))' }}>
        <span style={{ color: 'var(--text-muted)', fontSize: 'calc(11px * var(--fz))' }}>{open ? '▾' : '▸'}</span>
        <span>🗣️ 自然語言選股</span>
        <span style={{ fontWeight: 400, fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {open ? '用白話描述，AI 幫你篩（約 10–40 秒）'
                : (data?.status === 'done' ? `上次：「${data.query}」→ ${data.count} 檔` : '用白話描述，AI 幫你篩')}
        </span>
      </button>
      {open && (<>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input className="input" value={q} maxLength={120} placeholder="例：外資連買且月營收年增超過30%"
          onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') run(); }} style={{ flex: 1 }} />
        <button className="btn btn-buy" onClick={run} disabled={sending || !q.trim() || pending}>{pending ? '篩選中…' : '選股'}</button>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: data ? 12 : 0 }}>
        {EXAMPLES.map(e => <button key={e} onClick={() => setQ(e)} style={{ fontSize: 'calc(12px * var(--fz))', padding: '3px 10px', borderRadius: 14, border: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', cursor: 'pointer' }}>{e}</button>)}
      </div>

      {pending && <div style={{ color: 'var(--text-muted)', fontSize: 'calc(13px * var(--fz))' }}>🤔 AI 解析需求並篩選全市場中…</div>}
      {data?.status === 'error' && (
        <div style={{ color: '#ef4444', fontSize: 'calc(13px * var(--fz))', whiteSpace: 'pre-wrap' }}>
          {data.error || '解析失敗，請換個說法再試。'}
        </div>
      )}
      {data?.status === 'done' && (
        <div>
          <div style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-secondary)', marginBottom: 8 }}>「<span style={{ color: '#7dd3fc' }}>{data.query}</span>」→ 找到 <b style={{ color: '#fbbf24' }}>{data.count}</b> 檔{(data.count ?? 0) > 30 ? '（顯示前30）' : ''}</div>
          {/* 條件回譯：誤讀擺在使用者眼前，不用他去猜 AI 怎麼理解 */}
          {data.interpreted && (
            <div style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-secondary)', marginBottom: 8, padding: '6px 10px', background: 'var(--bg-tertiary)', borderRadius: 8 }}>
              🔍 實際套用的條件：<b style={{ color: '#7dd3fc' }}>{data.interpreted}</b>
              <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>與你的意思不同的話，換句話再問一次。</div>
            </div>
          )}
          {data.note && (
            <div style={{ fontSize: 'calc(12px * var(--fz))', color: '#f59e0b', marginBottom: 8, padding: '6px 10px', background: 'rgba(245,158,11,0.08)', borderRadius: 8, whiteSpace: 'pre-wrap' }}>
              ⚠ {data.note}
            </div>
          )}
          {(data.results || []).length === 0 && <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)' }}>沒有符合條件的股票，試試放寬條件。</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px,1fr))', gap: 8 }}>
            {(data.results || []).map(r => (
              <div key={r.code} onClick={() => navigateTo('stock', r.code)} style={{ cursor: 'pointer', padding: '8px 10px', background: 'var(--bg-tertiary)', borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 'calc(13px * var(--fz))', color: 'var(--text-primary)' }}>
                    <span style={{ color: '#e2e8f0' }}>{r.code}</span> <span style={{ fontWeight: 600, color: '#7dd3fc' }}>{r.name}</span>
                  </div>
                  <div style={{ fontSize: 'calc(11px * var(--fz))', color: 'var(--text-secondary)' }}>
                    評分 <b style={{ color: '#fbbf24' }}>{r.score}</b>
                    {r.rs != null && <> · RS <b style={{ color: '#fbbf24' }}>{r.rs}</b></>}
                    {r.yield != null && <> · 殖 <b style={{ color: '#fbbf24' }}>{r.yield}%</b></>}
                    {r.rsi5 != null && <> · RSI <b style={{ color: '#fbbf24' }}>{r.rsi5}</b>/<b style={{ color: '#fbbf24' }}>{r.rsi10}</b></>}
                  </div>
                  {/* 命中條件的實際數值——讓使用者能自己驗算，不是只給一份名單 */}
                  {r.rng60 != null && (
                    <div style={{ fontSize: 'calc(11px * var(--fz))', color: 'var(--text-secondary)' }}>
                      60日振幅 <b style={{ color: '#fbbf24' }}>{r.rng60}%</b>
                      <span style={{ color: 'var(--text-muted)' }}>（{r.lo60}→{r.hi60}）</span>
                      {r.offHigh60 != null && <> · 距高 <b style={{ color: '#22c55e' }}>{r.offHigh60}%</b></>}
                      {r.offLow60 != null && <> · 距低 <b style={{ color: '#f03e3e' }}>+{r.offLow60}%</b></>}
                    </div>
                  )}
                </div>
                <span style={{ fontSize: 'calc(11px * var(--fz))', fontWeight: 700, color: (SIG[r.signal] || SIG.NEUTRAL).c, whiteSpace: 'nowrap', marginLeft: 6 }}>{(SIG[r.signal] || SIG.NEUTRAL).t}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      </>)}
    </div>
  );
}
