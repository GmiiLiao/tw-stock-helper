#!/usr/bin/env node
// ── 第二大腦「洞」稽核 ────────────────────────────────────────────────
//
// 跟 audit-data-sources.mjs 的差別很重要，不要混用：
//   audit-data-sources 問的是「**最新**一份健不健康」——它只看最近 6 天。
//   這支問的是「**整條歷史**有沒有缺角」——逐日展開，把洞的位置指出來。
//   慢性缺漏（回補完沒接每日更新、某欄位某段時間全空）只有這支抓得到。
//
// 資料來源刻意用**本地 second-brain/backup**，不是 Firestore：
//   ① 這樣才是真的在驗「第二大腦」本身，而不是驗雲端然後假設本地一樣
//   ② 987 天 × 5 欄位全展開，走 Firestore 會是幾千次讀取
//   本地與雲端的份數一致性另外用 --cloud 比對。
//
// 用法：
//   node scripts/audit-brain-gaps.mjs            # 只驗本地
//   node scripts/audit-brain-gaps.mjs --cloud    # 另外比對 Firestore 份數

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'second-brain', 'backup');
const CLOUD = process.argv.includes('--cloud');

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isWeekend = (iso) => { const w = new Date(`${iso}T00:00:00Z`).getUTCDay(); return w === 0 || w === 6; };

// 連續日期壓成區間，避免印出 40 行單日
function runs(sortedDates) {
  const out = [];
  for (const d of sortedDates) {
    const last = out[out.length - 1];
    if (last && addDays(last.to, 1) <= d && daysBetween(last.to, d) <= 4) { last.to = d; last.n++; }
    else out.push({ from: d, to: d, n: 1 });
  }
  return out;
}
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
const fmtRun = (r) => (r.from === r.to ? r.from : `${r.from}…${r.to}`) + (r.n > 1 ? `(${r.n}天)` : '');

function listDated(col) {
  const dir = path.join(ROOT, col);
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')).sort();
}

// ── ① chipArchive 逐日 × 逐欄位 ─────────────────────────────────────
const FIELDS = [
  ['closeJson', '收盤', 1500],
  ['instJson', '法人', 1500],
  ['marginJson', '資券', 1200],
  ['lendingJson', '借券', 800],
  ['dayTradeJson', '當沖', 400],
];

function auditChipArchive(holidays = new Set()) {
  const dir = path.join(ROOT, 'chipArchive');
  const ids = listDated('chipArchive');
  if (!ids) { console.log('❌ chipArchive 本地不存在'); return null; }

  const cover = {};                       // field → [dates that are OK]
  const thin = {};                        // field → [{date,n}]
  for (const [f] of FIELDS) { cover[f] = new Set(); thin[f] = []; }
  let broken = [];

  for (const id of ids) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')); }
    catch (e) { broken.push(`${id}: ${e.message.slice(0, 40)}`); continue; }
    for (const [f, , min] of FIELDS) {
      let n = 0;
      try { n = Object.keys(JSON.parse(doc[f] || '{}')).length; } catch { n = 0; }
      if (n >= min) cover[f].add(id);
      else if (n > 0) thin[f].push({ date: id, n });
    }
  }

  console.log(`\n══ ① chipArchive 逐日 × 逐欄位（本地 ${ids.length} 天：${ids[0]} … ${ids[ids.length - 1]}）══`);
  if (broken.length) console.log(`  ❌ 無法解析 ${broken.length} 檔：${broken.slice(0, 3).join('; ')}`);

  // 每個欄位以「該欄位最早出現日」為起點算缺口——用全期起點會把「這欄本來就晚上線」誤報成洞
  const report = {};
  for (const [f, label, min] of FIELDS) {
    const have = [...cover[f]].sort();
    if (!have.length) { console.log(`  ${label}：完全沒有資料`); continue; }
    const start = have[0], end = ids[ids.length - 1];
    const haveSet = cover[f];
    // 扣掉休市日：2026-07-10 是颱風假，doc 存在但本來就沒有資料。
    // 不扣的話它會永遠掛在報告上，久了就沒人再看這份報告了。
    const missing = ids.filter(d => d >= start && d <= end && !haveSet.has(d) && !holidays.has(d));
    const pct = ((have.length / ids.filter(d => d >= start).length) * 100).toFixed(1);
    report[f] = { start, have: have.length, missing };
    const r = runs(missing);
    console.log(`  ${label.padEnd(3)}｜起 ${start}｜有 ${String(have.length).padStart(4)} 天｜涵蓋 ${pct}%｜洞 ${missing.length} 天` +
      (r.length ? `\n        ↳ ${r.slice(0, 8).map(fmtRun).join('、')}${r.length > 8 ? ` …共 ${r.length} 段` : ''}` : ''));
    const t = thin[f].filter(x => x.date >= start && !holidays.has(x.date));
    if (t.length) console.log(`        ↳ ⚠ 有值但過薄(<${min}) ${t.length} 天：${t.slice(0, 5).map(x => `${x.date}(${x.n})`).join('、')}`);
  }
  return { ids, report };
}

// ── ② 歸檔日期 vs 交易日曆 ──────────────────────────────────────────
// 用平日扣掉「歸檔本身缺席的日子」無法自證，所以拿 system/tradingCalendar 當外部真值。
async function auditAgainstCalendar(ids, db) {
  const cal = (await db.collection('system').doc('tradingCalendar').get()).data();
  const holidays = new Set(cal?.holidays || cal?.closed || []);
  if (!holidays.size) { console.log('\n══ ② 交易日曆比對：system/tradingCalendar 無 holidays 欄位，略過 ══'); return; }
  const have = new Set(ids);
  const start = ids[0], end = ids[ids.length - 1];
  const missing = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (isWeekend(d) || holidays.has(d)) continue;
    if (!have.has(d)) missing.push(d);
  }
  console.log(`\n══ ② 歸檔日 vs 交易日曆（${start} … ${end}）══`);
  if (!missing.length) { console.log('  ✅ 每一個應交易日都有 chipArchive 文件，零缺日'); return; }
  const r = runs(missing);
  console.log(`  ❌ 缺 ${missing.length} 個應交易日：${r.map(fmtRun).join('、')}`);
}

// ── ③ 其餘逐日/逐期歸檔的連續性 ─────────────────────────────────────
function auditOtherSeries(holidays = new Set()) {
  console.log('\n══ ③ 其餘歷史序列連續性 ══');
  for (const col of ['orderFlowArchive', 'intradayArchive', 'bookDepthArchive', 'snap0930Archive', 'volSurgeArchive', 'asiaPremarketArchive', 'chipDaily', 'tdccArchive']) {
    const ids = listDated(col);
    if (!ids || !ids.length) { console.log(`  ${col.padEnd(22)} —（本地無資料）`); continue; }
    const dated = ids.filter(isDate);
    const start = dated[0], end = dated[dated.length - 1];
    // 只算平日缺口（假日本來就沒有）
    const have = new Set(dated);
    const miss = [];
    for (let d = start; d <= end; d = addDays(d, 1)) if (!isWeekend(d) && !holidays.has(d) && !have.has(d)) miss.push(d);
    const span = daysBetween(start, end);
    console.log(`  ${col.padEnd(22)} ${String(dated.length).padStart(4)} 天｜${start}…${end}（跨 ${span} 日）｜平日缺 ${miss.length}` +
      (miss.length && miss.length <= 40 ? `：${runs(miss).map(fmtRun).join('、')}` : miss.length ? `（${runs(miss).length} 段）` : ''));
  }
  // 月頻
  const rev = listDated('revenueArchive') || [];
  if (rev.length) {
    const miss = [];
    const [y0, m0] = rev[0].split('-').map(Number);
    const [y1, m1] = rev[rev.length - 1].split('-').map(Number);
    const have = new Set(rev);
    for (let y = y0, m = m0; y < y1 || (y === y1 && m <= m1);) {
      const id = `${y}-${String(m).padStart(2, '0')}`;
      if (!have.has(id)) miss.push(id);
      m++; if (m > 12) { m = 1; y++; }
    }
    console.log(`  ${'revenueArchive'.padEnd(22)} ${String(rev.length).padStart(4)} 月｜${rev[0]}…${rev[rev.length - 1]}｜缺 ${miss.length}${miss.length ? '：' + miss.join('、') : ''}`);
  }
}

// ── ④ 本地檔案健康度（空檔／壞 JSON）─────────────────────────────────
function auditFileHealth() {
  console.log('\n══ ④ 本地檔案健康度 ══');
  let total = 0, empty = 0, bad = 0, bytes = 0;
  const badList = [];
  for (const col of fs.readdirSync(ROOT)) {
    const dir = path.join(ROOT, col);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(dir, f); const st = fs.statSync(p);
      total++; bytes += st.size;
      if (st.size === 0) { empty++; badList.push(`${col}/${f} (0 bytes)`); continue; }
      if (st.size < 2000) {                      // 只抽驗小檔，大檔全 parse 太慢
        try { JSON.parse(fs.readFileSync(p, 'utf8')); } catch { bad++; badList.push(`${col}/${f} (壞 JSON)`); }
      }
    }
  }
  console.log(`  檔案 ${total} 個、合計 ${(bytes / 1048576).toFixed(0)}MB｜空檔 ${empty}｜壞 JSON ${bad}`);
  if (badList.length) console.log(`  ❌ ${badList.slice(0, 10).join('、')}`);
  else console.log('  ✅ 無空檔、無損壞');
}

// ── ⑤ 本地 vs 雲端份數 ─────────────────────────────────────────────
async function auditCloudParity(db) {
  console.log('\n══ ⑤ 本地 vs Firestore 份數 ══');
  const cols = fs.readdirSync(ROOT).filter(c => fs.statSync(path.join(ROOT, c)).isDirectory() && c !== 'users');
  let drift = 0;
  for (const col of cols) {
    const local = fs.readdirSync(path.join(ROOT, col)).filter(f => f.endsWith('.json')).length;
    let cloud = -1;
    try { cloud = (await db.collection(col).count().get()).data().count; } catch { /* 集合不存在 */ }
    const mark = cloud < 0 ? '—' : (local === cloud ? '✅' : '❌');
    if (cloud >= 0 && local !== cloud) drift++;
    if (mark !== '✅') console.log(`  ${mark} ${col.padEnd(22)} 本地 ${local}｜雲端 ${cloud < 0 ? '不存在' : cloud}`);
  }
  console.log(drift === 0 ? '  ✅ 所有集合本地與雲端份數一致' : `  ❌ ${drift} 個集合份數不一致（上表）`);
}

async function main() {
  let db = null, holidays = new Set();
  if (CLOUD) {
    const admin = (await import('firebase-admin')).default;
    process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS
      || '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
    if (!admin.apps.length) admin.initializeApp();
    db = admin.firestore();
    // 休市日必須先拿到，否則序列檢查會把每個國定假日都當成洞（雜訊淹掉真洞）
    const cal = (await db.collection('system').doc('tradingCalendar').get()).data();
    holidays = new Set(cal?.holidays || cal?.closed || []);
  }
  const r = auditChipArchive(holidays);
  auditOtherSeries(holidays);
  auditFileHealth();
  if (CLOUD && r) { await auditAgainstCalendar(r.ids, db); await auditCloudParity(db); }
}

// ⚠ 路徑含中文 → 必須 pathToFileURL 正規化，否則直接執行靜默不做事。
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
