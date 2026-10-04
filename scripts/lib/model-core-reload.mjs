// ─────────────────────────────────────────────────────────────────────────────
// model-core.json 熱重載與舊版保留（WM-SCAN G4-22·2026-10-04）
//
//   daemon 舊版只在開機讀一次 scripts/data/model-core.json；每月首個交易日 17:20 自動重建後，
//   到下次重啟前問AI「明日隔日沖預測」都還用舊版。改為：
//     ① 重建前把現行檔另存到 second-brain/model-core/（gitignore 區·不動受追蹤檔的讀者）
//        —— model-core.prev.json（最近一版）＋ model-core.<generatedAt 日>.json（帶日期·不覆寫）。
//     ② 重建成功 ∧ 新檔通過結構驗證 ⇒ 換上記憶體版本；
//        任何一步失敗 ⇒ 記憶體保留舊版，並把檔案還原成舊版（讓 audit-weights／leaders-report／
//        action-report 等直接讀檔的腳本與 daemon 記憶體一致）。
//   model-core.json 的位置不變：scripts/audit-weights.mjs、leaders-report.mjs、action-report.mjs
//   都以固定路徑讀它，搬家會讓它們讀不到。
//   這裡是純函式＋注入 fs；時鐘、execScript、log 在 ai-daemon.mjs。
// ─────────────────────────────────────────────────────────────────────────────

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** 龍頭名單最少檔數——現行 65 檔（產業×前2）；遠低於此代表 build-leaders 產出殘缺 */
export const MIN_LEADERS = 20;

/**
 * 驗證 model-core 結構——只驗 daemon buildPredictSkill 真正讀的欄位。
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateModelCore(core) {
  if (!isObj(core)) return { ok: false, reason: '不是物件' };
  if (!(typeof core.version === 'string' ? core.version.trim() : isNum(core.version))) return { ok: false, reason: '缺 version' };
  if (!isNum(core.costPct) || core.costPct <= 0 || core.costPct > 5) return { ok: false, reason: `costPct 不合理：${core.costPct}` };
  if (!isObj(core.tierBase) || !isNum(core.tierBase.neutral)) return { ok: false, reason: 'tierBase.neutral 缺' };
  for (const [k, v] of Object.entries(core.tierBase)) if (!isNum(v)) return { ok: false, reason: `tierBase.${k} 非數字` };
  if (!isObj(core.adds)) return { ok: false, reason: '缺 adds' };
  for (const k of ['brkStrong', 'brk', 'sqz', 'strongAlone', 'weak', 'bag', 'dist30']) {
    if (!isObj(core.adds[k]) || !isNum(core.adds[k].w)) return { ok: false, reason: `adds.${k}.w 缺` };
  }
  const th = core.thresholds;
  if (!isObj(th)) return { ok: false, reason: '缺 thresholds' };
  for (const k of ['bullish', 'neutral', 'avoid']) {
    if (!isObj(th[k]) || !isNum(th[k].min)) return { ok: false, reason: `thresholds.${k}.min 缺` };
  }
  if (!(th.bullish.min > th.neutral.min && th.neutral.min >= th.avoid.min)) return { ok: false, reason: 'thresholds 不單調' };
  if (!Array.isArray(core.leaders) || core.leaders.length < MIN_LEADERS) return { ok: false, reason: `leaders 只有 ${core.leaders?.length ?? 0} 檔` };
  if (!core.leaders.every((c) => typeof c === 'string' && /^[0-9A-Z]{4,6}$/.test(c))) return { ok: false, reason: 'leaders 含非代號' };
  return { ok: true };
}

/**
 * 讀檔＋解析＋驗證。永不丟例外。
 * @param {{ readFileSync: Function }} fs
 * @returns {{ ok: true, core: object, raw: string } | { ok: false, reason: string }}
 */
export function readModelCore(fs, path) {
  let raw;
  try { raw = fs.readFileSync(path, 'utf8'); } catch (e) { return { ok: false, reason: `讀檔失敗：${e.code || e.message}` }; }
  let core;
  try { core = JSON.parse(raw); } catch (e) { return { ok: false, reason: `JSON 解析失敗：${String(e.message).slice(0, 60)}` }; }
  const v = validateModelCore(core);
  return v.ok ? { ok: true, core, raw } : { ok: false, reason: v.reason };
}

/** 帶日期備份檔名：取 generatedAt 的日期（YYYY-MM-DD），沒有就用 fallbackDay */
export function datedBackupName(core, fallbackDay) {
  const d = typeof core?.generatedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(core.generatedAt) ? core.generatedAt.slice(0, 10) : fallbackDay;
  return `model-core.${d}.json`;
}

/**
 * 重建前備份現行檔（必須是驗證過的有效版）。帶日期那份已存在就不覆寫。
 * @param {{ readFileSync, writeFileSync, mkdirSync, existsSync }} fs
 * @param {{ src: string, dir: string, today: string, join: Function }} p
 * @returns {{ ok: true, raw: string, prevPath: string, datedPath: string } | { ok: false, reason: string }}
 */
export function backupModelCore(fs, { src, dir, today, join }) {
  const cur = readModelCore(fs, src);
  if (!cur.ok) return { ok: false, reason: `現行檔無效，不備份：${cur.reason}` };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const prevPath = join(dir, 'model-core.prev.json');
    const datedPath = join(dir, datedBackupName(cur.core, today));
    fs.writeFileSync(prevPath, cur.raw);
    if (!fs.existsSync(datedPath)) fs.writeFileSync(datedPath, cur.raw);
    return { ok: true, raw: cur.raw, prevPath, datedPath };
  } catch (e) {
    return { ok: false, reason: `備份寫入失敗：${e.code || e.message}` };
  }
}

/**
 * 重建後決定：換新版或保留舊版（並還原檔案）。
 * @param {{ readFileSync, writeFileSync }} fs
 * @param {{ src: string, buildOk: boolean, backupRaw: string|null, current: object|null }} p
 * @returns {{ action: 'swap', core: object } | { action: 'keep', core: object|null, reason: string, restored: boolean }}
 */
export function decideModelCoreReload(fs, { src, buildOk, backupRaw, current }) {
  const next = buildOk ? readModelCore(fs, src) : { ok: false, reason: '重建腳本失敗' };
  if (next.ok) return { action: 'swap', core: next.core };
  let restored = false;
  if (backupRaw) {
    try { fs.writeFileSync(src, backupRaw); restored = true; } catch { restored = false; }
  }
  return { action: 'keep', core: current, reason: next.reason, restored };
}
