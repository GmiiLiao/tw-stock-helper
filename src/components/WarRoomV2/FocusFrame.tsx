'use client';

// A2 時段焦點的共用外框與標題列控制：📌 釘選、切換 ▾（手動切換／自動）、換內容前 60 秒提示、代號連結、置中訊息。
// 外框一律藍框強調（A2 永遠 emphasis）。
// 版面取捨（本機渲染夾具量過）：A2 桌機寬約 334–603px，標題＋兩顆 chip＋資料章已接近滿列——
//   ① 切換選單與 60 秒提示都放在標題列正下方的內容區頂端（標題列 .zx 會裁切溢出，放不下）；
//   ② <1800px 標題省略「時段焦點·」前綴、尾盤用短標；<1100px 釘選鈕只留 📌（aria-label 仍是「釘選」）；
//   ③ 手動切換中（未釘選）切換鈕呈點亮狀態，選單第一項可回到自動。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAppStore } from '@/lib/store';
import { warSegment } from '@/lib/warroom/session';
import { FOCUS_KINDS, FOCUS_LABEL, focusForSegment, type FocusKind } from '@/lib/warroom/focus-kinds';
import ZoneFrame, { type ZoneVariant } from './parts/ZoneFrame';
import { useWarData, useWarUi } from './WarRoomContext';
import styles from './WarRoomV2.module.css';
import css from './ZoneFocus.module.css';

/** 換內容前多久開始提示（使用者裁定：60 秒） */
const SWITCH_HINT_MS = 60_000;

/** 窄欄用的短標（只有尾盤的全名太長） */
const SHORT_LABEL: Partial<Record<FocusKind, string>> = { tail: '撿尾盤＋當沖' };

export interface FocusShell {
  variant: ZoneVariant;
  /** 標題列右側：📌 釘選、切換 ▾ */
  extra: ReactNode;
  /** 切換選單（開著才有；疊在內容區最上層） */
  menu: ReactNode;
  /** 換內容前 60 秒的提示列（沒有為 null） */
  notice: ReactNode;
}

function FocusTitle({ kind, mobile }: { kind: FocusKind; mobile: boolean }) {
  if (mobile) return <span className={css.mTitle}>焦點·{SHORT_LABEL[kind] ?? FOCUS_LABEL[kind]}</span>;
  const short = SHORT_LABEL[kind];
  return (
    <>
      <span className={css.tPre}>時段焦點·</span>
      {short ? <><span className={css.tFull}>{FOCUS_LABEL[kind]}</span><span className={css.tShort}>{short}</span></> : FOCUS_LABEL[kind]}
    </>
  );
}

/** 標題列控制＋切換選單（狀態在 ZoneFocus 這一層，換內容時選單仍開著） */
export function useFocusShell(variant: ZoneVariant): FocusShell {
  const ui = useWarUi();
  const { now, segment } = useWarData();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const mobile = variant === 'mobile';

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (menuRef.current?.contains(t) || btnRef.current?.contains(t))) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus(); } };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);
  useEffect(() => { if (open) menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus(); }, [open]);

  // 60 秒內時段會換、且換完畫面上的內容會跟著變（未釘選；手動切換會在換時段時清掉）⇒ 先提示
  const soonSeg = warSegment(now + SWITCH_HINT_MS);
  const nextAuto = soonSeg !== segment ? focusForSegment(soonSeg) : null;
  const willShow = nextAuto ? (ui.focusPinned ?? nextAuto) : null;
  const notice = willShow && willShow !== ui.focus
    ? <div className={css.switchBar} role="status">1 分內切換為「{FOCUS_LABEL[willShow]}」</div>
    : null;

  const pick = (k: FocusKind | null) => {
    if (k == null) {
      ui.setFocusOverride(null);
      if (ui.focusPinned) ui.pinFocus(null);
    } else if (ui.focusPinned) {
      ui.pinFocus(k);
    } else {
      ui.setFocusOverride(k === ui.focusAuto ? null : k);
    }
    setOpen(false);
  };
  const isAuto = !ui.focusPinned && !ui.focusOverride;
  const manual = !ui.focusPinned && !!ui.focusOverride && ui.focus !== ui.focusAuto;
  const chipCls = (on: boolean) => [styles.chip, on ? styles.chipOn : '', mobile ? css.mCtl : ''].filter(Boolean).join(' ');

  const extra = (
    <>
      <button
        type="button"
        className={chipCls(!!ui.focusPinned)}
        aria-pressed={!!ui.focusPinned}
        aria-label="釘選"
        onClick={() => ui.pinFocus(ui.focusPinned ? null : ui.focus)}
        title={ui.focusPinned ? '取消釘選（回到依時段自動切換）' : '釘選目前內容：跨時段保留到今日結束'}
      >
        📌<span className={mobile ? css.srOnly : css.pinTxt}> 釘選</span>
      </button>
      <button
        ref={btnRef}
        type="button"
        className={chipCls(open || manual)}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={manual ? `手動切換中（目前時段：${FOCUS_LABEL[ui.focusAuto]}）` : '手動切換時段焦點內容'}
      >
        切換 ▾
      </button>
    </>
  );

  const menu = open ? (
    <div ref={menuRef} className={css.menu} role="menu" aria-label="切換時段焦點內容">
      <button type="button" role="menuitemradio" aria-checked={isAuto} className={[css.menuItem, css.menuAuto, mobile ? css.menuItemM : ''].join(' ')} onClick={() => pick(null)}>
        自動（依時段）·{FOCUS_LABEL[ui.focusAuto]}
      </button>
      <div className={css.menuSep} role="separator" />
      {FOCUS_KINDS.map((k) => (
        <button
          key={k}
          type="button"
          role="menuitemradio"
          aria-checked={!isAuto && ui.focus === k}
          className={[css.menuItem, mobile ? css.menuItemM : ''].join(' ')}
          onClick={() => pick(k)}
        >
          {FOCUS_LABEL[k]}{k === ui.focusAuto ? '（目前時段）' : ''}
        </button>
      ))}
    </div>
  ) : null;

  return { variant, extra, menu, notice };
}

export interface FocusFrameProps {
  shell: FocusShell;
  kind: FocusKind;
  stamp?: ReactNode;
  foot?: ReactNode;
  children?: ReactNode;
}

export function FocusFrame({ shell, kind, stamp, foot, children }: FocusFrameProps) {
  const mobile = shell.variant === 'mobile';
  return (
    <ZoneFrame
      area="a2"
      emphasis
      variant={shell.variant}
      title={<FocusTitle kind={kind} mobile={mobile} />}
      label={`時段焦點·${FOCUS_LABEL[kind]}`}
      extra={shell.extra}
      stamp={stamp}
      foot={typeof foot === 'string' ? <span className={css.footTxt} title={foot}>{foot}</span> : foot}
    >
      <div className={mobile ? [css.bodyM, shell.menu ? css.bodyMOpen : ''].filter(Boolean).join(' ') : css.body}>
        {shell.menu}
        {shell.notice}
        {children}
      </div>
    </ZoneFrame>
  );
}

/** 代號：桌機可點（開個股頁）；手機只顯示文字（點擊目標太小，整列點擊開抽屜） */
export function CodeLink({ code, mobile }: { code: string; mobile?: boolean }) {
  if (mobile) return <span className={css.codeTxt}>{code}</span>;
  return (
    <button
      type="button"
      className={css.codeBtn}
      onClick={(e) => { e.stopPropagation(); useAppStore.getState().navigateTo('stock', code); }}
      title={`開啟 ${code} 個股頁`}
    >
      {code}
    </button>
  );
}

/** 置中訊息（無資料、提供時窗外、收盤競價中…） */
export function FocusMsg({ big, children }: { big?: ReactNode; children?: ReactNode }) {
  return (
    <div className={css.center}>
      {big && <div className={css.centerBig}>{big}</div>}
      {children && <div>{children}</div>}
    </div>
  );
}
