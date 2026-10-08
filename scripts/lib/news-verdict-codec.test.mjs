// newsVerdict 壓縮格式（讀取端）單元測試：node --test scripts/lib/news-verdict-codec.test.mjs
//   壓縮往返、舊格式（明文）相容、兩種並存時壓縮優先、壞資料的處理、與既有明文解析（warroom-news newsBoardFromDoc）的相容。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gzB64, unGzB64, verdictJsonOf, seenJsonOf, verdictsOf, seenOf, plainNewsVerdictDoc, NV_GZ_FIELD,
} from './news-verdict-codec.mjs';
import { newsBoardFromDoc } from './warroom-news.mjs';

const YMD = '2026-10-09';
const V = (over = {}) => ({
  label: '利空', strength: '強', confidence: '高', certainty: '已確認', novelty: '首次', priced: '否', eventType: '訂單',
  basis: 'content', challenged: true, at: Date.parse(`${YMD}T07:20:00+08:00`), pass: 'morning', n: 3,
  reason: '主要客戶抽單，第四季出貨下修', keyQuote: '客戶通知第四季訂單取消三成', quoteVerified: 2, quoteFailed: 0, ...over,
});
const verdicts = { 2317: V(), 3231: V({ label: '利多', reason: '伺服器訂單能見度延到明年' }) };
const seen = { 2317: ['鴻海 AI 伺服器出貨', '鴻海 9 月營收創同期新高'], 3231: ['緯創接單'] };
const plainDoc = { date: YMD, targetDate: YMD, updatedAt: 1, lastPass: 'morning', verdictJson: JSON.stringify(verdicts), seenJson: JSON.stringify(seen) };
const gzDoc = { date: YMD, targetDate: YMD, updatedAt: 1, lastPass: 'morning', verdictGz: gzB64(JSON.stringify(verdicts)), seenGz: gzB64(JSON.stringify(seen)) };

test('gzip＋base64 往返：中文、空字串、大字串都原樣還原；輸出是 base64 字串', () => {
  for (const s of ['', '鴻海 AI 伺服器出貨「利多」', JSON.stringify({ a: '台積電'.repeat(20_000) })]) {
    const b = gzB64(s);
    assert.equal(typeof b, 'string');
    assert.match(b, /^[A-Za-z0-9+/]*={0,2}$/);
    assert.equal(unGzB64(b), s);
  }
  const big = JSON.stringify(Object.fromEntries(Array.from({ length: 400 }, (_, i) => [String(1101 + i), Array.from({ length: 60 }, (_, k) => `第${k}則 公司${i} 營收月增、法說會釋出展望`)])));
  assert.ok(gzB64(big).length < Buffer.byteLength(big) / 2, '已見標題這種重複多的 JSON 壓縮後至少小一半');
});

test('舊格式（只有明文欄位）照讀；新格式（壓縮欄位）讀出同一份；都沒有回 null／{}', () => {
  assert.equal(verdictJsonOf(plainDoc), plainDoc.verdictJson);
  assert.equal(seenJsonOf(plainDoc), plainDoc.seenJson);
  assert.equal(verdictJsonOf(gzDoc), plainDoc.verdictJson);
  assert.equal(seenJsonOf(gzDoc), plainDoc.seenJson);
  assert.deepEqual(verdictsOf(gzDoc), verdicts);
  assert.deepEqual(seenOf(gzDoc), seen);
  assert.deepEqual(verdictsOf(plainDoc), verdicts);
  for (const d of [null, undefined, {}, [], { verdictJson: 123 }]) {
    assert.equal(verdictJsonOf(d), null);
    assert.deepEqual(verdictsOf(d), {});
    assert.deepEqual(seenOf(d), {});
  }
  assert.deepEqual(NV_GZ_FIELD, { verdictJson: 'verdictGz', seenJson: 'seenGz' });
});

test('兩種格式並存時壓縮欄位優先（只有較新的寫入端會寫它）；latest 沒有 seen 欄位不影響判別表', () => {
  const both = { ...plainDoc, verdictJson: JSON.stringify({ 9999: V() }), verdictGz: gzB64(JSON.stringify(verdicts)) };
  assert.deepEqual(verdictsOf(both), verdicts);
  const latest = { date: YMD, targetDate: YMD, verdictGz: gzB64(JSON.stringify(verdicts)) };
  assert.deepEqual(verdictsOf(latest), verdicts);
  assert.equal(seenJsonOf(latest), null);
});

test('壞資料：verdictsOf／seenOf 丟錯（寫入端靠它讀前一份，不可吞成空表再覆寫）', () => {
  assert.throws(() => verdictsOf({ verdictGz: 'not-gzip' }));
  assert.throws(() => seenOf({ seenGz: gzB64('{bad json') }));
  assert.throws(() => verdictsOf({ verdictJson: '{bad' }));
});

test('plainNewsVerdictDoc：沒有壓縮欄位原物件奉還；有就轉成明文、拿掉壓縮欄位；壞掉的欄位當作不存在並記 nvDecodeError', () => {
  assert.equal(plainNewsVerdictDoc(plainDoc), plainDoc);
  assert.equal(plainNewsVerdictDoc(null), null);
  const p = plainNewsVerdictDoc(gzDoc);
  assert.notEqual(p, gzDoc);
  assert.equal(p.verdictJson, plainDoc.verdictJson);
  assert.equal(p.seenJson, plainDoc.seenJson);
  assert.ok(!('verdictGz' in p) && !('seenGz' in p));
  assert.ok('verdictGz' in gzDoc, '不改動原物件');
  const bad = plainNewsVerdictDoc({ ...gzDoc, verdictJson: '{"9999":{}}', verdictGz: 'broken' });
  assert.ok(!('verdictJson' in bad), '壓縮壞掉不拿可能過時的明文頂替');
  assert.match(bad.nvDecodeError, /^verdictGz: /);
  assert.equal(bad.seenJson, plainDoc.seenJson, '另一個欄位照常還原');
});

test('與既有明文解析相容：warroom-news newsBoardFromDoc 吃壓縮文件（先轉明文）與吃舊文件的結果相同；壞掉的回 null 不捏造', () => {
  const a = newsBoardFromDoc(plainDoc);
  const b = newsBoardFromDoc(plainNewsVerdictDoc(gzDoc));
  assert.ok(a && b);
  assert.deepEqual(b, a);
  assert.equal(newsBoardFromDoc(gzDoc), null, '沒轉明文的壓縮文件，舊解析看不到（所以呼叫端一定要先轉）');
  assert.equal(newsBoardFromDoc(plainNewsVerdictDoc({ ...gzDoc, verdictGz: 'broken' })), null);
});
