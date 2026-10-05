'use client';

// A2 開盤段「開盤三關」（09:00–09:30；資料提供到 10:00，09:30 後為定格值）：逐檔列持股與候選。
//   ① 前段量÷昨量（今日累計量 ÷ 前一交易日總量；門檻 40%·待驗證，只顯示比率不標過關）
//   ② 相對大盤（個股漲跌 − 加權漲跌；分類與問 AI 三關同口徑；僅日線代理驗證）
//   ③ 現價相對 VWAP（daemon 取樣近似；待驗證）
// 資料：pulse.focus.gates（全市場 4 碼普通股的欄式編碼；路由不帶個人參數，挑持股與候選在這裡做）。
import { useMemo, type ReactNode } from 'react';
import { decodeGateRows, gateRsLabel, focusPartActive, FOCUS_WINDOW, GATE1_THRESHOLD_PCT } from '../../../scripts/lib/warroom-focus-codec.mjs';
import type { Section } from '@/lib/warroom/types';
import type { FocusData } from '@/lib/warroom/build-focus';
import { useWarData, useWarUi } from './WarRoomContext';
import Stamp from './parts/Stamp';
import { Badge } from './parts/Badge';
import { fmtPct, toneClass, hhmm } from './parts/fmt';
import { FocusFrame, FocusMsg, CodeLink, type FocusShell } from './FocusFrame';
import { useFocusUniverse } from './useFocusUniverse';
import styles from './WarRoomV2.module.css';
import css from './ZoneFocus.module.css';

const ROWS_DESK = 6;
const ROWS_MOBILE = 5;

interface GateView {
  code: string;
  src: '持股' | '候選';
  ratio: string;
  /** 漲跌 %（live＝即時；frozen＝09:30 定格） */
  chg: number | null;
  rs: { text: string; tone: number | null };
  vw: string;
}

function viewOf(code: string, src: GateView['src'], m: ReturnType<typeof decodeGateRows>, idxChg: number | null): GateView {
  const g = m.get(code);
  if (!g) {
    const why = code.startsWith('00') || code.length > 4 ? '不適用' : '無成交';
    return { code, src, ratio: why, chg: null, rs: { text: '—', tone: null }, vw: '—' };
  }
  const rs = gateRsLabel(g.chg, idxChg);
  return {
    code,
    src,
    ratio: g.ratio == null ? '—' : `${g.ratio}%`,
    chg: g.chg,
    rs: rs ? { text: `${rs.rs > 0 ? '+' : rs.rs < 0 ? '−' : ''}${Math.abs(rs.rs).toFixed(1)} ${rs.label}`, tone: rs.rs } : { text: '—', tone: null },
    vw: g.vw === 1 ? '站上' : g.vw === 0 ? '在下' : '—',
  };
}

export default function FocusGates({ shell, focus }: { shell: FocusShell; focus: Section<FocusData> | null | undefined }) {
  const { clock, segment } = useWarData();
  const { openDrawer } = useWarUi();
  const u = useFocusUniverse();
  const mobile = shell.variant === 'mobile';
  const part = focus?.ok ? focus.data.gates : undefined;
  const g = part && part.ok ? part.data : null;
  const map = useMemo(() => decodeGateRows(g?.rows), [g]);

  const pool = useMemo<Array<{ code: string; src: GateView['src'] }>>(
    () => [...u.holdings.map((code) => ({ code, src: '持股' as const })), ...u.candidates.map((code) => ({ code, src: '候選' as const }))],
    [u.holdings, u.candidates],
  );
  const max = mobile ? ROWS_MOBILE : ROWS_DESK;
  const views = useMemo(() => pool.slice(0, max).map((x) => viewOf(x.code, x.src, map, g?.idxChg ?? null)), [pool, max, map, g]);

  const modeText = g ? (g.mode === 'frozen' ? `09:30 定格${g.t0930 ? `（${hhmm(g.t0930)} 擷取）` : ''}` : '即時累計') : '';
  const foot = `${modeText ? `${modeText}·` : ''}①③ 待驗證·② 僅日線代理驗證${g?.prevDate ? `·昨量 ${g.prevDate.slice(5).replace('-', '/')}` : ''}${pool.length > max ? `·另 ${pool.length - max} 檔未列` : ''}`;

  let body: ReactNode;
  if (!focus) body = <FocusMsg big="載入中…" />;
  else if (!focus.ok) body = <FocusMsg big={focus.error} />;
  else if (!part) {
    const active = focusPartActive('gates', clock.minute, segment !== 'nontrading');
    body = active
      ? <FocusMsg big="資料更新中">每 30 秒更新一次</FocusMsg>
      : <FocusMsg big={`開盤三關於 ${FOCUS_WINDOW.gates.label} 提供`}>09:30 前為即時累計、之後為 09:30 定格</FocusMsg>;
  } else if (!part.ok) body = <FocusMsg big={part.error} />;
  else if (!pool.length) body = <FocusMsg big="尚無持股與候選">逐檔檢查的對象＝持股＋「＋候選」加入的個股</FocusMsg>;
  else if (mobile) {
    body = views.map((v) => (
      <div key={v.code} className={styles.card} role="button" tabIndex={0} onClick={() => openDrawer(v.code)} onKeyDown={(e) => { if (e.key === 'Enter') openDrawer(v.code); }}>
        <div className={styles.cardA}>
          <CodeLink code={v.code} mobile /><span className={styles.name}>{u.nameOf(v.code)}</span><Badge>{v.src === '持股' ? '持' : '候'}</Badge>
          <span className={`${styles.cardPx} ${toneClass(v.chg)}`}>{fmtPct(v.chg)}</span>
        </div>
        <div className={styles.cardB}>
          <span>①量比 {v.ratio}</span>
          <span className={v.rs.tone != null ? toneClass(v.rs.tone) : ''}>②{v.rs.text}</span>
          <span>③{v.vw}</span>
        </div>
      </div>
    ));
  } else {
    body = (
      <table className={`${styles.table} ${css.tbl}`}>
        <thead>
          <tr>
            <th className={`${css.gStock} ${css.txtL}`}>個股</th>
            <th className={css.gCol} title={`今日${g?.mode === 'frozen' ? '前 30 分' : '累計'}成交量 ÷ 前一交易日總量；方法論門檻 ${GATE1_THRESHOLD_PCT}%（待驗證·不計分）`}>①前段量÷昨量</th>
            <th className={css.gRs} title={`個股漲跌 − 加權漲跌（大盤 ${fmtPct(g?.idxChg ?? null)}）；漲 ≥3% 但 RS <1＝跟風、RS ≥2＝自己強`}>②相對大盤</th>
            <th className={css.gVw} title="現價相對 VWAP（daemon 取樣近似；覆蓋不足時不給值）">③站回 VWAP</th>
          </tr>
        </thead>
        <tbody>
          {views.map((v) => (
            <tr key={v.code} className={styles.row} onClick={() => openDrawer(v.code)}>
              <td className={css.txtL}>
                <CodeLink code={v.code} /> <span className={styles.name}>{u.nameOf(v.code)}</span>
                <span className={css.srcTag}><Badge title={v.src}>{v.src === '持股' ? '持' : '候'}</Badge></span>
              </td>
              <td>{v.ratio}</td>
              <td className={`${css.txtR} ${v.rs.tone != null ? toneClass(v.rs.tone) : ''}`}>{v.rs.text}</td>
              <td className={css.txtR}>{v.vw}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <FocusFrame shell={shell} kind="gates" stamp={<Stamp kind="list" asOf={part && part.ok ? part.asOf : null} openOnly />} foot={foot}>
      {body}
    </FocusFrame>
  );
}
