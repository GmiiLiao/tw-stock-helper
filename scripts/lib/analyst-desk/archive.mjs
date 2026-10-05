// ─────────────────────────────────────────────────────────────────────────────
// 分析師團隊：第二大腦存檔（契約 §6／規格 04 §1.4；慣例照抄 scripts/daily-heatmap.mjs 的 writeOnce）
//   second-brain/daily-analyst/
//     {D}.{edition}.json.gz / .pack.json.gz / .transcript.jsonl.gz   定版 issue／資料包／各輪稿（稽核用）
//     reports/{D}.{edition}.md   人讀 Markdown（由 issue 的 text 欄位渲染；頁尾附免責）
//     _manifest.json   rows["{D}.{edition}"]：status／file／sha256／bytes／canonicalAt／engineTier／packSha256／check／degraded…
//     latest.json      { dataDate, edition, canonicalAt }：morning 定版優先於 evening；舊資料日不蓋新的
//     _pending/{D}.{edition}.json   資料未到齊或 AI 版未成的原因；_alerts/LATEST.json   過死線仍未定版
//   規則：寫一次（tmp＋rename、.lock 用 wx、已存在不覆寫）；--force 舊檔改名 .r{n}（已過下一交易日 08:30 則只寫 .amend-{n}）；
//        非交易日不產檔；時間戳只放 manifest（檔本體不含 generatedAt／canonicalAt）。
//   root＝second-brain 根目錄（與 daily-heatmap 的 --root 同義）；本模組只讀寫 root/daily-analyst，不碰其他目錄。
//   純檔案 IO；不連網、不 import 任何 daemon／計分模組。
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { EDITIONS, SCHEMA_VERSION, isIsoDate, DISCLAIMER } from './constants.mjs';

export const ARCHIVE_DIRNAME = 'daily-analyst';
const TZ_MS = 8 * 3600e3;
const LOCK_STALE_MS = 30 * 60e3;   // 寫檔只需數秒；超過 30 分鐘的 .lock 視為上一個程序當掉遺留
/** 時間戳只放 manifest／meta：寫進檔本體前從 issue.meta 剝除（保持同輸入同輸出）。 */
const BODY_STRIP_META = ['generatedAt', 'canonicalAt'];

export const archiveDir = root => join(root, ARCHIVE_DIRNAME);
export const rowKey = (day, edition) => `${day}.${edition}`;
const sha = buf => createHash('sha256').update(buf).digest('hex');
const writeAtomic = (file, buf) => { const t = `${file}.tmp${process.pid}`; writeFileSync(t, buf); renameSync(t, file); };
const writeJson = (file, o) => writeAtomic(file, JSON.stringify(o, null, 1));
const readJson = (file, dflt = null) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return dflt; } };

export const fileNames = (key, suffix = '') => ({
  issue: `${key}${suffix}.json.gz`,
  pack: `${key}${suffix}.pack.json.gz`,
  transcript: `${key}${suffix}.transcript.jsonl.gz`,
  report: `${key}${suffix}.md`,
});

// ── 讀取 ─────────────────────────────────────────────────────────────────────
export const readManifest = root => readJson(join(archiveDir(root), '_manifest.json'), { rows: {} }) || { rows: {} };
export const readLatest = root => readJson(join(archiveDir(root), 'latest.json'), null);
export function readIssue(root, key) {
  const row = readManifest(root).rows?.[key];
  if (!row?.file) return null;
  const f = join(archiveDir(root), row.file);
  return existsSync(f) ? JSON.parse(gunzipSync(readFileSync(f)).toString('utf8')) : null;
}

// ── 時間 ─────────────────────────────────────────────────────────────────────
/** 下一交易日 08:30（台北）的 epoch ms。nextDay 缺時退化為下一個平日（與 daily-heatmap.mjs 同做法；休市日曆無法由本機得知）。 */
export function deadlineMs(dataDate, nextDay = null) {
  if (isIsoDate(nextDay) && nextDay > dataDate) return new Date(`${nextDay}T00:00:00+08:00`).getTime() + 8.5 * 3600e3;
  let t = new Date(`${dataDate}T00:00:00+08:00`).getTime();
  do { t += 86400e3; } while ([0, 6].includes(new Date(t + TZ_MS).getUTCDay()));
  return t + 8.5 * 3600e3;
}

/** 非交易日判斷：有交易日清單就查清單；沒有就退化為「週一～五」（只擋週末，已知不涵蓋休市日——呼叫端應盡量提供清單）。 */
export function isTradingDay(dataDate, tradingDays = null) {
  if (Array.isArray(tradingDays) && tradingDays.length) return tradingDays.includes(dataDate);
  const wd = new Date(`${dataDate}T00:00:00Z`).getUTCDay();
  return wd !== 0 && wd !== 6;
}

// ── Markdown（人讀；由 issue 的 text 欄位渲染）──────────────────────────────────
const claimLine = c => `- ${c.text}${c.tier && c.tier !== '官方' ? `（${c.tier}）` : ''}`;
function focusMd(card) {
  const f = card.focus || {};
  const lines = [`### 資料觀察名單（${f.kind === 'watch' ? '明日觀察' : '回顧'}；池 ${f.poolSize ?? 0} 檔、排除 ${f.excludedCount ?? 0} 檔、列示 ${(f.stocks || []).length} 檔）`];
  if (f.note) lines.push(`> ${f.note}`);
  for (const s of f.stocks || []) {
    lines.push(`- **${s.code} ${s.name || ''}**（${s.market || ''}／${s.industry || ''}）：${s.thesis || ''}`);
    for (const w of s.watchConditions || []) lines.push(`  - 觀察條件：${w.text}`);
    for (const r of s.risks || []) lines.push(`  - 風險：${r.text}`);
  }
  return lines.join('\n');
}

export function renderIssueMarkdown(issue) {
  const m = issue.meta || {};
  const out = [`# AI 分析師團隊報告｜資料日 ${issue.dataDate}（${issue.edition === 'morning' ? '晨間定版' : '盤後版'}）`, ''];
  out.push(`> 引擎層級：${m.engineTier || '—'}｜機械查核：${m.check?.pass ? '通過' : '未過'}｜降級：${(m.degraded || []).join('、') || '無'}`, '');
  const s = issue.summary || {};
  if (s.headline) out.push(`## ${s.headline}`, '');
  for (const [title, list] of [['重點', s.points], ['明日關注', s.nextFocus], ['風險', s.risks]]) {
    if (list?.length) out.push(`### ${title}`, ...list.map(claimLine), '');
  }
  for (const card of issue.cards || []) {
    out.push(`## ${card.title}`, '');
    for (const sec of card.sections || []) out.push(`### ${sec.title}`, ...(sec.claims || []).map(claimLine), '');
    if (card.focus) out.push(focusMd(card), '');
    out.push(`> ${issue.useRules?.disclaimerShort || ''}`, '');
  }
  if (issue.linkages?.length) out.push('## 跨領域連動（站內整理）', ...issue.linkages.map(l => `- ${l.text}（${l.mechanism}）`), '');
  out.push('---', issue.useRules?.disclaimer || DISCLAIMER, '');
  return out.join('\n');
}

// ── 檔內容（確定性）──────────────────────────────────────────────────────────
function bodyOf(issue) {
  if (!issue.meta) return issue;
  const meta = { ...issue.meta };
  for (const k of BODY_STRIP_META) delete meta[k];
  return { ...issue, meta };
}
const gz = s => gzipSync(Buffer.from(s), { level: 9 });
const transcriptText = tr => (Array.isArray(tr) && tr.length ? tr.map(x => JSON.stringify(x)).join('\n') + '\n' : '');

function manifestRow({ file, issueGz, issue, packSha, packFile, transcriptFile, reportFile, now, lateBuilt, forced, pack }) {
  const c = issue.meta?.check || {};
  return {
    status: 'final', file, sha256: sha(issueGz), bytes: issueGz.length, schemaVersion: issue.schema ?? SCHEMA_VERSION,
    canonicalAt: new Date(now).toISOString(), lateBuilt, canonicalForced: forced,
    edition: issue.edition, engineTier: issue.meta?.engineTier ?? null, packSha256: packSha, packFile, transcriptFile, reportFile,
    // 查核摘要：刪句數用 cut（不用含 action 字樣的鍵名，以免觸發欄位命名契約）
    check: { pass: !!c.pass, blockers: c.blockers ?? 0, cut: Array.isArray(c.redactions) ? c.redactions.length : 0, warnings: Array.isArray(c.warnings) ? c.warnings.length : 0, repairRounds: c.repairRounds ?? 0 },
    degraded: [...(issue.meta?.degraded || [])],
    inputs: pack?.meta?.inputs ?? {},
  };
}

function acquireLock(dir, now) {
  const lock = join(dir, '.lock');
  try { return { fd: openSync(lock, 'wx'), lock }; } catch {
    try { if (now - statSync(lock).mtimeMs > LOCK_STALE_MS) { unlinkSync(lock); return { fd: openSync(lock, 'wx'), lock }; } } catch { /* 競爭中，視為被占用 */ }
    return null;
  }
}

/** 同日 morning 優先於 evening；舊資料日不蓋新的。 */
export function shouldUpdateLatest(cur, day, edition) {
  if (!cur) return true;
  if (cur.dataDate < day) return true;
  if (cur.dataDate > day) return false;
  return !(cur.edition === 'morning' && edition === 'evening');
}

/**
 * 寫一份定版。回傳 { status, key, file?, row?, latestUpdated?, reason? }
 *   status：written｜written-forced｜written-amend｜skip-exists｜skip-non-trading｜refused｜locked
 * 拒絕（refused）：issue 為模板殼（meta.fallback／engineTier = template）、查核未過、資料日／版次與 issue 不符——「AI 版定版檔」不得由殘稿或模板冒充。
 */
export function writeIssue({ root, issue, pack, transcript, edition, dataDate, now = Date.now(), force = false, tradingDays = null }) {
  const key = rowKey(dataDate, edition);
  if (!EDITIONS.includes(edition)) throw new Error(`writeIssue: 未知版次 ${edition}`);
  if (!isIsoDate(dataDate)) throw new Error(`writeIssue: 資料日格式錯誤 ${dataDate}`);
  if (!issue || issue.dataDate !== dataDate || issue.edition !== edition) return { status: 'refused', key, reason: `issue 的資料日／版次（${issue?.dataDate}/${issue?.edition}）與 ${key} 不符` };
  if (issue.meta?.fallback === 'template' || issue.meta?.engineTier === 'template') return { status: 'refused', key, reason: '模板殼不寫 AI 版定版檔' };
  if (!issue.meta?.check?.pass) return { status: 'refused', key, reason: '機械查核未過，不定版' };
  const days = tradingDays || pack?.calendar?.tradingDays || null;
  if (!isTradingDay(dataDate, days)) return { status: 'skip-non-trading', key, reason: `${dataDate} 非交易日，不產檔` };

  const dir = archiveDir(root);
  mkdirSync(join(dir, 'reports'), { recursive: true });
  const lk = acquireLock(dir, now);
  if (!lk) return { status: 'locked', key, reason: '另一個程序正在寫入（.lock）' };
  try {
    const man = readManifest(root);
    const f = fileNames(key);
    const exists = !!man.rows?.[key] || existsSync(join(dir, f.issue));
    if (exists && !force) return { status: 'skip-exists', key, file: f.issue };

    const next = pack?.dates?.next ?? pack?.calendar?.nextTradingDay ?? null;
    const lateBuilt = now > deadlineMs(dataDate, next);
    const issueGz = gz(JSON.stringify(bodyOf(issue)));
    const packText = JSON.stringify(pack ?? null);
    const packGz = gz(packText);
    const trGz = gz(transcriptText(transcript));
    const md = Buffer.from(renderIssueMarkdown(issue));
    const packSha = issue.meta?.pack?.sha256 || sha(Buffer.from(packText));

    let suffix = '', status = 'written', forced = false, amendN = 0;
    if (exists && force) {
      if (lateBuilt) {                          // 開盤後修補：只另存 .amend-{n}，不取代原檔、不動 manifest 主列與 latest
        amendN = (man.rows[key]?.amends?.length || 0) + 1;
        suffix = `.amend-${amendN}`; status = 'written-amend';
      } else {                                  // 開盤前修補：舊檔改名 .r{n}
        let k = 1; while (existsSync(join(dir, `${key}.r${k}.json.gz`))) k++;
        const old = fileNames(key, `.r${k}`);
        for (const part of ['issue', 'pack', 'transcript']) if (existsSync(join(dir, f[part])) ) renameSync(join(dir, f[part]), join(dir, old[part]));
        if (existsSync(join(dir, 'reports', f.report))) renameSync(join(dir, 'reports', f.report), join(dir, 'reports', old.report));
        forced = true; status = 'written-forced';
        man.rows[key] = { ...man.rows[key], revisions: [...(man.rows[key]?.revisions || []), { n: k, file: old.issue, sha256: man.rows[key]?.sha256 ?? null, canonicalAt: man.rows[key]?.canonicalAt ?? null }] };
      }
    }
    const t = fileNames(key, suffix);
    writeAtomic(join(dir, t.pack), packGz);
    writeAtomic(join(dir, t.transcript), trGz);
    writeAtomic(join(dir, 'reports', t.report), md);
    writeAtomic(join(dir, t.issue), issueGz);

    const row = manifestRow({ file: t.issue, issueGz, issue, packSha, packFile: t.pack, transcriptFile: t.transcript, reportFile: `reports/${t.report}`, now, lateBuilt, forced, pack });
    let latestUpdated = false;
    if (status === 'written-amend') {
      man.rows[key] = { ...man.rows[key], amends: [...(man.rows[key].amends || []), { n: amendN, file: t.issue, sha256: row.sha256, bytes: row.bytes, canonicalAt: row.canonicalAt }] };
    } else {
      man.rows[key] = { ...row, ...(man.rows[key]?.revisions ? { revisions: man.rows[key].revisions } : {}) };
      const cur = readLatest(root);
      if (shouldUpdateLatest(cur, dataDate, edition)) { writeJson(join(dir, 'latest.json'), { dataDate, edition, canonicalAt: row.canonicalAt }); latestUpdated = true; }
    }
    writeJson(join(dir, '_manifest.json'), man);
    clearResolved(root, dataDate, edition);
    return { status, key, file: t.issue, row: man.rows[key], latestUpdated };
  } finally { closeSync(lk.fd); try { unlinkSync(lk.lock); } catch { /* ignore */ } }
}

// ── pending／alert ───────────────────────────────────────────────────────────
const asReasons = r => (Array.isArray(r) ? r.map(String) : [String(r)]);

/** 資料未到齊、查核不過或 AI 版未成：寫 _pending/{D}.{edition}.json（覆寫同名；定版後由 writeIssue 清掉）。 */
export function writePending(root, day, edition, reason, now = Date.now()) {
  const d = join(archiveDir(root), '_pending');
  mkdirSync(d, { recursive: true });
  const file = join(d, `${rowKey(day, edition)}.json`);
  writeJson(file, { dataDate: day, edition, reasons: asReasons(reason), generatedAt: new Date(now).toISOString() });
  return file;
}

/**
 * _alerts/LATEST.json：過下一交易日 08:30 仍未定版才寫（盤前簡報應顯示「昨日分析未產出」）。
 * immediate:true＝呼叫端已確知「頁面將退回模板版」（例：引擎全降級到模板、晨間硬死線已到）時直接寫。
 * 回傳是否寫了。
 */
export function writeAlert(root, { day, edition, reasons, now = Date.now(), nextTradingDay = null, immediate = false }) {
  if (!immediate && now <= deadlineMs(day, nextTradingDay)) return false;
  const d = join(archiveDir(root), '_alerts');
  mkdirSync(d, { recursive: true });
  writeJson(join(d, 'LATEST.json'), {
    dataDate: day, edition, reasons: asReasons(reasons),
    note: '昨日 AI 分析師報告未產出；盤前簡報與頁面應顯示「昨日分析未產出」並退回模板版', generatedAt: new Date(now).toISOString(),
  });
  return true;
}

/** 定版後清掉同日 pending，並清掉針對該資料日（或更舊）的 alert。 */
export function clearResolved(root, day, edition) {
  const dir = archiveDir(root);
  try { unlinkSync(join(dir, '_pending', `${rowKey(day, edition)}.json`)); } catch { /* 不存在 */ }
  if (edition === 'morning') { try { unlinkSync(join(dir, '_pending', `${rowKey(day, 'evening')}.json`)); } catch { /* 不存在 */ } }
  const af = join(dir, '_alerts', 'LATEST.json');
  const a = readJson(af, null);
  if (a && a.dataDate <= day) { try { unlinkSync(af); } catch { /* ignore */ } }
}

/** 該資料日該版次是否已定版（含檔案真的在）。 */
export function isFinal(root, day, edition) {
  const row = readManifest(root).rows?.[rowKey(day, edition)];
  return !!row && row.status === 'final' && existsSync(join(archiveDir(root), row.file));
}
