'use client';

// ─────────────────────────────────────────────────────────────────────────────
// 盤中戰情 v2 外殼（2026-10-05 使用者定案；視覺唯一參考＝規畫資料夾 preview.html 的「第一階段可做」）。
// 一頁 9 個固定區塊，骨架整天不動，只有 A2「時段焦點」依時段換內容。
//   桌機（≥768）：CSS grid（WarRoomV2.module.css .grid；斷點 768／1280／1800）
//   手機（<768）：S1／S2 固定列（MobileBars）＋單欄段落（各區塊的 variant='mobile'）
// 手機與桌機是兩棵樹，只掛其中一棵（隱藏的那棵也會跑 effect，所以不用 CSS 切）。
// 全頁唯一輪詢＝WarRoomProvider 內的 useWarRoomBus；區塊元件不得自己開輪詢（快看抽屜除外）。
// ─────────────────────────────────────────────────────────────────────────────
import { WarRoomProvider, useWarData, useWarUi } from './WarRoomContext';
import { useWarAccess } from './parts/useWarAccess';
import { MOBILE_SECTION_ID } from './parts/ZoneFrame';
import ZoneCommand from './ZoneCommand';
import ZonePulse from './ZonePulse';
import ZoneAlerts from './ZoneAlerts';
import ZoneMine from './ZoneMine';
import ZoneOpportunity from './ZoneOpportunity';
import ZoneSectors from './ZoneSectors';
import ZoneLimitFlow from './ZoneLimitFlow';
import ZoneFocus from './ZoneFocus';
import ZoneFeed from './ZoneFeed';
import QuickDrawer from './QuickDrawer';
import ZoomLayer from './ZoomLayer';
import MobileBars, { type MobileSection } from './MobileBars';
import styles from './WarRoomV2.module.css';

const DISCLAIMER = '觀察工具·資料為交易所揭示與本站彙整·非投資建議';

function DeskLayout() {
  return (
    <div className={styles.grid}>
      <ZoneCommand />
      <ZonePulse />
      <ZoneAlerts />
      <ZoneMine />
      <ZoneOpportunity />
      <ZoneSectors />
      <ZoneLimitFlow />
      <ZoneFocus />
      <ZoneFeed />
    </div>
  );
}

const SEC_MINE: MobileSection = { id: MOBILE_SECTION_ID.a1 ?? 'wr-m-mine', label: '我的' };
const SEC_FOCUS: MobileSection = { id: MOBILE_SECTION_ID.a2 ?? 'wr-m-focus', label: '焦點' };
const SEC_OPP: MobileSection = { id: MOBILE_SECTION_ID.b1 ?? 'wr-m-opp', label: '機會' };
const SEC_FEED: MobileSection = { id: MOBILE_SECTION_ID.b2 ?? 'wr-m-feed', label: '異動' };
const SEC_SECTORS: MobileSection = { id: MOBILE_SECTION_ID.c1 ?? 'wr-m-sectors', label: '族群' };
const ORDER_MID: readonly MobileSection[] = [SEC_MINE, SEC_OPP, SEC_FOCUS, SEC_FEED, SEC_SECTORS];
const ORDER_DEFAULT: readonly MobileSection[] = [SEC_MINE, SEC_FOCUS, SEC_OPP, SEC_FEED, SEC_SECTORS];

function MobileLayout() {
  const { segment } = useWarData();
  // 盤中段「機會」排在「焦點」前；盤前、開盤、尾盤等其餘時段焦點在前（preview）
  const midFirst = segment === 'mid';
  return (
    <>
      <MobileBars sections={midFirst ? ORDER_MID : ORDER_DEFAULT} />
      <div className={styles.mScroll}>
        <ZoneMine variant="mobile" />
        {midFirst
          ? <><ZoneOpportunity variant="mobile" /><ZoneFocus variant="mobile" /></>
          : <><ZoneFocus variant="mobile" /><ZoneOpportunity variant="mobile" /></>}
        <ZoneFeed variant="mobile" />
        <ZoneSectors variant="mobile" />
      </div>
    </>
  );
}

function Shell() {
  const { isMobile } = useWarUi();
  return (
    <div className={isMobile ? `${styles.wr} ${styles.wrMobile}` : styles.wr}>
      {isMobile ? <MobileLayout /> : <DeskLayout />}
      <QuickDrawer variant={isMobile ? 'mobile' : 'desk'} />
      <ZoomLayer />
      <p className={styles.disclaimer}>{DISCLAIMER}</p>
    </div>
  );
}

function Lock() {
  return (
    <div className={styles.lock}>
      <div aria-hidden="true" style={{ fontSize: 'calc(28px * var(--fz))', marginBottom: 8 }}>🔒</div>
      <b>盤中戰情為高級會員功能</b>
      一頁看完大盤脈動、我的部位、盤中機會榜、即時異動、族群資金與漲停動態。
      <div style={{ marginTop: 10, fontWeight: 700, color: '#fbbf24' }}>新註冊會員可免費體驗 14 天（自註冊日起自動生效）</div>
    </div>
  );
}

export default function WarRoomV2() {
  const allowed = useWarAccess();
  if (!allowed) return <Lock />;   // 不掛 Provider ⇒ 不啟動任何輪詢
  return (
    <WarRoomProvider>
      <Shell />
    </WarRoomProvider>
  );
}
