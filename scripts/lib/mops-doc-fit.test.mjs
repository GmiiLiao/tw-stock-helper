// mopsNews 日文件大小保護（位元組）單元測試：node --test scripts/lib/mops-doc-fit.test.mjs
//   2026-10-08 X18（jev-score-usage-spec 附錄 B；plan B2-4 i）：舊版以 `json.length > 900_000`（字元數）判斷，
//   中文 UTF-8 約 3 bytes／字 ⇒ 位元組先超過 1 MiB、裁切來不及觸發；且固定保留 300 則內文（300×1200 字×3 ≈ 1.08 MB）本身就放不下。
//   改用 news-verdict-write 的 firestoreDocBytes 估整份文件，超標時保留「放得下的最多則最新內文」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitMopsDayDoc, MOPS_DOC_SOFT_MAX, FIRESTORE_DOC_MAX, MOPS_BODY_TRIM_TAG, skipBodyRefetch } from './mops-doc-fit.mjs';
import { firestoreDocBytes } from './news-verdict-write.mjs';

const BODY = '本公司董事會決議通過重要事項說明'.repeat(75).slice(0, 1200);   // 1,200 個中文字 ≈ 3,600 bytes
const mkItems = (n, withBody = true) => {
  const o = {};
  for (let i = 0; i < n; i++) {
    const key = `sii-1151008-${i}-${1000 + (i % 900)}`;
    o[key] = { key, code: String(1000 + (i % 900)), name: '測試公司', subject: '公告本公司董事會決議事項', at: 1_760_000_000_000 + i * 1000, market: 'sii', enter: '1151008', serial: i, api: 't05st02_detail', body: withBody ? BODY : null };
  }
  return o;
};
const FIELDS = { date: '2026-10-08', dataDate: '2026-10-08', n: 0, updatedAt: 1, fetchedAt: 1, source: 'mops.twse.com.tw/mops/api/t05st02', note: '公開資訊觀測站當日重大訊息原文' };

test('門檻貼近 Firestore 上限（只在真的寫不進去時才清內文；審查 2026-10-08）：1,048,576 減 8,576 bytes 估算餘量', () => {
  assert.equal(FIRESTORE_DOC_MAX, 1_048_576);
  assert.equal(MOPS_DOC_SOFT_MAX, 1_040_000);
  assert.ok(MOPS_DOC_SOFT_MAX < FIRESTORE_DOC_MAX);
});

test('位元組落在 900,000～門檻之間（舊版字元數判斷能完整寫入的日子）⇒ 不清任何內文（不比舊版退化）', () => {
  let n = 200, r = null, bytes = 0;
  for (; n < 400; n++) {
    const items = mkItems(n);
    bytes = firestoreDocBytes('mopsNews/2026-10-08', { ...FIELDS, itemsJson: JSON.stringify(items) });
    if (bytes > 900_000) { r = fitMopsDayDoc({ docPath: 'mopsNews/2026-10-08', items, fields: FIELDS }); break; }
  }
  assert.ok(r, '找得到 >900,000 bytes 的筆數');
  assert.ok(bytes > 900_000 && bytes <= MOPS_DOC_SOFT_MAX, `${n} 則 ${bytes} bytes`);
  assert.equal(r.fits, true);
  assert.equal(r.clearedBodies, 0);
  assert.equal(r.keptBodies, null);
});

test('字元數 < 900,000 但位元組 > 1 MiB（舊版不會觸發）⇒ 會裁內文且裁後整份 ≤ 門檻', () => {
  const items = mkItems(300);
  const json = JSON.stringify(items);
  assert.ok(json.length < 900_000, `字元數 ${json.length}`);
  assert.ok(Buffer.byteLength(json, 'utf8') > 1_048_576, '位元組已超過 Firestore 上限');
  const r = fitMopsDayDoc({ docPath: 'mopsNews/2026-10-08', items, fields: FIELDS });
  assert.equal(r.fits, true);
  assert.ok(r.bytes <= MOPS_DOC_SOFT_MAX, String(r.bytes));
  assert.equal(r.bytes, firestoreDocBytes('mopsNews/2026-10-08', { ...FIELDS, itemsJson: r.json }));
  assert.ok(r.clearedBodies > 0 && r.keptBodies > 0, JSON.stringify({ k: r.keptBodies, c: r.clearedBodies }));
  assert.equal(Object.keys(r.items).length, 300, '公告本身一則不少，只清內文');
});

test('保留的是最新的內文、且是放得下的最多則（再多 1 則就超標）', () => {
  const items = mkItems(300);
  const r = fitMopsDayDoc({ docPath: 'mopsNews/2026-10-08', items, fields: FIELDS });
  const byNew = Object.values(r.items).sort((a, b) => b.at - a.at);
  const kept = byNew.filter(x => x.body).length;
  assert.equal(kept, r.keptBodies);
  assert.ok(byNew.slice(0, kept).every(x => x.body) && byNew.slice(kept).every(x => !x.body), '最新的 k 則有內文、其餘清掉');
  assert.ok(byNew.slice(kept).every(x => x.bodyTrimmed === MOPS_BODY_TRIM_TAG), '清掉的標 bodyTrimmed＝本版裁切章（寫入端同一版下不再重抓放不下的內文）');
  assert.ok(byNew.slice(0, kept).every(x => !('bodyTrimmed' in x)), '保留的不加欄位');
  // k+1 放不下
  const plus = Object.fromEntries(Object.entries(r.items).map(([k, x]) => [k, x]));
  const next = byNew[kept];
  plus[next.key] = { ...next, body: BODY };
  assert.ok(firestoreDocBytes('mopsNews/2026-10-08', { ...FIELDS, itemsJson: JSON.stringify(plus) }) > MOPS_DOC_SOFT_MAX);
});

test('放得下就原樣（不清任何內文、回傳同一份內容）；不改動輸入', () => {
  const items = mkItems(50);
  const before = JSON.stringify(items);
  const r = fitMopsDayDoc({ docPath: 'mopsNews/2026-10-08', items, fields: FIELDS });
  assert.equal(r.fits, true);
  assert.equal(r.clearedBodies, 0);
  assert.equal(r.json, before);
  const big = mkItems(400);
  const bigBefore = JSON.stringify(big);
  fitMopsDayDoc({ docPath: 'mopsNews/2026-10-08', items: big, fields: FIELDS });
  assert.equal(JSON.stringify(big), bigBefore, '輸入物件不被改動（不可變）');
});

test('merge 寫入會留著的舊欄位也算進大小（keep）', () => {
  const items = mkItems(200);
  const keep = { legacyBlob: 'x'.repeat(400_000) };
  const a = fitMopsDayDoc({ docPath: 'mopsNews/2026-10-08', items, fields: FIELDS });
  const b = fitMopsDayDoc({ docPath: 'mopsNews/2026-10-08', items, fields: FIELDS, keep });
  const bodies = r => Object.values(r.items).filter(x => x.body).length;
  assert.equal(a.clearedBodies, 0, '不算舊欄位時放得下');
  assert.ok(bodies(b) < bodies(a), `${bodies(b)} < ${bodies(a)}`);
  assert.ok(b.bytes <= MOPS_DOC_SOFT_MAX);
  assert.equal(b.bytes, firestoreDocBytes('mopsNews/2026-10-08', { ...keep, ...FIELDS, itemsJson: b.json }));
});

test('連一則內文都不留仍放不下（主旨就超標）⇒ fits=false，交給寫入端記錯，不捏造截斷主旨', () => {
  const items = mkItems(10, false);
  const r = fitMopsDayDoc({ docPath: 'mopsNews/2026-10-08', items, fields: FIELDS, maxBytes: 500 });
  assert.equal(r.fits, false);
  assert.equal(r.keptBodies, 0);
});

test('bodyTrimmed 不是永久旗標：只有本版裁切章才跳過重抓；舊值（true）或改版（壓縮／分片上線換章）後會重抓（審查 2026-10-08）', () => {
  assert.match(MOPS_BODY_TRIM_TAG, /^mops-trim-/);
  assert.equal(skipBodyRefetch({ body: null, bodyTrimmed: MOPS_BODY_TRIM_TAG }), true);
  assert.equal(skipBodyRefetch({ body: null, bodyTrimmed: true }), false, '舊布林旗標（未上線過，防呆）不擋重抓');
  assert.equal(skipBodyRefetch({ body: null, bodyTrimmed: 'mops-trim-v0-old' }), false, '別版的章不擋重抓');
  assert.equal(skipBodyRefetch({ body: null }), false);
  assert.equal(skipBodyRefetch(null), false);
});
