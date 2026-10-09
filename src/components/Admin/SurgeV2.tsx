'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { auth } from '@/lib/firebase';
import {
  parseReport, rec, isWarnPick, ledgerStatusLabel, swingStatusLabel, barWidths, signTone, ciTone,
  fmtNum, fmtCount, fmtRatio, fmtPercent, fmtRate, fmtInterval, fmtDateTime, fmtText, fmtFlag,
  type V2Report, type V2Pick, type V2Swing10, type Tone,
} from '@/lib/surge-v2-format';
import { LAB_FOOT } from './surgeLabFetch';

// ── 🧪 飆股模型 v2（影子實驗·超級管理員）─────────────────────────────────────
// 研究管線每晚產出的影子實驗報告（未通過驗證、不進任何分數、不影響站上功能）。
// 資料：Mac 管線 → Firestore surgeShadow/surge-v2 → /api/admin/surge-v2。欄位全部可能缺：由 parseReport 收斂、缺值顯示「—」。
// 不輪詢：載入時讀一次＋手動「重新整理」（資料每晚才變一次）。
// 2026-10-09：加「5日榜→10日（模型A）」區塊（report.swing10；舊報告沒有這欄就不顯示）。

const FETCH_TIMEOUT_MS = 8000;
const LIST_BASE = 30;   // 名單／帳本預設顯示列數（不一次渲染全部）
const LIST_STEP = 20;
const MONO = "'JetBrains Mono',monospace";
const AMBER = '#f59e0b';
const RED = '#ef4444';
const BLUE = '#7dd3fc';
const MUTED = 'var(--text-muted)';
const LINE = '1px solid var(--border-primary)';

const toneColor = (t: Tone): string | undefined => (t === 'up' ? 'var(--color-up)' : t === 'down' ? 'var(--color-down)' : undefined);

// ───────── 版面小件 ─────────
const TH: CSSProperties = { padding: '3px 10px', textAlign: 'right', borderBottom: LINE, fontWeight: 600 };
const TD: CSSProperties = { padding: '3px 10px', textAlign: 'right' };
const BTN: CSSProperties = { padding: '3px 14px', borderRadius: 999, border: LINE, background: 'transparent', color: BLUE, cursor: 'pointer', fontWeight: 700, fontSize: 'calc(12.5px * var(--fz))' };

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section style={{ marginTop: 18, minWidth: 0 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 'calc(15px * var(--fz))', fontWeight: 800 }}>{title}</h3>
      {hint && <div style={{ color: MUTED, marginBottom: 6 }}>{hint}</div>}
      {children}
    </section>
  );
}
const Empty = ({ text = '尚無資料' }: { text?: string }) => <div style={{ color: MUTED, padding: '4px 0' }}>{text}</div>;
const Note = ({ children }: { children: ReactNode }) => <div style={{ color: MUTED, marginBottom: 6, wordBreak: 'break-word' }}>{children}</div>;

/** 橫向可捲的表（手機寬度不撐破頁面）。left＝靠左對齊的欄位索引。 */
function Table({ heads, left = [], children }: { heads: string[]; left?: number[]; children: ReactNode }) {
  return (
    <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
      <table style={{ borderCollapse: 'collapse', fontFamily: MONO, fontSize: 'calc(13px * var(--fz))', whiteSpace: 'nowrap' }}>
        <thead><tr style={{ color: MUTED }}>{heads.map((h, i) => <th key={h} style={left.includes(i) ? { ...TH, textAlign: 'left' } : TH}>{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
const cell = (v: ReactNode, tone?: Tone, extra: CSSProperties = {}) => <td style={{ ...TD, color: tone ? toneColor(tone) : undefined, ...extra }}>{v}</td>;
const cellL = (v: ReactNode, extra: CSSProperties = {}) => <td style={{ ...TD, textAlign: 'left', ...extra }}>{v}</td>;

/** 顯示前 N 列＋「再 +20」。rows 變多／變少時 shown 仍以 min 夾住。 */
function Limited<T>({ rows, render }: { rows: T[]; render: (visible: T[]) => ReactNode }) {
  const [shown, setShown] = useState(LIST_BASE);
  const visible = rows.slice(0, shown);
  return (
    <>
      {render(visible)}
      {rows.length > LIST_BASE && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <span style={{ color: MUTED }}>顯示 {visible.length}／{rows.length} 筆</span>
          {visible.length < rows.length && <button type="button" style={BTN} onClick={() => setShown(s => s + LIST_STEP)}>＋{Math.min(LIST_STEP, rows.length - visible.length)} 筆</button>}
          {shown > LIST_BASE && <button type="button" style={{ ...BTN, color: MUTED }} onClick={() => setShown(LIST_BASE)}>收回前 {LIST_BASE}</button>}
        </div>
      )}
    </>
  );
}

// ───────── 頁首 ─────────
function Badge({ label, value }: { label: string; value: string }) {
  return <span style={{ padding: '2px 10px', borderRadius: 999, border: LINE, background: 'var(--bg-tertiary)', fontFamily: MONO, whiteSpace: 'nowrap' }}><span style={{ color: MUTED }}>{label} </span><b>{value}</b></span>;
}

function Header({ r, updatedAt }: { r: V2Report; updatedAt: string | null }) {
  const { passed, text, rule } = r.verdict;
  const mark = passed === true ? ['✅ 通過驗證標準', 'var(--color-up)'] : passed === false ? ['⛔ 未通過驗證標準', AMBER] : ['驗證結論未提供', MUTED];
  return (
    <div>
      <div style={{ padding: '8px 12px', borderRadius: 10, background: 'rgba(245,158,11,0.12)', border: `1px solid ${AMBER}`, marginBottom: 8, fontWeight: 800, color: AMBER }}>
        🧪 影子實驗・未通過驗證・不進任何分數
        {r.status !== null && r.status !== 'shadow' && <span style={{ color: RED }}>　⚠ 報告 status＝{r.status}（預期 shadow）</span>}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        <Badge label="資料日" value={fmtText(r.asOfDay)} />
        <Badge label="假設進場日" value={fmtText(r.entryDay)} />
        <Badge label="建置" value={fmtDateTime(r.builtTime)} />
        <Badge label="寫入 Firestore" value={fmtDateTime(updatedAt)} />
        <Badge label="schema" value={fmtText(r.schema)} />
      </div>
      <div style={{ padding: '8px 12px', borderRadius: 10, background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.25)', wordBreak: 'break-word' }}>
        <b style={{ color: mark[1] }}>{mark[0]}</b>
        <div>{fmtText(text)}</div>
        {rule && <div style={{ color: MUTED }}>通過標準：{rule}</div>}
      </div>
    </div>
  );
}

// ───────── 驗證摘要 ─────────
function Validation({ v }: { v: V2Report['validation'] }) {
  const widths = barWidths(v.importance.map(x => x.pp));
  return (
    <Section title="驗證摘要（walk-forward）" hint={v.target ?? undefined}>
      <b>實際出場報酬</b>
      {v.rows.length === 0 ? <Empty /> : (
        <Table heads={['階段', '折', '名單均報', '基準', '超額', '超額 95% 區間', '勝率%', '平均持有日']} left={[0, 1]}>
          {v.rows.map((x, i) => {
            const diff = x.top !== null && x.base !== null ? x.top - x.base : null;
            return (
              <tr key={i} style={{ borderBottom: LINE }}>
                {cellL(fmtText(x.phase))}{cellL(fmtText(x.fold))}
                {cell(fmtPercent(x.top, 2, true), signTone(x.top))}{cell(fmtPercent(x.base, 2, true), signTone(x.base))}
                {cell(fmtPercent(diff, 2, true), ciTone(x.diffLo, x.diffHi), { fontWeight: 700 })}
                {cell(fmtInterval(x.diffLo, x.diffHi), ciTone(x.diffLo, x.diffHi))}
                {cell(fmtNum(x.win, 0))}{cell(fmtNum(x.holdDays, 1))}
              </tr>
            );
          })}
        </Table>
      )}
      <div style={{ marginTop: 10 }}><b>命中率提升</b></div>
      {v.hitRows.length === 0 ? <Empty /> : (
        <Table heads={['階段', '折', '命中率', '基準', '提升(pp)', '提升 95% 區間']} left={[0, 1]}>
          {v.hitRows.map((x, i) => (
            <tr key={i} style={{ borderBottom: LINE }}>
              {cellL(fmtText(x.phase))}{cellL(fmtText(x.fold))}
              {cell(fmtPercent(x.prec, 1))}{cell(fmtPercent(x.base, 1))}
              {cell(fmtNum(x.lift, 1, true), ciTone(x.liftLo, x.liftHi), { fontWeight: 700 })}
              {cell(fmtInterval(x.liftLo, x.liftHi), ciTone(x.liftLo, x.liftHi))}
            </tr>
          ))}
        </Table>
      )}
      <div style={{ marginTop: 10 }}><b>特徵群重要度</b>（pp）</div>
      {v.importance.length === 0 ? <Empty /> : v.importance.map((x, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0' }}>
          <span style={{ flex: '0 0 120px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmtText(x.group)}</span>
          <span style={{ flex: 1, minWidth: 0, background: 'var(--bg-tertiary)', borderRadius: 4, height: 10 }}>
            <span style={{ display: 'block', width: `${widths[i]}%`, height: '100%', borderRadius: 4, background: (x.pp ?? 0) < 0 ? RED : BLUE }} />
          </span>
          <span style={{ flex: '0 0 64px', textAlign: 'right', fontFamily: MONO }}>{fmtNum(x.pp, 1, true)}</span>
        </div>
      ))}
      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: 'pointer', color: BLUE }}>限制備註（{v.notes.length}）</summary>
        {v.notes.length === 0 ? <Empty /> : <ul style={{ margin: '4px 0', paddingLeft: 20, wordBreak: 'break-word' }}>{v.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      </details>
    </Section>
  );
}

// ───────── 名單 ─────────
const PICK_HEADS = ['名次', '代號名稱', '分數', '前20日', '線型家族', '近20日漲停', '開盤即漲停', '一字鎖死', '開板', '小量漲停', '連板', '量比', '注意', '處置', '上櫃', '新聞 利多/利空/則', '標籤'];

function PickDetail({ p }: { p: V2Pick }) {
  const e = p.exit;
  return (
    <div style={{ position: 'sticky', left: 0, maxWidth: 'min(640px, 88vw)', whiteSpace: 'normal', lineHeight: 1.7, wordBreak: 'break-word' }}>
      <div><b>出場規則</b>：停利 {fmtRatio(e.tp, 0, true)}｜停損 {fmtRatio(e.sl === null ? null : -Math.abs(e.sl), 0)}｜最長持有 {fmtCount(e.maxHold)} 日（未扣成本）</div>
      <div>勝率估計 {fmtRatio(p.winProb)}｜模型分數 {fmtNum(p.score, 3)}｜線型家族 {fmtText(p.family?.label)}（id {fmtCount(p.family?.id)}，距離 {fmtNum(p.family?.dist, 2)}）</div>
      <div>近20日：收漲停 {fmtCount(p.state.luClose20)}｜開盤即漲停 {fmtCount(p.state.luOpen20)}｜一字鎖死 {fmtCount(p.state.luLock20)}｜開板 {fmtCount(p.state.luBroken20)}｜小量 {fmtCount(p.state.luSmall20)}｜大量 {fmtCount(p.state.luBig20)}｜注意 {fmtCount(p.state.attn20)} 次</div>
      <div>新聞：利多 {fmtNum(p.news.bull0, 2)}／利空 {fmtNum(p.news.bear0, 2)}／近3日 {fmtCount(p.news.cnt3)} 則</div>
      <div>標籤：{p.flags.length === 0 ? '—' : p.flags.join('、')}</div>
    </div>
  );
}

function PickRows({ rows }: { rows: V2Pick[] }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set<string>());
  const toggle = (k: string) => setOpen(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  return (
    <Limited rows={rows} render={visible => (
      <Table heads={PICK_HEADS} left={[1, 4, 16]}>
        {visible.map((p, i) => {
          const k = `${p.code}#${i}`; const isOpen = open.has(k); const warn = isWarnPick(p);
          return [
            <tr key={k} onClick={() => toggle(k)} style={{ borderBottom: LINE, cursor: 'pointer', background: warn ? 'rgba(245,158,11,0.10)' : undefined }}>
              {cell(<button type="button" aria-expanded={isOpen} style={{ all: 'unset', cursor: 'pointer' }}>{isOpen ? '▾' : '▸'} {fmtCount(p.rank ?? i + 1)}</button>)}
              {cellL(<><b>{p.code}</b> {p.name}{warn && <span title="處置中或有一字鎖死" style={{ color: AMBER }}> ⚠</span>}</>)}
              {cell(fmtNum(p.score, 2))}{cell(fmtRatio(p.past20, 1, true), signTone(p.past20))}
              {cellL(fmtText(p.family?.label))}
              {cell(fmtCount(p.state.luClose20))}{cell(fmtCount(p.state.luOpen20))}
              {cell(fmtCount(p.state.luLock20), undefined, { color: (p.state.luLock20 ?? 0) > 0 ? AMBER : undefined, fontWeight: (p.state.luLock20 ?? 0) > 0 ? 700 : 400 })}
              {cell(fmtCount(p.state.luBroken20))}{cell(fmtCount(p.state.luSmall20))}
              {cell(fmtCount(p.state.streak))}{cell(fmtNum(p.state.vr, 2))}{cell(fmtCount(p.state.attn20))}
              {cell(fmtFlag(p.state.disp, '處置', '否'), undefined, { color: (p.state.disp ?? 0) > 0 ? AMBER : undefined, fontWeight: (p.state.disp ?? 0) > 0 ? 700 : 400 })}
              {cell(fmtFlag(p.state.otc, '上櫃', '上市'))}
              {cell(`${fmtNum(p.news.bull0, 1)}/${fmtNum(p.news.bear0, 1)}/${fmtCount(p.news.cnt3)}`)}
              {cellL(p.flags.length === 0 ? '—' : p.flags.join('、'))}
            </tr>,
            isOpen && <tr key={`${k}-d`} style={{ borderBottom: LINE }}><td colSpan={PICK_HEADS.length} style={{ ...TD, textAlign: 'left' }}><PickDetail p={p} /></td></tr>,
          ];
        })}
      </Table>
    )} />
  );
}

function Picks({ p }: { p: V2Report['picks'] }) {
  return (
    <>
      <Section title="起漲名單" hint="進場前 20 日漲幅 < +15%。點一列展開出場規則與細節；橘底＝處置中或有一字鎖死（買不到／風險高）。">
        {p.start.length === 0 ? <Empty /> : <PickRows rows={p.start} />}
      </Section>
      <Section title="續漲名單" hint="進場前 20 日漲幅 ≥ +15%。">
        {p.cont.length === 0 ? <Empty /> : <PickRows rows={p.cont} />}
      </Section>
    </>
  );
}

// ───────── 處置股 ─────────
function Disposal({ d }: { d: V2Report['disposal'] }) {
  return (
    <Section title="處置股模態" hint={d.predictability ?? undefined}>
      {d.modes.length === 0 ? <Empty /> : (
        <Table heads={['#', '模態', '樣本', '處置前20日', '處置期間', '出關後20日', '觸及+25%', '說明']} left={[1, 7]}>
          {d.modes.map((m, i) => (
            <tr key={i} style={{ borderBottom: LINE }}>
              {cell(fmtCount(m.id))}{cellL(fmtText(m.label))}{cell(fmtCount(m.n))}
              {cell(fmtRatio(m.pre20, 1, true), signTone(m.pre20))}{cell(fmtRatio(m.during, 1, true), signTone(m.during))}
              {cell(fmtRatio(m.post20, 1, true), signTone(m.post20))}{cell(fmtRatio(m.reach25, 0))}
              {cellL(fmtText(m.note), { whiteSpace: 'normal', minWidth: 200 })}
            </tr>
          ))}
        </Table>
      )}
      <div style={{ marginTop: 10 }}><b>今日處置中股票追蹤</b></div>
      {d.today.length === 0 ? <Empty text="今日沒有處置中股票（或管線未提供）" /> : (
        <Table heads={['代號名稱', '處置第N日', '前20日', '處置以來', '模態', '距該模態']} left={[0, 4]}>
          {d.today.map((t, i) => (
            <tr key={i} style={{ borderBottom: LINE }}>
              {cellL(<><b>{t.code}</b> {t.name}</>)}{cell(fmtCount(t.day))}
              {cell(fmtRatio(t.pre20, 1, true), signTone(t.pre20))}{cell(fmtRatio(t.since, 1, true), signTone(t.since))}
              {cellL(t.modeLabel ?? (t.mode === null ? '—' : `#${t.mode}`))}{cell(fmtNum(t.dist, 3))}
            </tr>
          ))}
        </Table>
      )}
    </Section>
  );
}

// ───────── 換股機會 ─────────
const pickText = (p: V2Pick | null) => (p ? `${p.code} ${p.name}（分數 ${fmtNum(p.score, 2)}）` : '—');

function Swaps({ s }: { s: V2Report['swaps'] }) {
  return (
    <Section title="換股機會" hint={s.rule ?? undefined}>
      {s.validation.length === 0 ? <Empty text="尚無換股驗證資料" /> : (
        <Table heads={['變體', '折', '樣本', '換股後%', '續抱%', '差(pp)', '差 95% 區間']} left={[0, 1]}>
          {s.validation.map((x, i) => (
            <tr key={i} style={{ borderBottom: LINE }}>
              {cellL(fmtText(x.variant))}{cellL(fmtText(x.fold))}{cell(fmtCount(x.n))}
              {cell(fmtPercent(x.swap, 2, true), signTone(x.swap))}{cell(fmtPercent(x.hold, 2, true), signTone(x.hold))}
              {cell(fmtNum(x.diff, 2, true), ciTone(x.lo, x.hi), { fontWeight: 700 })}{cell(fmtInterval(x.lo, x.hi, 2), ciTone(x.lo, x.hi))}
            </tr>
          ))}
        </Table>
      )}
      <div style={{ marginTop: 10 }}><b>今日建議</b></div>
      {s.today.length === 0 ? <Empty text="今日沒有換股建議" /> : s.today.map((t, i) => (
        <div key={i} style={{ padding: '6px 0', borderBottom: LINE, wordBreak: 'break-word' }}>
          持有 <b>{pickText(t.hold)}</b> → 換入 <b>{pickText(t.to)}</b>｜籌碼距離 {fmtNum(t.chipDist, 2)}
          {t.why && <div style={{ color: MUTED }}>{t.why}</div>}
        </div>
      ))}
    </Section>
  );
}

// ───────── 5 日榜 → 10 日（模型 A）─────────
const SWING_TOP = 5;     // 每晚凍結前 5 名
const SWING_STRAT = 3;   // 策略＝前 5 名中隔日開盤非漲停的前 3 檔
const SWING_HEADS = ['名次', '代號名稱', '模型機率', '5日漲幅', '已有5日超額', '還需約', '所在榜', '距5日線', '上榜第幾天', '今日漲停', '連板', '連續注意', '處置第N日', '本次處置漲停', '營收3月年增', '60日漲停'];

function Swing10({ s }: { s: V2Swing10 }) {
  const m = s.model; const ls = s.ledger.summary;
  return (
    <Section title="🎯 5日榜→10日（模型A·影子）" hint={s.target ?? undefined}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        <Badge label="資料日" value={fmtText(s.asOfDay)} />
        <Badge label="假設進場日" value={fmtText(s.entryDay)} />
        <Badge label="訓練資料到" value={fmtText(m.trainedThrough)} />
        <Badge label="訓練列／正例" value={`${fmtCount(m.rows)}／${fmtCount(m.positives)}`} />
      </div>
      {s.validation.length > 0 && <ul style={{ margin: '0 0 8px', paddingLeft: 20, wordBreak: 'break-word' }}>{s.validation.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      <Note>藍底＝每晚凍結的前 {SWING_TOP} 名（只寫一次，事後對答案）；策略取其中隔日開盤非漲停的前 {SWING_STRAT} 檔。「還需約」假設之後 5 日大盤持平。</Note>
      {s.picks.length === 0 ? <Empty text="今日沒有 5 日榜名單" /> : (
        <Limited rows={s.picks} render={visible => (
          <Table heads={SWING_HEADS} left={[1, 6]}>
            {visible.map((p, i) => {
              const top = (p.rank ?? i + 1) <= SWING_TOP;
              return (
                <tr key={`${p.code}#${i}`} style={{ borderBottom: LINE, background: top ? 'rgba(59,130,246,0.08)' : undefined }}>
                  {cell(fmtCount(p.rank ?? i + 1))}{cellL(<><b>{p.code}</b> {p.name}</>)}
                  {cell(fmtRatio(p.prob, 1), undefined, { fontWeight: 700 })}
                  {cell(fmtRatio(p.g5, 0, true), signTone(p.g5))}{cell(fmtRatio(p.g5x, 0, true), signTone(p.g5x))}{cell(fmtRatio(p.need, 0, true))}
                  {cellL(fmtText(p.boards))}{cell(fmtRatio(p.ma5gap, 0, true), signTone(p.ma5gap))}{cell(fmtCount(p.boardAge))}
                  {cell(fmtFlag(p.luToday, '是', ''))}{cell(fmtCount(p.luRun))}{cell(fmtCount(p.attRun))}
                  {cell((p.dispDay ?? 0) > 0 ? fmtCount(p.dispDay) : '', undefined, { color: (p.dispDay ?? 0) > 0 ? AMBER : undefined })}
                  {cell((p.dispDay ?? 0) > 0 ? fmtCount(p.dispLu) : '')}
                  {cell(fmtPercent(p.yoy3, 0))}{cell(fmtCount(p.lu60))}
                </tr>
              );
            })}
          </Table>
        )} />
      )}
      <div style={{ marginTop: 10 }}><b>前向帳本</b></div>
      <Note>
        累計 {fmtCount(ls.days)} 個資料日、已結算 {fmtCount(ls.closedDays)} 日｜策略可實現超額 <b style={{ color: toneColor(signTone(ls.topRetx)) }}>{fmtRatio(ls.topRetx, 2, true)}</b>｜同日全榜 {fmtRatio(ls.boardRetx, 2, true)}｜差 <b style={{ color: toneColor(signTone(ls.diff)) }}>{fmtRatio(ls.diff, 2, true)}</b>｜上漲比例 {fmtRatio(ls.upShare, 0)}｜達 A 標 {fmtRatio(ls.hitA, 0)}
        {(ls.closedDays ?? 0) < 20 && <span style={{ color: AMBER }}>　⚠ 已結算不到 20 日，還不能下結論</span>}
        {ls.note && <div>{ls.note}</div>}
      </Note>
      {s.ledger.rows.length === 0 ? <Empty text="帳本尚無逐筆紀錄（第一份凍結名單要等隔日開盤才進場）" /> : (
        <Limited rows={s.ledger.rows} render={visible => (
          <Table heads={['進場日', '資料日', '代號名稱', '模型機率', '策略', '狀態', '持有日', '報酬', '超額', '達A標']} left={[0, 1, 2, 4, 5]}>
            {visible.map((x, i) => (
              <tr key={i} style={{ borderBottom: LINE }}>
                {cellL(fmtText(x.pickDay))}{cellL(fmtText(x.dataDay))}{cellL(<><b>{x.code}</b> {x.name}</>)}
                {cell(fmtRatio(x.prob, 1))}{cellL(x.pick === true ? '✓ 買進' : x.pick === false ? '略過' : '—')}
                {cellL(swingStatusLabel(x.status))}{cell(fmtCount(x.day))}
                {cell(fmtRatio(x.ret, 2, true), signTone(x.ret))}{cell(fmtRatio(x.retx, 2, true), signTone(x.retx))}
                {cell(x.hitA === null ? '—' : x.hitA ? '是' : '否')}
              </tr>
            ))}
          </Table>
        )} />
      )}
      {s.notes.length > 0 && <ul style={{ margin: '6px 0 0', paddingLeft: 20, color: AMBER, wordBreak: 'break-word' }}>{s.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
    </Section>
  );
}

// ───────── 前向帳本 ─────────
function Ledger({ l }: { l: V2Report['ledger'] }) {
  const s = l.summary;
  return (
    <Section title="前向影子帳本" hint="每日凍結名單之後的實際後續（事前凍結才算前向成績）。">
      <Note>
        累計 {fmtCount(s.days)} 日、{fmtCount(s.picks)} 檔、已結案 {fmtCount(s.closed)} 檔｜平均報酬 <b style={{ color: toneColor(signTone(s.meanRet)) }}>{fmtRatio(s.meanRet, 2, true)}</b>｜勝率 {fmtRate(s.win)}
        {(s.closed ?? 0) < 20 && <span style={{ color: AMBER }}>　⚠ 結案樣本太少，還不能下結論</span>}
      </Note>
      {l.rows.length === 0 ? <Empty text="帳本尚無逐筆紀錄" /> : (
        <Limited rows={l.rows} render={visible => (
          <Table heads={['進場日', '代號名稱', '階段', '狀態', '報酬', '出場日']} left={[0, 1, 2, 3, 5]}>
            {visible.map((x, i) => (
              <tr key={i} style={{ borderBottom: LINE }}>
                {cellL(fmtText(x.pickDay))}{cellL(<><b>{x.code}</b> {x.name}</>)}{cellL(fmtText(x.phase))}
                {cellL(ledgerStatusLabel(x.status), { color: x.status === 'tp' ? 'var(--color-up)' : x.status === 'sl' ? 'var(--color-down)' : undefined })}
                {cell(fmtRatio(x.ret, 2, true), signTone(x.ret))}{cellL(fmtText(x.exitDay))}
              </tr>
            ))}
          </Table>
        )} />
      )}
    </Section>
  );
}

// ───────── 管線狀態 ─────────
function Pipeline({ p }: { p: V2Report['pipeline'] }) {
  return (
    <Section title="管線狀態與資料備註">
      <Note>最近執行 {fmtDateTime(p.lastRun)}</Note>
      {p.steps.length === 0 ? <Empty text="沒有步驟紀錄" /> : (
        <ul style={{ margin: '0 0 8px', paddingLeft: 0, listStyle: 'none' }}>
          {p.steps.map((s, i) => (
            <li key={i} style={{ wordBreak: 'break-word' }}>
              <span style={{ color: s.ok === true ? 'var(--color-up)' : s.ok === false ? RED : MUTED }}>{s.ok === true ? '✅' : s.ok === false ? '✖' : '？'}</span> {s.name}{s.note ? `：${s.note}` : ''}
            </li>
          ))}
        </ul>
      )}
      {p.dataNotes.length > 0 && <ul style={{ margin: 0, paddingLeft: 20, color: AMBER, wordBreak: 'break-word' }}>{p.dataNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
    </Section>
  );
}

// ───────── 容器 ─────────
interface Loaded { report: V2Report | null; found: boolean; updatedAt: string | null }
interface State { data: Loaded | null; err: string; loading: boolean }

async function fetchReport(): Promise<{ ok: true; data: Loaded } | { ok: false; error: string }> {
  try {
    const token = (await auth.currentUser?.getIdToken()) ?? '';
    const r = await fetch('/api/admin/surge-v2', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    let j: unknown = null;
    try { j = await r.json(); } catch { j = null; }
    const o = rec(j);
    if (!r.ok || j === null) return { ok: false, error: `HTTP ${r.status}${typeof o.error === 'string' ? `：${o.error}` : ''}` };
    if (o.found !== true) return { ok: true, data: { report: null, found: false, updatedAt: null } };
    const report = parseReport(o.report);
    if (!report) return { ok: false, error: '報告格式不符（reportJson 不是物件）' };
    return { ok: true, data: { report, found: true, updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : null } };
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') return { ok: false, error: `逾時（${FETCH_TIMEOUT_MS / 1000} 秒）` };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export default function SurgeV2() {
  const [st, setSt] = useState<State>({ data: null, err: '', loading: true });
  const seq = useRef(0);   // 只採用最後一次請求的回應
  const load = useCallback(async () => {
    const my = ++seq.current;
    setSt(s => ({ ...s, err: '', loading: true }));
    const r = await fetchReport();
    if (my !== seq.current) return;
    setSt(s => (r.ok ? { data: r.data, err: '', loading: false } : { data: s.data, err: r.error, loading: false }));   // 失敗保留上一份資料
  }, []);
  useEffect(() => { void load(); }, [load]);

  const { data, err, loading } = st;
  const retryBtn = <button type="button" onClick={() => void load()} disabled={loading} style={{ ...BTN, marginLeft: 8, padding: '1px 12px' }}>{loading ? '載入中…' : '重新整理'}</button>;
  const root: CSSProperties = { fontSize: 'calc(13.5px * var(--fz))', lineHeight: 1.7, minWidth: 0, maxWidth: '100%' };

  if (!data) {
    return err
      ? <div style={{ ...root, padding: 16, color: RED }}>載入失敗：{err}{retryBtn}</div>
      : <div style={{ ...root, padding: 16, color: MUTED }}>載入中…</div>;
  }
  const r = data.report;
  if (!data.found || !r) {
    return <div style={{ ...root, padding: 16, color: MUTED }}>管線尚未產出——surgeShadow/surge-v2 還沒有報告（研究管線每晚產出，明早再看）。{retryBtn}{err && <div style={{ color: RED }}>重新整理失敗：{err}</div>}</div>;
  }
  return (
    <div style={root}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <b style={{ fontSize: 'calc(16px * var(--fz))' }}>🧪 飆股模型 v2</b>
        {retryBtn}
        {err && <span style={{ color: RED }}>重新整理失敗（顯示上一份）：{err}</span>}
      </div>
      <Header r={r} updatedAt={data.updatedAt} />
      <Validation v={r.validation} />
      <Picks p={r.picks} />
      {r.swing10 && <Swing10 s={r.swing10} />}
      <Disposal d={r.disposal} />
      <Swaps s={r.swaps} />
      <Ledger l={r.ledger} />
      <Pipeline p={r.pipeline} />
      <div style={{ marginTop: 14, color: MUTED }}>影子實驗：研究模型輸出，未通過驗證、不進任何分數、不構成推薦。{LAB_FOOT}</div>
    </div>
  );
}
