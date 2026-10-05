'use client';

// ── 🧭 T1 連板起漲（分軌）前向影子（超級管理員；起漲影子分頁的子分頁）────────────────────────────
// 登錄 T1-TRACKS-FWD-2026-10-05：每個交易日盤後凍結四份代理清單（S0、S_FB 研究榜；R0、W 灰底觀察），t＋1 收盤後對答案。
// 資料：scripts/surge-lab/a37_tracks_fwd.py → a37_tracks_publish.mjs → surgeShadow/tracks-* → /api/admin/surge-shadow?view=tracks｜tracksDay。
// 文件本身不含任何報酬欄位（灰底清單依 G1 決定不顯示報酬；研究榜卡片也只顯示 T1 命中與 Δprecision）。
// 版面：上方＝當日對帳（每個 T1 事件的軌道／沒通過的條件／名次／是否入選），下方依固定順序 M0 參照 → S0 → S_FB → R0（灰底）→ W（灰底），各自一區、不混排。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TracksIndexDoc, TracksDayDoc, TracksListBlock, TracksPick, TracksCum, TracksRefStat } from '../../../scripts/lib/surge-tracks-report.mjs';
import { Kpi, Section, ListTable, MONO } from './AiLabParts';
import { labGet, twTime } from './surgeLabFetch';

export interface TracksResp { found: boolean; index?: TracksIndexDoc | null; updatedAt?: string | null; day?: TracksDayDoc | null; dayId?: string | null }
const RED = '#ef4444'; const AMBER = '#f59e0b';
const GREY_BG = 'rgba(148,163,184,0.10)';
const n2 = (v: number | null | undefined, unit = '') => (v == null ? '—' : `${v.toFixed(2)}${unit}`);
const pp = (v: number | null | undefined) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}pp`);
const ciTxt = (v: [number, number] | null | undefined) => (v ? `[${v[0].toFixed(2)}, ${v[1].toFixed(2)}]` : '');
const MKT: Record<string, string> = { TWSE: '市', TPEx: '櫃' };

function refText(r: TracksRefStat | undefined, label: string) {
  if (!r) return null;
  return `${label} ${r.hits}／${r.picks.toLocaleString()}＝${r.precisionPct.toFixed(2)}%、Δ ${pp(r.deltaPp)} ${ciTxt(r.deltaCiPp)}、lift ${r.lift.toFixed(2)}`;
}

function outcomeCell(p: TracksPick) {
  const o = p.outcome;
  if (!o) return <span style={{ color: 'var(--text-muted)' }}>待到期</span>;
  const extra = [o.lockedOpen ? '開盤鎖漲停' : null, o.noOpen ? 't 日無開盤' : null, o.dispT ? 't 日起處置' : null].filter(Boolean).join('·');
  return (
    <span title="事後欄位（凍結之後才知道）">
      <span style={{ color: o.t1 ? 'var(--color-up)' : 'var(--text-muted)', fontWeight: o.t1 ? 800 : 400 }}>{o.t1 ? '✅ T1 連板' : '✖ 未連板'}</span>
      {extra ? <span style={{ color: AMBER }}>（{extra}）</span> : null}
      <span style={{ color: 'var(--text-muted)', fontSize: 'calc(11px * var(--fz))' }}>（事後）</span>
    </span>
  );
}

function badges(p: TracksPick) {
  const out = [p.disposalBadge, p.attentionBadge].filter(Boolean) as string[];
  if (!out.length) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  return <span style={{ color: AMBER, whiteSpace: 'normal' }}>{out.join('；')}</span>;
}

function ListSection({ b }: { b: TracksListBlock }) {
  const box: React.CSSProperties = { marginTop: 14, padding: '10px 12px', borderRadius: 12, border: `1px solid ${b.grey ? 'rgba(148,163,184,0.35)' : 'var(--border-primary)'}`, background: b.grey ? GREY_BG : 'transparent' };
  const o = b.outcome;
  return (
    <section style={box} aria-label={b.title}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 900, fontSize: 'calc(14px * var(--fz))', color: b.grey ? 'var(--text-muted)' : undefined }}>{b.title}</span>
        {b.exploratory && <span style={{ fontSize: 'calc(11.5px * var(--fz))', padding: '0 8px', borderRadius: 999, border: `1px solid ${AMBER}`, color: AMBER }}>探索性</span>}
        {b.grey && <span style={{ fontSize: 'calc(11.5px * var(--fz))', padding: '0 8px', borderRadius: 999, border: '1px solid var(--border-primary)', color: 'var(--text-muted)' }}>灰底·不顯示報酬</span>}
      </div>
      <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginTop: 2 }}>{b.listVerdict}</div>
      {b.status === 'not-wired' ? (
        <div style={{ marginTop: 6, color: 'var(--text-muted)' }}>尚未接線（第二期）：凍結模型指紋重現後才凍結 M0 參照名單；本區不顯示名單。</div>
      ) : b.status === 'missing' ? (
        <div style={{ marginTop: 6, color: RED }}>這一天的凍結檔沒有這份清單。</div>
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 14px', marginTop: 6, fontSize: 'calc(12.5px * var(--fz))' }}>
            <span>候選 <b style={MONO}>{b.nPool ?? '—'}</b> 檔（{b.ranking ?? '—'} 由大到小，取前 {b.K}）</span>
            {o ? <span>當日基準率 <b style={MONO}>{n2(o.baseRatePct, '%')}</b>（池內 T1 {o.events ?? '—'} 件）</span> : <span style={{ color: 'var(--text-muted)' }}>基準率待到期</span>}
            {o && <span>命中 <b style={MONO}>{o.hits}／{o.picks}</b>、Δ 對 RAND <b style={MONO}>{pp(o.deltaPp)}</b>（同日隨機期望 {o.expectedRand ?? '—'} 件）</span>}
          </div>
          <div style={{ marginTop: 4, fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>
            研究參考：{[refText(b.reference?.sel, 'SEL'), refText(b.reference?.ho, 'HO')].filter(Boolean).join('｜') || '—'}
          </div>
          {b.warnings.length > 0 && <div style={{ marginTop: 4, fontSize: 'calc(12px * var(--fz))', color: AMBER }}>⚠ {b.warnings.join('；')}</div>}
          <div style={{ marginTop: 6 }}>
            <ListTable head={['#', '代號', '名稱', '市場', '收盤', 'vol20（張）', 'Qmax（張）', '處置／注意（另列風險）', '分數', '結果（事後）']} right={[0, 4, 5, 6, 8]} stickyFirst
              empty="池內沒有列" rowKeys={b.picks.map(p => `${p.rank}-${p.code}`)}
              rows={b.picks.map(p => [
                p.rank ?? '—', <b key="c" style={MONO}>{p.code}</b>, <span key="n" title={p.nameSrc ?? undefined}>{p.name}</span>, p.market ? MKT[p.market] ?? p.market : '—',
                p.close ?? '—', p.vol20 ?? '—', p.qmaxLots ?? '—', badges(p), p.score == null ? '—' : p.score.toFixed(4), outcomeCell(p),
              ])} />
          </div>
          {b.rand && b.rand.drawCodes.length > 0 && (
            <div style={{ marginTop: 4, fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>
              同日隨機抽樣（稽核用、種子固定）：{b.rand.drawCodes.join(' ')}{o?.randDrawHits != null ? `｜命中 ${o.randDrawHits}` : ''}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Reconcile({ d }: { d: TracksDayDoc }) {
  if (!d.events) {
    const st = d.matured.y;
    return <div style={{ color: st === 'label_unavailable' ? RED : 'var(--text-muted)' }}>{st === 'label_unavailable' ? '標籤無法取得（t／t＋1 官方資料逾期未齊，不計入指標）' : `⏳ 尚未到期：${d.t ?? 't'} 與下一交易日收盤、官方漲停價到齊後對帳`}</div>;
  }
  const by = d.eventsByTrack ? Object.entries(d.eventsByTrack).map(([k, v]) => `${k} ${v}`).join('、') : '';
  return (
    <>
      <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginBottom: 4 }}>當日 T1 事件 {d.events.length} 件（{by || '—'}）：每件標出所屬軌道、沒通過的條件、在該軌清單的名次與是否入選。</div>
      <ListTable head={['代號', '名稱', '市場', '軌道', '沒通過的條件', '清單', '名次／池', '結果']} right={[6]} stickyFirst empty="當日沒有 T1 事件"
        rowKeys={d.events.map(e => `${e.code}`)}
        rows={d.events.map(e => [
          <b key="c" style={MONO}>{e.code}</b>, e.name ?? '—', e.market ? MKT[e.market] ?? e.market : '—', e.trackText ?? e.track ?? '—',
          <span key="f" style={{ whiteSpace: 'normal', display: 'inline-block', minWidth: '14em' }}>{e.failing.length ? e.failing.join('、') : '—'}</span>, e.listId ?? '—',
          e.rank != null ? `${e.rank}／${e.nPool ?? '—'}` : '—',
          e.listId && e.rank != null ? <span key="r" style={{ color: e.picked ? 'var(--color-up)' : 'var(--text-muted)', fontWeight: e.picked ? 800 : 400 }}>{e.picked ? `✅ 命中（前 ${e.K}）` : '漏網'}</span>
            : <span key="r" style={{ color: 'var(--text-muted)' }}>{e.note ?? '不排名'}</span>,
        ])} />
    </>
  );
}

function CumTable({ ix }: { ix: TracksIndexDoc }) {
  const ids = ['S0_atr14@5', 'SFB_atr14@5', 'R0_combo@5', 'W_atr14@3'];
  const rows = ids.map(id => {
    const c: TracksCum | null = ix.cumulative[id] ?? null;
    const meta = ix.listMeta[id];
    return [
      <span key="t" style={{ color: meta?.grey ? 'var(--text-muted)' : undefined }}>{meta?.title ?? id}</span>, c?.windowDays ?? 0, c ? `${c.hits ?? 0}／${c.picks ?? 0}` : '—',
      c?.precisionPct == null ? '—' : `${c.precisionPct.toFixed(2)}%`, c?.randPrecisionPct == null ? '—' : `${c.randPrecisionPct.toFixed(2)}%`,
      c ? `${pp(c.deltaPp)} ${ciTxt(c.deltaCiPp)}` : '—', c?.lift == null ? '—' : `${c.lift.toFixed(2)} ${ciTxt(c.liftCi)}`,
    ];
  });
  return <ListTable head={['清單', '評分日', '命中／選股', '精確度', '同日隨機', 'Δ 對 RAND [95% CI]', 'lift [95% CI]']} right={[1, 2, 3, 4, 5, 6]} rows={rows} />;
}

interface ViewProps { data: TracksResp; onPick: (day: string) => void; pending?: string | null; err?: string }

/** 純顯示（不碰驗證／網路）：資料由容器 SurgeTracks 讀 API 後傳入。 */
export function SurgeTracksView({ data, onPick, pending = null, err = '' }: ViewProps) {
  if (!data.found || !data.index) {
    return (
      <div style={{ padding: 16, color: 'var(--text-muted)', lineHeight: 1.7 }}>
        尚無 T1 分軌前向紀錄。前向影子由 scripts/surge-lab/tracks/forward_config.json 總開關控制（預設停用）；啟用並凍結第一天後，協調器會自動發佈到這裡。
        <div style={{ marginTop: 6 }}>影子模式·未扣成本·非投資建議</div>
      </div>
    );
  }
  const ix = data.index; const d = data.day ?? null;
  const g = ix.gates;
  const crash = Object.entries(g.g60.crash || {}).filter(([, v]) => v === true).map(([k]) => k);
  return (
    <div style={{ fontSize: 'calc(13.5px * var(--fz))', lineHeight: 1.7 }}>
      <div style={{ padding: '10px 12px', borderRadius: 10, background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.25)', marginBottom: 10 }}>
        <b>🧭 T1 連板起漲（分軌）前向影子</b>（{ix.registrationId}）：每個交易日盤後凍結（封印、下一交易日 09:00 前），t＋1 收盤後對答案。
        S0／S_FB 是「觀察／研究榜·代理 lift 的時間外複製·容量受限·不可交易·待前向確認」；R0、W 只做灰底觀察。<b>沒有任何清單是可交易名單。</b>
        <div style={{ marginTop: 4, color: 'var(--text-muted)' }}>s0 {ix.s0 ?? '—'}｜凍結 {ix.nCore} 日、缺口 {ix.nGaps} 日｜發佈 {twTime(ix.generatedAt)}{ix.pipeline?.finished ? `｜管線 ${twTime(ix.pipeline.finished)}（exit ${ix.pipeline.exit ?? '—'}${ix.pipeline.errors ? `、錯誤 ${ix.pipeline.errors}` : ''}）` : ''}</div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Kpi label="已評分交易日" value={g.nScored} sub={`G60 ${Math.min(g.nScored, g.g60.target)}／${g.g60.target}｜G250 ${Math.min(g.nScored, g.g250.target)}／${g.g250.target}`} hint={g.note} />
        <Kpi label="G60（流程與崩壞）" value={g.g60.reached ? (crash.length ? '崩壞' : '未崩壞') : '未到'} color={crash.length ? RED : undefined} sub={crash.length ? crash.join('、') : '只查流程，不判去留'} />
        <Kpi label="G250（去留）" value={g.g250.reached ? Object.entries(g.g250.verdict).map(([k, v]) => `${k.split('_')[0]} ${v ?? '—'}`).join('·') : '未到'} sub="S0 為唯一主要檢定" />
      </div>
      <Section title="累計（判定窗內的已評分日）" sub="只有精確度、Δ 對同日隨機（期望值）與 lift；報酬不在後台顯示">
        <CumTable ix={ix} />
        <div style={{ marginTop: 4, fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>{ix.referenceNote}</div>
      </Section>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 14 }}>
        <span style={{ color: 'var(--text-muted)' }}>決策日</span>
        <select value={pending ?? d?.day ?? ''} onChange={e => onPick(e.target.value)}
          style={{ maxWidth: '100%', padding: '4px 8px', borderRadius: 8, background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)', ...MONO }}>
          {ix.days.map(r => (
            <option key={r.day} value={r.day} disabled={r.status === 'gap'}>
              {r.day}→{r.t ?? '—'}｜{r.status === 'gap' ? `缺口：${r.gapReason ?? ''}` : r.matured?.y === 'ok' ? `已對帳（T1 事件 ${r.nEvents ?? '—'}）` : r.matured?.y === 'label_unavailable' ? '標籤無法取得' : '待到期'}
            </option>
          ))}
        </select>
        {pending && <span style={{ color: 'var(--text-muted)' }}>載入中…</span>}
        {err && <span style={{ color: RED }}>載入失敗：{err}</span>}
      </label>
      {d ? (
        <>
          <div style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))' }}>
            {d.day} 盤後凍結 → {d.t ?? '—'}｜封印 <span style={MONO}>{d.sealShort}</span>｜凍結 {d.frozenAt ? twTime(d.frozenAt) : '—'}（期限 {d.deadline ? twTime(d.deadline) : '—'}）｜
            各軌列數 {Object.entries(d.trackCounts).filter(([k]) => !k.startsWith('NE_SUSP_fwd')).map(([k, v]) => `${k} ${v}`).join('、')}
            {d.parity && <span style={{ color: d.parity.verdict === 'fail' ? RED : d.parity.verdict === 'data_correction' ? AMBER : undefined }}>｜parity {d.parity.verdict}{d.parity.inputsChanged.length ? `（${d.parity.inputsChanged.join('、')} 修正）` : ''}</span>}
          </div>
          <Section title="當日對帳" sub="每個 T1 事件（t 起連續 ≥2 日收漲停）→ 軌道、沒通過的條件、名次、是否入選；只用官方標籤">
            <Reconcile d={d} />
          </Section>
          {d.lists.map(b => <ListSection key={b.id} b={b} />)}
          <Section title="成本參考（不當門檻）">
            <ListTable head={['項目', '數值']} rows={d.costRef.map(c => [c.item, c.value])} />
          </Section>
          <div style={{ marginTop: 10, fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>{d.fixedLabels.join('；')}</div>
        </>
      ) : <div style={{ marginTop: 8, color: 'var(--text-muted)' }}>這一天沒有凍結名單（缺口日永不補產）。</div>}
      <div style={{ marginTop: 10, color: 'var(--text-muted)' }}>影子模式·未扣成本·非投資建議</div>
    </div>
  );
}

export default function SurgeTracks() {
  const [data, setData] = useState<TracksResp | null>(null);
  const [err, setErr] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const seq = useRef(0);   // 只接受最後一次請求的回應：快速切日時較晚抵達的舊回應不可蓋掉新選擇
  const load = useCallback(async (day?: string) => {
    const my = ++seq.current;
    setErr(''); setPending(day ?? null);
    const r = await labGet<TracksResp>(day ? `view=tracksDay&day=${encodeURIComponent(day)}` : 'view=tracks');
    if (my !== seq.current) return;
    setPending(null);
    if (!r.ok) { setErr(r.error); return; }
    setData(prev => (day && prev ? { ...prev, day: r.data.day ?? null, dayId: r.data.dayId ?? null } : r.data));
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (!data) return <div style={{ padding: 16, color: err ? RED : 'var(--text-muted)' }}>{err ? <>載入失敗：{err} <button type="button" onClick={() => void load()}>重試</button></> : '載入中…'}</div>;
  return <SurgeTracksView data={data} onPick={day => void load(day)} pending={pending} err={err} />;
}
