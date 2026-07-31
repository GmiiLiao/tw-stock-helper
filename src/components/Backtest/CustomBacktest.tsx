'use client';

import { useEffect, useState } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';

// ── 自訂策略回測器（全市場版）──
// 設定進出場規則 → daemon 對前 100 大成交值個股（或你的自選）跑近一年歷史。
// 與下方單股回測互補：這裡回答「這套規則在整個市場行不行」。

const ENTRIES = [
  { v: 'breakoutN', t: '突破 N 日新高', hasN: true },
  { v: 'maCross', t: 'MA5 黃金交叉 MA20', hasN: false },
  { v: 'rsiOversold', t: 'RSI14 超賣回升（<30→回升）', hasN: false },
  { v: 'volBreak', t: '爆量突破（3 倍量+漲2%）', hasN: false },
  { v: 'limitLock', t: '漲停鎖死（收盤=最高）', hasN: false },
  { v: 'gapUp', t: '跳空 2% 不回補收紅', hasN: false },
  { v: 'ma5Bounce', t: '多頭回踩 5 日線收復', hasN: false },
  { v: 'hammer', t: '長下影反轉（殺低收高）', hasN: false },
  { v: 'secondBar', t: '連漲第2根K＋今日漲2%（動能日）', hasN: false },
];

interface Result { universe: number; trades: number; winRate: number; avgRet: number; profitFactor: number | null; avgDays: number; exitDist: Record<string, number>; best: { code: string; name: string; ret: number }[]; worst: { code: string; name: string; ret: number }[] }
interface Doc { status: string; params?: unknown; result?: Result; error?: string; finishedAt?: number }

export default function CustomBacktest() {
  const user = useAppStore(st => st.user);
  const [d, setD] = useState<Doc | null>(null);
  const [entry, setEntry] = useState('breakoutN');
  const [n, setN] = useState('20');
  const [stopPct, setStopPct] = useState('7');
  const [targetPct, setTargetPct] = useState('15');
  const [maxDays, setMaxDays] = useState('20');
  const [maExit, setMaExit] = useState(false);
  const [universe, setUniverse] = useState('top100');

  useEffect(() => {
    if (!user?.uid || !db || typeof (db as { type?: unknown }).type === 'undefined') return;
    const unsub = onSnapshot(doc(db, 'users', user.uid, 'data', 'customBacktest'), snap => setD(snap.exists() ? (snap.data() as Doc) : null), () => {});
    return () => unsub();
  }, [user?.uid]);

  const run = async () => {
    if (!user?.uid) return;
    const params = {
      entry: { type: entry, n: Math.max(5, Math.min(60, parseInt(n) || 20)) },
      exit: { stopPct: Math.max(2, parseFloat(stopPct) || 7), targetPct: Math.max(3, parseFloat(targetPct) || 15), maxDays: Math.max(3, parseInt(maxDays) || 20), maExit },
      universe,
    };
    await setDoc(doc(db, 'users', user.uid, 'data', 'customBacktest'), { status: 'pending', params, at: Date.now() });
  };

  if (!user?.uid) return null;
  const pending = d?.status === 'pending';
  const r = d?.status === 'done' ? d.result : null;

  return (
    <div style={{ marginBottom: 18, padding: '16px 18px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>🧪 自訂策略回測（全市場）
        <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-muted)', marginLeft: 8 }}>daemon 跑前 100 大個股近一年歷史，約 1-2 分鐘</span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '10px 0' }}>
        <select className="input" value={entry} onChange={e => setEntry(e.target.value)} style={{ width: 210 }}>
          {ENTRIES.map(x => <option key={x.v} value={x.v}>{x.t}</option>)}
        </select>
        {ENTRIES.find(x => x.v === entry)?.hasN && <label style={{ fontSize: 12 }}>N=<input className="input" type="number" value={n} onChange={e => setN(e.target.value)} style={{ width: 60 }} /></label>}
        <label style={{ fontSize: 12 }}>停損%<input className="input" type="number" value={stopPct} onChange={e => setStopPct(e.target.value)} style={{ width: 60 }} /></label>
        <label style={{ fontSize: 12 }}>停利%<input className="input" type="number" value={targetPct} onChange={e => setTargetPct(e.target.value)} style={{ width: 60 }} /></label>
        <label style={{ fontSize: 12 }}>最長持有<input className="input" type="number" value={maxDays} onChange={e => setMaxDays(e.target.value)} style={{ width: 55 }} />日</label>
        <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={maExit} onChange={e => setMaExit(e.target.checked)} />跌破MA20出場</label>
        <select className="input" value={universe} onChange={e => setUniverse(e.target.value)} style={{ width: 130 }}>
          <option value="top100">前100大個股</option>
          <option value="watchlist">我的自選</option>
        </select>
        <button className="btn btn-buy" onClick={run} disabled={pending}>{pending ? '回測中…' : '開始回測'}</button>
      </div>

      {pending && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>⏳ daemon 正在抓取歷史並模擬交易，完成後自動顯示…</div>}
      {d?.status === 'error' && <div style={{ fontSize: 13, color: '#ef4444' }}>回測失敗：{d.error}</div>}
      {r && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px,1fr))', gap: 8, marginBottom: 10 }}>
            {[
              { l: '樣本', v: `${r.universe} 檔 / ${r.trades} 筆` },
              { l: '勝率', v: `${r.winRate}%`, c: r.winRate >= 55 ? 'var(--color-up)' : r.winRate >= 45 ? '#f59e0b' : 'var(--color-down)' },
              { l: '平均報酬', v: `${r.avgRet >= 0 ? '+' : ''}${r.avgRet}%`, c: r.avgRet >= 0 ? 'var(--color-up)' : 'var(--color-down)' },
              { l: '獲利因子', v: r.profitFactor != null ? `${r.profitFactor}` : '—', c: (r.profitFactor ?? 0) >= 1.5 ? 'var(--color-up)' : (r.profitFactor ?? 0) >= 1 ? '#f59e0b' : 'var(--color-down)' },
              { l: '平均持有', v: `${r.avgDays} 日` },
            ].map(x => (
              <div key={x.l} style={{ padding: '8px 10px', background: 'var(--bg-tertiary)', borderRadius: 8 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{x.l}</div>
                <div style={{ fontWeight: 800, color: x.c || 'var(--text-primary)', fontFamily: "'JetBrains Mono',monospace" }}>{x.v}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
            出場分布：{Object.entries(r.exitDist).map(([k, v]) => `${k} ${v}`).join(' · ')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            最佳：{r.best.map(t => `${t.code} +${t.ret}%`).join('、')}<br />
            最差：{r.worst.map(t => `${t.code} ${t.ret}%`).join('、')}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>※ 歷史模擬不代表未來績效；未含滑價，交易成本請自行斟酌約 0.6%/筆。</div>
        </div>
      )}
    </div>
  );
}
