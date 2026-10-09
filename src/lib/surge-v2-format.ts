// 🧪 飆股模型 v2（影子實驗）報告的「容錯正規化＋格式化」純函式。
// 資料：Mac 研究管線寫 Firestore surgeShadow/surge-v2（reportJson 字串化 JSON）→ /api/admin/surge-v2 → SurgeV2.tsx。
// 管線欄位全部可能缺：parseReport 一律把未知輸入收斂成「型別完整、缺值為 null／空陣列」的結構，元件端不再需要防呆；
// 格式化函式對 null／undefined／NaN／Infinity／非數字一律回「—」，不丟例外。
// 刻意只用「可被 Node 直接剝除型別執行」的 TS 語法（無 enum／namespace），scripts/verify-surge-v2-format.mjs 直接 import 本檔驗證。
//
// 單位（沿用管線輸出，不自行換算）：
//   小數比例（0.31＝31%）：Pick 的 score／winProb／past20／news.bull0／bear0、tp／sl、處置模態的 pre20／during／post20／reach25、前向帳本 ret／meanRet
//   已是百分數（6.18＝6.18%）：validation 與 swaps.validation 各欄、hitRows 各欄、importance.pp
//   前向帳本 summary.win：兩種寫法都可能（0.43 或 43）→ fmtRate 以 ≤1 視為比例（唯一的啟發式，限勝率）
//   swing10（5日榜→10日模型A，2026-10-09 接入）：prob／g5／g5x／need／ma5gap／ret／retx／summary 各報酬與比例＝小數比例；yoy3＝已是百分數

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DASH = '—';

// ───────── 基礎收斂 ─────────
export type Num = number | null;

/** 只收有限數字；字串、NaN、Infinity、物件一律 null。 */
export function num(v: unknown): Num {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
/** 非空字串（trim 後）；其餘 null。 */
export function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
export function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
/** 只留物件元素（壞列直接丟，不產生一整列「—」）。 */
const objs = (v: unknown): Array<Record<string, unknown>> => arr(v).filter(x => x !== null && typeof x === 'object' && !Array.isArray(x)).map(rec);
const strs = (v: unknown): string[] => arr(v).map(x => (typeof x === 'string' ? x : '')).filter(s => s.trim() !== '');
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

// ───────── 格式化（輸入皆可為任意值）─────────
/** 一般數字。digits＝小數位；signed＝正數加 +。 */
export function fmtNum(v: unknown, digits = 2, signed = false): string {
  const n = num(v);
  if (n === null) return DASH;
  const s = n.toFixed(digits);
  return signed && n > 0 ? `+${s}` : s;
}
/** 整數（四捨五入）；千分位。 */
export function fmtCount(v: unknown): string {
  const n = num(v);
  return n === null ? DASH : Math.round(n).toLocaleString('en-US');
}
/** 小數比例 → 百分比（0.31 → 31.0%）。 */
export function fmtRatio(v: unknown, digits = 1, signed = false): string {
  const n = num(v);
  return n === null ? DASH : `${fmtNum(n * 100, digits, signed)}%`;
}
/** 已是百分數 → 帶 % 字樣（6.18 → +6.18%）。 */
export function fmtPercent(v: unknown, digits = 2, signed = false): string {
  const n = num(v);
  return n === null ? DASH : `${fmtNum(n, digits, signed)}%`;
}
/** 勝率：≤1 視為比例（×100），否則已是百分數。 */
export function fmtRate(v: unknown, digits = 1): string {
  const n = num(v);
  if (n === null) return DASH;
  return `${(n <= 1 ? n * 100 : n).toFixed(digits)}%`;
}
/** 區間（已是百分數）：[+4.20, +8.40]%；任一端缺就整段「—」。 */
export function fmtInterval(lo: unknown, hi: unknown, digits = 1): string {
  const a = num(lo); const b = num(hi);
  return a === null || b === null ? DASH : `[${fmtNum(a, digits, true)}, ${fmtNum(b, digits, true)}]%`;
}
/** ISO／帶時區字串 → 台北 MM-DD HH:MM；無法解析回原字串（有）或「—」。 */
export function fmtDateTime(v: unknown): string {
  const s = str(v);
  if (s === null) return DASH;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return s;
  return new Date(t + 8 * 3600_000).toISOString().slice(5, 16).replace('T', ' ');
}
export function fmtText(v: unknown): string {
  return str(v) ?? DASH;
}
/** 0／1 旗標（null＝未知）。 */
export function fmtFlag(v: unknown, yes = '是', no = '否'): string {
  const n = num(v);
  return n === null ? DASH : n > 0 ? yes : no;
}

// ───────── 顏色語意 ─────────
export type Tone = 'up' | 'down' | 'neutral';
/** 已是百分數／比例皆可用：正＝up、負＝down、0 或缺＝neutral。 */
export function signTone(v: unknown): Tone {
  const n = num(v);
  return n === null || n === 0 ? 'neutral' : n > 0 ? 'up' : 'down';
}
/** 差值 95% 區間是否排除 0：全為正＝up、全為負＝down、跨 0／缺＝neutral。 */
export function ciTone(lo: unknown, hi: unknown): Tone {
  const a = num(lo); const b = num(hi);
  if (a === null || b === null) return 'neutral';
  return a > 0 ? 'up' : b < 0 ? 'down' : 'neutral';
}

// ───────── 正規化結構 ─────────
export interface V2State {
  luClose20: Num; luOpen20: Num; luLock20: Num; luBroken20: Num; luSmall20: Num; luBig20: Num;
  streak: Num; vr: Num; attn20: Num; disp: Num; otc: Num;
}
export interface V2Pick {
  rank: Num; code: string; name: string; score: Num; winProb: Num; past20: Num;
  family: { id: Num; label: string | null; dist: Num } | null;
  state: V2State;
  news: { bull0: Num; bear0: Num; cnt3: Num };
  exit: { tp: Num; sl: Num; maxHold: Num };
  flags: string[];
}
export interface V2Report {
  schema: string | null; asOfDay: string | null; entryDay: string | null; builtTime: string | null; status: string | null;
  verdict: { text: string | null; passed: boolean | null; rule: string | null };
  validation: {
    target: string | null;
    rows: Array<{ phase: string | null; fold: string | null; top: Num; base: Num; diffLo: Num; diffHi: Num; win: Num; holdDays: Num }>;
    hitRows: Array<{ phase: string | null; fold: string | null; prec: Num; base: Num; lift: Num; liftLo: Num; liftHi: Num }>;
    importance: Array<{ group: string | null; pp: Num }>;
    notes: string[];
  };
  picks: { start: V2Pick[]; cont: V2Pick[] };
  disposal: {
    modes: Array<{ id: Num; label: string | null; n: Num; pre20: Num; during: Num; post20: Num; reach25: Num; note: string | null }>;
    today: Array<{ code: string; name: string; day: Num; pre20: Num; since: Num; mode: Num; modeLabel: string | null; dist: Num }>;
    predictability: string | null;
  };
  swaps: {
    rule: string | null;
    validation: Array<{ variant: string | null; fold: string | null; n: Num; swap: Num; hold: Num; diff: Num; lo: Num; hi: Num }>;
    today: Array<{ hold: V2Pick | null; to: V2Pick | null; chipDist: Num; why: string | null }>;
  };
  ledger: {
    summary: { days: Num; picks: Num; closed: Num; meanRet: Num; win: Num };
    rows: Array<{ pickDay: string | null; code: string; name: string; phase: string | null; status: string | null; ret: Num; exitDay: string | null }>;
  };
  pipeline: { lastRun: string | null; steps: Array<{ name: string; ok: boolean | null; note: string | null }>; dataNotes: string[] };
  swing10: V2Swing10 | null;
}

/** 5 日榜 → 到第 10 日 10 日累積超額≥50%（模型 A＋均線／多榜特徵；管線 lib/swing10.py）。 */
export interface V2SwingPick {
  rank: Num; code: string; name: string; boardRank: Num; prob: Num; g5: Num; g5x: Num; need: Num; boards: string | null;
  ma5gap: Num; boardAge: Num; luToday: Num; luRun: Num; attRun: Num; dispDay: Num; dispLu: Num; yoy3: Num; lu60: Num;
}
export interface V2Swing10 {
  asOfDay: string | null; entryDay: string | null; builtTime: string | null; target: string | null;
  model: { kind: string | null; feats: Num; trainedOn: string | null; trainedThrough: string | null; rows: Num; positives: Num };
  validation: string[];
  picks: V2SwingPick[];
  ledger: {
    summary: { days: Num; closedDays: Num; topRetx: Num; boardRetx: Num; diff: Num; upShare: Num; hitA: Num; note: string | null };
    rows: Array<{ pickDay: string | null; dataDay: string | null; code: string; name: string; prob: Num; pick: boolean | null; status: string | null; day: Num; ret: Num; retx: Num; hitA: boolean | null }>;
  };
  notes: string[];
}

const STATE_KEYS: ReadonlyArray<keyof V2State> = ['luClose20', 'luOpen20', 'luLock20', 'luBroken20', 'luSmall20', 'luBig20', 'streak', 'vr', 'attn20', 'disp', 'otc'];

/** 單檔：不是物件就 null；其餘缺值補 null／空。code／name 缺時以「—」顯示字串。 */
export function parsePick(raw: unknown): V2Pick | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = rec(raw);
  const st = rec(o.state);
  const state = {} as V2State;
  for (const k of STATE_KEYS) state[k] = num(st[k]);
  const fam = o.family !== null && typeof o.family === 'object' ? rec(o.family) : null;
  const nw = rec(o.news); const ex = rec(o.exit);
  return {
    rank: num(o.rank), code: str(o.code) ?? DASH, name: str(o.name) ?? '', score: num(o.score), winProb: num(o.winProb), past20: num(o.past20),
    family: fam ? { id: num(fam.id), label: str(fam.label), dist: num(fam.dist) } : null,
    state,
    news: { bull0: num(nw.bull0), bear0: num(nw.bear0), cnt3: num(nw.cnt3) },
    exit: { tp: num(ex.tp), sl: num(ex.sl), maxHold: num(ex.maxHold) },
    flags: strs(o.flags),
  };
}
const picks = (v: unknown): V2Pick[] => arr(v).map(parsePick).filter((p): p is V2Pick => p !== null);

/** swing10 區塊：不是物件（含舊報告沒有這個欄位）回 null＝元件不顯示該區塊。 */
export function parseSwing10(raw: unknown): V2Swing10 | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = rec(raw); const md = rec(o.model); const val = rec(o.validation); const lg = rec(o.ledger); const ls = rec(lg.summary);
  return {
    asOfDay: str(o.asOfDay), entryDay: str(o.entryDay), builtTime: str(o.builtTime), target: str(o.target),
    model: { kind: str(md.kind), feats: num(md.feats), trainedOn: str(md.trainedOn), trainedThrough: str(md.trainedThrough), rows: num(md.rows), positives: num(md.positives) },
    validation: strs(val.lines),
    picks: objs(o.picks).map(r => ({
      rank: num(r.rank), code: str(r.code) ?? DASH, name: str(r.name) ?? '', boardRank: num(r.boardRank), prob: num(r.prob), g5: num(r.g5), g5x: num(r.g5x), need: num(r.need),
      boards: str(r.boards), ma5gap: num(r.ma5gap), boardAge: num(r.boardAge), luToday: num(r.luToday), luRun: num(r.luRun), attRun: num(r.attRun),
      dispDay: num(r.dispDay), dispLu: num(r.dispLu), yoy3: num(r.yoy3), lu60: num(r.lu60),
    })),
    ledger: {
      summary: { days: num(ls.days), closedDays: num(ls.closedDays), topRetx: num(ls.topRetx), boardRetx: num(ls.boardRetx), diff: num(ls.diff), upShare: num(ls.upShare), hitA: num(ls.hitA), note: str(ls.note) },
      rows: objs(lg.rows).map(r => ({
        pickDay: str(r.pickDay), dataDay: str(r.dataDay), code: str(r.code) ?? DASH, name: str(r.name) ?? '', prob: num(r.prob), pick: bool(r.pick),
        status: str(r.status), day: num(r.day), ret: num(r.ret), retx: num(r.retx), hitA: bool(r.hitA),
      })),
    },
    notes: strs(o.notes),
  };
}
/** swing10 帳本 status → 中文；未知狀態原樣顯示。 */
export function swingStatusLabel(s: string | null): string {
  if (s === null) return DASH;
  switch (s) {
    case 'closed': return '已結算';
    case 'open': return '持有中';
    default: return s;
  }
}

/** 整份報告。輸入不是物件（含 null、陣列、字串）回 null＝呼叫端顯示「格式不符」。 */
export function parseReport(raw: unknown): V2Report | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = rec(raw);
  const v = rec(o.verdict); const val = rec(o.validation); const pk = rec(o.picks);
  const dis = rec(o.disposal); const sw = rec(o.swaps); const lg = rec(o.ledger); const ls = rec(lg.summary); const pl = rec(o.pipeline);
  return {
    schema: str(o.schema), asOfDay: str(o.asOfDay), entryDay: str(o.entryDay), builtTime: str(o.builtTime), status: str(o.status),
    verdict: { text: str(v.text), passed: bool(v.passed), rule: str(v.rule) },
    validation: {
      target: str(val.target),
      rows: objs(val.rows).map(r => ({ phase: str(r.phase), fold: str(r.fold), top: num(r.top), base: num(r.base), diffLo: num(r.diffLo), diffHi: num(r.diffHi), win: num(r.win), holdDays: num(r.holdDays) })),
      hitRows: objs(val.hitRows).map(r => ({ phase: str(r.phase), fold: str(r.fold), prec: num(r.prec), base: num(r.base), lift: num(r.lift), liftLo: num(r.liftLo), liftHi: num(r.liftHi) })),
      importance: objs(val.importance).map(r => ({ group: str(r.group), pp: num(r.pp) })),
      notes: strs(val.notes),
    },
    picks: { start: picks(pk.start), cont: picks(pk.cont) },
    disposal: {
      modes: objs(dis.modes).map(r => ({ id: num(r.id), label: str(r.label), n: num(r.n), pre20: num(r.pre20), during: num(r.during), post20: num(r.post20), reach25: num(r.reach25), note: str(r.note) })),
      today: objs(dis.today).map(r => ({ code: str(r.code) ?? DASH, name: str(r.name) ?? '', day: num(r.day), pre20: num(r.pre20), since: num(r.since), mode: num(r.mode), modeLabel: str(r.modeLabel), dist: num(r.dist) })),
      predictability: str(dis.predictability),
    },
    swaps: {
      rule: str(sw.rule),
      validation: objs(sw.validation).map(r => ({ variant: str(r.variant), fold: str(r.fold), n: num(r.n), swap: num(r.swap), hold: num(r.hold), diff: num(r.diff), lo: num(r.lo), hi: num(r.hi) })),
      today: objs(sw.today).map(r => ({ hold: parsePick(r.hold), to: parsePick(r.to), chipDist: num(r.chipDist), why: str(r.why) })),
    },
    ledger: {
      summary: { days: num(ls.days), picks: num(ls.picks), closed: num(ls.closed), meanRet: num(ls.meanRet), win: num(ls.win) },
      rows: objs(lg.rows).map(r => ({ pickDay: str(r.pickDay), code: str(r.code) ?? DASH, name: str(r.name) ?? '', phase: str(r.phase), status: str(r.status), ret: num(r.ret), exitDay: str(r.exitDay) })),
    },
    pipeline: {
      lastRun: str(pl.lastRun),
      steps: objs(pl.steps).map(r => ({ name: str(r.name) ?? DASH, ok: bool(r.ok), note: str(r.note) })),
      dataNotes: strs(pl.dataNotes),
    },
    swing10: parseSwing10(o.swing10),
  };
}

// ───────── 名單輔助 ─────────
/** 風險列：處置中、有一字鎖死、或標籤含「處置」。 */
export function isWarnPick(p: V2Pick): boolean {
  return (p.state.disp ?? 0) > 0 || (p.state.luLock20 ?? 0) > 0 || p.flags.some(f => f.includes('處置'));
}
/** 帳本 status → 中文；未知狀態原樣顯示（不捏造）。 */
export function ledgerStatusLabel(s: string | null): string {
  if (s === null) return DASH;
  switch (s) {
    case 'open': return '持有中';
    case 'tp': return '停利';
    case 'sl': return '停損';
    case 'time': return '到期出場';
    default: return s;
  }
}
/** 重要度長條：以最大絕對值為 100%；全缺或全 0 → 0。 */
export function barWidths(values: ReadonlyArray<Num>): number[] {
  const m = Math.max(0, ...values.map(v => (v === null ? 0 : Math.abs(v))));
  return values.map(v => (v === null || m === 0 ? 0 : Math.round((Math.abs(v) / m) * 100)));
}
