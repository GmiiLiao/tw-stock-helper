// ─────────────────────────────────────────────────────────────────────────
// 市場委託買賣失衡 3 年回補 —— 2026-08-02
//
// ⚠先講清楚可行性邊界（2026-08-02 查證）：
//   · **個股五檔（bookDepth）無法回補** —— TWSE 只有即時 MIS，無任何歷史端點。
//     逐秒變動的委託簿快照，時間過了就不存在。只能從今天開始累積（見 4fe425c）。
//   · **市場層級委託失衡可以回補** —— `MI_5MINS`（每5秒委託成交統計）
//     rwd 版可帶 date 參數，實測 2023/2024/2025 皆回 3,241 列、stat=OK。
//
// 為什麼值得回補：KD 相對值檢定顯示失效來源是「時間/regime」，而大盤報酬、
//   波動、漲跌家數都抓不到那個開關（相關係數 ≤0.30）。委託失衡是**不同維度**
//   的資料——它是「掛單意圖」而非「成交結果」，與價量的重疊度理應較低。
//
// 儲存策略（不存原始 3,241 列，那是 3 年 × 3,241 × 8 欄的浪費）：
//   · final：13:30 收盤時的累積值（買/賣 筆數與數量、成交筆數/量/值）
//   · curve：每 15 分鐘取樣的失衡曲線（約 19 點）
//   · 衍生：日終失衡率、尾盤(13:00→13:30)失衡變化、平均每筆委託量（大單小單）
//
// 用法：node scripts/backfill-orderflow.mjs [--days 750] [--from YYYYMMDD]
// 節流：每次請求間隔 1.5 秒（TWSE rwd 無明文限制，比照本專案既有節流慣例）
// 冪等：已存在且非 skipped 的日期直接跳過，可中斷後重跑。
// ─────────────────────────────────────────────────────────────────────────
import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS ||=
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DAYS = +arg('--days', 750);
const FROM = arg('--from', null);
const PACE = 1500;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = s => +String(s ?? '').replace(/,/g, '') || 0;
const ymd = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// 2026-08-02 首輪回補實測：TWSE 偶發回 **HTTP 307**（同一日期稍後重打即 200）
// ——是節流性質的暫時性錯誤，不是該日無資料。首版沒有重試，這些日子會變成缺洞
// 且因為只每 25 筆記錄一次日誌，真實缺漏數還看不出來。改為指數退避重試 3 次。
async function fetchDay(ymd8, attempt = 0) {
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/MI_5MINS?date=${ymd8}&response=json`;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    if ((r.status === 307 || r.status === 429 || r.status >= 500) && attempt < 3) {
      await sleep(3000 * (attempt + 1));            // 3s → 6s → 9s
      return fetchDay(ymd8, attempt + 1);
    }
    if (!r.ok) return { err: `HTTP ${r.status}` };
    const j = await r.json();
    if (j.stat !== 'OK' || !Array.isArray(j.data) || !j.data.length) return { err: j.stat || 'no data' };
    // 回音驗證：標題的民國日期必須等於請求日（本專案鐵律，防端點前滾/落後）
    const m = (j.title || '').match(/(\d{2,3})年(\d{1,2})月(\d{1,2})日/);
    if (m) {
      const got = `${+m[1] + 1911}${String(+m[2]).padStart(2, '0')}${String(+m[3]).padStart(2, '0')}`;
      if (got !== ymd8) return { err: `日期回音不符 請求${ymd8}≠回應${got}` };
    }
    return { rows: j.data };
  } catch (e) {
    clearTimeout(t);
    if (attempt < 3) { await sleep(3000 * (attempt + 1)); return fetchDay(ymd8, attempt + 1); }
    return { err: e.name === 'AbortError' ? 'timeout' : e.message };
  }
}

// ⚠資料語意（2026-08-02 試跑實測，與欄位名稱不符，務必看清楚）：
//   欄位叫「**累積**委託買進數量」，但實測**不是單調遞增**——
//   2026-07-31 全日 3,241 列中有 **1,524 次下降**，首次在 09:00:20（開盤撮合時），
//   13:20 峰值 37,875,122 → 13:30 收盤 24,235,296（集合競價期間單次掉 429 萬張）。
//   ⇒ 它實際是**委託簿餘額**（掛入扣除已成交與已撤單），不是累積流入量。
//   ⇒ 「尾盤增量失衡」不能用相減（會是負數導致 null）；改用**失衡率的變化**，
//     並額外抓峰值與撤單率——後兩者正是餘額語意才有的資訊。
/** 3,241 列 → 壓縮：收盤餘額 + 每15分鐘曲線 + 衍生指標 */
function digest(rows) {
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

const main = async () => {
  const end = FROM ? new Date(`${FROM.slice(0, 4)}-${FROM.slice(4, 6)}-${FROM.slice(6, 8)}T00:00:00+08:00`) : new Date();
  const dates = [];
  for (let i = 0; i < DAYS; i++) {
    const d = new Date(end); d.setDate(d.getDate() - i);
    const w = d.getDay();
    if (w === 0 || w === 6) continue;               // 週末先排除（假日由端點回 no data 自然跳過）
    dates.push({ y: ymd(d), i: iso(d) });
  }
  dates.reverse();
  console.log(`▶ 市場委託失衡回補：${dates[0].i} → ${dates[dates.length - 1].i}（${dates.length} 個平日）`);

  // 冪等：已成功存過的跳過
  const done = new Set();
  const snap = await db.collection('orderFlowArchive').get();
  for (const d of snap.docs) if (!d.data().skipped) done.add(d.id);
  console.log(`  已存在 ${done.size} 日，將處理 ${dates.filter(d => !done.has(d.i)).length} 日\n`);

  let ok = 0, skip = 0, fail = 0, t0 = Date.now();
  for (let n = 0; n < dates.length; n++) {
    const { y, i } = dates[n];
    if (done.has(i)) { skip++; continue; }
    const { rows, err } = await fetchDay(y);
    if (err) {
      // 假日/停市回 no data 是正常的，不算失敗
      if (/no data|OK$/.test(err) === false && !/no data/.test(err)) fail++;
      if (n % 25 === 0) console.log(`  ${i} — ${err}`);
      await sleep(PACE);
      continue;
    }
    const dg = digest(rows);
    if (!dg) { fail++; await sleep(PACE); continue; }
    await db.collection('orderFlowArchive').doc(i).set({ date: i, ...dg, fetchedAt: Date.now() });
    ok++;
    if (ok % 25 === 0) {
      const el = (Date.now() - t0) / 1000;
      const rate = ok / el;
      const left = dates.length - n - 1;
      console.log(`  ${i} ✓ 已存 ${ok} 日｜失衡 ${dg.imbalance?.toFixed(4)}｜尾盤變化 ${dg.tailImbShift}｜剩約 ${Math.round(left / Math.max(rate, 0.01) / 60)} 分`);
    }
    await sleep(PACE);
  }
  console.log(`\n✓ 完成：新增 ${ok} 日、已存跳過 ${skip} 日、失敗 ${fail} 日（耗時 ${Math.round((Date.now() - t0) / 60000)} 分）`);
  const fin = await db.collection('orderFlowArchive').get();
  const ids = fin.docs.filter(d => !d.data().skipped).map(d => d.id).sort();
  console.log(`  orderFlowArchive 現有 ${ids.length} 日：${ids[0]} → ${ids[ids.length - 1]}`);
  process.exit(0);
};
main();
