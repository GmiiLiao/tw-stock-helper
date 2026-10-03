// ─────────────────────────────────────────────────────────────────────────────
// 台股 wiki：年報覆蓋的批次執行（狀態檔可中斷續跑）
//   .cache/annual/state/{code}.json  { fy, filename, status:'text'|'noreport'|'error', fetchedAt, chapterFound, anchors, extractedAt, extract }
//   .cache/annual/text/{code}.txt    營運概況錨點段落（PDF 用完即刪）
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { findAnnualReport, downloadAnnualPdf, pdfToText, operationsText, buildPrompt, ollamaExtract, inWindow, toAnnualProfile, nightBackfillDone, daemonLlmBusy } from './annual-report.mjs';
import { profileDir } from './profiles.mjs';
import { normCompanyName } from './util.mjs';

const DAY = 86400000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(`${f}.tmp`, JSON.stringify(o)); fs.renameSync(`${f}.tmp`, f); };
export const annualPaths = (cacheDir, code) => ({
  state: path.join(cacheDir, 'annual', 'state', `${code}.json`),
  text: path.join(cacheDir, 'annual', 'text', `${code}.txt`),
  pdf: path.join(cacheDir, 'annual', 'tmp', `${code}.pdf`),
  bin: path.join(cacheDir, 'bin'),
});

/** 現在應該已有的最新年報會計年度：股東會多在 5–6 月，7 月起以去年為準 */
export function expectedFy(now = Date.now()) {
  const tw = new Date(now + 8 * 3600000); const y = tw.getUTCFullYear();
  return tw.getUTCMonth() + 1 >= 7 ? y - 1 : y - 2;
}

export function needsFetch(state, now = Date.now()) {
  if (!state) return true;
  const stale = now - (state.fetchedAt || 0) > 30 * DAY;
  // 年報比預期舊（晚交、興櫃）也只 30 天查一次——否則每晚重下載、重萃取同一份舊年報（2026-10-03 審查）
  if (state.status === 'text') return (state.fy || 0) < expectedFy(now) && stale;
  return stale;   // noreport／error 30 天後再試
}

export async function annualFetch(cacheDir, codes, { paceMs = 3000, maxFetch = Infinity, log = () => {}, fetchImpl = fetch, now = () => Date.now() } = {}) {
  const st = { fetched: 0, skipped: 0, noreport: 0, failed: 0, aborted: false };
  let consecutive = 0;
  const rocYear = new Date(now() + 8 * 3600000).getUTCFullYear() - 1911;
  for (const code of codes) {
    const P = annualPaths(cacheDir, code);
    const prev = readJson(P.state);
    if (!needsFetch(prev, now())) { st.skipped++; continue; }
    if (st.fetched + st.noreport + st.failed >= maxFetch) break;   // 每晚上限（以實際處理數計，不是切代號清單）
    try {
      const pick = await findAnnualReport(code, { rocYear, fetchImpl, paceMs });
      if (!pick) { writeJson(P.state, { status: 'noreport', fetchedAt: now() }); st.noreport++; consecutive = 0; await sleep(paceMs); continue; }
      await sleep(paceMs);
      await downloadAnnualPdf(code, pick.filename, P.pdf, { fetchImpl, paceMs });
      const ops = operationsText(pdfToText(P.pdf, P.bin));
      if (!ops.chapterFound) {
        // 非制式年報（找不到營運概況章）：關鍵字段落常是願景文宣，萃取會產生錯配的「高」信心資料 ⇒ 不做，AI 層保留
        writeJson(P.state, { status: 'nochapter', fy: pick.fy, filename: pick.filename, fetchedAt: now() });
        st.noreport++;
      } else {
        fs.mkdirSync(path.dirname(P.text), { recursive: true });
        fs.writeFileSync(P.text, ops.text);
        writeJson(P.state, { status: 'text', fy: pick.fy, filename: pick.filename, fetchedAt: now(), chapterFound: true, anchors: ops.anchors, chars: ops.text.length });
        st.fetched++;
      }
      consecutive = 0;
    } catch (e) {
      // 舊年報文字仍可用就保留（不動 fetchedAt，免得觸發重萃同一份文字）；否則記 error，30 天後再試
      writeJson(P.state, prev?.status === 'text' ? { ...prev, error: e.message, errorAt: now() } : { status: 'error', error: e.message, fetchedAt: now() });
      st.failed++; consecutive++; log(`  ✗ ${code} ${e.message}`);
      if (consecutive >= 5) { st.aborted = true; log('  ⛔ 年報下載連續失敗 5 次，中止（下次續跑）'); break; }
    } finally {
      try { fs.unlinkSync(P.pdf); } catch { /* 沒有 PDF */ }
    }
    if ((st.fetched + st.noreport + st.failed) % 25 === 0) log(`  · 年報 ${JSON.stringify(st)}`);
    await sleep(paceMs);
  }
  return st;
}

/** 名稱 → 台股代號（簡稱、全名正規化、去 -KY／*） */
export function makeNameToCode(model) {
  const m = new Map();
  for (const s of model.stocks.values()) {
    for (const n of [s.name, String(s.name || '').replace(/[-－]KY$|\*|＊/g, ''), s.fullName]) {
      const k = normCompanyName(n); if (k && !m.has(k)) m.set(k, s.code);
    }
  }
  return (name) => m.get(normCompanyName(name)) || null;
}

export async function annualExtract(cacheDir, model, codes, { window = '02:00-06:30', force = false, signalDir = null, log = () => {}, now = () => Date.now(), extract = ollamaExtract, sleepImpl = sleep, busyWaitMs = 30000 } = {}) {
  const st = { extracted: 0, empty: 0, failed: 0, skipped: 0, stoppedByWindow: false, waitedBusy: 0 };
  const nameToCode = makeNameToCode(model); const validCodes = new Set(model.stocks.keys());
  const outDir = profileDir(cacheDir, 'annual'); fs.mkdirSync(outDir, { recursive: true });
  for (const code of codes) {
    const P = annualPaths(cacheDir, code);
    const state = readJson(P.state);
    // 已萃取過這份文字（ok 或確認為空）就跳過；只有 error 重試
    if (state?.status !== 'text' || (state.extractedAt && state.extractedAt >= state.fetchedAt && state.extract !== 'error')) { st.skipped++; continue; }
    if (!force && !inWindow(now(), window)) { st.stoppedByWindow = true; log(`  ⏸ 已離開 LLM 閒置時段 ${window}，停止（下次續跑）`); break; }
    // daemon 正在用 LLM（佇列非空或推論中）就等；等到離窗為止
    let outOfWindow = false;
    while (signalDir && daemonLlmBusy(signalDir, now())) {
      st.waitedBusy++;
      if (!force && !inWindow(now(), window)) { outOfWindow = true; break; }
      await sleepImpl(busyWaitMs);
    }
    if (outOfWindow) { st.stoppedByWindow = true; log('  ⏸ 等 daemon LLM 期間離開時段，停止'); break; }
    const s = model.stocks.get(code);
    try {
      const llm = await extract(buildPrompt({ code, name: s?.name || code }, state.fy, fs.readFileSync(P.text, 'utf8')));
      const p = toAnnualProfile(llm, { fy: state.fy, validCodes, nameToCode, asOf: `${state.fy}年報` });
      if (p) { writeJson(path.join(outDir, `${code}.json`), p); st.extracted++; } else st.empty++;
      writeJson(P.state, { ...state, extractedAt: now(), extract: p ? 'ok' : 'empty' });
    } catch (e) {
      writeJson(P.state, { ...state, extractedAt: now(), extract: 'error', extractError: e.message });
      st.failed++; log(`  ✗ ${code} 萃取失敗：${e.message}`);
    }
    if ((st.extracted + st.empty + st.failed) % 10 === 0) log(`  · 萃取 ${JSON.stringify(st)}`);
  }
  return st;
}
