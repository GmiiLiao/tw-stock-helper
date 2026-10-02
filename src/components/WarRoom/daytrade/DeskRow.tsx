'use client';

// 當沖工作台一列：名單基本資料（BaseRow）＋ 5 秒監控中的評分與計畫（DeskRowData，可缺）。
// 2026-09-30 重整（使用者：資料太混亂、無法一眼看出關鍵）：收起時只有 ①代號·分數·價·漲跌 ②一行重點（成立／出場／等待還差什麼／否決）；
//   M·S·E 分項、完整計畫（1R·淨R·張數）、評分證據、走勢圖點開才看。v1 規則尚未驗證出正報酬 ⇒ 一律用「觀察／假設進場」措辭，不寫「進場」。
import { useState } from 'react';
import StockTrendChart from '@/components/WatchlistTracker/StockTrendChart';
import AddCandidateButton from '@/components/Candidates/AddCandidateButton';
import RiskBadge from '@/components/shared/RiskBadge';
import { DayTradeMark } from '@/components/shared/DayTradeBadge';
import { useAppStore } from '@/lib/store';
import { planLots, type DeskRisk } from '@/lib/daytrade-sizing';
import type { BrokerSettings } from '@/lib/tw-fee';
import type { BaseRow, DeskRowData, ScoreItem } from './types';

const FLASH_ON_MS = 90_000, FLASH_STOP_MS = 60_000, STOP_KEEP_MS = 15 * 60_000;
const NUM: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const pct = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`);
const upDn = (v: number | null | undefined) => (v == null ? 'var(--text-muted)' : v > 0 ? 'var(--color-up)' : v < 0 ? 'var(--color-down)' : 'var(--text-muted)');
export const hhmm = (t: number | null | undefined) => (t ? new Date(t).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' }) : '—');
const tickOf = (p: number) => (p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5);
const roundTick = (p: number, dir: number) => { const t = tickOf(p); const k = p / t; return +((dir > 0 ? Math.ceil(k - 1e-9) : Math.floor(k + 1e-9)) * t).toFixed(2); };
const TIER_C: Record<string, string> = { 優先觀察: '#22c55e', 等待: '#f59e0b', 低優先: 'var(--text-muted)' };

/** 欄內分組：on＝規則成立中、stop＝剛出場（15 分鐘內）、wait＝已寫定觸發價在等、other＝其餘 */
export function rowGroupOf(desk: DeskRowData | null, now: number): 'on' | 'stop' | 'wait' | 'other' {
  const st = desk?.st;
  if (st?.phase === 'on') return 'on';
  if (st?.phase === 'stop' && st.stopAt && now - st.stopAt < STOP_KEEP_MS) return 'stop';
  if (desk?.watch?.some(x => x.trigger != null && x.stop != null)) return 'wait';
  return 'other';
}

export interface DeskRowProps { base: BaseRow | null; desk: DeskRowData | null; now: number; risk: DeskRisk; broker: BrokerSettings; dtStatus: 0 | 1 | 2 | null }

export default function DeskRow({ base, desk, now, risk, broker, dtStatus }: DeskRowProps) {
  const navigateTo = useAppStore(s => s.navigateTo);
  const [open, setOpen] = useState(false);
  const side = base?.side ?? 'long'; const L = side === 'long'; const sg = L ? 1 : -1;
  const code = base?.code ?? desk!.code; const name = base?.name ?? desk!.name;
  const price = desk?.m.c ?? base?.price ?? null; const chg = desk?.m.chg ?? base?.chg ?? null;
  const st = desk?.st ?? null;
  const isOn = st?.phase === 'on';
  const isStop = st?.phase === 'stop' && !!st.stopAt && now - st.stopAt < STOP_KEEP_MS;
  const flash = (isOn && now - st!.since < FLASH_ON_MS) || (isStop && now - st!.stopAt! < FLASH_STOP_MS);
  const cls = ['dt-row', isOn ? (L ? 'dt-on-long' : 'dt-on-short') : isStop ? 'dt-stop' : '', flash ? 'dt-flash' : ''].filter(Boolean).join(' ');
  const sc = desk?.score;

  // 計畫：已觸發用實際計畫；否則用第一個「已寫定觸發價＋結構停損」的等待中計畫
  const act = desk?.plan && (isOn || isStop) ? desk.plan : null;
  const w = desk?.watch?.find(x => x.trigger != null && x.stop != null) || null;
  const pEntry = act?.entry ?? w?.trigger ?? null, pStop = act?.stop ?? w?.stop ?? null;
  const d = pEntry != null && pStop != null ? sg * (pEntry - pStop) : null;
  const targets = act?.targets ?? (d && d > 0 && pEntry != null ? [1, 2, 3].map(k => roundTick(pEntry + sg * k * d, -sg)) : null);
  const lp = pEntry != null && pStop != null && targets ? planLots(side, pEntry, pStop, targets, broker, risk) : null;
  const expire = act && isOn ? act.t + 20 * 60_000 : null;

  const scorePill = sc ? (
    <span title={sc.missing.length ? `缺：${sc.missing.join('、')}（未知不當 0、不等比放大）` : '全部子項已知'} style={{ ...NUM, fontWeight: 800, padding: '1px 7px', borderRadius: 6, background: 'rgba(148,163,184,0.12)', color: sc.tier ? TIER_C[sc.tier] : 'var(--text-primary)' }}>
      {sc.total}/{sc.knownMax}{sc.tier ? `·${sc.tier}` : sc.missing.length ? '·待確認' : ''}
    </span>
  ) : <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>未監控</span>;

  return (
    <div className={cls} data-anchor={code} style={{ borderRadius: 8, marginTop: 4, ...(cls === 'dt-row' ? { background: open ? 'rgba(61,142,248,0.10)' : 'rgba(148,163,184,0.05)' } : {}) }}>
      <div onClick={() => setOpen(v => !v)} title="點列展開評分證據與走勢；點代號開個股" style={{ padding: '5px 8px', cursor: 'pointer', fontSize: 'calc(13.5px * var(--fz))' }}>
        {/* ① 代號・價 */}
        <div style={{ display: 'grid', gridTemplateColumns: `1.6em 1.8em 3.7em minmax(0, 1fr) auto 4.8em ${L ? '5.2em' : '7em'}`, columnGap: 6, alignItems: 'center' }}>
          <span style={{ fontWeight: 900, textAlign: 'center', color: isOn ? (L ? 'var(--color-up)' : 'var(--color-down)') : '#f59e0b' }}>{isOn ? (L ? '▲' : '▼') : isStop ? '🏁' : ''}</span>
          <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', fontWeight: 700 }}>{base?.rank ?? '·'}</span>
          <span onClick={e => { e.stopPropagation(); navigateTo('stock', code); }} style={{ ...NUM, fontWeight: 800, textDecoration: 'underline dotted' }}>{code}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
            <span title={name} style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{name}</span>
            {dtStatus != null && <span style={{ flexShrink: 0 }}><DayTradeMark status={dtStatus} size="xs" /></span>}
            <span style={{ flexShrink: 0 }}><RiskBadge code={code} size="xs" /></span>
            <span onClick={e => e.stopPropagation()} style={{ flexShrink: 0 }}><AddCandidateButton code={code} variant="icon" /></span>
          </span>
          {scorePill}
          <span style={{ ...NUM, textAlign: 'right', fontWeight: 700 }}>{price ?? '—'}</span>
          <span title={L ? '今日漲跌' : '今日漲跌（做空候選＝今天已漲、等轉弱；不是放空損益）'} style={{ ...NUM, textAlign: 'right', fontWeight: 800, color: upDn(chg) }}>{L ? '' : <span style={{ fontWeight: 400, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>今日</span>}{pct(chg)}</span>
        </div>
        {/* 一行重點 */}
        <KeyLine L={L} isOn={isOn} isStop={isStop} act={act} w={w} pEntry={pEntry} pStop={pStop} targets={targets} lp={lp} expire={expire} desk={desk} now={now} />
      </div>
      {open && (
        <div style={{ padding: '4px 10px 10px' }} onClick={e => e.stopPropagation()}>
        {/* ② 分數＋setup 狀態 */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline', fontSize: 'calc(12.5px * var(--fz))', marginTop: 2, color: 'var(--text-muted)' }}>
          {sc ? (['market', 'stock', 'entry'] as const).map(k => (
            <span key={k} style={NUM}>{k === 'market' ? 'M' : k === 'stock' ? 'S' : 'E'} <b style={{ color: 'var(--text-primary)' }}>{sc.parts[k].score}</b>/{sc.parts[k].knownMax}{sc.parts[k].knownMax < sc.parts[k].max ? <span title="有未知子項">*</span> : null}</span>
          )) : <span>{base?.label} · VWAP 乖離 {pct(base?.vwapDev)} · 最高 {pct(base?.hiUp, 1)}</span>}
          <span style={{ color: isOn ? (L ? 'var(--color-up)' : 'var(--color-down)') : 'var(--text-muted)', fontWeight: isOn ? 800 : 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {act ? `${act.type}·${isOn ? `已觸發 ${hhmm(act.t)}` : `已出場 ${hhmm(act.exit?.t)}`}` : w ? `${w.type}·未觸發：${w.note}` : desk?.watch?.[0] ? `${desk.watch[0].type}·${desk.watch[0].note}` : desk ? '尚無 setup' : ''}
          </span>
        </div>
        {/* ③ 計畫 */}
        {pEntry != null && pStop != null && targets ? (
          <div style={{ ...NUM, fontSize: 'calc(12.5px * var(--fz))', marginTop: 2, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <span>{act ? '假設進場' : '觸發'} <b>{pEntry}</b></span>
            <span>停 <b style={{ color: '#f59e0b' }}>{act?.trail != null && act.trail !== act.stop ? `${act.trail}（原 ${pStop}）` : pStop}</b></span>
            <span>1R {d?.toFixed(2)}</span>
            <span>目標 {targets.map((t, i) => <span key={i} style={{ color: act?.hit?.[i] ? (L ? 'var(--color-up)' : 'var(--color-down)') : undefined, fontWeight: act?.hit?.[i] ? 800 : 400 }}>{i ? '／' : ''}{t}</span>)}</span>
            <span title="扣你的手續費折讓、當沖稅 0.15%、滑價後的淨 R">淨 {lp?.netR.map(v => (v == null ? '—' : v.toFixed(1))).join('／')}R</span>
            <span style={{ color: lp?.lots ? 'var(--text-primary)' : '#f59e0b', fontWeight: 700 }}>{lp?.lots ? `${lp.lots} 張·停損約 −${lp.riskTwd?.toLocaleString()} 元` : lp?.why ?? ''}</span>
            {expire && <span title="時間停損：觸發後 20 分鐘仍未走出 0.5R">⏱ {hhmm(expire)}</span>}
          </div>
        ) : null}
        {/* ④ 否決／警訊／出場／名單理由 */}
        <div title={base?.reason} style={{ fontSize: 'calc(12.5px * var(--fz))', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {isStop && act?.exit ? <span style={{ color: '#f59e0b', fontWeight: 800 }}>🏁 {L ? '出場' : '回補'} {hhmm(act.exit.t)} @{act.exit.px}·{act.exit.reason}·淨 {act.netR != null ? `${act.netR >= 0 ? '+' : ''}${act.netR}R` : '—'}（日誌口徑成本）</span>
            : desk?.vetoed && now - desk.vetoed.t < STOP_KEEP_MS ? <span style={{ color: '#f59e0b' }}>⛔ 否決 {desk.vetoed.type} {hhmm(desk.vetoed.t)}：{desk.vetoed.veto.join('；')}</span>
            : desk?.warnings?.length ? <span style={{ color: '#f59e0b' }}>⚠ {desk.warnings.join('、')}</span>
            : <span style={{ color: 'var(--text-muted)' }}>{base?.reason ?? ''}</span>}
        </div>
          {sc && <ScoreTable items={[...sc.market, ...sc.stock, ...sc.entry]} />}
          {desk?.orb && <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', margin: '4px 0' }}>開盤區間（{hhmm(desk.orb.formedAt)} 形成）開 {desk.orb.O}·高 {desk.orb.H}·低 {desk.orb.L}·今日假突破 {desk.falseBreaks} 次</div>}
          <StockTrendChart code={code} name={name} closePrice={price ?? 0} changePercent={chg ?? 0} />
        </div>
      )}
    </div>
  );
}

function KeyLine({ L, isOn, isStop, act, w, pEntry, pStop, targets, lp, expire, desk, now }: {
  L: boolean; isOn: boolean; isStop: boolean; act: DeskRowData['plan'] | null; w: NonNullable<DeskRowData['watch']>[number] | null;
  pEntry: number | null; pStop: number | null; targets: number[] | null; lp: ReturnType<typeof planLots> | null; expire: number | null; desk: DeskRowData | null; now: number;
}) {
  const S: React.CSSProperties = { fontSize: 'calc(12.5px * var(--fz))', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
  const col = L ? 'var(--color-up)' : 'var(--color-down)';
  if (isStop && act?.exit) return <div style={{ ...S, color: '#f59e0b', fontWeight: 700 }}>🏁 {hhmm(act.exit.t)} 出場 @{act.exit.px}·{act.exit.reason}·淨 {act.netR != null ? `${act.netR >= 0 ? '+' : ''}${act.netR}R` : '—'}</div>;
  if (isOn && act) return (
    <div style={{ ...S, ...NUM }}><b style={{ color: col }}>⚡ 成立（觀察）{hhmm(act.t)}·{act.type}</b>　假設進場 <b>{pEntry}</b>·停 <b style={{ color: '#f59e0b' }}>{act.trail != null && act.trail !== act.stop ? act.trail : pStop}</b>·目標 {targets?.join('／')}
      {lp?.lots ? <>·{lp.lots} 張風險約 −{lp.riskTwd?.toLocaleString()} 元</> : null}{expire ? <>·⏱{hhmm(expire)}</> : null}</div>
  );
  if (desk?.vetoed && now - desk.vetoed.t < STOP_KEEP_MS) return <div style={{ ...S, color: '#f59e0b' }}>⛔ {hhmm(desk.vetoed.t)} {desk.vetoed.type} 否決：{desk.vetoed.veto.join('；')}</div>;
  if (w) return <div style={{ ...S, color: 'var(--text-secondary, var(--text-muted))' }}>⏳ {w.type}·還差：{w.note}<span style={NUM}>（觸發 {w.trigger}·停 {w.stop}）</span></div>;
  return null;
}

function ScoreTable({ items }: { items: ScoreItem[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(8em, 13em) 3.2em minmax(0, 1fr)', columnGap: 8, rowGap: 2, fontSize: 'calc(12.5px * var(--fz))', marginBottom: 6 }}>
      {items.map(i => (
        <div key={i.key} style={{ display: 'contents' }}>
          <span style={{ color: 'var(--text-muted)' }}>{i.key.startsWith('m') ? 'M' : i.key.startsWith('s') ? 'S' : 'E'}·{i.label}</span>
          <span style={{ ...NUM, textAlign: 'right', fontWeight: 800, color: i.score == null ? '#f59e0b' : 'var(--text-primary)' }}>{i.score == null ? '未知' : `${i.score}/${i.max}`}</span>
          <span style={{ color: 'var(--text-muted)' }}>{i.evidence}</span>
        </div>
      ))}
    </div>
  );
}
