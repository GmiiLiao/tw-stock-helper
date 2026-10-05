#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 分析師團隊 CLI（手動／乾跑用；排程入口是 analyst-desk-run.mjs）。
//   node scripts/analyst-desk.mjs --date 2026-10-02 --edition evening [--engine claude-cli|ollama|files] [--files-dir DIR]
//        [--pack FILE.json] [--out DIR] [--model opus|sonnet|…] [--dry-run] [--no-fallback]
//   --pack     用現成資料包（跳過 R0）；否則組包（Firestore 只 get；--no-firestore 只用本機檔；--root 指定 second-brain 根）
//   --out      輸出目錄（預設 second-brain/daily-analyst/_dryrun/{date}.{edition}/）；乾跑只寫這裡，不寫 Firestore、不寫定版檔
//   --dry-run  即使指定 --out 之外也不呼叫 archive／publish（本 CLI 目前永遠只寫 --out；正式寫入走 analyst-desk-run.mjs）
//   不使用 API 金鑰；claude-cli 用使用者已登入的帳號（401 → 退 ollama → 退模板殼，並在輸出標示）。
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { produceIssue, runDesk } from './lib/analyst-desk/desk.mjs';

function arg(name, def = null) { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; }
const has = name => process.argv.includes(`--${name}`);

const date = arg('date');
const edition = arg('edition', 'evening');
const engine = arg('engine', 'claude-cli');
const filesDir = arg('files-dir') ? resolve(arg('files-dir')) : null;
const model = arg('model') || undefined;           // 全部角色同一模型（覆蓋下面兩個）
const draftModel = arg('draft-model') || undefined;   // 草稿／交叉審閱／紅隊（預設 opus，effort low）
const editorModel = arg('editor-model') || undefined; // 總編輯與修稿（預設 opus，effort high）
if (!['evening', 'morning'].includes(edition)) { console.error('--edition 只能是 evening|morning'); process.exit(2); }
if (!arg('pack') && !date) { console.error('需要 --date YYYY-MM-DD（資料日）或 --pack FILE'); process.exit(2); }

let pack;
if (arg('pack')) pack = JSON.parse(readFileSync(resolve(arg('pack')), 'utf8'));
else {
  const sbRoot = resolve(arg('root') || 'second-brain');
  if (has('no-firestore')) { const { buildPack } = await import('./lib/analyst-desk/pack.mjs'); pack = await buildPack({ date, edition, root: sbRoot, fsGet: null, now: Date.now() }); }
  else { const { defaultDeps } = await import('./analyst-desk-run.mjs'); pack = await defaultDeps(sbRoot).loadPack({ date, edition, nowMs: Date.now() }); }   // Firestore 只 get
}
const day = pack.dataDate;
const out = resolve(arg('out') || join('second-brain', 'daily-analyst', '_dryrun', `${day}.${edition}`));
mkdirSync(out, { recursive: true });

const todayISO = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);   // 台北日期，只用於卡片標題的「前交易日／當日」標籤
const opts = { pack, filesDir, model, draftModel, editorModel, draftEffort: arg('draft-effort') || undefined, editorEffort: arg('editor-effort') || undefined, todayISO, log: e => { if (e.label && !e.raw) console.error(`  · ${e.label}${e.attempt ? ' (retry)' : ''}${e.error ? ' ✖ ' + e.error : ''}`); } };

const t0 = Date.now();
const r = has('no-fallback') ? { ...(await runDesk({ ...opts, engine })), engineUsed: engine, errors: [] } : await produceIssue({ ...opts, engines: engine === 'files' ? ['files'] : [engine, ...(engine === 'claude-cli' ? ['ollama'] : [])] });

writeFileSync(join(out, 'pack.json'), JSON.stringify(pack, null, 1));
const spend = r.transcript.filter(x => x.usage).reduce((a, x) => ({ n: a.n + 1, inTok: a.inTok + x.usage.in, outTok: a.outTok + x.usage.out, usd: a.usd + (x.usage.costUsd || 0) }), { n: 0, inTok: 0, outTok: 0, usd: 0 });
writeFileSync(join(out, 'issue.json'), JSON.stringify(r.issue, null, 1));
writeFileSync(join(out, 'transcript.jsonl'), r.transcript.map(x => JSON.stringify(x)).join('\n') + '\n');
if (r.errors?.length) writeFileSync(join(out, 'errors.json'), JSON.stringify(r.errors, null, 1));

const c = r.issue.meta.check;
console.log(`資料日 ${day}／${pack.edition}／引擎 ${r.engineUsed}／查核 ${c.pass ? '通過' : '未過'}（blockers ${c.blockers}、刪除 ${c.redactions.length}、修稿 ${c.repairRounds} 輪）／${((Date.now() - t0) / 1000).toFixed(0)}s`);
for (const card of r.issue.cards) console.log(`  ${card.title}：${card.sections.reduce((n, s) => n + s.claims.length, 0)} 句、名單 ${card.focus.stocks.length} 檔${card.focus.note ? `（${card.focus.note}）` : ''}`);
if (r.issue.meta.fallback) console.log('  ⚠ 已降級為模板殼：' + JSON.stringify(r.errors));
console.log(`呼叫 ${spend.n} 次｜輸入 ${spend.inTok} tokens｜輸出 ${spend.outTok} tokens｜約 $${spend.usd.toFixed(2)}`);
console.log(`輸出：${out}`);
process.exit(c.pass || r.issue.meta.fallback ? 0 : 1);
