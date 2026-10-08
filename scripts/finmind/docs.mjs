// ── second-brain/finmind 的 README 與 _manifest.json ──────────────────────────────
// 每份輸出都標「來源 FinMind（第三方轉載官方）·研究用·不上站」；授權限制照 FinMind 方案表寫明。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SOURCE_LABEL, MAIN_START, DATASETS } from './datasets.mjs';
import { datasetDir, readJson, writeJsonAtomic } from './store.mjs';

export const LICENSE_NOTE = 'FinMind Sponsor 方案：只限個人／學術／web／app 開發等非商業用途；即時資料不得呈現於對外介面；使用時須標示資料來源「FinMind」。';
export const USAGE_NOTE = '台股助手有付費會員 ⇒ 本目錄資料只進第二大腦做內部研究：不寫 Firestore、不上站、不進正式訓練或計分（tw-official-data-sources：正式只用官方；第三方等同 Yahoo，只能研究）。';
const MAX_RUNS = 30;
// 人工／試抓者寫的「實測筆記」區塊：--refresh-docs 重產 README 時原樣保留（2026-10-08 試抓者加）
export const FIELD_NOTES_START = '<!-- field-notes:start -->';
export const FIELD_NOTES_END = '<!-- field-notes:end -->';

/** 取出既有 README 的實測筆記區塊（含標記）；沒有就回空字串。 */
export function extractFieldNotes(text) {
  const s = String(text ?? '');
  const a = s.indexOf(FIELD_NOTES_START); const b = s.indexOf(FIELD_NOTES_END);
  return a >= 0 && b > a ? s.slice(a, b + FIELD_NOTES_END.length) : '';
}

const modeText = {
  'market-day': '每個交易日一次請求（全市場），一天一檔',
  'code-day': '每檔（或每個商品）每天一次請求，同一天的所有代號併成一檔（每次請求＝一個 gzip 成員）',
  'broker-day': '每家券商每天一次請求（回該券商當天所有股票），同一天的所有券商併成一檔',
  range: '一次請求拿區間內全市場（檔名帶區間）',
  table: '只帶 dataset 拿整張表（檔名帶抓取日＝快照）',
  week: '先以 data_id=2330 的區間查詢取得週資料日，再逐週全市場',
};

export function datasetReadme(spec) {
  return `# ${spec.name}｜${spec.zh}

> **${SOURCE_LABEL}**
> ${LICENSE_NOTE}
> ${USAGE_NOTE}

- 方案等級：${spec.tier || '—'}；FinMind 起始日：${spec.since || '文件沒寫'}；請求方式：${modeText[spec.mode] || spec.mode}
- 驗證方法：\`${spec.validator}\`（結果在 \`_validation.json\`；未通過不得大量下載）
${(spec.notes || []).map(n => `- ${n}`).join('\n')}

## 檔案
- \`<YYYY>/<YYYY-MM-DD>.jsonl.gz\`（日資料）或 \`range_<起>_<迄>.jsonl.gz\`／\`snapshot_<抓取日>.jsonl.gz\`：一行一列 JSON，欄位照 FinMind 原樣，不改名、不換算單位。
- \`*.idx.tsv\`：每次請求一行「成員（代號／券商／*）\\t列數\\t起\\t迄」位元組位置；可只解壓某一檔：讀該段位元組再 gunzip。
- \`*.part.*\`：下載中（下次續抓）；只有正式檔才是完整的一天。
- \`_superseded/\`：被取代的舊版（暫定群組重抓、\`--retry-empty\`、同起點但終點較早的舊區間檔），不刪只搬；**不是現行資料，合併讀取時要排除**（區間檔只讀同起點終點最晚的那份）。
- \`_coverage.json\`（每群組狀態、列數、失敗）、\`_manifest.json\`（來源、授權、抓取紀錄）、\`_validation.json\`（與官方抽樣比對結果）。

## 讀法
\`\`\`js
import { gunzipSync } from 'node:zlib'; import { readFileSync } from 'node:fs';
const rows = gunzipSync(readFileSync('2026/2026-10-07.jsonl.gz')).toString().split('\\n').filter(Boolean).map(JSON.parse);
\`\`\`
\`\`\`python
import gzip, json; rows = [json.loads(l) for l in gzip.open('2026/2026-10-07.jsonl.gz', 'rt')]
\`\`\`
`;
}

export function rootReadme() {
  const rows = DATASETS.filter(d => d.enabled).map(d => `| ${d.name} | ${d.zh} | ${d.mode} | ${d.since || '—'} | ${d.validator} |`).join('\n');
  return `# second-brain/finmind｜FinMind 研究資料（第三方）

> **${SOURCE_LABEL}**
> ${LICENSE_NOTE}
> ${USAGE_NOTE}

由 \`scripts/finmind/backfill.mjs\` 下載（token 只在執行時讀 \`.env.local\`、只放 Authorization 標頭，不落地任何檔案）。

## 下載順序（使用者 2026-10-08：「可下載的資料先下載2023-2026的部份，先驗證，其它的再找空閒時間下載」）
1. 每個資料集先 \`--sample\` 小樣本 → \`node scripts/finmind/validate.mjs --dataset <名稱>\` 與官方鏡像／chipArchive 比對，\`_validation.json\` 為 pass 才能大量下載（程式強制）。
2. 主佇列：${MAIN_START} 起到最新交易日；平日 08:30–13:45 每小時 ≤1,500 次，其他時間 ≤5,000 次（daemon 重任務窗也降速）；重資料集（每次回應數 MB：期貨／選擇權逐筆、5 秒指數、集保、八大行庫）在這些降速時段整段暫停（次數上限擋不住頻寬與 CPU）。
3. 空閒佇列：${MAIN_START} 以前，只在 \`--window idle\`（平日 15:30–08:00、週末、休市日）且該資料集主佇列全部完成後才跑。

## 指令
\`\`\`bash
node scripts/finmind/backfill.mjs --status                       # 各資料集進度、驗證、上次執行（離線）
node scripts/finmind/backfill.mjs --dataset cheap --dry-run      # 估請求數、磁碟、時間（不打網路）
node scripts/finmind/backfill.mjs --dataset TaiwanStockKBar --sample
node scripts/finmind/validate.mjs --dataset TaiwanStockKBar
node scripts/finmind/backfill.mjs --dataset TaiwanStockKBar --max-requests 5000
\`\`\`

## 資料集
| 名稱 | 內容 | 請求方式 | FinMind 起始日 | 驗證 |
|---|---|---|---|---|
${rows}
`;
}

/** README 只在不存在時寫（保留人工補充）；--refresh-docs 時覆寫。 */
export function writeDocs(root, specs, { force = false } = {}) {
  mkdirSync(root, { recursive: true });
  const top = join(root, 'README.md');
  if (!existsSync(top)) writeFileSync(top, rootReadme());
  else if (force) { const notes = extractFieldNotes(readFileSync(top, 'utf8')); writeFileSync(top, notes ? `${rootReadme()}\n${notes}\n` : rootReadme()); }
  for (const s of specs) {
    const dir = datasetDir(root, s.name); mkdirSync(dir, { recursive: true });
    const p = join(dir, 'README.md');
    if (!existsSync(p)) { writeFileSync(p, datasetReadme(s)); continue; }
    if (!force) continue;
    const notes = extractFieldNotes(readFileSync(p, 'utf8'));
    writeFileSync(p, notes ? `${datasetReadme(s)}\n${notes}\n` : datasetReadme(s));
  }
}

/** 更新 _manifest.json：靜態說明＋本次執行紀錄（保留最近 30 次）。 */
export function updateManifest(root, spec, run) {
  const path = join(datasetDir(root, spec.name), '_manifest.json');
  const prev = readJson(path, {}) || {};
  const cov = readJson(join(datasetDir(root, spec.name), '_coverage.json'), null);
  const val = readJson(join(datasetDir(root, spec.name), '_validation.json'), null);
  const runs = [...(prev.runs || []), ...(run ? [run] : [])].slice(-MAX_RUNS);
  const m = {
    dataset: spec.name, zh: spec.zh, source: SOURCE_LABEL, provider: 'FinMind（api.finmindtrade.com，第三方轉載官方）', license: LICENSE_NOTE, usage: USAGE_NOTE,
    tier: spec.tier || null, mode: spec.mode, endpoint: spec.endpoint, since: spec.since, notes: spec.notes,
    cols: cov?.cols ?? prev.cols ?? null, coverage: cov?.summary ?? null, validation: val ? { status: val.status, method: val.method, checkedAt: val.checkedAt } : null,
    runs, updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(path, m);
  return m;
}
