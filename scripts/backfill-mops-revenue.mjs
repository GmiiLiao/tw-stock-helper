#!/usr/bin/env node
// ── MOPS 月營收「逐檔逐月」歷史回補 ──────────────────────────────────
//
// 事故（2026-08-10 四源稽核發現）：
//   daemon 的 computeRevenue 只寫 `revenue/latest`，內容是 { month, topYoY, topMoM }
//   ——**兩張 20 名排行榜**。全市場 1,900 檔的當月營收、上月、去年同月、累計，
//   抓下來算完排行就丟了。想回頭問「這檔去年 3 月營收多少」→ 沒有。
//
// 好消息是這一源**真的可以補三年**：MOPS 的月營收彙總表是靜態 HTML，
//   上市 https://mopsov.twse.com.tw/nas/t21/sii/t21sc03_{民國年}_{月}_0.html
//   上櫃 https://mopsov.twse.com.tw/nas/t21/otc/t21sc03_{民國年}_{月}_0.html
//   實測 112_8（2023-08）仍為 43 萬 bytes 有效內容。
//
// ⚠ 三個踩過的坑，改這支之前先讀：
//   ① 編碼是 **big5**，不是 UTF-8。用 `new TextDecoder('big5')`，
//      直接 `res.text()` 會拿到一堆亂碼且公司名全毀。
//   ② 頁面有 68 個 <table>（排版用巢狀表），不能用「第 N 個表格」定位，
//      要**用列的欄數與內容特徵**篩：11 欄、第 1 欄是 4 碼代號。
//   ③ 民國年 = 西元 − 1911。月份**不補零**（是 `_8_` 不是 `_08_`）。
//
// 存法：`revenueArchive/{YYYY-MM}`，一個月一份 doc，rowsJson 放全市場。
//       doc id 用**資料所屬月份**（不是公布月），與 chipArchive 的 date 語意一致。

import admin from 'firebase-admin';
import { pathToFileURL } from 'node:url';

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const MARKETS = [['sii', '上市'], ['otc', '上櫃']];
const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 抓單一（市場, 年, 月）的彙總表，回傳 [{c,n,rev,prev,yoyRev,mom,yoy,cum}]
async function fetchMonth(mkt, rocYear, month) {
  const url = `https://mopsov.twse.com.tw/nas/t21/${mkt}/t21sc03_${rocYear}_${month}_0.html`;
  let buf;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) return { rows: [], err: `HTTP ${r.status}` };
    buf = Buffer.from(await r.arrayBuffer());
  } catch (e) { return { rows: [], err: e.message }; }

  const html = new TextDecoder('big5').decode(buf);
  const out = [];
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(x => x[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
    if (tds.length < 8) continue;
    const code = tds[0];
    if (!/^\d{4}$/.test(code)) continue;          // 表頭、產業分類列、合計列全被這道濾掉
    const rev = num(tds[2]);
    if (rev <= 0) continue;                       // 無營收（新上市未公布）不佔位
    out.push({
      c: code, n: tds[1],
      rev: Math.round(rev),                       // 當月營收（千元）
      prev: Math.round(num(tds[3])),              // 上月營收
      last: Math.round(num(tds[4])),              // 去年當月營收
      mom: +num(tds[5]).toFixed(2),               // 上月比較增減 %
      yoy: +num(tds[6]).toFixed(2),               // 去年同月增減 %
      cum: Math.round(num(tds[7])),               // 當月累計營收
    });
  }
  return { rows: out, err: null };
}

// months：往回幾個月。logFn 讓 daemon 也能呼叫並吐到自己的 log。
export async function backfillMopsRevenue(months = 36, logFn = console.log) {
  // 最新一筆可得的是「上個月」的營收（本月 10 日前公布上月）。
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  let ok = 0, skip = 0, fail = 0;
  for (let i = 0; i < months; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() - i, 1);
    const y = d.getFullYear(), mo = d.getMonth() + 1;
    const id = `${y}-${String(mo).padStart(2, '0')}`;
    const roc = y - 1911;

    // ⚠ 略過門檻不能設「有就跳過」，也不能設得太鬆：
    //   daemon 走 openapi 只涵蓋 ~1,350 檔，若門檻是 >1000 就會把那份薄資料
    //   誤判成「已完整」而永遠不再加厚。一個完整月份是 1,775–1,850 檔，
    //   所以門檻設 1700——低於此就當作不完整，重抓 MOPS 彙總表補厚。
    const exist = await db.collection('revenueArchive').doc(id).get();
    const prevN = exist.exists ? (exist.data()?.n ?? 0) : 0;
    if (prevN >= 1700) { skip++; continue; }

    const all = [];
    const per = {};
    for (const [mkt, label] of MARKETS) {
      const { rows, err } = await fetchMonth(mkt, roc, mo);
      per[label] = rows.length;
      if (err) per[label] = `ERR ${err}`;
      all.push(...rows);
      await sleep(400);                            // MOPS 沒有公布 rate limit，保守 pacing
    }

    if (all.length < 800 || all.length < prevN) {
      logFn(`✗ ${id}（民國${roc}_${mo}）解析 ${all.length} 筆（既有 ${prevN}）${JSON.stringify(per)} — 不寫入`);
      fail++;
      continue;
    }
    const json = JSON.stringify(all);
    await db.collection('revenueArchive').doc(id).set({
      month: id, n: all.length, rowsJson: json, bytes: json.length,
      bySrc: per, at: Date.now(),
    });
    logFn(`✓ ${id}：${all.length} 檔（${JSON.stringify(per)}）${(json.length / 1024).toFixed(0)}KB`);
    ok++;
  }
  logFn(`月營收回補完成：新寫 ${ok}、已完整略過 ${skip}、失敗 ${fail}`);
  return { ok, skip, fail };
}

// ⚠ 路徑含中文 → 必須用 pathToFileURL 正規化，否則直接執行會靜默不做事。
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  backfillMopsRevenue(parseInt(process.argv[2] || '36', 10))
    .then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
