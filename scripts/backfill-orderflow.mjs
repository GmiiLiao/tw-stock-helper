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
//
// 2026-10-07 使用者裁定 O8（開盤感應器 design-v2.1 §8.5-1）：同一份 MI_5MINS 回應順便產出早盤衍生值 openMarks
//   （口徑 openSensorMarks-v1，scripts/lib/open-sensor-marks.mjs），**不增加請求**。
//   · 只在「回音＝請求日、已收盤、全日金額／量／筆數＝digest」時才帶 openMarks；不過關只寫 digest、印一行原因，結束碼不變。
//   · 寫入改 set(…, { merge:true })：不覆蓋文件上其他欄位（例：回補的 indexMarks）；沒有 digest 就不寫（不建空殼）。
//   · 已存在的日子照舊跳過（不為補 openMarks 重打）；缺的日子用 scripts/backfill-open-sensor.mjs 回補（先回報使用者）。
//   · daemon 每交易日 ≥15:25 以子程序呼叫：execScript('backfill-orderflow.mjs', ['--days','1'], '📋 委託失衡', 5)，
//     結束碼 0 才標當日完成；daemon 日誌只記 stdout 最後一行（所以最後一行附 openMarks 寫入數）。
//   純函式（digest 原樣搬移、openMarks、寫入內容）與測試：scripts/lib/orderflow-archive.mjs(.test.mjs)。
// ─────────────────────────────────────────────────────────────────────────
import admin from 'firebase-admin';
import { digest, openMarksFromResponse, dayDocPayload } from './lib/orderflow-archive.mjs';
import { MI5_URL } from './lib/open-sensor-marks.mjs';

process.env.GOOGLE_APPLICATION_CREDENTIALS ||=
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DAYS = +arg('--days', 750);
const FROM = arg('--from', null);
const PACE = 1500;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ymd = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// 2026-08-02 首輪回補實測：TWSE 偶發回 **HTTP 307**（同一日期稍後重打即 200）
// ——是節流性質的暫時性錯誤，不是該日無資料。首版沒有重試，這些日子會變成缺洞
// 且因為只每 25 筆記錄一次日誌，真實缺漏數還看不出來。改為指數退避重試 3 次。
// 2026-10-07（O8）：除了 data 也回傳 stat／date／title／fields（parseMi5 依欄名解析、不猜位置）與 url（openMarks.src）。
async function fetchDay(ymd8, attempt = 0) {
  const url = MI5_URL(ymd8);   // 與舊版字串相同：https://www.twse.com.tw/rwd/zh/afterTrading/MI_5MINS?date=…&response=json
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
    return { rows: j.data, url, resp: { stat: j.stat, date: j.date, title: j.title, fields: j.fields, data: j.data } };
  } catch (e) {
    clearTimeout(t);
    if (attempt < 3) { await sleep(3000 * (attempt + 1)); return fetchDay(ymd8, attempt + 1); }
    return { err: e.name === 'AbortError' ? 'timeout' : e.message };
  }
}

// digest（3,241 列 → 收盤餘額＋每 15 分鐘曲線＋衍生指標）與資料語意說明已原樣搬到 scripts/lib/orderflow-archive.mjs。

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
  const skippedIds = new Set();   // 帶 skipped 標記的舊文件：會重抓；改 merge 後要明講清掉該標記（舊版整份覆寫會順手清掉）
  const snap = await db.collection('orderFlowArchive').get();
  for (const d of snap.docs) if (!d.data().skipped) done.add(d.id); else skippedIds.add(d.id);
  console.log(`  已存在 ${done.size} 日，將處理 ${dates.filter(d => !done.has(d.i)).length} 日\n`);

  let ok = 0, skip = 0, fail = 0, t0 = Date.now();
  let omOk = 0, omSkip = 0;   // O8 openMarks：隨 digest 寫入的日數／未寫（原因逐日印出）
  for (let n = 0; n < dates.length; n++) {
    const { y, i } = dates[n];
    if (done.has(i)) { skip++; continue; }
    const { rows, url, resp, err } = await fetchDay(y);
    if (err) {
      // 假日/停市回 no data 是正常的，不算失敗
      if (/no data|OK$/.test(err) === false && !/no data/.test(err)) fail++;
      if (n % 25 === 0) console.log(`  ${i} — ${err}`);
      await sleep(PACE);
      continue;
    }
    const dg = digest(rows);
    if (!dg) { fail++; await sleep(PACE); continue; }
    // O8：同一份回應順便產出 openMarks（0 新增請求）；不過關就只寫 digest（純函式不丟錯，不影響結束碼）
    const { openMarks, reason } = openMarksFromResponse(resp, i, dg, { src: url });
    if (openMarks) omOk++; else { omSkip++; console.log(`  ${i} openMarks 未寫：${reason}`); }
    const payload = dayDocPayload({
      iso: i, dg, openMarks, fetchedAt: Date.now(),
      clearSkipped: skippedIds.has(i) ? admin.firestore.FieldValue.delete() : undefined,
    });
    await db.collection('orderFlowArchive').doc(i).set(payload, { merge: true });
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
  // daemon 日誌只記這一行 ⇒ openMarks 的寫入數附在這裡
  console.log(`  orderFlowArchive 現有 ${ids.length} 日：${ids[0]} → ${ids[ids.length - 1]}｜openMarks 新寫 ${omOk} 日${omSkip ? `、未寫 ${omSkip} 日（原因見上）` : ''}`);
  process.exit(0);
};
main();
