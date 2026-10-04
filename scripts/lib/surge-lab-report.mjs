// ── 起漲研究後台：官方化重訓驗證／鏡像健康／影子管線狀態 → surgeShadow/lab-* 文件（純函式，不碰 I/O）──
// 研究端輸出（scripts/surge-lab/out/official_cv_*、second-brain/official/*）由 scripts/surge-lab/surge_lab_publish.mjs 讀檔後交給這裡整理；
// API（src/app/api/admin/surge-shadow?view=cvrows）也用這裡的查詢函式做伺服器端篩選與分頁。
//   · lastTradingDay：資料日一律由資料決定（研究面板日期＋鏡像 MI_INDEX 已確認日），不看日曆——非交易日發佈也記最後交易日。
//   · planCvTask：一個任務（t1L／t2L／lu1L）× 版本（修正前快照／目前 out/）→ 摘要＋逐列資料；修正前後的數字絕不混用：
//       目前版與修正前逐位相同 ⇒ 標 sameAs（不重複發佈）；穩健度檔與本版 CV 對不上 ⇒ 不採用；逐列 CSV 筆數對不上 ⇒ 不發佈該模型逐列。
//   · buildMirrorDoc：鏡像 manifest／驗證／警示／鎖／請求額度 → 健康摘要（日資料落後最後交易日者標記）。
//   · buildPipelineDoc：每日影子協調器的狀態檔原樣帶上（沒有就 null＋說明，不捏造）。
// 研究數字未扣成本、非投資建議。欄位命名避開未登記的 xxxAt／xxxDate（scripts/check-field-conventions.mjs）。

export const CV_SCHEMA = 'surgeShadow.cv.v1';
export const CVROWS_SCHEMA = 'surgeShadow.cvrows.v1';
export const MIRROR_SCHEMA = 'surgeShadow.mirror.v1';
export const PIPELINE_SCHEMA = 'surgeShadow.pipeline.v1';
export const LAB_DOC_IDS = { cv: 'lab-cv', mirror: 'lab-mirror', pipeline: 'lab-pipeline' };
export const MAX_DOC_BYTES = 900_000;          // Firestore 單文件 1 MiB；超過就中止（改分片前不寫）
export const ROWS_PAGE_SIZE = 200;
export const LU_MISS_RANK_MAX = 100;           // lu1L 漏網 13k 列 gzip ≈1MB 超出單文件預算 ⇒ 後台只放名次 ≤100，全量留本機
export const ANALYSIS_MAX_CHARS = 40_000;
export const ALERTS_MAX = 500;
export const CV_TASKS = [
  { id: 't1L', label: 'T1 連 2 漲停起漲' },
  { id: 't2L', label: 'T2 5 日連漲 >35%' },
  { id: 'lu1L', label: 'LU1 隔日漲停' },
];
export const CV_VERSIONS = [
  { id: 'pre_fix', label: '修正前', dir: 'out/pre_fix_20261004', snapshot: '2026-10-04' },
  { id: 'current', label: '修正後', dir: 'out', snapshot: null },
];
export const CV_MODELS = ['base', 'official'];
export const CV_KINDS = ['hits', 'misses', 'outside'];
export const CVROWS_ID_RE = /^lab-cvrows-(t1L|t2L|lu1L)-(pre_fix|current)-(base|official|all)-(hits|misses|outside)$/;
export const ANALYSIS_SECTIONS = ['0', '6', '7', '8'];   // 重點摘要／漏網原因假設／負面結果／限制

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TEXT_COLS = new Set(['date', 'event_day', 'code', 'name', 'market', 'result', 'reason']);
const MODEL_KEYS = ['prec', 'auc', 'lift', 'hits', 'picks', 'nfeat', 'seeds'];
const META_KEYS = ['task', 'K', 'test_rows', 'positives', 'days', 'base_rate', 'protocol'];
const fin = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = v => (typeof v === 'string' ? v : null);
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const ci = v => (Array.isArray(v) && v.length === 2 && v.every(x => fin(x) !== null) ? [v[0], v[1]] : null);
const maxDay = xs => xs.filter(d => typeof d === 'string' && DAY_RE.test(d)).reduce((m, d) => (m === null || d > m ? d : m), null);

// ── 資料日 ───────────────────────────────────────────────────
/**
 * 最後交易日＝研究面板日期與鏡像 MI_INDEX（status=ok＝當天確實有收盤）兩者的最大值；兩邊都沒有 ⇒ null（呼叫端要中止，不可拿日曆日充數）。
 * 與 scripts/official-mirror.mjs dayInfo() 同一口徑：empty（休市）不算交易日。
 */
export function lastTradingDay({ panelDates = [], miIndexRows = {} } = {}) {
  const panelLast = maxDay(Array.isArray(panelDates) ? panelDates : []);
  const okKeys = Object.entries(isObj(miIndexRows) ? miIndexRows : {}).filter(([, r]) => r?.status === 'ok').map(([k]) => k);
  const mirrorLast = maxDay(okKeys);
  const date = maxDay([panelLast, mirrorLast].filter(Boolean));
  return { date, panelLast, mirrorLast };
}

/** ISO 時刻 → 台北「YYYY-MM-DD HH:MM」（版本標籤用；無效 ⇒ null）。 */
export function taipeiMinute(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  return new Date(t + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
}

// ── CSV ─────────────────────────────────────────────────────
/** RFC 4180 子集：雙引號欄位（含逗號、"" 跳脫）、CRLF、BOM。欄數不齊直接丟錯（格式漂移不可安靜吞掉）。 */
export function parseCsv(text) {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = []; let row = []; let f = ''; let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c !== '"') f += c;
      else if (s[i + 1] === '"') { f += '"'; i++; } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(f); lines.push(row); row = []; f = '';
    } else f += c;
  }
  if (f !== '' || row.length) { row.push(f); lines.push(row); }
  const body = lines.filter(r => !(r.length === 1 && r[0] === ''));
  if (!body.length) throw new Error('CSV 沒有表頭');
  const [cols, ...rows] = body;
  const bad = rows.findIndex(r => r.length !== cols.length);
  if (bad >= 0) throw new Error(`CSV 第 ${bad + 2} 列欄數 ${rows[bad].length} ≠ 表頭 ${cols.length}`);
  return { cols, rows };
}

/** 字串表 → 數值欄轉數字（空字串＝缺值 null；非數字直接丟錯）。 */
export function typedTable({ cols, rows }) {
  const numeric = cols.map(c => !TEXT_COLS.has(c));
  const out = rows.map((r, k) => r.map((v, i) => {
    if (!numeric[i]) return v;
    if (v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`第 ${k + 2} 列欄「${cols[i]}」不是數字：${v}`);
    return n;
  }));
  return { cols: [...cols], rows: out };
}

/** 後台逐列文件內容：lu1L 漏網只留名次 ≤100（全量留本機）。 */
export function rowsPayload(task, kind, table) {
  const typed = typedTable(table);
  const totalRows = typed.rows.length;
  if (task === 'lu1L' && kind === 'misses') {
    const ri = typed.cols.indexOf('rank');
    if (ri < 0) throw new Error('lu1L 漏網 CSV 缺 rank 欄');
    const rows = typed.rows.filter(r => typeof r[ri] === 'number' && r[ri] <= LU_MISS_RANK_MAX);
    return { cols: typed.cols, rows, totalRows, keptRows: rows.length, filterNote: `只發佈名次 ≤${LU_MISS_RANK_MAX}（全量 ${totalRows} 列留本機）` };
  }
  return { cols: typed.cols, rows: typed.rows, totalRows, keptRows: totalRows, filterNote: null };
}

/** sizes：[[文件 id, 位元組]]；任何一份 ≥ 上限就丟錯（整批不寫）。回傳最大的一份方便印出。 */
export function assertDocSizes(sizes, max = MAX_DOC_BYTES) {
  const big = sizes.filter(([, n]) => !(Number.isFinite(n) && n < max));
  if (big.length) throw new Error(`文件過大或大小不明（上限 ${max} 位元組，需改分片）：${big.map(([id, n]) => `${id} ${n}B`).join(', ')}`);
  return sizes.reduce((m, s) => (m === null || s[1] > m[1] ? s : m), null);
}

export function cvRowsDocId(task, version, model, kind) {
  const id = `lab-cvrows-${task}-${version}-${model}-${kind}`;
  if (!CVROWS_ID_RE.test(id)) throw new Error(`無效的逐列文件 id：${id}`);
  return id;
}

// ── CV 摘要 ──────────────────────────────────────────────────
function slimModel(m) {
  if (!isObj(m)) return null;
  const o = {};
  for (const k of MODEL_KEYS) o[k] = fin(m[k]);
  if (isObj(m.vs_base)) o.vs_base = { dprec: ci(m.vs_base.dprec), dauc: ci(m.vs_base.dauc) };
  return o;
}

function slimHitmiss(h) {
  if (!isObj(h)) return null;
  const pairs = o => Object.fromEntries(Object.entries(isObj(o) ? o : {}).map(([k, v]) => [k, ci(v)]));
  return {
    K: fin(h.K), n_hit: fin(h.n_hit), n_miss: fin(h.n_miss),
    feature_pct_mean: pairs(h.feature_pct_mean), source_has_value_rate: pairs(h.source_has_value_rate),
    miss_rank_bins: Object.fromEntries(Object.entries(isObj(h.miss_rank_bins) ? h.miss_rank_bins : {}).map(([k, v]) => [k, fin(v)])),
    by_market: pairs(h.by_market), legend: str(h._legend),
  };
}

/** 消融列：base／official／_meta 以外的每組；seeds=1 只能當參考（單種子雜訊大）。 */
export function ablationRows(cv) {
  return Object.entries(isObj(cv) ? cv : {})
    .filter(([k, v]) => !['base', 'official', '_meta'].includes(k) && isObj(v))
    .map(([key, v]) => ({ key, ...slimModel(v), referenceOnly: v.seeds === 1 }));
}

function slimMeta(meta) {
  if (!isObj(meta)) return null;
  const o = Object.fromEntries(META_KEYS.map(k => [k, typeof meta[k] === 'string' ? meta[k] : fin(meta[k])]));
  o.groups = Object.fromEntries(Object.entries(isObj(meta.groups) ? meta.groups : {}).map(([g, l]) => [g, Array.isArray(l) ? l.map(String) : []]));
  return o;
}

/**
 * 穩健度（半年分段、可買精確度、報酬）只在「與本版 CV 是同一次模型」時採用：overall 的 base／official 精確度（%）
 * 必須等於本版 cv 的 prec×100（兩位小數）。對不上＝穩健度是別次重訓的 ⇒ 不顯示（2026-10-04 審查：修正前後不可混放）。
 */
export function robustFor(robustAll, task, cv) {
  const r = isObj(robustAll) ? robustAll[task] : null;
  if (!isObj(r)) return { robust: null, note: '沒有這個任務的穩健度檔（需重跑 save_scores＋robust）' };
  const off = ['base', 'official'].map(m => {
    const want = fin(cv?.[m]?.prec); const got = fin(r.overall?.[m]);
    return want === null || got === null || Math.abs(Math.round(want * 10000) / 100 - got) > 0.011 ? `${m} ${got ?? '—'}% vs CV ${want === null ? '—' : (want * 100).toFixed(2)}%` : null;
  }).filter(Boolean);
  if (off.length) return { robust: null, note: `穩健度檔與本版 CV 不一致（${off.join('；')}），未採用——需對本版重跑 save_scores＋robust` };
  return { robust: r, note: null };
}

/** 從分析文件取前言（性質／口徑／沒有證明的事）＋指定節；過長在行邊界截斷並註明。 */
export function extractAnalysis(md, sections = ANALYSIS_SECTIONS, maxChars = ANALYSIS_MAX_CHARS) {
  const lines = String(md || '').split('\n');
  const keep = []; let on = true;
  for (const l of lines) {
    if (/^## /.test(l)) on = sections.some(s => l.startsWith(`## ${s}.`));
    if (on) keep.push(l);
  }
  const full = keep.join('\n').trim();
  if (full.length <= maxChars) return { markdown: full, truncated: false, chars: full.length };
  const cut = full.lastIndexOf('\n', maxChars);
  const markdown = `${full.slice(0, cut > 0 ? cut : maxChars)}\n\n…（已截斷：原 ${full.length} 字，全文見本機分析文件）`;
  return { markdown, truncated: true, chars: full.length };
}

function rowsConsistent(cvModel, counts) {
  const hm = cvModel?.hitmiss;
  if (!isObj(hm)) return 'CV 檔沒有 hitmiss 摘要';
  if (counts.hits !== null && counts.hits !== hm.n_hit) return `命中 CSV ${counts.hits} 列 ≠ 摘要 ${hm.n_hit}`;
  if (counts.misses !== null && counts.misses !== hm.n_miss) return `漏網 CSV ${counts.misses} 列 ≠ 摘要 ${hm.n_miss}`;
  return null;
}

/**
 * 一個任務的所有版本 → 摘要條目＋要發佈的逐列內容。inputs：每個版本一筆（檔案不存在的欄位給 null）
 *   { def, cvText, sha, mtime, robustText, analysis: { file, text, sha } | null,
 *     csv: { base: { hits, misses, outside }, official: { … } } }（CSV 為原始文字或 null）
 * 純函式：不讀檔、不壓縮；回傳的 payloads 由發佈程式 gzip、量大小、算 sha。
 */
export function planCvTask(taskId, inputs) {
  const task = CV_TASKS.find(t => t.id === taskId);
  if (!task) throw new Error(`未知任務：${taskId}`);
  const pre = inputs.find(x => x.def.id === 'pre_fix' && x.cvText);
  const versions = []; const payloads = [];
  for (const inp of inputs) {
    const { def } = inp;
    if (!inp.cvText) continue;
    const label = `${def.label}｜${def.snapshot ? `${def.snapshot} 快照` : taipeiMinute(inp.mtime) ?? '時間不明'}｜${String(inp.sha || '').slice(0, 8)}`;
    if (def.id !== 'pre_fix' && pre && inp.cvText === pre.cvText) {
      versions.push({ id: def.id, label: def.label, versionLabel: label, sameAs: 'pre_fix', note: `${def.dir}/ 與修正前快照逐位相同——尚未產出修正後的重訓結果` });
      continue;
    }
    const cv = JSON.parse(inp.cvText);
    if (!isObj(cv?.base) || !isObj(cv?.official)) throw new Error(`${def.dir}/official_cv_${taskId}.json 缺 base／official`);
    const warnings = [];
    const robustAll = inp.robustText ? JSON.parse(inp.robustText) : null;
    const rb = robustAll ? robustFor(robustAll, taskId, cv) : { robust: null, note: `${def.dir}/ 沒有 official_cv_robust.json（需重跑 save_scores＋robust）` };
    const own = inp.analysis && !(def.id !== 'pre_fix' && pre?.analysis && inp.analysis.text === pre.analysis.text) ? inp.analysis : null;
    const rows = {};
    for (const model of CV_MODELS) {
      const c = inp.csv?.[model] || {};
      const tables = Object.fromEntries(['hits', 'misses'].map(k => [k, c[k] ? parseCsv(c[k]) : null]));
      const bad = rowsConsistent(cv[model], { hits: tables.hits?.rows.length ?? null, misses: tables.misses?.rows.length ?? null });
      if (bad) { warnings.push(`${model} 逐列未發佈：${bad}`); rows[model] = { skipped: bad }; continue; }
      rows[model] = {};
      for (const kind of ['hits', 'misses']) {
        if (!tables[kind]) { rows[model][kind] = { skipped: '檔案不存在' }; continue; }
        const p = rowsPayload(taskId, kind, tables[kind]);
        const id = cvRowsDocId(taskId, def.id, model, kind);
        payloads.push({ id, task: taskId, version: def.id, model, kind, ...p });
        rows[model][kind] = { docId: id, totalRows: p.totalRows, keptRows: p.keptRows, filterNote: p.filterNote };
      }
    }
    // 母體外：兩個模型的事件集合相同（與模型無關）⇒ 只存一份 model=all；不同就各存一份
    const ob = inp.csv?.base?.outside; const oo = inp.csv?.official?.outside;
    const outs = ob && oo && ob === oo ? [['all', ob]] : [['base', ob], ['official', oo]].filter(([, t]) => t);
    rows.outside = {};
    for (const [model, text] of outs) {
      const p = rowsPayload(taskId, 'outside', parseCsv(text));
      const id = cvRowsDocId(taskId, def.id, model, 'outside');
      payloads.push({ id, task: taskId, version: def.id, model, kind: 'outside', ...p });
      rows.outside[model] = { docId: id, totalRows: p.totalRows, keptRows: p.keptRows, filterNote: p.filterNote };
    }
    versions.push({
      id: def.id, label: def.label, versionLabel: label, sameAs: null, dir: def.dir, sha12: String(inp.sha || '').slice(0, 12) || null, mtime: str(inp.mtime),
      meta: slimMeta(cv._meta), base: slimModel(cv.base), official: slimModel(cv.official), ablation: ablationRows(cv),
      hitmiss: { base: slimHitmiss(cv.base.hitmiss), official: slimHitmiss(cv.official.hitmiss) },
      robust: rb.robust, robustNote: rb.note,
      analysis: own ? { file: own.file, sha12: String(own.sha || '').slice(0, 12) || null, ...extractAnalysis(own.text) } : null,
      rows, warnings,
    });
  }
  return { entry: { id: task.id, label: task.label, versions, note: versions.length ? null : '沒有任何版本的 CV 輸出' }, payloads };
}

/** lab-cv 文件。rowsDocs：逐列文件清單（id＋內容 sha256），API 只服務清單內、且 sha 對得上的文件。 */
export function buildCvDoc({ dataDate, generatedAt, tasks, rowsDocs }) {
  if (!DAY_RE.test(dataDate || '')) throw new Error(`dataDate 格式錯誤：${dataDate}`);
  const ids = rowsDocs.map(r => r.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) throw new Error(`逐列文件 id 重複：${[...new Set(dup)].join(', ')}`);
  for (const r of rowsDocs) if (!CVROWS_ID_RE.test(r.id) || !/^[0-9a-f]{64}$/.test(r.sha256 || '')) throw new Error(`逐列文件描述無效：${r.id}`);
  return { schema: CV_SCHEMA, dataDate, generatedAt, tasks, rowsDocs };
}

// ── 鏡像健康 ──────────────────────────────────────────────────
export function datasetUnit(key) {
  if (DAY_RE.test(key || '')) return 'day';
  if (/^\d{4}-\d{2}(\.[a-z]+)?$/.test(key || '')) return 'month';
  if (/^\d{4}Q\d(\.[a-z]+)?$/.test(key || '')) return 'quarter';
  return 'other';
}

/**
 * 鏡像健康摘要。日資料（鍵為 YYYY-MM-DD）的 last 早於最後交易日 ⇒ stale；月／季資料的定版規則不同，這裡不判（stale=null，不假裝驗過）。
 * 警示檔不存在（retry 尚未首跑）⇒ alerts=null＋說明。
 */
export function buildMirrorDoc({ manifest, verify, alerts, lock, budget, runs = [], lastTradingDay: ltd, dataDate, generatedAt }) {
  if (!DAY_RE.test(dataDate || '')) throw new Error(`dataDate 格式錯誤：${dataDate}`);
  const vmap = isObj(verify) ? verify : {};
  const datasets = Object.entries(isObj(manifest?.datasets) ? manifest.datasets : {}).map(([key, v]) => {
    const slash = key.indexOf('/'); const id = slash > 0 ? key.slice(slash + 1) : key;
    const last = str(v?.last); const unit = datasetUnit(last ?? str(v?.first) ?? '');
    const counts = Object.fromEntries(Object.entries(isObj(v?.counts) ? v.counts : {}).map(([k, n]) => [k, fin(n) ?? 0]));
    const stale = unit === 'day' && ltd ? last === null || last < ltd : null;
    const verified = isObj(vmap[id]) ? vmap[id].ok === true : null;   // 端點驗證結果（null＝沒驗過）
    return { key, host: slash > 0 ? key.slice(0, slash) : null, id, first: str(v?.first), last, unit, counts, stale, verified };
  }).sort((a, b) => Number(!!b.stale) - Number(!!a.stale) || (a.key < b.key ? -1 : 1));
  const vEntries = Object.entries(vmap);
  const failures = vEntries.filter(([, x]) => x?.ok !== true).map(([id, x]) => ({ id, status: str(x?.status), note: str(x?.note), rows: fin(x?.rows), echo: str(x?.echo), at: str(x?.at) }));
  const missing = Array.isArray(alerts?.missing) ? alerts.missing : [];
  // 有失敗鍵；或只有空表且驗證沒說「空表是正常的」（例：當日無暫停交易的權證，驗證 ok＝空表合法）
  const isBad = d => (d.counts.bad || 0) > 0 || ((d.counts.empty || 0) > 0 && !d.counts.ok && d.verified !== true);
  return {
    schema: MIRROR_SCHEMA, dataDate, generatedAt, lastTradingDay: ltd ?? null,
    present: isObj(manifest), manifestUpdated: str(manifest?.updated), manifestAlerts: isObj(manifest?.alerts) ? manifest.alerts : null,
    summary: {
      datasets: datasets.length, daily: datasets.filter(d => d.unit === 'day').length, stale: datasets.filter(d => d.stale).length,
      withBad: datasets.filter(isBad).length, verifyTotal: vEntries.length, verifyOk: vEntries.length - failures.length, alertsMissing: alerts ? missing.length : null,
    },
    verifyFailures: failures,
    alerts: isObj(alerts) ? { rule: str(alerts.rule), at: str(alerts.at), missingTotal: missing.length, missing: missing.slice(0, ALERTS_MAX).map(m => ({ id: str(m?.id), key: str(m?.key), status: str(m?.status) })), truncated: missing.length > ALERTS_MAX } : null,
    alertsNote: isObj(alerts) ? null : '尚無 _alerts/LATEST.json（鏡像 retry 首次執行後才會產生）',
    lock: isObj(lock) ? { cmd: str(lock.cmd), pid: fin(lock.pid), at: str(lock.at), alive: typeof lock.alive === 'boolean' ? lock.alive : null } : null,
    budget: isObj(budget) ? { day: str(budget.day), requests: fin(budget.requests) } : null,
    runs: (Array.isArray(runs) ? runs : []).map(r => ({ name: str(r?.name), requests: fin(r?.requests), stats: isObj(r?.stats) ? r.stats : null, alerts: fin(r?.alerts), at: str(r?.at) })),
    datasets,
  };
}

// ── 影子管線狀態 ───────────────────────────────────────────────
export function buildPipelineDoc({ status, mtime = null, dataDate, generatedAt }) {
  if (!DAY_RE.test(dataDate || '')) throw new Error(`dataDate 格式錯誤：${dataDate}`);
  if (status !== null && status !== undefined && !isObj(status)) throw new Error('管線狀態檔不是 JSON 物件');
  return {
    schema: PIPELINE_SCHEMA, dataDate, generatedAt, present: isObj(status), status: isObj(status) ? status : null, mtime: str(mtime),
    note: isObj(status) ? null : '尚無管線狀態檔（out/a35_shadow_daily_status.json 由每日影子協調器產生）',
  };
}

// ── API：逐列查詢（伺服器端篩選＋分頁）──────────────────────────────
const INT_RE = /^\d{1,7}$/;
/** URLSearchParams → 查詢條件；任何欄位不合法都回 { ok:false }，不猜。 */
export function parseRowsQuery(params) {
  const get = k => params.get(k);
  const pick = (k, allowed, dflt) => { const v = get(k) ?? dflt; return allowed.includes(v) ? v : undefined; };
  const task = pick('task', CV_TASKS.map(t => t.id)); const version = pick('version', CV_VERSIONS.map(v => v.id));
  const model = pick('model', CV_MODELS); const kind = pick('kind', CV_KINDS);
  const market = pick('market', ['all', 'tse', 'otc'], 'all'); const sort = pick('sort', ['date', 'rank'], 'date');
  if (!task || !version || !model || !kind || !market || !sort) return { ok: false, error: 'task／version／model／kind／market／sort 參數不合法' };
  const int = k => { const v = get(k); if (v === null || v === '') return null; return INT_RE.test(v) ? Number(v) : NaN; };
  const rankMin = int('rankMin'); const rankMax = int('rankMax'); const page = int('page') ?? 1;
  if (Number.isNaN(rankMin) || Number.isNaN(rankMax) || Number.isNaN(page) || page < 1) return { ok: false, error: 'rankMin／rankMax／page 須為正整數' };
  const day = k => { const v = get(k); if (v === null || v === '') return null; return DAY_RE.test(v) ? v : undefined; };
  const from = day('from'); const to = day('to');
  if (from === undefined || to === undefined) return { ok: false, error: 'from／to 格式應為 YYYY-MM-DD' };
  const q = (get('q') ?? '').trim();
  if (q.length > 20) return { ok: false, error: '搜尋字串最多 20 字' };
  return { ok: true, query: { task, version, model, kind, market, sort, rankMin, rankMax, page, from, to, q } };
}

/** 摘要的 rowsDocs 清單裡找出要讀的逐列文件（母體外可能只存一份 model=all）。 */
export function resolveRowsDoc(cvDoc, { task, version, model, kind }) {
  const list = Array.isArray(cvDoc?.rowsDocs) ? cvDoc.rowsDocs : [];
  return list.find(r => r.task === task && r.version === version && r.kind === kind && r.model === model)
    ?? list.find(r => r.task === task && r.version === version && r.kind === kind && r.model === 'all') ?? null;
}

/** 篩選（市場、名次區間、日期、代號／名稱）＋排序＋分頁；不改動輸入。母體外沒有名次欄 ⇒ 名次條件不適用（rankIgnored）。 */
export function queryRows(table, query, pageSize = ROWS_PAGE_SIZE) {
  const col = c => table.cols.indexOf(c);
  const [iDate, iCode, iName, iMkt, iRank] = ['date', 'code', 'name', 'market', 'rank'].map(col);
  const hasRank = iRank >= 0;
  const q = (query.q || '').toLowerCase();
  const kept = table.rows.filter(r => {
    if (query.market !== 'all' && r[iMkt] !== query.market) return false;
    if (hasRank && query.rankMin !== null && !(typeof r[iRank] === 'number' && r[iRank] >= query.rankMin)) return false;
    if (hasRank && query.rankMax !== null && !(typeof r[iRank] === 'number' && r[iRank] <= query.rankMax)) return false;
    if (query.from && !(String(r[iDate]) >= query.from)) return false;
    if (query.to && !(String(r[iDate]) <= query.to)) return false;
    if (q && !String(r[iCode] ?? '').toLowerCase().includes(q) && !String(r[iName] ?? '').toLowerCase().includes(q)) return false;
    return true;
  });
  const rk = r => (hasRank && typeof r[iRank] === 'number' ? r[iRank] : Infinity);
  const byDate = (a, b) => (a[iDate] < b[iDate] ? 1 : a[iDate] > b[iDate] ? -1 : 0);
  const byRank = (a, b) => rk(a) - rk(b);
  const byCode = (a, b) => (String(a[iCode]) < String(b[iCode]) ? -1 : String(a[iCode]) > String(b[iCode]) ? 1 : 0);
  const sorted = [...kept].sort(query.sort === 'rank' ? (a, b) => byRank(a, b) || byDate(a, b) || byCode(a, b) : (a, b) => byDate(a, b) || byRank(a, b) || byCode(a, b));
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const page = Math.min(query.page, pages);
  return { cols: table.cols, rows: sorted.slice((page - 1) * pageSize, page * pageSize), total: sorted.length, page, pages, pageSize, rankIgnored: !hasRank && (query.rankMin !== null || query.rankMax !== null) };
}
