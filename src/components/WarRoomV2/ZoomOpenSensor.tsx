'use client';

// D2 放大層「開盤結構」（開盤感應器 openSensor-v2.1·影子；超管）：Z1 第 5 塊的完整明細（規格 v2.1 §9.2 ZoomLayer 項）。
//   檢查點表（09:02 首判＋09:10…10:00 複判，每次修正的揭示時間）｜軌跡｜量的組成（Q、價格樣本窗、ρ 值與來源、c(T) 與基準日數、
//   E1 點估計、E2 事實、加總法伴隨值、樣本內誤差事實）｜兩群明細與覆蓋｜有效開盤與修正｜09:20／09:30 盤型｜門檻 H｜名單存證｜
//   本月「不在狀態內」次數｜盤後兩法誤差（post）。
// 只讀匯流排影子層（不自己開輪詢）；文字只描述事實，不上命中率、勝率、回測百分比。單位：量寫萬張、值寫億元並標（估）。
import type { ReactNode } from 'react';
import { useWarData } from './WarRoomContext';
import { useWarV2Allowed } from './parts/useWarAccess';
import { Badge } from './parts/Badge';
import { hhmmss } from './parts/fmt';
import { OS_CHECK_KEYS, checkOf, currentCheck, type OsCheck, type OsDoc, type OsSeg, type OsCheckKey } from '../../../scripts/lib/warroom-open-sensor.mjs';
import {
  osStateText, osPct, osPp, osInt, osWan, osRatioPct, hm, osGateReasonText, osVolReasonText, osOutsideMonthRows, osOpenLine,
  OS_SAMPLE_ERROR_NOTE, OS_RHO_PRIOR_NOTE,
} from '../../../scripts/lib/warroom-open-sensor-view.mjs';
import zs from './ZoomLayer.module.css';

const DASH = '—';
const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const t = (ms: number | null | undefined) => (isNum(ms) ? hhmmss(ms) : DASH);
const keyTime = (k: string) => `${k.slice(1, 3)}:${k.slice(3)}`;
const segText = (s: OsSeg) => (s == null ? DASH : Array.isArray(s) ? `${osInt(s[0])}–${osInt(s[1])}` : String(s));
const VOL_LABEL: Readonly<Record<string, string>> = { big: '量大（估）', small: '量縮（估）', pending: '量能未定' };
const DIR_LABEL: Readonly<Record<string, string>> = { up: '漲', down: '跌', flat: '平', unconfirmed: '未確認' };

function Sec({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={zs.osSec}>
      <h3 className={zs.osSecTitle}>{title}</h3>
      {children}
    </section>
  );
}

function Kv({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className={zs.osKv}>
      {rows.map(([k, v]) => <div key={k} className={zs.osKvRow}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}

function checkStateText(c: OsCheck | null): string {
  if (!c) return '—（未到或未寫入）';
  if (c.status === 'nodata') return '無資料';
  if (c.status === 'undetermined') return '未判定';
  return osStateText(c.state).short;
}

function checkNote(c: OsCheck | null): string {
  if (!c) return '';
  const notes: string[] = [];
  if (c.late) notes.push('重啟後判（late）');
  if (c.slid) notes.push(`09:02 未過閘門，改用 ${hm(c.T)}`);
  if (c.status !== 'ok' && c.reasons.length) notes.push(c.reasons.map(osGateReasonText).join('；'));
  if (c.vol?.label === 'pending') notes.push(`量未定：${osVolReasonText(c.vol.reason) ?? '輸入缺漏'}`);
  if (c.vol?.gapDay) notes.push('大跳空日');
  return notes.join('｜');
}

function CheckTable({ doc }: { doc: OsDoc }) {
  return (
    <div className={zs.healthWrap}>
      <table className={zs.health}>
        <thead>
          <tr><th>檢查點</th><th>狀態</th><th>權值30</th><th>其餘29檔</th><th>上市一般股</th><th>上市成交金額（估）</th><th>全日（估）／門檻</th><th>揭示 p10–p90</th><th>備註</th></tr>
        </thead>
        <tbody>
          {OS_CHECK_KEYS.map((k: OsCheckKey) => {
            const c = checkOf(doc, k);
            const w = c?.w, g = c?.g, v = c?.vol;
            return (
              <tr key={k}>
                <td>{c?.T ? hm(c.T) : keyTime(k)}</td>
                <td>{checkStateText(c)}</td>
                <td>{w ? `${osPct(w.pct)}·台積電 ${osPct(w.tsmcPct)}` : DASH}</td>
                <td>{w ? `${osInt(w.restUp)}漲${osInt(w.restDown)}跌·X ${osPct(w.restPct)}` : DASH}</td>
                <td>{g ? `中位 ${osPct(g.median)}·上漲 ${osRatioPct(isNum(g.up) && isNum(g.down) && g.up + g.down > 0 ? g.up / (g.up + g.down) : g.upRatio)}（${osInt(g.fresh)}/${osInt(g.n)}）` : DASH}</td>
                <td>{v && isNum(v.vHatYi) ? `${osInt(v.vHatYi)} 億（同時段門檻 ${osInt(v.segThYi)}）` : DASH}</td>
                <td>{v && (isNum(v.estYi) || v.label) ? `${osInt(v.estYi)}／${osInt(v.H)} 億·${v.label ? VOL_LABEL[v.label] : DASH}` : DASH}</td>
                <td>{c ? `${t(c.revealP10)}–${t(c.revealP90)}` : DASH}</td>
                <td>{checkNote(c)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function VolSec({ doc, c, ckey }: { doc: OsDoc; c: OsCheck; ckey: string }) {
  const v = c.vol;
  if (!v) return <Sec title={`量的組成（${keyTime(ckey)}）`}><p className={zs.osNote}>這個檢查點沒有量軸資料</p></Sec>;
  const cb = doc.params?.cBase;
  const rho = v.rho;
  return (
    <Sec title={`量的組成（${hm(c.T)}·比率估計 V̂＝Q×1000×P̄×ρ÷1e8）`}>
      <Kv rows={[
        ['上市累積成交量 Q（實）', v.q ? `${osWan(v.q.lots)} 萬張（揭示 ${t(v.q.revealAt)}）` : DASH],
        ['開盤競價量', `${osWan(v.qAucLots)} 萬張`],
        ['價格樣本', v.px ? `窗 ${v.px.win ?? DASH} 秒·${osInt(v.px.n)} 檔·樣本量 ${osWan(v.px.volLots)} 萬張·含台積電 ${v.px.hasTsmc == null ? DASH : v.px.hasTsmc ? '是' : '否'}·權值 ${osInt(v.px.w30n)} 檔·P̄ ${isNum(v.px.bar) ? v.px.bar.toFixed(2) : DASH} 元` : DASH],
        ['ρ', rho ? `${isNum(rho.v) ? rho.v.toFixed(3) : DASH}（${rho.src === 'live' ? `近 20 日實測中位·${osInt(rho.n)} 日` : OS_RHO_PRIOR_NOTE}）` : DASH],
        ['時間累計比例 c(T)', `${isNum(v.c) ? `${(v.c * 100).toFixed(2)}%` : DASH}（基準 ${osInt(v.cN)} 日${cb ? `；${cb.from ?? DASH}～${cb.to ?? DASH}；缺 openMarks ${cb.missing.length ? cb.missing.join('、') : '無'}` : ''}）`],
        ['上市累積成交金額（估）', `${osInt(v.vHatYi)} 億`],
        ['全日（估）E1', `${osInt(v.estYi)} 億 ${isNum(v.estYi) && isNum(v.H) ? (v.estYi >= v.H ? '≥' : '<') : ''} 門檻 ${osInt(v.H)} 億（同時段 ${osInt(v.segThYi)} 億）`],
        ['E2 競價拆開（事實，不參與判定）', `${osInt(v.estE2Yi)} 億`],
        ['加總法 ΣP×V（伴隨值，不參與判定）', v.vSum ? `${osInt(v.vSum.yi)} 億（${osInt(v.vSum.n)} 檔，未乘係數）` : DASH],
        ['門檻 H', `${osInt(doc.params?.H ?? v.H)} 億（區段 ${segText(doc.params?.hSeg ?? null)}·${doc.params?.hBasis ?? DASH}）`],
        ['樣本內誤差（事實）', OS_SAMPLE_ERROR_NOTE],
      ]} />
    </Sec>
  );
}

function GroupsSec({ c }: { c: OsCheck }) {
  const { w, g, value, open, dom } = c;
  return (
    <Sec title={`兩群明細（${hm(c.T)}）`}>
      <Kv rows={[
        ['權值30', w ? `${osPct(w.pct)}·夠新 ${osInt(w.fresh)}/30·市值覆蓋 ${isNum(w.capCovPct) ? `${w.capCovPct.toFixed(1)}%` : DASH}·方向 ${w.dir ? DIR_LABEL[w.dir] : DASH}` : DASH],
        ['其餘29檔', w ? `${osInt(w.restUp)} 漲·${osInt(w.restDown)} 跌·${osInt(w.restFlat)} 平（夠新 ${osInt(w.restFresh)}）·市值加權 ${osPct(w.restPct)}` : DASH],
        ['上市一般股（流動）', g ? `中位 ${osPct(g.median)}·${osInt(g.up)} 漲/${osInt(g.down)} 跌/${osInt(g.flat)} 平·已成交 ${osInt(g.fresh)}/${osInt(g.n)}·方向 ${g.dir ? DIR_LABEL[g.dir] : DASH}` : DASH],
        ['S＝權值−一般股', `${osPp(c.s)}${dom ? `·判定 ${dom.rule ?? DASH}${isNum(dom.ratio) ? `（比 ${dom.ratio.toFixed(2)}）` : ''}` : ''}`],
        ['兩群成交金額（樣本，估）', value ? `權值 ${osInt(value.wYi)} 億·一般股 ${osInt(value.gYi)} 億·權值占 ${isNum(value.wSharePct) ? `${value.wSharePct.toFixed(1)}%` : DASH}（近 20 日同時刻 ${isNum(value.wShareBasePct) ? `${value.wShareBasePct.toFixed(1)}%` : DASH}）` : DASH],
        ['自開盤變化', open ? `權值 ${osPp(open.dW)}·一般股 ${osPp(open.dG)}（開盤 權值 ${osPct(open.wOpenPct)}、一般股中位 ${osPct(open.gOpenMedian)}）` : DASH],
        ['揭示時間（流動一般股）', `中位 ${t(g?.revealMed)}·p10 ${t(c.revealP10)}·p90 ${t(c.revealP90)}·檢查點 ${hm(c.T)}·寫入 ${t(c.writtenAt)}`],
      ]} />
    </Sec>
  );
}

function OpenSec({ doc }: { doc: OsDoc }) {
  const e = doc.checks.e, x = doc.eCorr;
  return (
    <Sec title="有效開盤與失真修正（09:10…10:00，10:00 後停）">
      <Kv rows={[
        ['摘要', osOpenLine(doc) ?? DASH],
        ['有效開盤 E（揭示 ≥09:02:00 第一拍）', e ? `加權 ${osPct(e.tse?.pct)}·櫃買 ${osPct(e.otc?.pct)}·上市一般股中位 ${osPct(e.gen)}` : DASH],
        ['官方開盤', e ? `${isNum(e.officialOpen) ? e.officialOpen.toLocaleString('zh-TW', { maximumFractionDigits: 2 }) : DASH}（${osPct(e.officialOpenPct)}）·個股開盤合成 ${isNum(e.oStarPct) ? `${osPct(e.oStarPct)}·差 ${osPp(e.distortPp)}${e.distorted ? '·失真' : ''}` : `${DASH}（09:02 上市市值覆蓋不足 95% 或無有效開盤，不合成）`}` : DASH],
        ['09:02 確定未成交', x?.unopened ? `${osInt(x.unopened.n)} 檔·市值 ${isNum(x.unopened.capPct) ? `${x.unopened.capPct.toFixed(2)}%` : DASH}${x.unopened.w30.length ? `·權值 ${x.unopened.w30.join('、')}` : ''}` : DASH],
        ['09:02 未掃到（不修正）', x?.unknown ? `${osInt(x.unknown.n)} 檔·市值 ${isNum(x.unknown.capPct) ? `${x.unknown.capPct.toFixed(2)}%` : DASH}` : DASH],
        ['加權修正', x?.tse.length ? x.tse.map(r => `${hm(r.T)} ${osPct(r.pct)}（${osPp(r.addPp)}·開出 ${osInt(r.nOpened)} 檔）`).join('；') : (x?.eFinal ? '免修正' : DASH)],
        ['一般股中位 E′', x?.gen.length ? x.gen.map(r => `${hm(r.T)} ${osPct(r.pp)}`).join('；') : DASH],
        ['櫃買修正', x?.otc?.status === 'uncorrected' ? '未修正（無上櫃發行股數）' : x?.otc?.status === 'ok' ? '已修正' : DASH],
      ]} />
    </Sec>
  );
}

function PatternSec({ doc }: { doc: OsDoc }) {
  const rows = (['c0920', 'c0930'] as const).flatMap(k => {
    const p = doc.checks[k];
    if (!p) return [];
    return ([['加權', p.lines.tse, true], ['櫃買', p.lines.otc, true], ['一般股中位', p.lines.gen, false]] as const)
      .map(([name, l, idx]) => ({ k, T: p.T, name, l, idx, q: p.qualifier }));
  });
  if (!rows.length) return <Sec title="盤型 09:20／09:30（三線·用有效開盤 E′）"><p className={zs.osNote}>09:20 起判讀</p></Sec>;
  return (
    <Sec title="盤型 09:20／09:30（三線·用有效開盤 E′）">
      <div className={zs.healthWrap}>
        <table className={zs.health}>
          <thead><tr><th>時點</th><th>線</th><th>盤型</th><th>跳空 Gp</th><th>自開盤 D</th><th>回補 F</th><th>有效開盤 E′</th><th>現值</th><th>限定詞</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={`${r.k}-${r.name}`}>
                <td>{hm(r.T)}</td><td>{r.name}</td>
                <td>{!r.l ? DASH : r.l.status && r.l.status !== 'ok' ? '資料不足' : (r.l.label ?? r.l.key ?? DASH)}</td>
                <td>{!r.l ? DASH : r.idx ? osPct(r.l.gp) : osPp(r.l.gp)}</td><td>{!r.l ? DASH : r.idx ? osPct(r.l.d) : osPp(r.l.d)}</td>
                <td>{r.l && isNum(r.l.f) ? `${Math.round(r.l.f * 100)}%` : DASH}</td>
                <td>{!r.l ? DASH : `${r.idx ? (isNum(r.l.eUsed) ? r.l.eUsed.toLocaleString('zh-TW', { maximumFractionDigits: 2 }) : DASH) : osPct(r.l.eUsed)}${r.l.eCorrected ? '（含修正）' : ''}`}</td>
                <td>{!r.l ? DASH : r.idx ? `${isNum(r.l.p) ? r.l.p.toLocaleString('zh-TW', { maximumFractionDigits: 2 }) : DASH}（${osPct(r.l.pPct)}）` : DASH}</td>
                <td>{r.q ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Sec>
  );
}

function MetaSec() {
  const { openSensor, now } = useWarData();
  const th = openSensor?.threshold, u = openSensor?.universe, months = osOutsideMonthRows(openSensor?.outsideStats ?? null, now);
  const st = openSensor?.outsideStats;
  return (
    <>
      <Sec title="門檻 H（區段表·同一新段連 3 日、下一交易日生效）">
        <Kv rows={[
          ['H', th ? `${osInt(th.H)} 億（區段 ${segText(th.seg)}·${th.basis ?? DASH}·生效 ${th.effectiveFrom ?? DASH}）` : DASH],
          ['近 60 日上市成交金額中位', th ? `${osInt(th.m60)} 億（${osInt(th.n)} 日；${th.from ?? DASH}～${th.to ?? DASH}）` : DASH],
          ['換段計數', th?.streak ? `段 ${segText(th.streak.seg)}·${osInt(th.streak.n)} 日${th.streak.dates.length ? `（${th.streak.dates.join('、')}）` : ''}` : DASH],
          ['資料', th ? `至 ${th.asOf ?? DASH}${th.stale ? '·未驗證沿用（stale）' : ''}${th.gaps.length ? `·缺 ${th.gaps.join('、')}` : ''}` : DASH],
        ]} />
      </Sec>
      <Sec title="名單（盤前定版·首判時存證）">
        <Kv rows={[
          ['發行股數', u ? `${u.sharesAsOf ?? DASH}（${u.sharesSrc === 'cache' ? '正快取' : u.sharesSrc === 'mirror' ? '官方鏡像' : DASH}）·市值基準 ${u.prevYmd ?? DASH} 收盤` : DASH],
          ['權值30', u ? `占上市市值 ${isNum(u.w30CapPct) ? `${u.w30CapPct.toFixed(1)}%` : DASH}·台積電 ${isNum(u.tsmcCapPct) ? `${u.tsmcCapPct.toFixed(1)}%` : DASH}${u.w30.length ? `·${u.w30.map(r => r.code).join(' ')}` : ''}` : DASH],
          ['上市流動一般股', u ? `${osInt(u.liquidN)} 檔（前一交易日 ≥ ${osInt(u.liquidMinLots)} 張）·排除 ETF ${osInt(u.excluded.etf)}、TDR ${osInt(u.excluded.tdr)}、全額交割 ${osInt(u.excluded.fullDelivery)}、分盤 ${osInt(u.excluded.split)}` : DASH],
        ]} />
      </Sec>
      <Sec title="本月「不在狀態內」（以 10:00 定格狀態計，每交易日一次）">
        {months.length ? (
          <Kv rows={months.map(r => [r.title, `${r.capped ? '至少 ' : ''}${r.month} 次${r.dates.length ? `（${r.dates.map(d => d.slice(5).replace('-', '/')).join('、')}）` : ''}·累計 ${osInt(r.total)} 次`])} />
        ) : <p className={zs.osNote}>本月尚無紀錄</p>}
        {st && <p className={zs.osNote}>量能未定 {osInt(st.pending?.n)} 次·未判定 {osInt(st.undetermined?.n)} 次（累計）</p>}
      </Sec>
    </>
  );
}

function PostSec({ doc }: { doc: OsDoc }) {
  const p = doc.post;
  if (!p) return <Sec title="盤後對官方值（15:25 後）"><p className={zs.osNote}>盤後寫入</p></Sec>;
  const marks = Object.keys({ ...p.errRatio, ...p.errSum, ...p.qMatch }).sort();
  const pctOf = (m: Record<string, number> | null, k: string) => (m && isNum(m[k]) ? `${(m[k] * 100).toFixed(1)}%` : DASH);
  const num3 = (m: Record<string, number> | null, k: string) => (m && isNum(m[k]) ? m[k].toFixed(3) : DASH);
  return (
    <Sec title={`盤後對官方值（上市成交金額 ${osInt(p.A)} 億·門檻 ${osInt(p.H)} 億·${p.label === 'big' ? '量大' : p.label === 'small' ? '量縮' : DASH}）`}>
      <div className={zs.healthWrap}>
        <table className={zs.health}>
          <thead><tr><th>時點</th><th>比率法誤差</th><th>加總法誤差</th><th>ρ 比率法</th><th>ρ 加總法</th><th>量對官方差</th></tr></thead>
          <tbody>
            {marks.map(k => (
              <tr key={k}>
                <td>{keyTime(k)}</td><td>{pctOf(p.errRatio, k)}</td><td>{pctOf(p.errSum, k)}</td>
                <td>{num3(p.rhoRatio, k)}</td><td>{num3(p.rhoSum, k)}</td><td>{pctOf(p.qMatch, k)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={zs.osNote}>兩法各自對官方同時刻累積值的相對誤差；滿 10 個交易日回報，換主估計式要使用者核可並升版</p>
    </Sec>
  );
}

export default function ZoomOpenSensor() {
  const allowed = useWarV2Allowed();
  const { openSensor, layers } = useWarData();
  if (!allowed) return <p className={zs.osNote}>僅限超級管理員</p>;
  if (!openSensor) return <p className={zs.osNote}>{layers.openSensor.failCount ? `讀取失敗·${layers.openSensor.lastError ?? ''}` : '讀取中…'}</p>;
  const doc = openSensor.doc;
  const cur = currentCheck(doc);
  return (
    <div className={zs.osWrap}>
      <p className={zs.osHead}>
        <Badge title="影子模式：只計算、只記錄，不發警示、不推播">影子·只記錄·先驗未校準</Badge>
        {' '}openSensor/{openSensor.date}{doc ? `·${doc.basis ?? DASH}·${doc.mode ?? DASH}·資料日來源 ${doc.dateSrc ?? DASH}·首判寫入 ${t(doc.writtenAt)}` : '·文件尚未存在（09:02 起首判）'}
        {doc?.cur?.final ? `·${doc.cur.finalBy === 'timeout' ? '10:05 逾時定格' : '10:00 定格'}（${t(doc.cur.frozenAt)}）` : ''}
        {openSensor.failed.length ? `·讀取失敗：${openSensor.failed.join('、')}` : ''}
      </p>
      {doc && <Sec title="檢查點（09:02 首判、09:10…10:00 每 10 分鐘複判；資料時間＝揭示時間）"><CheckTable doc={doc} /></Sec>}
      {doc && doc.trail.length > 0 && (
        <Sec title="軌跡（狀態有變才補記）">
          <p className={zs.osNote}>{doc.trail.map(x => `${hm(x.T)} ${x.kind === 'eCorr' ? (x.label ?? '有效開盤修正') : osStateText(x).short}`).join(' → ')}</p>
        </Sec>
      )}
      {doc && cur && <VolSec doc={doc} c={cur.check} ckey={cur.key} />}
      {doc && cur && <GroupsSec c={cur.check} />}
      {doc && <OpenSec doc={doc} />}
      {doc && <PatternSec doc={doc} />}
      <MetaSec />
      {doc && <PostSec doc={doc} />}
    </div>
  );
}
