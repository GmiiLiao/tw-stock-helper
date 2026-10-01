'use client';

// ── ⏳ 當沖工作台（即時漲跌子分頁；2026-09-23 依使用者提供的 tw-day-trading 技巧重新設計）──────────
// 技巧重點落地：
//   · 時段節奏條（09:00–09:05 只記 O/H/L 不追價 … 12:30 後降低新倉）
//   · Market 20 + Stock 50 + Entry 30 規則符合度（daemon 算；未知不當 0、有缺項不給分級）
//   · Setup：ORB（突破→站穩→再攻）、突破回踩（昨高）、開低反轉；事前寫明觸發價與結構停損
//   · 硬性否決（當沖資格／處置、停損失衡、追價、距漲停、2R 淨報酬不足、12:30 後）
//   · 部位：依「我的風控」每筆上限算整張、扣自己的手續費折讓＋當沖稅＋滑價的淨 R
//   · 出場：結構停損／1R 保本／2R 追蹤／3R／VWAP 停損／時間停損／13:20 沖銷（🏁 提醒）
//   · 日誌與迭代：所有候選與觸發都記；樣本不足不調參
// 做空為本站鏡像延伸（技巧原文只涵蓋做多），權重門檻未驗證，畫面上明示。
import { useState } from 'react';
import { useBrokerSettings } from '@/lib/useBrokerSettings';
import { useDayTradeCodes, statusOf } from '@/lib/useDayTradeCodes';
import type { FadeSnap } from '@/lib/fade-patterns';
import DeskRiskPanel, { useDeskRisk } from './DeskRiskPanel';
import DeskRow, { hhmm, rowGroupOf } from './DeskRow';
import DeskJournal from './DeskJournal';
import { useAlertDoc, useDeskLists, LIST_N } from './useDeskData';
import type { BaseRow, DeskRowData, DeskEvidence, ScoreItem, Side } from './types';

const STOP_KEEP_MS = 15 * 60_000;
const PHASES: [number, number, string, string][] = [
  [8 * 60 + 30, 9 * 60, '08:30–09:00 盤前', '由可當沖、流動性足的股票建立 5–10 檔觀察名單；記昨高低收與催化，分數只算暫定、Entry 待確認'],
  [9 * 60, 9 * 60 + 5, '09:00–09:05', '只記開高低、VWAP 與價量——不要憑第一根追價'],
  [9 * 60 + 5, 9 * 60 + 30, '09:05–09:30', '辨認主流族群與龍一／龍二；等 ORB 或回測確認'],
  [9 * 60 + 30, 10 * 60 + 30, '09:30–10:30', '優先評估二次攻擊、回踩與扣成本後的淨風險報酬'],
  [10 * 60 + 30, 12 * 60 + 30, '10:30–12:30', '注意量縮、時間停損與既有部位管理'],
  [12 * 60 + 30, 13 * 60 + 30, '12:30–收盤', '不提新倉；確認退出流動性與沖銷狀態'],
];

function phaseOf(now: number): [string, string] {
  const d = new Date(now + 8 * 3600000); const m = d.getUTCHours() * 60 + d.getUTCMinutes(); const wd = d.getUTCDay();
  if (wd === 0 || wd === 6) return ['休市', '回顧日誌：只看 n 足夠的格子，不因少數樣本改規則'];
  for (const [a, b, l, t] of PHASES) if (m >= a && m < b) return [l, t];
  return m >= 13 * 60 + 30 ? ['盤後', '檢討：所有候選與實際交易都要記（見「日誌與迭代」）'] : ['盤前', '08:30 起建立觀察名單'];
}

function orderRows(base: BaseRow[], desk: DeskRowData[], now: number): { base: BaseRow | null; desk: DeskRowData | null }[] {
  const dmap = new Map(desk.map(d => [d.code, d]));
  const rows = base.map(b => ({ base: b as BaseRow | null, desk: dmap.get(b.code) ?? null }));
  const seen = new Set(base.map(b => b.code));
  for (const d of desk) if (!seen.has(d.code)) rows.push({ base: null, desk: d });
  const w = (r: { desk: DeskRowData | null }) => {
    const st = r.desk?.st;
    if (st?.phase === 'on') return 0;
    if (st?.phase === 'stop' && st.stopAt && now - st.stopAt < STOP_KEEP_MS) return 1;
    return r.desk ? 2 : 3;
  };
  const sorted = rows.sort((a, b) => w(a) - w(b)
    || (w(a) === 0 ? b.desk!.st!.since - a.desk!.st!.since : 0)
    || (w(a) === 1 ? (b.desk!.st!.stopAt ?? 0) - (a.desk!.st!.stopAt ?? 0) : 0)
    || (w(a) === 2 ? b.desk!.score.total - a.desk!.score.total : 0)
    || (a.base?.rank ?? 999) - (b.base?.rank ?? 999));
  const keep = sorted.filter((r, i) => i < LIST_N || w(r) <= 1);   // 30 檔；成立中與剛出場的永不截掉
  return keep;
}

export default function DayTradeDesk({ snaps, marketOpen, wide }: { snaps: FadeSnap[]; marketOpen: boolean; wide: boolean }) {
  const [doc, now] = useAlertDoc();
  const lists = useDeskLists(snaps, marketOpen);
  const [risk, setRisk] = useDeskRisk();
  const [broker] = useBrokerSettings();
  const [tab, setTab] = useState<'desk' | 'journal'>('desk');
  const [ph, task] = phaseOf(now);
  const stale = marketOpen && doc?.found && doc.at ? Math.floor((now - doc.at) / 60000) : 0;
  const events = (doc?.events || []).slice(0, 6);

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', padding: '6px 10px', borderRadius: 10, background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', marginBottom: 8 }}>
        <b style={{ color: '#fbbf24' }}>⏱ {ph}</b>
        <span style={{ fontSize: 'calc(12.5px * var(--fz))' }}>{task}</span>
        <span style={{ marginLeft: 'auto', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
          資料時間 {doc?.at ? hhmm(doc.at) : '—'}{doc?.version ? `·規則 ${doc.version}` : ''}{stale >= 3 ? <b style={{ color: '#f59e0b' }}> ·⚠ 已 {stale} 分鐘未更新（視同資料失效：不提進場）</b> : null}
        </span>
        <span role="tablist" style={{ display: 'inline-flex', padding: 2, borderRadius: 999, background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)' }}>
          {([['desk', '工作台'], ['journal', '日誌與迭代']] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} style={{ padding: '2px 12px', borderRadius: 999, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 'calc(12.5px * var(--fz))', background: tab === k ? 'rgba(251,191,36,0.2)' : 'transparent', color: tab === k ? '#fbbf24' : 'var(--text-muted)' }}>{l}</button>
          ))}
        </span>
      </div>

      {tab === 'journal' ? <DeskJournal /> : <>
        {/* ⚠ 觀察工具聲明（2026-09-30 使用者：規則是否有問題？——實績為負，必須放在最顯眼處，不再埋在說明文字裡） */}
        <div style={{ padding: '8px 12px', borderRadius: 10, marginBottom: 8, border: '1px solid rgba(239,68,68,0.45)', background: 'rgba(239,68,68,0.08)', fontSize: 'calc(13.5px * var(--fz))', lineHeight: 1.6 }}>
          <b style={{ color: '#ef4444' }}>⚠ 觀察工具，不是買賣訊號</b>：規則 {doc?.version ?? 'v1'} 回放（扣成本）做多平均 <b>{doc?.evidence?.long?.all ? `${doc.evidence.long.all.teR}R·勝率 ${doc.evidence.long.all.teWin}%` : '—'}</b>、做空平均 <b>{doc?.evidence?.short?.all ? `${doc.evidence.short.all.teR}R·勝率 ${doc.evidence.short.all.teWin}%` : '—'}</b>——平均是虧的。
          規則驗證出正報酬之前，下方「成立」「假設進場」只供觀察與記錄；每一筆的實際結果在「日誌與迭代」，並每日餵給 AI 交易員經驗庫訓練。
        </div>
        <DeskRiskPanel risk={risk} setRisk={setRisk} broker={broker} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginBottom: 8, minHeight: '1.8em' }}>
          <b style={{ color: 'var(--text-primary)' }}>⚡ 成立／出場（觀察）</b>
          {!doc?.found ? <span>今日尚未啟動（09:05 開盤區間形成後開始評估）</span> : !events.length ? <span>{marketOpen ? '監控中，尚無觸發' : `非盤中·最後 ${hhmm(doc.at)}`}</span>
            : events.map(e => (
              <span key={`${e.side}${e.code}${e.t}${e.kind}`} style={{ padding: '1px 8px', borderRadius: 999, fontWeight: 700, background: e.kind === 'stop' ? 'rgba(245,158,11,0.14)' : e.side === 'long' ? 'rgba(240,62,62,0.14)' : 'rgba(47,158,68,0.14)', color: e.kind === 'stop' ? '#f59e0b' : e.side === 'long' ? 'var(--color-up)' : 'var(--color-down)' }}>
                {hhmm(e.t)} {e.kind === 'stop' ? '🏁' : e.side === 'long' ? '▲' : '▼'} {e.code} {e.name} {e.type ?? ''} {e.kind === 'stop' ? (e.reason ?? '') : `@${e.px}`}
              </span>
            ))}
          {doc?.evidence?.verdict && <span style={{ marginLeft: 'auto', color: '#f59e0b' }}>⚠ {doc.evidence.verdict}</span>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: wide ? 'minmax(0, 1fr) minmax(0, 1fr)' : '1fr', gap: 12 }}>
          {(['long', 'short'] as Side[]).map(side => (
            <DeskColumn key={side} side={side} rows={orderRows(side === 'long' ? lists.long : lists.short, (side === 'long' ? doc?.long : doc?.short) || [], now)}
              now={now} risk={risk} broker={broker} dtLoaded={lists.dtLoaded} evidence={doc?.evidence ?? null}
              market={((side === 'long' ? doc?.long : doc?.short) || [])[0]?.score.market ?? null} />
          ))}
        </div>
        <details style={{ marginTop: 8, fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.6 }}>
          <summary style={{ cursor: 'pointer', color: '#7dd3fc' }}>怎麼讀（規則、出場計畫、否決條件）</summary>
          分數是<b>規則符合度，不是上漲機率</b>；有「未知」子項時只列已知分／已知滿分與待確認，不給分級（≥75 優先觀察、60–74 等待、&lt;60 低優先）。
          Setup：ORB＝前 {doc?.params?.orbBars ?? 5} 分鐘區間突破→站穩→再攻；突破回踩＝放量過昨高→量縮回測守住→再攻過短線高；開低反轉＝開低 ≥1%→較高低點＋收復 VWAP＋過短線高（11:00 前）。
          出場計畫：1R 落袋 1/3 並把停損移到成本、2R 再 1/3 並把停損移到 1R、餘部到 3R；未到 1R 前連 2 根失守 VWAP 或 20 分鐘沒走出 0.5R 就出場；13:20 起以完成沖銷為優先。
          硬性否決：不可當沖／處置股、每股風險 &gt;{doc?.params?.maxStopPct ?? 3}%、距 VWAP &gt;{doc?.params?.maxVwapDevPct ?? 3}%、距漲（跌）停 &lt;{doc?.params?.nearLimitPct ?? 1}% 或 2R 超過漲跌停、2R 扣成本淨 &lt;{doc?.params?.minNetR2 ?? 1.5}R、12:30 後。
          評分與 1 分 K 只有 5 秒監控中的個股才有（多、空各約 18 檔）；台指期盤中無資料來源，永遠列為缺項。<b>「優先觀察」不是買進指令</b>；做空為鏡像延伸、未經驗證。非投資建議。
        </details>
      </>}
    </div>
  );
}

// 欄內分組順序（2026-09-30 重整）：成立中→剛出場→等待條件→其餘（預設收起）
const GROUPS: { k: 'on' | 'stop' | 'wait' | 'other'; t: (L: boolean) => string }[] = [
  { k: 'on', t: () => '⚡ 成立中（觀察）' },
  { k: 'stop', t: () => '🏁 剛出場' },
  { k: 'wait', t: () => '⏳ 等待條件（還差一步）' },
  { k: 'other', t: L => (L ? '其餘候選（尚無型態）' : '其餘候選（今日已漲·尚未轉弱）') },
];

function DeskColumn({ side, rows, now, risk, broker, dtLoaded, evidence, market }: {
  side: Side; rows: { base: BaseRow | null; desk: DeskRowData | null }[]; now: number; risk: Parameters<typeof DeskRow>[0]['risk']; broker: Parameters<typeof DeskRow>[0]['broker'];
  dtLoaded: boolean; evidence: DeskEvidence | null; market: ScoreItem[] | null;
}) {
  const L = side === 'long'; const color = L ? 'var(--color-up)' : 'var(--color-down)';
  const dt = useDayTradeCodes();
  const ev = evidence?.[side]?.all;
  const mSum = market ? market.filter(i => i.score != null).reduce((a, i) => a + (i.score ?? 0), 0) : null;
  const mMax = market ? market.filter(i => i.score != null).reduce((a, i) => a + i.max, 0) : null;
  const active = rows.filter(r => r.desk?.st?.phase === 'on').length;
  const [showOther, setShowOther] = useState(false);
  return (
    <section style={{ minWidth: 0, borderRadius: 10, border: `1px solid ${L ? 'rgba(240,62,62,0.35)' : 'rgba(47,158,68,0.35)'}`, background: L ? 'rgba(240,62,62,0.03)' : 'rgba(47,158,68,0.03)' }}>
      <div style={{ padding: '8px 10px 6px', minHeight: '5.4em' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 900, color, fontSize: 'calc(14px * var(--fz))' }}>{L ? '▲ 做多（先買後賣）' : '▼ 做空（先賣後買·鏡像延伸）'}</span>
          <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{rows.length} 檔·僅可{L ? '先買' : '先賣'}當沖、排除處置股{active ? <b style={{ color }}> · 成立中（觀察）{active}</b> : null}</span>
        </div>
        <div title={market?.map(i => `${i.label}：${i.score ?? '未知'}/${i.max}｜${i.evidence}`).join('\n')} style={{ fontSize: 'calc(12.5px * var(--fz))', marginTop: 3, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          Market <b style={{ color: 'var(--text-primary)' }}>{mSum ?? '—'}/{mMax ?? 20}</b>{market ? ` · ${market.map(i => `${i.label.slice(0, 4)} ${i.score ?? '未知'}`).join(' · ')}` : ' · 盤中評估後顯示'}
        </div>
        <div style={{ fontSize: 'calc(12.5px * var(--fz))', marginTop: 2, color: 'var(--text-muted)' }}>
          {ev && evidence ? <>v1 回放 {evidence.from}～{evidence.to}：樣本外 n={ev.teN}、勝率 {ev.teWin}%、平均 <b style={{ color: ev.teR >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>{ev.teR >= 0 ? '+' : ''}{ev.teR}R</b>（扣成本）·達 1R {ev.teHit1}%</> : '回放證據尚未載入'}
        </div>
      </div>
      <div style={{ height: 'max(520px, calc(100vh - 360px))', overflowY: 'auto', padding: '0 6px 6px' }}>
        {!dtLoaded ? <div style={{ padding: 16, color: 'var(--text-muted)' }}>當沖資格／處置股名單載入中（或暫時無法取得）：確認可當沖且非處置股前不列任何個股。</div>
          : !rows.length ? <div style={{ padding: 16, color: 'var(--text-muted)' }}>目前沒有符合的個股。</div>
          : GROUPS.map(g => {
            const list = rows.filter(r => rowGroupOf(r.desk, now) === g.k);
            if (!list.length) return null;
            const folded = g.k === 'other' && !showOther;
            return (
              <div key={g.k} style={{ marginTop: 6 }}>
                <div onClick={g.k === 'other' ? () => setShowOther(v => !v) : undefined} style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, color: g.k === 'on' ? color : g.k === 'stop' ? '#f59e0b' : 'var(--text-muted)', padding: '2px 4px', cursor: g.k === 'other' ? 'pointer' : 'default' }}>
                  {g.k === 'other' ? `${folded ? '▸' : '▾'} ` : ''}{g.t(L)} {list.length} 檔
                </div>
                {!folded && list.map(r => <DeskRow key={(r.base?.code ?? r.desk!.code)} base={r.base ?? { side, code: r.desk!.code, name: r.desk!.name, market: 'tse', rank: 0, price: null, chg: null, hiUp: null, give: null, vwapDev: null, label: '監控', labelColor: 'var(--text-muted)', reason: '5 秒監控中（不在名單前 30）' }}
                  desk={r.desk} now={now} risk={risk} broker={broker} dtStatus={statusOf(dt, r.base?.code ?? r.desk!.code)} />)}
              </div>
            );
          })}
      </div>
    </section>
  );
}
