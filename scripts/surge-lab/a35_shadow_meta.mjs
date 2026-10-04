#!/usr/bin/env node
// a35_shadow 中繼資料（唯讀，結果印到 stdout 的 JSON；不寫任何檔案、不寫 Firestore）：
//   calendar  → Firestore system/tradingCalendar（唯讀 get）：{ holidays, coverYear, official, adHoc, updatedAt }
//               憑證只走環境變數 GOOGLE_APPLICATION_CREDENTIALS（由 a35_shadow_lib.calendar_from_firestore 帶入，不印出）。
//   basis D   → 本機快取 chipArchive.json.gz 裡 D 那份文件的到齊狀態——與 daemon 定版閘門同一支 archiveDayStatus（scripts/lib/canonical-gate.mjs），
//               另標上櫃收盤是否含第三方（Yahoo）補洞，以及模型輸入（資券／借券兩市、上市當沖；surge-shadow-daily.modelInputsStatus）是否已進歸檔：
//               { date, found, ready, missing, basis, nonOfficialOtcClose, gapFixSource, otcPending, complete, nClose, inputsReady, inputsMissing, inputCounts }
//               ready 只代表收盤＋法人（daemon 定版閘門）；事前凍結名單要 ready 且 inputsReady（2026-10-04 審查：資券／借券／當沖 19:45～21:49 才到）。
//               快取目錄＝SURGE_CACHE，否則本檔所在目錄的 .surge-cache。
// 用法：node a35_shadow_meta.mjs calendar｜node a35_shadow_meta.mjs basis 2026-10-02
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveDayStatus } from '../lib/canonical-gate.mjs';
import { modelInputsStatus } from '../lib/surge-shadow-daily.mjs';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SP = process.env.SURGE_CACHE || fileURLToPath(new URL('./.surge-cache/', import.meta.url));
const out = obj => new Promise(r => process.stdout.write(JSON.stringify(obj), r));

async function calendar() {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credPath) throw new Error('缺 GOOGLE_APPLICATION_CREDENTIALS');
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  initializeApp({ credential: cert(JSON.parse(readFileSync(credPath, 'utf8'))) });
  const d = (await getFirestore().collection('system').doc('tradingCalendar').get()).data();   // 唯讀 get
  if (!d || !Array.isArray(d.holidays)) throw new Error('system/tradingCalendar 沒有 holidays');
  return { holidays: d.holidays, coverYear: d.coverYear ?? null, official: d.official ?? [], adHoc: d.adHoc ?? [], updatedAt: d.updatedAt ?? null };
}

/** chipArchive 單日文件 → 到齊狀態（純函式；欄位缺就照實回 null，不補預設值） */
export function basisOf(date, doc) {
  if (!doc) return { date, found: false, ready: false, missing: ['文件不存在'], basis: null, inputsReady: false, inputsMissing: ['文件不存在'], inputCounts: null };
  const st = archiveDayStatus(doc);
  const mi = modelInputsStatus(doc);
  let nClose = null;
  try { nClose = doc.closeJson ? Object.keys(JSON.parse(doc.closeJson)).length : 0; } catch { nClose = null; }
  return {
    date, found: true, ready: st.ready, missing: st.missing, basis: st.basis,
    nonOfficialOtcClose: /yahoo/i.test(String(doc.gapFixSource || '')),
    gapFixSource: doc.gapFixSource ?? null, otcPending: doc.otcPending ?? null, complete: doc.complete ?? null, nClose,
    inputsReady: mi.ready, inputsMissing: mi.missing, inputCounts: mi.counts,
  };
}

function basis(date) {
  if (!DAY_RE.test(date || '')) throw new Error('basis 需要 YYYY-MM-DD');
  const arr = JSON.parse(gunzipSync(readFileSync(join(SP, 'chipArchive.json.gz'))).toString('utf8'));
  return basisOf(date, arr.find(x => x?.date === date));
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'calendar') return out(await calendar());
  if (cmd === 'basis') return out(basis(arg));
  throw new Error('用法：a35_shadow_meta.mjs calendar｜basis YYYY-MM-DD');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(() => process.exit(0), e => { console.error(String(e?.message || e)); process.exit(1); });
}
