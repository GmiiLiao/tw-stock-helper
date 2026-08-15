'use client';

import { useState } from 'react';
import type { HoldingStrategyResult } from '../../../scripts/lib/holding-strategy';

// ── 持股策略三段面板（藍=隔日沖、青=波段持有、紫=相似歷史）──────────────
// PortfolioAI（持股卡）與 DecisionDesk（決策工作台展開區）共用——
// 單一渲染實作，配色/揭露文字兩處永遠一致。資料來源：
//   持股卡＝daemon 寫進 portfolioAnalysis.analyses[code].strategy；
//   工作台＝/api/ai/stock-strategy（同一份共用計算模組）。
// 兩條誠實揭露（描述統計非預測／相似檢定未通過）是本元件的一部分，不可由呼叫端關掉。

const BLUE = '#3d8ef8', TEAL = '#2dd4bf', VIOLET = '#a78bfa';

const panel = (c: string): React.CSSProperties => ({
  marginTop: 8, padding: '8px 12px', borderRadius: 8,
  background: `${c}0f`, border: `1px solid ${c}33`, borderLeft: `3px solid ${c}`,
});
const pTitle = (c: string): React.CSSProperties => ({ fontWeight: 800, color: c, marginBottom: 2 });
const chip = (border?: string): React.CSSProperties => ({
  padding: '2px 8px', borderRadius: 6, background: 'rgba(0,0,0,0.25)',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 'calc(0.72rem * var(--fz))',
  border: border ?? '1px solid transparent',
});
const caveat: React.CSSProperties = {
  marginTop: 4, padding: '4px 8px', borderRadius: 6, background: 'rgba(245,158,11,0.10)',
  border: '1px solid rgba(245,158,11,0.25)', color: '#fbbf24', fontSize: 'calc(0.68rem * var(--fz))',
};

// ── 隔日沖相似日疊圖（近5日形狀·後續5日·4 組）──────────────────────
// 與波段版同語言：錨=相似日（今日）=0%，左=近5日形狀、右=那三天後來的5日。
// 出場統計另以**隔日開盤價**計（與明開賣鐵律同口徑）。SVG 內零文字。
function NextAnalogChart({ na, selfPath5 }: { na: NonNullable<HoldingStrategyResult['nextAnalog']>; selfPath5: number[] }) {
  const [sel, setSel] = useState<number | 'self' | null>(null);
  const toggleSel = (k: number | 'self') => setSel(cur => (cur === k ? null : k));
  const opa = (k: number | 'self') => (sel == null ? undefined : sel === k ? 1 : 0.12);
  const W = 400, H = 130, DAYS = 10;   // day -4..+5
  const x = (day: number) => ((day + 4) / (DAYS - 1)) * W;
  const all: number[] = [...selfPath5];
  for (const e of na.examples) all.push(...e.path5);
  const lo = Math.min(...all), hi = Math.max(...all);
  const pad = Math.max((hi - lo) * 0.08, 0.4);
  const y = (v: number) => H - ((v - (lo - pad)) / ((hi + pad) - (lo - pad))) * H;
  const line = (pts: Array<[number, number]>) => pts.map(([d, v], i) => `${i === 0 ? 'M' : 'L'}${x(d).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 'calc(0.66rem * var(--fz))', marginBottom: 3 }}>
        <button onClick={() => toggleSel('self')}
          style={{ display: 'inline-flex', alignItems: 'center', padding: '1px 8px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit',
            background: sel === 'self' ? 'rgba(226,232,240,0.18)' : 'transparent', color: 'var(--text-secondary)',
            border: sel === 'self' ? '1px solid #e2e8f0' : '1px solid var(--border-primary)', opacity: sel != null && sel !== 'self' ? 0.4 : 1 }}>
          <span style={{ display: 'inline-block', width: 14, height: 3, background: '#e2e8f0', marginRight: 4 }} />本檔（至今日）
        </button>
        {na.examples.map((e, i) => (
          <button key={e.code + e.date} onClick={() => toggleSel(i)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 8px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit',
              background: sel === i ? `${EX_COLORS[i]}22` : 'transparent', color: 'var(--text-secondary)',
              border: sel === i ? `1px solid ${EX_COLORS[i]}` : '1px solid var(--border-primary)', opacity: sel != null && sel !== i ? 0.4 : 1 }}>
            <span style={{ display: 'inline-block', width: 14, height: 3, background: EX_COLORS[i] }} />
            {e.code} {e.name}{e.sameInd && <span style={{ fontSize: 'calc(0.6rem * var(--fz))', padding: '0 4px', borderRadius: 999, background: 'rgba(45,212,191,0.15)', color: '#2dd4bf', border: '1px solid rgba(45,212,191,0.35)' }}>同族群</span>} {e.date}{e.openRet != null ? `（隔日開盤 ${e.openRet >= 0 ? '+' : ''}${e.openRet}%）` : ''}
          </button>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 130, display: 'block', background: 'rgba(0,0,0,0.2)', borderRadius: 8 }}>
        <DayBands dayMin={-4} dayMax={5} W={W} H={H} />
        <rect x={x(0)} y={0} width={W - x(0)} height={H} fill="rgba(61,142,248,0.06)" />
        <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="rgba(148,163,184,0.35)" strokeDasharray="4 4" strokeWidth={0.6} />
        <line x1={x(0)} x2={x(0)} y1={0} y2={H} stroke="rgba(226,232,240,0.5)" strokeDasharray="2 3" strokeWidth={0.8} />
        {na.examples.map((e, i) => (
          <path key={e.code + e.date} d={line(e.path5.map((v, k) => [k - (e.winLen5 - 1), v] as [number, number]))}
            fill="none" stroke={EX_COLORS[i]} strokeWidth={sel === i ? 2.6 : 1.4} vectorEffect="non-scaling-stroke"
            opacity={opa(i) ?? 0.9} style={{ cursor: 'pointer' }} pointerEvents="stroke" onClick={() => toggleSel(i)} />
        ))}
        <path d={line(selfPath5.map((v, k) => [k - (selfPath5.length - 1), v] as [number, number]))}
          fill="none" stroke="#e2e8f0" strokeWidth={sel === 'self' ? 3.2 : 2.4} vectorEffect="non-scaling-stroke"
          opacity={opa('self')} style={{ cursor: 'pointer' }} pointerEvents="stroke" onClick={() => toggleSel('self')} />
        <circle cx={x(0)} cy={y(0)} r={3} fill="#e2e8f0" />
      </svg>
      <DayLabels dayMin={-4} dayMax={5} step={1} />
    </div>
  );
}

// ── 相似波段比較疊圖 ────────────────────────────────────────────────
// 四條線（本檔＋3 段相似）以「相似點」為 0% 錨對齊：
// 錨左邊是拿去比對的 20 日形狀、右邊是那三段歷史「後來怎麼走」。
// 本檔沒有未來，線停在錨點——右半邊只有歷史例子，這正是視覺判斷的素材。
// ⚠ SVG 內不放任何文字（preserveAspectRatio="none" 會把字壓扁——個股K線圖的舊坑），
//   圖例與軸標全部放 HTML。
const EX_COLORS = ['#a78bfa', '#f472b6', '#38bdf8'];

// ── 日刻度（2026-08-12 使用者需求：線段看不出是第幾日）────────────────
// SVG 內畫「每 5 日交替底色帶＋日刻度線」，日數字放 HTML 標籤列（SVG 零文字鐵則）。
// dayMin..dayMax 對映 0..W；labelStep 決定標籤密度。
function DayBands({ dayMin, dayMax, W, H }: { dayMin: number; dayMax: number; W: number; H: number }) {
  const x = (d: number) => ((d - dayMin) / (dayMax - dayMin)) * W;
  const bands: React.ReactNode[] = [];
  for (let d = Math.ceil(dayMin / 5) * 5; d < dayMax; d += 5) {
    const isAlt = ((d / 5) % 2 + 2) % 2 === 1;
    if (isAlt) bands.push(<rect key={'b' + d} x={x(d)} y={0} width={x(Math.min(d + 5, dayMax)) - x(d)} height={H} fill="rgba(255,255,255,0.03)" />);
  }
  const ticks: React.ReactNode[] = [];
  for (let d = Math.ceil(dayMin); d <= dayMax; d++) {
    if (d === 0) continue;   // 錨線另有樣式
    const major = d % 5 === 0;
    ticks.push(<line key={'t' + d} x1={x(d)} x2={x(d)} y1={0} y2={H}
      stroke={major ? 'rgba(148,163,184,0.22)' : 'rgba(148,163,184,0.08)'} strokeWidth={major ? 0.8 : 0.5} />);
  }
  return <>{bands}{ticks}</>;
}
function DayLabels({ dayMin, dayMax, step }: { dayMin: number; dayMax: number; step: number }) {
  const labels: number[] = [];
  for (let d = Math.ceil(dayMin / step) * step; d <= dayMax; d += step) labels.push(d);
  if (!labels.includes(0)) labels.push(0);
  return (
    <div style={{ position: 'relative', height: 14, marginTop: 1, fontFamily: 'JetBrains Mono, monospace', fontSize: 'calc(0.6rem * var(--fz))', color: 'var(--text-muted)' }}>
      {labels.sort((a, b) => a - b).map(d => (
        <span key={d} style={{ position: 'absolute', left: `${((d - dayMin) / (dayMax - dayMin)) * 100}%`, transform: 'translateX(-50%)', color: d === 0 ? 'var(--text-secondary)' : undefined, fontWeight: d === 0 ? 700 : 400 }}>
          {d === 0 ? '今' : d > 0 ? `+${d}` : d}
        </span>
      ))}
    </div>
  );
}

// ── 隔日沖：走勢與突破位圖 ────────────────────────────────────────────
// 一眼回答「現在是不是突破 20 日高的時機」：近 20 日收盤線（錨=今日=0%）＋
// 琥珀虛線=20日高突破線＋今日端點。線在虛線上方收＝已突破（濾網第一條件）。
// SVG 內零文字（preserveAspectRatio="none" 壓扁字的舊坑），標籤全在 HTML。
function BreakoutChart({ selfPath, hi20Rel, brk20 }: { selfPath: number[]; hi20Rel: number; brk20: boolean }) {
  const W = 400, H = 110;
  const all = [...selfPath, hi20Rel, 0];
  const lo = Math.min(...all), hi = Math.max(...all);
  const pad = Math.max((hi - lo) * 0.08, 0.4);
  const y = (v: number) => H - ((v - (lo - pad)) / ((hi + pad) - (lo - pad))) * H;
  const x = (i: number) => (i / (selfPath.length - 1)) * W;
  const d = selfPath.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const lineColor = brk20 ? 'var(--color-up)' : '#e2e8f0';
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 'calc(0.66rem * var(--fz))', color: 'var(--text-muted)', marginBottom: 3 }}>
        <span><span style={{ display: 'inline-block', width: 14, height: 3, background: lineColor, verticalAlign: 'middle', marginRight: 4 }} />近 20 日收盤（今日＝0%）</span>
        <span><span style={{ display: 'inline-block', width: 14, height: 0, borderTop: '2px dashed #fbbf24', verticalAlign: 'middle', marginRight: 4 }} />20日高突破線（{hi20Rel >= 0 ? `還差 +${hi20Rel}%` : '已站上'}）</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 110, display: 'block', background: 'rgba(0,0,0,0.2)', borderRadius: 8 }}>
        <DayBands dayMin={-(selfPath.length - 1)} dayMax={0} W={W} H={H} />
        <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="rgba(148,163,184,0.3)" strokeDasharray="4 4" strokeWidth={0.6} />
        <line x1={0} x2={W} y1={y(hi20Rel)} y2={y(hi20Rel)} stroke="#fbbf24" strokeDasharray="5 4" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
        <path d={d} fill="none" stroke={lineColor} strokeWidth={2.2} vectorEffect="non-scaling-stroke" />
        <circle cx={W} cy={y(0)} r={3.5} fill={lineColor} />
      </svg>
      <DayLabels dayMin={-(selfPath.length - 1)} dayMax={0} step={5} />
    </div>
  );
}
function AnalogChart({ analog, selfPath }: { analog: NonNullable<HoldingStrategyResult['analog']>; selfPath: number[] }) {
  // 點選辨識（2026-08-12 使用者需求）：點圖例或線段 → 該線高亮、其餘退淡；再點取消。
  const [sel, setSel] = useState<number | 'self' | null>(null);
  const toggleSel = (k: number | 'self') => setSel(cur => (cur === k ? null : k));
  const opa = (k: number | 'self') => (sel == null ? undefined : sel === k ? 1 : 0.12);
  const W = 400, H = 150, DAYS = 40;              // x 槽位：day -19..+20
  const x = (day: number) => ((day + 19) / (DAYS - 1)) * W;
  const all: number[] = [...selfPath];
  for (const e of analog.examples) all.push(...e.path);
  const lo = Math.min(...all), hi = Math.max(...all);
  const pad = Math.max((hi - lo) * 0.06, 0.5);
  const y = (v: number) => H - ((v - (lo - pad)) / ((hi + pad) - (lo - pad))) * H;
  const line = (pts: Array<[number, number]>) => pts.map(([d, v], i) => `${i === 0 ? 'M' : 'L'}${x(d).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const selfPts: Array<[number, number]> = selfPath.map((v, i) => [i - (selfPath.length - 1), v]);
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 'calc(0.66rem * var(--fz))', marginBottom: 3 }}>
        {/* 圖例即開關：點選高亮該線、其餘退淡（線段本身也可點） */}
        <button onClick={() => toggleSel('self')}
          style={{ display: 'inline-flex', alignItems: 'center', padding: '1px 8px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit',
            background: sel === 'self' ? 'rgba(226,232,240,0.18)' : 'transparent', color: 'var(--text-secondary)',
            border: sel === 'self' ? '1px solid #e2e8f0' : '1px solid var(--border-primary)', opacity: sel != null && sel !== 'self' ? 0.4 : 1 }}>
          <span style={{ display: 'inline-block', width: 14, height: 3, background: '#e2e8f0', marginRight: 4 }} />本檔（至今日）
        </button>
        {analog.examples.map((e, i) => (
          <button key={e.code + e.date} onClick={() => toggleSel(i)}
            style={{ display: 'inline-flex', alignItems: 'center', padding: '1px 8px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit',
              background: sel === i ? `${EX_COLORS[i]}22` : 'transparent', color: 'var(--text-secondary)',
              border: sel === i ? `1px solid ${EX_COLORS[i]}` : '1px solid var(--border-primary)', opacity: sel != null && sel !== i ? 0.4 : 1 }}>
            <span style={{ display: 'inline-block', width: 14, height: 3, background: EX_COLORS[i], marginRight: 4 }} />{e.code} {e.name || ''}{e.sameInd && <span style={{ fontSize: 'calc(0.6rem * var(--fz))', padding: '0 4px', borderRadius: 999, background: 'rgba(45,212,191,0.15)', color: '#2dd4bf', border: '1px solid rgba(45,212,191,0.35)', marginLeft: 3 }}>同族群</span>} {e.date}{e.ret5 != null ? `（5日 ${e.ret5 >= 0 ? '+' : ''}${e.ret5}%）` : ''}
          </button>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 150, display: 'block', background: 'rgba(0,0,0,0.2)', borderRadius: 8 }}>
        <DayBands dayMin={-19} dayMax={20} W={W} H={H} />
        {/* 右半（相似點之後）淡紫底＝「後來怎麼走」區 */}
        <rect x={x(0)} y={0} width={W - x(0)} height={H} fill="rgba(167,139,250,0.06)" />
        {/* 0% 水平線與相似點分隔線 */}
        <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="rgba(148,163,184,0.35)" strokeDasharray="4 4" strokeWidth={0.6} />
        <line x1={x(0)} x2={x(0)} y1={0} y2={H} stroke="rgba(226,232,240,0.5)" strokeDasharray="2 3" strokeWidth={0.8} />
        {analog.examples.map((e, i) => (
          <path key={e.code + e.date} d={line(e.path.map((v, k) => [k - (e.winLen - 1), v] as [number, number]))}
            fill="none" stroke={EX_COLORS[i]} strokeWidth={sel === i ? 2.6 : 1.4} vectorEffect="non-scaling-stroke"
            opacity={opa(i) ?? 0.9} style={{ cursor: 'pointer' }} pointerEvents="stroke"
            onClick={() => toggleSel(i)} />
        ))}
        <path d={line(selfPts)} fill="none" stroke="#e2e8f0" strokeWidth={sel === 'self' ? 3.2 : 2.4} vectorEffect="non-scaling-stroke"
          opacity={opa('self')} style={{ cursor: 'pointer' }} pointerEvents="stroke" onClick={() => toggleSel('self')} />
        <circle cx={x(0)} cy={y(0)} r={3} fill="#e2e8f0" />
      </svg>
      <DayLabels dayMin={-19} dayMax={20} step={5} />
    </div>
  );
}

export default function StrategyPanels({ st, pnlPct, mode = 'holding' }: { st: HoldingStrategyResult; pnlPct?: number; mode?: 'holding' | 'candidate' }) {
  // 日計慣例（2026-08-12 使用者定案）：**進場／操作當天＝第 1 日**。
  // st.heldDays 是「經過的交易日數」（進場日=0）——顯示一律 +1；
  // 候選（無買進日）由呼叫端把 heldDays 錨定為 0＝「以操作時間為第 1 日」。
  // 對照列取 max(1, elapsed)：進場當天對到 d=1（＝明日收盤那格），語意是
  // 「接下來持有滿 1 個交易日，歷史上中位是多少」。
  const [showChart, setShowChart] = useState(false);   // 相似疊圖（預設收合）
  const [showBreakout, setShowBreakout] = useState(false);   // 隔日沖走勢/突破位圖（預設收合）
  const [showNextAnalog, setShowNextAnalog] = useState(false);   // 隔日沖相似日疊圖（預設收合）
  const elapsed = st.heldDays;
  const dayNo = elapsed != null ? elapsed + 1 : null;
  const matched = elapsed != null ? st.hold.find(h => h.d >= Math.max(1, elapsed)) ?? st.hold[st.hold.length - 1] : null;
  // 🗼 寶塔線技能（2026-08-15 使用者定義）：紅K×月線上未翻黑前續抱、綠K×月線下賣出；
  // 短線同規則改 60 分K。古典規則、未經本站回測——顯示判定與依據，不下結論。
  const pagodaChip = (j: NonNullable<HoldingStrategyResult['pagoda']>, label: string) => {
    const kc = j.color === 'red' ? 'var(--color-up)' : 'var(--color-down)';
    const ac = j.action === '續抱' ? 'var(--color-up)' : j.action === '賣出' ? 'var(--color-down)' : '#f59e0b';
    return (
      <span title={`${j.note}（收 ${j.close}／MA20 ${j.ma}）`} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span style={{ color: 'var(--text-muted)' }}>{label}</span>
        <b style={{ color: kc }}>{j.color === 'red' ? '紅' : '綠'}K第{j.run}根</b>
        <span style={{ color: 'var(--text-muted)' }}>{j.above ? '線上' : '線下'}</span>
        {j.flip && <b style={{ color: j.flip === 'up' ? 'var(--color-up)' : 'var(--color-down)' }}>{j.flip === 'up' ? '⚡翻多' : '⚡翻空'}</b>}
        <b style={{ padding: '0 7px', borderRadius: 999, background: `${'#000'}00`, border: `1px solid ${ac}`, color: ac }}>{j.action}</b>
      </span>
    );
  };
  return (
    <div style={{ padding: '2px 10px 10px', fontSize: 'calc(0.76rem * var(--fz))', lineHeight: 1.8, color: 'var(--text-secondary)' }}>
      {/* 🗼 寶塔線（波段=日K×月線；短線=60分K×20根均） */}
      {(st.pagoda || st.pagoda60) && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', padding: '6px 10px', margin: '6px 0 2px', borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <b style={{ color: 'var(--text-primary)' }}>🗼 寶塔線</b>
          {st.pagoda && pagodaChip(st.pagoda, '波段·日K')}
          {st.pagoda60 && pagodaChip(st.pagoda60, '短線·60分K')}
          <span style={{ fontSize: 'calc(0.64rem * var(--fz))', color: 'var(--text-muted)' }}>古典規則·未經本站回測（詳見說明書）</span>
        </div>
      )}
      {/* ① 隔日沖 */}
      <div style={panel(BLUE)}>
        <div style={pTitle(BLUE)}>🎯 若以隔日沖操作</div>
        <div style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 6, marginBottom: 2,
          background: st.filterPass ? 'rgba(240,62,62,0.12)' : 'rgba(148,163,184,0.12)',
          border: st.filterPass ? '1px solid rgba(240,62,62,0.35)' : '1px solid var(--border-primary)' }}>
          今日 <b style={{ color: st.chg >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>{st.chg >= 0 ? '+' : ''}{st.chg}%</b>
          {st.pos != null ? <>·收位 <b>{st.pos}</b></> : null}{st.charLabel ? `·${st.charLabel}` : ''}——
          {st.filterPass
            ? <b style={{ color: 'var(--color-up)' }}>符合撿尾盤定版濾網</b>
            : <>不符定版濾網（缺 <b style={{ color: '#fbbf24' }}>{st.fails.join('、')}</b>）</>}
        </div>
        <div style={{ fontSize: 'calc(0.72rem * var(--fz))' }}>
          鐵律：隔日沖持股一律<b style={{ color: BLUE }}>明早開盤賣出</b>（700 日實測唯一穩定淨正出場；開高續抱平均吐光溢價 -0.33%）。來回費稅約 <b>0.44%</b>。
          {st.charLabel === '長期核心' ? <b style={{ color: '#fbbf24' }}>此股屬長期核心——短線訊號是雜訊，不建議隔日沖。</b> : null}
        </div>
        {/* 走勢與突破位：**只在已突破時出現**（2026-08-12 使用者定案）——
            未突破的股不顯示此區，避免對「時機未到」的股提供追價視覺。 */}
        {st.brk20 && st.selfPath?.length ? (
          <>
            <button onClick={() => setShowBreakout(v => !v)}
              style={{ marginTop: 4, padding: '3px 10px', borderRadius: 8, fontSize: 'calc(0.7rem * var(--fz))', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', background: showBreakout ? `${BLUE}22` : 'var(--bg-secondary)', color: showBreakout ? BLUE : 'var(--text-secondary)', border: `1px solid ${showBreakout ? BLUE : 'var(--border-primary)'}` }}>
              📈 {showBreakout ? '收合走勢與突破位 ▴' : '展開走勢與突破位（時機判斷）▾'}
            </button>
            {showBreakout && <BreakoutChart selfPath={st.selfPath} hi20Rel={st.hi20Rel} brk20={st.brk20} />}
          </>
        ) : null}
        {st.nextAnalog && st.selfPath5?.length ? (
          <>
            <button onClick={() => setShowNextAnalog(v => !v)}
              style={{ marginTop: 4, marginLeft: 6, padding: '3px 10px', borderRadius: 8, fontSize: 'calc(0.7rem * var(--fz))', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', background: showNextAnalog ? `${BLUE}22` : 'var(--bg-secondary)', color: showNextAnalog ? BLUE : 'var(--text-secondary)', border: `1px solid ${showNextAnalog ? BLUE : 'var(--border-primary)'}` }}>
              📈 {showNextAnalog ? '收合相似日比較 ▴' : `展開相似日比較（4 組·後續 5 日）▾`}
            </button>
            {showNextAnalog && (
              <>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '6px 0 0' }}>
                  <span style={{ padding: '2px 8px', borderRadius: 6, background: 'rgba(0,0,0,0.25)', fontFamily: 'JetBrains Mono, monospace', fontSize: 'calc(0.72rem * var(--fz))' }}>
                    隔日<b style={{ color: BLUE }}>開盤賣</b>中位 <b style={{ color: (st.nextAnalog.openMed ?? 0) >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>{st.nextAnalog.openMed != null ? `${st.nextAnalog.openMed >= 0 ? '+' : ''}${st.nextAnalog.openMed}%` : '—'}</b> <span style={{ color: 'var(--text-muted)' }}>勝{st.nextAnalog.openWin ?? '—'}%</span>
                  </span>
                  <span style={{ padding: '2px 8px', borderRadius: 6, background: 'rgba(0,0,0,0.25)', fontFamily: 'JetBrains Mono, monospace', fontSize: 'calc(0.72rem * var(--fz))' }}>
                    後5日收盤中位 <b style={{ color: (st.nextAnalog.d5Med ?? 0) >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>{st.nextAnalog.d5Med != null ? `${st.nextAnalog.d5Med >= 0 ? '+' : ''}${st.nextAnalog.d5Med}%` : '—'}</b> <span style={{ color: 'var(--text-muted)' }}>勝{st.nextAnalog.d5Win ?? '—'}%</span>
                  </span>
                  <span style={{ padding: '2px 8px', borderRadius: 6, background: 'rgba(0,0,0,0.25)', fontSize: 'calc(0.68rem * var(--fz))', color: 'var(--text-muted)' }}>近5日逐點 ±3%·例外≤1日·n={st.nextAnalog.n}·同族群優先</span>
                  {(st.nextAnalog.n < 5 || st.nextAnalog.relaxedOutDays != null) && (
                    <span style={{ padding: '2px 8px', borderRadius: 6, background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.25)', fontSize: 'calc(0.68rem * var(--fz))', color: '#fbbf24' }}>{st.nextAnalog.relaxedOutDays != null ? `標準鐵則 0 段——已放寬例外 ≤${st.nextAnalog.relaxedOutDays} 日` : '樣本<5'}——統計留空，僅供目視</span>
                  )}
                </div>
                <NextAnalogChart na={st.nextAnalog} selfPath5={st.selfPath5} />
                <div style={caveat}>⚠ 開盤賣＝鐵律口徑·描述統計非訊號（詳見說明書「持股策略分析」）</div>
              </>
            )}
          </>
        ) : null}
      </div>
      {/* ② 持有日獲利 */}
      <div style={panel(TEAL)}>
        <div style={pTitle(TEAL)}>🌊 波段持有日獲利<span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 'calc(0.68rem * var(--fz))' }}>（該股近一年逐日進場統計·n={st.hold[0]?.n ?? '—'}）</span></div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '3px 0' }}>
          {st.hold.map(h => (
            <span key={h.d} style={chip(matched && matched.d === h.d ? `1.5px solid ${TEAL}` : undefined)}>
              第{h.d}日 <b style={{ color: h.med >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>{h.med >= 0 ? '+' : ''}{h.med}%</b> <span style={{ color: 'var(--text-muted)' }}>勝{h.win}%</span>
            </span>
          ))}
        </div>
        {dayNo != null && matched && (
          <div>
            你目前{mode === 'candidate' ? '操作' : '持有'}<b style={{ color: TEAL }}>第 {dayNo} 個交易日</b>
            <span style={{ color: 'var(--text-muted)', fontSize: 'calc(0.68rem * var(--fz))' }}>（{mode === 'candidate' ? '以操作時間為第 1 日' : '買進日＝第 1 日'}）</span>
            {pnlPct != null && <>、帳面 <b style={{ color: pnlPct >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>{pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%</b></>}
            ；持有滿 <b>{matched.d}</b> 個交易日的歷史中位 {matched.med >= 0 ? '+' : ''}{matched.med}%（勝率 {matched.win}%）。
          </div>
        )}
        <div style={caveat}>⚠ 描述統計·繼承趨勢·非預測（詳見說明書「持股策略分析」）</div>
      </div>
      {/* ③ 相似歷史波段 */}
      {!st.analog && st.analogNote && (
        <div style={panel(VIOLET)}>
          <div style={pTitle(VIOLET)}>🔁 相似歷史波段</div>
          <div style={{ color: 'var(--text-muted)' }}>{st.analogNote}</div>
        </div>
      )}
      {st.analog && (
        <div style={panel(VIOLET)}>
          <div style={pTitle(VIOLET)}>🔁 相似歷史波段<span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 'calc(0.68rem * var(--fz))' }}>（全市場最像的 {st.analog.n} 段·逐點 ±3% 內·例外 ≤5 日且不超過 ±{st.analog.tube}%）</span></div>
          {st.analog.relaxedOutDays != null && (
            <div style={{ ...caveat, marginTop: 0, marginBottom: 3 }}>⚠ 標準鐵則（例外 ≤5 日）下為 0 段——已放寬至例外 ≤{st.analog.relaxedOutDays} 日找出最接近者；統計一律留空，僅供目視比對。</div>
          )}
          {st.analog.relaxedOutDays == null && st.analog.n < 5 && (
            <div style={{ ...caveat, marginTop: 0, marginBottom: 3 }}>⚠ 僅找到 {st.analog.n} 段（&lt;5）——樣本過少、無統計意義，中位/勝率不顯示，線圖僅供目視比對。</div>
          )}
          {st.analog.tube > 5 && (
            <div style={{ ...caveat, marginTop: 0, marginBottom: 3 }}>⚠ 走勢較極端，例外日的離群上限已放寬到 ±{st.analog.tube}%（逐點 ±3%/≤5 日鐵則不變）——判讀請更保守。</div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '3px 0' }}>
            {st.analog.stats.map(x => (
              <span key={x.d} style={chip()}>
                後{x.d}日 <b style={{ color: x.med >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>{x.med >= 0 ? '+' : ''}{x.med}%</b> <span style={{ color: 'var(--text-muted)' }}>勝{x.win}%</span>
              </span>
            ))}
            {st.analog.grow != null && st.analog.draw != null && (
              <span style={chip(`1px solid ${VIOLET}55`)}>
                最大成長 <b style={{ color: 'var(--color-up)' }}>+{st.analog.grow}%</b> ／ 回檔 <b style={{ color: 'var(--color-down)' }}>{st.analog.draw}%</b>
              </span>
            )}
          </div>
          <div style={{ fontSize: 'calc(0.7rem * var(--fz))', color: 'var(--text-muted)' }}>例：{st.analog.examples.map(e => `${e.code} ${e.name || ''} ${e.date} → 5日 ${e.ret5 != null ? (e.ret5 >= 0 ? '+' : '') + e.ret5 + '%' : '—'}`).join('；')}</div>
          {st.selfPath?.length ? (
            <>
              <button onClick={() => setShowChart(v => !v)}
                style={{ marginTop: 4, padding: '3px 10px', borderRadius: 8, fontSize: 'calc(0.7rem * var(--fz))', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', background: showChart ? `${VIOLET}22` : 'var(--bg-secondary)', color: showChart ? VIOLET : 'var(--text-secondary)', border: `1px solid ${showChart ? VIOLET : 'var(--border-primary)'}` }}>
                📈 {showChart ? '收合比較線圖 ▴' : '展開比較線圖（本檔＋3 段相似疊圖）▾'}
              </button>
              {showChart && <AnalogChart analog={st.analog} selfPath={st.selfPath} />}
            </>
          ) : null}
          <div style={caveat}>⚠ 相似≠預測·檢定未通過·非訊號（詳見說明書「持股策略分析」）</div>
        </div>
      )}
    </div>
  );
}
