#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 新聞內文覆蓋率：修抓取前後的量測比較（純本機、不連線）
//
// 量測本身由 daemon 的單次任務產生（唯讀、不呼叫 LLM、不寫 Firestore）：
//   GOOGLE_APPLICATION_CREDENTIALS=… NV_SAMPLE=40 NV_OUT=before.json \
//     node --env-file=.env.local scripts/ai-daemon.mjs --run newsCoverageProbe
//   （改完抓取邏輯後）NV_FROM=before.json NV_OUT=after.json … --run newsCoverageProbe
// 本腳本：node scripts/news-coverage-compare.mjs before.json after.json
//
// 口徑（與 judgeOneStock 同一把尺）：
//   fresh     ＝ 近兩個交易日內、有內文、非機器稿 ⇒ 判別能以 basis=content 進行
//   content14 ＝ 14 日回退範圍內有內文 ⇒ 至少能 stale 判別
//   bodies    ＝ 任何內文（不論多舊）
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';

const [a, b] = process.argv.slice(2);
if (!a || !b) { console.error('用法：node scripts/news-coverage-compare.mjs before.json after.json'); process.exit(1); }
const A = JSON.parse(readFileSync(a, 'utf8')), B = JSON.parse(readFileSync(b, 'utf8'));
const mapA = new Map(A.rows.map(r => [r.code, r])), mapB = new Map(B.rows.map(r => [r.code, r]));
const common = [...mapA.keys()].filter(c => mapB.has(c));
if (common.length !== A.rows.length || common.length !== B.rows.length) {
  console.log(`⚠ 兩份宇宙不同：前 ${A.rows.length} 檔、後 ${B.rows.length} 檔、共同 ${common.length} 檔——只比共同的部分`);
}
const N = common.length;
const pct = (rows, k) => `${rows.filter(r => r[k] > 0).length}/${N}（${(100 * rows.filter(r => r[k] > 0).length / N).toFixed(0)}%）`;
const rowsA = common.map(c => mapA.get(c)), rowsB = common.map(c => mapB.get(c));
const avg = (rows, k) => rows.reduce((s, r) => s + (r[k] || 0), 0) / Math.max(1, rows.length);

console.log(`# 新聞內文覆蓋率比較（共同 ${N} 檔）`);
console.log(`前：${A.summary.date} ${A.summary.universeFrom}`);
console.log(`後：${B.summary.date} ${B.summary.universeFrom}\n`);
console.log('| 指標 | 前 | 後 |');
console.log('|---|---|---|');
for (const [label, k] of [['近期內文（兩交易日內·非機器稿）', 'fresh'], ['14 日內可回退', 'content14'], ['任何內文', 'bodies']]) {
  console.log(`| ${label} | ${pct(rowsA, k)} | ${pct(rowsB, k)} |`);
}
console.log(`| 平均耗時／檔 | ${(avg(rowsA, 'ms') / 1000).toFixed(1)}s | ${(avg(rowsB, 'ms') / 1000).toFixed(1)}s |`);
console.log(`| 平均請求／檔 | ${avg(rowsA, 'reqs').toFixed(1)} | ${avg(rowsB, 'reqs').toFixed(1)} |`);
console.log(`| 最大請求／檔 | ${Math.max(...rowsA.map(r => r.reqs))} | ${Math.max(...rowsB.map(r => r.reqs))} |`);
console.log(`| 抓取錯誤 | ${rowsA.filter(r => r.err).length} | ${rowsB.filter(r => r.err).length} |`);

const buckets = ['≤1d', '1~3d', '3~7d', '7~14d', '>14d', '無內文'];
console.log('\n最新內文年齡分佈：');
console.log('| 區間 | 前 | 後 |\n|---|---|---|');
for (const k of buckets) console.log(`| ${k} | ${A.summary.ageBuckets?.[k] ?? '-'} | ${B.summary.ageBuckets?.[k] ?? '-'} |`);

const srcKeys = [...new Set([...Object.keys(A.summary.srcTotal || {}), ...Object.keys(B.summary.srcTotal || {})])];
console.log('\n來源貢獻（篇／內文／近期內文／有近期內文的檔數）：');
console.log('| 來源 | 前 | 後 |\n|---|---|---|');
for (const k of srcKeys) {
  const f = v => v ? `${v.items}/${v.bodies}/${v.fresh}/${v.stocksFresh}` : '—';
  console.log(`| ${k} | ${f(A.summary.srcTotal?.[k])} | ${f(B.summary.srcTotal?.[k])} |`);
}

const gained = common.filter(c => !(mapA.get(c).fresh > 0) && mapB.get(c).fresh > 0);
const lost = common.filter(c => mapA.get(c).fresh > 0 && !(mapB.get(c).fresh > 0));
console.log(`\n近期內文 由無→有：${gained.length} 檔${gained.length ? '：' + gained.map(c => `${c} ${mapB.get(c).name}（${(mapB.get(c).freshFrom || []).join('・')}）`).join('、') : ''}`);
console.log(`近期內文 由有→無：${lost.length} 檔${lost.length ? '：' + lost.map(c => `${c} ${mapA.get(c).name}`).join('、') : ''}`);
console.log('\n（量測結果非投資建議）');
