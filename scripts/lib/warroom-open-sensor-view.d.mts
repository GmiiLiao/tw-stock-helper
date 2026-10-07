// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）
import type { OpenSensorPayload, OsCheck, OsDoc, OsOutsideStats, OsLamp, OsState } from './warroom-open-sensor.mjs';

export type OsStateKind = 'named' | 'outside' | 'volPending' | 'undetermined' | 'unknown';

export interface OsStateText {
  kind: OsStateKind;
  key: string | null;
  num: number | null;
  lamp: OsLamp;
  named: boolean;
  /** 第一行（①–⑥ 帶「（量為估計）」） */
  title: string;
  /** 軌跡用短名（例「⑥量大權值漲」） */
  short: string;
}

export type OsPhase = 'loading' | 'wait' | 'missing' | 'ok';

export interface OpenSensorView {
  badge: string;
  phase: OsPhase;
  /** 'none'＝讀取中、等待首判、沒有文件 */
  lamp: OsLamp | 'none';
  title: string;
  /** 目前顯示的檢查點揭示時間 'HH:MM:SS' */
  dataT: string | null;
  /** 看的是前一交易日：「◆ 前交易日 10/07」 */
  prevLabel: string | null;
  trail: string | null;
  facts: string | null;
  vol: string | null;
  volReal: string | null;
  open: string | null;
  pattern: string | null;
  /** 未判定原因、量未定候選、首判前的門檻等 */
  note: string | null;
  checkKey: string | null;
}

export interface OsOutsideMonthRow {
  key: string;
  title: string;
  month: number;
  /** 最近 10 筆都在本月（實際可能更多） */
  capped: boolean;
  total: number | null;
  dates: string[];
}

export const OS_STATES: Readonly<Record<string, Readonly<{ num: number; name: string; lamp: OsLamp }>>>;
export const PATTERN3_LABEL: Readonly<Record<string, string>>;
export const OS_SAMPLE_ERROR_NOTE: string;
export const OS_RHO_PRIOR_NOTE: string;

export function osPct(n: number | null | undefined, digits?: number): string;
export function osPp(n: number | null | undefined, digits?: number): string;
export function osInt(n: number | null | undefined): string;
export function osWan(lots: number | null | undefined): string;
export function osRatioPct(r: number | null | undefined): string;
export function hm(T: string | null | undefined): string;

export function osStateText(state: Partial<Pick<OsState, 'key' | 'label' | 'cell' | 'outsideReason' | 'sub'>> | null | undefined): OsStateText;
export function osCandidatesText(cell: OsState['cell'] | null | undefined): string | null;
export function osVolReasonText(reason: string | null | undefined): string | null;
export function osGateReasonText(r: string): string;

export function osFactsLine(check: OsCheck | null | undefined): string;
export function osVolLine(check: OsCheck | null | undefined): string | null;
export function osVolRealLine(check: OsCheck | null | undefined, aucLots?: number | null): string | null;
export function osOpenLine(doc: OsDoc | null | undefined): string | null;
export function osPatternLine(doc: OsDoc | null | undefined): string | null;
export function osTrailLine(doc: OsDoc | null | undefined): string | null;
export function osUndeterminedLine(check: OsCheck | null | undefined): string | null;
export function openSensorView(payload: OpenSensorPayload | null | undefined, nowMs: number): OpenSensorView;
export function osOutsideMonthRows(stats: OsOutsideStats | null | undefined, nowMs: number): OsOutsideMonthRow[];
