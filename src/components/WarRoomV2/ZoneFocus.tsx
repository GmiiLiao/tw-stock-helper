'use client';

// A2「時段焦點」：骨架整天不動，只有這一格依時段換內容（使用者裁定第 1 題）。
//   盤前 開盤劇本 → 08:55 試撮中 → 09:00 開盤三關 → 09:30 當沖觀察 → 12:45 當沖成立中＋撿尾盤
//   → 13:25 收盤競價（13:30 揭示後更新）→ 13:30 今日結果 → 13:45 後／非交易日 盤後（盤後報告、盤前備課連結）
// 標題列：📌 釘選（跨時段保留到今日結束）、切換 ▾（手動切換；時段一換自動清掉）、換內容前 60 秒提示。
// 資料：pulse.focus（中層 30 秒；只讀 Firestore 的聚合路由）＋匯流排指數與報價；本元件不自己輪詢。
// 手機 variant：段落 id＝wr-m-focus（S2 跳轉），每種內容最多 5 列卡片。
// 出錯保留舊資料：匯流排只保留到 pulse 的頂層 focus 區段；這裡再對子內容（開盤劇本與其兩份來源、開盤三關、當沖觀察、撿尾盤）
//   各自沿用最後一份成功的 Section（asOf 不前進 ⇒ 資料章自然轉延遲／過期），不讓一次讀取失敗把表格換成錯誤訊息。
//   子內容是 null（不在提供時窗）時照實傳下去，不拿舊的頂替；換日清空。
import { useMemo } from 'react';
import type { Section } from '@/lib/warroom/types';
import type { FocusData, FocusScript as FocusScriptData } from '@/lib/warroom/build-focus';
import type { ZoneProps } from './parts/ZoneFrame';
import { useWarData, useWarUi } from './WarRoomContext';
import { useFocusShell } from './FocusFrame';
import FocusScript from './FocusScript';
import FocusGates from './FocusGates';
import { FocusDaytradeView, FocusTailView } from './FocusDaytrade';
import { FocusAuctionView, FocusResultView } from './FocusResult';

type PartKey = 'script' | 'gates' | 'daytrade' | 'tail';
type ScriptKey = keyof FocusScriptData;
type AnySection = Section<unknown>;

// 模組層級（桌機／手機兩棵樹切換、Provider 重掛都保留）
let heldYmd = '';
let heldParts: Partial<Record<PartKey, AnySection>> = {};
let heldScript: Partial<Record<ScriptKey, AnySection>> = {};

function holdSection<S extends AnySection | null>(next: S, held: Partial<Record<string, AnySection>>, key: string): S {
  if (next && next.ok) { held[key] = next; return next; }
  if (next && !next.ok && held[key]) return held[key] as S;
  return next;
}

/** 開盤劇本：兩份來源各自沿用；整份失敗時沿用上一份整份（盤前新聞讀 board.news，不在這裡） */
function holdScriptPart(next: FocusData['script']): FocusData['script'] {
  if (!next || !next.ok) return holdSection(next, heldParts, 'script');
  const d = next.data;
  const merged: FocusScriptData = {
    queue: holdSection(d.queue, heldScript, 'queue'),
    asia: holdSection(d.asia, heldScript, 'asia'),
  };
  const out = merged.queue === d.queue && merged.asia === d.asia ? next : { ...next, data: merged };
  heldParts.script = out;
  return out;
}

function holdFocus(focus: Section<FocusData> | null | undefined): Section<FocusData> | null | undefined {
  if (!focus || !focus.ok) return focus;
  const d = focus.data;
  if (d.ymd !== heldYmd) { heldYmd = d.ymd; heldParts = {}; heldScript = {}; }
  const data: FocusData = {
    ...d,
    script: holdScriptPart(d.script),
    gates: holdSection(d.gates, heldParts, 'gates'),
    daytrade: holdSection(d.daytrade, heldParts, 'daytrade'),
    tail: holdSection(d.tail, heldParts, 'tail'),
  };
  const same = data.script === d.script && data.gates === d.gates && data.daytrade === d.daytrade && data.tail === d.tail;
  return same ? focus : { ...focus, data };
}

export default function ZoneFocus({ variant = 'desk' }: ZoneProps) {
  const { focus: kind } = useWarUi();
  const { pulse } = useWarData();
  const shell = useFocusShell(variant);
  const raw = pulse?.focus;
  const focus = useMemo(() => holdFocus(raw), [raw]);

  switch (kind) {
    case 'script':
    case 'preclear':
      return <FocusScript shell={shell} kind={kind} focus={focus} />;
    case 'gates':
      return <FocusGates shell={shell} focus={focus} />;
    case 'daytrade':
      return <FocusDaytradeView shell={shell} focus={focus} />;
    case 'tail':
      return <FocusTailView shell={shell} focus={focus} />;
    case 'auction':
      return <FocusAuctionView shell={shell} />;
    case 'result':
    case 'after':
    default:
      return <FocusResultView shell={shell} kind={kind === 'result' ? 'result' : 'after'} />;
  }
}
