#!/usr/bin/env node
// 台股每日熱力分析（技能 tw-daily-heatmap）：讀本機官方鏡像 → 閘門 → 寫一次定版。
//   node scripts/daily-heatmap.mjs [--date YYYY-MM-DD] [--dry-run] [--md] [--force] [--root <second-brain>]
//   node scripts/daily-heatmap.mjs --backfill N   把近 N 個交易日缺的檔補建（標 rebuilt:true、不當盤前簡報資料；wiki 分組為現行快照有前視）
//   對上游 0 請求、不寫任何既有集合（sectorWind/marketWind/chipArchive…）；輸出在 second-brain/daily-heatmap/。
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DS, mirrorPaths, tradingDates, prevTradingDate, readDataset, parseMiIndex, parseTwt84u, parseQfiis, parseT187,
  parseTpex, readWiki, readChipInst, buildSharesFix, latestT187, loadExDivPlan,
} from './lib/daily-heatmap/inputs.mjs';
import { computeHeatmap, SCHEMA_VERSION } from './lib/daily-heatmap/compute.mjs';
import { evaluateGates } from './lib/daily-heatmap/gates.mjs';
import { renderMarkdown } from './lib/daily-heatmap/render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PREV_DAYS = 20;
const sha = buf => createHash('sha256').update(buf).digest('hex');
const writeAtomic = (file, buf) => { const t = `${file}.tmp${process.pid}`; writeFileSync(t, buf); renameSync(t, file); };
const writeJson = (file, o) => writeAtomic(file, JSON.stringify(o, null, 1));

function parseArgs(argv) {
  const a = { date: null, dry: false, md: false, force: false, rebuilt: false, backfill: 0, root: join(HERE, '..', 'second-brain') };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--date') a.date = argv[++i];
    else if (k === '--dry-run') a.dry = true;
    else if (k === '--md') a.md = true;
    else if (k === '--force') a.force = true;
    else if (k === '--rebuilt') a.rebuilt = true;
    else if (k === '--backfill') a.backfill = Number(argv[++i]);
    else if (k === '--root') a.root = argv[++i];
    else throw new Error(`未知參數 ${k}`);
  }
  if (a.date && !/^\d{4}-\d{2}-\d{2}$/.test(a.date)) throw new Error('--date 格式須為 YYYY-MM-DD');
  return a;
}

/** 下一個（平日）交易日 08:30 台北時間的 epoch ms；平日以外的休市日無法由本機得知，以平日近似。 */
function deadlineMs(date) {
  const TZ = 8 * 3600e3;
  let t = new Date(`${date}T00:00:00+08:00`).getTime();
  do { t += 86400e3; } while ([0, 6].includes(new Date(t + TZ).getUTCDay()));
  return t + 8.5 * 3600e3; // 下一個平日 00:00(台北) + 08:30
}

function loadInputs(P, date, dates) {
  const prevDate = prevTradingDate(dates, date);
  const ds = {
    mi: readDataset(P.official, DS.mi, date), ref: readDataset(P.official, DS.ref, date),
    qfiis: readDataset(P.official, DS.qfiis, date), tpex: readDataset(P.official, DS.tpex, date),
  };
  const t187 = readDataset(P.official, DS.t187, date);
  const prev = prevDate ? { mi: readDataset(P.official, DS.mi, prevDate), tpex: readDataset(P.official, DS.tpex, prevDate) } : {};
  const parsed = {
    mi: ds.mi && parseMiIndex(ds.mi.entry), ref: ds.ref && parseTwt84u(ds.ref.entry),
    qfiis: ds.qfiis && parseQfiis(ds.qfiis.entry), tpex: ds.tpex && parseTpex(ds.tpex.entry),
  };
  const wiki = readWiki(P.wiki);
  // 當日 t187 不存在（歷史重建）⇒ 股數用 qfiis，並對「分割／減資後仍是舊股數」者校正（inputs.mjs buildSharesFix）
  let sharesCorrected = [];
  if (!t187 && parsed.qfiis) {
    const fix = buildSharesFix({ official: P.official, dates, date, qfiis: parsed.qfiis, t187Latest: latestT187(P.official) });
    sharesCorrected = [...fix].map(([code, v]) => ({ code, from: v.from, to: v.to, eventDay: v.eventDay })).sort((a, b) => (a.code < b.code ? -1 : 1));
    for (const [code, v] of fix) parsed.qfiis.rows.set(code, { shares: v.to });
  }
  return {
    date, prevDate, ds, parsed, t187: t187 && parseT187(t187.entry), prev, wiki, sharesCorrected,
    inp: {
      date, wiki, mi: parsed.mi, ref: parsed.ref, qfiis: parsed.qfiis, tpex: parsed.tpex,
      t187: t187 && parseT187(t187.entry), tpexPrev: prev.tpex && parseTpex(prev.tpex.entry),
      exDivPlan: loadExDivPlan(P.official, date), miPrev: prev.mi && parseMiIndex(prev.mi.entry), inst: readChipInst(P.chip, date), tradingDates: dates,
    },
  };
}

function prevCounts(P, dates, date) {
  const prior = dates.filter(d => d < date).slice(-PREV_DAYS);
  const out = { tse: [], otc: [] };
  for (const d of prior) {
    const mi = readDataset(P.official, DS.mi, d), tp = readDataset(P.official, DS.tpex, d);
    if (!mi || !tp) continue;
    const common = c => /^[1-9]\d{3}$/.test(c) && !c.startsWith('91');
    out.tse.push([...parseMiIndex(mi.entry).rows].filter(([c, x]) => common(c) && x.close > 0).length);
    out.otc.push([...parseTpex(tp.entry).rows].filter(([c, x]) => common(c) && x.close > 0).length);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const P = mirrorPaths(args.root);
  const dates = tradingDates(P.official);
  if (!dates.length) { console.error('找不到上市 MI_INDEX 鏡像，無交易日可用'); process.exit(2); }
  if (args.backfill > 0) return backfill(P, dates, args);
  const date = args.date || dates[dates.length - 1];
  if (!dates.includes(date)) {
    console.log(`非交易日或鏡像無該日（${date}）：不產生檔案；最後交易日 ${dates[dates.length - 1]}`);
    return;
  }
  const outFile = join(P.out, `${date}.json.gz`);
  if (existsSync(outFile) && !args.force && !args.dry) { console.log(`skip-exists ${outFile}`); return; }

  const L = loadInputs(P, date, dates);
  const missing = ['mi', 'ref', 'qfiis', 'tpex'].filter(k => !L.parsed[k]);
  if (missing.length || !L.inp.tpexPrev) {
    return fail(P, date, [...missing.map(k => `缺輸入：${k}`), ...(L.inp.tpexPrev ? [] : ['缺前一交易日上櫃檔（參考價/漲停價）'])], args);
  }
  const result = { ...computeHeatmap(L.inp), sharesCorrected: L.sharesCorrected };
  const gate = evaluateGates({ date, datasets: L.ds, parsed: L.parsed, result, prevCounts: prevCounts(P, dates, date), hasWiki: !!L.wiki });
  if (!gate.pass) return fail(P, date, gate.hard, args);

  const payload = JSON.stringify(result);
  const gz = gzipSync(Buffer.from(payload), { level: 9 });
  const now = Date.now();
  const lateBuilt = now > deadlineMs(date);
  const meta = { degraded: gate.soft, groupingAsOf: L.wiki?.generatedAt ?? null };
  const md = renderMarkdown(result, meta);
  if (args.md) process.stdout.write(md);
  if (args.dry) {
    console.log(`dry-run OK ${date}：gz ${(gz.length / 1024).toFixed(1)}KB、殘差 ${result.index?.residualBp}bp（${result.index?.grade}）、軟警告 ${gate.soft.length}`);
    return;
  }
  writeOnce(P, { date, gz, md, outFile, lateBuilt: lateBuilt || args.rebuilt, rebuilt: args.rebuilt, gate, L, meta, now, force: args.force });
}

/** 補建缺的歷史日（每日各開一個子程序，互不影響；已存在的跳過）。 */
function backfill(P, dates, args) {
  const todo = dates.slice(-args.backfill).filter(d => !existsSync(join(P.out, `${d}.json.gz`)));
  console.log(`backfill：${todo.length} 日待補（近 ${args.backfill} 個交易日）`);
  let ok = 0;
  for (const d of todo) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--date', d, '--rebuilt', '--root', args.root], { stdio: 'inherit' });
    if (r.status === 0) ok++;
  }
  console.log(`backfill 完成 ${ok}/${todo.length}`);
}

function fail(P, date, reasons, args) {
  console.error(`✗ ${date} 未定版：\n  ${reasons.join('\n  ')}`);
  if (args.dry) process.exit(2);
  mkdirSync(join(P.out, '_pending'), { recursive: true });
  writeJson(join(P.out, '_pending', `${date}.json`), { date, reasons, generatedAt: new Date().toISOString() });
  if (Date.now() > deadlineMs(date)) {
    mkdirSync(join(P.out, '_alerts'), { recursive: true });
    writeJson(join(P.out, '_alerts', 'LATEST.json'), { date, reasons, note: '已過下一交易日 08:30 仍未定版；盤前簡報應顯示「昨日熱力未產出」', at: new Date().toISOString() });
  }
  process.exit(2);
}

function writeOnce(P, { date, gz, md, outFile, lateBuilt, rebuilt = false, gate, L, meta, now, force }) {
  mkdirSync(join(P.out, 'reports'), { recursive: true });
  const lock = join(P.out, '.lock');
  let fd;
  try { fd = openSync(lock, 'wx'); } catch { console.error('另一個程序正在寫入（.lock），結束'); process.exit(3); }
  try {
    let target = outFile, forced = false;
    if (existsSync(outFile)) {
      if (!force) { console.log(`skip-exists ${outFile}`); return; }
      if (lateBuilt) {
        const n = readdirSync(P.out).filter(f => f.startsWith(`${date}.amend-`)).length + 1;
        target = join(P.out, `${date}.amend-${n}.json.gz`); // 開盤後修補不取代原檔
      } else {
        let k = 1; while (existsSync(join(P.out, `${date}.r${k}.json.gz`))) k++;
        renameSync(outFile, join(P.out, `${date}.r${k}.json.gz`));
        forced = true;
      }
    }
    writeAtomic(target, gz);
    if (target === outFile) writeAtomic(join(P.out, 'reports', `${date}.md`), Buffer.from(md));
    const manFile = join(P.out, '_manifest.json');
    const man = existsSync(manFile) ? JSON.parse(readFileSync(manFile, 'utf8')) : { rows: {} };
    const wikiBuf = existsSync(P.wiki) ? readFileSync(P.wiki) : null;
    man.rows[date] = {
      status: 'final', file: target.split('/').pop(), sha256: sha(gz), bytes: gz.length, schemaVersion: SCHEMA_VERSION,
      canonicalAt: new Date(now).toISOString(), lateBuilt, rebuilt, canonicalForced: forced,
      inputs: Object.fromEntries(Object.entries(L.ds).map(([k, v]) => [k, { echo: v.echo, sha256: sha(readFileSync(v.file)) }])),
      coverage: gate.coverage, degraded: meta.degraded, groupingAsOf: meta.groupingAsOf, groupingSha256: wikiBuf ? sha(wikiBuf) : null,
    };
    writeJson(manFile, man);
    // 回補的歷史日不動 latest.json（latest 只指向「最後交易日」的正式定版）
    const latestF = join(P.out, 'latest.json');
    const cur = existsSync(latestF) ? JSON.parse(readFileSync(latestF, 'utf8')) : null;
    if (!rebuilt && (!cur || cur.dataDate <= date)) writeJson(latestF, { dataDate: date, canonicalAt: man.rows[date].canonicalAt, usableForNextDayBrief: !lateBuilt });
    const pend = join(P.out, '_pending', `${date}.json`);
    if (existsSync(pend)) unlinkSync(pend);
    console.log(`✓ ${date} 定版 ${target}（${(gz.length / 1024).toFixed(1)}KB${lateBuilt ? '，過 08:30 → usableForNextDayBrief:false' : ''}）`);
  } finally { closeSync(fd); try { unlinkSync(lock); } catch { /* ignore */ } }
}

main();
