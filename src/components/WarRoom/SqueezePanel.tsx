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
interface Verdict { label: string; bullish: boolean; confidence?: string; reason: string; basis: string; n?: number; nMaterial?: number }
interface RecItem extends Item { verdict?: Verdict; primary?: boolean; news?: { checked: number; material: number; priceOnly: number; basis: string; top: Array<{ title: string; link: string; at: number }> } }
interface Rec {
  updatedAt: number; targetDate: string | null; archDate: string | null; mode: string | null;
  modelMain: string | null; modelSqueeze: string | null; modelRunId: string | null;
  items: RecItem[]; primaryCount: number; newsSource?: string;
  global?: Record<string, { chg?: number | null; date?: string }>;
}
interface Data {
  updatedAt: number; priceDate: string; marginDate: string; rule: string;
  mode?: string; targetDate?: string | null; archDate?: string | null;
  items: Item[]; count: number;
  recent?: { n: number; days: number; avgNextDay: number; winRate: number } | null;
  evidence?: { base5d: number; baseWin: number; setupOnly: number; setupWin: number; bandOnly: number; bandWin: number; combo: number; comboWin: number; bNoA: number; bNoAWin: number; band20up: number; n: number; days: number };
}

export default function SqueezePanel() {
  const [d, setD] = useState<Data | null>(null);
  const [rec, setRec] = useState<Rec | null>(null);
  const [loading, setLoading] = useState(true);
  const navigateTo = useAppStore(s => s.navigateTo);

  useEffect(() => {
    let live = true;
    const load = () => {
      fetch('/api/ai/squeeze-picks').then(r => (r.ok ? r.json() : null))
        .then(x => { if (live && x && !x.error) setD(x); }).catch(() => {})
        .finally(() => { if (live) setLoading(false); });
      fetch('/api/ai/squeeze-recommend').then(r => (r.ok ? r.json() : null))
        .then(x => { if (live && x && !x.error && x.items) setRec(x); }).catch(() => {});
    };
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
            {d.count} 檔 · 分析資料日 {d.archDate ?? d.priceDate}
            {d.mode === 'nextday'
              ? <> · <b style={{ color: '#22c55e' }}>適用交易日 {d.targetDate}</b>（TWSE 盤後全資料到齊，同日券資比×同日漲幅，與回測定版同口徑）</>
              : <> · <b style={{ color: '#f59e0b' }}>盤中即時版（券資比為 {d.marginDate}，t-1）</b>——今晚 21:45 資券公布後才會更新為次交易日清單</>}
          </span>
        )}
      </div>

      {/* 近期實際戰績——擺在回測數字之前。使用者是隔日沖，會照著明天下單，
          只掛長期期望值而不講當下正在回檔，是不誠實的。 */}
      {d?.recent && (
        <div style={{
          padding: '8px 12px', borderRadius: 8, marginBottom: 8,
          background: d.recent.avgNextDay >= 0 ? 'rgba(34,197,94,0.07)' : 'rgba(239,68,68,0.07)',
          border: `1px solid ${d.recent.avgNextDay >= 0 ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.4)'}`,
          fontSize: 'calc(11.5px * var(--fz))', lineHeight: 1.65,
        }}>
          <div style={{ fontWeight: 700, marginBottom: 2, color: d.recent.avgNextDay >= 0 ? '#22c55e' : '#ef4444' }}>
            近 30 個交易日實際戰績（同一條規則回放）
          </div>
          <div>
            共選出 <b>{d.recent.n}</b> 檔次（{d.recent.days} 個有訊號日）·
            隔日平均 <b style={{ color: d.recent.avgNextDay >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
              {d.recent.avgNextDay >= 0 ? '+' : ''}{d.recent.avgNextDay}%
            </b> · 勝率 <b>{d.recent.winRate}%</b>
          </div>
          {d.recent.avgNextDay < 0 && (
            <div style={{ color: '#ef4444', fontWeight: 600 }}>
              ⚠ 訊號目前處於回檔期：近期隔日報酬為負，與長期期望值（+1.62%／勝率55%）背離。單日離散度很大（實測區間 −8.4% ~ +7.6%），請勿因為看到榜單就加大部位。
            </div>
          )}
        </div>
      )}

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
            ⇒ 上表為 <b>5 日</b>報酬。若做<b>隔日沖</b>：定版規則長期隔日 <b>+1.62%／勝率 55%</b>（三段全正），
            但邊際貢獻僅約 +1.8pp，是<b>傾向</b>不是預測。
            另外實測：<b>不看價格、只用籌碼（融券暴增／券資比跳進甜蜜點）選股是無效的</b>——
            隔日 −0.02% ~ +0.57%、勝率 46~48%，全數不如基準；必須有「當日已強漲」的價格確認才成立。
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

      {/* AI 新聞判別（開盤前 1 小時產出）——每一檔都有判別提示，含中性與資訊不足 */}
      {rec && rec.items.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 5 }}>
            <b style={{ fontSize: 'calc(13px * var(--fz))' }}>🤖 開盤前新聞判別</b>
            <span style={{ fontSize: 'calc(11px * var(--fz))', color: 'var(--text-muted)' }}>
              適用 <b>{rec.targetDate ?? '—'}</b> · 主力推薦 {rec.primaryCount} 檔 · 來源 {rec.newsSource ?? '—'} ·
              {rec.modelMain ? <> 模型 <code>{rec.modelMain}</code></> : ' 尚無模型'}
            </span>
          </div>
          {rec.global && Object.keys(rec.global).length > 0 && (
            <div style={{ fontSize: 'calc(11px * var(--fz))', color: 'var(--text-muted)', marginBottom: 6 }}>
              昨夜國際盤：{['sox', 'nasdaq', 'sp500', 'n225', 'kospi', 'vix']
                .filter(k => rec.global?.[k]).map(k => {
                  const v = rec.global![k].chg;
                  return <span key={k} style={{ marginRight: 8, color: (v ?? 0) >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
                    {k} {(v ?? 0) >= 0 ? '+' : ''}{v}%
                  </span>;
                })}
            </div>
          )}
          <div style={{ display: 'grid', gap: 6 }}>
            {rec.items.map(it => {
              const v = it.verdict;
              const c = v?.label === '利多' ? '#22c55e' : v?.label === '利空' ? '#ef4444' : v?.label === '中性' ? '#94a3b8' : '#64748b';
              return (
                <div key={it.code} style={{
                  padding: '7px 11px', borderRadius: 8,
                  background: it.primary ? 'rgba(34,197,94,0.08)' : 'var(--bg-elevated)',
                  border: `1px solid ${it.primary ? 'rgba(34,197,94,0.45)' : 'var(--border-primary)'}`,
                }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    {it.primary && <span style={{ fontWeight: 800, color: '#22c55e' }}>★ 主力推薦</span>}
                    <button onClick={() => navigateTo('stock', it.code)}
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-primary)', fontWeight: 700, textDecoration: 'underline dotted' }}>
                      {it.code} {it.name}
                    </button>
                    <span style={{ color: 'var(--color-up)' }}>+{it.chg}%</span>
                    <span style={{ color: 'var(--text-muted)' }}>券資比 {it.ratio}%</span>
                    <span style={{ padding: '1px 8px', borderRadius: 999, background: `${c}22`, color: c, fontWeight: 700, fontSize: 'calc(11px * var(--fz))' }}>
                      {v?.label ?? '—'}{v?.confidence ? `·信心${v.confidence}` : ''}
                    </span>
                    <span style={{ fontSize: 'calc(10.5px * var(--fz))', color: 'var(--text-muted)' }}>
                      依據{v?.basis === 'content' ? '內文' : v?.basis === 'title' ? '僅標題' : '無新聞'}
                      {it.news ? `｜2日內 ${it.news.checked} 則（實質 ${it.news.material}／純行情 ${it.news.priceOnly} 不計）` : ''}
                    </span>
                  </div>
                  <div style={{ fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-secondary)', marginTop: 2 }}>
                    {v?.reason}
                  </div>
                  {it.news?.top?.slice(0, 2).map((n, i) => (
                    <div key={i} style={{ fontSize: 'calc(10.5px * var(--fz))', color: 'var(--text-muted)', marginTop: 1 }}>
                      · {n.link ? <a href={n.link} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>{n.title}</a> : n.title}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 'calc(10.5px * var(--fz))', color: 'var(--text-muted)', marginTop: 5 }}>
            判別由本機 AI 讀新聞<b>內文</b>後給出；「股價上漲/漲停/爆量」等行情報導一律不採計為利多（那是結果不是原因）。
            抓不到內文時會標「僅標題」，不假裝讀過。AI 不確定一律判中性。
          </div>
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
