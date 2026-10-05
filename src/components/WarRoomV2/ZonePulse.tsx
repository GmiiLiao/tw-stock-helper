'use client';

// Z1 大盤脈動列（preview.html renderZ1）：4 塊——盤勢燈＋一句事實｜加權與櫃買（快層 index）＋成交值｜漲跌家數比例條｜漲停跌停。
// 家數口徑只用 marketPulse/latest（build-top）；盤前「待開盤」不顯示 0；期望只寫「全日均 N（非同時刻）」不顯示比值（critique H1）；
// 成交值只寫當日累積（上市／上櫃分列；與昨日的比值待同口徑基準，見 TopView）。每塊一個主值＋一行副資訊（critique 可用性 #20），其餘放健康彈窗。
// variant='mobile'：WarRoomV2 手機樹不掛 Z1；手機 S1 展開面板以 2×2 塊重用這裡（MobileBars）。
import ZoneFrame, { type ZoneProps } from './parts/ZoneFrame';
import Stamp from './parts/Stamp';
import { Indicative } from './parts/Badge';
import { MoreButton } from './parts/Chip';
import { useWarData, useWarUi } from './WarRoomContext';
import { useTopState } from './TopStore';
import { fmtArrowChange, fmtInt, fmtPct, toneClass } from './parts/fmt';
import { fmtIndex, indexView, pulseView, ratioWidths, type IndexRow, type PulseLampTone } from './TopView';
import styles from './WarRoomV2.module.css';
import css from './TopZones.module.css';

export const LAMP_CLASS: Record<PulseLampTone, string> = {
  up: css.lampUp, dn: css.lampDn, flat: css.lampFlat, danger: css.lampDanger,
};

function IndexLine({ row, prev, indicative }: { row: IndexRow; prev: boolean; indicative: boolean }) {
  const value = fmtIndex(row.value);
  if (prev) {
    return <div className={css.row2}><span className={css.idxLab}>{row.label}</span><b>{value}</b> <span className={styles.muted}>◆收盤</span></div>;
  }
  return (
    <div className={css.row2}>
      <span className={css.idxLab}>{row.label}</span>
      <b>{indicative && row.value != null ? <Indicative>{value}</Indicative> : value}</b>{' '}
      <span className={toneClass(row.change)}>{fmtArrowChange(row.change)} {fmtPct(row.pct)}</span>
    </div>
  );
}

export default function ZonePulse({ variant = 'desk' }: ZoneProps) {
  const { index, pulse, clock, now } = useWarData();
  const { openZoom } = useWarUi();
  const { danger } = useTopState();
  const topSec = pulse?.top;
  const top = topSec?.ok ? topSec.data : null;
  const iv = indexView(index, top, clock, now);
  const pv = pulseView(top, index, clock, now, danger.active);
  const widths = pv.breadth ? ratioWidths(pv.breadth) : null;
  const lampText = pv.tone === 'danger' ? <><span aria-hidden="true">⚠</span><span>危險</span></> : pv.label;
  const failMsg = topSec && !topSec.ok ? topSec.error : null;
  const noData = !pulse ? '讀取中' : failMsg ? `家數${failMsg}` : '家數資料尚未產生';

  const tiles = (
    <>
      <div className={`${css.tile} ${css.tilePulse}`}>
        <div className={`${css.bigLamp} ${LAMP_CLASS[pv.tone]}`} role="img" aria-label={`盤勢燈 ${pv.label}`}>{lampText}</div>
        <div className={css.tileBody}>
          <div className={css.lab}><span>盤勢燈·盤型 {pv.pattern}</span></div>
          <div className={css.fact}>{!top && !pv.preOpen ? noData : pv.fact}</div>
        </div>
      </div>

      <div className={css.tile}>
        <div className={css.lab}><span>加權／櫃買</span><Stamp kind="index" asOf={iv.asOf} /></div>
        <IndexLine row={iv.twii} prev={iv.prev} indicative={iv.indicative} />
        <IndexLine row={iv.otc} prev={iv.prev} indicative={iv.indicative} />
        <div className={css.sub} title="上市＝加權指數、上櫃＝櫃買指數的累積成交金額（交易所揭示）；與昨日的比較待同口徑基準（第二階段）">{iv.amount}</div>
      </div>

      <div className={css.tile}>
        <div className={css.lab}>
          <span>漲跌家數</span>
          <MoreButton onClick={() => openZoom('risefall')}>分布 →</MoreButton>
          <Stamp kind="list" asOf={pv.asOf} openOnly />
        </div>
        {pv.breadth ? (
          <>
            <div className={css.row2}>
              <span className={styles.up}>漲 {fmtInt(pv.breadth.up)}</span>　<span className={styles.flat}>平 {fmtInt(pv.breadth.flat)}</span>　<span className={styles.dn}>跌 {fmtInt(pv.breadth.down)}</span>
            </div>
            {widths && (
              <div className={css.ratio} role="img" aria-label={`上漲 ${pv.breadth.up}、平盤 ${pv.breadth.flat}、下跌 ${pv.breadth.down}`}>
                <i className={css.rUp} style={{ width: `${widths[0]}%` }} />
                <i className={css.rFlat} style={{ width: `${widths[1]}%` }} />
                <i className={css.rDn} style={{ width: `${widths[2]}%` }} />
              </div>
            )}
            <div className={css.sub}>{pv.breadth.sub}</div>
          </>
        ) : (
          <>
            <div className={`${css.big} ${css.bigMuted}`}>{pv.preOpen ? '待開盤' : '—'}</div>
            <div className={css.sub}>{pv.preOpen ? '09:00 起依揭示更新' : noData}</div>
          </>
        )}
      </div>

      <div className={css.tile}>
        <div className={css.lab}><span>漲停／跌停</span><Stamp kind="list" asOf={pv.asOf} openOnly /></div>
        {pv.limits ? (
          <>
            <div className={css.big}><span className={styles.up}>漲停 {fmtInt(pv.limits.lu)}</span>　<span className={styles.dn}>跌停 {fmtInt(pv.limits.ld)}</span></div>
            <div className={css.sub} title={pv.limits.subTitle}>{pv.limits.sub}</div>
          </>
        ) : (
          <>
            <div className={`${css.big} ${css.bigMuted}`}>{pv.preOpen ? '待開盤' : '—'}</div>
            <div className={css.sub}>
              {!pv.preOpen ? noData
                : pv.prevLimits ? `◆ 前交易日 ${pv.prevLimits.date} 漲停 ${fmtInt(pv.prevLimits.lu)}·跌停 ${fmtInt(pv.prevLimits.ld)}`
                  : '09:00 起依揭示更新'}
            </div>
          </>
        )}
      </div>
    </>
  );

  if (variant === 'mobile') return <div className={css.mobileTiles}>{tiles}</div>;
  return (
    <ZoneFrame area="z1" bare label="大盤脈動" className={css.z1}>
      {tiles}
    </ZoneFrame>
  );
}
