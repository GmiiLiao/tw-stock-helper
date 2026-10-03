// 處置風險分級 單元測試：node --test scripts/lib/attention-risk.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClauses, attentionTier, parseNearDisposal, createNearDisposalSource, riskTiersOf, dispositionProb10, NEAR_DISPOSAL_URLS, attentionInfoOf, setAttentionCalibration } from './attention-risk.mjs';
import { ATTENTION_CAL_FIXTURE } from './attention-calibration.fixture.mjs';

setAttentionCalibration(ATTENTION_CAL_FIXTURE);   // 自帶校準資料：不依賴（不進版控的）scripts/data/attention-calibration.json

test('parseClauses：上市﹝第X款﹞、上櫃(第X款)、十以上的款、無條款回空陣列', () => {
  assert.deepEqual(parseClauses('最近六個營業日累積收盤價漲幅達33.16%﹝第一款﹞。…漲幅達232.46% ﹝第二款﹞。'), [1, 2]);
  assert.deepEqual(parseClauses('當日本益比為86.83…(第六款)最近六個營業日(含當日)之累積週轉率為93.98%(第十款)'), [6, 10]);
  assert.deepEqual(parseClauses('…(第十一款)…(第十三款)…(第一款)'), [1, 11, 13]);
  assert.deepEqual(parseClauses('累計 2 次｜（來源未提供）'), []);
  assert.deepEqual(parseClauses(null), []);
});

test('attentionTier：可能達處置＝high；計入條款＝mid（上市第 6 款不計、上櫃第 6 款計）；條款未知保守當 mid', () => {
  assert.equal(attentionTier({ near: 'TWSE', att: null }).tier, 'high', '可能達處置不要求當日被注意');
  assert.equal(attentionTier({ near: 'TPEx', att: { src: 'TPEx', clauses: [9] } }).tier, 'high', '高優先於低');
  assert.equal(attentionTier({ att: { src: 'TWSE', clauses: [6] } }).tier, 'low');
  assert.equal(attentionTier({ att: { src: 'TPEx', clauses: [6] } }).tier, 'mid');
  assert.equal(attentionTier({ att: { src: 'TWSE', clauses: [6, 9, 10, 11, 12, 13] } }).tier, 'low');
  assert.equal(attentionTier({ att: { src: 'TWSE', clauses: [6, 7] } }).tier, 'mid');
  const u = attentionTier({ att: { src: 'TPEx', clauses: [] } });
  assert.equal(u.tier, 'mid'); assert.equal(u.clausesKnown, false);
  assert.equal(attentionTier({}), null);
});

const TWSE_OK = { stat: 'OK', title: '115年10月02日 公布注意累計次數可能達處置標準之有價證券一覽表', fields: ['編號', '證券代號', '證券名稱', '近期達本公司「公布注意交易資訊」標準之情形'],
  data: [[1, '2033', '佳大', '115年10月1日至115年10月2日連續二次'], [2, '2305', '全友', '…九個營業日已有五次']] };
const TPEX_OK = { stat: 'ok', tables: [{ title: '上櫃公布注意累計次數可能達處置標準之有價證券', date: 20261002, fields: ['編號', '證券代號', '證券名稱', '近期達本公司「公布注意交易資訊」標準之情形'],
  data: [[1, '3455', '由田', '連續四次'], [2, '6538', '倉和', '…'], ['', '', '', '']] }] };

test('parseNearDisposal：兩市資料日回音；身分或日期對不上＝null（未知，不是「沒有」）；空白列略過', () => {
  const p = parseNearDisposal({ twse: TWSE_OK, tpex: TPEX_OK });
  assert.deepEqual(p.twse, { date: '2026-10-02', codes: ['2033', '2305'] });
  assert.deepEqual(p.tpex, { date: '2026-10-02', codes: ['3455', '6538'] });
  assert.equal(parseNearDisposal({ twse: { ...TWSE_OK, title: '公布注意有價證券資訊' } }).twse, null, '端點身分不符');
  assert.equal(parseNearDisposal({ twse: { ...TWSE_OK, stat: '很抱歉，沒有符合條件的資料!' } }).twse, null);
  assert.equal(parseNearDisposal({ twse: { ...TWSE_OK, fields: ['編號', 'Code'] } }).twse, null, '欄位對不上不猜');
  assert.equal(parseNearDisposal({ tpex: { tables: [{ ...TPEX_OK.tables[0], date: null }] } }).tpex, null, '沒有資料日不用');
  assert.deepEqual(parseNearDisposal({ twse: { ...TWSE_OK, data: [] } }).twse, { date: '2026-10-02', codes: [] }, '當日無名單＝空（有日期才算確定）');
});

test('createNearDisposalSource：10 分鐘內重用、併發合流、失敗 1 分鐘負快取、單邊失敗仍回另一邊', async () => {
  let now = 0, calls = 0, failTpex = false;
  const fetchImpl = async url => {
    calls++; await new Promise(r => setTimeout(r, 5));
    if (url === NEAR_DISPOSAL_URLS.tpex && failTpex) return { ok: false, json: async () => null };
    return { ok: true, json: async () => (url === NEAR_DISPOSAL_URLS.twse ? TWSE_OK : TPEX_OK) };
  };
  const logs = [];
  const src = createNearDisposalSource({ fetchImpl, clock: () => now, log: m => logs.push(m) });
  const [a, b] = await Promise.all([src.get(), src.get()]);
  assert.equal(calls, 2, '兩個併發呼叫只打一次（兩支端點各一）'); assert.equal(a, b);
  now = 9 * 60_000; await src.get(); assert.equal(calls, 2, 'TTL 內重用');
  now = 11 * 60_000; failTpex = true; const c = await src.get();
  assert.equal(calls, 4); assert.equal(c.tpex, null); assert.deepEqual(c.twse.codes, ['2033', '2305']);
  assert.match(logs.join(), /上櫃/);
  const dead = createNearDisposalSource({ fetchImpl: async () => { calls++; throw new Error('x'); }, clock: () => now });
  const before = calls;
  assert.equal(await dead.get(), null); now += 30_000; await dead.get(); assert.equal(calls - before, 2, '負快取 1 分鐘內不重打');
  now += 31_000; await dead.get(); assert.equal(calls - before, 4);
});

test('riskTiersOf＋dispositionProb10：組合等級、校準機率依市場', () => {
  const t = riskTiersOf({ nearMap: new Map([['2033', 'TWSE']]), attentionInfo: { 2033: { src: 'TWSE', clauses: [1] }, 3163: { src: 'TPEx', clauses: [6] }, 1709: { src: 'TWSE', clauses: [6] } } });
  assert.equal(t['2033'].tier, 'high'); assert.equal(t['3163'].tier, 'mid'); assert.equal(t['1709'].tier, 'low');
  assert.deepEqual(riskTiersOf({}), {}, '無輸入＝空物件');
  const hi = dispositionProb10('high', 'TWSE'), lo = dispositionProb10('low', 'TWSE'), none = dispositionProb10('none', 'TPEx');
  assert.ok(hi > 0.4 && hi < 0.7, `可能達處置約五成（${hi}）`);
  assert.ok(lo < hi && none < lo);
  assert.equal(dispositionProb10('high', 'XX'), null);
});

test('attentionInfoOf：只收公告日＝名單日的列——上櫃 openapi 混兩天時 D−1 才被注意的不分級；上櫃缺公告日（舊版 API）整批不分級；上市舊版無 date 仍可用', () => {
  const rs = { twseAttentionDate: '2026-10-02', tpexAttentionDate: '2026-10-02', attention: [
    { code: '2033', source: 'TWSE', date: '2026-10-02', reason: '…﹝第一款﹞' },
    { code: '3219', source: 'TPEx', date: '2026-10-01', reason: '…(第一款)' },
    { code: '3455', source: 'TPEx', date: '2026-10-02', reason: '…(第六款)' },
    { code: '6708', source: 'TPEx', date: '2026-10-01', reason: '…(第四款)' },
    { code: '6708', source: 'TPEx', date: '2026-10-02', reason: '…(第一款)…(第三款)' },
  ] };
  const { info, tpexUndated } = attentionInfoOf(rs);
  assert.deepEqual(Object.keys(info).sort(), ['2033', '3455', '6708']);
  assert.equal(info['3219'], undefined, 'D−1 才被注意 ⇒ 當日無注意');
  assert.deepEqual(info['6708'].clauses, [1, 3], '條款不跨日合併');
  assert.equal(tpexUndated, 0);
  assert.deepEqual([...attentionInfoOf(rs).currentCodes].sort(), ['2033', '3455', '6708'], 'D−1 才被注意的 3219 不再標注意股');
  const old = attentionInfoOf({ twseAttentionDate: '2026-10-02', tpexAttentionDate: '2026-10-02', attention: [{ code: '2033', source: 'TWSE', reason: '﹝第六款﹞' }, { code: '3455', source: 'TPEx', reason: '(第一款)' }] });
  assert.deepEqual(Object.keys(old.info), ['2033'], '上市 rwd 本來只取最新一批 ⇒ 無 date 也可用');
  assert.deepEqual([...old.currentCodes].sort(), ['2033', '3455'], '部署前：缺公告日的上櫃仍標注意股（舊標示）');
  assert.equal(old.tpexUndated, 1);
  const noDate = attentionInfoOf({ twseAttentionDate: null, attention: [{ code: '2033', source: 'TWSE', reason: '﹝第一款﹞' }] });
  assert.deepEqual(noDate.info, {}, '名單日不明 ⇒ 不分級'); assert.deepEqual([...noDate.currentCodes], ['2033'], '但仍標注意股');
  const none = attentionInfoOf(null); assert.deepEqual(none.info, {}); assert.equal(none.tpexUndated, 0); assert.equal(none.currentCodes.size, 0);
});

test('dispositionProb10：校準缺席（檔案不存在）⇒ 回 null，不是 0；注入／還原行為正確', () => {
  const prev = setAttentionCalibration(null);
  try {
    assert.equal(dispositionProb10('high', 'TWSE'), null);
    assert.equal(dispositionProb10('none', 'TPEx'), null);
  } finally { setAttentionCalibration(prev); }
  assert.ok(dispositionProb10('high', 'TWSE') > 0.4, '還原後恢復');
  assert.equal(dispositionProb10('high', 'XX'), null);
});
