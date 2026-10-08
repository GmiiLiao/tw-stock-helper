#!/usr/bin/env node
// ── FinMind 回補 CLI（second-brain/finmind，研究用·不上站）──────────────────────────────
// 使用者 2026-10-08：「可下載的資料先下載2023-2026的部份，先驗證，其它的再找空閒時間下載」
//   ① 每個資料集先 --sample（小樣本）→ validate.mjs 與官方比對通過（_validation.json=pass）才允許大量下載（> 60 請求）。
//   ② 主佇列 2023-01-01 起；平日 08:30–13:45 每小時 ≤1,500、其餘 ≤5,000（timewin）；每秒 ≤2。
//   ③ 2023 以前＝空閒佇列：只在 --window idle（平日 15:30–08:00、週末、休市日）且該資料集主佇列全部完成後才跑。
// 規矩：token 執行時才從 .env.local 讀、只放 Authorization 標頭；單程序鎖；SIGTERM 收尾（第二次 SIGTERM 中止進行中的請求）；
//       不寫 Firestore、不動 daemon；寫檔 gzip、批次 fsync、低優先權（nice 10）。
// 用法：
//   node scripts/finmind/backfill.mjs --status [--quota]
//   node scripts/finmind/backfill.mjs --dataset <名稱,名稱|cheap> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--codes 2330,2317]
//        [--priority recent-first|oldest-first] [--interleave] [--max-requests N] [--window main|idle] [--sample]
//        [--route broker|stock] [--universe stocks|stocks+etf] [--retry-empty] [--dry-run] [--refresh-docs] [--log <path>] [--root <dir>]
//        [--probe-brokers]       分點只抓探針日（每年 1／7 月第一個交易日＋最後一日），供下一項判定閒置券商
//        [--skip-idle-brokers]   探針日（≥4 個）全部 0 列的券商，在探針日區間內不請求（省停業券商的額度；區間外照抓）
// 結束碼：0 完成／max-requests；1 錯誤停止；2 參數；3 閘門；4 SIGTERM 收尾（串接 && 時不會自動進下一步）
import { existsSync, statfsSync } from 'node:fs';
import { setPriority } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DATASETS, MAIN_START, SAMPLE_STOCKS, SOURCE_LABEL, getSpec, resolveDatasets } from './datasets.mjs';
import { defaultTo, expandPlan, orderGroups, sampleDays, summarizePlan } from './jobs.mjs';
import { createLocalData } from './localdata.mjs';
import { acquireLock, datasetDir, groupPaths, readDone, readJson, releaseLock, writeJsonAtomic } from './store.mjs';
import { runPlan } from './runner.mjs';
import { validationOk } from './validate.mjs';
import { chooseToken, describeCandidates, maskSecrets, readTokenCandidates } from './secrets.mjs';
import { createFinMindClient, defaultSleep } from './client.mjs';
import { createRateLimiter } from './ratelimit.mjs';
import { createRequestLog } from './reqlog.mjs';
import { etaHours, hourlyCapAt, taipeiParts, WINDOWS } from './timewin.mjs';
import { updateManifest, writeDocs } from './docs.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PATHS = Object.freeze({ env: join(REPO, '.env.local'), root: join(REPO, 'second-brain', 'finmind'), backup: join(REPO, 'second-brain', 'backup'), official: join(REPO, 'second-brain', 'official') });
export const DEFAULT_REQUEST_LOG = '/private/tmp/claude-501/-Users-gmii-Documents-----app/4719486c-a017-4257-8b3e-e4ff75aedb5d/scratchpad/finmind/requests.log';
export const SAMPLE_MAX_REQUESTS = 60;
const DISK_RESERVE_BYTES = 20e9;
const DISK_FACTOR = 1.5;
const PROBE_BROKER = '1020';
const EST_BROKERS = 1044;   // 目錄員 2026-10-08 實測證券商清單筆數（券商清單未下載時，dry-run／status 用來估算）   // 目錄員實測一次 842 檔：近日群組第一個請求用它判斷「FinMind 是否已更新」
const FLAGS = new Set(['--dry-run', '--status', '--sample', '--retry-empty', '--interleave', '--quota', '--refresh-docs', '--probe-brokers', '--skip-idle-brokers']);
const VALUED = new Set(['--dataset', '--from', '--to', '--codes', '--priority', '--max-requests', '--window', '--route', '--universe', '--root', '--log']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EXIT = { ok: 0, error: 1, usage: 2, gate: 3, stopped: 4 };
/** 結束碼：done／max-requests＝0；SIGTERM 收尾＝4（不是 0：串接「步驟1 && 步驟2」時，手動停下的步驟不可讓下一步自動開跑）；其餘停止原因＝1。 */
export const exitCodeFor = stopReason => (['done', 'max-requests'].includes(stopReason) ? EXIT.ok : stopReason === 'signal' ? EXIT.stopped : EXIT.error);

const SECRETS = [];   // 讀到的 token 候選（只供遮罩錯誤訊息用，不輸出）
function loadCandidates() {
  const r = readTokenCandidates(PATHS.env);
  SECRETS.push(...r.candidates.map(c => c.value));
  return r;
}
const camel = s => s.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const fmtN = n => Number(n).toLocaleString('en-US');
const fmtGB = b => `${(b / 1e9).toFixed(b >= 1e10 ? 0 : 2)}GB`;

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
  for (const k of ['from', 'to']) if (o[k] && !DATE_RE.test(o[k])) throw new Error(`--${k} 要 YYYY-MM-DD`);
  o.window ||= 'main';
  if (!WINDOWS.includes(o.window)) throw new Error(`--window 只接受 ${WINDOWS.join('／')}`);
  if (o.route && !['broker', 'stock'].includes(o.route)) throw new Error('--route 只接受 broker／stock');
  if (o.universe && !['stocks', 'stocks+etf'].includes(o.universe)) throw new Error('--universe 只接受 stocks／stocks+etf');
  if (o.maxRequests != null) { o.maxRequests = Number(o.maxRequests); if (!Number.isInteger(o.maxRequests) || o.maxRequests <= 0) throw new Error('--max-requests 要正整數'); }
  if (o.codes) o.codes = o.codes.split(',').map(s => s.trim()).filter(Boolean);
  if (o.codes?.some(c => !/^[A-Za-z0-9]+$/.test(c))) throw new Error('--codes 只接受英數代號');
  if (!o.status && !o.dataset) throw new Error('要指定 --dataset 或 --status');
  return o;
}

/** 週資料日（dry-run 估算用）：每週最後一個交易日。 */
export function approxWeeks(days) {
  const wk = d => { const t = new Date(`${d}T00:00:00Z`); const day = (t.getUTCDay() + 6) % 7; return new Date(t.getTime() - day * 86400e3).toISOString().slice(0, 10); };
  const last = new Map();
  for (const d of days) last.set(wk(d), d);
  return [...last.values()];
}

const variantFor = (spec, route) => (spec.mode === 'broker-day' && route === 'stock' ? 'by-stock' : null);
const maxDate = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

/** 分點停業券商探針日：區間內每年 1 月、7 月的第一個交易日，加上區間最後一日。 */
export function brokerProbeDates(days, from, to) {
  const r = days.filter(d => d >= from && d <= to);
  const out = []; const seen = new Set();
  for (const d of r) { const k = d.slice(0, 7); if ((k.endsWith('-01') || k.endsWith('-07')) && !seen.has(k)) { seen.add(k); out.push(d); } }
  if (r.length && out.at(-1) !== r.at(-1)) out.push(r.at(-1));
  return out;
}

const MIN_PROBES = 4;
/** 閒置券商：在每個已收尾的探針日都有請求、且都 0 列（停業或長期無成交）。探針不足 MIN_PROBES 個就不判定（回空集合）。 */
export function idleBrokers(root, spec, probeDates) {
  const done = probeDates.map(d => ({ d, st: readDone(groupPaths(root, spec.name, d)) })).filter(x => x.st.final && x.st.rowsBy?.size);
  if (done.length < MIN_PROBES) return { ids: [], from: null, to: null, probes: done.map(x => x.d) };
  const [first, ...rest] = done;
  const ids = [...first.st.rowsBy].filter(([id, n]) => n === 0 && rest.every(x => x.st.rowsBy.get(id) === 0)).map(([id]) => id).sort();
  return { ids, from: done[0].d, to: done.at(-1).d, probes: done.map(x => x.d) };
}

/** 規劃環境：交易日、區間、各日代號、已完成成員。 */
export function buildContext(opts, ld, root, todayIso) {
  const days = ld.tradingDays();
  const route = opts.route || 'broker';
  const ctx = {
    // asOf：快照群組名＝抓取日（缺了會變 snapshot_undefined，2026-10-08 試抓實測）
    days, todayIso, asOf: todayIso, route, codes: opts.codes || null, from: opts.from || MAIN_START, to: opts.to || defaultTo(days, todayIso),
    priority: opts.priority || 'recent-first', interleave: !!opts.interleave, retryEmpty: !!opts.retryEmpty,
    doneFor: (spec, group, route = ctx.route) => readDone(groupPaths(root, spec.name, group, variantFor(spec, route))),
    membersFor(spec, date) {
      if (spec.members === 'stocks' || (spec.mode === 'broker-day' && ctx.route === 'stock')) {
        const s = ld.stocksFor(date); if (!s) return null;
        return opts.universe === 'stocks+etf' ? [...s, ...(ld.etfsFor(date) || [])] : s;
      }
      if (spec.members === 'futures' || spec.members === 'options') return spec.defaultMembers;
      if (spec.mode === 'broker-day') {
        let b = ld.brokersFor(date);
        if (!b) return opts.dryRun || opts.status ? Array.from({ length: EST_BROKERS }, (_, i) => `est${i}`) : null;
        // --skip-idle-brokers：探針日全部 0 列的券商，在探針日區間內不請求（區間外、例如 2023 以前，照抓）
        const idle = ctx.idleFor();
        if (idle.ids.length && date >= idle.from && date <= idle.to) { const skip = new Set(idle.ids); b = b.filter(x => !skip.has(x)); }
        return b.includes(PROBE_BROKER) ? [PROBE_BROKER, ...b.filter(x => x !== PROBE_BROKER)] : b;
      }
      return null;
    },
    idleFor() { return ctx.idleBrokers || { ids: [] }; },
    weeksFor(spec) {
      const w = readJson(join(datasetDir(root, spec.name), '_weeks.json'), null);
      // 已存範圍要同時涵蓋本次終點與起點（2023 起的週資料日不能拿來排 2023 以前的空閒佇列）
      if (w?.dates && w.to >= ctx.to && w.from <= maxDate(ctx.from, spec.since)) return w.dates;
      return opts.dryRun || opts.status ? approxWeeks(days) : undefined;
    },
  };
  if (!ctx.to) throw new Error('本機沒有交易日資料（second-brain/backup/chipArchive），無法決定 --to');
  if (opts.skipIdleBrokers && route === 'broker') {
    ctx.idleBrokers = idleBrokers(root, getSpec('TaiwanStockTradingDailyReport'), brokerProbeDates(days, MAIN_START, defaultTo(days, todayIso) || ctx.to));
  }
  return ctx;
}

/** 計畫：一般或抽樣（--sample：每資料集 3 個抽樣日 × 少數代號；分點走股票路線）。 */
export function planAll(specs, ctx, opts) {
  if (opts.probeBrokers && !opts.sample) {
    // --probe-brokers：分點只排探針日（之後 --skip-idle-brokers 用它們判定閒置券商）；其他資料集照常
    const probeDays = brokerProbeDates(ctx.days, ctx.from, ctx.to);
    const a = expandPlan(specs.filter(s => s.mode === 'broker-day'), { ...ctx, days: probeDays });
    const b = expandPlan(specs.filter(s => s.mode !== 'broker-day'), ctx);
    return { groups: orderGroups([...a.groups, ...b.groups], ctx), skipped: [...a.skipped, ...b.skipped] };
  }
  if (!opts.sample) return expandPlan(specs, ctx);
  const groups = []; const skipped = [];
  for (const spec of specs) {
    const f = maxDate(ctx.from, spec.since);
    let days = sampleDays(ctx.days, { from: f, to: ctx.to });
    if (spec.name === 'TaiwanOptionTick') days = days.slice(-1);   // 一天 107MB：抽樣只抓最新一天
    const s = { ...ctx, days };
    if (spec.members === 'stocks' || spec.mode === 'broker-day') s.codes = ctx.codes || SAMPLE_STOCKS;
    if (spec.mode === 'broker-day') s.route = 'stock';
    if (spec.members === 'futures' || spec.members === 'options') s.codes = ctx.codes || spec.defaultMembers.slice(0, 1);
    if (spec.mode === 'week') { const w = ctx.weeksFor(spec); s.weeksFor = () => (w ? sampleDays(w, { from: f, to: ctx.to }) : w); }
    s.doneFor = (sp, g) => ctx.doneFor(sp, g, s.route);
    const p = expandPlan([spec], s);
    groups.push(...p.groups); skipped.push(...p.skipped);
  }
  return { groups, skipped };
}

/** 主佇列（2023 起）還差幾個請求。 */
export function mainRemaining(spec, ctx) {
  const p = expandPlan([spec], { ...ctx, from: MAIN_START, to: defaultTo(ctx.days, ctx.todayIso), retryEmpty: false });
  return p.groups.reduce((n, g) => n + g.members.length, 0) + p.skipped.length;
}

/** 閘門：空閒佇列（window／主佇列完成）與驗證（未通過不得大量下載）。 */
export function applyGates(plan, specs, ctx, opts, root) {
  const notes = []; let groups = plan.groups;
  const idle = groups.filter(g => g.phase === 'idle');
  if (idle.length && opts.window !== 'idle') {
    groups = groups.filter(g => g.phase !== 'idle');
    notes.push(`2023 以前 ${fmtN(idle.reduce((n, g) => n + g.members.length, 0))} 個請求屬空閒佇列：本次不跑（要跑請加 --window idle，且主佇列要先完成）`);
  } else if (idle.length) {
    for (const spec of specs) {
      if (!groups.some(g => g.dataset === spec.name && g.phase === 'idle')) continue;
      const left = mainRemaining(spec, ctx);
      if (!left) continue;
      // 主佇列剩下的若全部排在本次前段（main 一律排在 idle 前），idle 群組標 afterMain：runner 確認該資料集本次的 main 群組都收尾後才跑
      //   （區間型資料集的群組名帶 to 日期、新交易日也會長出 main 群組 ⇒ 不這樣做，空閒佇列永遠要分兩次執行）
      const queued = groups.filter(g => g.dataset === spec.name && g.phase === 'main').reduce((n, g) => n + g.members.length, 0);
      if (queued >= left) {
        groups = groups.map(g => (g.dataset === spec.name && g.phase === 'idle' ? { ...g, afterMain: true } : g));
        notes.push(`${spec.name} 主佇列（2023 起）剩 ${fmtN(left)} 個請求排在本次前段：全部收尾後才接著跑 2023 以前`);
      } else { groups = groups.filter(g => !(g.dataset === spec.name && g.phase === 'idle')); notes.push(`${spec.name} 主佇列（2023 起）還差 ${fmtN(left)} 個請求，空閒佇列先不跑`); }
    }
  }
  const refused = [];
  if (!opts.sample) {
    const sum = summarizePlan(groups);
    for (const spec of specs) {
      const n = sum.byDataset[spec.name]?.requests || 0;
      if (n > SAMPLE_MAX_REQUESTS && !validationOk(root, spec)) {
        groups = groups.filter(g => g.dataset !== spec.name);
        refused.push(`${spec.name}（${fmtN(n)} 個請求）尚未通過驗證：先 --sample，再 node scripts/finmind/validate.mjs --dataset ${spec.name}`);
      }
    }
  }
  return { groups, notes, refused };
}

export function diskCheck(root, estGzBytes) {
  let p = root; while (!existsSync(p)) p = dirname(p);
  const s = statfsSync(p);
  const free = Number(s.bavail) * Number(s.bsize);
  const need = estGzBytes * DISK_FACTOR + DISK_RESERVE_BYTES;
  return { free, need, ok: free >= need };
}

function printPlan(sum, ctx, opts, windowOpts, gates, skipped, allSum = sum) {
  console.log(`FinMind 下載計畫｜${SOURCE_LABEL}`);
  console.log(`區間 ${ctx.from} ～ ${ctx.to}｜window ${opts.window}｜priority ${ctx.priority}${ctx.interleave ? '（交錯）' : ''}${opts.sample ? '｜抽樣' : ''}`);
  for (const [name, d] of Object.entries(allSum.byDataset)) {
    const tag = sum.byDataset[name] ? '✓' : '✖ 待驗證';
    console.log(`  ${tag.padEnd(5)} ${name.padEnd(48)} 群組 ${fmtN(d.groups).padStart(6)}  請求 ${fmtN(d.requests).padStart(10)}  估 gz ${fmtGB(d.estGzBytes)}`);
  }
  const h = etaHours(sum.requests, opts.window, windowOpts);
  const hAll = etaHours(allSum.requests, opts.window, windowOpts);
  const eta = x => (x < 48 ? `${x.toFixed(1)} 小時` : `${(x / 24).toFixed(1)} 天`);
  console.log(`本次可跑 請求 ${fmtN(sum.requests)}（main ${fmtN(sum.byPhase.main)}／idle ${fmtN(sum.byPhase.idle)}）｜估 gz ${fmtGB(sum.estGzBytes)}｜預估 ${eta(h)}（${opts.window} 窗平均速率）`);
  if (allSum.requests !== sum.requests) console.log(`全部（含待驗證） 請求 ${fmtN(allSum.requests)}｜估 gz ${fmtGB(allSum.estGzBytes)}｜預估 ${eta(hAll)}`);
  for (const n of gates.notes) console.log(`ℹ ${n}`);
  for (const r of gates.refused) console.log(`✖ ${r}`);
  const bySkip = new Map();
  for (const x of skipped) { const k = `${x.dataset}：${x.reason}`; bySkip.set(k, [...(bySkip.get(k) || []), x.group]); }
  for (const [k, gs] of bySkip) console.log(`⚠ 略過 ${gs.length} 個群組（${gs[gs.length - 1]}～${gs[0]}）${k}`);
}

async function printStatus(opts, ld, root, todayIso, windowOpts) {
  console.log(`FinMind 第二大腦狀態｜${SOURCE_LABEL}｜${root}`);
  const lock = readJson(join(root, '_lock.json'), null);
  const st = readJson(join(root, '_status.json'), null);
  if (lock) console.log(`⏳ 執行中 pid ${lock.pid}（${lock.startedAt} 起）`);
  if (st) console.log(`上次執行：${st.startedAt} → ${st.finishedAt || '進行中'}｜請求 ${fmtN(st.stats?.requests || 0)}｜列 ${fmtN(st.stats?.rows || 0)}｜停止原因 ${st.stats?.stopReason || '—'}`);
  const specs = opts.dataset ? resolveDatasets(opts.dataset) : DATASETS.filter(d => d.enabled);
  const ctx = buildContext({ ...opts, status: true }, ld, root, todayIso);
  let total = 0;
  for (const spec of specs) {
    const cov = readJson(join(datasetDir(root, spec.name), '_coverage.json'), null)?.summary;
    const val = readJson(join(datasetDir(root, spec.name), '_validation.json'), null)?.status || '未驗證';
    let left; try { left = mainRemaining(spec, ctx); total += left; } catch { left = '?'; }
    console.log(`  ${spec.name.padEnd(48)} 完成 ${String(cov?.complete ?? 0).padStart(4)}／空 ${String(cov?.empty ?? 0).padStart(3)}／進行中 ${String(cov?.partial ?? 0).padStart(3)}  列 ${fmtN(cov?.rows ?? 0).padStart(12)}  ${fmtGB(cov?.bytes ?? 0).padStart(7)}  ${cov?.firstDate || '—'}～${cov?.lastDate || '—'}  驗證 ${val}  主佇列剩 ${typeof left === 'number' ? fmtN(left) : left}`);
  }
  console.log(`主佇列（${MAIN_START}～${ctx.to}）合計剩 ${fmtN(total)} 個請求，main 窗預估 ${(etaHours(total, 'main', windowOpts) / 24).toFixed(1)} 天`);
  if (opts.quota) {
    const { candidates } = loadCandidates();
    const reqlog = createRequestLog(opts.log || process.env.FINMIND_REQUEST_LOG || DEFAULT_REQUEST_LOG, { secrets: candidates.map(c => c.value), tag: 'status' });
    const picked = await chooseToken(candidates, tok => createFinMindClient({ token: tok, log: r => reqlog.write(r) }).userInfo());
    reqlog.flush();
    console.log(`額度：.env.local 第 ${picked.line} 行 token｜level ${picked.level}（${picked.info?.level_title ?? '—'}）｜本小時已用 ${picked.info?.user_count ?? '?'}／上限 ${picked.info?.api_request_limit_hour ?? '?'}`);
  }
}

function eventLogger(statusPath, base) {
  let last = base;
  return e => {
    const t = taipeiParts(Date.now()).iso.slice(5, 16).replace('T', ' ');
    if (e.type === 'progress') {
      last = { ...last, stats: e }; writeJsonAtomic(statusPath, last);
      console.log(`${t} 進度：請求 ${fmtN(e.requests)}｜列 ${fmtN(e.rows)}｜gz ${fmtGB(e.gzBytes)}｜完成群組 ${fmtN(e.groupsFinalized)}｜失敗 ${e.failures}`);
    } else if (e.type === 'quota') console.log(`${t} 額度：伺服器本小時 ${e.user_count}／${e.limit_hour}｜本機近一小時 ${e.local_last_hour}`);
    else console.log(`${t} ${e.type === 'fail' ? '✖' : e.type === 'warn' ? '⚠' : 'ℹ'} ${e.reason || e.msg || ''}${e.label ? `（${e.label}）` : ''}`);
  };
}

async function discoverWeeks(specs, ctx, client, root) {
  for (const spec of specs.filter(s => s.mode === 'week')) {
    if (ctx.weeksFor(spec)) continue;
    const from = maxDate(ctx.from, spec.since);
    const dates = new Set();
    const make = () => ({ async write(rows) { for (const r of rows) { const m = /"date"\s*:\s*"(\d{4}-\d{2}-\d{2})/.exec(r); if (m) dates.add(m[1]); } }, async end() { return null; }, abort() {} });
    await client.fetchRows({ endpoint: 'data', params: { dataset: spec.name, data_id: spec.discoverId, start_date: from, end_date: ctx.to }, label: `${spec.name}/discover` }, make);
    if (!dates.size) throw new Error(`${spec.name} 週資料日查詢（data_id=${spec.discoverId}）回 0 筆——不寫 _weeks.json，請檢查`);
    writeJsonAtomic(join(datasetDir(root, spec.name), '_weeks.json'), { dataset: spec.name, from, to: ctx.to, dates: [...dates].sort(), source: SOURCE_LABEL, fetchedAt: new Date().toISOString() });
    console.log(`ℹ ${spec.name} 週資料日 ${dates.size} 個（${from}～${ctx.to}，以 ${spec.discoverId} 查得）`);
  }
}

async function run(opts) {
  const root = resolve(opts.root || PATHS.root); opts.root = root;
  const ld = createLocalData({ backup: PATHS.backup, official: PATHS.official, finmind: root });
  const hol = ld.holidays();
  const windowOpts = { isHoliday: d => hol.has(d) };
  const todayIso = taipeiParts(Date.now()).date;
  if (opts.status) { await printStatus(opts, ld, root, todayIso, windowOpts); return EXIT.ok; }

  const specs = resolveDatasets(opts.dataset);
  const ctx = buildContext(opts, ld, root, todayIso);
  if (ctx.from < ld.tradingDays()[0]) console.log(`⚠ --from ${ctx.from} 早於本機交易日資料（${ld.tradingDays()[0]}）：更早的日子要先下載 TaiwanStockTradingDate`);
  // 離線預先規劃（週資料日、券商清單未下載時用估計值）：閘門與磁碟先判斷，沒有可跑的就不讀 token、不打網路
  const estCtx = buildContext({ ...opts, dryRun: true }, ld, root, todayIso);
  const prePlan = planAll(specs, estCtx, opts);
  const preGates = applyGates(prePlan, specs, estCtx, opts, root);
  const preSum = summarizePlan(preGates.groups);
  const allSum = summarizePlan(opts.window === 'idle' ? prePlan.groups : prePlan.groups.filter(g => g.phase === 'main'));
  const disk = diskCheck(root, opts.dryRun ? allSum.estGzBytes : preSum.estGzBytes);
  if (opts.dryRun) {
    printPlan(preSum, estCtx, opts, windowOpts, preGates, prePlan.skipped, allSum);
    console.log(`${disk.ok ? '✓' : '✖'} 磁碟：剩 ${fmtGB(disk.free)}，需要 ${fmtGB(disk.need)}（估 gz ×${DISK_FACTOR}＋保留 ${fmtGB(DISK_RESERVE_BYTES)}）｜dry-run：沒有讀 token、沒有打網路`);
    return EXIT.ok;
  }
  if (!disk.ok) { console.log(`✖ 磁碟不足：剩 ${fmtGB(disk.free)}，需要 ${fmtGB(disk.need)}（估 gz ×${DISK_FACTOR}＋保留 ${fmtGB(DISK_RESERVE_BYTES)}）`); return EXIT.gate; }
  if (!preGates.groups.length) {
    printPlan(preSum, estCtx, opts, windowOpts, preGates, prePlan.skipped, allSum);
    console.log(preGates.refused.length ? '✖ 沒有可跑的群組（驗證閘門）——沒有讀 token、沒有打網路' : '✓ 沒有缺的資料');
    return preGates.refused.length ? EXIT.gate : EXIT.ok;
  }

  const { candidates, empty } = loadCandidates();   // 先讀 token 候選（失敗就不必拿鎖）
  const lock = acquireLock(root);
  const soft = new AbortController(); const hard = new AbortController();
  const onSignal = sig => {
    if (!soft.signal.aborted) { console.log(`ℹ 收到 ${sig}：做完當前請求後收尾（再送一次會中止進行中的請求）`); soft.abort(); } else hard.abort();
  };
  process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);
  const reqlog = createRequestLog(opts.log || process.env.FINMIND_REQUEST_LOG || DEFAULT_REQUEST_LOG, { secrets: candidates.map(c => c.value) });
  const statusPath = join(root, '_status.json');
  const base = { running: true, pid: process.pid, startedAt: new Date().toISOString(), opts: { ...opts, codes: opts.codes?.length ?? null }, source: SOURCE_LABEL };
  try {
    try { setPriority(10); } catch { /* 低優先權失敗不致命 */ }
    if (empty.length) console.log(`⚠ .env.local 第 ${empty.join('、')} 行 FINMIND_TOKEN 是空值（略過）`);
    console.log(`ℹ token 候選：${describeCandidates(candidates).map(c => `第 ${c.line} 行（長度 ${c.length}）`).join('、')}——以 user_info 驗 level`);
    const picked = await chooseToken(candidates, tok => createFinMindClient({ token: tok, log: r => reqlog.write(r) }).userInfo());
    console.log(`✓ 使用 .env.local 第 ${picked.line} 行 token｜level ${picked.level}｜本小時已用 ${picked.info?.user_count ?? '?'}／上限 ${picked.info?.api_request_limit_hour ?? '?'}`);
    const limiter = createRateLimiter({ capFor: ms => hourlyCapAt(ms, windowOpts), perSecond: 2, burst: 20 });
    limiter.seed(picked.info?.user_count); limiter.setServerCap(picked.info?.api_request_limit_hour);
    const client = createFinMindClient({ token: picked.token, limiter, log: r => reqlog.write(r), signal: hard.signal, sleep: ms => defaultSleep(ms, soft.signal) });
    await discoverWeeks(specs, ctx, client, root);
    if (!opts.sample && ctx.route === 'broker' && specs.some(sp => sp.mode === 'broker-day') && !ld.brokersFor(ctx.to)) {
      console.log('ℹ 分點券商路線需要證券商清單：先抓 TaiwanSecuritiesTraderInfo（1 個請求）');
      const tp = expandPlan([getSpec('TaiwanSecuritiesTraderInfo')], ctx);
      const ts = await runPlan({ groups: tp.groups, client, limiter, root, stopSignal: soft.signal, window: opts.window, windowOpts, log: eventLogger(statusPath, base), todayIso });
      if (ts.stopReason !== 'done') { console.log(`✖ 證券商清單下載失敗：${ts.stopReason}`); return EXIT.error; }
    }
    const plan = planAll(specs, ctx, opts);
    const gates = applyGates(plan, specs, ctx, opts, root);
    const sum = summarizePlan(gates.groups);
    printPlan(sum, ctx, opts, windowOpts, gates, plan.skipped);
    if (!gates.groups.length) { console.log(gates.refused.length ? '✖ 沒有可跑的群組（驗證閘門）' : '✓ 沒有缺的資料'); return gates.refused.length ? EXIT.gate : EXIT.ok; }
    writeDocs(root, specs, { force: !!opts.refreshDocs });
    writeJsonAtomic(statusPath, base);
    const stats = await runPlan({ groups: gates.groups, client, limiter, root, stopSignal: soft.signal, window: opts.window, windowOpts,
      maxRequests: opts.maxRequests ?? Infinity, log: eventLogger(statusPath, base), todayIso });
    const runRec = { startedAt: stats.startedAt, finishedAt: stats.finishedAt, from: ctx.from, to: ctx.to, window: opts.window, sample: !!opts.sample, requests: stats.requests, rows: stats.rows, gzBytes: stats.gzBytes, stopReason: stats.stopReason };
    for (const spec of specs) updateManifest(root, spec, gates.groups.some(g => g.dataset === spec.name) ? runRec : null);
    writeJsonAtomic(statusPath, { ...base, running: false, finishedAt: stats.finishedAt, stats });
    console.log(`${['done', 'max-requests', 'signal'].includes(stats.stopReason) ? '✓' : '✖'} 結束：${stats.stopReason}｜請求 ${fmtN(stats.requests)}｜列 ${fmtN(stats.rows)}｜gz ${fmtGB(stats.gzBytes)}｜收尾群組 ${fmtN(stats.groupsFinalized)}｜失敗 ${stats.failures}${stats.notPublished.length ? `｜尚未更新 ${stats.notPublished.length}` : ''}`);
    return exitCodeFor(stats.stopReason);
  } finally {
    reqlog.flush();
    releaseLock(lock);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`✖ ${e.message}`); process.exit(EXIT.usage); }
  run(opts).then(code => process.exit(code)).catch(e => { console.error(`✖ ${maskSecrets(e?.message || e, SECRETS)}`); process.exit(EXIT.error); });
}
