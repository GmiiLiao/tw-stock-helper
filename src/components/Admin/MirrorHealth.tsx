'use client';

// ── 🪞 官方資料鏡像健康（超級管理員；起漲影子分頁的子分頁）────────────────────
// second-brain/official 的 manifest／端點驗證／缺漏警示／執行鎖／請求額度，由 surge_lab_publish.mjs 發佈到 surgeShadow/lab-mirror。
// 日資料（鍵為日期）的最後一筆早於「最後交易日」＝落後，整列標紅；月／季資料定版規則不同，這裡不判（顯示「—」，不假裝驗過）。
// 必有表（official-mirror must：交易日不可能為空）另看「最後交易日那一列」的狀態——manifest 的最後一筆含空表，只看它會漏掉「很新但其實是空」。
import { useRef, useState } from 'react';
import type { MirrorDoc, MirrorDataset } from '../../../scripts/lib/surge-lab-report.mjs';
import { Kpi, Section, ListTable, MONO } from './AiLabParts';
import { useLabView, twTime } from './surgeLabFetch';

interface Resp { found: boolean; updatedAt?: string | null; mirror?: MirrorDoc }
const SHOW_MAX = 400;
const counts = (c: Record<string, number | null>) => Object.entries(c).map(([k, n]) => `${k} ${n ?? '—'}`).join('｜') || '—';
const abnormal = (d: MirrorDataset) => d.stale === true || d.mustNotOk === true || (d.counts.bad || 0) > 0 || d.verified === false || ((d.counts.empty || 0) > 0 && !d.counts.ok && d.verified !== true);

export default function MirrorHealth() {
  const { data, err, loading, reload } = useLabView<Resp>('mirror');
  const [onlyBad, setOnlyBad] = useState(true);
  const [q, setQ] = useState('');
  const qRef = useRef<HTMLInputElement>(null);   // 非受控搜尋框（IME），按 Enter／搜尋才套用
  if (!data) return <div style={{ padding: 16, color: err ? '#ef4444' : 'var(--text-muted)' }}>{err ? <>載入失敗：{err} <button type="button" onClick={() => void reload()}>重試</button></> : '載入中…'}</div>;
  if (!data.found || !data.mirror) return <div style={{ padding: 16, color: 'var(--text-muted)' }}>尚未發佈鏡像健康——在 Mac 上執行 node scripts/surge-lab/surge_lab_publish.mjs --only mirror。</div>;
  const m = data.mirror; const s = m.summary;
  const list = m.datasets.filter(d => (!onlyBad || abnormal(d)) && (!q || d.key.toLowerCase().includes(q.toLowerCase())));
  const lockText = m.lock ? `${m.lock.cmd ?? '?'}（pid ${m.lock.pid ?? '?'}，${twTime(m.lock.at)} 開始${m.lock.alive === true ? '，發佈時仍在跑' : m.lock.alive === false ? '，發佈時已不在——殘留鎖' : ''}）` : '無（沒有回補／補抓在跑）';
  const applyQ = () => setQ(qRef.current?.value.trim() ?? '');
  return (
    <div style={{ fontSize: 'calc(13.5px * var(--fz))', lineHeight: 1.7 }}>
      <div style={{ padding: '10px 12px', borderRadius: 10, background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.25)', marginBottom: 10 }}>
        <b>🪞 官方資料鏡像健康</b>：本機 second-brain/official（研究與訓練資料一律取官方來源）。資料日 <b>{m.dataDate}</b>｜最後交易日 <b>{m.lastTradingDay ?? '—'}</b>｜manifest 更新 {twTime(m.manifestUpdated)}｜發佈 {twTime(m.generatedAt)}
        {loading && <span style={{ color: 'var(--text-muted)' }}>　更新中…</span>}{err && <span style={{ color: '#ef4444' }}>　重新載入失敗：{err}</span>}
        {!m.present && <div style={{ color: '#ef4444' }}>⚠ 發佈時找不到鏡像 manifest.json</div>}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Kpi label="資料集" value={s.datasets} sub={`日資料 ${s.daily}｜落後最後交易日 ${s.stale}`} color={s.stale ? '#ef4444' : undefined} />
        <Kpi label="必有表（最後交易日有資料）" value={`${(s.mustTotal ?? 0) - (s.mustNotOk ?? 0)}／${s.mustTotal ?? '—'}`} color={s.mustNotOk ? '#ef4444' : undefined}
          sub={s.mustNotOk ? `${s.mustNotOk} 張不是 ok${s.mustAbsent ? `（其中 ${s.mustAbsent} 張鏡像尚無）` : ''}` : '全部 ok'} hint="官方鏡像標為交易日不可能為空的表；看最後交易日那一列是否抓到真資料（空表也算缺）。" />
        <Kpi label="有失敗或只有空表" value={s.withBad} color={s.withBad ? '#f59e0b' : undefined} sub="空表經驗證判定合法者不算" />
        <Kpi label="端點驗證" value={`${s.verifyOk}／${s.verifyTotal}`} color={s.verifyOk < s.verifyTotal ? '#f59e0b' : undefined} sub="帶日期端點須抓到真資料才算通過" />
        <Kpi label="缺漏警示" value={s.alertsMissing == null ? '無檔' : `缺 ${s.alertsMissing}`} color={s.alertsMissing ? '#ef4444' : undefined} sub={m.alerts ? `retry ${twTime(m.alerts.at)}` : m.alertsNote ?? ''} />
      </div>
      <div style={{ marginTop: 6, color: 'var(--text-muted)' }}>
        執行鎖：{lockText}｜回補請求額度：{m.budget ? `${m.budget.day ?? '—'}（台北日曆日計）已用 ${m.budget.requests ?? '—'} 個請求` : '—'}
      </div>

      {(m.readErrors?.length ?? 0) > 0 && (
        <Section title="發佈時讀檔失敗" sub={`${m.readErrors.length} 個檔（半寫或損壞；對應欄位是 null，不是「沒有」）`}>
          <ListTable head={['檔案', '錯誤']} rows={m.readErrors.map(e => [<span key="f" style={MONO}>{e.file ?? '—'}</span>, e.error ?? '—'])} />
        </Section>
      )}
      <Section title="端點驗證失敗" sub={`${m.verifyFailures.length} 項`}>
        <ListTable head={['端點', '狀態', '列數', '回音日', '驗證時刻', '說明']} right={[2]} empty="全部通過"
          rows={m.verifyFailures.map(f => [<b key="i">{f.id}</b>, f.status ?? '—', f.rows ?? '—', f.echo ?? '—', twTime(f.at), f.note ?? '—'])} />
      </Section>
      <Section title="交易日缺漏警示" sub={m.alerts ? `${m.alerts.rule ?? ''}｜${twTime(m.alerts.at)}${m.alerts.truncated ? `｜只列前 ${m.alerts.missing.length} 筆` : ''}` : undefined}>
        {m.alerts ? (
          <ListTable head={['資料集', '鍵', '狀態']} empty="沒有缺漏" rows={m.alerts.missing.map(a => [a.id ?? '—', <span key="k" style={MONO}>{a.key ?? '—'}</span>, a.status ?? '—'])} />
        ) : <div style={{ color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))' }}>{m.alertsNote}</div>}
      </Section>
      {m.runs.length > 0 && (
        <Section title="最近執行" sub="_runs/（新→舊）">
          <ListTable head={['執行', '請求', '結果', '警示', '時刻']} right={[1, 3]} rows={m.runs.map(r => [r.name ?? '—', r.requests ?? '—', r.error ? <span key="e" style={{ color: '#f59e0b' }}>{r.error}</span> : r.stats ? counts(r.stats) : '—', r.alerts ?? '—', twTime(r.at)])} />
        </Section>
      )}
      <Section title="資料集" sub={`${list.length}／${m.datasets.length}${list.length > SHOW_MAX ? `（只列前 ${SHOW_MAX}）` : ''}`}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6, fontSize: 'calc(12.5px * var(--fz))' }}>
          <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={onlyBad} onChange={e => setOnlyBad(e.target.checked)} />只看異常</label>
          <input ref={qRef} defaultValue="" placeholder="搜尋資料集" maxLength={60} onKeyDown={e => { if (e.key === 'Enter') applyQ(); }}
            style={{ padding: '3px 8px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-input, var(--bg-secondary))', color: 'var(--text-primary)', width: '12em' }} />
          <button type="button" onClick={applyQ} style={{ padding: '3px 10px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'transparent', color: '#7dd3fc', cursor: 'pointer' }}>搜尋</button>
        </div>
        <ListTable head={['資料集', '第一筆', '最後一筆', '單位', '筆數狀態', '最後交易日', '驗證', '落後']} right={[]} maxHeight={520} stickyFirst
          empty={onlyBad ? '沒有異常的資料集' : '沒有符合的資料集'}
          rows={list.slice(0, SHOW_MAX).map(d => {
            const hot = d.stale === true || d.mustNotOk === true;
            const style = hot ? { color: '#ef4444', fontWeight: 800 } : undefined;
            return [
              <span key="k" style={style} title={d.key}>{d.host ? <span style={{ color: 'var(--text-muted)' }}>{d.host.replace(/^www\./, '')}/</span> : null}{d.id}{d.must && <span style={{ marginLeft: 4, fontSize: 'calc(11px * var(--fz))', color: 'var(--text-muted)' }}>必有</span>}</span>,
              <span key="f" style={MONO}>{d.first ?? '—'}</span>, <span key="l" style={{ ...MONO, ...(style || {}) }}>{d.last ?? '—'}</span>,
              { day: '日', month: '月', quarter: '季', other: '其他' }[d.unit], d.absent ? <span key="c" style={{ color: '#ef4444' }}>鏡像尚無此資料集</span> : counts(d.counts),
              d.unit !== 'day' ? <span key="t" style={{ color: 'var(--text-muted)' }}>不判</span>
                : <span key="t" style={d.mustNotOk ? { color: '#ef4444', fontWeight: 800 } : undefined} title={d.ltdError ?? undefined}>{d.ltdError ? '讀檔失敗' : d.ltdStatus ?? '沒有這一列'}</span>,
              d.verified === true ? '✓' : d.verified === false ? <span key="v" style={{ color: '#f59e0b' }}>✗</span> : '—',
              d.stale === true ? <b key="s" style={{ color: '#ef4444' }}>落後</b> : d.stale === false || d.absent ? '—' : <span key="s" style={{ color: 'var(--text-muted)' }}>不判</span>,
            ];
          })} />
      </Section>
      <div style={{ marginTop: 10, color: 'var(--text-muted)' }}>鏡像只在本機；這裡是發佈當下的快照（重新執行 surge_lab_publish.mjs --only mirror 才會更新）。</div>
    </div>
  );
}
