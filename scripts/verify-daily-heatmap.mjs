#!/usr/bin/env node
// 每日熱力對帳（技能 tw-daily-heatmap §8 驗收）：把定版檔與「獨立來源」逐項比對，印出差異表；有硬性不符 exit 1。
//   V1 家數  vs 官方 MI_INDEX「漲跌證券數合計」（股票欄）與 marketReports/{日}.breadth
//   V2 指數  Σ貢獻 vs 官方漲跌點（殘差分級）
//   V3 成交值 Σ4碼上市成交值 ÷ 官方一般股票成交金額
//   V4 收盤  chipArchive.closeJson 收盤 vs 官方收盤（逐檔）
//   V5 sectorWind 同名產業：valW vs avgChg 的 Spearman 與方向一致率（結構性差異見 SKILL §8）
//   V6 人工抽檢三檔：重算原始檔欄位 vs 定版檔
//   node scripts/verify-daily-heatmap.mjs [--days 60] [--root <second-brain>]
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DS, mirrorPaths, readDataset, parseMiIndex, parseTwt84u, parseTpex, isCommonStock } from './lib/daily-heatmap/inputs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = opt('--root', join(HERE, '..', 'second-brain'));
const DAYS = Number(opt('--days', 60));
const P = mirrorPaths(ROOT);
const readGz = f => JSON.parse(gunzipSync(readFileSync(f)).toString('utf8'));
const dates = readdirSync(P.out).filter(f => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f)).map(f => f.slice(0, 10)).sort().slice(-DAYS);
const ALIAS = { 水泥: '水泥工業', 食品: '食品工業', 塑膠: '塑膠工業', 造紙: '造紙工業', 鋼鐵: '鋼鐵工業', 橡膠: '橡膠工業', 汽車: '汽車工業', 航運: '航運業', 生技醫療: '生技醫療業', 油電燃氣: '油電燃氣業', 半導體: '半導體業', 電腦及週邊: '電腦及週邊設備業', 光電: '光電業', 通信網路: '通信網路業', 電子零組件: '電子零組件業', 電子通路: '電子通路業', 資訊服務: '資訊服務業', 其他電子: '其他電子業', 金融保險: '金融保險業' };

function spearman(a, b) {
  const rank = v => { const s = [...v].map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]); const r = Array(v.length); s.forEach(([, i], k) => { r[i] = k; }); return r; };
  const ra = rank(a), rb = rank(b), n = a.length;
  const m = (n - 1) / 2; let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i] - m) * (rb[i] - m); da += (ra[i] - m) ** 2; db += (rb[i] - m) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : null;
}
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

const rows = [];
let hard = 0;
for (const d of dates) {
  const p = readGz(join(P.out, `${d}.json.gz`));
  const mi = parseMiIndex(readDataset(P.official, DS.mi, d).entry);
  const r = { d, grade: p.index?.grade, resBp: p.index?.residualBp };
  // V1
  const offUp = mi.breadth?.up?.n, offDn = mi.breadth?.down?.n;
  // 自算：不信定版檔的 breadth（它在有官方家數時直接採官方），從原始檔以參考價重算上市普通股漲跌家數
  const refRows = parseTwt84u(readDataset(P.official, DS.ref, d).entry).rows;
  //   官方家數把除權息日（符號 X＝無比價）的個股歸「無比價」，不算漲跌；本頁以參考價計報酬，會把它們算進漲跌。
  //   所以對帳用「排除除權息日個股」的口徑比官方（應 ≤3 檔差），全口徑的差距＝除權息檔數，另列。
  let ownUp = 0, ownDn = 0, xN = 0, fullUp = 0, fullDn = 0;
  for (const [code, x] of mi.rows) {
    if (!isCommonStock(code) || !(x.close > 0)) continue;
    const q = refRows.get(code);
    if (!(q?.ref > 0)) continue;
    const isX = !(q.prevClose > 0) || Math.abs(q.ref - q.prevClose) > 1e-9; // 無前收（新上市、恢復買賣）也是官方的「無比價」
    if (x.close > q.ref) fullUp++; else if (x.close < q.ref) fullDn++;
    if (isX) { xN++; continue; }
    if (x.close > q.ref) ownUp++; else if (x.close < q.ref) ownDn++;
  }
  r.v1 = { offUp, offDn, ownUp, ownDn, xN, fullUp, fullDn };
  const mr = join(ROOT, 'backup', 'marketReports', `${d}.json`);
  if (existsSync(mr)) { const b = JSON.parse(readFileSync(mr, 'utf8')).breadth; r.v1.mrUp = b?.up; r.v1.mrDn = b?.down; r.v1.mrTotal = b?.total; }
  // V3
  let s = 0; for (const [c, x] of mi.rows) if (isCommonStock(c)) s += x.val || 0;
  r.v3 = mi.officialStockValue ? s / mi.officialStockValue : null;
  // V4
  const cf = join(P.chip, `${d}.json`);
  if (existsSync(cf)) {
    const cj = JSON.parse(readFileSync(cf, 'utf8')).closeJson;
    if (cj) {
      const c = JSON.parse(cj); let n = 0, ok = 0, bad = [];
      for (const [code, x] of mi.rows) if (isCommonStock(code) && x.close > 0 && c[code]) { n++; if (Math.abs(c[code][0] - x.close) < 1e-6) ok++; else bad.push(code); }
      r.v4 = { n, ok, bad: bad.slice(0, 5) };
    }
  }
  // V5
  const sw = join(P.out, '..', 'backup', 'sectorWind', `${d}.json`);
  if (existsSync(sw)) {
    const secs = JSON.parse(readFileSync(sw, 'utf8')).sectors || [];
    const mine = new Map(p.industries.filter(x => x.listable).map(x => [x.key, x]));
    const A = [], B = []; let same = 0;
    for (const x of secs) { const k = ALIAS[x.industry] || x.industry; const m = mine.get(k); if (m && m.valW != null && x.n >= 8) { A.push(m.valW); B.push(x.avgChg); if (Math.sign(m.valW) === Math.sign(x.avgChg) || Math.abs(m.valW) < 0.05) same++; } }
    if (A.length >= 8) r.v5 = { n: A.length, rho: spearman(A, B), dir: same / A.length };
  }
  rows.push(r);
}

const f = (x, d = 3) => (x == null ? '—' : x.toFixed(d));
console.log(`對帳 ${dates[0]} ~ ${dates[dates.length - 1]}（${dates.length} 日）\n`);
const v1 = rows.filter(r => r.v1.offUp != null);
const dUp = v1.map(r => Math.abs(r.v1.ownUp - r.v1.offUp)), dDn = v1.map(r => Math.abs(r.v1.ownDn - r.v1.offDn));
console.log(`V1 家數(上市，排除除權息無比價股後)  自算 vs 官方：上漲差 中位 ${med(dUp)} 最大 ${Math.max(...dUp)}｜下跌差 中位 ${med(dDn)} 最大 ${Math.max(...dDn)}（門檻 ≤5）`);
console.log(`   本頁全口徑（含除權息股，以參考價計）比官方多出的檔數＝除權息檔數：近 ${v1.length} 日除權息檔數 中位 ${med(v1.map(r => r.v1.xN))} 最大 ${Math.max(...v1.map(r => r.v1.xN))}`);
const bigV1 = v1.filter(r => Math.abs(r.v1.ownUp - r.v1.offUp) > 5 || Math.abs(r.v1.ownDn - r.v1.offDn) > 5);
if (bigV1.length) { hard += bigV1.length; console.log('   ✗ 超門檻：', bigV1.map(r => r.d).join(',')); }
const mr = rows.filter(r => r.v1.mrUp != null);
if (mr.length) {
  const tot = mr.map(r => r.v1.mrTotal);
  console.log(`   marketReports（兩市）上漲 ${mr.length} 日有檔；其 total 中位 ${med(tot)}（含 91xx、不含 00xx，與本頁宇宙差 4 檔 TDR 屬預期）`);
}
const grades = rows.reduce((m, r) => (m[r.grade] = (m[r.grade] || 0) + 1, m), {});
console.log(`V2 指數殘差  ${JSON.stringify(grades)}｜|bp| 中位 ${f(med(rows.map(r => Math.abs(r.resBp))))} 最大 ${f(Math.max(...rows.map(r => Math.abs(r.resBp))), 2)}`);
console.log('   非綠日：' + rows.filter(r => r.grade !== '綠').map(r => `${r.d}(${r.grade} ${r.resBp}bp)`).join('、'));
const v3 = rows.map(r => r.v3).filter(x => x != null);
console.log(`V3 成交值比  ${f(Math.min(...v3), 4)} ~ ${f(Math.max(...v3), 4)}（門檻 0.99~1.02）`);
if (v3.some(x => x < 0.99 || x > 1.02)) hard++;
const v4 = rows.filter(r => r.v4);
console.log(`V4 chipArchive 收盤逐檔相符  ${v4.length} 日：` + (v4.length ? `最低 ${f(Math.min(...v4.map(r => r.v4.ok / r.v4.n)), 4)}；不符日 ${v4.filter(r => r.v4.ok !== r.v4.n).map(r => `${r.d}(${r.v4.n - r.v4.ok}檔:${r.v4.bad.join('/')})`).join('、') || '無'}` : '無檔'));
const v5 = rows.filter(r => r.v5);
console.log(`V5 sectorWind 同名產業  ${v5.length} 日：Spearman 中位 ${f(med(v5.map(r => r.v5.rho)))} 最小 ${f(Math.min(...v5.map(r => r.v5.rho)))}｜方向一致率 中位 ${f(med(v5.map(r => r.v5.dir)))}（SKILL 門檻 ≥0.75／≥85%）`);

// V6 人工抽檢：從原始檔獨立重算
console.log('\nV6 人工抽檢（原始檔獨立重算 vs 定版檔）');
const checks = [['2026-10-02', '2330'], ['2026-10-02', '6488'], ['2026-09-16', '2330']];
for (const [d, code] of checks) {
  if (!existsSync(join(P.out, `${d}.json.gz`))) { console.log(`  ${d} ${code}：定版檔不存在`); continue; }
  const p = readGz(join(P.out, `${d}.json.gz`));
  const mi = parseMiIndex(readDataset(P.official, DS.mi, d).entry);
  const ref = parseTwt84u(readDataset(P.official, DS.ref, d).entry);
  const tpx = parseTpex(readDataset(P.official, DS.tpex, d).entry);
  const dates2 = readdirSync(join(P.official, 'www.tpex.org.tw', 'tpex_dailyquotes')).filter(x => /^\d{4}/.test(x)).map(x => x.slice(0, 10)).sort();
  const prev = dates2[dates2.indexOf(d) - 1];
  const prevTpx = prev ? parseTpex(readDataset(P.official, DS.tpex, prev).entry) : null;
  const tse = mi.rows.get(code), otc = tpx.rows.get(code);
  const close = tse?.close ?? otc?.close;
  const rf = tse ? ref.rows.get(code)?.ref : (otc?.chg != null ? +(otc.close - otc.chg).toFixed(4) : prevTpx?.rows.get(code)?.nextRef);
  const ret = close / rf * 100 - 100;
  const mine = p.stocks.find(x => x[0] === code);
  const diff = mine ? Math.abs(mine[1] - ret) : null;
  const ok = diff != null && diff < 0.006;
  if (!ok) hard++;
  console.log(`  ${d} ${code}：收 ${close}／參考價 ${rf} → 報酬 ${ret.toFixed(3)}%｜定版 ${mine?.[1]}%｜${ok ? '✓' : '✗ 不符'}${mine ? `｜flags ${mine[3]}` : ''}`);
}
process.exit(hard ? 1 : 0);
