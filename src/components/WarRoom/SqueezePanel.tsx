'use client';

// 軋空候選 —— 條件經 240 日 / 16.9 萬筆事件回測校準（見 daemon SQUEEZE_SKILL）。
// 這一頁的設計原則：**把邊際效益講清楚**。券資比的貢獻只有約 +1.5pp，
// 若做成「軋空預測神器」的口吻，使用者會照著重押，那是我們造成的傷害。
import { useEffect, useState } from 'react';
import { useAppStore } from '@/lib/store';

interface Item {
  code: string; name: string; price: number; chg: number;
  mgn: number; shrt: number; ratio: number; volX: number; tier: number; live: boolean;
  setup: number | null; band: string;
}
interface Data {
  updatedAt: number; priceDate: string; marginDate: string; rule: string;
  items: Item[]; count: number;
  evidence?: { base5d: number; baseWin: number; setupOnly: number; setupWin: number; bandOnly: number; bandWin: number; combo: number; comboWin: number; bNoA: number; bNoAWin: number; band20up: number; n: number; days: number };
}

export default function SqueezePanel() {
  const [d, setD] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const navigateTo = useAppStore(s => s.navigateTo);

  useEffect(() => {
    let live = true;
    const load = () => fetch('/api/ai/squeeze-picks')
      .then(r => (r.ok ? r.json() : null))
      .then(x => { if (live && x && !x.error) setD(x); })
      .catch(() => {})
      .finally(() => { if (live) setLoading(false); });
    load();
    const id = setInterval(load, 180_000);
    return () => { live = false; clearInterval(id); };
  }, []);

  const ev = d?.evidence;
  return (
    <div style={{ padding: '4px 0' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <h2 style={{ fontSize: 'calc(15px * var(--fz))', fontWeight: 800, margin: 0 }}>🩳 軋空候選</h2>
        {d && (
          <span style={{ fontSize: 'calc(11px * var(--fz))', color: 'var(--text-muted)' }}>
            {d.count} 檔 · 漲幅資料日 {d.priceDate} · <b>券資比資料日 {d.marginDate}</b>（融資券當日 21:45 才公布）
          </span>
        )}
      </div>

      {/* 實證揭露：邊際效益多小，講在最前面 */}
      {ev && (
        <div style={{ padding: '8px 12px', borderRadius: 8, marginBottom: 10, background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.3)', fontSize: 'calc(11.5px * var(--fz))', lineHeight: 1.65 }}>
          <div style={{ fontWeight: 700, color: '#f59e0b', marginBottom: 3 }}>實測校準（{ev.days} 日 / {ev.n.toLocaleString()} 筆事件·5 日報酬）</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto auto auto', gap: '1px 10px', marginBottom: 3 }}>
            <span style={{ color: 'var(--text-muted)' }}>純動能對照（僅漲≥5%）</span><span>+{ev.base5d}%</span><span style={{ color: 'var(--text-muted)' }}>勝率 {ev.baseWin}%</span>
            <span style={{ color: 'var(--text-muted)' }}>A 軋空啟動（昨券增）</span><span>+{ev.setupOnly}%</span><span style={{ color: 'var(--text-muted)' }}>勝率 {ev.setupWin}%</span>
            <span style={{ color: 'var(--text-muted)' }}>B 券資比 10~20%</span><span>+{ev.bandOnly}%</span><span style={{ color: 'var(--text-muted)' }}>勝率 {ev.bandWin}%</span>
            <span style={{ fontWeight: 700, color: '#22c55e' }}>⭐⭐ A∩B（兩者皆成立）</span><span style={{ fontWeight: 700, color: 'var(--color-up)' }}>+{ev.combo}%</span><span style={{ fontWeight: 700 }}>勝率 {ev.comboWin}%</span>
            <span style={{ color: 'var(--text-muted)' }}>⭐ 僅 B（無 A）</span><span>+{ev.bNoA}%</span><span style={{ color: 'var(--text-muted)' }}>勝率 {ev.bNoAWin}%（近段轉弱）</span>
          </div>
          <div style={{ color: 'var(--text-muted)' }}>
            ⇒ 相對純動能的邊際貢獻約 <b>+1.8pp</b>，是<b>傾向</b>不是預測。
            反直覺：券資比 <b>≥20% 反而掉到 +{ev.band20up}%</b>（低於純動能）——極高券資比多半是空方看對或避險空單，不會被軋，故本榜刻意排除。
          </div>
        </div>
      )}

      {loading && !d && <div style={{ color: 'var(--text-muted)', fontSize: 'calc(12px * var(--fz))' }}>載入中…</div>}
      {d && d.items.length === 0 && (
        <div style={{ padding: '18px 4px', color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))' }}>
          今日無符合條件的個股。條件嚴格是刻意的——放寬到「券資比越高越好」實測反而更差。
        </div>
      )}

      {d && d.items.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'calc(12px * var(--fz))', minWidth: 620 }}>
            <thead>
              <tr style={{ color: 'var(--text-muted)', textAlign: 'right' }}>
                <th style={{ padding: '6px 4px', textAlign: 'left' }}>分級</th>
                <th style={{ padding: '6px 4px', textAlign: 'left' }}>代號/名稱</th>
                <th style={{ padding: '6px 4px' }}>現價</th>
                <th style={{ padding: '6px 4px' }}>漲幅</th>
                <th style={{ padding: '6px 4px' }}>券資比</th>
                <th style={{ padding: '6px 4px' }}>昨券增(張)</th>
                <th style={{ padding: '6px 4px' }}>融資/融券(張)</th>
                <th style={{ padding: '6px 4px' }}>量增</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map(it => (
                <tr key={it.code} style={{ borderTop: '1px solid var(--border-primary)', textAlign: 'right' }}>
                  <td style={{ padding: '6px 4px', textAlign: 'left', whiteSpace: 'nowrap' }}>
                    {it.tier === 2 ? '⭐⭐' : '⭐'}
                    <span style={{ marginLeft: 4, fontSize: 'calc(10px * var(--fz))', color: 'var(--text-muted)' }}>
                      {it.tier === 2 ? 'A∩B' : '僅B'}
                    </span>
                  </td>
                  <td style={{ padding: '6px 4px', textAlign: 'left' }}>
                    <button onClick={() => navigateTo('stock', it.code)}
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-primary)', fontWeight: 700, textDecoration: 'underline dotted' }}>
                      {it.code} {it.name}
                    </button>
                  </td>
                  <td style={{ padding: '6px 4px', fontFamily: "'JetBrains Mono',monospace" }}>{it.price}</td>
                  <td style={{ padding: '6px 4px', color: 'var(--color-up)', fontWeight: 700 }}>+{it.chg}%</td>
                  <td style={{ padding: '6px 4px', fontWeight: 700, color: it.tier === 2 ? '#22c55e' : 'var(--text-primary)' }}>
                    {it.ratio}%<span style={{ marginLeft: 3, fontSize: 'calc(10px * var(--fz))', color: 'var(--text-muted)', fontWeight: 400 }}>{it.band}</span>
                  </td>
                  <td style={{ padding: '6px 4px', color: it.setup != null ? '#22c55e' : 'var(--text-muted)' }}>
                    {it.setup != null ? `+${it.setup.toLocaleString()}` : '—'}
                  </td>
                  <td style={{ padding: '6px 4px', color: 'var(--text-muted)' }}>{it.mgn.toLocaleString()} / {it.shrt.toLocaleString()}</td>
                  <td style={{ padding: '6px 4px' }}>{it.volX}x</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 10, fontSize: 'calc(11px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.6 }}>
        規則：{d?.rule || '漲≥5% × 券資比10~20% × 20日均量≥500張 × 價>10'}。
        「軋空啟動(A)」沿用站上撿尾盤既有的同名訊號（昨日融券增≥昨量0.5%，2 年稽核），不另立第二套定義。
        券資比＝融券餘額÷融資餘額，取<b>最近已公布</b>的交易日（t-1）；漲幅為當日。
        台股不適用美股常用的 days-to-cover（融券量相對成交量過小，回測樣本近乎 0）。
        <b>非投資建議。</b>
      </div>
    </div>
  );
}
