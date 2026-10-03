#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 官方注意有價證券（注意股）名單歷史（唯讀）——與處置名單（fetch_disposal.mjs）同一套紀律
//   上市：https://www.twse.com.tw/rwd/zh/announcement/notice?startDate=YYYYMMDD&endDate=YYYYMMDD&response=json
//         回聲：title「公布注意有價證券資訊 (起年月日 至 迄年月日 …)」；欄位 編號／證券代號／證券名稱／累計次數／注意交易資訊／日期／收盤價／本益比；
//         並驗證 data 筆數 == total（防止被截斷）
//   上櫃：https://www.tpex.org.tw/www/zh-tw/bulletin/attention?startDate=YYYY/MM/DD&endDate=YYYY/MM/DD&response=json
//         回聲：tables[0].title2「公布注意期間為 起 至 迄」；欄位 編號／證券代號／證券名稱／累計／注意交易資訊／公告日期／收盤價／本益比／link
//   兩個網域皆已登錄於 scripts/source-registry.json 並經使用者 2026-09-28 裁定 approved。
//   紀律：月為單位、請求間隔 2 秒、驗證回聲與筆數、失敗重試 3 次、任一月回聲對不上就中止。不寫 Firestore。
//   用法：node scripts/surge-lab/fetch_attention.mjs [輸出目錄] [起 YYYY-MM] [迄 YYYY-MM]
// ─────────────────────────────────────────────────────────────────────────
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2] || process.env.SURGE_CACHE || join(process.cwd(), '.surge-cache');
const FROM = process.argv[3] || '2022-07';
const TO = process.argv[4] || new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7);
mkdirSync(OUT, { recursive: true });
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TW-Stock-App/1.0)' };
const PACE = 2000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, '0');
const months = [];
for (let [y, m] = FROM.split('-').map(Number); `${y}-${pad(m)}` <= TO; m === 12 ? (y++, m = 1) : m++) months.push([y, m]);
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

async function getJson(url) {
  let err;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { err = e; await sleep(PACE * (i + 2)); }
  }
  throw new Error(`${url} 失敗：${err?.message}`);
}

const twse = [], tpex = []; let twseFields = null, tpexFields = null;
for (const [y, m] of months) {
  const ld = lastDay(y, m), ry = y - 1911;
  const j = await getJson(`https://www.twse.com.tw/rwd/zh/announcement/notice?startDate=${y}${pad(m)}01&endDate=${y}${pad(m)}${ld}&response=json`);
  const want = `${ry}年${pad(m)}月01日 至 ${ry}年${pad(m)}月${ld}日`;
  if (j.stat !== 'OK' || !String(j.title || '').includes(want)) throw new Error(`TWSE ${y}-${m} 回聲不符：stat=${j.stat} title=${j.title}（要含 ${want}）`);
  twseFields ||= j.fields;
  if (JSON.stringify(j.fields) !== JSON.stringify(twseFields)) throw new Error(`TWSE ${y}-${m} 欄位變了：${JSON.stringify(j.fields)}`);
  const n = (j.data || []).length;
  if (j.total != null && Number(j.total) !== n) throw new Error(`TWSE ${y}-${m} 筆數不符：total=${j.total} data=${n}（可能被截斷）`);
  for (const r of j.data || []) twse.push(r);
  await sleep(PACE);
  const k = await getJson(`https://www.tpex.org.tw/www/zh-tw/bulletin/attention?startDate=${y}/${pad(m)}/01&endDate=${y}/${pad(m)}/${ld}&response=json`);
  const t0 = k?.tables?.[0]; const wantT = `${ry}/${pad(m)}/01 至 ${ry}/${pad(m)}/${ld}`;
  if (!t0 || !String(t0.title2 || '').includes(wantT)) throw new Error(`TPEx ${y}-${m} 回聲不符：title2=${t0?.title2}（要含 ${wantT}）`);
  tpexFields ||= t0.fields;
  if (JSON.stringify(t0.fields) !== JSON.stringify(tpexFields)) throw new Error(`TPEx ${y}-${m} 欄位變了`);
  let c = 0; for (const r of t0.data || []) if (r[1]) { tpex.push(r); c++; }
  process.stdout.write(`${y}-${pad(m)} 上市 ${n}、上櫃 ${c}\n`);
  await sleep(PACE);
}
writeFileSync(join(OUT, 'attention_twse.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), from: FROM, to: TO, fields: twseFields, data: twse }));
writeFileSync(join(OUT, 'attention_tpex.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), from: FROM, to: TO, fields: tpexFields, data: tpex }));
console.log(`✓ 上市 ${twse.length} 筆、上櫃 ${tpex.length} 筆（${FROM}～${TO}）→ ${OUT}`);
