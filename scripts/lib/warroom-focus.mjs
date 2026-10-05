// ─────────────────────────────────────────────────────────────────────────────
// 盤中戰情 v2「A2 時段焦點」伺服器端組裝的純函式（文件 → 精簡 payload）。
// 呼叫端：src/lib/warroom/build-focus.ts（只讀 Firestore，不打任何上游）。
//
// 資料來源（皆為 daemon 已寫好的文件；欄位對照 scripts/ai-daemon.mjs）：
//   搶漲停排隊   limitQueue/latest            computeLimitQueue：items[{code,name,queueLots,chg,limitPrice}]、date、updatedAt
//   日韓早盤     asiaPremarket/latest         computeAsiaPremarket：jp.chg、kr.chg、sox、quoteAt、delayMin、lateCatchup、split、date
//   （盤前新聞判別不在這裡：A2 改讀慢層 board.news 精簡表，見 warroom-news.mjs premarketNewsRows）
//   開盤三關     marketSnapshot（疊 hot）＋ chipArchive/{前一交易日}.closeJson[code][1]（昨量·張）
//               ＋ snap0930Archive/{今日}（09:31 起：byCodeJson{code:[漲跌%, 前30分量張]}、idxChgPct）＋ marketIndex/latest
//   當沖觀察     daytradeAlerts/live          daytrade-engine.mjs snapshot()：long/short[{code,name,st,m,plan,watch}]、date、at
//   撿尾盤       marketPattern/latest.tailPicks computeTailEndPicks：buyable[…]、locked、buyableTotal、source、date、updatedAt
// 原則：缺欄位就省略（null），不捏造預設值；資料日一律用來源自報的 date。
// 單元測試：node --test scripts/lib/warroom-focus.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { DESK_PARAMS } from './daytrade-setups.mjs';
import { encodeGateRows } from './warroom-focus-codec.mjs';

export const FOCUS_LIMITS = Object.freeze({
  /** 搶漲停排隊送前幾檔 */
  queue: 8,
  /** 當沖觀察每側送前幾列（成立中優先，其次剛出場） */
  dtPerSide: 5,
  /** 「剛出場」保留多久（與當沖工作台 DeskRow 的 STOP_KEEP_MS 同口徑） */
  stopKeepMs: 15 * 60_000,
  /** 撿尾盤候選送前幾檔 */
  tail: 10,
});

const CODE_RE = /^\d{4,6}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const num = v => (isNum(v) ? v : null);
const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
const round2 = v => Math.round(v * 100) / 100;
const ymdOf = v => (typeof v === 'string' && DATE_RE.test(v) ? v : null);

/** 安全解析 JSON 字串欄位（壞掉回 null，不丟錯） */
export function parseJsonField(v) {
  if (typeof v !== 'string' || !v) return null;
  try {
    const o = JSON.parse(v);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

/** 前一個交易日（YYYY-MM-DD）。isTradingYmd 由呼叫端注入（伺服器端休市日曆）；往回最多 maxBack 天，找不到回 null */
export function prevTradingYmd(ymd, isTradingYmd, maxBack = 15) {
  if (!ymdOf(ymd) || typeof isTradingYmd !== 'function') return null;
  const [y, m, d] = ymd.split('-').map(Number);
  let t = Date.UTC(y, m - 1, d);
  for (let i = 0; i < maxBack; i++) {
    t -= 86_400_000;
    const s = new Date(t).toISOString().slice(0, 10);
    if (isTradingYmd(s)) return s;
  }
  return null;
}

/** limitQueue/latest → 前 N 檔（張數為買一委買張數；尚未成交上去，不是已漲停） */
export function buildQueue(doc, limit = FOCUS_LIMITS.queue) {
  if (!doc || typeof doc !== 'object') return null;
  const items = Array.isArray(doc.items) ? doc.items : [];
  return {
    date: ymdOf(doc.date),
    total: isNum(doc.n) ? doc.n : items.length,
    items: items
      .filter(x => x && CODE_RE.test(String(x.code)))
      .slice(0, limit)
      .map(x => ({ code: String(x.code), name: str(x.name) ?? String(x.code), lots: num(x.queueLots), chg: num(x.chg), limit: num(x.limitPrice) })),
  };
}

/** asiaPremarket/latest → 日經／韓國／費半（費半是前一晚美股收盤） */
export function buildAsia(doc) {
  if (!doc || typeof doc !== 'object') return null;
  return {
    date: ymdOf(doc.date),
    jp: num(doc.jp?.chg),
    kr: num(doc.kr?.chg),
    sox: num(doc.sox),
    delayMin: num(doc.delayMin),
    late: doc.lateCatchup === true,
    split: !!str(doc.split),
  };
}

/** chipArchive closeJson（{code:[收,量張,開,高,低]}）→ 昨量查詢 */
export function yVolLookup(closeMap) {
  const m = closeMap && typeof closeMap === 'object' ? closeMap : {};
  return code => {
    const v = m[code]?.[1];
    return isNum(v) && v > 0 ? v : null;
  };
}

/**
 * 開盤三關全市場數據（只收 4 碼普通股，排除 00 開頭 ETF）。
 *   live 模式（09:00–09:30）：今日累計量÷昨量、即時漲跌；frozen 模式（snap0930Archive 存在時）：09:30 定格的前 30 分量與漲跌。
 *   VWAP 位置一律用即時快照（daemon 取樣近似；覆蓋不足當日量 80% 時 daemon 不給 vwap ⇒ 未知）。
 * @param {{ quotes: Record<string, any>, yVol: (code: string) => number|null, frozenBy?: Record<string, [number, number]> | null }} input
 */
export function buildGateRows({ quotes, yVol, frozenBy = null }) {
  const q = quotes && typeof quotes === 'object' ? quotes : {};
  const rows = [];
  const codes = frozenBy ? Object.keys(frozenBy) : Object.keys(q);
  for (const code of codes) {
    if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
    const s = q[code];
    let chg, lots;
    if (frozenBy) {
      const f = frozenBy[code];
      if (!Array.isArray(f) || !isNum(f[0])) continue;
      chg = f[0];
      lots = num(f[1]);
    } else {
      if (!s || s.live !== true || !(s.price > 0) || !isNum(s.changePercent)) continue;
      chg = s.changePercent;
      lots = isNum(s.volume) ? s.volume / 1000 : null;
    }
    const yv = yVol(code);
    const ratio = yv && lots != null ? (lots / yv) * 100 : null;
    const live = s && s.live === true && s.price > 0;
    const vw = live && isNum(s.vwap) && s.vwap > 0 ? (s.price >= s.vwap ? 1 : 0) : null;
    rows.push({ code, ratio, chg, vw });
  }
  return encodeGateRows(rows);
}

/** 日內位置（與撿尾盤 pos 同口徑：無振幅＝1） */
export function dayPos(s) {
  if (!s || !(s.price > 0) || !(s.high > 0) || !(s.low > 0)) return null;
  const rng = s.high - s.low;
  return rng > 0 ? round2((s.price - s.low) / rng) : 1;
}

/**
 * 成立中的「淨 R」（以現價估算、扣成本）：與 daytrade-setups.mjs 出場時的算法相同——
 *   依出場計畫加權（已達目標按目標 R、其餘按現價 R），再扣 costR。
 */
export function unrealizedNetR(plan, price, side, split = DESK_PARAMS.split) {
  if (!plan || !isNum(price) || !isNum(plan.entry) || !isNum(plan.d) || !(plan.d > 0) || !isNum(plan.costR)) return null;
  const sg = side === 'short' ? -1 : 1;
  const hit = Array.isArray(plan.hit) ? plan.hit : [];
  let r = 0;
  for (let k = 0; k < 3; k++) r += (isNum(split?.[k]) ? split[k] : 0) * (hit[k] ? k + 1 : (sg * (price - plan.entry)) / plan.d);
  return round2(r - plan.costR);
}

function dtRow(r, side, phase, split) {
  const plan = r.plan && typeof r.plan === 'object' ? r.plan : null;
  const st = r.st;
  const px = num(r.m?.c);
  const isOn = phase === 'on';
  return {
    side,
    code: String(r.code),
    name: str(r.name) ?? String(r.code),
    phase,
    /** 成立時間（1 分 K 時戳） */
    since: num(st?.since) ?? num(plan?.t),
    /** 列表時間：成立中＝成立時間；剛出場＝出場時間 */
    t: isOn ? num(st?.since) ?? num(plan?.t) : num(st?.stopAt),
    type: str(plan?.type),
    entry: num(plan?.entry) ?? num(st?.entry),
    /** 成立中＝目前停損（1R 後上移的追蹤停損）；剛出場＝原結構停損 */
    stop: isOn ? num(plan?.trail) ?? num(plan?.stop) : num(plan?.stop),
    px,
    chg: num(r.m?.chg),
    netR: isOn ? unrealizedNetR(plan, px, side, split) : num(plan?.netR) ?? num(st?.netR),
    reason: isOn ? null : str(plan?.exit?.reason) ?? str(st?.reason),
    exitPx: isOn ? null : num(st?.stopPx),
    pos: null,
  };
}

/**
 * daytradeAlerts/live → 多空各前 N 列（成立中優先、其次 15 分鐘內剛出場）＋計數。
 * 分組與當沖工作台 DeskRow.rowGroupOf 同口徑：on＝成立中、stop＝15 分內出場、wait＝已寫定觸發價與停損在等。
 * 文件日期不是今天 ⇒ 不列任何個股（不把昨天的成立當成今天的）。
 */
export function buildDaytrade(doc, { ymd, now, split = DESK_PARAMS.split, perSide = FOCUS_LIMITS.dtPerSide, keepMs = FOCUS_LIMITS.stopKeepMs } = {}) {
  if (!doc || typeof doc !== 'object') return null;
  const date = ymdOf(doc.date);
  const empty = { rows: [], on: 0, stop: 0, wait: 0, monitored: 0 };
  if (!date || date !== ymd) return { date, long: empty, short: empty };
  const side = s => {
    const list = Array.isArray(doc[s]) ? doc[s] : [];
    const on = [], stop = [];
    let wait = 0, monitored = 0;
    for (const r of list) {
      if (!r || !CODE_RE.test(String(r.code))) continue;
      monitored++;
      const st = r.st;
      if (st?.phase === 'on') on.push(dtRow(r, s, 'on', split));
      else if (st?.phase === 'stop' && isNum(st.stopAt) && isNum(now) && now - st.stopAt < keepMs) stop.push(dtRow(r, s, 'stop', split));
      else if (Array.isArray(r.watch) && r.watch.some(w => w && w.trigger != null && w.stop != null)) wait++;
    }
    on.sort((a, b) => (b.since ?? 0) - (a.since ?? 0));
    stop.sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
    return { rows: [...on, ...stop].slice(0, perSide), on: on.length, stop: stop.length, wait, monitored };
  };
  return { date, long: side('long'), short: side('short') };
}

/** 把即時快照的日內位置補到當沖列上（撿尾盤段「位置」欄用；回新物件，不改原物件） */
export function withDayPos(dt, quotes) {
  if (!dt || !quotes) return dt;
  const add = b => ({ ...b, rows: b.rows.map(r => ({ ...r, pos: dayPos(quotes[r.code]) })) });
  return { ...dt, long: add(dt.long), short: add(dt.short) };
}

/** marketPattern/latest.tailPicks → 撿尾盤候選前 N 檔（buyable；鎖漲停另計數） */
export function buildTail(mpDoc, limit = FOCUS_LIMITS.tail) {
  const tp = mpDoc && typeof mpDoc === 'object' ? mpDoc.tailPicks : null;
  if (!tp || typeof tp !== 'object') return null;
  const buyable = Array.isArray(tp.buyable) ? tp.buyable : [];
  return {
    date: ymdOf(tp.date),
    source: tp.source === 'live' || tp.source === 'close' ? tp.source : null,
    instDate: ymdOf(tp.instDate),
    total: isNum(tp.buyableTotal) ? tp.buyableTotal : buyable.length,
    locked: Array.isArray(tp.locked) ? tp.locked.length : 0,
    items: buyable
      .filter(x => x && CODE_RE.test(String(x.code)))
      .slice(0, limit)
      .map(x => ({
        code: String(x.code),
        name: str(x.name) ?? String(x.code),
        market: str(x.market),
        px: num(x.price),
        chg: num(x.chg),
        pos: num(x.pos),
        volX: num(x.volX),
        fStreak: isNum(x.fStreak) ? x.fStreak : null,
        char: str(x.char),
      })),
  };
}
