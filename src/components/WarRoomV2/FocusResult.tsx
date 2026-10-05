'use client';

// A2 收盤後：「今日結果」（13:30–13:45 定價）與「盤後」（13:45 後、非交易日、交易日 08:30 前）。
//   大盤收盤摘要（匯流排指數：加權、櫃買、成交值）＋持股今日漲跌摘要（匯流排報價；只列漲跌%，不重算損益——損益在「我的部位」）
//   ＋連到盤後報告（市場總覽·盤後報告分頁）與盤前備課頁。
// 另含「收盤競價」（13:25–13:30）：第一階段只顯示「收盤集合競價中·13:30 揭示後更新」（試撮看板＝2 期）。
import { useMemo, type ReactNode } from 'react';
import { useAppStore } from '@/lib/store';
import { useWarData } from './WarRoomContext';
import Stamp from './parts/Stamp';
import { fmtArrowChange, fmtPct, fmtYi, toneClass } from './parts/fmt';
import { FocusFrame, FocusMsg, CodeLink, type FocusShell } from './FocusFrame';
import { useFocusUniverse } from './useFocusUniverse';
import { indexAsOf } from './TopView';
import styles from './WarRoomV2.module.css';
import css from './ZoneFocus.module.css';

const LIST_DESK = 4;
const LIST_MOBILE = 3;

function goReport() {
  const s = useAppStore.getState();
  s.setDashTab('report');
  s.navigateTo('dashboard');
}
function goPrep() {
  useAppStore.getState().navigateTo('prep');
}

function Line({ label, mobile, children }: { label: string; mobile: boolean; children: ReactNode }) {
  return (
    <div className={css.line}>
      <span className={css.lineLab}>{label}</span>
      <span className={mobile ? css.lineBodyM : css.lineBody}>{children}</span>
    </div>
  );
}

export function FocusResultView({ shell, kind }: { shell: FocusShell; kind: 'result' | 'after' }) {
  const { index, quotes } = useWarData();
  const u = useFocusUniverse();
  const mobile = shell.variant === 'mobile';

  const mine = useMemo(() => {
    const rows = u.holdings.map((code) => {
      const q = quotes[code];
      const chg = q && q.price > 0 && Number.isFinite(q.changePercent) ? q.changePercent : null;
      return { code, chg };
    });
    const known = rows.filter((r) => r.chg != null);
    return {
      up: known.filter((r) => (r.chg as number) > 0).length,
      dn: known.filter((r) => (r.chg as number) < 0).length,
      flat: known.filter((r) => r.chg === 0).length,
      missing: rows.length - known.length,
      top: known.slice().sort((a, b) => Math.abs(b.chg as number) - Math.abs(a.chg as number)).slice(0, mobile ? LIST_MOBILE : LIST_DESK),
      n: rows.length,
    };
  }, [u.holdings, quotes, mobile]);

  const idxOk = index && index.weighted > 0;
  const body = (
    <>
      <Line label="大盤" mobile={mobile}>
        {idxOk ? (
          <>
            <span className={css.item}>加權 <b className={styles.mono}>{index.weighted.toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
              <span className={`${styles.mono} ${toneClass(index.weightedChange)}`}>{fmtArrowChange(index.weightedChange)} {fmtPct(index.weightedChangePercent)}</span></span>
            {index.otc != null && index.otc > 0 && (
              <span className={css.item}>櫃買 <b className={styles.mono}>{index.otc.toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
                <span className={`${styles.mono} ${toneClass(index.otcChange ?? null)}`}>{fmtArrowChange(index.otcChange ?? null)} {fmtPct(index.otcChangePercent ?? null)}</span></span>
            )}
            {index.value != null && index.value > 0 && <span className={css.item}>成交值 <span className={styles.mono}>{fmtYi(index.value)}</span></span>}
          </>
        ) : <span className={styles.muted}>指數資料尚未取得</span>}
      </Line>
      <Line label="我的持股" mobile={mobile}>
        {!mine.n ? <span className={styles.muted}>尚無持股</span> : (
          <>
            <span className={css.item}>
              <span className={styles.up}>上漲 {mine.up}</span>·<span className={styles.dn}>下跌 {mine.dn}</span>·<span className={styles.flat}>平盤 {mine.flat}</span>
              {mine.missing > 0 && <span className={styles.muted}>·無報價 {mine.missing}</span>}
            </span>
            {mine.top.map((r) => (
              <span key={r.code} className={css.item}>
                <CodeLink code={r.code} mobile={mobile} /><span className={styles.name}>{u.nameOf(r.code)}</span>
                <span className={`${styles.mono} ${toneClass(r.chg)}`}>{fmtPct(r.chg)}</span>
              </span>
            ))}
          </>
        )}
      </Line>
      <div className={css.actions}>
        <button type="button" className={[css.actBtn, mobile ? css.actBtnM : ''].join(' ')} onClick={goReport}>🌙 盤後報告 →</button>
        <button type="button" className={[css.actBtn, mobile ? css.actBtnM : ''].join(' ')} onClick={goPrep}>📋 盤前備課 →</button>
      </div>
    </>
  );
  return (
    <FocusFrame
      shell={shell}
      kind={kind}
      stamp={<Stamp kind="index" asOf={indexAsOf(index)} />}
      foot="收盤價以交易所揭示為準·持股損益見「我的部位」·非投資建議"
    >
      {body}
    </FocusFrame>
  );
}

export function FocusAuctionView({ shell }: { shell: FocusShell }) {
  const { index } = useWarData();
  return (
    <FocusFrame
      shell={shell}
      kind="auction"
      stamp={<Stamp kind="index" asOf={indexAsOf(index)} />}
      foot="試撮指示價可能不成交·收盤狀態等揭示時間 ≥13:30 才切換"
    >
      <FocusMsg big="收盤集合競價中·13:30 揭示後更新">13:25–13:30 集合競價不逐筆成交，畫面價格為試撮指示價</FocusMsg>
    </FocusFrame>
  );
}
