// ─────────────────────────────────────────────────────────────────────────────
// 當沖即時警示：1 分 K 價量訊號（唯一實作——daemon、回放實驗室、前端型別共用，勿另寫第二份）
//
// 2026-09-23 使用者：「做多與做空時都要有即時警示，做多轉上漲時背景反白閃爍，做空亦同；
//   現象停止時也需 icon 提醒出貨；預測有 2% 以上空間要提前反應；由 1 分 K 與價量來即時判斷。」
//
// 定義（全部只用「到這一根為止」的資料，不偷看未來）：
//   bars：當日 1 分 K [{ t(ms), o, h, l, c, v(股) }]，t＝該分鐘起點。最後一根＝剛收完的那根。
//   VWAP：daemon 傳入全日取樣累積值（Σ價×Δ量÷ΣΔ量，MIS 無個股成交金額）；回放以 1 分 K 典型價×量累積。
//     daemon 取樣覆蓋不足時傳 null 且 allowBarVwap=false ⇒ 不用「加入監控後才開始的 K 棒」冒充全日 VWAP。
//   做多轉強 ▲：收盤突破前 N 根最高、該根量≥前 M 根均量×K、站上 VWAP、距漲停價仍有≥2% 空間。
//   做空轉弱 ▼：今日曾漲≥5%、收盤跌破前 N 根最低、該根量≥均量×K、距下檔目標（VWAP 與昨收取高者）仍有≥2% 空間。
//   現象停止（出貨/回補 icon）：多＝收盤跌破前 3 根最低；空＝收盤站上前 3 根最高。
//   空間（room）：多＝(漲停價−現價)/現價，<2% 不發訊號；空＝(現價−下檔目標)/現價，只顯示不設門檻。
// ⚠ 回放結論（2026-09-23，22 交易日）：1 分 K 突破/跌破**本身沒有正期望**（扣成本後樣本外皆為負），
//   「距漲停≥2%」只能排除貼漲停者、不能預測會漲 2%。本訊號是**盯盤提示**不是進場訊號；
//   前端每則警示旁附該情境的歷史兌現率與淨報酬（ALERT_EVIDENCE），不得宣稱「預測 2% 空間」。
// 門檻由 scripts/daytrade-alert-lab.mjs 以 Yahoo 1 分 K 逐根回放決定，數字寫在 ALERT_EVIDENCE。
// ─────────────────────────────────────────────────────────────────────────────

export const DT_COST = 0.435;   // 現股當沖：手續費 0.1425%×2（未含折讓）＋當沖證交稅 0.15%

export const DEFAULT_PARAMS = Object.freeze({
  lookback: 5,        // 突破/跌破前 N 根的高/低
  volWin: 10,         // 均量視窗（前 M 根）
  volK: 2,            // 該根量 ≥ 均量×K
  minRoom: 2,         // 做多：距漲停空間門檻（%）——回放：空間<2% 的觸發 0% 兌現 +2%，當否決條件用
  shortMinRoom: 0,    // 做空：距下檔目標空間門檻（%）——回放：設 2% 觸發剩 1/40 且未更好，故不設
  shortMinHiUp: 5,    // 做空：今日曾漲 ≥ 5%
  longMinChg: 0,      // 做多：現價漲幅下限（%）
  startMin: 9 * 60 + 5,    // 09:05 前不發（開盤前幾根量價失真）
  endMin: 12 * 60 + 30,    // 12:30 後不發新訊號（只追蹤既有訊號的停止）
  exitBars: 3,        // 做多現象停止：收盤跌破前 N 根最低（回放各出場規則中樣本外最不差）
  longExit: 'bars',   // 'bars'｜'vwap'｜'both'
  shortExit: 'bars',  // 做空現象停止：收盤站上前 N 根最高（與做多對稱）。⚠ 不可用 VWAP：做空觸發多半仍在 VWAP 上，下一根就出場（回放勝率 3~5%）
});

const tickOf = p => (p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5);
/** 漲跌停價（依檔位向內取整） */
export function limitPrices(prevClose) {
  const upRaw = prevClose * 1.1, dnRaw = prevClose * 0.9;
  const tu = tickOf(upRaw), td = tickOf(dnRaw);
  return { up: +(Math.floor(upRaw / tu + 1e-9) * tu).toFixed(2), down: +(Math.ceil(dnRaw / td - 1e-9) * td).toFixed(2) };
}

/** 台北時間的「當日分鐘數」 */
export function twMinute(tMs) {
  const d = new Date(tMs + 8 * 3600000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// ── 1 分 K 累積器（daemon 用：由 5 秒快線取樣組 K）──────────────────────
/** 新累積器 */
export function newBarBook() { return { bars: [], cur: null, cumVol: null, cumValue: null }; }
/**
 * 餵一筆即時取樣（價、當日累積量、當日累積金額）。回傳是否剛收完一根。
 * 量用「累積量差」算，所以取樣漏掉幾筆也不會少算量。
 */
export function pushSample(book, { t, price, volume, value }) {
  if (!(price > 0)) return false;
  const minT = Math.floor(t / 60000) * 60000;
  let closed = false;
  if (book.cur && book.cur.t !== minT) {
    book.bars.push(book.cur);
    if (book.bars.length > 300) book.bars.splice(0, book.bars.length - 300);
    book.cur = null; closed = true;
  }
  const base = book.cumVol ?? volume ?? 0;
  if (!book.cur) book.cur = { t: minT, o: price, h: price, l: price, c: price, v: 0, v0: base };
  const b = book.cur;
  b.h = Math.max(b.h, price); b.l = Math.min(b.l, price); b.c = price;
  if (volume != null && volume >= b.v0) b.v = volume - b.v0;
  if (volume != null) book.cumVol = volume;
  if (value != null) book.cumValue = value;
  return closed;
}

// ── 指標 ──────────────────────────────────────────────────────────────
/**
 * 算第 i 根（含）為止的指標。exactVwap 有值時優先用（MIS 金額/量）。
 * dayHigh：今日到此為止最高（daemon 用 MIS 當日最高，比 1 分 K 取樣更準）。
 */
export function metricsAt(bars, i, { prevClose, exactVwap = null, dayHigh = null, allowBarVwap = true }, P = DEFAULT_PARAMS) {
  const b = bars[i];
  let vwap = exactVwap > 0 ? exactVwap : null;
  if (!vwap && allowBarVwap) {
    let pv = 0, vv = 0;
    for (let k = 0; k <= i; k++) { const x = bars[k]; const tp = (x.h + x.l + x.c) / 3; pv += tp * x.v; vv += x.v; }
    vwap = vv > 0 ? pv / vv : null;
  }
  let hi = dayHigh ?? 0; if (!(dayHigh > 0)) for (let k = 0; k <= i; k++) hi = Math.max(hi, bars[k].h);
  const from = Math.max(0, i - P.lookback), vFrom = Math.max(0, i - P.volWin);
  let hiN = -Infinity, loN = Infinity; for (let k = from; k < i; k++) { hiN = Math.max(hiN, bars[k].h); loN = Math.min(loN, bars[k].l); }
  let vs = 0, vn = 0; for (let k = vFrom; k < i; k++) { vs += bars[k].v; vn++; }
  const volAvg = vn ? vs / vn : 0;
  const lim = limitPrices(prevClose);
  const c = b.c;
  const shortTarget = Math.max(vwap ?? 0, prevClose);
  return {
    c, chg: (c / prevClose - 1) * 100,
    hiUp: (hi / prevClose - 1) * 100,
    give: (hi - c) / prevClose * 100,
    vwap, vwapDev: vwap ? (c / vwap - 1) * 100 : null,
    volX: volAvg > 0 ? b.v / volAvg : null,
    brkUp: i - from >= P.lookback && c > hiN,
    brkDn: i - from >= P.lookback && c < loN,
    roomUp: (lim.up - c) / c * 100,
    roomDn: (c - shortTarget) / c * 100,
    limitUp: lim.up, shortTarget,
    minute: twMinute(b.t),
  };
}

/** 這一根是否觸發做多轉強 */
export function longTrigger(m, P = DEFAULT_PARAMS) {
  return m.minute >= P.startMin && m.minute <= P.endMin && m.brkUp && (m.volX ?? 0) >= P.volK
    && m.vwap != null && m.c > m.vwap && m.chg >= P.longMinChg && m.roomUp >= P.minRoom;
}
/** 這一根是否觸發做空轉弱 */
export function shortTrigger(m, P = DEFAULT_PARAMS) {
  return m.minute >= P.startMin && m.minute <= P.endMin && m.hiUp >= P.shortMinHiUp && m.brkDn && (m.volX ?? 0) >= P.volK
    && m.roomDn >= P.shortMinRoom;
}
/** 訊號成立後，這一根是否「現象停止」（多＝出貨、空＝回補） */
export function stopHit(side, bars, i, m, P = DEFAULT_PARAMS) {
  const from = Math.max(0, i - P.exitBars);
  const mode = side === 'long' ? P.longExit : P.shortExit;
  const useBars = mode === 'bars' || mode === 'both', useVwap = mode === 'vwap' || mode === 'both';
  if (side === 'long') {
    let lo = Infinity; for (let k = from; k < i; k++) lo = Math.min(lo, bars[k].l);
    return (useBars && m.c < lo) || (useVwap && m.vwap != null && m.c < m.vwap);
  }
  let hi = -Infinity; for (let k = from; k < i; k++) hi = Math.max(hi, bars[k].h);
  return (useBars && m.c > hi) || (useVwap && m.vwap != null && m.c > m.vwap);
}

/**
 * 狀態機：每收一根呼叫一次。回傳新狀態（不改舊物件）。
 *   phase：null（無訊號）→ 'on'（成立中，閃爍）→ 'stop'（現象停止，出貨/回補 icon）
 *   'stop' 之後若再次觸發，會重新進入 'on'。
 */
export function stepAlert(prev, side, bars, i, m, P = DEFAULT_PARAMS) {
  const s = prev ?? { phase: null };
  const trig = side === 'long' ? longTrigger(m, P) : shortTrigger(m, P);
  const t = bars[i].t;
  if (s.phase === 'on') {
    const best = side === 'long' ? Math.max(s.best, bars[i].h) : Math.min(s.best, bars[i].l);
    if (stopHit(side, bars, i, m, P)) {
      const ret = side === 'long' ? (m.c / s.entry - 1) * 100 : (1 - m.c / s.entry) * 100;
      return { ...s, phase: 'stop', stopAt: t, stopPx: m.c, best, ret: +ret.toFixed(2) };
    }
    return { ...s, best };
  }
  if (trig) return { phase: 'on', since: t, entry: m.c, best: m.c, room: +(side === 'long' ? m.roomUp : m.roomDn).toFixed(2), n: (s.n ?? 0) + 1 };
  return s;
}

// ── 線上採用的參數與回放證據（由 scripts/daytrade-alert-lab.mjs 決定；改參數必須重跑回放）──
export const ALERT_PARAMS = DEFAULT_PARAMS;
// 2026-09-23 回放（scripts/daytrade-alert-lab.mjs，Yahoo 1 分 K 22 交易日，前 60% 訓練／後 40% 樣本外）：
//   hit2＝成立後到收盤前最大順向 ≥2% 的比例；stop＝跟 🏁 出場淨報酬；close＝抱到收盤淨報酬（皆已扣 0.435%）。
export const ALERT_EVIDENCE = Object.freeze({
  from: '2026-08-25', to: '2026-09-23', days: 22, cut: '2026-09-11', cost: DT_COST,
  verdict: '1 分 K 突破／跌破本身沒有正期望（樣本外扣成本後皆為負）：這是盯盤提示，不是進場訊號',
  long: {
    all:   { trN: 770, teN: 519, trHit2: 46, teHit2: 41, trStop: -0.37, teStop: -0.55, teWin: 19, trClose: -0.50, teClose: -0.85 },
    early: { trN: 312, teN: 213, trHit2: 57, teHit2: 54, trStop: -0.33, teStop: -0.58, teWin: 22, trClose: -0.36, teClose: -0.97 },
    late:  { trN: 458, teN: 306, trHit2: 38, teHit2: 31, trStop: -0.40, teStop: -0.53, teWin: 18, trClose: -0.61, teClose: -0.78 },
  },
  short: {
    all:   { trN: 902, teN: 596, trHit2: 19, teHit2: 31, trStop: -0.59, teStop: -0.56, teWin: 16, trClose: -0.55, teClose: -0.08 },
    early: { trN: 58, teN: 56, trHit2: 41, teHit2: 55, trStop: -0.36, teStop: -0.50, teWin: 23, trClose: -0.47, teClose: 0.72 },
    late:  { trN: 844, teN: 540, trHit2: 18, teHit2: 28, trStop: -0.61, teStop: -0.56, teWin: 16, trClose: -0.55, teClose: -0.16 },
  },
});
