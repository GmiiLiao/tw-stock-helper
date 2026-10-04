#!/usr/bin/env node
// a35_shadow 對答案前的「下一交易日收盤」唯讀補抓（只寫 .surge-cache/a35_*，不寫 Firestore、不動既有快取）。
//   1. Firestore chipArchive/{日期}（唯讀 get）→ .surge-cache/a35_shadow_close_{日期}.json：closeJson［收,量,開,高,低］＋ complete／otcPending 旗標
//   2. 官方除權息（上市 TWT49U＋上櫃 exDailyQ；scripts/lib/exright-source.mjs，兩網域皆已登錄核准）→ .surge-cache/a35_shadow_exright_{日期}.json
//      任一市場抓不到就把錯誤寫進檔內（scorer 會顯示警告：該市場當日除權息股的漲停判定可能不準）。
// 用法：GOOGLE_APPLICATION_CREDENTIALS=<金鑰檔> node a35_shadow_fetch.mjs 2026-10-05 [--no-exright] [--no-close]
// （a35_shadow_score.py --fetch 會自己帶入憑證；憑證路徑取自 daemon 的 launchd plist，不印出。）
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchExright } from '../lib/exright-source.mjs';
import { exrightRank } from '../lib/surge-shadow-daily.mjs';

const date = process.argv.slice(2).find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
if (!date) { console.error('需要 YYYY-MM-DD'); process.exit(2); }
const noEx = process.argv.includes('--no-exright'), noClose = process.argv.includes('--no-close');
const SP = process.env.SURGE_CACHE || fileURLToPath(new URL('./.surge-cache/', import.meta.url));
let rc = 0;

if (!noClose) {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credPath) { console.error('缺 GOOGLE_APPLICATION_CREDENTIALS'); process.exit(2); }
  initializeApp({ credential: cert(JSON.parse(readFileSync(credPath, 'utf8'))) });
  const snap = await getFirestore().collection('chipArchive').doc(date).get();      // 唯讀
  if (!snap.exists) { console.error(`chipArchive/${date} 還不存在（收盤資料尚未寫入）`); rc = 3; }
  else {
    const x = snap.data(); const close = x.closeJson ? JSON.parse(x.closeJson) : null;
    writeFileSync(`${SP}/a35_shadow_close_${date}.json`, JSON.stringify({ date, complete: x.complete ?? null, otcPending: x.otcPending ?? null, market: x.market ?? null, updatedAt: x.updatedAt ?? null, n: close ? Object.keys(close).length : 0, fetchedAt: Date.now(), close }));
    console.log(`chipArchive/${date}：${close ? Object.keys(close).length : 0} 檔；complete=${x.complete} otcPending=${x.otcPending}`);
    if (!close) rc = 3;
  }
}
if (!noEx) {
  let rec;
  try { const r = await fetchExright(date, date); rec = { date, from: date, to: date, counts: r.counts, items: r.items, fetchedAt: Date.now() }; console.log(`除權息 ${date}：${JSON.stringify(r.counts)}`); }
  catch (e) {
    // 共用函式任一市場失敗就整個 throw ⇒ 退而只抓上市（TWT49U，同 exright-source.mjs 的欄位與回聲檢查），上櫃缺口明記在檔內
    rec = { date, from: date, to: date, error: String(e?.message || e), items: [], fetchedAt: Date.now() };
    try {
      const num = s => { const v = parseFloat(String(s ?? '').replace(/,/g, '')); return Number.isFinite(v) ? v : null; };
      const roc = s => { const m = String(s || '').match(/^(\d{2,3})\D(\d{1,2})\D(\d{1,2})/); return m ? `${+m[1] + 1911}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null; };
      const u = `https://www.twse.com.tw/rwd/zh/exRight/TWT49U?startDate=${date.replace(/-/g, '')}&endDate=${date.replace(/-/g, '')}&response=json`;
      const j = await (await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.twse.com.tw/' }, signal: AbortSignal.timeout(30000) })).json();
      if (j?.stat === 'OK') {
        const f = j.fields || []; const iD = f.indexOf('資料日期'), iC = f.indexOf('股票代號'), iP = f.indexOf('除權息前收盤價'), iR = f.indexOf('除權息參考價');
        if (![iD, iC, iP, iR].some(i => i < 0)) rec.items = (j.data || []).map(r => { const d = roc(r[iD]), p = num(r[iP]), ref = num(r[iR]); const fac = p > 0 && ref > 0 ? +(ref / p).toFixed(6) : null; return d === date && fac && fac !== 1 && fac >= 0.3 && fac <= 1.2 ? [d, String(r[iC]).trim(), fac] : null; }).filter(Boolean);
        rec.twseOnly = true;
      }
    } catch (e2) { rec.twseError = String(e2?.message || e2); }
    console.error(`除權息（上市＋上櫃）抓取失敗：${rec.error}；上市單獨補抓 ${rec.twseOnly ? `成功 ${rec.items.length} 檔` : '也失敗'}`);
  }
  // 不准變差（2026-10-04 每日自動化會重試失敗的日子）：既有檔較完整（兩市 > 只有上市 > 都失敗）就保留，不用較差的結果覆蓋
  const path = `${SP}/a35_shadow_exright_${date}.json`;
  let prev = null;
  try { prev = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; } catch { prev = null; }
  if (prev && exrightRank(prev) > exrightRank(rec)) console.error(`除權息 ${date}：這次結果較差，保留既有檔（${exrightRank(prev)} > ${exrightRank(rec)}）`);
  else writeFileSync(path, JSON.stringify(rec));
  // 只補除權息（--no-close，每日協調器用）時，任一市場沒抓到就以 4 結束，讓狀態檔看得到；對答案的 --fetch 路徑結束碼不變
  if (noClose && rec.error) rc = 4;
}
process.exit(rc);
