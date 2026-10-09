#!/usr/bin/env node
// ── 閒置券商稽核（--skip-idle-brokers 啟用前的檢驗；second-brain/finmind，來源 FinMind・研究用）──────────────
// 使用者 2026-10-09 裁定「3 依建議」：啟用閒置券商延後，並做稽核——挑一個非探針日、整天抓全部券商，
//   確認被判為閒置（探針日全部 0 列）的券商在稽核日也是 0 列。
// 閒置集合與 backfill.mjs --skip-idle-brokers 用同一個函式（idleBrokerSet）；稽核日不當佐證（holdOut），否則等於自己證明自己。
// 雙重核對：索引（每家券商請求登錄的列數，與 --skip-idle-brokers 判定同口徑）＋資料檔逐列（securities_trader_id）。
// 只讀本機檔：不讀 token、不打網路、不拿鎖（可與執行中的 backfill 並行）。
// 用法：
//   node scripts/finmind/idle-audit.mjs --date YYYY-MM-DD [--no-write] [--root <dir>]
//   node scripts/finmind/idle-audit.mjs --probe-status [--root <dir>]      探針日（backfill --probe-brokers）是否全部收尾
// 結束碼：0 通過（寫 TaiwanStockTradingDailyReport/_idle-audit.json；--no-write 不寫）／探針齊全
//         1 閒置券商在稽核日有成交，或資料檔與索引不符；2 參數或稽核日不合法；3 尚未就緒（探針不足、稽核日沒抓完整、沒有券商清單）
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SOURCE_LABEL } from './datasets.mjs';
import { createLocalData } from './localdata.mjs';
import { datasetDir, forEachRow, groupPaths, readDone, writeJsonAtomic } from './store.mjs';
import { MIN_PROBES, PATHS, idleBrokerSet } from './backfill.mjs';
import { taipeiParts } from './timewin.mjs';

const DS = 'TaiwanStockTradingDailyReport';
export const AUDIT_FILE = '_idle-audit.json';
export const EXIT = Object.freeze({ ok: 0, violation: 1, usage: 2, notReady: 3 });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FLAGS = new Set(['--no-write', '--probe-status']);
const VALUED = new Set(['--date', '--root']);
const SAMPLE_IDS = 10;
const camel = s => s.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const fmtN = n => Number(n).toLocaleString('en-US');
const sample = ids => `${ids.slice(0, SAMPLE_IDS).join('、')}${ids.length > SAMPLE_IDS ? ` 等 ${ids.length} 家` : ''}`;

export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS.has(a)) { o[camel(a)] = true; continue; }
    if (!VALUED.has(a)) throw new Error(`看不懂的參數：${a}`);
    const v = argv[i + 1];
    if (v == null || v.startsWith('--')) throw new Error(`${a} 缺值`);
    o[camel(a)] = v; i += 1;
  }
  if (o.date && !DATE_RE.test(o.date)) throw new Error('--date 要 YYYY-MM-DD');
  if (o.date && o.probeStatus) throw new Error('--date 與 --probe-status 擇一');
  if (!o.date && !o.probeStatus) throw new Error('要指定 --date 或 --probe-status');
  return o;
}

/** 前置檢查：稽核日要是交易日、非探針日、在略過區間內；探針要夠；要有券商清單。回傳 null＝通過。 */
function precheck(auditDate, days, idle, brokers) {
  if (!days.includes(auditDate)) return [EXIT.usage, `${auditDate} 不是本機交易日表裡的交易日`];
  if (idle.planned.includes(auditDate)) return [EXIT.usage, `${auditDate} 是探針日：稽核要挑非探針日（探針 ${idle.planned.join('、')}）`];
  if (idle.probes.length < MIN_PROBES) return [EXIT.notReady, `已收尾的探針日只有 ${idle.probes.length} 個（需 ≥${MIN_PROBES}）：先跑完 backfill --probe-brokers`];
  if (auditDate < idle.from || auditDate > idle.to) return [EXIT.usage, `${auditDate} 不在略過區間 ${idle.from}～${idle.to}（--skip-idle-brokers 只在探針區間內略過，區間外稽核沒有意義）`];
  if (!brokers?.length) return [EXIT.notReady, '本機沒有證券商清單（TaiwanSecuritiesTraderInfo 快照），無法判斷稽核日是否涵蓋全部券商'];
  return null;
}

/** 稽核日覆蓋：要收尾、涵蓋清單上全部券商（不是帶 --skip-idle-brokers 抓的）、而且不是整天 0 列。回傳 null＝通過。 */
function coverageProblem(auditDate, st, brokers) {
  if (!st.final) return `稽核日 ${auditDate} 尚未收尾（覆蓋未完成：已抓 ${fmtN(st.members)}／${fmtN(brokers.length)} 家）`;
  const missing = brokers.filter(id => !st.done.has(id));
  if (missing.length) return `稽核日 ${auditDate} 缺 ${missing.length} 家券商（${sample(missing)}）：要不帶 --skip-idle-brokers 整天抓全部券商`;
  if (!st.rows) return `稽核日 ${auditDate} 全部券商 0 列（FinMind 缺日？）：換一個交易日`;
  return null;
}

/** 資料檔逐列：總列數要等於索引合計；閒置券商的列數要等於索引登錄的列數。 */
async function scanData(paths, st, idleIds) {
  const idleSet = new Set(idleIds);
  const by = new Map();
  const dataRows = await forEachRow(paths, r => {
    const id = String(r.securities_trader_id ?? '');
    if (idleSet.has(id)) by.set(id, (by.get(id) || 0) + 1);
  });
  const mismatch = idleIds.map(id => ({ id, dataRows: by.get(id) || 0, indexRows: st.rowsBy.get(id) })).filter(x => x.dataRows !== x.indexRows);
  return { dataRows, mismatch };
}

/**
 * 稽核：閒置集合（稽核日不當佐證）在稽核日的列數全部為 0 才通過。
 * 回傳 { code, reasons, record }；record 是要寫進 _idle-audit.json 的內容（通過才寫）。
 */
export async function auditIdle({ root, days, todayIso, auditDate, brokers }) {
  const idle = idleBrokerSet(root, days, todayIso, { holdOut: [auditDate] });
  const base = { dataset: DS, auditDate, idleCount: idle.ids.length, idleIds: idle.ids, excluded: idle.excluded, probes: idle.probes,
    span: { from: idle.from, to: idle.to }, rule: '探針日（≥4 個已收尾）全部 0 列、且區間內其他已抓日（稽核日除外）也沒成交的券商＝閒置；稽核日整天抓全部券商，閒置券商要全部 0 列',
    source: SOURCE_LABEL, checkedAt: new Date().toISOString() };
  const done = (code, reasons, extra = {}) => ({ code, reasons, record: { ...base, ...extra, result: code === EXIT.ok ? 'pass' : 'fail', reasons } });
  const pre = precheck(auditDate, days, idle, brokers);
  if (pre) return done(pre[0], [pre[1]]);
  const paths = groupPaths(root, DS, auditDate);
  const st = readDone(paths);
  const cov = coverageProblem(auditDate, st, brokers);
  if (cov) return done(EXIT.notReady, [cov]);

  const violations = idle.ids.filter(id => st.rowsBy.get(id) !== 0).map(id => ({ id, rows: st.rowsBy.get(id) }));
  const { dataRows, mismatch } = await scanData(paths, st, idle.ids);
  const reasons = [
    ...violations.map(v => `${v.id}：稽核日 ${auditDate} 有 ${fmtN(v.rows)} 列（探針日全 0 列，被判為閒置）`),
    ...(dataRows !== st.rows ? [`稽核日 ${auditDate} 資料檔 ${fmtN(dataRows)} 列≠索引 ${fmtN(st.rows)} 列（檔案與索引不一致）`] : []),
    ...mismatch.map(m => `${m.id}：資料檔有 ${fmtN(m.dataRows)} 列（索引 ${fmtN(m.indexRows)} 列）`),
  ];
  const zeroBrokers = [...st.rowsBy.values()].filter(n => n === 0).length;
  const auditDay = { brokers: brokers.length, members: st.members, rows: st.rows, dataRows, zeroBrokers, activeBrokers: st.members - zeroBrokers };
  return done(reasons.length ? EXIT.violation : EXIT.ok, reasons, { auditDay, violations, dataMismatch: mismatch });
}

/** 探針日進度（判斷 backfill --probe-brokers 是否完成）：每個應有的探針日都收尾、且涵蓋清單上全部券商才算完成。 */
export function probeStatus({ root, days, todayIso, brokers }) {
  const idle = idleBrokerSet(root, days, todayIso);
  const probes = idle.planned.map(date => {
    const st = readDone(groupPaths(root, DS, date));
    return { date, final: st.final, members: st.members, rows: st.rows, zero: [...st.rowsBy.values()].filter(n => n === 0).length,
      missing: brokers?.length ? brokers.filter(id => !st.done.has(id)).length : null };
  });
  const complete = probes.length >= MIN_PROBES && probes.every(p => p.final && p.missing === 0);
  return { probes, complete, idleCount: idle.ids.length, excluded: idle.excluded, span: { from: idle.from, to: idle.to } };
}

function printProbeStatus(s, brokers, print) {
  print(`FinMind 分點探針日｜${SOURCE_LABEL}｜券商清單 ${brokers?.length ? `${fmtN(brokers.length)} 家` : '（本機沒有）'}`);
  for (const p of s.probes) {
    const tag = p.final && p.missing === 0 ? '✓' : p.final ? '⚠' : '…';
    print(`  ${tag} ${p.date}  ${p.final ? '已收尾' : p.members ? '進行中' : '未抓  '}  券商 ${fmtN(p.members).padStart(5)}  0 列 ${fmtN(p.zero).padStart(4)}  列 ${fmtN(p.rows).padStart(11)}${p.missing ? `  缺 ${fmtN(p.missing)} 家` : ''}`);
  }
  print(s.complete
    ? `✓ 探針日 ${s.probes.length} 個全部收尾｜目前判定閒置 ${s.idleCount} 家（${s.span.from}～${s.span.to}）${s.excluded.length ? `｜探針全 0 列但其他日有成交、不列閒置：${sample(s.excluded.map(x => x.id))}` : ''}`
    : `… 探針日尚未全部完成：${s.probes.filter(p => !(p.final && p.missing === 0)).map(p => p.date).join('、') || `探針日不足 ${MIN_PROBES} 個`}`);
}

function printAudit(r, print) {
  const rec = r.record;
  if (rec.excluded?.length) print(`ℹ 探針日全 0 列但區間內其他已抓日有成交、不列入閒置：${rec.excluded.map(x => `${x.id}（${x.dates.slice(0, 3).join('、')}${x.dates.length > 3 ? ` 等 ${x.dates.length} 天` : ''}）`).join('；')}`);
  if (r.code === EXIT.ok) {
    print(`✓ 閒置券商稽核通過：稽核日 ${rec.auditDate}｜閒置 ${rec.idleCount} 家（已收尾探針 ${rec.probes.length} 個，${rec.span.from}～${rec.span.to}）在稽核日全部 0 列`);
    print(`  稽核日 ${fmtN(rec.auditDay.members)} 家券商、${fmtN(rec.auditDay.activeBrokers)} 家有成交、索引 ${fmtN(rec.auditDay.rows)} 列＝資料檔逐列 ${fmtN(rec.auditDay.dataRows)} 列`);
    return;
  }
  print(`✖ 閒置券商稽核未通過（結束碼 ${r.code}）${rec.idleCount ? `｜閒置 ${rec.idleCount} 家` : ''}`);
  for (const x of r.reasons) print(`  - ${x}`);
}

export async function main(argv, { root: rootDep = null, ld: ldDep = null, todayIso = taipeiParts(Date.now()).date, print = console.log } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { print(`✖ ${e.message}`); return EXIT.usage; }
  const root = resolve(opts.root || rootDep || PATHS.root);
  const ld = ldDep || createLocalData({ backup: PATHS.backup, official: PATHS.official, finmind: root });
  const days = ld.tradingDays();
  const brokers = ld.brokersFor(opts.date || todayIso);
  if (opts.probeStatus) {
    const s = probeStatus({ root, days, todayIso, brokers });
    printProbeStatus(s, brokers, print);
    return s.complete ? EXIT.ok : EXIT.notReady;
  }
  const r = await auditIdle({ root, days, todayIso, auditDate: opts.date, brokers });
  printAudit(r, print);
  if (r.code === EXIT.ok && !opts.noWrite) {
    const file = join(datasetDir(root, DS), AUDIT_FILE);
    writeJsonAtomic(file, r.record);
    print(`✓ 已寫 ${file}`);
  }
  return r.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch(e => { console.error(`✖ ${e?.message || e}`); process.exit(EXIT.violation); });
}
