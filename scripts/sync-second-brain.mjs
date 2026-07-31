#!/usr/bin/env node
// ============================================================
// Sync the local "second brain" from the app's data layer.
// Pulls the latest after-close market report and writes it as a
// human/AI-readable markdown page under second-brain/reports/.
//
// Usage:
//   (app running locally)  node scripts/sync-second-brain.mjs
//   APP_BASE=https://your-app node scripts/sync-second-brain.mjs
//
// The second brain is a local knowledge base (markdown + json) that the
// local Ollama pipeline (local-analyze.mjs) reads for fast context.
// ============================================================

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const APP_BASE = process.env.APP_BASE || 'http://localhost:3000';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'second-brain');

async function getJSON(path) {
  const res = await fetch(`${APP_BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

function reportToMarkdown(r) {
  const lines = [];
  lines.push(`# 收盤盤勢分析 — ${r.date}`, '');
  lines.push(`> 產生時間：${new Date(r.generatedAt).toLocaleString('zh-TW')}`, '');
  lines.push(`## 摘要`, '', r.summary, '');
  lines.push(`## 市場寬度`, '');
  lines.push(`- 上漲 **${r.breadth.up}** / 下跌 **${r.breadth.down}** / 持平 **${r.breadth.flat}**（共 ${r.breadth.total}）`);
  lines.push(`- 漲家數佔比：**${r.breadth.advancePct}%**`, '');
  if (r.riskHighlights?.length) {
    lines.push(`## 風險提示`, '', ...r.riskHighlights.map(x => `- ${x}`), '');
  }
  lines.push(`## 精選標的（已套用均線支撐 / 波動度賣點）`, '');
  lines.push('| 代號 | 名稱 | 評級 | 訊號 | 現價 | 漲跌% | 買點 | 目標 | 停損 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const p of r.topPicks || []) {
    lines.push(`| ${p.code} | ${p.name} | ${p.grade} | ${p.signal} | ${p.price} | ${p.changePercent?.toFixed?.(2) ?? p.changePercent} | ${p.buy ?? '—'} | ${p.target ?? '—'} | ${p.stopLoss ?? '—'} |`);
  }
  lines.push('');
  lines.push(`_分析 ${r.meta?.totalAnalyzed} 檔｜強化 ${r.meta?.enriched} 檔｜歷史涵蓋 ${r.meta?.historyCovered} 檔_`);
  return lines.join('\n');
}

(async () => {
  mkdirSync(join(ROOT, 'reports'), { recursive: true });
  mkdirSync(join(ROOT, 'stocks'), { recursive: true });

  console.log(`▶ Syncing second brain from ${APP_BASE} …`);
  const report = await getJSON('/api/market-report').catch(e => { console.error('✖ market-report:', e.message); return null; });
  if (report) {
    const md = reportToMarkdown(report);
    writeFileSync(join(ROOT, 'reports', `${report.date}.md`), md);
    writeFileSync(join(ROOT, 'reports', 'latest.md'), md);
    writeFileSync(join(ROOT, 'index.json'), JSON.stringify({
      lastSync: Date.now(),
      latestReportDate: report.date,
      topPickCodes: (report.topPicks || []).map(p => p.code),
    }, null, 2));
    console.log(`✓ Wrote reports/${report.date}.md (+latest.md), ${report.topPicks?.length || 0} picks`);
  }
  console.log('✓ Second-brain sync done.');
})();
