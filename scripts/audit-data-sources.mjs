#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 全站資料源稽核 —— 依 wm-freshness-health-monitoring 的新鮮度契約
//
// 契約：每個資料源都要能回答三件事
//   ① fetchedAt   —— 最後一次成功更新是什麼時候
//   ② recordCount —— 這次更新涵蓋了多少筆
//   ③ dataDate    —— 這批資料**代表哪一天**（不是「什麼時候抓的」）
//
// 兩道獨立閘門，缺一不可：
//   • maxStaleMin  = 更新節奏的 2~3 倍。只看這個會漏掉「很新但幾乎全空」。
//   • minRecords   = 覆蓋率下限。只看這個會漏掉「很完整但是上週的」。
//
// ⚠ 第三道：**dataDate 漂移**。這是本專案踩過最多次的坑 ——
//   上櫃日期位移、加權指數落後一日、stockHistory 只寫一次、chipDaily PIT 漂移。
//   共同特徵都是「有值、很新、筆數也夠」，但代表的是**別天**的資料。
//   所以有 dataDate 的來源一律比對「最近一個交易日」。
//
// 用法：node scripts/audit-data-sources.mjs [--json] [--only=collection]
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const AS_JSON = process.argv.includes('--json');
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7) || null;
const WRITE = process.argv.includes('--write');   // 寫入 system/dataHealth 供 daemon 告警與 API 讀取
const NO_EXT = process.argv.includes('--no-external');

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

// ── 契約表 ───────────────────────────────────────────────────────────────
// kind: 'latest'  → 讀 doc('latest')
//       'dated'   → 讀 orderBy(date desc) 第一筆
//       'perCode' → 整個 collection 每個 doc 一檔股票
// maxStale: 允許的最大陳舊時間（ms）。intraday 類只在交易日盤中嚴格判定。
// minRecords: 覆蓋率下限。
// session: 'intraday' 盤中更新 | 'daily' 每日收盤後 | 'always' 全天
const CONTRACTS = [
  // ── 盤中即時（節奏以分鐘計）──
  { c: 'marketIndex',      kind: 'latest',  maxStale: 10 * MIN,  session: 'intraday', dateField: 'tradeDate' },
  { c: 'marketSnapshot',   kind: 'latest',  maxStale: 10 * MIN,  session: 'intraday', countField: 'quotes' },
  { c: 'marketIntraday',   kind: 'latest',  maxStale: 15 * MIN,  session: 'intraday' },
  { c: 'intradayRadar',    kind: 'latest',  maxStale: 15 * MIN,  session: 'intraday' },
  { c: 'limitUpForecast',  kind: 'latest',  maxStale: 15 * MIN,  session: 'intraday' },
  { c: 'volSurge',         kind: 'latest',  maxStale: 15 * MIN,  session: 'intraday' },

  // ── 每日收盤後（節奏以日計）──
  { c: 'chipArchive',      kind: 'dated',   maxStale: 30 * HOUR, session: 'daily', minRecords: 1500, countField: 'closeJson' },
  { c: 'chipDaily',        kind: 'dated',   maxStale: 30 * HOUR, session: 'daily', minRecords: 1500, countField: 'codesJson' },
  // 尾盤五檔歸檔（委買賣失衡原料·2026-08-02 接上稽核）：舊版 9 個交易日缺 2 天
  // 且沒有任何告警——這種「靜默不累積」的資料要靠三道閘門才抓得到。
  { c: 'bookDepthArchive', kind: 'dated',   maxStale: 30 * HOUR, session: 'daily', minRecords: 300,  countField: 'byCodeJson' },
  // 市場委託失衡（MI_5MINS 每5秒委託成交統計·2026-08-02 回補3年並接上每日更新）
  // 日韓早盤（2026-08-03 建立）：台股開盤前的領先窗口原料。
  // 只在交易日 08:00–09:05 產生，故 maxStale 放寬到 30h；minRecords 用 snapshots 陣列長度。
  { c: 'asiaPremarketArchive', kind: 'dated', maxStale: 30 * HOUR, session: 'daily', minRecords: 1, countField: 'snapshots' },
  { c: 'orderFlowArchive', kind: 'dated',   maxStale: 30 * HOUR, session: 'daily', minRecords: 1,    countField: 'curveJson' },
  { c: 'stockHistory',     kind: 'perCode', maxStale: 30 * HOUR, session: 'daily', minRecords: 900,  dateField: 'lastDate' },
  { c: 'scanner',          kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'rsRanking',        kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'tradeSignals',     kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'multiTimeframe',   kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'chipPicks',        kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'chipCharacter',    kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'chipWind',         kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'chipDivergence',   kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'sectorRotation',   kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'sectorWind',       kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'marketWind',       kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'marketHealth',     kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'topicPicks',       kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'swingPicks',       kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  // allowEmpty：本榜回測日均僅 1.6 檔，零檔是常態（例：大反彈日後 RSI5 全面噴高）——EMPTY 不是故障
  { c: 'strengthPicks',    kind: 'latest',  maxStale: 30 * HOUR, session: 'daily', allowEmpty: true },
  { c: 'strategyPicks',    kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'snipeList',        kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'squeezeSetup',     kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'washoutMonitor',   kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'institutionalStreaks', kind: 'latest', maxStale: 30 * HOUR, session: 'daily' },
  { c: 'dayTradeRatio',    kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'marginShort',      kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'taifexPositions',  kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'bookDepth',        kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'volAvg20',         kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'premarketBrief',   kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'morningNote',      kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'dailyPost',        kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'globalMarkets',    kind: 'latest',  maxStale: 12 * HOUR, session: 'always' },
  { c: 'adrPremium',       kind: 'latest',  maxStale: 12 * HOUR, session: 'always' },
  { c: 'etfPremium',       kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'etfInfluence',     kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'newsDigest',       kind: 'latest',  maxStale: 8 * HOUR,  session: 'always' },
  { c: 'newsDaily',        kind: 'dated',   maxStale: 30 * HOUR, session: 'daily' },
  { c: 'marketReports',    kind: 'dated',   maxStale: 30 * HOUR, session: 'daily' },   // 收盤盤勢分析（2026-08-01 事故後納管：曾停更2日無人察覺）

  // ── 低頻（週/月/季）──
  { c: 'revenue',          kind: 'latest',  maxStale: 40 * DAY,  session: 'always' },
  { c: 'dividendCalendar', kind: 'latest',  maxStale: 10 * DAY,  session: 'always' },
  { c: 'dividendStocks',   kind: 'latest',  maxStale: 10 * DAY,  session: 'always' },
  { c: 'majorHolders',     kind: 'latest',  maxStale: 14 * DAY,  session: 'always' },
  { c: 'lending',          kind: 'latest',  maxStale: 10 * DAY,  session: 'always' },
  { c: 'peerComps',        kind: 'latest',  maxStale: 10 * DAY,  session: 'always' },
  { c: 'catalystCalendar', kind: 'latest',  maxStale: 10 * DAY,  session: 'always' },
  { c: 'modelCore',        kind: 'latest',  maxStale: 40 * DAY,  session: 'always' },
  // themeMap 用 seed/custom 兩個 doc，沒有 latest —— 先前報 MISSING 是契約寫錯，不是資料缺
  { c: 'themeMap',         kind: 'latest',  maxStale: 40 * DAY,  session: 'always', docId: 'seed' },
  { c: 'system',           kind: 'latest',  maxStale: 30 * HOUR, session: 'always', docId: 'tradingCalendar' },
];

/**
 * 外部資料源自報日期探測。
 *
 * 實測（2026-07-31）：openapi.twse.com.tw 這個鏡像**整批固定落後一個交易日** ——
 * MI_INDEX / BWIBBU_ALL / STOCK_DAY_ALL / t187ap03_L / t187ap41_L 全部差 1 天。
 * 而 MI_MARGN 與 SBL/TWT96U **連日期欄位都沒有**，無法驗證。
 * 這不是偶發抖動，是這個鏡像的固定性質 —— 任何新的消費端都必須假設它是舊的。
 */
const EXTERNAL_PROBES = [
  { name: '指數收盤',  url: 'https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX',      dateKeys: ['日期'] },
  { name: '個股收盤',  url: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', dateKeys: ['日期', 'Date'] },
  // 註：TWT48U_ALL 是**除權息預告表**，它的 Date 是「未來的除權息日」不是資料日 ——
  //     先前一度把 2026-08-05 讀成「落後 -5 天」，那是誤判，已移出探測清單。
  { name: '殖利率',    url: 'https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL',    dateKeys: ['日期', 'Date'] },
  { name: '公司基本',  url: 'https://openapi.twse.com.tw/v1/opendata/t187ap03_L',          dateKeys: ['出表日期'] },
  { name: '融資融券', url: 'https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN',       dateKeys: ['日期', 'Date'] },
  { name: '借券',      url: 'https://openapi.twse.com.tw/v1/SBL/TWT96U',                   dateKeys: ['日期', 'Date'] },
];

// 已改用的「可指定日期＋會回音」端點 —— 這些才是生產路徑，openapi 只留著當對照組，
// 證明「換掉是對的」而不是憑感覺。topLevel=true 代表日期在回應的最上層而非資料列。
const FRESH_PROBES = [
  { name: '融資融券(rwd)', url: d => `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${d}&selectType=ALL&response=json`, from: 'field' },
  // forward：「當日可借券」公布的是**下一個交易時段**的額度，傍晚就滾動 ——
  //          資料日 >= 最近交易日即為健康，用 === 會每晚誤報。
  { name: '借券(rwd)',     url: d => `https://www.twse.com.tw/rwd/zh/marginTrading/TWT96U?date=${d}&response=json`,                  from: 'title', mode: 'forward' },
  { name: '法人T86(rwd)',  url: d => `https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${d}&selectType=ALL`,               from: 'field' },
  { name: '指數(rwd)',     url: d => `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${d}&type=IND&response=json`,        from: 'field' },
  { name: '殖利率(rwd)',   url: d => `https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_ALL?date=${d}&response=json`,               from: 'field' },
];

function ymdFromTitle(t) {
  const m = String(t || '').match(/(\d{2,3})年(\d{1,2})月(\d{1,2})日/);
  return m ? `${+m[1] + 1911}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}` : null;
}

async function probeFresh(ltd) {
  const want = ltd.replace(/-/g, '');
  const out = [];
  for (const p of FRESH_PROBES) {
    try {
      const r = await fetch(p.url(want), { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.twse.com.tw/' }, signal: AbortSignal.timeout(20000) });
      const t = await r.text();
      if (t.trim().startsWith('<')) { out.push({ name: p.name, status: 'ERROR', note: '回傳 HTML' }); continue; }
      const j = JSON.parse(t);
      const n = (j.data || []).length || (j.tables || []).reduce((s2, x) => s2 + (x.data || []).length, 0);
      const feedDate = p.from === 'title' ? ymdFromTitle(j.title) : normDate(j.date);
      const ok = p.mode === 'forward' ? (feedDate != null && feedDate >= ltd) : feedDate === ltd;
      out.push({ name: p.name, records: n, feedDate, status: ok ? 'OK' : 'MISMATCH', note: ok ? (p.mode === 'forward' && feedDate > ltd ? `前瞻至 ${feedDate}（正常）` : '') : `自報 ${feedDate} ${p.mode === 'forward' ? '早於' : '≠'} ${ltd}` });
    } catch (e) { out.push({ name: p.name, status: 'ERROR', note: (e.message || '').slice(0, 40) }); }
  }
  return out;
}

function normDate(v) {
  const s = String(v || '');
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
  if (/^\d{7}$/.test(s)) return `${+s.slice(0, 3) + 1911}-${s.slice(3, 5)}-${s.slice(5)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

async function probeExternal(ltd) {
  const out = [];
  for (const p of EXTERNAL_PROBES) {
    try {
      const r = await fetch(p.url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) { out.push({ ...p, status: 'ERROR', note: `HTTP ${r.status}` }); continue; }
      const j = await r.json();
      const n = Array.isArray(j) ? j.length : 0;
      const row = n ? j[0] : {};
      const key = p.dateKeys.find(k => row[k] != null);
      const feedDate = key ? normDate(row[key]) : null;
      if (!feedDate) { out.push({ name: p.name, records: n, feedDate: null, status: 'NO_DATE', note: '無日期欄位＝無法驗證' }); continue; }
      const stale = feedDate < ltd;
      out.push({ name: p.name, records: n, feedDate, status: stale ? 'LAGGING' : 'OK', note: stale ? `落後至 ${feedDate}（最近交易日 ${ltd}）` : '' });
    } catch (e) { out.push({ name: p.name, status: 'ERROR', note: (e.message || '').slice(0, 40) }); }
  }
  return out;
}

const taipeiNow = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));

/**
 * 盤中類的 maxStale 只在**交易時段內**適用。
 * 收盤後那些 doc 本來就不會再更新，套 10 分鐘上限等於保證誤報 ——
 * 這正是 wm-freshness 說的「狀態階梯」要分 session，否則監控自己會變成雜訊來源。
 * 收盤後改用「當日內」判定（30 小時），只要資料日對就算健康。
 */
function effectiveMaxStale(spec, marketOpen, tradingToday) {
  if (spec.session === 'intraday') return marketOpen ? spec.maxStale : 30 * HOUR;
  // daily 類在非交易日（週末/假日）放寬到 78h——週五收盤產物到週日必然超過 30h，
  // 不放寬的話每個週末稽核都是假警報，監控又變雜訊來源。
  if (spec.session === 'daily' && !tradingToday) return Math.max(spec.maxStale, 78 * HOUR);
  return spec.maxStale;
}
const isoOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 最近一個交易日（用 system/tradingCalendar；抓不到就只擋週末） */
async function lastTradingDay() {
  let holidays = new Set();
  try {
    const d = (await db.collection('system').doc('tradingCalendar').get()).data();
    if (Array.isArray(d?.holidays)) holidays = new Set(d.holidays);
  } catch { /* fail-open */ }
  const t = taipeiNow();
  // 13:30 收盤前，「最近一個完整交易日」是前一天
  if (t.getHours() * 60 + t.getMinutes() < 13 * 60 + 30) t.setDate(t.getDate() - 1);
  for (let i = 0; i < 15; i++) {
    const iso = isoOf(t);
    if (t.getDay() !== 0 && t.getDay() !== 6 && !holidays.has(iso)) return iso;
    t.setDate(t.getDate() - 1);
  }
  return isoOf(taipeiNow());
}

function pickTimestamp(d) {
  for (const k of ['updatedAt', 'at', 'generatedAt', 'fetchedAt', 'topupAt']) {
    const v = d?.[k];
    if (typeof v === 'number' && v > 1e12) return v;
    if (typeof v === 'string') { const t = Date.parse(v); if (!Number.isNaN(t)) return t; }
    if (v?.toMillis) return v.toMillis();
  }
  return null;
}

function pickCount(d, countField) {
  if (countField && d?.[countField]) {
    const raw = d[countField];
    if (typeof raw === 'string') { try { return Object.keys(JSON.parse(raw)).length; } catch { return null; } }
    if (typeof raw === 'object') return Object.keys(raw).length;
  }
  for (const k of ['items', 'picks', 'rows', 'list', 'stocks', 'cats']) {
    if (Array.isArray(d?.[k])) return d[k].length;
  }
  if (typeof d?.count === 'number') return d.count;
  if (typeof d?.n === 'number') return d.n;
  return null;
}

/** 從 doc 內容找出「這批資料代表哪一天」 */
function pickDataDate(d, dateField) {
  // 別名：專案裡同一個語意用過 5 種欄位名。改稽核器認得它們，
  // 比改欄位名去破壞既有消費端划算（wm-data-accuracy「三層 fallback 身分」）。
  const raw = dateField ? d?.[dateField]
    : (d?.date ?? d?.dataDate ?? d?.tradeDate ?? d?.lastDate ?? d?.latestDate ?? d?.endDate);
  if (!raw) return null;
  const s = String(raw);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;   // 20260731
  if (/^\d{7}$/.test(s)) return `${+s.slice(0, 3) + 1911}-${s.slice(3, 5)}-${s.slice(5)}`; // 民國
  return null;
}

async function auditOne(spec, ltd, marketOpen, tradingToday) {
  const out = { collection: spec.c, status: 'OK', notes: [] };
  try {
    let data = null, docId = null;

    if (spec.kind === 'latest') {
      docId = spec.docId || 'latest';
      data = (await db.collection(spec.c).doc(docId).get()).data() || null;
    } else if (spec.kind === 'dated') {
      const s = await db.collection(spec.c).orderBy('date', 'desc').limit(1).get();
      if (!s.empty) { data = s.docs[0].data(); docId = s.docs[0].id; }
    } else if (spec.kind === 'perCode') {
      const s = await db.collection(spec.c).get();
      const dates = {};
      s.forEach(x => { const v = x.data()?.[spec.dateField || 'lastDate']; if (v) dates[v] = (dates[v] || 0) + 1; });
      const newest = Object.keys(dates).sort().pop() || null;
      out.records = s.size;
      out.dataDate = newest;
      out.spread = Object.keys(dates).length;
      if (out.spread > 3) out.notes.push(`日期分歧 ${out.spread} 種（最新 ${newest}）`);
      data = { __perCode: true };
    }

    if (!data) { out.status = 'MISSING'; out.notes.push(`doc 不存在（${docId || 'n/a'}）`); return out; }

    if (spec.kind !== 'perCode') {
      out.docId = docId;
      const ts = pickTimestamp(data);
      out.ageMin = ts ? Math.round((Date.now() - ts) / MIN) : null;
      out.records = pickCount(data, spec.countField);
      out.dataDate = pickDataDate(data, spec.dateField);
      if (ts == null) out.notes.push('無時間戳（不符新鮮度契約：缺 fetchedAt）');
      else {
        const limit = effectiveMaxStale(spec, marketOpen, tradingToday);
        if (Date.now() - ts > limit) {
          out.status = 'STALE';
          const fmt = ms => (ms >= HOUR ? `${Math.round(ms / HOUR)}h` : `${Math.round(ms / MIN)}m`);
          out.notes.push(`陳舊 ${fmt(Date.now() - ts)}（上限 ${fmt(limit)}${spec.session === 'intraday' && !marketOpen ? '·收盤後放寬' : ''}）`);
        }
      }
    }

    if (spec.minRecords != null && out.records != null && out.records < spec.minRecords) {
      out.status = out.status === 'OK' ? 'THIN' : out.status;
      out.notes.push(`筆數 ${out.records} < 下限 ${spec.minRecords}`);
    }
    if (out.records === 0 && !spec.allowEmpty) { out.status = 'EMPTY'; out.notes.push('筆數 0'); }

    // 第三道閘門：dataDate 漂移
    if (out.dataDate && spec.session !== 'always') {
      if (out.dataDate < ltd) {
        out.status = 'DATE_DRIFT';
        out.notes.push(`資料日 ${out.dataDate} < 最近交易日 ${ltd}`);
      }
    }
    if (!out.dataDate && spec.session === 'daily') out.notes.push('無資料日欄位（無法偵測日期漂移）');
  } catch (e) {
    out.status = 'ERROR';
    out.notes.push((e.message || '').slice(0, 60));
  }
  return out;
}

async function main() {
  const ltd = await lastTradingDay();
  const t = taipeiNow();
  const mins = t.getHours() * 60 + t.getMinutes();
  const marketOpen = t.getDay() !== 0 && t.getDay() !== 6
    && isoOf(t) !== null && mins >= 8 * 60 + 30 && mins <= 13 * 60 + 40
    && ltd === isoOf(t);
  const specs = ONLY ? CONTRACTS.filter(s => s.c === ONLY) : CONTRACTS;
  const results = [];
  const tradingToday = ltd === isoOf(taipeiNow());
  for (const s of specs) results.push(await auditOne(s, ltd, marketOpen, tradingToday));

  const external = NO_EXT ? [] : await probeExternal(ltd);
  const fresh = NO_EXT ? [] : await probeFresh(ltd);

  if (WRITE) {
    const badN = results.filter(r => r.status !== 'OK').length;
    const extBad = external.filter(r => r.status !== 'OK').length;
    await db.collection('system').doc('dataHealth').set({
      updatedAt: Date.now(), date: ltd,
      total: results.length, healthy: results.length - badN, unhealthy: badN,
      externalTotal: external.length, externalUnhealthy: extBad,
      results, external, fresh,
    });
    console.log(`[audit] ✓ 已寫入 system/dataHealth（內部異常 ${badN}、外部異常 ${extBad}）`);
  }

  if (AS_JSON) { console.log(JSON.stringify({ lastTradingDay: ltd, results, external }, null, 2)); process.exit(0); }

  const RANK = { ERROR: 0, MISSING: 1, EMPTY: 2, DATE_DRIFT: 3, STALE: 4, THIN: 5, OK: 9 };
  results.sort((a, b) => (RANK[a.status] ?? 8) - (RANK[b.status] ?? 8) || a.collection.localeCompare(b.collection));

  console.log(`\n稽核基準：最近一個完整交易日 = ${ltd}｜盤中時段 = ${marketOpen ? '是' : '否（盤中類 maxStale 放寬）'}\n`);
  const bad = results.filter(r => r.status !== 'OK');
  for (const r of results) {
    const icon = r.status === 'OK' ? '✅' : r.status === 'THIN' ? '🟡' : '❌';
    const age = r.ageMin != null ? `${r.ageMin < 90 ? r.ageMin + 'm' : Math.round(r.ageMin / 60) + 'h'}` : '—';
    const rec = r.records != null ? String(r.records) : '—';
    console.log(`${icon} ${r.collection.padEnd(22)} ${r.status.padEnd(11)} age=${age.padEnd(6)} n=${rec.padEnd(6)} date=${(r.dataDate || '—').padEnd(11)} ${r.notes.join('；')}`);
  }
  if (fresh.length) {
    console.log('\n── 生產路徑（可指定日期＋回音驗證）──');
    for (const e of fresh) {
      const icon = e.status === 'OK' ? '✅' : '❌';
      console.log(`${icon} ${e.name.padEnd(14)} ${e.status.padEnd(9)} n=${String(e.records ?? '—').padEnd(6)} date=${(e.feedDate || '—').padEnd(11)} ${e.note}`);
    }
  }
  if (external.length) {
    console.log('\n── openapi 鏡像對照組（已知落後，不是生產路徑）──');
    for (const e of external) {
      const icon = e.status === 'OK' ? '✅' : e.status === 'NO_DATE' ? '🟡' : '❌';
      console.log(`${icon} ${e.name.padEnd(10)} ${String(e.status).padEnd(9)} n=${String(e.records ?? '—').padEnd(6)} date=${(e.feedDate || '—').padEnd(11)} ${e.note}`);
    }
  }
  console.log(`\n總計 ${results.length} 個資料源：正常 ${results.length - bad.length}、需處理 ${bad.length}`);
  const byStatus = {};
  bad.forEach(r => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });
  if (bad.length) console.log('  ' + Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join('、'));
  process.exit(0);
}

main().catch(e => { console.error('[audit] 失敗:', e.message); process.exit(1); });
