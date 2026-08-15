// ── 寶塔線（Tower/Pagoda Line）純計算模組 ────────────────────────────
// 2026-08-15 波段操作技能（使用者定義）：
//   紅K且站上月線（MA20）→ 未翻黑前可續抱；綠K且跌破月線 → 賣出。
//   短線（隔日沖/當沖模式）同規則，K 線圖改用 60 分K（MA 改 20 根 60 分K）。
// 口徑：寶塔線(3)＝三線轉向（與看盤軟體「寶塔線3」一致）：
//   收盤 > 前三根寶塔線最高點 → 翻紅；收盤 < 前三根寶塔線最低點 → 翻黑；
//   否則延續原色。每根寶塔線的區間＝前收→本收。
// ⚠ 古典規則技能：直接實作市場慣用定義，**未經本站 480 日主窗＋OOT 回測驗證**，
//   屬判讀輔助非實證權重——說明文字必須帶這句，不可省。
//
// 被 daemon（computePagodaSignals / holding-strategy ctx）與 web（型別橋）共用，
// 不要複製第二份實作。

/**
 * @param {number[]} closes 收盤序列（舊→新）
 * @param {number} n 轉向根數（預設 3）
 * @returns {{ bars: Array<{top:number,bot:number,red:boolean}>, color:'red'|'green'|null, run:number, flip:'up'|'down'|null }}
 *   color=最新色；run=連續同色根數；flip=最新一根是否為轉向根
 */
export function computePagoda(closes, n = 3) {
  const bars = [];
  if (!Array.isArray(closes) || closes.length < 2) return { bars, color: null, run: 0, flip: null };
  for (let i = 1; i < closes.length; i++) {
    const c = closes[i], p = closes[i - 1];
    const top = Math.max(c, p), bot = Math.min(c, p);
    if (!bars.length) { bars.push({ top, bot, red: c >= p }); continue; }
    const last = bars[bars.length - 1];
    const win = bars.slice(-n);
    let red = last.red;
    if (last.red) { if (c < Math.min(...win.map(b => b.bot))) red = false; }
    else { if (c > Math.max(...win.map(b => b.top))) red = true; }
    bars.push({ top, bot, red });
  }
  let run = 1;
  for (let i = bars.length - 2; i >= 0 && bars[i].red === bars[bars.length - 1].red; i--) run++;
  const lastBar = bars[bars.length - 1];
  const flip = bars.length >= 2 && bars[bars.length - 2].red !== lastBar.red
    ? (lastBar.red ? 'up' : 'down') : null;
  return { bars, color: lastBar.red ? 'red' : 'green', run, flip };
}

/**
 * 依使用者規則出具行動判定。
 * @param {number[]} closes 收盤序列（舊→新）
 * @param {number} maPeriod 均線根數（日K=20＝月線；60分K=20 根）
 * @param {number} n 寶塔轉向根數
 * @returns {null | { color:'red'|'green', run:number, flip:'up'|'down'|null,
 *   close:number, ma:number, above:boolean,
 *   action:'續抱'|'賣出'|'觀察'|'警戒', note:string }}
 */
export function judgePagoda(closes, maPeriod = 20, n = 3) {
  if (!Array.isArray(closes) || closes.length < maPeriod + 2) return null;
  const pg = computePagoda(closes, n);
  if (!pg.color) return null;
  const close = closes[closes.length - 1];
  const ma = closes.slice(-maPeriod).reduce((s, v) => s + v, 0) / maPeriod;
  const above = close > ma;
  let action, note;
  if (pg.color === 'red' && above) { action = '續抱'; note = '紅K×均線上，未翻黑前可續抱'; }
  else if (pg.color === 'green' && !above) { action = '賣出'; note = '綠K×均線下，符合賣出條件'; }
  else if (pg.color === 'red' && !above) { action = '觀察'; note = '紅K但收在均線下，不符續抱條件'; }
  else { action = '警戒'; note = '綠K但仍在均線上，留意翻黑轉弱'; }
  return { color: pg.color, run: pg.run, flip: pg.flip, close, ma: +ma.toFixed(2), above, action, note };
}
