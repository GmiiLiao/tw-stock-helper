#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 3 年法人籌碼回填 → chipArchive/{YYYY-MM-DD}
//
// 目的：現有 chipArchive 僅 93 天(2026-02-26 起)。要做「法人炒作 vs 長期持有」
//       的 3 年回測與權重分析，需先補足歷史日法人買賣超 + 收盤量價。
//
// 資料源(皆非美國封鎖，台灣機直抓)——欄位索引已於動工前實測鎖定：
//   TWSE 法人 T86            [0]代號 [4]外資超股 [10]投信超股 [18]三大法人超股
//   TWSE 價   MI_INDEX ALLBUT0999  個股表: [0]代號 [2]成交股 [5]開 [6]高 [7]低 [8]收
//   TPEx 法人 insti/dailyTrade EW  tables[0]: [0]代號 [4]外資超股 [13]投信超股 [23]三大法人合計
//     ※TPEx 比 TWSE 多「外資合計」分組：idx4=外資(不含自營) idx10=外資合計 idx13=投信
//   TPEx 價   afterTrading/dailyQuotes EW  tables[0]: [0]代號 [2]收 [4]開 [5]高 [6]低 [8]成交股
//
// 寫入 schema 對齊既有 chipArchive：
//   instJson  = { code: [外資淨張, 投信淨張] }        (股/1000 四捨五入)
//   closeJson = { code: [收, 量張, 開, 高, 低] }
//   source: 'backfill_3y'（區分於 daemon 即時寫入；既有 93 天不覆蓋）
//
// 特性：可續跑(doc 已存在即跳過)、禮貌節流、失敗退避重試、非交易日自動略過。
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const UA = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' };
const H_TWSE = { headers: { ...UA, Referer: 'https://www.twse.com.tw/' } };
const H_TPEX = { headers: { ...UA, Referer: 'https://www.tpex.org.tw/' } };

const START = process.env.BF_START || '2023-07-17'; // 3 年前
const END = process.env.BF_END || '2026-02-25';
const REPAIR = process.env.BF_REPAIR === '1';   // 修補模式：允許覆寫 daemon 寫壞的日子（僅加厚）
const THROTTLE_MS = 1600;                            // 每個請求間隔
const isNum4 = (c) => /^\d{4}$/.test(String(c || '').trim()); // 只留 4 位數普通股/ETF

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const numOf = (s) => {
  const n = parseFloat(String(s ?? '').replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const lots = (shares) => Math.round(numOf(shares) / 1000); // 股→張

async function fetchJson(url, h, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, h);
      const t = await r.text();
      try { return JSON.parse(t); } catch { return null; }
    } catch {
      await sleep(1500 * (i + 1));
    }
  }
  return null;
}

function ymd8(iso) { return iso.replace(/-/g, ''); }
function* dateRange(startIso, endIso) {
  const s = new Date(startIso + 'T00:00:00Z');
  const e = new Date(endIso + 'T00:00:00Z');
  for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // 週末
    yield d.toISOString().slice(0, 10);
  }
}

// ── 單日抓取：回傳 {inst, close} 或 null(非交易日) ──
async function fetchDay(iso) {
  const d8 = ymd8(iso);
  const inst = {}; // code -> [外資張, 投信張]
  const close = {}; // code -> [收, 量張, 開, 高, 低]

  // 1) TWSE 法人
  const t86 = await fetchJson(
    `https://www.twse.com.tw/rwd/zh/fund/T86?date=${d8}&selectType=ALL&response=json`, H_TWSE);
  await sleep(THROTTLE_MS);
  const twInstOk = t86 && t86.stat === 'OK' && Array.isArray(t86.data);
  if (twInstOk) {
    for (const r of t86.data) {
      const c = String(r[0] || '').trim();
      if (!isNum4(c)) continue;
      inst[c] = [lots(r[4]), lots(r[10])];
    }
  }

  // 2) TWSE 價
  const mi = await fetchJson(
    `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${d8}&type=ALLBUT0999&response=json`, H_TWSE);
  await sleep(THROTTLE_MS);
  const stkTbl = mi && Array.isArray(mi.tables)
    ? mi.tables.find((tb) => (tb.fields || []).some((f) => /證券代號/.test(f)) && tb.data && tb.data.length > 200)
    : null;
  if (stkTbl) {
    for (const r of stkTbl.data) {
      const c = String(r[0] || '').trim();
      if (!isNum4(c)) continue;
      const cl = numOf(r[8]);
      if (!(cl > 0)) continue;
      close[c] = [cl, lots(r[2]), numOf(r[5]), numOf(r[6]), numOf(r[7])];
    }
  }

  // 3) TPEx 法人
  // ⚠ TPEx 新版 API 只認 YYYY/MM/DD；8 位數日期會被「靜默忽略」回最新資料
  //（實案：首輪回填上櫃整批變今日快照）。斜線格式＋回應日期回聲驗證。
  const dSlash = `${d8.slice(0, 4)}/${d8.slice(4, 6)}/${d8.slice(6, 8)}`;
  const tpI = await fetchJson(
    `https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${encodeURIComponent(dSlash)}&id=&response=json`, H_TPEX);
  await sleep(THROTTLE_MS);
  const tpInstOk = tpI && String(tpI.date || '') === d8; // 回聲不符＝假日或被忽略，不得使用
  const tpInstTbl = tpInstOk && Array.isArray(tpI.tables) ? tpI.tables[0] : null;
  if (tpInstTbl && Array.isArray(tpInstTbl.data)) {
    for (const r of tpInstTbl.data) {
      const c = String(r[0] || '').trim();
      if (!isNum4(c)) continue;
      inst[c] = [lots(r[4]), lots(r[13])]; // 外資(不含自營)=idx4, 投信=idx13
    }
  }

  // 4) TPEx 價（同樣斜線格式＋回聲驗證）
  const tpP = await fetchJson(
    `https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=${encodeURIComponent(dSlash)}&type=EW&id=&response=json`, H_TPEX);
  await sleep(THROTTLE_MS);
  const tpPriceOk = tpP && String(tpP.date || '') === d8;
  const tpPriceTbl = tpPriceOk && Array.isArray(tpP.tables) ? tpP.tables[0] : null;
  if (tpPriceTbl && Array.isArray(tpPriceTbl.data)) {
    for (const r of tpPriceTbl.data) {
      const c = String(r[0] || '').trim();
      if (!isNum4(c)) continue;
      const cl = numOf(r[2]);
      if (!(cl > 0)) continue;
      close[c] = [cl, lots(r[8]), numOf(r[4]), numOf(r[5]), numOf(r[6])];
    }
  }

  // 非交易日：四源皆空
  if (!twInstOk && !stkTbl && Object.keys(inst).length === 0 && Object.keys(close).length === 0) return null;
  return { inst, close };
}

async function main() {
  const days = [...dateRange(START, END)];
  console.log(`[backfill] 範圍 ${START}→${END}，候選 ${days.length} 個工作日。既有 doc 自動跳過。`);
  let done = 0, skipped = 0, holidays = 0, failed = 0;

  for (const iso of days) {
    const ref = db.collection('chipArchive').doc(iso);
    const snap = await ref.get();
    // ── 修補模式 BF_REPAIR=1（2026-08-10 加）────────────────────────
    // 原本這兩行的契約是「daemon 寫過的日子一律不碰」。立意良善，但代價是
    // **daemon 自己寫壞的日子永遠修不好**——實測 2026-02-26…2026-07-31 這段
    // daemon 只寫進約 1,080 檔（全市場 1,950），收盤/法人整整五個月只有半個市場，
    // 而這兩行讓每一次回補都禮貌地跳過它們。
    // 修補模式改用「只准加厚不准變薄」判定：既有欄位已經夠厚才跳過。
    const cur = snap.exists ? snap.data() : null;
    const curN = (f) => { try { return Object.keys(JSON.parse(cur?.[f] || '{}')).length; } catch { return 0; } };
    if (REPAIR) {
      if (cur && curN('closeJson') >= 1500 && curN('instJson') >= 1500) { skipped++; continue; }
    } else {
      if (snap.exists && snap.data()?.source === 'backfill_3y') { skipped++; continue; }
      if (snap.exists && !snap.data()?.source) { skipped++; continue; } // 既有 daemon 寫入不覆蓋
    }

    const day = await fetchDay(iso);
    if (day === null) { holidays++; continue; }
    const instN = Object.keys(day.inst).length;
    const closeN = Object.keys(day.close).length;
    // 台股休市日守衛：TPEx API 在假日會回前一交易日資料（幻影），TWSE 才會空。
    // 2330 必在真交易日出現——無 2330 收盤 = 台股休市，跳過（實案 2026-07-17 清除 50 幻影日）。
    if (!day.close['2330']) { holidays++; continue; }
    if (instN < 100 || closeN < 100) { // 疑似部分失敗，不落地以免污染回測
      failed++;
      console.log(`[backfill] ⚠ ${iso} 資料不足(inst=${instN} close=${closeN})，略過`);
      continue;
    }
    // ⚠**一律 merge**：這份 doc 還住著 marginJson / lendingJson / dayTradeJson。
    //   原本是不帶 merge 的 set()，在只有「全新空白日」的原始用途下沒事，
    //   但修補既有日時會把那三個欄位整個抹掉——修一個洞挖三個洞。
    // 並且逐欄位比對筆數：只有比既有更厚才寫，避免上游當天半殘反而把好資料蓋薄。
    const patch = { date: iso, at: Date.now(), source: REPAIR ? 'repair_2026' : 'backfill_3y' };
    if (instN >= curN('instJson')) patch.instJson = JSON.stringify(day.inst);
    if (closeN >= curN('closeJson')) patch.closeJson = JSON.stringify(day.close);
    if (!patch.instJson && !patch.closeJson) { skipped++; continue; }
    await ref.set(patch, { merge: true });
    done++;
    if (done % 20 === 0) console.log(`[backfill] 進度 ${done} 落地 / ${skipped} 跳過 / ${holidays} 假日 / ${failed} 不足 …最新 ${iso}(inst=${instN} close=${closeN})`);
  }
  console.log(`[backfill] 完成：${done} 落地、${skipped} 跳過、${holidays} 假日、${failed} 不足。`);
  process.exit(0);
}
main().catch((e) => { console.error('[backfill] 失敗:', e); process.exit(1); });
