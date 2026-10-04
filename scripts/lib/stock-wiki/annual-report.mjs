// ─────────────────────────────────────────────────────────────────────────────
// 台股 wiki：股東會年報「營運概況」→ 經營輪廓（使用者 2026-10-03 核准 doc.twse.com.tw）
//
// 兩段式，分開跑：
//   fetch   清單(t57sb01 step=1) → 取暫時連結(step=9) → 下 PDF → macOS PDFKit 抽文字 → 只留營運相關段落
//           純網路＋本機運算、不碰 LLM，任何時段都能跑；逐請求間隔 ≥3s；PDF 用完即刪，只留段落（供重萃取與稽核）
//   extract 段落 → 本機 Ollama 萃取 JSON → sanitize → .cache/profiles/annual/{code}.json
//           daemon 共用同一個 Ollama、一次只能推論一個；插隊會讓 daemon 的判讀撞 240s 逾時並被存成假「中性」。
//           所以：①只在台北 02:00–06:30 ②等 daemon 寫出「今晚夜間補判已跑完」訊號（second-brain/.signals/night-backfill.json）
//           ③每次送出前確認 daemon LLM 佇列不忙（.signals/llm.json）④不覆寫 num_ctx（避免模型重載）⑤單次 120 秒逾時。
//           （2026-10-03 審查：daemon 的 computeNightBackfill 01:15 起跑、死線 06:30，原本以為 02:00 後閒置是錯的）
// 萃取原則：只抽文中明寫的；年報常把客戶寫成「甲客戶」⇒ 不得還原名稱，留空。
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sanitizeProfile, KINDS } from './profiles.mjs';

export const DOC_BASE = 'https://doc.twse.com.tw';
const UA = { 'User-Agent': 'Mozilla/5.0' };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 清單與下載 ─────────────────────────────────────────────────────────────
/** 清單 HTML（已解 big5）→ 最新一份股東會年報（F04） { fy, filename } */
export function pickAnnualReport(html) {
  const found = [...String(html).matchAll(/readfile2?\("F","[^"]*","((\d{4})_[^"]*F04\.pdf)"\)/g)].map(m => ({ filename: m[1], fy: +m[2] }));
  if (!found.length) return null;
  return found.sort((a, b) => b.fy - a.fy || b.filename.localeCompare(a.filename))[0];
}
export function pickPdfHref(html) {
  const m = String(html).match(/href='(\/pdf\/[^']+\.pdf)'/);
  return m ? m[1] : null;
}

async function fetchBig5(url, fetchImpl) {
  const r = await fetchImpl(url, { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return new TextDecoder('big5').decode(await r.arrayBuffer());
}

/** 找年報：今年（民國）的股東會清單沒有就往前一年 */
export async function findAnnualReport(code, { rocYear, fetchImpl = fetch, paceMs = 3000 } = {}) {
  for (const y of [rocYear, rocYear - 1]) {
    const html = await fetchBig5(`${DOC_BASE}/server-java/t57sb01?step=1&colorchg=1&co_id=${code}&year=${y}&mtype=F&`, fetchImpl);
    const pick = pickAnnualReport(html);
    if (pick) return pick;
    await sleep(paceMs);
  }
  return null;
}

/** 年報 PDF 大小上限（G1-29·2026-10-04）：舊版整包 arrayBuffer() 讀進記憶體、沒有上限。
 *  上市櫃年報多在 5–40MB，留到 100MB；超過就放棄這檔（不寫檔），由 runner 記為失敗、下次再試。 */
export const MAX_PDF_BYTES = 100 * 1024 * 1024;

/**
 * 讀回應本體但不超過 maxBytes：先看 Content-Length，再邊讀邊數（伺服器不給或謊報長度也擋得住）。
 * 超過即取消串流並丟例外。
 * @returns {Promise<Buffer>}
 */
export async function readBodyCapped(r, maxBytes = MAX_PDF_BYTES) {
  const declared = Number(r.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`PDF 過大（宣告 ${declared} bytes > 上限 ${maxBytes}）`);
  if (!r.body?.getReader) {
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`PDF 過大（${buf.length} bytes > 上限 ${maxBytes}）`);
    return buf;
  }
  const reader = r.body.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* 取消失敗不影響丟例外 */ }
      throw new Error(`PDF 過大（已讀 ${total} bytes > 上限 ${maxBytes}）`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), total);
}

export async function downloadAnnualPdf(code, filename, file, { fetchImpl = fetch, paceMs = 3000, maxBytes = MAX_PDF_BYTES } = {}) {
  const html = await fetchBig5(`${DOC_BASE}/server-java/t57sb01?step=9&kind=F&co_id=${code}&filename=${encodeURIComponent(filename)}`, fetchImpl);
  const href = pickPdfHref(html);
  if (!href) throw new Error('取不到 PDF 連結');
  await sleep(paceMs);
  const r = await fetchImpl(DOC_BASE + href, { headers: UA, signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error(`PDF HTTP ${r.status}`);
  const buf = await readBodyCapped(r, maxBytes);
  if (buf.subarray(0, 4).toString() !== '%PDF') throw new Error('不是 PDF');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return buf.length;
}

/** macOS PDFKit 抽文字（swiftc 編一次放 .cache/bin） */
export function pdfToText(pdfFile, binDir) {
  const bin = path.join(binDir, 'pdftext');
  if (!fs.existsSync(bin)) {
    fs.mkdirSync(binDir, { recursive: true });
    execFileSync('swiftc', ['-O', '-o', bin, path.join(HERE, 'bin', 'pdftext.swift')], { stdio: 'pipe' });
  }
  return execFileSync(bin, [pdfFile], { maxBuffer: 64 * 1024 * 1024, timeout: 120000 }).toString('utf8');
}

// ── 段落擷取 ────────────────────────────────────────────────────────────────
// 錨點：年報「營運概況」的制式小節，依重要性排序、各自配額（避免前面的產業概況把預算吃光）
const ANCHORS = [
  { key: 'products', re: /營業比重|產品及服務項目|主要產品/, after: 1800 },
  { key: 'chain', re: /上、中、下游|上中下游|產業上下游/, after: 1500 },
  { key: 'materials', re: /主要原料/, after: 1500 },
  { key: 'counterparties', re: /主要供應商|進貨廠商|主要進銷貨|客戶名單|主要銷貨客戶/, after: 3500 },
  { key: 'competitors', re: /主要競爭對手|競爭對手|主要競爭/, after: 1200 },
  { key: 'markets', re: /銷售地區|內外銷/, after: 1200 },
  { key: 'uses', re: /重要用途|產製過程/, after: 1000 },
  { key: 'production', re: /生產量值|產能/, after: 1000 },
  { key: 'sales', re: /銷售量值|銷售量及值|銷售值/, after: 1800 },   // 各產品內銷／外銷（2026-10-03 產品×國家）
  { key: 'plants', re: /生產基地|主要廠房|廠區|工廠/, after: 800 },
];
// 目錄頁：一段文字裡出現多條「……… 77」「-------- 77」引導線
const LEADER = /[.．…‧\-－—_]{6,}\s*\d*/g;
export const looksLikeToc = (s) => (String(s).match(LEADER) || []).length >= 3;

/** 定位「營運概況」章；找不到回 null（像台積電那種非制式年報） */
export function findOperationsChapter(text) {
  const t = String(text);
  const starts = [...t.matchAll(/(?:^|\n)\s*[伍五陸肆参參]\s*[、.．]\s*營運概況/g)].map(m => m.index);
  for (const s of starts) {
    const head = t.slice(s, s + 4000);
    if (looksLikeToc(t.slice(s, s + 1500))) continue;   // 目錄頁
    if (!/業務內容|業務範圍|主要產品|市場及產銷/.test(head)) continue;
    const rest = t.slice(s + 10);
    // 下一章（財務概況／財務狀況）——章號可能是伍到捌，視年報把營運概況排在第幾章而定
    const end = rest.search(/\n\s*[參叁肆伍陸柒捌玖三四五六七八九]\s*[、.．]\s*(?:財務概況|財務狀況)/);
    return t.slice(s, s + 10 + (end > 0 ? end : 60000));
  }
  return null;
}

/** 依錨點取段落：每個錨點取第一次出現處往前 100、往後 after 字，合併重疊，總長上限 budget */
export function anchorWindows(text, { budget = 18000 } = {}) {
  const t = String(text); const spans = [];
  for (const a of ANCHORS) {
    const m = a.re.exec(t);
    if (m) spans.push([Math.max(0, m.index - 100), Math.min(t.length, m.index + a.after), a.key]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const sp of spans) { const last = merged.at(-1); if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]); else merged.push([sp[0], sp[1]]); }
  let out = '';
  for (const [a, b] of merged) {
    const piece = t.slice(a, b).replace(/<<<PAGE \d+>>>/g, '').replace(/^-\d+-$/gm, '').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n');
    if (out.length + piece.length > budget) { out += piece.slice(0, Math.max(0, budget - out.length)); break; }
    out += `${piece}\n…\n`;
  }
  return { text: out, anchors: spans.map(x => x[2]) };
}

export function operationsText(fullText, opts) {
  const ch = findOperationsChapter(fullText);
  const w = anchorWindows(ch || fullText, opts);
  return { chapterFound: !!ch, ...w };
}

// ── LLM 萃取 ────────────────────────────────────────────────────────────────
export function buildPrompt(stock, fy, text) {
  return `你是嚴謹的資料萃取器。以下是「${stock.code} ${stock.name}」${fy} 年度股東會年報「營運概況」章的節錄。
請**逐一掃過節錄中的每個表格與條列**，把明確寫出的項目萃取成 JSON。只能用節錄內容，不可用你的知識補充；節錄沒寫的欄位才給空陣列。

各欄位對應年報小節：
- products：「主要產品／營業比重／產品及服務項目」。name＝產品名，share＝營業比重（照原文，例如 48%）。
  若有「銷售量值表」：同一產品的 domestic＝最近年度**內銷值**、export＝最近年度**外銷值**（照原文數字，不要換算；沒有就省略）。
- materials：「主要原料之供應狀況」表的**原料名稱**欄（例：苯乙烯、銅箔、玻纖布）。
- suppliers：同一張原料表的**供應來源**欄，以及「主要供應商名單」中有寫出真名的廠商（台灣公司用簡稱，外國公司保留原文）。
- customers：「主要銷貨客戶名單」中有寫出真名的客戶。**寫成甲、乙、A 公司、客戶 1 等代號的一律不列。**
- competitors：「主要競爭對手」「競爭情形」中寫出的公司名，每個都列。
- equipment：明寫的生產設備（例：真空壓膜機、射出成型機）。
- plants：生產基地／工廠／廠區，location 寫國家與城市，country 寫國家；products＝原文寫明該廠區生產的產品（沒寫就省略）。
- markets：「主要商品之銷售地區」，name＝地區（例：台灣、中國大陸、美洲），share＝比重。
- summary：一句話定位（≤40 字）。
每個項目都加 "conf":"高"。名稱用繁體中文短詞（≤12 字），外國公司保留原文。

輸出（只輸出 JSON，不要說明）：
{"summary":"","products":[{"name":"產品","share":"比重","domestic":"內銷值","export":"外銷值","conf":"高"}],"materials":[{"name":"原料","conf":"高"}],"suppliers":[{"name":"廠商","country":"國家","conf":"高"}],"customers":[{"name":"客戶","country":"國家","conf":"高"}],"competitors":[{"name":"公司","country":"國家","conf":"高"}],"equipment":[{"name":"設備","conf":"高"}],"plants":[{"name":"廠區","location":"國家／城市","country":"國家","products":["產品"],"conf":"高"}],"markets":[{"name":"地區","share":"比重","conf":"高"}]}

【年報節錄】
${text}`;
}

export async function ollamaExtract(prompt, { url = process.env.OLLAMA_URL || 'http://localhost:11434', model = process.env.OLLAMA_MODEL || 'gemma4:latest', fetchImpl = fetch, timeoutMs = 120000 } = {}) {
  // 不帶 num_ctx：與 daemon 同參數才不會讓 Ollama 每次切換呼叫端都重載模型
  const r = await fetchImpl(`${url}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, think: false, format: 'json', options: { temperature: 0 } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`ollama HTTP ${r.status}`);
  const raw = (await r.json()).response || '';
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('LLM 沒有回 JSON');
  return JSON.parse(m[0]);
}

/** 台北時間是否落在 'HH:MM-HH:MM' 窗內（可跨午夜）；格式錯直接丟錯（舊版回 true＝整天跑 LLM） */
export function inWindow(now, win) {
  const m = String(win).match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`時段格式錯誤：${win}（應為 HH:MM-HH:MM）`);
  const tw = new Date(now + 8 * 3600000); const cur = tw.getUTCHours() * 60 + tw.getUTCMinutes();
  const a = +m[1] * 60 + +m[2]; const b = +m[3] * 60 + +m[4];
  return a <= b ? cur >= a && cur < b : cur >= a || cur < b;
}

// ── 與 daemon 的協調訊號（daemon 寫在 second-brain/.signals）───────────────
const SIGNAL_STALE_MS = 5 * 60000;   // daemon 單次 LLM 最多 240s；忙碌訊號超過 5 分鐘沒更新視為 daemon 已掛／殘留
const readSignal = (dir, name) => { try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return null; } };
const twDay = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
/** 今晚 daemon 夜間補判是否已跑完一輪（台北日期相同且在 01:15 之後寫的） */
export function nightBackfillDone(signalDir, now = Date.now()) {
  const s = readSignal(signalDir, 'night-backfill.json');
  if (!s?.at || twDay(s.at) !== twDay(now)) return false;
  const tw = new Date(s.at + 8 * 3600000); return tw.getUTCHours() * 60 + tw.getUTCMinutes() >= 75;
}
/** daemon LLM 佇列是否忙碌（訊號過期視為不忙） */
export function daemonLlmBusy(signalDir, now = Date.now()) {
  const s = readSignal(signalDir, 'llm.json');
  if (!s?.at || now - s.at > SIGNAL_STALE_MS) return false;
  return !!s.busy || (s.queue || 0) > 0;
}

/** 把 LLM 結果轉成輪廓並把台股公司名補上代號 */
export function toAnnualProfile(llm, { fy, validCodes, nameToCode, asOf }) {
  const src = `annual-report-${fy}`;
  const withCodes = { ...llm };
  for (const k of ['customers', 'suppliers', 'competitors']) {
    withCodes[k] = (llm?.[k] || []).map(it => {
      const o = typeof it === 'string' ? { name: it } : { ...it };
      const c = nameToCode?.(o.name); if (c && !o.code) o.code = c;
      return o;
    });
  }
  const p = sanitizeProfile({ ...withCodes, src, asOf, conf: '高' }, { validCodes, defaultSrc: src });
  return p && KINDS.some(k => p[k].length) ? p : null;
}
