// ─────────────────────────────────────────────────────────────────────────────
// 台股 wiki：讀本地第二大腦備份（second-brain/backup，由 backup-brain.mjs 每日同步 Firestore）
// 全部走本地檔，**零上游請求、零 Firestore 讀取**。缺哪一份就回空並在 missing[] 記名，頁面會明說「來源未提供」。
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';

const parseMaybe = (v, fallback) => {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
};
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** 股票類別：4 碼個股、00 開頭 ETF */
export const isEtfCode = (c) => /^00\d{2,4}[A-Z]?$/.test(c);
export const isStockCode = (c) => /^\d{4}$/.test(c) && !c.startsWith('00');

export function loadBackup(brainDir) {
  const backupDir = path.join(brainDir, 'backup');
  const missing = [];
  const singletons = readJson(path.join(backupDir, 'singletons.json'));
  if (!singletons) missing.push('backup/singletons.json');
  const S = singletons || {};
  const doc = (col, id) => S[col]?.[id] || null;

  // 宇宙：上市＋上櫃快照（含 ETF）＋興櫃
  const snap = doc('marketSnapshot', 'latest');
  const quotes = parseMaybe(snap?.quotesJson, {});
  const emerging = parseMaybe(doc('marketSnapshot', 'emerging')?.quotesJson, {});
  if (!snap) missing.push('marketSnapshot/latest');

  const peer = doc('peerComps', 'latest');
  const theme = doc('themeMap', 'seed');
  const etfInf = doc('etfInfluence', 'latest');
  const fin = doc('finSummary', 'latest');

  const mopsDays = Object.keys(S.mopsNews || {}).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
  const mopsNews = mopsDays.map(d => ({ date: d, items: Object.values(parseMaybe(S.mopsNews[d]?.itemsJson, {}) || {}) }));

  return {
    missing,
    snapshotDate: snap?.dataDate || snap?.date || null,
    quotes, emerging,
    emergingDate: doc('marketSnapshot', 'emerging')?.date || null,
    peer: { month: peer?.month || null, industries: parseMaybe(peer?.industriesJson, {}), summary: parseMaybe(peer?.summaryJson, {}) },
    themeChains: parseMaybe(theme?.chains, []),
    etfInfluence: etfInf ? {
      date: etfInf.dataDate || etfInf.date || null,
      constituents: parseMaybe(etfInf.constituents, []),
      bigcapEtfs: parseMaybe(etfInf.bigcapEtfs, []),
      note: etfInf.note || '',
    } : null,
    finSummary: parseMaybe(fin?.byCodeJson, {}),
    mopsNews,
    backupDir,
  };
}

/** 個股新聞：second-brain/news/{code}.json（daemon newsLoop）＋ backup/stockAI/{code}.json 的 news，依網址去重 */
export function loadStockNews(brainDir, code) {
  const out = []; const seen = new Set();
  const push = (it, origin) => {
    if (!it?.title) return;
    const key = it.url || it.link || it.title;
    if (seen.has(key)) return; seen.add(key);
    if (it.category === 'policy') return;   // 政策類是關鍵字搜尋撈到的政府頁（常與本檔無關），不收
    out.push({ title: it.title, source: it.source || '', time: it.time || it.pubDate || '', url: it.url || it.link || '', category: it.category || null, origin });
  };
  const local = readJson(path.join(brainDir, 'news', `${code}.json`));
  for (const it of local?.items || []) push(it, 'newsLoop');
  const ai = readJson(path.join(brainDir, 'backup', 'stockAI', `${code}.json`));
  for (const it of ai?.news || []) push(it, 'stockAI');
  return out.sort((a, b) => String(b.time).localeCompare(String(a.time)));
}

/** 財報季資料（backup/finReports/{code}.json） */
export function loadFinReport(brainDir, code) {
  const j = readJson(path.join(brainDir, 'backup', 'finReports', `${code}.json`));
  if (!j) return null;
  return { quarters: parseMaybe(j.quartersJson, []), updatedAt: j.updatedAt || null };
}

/** 全部個股代號（上市＋上櫃＋興櫃），排除 ETF */
export function stockUniverse(bk) {
  const out = new Map();
  for (const [c, q] of Object.entries(bk.quotes)) if (isStockCode(c)) out.set(c, { code: c, name: q.name, market: q.market });
  for (const [c, q] of Object.entries(bk.emerging)) if (isStockCode(c) && !out.has(c)) out.set(c, { code: c, name: q.name, market: 'esb' });
  return out;
}
