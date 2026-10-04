'use client';

// ── 🧪 官方化重訓驗證（超級管理員；起漲影子分頁的子分頁）──────────────────────
// 同一批列、同一套滾動外樣本協定，只換特徵集：base（原特徵）vs official（官方來源特徵）。資料：surge_lab_publish.mjs → surgeShadow/lab-cv。
// 閱讀順序：①任務／版本 ②KPI（base→official 與差的 95% 區間；區間不含 0 才上色）③半年穩健度 ④可買精確度與報酬 ⑤消融 ⑥命中／漏網摘要 ⑦逐列 ⑧漏網假設摘要。
import { useState, type ReactNode } from 'react';
import type { CvDoc, CvVersion, CvModelStat, CvRobust, CvHitmiss, Ci, CvTaskId } from '../../../scripts/lib/surge-lab-report.mjs';
import { Kpi, Section, ListTable, Collapse, MONO } from './AiLabParts';
import { useLabView, twTime, LAB_FOOT } from './surgeLabFetch';
import MiniMarkdown from './MiniMarkdown';
import SurgeCvRows from './SurgeCvRows';

interface Resp { found: boolean; updatedAt?: string | null; cv?: CvDoc }

const frac = (v: number | null | undefined, d = 2) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
const num = (v: number | null | undefined, d = 3) => (v == null ? '—' : v.toFixed(d));
const p2 = (v: unknown) => (typeof v === 'number' ? `${v.toFixed(2)}%` : '—');            // robust.py 輸出已是百分比
const ciPp = (c: Ci, scale = 100) => (c ? `${(c[0] * scale).toFixed(2)}～${(c[1] * scale).toFixed(2)} pp` : '—');
/** 只有 95% 區間不含 0 才上色（正＝紅、負＝綠，台股慣例）；含 0 一律灰——不讓雜訊看起來像結論。 */
const ciColor = (c: Ci) => (!c ? undefined : c[0] > 0 ? 'var(--color-up)' : c[1] < 0 ? 'var(--color-down)' : undefined);
const tag = (text: string, color = 'var(--text-muted)') => <span style={{ fontSize: 'calc(11.5px * var(--fz))', padding: '0 6px', borderRadius: 999, border: `1px solid ${color}`, color, marginLeft: 4 }}>{text}</span>;
const Muted = ({ children }: { children: ReactNode }) => <div style={{ color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))' }}>{children}</div>;
const pill = (on: boolean): React.CSSProperties => ({ padding: '3px 12px', borderRadius: 999, border: '1px solid var(--border-primary)', cursor: 'pointer', fontWeight: 700, fontSize: 'calc(12.5px * var(--fz))', background: on ? 'rgba(125,211,252,0.18)' : 'transparent', color: on ? '#7dd3fc' : 'var(--text-muted)' });

function KpiRow({ b, o }: { b: CvModelStat; o: CvModelStat }) {
  const dp = o.vs_base?.dprec ?? null; const da = o.vs_base?.dauc ?? null;
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <Kpi label="前10 精確度（official）" value={frac(o.prec)} color={ciColor(dp)} sub={`base ${frac(b.prec)}｜差 95% ${ciPp(dp)}`} hint="每天模型分數前 10 名中，真的發生事件的比例（外樣本）。差＝official−base，20 日區塊 bootstrap 配對區間。" />
      <Kpi label="同日 AUC（official）" value={num(o.auc)} color={ciColor(da)} sub={`base ${num(b.auc)}｜差 95% ${ciPp(da)}`} />
      <Kpi label="lift（相對基準倍數）" value={num(o.lift, 2)} sub={`base ${num(b.lift, 2)}`} />
      <Kpi label="命中／選股" value={`${o.hits ?? '—'}／${o.picks ?? '—'}`} sub={`base ${b.hits ?? '—'}／${b.picks ?? '—'}｜特徵 ${b.nfeat ?? '—'}→${o.nfeat ?? '—'}｜種子 ${o.seeds ?? '—'}`} />
    </div>
  );
}

function HalfYear({ r }: { r: CvRobust }) {
  const rows = Object.entries(r.by_half || {}).sort(([a], [b]) => (a < b ? -1 : 1));
  return (
    <ListTable head={['半年', '測試日', 'base', 'official', '差', '差 95%（區塊 bootstrap）']} right={[1, 2, 3, 4, 5]}
      rows={rows.map(([k, h]) => {
        const c: Ci = Array.isArray(h.diff_ci) ? [h.diff_ci[0] / 100, h.diff_ci[1] / 100] : null;
        const col = ciColor(c);
        return [k, h.days, p2(h.base), p2(h.official), <span key="d" style={{ color: col }}>{(h.official - h.base).toFixed(2)} pp</span>, <span key="c" style={{ color: col }}>{ciPp(c)}</span>];
      })} />
  );
}

const val = (o: unknown, k: string): number | null => (o && typeof o === 'object' && typeof (o as Record<string, unknown>)[k] === 'number' ? (o as Record<string, number>)[k] : null);
const T_ROWS: Array<[string, string, boolean]> = [   // [標籤, 欄位, 有全母體基準]
  ['前10 精確度', 'prec', false], ['開盤即鎖占比（買不到）', 'locked_open_share', false], ['可買進精確度（排除開盤即鎖）', 'buyable_prec', false],
  ['t 開盤買→1 日收 均值', 'o_c1_mean', true], ['t 開盤買→5 日收 均值', 'o_c5_mean', true], ['t 開盤買→10 日收 均值', 'o_c10_mean', true],
  ['→5 日收 中位數', 'o_c5_median', false], ['→10 日收 中位數', 'o_c10_median', false], ['→5 日收 勝率', 'o_c5_win', false], ['→10 日收 勝率', 'o_c10_win', false],
];
const LU_ROWS: Array<[string, string]> = [
  ['前10 精確度', 'prec'], ['可買漲停精確度（隔日漲停且開盤買得到）', 'buyable_lu_prec'], ['延續股占比（打分日已漲停）', 'share_cont'],
  ['新起漲精確度', 'prec_fresh'], ['延續股精確度', 'prec_cont'], ['開盤即鎖占比', 'locked_open_share'], ['可買者 t 開→收 均值', 'oc1_mean_buyable'], ['s 收→t 收 均值', 'cc1_mean'],
];

function Buyable({ task, r }: { task: CvTaskId; r: CvRobust }) {
  if (task === 'lu1L') {
    const fb = r.base?.fresh_only_top10; const fo = r.official?.fresh_only_top10;
    return (
      <>
        <ListTable head={['指標（選股＝每日前 10）', 'base', 'official']} right={[1, 2]} rows={LU_ROWS.map(([l, k]) => [l, p2(val(r.base, k)), p2(val(r.official, k))])} />
        <div style={{ marginTop: 6 }}>
          <ListTable head={['只在新起漲（打分日未漲停）裡選前 10', 'base', 'official']} right={[1, 2]}
            rows={[['精確度', p2(val(fb, 'prec')), p2(val(fo, 'prec'))], ['可買漲停', p2(val(fb, 'buyable')), p2(val(fo, 'buyable'))], ['新起漲基準率', p2(val(fb, 'base_rate')), p2(val(fo, 'base_rate'))]]} />
        </div>
        <Muted>LU1 的命中大多來自前一天已漲停的延續股；新起漲另列，避免把延續當成選股能力。</Muted>
      </>
    );
  }
  return (
    <>
      <ListTable head={['指標（選股＝每日前 10）', 'base', 'official', '全母體（可買進）']} right={[1, 2, 3]}
        rows={T_ROWS.map(([l, k, u]) => [l, p2(val(r.base, k)), p2(val(r.official, k)), u ? p2(val(r.universe, k)) : '—'])} />
      <Muted>報酬＝t 日（打分隔日）開盤買進到第 k 日收盤，只算開盤買得到的列；全母體＝同期母體內全部可買進列的均值（基準）。</Muted>
    </>
  );
}

function Ablation({ v }: { v: CvVersion }) {
  const rows = v.ablation || [];
  return (
    <>
      <ListTable head={['組', '前10 精確度', '差 vs base 95%', 'AUC', 'ΔAUC 95%', 'lift', '命中／選股', '特徵數', '種子']} right={[1, 2, 3, 4, 5, 6, 7, 8]} maxHeight={360}
        rows={rows.map(a => [
          <span key="k" style={{ opacity: a.referenceOnly ? 0.75 : 1 }}>{a.key}{a.referenceOnly && tag('參考')}</span>,
          frac(a.prec), <span key="p" style={{ color: ciColor(a.vs_base?.dprec ?? null) }}>{ciPp(a.vs_base?.dprec ?? null)}</span>,
          num(a.auc), <span key="a" style={{ color: ciColor(a.vs_base?.dauc ?? null) }}>{ciPp(a.vs_base?.dauc ?? null)}</span>,
          num(a.lift, 2), `${a.hits ?? '—'}／${a.picks ?? '—'}`, a.nfeat ?? '—', a.seeds ?? '—'])} />
      <Muted>+組＝base 加上單一官方特徵組；−組＝official 拿掉單一組；official+grp＝再加 wiki 集團共振（2026-10 靜態快照，回測有前視）。種子＝1 的列只跑一次，雜訊大，標「參考」，不可單獨下結論。</Muted>
    </>
  );
}

function Hitmiss({ hm }: { hm: CvHitmiss | null | undefined }) {
  const [all, setAll] = useState(false);
  if (!hm) return <Muted>沒有命中／漏網摘要。</Muted>;
  const feats = Object.entries(hm.feature_pct_mean).filter(([, p]) => p).sort(([, a], [, b]) => Math.abs(b![0] - b![1]) - Math.abs(a![0] - a![1]));
  const shown = all ? feats : feats.slice(0, 12);
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', ...MONO, fontSize: 'calc(12.5px * var(--fz))' }}>
        <span>前 {hm.K ?? '—'} 名命中 <b>{hm.n_hit ?? '—'}</b>｜漏網 <b>{hm.n_miss ?? '—'}</b></span>
        <span>漏網名次：{Object.entries(hm.miss_rank_bins).map(([k, n]) => `${k.replace(/^\((\d+), 1000000\]$/, '>$1')} ${n ?? '—'}`).join('｜')}</span>
        <span>市場［命中, 漏網］：{Object.entries(hm.by_market).map(([k, p]) => `${k === 'tse' ? '上市' : k === 'otc' ? '上櫃' : k} ${p ? `${p[0]}, ${p[1]}` : '—'}`).join('｜')}</span>
      </div>
      <ListTable head={['來源當天有值率', '命中', '漏網']} right={[1, 2]} maxHeight={260}
        rows={Object.entries(hm.source_has_value_rate).map(([k, p]) => [k, p ? frac(p[0], 1) : '—', p ? frac(p[1], 1) : '—'])} />
      <ListTable head={['特徵（同日百分位均值）', '命中', '漏網', '差']} right={[1, 2, 3]} maxHeight={300}
        rows={shown.map(([k, p]) => [k, p![0].toFixed(3), p![1].toFixed(3), (p![0] - p![1]).toFixed(3)])} />
      {feats.length > 12 && <button type="button" onClick={() => setAll(x => !x)} style={{ justifySelf: 'start', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#7dd3fc', fontSize: 'calc(12.5px * var(--fz))' }}>{all ? '▾ 只看差最大的 12 個' : `▸ 顯示全部 ${feats.length} 個特徵`}</button>}
      {hm.legend && <Muted>{hm.legend}</Muted>}
    </div>
  );
}

function VersionView({ task, v }: { task: CvTaskId; v: CvVersion }) {
  const [hmModel, setHmModel] = useState<'base' | 'official'>('official');
  if (v.sameAs) return <div style={{ padding: 10, color: '#f59e0b' }}>⏳ {v.note || '這個版本與修正前相同'}</div>;
  if (!v.base || !v.official) return <Muted>這個版本沒有 base／official 結果。</Muted>;
  const m = v.meta;
  return (
    <div>
      <Muted>
        {v.versionLabel}｜測試 {m?.days ?? '—'} 日、{m?.test_rows?.toLocaleString() ?? '—'} 列、正例 {m?.positives?.toLocaleString() ?? '—'}（基準率 {frac(m?.base_rate ?? null, 3)}）｜{m?.protocol ?? '—'}
      </Muted>
      {(v.warnings?.length ?? 0) > 0 && <div style={{ color: '#f59e0b', fontSize: 'calc(12.5px * var(--fz))' }}>⚠ {v.warnings!.join('；')}</div>}
      <div style={{ marginTop: 8 }}><KpiRow b={v.base} o={v.official} /></div>

      <Section title="半年穩健度" sub="同一批日子配對比較；區間不含 0 才上色">
        {v.robust ? <HalfYear r={v.robust} /> : <div style={{ color: '#f59e0b', fontSize: 'calc(12.5px * var(--fz))' }}>⚠ {v.robustNote}</div>}
      </Section>
      <Section title={task === 'lu1L' ? '可買精確度｜新起漲 vs 延續' : '可買精確度與選股報酬（vs 全母體）'} sub="選股＝每日前 10；未扣成本">
        {v.robust ? <Buyable task={task} r={v.robust} /> : <Muted>（穩健度未採用，不顯示）</Muted>}
      </Section>
      <Collapse id={`surge-cv-abl-${task}`} title="🧩 消融（每組官方特徵的貢獻）" count={`${v.ablation?.length ?? 0} 組`} defaultOpen={false}>
        <Ablation v={v} />
      </Collapse>
      <Collapse id={`surge-cv-hm-${task}`} title="🎯 命中／漏網摘要" sub="同日百分位與來源有值率：命中 vs 漏網">
        <div role="tablist" style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          {(['official', 'base'] as const).map(k => <button key={k} type="button" role="tab" aria-selected={hmModel === k} onClick={() => setHmModel(k)} style={pill(hmModel === k)}>{k}</button>)}
        </div>
        <Hitmiss hm={v.hitmiss?.[hmModel]} />
      </Collapse>
      <Collapse id={`surge-cv-rows-${task}`} title="📋 逐列瀏覽（命中／漏網／母體外）" sub="伺服器端篩選，每頁 200 列" defaultOpen={false}>
        <SurgeCvRows key={`${task}-${v.id}`} task={task} v={v} />
      </Collapse>
      <Collapse id={`surge-cv-md-${task}`} title="📝 漏網原因假設摘要" sub={v.analysis ? `${v.analysis.file}${v.analysis.truncated ? '（已截斷）' : ''}` : '本版沒有對應的分析文件'} defaultOpen={false}>
        {v.analysis ? <MiniMarkdown md={v.analysis.markdown} /> : <Muted>分析文件只屬於產生它的那一版模型；修正後重訓若未重跑分析，這裡不顯示（避免把修正前的結論套到修正後）。</Muted>}
      </Collapse>
    </div>
  );
}

export default function SurgeCvOfficial() {
  const { data, err, loading, reload } = useLabView<Resp>('cv');
  const [task, setTask] = useState<CvTaskId>('t1L');
  const [ver, setVer] = useState<string | null>(null);
  if (!data) return <div style={{ padding: 16, color: err ? '#ef4444' : 'var(--text-muted)' }}>{err ? <>載入失敗：{err} <button type="button" onClick={() => void reload()}>重試</button></> : '載入中…'}</div>;
  if (!data.found || !data.cv) return <div style={{ padding: 16, color: 'var(--text-muted)' }}>尚未發佈官方化重訓驗證——在 Mac 上執行 node scripts/surge-lab/surge_lab_publish.mjs --only cv,cvrows。</div>;
  const cv = data.cv;
  const t = cv.tasks.find(x => x.id === task) ?? cv.tasks[0];
  const real = (t?.versions || []).filter(v => !v.sameAs);
  const v = t?.versions.find(x => x.id === ver) ?? real.at(-1) ?? t?.versions[0];
  return (
    <div style={{ fontSize: 'calc(13.5px * var(--fz))', lineHeight: 1.7 }}>
      <div style={{ padding: '10px 12px', borderRadius: 10, background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.25)', marginBottom: 10 }}>
        <b>🧪 官方化重訓驗證</b>：同一批列、同一套滾動外樣本協定，只換特徵集（base＝原特徵；official＝官方來源特徵）。資料日 <b>{cv.dataDate}</b>｜發佈 {twTime(cv.generatedAt)}{data.updatedAt ? `｜寫入 ${twTime(data.updatedAt)}` : ''}
        {loading && <span style={{ color: 'var(--text-muted)' }}>　更新中…</span>}{err && <span style={{ color: '#ef4444' }}>　重新載入失敗：{err}</span>}
        <div style={{ color: 'var(--text-muted)' }}>{LAB_FOOT}研究模型的外樣本回測，不是站上預測、不構成推薦。</div>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <div role="tablist" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {cv.tasks.map(x => <button key={x.id} type="button" role="tab" aria-selected={t?.id === x.id} onClick={() => { setTask(x.id); setVer(null); }} style={pill(t?.id === x.id)}>{x.label}</button>)}
        </div>
        {t && t.versions.length > 1 && (
          <div role="tablist" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {t.versions.map(x => <button key={x.id} type="button" role="tab" aria-selected={v?.id === x.id} onClick={() => setVer(x.id)} style={pill(v?.id === x.id)}>{x.label}{x.sameAs ? '（未產出）' : ''}</button>)}
          </div>
        )}
      </div>
      {!t || !v ? <Muted>{t?.note || '這個任務沒有資料'}</Muted> : <VersionView key={`${t.id}-${v.id}`} task={t.id} v={v} />}
    </div>
  );
}
