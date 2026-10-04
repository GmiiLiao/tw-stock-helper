// daemon 加厚流程（scripts/backfill-mops-revenue.mjs）的離線測試：假 Firestore＋假 MOPS（0 網路、0 憑證）。
// node --test scripts/lib/mops-revenue-backfill.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backfillMopsRevenue } from '../backfill-mops-revenue.mjs';

function fakeDb(init = {}) {
  const store = new Map(Object.entries(init).map(([k, v]) => [k, { data: v, t: 1 }]));
  const writes = [];
  const doc = id => ({
    get: async () => { const e = store.get(id); return { exists: !!e, data: () => e?.data, updateTime: e?.t }; },
    update: async (d, pre) => {
      const e = store.get(id);
      if (!e || (pre && pre.lastUpdateTime !== e.t)) throw new Error('FAILED_PRECONDITION');
      store.set(id, { data: { ...e.data, ...d }, t: e.t + 1 }); writes.push(['update', id]);
    },
    create: async (d) => { if (store.has(id)) throw new Error('ALREADY_EXISTS'); store.set(id, { data: d, t: 1 }); writes.push(['create', id]); },
  });
  return { store, writes, collection: () => ({ doc }) };
}

const LABEL = { sii: '上市', otc: '上櫃' };
const rowHtml = c => `<tr align=right><td align=center>${c}</td><td align=left>公司${c}</td><td nowrap>1,000</td><td nowrap>900</td><td nowrap>800</td><td nowrap>11.11</td><Td nowrap>25.00</td><td nowrap>9,000</td><td nowrap>8,000</td><td nowrap>12.50</td><td>-</td></tr>`;
const pageHtml = (mkt, roc, m, page, codes) => `<b>${LABEL[mkt]}公司${roc}年${m}月份(累計與當月)營業收入統計表</b><div>出表日期：115/09/12<!--20:00:18--></div><table>`
  + codes.map(rowHtml).join('') + `<tr><th colspan=2>全部${page === '0' ? '國內' : '國外'}${LABEL[mkt]}公司合計</th><td>1</td></tr></table>`;
const range = (a, n) => Array.from({ length: n }, (_, i) => String(a + i));
const CODES = { sii0: range(1000, 900), sii1: range(4000, 80), otc0: range(3000, 100), otc1: range(6000, 25) };

/** 假 MOPS：依網址回頁；override(mkt,page,roc,m) 可改回應（{status} 或 html 字串）。calls 記錄每次請求。 */
function fakeMops(override = () => null) {
  const calls = [];
  const fetchImpl = async (url) => {
    const [, mkt, roc, m, page] = url.match(/nas\/t21\/(sii|otc)\/t21sc03_(\d+)_(\d+)_(\d)\.html$/);
    calls.push(`${mkt}_${page}`);
    const o = override(mkt, page, +roc, +m);
    if (o?.status) return { status: o.status, ok: o.status >= 200 && o.status < 300, arrayBuffer: async () => Buffer.from('') };
    const html = typeof o === 'string' ? o : pageHtml(mkt, roc, m, page, CODES[`${mkt}${page}`]);
    return { status: 200, ok: true, arrayBuffer: async () => Buffer.from(html, 'utf8') };
  };
  return { fetchImpl, calls };
}
const opts = (db, mops, iso, extra = {}) => ({ db, fetchImpl: mops.fetchImpl, decode: b => b.toString('utf8'), paceFn: async () => {}, now: new Date(iso), ...extra });
const quiet = () => {};
const v1 = { month: '2026-08', n: 3, bySrc: { 上市: 2, 上櫃: 1 }, at: 1, rowsJson: JSON.stringify([{ c: '1000', rev: 1, yoy: 0, mom: 0 }, { c: '2867', rev: 5, yoy: 1, mom: 1 }, { c: '3000', rev: 7, yoy: 2, mom: 2 }]) };

test('舊版文件（≥1700 也不再凍結）：抓 4 頁、依代號聯集（官方新值覆蓋、舊代號留存）、寫 v2＋組成；同筆數相隔 ≥3 日才定版，定版後 0 請求', async () => {
  const db = fakeDb({ '2026-08': v1 }); const mops = fakeMops();
  await backfillMopsRevenue(1, quiet, opts(db, mops, '2026-09-12T07:10:00Z'));   // 台北 09-12 15:10 ⇒ 處理 2026-08
  assert.deepEqual(mops.calls, ['sii_0', 'sii_1', 'otc_0', 'otc_1']);
  let d = db.store.get('2026-08').data;
  assert.equal(d.v, 2); assert.equal(d.final, false); assert.equal(d.n, 1106);
  assert.deepEqual(d.bySrc, { 上市: 900, 上市KY: 80, 上櫃: 100, 上櫃KY: 25, 留存: 1 }); assert.equal(d.kyN, 105);
  const rows = JSON.parse(d.rowsJson); const r1000 = rows.find(r => r.c === '1000');
  assert.equal(r1000.rev, 1000, '官方新值覆蓋'); assert.equal(r1000.yoy, 25); assert.ok(rows.some(r => r.c === '2867'), '舊代號留存');
  assert.equal(d.bytes, Buffer.byteLength(d.rowsJson)); assert.equal(d.fetchLog.length, 1);
  await backfillMopsRevenue(1, quiet, opts(db, mops, '2026-09-14T07:10:00Z'));
  assert.equal(db.store.get('2026-08').data.final, false, '只差 2 日');
  await backfillMopsRevenue(1, quiet, opts(db, mops, '2026-09-15T07:10:00Z'));
  d = db.store.get('2026-08').data; assert.equal(d.final, true, '相隔 3 日、筆數沒增加 ⇒ 定版');
  const before = mops.calls.length; const log = [];
  const r = await backfillMopsRevenue(1, m => log.push(m), opts(db, mops, '2026-09-16T07:10:00Z'));
  assert.equal(mops.calls.length, before, '已定版不再打 MOPS'); assert.equal(r.skip, 1);
});

test('KY 頁內容過短（回音認不得）：照寫本國＋另一市場 KY，但不記觀測、不定版；_0 回音不符則整月不寫', async () => {
  const db = fakeDb({ '2026-08': v1 });
  const short = fakeMops((mkt, page) => (mkt === 'sii' && page === '1' ? '<html>短</html>' : null));
  await backfillMopsRevenue(1, quiet, opts(db, short, '2026-09-12T07:10:00Z'));
  const d = db.store.get('2026-08').data;
  assert.equal(d.v, 2); assert.equal(d.final, false); assert.deepEqual(d.fetchLog, []);
  assert.match(String(d.pages['上市KY']), /^ERR 回音不符/); assert.equal(d.bySrc['上櫃KY'], 25);
  const db2 = fakeDb({ '2026-08': v1 }); const log = [];
  const wrongMonth = fakeMops((mkt, page, roc) => (page === '0' && mkt === 'otc' ? pageHtml('otc', roc, 7, '0', CODES.otc0) : null));
  const r = await backfillMopsRevenue(1, m => log.push(m), opts(db2, wrongMonth, '2026-09-12T07:10:00Z'));
  assert.equal(r.fail, 1); assert.equal(db2.writes.length, 0); assert.match(log.join('\n'), /不寫入/);
});

test('封鎖訊號（403／封鎖頁）：立即停、不再發請求、不寫入', async () => {
  const db = fakeDb({ '2026-08': v1, '2026-07': v1 });
  const blocked = fakeMops(() => ({ status: 403 }));
  const r = await backfillMopsRevenue(2, quiet, opts(db, blocked, '2026-09-12T07:10:00Z'));
  assert.equal(blocked.calls.length, 1); assert.equal(r.fail, 1); assert.equal(db.writes.length, 0);
  const page = fakeMops(() => '<html>FOR SECURITY REASONS, this page can not be accessed</html>');
  await backfillMopsRevenue(2, quiet, opts(fakeDb({ '2026-08': v1 }), page, '2026-09-12T07:10:00Z'));
  assert.equal(page.calls.length, 1);
});

test('openapi 薄版（無 v、無 bySrc）不當聯集基底：未上市代號不留存；新月份用 create；dry-run 不寫', async () => {
  const thin = { month: '2026-08', n: 2, at: 1, rowsJson: JSON.stringify([{ c: '1000', rev: 1 }, { c: '9998', rev: 9 }]) };
  const db = fakeDb({ '2026-08': thin }); const mops = fakeMops();
  await backfillMopsRevenue(1, quiet, opts(db, mops, '2026-09-12T07:10:00Z'));
  const rows = JSON.parse(db.store.get('2026-08').data.rowsJson);
  assert.ok(!rows.some(r => r.c === '9998'), '_P 未上市公司被官方 4 頁取代'); assert.equal(db.store.get('2026-08').data.bySrc['留存'], 0);
  const empty = fakeDb(); await backfillMopsRevenue(1, quiet, opts(empty, fakeMops(), '2026-09-12T07:10:00Z'));
  assert.deepEqual(empty.writes, [['create', '2026-08']]);
  const dry = fakeDb({ '2026-08': v1 }); const log = [];
  await backfillMopsRevenue(1, m => log.push(m), opts(dry, fakeMops(), '2026-09-12T07:10:00Z', { dryRun: true }));
  assert.equal(dry.writes.length, 0); assert.match(log.join('\n'), /dry-run/);
});

test('讀寫之間文件被別人改過（前置條件失敗）：本輪放棄、記失敗，不蓋掉對方', async () => {
  const db = fakeDb({ '2026-08': v1 }); const mops = fakeMops();
  const orig = db.collection; const log = [];
  db.collection = () => { const c = orig(); return { doc: id => { const d = c.doc(id); return { ...d, update: async (x) => d.update(x, { lastUpdateTime: -1 }) }; } }; };
  const r = await backfillMopsRevenue(1, m => log.push(m), opts(db, mops, '2026-09-12T07:10:00Z'));
  assert.equal(r.fail, 1); assert.equal(db.store.get('2026-08').data.v, undefined); assert.match(log.join('\n'), /FAILED_PRECONDITION/);
});
