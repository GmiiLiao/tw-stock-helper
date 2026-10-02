'use client';

// 🧠 AI 交易員經驗庫（2026-09-30 使用者）：盤後訓練學到的風險／優勢特徵。
//   已驗證（前後期方向一致且顯著）才提供給 AI 交易員；觀察中只記錄。訓練：scripts/ai-lab-learn.mjs；純函式：scripts/lib/ai-lab-learn.mjs。
import { useEffect, useState } from 'react';
import { auth } from '@/lib/firebase';
import { Section, ListTable, tw } from './AiLabParts';

interface Rule { id: string; label: string; kind: 'risk' | 'edge'; status: 'validated' | 'observing'; n: number; mean: number | null; win: number | null; restMean: number | null; t: number | null; train: { n: number; diff: number | null }; holdout: { n: number; diff: number | null } }
interface KeyBlock { base: { n: number; mean: number | null; win: number | null }; split: { cut: string }; unit: string; rules: Rule[] }
interface LearnDoc { date: string; version: string; at: number; sources: Record<string, number>; learned: Record<string, KeyBlock> }

const NAME: Record<string, string> = {
  swing: '🌊 波段交易員', 'swing-buy': '🛒 AI 買進經驗（實驗＋會員帳戶的實際買進）', 'swing-sell': '📤 AI 賣出經驗（實驗＋會員帳戶的實際賣出；正＝賣出避開的跌幅）',
  'dt-long': '⏳ 當沖交易員·做多', 'dt-short': '⏳ 當沖交易員·做空',
  // 波段取樣實驗（2026-10-02；只記錄比對、不提供給 AI）
  'swing-x-rep': '🧪 取樣實驗①兩半複驗（奇偶兩組交易日都驗證且同向）', 'swing-x-cal': '🧪 取樣實驗②固定日曆錨點（日曆日偶數）', 'swing-x-all': '🧪 取樣實驗③每個交易日',
};
// 賣出經驗的 y＝賣出避開的跌幅：較差＝賣太早（賣後續漲）、較好＝賣得對（賣後下跌）；與絕對方向不一致者只是「相對」，不提供給 AI
//   （同 scripts/lib/ai-lab-learn.mjs kindText／sellVerdictOk）
const kindLabel = (key: string, r: Rule) => {
  if (key !== 'swing-sell') return r.kind === 'risk' ? '⚠風險' : '✓優勢';
  const ok = r.kind === 'edge' ? (r.mean ?? 0) > 0 : (r.mean ?? 0) < 0;
  if (!ok) return r.kind === 'risk' ? '相對較差（不提供給 AI）' : '相對較佳（不提供給 AI）';
  return r.kind === 'risk' ? '⚠賣太早' : '✓賣得對';
};
const sgn = (v: number | null) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}`);

export default function AiLabLearn() {
  const [doc, setDoc] = useState<LearnDoc | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'empty' | 'error'>('loading');
  const [showObs, setShowObs] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const token = (await auth.currentUser?.getIdToken()) ?? '';
        const r = await fetch('/api/admin/ai-lab-learn', { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        if (!alive) return;
        setDoc(j.doc); setState(j.found ? 'ok' : 'empty');
      } catch { if (alive) setState('error'); }
    })();
    return () => { alive = false; };
  }, []);

  return (
    <Section title="🧠 交易員經驗庫" sub={doc ? `盤後訓練 ${doc.date}（完成 ${tw(doc.at, true)}）·樣本 ${Object.entries(doc.sources || {}).map(([k, v]) => `${k} ${v.toLocaleString()}`).join('、')}` : '每個交易日 18:30 後盤後訓練'}>
      <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', marginBottom: 6 }}>
        失利的共同條件＝<b style={{ color: '#ef4444' }}>⚠風險</b>（未來辨別避開）、獲利的共同條件＝<b style={{ color: '#22c55e' }}>✓優勢</b>（提升選股可靠度）。每個條件與同類其餘樣本比較（波段與 AI 決策層以同日其他樣本為基準：先減同日平均、排除當天大盤漲跌——表中平均／其餘平均是原始值，判斷看訓練段／驗證段相對差）；日期前 70% 訓練、後 30% 驗證，
        兩段相對差同方向且顯著（|t|≥2）才「已驗證」並提供給 AI 交易員決策參考，其餘列「觀察中」只記錄。結果存第二大腦 second-brain/ai-lab-learn/，其他功能可讀 Firestore aiLabLearn/latest。歷史統計不保證未來，非投資建議。
      </div>
      {state === 'loading' && <div style={{ color: 'var(--text-muted)' }}>載入中…</div>}
      {state === 'error' && <div style={{ color: '#ef4444' }}>載入失敗</div>}
      {state === 'empty' && <div style={{ color: 'var(--text-muted)' }}>尚未訓練（下一個交易日 18:30 後）</div>}
      {doc && Object.entries(doc.learned || {}).map(([key, x]) => {
        const rules = x.rules.filter(r => showObs || r.status === 'validated');
        return (
          <div key={key} style={{ marginTop: 8 }}>
            <div style={{ fontWeight: 800, fontSize: 'calc(13.5px * var(--fz))' }}>{NAME[key] || key}　<span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))' }}>樣本 {x.base.n.toLocaleString()}·整體平均 {sgn(x.base.mean)}{x.unit === '淨R' ? 'R' : '%'}·勝率 {x.base.win}%·驗證段自 {x.split.cut}</span></div>
            <ListTable head={['狀態', '類型', '條件', '樣本', '平均', '勝率', '其餘平均', 't', '訓練段相對差', '驗證段相對差']} right={[3, 4, 5, 6, 7, 8, 9]}
              empty={x.base.n < 60 ? `樣本還少（${x.base.n}），持續累積中` : '尚無顯著條件'}
              rows={rules.map(r => [r.status === 'validated' ? '已驗證' : '觀察中', <b key="k" style={{ color: r.kind === 'risk' ? '#ef4444' : '#22c55e' }}>{kindLabel(key, r)}</b>, r.label,
                r.n.toLocaleString(), sgn(r.mean), `${r.win}%`, sgn(r.restMean), sgn(r.t), `${sgn(r.train.diff)}（${r.train.n}）`, `${sgn(r.holdout.diff)}（${r.holdout.n}）`])} />
          </div>
        );
      })}
      {doc && <button onClick={() => setShowObs(v => !v)} style={{ marginTop: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#7dd3fc', fontSize: 'calc(12.5px * var(--fz))' }}>{showObs ? '▾ 隱藏觀察中' : '▸ 顯示觀察中（未驗證、不提供給 AI）'}</button>}
    </Section>
  );
}
