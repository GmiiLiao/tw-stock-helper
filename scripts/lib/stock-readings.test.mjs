// 個股判讀（寫死值改真實判讀）純函式單元測試：node --test scripts/lib/stock-readings.test.mjs
// 不連網：直接載入 src/lib/stock-readings.ts（零 import、只有可剝除的型別註記，Node 25 內建型別剝除可直接載入）。
// 規格：hardcoded-to-real-spec（2026-10-08 定稿）F1、F6、F7、F9、F11、F12、F14、§1.4、§1.9。
// F1 的三檔真實值取自 2026-10-08 Firestore 唯讀（只存三檔的 f20／t20／avg 與全表比值的 0～100 分位點，不存整份文件）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const lib = await import(new URL('../../src/lib/stock-readings.ts', import.meta.url).href);

// ── 交易日曆 fixture（照 system/tradingCalendar 實查：10 月休市 10-09、10-10、10-25、10-26）──
const HOLIDAYS = new Set(['2026-10-09', '2026-10-10', '2026-10-25', '2026-10-26']);
const isTradingYmd = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow !== 0 && dow !== 6 && !HOLIDAYS.has(ymd);
};
const CTX = (over = {}) => ({ todayYmd: '2026-10-08', isTradingYmd, isEsb: false, degraded: false, ...over });

// ── F1 合成表 ──
const CHAR_WRITTEN_MS = Date.UTC(2026, 9, 8, 9, 21);   // 10-08 17:21 台北
const VOL_WRITTEN_MS = Date.UTC(2026, 9, 8, 1, 0);     // 10-08 09:00 台北
function tableFrom(rows, { dailyYmd = '2026-10-08', charYmd = '2026-10-08', volYmd = '2026-10-08' } = {}) {
  const charByCode = {};
  const avgByCode = {};
  for (const [code, f20, t20, avg, extra] of rows) {
    charByCode[code] = { f20, t20, d20: 0, fStreak: 0, tStreak: 0, dStreak: 0, ...(extra || {}) };
    if (avg != null) avgByCode[code] = avg;
  }
  return lib.buildInstFlowTable({ charByCode, charYmd, charWrittenMs: CHAR_WRITTEN_MS, avgByCode, volYmd, volWrittenMs: VOL_WRITTEN_MS, dailyYmd });
}
/** n 檔填充（代號 1100 起，跳過 00／01／91 前綴），比值 0..n-1 遞增；avg=100、f20=比值×100 */
function fillerRows(n, start = 0) {
  const out = [];
  let code = 1100;
  for (let i = 0; i < n; i++) {
    while (/^(00|01|91)/.test(String(code)) || ['9929', '2330', '6488'].includes(String(code))) code++;
    out.push([String(code), (start + i) * 100, 0, 100]);
    code++;
  }
  return out;
}

test('F1 百分位：中位並列、門檻 80／79／20／21', () => {
  // 1,600 檔填充比值 0..1599（P 依位置），另加測試檔
  const rows = fillerRows(1600);
  const t = tableFrom(rows);
  assert.equal(t.n, 1600);
  // 比值 1279 的那檔：小於它 1279 檔、等於 1 檔 ⇒ P=round(100×1279.5/1600)=80
  const code80 = rows[1279][0];
  const r80 = lib.instFlowReading(t, code80, CTX());
  assert.equal(r80.state, 'up');
  assert.equal(r80.stateText, '偏買超');
  const code79 = rows[1263][0];   // P=round(100×1263.5/1600)=79
  assert.equal(lib.instFlowReading(t, code79, CTX()).state, 'neutral');
  const code20 = rows[319][0];    // P=round(100×319.5/1600)=20
  const r20 = lib.instFlowReading(t, code20, CTX());
  assert.equal(r20.state, 'down');
  assert.equal(r20.stateText, '偏賣超');
  const code21 = rows[336][0];    // P=round(100×336.5/1600)=21
  assert.equal(lib.instFlowReading(t, code21, CTX()).state, 'neutral');
  assert.match(r80.value, /^第 80 百分位/);
});

test('F1 並列值取中位百分位', () => {
  // 1,500 檔全部同比值 ⇒ 每檔 P = round(100 × 0.5×1500/1500) = 50
  const rows = [];
  let code = 1100;
  for (let i = 0; i < 1500; i++) { while (/^(00|01|91)/.test(String(code))) code++; rows.push([String(code), 50, 0, 100]); code++; }
  const t = tableFrom(rows);
  const r = lib.instFlowReading(t, rows[0][0], CTX());
  assert.match(r.value, /^第 50 百分位/);
  assert.equal(r.state, 'neutral');
  assert.equal(r.stateText, '無明顯偏向');
});

test('F1 母體外：ETF／存託憑證／興櫃／非四碼 ⇒ outside；查無 ⇒ none；avg=0 ⇒ none', () => {
  const rows = [...fillerRows(1600), ['0050', -406782, 26939, 74863], ['9103', -845, 0, 290], ['5555', 10, 0, 0]];
  const t = tableFrom(rows);
  const etf = lib.instFlowReading(t, '0050', CTX());
  assert.equal(etf.state, 'outside');
  assert.equal(etf.stateText, '不在比較母體（ETF）');
  assert.equal(etf.value, null);
  const dr = lib.instFlowReading(t, '9103', CTX());
  assert.equal(dr.state, 'outside');
  assert.equal(dr.stateText, '不在比較母體（存託憑證）');
  const esb = lib.instFlowReading(t, '7930', CTX({ isEsb: true }));
  assert.equal(esb.state, 'outside');
  assert.equal(esb.stateText, '不在比較母體（興櫃）');
  const odd = lib.instFlowReading(t, '2881A', CTX());
  assert.equal(odd.state, 'outside');
  assert.equal(odd.stateText, '不在比較母體（非四碼普通股）');
  const missing = lib.instFlowReading(t, '4444', CTX());
  assert.equal(missing.state, 'none');
  assert.equal(missing.stateText, '尚無判讀結果');
  assert.equal(missing.value, null);
  const zeroAvg = lib.instFlowReading(t, '5555', CTX());
  assert.equal(zeroAvg.state, 'none');
  assert.equal(t.n, 1600, 'avg=0、ETF、存託憑證不進母體');
});

test('F1 母體不完整 ⇒ thin；表讀取失敗 ⇒ unavailable（不得寫成尚無判讀結果）', () => {
  const t = tableFrom(fillerRows(1200));
  const thin = lib.instFlowReading(t, '1100', CTX());
  assert.equal(thin.state, 'thin');
  assert.match(thin.stateText, /比較母體不完整（n=1200）/);
  assert.equal(thin.value, null);
  const un = lib.instFlowReading(null, '2330', CTX());
  assert.equal(un.state, 'unavailable');
  assert.equal(un.stateText, '暫時無法取得');
  assert.notEqual(un.stateText, '尚無判讀結果');
  assert.equal(un.value, null);
});

test('F1 降級模式：none、hint 說資料已存在，不寫「沒有本檔」「涵蓋範圍」', () => {
  const r = lib.instFlowReading(null, '2330', CTX({ degraded: true }));
  assert.equal(r.state, 'none');
  assert.equal(r.stateText, '尚無判讀結果');
  assert.match(r.hint, /資料已存在/);
  assert.doesNotMatch(r.hint, /沒有本檔|涵蓋範圍/);
});

test('F1 過期（真實日曆：休市 10-09、10-10，週末 10-11）', () => {
  assert.equal(lib.tradingLag('2026-10-08', '2026-10-12', isTradingYmd), 1);
  assert.equal(lib.tradingLag('2026-10-08', '2026-10-13', isTradingYmd), 2);
  assert.equal(lib.tradingLag('2026-10-08', '2026-10-10', isTradingYmd), 0);
  assert.equal(lib.tradingLag('2026-10-08', '2026-10-08', isTradingYmd), 0);
  const rows = fillerRows(1600);
  const t = tableFrom(rows);
  const c = rows[800][0];
  assert.equal(lib.instFlowReading(t, c, CTX({ todayYmd: '2026-10-12' })).stale, false);
  const st = lib.instFlowReading(t, c, CTX({ todayYmd: '2026-10-13' }));
  assert.equal(st.stale, true);
  assert.match(st.stateText, /^⚠ 10-08 資料，未更新/);
  assert.match(st.hint, /資料落後 2 個交易日/);
  assert.equal(lib.instFlowReading(t, c, CTX({ todayYmd: '2026-10-10' })).stale, false);
});

test('F1 資料日核對閘門', () => {
  const rows = fillerRows(1600);
  const ahead = tableFrom(rows, { dailyYmd: '2026-10-09' });
  const r = lib.instFlowReading(ahead, rows[800][0], CTX());
  assert.equal(r.stale, true);
  assert.match(r.stateText, /逐日籌碼已到 10-09/);
  assert.match(r.stateText, /法人 20 日累計截至 10-08/);
  const unknown = tableFrom(rows, { dailyYmd: null });
  const u = lib.instFlowReading(unknown, rows[800][0], CTX());
  assert.equal(u.stale, false);
  assert.match(u.basis, /未能核對/);
  const behind = tableFrom(rows, { dailyYmd: '2026-10-07' });
  const b = lib.instFlowReading(behind, rows[800][0], CTX());
  assert.equal(b.stale, false);
  assert.match(b.basis, /未能核對/);
});

test('F1 文案：caveat 限定 5～20 日、basis 不含集合名、明細行', () => {
  const rows = [...fillerRows(1600), ['2330', -36491, 1938, 21328, { d20: 7655, fStreak: -3, tStreak: 8 }]];
  const t = tableFrom(rows);
  const r = lib.instFlowReading(t, '2330', CTX());
  assert.equal(r.label, '法人籌碼動向（描述）');
  assert.match(r.caveat, /5～20 日/);
  assert.match(r.caveat, /無預測力/);
  assert.doesNotMatch(r.caveat, /法人買賣超沒有預測力/);
  assert.match(r.hint, /外資 -36,491 張｜投信 \+1,938｜自營 \+7,655（自營不計入）/);
  assert.match(r.hint, /外資連賣 3 日、投信連買 8 日/);
  // 「當日籌碼判讀見頁首」只在個股頁成立（趨勢面板沒有頁首籌碼判讀）⇒ 不在共用 hint（個股頁以 ReadingRow note 附註）
  assert.doesNotMatch(r.hint, /頁首/);
  assert.match(r.basis, /本站法人買賣超彙整/);
  assert.match(r.basis, /10-08 17:21 計算/);
  assert.match(r.basis, /1601 檔上市櫃普通股/);
  assert.equal(r.dataDate, '2026-10-08');
  assert.equal(r.palette, 'market');
  for (const s of [r.hint, r.basis, r.caveat, r.stateText, r.label, r.value]) {
    assert.doesNotMatch(s, /看好|chipCharacter|volAvg20|chipDaily/);
  }
  // 連續日數為 0 寫「無連續」
  const rows2 = [...fillerRows(1600), ['9929', -9, 0, 68, { d20: 10, fStreak: -2, tStreak: 0 }]];
  const r2 = lib.instFlowReading(tableFrom(rows2), '9929', CTX());
  assert.match(r2.hint, /外資連賣 2 日、投信無連續/);
});

// 10-08 真實值（n=1,947）＋全表比值 0～100 分位點；合成 1,947 檔重現分布，三檔百分位容許 ±2
const REAL = { '9929': [-9, 0, 68, 44, 'neutral'], '2330': [-36491, 1938, 21328, 15, 'down'], '6488': [-13064, -2685, 12537, 19, 'down'] };
const QUANTILES = [-12.042,-5.9375,-4.8216,-4.4607,-4.0329,-3.5167,-3.2353,-2.9859,-2.7669,-2.5357,-2.3489,-2.1811,-2.0024,-1.8611,-1.7368,-1.636,-1.5472,-1.4403,-1.3259,-1.2587,-1.1935,-1.0953,-1.0196,-0.9744,-0.9104,-0.8421,-0.7912,-0.7503,-0.7,-0.6519,-0.6129,-0.5604,-0.5128,-0.4918,-0.4523,-0.4167,-0.3649,-0.3462,-0.3182,-0.2903,-0.25,-0.2273,-0.1935,-0.17,-0.1462,-0.1185,-0.0833,-0.0606,-0.0385,0,0,0.027,0.0569,0.0769,0.125,0.1481,0.1831,0.2153,0.26,0.3088,0.3409,0.375,0.4091,0.4518,0.4994,0.5363,0.5738,0.6341,0.6667,0.7188,0.7549,0.7917,0.8434,0.8824,0.9403,0.9897,1.0891,1.1382,1.1937,1.2699,1.3514,1.4302,1.504,1.5974,1.7115,1.8122,1.9115,2.0134,2.1261,2.25,2.4,2.5297,2.6658,2.9001,3.0587,3.2247,3.5044,3.8893,4.3482,4.9621,8.4845];
test('F1 10-08 真實三檔：9929 neutral（~44）、2330 down（~15）、6488 down（~19）', () => {
  const N = 1947 - 3;
  const rows = [];
  let code = 1100;
  for (let i = 0; i < N; i++) {
    while (/^(00|01|91)/.test(String(code)) || REAL[String(code)]) code++;
    const pos = (i / (N - 1)) * 100;
    const lo = Math.floor(pos), hi = Math.min(100, lo + 1);
    const ratio = QUANTILES[lo] + (QUANTILES[hi] - QUANTILES[lo]) * (pos - lo);
    rows.push([String(code), ratio * 1000, 0, 1000]);
    code++;
  }
  for (const [c, [f20, t20, avg]] of Object.entries(REAL)) rows.push([c, f20, t20, avg]);
  const t = tableFrom(rows);
  assert.equal(t.n, 1947);
  for (const [c, [, , , p, state]] of Object.entries(REAL)) {
    const r = lib.instFlowReading(t, c, CTX());
    assert.equal(r.state, state, c);
    const got = Number(/第 (\d+) 百分位/.exec(r.value)[1]);
    assert.ok(Math.abs(got - p) <= 2, `${c} P=${got} 期望 ${p}±2`);
  }
});

// ── F2–F5、F6、F8、F9 今晚無值的欄位 ──
test('F2 模型評等：無模型評等，不含 BUY／HOLD／買進', () => {
  const r = lib.model20Reading();
  assert.equal(r.state, 'none');
  assert.equal(r.stateText, '無模型評等');
  assert.equal(r.label, '模型評等（20 日）');
  assert.equal(r.value, null);
  assert.doesNotMatch(`${r.hint}${r.stateText}`, /BUY|HOLD|買進/);
  assert.match(r.hint, /不等於「持有」/);
});

test('F3 歷史同條件 20 日報酬分布：尚無判讀結果、不是目標價、無百分比', () => {
  const r = lib.dist20Reading();
  assert.equal(r.state, 'none');
  assert.equal(r.label, '歷史同條件 20 日報酬分布');
  assert.equal(r.stateText, '尚無判讀結果');
  assert.match(r.hint, /不是目標價/);
  assert.doesNotMatch(r.hint, /\d+(\.\d+)?%/);
});

test('F4 期限方向：研究中／研究中／尚無判讀結果', () => {
  const h = lib.horizonReadings();
  assert.equal(h.horizonShort.state, 'research');
  assert.equal(h.horizonShort.stateText, '研究中');
  assert.equal(h.horizonShort.label, '隔日方向');
  assert.equal(h.horizonMid.state, 'research');
  assert.equal(h.horizonMid.label, '5 日方向');
  assert.equal(h.horizonLong.state, 'none');
  assert.equal(h.horizonLong.stateText, '尚無判讀結果');
  assert.equal(h.horizonLong.label, '20 日以上方向');
});

test('F5 新聞判讀、F6 觸及率、F8 落入率、F9 明日方向：今晚無值', () => {
  assert.equal(lib.newsDirReading().state, 'none');
  const hit = lib.hitReadings();
  assert.equal(hit.hitHigh.state, 'none');
  assert.equal(hit.hitLow.state, 'none');
  assert.match(hit.hitHigh.hint, /信心度 72／58」沒有依據，已移除/);
  assert.equal(hit.hitHigh.palette, 'rate');
  const o = lib.openRangeReading();
  assert.equal(o.state, 'none');
  assert.match(o.hint, /不是方向/);
  const n = lib.nextDayDirReading();
  assert.equal(n.state, 'research');
  assert.equal(n.stateText, '研究中');
  assert.match(n.hint, /不提供「買進／暫緩」建議/);
  for (const r of [lib.newsDirReading(), hit.hitHigh, hit.hitLow, o, n]) {
    assert.equal(r.value, null);
    assert.doesNotMatch(r.hint, /\d+(\.\d+)?%/, `${r.key} 無值時 hint 不得有百分比`);
  }
});

// ── F6 basis ──
test('F6 basisText：今收＋高低差，不含昨收／ATR／振幅', () => {
  const b = lib.basisText(100, 3.2);
  assert.match(b, /今收/);
  assert.match(b, /高低差/);
  assert.doesNotMatch(b, /昨收|ATR|振幅/);
  const low = lib.basisText(100, 1.0);
  assert.match(low, /低於 1.5% 時以 1.5% 計/);
  const miss = lib.basisText(100, null);
  assert.match(miss, /今日高低價未提供，以 1.5% 計/);
  const intra = lib.basisText(100, 3.2, { phase: 'intraday', quoteAsOfMs: Date.UTC(2026, 9, 12, 2, 32) });
  assert.match(intra, /目前價/);
  assert.match(intra, /10:32/);
  assert.doesNotMatch(intra, /今收/);
});

// ── §1.9 closePosOf ──
test('closePosOf：一價非漲停 null、一字漲停 1、現價出界 null、缺高低 null', () => {
  assert.equal(lib.closePosOf(10, 10, 10, 9.5, null), null);
  assert.equal(lib.closePosOf(10.45, 10.45, 10.45, 9.5, 'up'), 1);
  assert.equal(lib.closePosOf(8.55, 8.55, 8.55, 9.5, 'down'), 0);
  assert.equal(lib.closePosOf(12, 11, 10, 10.5, null), null);
  assert.equal(lib.closePosOf(10, 0, 0, 9.5, null), null);
  assert.equal(lib.closePosOf(10, 9, 11, 9.5, null), null, 'high<low');
  assert.equal(lib.closePosOf(10.5, 11, 10, 10.2, null), 0.5);
});

// ── §1.9 quoteContextOf ──
test('quoteContextOf：興櫃 quote／盤中 intraday／收盤 close／fallback 資料日', () => {
  const esb = lib.quoteContextOf({ snapFresh: true, snapDataYmd: '2026-10-08', snapMarketOpen: true, snapSweepMs: 1, rowYmd: null, rowMarket: 'esb' });
  assert.deepEqual(esb, { dataDate: null, phase: 'quote', quoteAsOfMs: null });
  const intra = lib.quoteContextOf({ snapFresh: true, snapDataYmd: '2026-10-12', snapMarketOpen: true, snapSweepMs: 123, rowYmd: '2026-10-08', rowMarket: 'tse' });
  assert.deepEqual(intra, { dataDate: '2026-10-12', phase: 'intraday', quoteAsOfMs: 123 });
  const close = lib.quoteContextOf({ snapFresh: true, snapDataYmd: '2026-10-08', snapMarketOpen: false, snapSweepMs: 456, rowYmd: '2026-10-07', rowMarket: 'otc' });
  assert.deepEqual(close, { dataDate: '2026-10-08', phase: 'close', quoteAsOfMs: 456 });
  const fb = lib.quoteContextOf({ snapFresh: false, snapDataYmd: '2026-10-12', snapMarketOpen: true, snapSweepMs: 1, rowYmd: '2026-10-08', rowMarket: 'tse' });
  assert.deepEqual(fb, { dataDate: '2026-10-08', phase: 'close', quoteAsOfMs: null });
  const fbNull = lib.quoteContextOf({ snapFresh: false, snapDataYmd: null, snapMarketOpen: false, snapSweepMs: null, rowYmd: null, rowMarket: 'tse' });
  assert.equal(fbNull.dataDate, null);
});

// ── F7 收盤位置 ──
test('F7 closePosReading：貼近日高不是延續訊號、附稽核 basis', () => {
  const r = lib.closePosReading(0.92, { limit: null, phase: 'close', quoteAsOfMs: null, dataDate: '2026-10-08', auditOutside: null });
  assert.equal(r.state, 'neutral');
  assert.equal(r.palette, 'rate');
  assert.equal(r.stateText, '貼近日高');
  assert.equal(r.value, '日內 92%');
  assert.match(r.hint, /不是延續訊號/);
  assert.doesNotMatch(r.hint, /機率高/);
  assert.match(r.basis, /480/);
  assert.match(r.basis, /隔日開盤/);
  assert.match(r.basis, /數字不列|不列數字/);
});

test('F7 盤中：value／stateText 不含「收」、不套稽核方向', () => {
  const r = lib.closePosReading(0.92, { limit: null, phase: 'intraday', quoteAsOfMs: Date.UTC(2026, 9, 12, 2, 32), dataDate: '2026-10-12' });
  assert.doesNotMatch(`${r.value}${r.stateText}${r.label}`, /收/);
  assert.match(r.stateText, /盤中位置（10:32）/);
  assert.doesNotMatch(r.hint, /最差|相對最佳/);
  assert.match(r.hint, /收盤前會變/);
});

test('F7 漲跌停不套稽核、缺值寫資料不足、興櫃只描述位置、分段', () => {
  const up = lib.closePosReading(1, { limit: 'up', phase: 'close', quoteAsOfMs: null, dataDate: '2026-10-08' });
  assert.equal(up.stateText, '收漲停');
  assert.doesNotMatch(up.hint, /最差/);
  const down = lib.closePosReading(0.1, { limit: 'down', phase: 'close', quoteAsOfMs: null, dataDate: '2026-10-08' });
  assert.equal(down.stateText, '收跌停');
  assert.doesNotMatch(down.hint, /相對最佳/);
  const nil = lib.closePosReading(null, { limit: null, phase: 'close', quoteAsOfMs: null, dataDate: '2026-10-08' });
  assert.equal(nil.value, null);
  assert.equal(nil.stateText, '收盤位置資料不足');
  assert.match(nil.hint, /不以 50 代替/);
  const low = lib.closePosReading(0.1, { limit: null, phase: 'close', quoteAsOfMs: null, dataDate: '2026-10-08', auditOutside: null });
  assert.equal(low.stateText, '日線下半段');
  assert.match(low.hint, /不是買進訊號/);
  assert.match(low.basis, /480/);
  assert.equal(lib.closePosReading(0.75, { limit: null, phase: 'close', dataDate: null }).stateText, '偏高');
  assert.equal(lib.closePosReading(0.55, { limit: null, phase: 'close', dataDate: null }).stateText, '中段偏高');
  const mid = lib.closePosReading(0.35, { limit: null, phase: 'close', dataDate: null, auditOutside: null });
  assert.equal(mid.stateText, '中段偏低');
  assert.match(mid.hint, /中段沒有結論/);
  const esb = lib.closePosReading(0.9, { limit: null, phase: 'quote', dataDate: null });
  assert.doesNotMatch(`${esb.value}${esb.stateText}${esb.label}`, /收/);
  assert.match(esb.hint, /興櫃無漲跌幅限制/);
  assert.doesNotMatch(esb.hint, /最差/);
});

// ── F9 今日走勢 ──
const BAD_WORDS = /建議|買進|暫緩進場/;
test('F9 todayMoveOf：收跌停／盤中不含收／小跌／小漲／大漲共用 EDGES', () => {
  const d = lib.todayMoveOf(-9.97, { limit: 'down', phase: 'close', tradeValue: 2.5e8, closePos: 0, dataDate: '2026-10-08', quoteAsOfMs: null });
  assert.equal(d.label, '收跌停');
  assert.equal(d.kind, 'limit_down');
  assert.equal(d.tone, 'down');
  assert.match(d.text, /^10-08 收跌停（-9\.97%），成交值 2\.5 億元，收盤位於日內 0%。$/);
  const i = lib.todayMoveOf(-9.97, { limit: 'down', phase: 'intraday', tradeValue: 2.5e8, closePos: 0, dataDate: '2026-10-12', quoteAsOfMs: Date.UTC(2026, 9, 12, 2, 32) });
  assert.match(i.label, /盤中/);
  assert.doesNotMatch(`${i.label}${i.text}`, /收/);
  assert.match(i.text, /盤中 10:32 暫定：在跌停價（-9\.97%）/);
  assert.match(i.text, /累計至此/);
  assert.equal(lib.todayMoveOf(-1.2, { limit: null, phase: 'close', dataDate: '2026-10-08' }).label, '小跌');
  assert.equal(lib.todayMoveOf(1.5, { limit: null, phase: 'close', dataDate: '2026-10-08' }).label, '小漲');
  assert.equal(lib.todayMoveOf(5.5, { limit: null, phase: 'close', dataDate: '2026-10-08' }).label, '大漲');
  assert.equal(lib.todayMoveOf(0.3, { limit: null, phase: 'close', dataDate: '2026-10-08' }).label, '平盤');
  // 平盤的色調跟著文字走（審查 LOW：+0.3% 寫「平盤」卻給紅色📈）
  assert.equal(lib.todayMoveOf(0.3, { limit: null, phase: 'close', dataDate: '2026-10-08' }).tone, 'flat');
  assert.equal(lib.todayMoveOf(-0.5, { limit: null, phase: 'intraday', dataDate: '2026-10-08' }).tone, 'flat');
  assert.equal(lib.todayMoveOf(0.51, { limit: null, phase: 'close', dataDate: '2026-10-08' }).tone, 'up');
  assert.equal(lib.todayMoveOf(-2, { limit: null, phase: 'close', dataDate: '2026-10-08' }).label, '下跌');
  assert.equal(lib.todayMoveOf(-5, { limit: null, phase: 'close', dataDate: '2026-10-08' }).label, '大跌');
  assert.equal(lib.todayMoveOf(2, { limit: null, phase: 'close', dataDate: '2026-10-08' }).label, '上漲');
  assert.deepEqual([...lib.TODAY_MOVE_EDGES], [5, 2, 0.5]);
});

test('F9 興櫃：不判漲跌停、不寫收、資料日與成交值未提供', () => {
  const big = lib.todayMoveOf(25, { limit: 'up', phase: 'quote', tradeValue: null, closePos: 0.6, dataDate: null });
  assert.equal(big.label, '興櫃 大漲');
  assert.doesNotMatch(`${big.label}${big.text}`, /漲停|鎖板|收/);
  assert.match(big.text, /資料日未提供/);
  assert.match(big.text, /成交值：來源未提供/);
  const twelve = lib.todayMoveOf(12, { limit: null, phase: 'quote', dataDate: null });
  assert.doesNotMatch(`${twelve.label}${twelve.text}`, /漲停|鎖板/);
  const nul = lib.todayMoveOf(-3, { limit: null, phase: 'close', dataDate: null, tradeValue: 1e9, closePos: 0.4 });
  assert.match(nul.text, /^資料日未提供：/);
  for (const m of [big, twelve, nul]) assert.doesNotMatch(`${m.label}${m.text}`, BAD_WORDS);
});

test('F9 文字不含建議／買進／暫緩進場（全段）', () => {
  for (const chg of [-10, -9.97, -6, -3, -1, 0, 1, 3, 6, 9.95, 10]) {
    for (const phase of ['close', 'intraday', 'quote']) {
      const limit = chg >= 9.9 ? 'up' : chg <= -9.9 ? 'down' : null;
      const m = lib.todayMoveOf(chg, { limit, phase, tradeValue: 1e9, closePos: 0.5, dataDate: '2026-10-08', quoteAsOfMs: 0 });
      assert.doesNotMatch(`${m.label}${m.text}`, BAD_WORDS);
      if (phase !== 'close') assert.doesNotMatch(`${m.label}${m.text}`, /收/);
    }
  }
});

// ── F11 參考停損 ──
test('F11 stopRefOf：跌幅 ≥5% 公式不適用；一般 ×0.95；漲 ≥5% ×0.93', () => {
  const a = lib.stopRefOf(90.04, 100);
  assert.equal(a.price, null);
  assert.match(a.note, /公式不適用/);
  assert.equal(a.label, '參考停損（進場前）');
  const b = lib.stopRefOf(98, 100);
  assert.ok(b.price < 98);
  assert.equal(b.price, 95);
  assert.equal(b.note, null);
  const c = lib.stopRefOf(106, 100);
  assert.equal(c.price, 93);
  assert.equal(c.basis, '昨收 × 0.95（今日漲幅 ≥5% 時 × 0.93）');
  const d = lib.stopRefOf(0, 0);
  assert.equal(d.price, null);
});

// ── F12 摘要與原因 ──
test('F12 summaryText／reasonsOf：依實際方向、對稱、跳空開低', () => {
  const s = lib.summaryText({ companyName: '秋雨', code: '9929', chgPct: -9.97, limit: 'down', phase: 'close', tradeValue: 2e8, closePos: 0, dataDate: '2026-10-08', quoteAsOfMs: null });
  assert.match(s, /收跌停/);
  assert.doesNotMatch(s, /上漲/);
  assert.match(s, /^秋雨（9929）/);
  const si = lib.summaryText({ companyName: '秋雨', code: '9929', chgPct: -9.97, limit: 'down', phase: 'intraday', tradeValue: 2e8, closePos: 0, dataDate: '2026-10-12', quoteAsOfMs: 0 });
  assert.doesNotMatch(si, /收/);
  const base = { close: 100, open: 0, prevClose: 95, limit: null, phase: 'close', tradeValue: 0, closePos: 0.5, quoteAsOfMs: null, dataDate: '2026-10-08' };
  const up = lib.reasonsOf({ ...base, chgPct: 5.5 });
  assert.match(up[0].title, /大漲/);
  assert.equal(lib.todayMoveOf(5.5, { limit: null, phase: 'close', dataDate: null }).label, '大漲');
  const dn = lib.reasonsOf({ ...base, chgPct: -5.5 });
  assert.match(dn[0].title, /大跌/);
  assert.equal(up[0].strength, dn[0].strength);
  const gap = lib.reasonsOf({ ...base, chgPct: -1, open: 96, prevClose: 100 });
  assert.ok(gap.some(r => /跳空開低/.test(r.title)));
  const gapUp = lib.reasonsOf({ ...base, chgPct: 1, open: 102, prevClose: 100 });
  assert.ok(gapUp.some(r => /跳空開高/.test(r.title)));
  const noOpen = lib.reasonsOf({ ...base, chgPct: 1, open: 0, prevClose: 100 });
  assert.ok(!noOpen.some(r => /跳空/.test(r.title)));
  const vol = lib.reasonsOf({ ...base, chgPct: 0.1, tradeValue: 6e9 });
  assert.ok(vol.some(r => r.title === '成交值 60.0 億元' && r.strength === 'weak'));
  const lowPos = lib.reasonsOf({ ...base, chgPct: 3, closePos: 0.2 });
  const lp = lowPos.find(r => /日線下半段/.test(r.title));
  assert.ok(lp);
  assert.doesNotMatch(lp.detail, /今日雖上漲/);
  const lim = lib.reasonsOf({ ...base, chgPct: -9.97, close: 12.3, limit: 'down', closePos: 0 });
  assert.equal(lim[0].title, '收跌停 12.30');
  assert.equal(lim[0].strength, 'strong');
  const limI = lib.reasonsOf({ ...base, chgPct: -9.97, close: 12.3, limit: 'down', closePos: 0, phase: 'intraday', quoteAsOfMs: 0 });
  assert.doesNotMatch(limI.map(r => r.title + r.detail).join(''), /收/);
  for (const r of [...up, ...dn, ...gap, ...vol, ...lowPos, ...lim]) {
    assert.ok(['strong', 'moderate', 'weak'].includes(r.strength));
    assert.ok(['price_action', 'volume', 'technical', 'industry', 'news'].includes(r.category));
    assert.doesNotMatch(r.title + r.detail, /主力|法人資金|後市|62%|今日溫和上漲/);
  }
});

// ── F14 產業別一行 ──
test('F14 industryLineOf：99 不稱官方、ETF／興櫃據實、兩碼代碼才稱官方產業代碼', () => {
  assert.doesNotMatch(lib.industryLineOf({ code: '99', name: '未分類', emoji: '🏢' }, { dataSource: 'none' }), /官方/);
  assert.equal(lib.industryLineOf({ code: '99', name: '未分類', emoji: '🏢' }, { dataSource: 'live' }), '產業別：來源未提供');
  const etf = lib.industryLineOf({ code: 'ETF', name: 'ETF', emoji: '📈' }, { dataSource: 'none' });
  assert.doesNotMatch(etf, /官方產業代碼/);
  assert.equal(etf, '📈 ETF（基金，無產業別）');
  assert.equal(lib.industryLineOf({ code: 'ESB', name: '興櫃', emoji: '🌱' }, { dataSource: 'none' }), '🌱 興櫃（官方產業別尚未接入）');
  assert.match(lib.industryLineOf({ code: '24', name: '半導體', emoji: '💻' }, { dataSource: 'live' }), /官方產業代碼 24/);
  assert.equal(lib.industryLineOf({ code: '24', name: '半導體', emoji: '💻' }, { dataSource: 'none' }), '產業別：來源未提供');
});

// ── 共用 ──
test('anyUnavailable／toneOf', () => {
  const ok = { a: lib.model20Reading(), b: lib.dist20Reading() };
  assert.equal(lib.anyUnavailable(ok), false);
  assert.equal(lib.anyUnavailable({ ...ok, c: lib.instFlowReading(null, '2330', CTX()) }), true);
  assert.equal(lib.anyUnavailable({ ...ok, c: undefined }), false);
  assert.equal(lib.toneOf('up', 'market'), 'var(--color-up)');
  assert.equal(lib.toneOf('up', 'rate'), '#60a5fa');
  assert.equal(lib.toneOf('down', 'rate'), '#f59e0b');
  assert.equal(lib.toneOf('mixed', 'market'), '#94a3b8');
  assert.equal(lib.toneOf('thin', 'market'), '#f59e0b');
  assert.equal(lib.toneOf('none', 'market'), 'var(--text-muted)');
});

test('公開頁文字規則：READING_TEXT 與所有今晚 reading 不含內部代號、集合名、你核可、看好', () => {
  const BANNED = /你核可|你裁定|v3 S|v3 W|波段公式 D|M0-b|M4|chipCharacter|volAvg20|chipDaily|modelMap|calib|看好/;
  const walk = (v) => {
    if (typeof v === 'string') assert.doesNotMatch(v, BANNED, v);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(lib.READING_TEXT);
  const all = [lib.model20Reading(), lib.dist20Reading(), ...Object.values(lib.horizonReadings()), lib.newsDirReading(),
    ...Object.values(lib.hitReadings()), lib.openRangeReading(), lib.nextDayDirReading(),
    lib.instFlowReading(null, '2330', CTX()), lib.instFlowReading(null, '2330', CTX({ degraded: true }))];
  for (const r of all) {
    walk(r);
    assert.ok(typeof r.hint === 'string' && r.hint.length > 0, `${r.key} 缺 hint`);
    assert.ok(typeof r.stateText === 'string' && r.stateText.length > 0, `${r.key} 缺 stateText`);
    if (r.value == null) assert.doesNotMatch(r.hint, /\d+(\.\d+)?%/, `${r.key} 無值時 hint 不得有百分比`);
  }
});

test('常數事前寫死（2026-10-08）', () => {
  assert.equal(lib.INST_UP_P, 80);
  assert.equal(lib.INST_DOWN_P, 20);
  assert.equal(lib.INST_MIN_N, 1500);
  assert.deepEqual([...lib.CLOSE_POS_EDGES], [0.85, 0.70, 0.50, 0.30]);
  assert.equal(lib.GAP_EDGE_PCT, 1);
  assert.equal(lib.MIN_RANGE_PCT, 1.5);
  assert.equal(lib.STALE_LAG, 2);
  assert.deepEqual({ ...lib.STOP_MULT }, { normal: 0.95, strong: 0.93, strongChgPct: 5 });
});

// ── F10 明日漲跌停價（今收 ×1.1／×0.9 取合法檔位；股票檔位表取自 twse-api.ts 的 tickSize，ETF 用 ETF 表）──
const twse = await import(new URL('../../src/lib/twse-api.ts', import.meta.url).href);
test('F10 nextLimitPrices：檔位進位方向正確、ETF 用 ETF 檔位、價格必為合法檔位', () => {
  assert.deepEqual(lib.nextLimitPrices(13.65, twse.tickSize), { up: 15.0, down: 12.3 });
  assert.deepEqual(lib.nextLimitPrices(98.5, twse.tickSize), { up: 108.0, down: 88.7 });
  assert.equal(lib.nextLimitPrices(98, twse.tickSize).down, 88.2, '剛好在檔位上不得多進一檔');
  assert.equal(lib.nextLimitPrices(103.55, lib.etfTickSize).up, 113.9);
  assert.equal(lib.nextLimitPrices(0, twse.tickSize), null);
  for (let p = 5; p < 1500; p += 0.37) {
    const close = parseFloat(p.toFixed(2));
    const r = lib.nextLimitPrices(close, twse.tickSize);
    for (const [px, raw] of [[r.up, close * 1.1], [r.down, close * 0.9]]) {
      const t = twse.tickSize(raw);
      assert.ok(Math.abs(px / t - Math.round(px / t)) < 1e-6, `${close} → ${px} 不是合法檔位 ${t}`);
    }
    assert.ok(r.up <= close * 1.1 + 1e-9 && r.down >= close * 0.9 - 1e-9, `${close} 超出 ±10%`);
  }
});

// ── 2026-10-08 審查修正 ──────────────────────────────────────────

test('limitKindOf：ETF 用 ETF 檔位（00632R +9.79% 不是漲停）、低價股 9.57% 真漲停、超出漲跌停價＝無漲跌幅標的', () => {
  // 00632R 昨收 20.13、收 22.10：個股檔位算出漲停 22.10（舊誤判），ETF 檔位漲停 22.14
  assert.equal(lib.limitKindOf(22.10, 1.97, twse.tickSize), 'up', '個股檔位會誤判（說明為何 ETF 要換檔位）');
  assert.equal(lib.limitKindOf(22.10, 1.97, lib.etfTickSize), null);
  assert.equal(lib.limitKindOf(22.14, 2.01, lib.etfTickSize), 'up');
  // 國外成分 ETF 沒有漲跌幅限制：+12% 收在漲停價外側 ⇒ 不算漲停
  assert.equal(lib.limitKindOf(22.4, 2.4, lib.etfTickSize), null);
  // 昨收 10.45 → 漲停 11.45（+9.57%）
  assert.equal(lib.limitKindOf(11.45, 1.0, twse.tickSize), 'up');
  // 9929：昨收 13.65 → 跌停 12.30
  assert.equal(lib.limitKindOf(12.3, -1.35, twse.tickSize), 'down');
  assert.equal(lib.limitKindOf(12.35, -1.3, twse.tickSize), null);
  assert.equal(lib.limitKindOf(50, 0, twse.tickSize), null);
  // 與 twse-api 的 isLimitUp／isLimitDown 在股票上一致（股票收盤不可能超出漲跌停價）
  for (let p = 5; p < 1200; p += 0.73) {
    const prev = parseFloat(p.toFixed(2));
    for (const close of [lib.nextLimitPrices(prev, twse.tickSize).up, lib.nextLimitPrices(prev, twse.tickSize).down]) {
      const change = parseFloat((close - prev).toFixed(2));
      const want = twse.isLimitUp(close, change) ? 'up' : twse.isLimitDown(close, change) ? 'down' : null;
      assert.equal(lib.limitKindOf(close, change, twse.tickSize), want, `${prev} → ${close}`);
    }
  }
});

const ROW = (over = {}) => ({
  close: 50, change: -1, open: 52, high: 53, low: 49.5, tradeValue: 3e9, volume: 6e7,
  rowYmd: '2026-10-12', source: 'stock_day_all', market: 'tse', ...over,
});
const QC_INTRA = { dataDate: '2026-10-12', phase: 'intraday', quoteAsOfMs: Date.UTC(2026, 9, 12, 2, 32) };
const QC_CLOSE = { dataDate: '2026-10-12', phase: 'close', quoteAsOfMs: Date.UTC(2026, 9, 12, 6, 0) };
const moveOf = (q, qc) => lib.todayMoveOf(q.chgPct, {
  limit: q.limit, phase: qc.phase, tradeValue: q.tradeValue, closePos: q.closePos,
  dataDate: qc.dataDate, quoteAsOfMs: qc.quoteAsOfMs, noTradeToday: q.noTradeToday,
});
const reasonsFor = (q, qc) => lib.reasonsOf({
  chgPct: q.chgPct, limit: q.limit, phase: qc.phase, tradeValue: q.tradeValue, closePos: q.closePos,
  dataDate: qc.dataDate, quoteAsOfMs: qc.quoteAsOfMs, noTradeToday: q.noTradeToday, auditOutside: q.auditOutside,
  close: q.close, open: q.open, prevClose: q.prevClose,
});

test('quoteFactsOf 盤中非即時列（rowYmd≠資料日）：不出位置、跳空、成交值數字，寫「尚未取得今日成交」', () => {
  // daemon 種子：價格＝昨收、開高低＝昨日 CSV、成交值＝昨日；盤中漲跌已歸零（這裡故意給非 0，確認仍以 0 計）
  const q = lib.quoteFactsOf('2330', ROW({ close: 50, change: 1.2, open: 48, high: 51, low: 47.5, rowYmd: '2026-10-08' }), QC_INTRA, twse.tickSize);
  assert.equal(q.noTradeToday, true);
  assert.equal(q.chgPct, 0);
  assert.equal(q.closePos, null);
  assert.equal(q.tradeValue, null);
  assert.equal(q.open, 0);
  assert.equal(q.limit, null);
  const m = moveOf(q, QC_INTRA);
  assert.equal(m.label, '盤中尚無成交');
  assert.equal(m.tone, 'flat');
  assert.match(m.text, /盤中 10:32：本站尚未取得本檔今日成交/);
  assert.doesNotMatch(`${m.label}${m.text}`, /收|累計至此|目前位於|億元|萬元/);
  const rs = reasonsFor(q, QC_INTRA);
  assert.equal(rs.length, 0, JSON.stringify(rs));
  const pos = lib.closePosReading(q.closePos, { limit: q.limit, phase: 'intraday', dataDate: QC_INTRA.dataDate, auditOutside: q.auditOutside });
  assert.equal(pos.value, null);
  // 快照合成的上櫃列（沒有 Date）盤中非即時：開高低是種子（前一交易日）⇒ 一樣不用
  const otc = lib.quoteFactsOf('6488', ROW({ market: 'otc', rowYmd: null, close: 1130, change: 0, open: 1180, high: 1195, low: 1095 }), QC_INTRA, twse.tickSize);
  assert.equal(otc.noTradeToday, true);
  assert.equal(otc.closePos, null);
  assert.equal(otc.tradeValue, null);
  assert.equal(reasonsFor(otc, QC_INTRA).length, 0);
});

test('quoteFactsOf 收盤後 CSV 未更新（非即時列 rowYmd≠資料日）：開高低當 0、成交值來源未提供，漲跌照用', () => {
  const q = lib.quoteFactsOf('2330', ROW({ open: 47, high: 53, low: 46.5, rowYmd: '2026-10-08' }), QC_CLOSE, twse.tickSize);
  assert.equal(q.noTradeToday, false);
  assert.equal(q.change, -1);
  assert.equal(q.closePos, null);
  assert.equal(q.tradeValue, null);
  assert.equal(q.open, 0);
  const m = moveOf(q, QC_CLOSE);
  assert.match(m.text, /^10-12 收跌 1\.96%（小跌），成交值：來源未提供，收盤位置資料不足。$/);
  const rs = reasonsFor(q, QC_CLOSE);
  assert.ok(!rs.some(r => /跳空|成交值|日內|日線/.test(r.title)), JSON.stringify(rs));
});

test('quoteFactsOf 即時列與同日列：開高低、成交值照用；興櫃成交值 0＝來源未提供', () => {
  const live = lib.quoteFactsOf('2330', ROW({ source: 'mis_live', rowYmd: '2026-10-08', close: 50, change: -1, open: 51, high: 51.5, low: 49 }), QC_INTRA, twse.tickSize);
  assert.equal(live.noTradeToday, false);
  assert.equal(live.open, 51);
  assert.equal(live.tradeValue, 3e9);
  assert.equal(Math.round(live.closePos * 100), 40);
  const same = lib.quoteFactsOf('2330', ROW({ open: 51, high: 51.5, low: 49 }), QC_CLOSE, twse.tickSize);
  assert.equal(same.tradeValue, 3e9);
  assert.equal(Math.round(same.closePos * 100), 40);
  assert.equal(same.auditOutside, null);
  const esb = lib.quoteFactsOf('7930', ROW({ market: 'esb', source: 'esb', rowYmd: null, tradeValue: 0, change: 3, close: 30, high: 31, low: 28, open: 0 }),
    { dataDate: null, phase: 'quote', quoteAsOfMs: null }, twse.tickSize);
  assert.equal(esb.limit, null);
  assert.equal(esb.tradeValue, null);
  assert.equal(esb.auditOutside, '興櫃');
  assert.ok(esb.closePos != null);
});

test('quoteFactsOf 快照合成的上櫃後備列（Date 空、TradeValue 0）：成交值來源未提供，不寫「0 萬元」', () => {
  // twse-api-server 的 fallback 每列都標 _source:'stock_day_all'，所以不能靠「_source 為空」判斷（規格 §1.9 與程式不符）
  const qc = lib.quoteContextOf({ snapFresh: false, snapDataYmd: null, snapMarketOpen: false, snapSweepMs: null, rowYmd: null, rowMarket: 'otc' });
  const q = lib.quoteFactsOf('6488', ROW({ market: 'otc', rowYmd: null, tradeValue: 0, close: 400, change: -30, open: 425, high: 430, low: 398 }), qc, twse.tickSize);
  assert.equal(q.tradeValue, null);
  // 沒有 Date 的列：開高低與價格出自同一筆快照報價（不是另一份檔案），位置照算
  assert.equal(Math.round(q.closePos * 100), 6);
  const m = moveOf(q, qc);
  assert.match(m.text, /^資料日未提供：收跌 6\.98%（大跌），成交值：來源未提供，收盤位於日內 6%。$/);
  assert.doesNotMatch(m.text, /0 萬元/);
  // 同日列成交值給 0 也一樣視為來源未提供
  assert.equal(lib.quoteFactsOf('2330', ROW({ tradeValue: 0 }), QC_CLOSE, twse.tickSize).tradeValue, null);
  // 快照新鮮、上櫃收盤檔未寫入時的合成列（Date 空、成交值取自快照）：照用
  const snapRow = lib.quoteFactsOf('6488', ROW({ market: 'otc', rowYmd: null, close: 1130, change: -85, open: 1180, high: 1195, low: 1095, tradeValue: 23287103280 }), QC_CLOSE, twse.tickSize);
  assert.equal(snapRow.tradeValue, 23287103280);
  assert.equal(Math.round(snapRow.closePos * 100), 35);
});

test('稽核母體：ETF／漲幅逾 8.5%／量不足／興櫃不套稽核方向；未核對也不套', () => {
  assert.equal(lib.auditOutsideOf('0050', false, -1, 1e8), 'ETF');
  assert.equal(lib.auditOutsideOf('2330', false, 9.0, 1e8), '漲幅逾 8.5%');
  assert.equal(lib.auditOutsideOf('2330', false, 8.5, 1e8), null);
  assert.equal(lib.auditOutsideOf('2330', false, -9.9, 1e8), null, '跌停在母體內');
  assert.equal(lib.auditOutsideOf('2330', false, 1, 299_999), '成交量未達 300 張');
  assert.equal(lib.auditOutsideOf('2881A', false, 1, 1e8), '非四碼普通股');
  assert.equal(lib.auditOutsideOf('7930', true, 1, 1e8), '興櫃');
  const NO_DIR = /最差|相對最佳/;
  const etf = lib.closePosReading(0.1, { limit: null, phase: 'close', dataDate: '2026-10-08', auditOutside: 'ETF' });
  assert.doesNotMatch(etf.hint, NO_DIR);
  assert.match(etf.hint, /不在本站五因子稽核母體（ETF）/);
  assert.doesNotMatch(etf.basis, /480/);
  assert.equal(etf.stateText, '日線下半段');
  const hot = lib.closePosReading(0.9, { limit: null, phase: 'close', dataDate: '2026-10-08', auditOutside: '漲幅逾 8.5%' });
  assert.doesNotMatch(hot.hint, NO_DIR);
  const unk = lib.closePosReading(0.9, { limit: null, phase: 'close', dataDate: '2026-10-08' });
  assert.match(unk.hint, /母體條件未核對/);
  assert.doesNotMatch(unk.hint, NO_DIR);
  const inPop = lib.closePosReading(0.9, { limit: null, phase: 'close', dataDate: '2026-10-08', auditOutside: null });
  assert.match(inPop.hint, /最差/);
  assert.match(inPop.basis, /漲幅 ≤8\.5%、成交量 ≥300 張/);
  // reasonsOf 沿用同一段 hint
  const q = lib.quoteFactsOf('0050', ROW({ close: 100, change: -1, open: 101, high: 101.5, low: 99.8 }), QC_CLOSE, lib.etfTickSize);
  assert.equal(q.auditOutside, 'ETF');
  const r = reasonsFor(q, QC_CLOSE).find(x => /日線下半段/.test(x.title));
  assert.ok(r);
  assert.doesNotMatch(r.detail, NO_DIR);
  const hot9 = lib.quoteFactsOf('2330', ROW({ close: 109, change: 9, open: 101, high: 109.5, low: 100.5 }), QC_CLOSE, twse.tickSize);
  assert.equal(hot9.auditOutside, '漲幅逾 8.5%');
  const r9 = reasonsFor(hot9, QC_CLOSE).find(x => /日內高位/.test(x.title));
  assert.ok(r9);
  assert.doesNotMatch(r9.detail, NO_DIR);
});

test('openRangeBasisText：分段寫「近似漲停」；真漲停但未達 9.9% 附註；盤中不寫收', () => {
  const t = lib.openRangeBasisText(0.985, 1.03, { anchor: '今收', chgPct: 9.57, limitUpApprox: false, limit: 'up', phase: 'close', quoteAsOfMs: null });
  assert.match(t, /漲幅 ≥9\.9%（近似漲停）0\.99～1\.05/);
  assert.match(t, /本檔收漲停但漲幅 9\.57% 未達 9\.9%，依漲幅分段試算/);
  assert.doesNotMatch(t, /、漲停 0\.99/);
  const a = lib.openRangeBasisText(0.99, 1.05, { anchor: '今收', chgPct: 9.98, limitUpApprox: true, limit: 'up', phase: 'close', quoteAsOfMs: null });
  assert.doesNotMatch(a, /未達/);
  const i = lib.openRangeBasisText(0.985, 1.03, { anchor: '目前價', chgPct: 9.57, limitUpApprox: false, limit: 'up', phase: 'intraday', quoteAsOfMs: Date.UTC(2026, 9, 12, 2, 32) });
  assert.match(i, /本檔在漲停價但漲幅/);
  assert.match(i, /依盤中 10:32 暫定價試算/);
});

test('stopRefOf／stopRefCellText：盤中寫「高於目前價」；格子依 note 分資料不足與公式不適用', () => {
  const intra = lib.stopRefOf(90, 100, '目前價');
  assert.equal(intra.price, null);
  assert.match(intra.note, /高於目前價/);
  assert.equal(lib.stopRefCellText(intra), '公式不適用');
  assert.equal(lib.stopRefCellText(lib.stopRefOf(0, 0)), '資料不足');
  assert.equal(lib.stopRefCellText(lib.stopRefOf(98, 100)), '95.00');
  assert.equal(lib.stopRefCellText(null), '暫時無法取得');
  assert.equal(lib.stopRefCellText(undefined), '暫時無法取得');
});

test('nextTradingYmd／sessionStartMsOf：過期改明確日期、個股頁判斷 trendData 是否本時段載入', () => {
  assert.equal(lib.nextTradingYmd('2026-10-08', isTradingYmd), '2026-10-12', '10-09、10-10 休市、10-11 週日');
  assert.equal(lib.nextTradingYmd('2026-10-12', isTradingYmd), '2026-10-13');
  assert.equal(lib.nextTradingYmd('bad', isTradingYmd), null);
  const open = Date.UTC(2026, 9, 12, 1, 0);   // 10-12 09:00 台北
  assert.equal(lib.sessionStartMsOf(Date.UTC(2026, 9, 12, 5, 40), true), open);
  assert.equal(lib.sessionStartMsOf(Date.UTC(2026, 9, 12, 0, 45), true), null, '08:45 還沒開盤');
  assert.equal(lib.sessionStartMsOf(Date.UTC(2026, 9, 10, 5, 0), false), null, '休市日');
});

test('查無此代號 ⇒ none（不觸發 partial 短快取）；收盤口徑可寫「今日」句首', () => {
  const r = lib.closePosNotFoundReading();
  assert.equal(r.state, 'none');
  assert.equal(r.stateText, '當日行情查無此代號');
  assert.equal(lib.anyUnavailable({ closePos: r }), false);
  const m = lib.todayMoveOf(-1.35, { limit: null, phase: 'close', dataDate: null, todayHead: true });
  assert.match(m.text, /^今日收跌 1\.35%（小跌）/);
});

test('收盤位置分段依畫面上的整數百分比：0.4996 印 50% 就是中段偏高、0.8496 印 85% 就是貼近日高', () => {
  const a = lib.closePosReading(0.4996, { limit: null, phase: 'close', dataDate: '2026-10-08', auditOutside: null });
  assert.equal(a.value, '日內 50%');
  assert.equal(a.stateText, '中段偏高');
  const b = lib.closePosReading(0.8496, { limit: null, phase: 'close', dataDate: '2026-10-08', auditOutside: null });
  assert.equal(b.value, '日內 85%');
  assert.equal(b.stateText, '貼近日高');
  assert.match(b.hint, /最差/);
  const c = lib.closePosReading(0.2996, { limit: null, phase: 'close', dataDate: '2026-10-08', auditOutside: null });
  assert.equal(c.value, '日內 30%');
  assert.equal(c.stateText, '中段偏低');
  assert.match(c.hint, /中段沒有結論/);
  const base = { close: 100, open: 0, prevClose: 99, limit: null, phase: 'close', tradeValue: null, quoteAsOfMs: null, dataDate: '2026-10-08', chgPct: 1, auditOutside: null };
  assert.ok(lib.reasonsOf({ ...base, closePos: 0.8496 }).some(r => /日內高位（85%）/.test(r.title)));
  assert.ok(!lib.reasonsOf({ ...base, closePos: 0.2996 }).some(r => /日線下半段/.test(r.title)));
});
