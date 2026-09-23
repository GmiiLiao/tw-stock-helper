// ─────────────────────────────────────────────────────────────────────────────
// 當沖工作台：Setup 掃描器（唯一實作——daemon、回放實驗室共用；前端只讀結果）
//
// 來源：使用者 2026-09-23 提供的 tw-day-trading 技巧（Market 20 + Stock 50 + Entry 30、
//   ORB／突破回踩／開低反轉、硬性否決、1R/2R/3R、時間停損、交易日誌與樣本外迭代）。
//   該技巧原文**只涵蓋做多**；做空為本站鏡像延伸（先賣後買、停損在上方），權重與門檻未經驗證。
//
// 設計：**無狀態重掃**——每收一根 1 分 K，就用「到這根為止」的整串 K 棒從頭掃一次，
//   得到當下的 setup 階段、已觸發交易、出場與假突破。好處：daemon 重啟後只要 K 棒在就能重建；
//   回放與線上跑的是同一個函式，結果逐根可對。成本：每檔每分鐘 O(270)，36 檔可忽略。
//
// 所有判斷只用「到第 i 根為止」的資料；結構停損、目標價事前寫定，觸發後不得放寬。
// ─────────────────────────────────────────────────────────────────────────────
import { limitPrices, twMinute } from './daytrade-signals.mjs';

export const DESK_VERSION = 'dt-desk-v1';   // 規則版本（日誌 rule_version）；改任何參數或規則都要升版

export const DESK_PARAMS = Object.freeze({
  orbBars: 5,              // 開盤區間＝前 5 根 1 分 K（09:00–09:04）；當天不得事後改
  confirmBars: 3,          // 突破後幾根內要「站穩→再攻」，逾時視為未確認
  retestTolPct: 0.3,       // 回測容許跌回關鍵位下方幾 %（仍算守住）
  volK: 1.5,               // 突破／再攻那根量 ≥ 前 10 根均量 × K
  olrGapPct: 1,            // 開低反轉：開盤 ≤ 昨收 −1%
  olrLastMin: 11 * 60,     // 開低反轉只在 11:00 前成立
  timeStopBars: 20,        // 時間停損：觸發後 20 根仍未走出 0.5R ⇒ 出場（技巧原文：10–20 分鐘示例觀察窗）
  vwapStopBars: 2,         // VWAP 停損：連續 2 根收在 VWAP 下（空：上）視為無法收復
  noNewAfter: 12 * 60 + 30,  // 12:30 後不提新進場
  closeOut: 13 * 60 + 20,  // 13:20 起以完成沖銷為優先：強制出場
  maxStopPct: 3,           // 每股風險 d 超過進場價 3% ⇒ 否決（停損距離失衡）
  maxVwapDevPct: 3,        // 距 VWAP 超過 3% ⇒ 否決（追價）
  minNetR2: 1.5,           // 2R 目標扣成本後淨 R < 1.5 ⇒ 否決（淨風險報酬不足）
  nearLimitPct: 1,         // 距漲停（空：跌停）< 1% ⇒ 否決（難以成交／反向沖銷）
  costPct: 0.435,          // 日誌口徑成本（手續費 0.1425%×2 未折讓＋當沖稅 0.15%）；前端改用使用者自己的券商設定
  split: [1 / 3, 1 / 3, 1 / 3],   // 出場計畫：1R 落袋 1/3、2R 再 1/3、餘部追蹤到 3R 或停損
});

const tickOf = p => (p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5);
/** 依合法跳動單位取價（多：目標向下取、停損向下取；由呼叫端決定方向） */
export function roundTick(p, dir = 0) {
  const t = tickOf(p); const k = p / t;
  const r = dir > 0 ? Math.ceil(k - 1e-9) : dir < 0 ? Math.floor(k + 1e-9) : Math.round(k);
  return +(r * t).toFixed(2);
}

/**
 * 掃描一檔一側（long/short）到第 last 根為止的狀態。
 * ctx：{ prevClose, prevHigh, prevLow, vwapOfBar?: (i)=>number|null }（vwapOfBar 缺時以 K 棒典型價×量累積）
 * 回傳：{ orb, trades[], active, watch, falseBreaks[], vetoed[] }
 */
export function scanDesk(bars, side, ctx, P = DESK_PARAMS, last = bars.length - 1) {
  const L = side === 'long';
  const above = (a, b) => (L ? a > b : a < b);          // 「順勢方向超過」
  const hiOf = b => (L ? b.h : b.l);                     // 順勢極值
  const loOf = b => (L ? b.l : b.h);                     // 逆勢極值
  const ext = (a, b) => (L ? Math.max(a, b) : Math.min(a, b));
  const extInv = (a, b) => (L ? Math.min(a, b) : Math.max(a, b));
  const sgn = L ? 1 : -1;
  const lim = limitPrices(ctx.prevClose);
  const limitFar = L ? lim.up : lim.down;

  // VWAP（逐根累積；有 daemon 取樣 VWAP 時用 vwapOfBar）
  const vw = []; { let pv = 0, vv = 0; for (let i = 0; i <= last; i++) { const b = bars[i]; pv += ((b.h + b.l + b.c) / 3) * b.v; vv += b.v; vw.push(ctx.vwapOfBar?.(i) ?? (vv > 0 ? pv / vv : null)); } }
  const volAvg = i => { let s = 0, n = 0; for (let k = Math.max(0, i - 10); k < i; k++) { s += bars[k].v; n++; } return n ? s / n : 0; };

  const out = { orb: null, trades: [], active: null, watch: [], falseBreaks: [], vetoed: [] };
  if (last < 0) return out;
  const t0min = twMinute(bars[0].t);
  // 開盤區間：只取 09:00 起的前 orbBars 根（daemon 若 09:02 才開始取樣，區間不完整 ⇒ 不做 ORB）
  if (t0min <= 9 * 60 + 1 && last >= P.orbBars - 1) {
    let H = -Infinity, Lo = Infinity; for (let k = 0; k < P.orbBars; k++) { H = Math.max(H, bars[k].h); Lo = Math.min(Lo, bars[k].l); }
    out.orb = { O: bars[0].o, H, L: Lo, formedAt: bars[P.orbBars - 1].t };
  }
  const orbHi = out.orb ? (L ? out.orb.H : out.orb.L) : null;   // 順勢突破位
  const orbLo = out.orb ? (L ? out.orb.L : out.orb.H) : null;   // 區間另一端
  const keyLevel = L ? ctx.prevHigh : ctx.prevLow;                // 突破回踩的關鍵位（昨高／昨低）
  const gapOk = out.orb && (L ? out.orb.O <= ctx.prevClose * (1 - P.olrGapPct / 100) : out.orb.O >= ctx.prevClose * (1 + P.olrGapPct / 100));

  // setup 追蹤器
  let orb = { phase: out.orb ? 'armed' : 'none', brk: -1, used: false };
  let brt = { phase: keyLevel > 0 ? 'armed' : 'none', brk: -1, brkVol: 0, extSince: null, pbLow: null, pb: false };
  let olr = { used: false };
  let tr = null;           // 進行中的交易
  let vwBelow = 0;

  const openTrade = (i, type, stop, why) => {
    const b = bars[i]; const entry = b.c; const d = sgn * (entry - stop);
    const m = twMinute(b.t);
    const costR = d > 0 ? (entry * P.costPct / 100) / d : Infinity;
    const t1 = roundTick(entry + sgn * d, -sgn), t2 = roundTick(entry + sgn * 2 * d, -sgn), t3 = roundTick(entry + sgn * 3 * d, -sgn);
    const vwDev = vw[i] ? (entry / vw[i] - 1) * 100 * sgn : null;
    const veto = [];
    if (!(d > 0)) veto.push('停損不在進場價的反方向（d≤0）');
    else if (d / entry * 100 > P.maxStopPct) veto.push(`每股風險 ${(d / entry * 100).toFixed(1)}% > ${P.maxStopPct}%（停損距離失衡）`);
    if (m > P.noNewAfter) veto.push('12:30 後不提新進場');
    if (vwDev != null && vwDev > P.maxVwapDevPct) veto.push(`距 VWAP ${vwDev.toFixed(1)}% > ${P.maxVwapDevPct}%（追價）`);
    if (sgn * (limitFar - entry) / entry * 100 < P.nearLimitPct) veto.push(`距${L ? '漲' : '跌'}停 < ${P.nearLimitPct}%（難以成交／反向沖銷）`);
    if (d > 0 && sgn * (limitFar - t2) < 0) veto.push(`2R 目標 ${t2} 超過${L ? '漲' : '跌'}停 ${limitFar}（空間不足）`);
    const netR2 = 2 - costR;
    if (d > 0 && netR2 < P.minNetR2) veto.push(`2R 扣成本後淨 ${netR2.toFixed(2)}R < ${P.minNetR2}R`);
    const trade = { onSide: vw[i] != null && above(entry, vw[i]), type, why, idx: i, t: b.t, minute: m, entry, stop: roundTick(stop, -sgn), d: +d.toFixed(3), costR: +costR.toFixed(3), targets: [t1, t2, t3], limit: limitFar,
      vwDev: vwDev != null ? +vwDev.toFixed(2) : null, veto, best: entry, hit: [false, false, false], trail: roundTick(stop, -sgn), fills: [], exit: null };
    if (veto.length) { out.vetoed.push(trade); return null; }
    out.trades.push(trade);
    return trade;
  };

  for (let i = 0; i <= last; i++) {
    const b = bars[i]; const m = twMinute(b.t); const vwap = vw[i]; const va = volAvg(i);
    // ── 進行中的交易：更新最佳價、目標、出場 ──
    if (tr) {
      tr.best = ext(tr.best, hiOf(b));
      for (let k = 0; k < 3; k++) if (!tr.hit[k] && sgn * (hiOf(b) - tr.targets[k]) >= 0) {
        tr.hit[k] = true; tr.fills.push({ k, px: tr.targets[k], t: b.t });
        if (k === 0) tr.trail = ext(tr.trail, tr.entry);                          // 1R 後停損移到成本
        if (k === 1) tr.trail = ext(tr.trail, tr.targets[0]);                     // 2R 後停損移到 1R
      }
      // VWAP 停損＝「跌破且無法收復」：必須先在 VWAP 順勢側收過一根，之後連續收在另一側才算（進場就在 VWAP 下的不因此出場）
      if (vwap != null && above(b.c, vwap)) tr.onSide = true;
      vwBelow = tr.onSide && vwap != null && !above(b.c, vwap) ? vwBelow + 1 : 0;
      let reason = null, px = b.c;
      if (tr.hit[2]) { reason = '達 3R'; px = tr.targets[2]; }
      else if (!above(b.c, tr.trail) && b.c !== tr.trail) reason = tr.hit[0] ? (tr.hit[1] ? '跌回 1R（追蹤停損）' : '回到成本（保本停損）') : '結構停損';
      else if (vwBelow >= P.vwapStopBars && !tr.hit[0]) reason = `連 ${P.vwapStopBars} 根${L ? '收在' : '站上'} VWAP ${L ? '下' : '上'}（VWAP 停損）`;
      else if (i - tr.idx >= P.timeStopBars && sgn * (tr.best - tr.entry) < 0.5 * tr.d && !tr.hit[0]) reason = `時間停損（${P.timeStopBars} 分鐘未走出 0.5R）`;
      else if (m >= P.closeOut) reason = '13:20 收盤前沖銷';
      if (reason) {
        tr.exit = { t: b.t, px, reason, idx: i };
        // 淨 R：依出場計畫加權（已達的目標按目標價、其餘按出場價），扣成本
        let r = 0; for (let k = 0; k < 3; k++) r += P.split[k] * (tr.hit[k] ? (k + 1) : sgn * (px - tr.entry) / tr.d);
        tr.netR = +(r - tr.costR).toFixed(2);
        tr.mfeR = +(sgn * (tr.best - tr.entry) / tr.d).toFixed(2);
        tr = null; vwBelow = 0;
      }
      continue;   // 持倉中不提新 setup（新進場須是新的完整 setup）
    }
    if (m > P.noNewAfter && m < P.closeOut) { /* 仍追蹤假突破，但不開新單 */ }

    // ── ORB：突破區間 → 站穩 → 再攻（只做一次）──
    if (orb.phase !== 'none' && !orb.used && i >= P.orbBars) {
      if (orb.phase === 'armed' && above(b.c, orbHi) && b.v >= P.volK * va) { orb.phase = 'broke'; orb.brk = i; orb.brkExt = hiOf(b); orb.low = loOf(b); }
      else if (orb.phase === 'broke' || orb.phase === 'held') {
        orb.low = extInv(orb.low, loOf(b));
        if (!above(b.c, orbHi) && b.c !== orbHi) { out.falseBreaks.push({ type: 'ORB', t: b.t, level: orbHi }); orb.phase = 'failed'; orb.used = true; }
        else if (orb.phase === 'broke' && i === orb.brk + 1) orb.phase = 'held';
        else if (orb.phase === 'held' && above(b.c, orb.brkExt)) {
          orb.used = true; orb.phase = 'triggered';
          tr = openTrade(i, 'ORB', extInv(orb.low, orbHi), `開盤區間 ${orbHi} 突破→站穩→再攻過 ${orb.brkExt}`);
          if (tr) continue;
        } else if (i - orb.brk > P.confirmBars) { orb.phase = 'expired'; orb.used = true; }
      }
    }
    // ── 突破回踩：過昨高（空：破昨低）→ 回測守住 → 再攻過回測後短線高 ──
    if (brt.phase !== 'none' && keyLevel > 0 && i >= P.orbBars) {   // 開盤前 5 根不認突破（技巧：避免憑第一根追價）
      if (brt.phase === 'armed' && above(b.c, keyLevel) && b.v >= P.volK * va) { brt = { phase: 'broke', brk: i, brkVol: b.v, extSince: hiOf(b), pbLow: null, pb: false }; }
      else if (brt.phase === 'broke') {
        const tolLevel = keyLevel * (1 - sgn * P.retestTolPct / 100);
        if (!above(b.c, tolLevel)) { out.falseBreaks.push({ type: '突破回踩', t: b.t, level: keyLevel }); brt = { phase: 'armed', brk: -1, brkVol: 0, extSince: null, pbLow: null, pb: false }; }
        else {
          if (!above(b.c, bars[i - 1].c) && b.v < brt.brkVol) { brt.pb = true; brt.pbLow = brt.pbLow == null ? loOf(b) : extInv(brt.pbLow, loOf(b)); }
          if (brt.pb && above(b.c, brt.extSince) && b.v >= P.volK * va) {
            const stop = brt.pbLow; brt.phase = 'armed'; brt.pb = false;   // 用過的回測不重用；跌回關鍵位下再重新 armed
            tr = openTrade(i, '突破回踩', stop, `${L ? '昨高' : '昨低'} ${keyLevel} 突破→量縮回測守住→再攻過 ${brt.extSince}`);
            brt.extSince = hiOf(b);
            if (tr) continue;
          } else brt.extSince = ext(brt.extSince, hiOf(b));
        }
      }
    }
    // ── 開低反轉（空：開高走低）：較高低點 ＋ 收復 VWAP ＋ 突破短線高 ──
    if (gapOk && !olr.used && m <= P.olrLastMin && i >= 6 && vwap != null) {
      let dayLo = loOf(bars[0]); for (let k = 0; k <= i; k++) dayLo = extInv(dayLo, loOf(bars[k]));
      let recentLo = loOf(bars[i - 5]), recentHi = hiOf(bars[i - 5]);
      for (let k = i - 5; k < i; k++) { recentLo = extInv(recentLo, loOf(bars[k])); recentHi = ext(recentHi, hiOf(bars[k])); }
      const higherLow = above(recentLo, dayLo);
      if (higherLow && above(b.c, vwap) && above(b.c, recentHi) && above(b.c, ctx.prevClose * (1 - sgn * P.olrGapPct / 100))) {
        olr.used = true;
        tr = openTrade(i, L ? '開低反轉' : '開高走低', recentLo, `開${L ? '低' : '高'} ${out.orb.O}→較${L ? '高低' : '低高'}點 ${recentLo}→收復 VWAP→過短線${L ? '高' : '低'} ${recentHi}`);
        if (tr) continue;
      }
    }
  }
  out.active = tr;
  // 盤中「等待中」的計畫：事前寫明觸發價與結構停損（尚未觸發）
  if (!tr) {
    if (orb.phase === 'armed' && !orb.used && out.orb) out.watch.push({ type: 'ORB', trigger: roundTick(orbHi + sgn * tickOf(orbHi), sgn), stop: roundTick(orbLo, -sgn), note: `等收盤${L ? '突破' : '跌破'}區間 ${orbHi} 且放量，再看站穩與再攻` });
    if (orb.phase === 'broke' || orb.phase === 'held') out.watch.push({ type: 'ORB', trigger: roundTick(orb.brkExt + sgn * tickOf(orb.brkExt), sgn), stop: roundTick(extInv(orb.low, orbHi), -sgn), note: `已${L ? '突破' : '跌破'} ${orbHi}，等站穩後再攻過 ${orb.brkExt}` });
    if (brt.phase === 'armed' && keyLevel > 0) out.watch.push({ type: '突破回踩', trigger: roundTick(keyLevel + sgn * tickOf(keyLevel), sgn), stop: null, note: `等放量${L ? '突破昨高' : '跌破昨低'} ${keyLevel}，再等量縮回測` });
    if (brt.phase === 'broke') out.watch.push({ type: '突破回踩', trigger: roundTick(brt.extSince + sgn * tickOf(brt.extSince), sgn), stop: brt.pbLow != null ? roundTick(brt.pbLow, -sgn) : null, note: brt.pb ? `回測守住 ${keyLevel}，等再攻過 ${brt.extSince}` : `已${L ? '突破' : '跌破'} ${keyLevel}，等量縮回測` });
  }
  return out;
}

// ── 回放證據（scripts/daytrade-alert-lab.mjs --desk，2026-09-23）──
// Yahoo 1 分 K 22 交易日（08-25～09-23，樣本外自 09-11）；母體＝昨漲≥5%∧均量≥1000 張（開盤前已知，兩側同母體）。
// 淨 R 已扣成本 0.435%。結論：v1 規則在此窗口**扣成本後為負**；依技巧的迭代規則，資料不足前不調參，先累積日誌。
export const DESK_EVIDENCE = Object.freeze({
  version: DESK_VERSION, from: '2026-08-25', to: '2026-09-23', days: 22, cut: '2026-09-11',
  verdict: 'v1 規則回放扣成本後為負（樣本外平均 −0.33R）：這是紀律與觀察工具，不是買賣訊號',
  long: {
    all: { trN: 215, teN: 118, trWin: 30, teWin: 26, trR: -0.21, teR: -0.33, teHit1: 37, teHit2: 19 },
    ORB: { trN: 38, teN: 17, trR: -0.09, teR: -0.64 },
    突破回踩: { trN: 127, teN: 89, trR: -0.11, teR: -0.25 },
    開低反轉: { trN: 50, teN: 12, trR: -0.54, teR: -0.50 },
  },
  short: {
    all: { trN: 151, teN: 95, trWin: 28, teWin: 23, trR: -0.32, teR: -0.33, teHit1: 39, teHit2: 15 },
    ORB: { trN: 57, teN: 37, trR: -0.40, teR: -0.48 },
    突破回踩: { trN: 18, teN: 4, trR: -0.50, teR: -0.22 },
    開高走低: { trN: 76, teN: 54, trR: -0.22, teR: -0.23 },
  },
});
