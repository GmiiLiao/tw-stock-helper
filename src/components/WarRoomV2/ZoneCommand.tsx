'use client';

// Z0 指揮列（preview.html renderZ0）：時段膠囊｜到下個節點的倒數｜時鐘（只到分）｜資料健康燈＋彈窗｜那指期小標｜代號搜尋｜
// 專注模式｜損益遮罩｜舊版切換｜非投資建議。手機不掛（S1／面板承接，見 MobileBars）。
// 時鐘只到分、倒數保留（critique 可用性 #15：整頁不要一直在動）；那指期取自匯流排已抓的 market-index 回應（不另打請求，
// 該欄位沒有時間戳，所以不標時間——critique L3）。
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/lib/store';
import { PHASE_LABELS } from '@/lib/warroom/session';
import ZoneFrame, { type ZoneProps } from './parts/ZoneFrame';
import { Chip, MoreButton } from './parts/Chip';
import { useWarData, useWarUi } from './WarRoomContext';
import { hhmm, fmtPct, toneClass } from './parts/fmt';
import { indexView } from './TopView';
import TopSearch from './TopSearch';
import TopHealthPanel, { useTopHealth } from './TopHealth';
import styles from './WarRoomV2.module.css';
import css from './TopZones.module.css';

/** 舊版保留期限（使用者裁定第 14 題：保留 2 週，自 10/05 起算；與 page.tsx 舊版切換列同一日期） */
const CLASSIC_UNTIL = '10/19';

function Phases() {
  const { clock } = useWarData();
  const idx = clock.phaseIndex;
  if (idx < 0) return <div className={css.phases}><span className={`${css.phase} ${css.phaseNow}`}>休市</span></div>;
  return (
    <div className={css.phases} aria-label={`目前時段：${PHASE_LABELS[idx] ?? ''}`}>
      {PHASE_LABELS.map((p, i) => (
        <span key={p} className={[css.phase, i < idx ? css.phasePast : '', i === idx ? css.phaseNow : ''].filter(Boolean).join(' ')}>{p}</span>
      ))}
    </div>
  );
}

function HealthButton() {
  const view = useTopHealth();
  const { openZoom } = useWarUi();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);
  const dot = view.status === 'ok' ? css.dotOk : view.status === 'warn' ? css.dotWarn : css.dotBad;
  return (
    <span ref={wrapRef} className={css.healthWrap}>
      <button type="button" className={css.health} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(v => !v)}
        title="各資料來源本身的時間與 daemon 心跳">
        <span className={`${css.dot} ${dot}`} aria-hidden="true" />資料健康 {view.label}
      </button>
      {open && (
        <div className={css.pop} role="dialog" aria-label="資料健康">
          <div className={css.popTitle}>
            <span>資料健康（每個來源的資料時間）</span>
            <MoreButton onClick={() => { setOpen(false); openZoom('health'); }}>抓取明細 →</MoreButton>
          </div>
          <TopHealthPanel />
        </div>
      )}
    </span>
  );
}

export default function ZoneCommand({ variant = 'desk' }: ZoneProps) {
  const { clock, now, index, pulse } = useWarData();
  const { pnlMasked, togglePnlMask } = useWarUi();
  const warFocus = useAppStore(s => s.warFocus);
  const setWarFocus = useAppStore(s => s.setWarFocus);
  const setWarLayout = useAppStore(s => s.setWarLayout);
  if (variant === 'mobile') return null;   // 手機沒有指揮列（MobileBars 承接）

  const top = pulse?.top?.ok ? pulse.top.data : null;
  const nq = indexView(index, top, clock, now).nq;
  return (
    <ZoneFrame area="z0" bare label="指揮列" className={css.z0}>
      <span className={css.ttl}>盤中戰情</span>
      <Phases />
      {clock.countdown && <span className={css.countdown}>{clock.countdown}</span>}
      <span className={css.clock} title="台北時間">{hhmm(now)}</span>
      <HealthButton />
      <span className={css.spacer} />
      {nq != null && (
        <span className={css.nq} title="那斯達克 100 期貨（NQ=F），美股盤後與台股盤中仍在交易">
          那指期 <span className={`${styles.mono} ${toneClass(nq)}`}>{fmtPct(nq)}</span>
        </span>
      )}
      <TopSearch hotkey />
      <span className={css.ctl}>
        <Chip on={warFocus} onClick={() => setWarFocus(!warFocus)} title="專注模式：側欄收成圖示欄、收起網站頂列（關閉＝恢復原樣）">專注</Chip>
        <Chip on={pnlMasked} onClick={togglePnlMask} title="遮住持股損益（本機記住）">{pnlMasked ? '損益 已遮' : '損益 👁'}</Chip>
        <button type="button" className={css.ctlBtn} onClick={() => setWarLayout('classic')} title={`切回舊版盤中戰情（保留至 ${CLASSIC_UNTIL}）`}>舊版</button>
      </span>
      <span className={css.nia}>非投資建議</span>
    </ZoneFrame>
  );
}
