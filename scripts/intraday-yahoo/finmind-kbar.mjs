#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// FinMind 台股 1 分 K 每日收集（來源 FinMind（第三方轉載官方）·研究用）——2026-10-09 使用者：「檢查 finmind 是否有提供即時完整資料？如果有以它為優先」
//
// 查證結果（2026-10-09）：
//   · 盤中「即時」：FinMind 只有 taiwan_stock_tick_snapshot（約 10 秒一次的報價快照，拼不出完整分 K；Sponsor 方案也規定即時資料不得上站）⇒ 不用。
//   · 盤後「完整」：TaiwanStockKBar（1 分 K，平日 15:50 更新）開高低收與官方逐檔一致、含 13:30 收盤集合競價那一根，
//     成交量為官方日量的 92–97%（差額應是盤後定價／鉅額，未驗）；Yahoo 1 分 K 只有 67–94%、無 13:30 根、舊價會被還原縮放。
//   ⇒ 盤後分 K 以本程式（FinMind）為優先；scripts/intraday-yahoo/collect.mjs（Yahoo）照跑、當備援（FinMind 缺的代號／訂閱到期後）。
//
// 存放：second-brain/intraday-finmind/{1m,5m,60m}/{YYYY-MM}/{YYYY-MM-DD}.json.gz，格式同 intraday-yahoo（codes[code]={t,o,h,l,c,v}），
//   t＝台北分鐘數、v＝FinMind 原值（單位：張，不換算）；5m／60m 由 1m 彙總（13:30 收盤根在 5m 自成一根、在 60m 併入 13:00 那根）。
//   每日檔 empty＝FinMind 回 0 列的代號（不重抓）；_coverage.json 分母＝官方當日有成交者（panel.npz）。
//
// 額度（與 scripts/finmind/backfill.mjs 大量回補共用每小時 6,000 次；回補單程序鎖、自己限 ≤5,000）：
//   每 300 個請求前查 user_info（不計次），本批只送「上限×90% − 伺服器本小時已用」；不足 30 次就每 5 分鐘再查一次。
//   每秒 ≤1.5 次；402 等 5 分鐘再查；401／403 停；平日 08:30–13:45 不跑（盤中額度留給回補、MIS 快線）。
//   一般一天約 1,950 次（一檔一天一請求；Sponsor 不能一次抓全市場）。
//
// 用法：node scripts/intraday-yahoo/finmind-kbar.mjs [--days N（補近 N 個交易日，預設 5）] [--codes 2330,2317] [--force] [--max-requests N]
// 排程：com.gmii.twstock.intraday-finmind 平日 17:00（避開 daemon 重任務窗 16:25–16:55；FinMind 15:50 更新）。
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmdirSync, statSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFinMindClient, defaultSleep } from '../finmind/client.mjs';
import { readTokenCandidates, chooseToken } from '../finmind/secrets.mjs';
import { createRequestLog } from '../finmind/reqlog.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const OUT = process.env.INTRADAY_FINMIND_OUT || join(REPO, 'second-brain', 'intraday-finmind');
const ENV_PATH = join(REPO, '.env.local');
const REQ_LOG = join(process.env.HOME || '/tmp', 'Library', 'Logs', 'twstock-intraday-finmind', 'requests.log');
const PY = existsSync('/Library/Frameworks/Python.framework/Versions/3.14/bin/python3') ? '/Library/Frameworks/Python.framework/Versions/3.14/bin/python3' : 'python3';
const SOURCE = 'FinMind TaiwanStockKBar（第三方轉載官方）·研究用·不上站';
const BATCH = 300, SERVER_MARGIN = 0.9, MIN_ALLOW = 30, WAIT_MS = 5 * 60e3, GAP_MS = 667;
const CLOSE_MIN = 13 * 60 + 30;

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const DAYS = Math.max(1, Math.min(20, Number(opt('--days') || 5)));
const CODES = opt('--codes')?.split(',').filter(c => /^[0-9A-Z]{4,6}$/.test(c)) || null;
const MAX_REQ = Number(opt('--max-requests') || Infinity);

const log = (...a) => console.log(new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Taipei' }), ...a);
const twNow = () => { const p = new Date(Date.now() + 8 * 3600e3); return { date: p.toISOString().slice(0, 10), min: p.getUTCHours() * 60 + p.getUTCMinutes(), wd: p.getUTCDay() }; };
function writeAtomic(path, buf) { mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.tmp${process.pid}`; writeFileSync(tmp, buf); renameSync(tmp, path); }
const writeJson = (p, o) => writeAtomic(p, JSON.stringify(o, null, 1));
const dayPath = (iv, d) => join(OUT, iv, d.slice(0, 7), `${d}.json.gz`);
const readDay = (iv, d) => { const p = dayPath(iv, d); return existsSync(p) ? JSON.parse(gunzipSync(readFileSync(p)).toString('utf8')) : null; };
const inBusyWindow = () => { const n = twNow(); return n.wd >= 1 && n.wd <= 5 && n.min >= 8 * 60 + 30 && n.min < 13 * 60 + 45; };
const minuteOf = s => { const [h, m] = String(s).split(':'); return +h * 60 + +m; };

/** FinMind 列 → {t,o,h,l,c,v}（依分鐘排序、同分鐘取後到） */
export function toBars(rows) {
  const m = new Map();
  for (const r of rows) { const t = minuteOf(r.minute); if (Number.isFinite(t) && r.close > 0) m.set(t, r); }
  const ts = [...m.keys()].sort((a, b) => a - b), b = { t: ts, o: [], h: [], l: [], c: [], v: [] };
  for (const t of ts) { const r = m.get(t); b.o.push(r.open); b.h.push(r.high); b.l.push(r.low); b.c.push(r.close); b.v.push(r.volume ?? 0); }
  return b;
}
/** 1 分 K 彙總成 N 分 K：區間起點分鐘為 t。5 分：13:30 收盤根自成一根；60 分：13:30 併入 13:00。 */
export function aggregate(b, n) {
  const key = t => (n === 5 && t >= CLOSE_MIN ? CLOSE_MIN : 9 * 60 + Math.floor((t - 9 * 60) / n) * n);
  const out = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let i = 0; i < b.t.length; i++) {
    const k = key(b.t[i]), j = out.t.length - 1;
    if (j >= 0 && out.t[j] === k) { out.h[j] = Math.max(out.h[j], b.h[i]); out.l[j] = Math.min(out.l[j], b.l[i]); out.c[j] = b.c[i]; out.v[j] += b.v[i]; }
    else { out.t.push(k); out.o.push(b.o[i]); out.h.push(b.h[i]); out.l.push(b.l[i]); out.c.push(b.c[i]); out.v.push(b.v[i]); }
  }
  return out;
}
function saveDay(d, codesMap, empty) {
  const cur = readDay('1m', d) || { schema: 'intraday-finmind/1', date: d, interval: '1m', tz: 'Asia/Taipei', official: false, source: SOURCE,
    unitVolume: 'lots(張)', note: 'FinMind 原值不換算；含 13:30 收盤集合競價根；成交量約官方日量 92–97%（差額應為盤後定價／鉅額）', codes: {}, empty: [] };
  Object.assign(cur.codes, codesMap); cur.empty = [...new Set([...(cur.empty || []), ...empty])].filter(c => !cur.codes[c]).sort();
  cur.n = Object.keys(cur.codes).length; cur.updated = new Date().toISOString();
  writeAtomic(dayPath('1m', d), gzipSync(JSON.stringify(cur)));
  for (const [iv, n] of [['5m', 5], ['60m', 60]]) {
    const agg = { ...cur, interval: iv, codes: Object.fromEntries(Object.entries(cur.codes).map(([c, b]) => [c, aggregate(b, n)])), note: `由 FinMind 1 分 K 彙總（${n === 5 ? '13:30 收盤根自成一根' : '13:30 併入 13:00 那根'}）` };
    writeAtomic(dayPath(iv, d), gzipSync(JSON.stringify(agg)));
  }
  return cur;
}

async function main() {
  const now = twNow();
  if (!flag('--force') && inBusyWindow()) { console.log('平日 08:30–13:45 不跑（盤中額度留給回補與快線）；要強制加 --force'); return 0; }
  mkdirSync(OUT, { recursive: true });
  const LOCK = join(OUT, '.lock');
  if (existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs > 14 * 3600e3) rmdirSync(LOCK);
  try { mkdirSync(LOCK); } catch { console.log('已有執行中（.lock）'); return 0; }
  process.on('exit', () => { try { rmdirSync(LOCK); } catch { /* 已釋放 */ } });

  const u = spawnSync(PY, [join(HERE, 'universe.py')], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (u.status !== 0) { console.error('universe.py 失敗：', u.stderr); return 1; }
  const U = JSON.parse(u.stdout);
  const official = Object.keys(U.expected).sort();
  // 目標日：官方最近 DAYS 個交易日＋（今天 15:55 後、且探針有資料）今天
  const days = official.slice(-DAYS).map(d => ({ date: d, codes: U.expected[d] }));
  const { candidates } = readTokenCandidates(ENV_PATH);
  const reqlog = createRequestLog(REQ_LOG, { secrets: candidates.map(c => c.value), tag: 'intraday-finmind' });
  let stopping = false; process.on('SIGTERM', () => { stopping = true; }); process.on('SIGINT', () => { stopping = true; });
  try {
    const picked = await chooseToken(candidates, tok => createFinMindClient({ token: tok, log: r => reqlog.write(r) }).userInfo());
    const client = createFinMindClient({ token: picked.token, log: r => reqlog.write(r) });
    log(`▶ FinMind 1 分 K｜token level ${picked.level}｜伺服器本小時已用 ${picked.info?.user_count ?? '?'}／${picked.info?.api_request_limit_hour ?? '?'}`);
    const fetchKBar = async (code, date) => {
      const rows = [];
      await client.fetchRows({ endpoint: 'data', params: { dataset: 'TaiwanStockKBar', data_id: code, start_date: date }, label: `kbar ${code} ${date}`, timeoutMs: 60e3 },
        () => ({ write: async rs => { for (const r of rs) rows.push(typeof r === 'string' ? JSON.parse(r) : r); }, end: async () => null, abort: () => {} }));   // client 交回原文 JSON 字串
      return rows;
    };
    if (now.min >= 15 * 60 + 55 && !official.includes(now.date) && !(now.wd === 0 || now.wd === 6)) {
      const probe = await fetchKBar('2330', now.date).catch(() => []);
      if (probe.length) { days.push({ date: now.date, codes: U.active, provisionalExpected: true }); saveDay(now.date, { 2330: toBars(probe) }, []); log(`  今天 ${now.date} FinMind 已有分 K（探針 2330 ${probe.length} 根）`); }
      else log(`  今天 ${now.date} FinMind 尚無分 K（休市或未更新）`);
    }
    let sent = 0, allow = 0, fails = 0;
    const budget = async () => {   // 本批可送幾個：上限×90% − 伺服器本小時已用
      for (;;) {
        if (stopping) return 0;
        const q = await client.userInfo();
        const lim = q.info?.api_request_limit_hour, used = q.info?.user_count;
        if (q.ok && lim > 0 && used != null) {
          const a = Math.floor(lim * SERVER_MARGIN) - used;
          log(`  額度：伺服器本小時 ${used}／${lim}｜本批可送 ${Math.max(0, Math.min(BATCH, a))}`);
          if (a >= MIN_ALLOW) return Math.min(BATCH, a);
        } else log(`  ⚠ user_info 查詢失敗（http=${q.http ?? '—'}），5 分鐘後再查`);
        await defaultSleep(WAIT_MS);
      }
    };
    const cov = {};
    for (const day of days) {
      const have = readDay('1m', day.date);
      const want = (CODES || day.codes).filter(c => !have?.codes?.[c] && !(have?.empty || []).includes(c));
      log(`── ${day.date}：應有 ${day.codes.length}｜已有 ${have ? Object.keys(have.codes).length : 0}｜要抓 ${want.length}`);
      const batch = {}; const empty = [];
      for (const c of want) {
        if (!flag('--force') && inBusyWindow()) { log('  進入平日 08:30–13:45：已抓的先存檔，下一輪接續'); stopping = true; break; }
        if (stopping || sent >= MAX_REQ) break;
        if (allow <= 0) { allow = await budget(); if (!allow) break; }
        try {
          const rows = await fetchKBar(c, day.date); sent++; allow--;
          if (rows.length) batch[c] = toBars(rows); else empty.push(c);
        } catch (e) {
          sent++; allow--; fails++;
          if (e.kind === 'quota') { log('  402 額度用完：5 分鐘後再查'); allow = 0; await defaultSleep(WAIT_MS); continue; }
          if (e.kind === 'auth' || e.http === 401 || e.http === 403) { log(`✖ ${e.message}：停止`); stopping = true; break; }
          log(`  ⚠ ${c} ${day.date}：${e.message}`);
          if (fails > 50) { log('✖ 失敗過多，停止'); stopping = true; break; }
        }
        if (Object.keys(batch).length + empty.length >= 100) { saveDay(day.date, batch, empty); for (const k of Object.keys(batch)) delete batch[k]; empty.length = 0; }
        await defaultSleep(GAP_MS);
      }
      const cur = saveDay(day.date, batch, empty);
      const exp = U.expected[day.date] || null;
      cov[day.date] = { have: Object.keys(cur.codes).length, empty: cur.empty.length, expected: exp ? exp.length : null, missing: exp ? exp.filter(c => !cur.codes[c]).length : null, provisional: !!day.provisionalExpected };
      if (stopping || sent >= MAX_REQ) break;
    }
    const prev = existsSync(join(OUT, '_coverage.json')) ? JSON.parse(readFileSync(join(OUT, '_coverage.json'), 'utf8')) : { days: {} };
    const merged = { ...prev.days, ...cov };
    const alerts = Object.entries(merged).filter(([, r]) => r.expected && r.have / r.expected < 0.97).map(([d, r]) => ({ day: d, ratio: +(r.have / r.expected).toFixed(4), missing: r.missing, msg: `${d} 1 分 K 覆蓋 ${(r.have / r.expected * 100).toFixed(1)}%（缺 ${r.missing} 檔；FinMind 回 0 列 ${r.empty} 檔）` }));
    writeJson(join(OUT, '_coverage.json'), { built: new Date().toISOString(), source: SOURCE, note: '分母＝官方當日有成交（panel.npz）；provisional＝當日官方資料尚未進 panel、分母暫缺', days: merged });
    writeJson(join(OUT, '_alerts.json'), { built: new Date().toISOString(), alerts });
    log(`✓ 結束｜請求 ${sent}｜失敗 ${fails}｜${Object.entries(cov).map(([d, r]) => `${d} ${r.have}${r.expected ? `/${r.expected}` : ''}`).join('、')}${stopping ? '｜已中止' : ''}`);
    return stopping ? 2 : 0;
  } finally { reqlog.flush?.(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().then(c => process.exit(c), e => { console.error(String(e?.message || e)); process.exit(1); });
