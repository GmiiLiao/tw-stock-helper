#!/usr/bin/env node
// ── ETF／興櫃官方日 K：鏡像覆蓋與驗證閘門（AI 停損 stop-v1.1 A3；規範 tw-ai-stoploss SKILL §2A）─────────────
// 只讀 second-brain/official（0 網路請求、不寫任何檔、不寫 Firestore）。核心在 scripts/lib/official-bars.mjs。
//   status  [--kind etf|emerging|all] [--last N] [--json]   逐日市場組成、回聲問題、閘門 ①②③（最近連續 ≥20 個交易日）
//   factors [--from D] [--to D] [--json]                     官方參考價係數 vs scripts/data/exright-history.json（ETF）的涵蓋自檢
// 閘門 ④⑤⑥（會員持股抽樣比對 daemon 快照、audit CONTRACTS 連續 5 日綠、影子期分開統計）屬整合端，見 SKILL §2A。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as B from './lib/official-bars.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.OFFICIAL_ROOT || B.DEFAULT_OFFICIAL_ROOT;

function args(argv) {
  const a = { cmd: argv[0] || 'status', kind: 'all', last: 80, json: false, from: null, to: null };
  for (let i = 1; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--kind') a.kind = argv[++i]; else if (k === '--last') a.last = Number(argv[++i]);
    else if (k === '--from') a.from = argv[++i]; else if (k === '--to') a.to = argv[++i];
    else if (k === '--json') a.json = true; else throw new Error(`未知參數：${k}`);
  }
  if (!['etf', 'emerging', 'all'].includes(a.kind)) throw new Error(`--kind 只認 etf｜emerging｜all：${a.kind}`);
  if (!Number.isInteger(a.last) || a.last <= 0) throw new Error(`--last 要正整數：${a.last}`);
  return a;
}

function statusOf(kind, last) {
  const { days, problems } = B.readOfficialDays({ root: ROOT, kind, lastN: last });
  const gates = B.archiveGates(days);
  const lastDay = days.at(-1) || null;
  return {
    kind, range: { first: days[0]?.date ?? null, last: lastDay?.date ?? null, tradingDays: days.length },
    okDays: days.filter(d => d.ok).length, lastCounts: lastDay?.counts ?? null, gates, problems: problems.slice(-30),
  };
}

function cmdStatus(a) {
  const out = (a.kind === 'all' ? ['etf', 'emerging'] : [a.kind]).map(k => statusOf(k, a.last));
  if (a.json) { console.log(JSON.stringify(out, null, 1)); return; }
  for (const s of out) {
    console.log(`【${s.kind}】${s.range.first} → ${s.range.last}（近 ${s.range.tradingDays} 個交易日，完整 ${s.okDays} 日）；最後一日各市場檔數 ${JSON.stringify(s.lastCounts)}`);
    console.log(`  閘門①②③：最近連續完整 ${s.gates.tailRun} 日（需 ≥${s.gates.minRun}）⇒ ${s.gates.pass ? '通過' : '未通過'}${s.gates.pendingTail ? `；最後 ${s.gates.pendingTail} 日鏡像尚未抓齊（daily 22:40／retry 06:45 補）` : ''}`);
    for (const p of s.problems.slice(-8)) console.log(`  ✖ ${p.date} ${p.market}（${p.id}）：${p.status}${p.note ? `·${p.note}` : ''}`);
  }
  console.log('閘門④⑤⑥（會員持股抽樣比對、稽核契約連續 5 日綠、影子期分開統計）由整合端做，見 SKILL §2A。非投資建議。');
}

function cmdFactors(a) {
  const ex = JSON.parse(readFileSync(join(HERE, 'data', 'exright-history.json'), 'utf8'));
  const from = a.from || ex.from; const to = a.to || ex.to;
  const ref = B.refFactorItems({ root: ROOT, from, to });
  const table = (ex.items || []).filter(([d, c]) => d >= from && d <= to && /^00\d{2,4}[A-Z]?$/.test(c) && !/^\d{4}$/.test(c));
  const cal = B.tradingDaysOf(ROOT); const idx = new Map(cal.map((d, i) => [d, i]));
  const un = B.uncoveredFactors(ref, table, { prevDayOf: d => cal[(idx.get(d) ?? 0) - 1] ?? null });
  const { days } = B.readOfficialDays({ root: ROOT, kind: 'etf', from, to });
  const breaks = B.structuralBreaks(B.barsByCodeOf(days), cal).map(b => ({ ...b, inTable: table.some(([d, c]) => c === b.code && d > b.prevDate && d <= b.date) }));
  const out = { from, to, refEvents: ref.length, tableEvents: table.length, uncovered: un, structuralBreaks: breaks };
  if (a.json) { console.log(JSON.stringify(out, null, 1)); return; }
  console.log(`官方參考價係數（ETF，前一日有成交者）${from}～${to}：${ref.length} 件；exright-history ETF 事件 ${table.length} 件`);
  console.log(`  係數表沒有或差 >1% 的官方事件 ${un.length} 件`);
  for (const [d, c, f] of un.slice(0, 20)) console.log(`  · ${d} ${c} ×${f}`);
  const miss = breaks.filter(b => !b.inTable);
  console.log(`  日 K 結構斷點（停止買賣後收盤比 <0.7 或 >1.43，分割／反分割候選）${breaks.length} 件，係數表沒有的 ${miss.length} 件：`);
  for (const b of miss) console.log(`  · ${b.code} ${b.prevDate} → ${b.date}（停 ${b.gapDays} 日，收盤比 ${b.ratio}，近似值不可當係數）`);
}

const a = args(process.argv.slice(2));
if (a.cmd === 'status') cmdStatus(a);
else if (a.cmd === 'factors') cmdFactors(a);
else { console.error('用法：official-bars.mjs status|factors [--kind etf|emerging|all] [--last N] [--from D] [--to D] [--json]'); process.exit(1); }
