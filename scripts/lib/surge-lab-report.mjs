// ── 起漲研究後台：官方化重訓驗證／鏡像健康／影子管線狀態 → surgeShadow/lab-* 文件（純函式，不碰 I/O）──
// 研究端輸出（scripts/surge-lab/out/official_cv_*、second-brain/official/*）由 scripts/surge-lab/surge_lab_publish.mjs 讀檔後交給這裡整理；
// API（src/app/api/admin/surge-shadow?view=cvrows）也用這裡的查詢函式做伺服器端篩選與分頁。
//   · lastTradingDay：資料日一律由資料決定（研究面板日期＋鏡像 MI_INDEX 已確認日），不看日曆——非交易日發佈也記最後交易日。
//   · planCvTask：一個任務（t1L／t2L／lu1L）× 版本（修正前快照／目前 out/）→ 摘要＋逐列資料；修正前後的數字絕不混用：
//       目前版與修正前逐位相同 ⇒ 標 sameAs（不重複發佈）；穩健度檔與本版 CV 對不上 ⇒ 不採用；
//       逐列 CSV 由內容重算 hitmiss 摘要與本版 CV 比對（hitmissMismatch），不符 ⇒ 不發佈該模型逐列；母體外無筆數可比 ⇒ 標「未驗證」。
//       每版的「外樣本打分日」範圍由已核對的列推得（scoredFirst／scoredLast），不拿發佈日充當。
//   · cvGateProblems／staleRowsToDelete：輸入殘缺（缺修正前快照、這次沒有逐列）時不寫、不刪——不讓空結果蓋掉 Firestore 上的好資料。
//   · buildMirrorDoc：鏡像 manifest／驗證／警示／鎖／請求額度 → 健康摘要（日資料落後最後交易日、必有表在最後交易日不是 ok 者標記）。
//   · buildPipelineDoc：每日影子協調器的狀態檔原樣帶上＋pipelineSummary 摘要（沒有就 null＋說明，不捏造）。
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

/** 後台逐列文件內容：lu1L 漏網只留名次 ≤100（全量留本機）。table 為 parseCsv 的字串表。 */
export function rowsPayload(task, kind, table) {
  return rowsPayloadTyped(task, kind, typedTable(table));
}

/** 同 rowsPayload，但輸入已是 typedTable 的結果（不可再轉一次：null 會被 Number() 變成 0）。 */
function rowsPayloadTyped(task, kind, typed) {
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

// ── 逐列 CSV 與 CV 摘要的內容比對（2026-10-04 審查：只比筆數擋不住「第 N 次的 JSON 配第 N+1 次的 CSV」）────────
// cv_official.py write_records 在訓練途中就寫 CSV、最後才寫 JSON；它的 hitmiss 摘要＝「CSV 欄位（已四捨五入到 3 位）平均」
// 再四捨五入到 3 位 ⇒ 由 CSV 重算的平均與摘要至多差 0.0005（＋浮點雜訊）。修正前 6 組 任務×模型 實測最大差 0.0005。
export const HITMISS_MEAN_TOL = 0.0006;
const SIDES = [{ kind: 'hits', side: 0, label: '命中', nKey: 'n_hit' }, { kind: 'misses', side: 1, label: '漏網', nKey: 'n_miss' }];
const MEAN_GROUPS = [['pct_', 'feature_pct_mean'], ['有值:', 'source_has_value_rate']];
const BIN_RE = /^\((\d+),\s*(\d+)\]$/;   // pandas Interval 字串，例 "(10, 30]"

function meanOf(rows, i) {
  let s = 0; let n = 0;
  for (const r of rows) { const v = r[i]; if (typeof v === 'number' && Number.isFinite(v)) { s += v; n++; } }   // 同 pandas mean：缺值不計
  return n ? s / n : null;
}

function sideMismatch(hm, t, { kind, side, label, nKey }) {
  if (t.rows.length !== hm[nKey]) return `${label} CSV ${t.rows.length} 列 ≠ 摘要 ${hm[nKey] ?? '—'}`;
  const col = c => t.cols.indexOf(c);
  for (const [prefix, key] of MEAN_GROUPS) {
    const want = isObj(hm[key]) ? hm[key] : {};
    const csvKeys = t.cols.filter(c => c.startsWith(prefix)).map(c => c.slice(prefix.length)).sort();
    const sumKeys = Object.keys(want).sort();
    if (csvKeys.join('\u0001') !== sumKeys.join('\u0001')) return `${label} CSV 的「${prefix}」欄位與摘要 ${key} 不同（${csvKeys.length} vs ${sumKeys.length} 欄）`;
    for (const k of csvKeys) {
      const w = Array.isArray(want[k]) ? fin(want[k][side]) : null; const got = meanOf(t.rows, col(prefix + k));
      if (w === null && got === null) continue;
      if (w === null || got === null || Math.abs(got - w) > HITMISS_MEAN_TOL) return `${label}「${k}」平均 ${got === null ? '—' : got.toFixed(4)} ≠ 摘要 ${w ?? '—'}`;
    }
  }
  const mi = col('market');
  for (const [m, pair] of Object.entries(isObj(hm.by_market) ? hm.by_market : {})) {
    const got = mi < 0 ? null : t.rows.filter(r => r[mi] === m).length;
    if (!Array.isArray(pair) || got !== pair[side]) return `${label} ${m} ${got ?? '—'} 檔 ≠ 摘要 ${Array.isArray(pair) ? pair[side] : '—'}`;
  }
  const ri = col('rank'); const K = fin(hm.K);
  if (ri < 0) return `${label} CSV 缺 rank 欄`;
  if (K !== null && t.rows.some(r => !(typeof r[ri] === 'number' && (side === 0 ? r[ri] <= K : r[ri] > K)))) return `${label} CSV 有名次不在 ${side === 0 ? '≤' : '>'}${K} 的列`;
  if (kind === 'misses') {
    for (const [bin, n] of Object.entries(isObj(hm.miss_rank_bins) ? hm.miss_rank_bins : {})) {
      const b = BIN_RE.exec(bin);
      if (!b) return `摘要的漏網名次分箱「${bin}」格式不明`;
      const got = t.rows.filter(r => typeof r[ri] === 'number' && r[ri] > Number(b[1]) && r[ri] <= Number(b[2])).length;
      if (got !== n) return `漏網名次 ${bin} ${got} 列 ≠ 摘要 ${n}`;
    }
  }
  return null;
}

/**
 * 由逐列 CSV（typedTable 後）重算 cv_official 的命中／漏網摘要，與 CV 檔的 hitmiss 比對；tables.hits／misses 為 null 的那一邊不比。
 * 比：筆數、各特徵百分位與來源有值率的平均（容差 HITMISS_MEAN_TOL）、市場［命中, 漏網］、名次與 K 的關係、漏網名次分箱。回傳 null＝一致。
 */
export function hitmissMismatch(hm, tables) {
  if (!isObj(hm)) return 'CV 檔沒有 hitmiss 摘要';
  for (const s of SIDES) {
    if (!tables?.[s.kind]) continue;
    const bad = sideMismatch(hm, tables[s.kind], s);
    if (bad) return bad;
  }
  return null;
}

const OUTSIDE_UNVERIFIED = '未驗證：CV 檔沒有母體外筆數（hitmiss.n_outside）可對照；僅依寫檔順序（命中→漏網→母體外→最後才寫 CV）推定與本版同一次執行';

/** 打分日範圍（由已核對的命中／漏網列推得，不看發佈日）。 */
function scoredRange(tables) {
  const days = [];
  for (const t of tables) { const i = t.cols.indexOf('date'); if (i >= 0) for (const r of t.rows) if (typeof r[i] === 'string' && DAY_RE.test(r[i])) days.push(r[i]); }
  if (!days.length) return { scoredFirst: null, scoredLast: null };
  return { scoredFirst: days.reduce((m, d) => (d < m ? d : m)), scoredLast: days.reduce((m, d) => (d > m ? d : m)) };
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
    const rows = {}; const checked = []; const outsideOk = {};
    const add = (model, kind, p, verified, verifyNote) => {
      const id = cvRowsDocId(taskId, def.id, model, kind);
      payloads.push({ id, task: taskId, version: def.id, model, kind, ...p, verified, verifyNote });
      return { docId: id, totalRows: p.totalRows, keptRows: p.keptRows, filterNote: p.filterNote, verified, verifyNote };
    };
    for (const model of CV_MODELS) {
      const c = inp.csv?.[model] || {};
      const tables = Object.fromEntries(['hits', 'misses'].map(k => [k, c[k] ? typedTable(parseCsv(c[k])) : null]));
      if (!tables.hits && !tables.misses) { rows[model] = { hits: { skipped: '檔案不存在' }, misses: { skipped: '檔案不存在' } }; continue; }
      const bad = hitmissMismatch(cv[model].hitmiss, tables);
      if (bad) { const why = `內容與本版 CV 摘要不符（不是同一次執行的輸出）：${bad}`; warnings.push(`${model} 逐列未發佈：${why}`); rows[model] = { skipped: why }; continue; }
      outsideOk[model] = true;   // 命中／漏網與本版 CV 同一次執行 ⇒ 依寫檔順序，之後才寫的母體外也是（見 OUTSIDE_UNVERIFIED）
      rows[model] = {};
      for (const kind of ['hits', 'misses']) {
        if (!tables[kind]) { rows[model][kind] = { skipped: '檔案不存在' }; continue; }
        checked.push(tables[kind]);
        rows[model][kind] = add(model, kind, rowsPayloadTyped(taskId, kind, tables[kind]), true, null);
      }
    }
    // 母體外：只收命中／漏網已核對過的模型；CV 有 n_outside 就比筆數（不符不發佈），沒有就標「未驗證」。兩模型內容相同 ⇒ 只存一份 model=all
    rows.outside = {};
    const outCands = CV_MODELS.map(model => {
      const text = inp.csv?.[model]?.outside;
      if (!text) return null;
      if (!outsideOk[model]) { rows.outside[model] = { skipped: '同模型的命中／漏網沒有通過核對，母體外來源無法推定' }; return null; }
      const table = typedTable(parseCsv(text)); const nOut = fin(cv[model].hitmiss?.n_outside);
      if (nOut !== null && nOut !== table.rows.length) {
        const why = `母體外 CSV ${table.rows.length} 列 ≠ CV 摘要 n_outside ${nOut}`;
        warnings.push(`${model} 母體外未發佈：${why}`); rows.outside[model] = { skipped: why }; return null;
      }
      return { model, text, table, verified: nOut !== null };
    }).filter(Boolean);
    const same = outCands.length === 2 && outCands[0].text === outCands[1].text;
    for (const o of same ? [{ ...outCands[0], model: 'all', verified: outCands.every(x => x.verified) }] : outCands) {
      rows.outside[o.model] = add(o.model, 'outside', rowsPayloadTyped(taskId, 'outside', o.table), o.verified, o.verified ? null : OUTSIDE_UNVERIFIED);
    }
    versions.push({
      id: def.id, label: def.label, versionLabel: label, sameAs: null, dir: def.dir, sha12: String(inp.sha || '').slice(0, 12) || null, mtime: str(inp.mtime),
      ...scoredRange(checked),
      meta: slimMeta(cv._meta), base: slimModel(cv.base), official: slimModel(cv.official), ablation: ablationRows(cv),
      hitmiss: { base: slimHitmiss(cv.base.hitmiss), official: slimHitmiss(cv.official.hitmiss) },
      robust: rb.robust, robustNote: rb.note,
      analysis: own ? { file: own.file, sha12: String(own.sha || '').slice(0, 12) || null, ...extractAnalysis(own.text) } : null,
      rows, warnings,
    });
  }
  return { entry: { id: task.id, label: task.label, versions, note: versions.length ? null : '沒有任何版本的 CV 輸出' }, payloads };
}

/**
 * 發佈前閘門：每個任務都必須有修正前快照（out/pre_fix_*）的 CV。缺任何一個 ⇒ 回傳問題清單，呼叫端整個 cv／cvrows 不寫
 * ——不可拿「找不到輸入」的空結果蓋掉 Firestore 上的好資料（CLAUDE.md：殘缺資料不可覆蓋好的快取；--dir 給錯、從 worktree 執行都會這樣）。
 */
export function cvGateProblems(tasks) {
  const pre = CV_VERSIONS.find(v => v.id === 'pre_fix');
  return CV_TASKS.filter(def => !(tasks || []).find(t => t.id === def.id)?.versions?.some(v => v.id === 'pre_fix' && !v.sameAs))
    .map(def => `${def.id}：缺修正前快照 ${pre.dir}/official_cv_${def.id}.json`);
}

/**
 * 要刪的舊逐列文件（Firestore 上有、這次清單沒有）。這次清單是空的、或任何任務一份逐列都沒有 ⇒ 不刪（回 skipped 原因）：
 * 輸入殘缺時「清單外」＝全部，會把好的逐列整批刪光。
 */
export function staleRowsToDelete(existingIds, keepIds) {
  const keep = new Set(keepIds || []);
  if (!keep.size) return { ids: [], skipped: '這次沒有任何逐列文件，不刪舊的' };
  const empty = CV_TASKS.filter(t => ![...keep].some(id => id.startsWith(`lab-cvrows-${t.id}-`))).map(t => t.id);
  if (empty.length) return { ids: [], skipped: `任務 ${empty.join('、')} 這次沒有任何逐列文件，不刪舊的` };
  return { ids: (existingIds || []).filter(id => id.startsWith('lab-cvrows-') && !keep.has(id)), skipped: null };
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
 * manifest 的 last 是 ok／empty／unchanged 的最後一鍵 ⇒「最後交易日只抓到空表」不會落後——所以另看各資料集 _manifest.json 在最後交易日那一列
 * 的狀態（ltdRows[key].status）：必有表（mustKeys＝official-mirror 的 must，交易日不可能為空）不是 ok ⇒ mustNotOk（紅）；
 * 必有表根本不在 manifest（回補還沒建）也列出來（absent）。警示檔不存在（retry 尚未首跑）⇒ alerts=null＋說明。
 * readErrors：發佈程式讀檔失敗（半寫／損壞）的清單，原樣帶上（那些欄位是 null，不是「沒有」）。
 */
export function buildMirrorDoc({ manifest, verify, alerts, lock, budget, runs = [], ltdRows = {}, mustKeys = [], readErrors = [], lastTradingDay: ltd, dataDate, generatedAt }) {
  if (!DAY_RE.test(dataDate || '')) throw new Error(`dataDate 格式錯誤：${dataDate}`);
  const vmap = isObj(verify) ? verify : {};
  const must = new Set(mustKeys);
  const lr = isObj(ltdRows) ? ltdRows : {};
  const entry = (key, v, absent) => {
    const slash = key.indexOf('/'); const id = slash > 0 ? key.slice(slash + 1) : key;
    const last = str(v?.last); const unit = absent ? 'day' : datasetUnit(last ?? str(v?.first) ?? '');
    const counts = Object.fromEntries(Object.entries(isObj(v?.counts) ? v.counts : {}).map(([k, n]) => [k, fin(n)]));   // 非數字＝null，不補 0
    const stale = unit === 'day' && ltd && !absent ? last === null || last < ltd : null;   // 鏡像尚無的必有表不算「落後」，另以 absent／mustNotOk 標
    const verified = isObj(vmap[id]) ? vmap[id].ok === true : null;   // 端點驗證結果（null＝沒驗過）
    const ltdStatus = unit === 'day' && isObj(lr[key]) ? str(lr[key].status) : null;
    const ltdError = isObj(lr[key]) ? str(lr[key].error) : null;
    const isMust = must.has(key);
    const mustNotOk = isMust && unit === 'day' && ltd ? ltdStatus !== 'ok' : null;
    return { key, host: slash > 0 ? key.slice(0, slash) : null, id, first: str(v?.first), last, unit, counts, stale, verified, must: isMust, ltdStatus, ltdError, mustNotOk, absent };
  };
  const present = Object.entries(isObj(manifest?.datasets) ? manifest.datasets : {}).map(([key, v]) => entry(key, v, false));
  const missingMust = [...must].filter(k => !present.some(d => d.key === k)).map(k => entry(k, null, true));
  const hot = d => Number(!!d.stale || !!d.mustNotOk);
  const datasets = [...present, ...missingMust].sort((a, b) => hot(b) - hot(a) || (a.key < b.key ? -1 : 1));
  const vEntries = Object.entries(vmap);
  const failures = vEntries.filter(([, x]) => x?.ok !== true).map(([id, x]) => ({ id, status: str(x?.status), note: str(x?.note), rows: fin(x?.rows), echo: str(x?.echo), at: str(x?.at) }));
  const missing = Array.isArray(alerts?.missing) ? alerts.missing : [];
  // 有失敗鍵；或只有空表且驗證沒說「空表是正常的」（例：當日無暫停交易的權證，驗證 ok＝空表合法）
  const isBad = d => (d.counts.bad || 0) > 0 || ((d.counts.empty || 0) > 0 && !d.counts.ok && d.verified !== true);
  return {
    schema: MIRROR_SCHEMA, dataDate, generatedAt, lastTradingDay: ltd ?? null,
    present: isObj(manifest), manifestUpdated: str(manifest?.updated), manifestAlerts: isObj(manifest?.alerts) ? manifest.alerts : null,
    summary: {
      datasets: present.length, daily: present.filter(d => d.unit === 'day').length, stale: datasets.filter(d => d.stale).length,
      withBad: datasets.filter(isBad).length, verifyTotal: vEntries.length, verifyOk: vEntries.length - failures.length, alertsMissing: alerts ? missing.length : null,
      mustTotal: must.size, mustNotOk: datasets.filter(d => d.mustNotOk === true).length, mustAbsent: missingMust.length,
    },
    readErrors: (Array.isArray(readErrors) ? readErrors : []).map(e => ({ file: str(e?.file), error: str(e?.error) })),
    verifyFailures: failures,
    alerts: isObj(alerts) ? { rule: str(alerts.rule), at: str(alerts.at), missingTotal: missing.length, missing: missing.slice(0, ALERTS_MAX).map(m => ({ id: str(m?.id), key: str(m?.key), status: str(m?.status) })), truncated: missing.length > ALERTS_MAX } : null,
    alertsNote: isObj(alerts) ? null : '尚無 _alerts/LATEST.json（鏡像 retry 首次執行後才會產生）',
    lock: isObj(lock) ? { cmd: str(lock.cmd), pid: fin(lock.pid), at: str(lock.at), alive: typeof lock.alive === 'boolean' ? lock.alive : null } : null,
    budget: isObj(budget) ? { day: str(budget.day), requests: fin(budget.requests) } : null,
    runs: (Array.isArray(runs) ? runs : []).map(r => ({ name: str(r?.name), requests: fin(r?.requests), stats: isObj(r?.stats) ? r.stats : null, alerts: fin(r?.alerts), at: str(r?.at), error: str(r?.error) })),
    datasets,
  };
}

// ── 影子管線狀態 ───────────────────────────────────────────────
/** 每日影子協調器 scripts/surge-lab/a35_shadow_daily.mjs 寫的狀態檔格式（out/a35_shadow_daily_status.json）。 */
export const PIPELINE_STATUS_SCHEMA = 'a35.shadowDaily.v1';
const ERR_MAX = 300;
const strList = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);

/**
 * 狀態檔 → 一行摘要用的欄位（a35.shadowDaily.v1：steps[{name,ok,ms,err}]、lastRunAt、D、nextTD、deadline、plan、produced、scored、missed、lastPublish）。
 * ok＝有步驟且全部成功（沒有步驟＝這輪沒事可做 ⇒ null，不假裝成功或失敗）；schema 不認得 ⇒ schemaKnown=false，畫面改提示看原始狀態。
 */
export function pipelineSummary(status) {
  if (!isObj(status)) return null;
  const steps = Array.isArray(status.steps) ? status.steps.filter(isObj) : [];
  const failed = steps.filter(s => s.ok !== true);
  const plan = isObj(status.plan) ? status.plan : null;
  const pub = isObj(status.lastPublish) ? status.lastPublish : null;
  const missed = Array.isArray(status.missed) ? status.missed.filter(isObj) : null;
  return {
    schema: str(status.schema), schemaKnown: status.schema === PIPELINE_STATUS_SCHEMA,
    ok: steps.length ? failed.length === 0 : null, stepsTotal: steps.length, stepsFailed: failed.length, lastStep: str(steps.at(-1)?.name),
    failed: failed.slice(0, 5).map(s => ({ name: str(s.name), err: typeof s.err === 'string' ? s.err.slice(0, ERR_MAX) : null })),
    lastRun: str(status.lastRunAt), day: str(status.D), nextTD: str(status.nextTD), deadline: str(status.deadline), dryRun: status.dryRun === true,
    produced: strList(status.produced), scored: strList(status.scored),
    missedTotal: missed ? missed.length : null, newlyMissed: Array.isArray(plan?.newlyMissed) ? plan.newlyMissed.length : null,
    missedRecent: (missed || []).slice(-3).map(m => ({ scoringDay: str(m.scoringDay), reason: str(m.reason) })),
    waiting: Array.isArray(plan?.waiting) ? plan.waiting.length : null,
    publishOk: typeof pub?.ok === 'boolean' ? pub.ok : null, publishFinished: str(pub?.finishedAt),
  };
}

export function buildPipelineDoc({ status, mtime = null, dataDate, generatedAt }) {
  if (!DAY_RE.test(dataDate || '')) throw new Error(`dataDate 格式錯誤：${dataDate}`);
  if (status !== null && status !== undefined && !isObj(status)) throw new Error('管線狀態檔不是 JSON 物件');
  return {
    schema: PIPELINE_SCHEMA, dataDate, generatedAt, present: isObj(status), status: isObj(status) ? status : null, mtime: str(mtime),
    summary: pipelineSummary(status),
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
