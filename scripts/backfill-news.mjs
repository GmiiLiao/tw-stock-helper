#!/usr/bin/env node
// ── 回補近 20+ 交易日全市場新聞 → newsDaily/{date} ──────────────────────
// 來源：鉅亨 cnyes tw_stock 新聞標題（startAt/endAt 可翻歷史）。
// 解讀（確定性，非 LLM）：① 個股提及＝標題含股名或4碼代號 ② 極性＝正/負面詞典。
// 產出 newsDaily/{iso}: { date, titles, mentions: {code: [則數, 正負淨值]} }
// 冪等：已存在的日期跳過（--force 重寫）。
import admin from 'firebase-admin';
import { createTpexClose } from './lib/tpex-close-quotes.mjs';
process.env.GOOGLE_APPLICATION_CREDENTIALS ||= '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();
const FORCE = process.argv.includes('--force');
const DAYS_BACK = 32; // 日曆日（涵蓋 ~22 交易日）

// 股名/代號對照（上市+上櫃）
// 2026-10-08：上櫃改讀共用取得層最近一份已驗證檔（0 請求；舊版直打 openapi 4.7MB、沒有逾時，失敗時靜默略過——上櫃新聞提及悄悄變 0 照寫 newsDaily）。
//   股名是慢變數，30 天內的檔都可用。任一市場讀不到就中止：不可用只有一個市場的對照表寫入（--force 會覆蓋舊資料）。
async function loadNames() {
  const map = {}; // name -> code
  const codes = new Set();
  let nTse = 0, nOtc = 0;
  try {
    const r = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
    if (r.ok) for (const x of await r.json()) if (/^\d{4}$/.test(x.Code)) { map[x.Name.trim()] = x.Code; codes.add(x.Code); nTse++; }
  } catch (e) { console.error('上市股名讀取失敗：', (e?.message || '').slice(0, 80)); }
  const lat = await createTpexClose({ network: 'never' }).getLatestTpexClose({ maxAgeDays: 30 });
  for (const x of lat?.rows || []) { const c = String(x.SecuritiesCompanyCode || '').trim(); if (/^\d{4}$/.test(c)) { map[String(x.CompanyName || '').trim()] = c; codes.add(c); nOtc++; } }
  if (nTse < 500 || nOtc < 500) {
    console.error(`✖ 股名對照不完整（上市 ${nTse}／上櫃 ${nOtc}）——中止，不寫 newsDaily。上櫃讀共用快取／官方鏡像本機檔；沒有就先：node scripts/tpex-close-import.mjs <手動下載的上櫃收盤檔>`);
    process.exit(1);
  }
  console.log(`上櫃股名取自 ${lat.dataDate}（${lat.source}）`);
  // 股名≥2字才收（單字股名誤匹配率太高）
  for (const n in map) if (n.length < 2) delete map[n];
  return { map, codes };
}

const POS = /漲停|大漲|飆|急拉|創新高|新高|報喜|樂觀|看好|急單|大單|接單暢旺|營收創|獲利創|上修|調升|買超|加碼|轉盈|旺季|受惠|吃補|噴/;
const NEG = /跌停|大跌|重挫|急殺|創新低|警示|處置|注意股|下修|調降|賣超|示警|虧損|衰退|轉虧|停工|裁員|利空|降評|砍單|失守/;

// 標題 → 提及股票（先長名優先，避免「台積電」被「台積」搶走；代號直配）
function matchStocks(title, nameEntries, codes) {
  const hit = new Set();
  for (const m of title.matchAll(/\b(\d{4})\b/g)) if (codes.has(m[1])) hit.add(m[1]);
  for (const [name, code] of nameEntries) if (title.includes(name)) hit.add(code);
  return hit;
}

const { map: nameMap, codes } = await loadNames();
const nameEntries = Object.entries(nameMap).sort((a, b) => b[0].length - a[0].length);
console.log(`股名對照 ${nameEntries.length} 檔`);

// 4 天一窗分段抓（單窗頁數 >30 會 422）
const endAll = Math.floor(Date.now() / 1000);
const startAll = endAll - DAYS_BACK * 86400;
const byDate = {}; // iso -> {titles, mentions:{code:[n,pol]}}
let fetched = 0;
const WIN = 4 * 86400;
for (let ws = startAll; ws < endAll; ws += WIN) {
  const we = Math.min(ws + WIN, endAll);
  for (let page = 1; page <= 30; page++) {
    const url = `https://api.cnyes.com/media/api/v1/newslist/category/tw_stock?startAt=${ws}&endAt=${we}&limit=30&page=${page}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) { console.log('HTTP', r.status, '@', new Date(ws * 1000).toISOString().slice(0, 10)); break; }
    const j = await r.json();
    const items = j?.items?.data || [];
    if (!items.length) break;
    for (const it of items) {
      const iso = new Date((it.publishAt + 8 * 3600) * 1000).toISOString().slice(0, 10); // 台北日
      const d = (byDate[iso] ||= { titles: 0, mentions: {} });
      d.titles++;
      const title = it.title || '';
      const pol = (POS.test(title) ? 1 : 0) - (NEG.test(title) ? 1 : 0);
      for (const code of matchStocks(title, nameEntries, codes)) {
        const m = (d.mentions[code] ||= [0, 0]);
        m[0]++; m[1] += pol;
      }
    }
    fetched += items.length;
    if (page >= (j?.items?.last_page || 1)) break;
    await new Promise(res => setTimeout(res, 250));
  }
}
console.log(`抓取 ${fetched} 則標題，涵蓋 ${Object.keys(byDate).length} 個日曆日`);

let wrote = 0, skipped = 0;
for (const iso of Object.keys(byDate).sort()) {
  const ref = db.collection('newsDaily').doc(iso);
  if (!FORCE && (await ref.get()).exists) { skipped++; continue; }
  const d = byDate[iso];
  await ref.set({ date: iso, at: Date.now(), titles: d.titles, mentionsJson: JSON.stringify(d.mentions) });
  wrote++;
}
console.log(`newsDaily 寫入 ${wrote} 日、跳過(已存在) ${skipped} 日`);
const sample = Object.entries(byDate).sort().slice(-1)[0];
if (sample) {
  const top = Object.entries(sample[1].mentions).sort((a, b) => b[1][0] - a[1][0]).slice(0, 8);
  console.log(`樣本 ${sample[0]}：${sample[1].titles} 則，熱度前8：${top.map(([c, [n, p]]) => `${c}×${n}(極性${p >= 0 ? '+' : ''}${p})`).join(' | ')}`);
}
process.exit(0);
