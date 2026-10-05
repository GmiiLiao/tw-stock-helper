'use client';

// 手機（<768）頂部兩條固定列（preview.html renderPhone 的 .s1／.s2）：
//   S1 摘要列（56px，取代網站頂列）：盤勢燈｜加權值與%｜櫃買%｜健康點｜一級警示計數點；第二行 漲跌比例條｜漲停/跌停｜時間
//      點一下展開「完整大盤卡」面板：一級警示（可按收到）、大盤脈動 4 塊、專注／損益遮罩／舊版、代號搜尋、資料健康明細
//   S2 區段跳轉列（40px）：依 sections 順序（我的・焦點・機會・異動・族群；盤中段機會在焦點前），點了捲到段落、不切分頁；
//      目前所在段落高亮（IntersectionObserver）；「我的」帶持股＋釘選檔數。
// 手機沒有 Z0／Z2：指揮列與警示帶的功能都在這裡承接；一級事件引擎也掛在這裡（桌機掛在 ZoneAlerts，兩棵樹擇一）。
// 不用 <nav>：Navbar 的字級套用以 document.querySelector('nav') 取第一個 nav（基礎 agent 備註）。
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/lib/store';
import { useWarData, useWarUi } from './WarRoomContext';
import { useTopState } from './TopStore';
import { useTopAlertEngine, useLevel1, ackTopEvent } from './TopAlertEngine';
import TopHealthPanel, { useTopHealth } from './TopHealth';
import { MOBILE_SECTION_ID } from './parts/ZoneFrame';
import TopSearch from './TopSearch';
import ZonePulse, { LAMP_CLASS } from './ZonePulse';
import { Chip } from './parts/Chip';
import { nearStopText, calmText } from './ZoneAlerts';
import { indexView, pulseView, ratioWidths, fmtIndex } from './TopView';
import { fmtInt, fmtPct, hhmm, hhmmss, toneClass } from './parts/fmt';
import styles from './WarRoomV2.module.css';
import css from './TopZones.module.css';

export interface MobileSection {
  /** 段落 DOM id（ZoneFrame 的 MOBILE_SECTION_ID） */
  id: string;
  /** 跳轉列文字：我的／焦點／機會／異動／族群 */
  label: string;
}

export interface MobileBarsProps {
  sections: readonly MobileSection[];
}

/** 段落在固定列下方時才算「目前」：上緣扣掉 S1＋S2（96px） */
const OBSERVER_MARGIN = '-104px 0px -55% 0px';

function jumpTo(id: string) {
  const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
  if (!el) return;
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

/** 目前在畫面上方的段落 id（段落還沒掛好時回 null） */
function useActiveSection(ids: readonly string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  const key = ids.join('|');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const list = key ? key.split('|') : [];
    const visible = new Map<string, boolean>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) visible.set(e.target.id, e.isIntersecting);
      const first = list.find(id => visible.get(id));
      if (first) setActive(first);
    }, { rootMargin: OBSERVER_MARGIN, threshold: 0 });
    // 段落由各區塊自己畫，可能晚一拍掛上：下一個 frame 再找一次
    const raf = requestAnimationFrame(() => {
      for (const id of list) { const el = document.getElementById(id); if (el) io.observe(el); }
    });
    return () => { cancelAnimationFrame(raf); io.disconnect(); };
  }, [key]);
  return active;
}

function AlertsBlock() {
  const { segment, pulse } = useWarData();
  const { danger, nearStop, nearStopKnown, holdingCount } = useTopState();
  const { list, danger: dangerEvent } = useLevel1();
  if (!list.length) {
    return <div className={css.calm}>{calmText(segment, danger, true, holdingCount, pulse?.top?.asOf ?? null)}</div>;
  }
  return (
    <>
      {list.map(e => {
        const isDanger = e.id === dangerEvent?.id;
        const near = isDanger ? nearStopText(nearStop, holdingCount, nearStopKnown) : '';
        return (
          <div key={e.id} className={`${css.alertCard} ${isDanger ? css.alertCardDanger : ''}`} role="alert">
            <div>
              <div className={isDanger ? undefined : styles.muted}>{isDanger ? '⚠ 一級' : '一級'}·<span className={styles.mono}>{hhmmss(e.at)}</span></div>
              <b>{e.text}</b>
              {near && <div>{near}</div>}
            </div>
            <button type="button" className={css.ackBtn} onClick={() => { void ackTopEvent(e.id); }}>收到</button>
          </div>
        );
      })}
    </>
  );
}

function Panel() {
  const { pnlMasked, togglePnlMask } = useWarUi();
  const warFocus = useAppStore(s => s.warFocus);
  const setWarFocus = useAppStore(s => s.setWarFocus);
  const setWarLayout = useAppStore(s => s.setWarLayout);
  return (
    <div className={css.panel} role="dialog" aria-label="大盤摘要與設定">
      <section className={css.panelSec} aria-label="一級警示">
        <div className={css.panelTitle}>一級警示</div>
        <AlertsBlock />
      </section>
      <section className={css.panelSec} aria-label="大盤脈動">
        <div className={css.panelTitle}>大盤脈動</div>
        <ZonePulse variant="mobile" />
      </section>
      <section className={`${css.panelSec} ${css.panelSearch}`} aria-label="代號搜尋">
        <TopSearch placeholder="搜尋代號或名稱" />
      </section>
      <section className={css.panelSec} aria-label="顯示設定">
        <div className={css.ctlRow}>
          <Chip on={warFocus} onClick={() => setWarFocus(!warFocus)} title="專注模式：收起網站頂列（關閉＝恢復原樣）">專注模式</Chip>
          <Chip on={pnlMasked} onClick={togglePnlMask} title="遮住持股損益（本機記住）">{pnlMasked ? '損益 已遮' : '損益 👁'}</Chip>
          <button type="button" className={css.ctlBtn} onClick={() => setWarLayout('classic')}>切回舊版</button>
        </div>
      </section>
      <section className={css.panelSec} aria-label="資料健康">
        <div className={css.panelTitle}>資料健康</div>
        <TopHealthPanel />
      </section>
      <div className={css.hNote}>觀察工具·非投資建議</div>
    </div>
  );
}

export default function MobileBars({ sections }: MobileBarsProps) {
  useTopAlertEngine();
  const { index, pulse, clock, now } = useWarData();
  const { pinned } = useWarUi();
  const holdings = useAppStore(s => s.holdings);
  const { danger } = useTopState();
  const { list, danger: dangerEvent } = useLevel1();
  const health = useTopHealth();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const active = useActiveSection(sections.map(s => s.id));

  // Esc 或點面板外收起
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: PointerEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown); };
  }, [open]);

  const top = pulse?.top?.ok ? pulse.top.data : null;
  const iv = indexView(index, top, clock, now);
  const pv = pulseView(top, index, clock, now, danger.active);
  const widths = pv.breadth ? ratioWidths(pv.breadth) : null;
  const dot = health.status === 'ok' ? css.dotOk : health.status === 'warn' ? css.dotWarn : css.dotBad;
  const alertCls = dangerEvent ? css.alertDotDanger : list.length ? '' : css.alertDotNone;
  const alertText = dangerEvent ? `⚠${list.length}` : String(list.length);
  // 「我的」段＝持股＋當日釘選（同代號只算一次）
  const mineCount = new Set([...holdings.map(h => h.code), ...pinned]).size;

  return (
    <div className={styles.mBars}>
      <div ref={wrapRef} className={css.s1Wrap}>
        <button type="button" className={css.s1} aria-expanded={open} aria-label="大盤摘要（點開看完整大盤、警示與設定）" onClick={() => setOpen(v => !v)}>
          <span className={css.s1Row}>
            <span className={`${css.miniLamp} ${LAMP_CLASS[pv.tone]}`} role="img" aria-label={`盤勢燈 ${pv.label}`}>{pv.tone === 'danger' ? '⚠' : ''}</span>
            <span className={styles.mono}>
              <b>{fmtIndex(iv.twii.value)}</b>{' '}
              {iv.prev ? <span className={styles.muted}>◆收盤</span> : <span className={toneClass(iv.twii.pct)}>{fmtPct(iv.twii.pct)}</span>}
            </span>
            <span className={`${styles.mono} ${css.s1Small}`}>
              櫃 {iv.prev ? '—' : <span className={toneClass(iv.otc.pct)}>{fmtPct(iv.otc.pct)}</span>}
            </span>
            <span className={css.s1Grow} />
            <span className={`${css.dot} ${dot}`} title={`資料健康 ${health.label}`} aria-label={`資料健康 ${health.label}`} role="img" />
            <span className={`${css.alertDot} ${alertCls}`} aria-label={`一級警示 ${list.length} 則`}>{alertText}</span>
          </span>
          <span className={css.s1Row}>
            <span className={css.s1Grow}>
              {widths ? (
                <span className={css.s1Ratio} role="img" aria-label={`上漲 ${pv.breadth?.up}、下跌 ${pv.breadth?.down}`}>
                  <i className={css.rUp} style={{ width: `${widths[0]}%` }} />
                  <i className={css.rFlat} style={{ width: `${widths[1]}%` }} />
                  <i className={css.rDn} style={{ width: `${widths[2]}%` }} />
                </span>
              ) : <span className={css.s1Small}>{pv.preOpen ? '家數待開盤' : '家數 —'}</span>}
            </span>
            <span className={`${styles.mono} ${css.s1Small}`}>
              {pv.limits ? <><span className={styles.up}>停 {fmtInt(pv.limits.lu)}</span>/<span className={styles.dn}>{fmtInt(pv.limits.ld)}</span></> : '—'}
            </span>
            <span className={css.s1Small}>{hhmm(now)}</span>
          </span>
        </button>
        {open && <Panel />}
      </div>
      <div className={styles.mS2} role="navigation" aria-label="區段跳轉">
        {sections.map((s) => (
          <button
            key={s.id}
            type="button"
            className={s.id === active ? `${styles.mS2Item} ${styles.mS2On}` : styles.mS2Item}
            aria-current={s.id === active ? 'location' : undefined}
            onClick={() => { setOpen(false); jumpTo(s.id); }}
          >
            {s.label}
            {s.id === MOBILE_SECTION_ID.a1 && mineCount > 0 && <span className={styles.mS2Count}>{mineCount}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
