// A2「時段焦點」的內容種類（前端 ZoneFocus 與伺服器 build-focus 共用的名冊）。
// 骨架整天不動，只有 A2 依時段換內容；使用者可手動切換（focusOverride）或釘選（pinFocus）。
import type { WarSegment } from './session';

export type FocusKind =
  | 'script'     // 08:30–08:55 開盤劇本（搶漲停排隊、今日不能做、國際亞洲、盤前新聞判別）
  | 'preclear'   // 08:55–09:00「試撮中·09:00 起更新」
  | 'gates'      // 09:00–09:30 開盤三關
  | 'daytrade'   // 09:30–12:45 當沖觀察（多空各前 5）
  | 'tail'       // 12:45–13:25 當沖成立中（置頂到 13:20）＋撿尾盤
  | 'auction'    // 13:25–13:30 收盤集合競價（第一階段：只寫「13:30 揭示後更新」；試撮看板＝2 期）
  | 'result'     // 13:30–13:45 今日結果
  | 'after';     // 13:45 後／非交易日：盤後報告與盤前備課連結

export const FOCUS_KINDS: readonly FocusKind[] = ['script', 'preclear', 'gates', 'daytrade', 'tail', 'auction', 'result', 'after'];

export const FOCUS_LABEL: Readonly<Record<FocusKind, string>> = {
  script: '開盤劇本',
  preclear: '試撮中',
  gates: '開盤三關',
  daytrade: '當沖觀察',
  tail: '當沖成立中＋撿尾盤',
  auction: '收盤競價',
  result: '今日結果',
  after: '盤後',
};

const BY_SEGMENT: Readonly<Record<WarSegment, FocusKind>> = {
  pre: 'script', preclear: 'preclear', open: 'gates', mid: 'daytrade', tail: 'tail',
  auction: 'auction', closing: 'result', after: 'after', nontrading: 'after',
};

/** 時段自動對應的 A2 內容 */
export function focusForSegment(seg: WarSegment): FocusKind {
  return BY_SEGMENT[seg];
}

export function isFocusKind(v: unknown): v is FocusKind {
  return typeof v === 'string' && (FOCUS_KINDS as readonly string[]).includes(v);
}
