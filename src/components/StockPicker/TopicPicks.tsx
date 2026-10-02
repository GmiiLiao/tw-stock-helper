'use client';

// ── 🎯 話題選股（2026-08-05 由「指數·新聞」搬到「選股」頁）─────────
// 搬遷理由（使用者指出）：它是**選股清單**。放在新聞頁的原始理由是「話題層來自
//   新聞」——那是資料來源的歸屬，不是使用者找它的路徑。人要選股時會去選股頁。
//
// ⚠**口徑：以 5 日持有為主，不是隔日沖**。三張清單各有各的窗口，必須分開讀：
//   · 超跌反彈候選 → 5 日持有（乖離<-5%：+1.09/+1.26%；×熱門族群 +1.3~2.1%）
//   · 跌破5日線出場 → 隔日弱（收賣Δ-0.16/-0.08 兩窗穩）＝出場/避開訊號
//   · 過熱勿追 → 避開項，不是放空訊號
//   所以本分頁**不掛任何模式**、也不顯示綜合評分——它的證據是自己的窗口，
//   不是任一交易模式的權重模型。硬掛模式等於宣稱它有那個口徑的實證。
//
// 方法來源：犀利媽「短線只設5日線·RSI只看最高跟最低」，經本站 720 日 bt-core
//   拆解檢定；「拉回5日線接」全變體皆負故**不提供**（見卡內說明）。非投資建議。

import AddCandidateButton from '@/components/Candidates/AddCandidateButton';
import { useEffect, useState } from 'react';
import { useAppStore } from '@/lib/store';
import { useDayTradeCodes, statusOf } from '@/lib/useDayTradeCodes';
import { DayTradeMark } from '@/components/shared/DayTradeBadge';
import RiskBadge from '@/components/shared/RiskBadge';   // 2026-09-21：與波段持有榜同批補上注意/處置徽章（光鼎 6226 實案）

const UP = '#f03e3e', DOWN = '#2f9e44';

interface TopicItem { code: string; name: string; price: number; chg: number | null; bias5: number; rsi5?: number; rsi10?: number; dualRsi?: boolean; deathX?: boolean; rsiHot?: boolean; triple?: boolean; volX?: number | null; instT1?: number | null; ind: string | null; newsN: number; hot: boolean; aboveM20: boolean }
interface TopicData { found: boolean; date?: string; dataDate?: string | null; mode?: string; updatedAt?: number; instDate?: string | null; instSameDay?: boolean; hotSectors?: { ind: string; n: number }[]; oversold?: TopicItem[]; overheat?: TopicItem[]; breakdown?: TopicItem[]; evidence?: Record<string, string> }

function TopicRow({ it }: { it: TopicItem }) {
  const dt = useDayTradeCodes();   // 當沖資格：必須在任何 early return 之前
  const navigateTo = useAppStore(s => s.navigateTo);
  return (
    <div data-anchor={it.code} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 'calc(12.5px * var(--fz))', padding: '4px 0', borderTop: '1px solid rgba(148,163,184,0.08)', flexWrap: 'wrap' }}>
      <button onClick={() => navigateTo('stock', it.code)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-primary)', fontWeight: 800, fontSize: 'calc(12.5px * var(--fz))', padding: 0 }}>
        {it.code} {it.name}
      </button>
      {(() => { const st = statusOf(dt, it.code); return st == null ? null : <DayTradeMark status={st} size="xs" />; })()}
      <RiskBadge code={it.code} size="xs" />
      <AddCandidateButton code={it.code} variant="icon" />
      {it.triple && <span style={{ fontSize: 'calc(12.5px * var(--fz))', padding: '1px 6px', borderRadius: 8, background: 'rgba(240,62,62,0.18)', color: '#ff8787', fontWeight: 800 }} title="三重確認：RSI5<20 × 法人t-1買超 × 量比>1.5（網格唯一最強組合·5日淨均+1.11%·淨勝55%·兩窗同向）">⭐三重確認</span>}
      {it.dualRsi && <span style={{ fontSize: 'calc(12.5px * var(--fz))', padding: '1px 6px', borderRadius: 8, background: 'rgba(251,191,36,0.15)', color: '#fbbf24', fontWeight: 800 }} title="RSI5與RSI10同時<10（影片定義的稀有極端超跌·樣本小存證觀察）">⚡雙RSI&lt;10</span>}
      {it.deathX && <span style={{ fontSize: 'calc(12.5px * var(--fz))', padding: '1px 6px', borderRadius: 8, background: 'rgba(47,158,68,0.15)', color: '#69db7c', fontWeight: 800 }} title="RSI5於70以上下穿RSI10（高檔死亡交叉·RSI八命題唯一過關·隔日Δ-0.11/-0.18兩窗穩）">💀高檔死叉</span>}
      {it.hot && <span style={{ fontSize: 'calc(12.5px * var(--fz))', padding: '1px 6px', borderRadius: 8, background: 'rgba(240,62,62,0.12)', color: '#fda4af', fontWeight: 800 }}>🔥話題</span>}
      {it.ind && <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{it.ind}</span>}
      {it.newsN >= 2 && <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: '#7dd3fc' }}>📰新聞{it.newsN}則</span>}
      <span style={{ marginLeft: 'auto', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-secondary)' }}>{it.price}</span>
      {it.chg != null && <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: it.chg > 0 ? UP : it.chg < 0 ? DOWN : 'var(--color-flat)', minWidth: 56, textAlign: 'right' }}>{it.chg > 0 ? '+' : ''}{it.chg}%</span>}
      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', minWidth: 78, textAlign: 'right' }}>乖離{it.bias5 >= 0 ? '+' : ''}{it.bias5}%</span>
      {it.rsi5 != null && <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 'calc(12.5px * var(--fz))', color: (it.rsi5 < 10 || it.rsi5 >= 90) ? '#fbbf24' : 'var(--text-muted)', minWidth: 96, textAlign: 'right' }}>RSI5/10：{it.rsi5}/{it.rsi10}</span>}
    </div>
  );
}

export default function TopicPicks() {
  const [d, setD] = useState<TopicData | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => fetch('/api/ai/topic-picks').then(r => (r.ok ? r.json() : null)).then(j => { if (live && j) setD(j); }).catch(() => {});
    load();
    const t = setInterval(load, 180000);
    return () => { live = false; clearInterval(t); };
  }, []);
  if (!d) return <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', padding: 16 }}>載入話題選股…</div>;
  if (!d.found) return <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', padding: 16 }}>尚無資料（常駐服務數分鐘內產生）。</div>;
  const sect = (title: string, items: TopicItem[] | undefined, evidence: string | undefined, tone: string) => (
    <div style={{ padding: '12px 14px', borderRadius: 12, background: 'var(--bg-elevated)', border: `1px solid ${tone}` }}>
      <div style={{ fontWeight: 900, fontSize: 'calc(13.5px * var(--fz))', marginBottom: 2 }}>{title} <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', fontWeight: 400 }}>{items?.length ?? 0} 檔</span></div>
      {evidence && <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 6 }}>📐 實證：{evidence}</div>}
      {(items || []).map(it => <TopicRow key={it.code} it={it} />)}
      {(!items || items.length === 0) && <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>目前無符合。</div>}
    </div>
  );
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {/* 口徑標頭：本分頁不掛模式，所以必須自己把窗口講清楚（見檔頭） */}
      {/* 2026-10-01 使用者：說明區字體太小、行距太開——改標準字級並收緊行高 */}
      <div style={{ padding: '9px 13px', borderRadius: 10, background: 'rgba(148,163,184,0.07)', border: '1px solid rgba(148,163,184,0.22)', fontSize: 'calc(13.5px * var(--fz))', lineHeight: 1.6, color: 'var(--text-secondary)' }}>
        🧭 <b style={{ color: 'var(--text-primary)' }}>本分頁不隨操作模式變</b>——三張清單各有各的實測窗口，混著讀就會用錯：
        <b style={{ color: '#7dd3fc' }}>反彈候選＝5 日持有</b>（非隔日沖）、
        <b style={{ color: '#7dd3fc' }}>跌破出場＝隔日弱</b>（出場/避開訊號，不是進場）、
        <b style={{ color: '#7dd3fc' }}>過熱勿追＝避開</b>（不是放空訊號）。故本頁不顯示綜合評分。
      </div>
      <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <span>📅 {d.mode === 'live' ? d.date : (d.dataDate || d.date)} · {d.mode === 'live' ? '盤中即時' : '收盤定版'}</span>
        {d.instDate && (
          <span title="法人資料日決定「可執行版本」：含今日T86＝依此決策要明日才能買；前一交易日＝今日收盤可買">
            🏦 法人資料 {d.instDate}{d.instSameDay ? '（含今日T86 → 可執行版本＝明日買進）' : '（前一交易日 → 今日收盤可買）'}
          </span>
        )}
        <span>🔥 熱門族群：{(d.hotSectors || []).map(h => `${h.ind}(${h.n}板)`).join('、') || '—'}</span>
      </div>
      <div style={{ padding: '10px 14px', borderRadius: 12, background: 'rgba(125,211,252,0.06)', border: '1px solid rgba(125,211,252,0.3)', fontSize: 'calc(13.5px * var(--fz))', lineHeight: 1.6, color: 'var(--text-secondary)' }}>
        方法來源：犀利媽「短線只設5日線·RSI只看最高跟最低」——本站 720 日回測拆解：<b style={{ color: 'var(--text-primary)' }}>超跌反彈✅（乖離&lt;-5%最穩·⚡雙RSI&lt;10為稀有極端加強版）、跌破出場✅、過熱勿追✅（乖離&gt;+8%較RSI≥95穩）、拉回5日線接❌（不成立、不提供）</b>。話題層（熱門族群/新聞熱度）讓超跌反彈在多空市況皆為淨正。出場鐵律照舊：破前低停損、單筆風險≤1%。
      </div>
      {sect('🟥 話題×超跌反彈候選（乖離5日線 < -5%）', d.oversold, d.evidence?.oversold, 'rgba(240,62,62,0.3)')}
      {sect('🚪 出場參考（跌破5日線／💀高檔死亡交叉）', d.breakdown, d.evidence?.breakdown, 'rgba(148,163,184,0.25)')}
      {sect('⚠️ 過熱勿追（乖離 > +8% 或雙RSI≥90）', d.overheat, d.evidence?.overheat, 'rgba(47,158,68,0.3)')}
      <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.6 }}>
        反彈策略左尾重（接刀型）：分批、小部位、破前低無條件停損。<br />
        ⚠ 雙RSI≥90 的正確讀法（720日實證）：<b>不是頂點</b>——今日即未來10日最高點的機率僅 22.6%（基準 21.1%）；但5日內≥5%回檔機率 50%（基準 27%）＝<b>波動放大</b>。持有者出場實測：隔日就賣 −0.53%（最差）、抱5日 +0.44%、抱10日 +1.18%（最佳）→ 移動停利勿隔日全出。非投資建議。
      </div>
    </div>
  );
}
