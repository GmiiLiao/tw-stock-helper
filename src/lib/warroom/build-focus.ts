// A2 時段焦點的伺服器端組裝（路由：/api/warroom/pulse 的 focus 區段）。
//
// 只讀 Firestore（reader），不打任何上游。這支路由全體共用同一個網址（CDN 快取），不知道誰持有什麼——
// 所以這裡只組「全市場的事實」，由前端 ZoneFocus 挑出使用者的持股／自選／候選（不送個人資料、不帶個人參數）。
// 各內容只在有意義的時窗內組裝（FOCUS_WINDOW；其餘回 null，前端顯示提供時窗），每塊各自成敗（Section）、各自 asOf：
//   script   開盤劇本（交易日 09:00 前）：搶漲停排隊 limitQueue、日韓早盤 asiaPremarket
//            （盤前新聞判別改用慢層 board.news 精簡表——與 A1 燈、Z2、B2 同一份、權重同盤後報告；這裡不再另讀 newsVerdict）
//   gates    開盤三關（09:00–10:00）：快照＋前一交易日昨量（chipArchive）＋09:30 定格（snap0930Archive，09:31 起）
//   daytrade 當沖觀察（09:00–13:45）：daytradeAlerts/live（尾盤段另補日內位置）
//   tail     撿尾盤（12:45–13:45）：marketPattern/latest.tailPicks
// 純計算在 scripts/lib/warroom-focus.mjs（有單元測試）；這裡只負責讀文件、判時窗、包 Section。
import type { DocRead, WarReader } from './reader';
import { asOfOf, errSection, guardSection, okSection, type Section } from './section';
import { warClock, type WarSegment } from './session';
import { focusForSegment } from './focus-kinds';
import { isTradingYmd } from '@/lib/market-clock';
import { focusPartActive, type GateRowsWire } from '../../../scripts/lib/warroom-focus-codec.mjs';
import {
  buildAsia, buildDaytrade, buildGateRows, buildQueue, buildTail, parseJsonField, prevTradingYmd,
  withDayPos, yVolLookup,
  type FocusAsia, type FocusDaytrade, type FocusQueue, type FocusTail, type GateQuoteLike,
} from '../../../scripts/lib/warroom-focus.mjs';

export type {
  FocusAsia, FocusDaytrade, FocusDtRow, FocusDtSide, FocusQueue, FocusQueueItem, FocusTail, FocusTailItem,
} from '../../../scripts/lib/warroom-focus.mjs';
export type { GateRowsWire } from '../../../scripts/lib/warroom-focus-codec.mjs';

/** 開盤劇本：兩份來源各自成敗（data:null＝文件尚未產生）。盤前新聞讀 board.news（前端 NewsModel） */
export interface FocusScript {
  queue: Section<FocusQueue | null>;
  asia: Section<FocusAsia | null>;
}

/** 開盤三關（全市場 4 碼普通股；前端挑持股與候選） */
export interface FocusGates {
  /** live＝09:00–09:30 即時累計；frozen＝09:30 定格（snap0930Archive） */
  mode: 'live' | 'frozen';
  /** 第二關的大盤基準：加權漲跌 %（live＝marketIndex/latest；frozen＝定格當下） */
  idxChg: number | null;
  /** 昨量所屬交易日（chipArchive）；null＝讀不到昨量 ⇒ 第一關全部缺 */
  prevDate: string | null;
  /** 09:30 定格的擷取時刻（frozen 才有） */
  t0930: number | null;
  rows: GateRowsWire;
}

export interface FocusData {
  /** 組裝當下的時段（reader.now） */
  segment: WarSegment;
  /** 台北日期 YYYY-MM-DD */
  ymd: string;
  /** null＝不在該內容的提供時窗（見 FOCUS_WINDOW） */
  script: Section<FocusScript> | null;
  gates: Section<FocusGates> | null;
  daytrade: Section<FocusDaytrade> | null;
  tail: Section<FocusTail | null> | null;
}

type Doc = Record<string, unknown>;

/** DocRead → 子 Section（讀取故障 ⇒ ok:false；文件不存在 ⇒ ok:true、data:null） */
function sub<T>(r: DocRead<Doc>, map: (d: Doc) => T | null, asOfKeys?: readonly string[]): Section<T | null> {
  if (!r.ok) return errSection('讀取失敗');
  if (!r.data) return okSection<T | null>(null, null);
  return okSection<T | null>(map(r.data), asOfOf(r.data, asOfKeys));
}

const maxAsOf = (...xs: Array<number | null>): number | null => {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return v.length ? Math.max(...v) : null;
};

// ── 開盤劇本 ──────────────────────────────────────────────────────────────────
async function buildScriptPart(reader: WarReader): Promise<Section<FocusScript>> {
  return guardSection('focus.script', async () => {
    const [q, a] = await Promise.all([
      reader.doc<Doc>('limitQueue', 'latest', 'quote'),
      reader.doc<Doc>('asiaPremarket', 'latest', 'slow'),
    ]);
    const queue = sub(q, buildQueue);
    const asia = sub(a, buildAsia, ['quoteAt', 'updatedAt']);
    if (!queue.ok && !asia.ok) return errSection<FocusScript>('讀取失敗');
    return okSection<FocusScript>({ queue, asia }, maxAsOf(queue.asOf, asia.asOf));
  });
}

// ── 開盤三關 ──────────────────────────────────────────────────────────────────
// 前一交易日的收盤歸檔（含全市場昨量）一天只需解析一次
let yVolMemo: { ymd: string; fn: (code: string) => number | null } | null = null;

async function buildGatesPart(reader: WarReader, ymd: string, minute: number): Promise<Section<FocusGates>> {
  return guardSection('focus.gates', async () => {
    const prevDate = prevTradingYmd(ymd, isTradingYmd);
    const wantFrozen = minute >= 9 * 60 + 30;
    const [snap, idx, arch, s0930] = await Promise.all([
      reader.snapshot(),
      reader.doc<Doc>('marketIndex', 'latest', 'tick'),
      prevDate && yVolMemo?.ymd !== prevDate ? reader.doc<Doc>('chipArchive', prevDate, 'daily') : Promise.resolve(null),
      wantFrozen ? reader.doc<Doc>('snap0930Archive', ymd, 'slow') : Promise.resolve(null),
    ]);
    if (!snap.ok || !snap.data) return errSection<FocusGates>('快照讀取失敗');

    let yVol: (code: string) => number | null = () => null;
    let yVolDay: string | null = null;
    if (prevDate && yVolMemo?.ymd === prevDate) {
      yVol = yVolMemo.fn; yVolDay = prevDate;
    } else if (arch && arch.ok && arch.data) {
      const close = parseJsonField(arch.data.closeJson);
      if (close) { yVol = yVolLookup(close); yVolDay = prevDate; if (prevDate) yVolMemo = { ymd: prevDate, fn: yVol }; }
    }

    const frozenDoc = s0930 && s0930.ok && s0930.data && s0930.data.date === ymd ? s0930.data : null;
    const frozenBy = frozenDoc ? parseJsonField(frozenDoc.byCodeJson) : null;
    const quotes = snap.data.quotes as unknown as Record<string, GateQuoteLike>;
    const rows = buildGateRows({ quotes, yVol, frozenBy });
    const idxLive = idx && idx.ok && idx.data ? Number(idx.data.weightedChangePercent) : NaN;
    const idxFrozen = frozenDoc ? Number(frozenDoc.idxChgPct) : NaN;
    const idxChg = frozenBy ? (Number.isFinite(idxFrozen) ? idxFrozen : null) : (Number.isFinite(idxLive) ? idxLive : null);
    const asOf = maxAsOf(snap.data.sweepAt ?? null, snap.data.hotAt ?? null);
    return okSection<FocusGates>({
      mode: frozenBy ? 'frozen' : 'live',
      idxChg,
      prevDate: yVolDay,
      t0930: frozenDoc ? asOfOf(frozenDoc, ['at']) : null,
      rows,
    }, asOf);
  });
}

// ── 當沖觀察（尾盤段補日內位置）────────────────────────────────────────────────
async function buildDaytradePart(reader: WarReader, ymd: string, withPos: boolean): Promise<Section<FocusDaytrade>> {
  return guardSection('focus.daytrade', async () => {
    const r = await reader.doc<Doc>('daytradeAlerts', 'live', 'tick');
    if (!r.ok) return errSection<FocusDaytrade>('讀取失敗');
    if (!r.data) return errSection<FocusDaytrade>('資料尚未產生');
    let dt = buildDaytrade(r.data, { ymd, now: reader.now });
    if (!dt) return errSection<FocusDaytrade>('資料尚未產生');
    if (withPos && (dt.long.rows.length || dt.short.rows.length)) {
      const snap = await reader.snapshot();
      if (snap.ok && snap.data) dt = withDayPos(dt, snap.data.quotes as unknown as Record<string, GateQuoteLike>) ?? dt;
    }
    return okSection(dt, asOfOf(r.data, ['at', 'updatedAt']));
  });
}

// ── 撿尾盤 ────────────────────────────────────────────────────────────────────
async function buildTailPart(reader: WarReader): Promise<Section<FocusTail | null>> {
  return guardSection('focus.tail', async () => {
    const r = await reader.doc<Doc>('marketPattern', 'latest', 'quote');
    if (!r.ok) return errSection<FocusTail | null>('讀取失敗');
    const tail = r.data ? buildTail(r.data) : null;
    const tp = r.data?.tailPicks as Doc | undefined;
    return okSection<FocusTail | null>(tail, asOfOf(tp ?? null, ['updatedAt']));
  });
}

export async function buildFocus(reader: WarReader): Promise<Section<FocusData>> {
  return guardSection('focus', async () => {
    const clock = warClock(reader.now);
    const trading = clock.segment !== 'nontrading';
    const on = (p: 'script' | 'gates' | 'daytrade' | 'tail') => focusPartActive(p, clock.minute, trading);
    const tailOn = on('tail');
    const [script, gates, daytrade, tail] = await Promise.all([
      on('script') ? buildScriptPart(reader) : null,
      on('gates') ? buildGatesPart(reader, clock.ymd, clock.minute) : null,
      on('daytrade') ? buildDaytradePart(reader, clock.ymd, tailOn) : null,
      tailOn ? buildTailPart(reader) : null,
    ]);
    const data: FocusData = { segment: clock.segment, ymd: clock.ymd, script, gates, daytrade, tail };
    // 區段 asOf＝此刻時段主內容的資料時間（各內容另有自己的 asOf）
    const kind = focusForSegment(clock.segment);
    const main = kind === 'script' || kind === 'preclear' ? script
      : kind === 'gates' ? gates
        : kind === 'daytrade' ? daytrade
          : kind === 'tail' ? (tail ?? daytrade)
            : null;
    return okSection(data, main && main.ok ? main.asOf : null);
  });
}
