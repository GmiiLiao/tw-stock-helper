#!/usr/bin/env node
// ============================================================
// Local AI analysis pipeline — the "local AI + second brain" tier.
// For each target stock it pulls computed context from the app
// (indicators + enriched rating + fundamentals), asks the LOCAL Ollama
// model to write an analysis, saves it to second-brain/stocks/{code}.md,
// and pushes a copy back to Firestore (aiNotes/{code}) so the app can
// surface it to users.
//
// Usage:
//   (app running + ollama running)
//   node scripts/local-analyze.mjs                 # analyse latest report's top picks
//   node scripts/local-analyze.mjs --codes 2330,2317
//
// Env: APP_BASE (default http://localhost:3000),
//      OLLAMA_URL (default http://localhost:11434),
//      OLLAMA_MODEL (default gemma4:latest),
//      CRON_SECRET (if the app requires it for note writes).
// ============================================================

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const APP_BASE = process.env.APP_BASE || 'http://localhost:3000';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwythos-9b:q8_0';
const CRON_SECRET = process.env.CRON_SECRET || '';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'second-brain', 'stocks');

const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ONLY = (getArg('--codes', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(path) {
  const res = await fetch(`${APP_BASE}${path}`);
  if (!res.ok) return null;
  return res.json();
}

async function targets() {
  if (ONLY.length) return ONLY.map(code => ({ code, name: '' }));
  const report = await getJSON('/api/market-report');
  return (report?.topPicks || []).map(p => ({ code: p.code, name: p.name }));
}

// Read cached news from the local second brain (no web fetch).
function readLocalNews(code) {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), '..', 'second-brain', 'news', `${code}.json`);
    const d = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(d.items) ? d.items : [];
  } catch { return []; }
}

function buildPrompt(code, name, rating, ind, news) {
  const s = ind?.snapshot;
  const f = rating?.fundamentals;
  const st = rating?.stock;
  const ctx = [];
  ctx.push(`股票：${code} ${name || st?.name || ''}`);
  if (st) ctx.push(`AI 評分 ${st.score}（${st.grade}）訊號 ${st.signal}；現價 ${st.price}，今日 ${st.changePercent?.toFixed?.(2)}%`);
  if (s) {
    ctx.push(`趨勢：${s.trend}；MA20 ${s.ma?.ma20} / MA60 ${s.ma?.ma60} / MA120 ${s.ma?.ma120} / MA240 ${s.ma?.ma240}`);
    ctx.push(`RSI ${s.rsi}，MACD ${s.macd}，KD ${s.k}/${s.d}；52週高 ${s.week52High} 低 ${s.week52Low}（距高 ${s.distFromHigh}%）`);
    ctx.push(`支撐 ${(s.support || []).join(', ')}；壓力 ${(s.resistance || []).join(', ') || '無（接近高點）'}`);
  }
  if (st?.buyZones?.length) ctx.push(`買點：${st.buyZones.map(z => `${z.label} ${z.price}`).join('；')}`);
  if (st?.sellTargets?.length) ctx.push(`賣點：${st.sellTargets.filter(t => t.type !== 'trailing').map(t => `${t.label} ${t.price}(+${t.gainPercent}%, 達成率${t.probability}%)`).join('；')}；停損 ${st.stopLoss}`);
  if (f?.valuation) ctx.push(`估值：PER ${f.valuation.pe} / 殖利率 ${f.valuation.dividendYield}% / PBR ${f.valuation.pb}`);
  if (f?.institutional) ctx.push(`三大法人(張)：外資 ${f.institutional.foreignNetLots}、投信 ${f.institutional.trustNetLots}、合計 ${f.institutional.totalNetLots}`);
  if (f?.margin) ctx.push(`融資：餘額 ${f.margin.balance} 張、使用率 ${f.margin.utilization}%`);
  if (news && news.length) ctx.push(`近期新聞（本地快取）：\n${news.slice(0, 6).map(nw => `・${nw.title}`).join('\n')}`);

  return `你是台灣股市資深分析師。根據以下量化數據，用繁體中文寫一段精簡、務實的個股分析（200-300字），需涵蓋：(1) 技術面與趨勢解讀 (2) 籌碼/估值面觀察 (3) 操作建議：明確的進場價位、停利/停損與風險。請勿杜撰數據，僅依據提供資訊。結尾加上「僅供參考，非投資建議」。

【數據】
${ctx.join('\n')}`;
}

async function askOllama(prompt) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 120000);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const d = await res.json();
    return (d.response || '').trim() || null;
  } catch (e) { clearTimeout(t); console.warn('  ⚠ ollama:', e.message); return null; }
}

async function postNote(code, name, analysis) {
  try {
    const res = await fetch(`${APP_BASE}/api/ai/stock-note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(CRON_SECRET ? { 'x-cron-secret': CRON_SECRET } : {}) },
      body: JSON.stringify({ code, name, analysis, model: OLLAMA_MODEL, source: 'local-ollama' }),
    });
    return res.ok;
  } catch { return false; }
}

(async () => {
  mkdirSync(ROOT, { recursive: true });
  const list = await targets();
  if (!list.length) { console.error('✖ No targets (no report and no --codes).'); process.exit(1); }
  console.log(`▶ Local-analyzing ${list.length} stocks via ${OLLAMA_MODEL} …`);

  let ok = 0, fail = 0;
  for (const { code, name } of list) {
    try {
      const [rating, ind] = await Promise.all([
        getJSON(`/api/rating?code=${code}`),
        getJSON(`/api/indicators?code=${code}`),
      ]);
      const news = readLocalNews(code); // from local second-brain wiki (no web fetch)
      const analysis = await askOllama(buildPrompt(code, name, rating, ind, news));
      if (!analysis) { fail++; console.warn(`  ✖ ${code} ${name}: no analysis`); continue; }

      const md = `# ${code} ${name || rating?.stock?.name || ''}\n\n> 本地 AI（${OLLAMA_MODEL}）· ${new Date().toLocaleString('zh-TW')}\n\n${analysis}\n`;
      writeFileSync(join(ROOT, `${code}.md`), md);
      const pushed = await postNote(code, name || rating?.stock?.name || '', analysis);
      ok++;
      console.log(`  ✓ ${code} ${name}  (note pushed: ${pushed})`);
    } catch (e) {
      fail++; console.warn(`  ✖ ${code}: ${e.message}`);
    }
    await sleep(300);
  }
  console.log(`✓ Done. ok=${ok} fail=${fail}  → second-brain/stocks/*.md + aiNotes/{code}`);
})();
