'use client';

// ── 📈 營運數據（AdminPanel 第四分頁，僅 superadmin）──────────────
// 讀 daemon 每日彙總（compute-analytics.mjs 17:00 後寫入）：
//   platformStats  平台匿名彙總（招募展示口徑）
//   usageSummary   DAU/WAU/MAU、留存、動作/頁面熱度
//   userPerf       每使用者交易績效表
//   featureAttribution 功能別勝率（經由X功能選出的交易實際勝率）

import { useEffect, useState } from 'react';
import { doc, getDoc, collection, getDocs } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import CostReference from '@/components/shared/CostReference';

interface Perf { winRate: number | null; moneyWinRate: number | null; netRealizedPnL: number; closed: number; totalTrades: number; totalBuyAmount: number; payoff: number | null; expectancy: number | null; maxConsecLoss: number; holdDaysMedian: number | null; overnightShare: number | null; dayTrades: number }
interface AttrBucket { n: number; winRate: number; totalPnL: number; avgPnL: number }

const fmt = (n: number | null | undefined) => n == null ? '—' : n.toLocaleString();
const money = (n: number | null | undefined) => n == null ? '—' : (n >= 0 ? '+' : '') + Math.round(n).toLocaleString();

export default function OpsPanel({ userNameOf }: { userNameOf: (uid: string) => string }) {
  const [platform, setPlatform] = useState<Record<string, unknown> | null>(null);
  const [usage, setUsage] = useState<Record<string, unknown> | null>(null);
  const [attr, setAttr] = useState<Record<string, AttrBucket> | null>(null);
  const [perfs, setPerfs] = useState<{ uid: string; p: Perf }[]>([]);
  const [tail, setTail] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [ps, us, fa, up, tt] = await Promise.all([
          getDoc(doc(db, 'platformStats', 'latest')),
          getDoc(doc(db, 'usageSummary', 'latest')),
          getDoc(doc(db, 'featureAttribution', 'latest')),
          getDocs(collection(db, 'userPerf')),
          getDoc(doc(db, 'tailTrack', 'summary')).catch(() => null),
        ]);
        setPlatform(ps.exists() ? ps.data() : null);
        setUsage(us.exists() ? us.data() : null);
        setAttr(fa.exists() ? (fa.data()?.buckets ?? null) : null);
        setPerfs(up.docs.map(d => ({ uid: d.id, p: d.data() as Perf })).sort((a, b) => (b.p.netRealizedPnL ?? 0) - (a.p.netRealizedPnL ?? 0)));
        setTail(tt && tt.exists() ? tt.data() : null);
      } catch (e) { setErr(String(e)); }
    })();
  }, []);

  if (err) return <div style={{ padding: 16, fontSize: 'calc(13px * var(--fz))', color: '#f87171' }}>載入失敗（權限或資料未生成）：{err.slice(0, 120)}</div>;

  const dau = (usage?.dau ?? {}) as Record<string, number>;
  const dauDays = Object.keys(dau).sort().slice(-14);
  const maxDau = Math.max(1, ...dauDays.map(d => dau[d]));
  const ret = usage?.retention as { d1: number | null; d1n: number; d7: number | null; d7n: number } | undefined;
  const actions = Object.entries((usage?.actions ?? {}) as Record<string, number>).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const pages = Object.entries((usage?.pages ?? {}) as Record<string, number>).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const attrRows = attr ? Object.entries(attr).sort((a, b) => b[1].n - a[1].n) : [];

  const card: React.CSSProperties = { padding: '12px 14px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' };
  const h: React.CSSProperties = { fontWeight: 900, fontSize: 'calc(13.5px * var(--fz))', marginBottom: 8 };

  return (
    <div style={{ display: 'grid', gap: 12, fontSize: 'calc(13.5px * var(--fz))' }}>
      {/* 撿尾盤實盤前追蹤（live out-of-sample·對照歷史回測） */}
      <div style={card}>
        <div style={h}>🪣 撿尾盤實盤前追蹤（每日 13:50 存證 → 次日對答案·未扣成本）</div>
        {tail ? (
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
            <span>累積 <b>{String(tail.n ?? 0)}</b> 筆／<b>{String(tail.days ?? 0)}</b> 日</span>
            <span>明開賣 均報 <b>{String(tail.openAvg ?? '—')}%</b>·勝率 <b>{String(tail.openWinPct ?? '—')}%</b>（回測對照 +0.50%）</span>
            <span>明收賣 均報 <b>{String(tail.closeAvg ?? '—')}%</b>·勝率 <b>{String(tail.closeWinPct ?? '—')}%</b></span>
            <span>炒作型開賣 <b>{String(tail.hotOpenAvg ?? '—')}%</b>（回測對照 +0.73%）</span>
            <span style={{ color: 'var(--text-muted)' }}><CostReference holdDays={[1]} /></span>
          </div>
        ) : <div style={{ color: 'var(--text-muted)' }}>尚無資料——首個交易日 13:50 起自動累積；累積足夠後作為「實測 vs 回測」偏差依據。</div>}
      </div>
      {/* 平台彙總（招募口徑：匿名） */}
      <div style={card}>
        <div style={h}>🏛 平台彙總（匿名·招募展示口徑）</div>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          <span>註冊 <b>{fmt(platform?.users as number)}</b> 人</span>
          <span>有交易 <b>{fmt(platform?.activeTraders as number)}</b> 人</span>
          <span>結算交易 <b>{fmt(platform?.closed as number)}</b> 筆</span>
          <span>整體勝率 <b style={{ color: '#7dd3fc' }}>{platform?.winRate != null ? `${platform.winRate}%` : '—'}</b></span>
          <span>累計淨損益 <b style={{ color: ((platform?.netPnL as number) ?? 0) >= 0 ? '#f03e3e' : '#2f9e44' }}>{money(platform?.netPnL as number)}</b> 元</span>
          <span>累計買進 <b>{fmt(platform?.buyAmt as number)}</b> 元</span>
        </div>
      </div>

      {/* 活躍與留存 */}
      <div style={card}>
        <div style={h}>📅 活躍與留存（近 35 天視窗）</div>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 8 }}>
          <span>今日 DAU <b>{fmt(usage?.todayDau as number)}</b></span>
          <span>WAU <b>{fmt(usage?.wau as number)}</b></span>
          <span>MAU <b>{fmt(usage?.mau as number)}</b></span>
          <span>D1 留存 <b>{ret?.d1 != null ? `${ret.d1}%` : '—'}</b>（n={ret?.d1n ?? 0}）</span>
          <span>D7 留存 <b>{ret?.d7 != null ? `${ret.d7}%` : '—'}</b>（n={ret?.d7n ?? 0}）</span>
        </div>
        {/* DAU 迷你長條 */}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 46 }}>
          {dauDays.map(d => (
            <div key={d} title={`${d}：${dau[d]} 人`} style={{ flex: 1, background: 'rgba(125,211,252,0.55)', borderRadius: 3, height: `${dau[d] / maxDau * 100}%`, minHeight: 3 }} />
          ))}
        </div>
        <div style={{ fontSize: 'calc(13.5px * var(--fz))', color: 'var(--text-muted)', marginTop: 3 }}>{dauDays[0]} → {dauDays[dauDays.length - 1]}（樣本小時留存僅供參考）</div>
      </div>

      {/* 功能歸因勝率 */}
      <div style={card}>
        <div style={h}>🧭 決策歸因——經由哪個功能選出的交易勝率（買入時 PIT 快照 × 關單結果）</div>
        {attrRows.length === 0 ? (
          <div style={{ color: 'var(--text-muted)' }}>樣本累積中——部署後的每筆「買入」都會自動快照當下榜單與足跡，賣出結算後在此呈現。這是「從使用者決策學習提高勝率」的核心資料。</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 'calc(13.5px * var(--fz))' }}>
              <th style={{ padding: '3px 6px' }}>功能來源</th><th>樣本</th><th>勝率</th><th>總損益</th><th>平均/筆</th>
            </tr></thead>
            <tbody>
              {attrRows.map(([k, v]) => (
                <tr key={k} style={{ borderTop: '1px solid var(--border-primary)' }}>
                  <td style={{ padding: '4px 6px', fontWeight: 700 }}>{k}</td>
                  <td>{v.n}</td>
                  <td style={{ color: v.winRate >= 50 ? '#f03e3e' : 'var(--text-secondary)', fontWeight: 800 }}>{v.winRate}%</td>
                  <td style={{ color: v.totalPnL >= 0 ? '#f03e3e' : '#2f9e44' }}>{money(v.totalPnL)}</td>
                  <td style={{ color: v.avgPnL >= 0 ? '#f03e3e' : '#2f9e44' }}>{money(v.avgPnL)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 使用者績效表 */}
      <div style={card}>
        <div style={h}>👤 使用者交易績效（僅管理員可見；對外一律匿名彙總）</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', whiteSpace: 'nowrap' }}>
            <thead><tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 'calc(13.5px * var(--fz))' }}>
              <th style={{ padding: '3px 6px' }}>用戶</th><th>交易</th><th>結算</th><th>勝率</th><th>金額勝率</th><th>淨損益</th><th>賺賠比</th><th>期望/筆</th><th>連敗</th><th>持有中位</th><th>隔日沖%</th>
            </tr></thead>
            <tbody>
              {perfs.map(({ uid, p }) => (
                <tr key={uid} style={{ borderTop: '1px solid var(--border-primary)' }}>
                  <td style={{ padding: '4px 6px', fontWeight: 700 }}>{userNameOf(uid)}</td>
                  <td>{p.totalTrades}</td><td>{p.closed}</td>
                  <td style={{ fontWeight: 800, color: (p.winRate ?? 0) >= 50 ? '#f03e3e' : 'var(--text-secondary)' }}>{p.winRate != null ? `${p.winRate}%` : '—'}</td>
                  <td>{p.moneyWinRate != null ? `${p.moneyWinRate}%` : '—'}</td>
                  <td style={{ fontWeight: 800, color: p.netRealizedPnL >= 0 ? '#f03e3e' : '#2f9e44' }}>{money(p.netRealizedPnL)}</td>
                  <td>{p.payoff ?? '—'}</td><td>{money(p.expectancy)}</td><td>{p.maxConsecLoss}</td>
                  <td>{p.holdDaysMedian != null ? `${p.holdDaysMedian}天` : '—'}</td>
                  <td>{p.overnightShare != null ? `${p.overnightShare}%` : '—'}</td>
                </tr>
              ))}
              {perfs.length === 0 && <tr><td colSpan={11} style={{ padding: 8, color: 'var(--text-muted)' }}>尚無交易績效資料。</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* 動作與頁面熱度 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(260px, 100%),1fr))', gap: 12 }}>
        <div style={card}>
          <div style={h}>🔥 動作熱度 Top10</div>
          {actions.map(([a, n]) => <div key={a} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}><span>{a}</span><b>{n.toLocaleString()}</b></div>)}
        </div>
        <div style={card}>
          <div style={h}>📄 頁面熱度 Top10</div>
          {pages.map(([a, n]) => <div key={a} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}><span>{a}</span><b>{n.toLocaleString()}</b></div>)}
        </div>
      </div>

      <div style={{ fontSize: 'calc(13.5px * var(--fz))', color: 'var(--text-muted)' }}>
        彙總由常駐服務每日 17:00 後更新；財務明細僅本人與管理員可見，對外展示一律匿名彙總（見隱私聲明）。
      </div>
    </div>
  );
}
