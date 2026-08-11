'use client';

import { useEffect, useMemo, useState } from 'react';
import { auth } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';
import { MarketPatternHint } from '@/components/MarketPattern/MarketPatternBanner';
import RiskBadge from '@/components/shared/RiskBadge';

// ── 選股策略分頁：實測驗證的隔日沖策略 → 每日候選清單 ──
// 回測依據：近一年、前 100 大成交值個股、訊號日收盤買 → 次日收盤賣。
// 三種策略均為官方收盤資料的程式化篩選（零 AI 推測）。

interface Pick { code: string; name: string; market: string; price: number; changePct: number; score: number | null; signal: string | null; dtHigh: boolean; streak?: number; volX?: number | null; instF?: number; instT?: number; dd?: number }
interface Stat { name: string; icon: string; winRate: number; avgRet: number; pf: number; principle: string; note: string; recent?: { label: string; winRate: number; avgRet: number }; regimeBoost?: { bull: string; bear: string } }
interface Data { date: string; dataDate?: string | null; updatedAt: number; stats: Record<string, Stat>; groups: Record<string, Pick[]>; regime?: { index: number; ma20: number; bull: boolean } | null }

const ORDER = ['limitLock', 'dipLimit', 'gapUp', 'volBreak', 'secondBar', 'chip']; // dipLimit 實測 58% 排第2、高於連2K棒
const RULES = [
  '進場：收盤前（漲停鎖死為掛單排隊）；出場：次日 09:00–10:00，隔日必出',
  '開高走弱跌破開盤價即出；開低直接認賠出場，不留倉第二晚',
  '單筆風險 ≤ 總資金 1%；⚠ 標記＝當沖比率 ≥40%（隔日沖大戶對做，建議跳過）',
];
// 各策略完整操作說明（點「操作說明」展開）
const OPS: Record<string, string[]> = {
  limitLock: [
    '① 13:00 後確認個股仍漲停鎖死（委買大量高掛、未打開）',
    '② 以漲停價掛「現股買單」排隊；收盤確認是否成交，未成交自動失效，不追價',
    '③ 次日出場：開高 ≥2% → 第一波衝高後跌破開盤價即出；開平 → 9:30 前出；開低 → 開盤直接市價出',
    '④ 連 3 停以上不參與；⚠高當沖標記跳過',
  ],
  gapUp: [
    '① 13:15–13:25 確認三件事：今日開盤跳空 ≥2%、全日最低點未回補缺口、目前收紅（收盤價 > 開盤價）',
    '② 尾盤市價進場；保守版＝收盤後從本清單挑，次日開盤高於昨收才進',
    '③ 次日 9:00–10:00 出場：開高跌破開盤價出、開低直接認賠；缺口被回補即出',
    '④ 優先挑評分 ≥55 且非⚠高當沖者',
  ],
  volBreak: [
    '① 13:15 後確認：成交量已達昨日 3 倍以上、漲幅 2%~8.5%（未鎖停買得到）、現價貼近當日高點',
    '② 尾盤進場；量比超過 10 倍者降低期望或跳過（參考⚠標記）',
    '③ 次日 9:00–10:00 出場，鐵律同上',
    '④ 可與「盤中潛力」榜交叉比對，同時上榜者優先',
  ],
  secondBar: [
    '① 條件：昨日首度收紅（前日未漲）＋今日續漲 ≥2%',
    '② 尾盤確認今日漲幅 ≥2% 後進場；若已鎖漲停則改用「漲停鎖死」策略排隊',
    '③ 次日 9:00–10:00 出場，隔日必出',
    '④ 大盤健康度 <45 時減半部位或觀望',
  ],
  dipLimit: [
    '① 條件：60 日高點回檔 ≥15% 之後，出現「第一根」漲停（昨日未漲停才算）',
    '② 進場：13:00 後仍鎖死者掛漲停價排隊；未鎖死但漲停邊緣者尾盤確認進場',
    '③ 次日 9:00–10:00 出場，隔日必出；開低直接認賠',
    '④ 卡片標示「回檔 N%」，回檔越深賣壓越重，嚴守鐵律',
  ],
  chip: [
    '① 條件：今日外資買超 ≥1000 張「且」投信買超 ≥100 張',
    '② 本清單 16:30 後更新，適合「次日開盤」進場版：開盤高於昨收才進',
    '③ 進場後隔日 9:00–10:00 出場（即 T+2 早盤）；或與價格策略疊加當確認訊號',
    '④ 同時出現在其他策略卡（多重共識）者優先做',
  ],
};

const PREMIUM = ['premium', 'admin', 'superadmin'];
const TRIAL_DAYS = 14; // 新註冊會員免費體驗天數（依 Firebase Auth 註冊時間，不可竄改）

export default function StrategyPicks() {
  // 本分頁是**隔日沖口徑**（撿尾盤定版濾網·明開賣）。使用者在別的模式進來時
  //   必須明說，否則會拿隔日沖的清單去做 5 日波段（實測 -0.06%）。
  const navigateTo = useAppStore(st => st.navigateTo);
  const user = useAppStore(st => st.user);
  const isPremium = !!user && PREMIUM.includes(user.level);
  const trialDaysLeft = useMemo(() => {
    const ct = (auth as { currentUser?: { metadata?: { creationTime?: string } } })?.currentUser?.metadata?.creationTime;
    if (!user?.uid || !ct) return null;
    const left = TRIAL_DAYS - Math.floor((Date.now() - new Date(ct).getTime()) / 86400000);
    return Math.max(left, 0);
  }, [user?.uid]);
  const trialActive = !isPremium && (trialDaysLeft ?? 0) > 0;
  const allowed = isPremium || trialActive;
  const [d, setD] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [opsOpen, setOpsOpen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/ai/strategy-picks').then(r => (r.ok ? r.json() : null)).then(x => { if (live) { setD(x); setLoading(false); } }).catch(() => setLoading(false));
    return () => { live = false; };
  }, []);

  // 多重共識：同一檔出現在 ≥2 張策略卡（多重訊號驗證，優先關注）
  const consensus = useMemo(() => {
    const map: Record<string, { count: number; keys: string[]; name: string; score: number | null }> = {};
    if (d?.groups) for (const key of ORDER) for (const p of (d.groups[key] || [])) {
      (map[p.code] ??= { count: 0, keys: [], name: p.name, score: p.score });
      map[p.code].count++; map[p.code].keys.push(key);
    }
    return map;
  }, [d]);
  const multi = useMemo(() => Object.entries(consensus).filter(([, v]) => v.count >= 2)
    .sort((a, b) => b[1].count - a[1].count || (b[1].score ?? 0) - (a[1].score ?? 0)), [consensus]);

  if (!allowed) return (
    <div style={{ padding: '36px 20px', textAlign: 'center', border: '1px solid var(--border-primary)', borderRadius: 12, background: 'var(--bg-elevated)' }}>
      <div style={{ fontSize: 'calc(28px * var(--fz))', marginBottom: 8 }}>🔒</div>
      <div style={{ fontWeight: 800, fontSize: 'calc(1.05rem * var(--fz))', marginBottom: 6 }}>選股策略為高級會員功能</div>
      <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.9 }}>
        包含五種經一年實測驗證的隔日沖策略（勝率 54%~64%）每日候選清單、<br />
        大盤 MA20 濾網紅綠燈、多重共識標記與完整操作 SOP。
      </div>
      <div style={{ marginTop: 10, fontSize: 'calc(13px * var(--fz))', fontWeight: 700, color: '#fbbf24' }}>
        {user?.uid && trialDaysLeft === 0 ? '你的 14 天新會員免費體驗已結束，升級高級會員即可繼續使用' : '🎁 新註冊會員可免費體驗 14 天（自註冊日起自動生效）'}
      </div>
    </div>
  );
  if (loading) return <div style={{ padding: 24, color: 'var(--text-muted)' }}>載入策略選股中…</div>;
  if (!d?.groups) return <div style={{ padding: 24, color: 'var(--text-muted)' }}>尚無策略選股資料（每交易日收盤後生成）。</div>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        <span style={{ fontWeight: 800, fontSize: 'calc(1.05rem * var(--fz))' }}>📐 實測驗證策略選股</span>
        <span style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>資料日 {d.dataDate || d.date} · 收盤後更新 · 隔日沖適用</span>
        {trialActive && <span style={{ fontSize: 'calc(12px * var(--fz))', fontWeight: 800, padding: '2px 10px', borderRadius: 10, background: 'rgba(251,191,36,0.15)', border: '1px solid rgba(251,191,36,0.5)', color: '#fbbf24' }}>🎁 免費體驗中 · 剩 {trialDaysLeft} 天</span>}
      </div>
      {/* 今日盤型即時警示改放「即時追蹤」頁；此處僅留一行提示導向 */}
      <MarketPatternHint onNavigate={() => navigateTo('tracker')} />
      <div style={{ margin: '2px 0 6px', fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, color: 'var(--text-muted)', letterSpacing: 1 }}>
        ▼ 前日盤後選股策略（回答「買什麼」，收盤資料計算）
      </div>
      {d.regime && (
        <div style={{ marginBottom: 10, padding: '10px 14px', borderRadius: 10, background: d.regime.bull ? 'rgba(240,62,62,0.10)' : 'rgba(47,158,68,0.10)', border: `1px solid ${d.regime.bull ? 'rgba(240,62,62,0.4)' : 'rgba(47,158,68,0.4)'}` }}>
          <div style={{ fontSize: 'calc(14px * var(--fz))', fontWeight: 800, color: d.regime.bull ? 'var(--color-up)' : 'var(--color-down)' }}>
            {d.regime.bull ? '🟢 大盤位於 MA20 之上（多頭濾網通過）— 漲停鎖死策略升級：勝率 64%／+2.66%／PF 3.07' : '⚠️ 大盤位於 MA20 之下（多頭濾網未過）— 漲停鎖死優勢下降，建議減量或觀望'}
            <span style={{ fontSize: 'calc(11px * var(--fz))', fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>加權 {d.regime.index} vs MA20 {d.regime.ma20}</span>
          </div>
          {/* 升級版名單＝漲停鎖死 ∩ 非連3停 ∩ 非高當沖（64% 統計的實際適用股） */}
          {d.regime.bull && (() => {
            const q = (d.groups.limitLock || []).filter(p => !p.dtHigh && (p.streak ?? 1) < 3)
              .sort((a, b) => ((consensus[b.code]?.count ?? 1) - (consensus[a.code]?.count ?? 1)) || ((b.score ?? 0) - (a.score ?? 0)));
            return q.length === 0 ? null : (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                {q.slice(0, 14).map(p => (
                  <span key={p.code} onClick={() => navigateTo('stock', p.code)}
                    style={{ cursor: 'pointer', fontSize: 'calc(12px * var(--fz))', fontWeight: 700, padding: '4px 10px', borderRadius: 10, background: (consensus[p.code]?.count ?? 1) >= 2 ? 'rgba(251,191,36,0.18)' : 'rgba(240,62,62,0.12)', border: `1px solid ${(consensus[p.code]?.count ?? 1) >= 2 ? 'rgba(251,191,36,0.55)' : 'rgba(240,62,62,0.35)'}` }}>
                    {(consensus[p.code]?.count ?? 1) >= 2 ? '⭐' : ''}{p.code} {p.name} <span style={{ color: '#fbbf24' }}>{p.score ?? ''}</span> <RiskBadge code={p.code} size="xs" />
                  </span>
                ))}
                {q.length > 14 && <span style={{ fontSize: 'calc(11px * var(--fz))', color: 'var(--text-muted)', alignSelf: 'center' }}>…共 {q.length} 檔（完整見下方 🥇 卡）</span>}
              </div>
            );
          })()}
        </div>
      )}
      <div style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.8, marginBottom: 14, padding: '8px 12px', background: 'var(--bg-tertiary)', borderRadius: 8 }}>
        {RULES.map(r => <div key={r}>• {r}</div>)}
      </div>

      {/* 多重共識榜：同時命中 ≥2 種策略的股票（最高優先） */}
      {multi.length > 0 && (
        <div style={{ marginBottom: 16, padding: '12px 16px', borderRadius: 12, background: 'rgba(251,191,36,0.08)', border: '1.5px solid rgba(251,191,36,0.45)' }}>
          <div style={{ fontWeight: 800, marginBottom: 8 }}>⭐ 多重共識（同時命中 ≥2 種策略，優先關注）</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {multi.map(([code, v]) => (
              <div key={code} onClick={() => navigateTo('stock', code)}
                style={{ cursor: 'pointer', padding: '6px 12px', borderRadius: 10, background: 'rgba(251,191,36,0.15)', border: '1px solid rgba(251,191,36,0.5)' }}>
                <b style={{ color: '#fbbf24' }}>{code} {v.name}</b>
                <span style={{ fontSize: 'calc(11px * var(--fz))', color: 'var(--text-secondary)', marginLeft: 6 }}>
                  評分 {v.score ?? '—'} · {v.keys.map(k => d.stats[k]?.icon + d.stats[k]?.name).join('＋')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {ORDER.map(key => {
        const st = d.stats[key]; const list = d.groups[key] || [];
        if (!st) return null;
        return (
          <div key={key} style={{ marginBottom: 18, padding: '14px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 800 }}>{st.icon} {st.name}</span>
              <span style={{ fontSize: 'calc(12px * var(--fz))', fontWeight: 700 }}>
                勝率 <b style={{ color: st.winRate >= 57 ? 'var(--color-up)' : '#f59e0b' }}>{st.winRate}%</b>
                {' · '}平均 <b style={{ color: 'var(--color-up)' }}>+{st.avgRet}%</b>/筆
                {' · '}獲利因子 <b style={{ color: '#fbbf24' }}>{st.pf}</b>
              </span>
              {st.recent && <span style={{ fontSize: 'calc(11px * var(--fz))', fontWeight: 800, padding: '1px 8px', borderRadius: 10, background: 'rgba(240,62,62,0.12)', color: '#f03e3e' }}>{st.recent.label} 勝率 {st.recent.winRate}%／+{st.recent.avgRet}%</span>}
              <span style={{ marginLeft: 'auto', fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>今日 {list.length} 檔</span>
              <button onClick={() => setOpsOpen(o => (o === key ? null : key))}
                style={{ fontSize: 'calc(12px * var(--fz))', padding: '2px 10px', borderRadius: 8, border: '1px solid var(--border-primary)', background: opsOpen === key ? 'var(--accent-purple,#6366f1)' : 'var(--bg-tertiary)', color: opsOpen === key ? '#fff' : 'var(--text-secondary)', cursor: 'pointer' }}>
                📖 操作說明
              </button>
            </div>
            {/* 原理說明隱藏（完整原理見「📖 操作說明」）；僅保留實用操作提示 note */}
            {st.note && (
              <div style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)', margin: '4px 0 10px', lineHeight: 1.6 }}>
                {st.note}
              </div>
            )}
            {opsOpen === key && OPS[key] && (
              <div style={{ margin: '0 0 12px', padding: '10px 14px', borderRadius: 10, background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.25)', fontSize: 'calc(12.5px * var(--fz))', lineHeight: 2, color: 'var(--text-secondary)' }}>
                {OPS[key].map(s => <div key={s}>{s}</div>)}
              </div>
            )}
            {list.length === 0 ? (
              <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)' }}>{key === 'volBreak' ? '今日無符合（或昨量資料累積中，次一交易日起完整）' : key === 'secondBar' ? '今日無符合（或收盤價歷史累積中，需 3 個交易日後完整）' : '今日無符合條件的股票'}</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(215px, 100%),1fr))', gap: 8 }}>
                {[...list].sort((a, b) => ((consensus[b.code]?.count ?? 1) - (consensus[a.code]?.count ?? 1)) || ((b.score ?? 0) - (a.score ?? 0))).slice(0, 24).map(p => {
                  const cc = consensus[p.code]?.count ?? 1;
                  return (
                  <div key={p.code} onClick={() => navigateTo('stock', p.code)}
                    style={{ cursor: 'pointer', padding: '8px 10px', borderRadius: 8, opacity: p.dtHigh ? 0.55 : 1,
                      background: cc >= 2 ? 'rgba(251,191,36,0.14)' : 'var(--bg-tertiary)',
                      border: cc >= 2 ? '1.5px solid rgba(251,191,36,0.55)' : '1px solid transparent' }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                      {cc >= 2 && <span style={{ fontSize: 'calc(10px * var(--fz))', fontWeight: 900, color: '#fbbf24' }}>⭐×{cc}</span>}
                      <b style={{ color: '#e2e8f0' }}>{p.code}</b>
                      <span style={{ color: '#7dd3fc', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                      <span style={{ fontSize: 'calc(9px * var(--fz))', fontWeight: 800, color: p.market === 'otc' ? '#f59e0b' : '#38bdf8' }}>{p.market === 'otc' ? '櫃' : '市'}</span>
                      {p.streak && p.streak >= 2 && <span style={{ fontSize: 'calc(10px * var(--fz))', fontWeight: 800, color: p.streak >= 3 ? '#ef4444' : '#f97316' }}>連{p.streak}停{p.streak >= 3 ? '⚠不追' : ''}</span>}
                      {p.volX != null && p.volX >= 2 && <span style={{ fontSize: 'calc(10px * var(--fz))', fontWeight: 800, color: '#fbbf24' }}>⚡量{p.volX}倍</span>}
                      {p.instF != null && <span style={{ fontSize: 'calc(10px * var(--fz))', fontWeight: 700, color: '#7dd3fc' }}>外{(p.instF / 1000).toFixed(1)}k/投{p.instT}</span>}
                      {p.dd != null && <span style={{ fontSize: 'calc(10px * var(--fz))', fontWeight: 700, color: '#38bdf8' }}>回檔{p.dd}%</span>}
                      {p.dtHigh && <span style={{ fontSize: 'calc(10px * var(--fz))', fontWeight: 800, color: '#f97316' }}>⚠高當沖</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 8, fontSize: 'calc(12px * var(--fz))', marginTop: 3 }}>
                      <span style={{ fontFamily: "'JetBrains Mono',monospace" }}>{p.price}</span>
                      <span style={{ color: 'var(--color-up)', fontFamily: "'JetBrains Mono',monospace" }}>+{p.changePct}%</span>
                      <span style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>評分 <b style={{ color: '#fbbf24' }}>{p.score ?? '—'}</b></span>
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      <div style={{ fontSize: 'calc(11px * var(--fz))', color: 'var(--text-muted)' }}>
        ※ 勝率/平均為近一年歷史回測（前 100 大個股、隔日收盤出場、未含約 0.585% 交易成本與滑價），歷史績效不代表未來；非投資建議。
      </div>
    </div>
  );
}
