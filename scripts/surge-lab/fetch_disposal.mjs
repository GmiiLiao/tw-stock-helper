#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 官方處置有價證券名單歷史（唯讀）——用來驗證「當沖資料缺值＝處置／禁當沖」的代理（起漲特徵實驗 v2 後續）
//   上市：https://www.twse.com.tw/rwd/zh/announcement/punish?startDate=YYYYMMDD&endDate=YYYYMMDD&response=json
//         （回聲：title「公布處置有價證券資訊 (起 至 迄)」；欄位 編號／公布日期／證券代號／證券名稱／累計／處置條件／處置起迄時間／處置措施／處置內容）
//   上櫃：https://www.tpex.org.tw/www/zh-tw/bulletin/disposal?startDate=YYYY/MM/DD&endDate=YYYY/MM/DD&response=json
//         （回聲：tables[0].title2「處置期間為 起 ~ 迄」；注意 disposal_information_result.php 變體會忽略日期、只回最新，不可用）
//   兩個網域皆已登錄於 scripts/source-registry.json 並經使用者 2026-09-28 裁定 approved。
//   紀律：以月為單位、請求間隔 2 秒、驗證回聲日期（不只看 stat=OK）、失敗重試 3 次、任一月份回聲對不上就中止（不得以空表當作沒有處置）。
//   不寫 Firestore。用法：node scripts/surge-lab/fetch_disposal.mjs [輸出目錄] [起 YYYY-MM] [迄 YYYY-MM]
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

const months = [];
for (let [y, m] = FROM.split('-').map(Number); `${y}-${String(m).padStart(2, '0')}` <= TO; m === 12 ? (y++, m = 1) : m++) months.push([y, m]);
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const roc = (y, m, d) => `${y - 1911}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`;

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

const twse = [], tpex = []; const log = [];
let twseFields = null, tpexFields = null;
for (const [y, m] of months) {
  const d1 = `${y}${String(m).padStart(2, '0')}01`, d2 = `${y}${String(m).padStart(2, '0')}${lastDay(y, m)}`;
  const j = await getJson(`https://www.twse.com.tw/rwd/zh/announcement/punish?startDate=${d1}&endDate=${d2}&response=json`);
  const want = `(${roc(y, m, 1)} 至 ${roc(y, m, lastDay(y, m))})`;
  if (j.stat !== 'OK' || !String(j.title || '').includes(want)) throw new Error(`TWSE ${y}-${m} 回聲不符：stat=${j.stat} title=${j.title}（要 ${want}）`);
  twseFields ||= j.fields;
  if (JSON.stringify(j.fields) !== JSON.stringify(twseFields)) throw new Error(`TWSE ${y}-${m} 欄位變了：${JSON.stringify(j.fields)}`);
  for (const r of j.data || []) twse.push(r);
  await sleep(PACE);
  const k = await getJson(`https://www.tpex.org.tw/www/zh-tw/bulletin/disposal?startDate=${y}/${String(m).padStart(2, '0')}/01&endDate=${y}/${String(m).padStart(2, '0')}/${lastDay(y, m)}&response=json`);
  const t0 = k?.tables?.[0]; const wantT = `${roc(y, m, 1)} ~ ${roc(y, m, lastDay(y, m))}`;
  if (!t0 || !String(t0.title2 || '').includes(wantT)) throw new Error(`TPEx ${y}-${m} 回聲不符：title2=${t0?.title2}（要含 ${wantT}）`);
  tpexFields ||= t0.fields;
  if (JSON.stringify(t0.fields) !== JSON.stringify(tpexFields)) throw new Error(`TPEx ${y}-${m} 欄位變了`);
  let n = 0; for (const r of t0.data || []) if (r[2]) { tpex.push(r); n++; }
  log.push(`${y}-${String(m).padStart(2, '0')} 上市 ${(j.data || []).length}、上櫃 ${n}`);
  process.stdout.write(`${log.at(-1)}\n`);
  await sleep(PACE);
}
writeFileSync(join(OUT, 'disposal_twse.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), from: FROM, to: TO, fields: twseFields, data: twse }));
writeFileSync(join(OUT, 'disposal_tpex.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), from: FROM, to: TO, fields: tpexFields, data: tpex }));
console.log(`✓ 上市 ${twse.length} 筆、上櫃 ${tpex.length} 筆（${FROM}～${TO}）→ ${OUT}`);
