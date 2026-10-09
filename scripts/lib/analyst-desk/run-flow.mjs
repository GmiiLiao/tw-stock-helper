// ─────────────────────────────────────────────────────────────────────────────
// 分析師團隊：排程入口的流程邏輯（scripts/analyst-desk-run.mjs 的核心；全部相依以參數注入，測試不碰網路／Firestore／模型）
//   兩階段：evening（盤後版，23:20 起、硬死線 00:30）與 morning（晨間定版，06:10 起、硬死線 07:30）。
//   看資料不看時鐘：本機可驗的閘門（P1 熱力定版、P2 前日熱力、P3 收盤＋法人備份）在此；P4–P8（公告／媒體／全球夜盤／日曆／風險旗標）由 pack.mjs 的
//   buildPack 自己驗，硬失敗（丟錯）→ 寫 _pending 並等下一輪。pack.mjs 若匯出 gates 函式，一併採用。
//   不與 ai-daemon 搶任何鎖、不改 daemon、不重啟任何東西；對上游 0 請求（引擎 claude-cli 走使用者已登入帳號，不碰 Ollama）。
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { isFinal, rowKey, writeIssue, writePending, writeAlert } from './archive.mjs';
import { archiveDayStatus } from '../canonical-gate.mjs';

export const POLL_MS = 10 * 60e3;
/** 起跑／硬死線（台北分鐘數；evening 的死線跨午夜）。 */
export const WINDOWS = Object.freeze({
  evening: { startMin: 23 * 60 + 20, deadlineMin: 30, label: '23:20 起、硬死線 00:30' },
  morning: { startMin: 6 * 60 + 10, deadlineMin: 7 * 60 + 30, label: '06:10 起、硬死線 07:30' },
});
const TZ_MS = 8 * 3600e3;
const readJson = f => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

// ── 台北時間／日期 ───────────────────────────────────────────────────────────
export const taipeiParts = ms => { const d = new Date(ms + TZ_MS); return { iso: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() }; };
export const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dowOf = iso => new Date(`${iso}T00:00:00Z`).getUTCDay();

/** 是否已過該版次的硬死線（evening：00:30 後到中午前；morning：07:30 後到傍晚前）。起跑前（白天手動跑）不算過。 */
export function pastDeadline(edition, nowMs) {
  const m = taipeiParts(nowMs).min;
  if (edition === 'evening') return m > WINDOWS.evening.deadlineMin && m < 12 * 60;
  return m >= WINDOWS.morning.deadlineMin && m < 18 * 60;
}

// ── 休市日曆（本機鏡像的證交所休市表；只含表訂休市，臨時休市靠交易日清單）──────────
const TRADING_MARK_RE = /開始交易|最後交易/;
const rocToIso = roc => (/^\d{7}$/.test(String(roc || '')) ? `${+String(roc).slice(0, 3) + 1911}-${String(roc).slice(3, 5)}-${String(roc).slice(5, 7)}` : null);

/** 讀鏡像最新一份 holidaySchedule → Set<休市日>；讀不到回 null（呼叫端退化為只擋週末）。 */
export function readHolidays(root) {
  const dir = join(root, 'official', 'openapi.twse.com.tw', 'twse_oa_holidaySchedule_holidaySchedule');
  const man = readJson(join(dir, '_manifest.json'));
  const file = man?.lastFile && join(dir, man.lastFile);
  if (!file || !existsSync(file)) return null;
  try {
    const rows = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')).payload;
    const set = new Set();
    for (const r of Array.isArray(rows) ? rows : []) { const iso = rocToIso(r?.Date); if (iso && !TRADING_MARK_RE.test(String(r.Name || ''))) set.add(iso); }
    return set;
  } catch { return null; }
}

/** 上市 MI_INDEX 鏡像 status=ok 的日期（升冪）＝已發生的交易日清單。 */
export function readTradingDays(root) {
  const man = readJson(join(root, 'official', 'www.twse.com.tw', 'twse_mi_index', '_manifest.json'));
  return Object.keys(man?.rows || {}).filter(d => man.rows[d]?.status === 'ok').sort();
}

const isExpectedTradingDay = (iso, holidays) => dowOf(iso) !== 0 && dowOf(iso) !== 6 && !(holidays && holidays.has(iso));
/** 小於 iso 的最近一個「預期交易日」（平日且不在表訂休市）。 */
export function expectedPrevTradingDay(iso, holidays) {
  let d = iso;
  for (let i = 0; i < 31; i++) { d = addDays(d, -1); if (isExpectedTradingDay(d, holidays)) return d; }
  return null;
}
/** 大於 iso 的最近一個預期交易日。 */
export function expectedNextTradingDay(iso, holidays) {
  let d = iso;
  for (let i = 0; i < 31; i++) { d = addDays(d, 1); if (isExpectedTradingDay(d, holidays)) return d; }
  return null;
}

/**
 * 這個版次此刻該處理哪個資料日。
 *   evening：台北「場次日」（12:00 後＝今天、之前＝昨天）；是交易日才跑。
 *   morning：今天之前的最後一個交易日（晨間定版接在該日的盤後版之後）。
 * 回傳 { state:'ok'|'non-trading'|'waiting-mirror', day, reason }
 *   waiting-mirror＝預期該日是交易日、但鏡像交易日清單還沒有它（鏡像延遲）→ 等下一輪，不算休市。
 */
export function resolveSession({ edition, nowMs, tradingDays, holidays }) {
  const t = taipeiParts(nowMs);
  if (edition === 'evening') {
    const s = t.min >= 12 * 60 ? t.iso : addDays(t.iso, -1);
    if (tradingDays.includes(s)) return { state: 'ok', day: s };
    if (isExpectedTradingDay(s, holidays)) return { state: 'waiting-mirror', day: s, reason: `預期 ${s} 為交易日，但官方鏡像尚無該日（等鏡像）` };
    return { state: 'non-trading', day: s, reason: `${s} 非交易日，不產檔` };
  }
  const exp = expectedPrevTradingDay(t.iso, holidays);
  const last = [...tradingDays].filter(d => d < t.iso).pop() || null;
  if (!last) return { state: 'non-trading', day: null, reason: '鏡像無任何交易日' };
  if (exp && exp > last) return { state: 'waiting-mirror', day: exp, reason: `預期最後交易日 ${exp}，但官方鏡像只到 ${last}（等鏡像）` };
  return { state: 'ok', day: last };
}

// ── 本機可驗的閘門（P1–P3；硬閘門不過＝不組包）──────────────────────────────────
/** 前一交易日（清單內 < day 的最後一天）。 */
export const prevTradingDate = (tradingDays, day) => [...tradingDays].filter(d => d < day).pop() || null;

/**
 * pinned＝呼叫端指定了資料日（--date／ctx.day 補跑舊日）：latest.json 只指向最新一日，回補的舊日永遠對不上 ⇒
 * 改只看 _manifest.json 的 rows[day].status==='final'＋定版檔存在（2026-10-09 全站掃描第 2 項）。不指定日期時行為不變。
 */
export function evaluateRunGates({ root, day, tradingDays, holidays, pinned = false }) {
  const hard = [], soft = [];
  const hm = join(root, 'daily-heatmap');
  const latest = pinned ? null : readJson(join(hm, 'latest.json'));
  const row = readJson(join(hm, '_manifest.json'))?.rows?.[day];
  if (!pinned && (!latest || latest.dataDate !== day)) hard.push(`P1 熱力尚未定版：latest.dataDate=${latest?.dataDate ?? '無'} ≠ ${day}`);
  else if (!row || row.status !== 'final') hard.push(`P1 熱力 manifest ${day} 非 final`);
  else if (!existsSync(join(hm, row.file))) hard.push(`P1 熱力定版檔不存在：${row.file}`);
  const prev = prevTradingDate(tradingDays, day);
  if (!prev) soft.push('P2 找不到前一交易日（prev 卡降為來源未提供）');
  else if (!existsSync(join(hm, `${prev}.json.gz`))) soft.push(`P2 前一交易日熱力不存在：${prev}（prev 卡降為來源未提供）`);
  const chipF = join(root, 'backup', 'chipArchive', `${day}.json`);
  const chip = readJson(chipF);
  if (!chip) soft.push('P3 本機 chipArchive 備份尚無該日（雲端歸檔由 pack 自行驗證）');
  else { const st = archiveDayStatus(chip); if (!st.ready) soft.push(`P3 收盤／法人未到齊：${st.missing.join('、')}`); }
  if (!holidays) soft.push('P7 本機休市表缺：下一交易日以平日近似');
  return { pass: hard.length === 0, hard, soft };
}

// ── 單次嘗試 ─────────────────────────────────────────────────────────────────
/**
 * runOnce(ctx) → { status, day?, reasons? }
 *   status：non-trading｜waiting-mirror｜already-final（含補發佈）｜pending｜ollama-deferred（非終端，稍後重試）｜template-fallback｜refused｜locked｜final（本次定版並已發佈）｜final-unpublished（已定版但發佈失敗，下輪重試）
 * ctx：{ root, edition, nowMs, force?, log?, deps:{ loadPack({date,edition}), produce(opts), publish({root,day,edition}) → boolean, packGates?(…) } }
 *   終端狀態（terminal）見 isTerminal。
 */
export async function runOnce(ctx) {
  const { root, edition, nowMs = Date.now(), force = false, deps, log = () => {} } = ctx;
  const tradingDays = ctx.tradingDays || readTradingDays(root);
  const holidays = ctx.holidays !== undefined ? ctx.holidays : readHolidays(root);
  const ses = ctx.day ? { state: tradingDays.includes(ctx.day) ? 'ok' : 'non-trading', day: ctx.day, reason: `${ctx.day} 非交易日（鏡像無該日）` } : resolveSession({ edition, nowMs, tradingDays, holidays });
  if (ses.state === 'non-trading') { log(`非交易日：${ses.reason}`); return { status: 'non-trading', day: ses.day, reasons: [ses.reason] }; }
  if (ses.state === 'waiting-mirror') { log(`等鏡像：${ses.reason}`); return { status: 'waiting-mirror', day: ses.day, reasons: [ses.reason] }; }
  const day = ses.day;

  if (isFinal(root, day, edition) && !force) {                      // 已定版：不重產；只補發佈（publish 本身對同一份定版是 skip-same）
    const ok = await deps.publish({ root, day, edition });
    log(`${rowKey(day, edition)} 已定版${ok ? '（發佈已確認）' : '（發佈失敗，下輪重試）'}`);
    return { status: ok ? 'already-final' : 'final-unpublished', day };
  }

  const gates = evaluateRunGates({ root, day, tradingDays, holidays, pinned: !!ctx.day });
  let extraHard = [];
  if (deps.packGates) { try { const g = await deps.packGates({ date: day, edition, root, nowMs }); if (g && g.pass === false) extraHard = (g.hard || []).map(String); } catch (e) { extraHard = [`pack 閘門檢查失敗：${e.message}`]; } }
  const hard = [...gates.hard, ...extraHard];
  if (hard.length) { writePending(root, day, edition, hard, nowMs); log(`硬閘門未過：${hard.join('；')}`); return { status: 'pending', day, reasons: hard }; }

  let pack;
  try { pack = await deps.loadPack({ date: day, edition, nowMs }); }
  catch (e) { const r = [`組包失敗：${e.message}`]; writePending(root, day, edition, r, nowMs); log(r[0]); return { status: 'pending', day, reasons: r }; }
  if (!pack || pack.dataDate !== day) { const r = [`資料包資料日（${pack?.dataDate ?? '無'}）≠ ${day}`]; writePending(root, day, edition, r, nowMs); return { status: 'pending', day, reasons: r }; }

  // evening 的卡片標題標籤以資料日為「當日」（輪詢跨午夜時標籤不漂移）；morning 以台北今天
  const todayISO = edition === 'evening' ? day : taipeiParts(nowMs).iso;
  const r = await deps.produce({ pack, engines: ['claude-cli', 'ollama'], todayISO, log: e => { if (e.label && !e.raw) log(`  · ${e.label}${e.error ? ' ✖ ' + e.error : ''}`); } });
  if (r.engineUsed === 'template' || r.issue?.meta?.fallback === 'template') {
    // 使用者裁定（2026-10-05）：Claude 被降級（未登入）而 Ollama 只是因 daemon 佔用讓路時，Ollama 補稿可以延後——
    //   不當成最終失敗、不寫 alert，輪詢窗內稍後再試（claude-cli 401 是秒退、重試不花錢；查核未過等其他失敗不在此列）。
    const claudeAuth = (r.errors || []).some(e => e.engine === 'claude-cli' && e.auth);
    const ollamaBusy = (r.errors || []).some(e => e.engine === 'ollama' && /忙碌|讓路/.test(String(e.error)));
    if (claudeAuth && ollamaBusy) {
      const reasons = ['Claude 未登入，Ollama 因 daemon 佔用延後補稿，稍後重試'];
      writePending(root, day, edition, reasons, nowMs);
      log(reasons[0]);
      return { status: 'ollama-deferred', day, reasons };
    }
    const reasons = ['AI 版未成（引擎全數降級到模板）：' + (r.errors || []).map(e => `${e.engine}:${e.error}`).join('；')];
    writePending(root, day, edition, reasons, nowMs);
    writeAlert(root, { day, edition, reasons, now: nowMs, nextTradingDay: pack.dates?.next ?? null, immediate: true });
    log(reasons[0]);
    return { status: 'template-fallback', day, reasons };
  }
  const w = writeIssue({ root, issue: r.issue, pack, transcript: r.transcript, edition, dataDate: day, now: nowMs, force, tradingDays: pack.calendar?.tradingDays?.length ? pack.calendar.tradingDays : tradingDays });
  if (w.status === 'refused') { writePending(root, day, edition, [w.reason], nowMs); log(`拒絕定版：${w.reason}`); return { status: 'refused', day, reasons: [w.reason] }; }
  if (w.status === 'locked') return { status: 'locked', day, reasons: [w.reason] };
  if (w.status === 'skip-non-trading') return { status: 'non-trading', day, reasons: [w.reason] };
  log(`✓ ${rowKey(day, edition)} 定版（${w.status}）`);
  const ok = await deps.publish({ root, day, edition });
  return { status: ok ? 'final' : 'final-unpublished', day };
}

/** 這一輪之後是否不用再輪詢。pending／waiting-mirror／locked／final-unpublished 會在下一輪重試。 */
export const isTerminal = status => ['non-trading', 'already-final', 'final', 'template-fallback', 'refused'].includes(status);

/**
 * 輪詢：到定版或死線為止。到死線仍無定版：morning 寫 alert（頁面退回模板版）；evening 只留 pending（晨間版會接手）。
 * sleep／now 可注入（測試）。回傳最後一次 runOnce 的結果。
 */
export async function pollLoop({ edition, root, deps, now = () => Date.now(), sleep, once = false, log = () => {}, ...rest }) {
  let last;
  for (;;) {
    last = await runOnce({ root, edition, nowMs: now(), deps, log, ...rest });
    if (isTerminal(last.status) || once) return last;
    if (pastDeadline(edition, now())) {
      log(`已過硬死線（${WINDOWS[edition].label}）仍未定版`);
      if (edition === 'morning' && last.day) writeAlert(root, { day: last.day, edition, reasons: last.reasons || ['晨間版硬死線前未定版'], now: now(), immediate: true });
      return last;
    }
    await sleep(POLL_MS);
  }
}

