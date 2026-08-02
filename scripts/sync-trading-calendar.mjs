#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 台股休市日曆同步 → Firestore `system/tradingCalendar`
//
// 兩個來源，缺一不可：
//
// ① 證交所官方休市日程表（openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule）
//    每年公告一次、涵蓋國定假日與春節結算日。**前瞻性**，但只有「表訂」休市。
//
// ② 自家 chipArchive 的空洞（平日、非表訂休市、卻沒有收盤資料）
//    ＝颱風假等臨時休市。官方日程表**不會**有這些，只能事後由實際資料反推。
//    2026 上半年實測抓到 5 天：03-10、03-13、03-25、05-20、07-10。
//    （07-10 就是先前害「波段起漲」整個功能靜默停擺的那一天。）
//
// ⚠ 分類陷阱：日程表裡有三筆是「交易日標記」不是休市 ——
//   「國曆新年開始交易日」「農曆春節前最後交易日」「農曆春節後開始交易日」。
//   而「市場無交易，僅辦理結算交割作業」雖然字面有「交易」兩字，卻是**休市**。
//   所以規則是 /開始交易|最後交易/ 才排除，不能只比對「交易」。
//   此規則已用自家歸檔全量對帳，2026 年 27 筆分類 100% 相符。
//
// 用法：node scripts/sync-trading-calendar.mjs [--year=2026] [--dry]
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const DRY = process.argv.includes('--dry');
const YEAR = +((process.argv.find(a => a.startsWith('--year=')) || '').slice(7)) ||
  new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei', year: 'numeric' });

const TWSE_HOLIDAY_API = 'https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule';
const MIN_STOCKS = 500;                       // 與 loadLuArchive 的有效日門檻一致
const isTradingMark = (name) => /開始交易|最後交易/.test(name);

/** 民國 1150101 → 2026-01-01 */
function rocToIso(roc) {
  const s = String(roc || '');
  if (!/^\d{7}$/.test(s)) return null;
  return `${+s.slice(0, 3) + 1911}-${s.slice(3, 5)}-${s.slice(5, 7)}`;
}

async function fetchOfficialHolidays() {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 15000);
  const r = await fetch(TWSE_HOLIDAY_API, {
    headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctl.signal,
  }).finally(() => clearTimeout(tm));
  if (!r.ok) throw new Error(`TWSE holidaySchedule HTTP ${r.status}`);
  const rows = await r.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error('holidaySchedule 回空陣列');

  const closed = [], tradingMarks = [];
  for (const row of rows) {
    const iso = rocToIso(row.Date);
    if (!iso) continue;
    (isTradingMark(row.Name || '') ? tradingMarks : closed).push(iso);
  }
  return { closed: [...new Set(closed)].sort(), tradingMarks: tradingMarks.sort(), raw: rows.length };
}

/** 由自家歸檔反推臨時休市（颱風假）：平日 ∧ 非表訂休市 ∧ 無收盤資料 */
async function deriveAdHocClosures(officialClosed) {
  const snap = await db.collection('chipArchive').get();
  const hasData = new Set();
  let earliest = null;
  snap.forEach(d => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.id)) return;
    if (!earliest || d.id < earliest) earliest = d.id;
    const raw = d.data().closeJson;
    if (raw && Object.keys(JSON.parse(raw)).length > MIN_STOCKS) hasData.add(d.id);
  });
  if (!earliest || !hasData.size) return [];

  const official = new Set(officialClosed);
  // 只回推到「有資料的最後一天」為止 —— 再往後是未來，沒資料是正常的
  const latest = [...hasData].sort().pop();
  const out = [];
  for (const d = new Date(`${earliest}T00:00:00+08:00`); ; d.setDate(d.getDate() + 1)) {
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (iso > latest) break;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    if (official.has(iso) || hasData.has(iso)) continue;
    out.push(iso);
  }
  return out;
}

// ── 獨立驗證：這一天到底有沒有開盤？（2026-08-02 新增）─────────────────
// 為什麼需要：舊版把「chipArchive 有空洞」直接當成臨時休市，但空洞也可能只是
//   **當天歸檔失敗**。而且這個錯誤會自我強化——一旦被判為休市，isTradingDay()
//   之後就回 false、不再嘗試補抓，空洞就永久化，日曆永遠是錯的。
// 實案（2026-08-02 查獲）：2026-03-10／03-13／03-25／05-20 被判為颱風假，
//   實際上四天都有 3,241 列委託統計與 860~1,169 萬股成交量——**都有開盤**。
//   只有 07-10 是真休市（委託統計 0 列）。四個假日曆條目污染了所有回測母體。
// 判準：MI_5MINS（每5秒委託成交統計）是**不依賴自家歸檔**的第三方事實。
//   0 列＝真休市；3,241 列＝有開盤（空洞是我方歸檔失敗，不可判為休市）。
async function verifyClosure(iso) {
  const ymd8 = iso.replace(/-/g, '');
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/MI_5MINS?date=${ymd8}&response=json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch(url, { signal: ctl.signal });
      clearTimeout(t);
      if (r.status === 307 || r.status === 429 || r.status >= 500) { await new Promise(z => setTimeout(z, 3000 * (attempt + 1))); continue; }
      const j = await r.json();
      const rows = Array.isArray(j.data) ? j.data.length : 0;
      // 回音驗證：標題民國日期須等於請求日，否則視為無法判定（保守：不推翻）
      const m = (j.title || '').match(/(\d{2,3})年(\d{1,2})月(\d{1,2})日/);
      if (m) {
        const got = `${+m[1] + 1911}${String(+m[2]).padStart(2, '0')}${String(+m[3]).padStart(2, '0')}`;
        if (got !== ymd8) return { closed: null, why: `日期回音不符(${got})` };
      }
      return { closed: rows === 0, rows };
    } catch { await new Promise(z => setTimeout(z, 3000 * (attempt + 1))); }
  }
  return { closed: null, why: '查詢失敗' };
}

async function main() {
  const { closed, tradingMarks, raw } = await fetchOfficialHolidays();
  console.log(`[cal] 官方日程表 ${raw} 筆 → 休市 ${closed.length}、交易日標記 ${tradingMarks.length}（${tradingMarks.join(', ')}）`);

  let derived = await deriveAdHocClosures(closed);
  // 每個「由空洞反推的休市」都必須通過第三方驗證，才准列入日曆
  if (derived.length) {
    console.log(`[cal] 由空洞反推 ${derived.length} 筆，逐一以 MI_5MINS 獨立驗證…`);
    const verified = [], rejected = [], unknown = [];
    for (const d of derived) {
      const v = await verifyClosure(d);
      if (v.closed === true) verified.push(d);
      else if (v.closed === false) rejected.push(`${d}(委託統計${v.rows}列＝有開盤)`);
      else unknown.push(`${d}(${v.why})`);
      await new Promise(z => setTimeout(z, 1200));
    }
    if (rejected.length) console.log(`[cal] ⚠ 推翻 ${rejected.length} 筆誤判——這些日子有開盤，是我方歸檔失敗不是休市：\n      ${rejected.join('\n      ')}`);
    if (unknown.length) console.log(`[cal] ⚠ ${unknown.length} 筆無法驗證，保守起見**不列入**休市：${unknown.join('、')}`);
    derived = verified;
  }
  // 官方日程表只涵蓋當年度。落在該年度內的 derived ＝真正的臨時休市（颱風假）；
  // 落在往年的 derived ＝該年度的一般國定假日（官方表已不提供，只能由歷史資料反推）。
  const coverYear = closed.length ? closed[0].slice(0, 4) : String(YEAR);
  const adHoc = derived.filter(d => d.startsWith(coverYear));
  const historical = derived.filter(d => !d.startsWith(coverYear));
  console.log(`[cal] ${coverYear} 年臨時休市（颱風假等，官方表無）${adHoc.length} 筆：${adHoc.join(', ') || '無'}`);
  console.log(`[cal] 往年休市（由歷史資料反推，供回測用）${historical.length} 筆`);

  const holidays = [...new Set([...closed, ...derived])].sort();
  const doc = {
    updatedAt: Date.now(),
    year: Number(YEAR),
    source: TWSE_HOLIDAY_API,
    coverYear,
    official: closed,
    adHoc,
    historical,
    holidays,                       // client 只需要吃這個合併後的清單
    note: 'official=證交所當年度日程表；adHoc=該年度臨時休市（颱風假，官方表沒有）；historical=往年休市（由歷史資料反推）。holidays 為三者聯集，client 只需吃這個。',
  };

  if (DRY) { console.log('[cal] (dry) 不寫入。合併後共', holidays.length, '天'); process.exit(0); }
  await db.collection('system').doc('tradingCalendar').set(doc);
  console.log(`[cal] ✓ 已寫入 system/tradingCalendar：合併 ${holidays.length} 天`);
  process.exit(0);
}

main().catch(e => { console.error('[cal] 失敗:', e.message); process.exit(1); });
