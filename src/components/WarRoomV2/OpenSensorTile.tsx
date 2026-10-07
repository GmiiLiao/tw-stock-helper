'use client';

// Z1 第 5 塊「開盤結構」（開盤感應器 openSensor-v2.1·影子；只有超管看得到——資料走匯流排影子層 /api/admin/open-sensor）。
// 版面（規格 v2.1 §9.2）：第一行 燈＋狀態名（①–⑥ 帶「（量為估計）」）＋標章「影子·只記錄·先驗未校準」＋資料（揭示）時間；
//   之後依序：軌跡（09:10 起）｜權值30 與上市一般股事實｜上市成交金額（估）與同時段門檻、量大／量縮｜上市成交量（實，萬張）｜
//   有效開盤與失真、修正時間｜09:20／09:30 盤型。桌機 ≥1280 區塊高度固定 ⇒ 每行單行省略（滑過看全文、「明細 →」看放大層）；
//   較窄版面與手機面板改折行全文顯示。
// 影子：不產生任何 Z2／B2 事件、不推播、不寫站內訊息（這個元件只讀匯流排）。文字只描述事實；不顯示命中率、勝率。
import { useWarData, useWarUi } from './WarRoomContext';
import { Badge } from './parts/Badge';
import { MoreButton } from './parts/Chip';
import { openSensorView, type OpenSensorView } from '../../../scripts/lib/warroom-open-sensor-view.mjs';
import css from './TopZones.module.css';

const LAMP: Readonly<Record<OpenSensorView['lamp'], string>> = {
  red: css.osLampRed, green: css.osLampGreen, neutral: css.osLampNeutral, gray: css.osLampGray, none: css.osLampNone,
};
const LAMP_LABEL: Readonly<Record<OpenSensorView['lamp'], string>> = {
  red: '紅燈（漲）', green: '綠燈（跌）', neutral: '中性燈', gray: '灰燈', none: '尚無燈號',
};

const join = (...parts: (string | null)[]) => parts.filter(Boolean).join('｜') || null;

function Line({ text, muted }: { text: string | null; muted?: boolean }) {
  if (!text) return null;
  return <div className={muted ? `${css.osLine} ${css.osMuted}` : css.osLine} title={text}>{text}</div>;
}

export default function OpenSensorTile({ variant }: { variant: 'desk' | 'mobile' }) {
  const { openSensor, layers, now } = useWarData();
  const { openZoom } = useWarUi();
  const v = openSensorView(openSensor, now);
  const failMsg = !openSensor && layers.openSensor.failCount > 0 ? `讀取失敗·重試中（${layers.openSensor.lastError ?? '—'}）` : null;
  const when = v.prevLabel ?? (v.dataT ? `資料 ${v.dataT}` : null);
  // 桌機單行：事實｜量（估）＋量（實）｜有效開盤＋盤型；量未定的候選、未判定原因、首判前門檻放在 note
  const lineFacts = v.facts ?? (v.phase === 'ok' ? null : v.note);
  const lineVol = join(v.vol, v.volReal, v.phase === 'ok' && v.facts ? v.note : null);
  const lineOpen = join(v.open, v.pattern);
  const undetermined = v.phase === 'ok' && !v.facts ? v.note : null;

  return (
    <div className={`${css.tile} ${css.tileWide} ${css.osTile} ${variant === 'mobile' ? css.osWrap : ''}`} aria-label="開盤結構（影子）">
      <div className={css.lab}>
        <span>開盤結構 <Badge title="影子模式：只計算、只記錄，不發警示、不推播；門檻與估計式未校準">{v.badge}</Badge></span>
        <span className={css.osWhen}>
          {when}
          <MoreButton onClick={() => openZoom('openSensor')}>明細 →</MoreButton>
        </span>
      </div>
      <div className={css.osHead}>
        <i className={`${css.osLamp} ${LAMP[v.lamp]}`} role="img" aria-label={LAMP_LABEL[v.lamp]} />
        <b className={css.osTitle}>{failMsg ?? v.title}</b>
        {v.trail && <span className={css.osTrail} title={v.trail}>{v.trail}</span>}
      </div>
      <Line text={undetermined ?? lineFacts} muted={v.phase !== 'ok'} />
      <Line text={lineVol} />
      <Line text={lineOpen} />
    </div>
  );
}
