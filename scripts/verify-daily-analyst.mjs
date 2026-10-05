#!/usr/bin/env node
// 每日 AI 分析師團隊事後對答案（技能 tw-analyst-desk §6；規格 04 §1.5）。只記錄，不得進任何模型分數／排序／濾網。
//   只評明日卡 kind:'watch'；資料日 +1／+5 個交易日的收盤（熱力定版檔＝官方參考價）到齊後才評該期；
//   只寫 second-brain/daily-analyst/_review/{D}.{edition}.json（命中表＋漏網表兩份記錄）；
//   不寫 Firestore、不寫 picksHistory／picksScoreboard、不被任何 daemon／計分模組 import（見 verify-review.test.mjs 的掃描測試）。
//   跨日命中率彙總只在有效樣本 ≥20 個交易日時才印；之前只列逐日。
//   node scripts/verify-daily-analyst.mjs [--root <second-brain>] [--day YYYY-MM-DD] [--edition evening|morning] [--summary]
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { archiveDir, readManifest, readIssue } from './lib/analyst-desk/archive.mjs';
import { readTradingDays } from './lib/analyst-desk/run-flow.mjs';
import { buildReview, aggregate, REVIEW_SPEC } from './lib/analyst-desk/verify-review.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const readGz = f => JSON.parse(gunzipSync(readFileSync(f)).toString('utf8'));
const writeAtomic = (f, s) => { const t = `${f}.tmp${process.pid}`; writeFileSync(t, s); renameSync(t, f); };

/** 熱力定版檔讀取器：manifest 為 final 且檔案存在才給（收盤到齊的證據）；其餘回 null。 */
export function heatmapReader(root) {
  const dir = join(root, 'daily-heatmap');
  let man = {};
  try { man = JSON.parse(readFileSync(join(dir, '_manifest.json'), 'utf8')).rows || {}; } catch { /* 無熱力 manifest */ }
  return day => {
    const row = man[day];
    if (!row || row.status !== 'final') return null;
    const f = join(dir, row.file);
    return existsSync(f) ? readGz(f) : null;
  };
}

/** 對一份定版做對答案並寫 _review；回傳 { key, status } */
export function reviewOne({ root, key, tradingDays, heatmapOf, now = Date.now() }) {
  const issue = readIssue(root, key);
  if (!issue) return { key, status: 'no-issue' };
  const packF = join(archiveDir(root), readManifest(root).rows[key].packFile || '');
  const pack = existsSync(packF) ? readGz(packF) : null;
  const out = join(archiveDir(root), '_review', `${key}.json`);
  const existing = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
  const r = buildReview({ issue, pack, tradingDays, heatmapOf, existing, now });
  if (r.skip) return { key, status: 'skip', reason: r.reason };
  const ready = REVIEW_SPEC.horizons.filter(h => r.review.horizons[h].status === 'ready');
  if (existing && ready.length === REVIEW_SPEC.horizons.filter(h => existing.horizons?.[h]?.status === 'ready').length) return { key, status: 'unchanged', ready };
  if (!ready.length) return { key, status: 'pending', reason: REVIEW_SPEC.horizons.map(h => `+${h}: ${r.review.horizons[h].reason}`).join('；') };
  mkdirSync(join(archiveDir(root), '_review'), { recursive: true });
  writeAtomic(out, JSON.stringify(r.review, null, 1));
  return { key, status: r.complete ? 'complete' : 'partial', ready };
}

function main() {
  const argv = process.argv.slice(2);
  const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const root = opt('--root') || join(HERE, '..', 'second-brain');
  const rows = readManifest(root).rows || {};
  const keys = Object.keys(rows).filter(k => rows[k].status === 'final' && (!opt('--day') || k.startsWith(opt('--day'))) && (!opt('--edition') || k.endsWith(`.${opt('--edition')}`))).sort();
  const tradingDays = readTradingDays(root), heatmapOf = heatmapReader(root);
  console.log(`對答案：${keys.length} 份定版（只評 watch；口徑 ${REVIEW_SPEC.returnBasis}；基準 ${REVIEW_SPEC.benchmark}）`);
  for (const key of keys) { const r = reviewOne({ root, key, tradingDays, heatmapOf }); console.log(`  ${key}：${r.status}${r.reason ? `（${r.reason}）` : ''}${r.ready ? ` ready=${r.ready.join(',')}` : ''}`); }
  if (argv.includes('--summary')) {
    const dir = join(archiveDir(root), '_review');
    const reviews = existsSync(dir) ? readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.(evening|morning)\.json$/.test(f)).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8'))) : [];
    for (const h of REVIEW_SPEC.horizons) console.log(JSON.stringify(aggregate(reviews, h)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
