import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitIssue, scanKeys, scanStockDetail, prepareDocs, decidePublish, isStockSpecificRef, publicFocus, MAX_DOC_BYTES, PUBLIC_FOCUS_KEYS, toFirestoreSafe } from './publish-split.mjs';
import { writeIssue } from './archive.mjs';
import { publishDaily } from '../../publish-daily-analyst.mjs';
import { makeIssue, makePack, DAY } from './w5-fixtures.mjs';

const STAMPS = { canonicalAt: '2026-10-02T15:40:00.000Z', updatedAt: 1791000000000 };

/** 仿 analystDeskTypes.ts 的 focusByCard：管理員文件 → { 卡 id: 名單區塊 }。 */
const focusByCard = doc => { const o = {}; for (const c of doc?.cards || []) if (c?.id && c.focus) o[c.id] = c.focus; return o; };

test('splitIssue：公開文件的 focus 只留計數與規則，不含任何個股名單', () => {
  const { pub } = splitIssue(makeIssue(), STAMPS);
  for (const c of pub.cards) assert.deepEqual(Object.keys(c.focus), PUBLIC_FOCUS_KEYS);
  const next = pub.cards.find(c => c.id === 'next');
  assert.equal(next.focus.count, 2);
  assert.equal(next.focus.poolSize, 3);
  assert.equal(next.focus.excludedCount, 1);
  assert.deepEqual(scanStockDetail(pub), []);
  assert.equal(JSON.stringify(pub).includes('thesisRaw'), false);
  assert.equal(JSON.stringify(pub).includes('台積電資料日收漲'), false);   // 個股論點文字不在公開文件
  assert.equal(pub.canonicalAt, STAMPS.canonicalAt);
  assert.equal(pub.meta.canonicalAt, STAMPS.canonicalAt);
  assert.equal(pub.updatedAt, STAMPS.updatedAt);
});

test('splitIssue：公開 refTable 剔除僅供個股名單用的個股專屬 ref，保留總結／claims 用到的', () => {
  const { pub } = splitIssue(makeIssue(), STAMPS);
  const ids = Object.keys(pub.refTable);
  assert.ok(ids.includes('m.ew') && ids.includes('m.n'));                 // 非個股專屬
  assert.ok(ids.includes('st.2330.ret'));                                  // 總結 points 引用 → 保留
  for (const gone of ['st.2317.ret', 'st.2317.close', 'st.2330.close', 'nv.2330.label', 'wk.2317.chain']) assert.equal(ids.includes(gone), false, gone);
  assert.equal(isStockSpecificRef('st.2330.ret'), true);
  assert.equal(isStockSpecificRef('m.ew'), false);
  assert.equal(isStockSpecificRef('ind.半導體業.heat'), false);
});

test('splitIssue：管理員文件形狀可被 focusByCard 讀取，含 stocks 與個股用到的 refTable', () => {
  const { focus } = splitIssue(makeIssue(), STAMPS);
  assert.deepEqual(Object.keys(focus), ['dataDate', 'edition', 'canonicalAt', 'updatedAt', 'cards', 'refTable']);
  const byCard = focusByCard(focus);
  assert.deepEqual(Object.keys(byCard), ['prev', 'data', 'next']);
  assert.equal(byCard.next.stocks.length, 2);
  assert.equal(byCard.next.kind, 'watch');
  assert.equal(byCard.prev.stocks.length, 0);
  for (const k of ['kind', 'poolRule', 'poolSize', 'excludedCount', 'count', 'note']) assert.ok(k in byCard.next, k);
  for (const id of ['st.2330.close', 'st.2317.close', 'nv.2330.label', 'wk.2317.chain', 'st.2330.ret']) assert.ok(focus.refTable[id], id);
  assert.equal(focus.refTable['m.n'], undefined);                          // 與名單無關的不放
});

test('publicFocus：缺欄位給固定預設（不丟 undefined 給 Firestore）', () => {
  assert.deepEqual(publicFocus(undefined), { kind: '', poolRule: '', poolSize: 0, excludedCount: 0, count: 0, note: '' });
});

test('scanKeys：禁用鍵名被抓；redactions 豁免；動態鍵 map 不掃鍵但掃其值', () => {
  assert.deepEqual(scanKeys({ a: { score: 1 } }).map(x => x.key), ['score']);
  for (const k of ['signalX', 'buyer', 'rankNo', 'targetPrice', 'stopLoss', 'entryAt', 'exitAt', 'myAction', 'ratingX', 'recommended', 'sellOff']) assert.equal(scanKeys({ [k]: 1 }).length, 1, k);
  assert.deepEqual(scanKeys({ meta: { check: { redactions: [{ rule: 'R14' }] } } }), []);
  assert.deepEqual(scanKeys({ refTable: { 'x.score.target': { v: 1, unit: '%' } } }), []);                 // refId 當鍵：不掃
  assert.deepEqual(scanKeys({ meta: { check: { rules: { R01: 'pass' } } } }), []);
  assert.deepEqual(scanKeys({ refTable: { 'm.ew': { v: 1, ratingX: 2 } } }).map(x => x.key), ['ratingX']);   // 值內的鍵仍掃
  assert.deepEqual(scanKeys({ list: [{ ok: 1 }, { stopX: 1 }] }).map(x => x.path), ['list[1]']);
});

test('fixture issue 與其兩份文件都通過鍵名掃描（含 usedForScoring、redactions）', () => {
  const prep = prepareDocs(makeIssue(), STAMPS);
  assert.deepEqual(prep.problems, []);
  assert.equal(prep.ok, true);
  assert.deepEqual(scanKeys(prep.pub), []);
  assert.deepEqual(scanKeys(prep.focus), []);
});

test('prepareDocs：禁用鍵名、巢狀陣列、個股明細外洩 都擋', () => {
  const bad = makeIssue(); bad.summary.points[0].targetPrice = 1;
  assert.match(prepareDocs(bad, STAMPS).problems.join(), /鍵名違規.*targetPrice/);
  const nest = makeIssue(); nest.summary.byline.contributors = [['a']];
  assert.match(prepareDocs(nest, STAMPS).problems.join(), /巢狀陣列/);
  assert.equal(toFirestoreSafe({ a: undefined, b: [1] }).doc.a, undefined);
  const leak = splitIssue(makeIssue(), STAMPS).pub; leak.cards[2].focus.stocks = [{ code: '2330' }];
  assert.ok(scanStockDetail(leak).length >= 1);
});

test('prepareDocs：900KB 守門（公開／管理員任一超過即擋）', () => {
  const big = makeIssue();
  big.refTable['m.big'] = { v: 'x'.repeat(MAX_DOC_BYTES + 10), unit: '文字', fmt: 'txt', asOf: DAY, tier: '官方', source: 's' };
  big.summary.points.push({ id: 'sx', raw: '', text: '', refs: ['m.big'], kind: 'fact' });
  const p = prepareDocs(big, STAMPS);
  assert.equal(p.ok, false);
  assert.match(p.problems.join(), /dailyAnalyst .*B 逼近 1MB/);
  const bigFocus = makeIssue();
  bigFocus.cards[2].focus.stocks[0].thesis = 'y'.repeat(MAX_DOC_BYTES + 10);
  const p2 = prepareDocs(bigFocus, STAMPS);
  assert.match(p2.problems.join(), /dailyAnalystFocus .*B 逼近 1MB/);
});

test('decidePublish：同份不重寫、舊資料日不蓋新 latest、evening 不蓋同日 morning、force 重發', () => {
  const doc = { dataDate: DAY, edition: 'evening', canonicalAt: 'A' };
  assert.equal(decidePublish({ cur: null, doc }), 'write');
  assert.equal(decidePublish({ cur: { ...doc }, doc }), 'skip-same');
  assert.equal(decidePublish({ cur: { ...doc }, doc, force: true }), 'write');
  assert.equal(decidePublish({ cur: { dataDate: '2026-10-05', edition: 'evening', canonicalAt: 'B' }, doc }), 'skip-older');
  assert.equal(decidePublish({ cur: { dataDate: '2026-10-05', edition: 'evening', canonicalAt: 'B' }, doc, force: true }), 'skip-older');
  assert.equal(decidePublish({ cur: { dataDate: DAY, edition: 'morning', canonicalAt: 'C' }, doc }), 'skip-edition');
  assert.equal(decidePublish({ cur: { dataDate: DAY, edition: 'evening', canonicalAt: 'Z' }, doc }), 'write');
  assert.equal(decidePublish({ cur: { dataDate: '2026-10-01', edition: 'morning', canonicalAt: 'Z' }, doc }), 'write');
});

// ── publishDaily（注入假 db，不碰 Firestore）────────────────────────────────
function fakeDb() {
  const store = new Map(); const sets = [];
  const ref = (c, id) => ({ c, id });
  const db = {
    store, sets,
    collection: c => ({ doc: id => ({ ...ref(c, id), get: async () => ({ exists: store.has(`${c}/${id}`), data: () => store.get(`${c}/${id}`) }) }) }),
    batch: () => { const ops = []; return { set: (r, d) => ops.push([r, d]), commit: async () => { for (const [r, d] of ops) { store.set(`${r.c}/${r.id}`, JSON.parse(JSON.stringify(d))); sets.push(`${r.c}/${r.id}`); } } }; },
  };
  return db;
}
const tmp = () => mkdtempSync(join(tmpdir(), 'analyst-pub-'));
const T0 = Date.parse('2026-10-02T23:40:00+08:00');
const put = (root, edition, now = T0) => writeIssue({ root, issue: makeIssue(DAY, edition), pack: makePack(DAY, edition), transcript: [], edition, dataDate: DAY, now });

test('publishDaily：寫公開＋管理員各 latest／{D}；公開文件無名單、管理員文件有', async () => {
  const root = tmp(); put(root, 'evening');
  const db = fakeDb();
  const r = await publishDaily({ root, db, now: 1791000000000 });
  assert.equal(r.status, 'published');
  assert.deepEqual([...db.sets].sort(), ['dailyAnalyst/2026-10-02', 'dailyAnalyst/latest', 'dailyAnalystFocus/2026-10-02', 'dailyAnalystFocus/latest']);
  const pub = db.store.get('dailyAnalyst/latest'), foc = db.store.get('dailyAnalystFocus/latest');
  assert.equal(JSON.stringify(pub).includes('"stocks"'), false);
  assert.equal(foc.cards.find(c => c.id === 'next').focus.stocks.length, 2);
  assert.equal(pub.updatedAt, 1791000000000);
  assert.equal(pub.canonicalAt, foc.canonicalAt);
  assert.deepEqual(scanKeys(pub), []);
});

test('publishDaily：同一份定版不重寫；--force 重發；dry-run 不寫', async () => {
  const root = tmp(); put(root, 'evening');
  const db = fakeDb();
  assert.equal((await publishDaily({ root, db, dry: true })).status, 'dry-run');
  assert.equal(db.sets.length, 0);
  await publishDaily({ root, db });
  const n = db.sets.length;
  assert.equal((await publishDaily({ root, db })).status, 'skip-same');
  assert.equal(db.sets.length, n);
  assert.equal((await publishDaily({ root, db, force: true })).status, 'published');
  assert.equal(db.sets.length, n * 2);
});

test('publishDaily：同日 evening 不蓋已發佈的 morning；舊資料日不蓋新 latest', async () => {
  const root = tmp(); put(root, 'evening'); put(root, 'morning', T0 + 6 * 3600e3);
  const db = fakeDb();
  assert.equal((await publishDaily({ root, db })).status, 'published');            // latest.json 指向 morning
  assert.equal(db.store.get('dailyAnalyst/latest').edition, 'morning');
  assert.equal((await publishDaily({ root, db, day: DAY, edition: 'evening' })).status, 'skip-edition');
  assert.equal(db.store.get('dailyAnalyst/latest').edition, 'morning');
  const db2 = fakeDb(); db2.store.set('dailyAnalyst/latest', { dataDate: '2026-10-05', edition: 'evening', canonicalAt: 'Z' });
  assert.equal((await publishDaily({ root, db: db2 })).status, 'skip-older');
  assert.equal(db2.sets.length, 0);
});

test('publishDaily：無定版、鍵名違規 → 不寫', async () => {
  const empty = tmp();
  assert.equal((await publishDaily({ root: empty, db: fakeDb() })).status, 'no-final');
  const root = tmp();
  const issue = makeIssue(); issue.summary.points[0].rankHint = 1;                   // 違規鍵進了定版檔
  writeIssue({ root, issue, pack: makePack(), transcript: [], edition: 'evening', dataDate: DAY, now: T0 });
  const db = fakeDb();
  const r = await publishDaily({ root, db });
  assert.equal(r.status, 'refused');
  assert.match(r.reason, /鍵名違規/);
  assert.equal(db.sets.length, 0);
});
