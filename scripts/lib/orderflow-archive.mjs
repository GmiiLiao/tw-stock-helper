// ─────────────────────────────────────────────────────────────────────────
// 市場委託失衡歸檔（scripts/backfill-orderflow.mjs）的純函式：digest 與 openMarks（O8）
//   不打網路、不讀時鐘、不碰 Firestore；呼叫端給「同一份 MI_5MINS rwd 回應」。
//   2026-10-07 抽出 digest（原樣搬移，行為不變）並新增 openMarksFromResponse：
//     使用者 10/07 裁定 O8「從 daemon 每日 15:25 已在下載的 MI_5MINS 回應順便產出早盤衍生值 openMarks
//     （沿用 scripts/lib/open-sensor-marks.mjs 的口徑 openSensorMarks-v1、merge 寫入 orderFlowArchive，不增加請求）」。
//     規格：scratchpad warroom/opensensor/design-v2.1.md §8.5-1。
// ─────────────────────────────────────────────────────────────────────────
import * as M from './open-sensor-marks.mjs';

const num = s => +String(s ?? '').replace(/,/g, '') || 0;

// ⚠資料語意（2026-08-02 試跑實測，與欄位名稱不符，務必看清楚）：
//   欄位叫「**累積**委託買進數量」，但實測**不是單調遞增**——
//   2026-07-31 全日 3,241 列中有 **1,524 次下降**，首次在 09:00:20（開盤撮合時），
//   13:20 峰值 37,875,122 → 13:30 收盤 24,235,296（集合競價期間單次掉 429 萬張）。
//   ⇒ 它實際是**委託簿餘額**（掛入扣除已成交與已撤單），不是累積流入量。
//   ⇒ 「尾盤增量失衡」不能用相減（會是負數導致 null）；改用**失衡率的變化**，
//     並額外抓峰值與撤單率——後兩者正是餘額語意才有的資訊。
/** 3,241 列 → 壓縮：收盤餘額 + 每15分鐘曲線 + 衍生指標（欄位依位置：時間、委買筆、委買量、委賣筆、委賣量、成交筆、成交量、成交金額） */
export function digest(rows) {
  const parse = r => ({
    t: r[0], bo: num(r[1]), bv: num(r[2]), ao: num(r[3]), av: num(r[4]),
    tn: num(r[5]), tv: num(r[6]), tval: num(r[7]),
  });
  const all = rows.map(parse).filter(x => /^\d{2}:\d{2}:\d{2}$/.test(x.t));
  if (!all.length) return null;
  const last = all[all.length - 1];
  const at = t => all.filter(x => x.t <= t).pop() || null;
  const MARKS = ['09:00:00', '09:15:00', '09:30:00', '09:45:00', '10:00:00', '10:30:00', '11:00:00',
    '11:30:00', '12:00:00', '12:30:00', '13:00:00', '13:15:00', '13:25:00', '13:30:00'];
  const imb = x => (x.bv + x.av > 0 ? (x.bv - x.av) / (x.bv + x.av) : null);
  const curve = MARKS.map(t => { const x = at(t); return x ? [t.slice(0, 5), x.bv, x.av] : null; }).filter(Boolean);
  const c0930 = at('09:30:00'), c1300 = at('13:00:00'), c1325 = at('13:25:00');
  const r4 = v => (v == null ? null : +v.toFixed(4));
  // 峰值與撤單率：餘額語意才有的資訊（掛單熱度、以及尾盤有多少掛單被抽掉）
  let pkB = 0, pkA = 0;
  for (const x of all) { if (x.bv > pkB) pkB = x.bv; if (x.av > pkA) pkA = x.av; }
  return {
    bidOrders: last.bo, bidVol: last.bv, askOrders: last.ao, askVol: last.av,
    trans: last.tn, tradeVol: last.tv, tradeValue: last.tval,
    imbalance: r4(imb(last)),                              // 收盤委託簿失衡率 (-1~1)
    imb0930: r4(c0930 ? imb(c0930) : null),                // 早盤失衡（09:30）
    imb1300: r4(c1300 ? imb(c1300) : null),                // 尾盤前失衡（13:00）
    imb1325: r4(c1325 ? imb(c1325) : null),                // 集合競價前失衡（13:25）
    tailImbShift: r4(c1300 ? imb(last) - imb(c1300) : null),   // 13:00→收盤 失衡「率」的變化
    auctionShift: r4(c1325 ? imb(last) - imb(c1325) : null),   // 集合競價期間失衡變化
    peakBidVol: pkB, peakAskVol: pkA,
    bidWithdraw: pkB > 0 ? r4(1 - last.bv / pkB) : null,   // 委買撤單率＝1−收盤/峰值
    askWithdraw: pkA > 0 ? r4(1 - last.av / pkA) : null,
    bidPerOrder: last.bo > 0 ? +(last.bv / last.bo).toFixed(2) : null,  // 平均每筆委買量（大單/小單）
    askPerOrder: last.ao > 0 ? +(last.av / last.ao).toFixed(2) : null,
    fillRate: last.bv + last.av > 0 ? r4(last.tv * 2 / (last.bv + last.av)) : null,
    curveJson: JSON.stringify(curve),
    n: all.length,
  };
}

/**
 * openMarks 全日三值 vs digest（同一份回應的兩種解析：digest 依欄位**位置**、parseMi5 依欄**名稱**）。
 *   單位：digest.tradeValue＝官方百萬元、openMarks.day.yi＝億元（百萬元÷100）；量（張）與筆數兩邊同單位。
 *   三值全等才 true——欄位順序變了或解析有誤時兩邊會不一致，那一天就不寫 openMarks。
 */
export function openMarksTotalsMatch(om, dg) {
  if (!om?.day || !dg) return false;
  return Number.isFinite(om.day.yi) && Math.round(om.day.yi * 100) === dg.tradeValue
    && om.day.lots === dg.tradeVol && om.day.tx === dg.trans;
}

/**
 * 同一份 MI_5MINS rwd 回應 → openMarks（口徑 openSensorMarks-v1，與 backfill-open-sensor.mjs 回補的 60 日同形）。
 *   任何一關不過就回 { openMarks:null, reason }，**不丟錯**——openMarks 失敗不可以拖垮 digest 的寫入
 *   （daemon 以子程序結束碼判成敗；丟錯會讓 daemon 每 5 分鐘重打一次 MI_5MINS）。
 *   關卡：① 回音（stat=OK、頂層 date、title 民國日期＝請求日）② 依欄名解析與衍生 ③ 已收盤（最後成交列 ≥13:30:00；
 *   盤中或半日市的占比分母不是全日，不寫）④ 全日金額／量／筆數＝digest。
 * @param {object} j    rwd 回應（至少 stat、date、title、fields、data）
 * @param {string} iso  請求日 'YYYY-MM-DD'
 * @param {object} dg   同一份回應的 digest(j.data)
 * @param {{src?:string|null}} [opt]
 * @returns {{openMarks:object|null, reason:string|null}}
 */
export function openMarksFromResponse(j, iso, dg, { src = null } = {}) {
  try {
    const echo = M.echoCheck(j, iso);
    if (!echo.ok) return { openMarks: null, reason: `回音不符（${echo.status}${echo.note ? '：' + echo.note : ''}）` };
    const om = M.deriveOpenMarks(M.parseMi5(j));
    if (!om.complete) return { openMarks: null, reason: `未收盤（最後成交列 ${om.day.t}）` };
    if (!openMarksTotalsMatch(om, dg)) {
      return { openMarks: null, reason: `全日三值與 digest 不一致（openMarks ${om.day.yi} 億／${om.day.lots} 張／${om.day.tx} 筆；digest ${dg?.tradeValue} 百萬元／${dg?.tradeVol} 張／${dg?.trans} 筆）` };
    }
    return { openMarks: { ...om, src, echo: echo.echo }, reason: null };
  } catch (e) {
    return { openMarks: null, reason: `解析失敗：${String(e?.message || e).slice(0, 120)}` };
  }
}

/**
 * orderFlowArchive/{date} 的寫入內容（呼叫端以 set(…, { merge:true }) 寫入）。
 *   沒有 digest ⇒ null（不寫，不建只有 openMarks 的空殼）；openMarks 為 null ⇒ 不帶這個鍵（不覆蓋、不寫 null）。
 *   clearSkipped：呼叫端傳 FieldValue.delete()——舊版整份覆寫會順手清掉 skipped 標記，改 merge 後要明講才會清。
 */
export function dayDocPayload({ iso, dg, openMarks = null, fetchedAt, clearSkipped }) {
  if (!dg) return null;
  return {
    date: iso, ...dg,
    ...(openMarks ? { openMarks } : {}),
    ...(clearSkipped !== undefined ? { skipped: clearSkipped } : {}),
    fetchedAt,
  };
}
