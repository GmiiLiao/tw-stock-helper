'use client';

// ── 🧠 軋空判讀模型（超級管理員）────────────────────────────────────
// 呈現三件事，缺一不可：
//   ① 主判讀模型與軋空機率模型的**樣本外**成績（不是訓練段的漂亮數字）
//   ② 分支模型（各族群）狀態——哪一族還有效、哪一族失效了
//   ③ 訓練資料集累積與歷史報表，可回查每一次訓練的變因實驗
import { useEffect, useState } from 'react';
import { auth } from '@/lib/firebase';

interface Stat { n?: number; mean?: number | null; win?: number | null; buyRate?: number | null; nBuyable?: number; meanBuyable?: number | null; winBuyable?: number | null; limitUpRate?: number; squeezeRate?: number }
// v2（2026-09-17 規則重規畫）：日層級超額 excess、95% CI、交易日數 days、三態 state；v1 文件沒有這些欄位，畫面兩者都要能讀
interface StatV2 extends Stat { excess?: number | null; ci?: [number | null, number | null] | null; days?: number; state?: 'valid' | 'ns' | 'invalid'; stateLabel?: string; segs?: (number | null)[] | null }
interface Branch { group: string; rank?: number; name?: string; pass?: boolean; why?: string; state?: string; stateLabel?: string; train?: { mean?: number; win?: number; n: number; segs?: (number | null)[] | null; excess?: number | null; ci?: [number | null, number | null] | null; days?: number }; oot?: StatV2 | null }
interface ModeModel {
  tradeMode?: string; tradeLabel?: string; label: string; samples: number; trainN: number; ootN: number; trainDays?: number; ootDays?: number; excludedEntry?: number;
  baseline: { train: { all: Stat; momentum: Stat }; oot: { all: Stat; momentum: Stat } };
  main: { name: string; parts: string[]; train: { mean?: number; win?: number; n: number; segs?: (number | null)[] | null; excess?: number | null; ci?: [number | null, number | null] | null; days?: number }; oot: StatV2; edgeVsMomentum: number; ci?: [number | null, number | null] | null } | null;
  squeezeProb?: Model['squeezeProb']; branches: Branch[]; singleTop?: Model['singleTop'];
  passedCount?: number; comboCount?: number; survivorCount?: number; status: string; note?: string | null;
}
interface Model {
  runId: string; updatedAt: number; status: string; note?: string | null;
  rules?: string; datasetHash?: string; tradeMode?: string; modes?: Record<string, ModeModel>;
  period: { from: string; to: string; days: number; oosFrom: string };
  samples: number; trainN: number; ootN: number; label: string; trainDays?: number; ootDays?: number; excludedEntry?: number;
  baseline: { train: { all: Stat; momentum: Stat }; oot: { all: Stat; momentum: Stat } };
  main: { name: string; parts: string[]; train: { mean?: number; win?: number; n: number; segs?: (number | null)[] | null; excess?: number | null; ci?: [number | null, number | null] | null; days?: number }; oot: StatV2; edgeVsMomentum: number; ci?: [number | null, number | null] | null } | null;
  squeezeProb?: { name?: string; parts?: string[]; train?: { n: number; rate: number }; oot?: { n: number; rate: number }; baseline?: { oot?: { rate: number | null } }; lift?: number; status?: string; note?: string };
  branches: Branch[];
  singleTop?: Array<{ name: string; group: string; n: number; mean?: number; win?: number; segs?: (number | null)[]; pass: boolean; why: string }>;
  passedCount?: number; comboCount?: number; survivorCount?: number;
  placebo?: { maxOfRandom: number; meanOfRandom: number; trials: number } | null;
}
interface ReviewDay { date: string; targetDate: string; picked: number; hit: number; precision: number | null; avgRet: number | null; buyRate: number | null; successTotal: number; successAll?: number; caught: number; recall: number | null; recallAll?: number | null; missed: number; why: Record<string, number>; missTop: Array<{ code: string; chg: number; ratio: number; shrtChg: number; ret: number; reasons: string[] }>; newsLift?: { bull: { n: number; avg?: number; win?: number }; neutral: { n: number; avg?: number; win?: number }; none: { n: number; avg?: number }; bear: { n: number; avg?: number } } | null }
interface ReviewSum { days: number; from: string; to: string; totalPicked: number; totalHit: number; precision: number | null; avgRet: number | null; totalSuccess: number; totalSuccessAll?: number; totalCaught: number; recall: number | null; recallAll?: number | null; totalMissed: number; whyAgg: Record<string, number>; daysWithNews?: number; newsLiftAgg?: Record<string, { n: number; avg?: number }>; note?: string }
interface Data {
  found: boolean; model: Model | null;
  review?: { summary: ReviewSum | null; daily: ReviewDay[] };
  reports: Array<{ runId: string; updatedAt: number; status: string; period?: { from: string; to: string }; mainName?: string | null; mainOot?: Stat | null; edge?: number | null; sqName?: string | null; sqLift?: number | null; survivorCount?: number | null }>;
  dataset: { days: number; totalRows: number; totalLimitUp: number; recent: Array<{ date: string; n: number; nLimitUp: number; nControl: number }> };
  globalHistory: { days: number | null; updatedAt: number | null; syms: Array<{ sym: string; key: string }> } | null;
}

const fmtT = (ms?: number | null) => (ms ? new Date(ms).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '—');
const pn = (v?: number | null, d = 2) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`);
const pp = (v?: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}pp`);
const ciTxt = (ci?: [number | null, number | null] | null) => (ci && ci[0] != null ? `[${ci[0]}, ${ci[1]}]` : '—');
const stateColor = (s?: string) => (s === 'valid' ? '#22c55e' : s === 'invalid' ? '#ef4444' : '#f59e0b');
const MODE_TABS: Array<[string, string]> = [['nextday', '隔日沖'], ['daytrade', '當沖'], ['swing', '波段持有']];

export default function SqueezeModel() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState('nextday');   // v2 三套交易模式切換（使用者 2026-09-17 決定）

  useEffect(() => {
    // ⚠ /api/admin/* 走 requireAdmin，必須帶 Firebase ID token
    //   （2026-08-27：漏了這一步，畫面直接顯示「Missing bearer token」）。
    //   作法與 SwingLab 一致，不要各自發明第二種寫法。
    (async () => {
      try {
        const token = (await auth.currentUser?.getIdToken()) ?? '';
        const r = await fetch('/api/admin/squeeze-model', {
          cache: 'no-store',
          headers: { Authorization: `Bearer ${token}` },
        });
        const j = await r.json();
        if (!r.ok) setErr(j.error || `HTTP ${r.status}`);
        else setD(j);
      } catch (e) {
        setErr(String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div style={{ color: 'var(--text-muted)' }}>載入模型狀態…</div>;
  if (err) return <div style={{ color: '#ef4444' }}>讀取失敗：{err}</div>;
  if (!d?.found || !d.model) {
    return (
      <div style={{ color: 'var(--text-muted)', lineHeight: 1.8 }}>
        尚未產生模型。訓練排程為<b>每週二、五 01:00 後</b>自動執行；
        亦可手動：<code>node scripts/squeeze-train.mjs 250</code>
        {d?.dataset && <div>目前訓練資料集：{d.dataset.days} 日 / {d.dataset.totalRows.toLocaleString()} 筆</div>}
      </div>
    );
  }
  const root = d.model;
  const v2 = root.rules === 'v2' && !!root.modes;
  // v2：畫面讀所選模式那份；v1：只有一份（頂層）
  const m: ModeModel & { runId: string; updatedAt: number; period: Model['period']; placebo?: Model['placebo'] } = v2 && root.modes![mode]
    ? { ...root.modes![mode], runId: root.runId, updatedAt: root.updatedAt, period: root.period, placebo: root.placebo }
    : root;
  const box: React.CSSProperties = { padding: '10px 14px', borderRadius: 10, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', marginBottom: 12 };
  const th: React.CSSProperties = { padding: '4px 6px', textAlign: 'right', color: 'var(--text-muted)', fontWeight: 600 };
  const td: React.CSSProperties = { padding: '4px 6px', textAlign: 'right' };

  return (
    <div style={{ fontSize: 'calc(13.5px * var(--fz))', lineHeight: 1.6 }}>
      {/* 總覽 */}
      <div style={box}>
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <b style={{ fontSize: 'calc(14px * var(--fz))' }}>🧠 軋空判讀模型</b>
          <span style={{ color: 'var(--text-muted)' }}>
            run <code>{m.runId}</code> · {fmtT(m.updatedAt)} · 排程：每交易日後 02:00
          </span>
        </div>
        {v2 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            {MODE_TABS.filter(([k]) => root.modes![k]).map(([k, lab]) => (
              <button key={k} onClick={() => setMode(k)} style={{ padding: '3px 12px', borderRadius: 8, border: '1px solid var(--border-primary)', cursor: 'pointer', fontWeight: 700, background: mode === k ? 'var(--accent-purple,#6366f1)' : 'var(--bg-tertiary)', color: mode === k ? '#fff' : 'var(--text-secondary)' }}>
                {lab}{root.modes![k].main ? ' ✓' : ''}
              </button>
            ))}
            <span style={{ color: 'var(--text-muted)', alignSelf: 'center' }}>規則 v2 · 資料集 {root.datasetHash} · {m.tradeLabel}</span>
          </div>
        )}
        <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>
          期間 {m.period.from} ~ {m.period.to}（{m.period.days} 日）·
          樣本 {m.samples.toLocaleString()} 筆（訓練 {m.trainN.toLocaleString()} / <b>樣本外 {m.ootN.toLocaleString()}</b>，
          自 <b>{m.period.oosFrom}</b> 起完全未參與選模{v2 ? '·切點固定' : ''}）· 標的：{m.label}
          {v2 && m.excludedEntry != null && <>　· 進場不可買剔除 {m.excludedEntry.toLocaleString()} 筆 · 訓練 {m.trainDays} 日／樣本外 {m.ootDays} 日</>}
        </div>
        {m.note && <div style={{ color: '#f59e0b', marginTop: 4 }}>⚠ {m.note}</div>}
      </div>

      {/* 主判讀模型 */}
      <div style={{ ...box, borderColor: m.main ? 'rgba(34,197,94,0.45)' : 'rgba(239,68,68,0.45)' }}>
        <b>① 主判讀模型（{v2 ? `${m.tradeLabel}·日層級超額對純動能·95% CI 下界＞0 才算` : '最大化「可買」隔日開盤報酬'}）</b>
        {!m.main ? <div style={{ color: '#ef4444', marginTop: 4 }}>本輪無組合通過樣本外驗收。</div> : v2 ? (
          <>
            <div style={{ fontSize: 'calc(14px * var(--fz))', fontWeight: 800, color: '#22c55e', margin: '4px 0' }}>{m.main.name}</div>
            <table style={{ borderCollapse: 'collapse', width: '100%', maxWidth: 720 }}>
              <thead><tr><th style={{ ...th, textAlign: 'left' }}>口徑</th><th style={th}>日層級超額</th><th style={th}>95% CI</th><th style={th}>逐筆平均</th><th style={th}>勝率</th><th style={th}>樣本</th><th style={th}>交易日</th></tr></thead>
              <tbody>
                <tr><td style={{ ...td, textAlign: 'left' }}>訓練段</td><td style={td}>{pp(m.main.train.excess)}</td><td style={td}>{ciTxt(m.main.train.ci)}</td><td style={td}>{pn(m.main.train.mean)}</td><td style={td}>{m.main.train.win ?? '—'}%</td><td style={td}>{m.main.train.n}</td><td style={td}>{m.main.train.days ?? '—'}</td></tr>
                <tr style={{ fontWeight: 700 }}><td style={{ ...td, textAlign: 'left' }}>樣本外</td><td style={{ ...td, color: stateColor(m.main.oot.state) }}>{pp(m.main.oot.excess)}</td><td style={td}>{ciTxt(m.main.oot.ci)}</td><td style={td}>{pn(m.main.oot.mean)}</td><td style={td}>{m.main.oot.win ?? '—'}%</td><td style={td}>{m.main.oot.n}</td><td style={td}>{m.main.oot.days ?? '—'}</td></tr>
                <tr><td style={{ ...td, textAlign: 'left', color: 'var(--text-muted)' }}>純動能基準（樣本外）</td><td style={td}>0</td><td style={td}>—</td><td style={{ ...td, color: 'var(--text-muted)' }}>{pn(m.baseline.oot.momentum.mean)}</td><td style={{ ...td, color: 'var(--text-muted)' }}>{m.baseline.oot.momentum.win}%</td><td style={{ ...td, color: 'var(--text-muted)' }}>{m.baseline.oot.momentum.n}</td><td style={td}>—</td></tr>
              </tbody>
            </table>
            <div style={{ marginTop: 4, color: 'var(--text-muted)' }}>超額＝每日「因子組平均 − 純動能母體平均」再對日序列取平均；CI 為按日區塊自助法（block 5、1,000 次）。進場可買已先剔除。</div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 'calc(14px * var(--fz))', fontWeight: 800, color: '#22c55e', margin: '4px 0' }}>{m.main.name}</div>
            <table style={{ borderCollapse: 'collapse', width: '100%', maxWidth: 620 }}>
              <thead><tr><th style={{ ...th, textAlign: 'left' }}>口徑</th><th style={th}>平均報酬</th><th style={th}>勝率</th><th style={th}>樣本</th></tr></thead>
              <tbody>
                <tr><td style={{ ...td, textAlign: 'left' }}>訓練段</td><td style={td}>{pn(m.main.train.mean)}</td><td style={td}>{m.main.train.win}%</td><td style={td}>{m.main.train.n}</td></tr>
                <tr><td style={{ ...td, textAlign: 'left' }}>樣本外（全部）</td><td style={td}>{pn(m.main.oot.mean)}</td><td style={td}>{m.main.oot.win}%</td><td style={td}>{m.main.oot.n}</td></tr>
                <tr style={{ fontWeight: 700 }}>
                  <td style={{ ...td, textAlign: 'left' }}>樣本外（<span style={{ color: '#22c55e' }}>可買</span>）</td>
                  <td style={td}>{pn(m.main.oot.meanBuyable)}</td><td style={td}>{m.main.oot.winBuyable}%</td><td style={td}>{m.main.oot.nBuyable}</td>
                </tr>
                <tr><td style={{ ...td, textAlign: 'left', color: 'var(--text-muted)' }}>純動能基準（可買）</td>
                  <td style={{ ...td, color: 'var(--text-muted)' }}>{pn(m.baseline.oot.momentum.meanBuyable)}</td>
                  <td style={{ ...td, color: 'var(--text-muted)' }}>{m.baseline.oot.momentum.winBuyable}%</td>
                  <td style={{ ...td, color: 'var(--text-muted)' }}>{m.baseline.oot.momentum.nBuyable}</td></tr>
              </tbody>
            </table>
            <div style={{ marginTop: 4 }}>
              樣本外淨勝純動能 <b style={{ color: m.main.edgeVsMomentum >= 0 ? '#22c55e' : '#ef4444' }}>{m.main.edgeVsMomentum >= 0 ? '+' : ''}{m.main.edgeVsMomentum}pp</b>
              　可買比例 <b>{m.main.oot.buyRate}%</b>
              <span style={{ color: 'var(--text-muted)' }}>（其餘為隔日開盤即漲停鎖死、買不到，已排除不計）</span>
            </div>
          </>
        )}
      </div>

      {/* 軋空機率模型 */}
      <div style={box}>
        <b>② 軋空機率模型（最大化 P(隔日軋空)＝漲≥5% 且融券真的減少）</b>
        {m.squeezeProb?.name ? (
          <>
            <div style={{ fontSize: 'calc(14px * var(--fz))', fontWeight: 800, color: '#f59e0b', margin: '4px 0' }}>{m.squeezeProb.name}</div>
            <div>
              訓練段軋空率 <b>{m.squeezeProb.train?.rate}%</b>（n={m.squeezeProb.train?.n}）→
              樣本外 <b style={{ color: '#22c55e' }}>{m.squeezeProb.oot?.rate}%</b>（n={m.squeezeProb.oot?.n}）
              　純動能基準 {m.squeezeProb.baseline?.oot?.rate}%
              　提升 <b>{m.squeezeProb.lift! >= 0 ? '+' : ''}{m.squeezeProb.lift}pp</b>
              （約 {((m.squeezeProb.oot?.rate ?? 0) / (m.squeezeProb.baseline?.oot?.rate || 1)).toFixed(2)}x）
            </div>
            {(m.squeezeProb.oot?.n ?? 0) < 120 && (
              <div style={{ color: '#f59e0b' }}>⚠ 樣本外僅 {m.squeezeProb.oot?.n} 筆，估計區間很寬，不宜當成穩定機率。</div>
            )}
          </>
        ) : <div style={{ color: '#ef4444', marginTop: 4 }}>無軋空專用組合通過樣本外驗收（誠實結果）。</div>}
      </div>

      {/* 分支模型 */}
      <div style={box}>
        <b>③ 分支模型狀態（{v2 ? '各族群前兩名·三態：有效／無顯著差異／失效' : '各族群最佳單因子'}）</b>
        <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: 4 }}>
          <thead><tr>
            <th style={{ ...th, textAlign: 'left' }}>族群</th><th style={{ ...th, textAlign: 'left' }}>因子</th>
            <th style={th}>訓練段{v2 ? '超額' : ''}</th><th style={th}>樣本外{v2 ? '超額' : ''}</th>{v2 && <th style={th}>95% CI</th>}<th style={th}>樣本外n{v2 ? '／日' : ''}</th><th style={{ ...th, textAlign: 'center' }}>狀態</th>
          </tr></thead>
          <tbody>
            {m.branches.map((b, i) => (
              <tr key={`${b.group}-${b.rank ?? i}`} style={{ borderTop: '1px solid var(--border-primary)' }} title={b.why}>
                <td style={{ ...td, textAlign: 'left', fontWeight: 700 }}>{b.group}{v2 && b.rank ? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> #{b.rank}</span> : null}</td>
                <td style={{ ...td, textAlign: 'left' }}>{b.name ?? '—'}</td>
                <td style={td}>{v2 ? pp(b.train?.excess) : (b.train ? pn(b.train.mean) : '—')}</td>
                <td style={td}>{v2 ? pp(b.oot?.excess) : (b.oot ? pn(b.oot.mean) : '—')}</td>
                {v2 && <td style={td}>{ciTxt(b.oot?.ci)}</td>}
                <td style={td}>{b.oot?.n ?? '—'}{v2 && b.oot?.days != null ? `／${b.oot.days}` : ''}</td>
                <td style={{ ...td, textAlign: 'center', color: v2 ? (b.oot ? stateColor(b.state) : 'var(--text-muted)') : (b.pass ? '#22c55e' : '#ef4444'), fontWeight: 700 }}>
                  {v2 ? (b.stateLabel ?? '—') : (b.pass ? '有效' : (b.why ?? '失效'))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {v2 && <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>「訓練段未通過」＝該因子在訓練段未同時滿足 CI 下界＞0、三段皆贏基準、交易日 ≥40；滑鼠移到列上可看原因與本群最佳者差多少。</div>}
      </div>

      {/* 訓練資料集 */}
      <div style={box}>
        <b>④ 訓練資料集（第二大腦）</b>
        <div style={{ color: 'var(--text-muted)' }}>
          逐日漲停股「當日 × 前一日」狀態 + 國際盤：<b>{d.dataset.days}</b> 日 ·
          {d.dataset.totalRows.toLocaleString()} 筆（其中漲停 {d.dataset.totalLimitUp.toLocaleString()}）
          {d.globalHistory && <> · 國際盤歷史 {d.globalHistory.days} 日（{d.globalHistory.syms.length} 項：{d.globalHistory.syms.map(s => s.key).join('/')}）</>}
        </div>
        {d.dataset.recent.length > 0 && (
          <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {d.dataset.recent.slice(0, 14).map(r => (
              <span key={r.date} style={{ padding: '2px 8px', borderRadius: 8, background: 'var(--bg-tertiary)', fontSize: 'calc(13.5px * var(--fz))' }}>
                {r.date.slice(5)} 漲停{r.nLimitUp}/對照{r.nControl}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 單因子明細 */}
      {m.singleTop && m.singleTop.length > 0 && (
        <div style={box}>
          <b>⑤ 單因子檢定（訓練段·前 16 名）</b>
          <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>
            通過條件：{v2 ? 'n≥80、交易日≥40、訓練段內三段皆贏純動能、日層級超額 95% CI 下界＞0。' : 'n≥80 且三段皆同向 且贏純動能基準（均值與勝率都要贏）。'}
            通過 {m.passedCount} 個 → 組合 {m.comboCount} 組 → 樣本外存活 {m.survivorCount} 組。
            {m.placebo && <>　安慰劑（隨機分組最佳值）{pn(m.placebo.maxOfRandom)}／平均 {pn(m.placebo.meanOfRandom)}，可作為過擬合幅度的量尺。</>}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 560 }}>
              <thead><tr>
                <th style={{ ...th, textAlign: 'left' }}>因子</th><th style={{ ...th, textAlign: 'left' }}>族</th>
                <th style={th}>n</th><th style={th}>平均</th><th style={th}>勝率</th><th style={{ ...th, textAlign: 'left' }}>三段</th><th style={{ ...th, textAlign: 'center' }}>判定</th>
              </tr></thead>
              <tbody>
                {m.singleTop.map(s => (
                  <tr key={s.name} style={{ borderTop: '1px solid var(--border-primary)' }}>
                    <td style={{ ...td, textAlign: 'left' }}>{s.name}</td>
                    <td style={{ ...td, textAlign: 'left', color: 'var(--text-muted)' }}>{s.group}</td>
                    <td style={td}>{s.n}</td>
                    <td style={td}>{s.mean != null ? pn(s.mean) : '—'}</td>
                    <td style={td}>{s.win != null ? `${s.win}%` : '—'}</td>
                    <td style={{ ...td, textAlign: 'left', color: 'var(--text-muted)', fontSize: 'calc(13.5px * var(--fz))' }}>
                      {s.segs ? s.segs.map(v => (v == null ? '—' : v.toFixed(2))).join(' / ') : '—'}
                    </td>
                    <td style={{ ...td, textAlign: 'center', color: s.pass ? '#22c55e' : '#94a3b8' }}>{s.pass ? '通過' : s.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 每日檢討：命中率 / 召回率 / 漏網診斷 */}
      {d.review?.summary && (() => {
        const rv = d.review.summary!;
        const WHY: Record<string, string> = { chg: '當日漲幅<5%', shrtChg: '融券日增≤0', ratio: '券資比<5%', vol: '20日均量<500張' };
        return (
          <div style={{ ...box, borderColor: 'rgba(245,158,11,0.4)' }}>
            <b>⑦ 每日檢討報表（推薦對答案 × 漏網診斷）</b>
            <div style={{ color: 'var(--text-muted)', marginBottom: 5 }}>
              {rv.from} ~ {rv.to}（{rv.days} 個交易日）
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(min(190px,100%),1fr))', gap: 8, marginBottom: 6 }}>
              <div style={{ padding: '8px 10px', borderRadius: 8, background: 'var(--bg-tertiary)' }}>
                <div style={{ color: 'var(--text-muted)', fontSize: 'calc(13.5px * var(--fz))' }}>命中率（推薦的隔日開盤上漲）</div>
                <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 800, color: '#22c55e' }}>{rv.precision}%</div>
                <div style={{ color: 'var(--text-muted)', fontSize: 'calc(13.5px * var(--fz))' }}>{rv.totalHit}/{rv.totalPicked} 檔次 · 平均 {pn(rv.avgRet)}</div>
              </div>
              <div style={{ padding: '8px 10px', borderRadius: 8, background: 'var(--bg-tertiary)' }}>
                <div style={{ color: 'var(--text-muted)', fontSize: 'calc(13.5px * var(--fz))' }}>召回率（軋空型機會抓到幾成）</div>
                <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 800, color: (rv.recall ?? 0) >= 90 ? '#22c55e' : '#f59e0b' }}>{rv.recall}%</div>
                <div style={{ color: 'var(--text-muted)', fontSize: 'calc(13.5px * var(--fz))' }}>{rv.totalCaught}/{rv.totalSuccess} · 漏網 {rv.totalMissed}</div>
              </div>
              <div style={{ padding: '8px 10px', borderRadius: 8, background: 'var(--bg-tertiary)' }}>
                <div style={{ color: 'var(--text-muted)', fontSize: 'calc(13.5px * var(--fz))' }}>全部跳空機會涵蓋率</div>
                <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 800, color: 'var(--text-muted)' }}>{rv.recallAll ?? '—'}%</div>
                <div style={{ color: 'var(--text-muted)', fontSize: 'calc(13.5px * var(--fz))' }}>母體含非軋空成因，本來就低</div>
              </div>
            </div>
            <div style={{ marginBottom: 6 }}>
              <b style={{ fontSize: 'calc(13.5px * var(--fz))' }}>漏網主因（可據以逐日修正）</b>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 3 }}>
                {Object.entries(rv.whyAgg || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                  <span key={k} style={{ padding: '2px 9px', borderRadius: 8, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)' }}>
                    {WHY[k] ?? k} <b>{v}</b> 檔次
                  </span>
                ))}
              </div>
            </div>
            {rv.newsLiftAgg && (
              <div style={{ marginBottom: 6 }}>
                <b style={{ fontSize: 'calc(13.5px * var(--fz))' }}>AI 新聞判別加值</b>
                <span style={{ color: 'var(--text-muted)', marginLeft: 6, fontSize: 'calc(13.5px * var(--fz))' }}>
                  （{rv.daysWithNews ?? 0} 個交易日有判別存檔{(rv.daysWithNews ?? 0) < 20 ? '·樣本尚不足以定論' : ''}）
                </span>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 3 }}>
                  {(['bull', 'neutral', 'none', 'bear'] as const).map(k => {
                    const g = rv.newsLiftAgg![k]; const lbl = { bull: '利多', neutral: '中性', none: '資訊不足', bear: '利空' }[k];
                    return <span key={k} style={{ color: 'var(--text-muted)' }}>{lbl}：{g?.n ? <b style={{ color: (g.avg ?? 0) >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>{pn(g.avg)}</b> : '—'}（n={g?.n ?? 0}）</span>;
                  })}
                </div>
              </div>
            )}
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 640 }}>
                <thead><tr>
                  <th style={{ ...th, textAlign: 'left' }}>資料日→適用日</th><th style={th}>推薦</th><th style={th}>命中</th>
                  <th style={th}>命中率</th><th style={th}>平均</th><th style={th}>召回</th><th style={{ ...th, textAlign: 'left' }}>最大漏網</th>
                </tr></thead>
                <tbody>
                  {d.review!.daily.slice(0, 12).map(r => (
                    <tr key={r.date} style={{ borderTop: '1px solid var(--border-primary)' }}>
                      <td style={{ ...td, textAlign: 'left', whiteSpace: 'nowrap' }}>{r.date.slice(5)}→{r.targetDate.slice(5)}</td>
                      <td style={td}>{r.picked}</td><td style={td}>{r.hit}</td>
                      <td style={{ ...td, color: (r.precision ?? 0) >= 60 ? '#22c55e' : 'var(--text-primary)' }}>{r.precision ?? '—'}%</td>
                      <td style={td}>{pn(r.avgRet)}</td>
                      <td style={td}>{r.recall ?? '—'}%</td>
                      <td style={{ ...td, textAlign: 'left', color: 'var(--text-muted)', fontSize: 'calc(13.5px * var(--fz))' }}>
                        {r.missTop?.[0] ? `${r.missTop[0].code} +${r.missTop[0].ret}%（${r.missTop[0].reasons.join('・')}）` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: 'calc(13.5px * var(--fz))', marginTop: 5, lineHeight: 1.7 }}>
              {rv.note}
            </div>
          </div>
        );
      })()}

      {/* 歷史報表 */}
      <div style={box}>
        <b>⑥ 歷史訓練報表</b>
        <div style={{ overflowX: 'auto', marginTop: 4 }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 640 }}>
            <thead><tr>
              <th style={{ ...th, textAlign: 'left' }}>時間</th><th style={{ ...th, textAlign: 'left' }}>主模型</th>
              <th style={th}>樣本外(可買)</th><th style={th}>淨勝</th><th style={{ ...th, textAlign: 'left' }}>軋空模型</th><th style={th}>提升</th>
            </tr></thead>
            <tbody>
              {d.reports.map(r => (
                <tr key={r.runId} style={{ borderTop: '1px solid var(--border-primary)' }}>
                  <td style={{ ...td, textAlign: 'left', whiteSpace: 'nowrap' }}>{fmtT(r.updatedAt)}</td>
                  <td style={{ ...td, textAlign: 'left' }}>{r.mainName ?? <span style={{ color: '#ef4444' }}>無</span>}</td>
                  <td style={td}>{r.mainOot?.meanBuyable != null ? pn(r.mainOot.meanBuyable) : '—'}</td>
                  <td style={{ ...td, color: (r.edge ?? 0) >= 0 ? '#22c55e' : '#ef4444' }}>{r.edge != null ? `${r.edge >= 0 ? '+' : ''}${r.edge}pp` : '—'}</td>
                  <td style={{ ...td, textAlign: 'left' }}>{r.sqName ?? '—'}</td>
                  <td style={td}>{r.sqLift != null ? `${r.sqLift >= 0 ? '+' : ''}${r.sqLift}pp` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ color: 'var(--text-muted)', fontSize: 'calc(13.5px * var(--fz))', lineHeight: 1.7 }}>
        方法論：選因子只用訓練段（前 70%），選定後在完全未參與的樣本外段驗證；
        報酬一律採<b>可買口徑</b>（排除隔日開盤即漲停鎖死、實際買不到者）。
        國際盤採 t 日收盤——美股 t 日盤在台北時間當晚，早於台股 t+1 開盤，不是未來函數。
        <b>非投資建議。</b>
      </div>
    </div>
  );
}
