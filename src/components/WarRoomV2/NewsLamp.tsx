'use client';

// 新聞燈（A1 我的部位、A2 盤前新聞、快看抽屜共用）：AI 新聞識讀（媒體 M）的方向＋強弱。
//   利多紅、利空綠、中性／關注度灰、未判別／資訊不足／價格描述空心、不做個股新聞識讀「—」。
//   強弱（權重 rankMediaVerdicts：w≥0.6 強＝外圈、0.3–0.6 中＝一般、<0.3 弱＝小點）只在今日適用、非承接的判別顯示；
//   強弱同時寫在 tooltip 文字裡（不只靠圖形）。承接／前一交易日的判別加 ◆；達持股重大利空一級的加紫色 ⚠。
//   影響權重研究期·只顯示：只表強弱，不是分數、不當警示門檻（Z2 一級看規則類別，見 warroom-news.majorBearOf）。
import type { NewsLampView } from '../../../scripts/lib/warroom-news.mjs';
import type { NewsState } from './MineModel';
import styles from './WarRoomV2.module.css';
import css from './NewsLamp.module.css';

const TONE_CLASS: Record<Exclude<NewsLampView['tone'], 'na'>, string> = {
  up: styles.lampUp, dn: styles.lampDn, flat: styles.lampFlat, none: styles.lampNone,
};

function lampClass(view: NewsLampView): string {
  const tone = view.tone === 'na' ? '' : TONE_CLASS[view.tone];
  const tier = view.tier === 'strong' ? `${css.strong} ${view.tone === 'up' ? css.ringUp : css.ringDn}` : view.tier === 'weak' ? css.weak : '';
  return [styles.lamp, tone, tier].filter(Boolean).join(' ');
}

export interface NewsLampProps {
  view: NewsLampView;
  /** 達持股重大利空一級（Z2）——加紫色 ⚠ */
  major?: boolean;
}

export function NewsLamp({ view, major = false }: NewsLampProps) {
  if (view.tone === 'na') return <span className={css.na} title={view.title}>—</span>;
  const title = major ? `${view.title}·達持股重大利空一級條件（Z2）` : view.title;
  return (
    <span className={css.wrap}>
      <span className={lampClass(view)} title={title} role="img" aria-label={title} />
      {major && <span className={css.major} aria-hidden="true">⚠</span>}
      {view.old && <span className={css.old} aria-hidden="true" title={view.old}>◆</span>}
    </span>
  );
}

const UNKNOWN_TITLE = '新聞判別暫時讀不到';

/** A1 列的新聞燈（尚未載入不畫；讀不到畫空心並註明） */
export function NewsCellLamp({ news }: { news: NewsState }) {
  if (news == null) return null;
  if (news === 'unknown') {
    return <span className={css.wrap}><span className={`${styles.lamp} ${styles.lampNone}`} title={UNKNOWN_TITLE} role="img" aria-label={UNKNOWN_TITLE} /></span>;
  }
  return <NewsLamp view={news.view} major={news.mb?.level === 1} />;
}
