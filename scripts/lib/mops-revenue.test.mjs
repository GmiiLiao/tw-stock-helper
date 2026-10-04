// MOPS 月營收彙總表純函式測試：node --test scripts/lib/mops-revenue.test.mjs
// 測試資料是從第二大腦鏡像 2026-08 的 _0／_1 原頁剪下的列（結構原樣：<Td 大寫、&nbsp; 留白、產業合計列、表尾全體合計）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from './mops-revenue.mjs';

const head = (mk, roc, m) => `<html><head><meta http-equiv='Content-Type' content='text/html; charset=big5'></head><body><center><font size='5'><b>${mk}公司${roc}年${m}月份(累計與當月)營業收入統計表</b></font>`
  + `<div class=tt>出表日期：115/10/04<!--20:00:18--></div><table border=0 width=100%><tr><th class=tt align=left >產業別：水泥工業</th><th class=tt align=right >單位：千元</th></tr>`
  + `<tr><th class=tt>公司<br>代號</th><th class=tt>公司名稱</th><th class=tt>當月營收</th></tr>`;
const row = (c, n, cells) => `<tr align=right><td align=center>${c}</td><td align=left>${n}</td>${cells.map((v, i) => (i === 4 ? `<Td nowrap>${v}</td>` : v === '' ? '<td>&nbsp;</td>' : `<td nowrap>                ${v}</td>`)).join('')}<td align=left>-</td></tr>`;
const total = (label) => `<tr align=right><th class=tt nowrap colspan=2 align=center>${label}</th><td nowrap>20,582,654</td><td nowrap>20,910,731</td><td nowrap>19,664,182</td><td nowrap>-1.56</td><td nowrap>4.67</td><td >155,611,301</td><td >157,923,850</td><td nowrap>-1.46</td><td>&nbsp;</td></tr>`;
const tail = (kind, mk) => `${total(`全部${kind}${mk}公司合計`)}</table></body></html>`;

// 上市本國 _0：台泥（<Td 大寫）、中光電投控（上月與去年同月為 0 ⇒ 兩個 % 留白）、營收 0 的新藥（丟棄）、產業合計列
const SII0 = head('上市', 115, 8)
  + row('1101', '台泥', ['13,515,534', '13,744,103', '12,214,776', '-1.66', '10.64', '98,726,969', '96,131,621', '2.69'])
  + row('3718', '中光電投控', ['3,428,522', '0', '0', '', '', '3,428,522', '0', ''])
  + row('6785', '昱展新藥', ['0', '0', '0', '', '', '0', '0', ''])
  + total('合計') + tail('國內', '上市');
// 上市外國 _1：太景*-KY（名稱含 *）、泰金寶-DR（4 碼 DR 保留）、晨訊科-DR（6 碼，不收）
const SII1 = head('上市', 115, 8)
  + row('4157', '太景*-KY', ['44,123', '40,001', '30,000', '10.30', '47.08', '300,000', '250,000', '20.00'])
  + row('9105', '泰金寶-DR', ['11,805,184', '13,956,638', '8,303,657', '-15.41', '42.16', '88,722,925', '80,247,373', '10.56'])
  + row('912000', '晨訊科-DR', ['123,881', '72,381', '76,038', '71.15', '62.91', '964,712', '1,004,081', '-3.92'])
  + tail('國外', '上市');
const OTC1 = head('上櫃', 115, 8)
  + row('2924', '宏太-KY', ['2,160', '2,949', '3,992', '-26.75', '-45.89', '33,848', '33,324', '1.57'])
  + tail('國外', '上櫃');

test('t21Url：民國年、月份不補零、頁碼', () => {
  assert.equal(R.t21Url('sii', 115, 8, '1'), 'https://mopsov.twse.com.tw/nas/t21/sii/t21sc03_115_8_1.html');
  assert.equal(R.T21_PAGES.map(p => `${p.mkt}_${p.page}:${p.label}`).join(','), 'sii_0:上市,sii_1:上市KY,otc_0:上櫃,otc_1:上櫃KY');
});

test('_0 解析：11 欄、<Td 大寫、千分位、負百分比；產業標題與合計列被濾掉；營收 0 丟棄；留白 % 存 null 不補 0', () => {
  const rows = R.parseT21sc03(SII0);
  assert.deepEqual(rows.map(r => r.c), ['1101', '3718']);
  assert.deepEqual(rows[0], { c: '1101', n: '台泥', rev: 13515534, prev: 13744103, last: 12214776, mom: -1.66, yoy: 10.64, cum: 98726969 });
  assert.equal(rows[1].yoy, null); assert.equal(rows[1].mom, null);
  assert.equal(rows[1].prev, 0); assert.equal(rows[1].last, 0);   // 金額欄官方寫 0 就是 0
});

test('_1 解析：KY 名稱照留（含 *）、4 碼 DR 保留、6 碼存託憑證不收', () => {
  const rows = R.parseT21sc03(SII1);
  assert.deepEqual(rows.map(r => `${r.c}${r.n}`), ['4157太景*-KY', '9105泰金寶-DR']);
  assert.equal(R.parseT21sc03(OTC1)[0].yoy, -45.89);
});

test('回音：市場＋民國年＋月＋本國／外國都要相符；1 月與 11 月不互相誤配', () => {
  assert.deepEqual(R.t21Echo(SII0), { market: 'sii', roc: 115, month: 8, kind: '0', kindMarket: 'sii' });
  assert.equal(R.echoOk(SII0, 'sii', 115, 8, '0'), true);
  assert.equal(R.echoOk(SII1, 'sii', '115', '8', '1'), true);
  assert.equal(R.echoOk(OTC1, 'sii', 115, 8), false, '上櫃頁當成上市送進來要被拒');
  assert.equal(R.echoOk(SII0, 'sii', 115, 9), false, '月份不符');
  assert.equal(R.echoOk(SII0, 'sii', 114, 8), false, '年份不符');
  assert.equal(R.echoOk(SII0, 'sii', 115, 8, '1'), false, '_0 內容出現在 _1 網址＝拒');
  assert.equal(R.echoOk(SII1, 'sii', 115, 8, '0'), false, '_1 內容出現在 _0 網址＝拒');
  const jan = head('上市', 115, 1) + tail('國內', '上市'); const nov = head('上市', 115, 11) + tail('國內', '上市');
  assert.equal(R.echoOk(jan, 'sii', 115, 11), false); assert.equal(R.echoOk(nov, 'sii', 115, 1), false);
  assert.equal(R.echoOk(nov, 'sii', 115, 11, '0'), true);
  assert.equal(R.t21Echo('<html>系統忙碌中</html>'), null);
  assert.equal(R.echoOk(head('上市', 115, 8), 'sii', 115, 8, '0'), false, '沒有表尾（內容過短）＝無法確認本國／外國');
});

test('mergeRows：只補缺時舊值不變；override 新值取代但舊代號保留；結果筆數 ≥ 舊筆數；不改動輸入', () => {
  const old = [{ c: '1101', rev: 1, yoy: 0 }, { c: '2867', rev: 5, yoy: 1 }];
  const neu = [{ c: '1101', rev: 2, yoy: null }, { c: '4157', rev: 3, yoy: 2 }];
  const add = R.mergeRows(old, neu);
  assert.deepEqual(add.map(r => `${r.c}:${r.rev}`), ['1101:1', '2867:5', '4157:3']);
  const ovr = R.mergeRows(old, neu, { override: true });
  assert.deepEqual(ovr.map(r => `${r.c}:${r.rev}`), ['1101:2', '2867:5', '4157:3']);
  assert.ok(ovr.length >= old.length);
  assert.equal(old[0].rev, 1, '輸入未被改動');
  assert.deepEqual(R.mergeRows([], []), []);
});

test('combinePages＋composition：各頁貢獻、留存、KY 檔數；重疊代號只取第一次', () => {
  const pages = [
    { label: '上市', rows: R.parseT21sc03(SII0) }, { label: '上市KY', rows: R.parseT21sc03(SII1) },
    { label: '上櫃KY', rows: [...R.parseT21sc03(OTC1), { c: '1101', rev: 9 }] },
  ];
  const { rows, srcOf, dup } = R.combinePages(pages);
  assert.equal(rows.length, 5); assert.deepEqual(dup, ['1101']);
  const merged = R.mergeRows([{ c: '2867', rev: 5 }], rows);
  const { bySrc, kyN } = R.composition(merged, srcOf);
  assert.deepEqual(bySrc, { 上市: 2, 上市KY: 2, 上櫃: 0, 上櫃KY: 1, 留存: 1 });
  assert.equal(kyN, 3);
});

test('略過邏輯：沒有 v → 重抓；v2 且 final → 略過；v2 未定版 → 重抓', () => {
  assert.equal(R.shouldSkipMonth(null), false);
  assert.equal(R.shouldSkipMonth({ n: 1900 }), false, '舊版 ≥1700 也要重抓（不再永久凍結）');
  assert.equal(R.shouldSkipMonth({ v: 2, final: true }), true);
  assert.equal(R.shouldSkipMonth({ v: 2, final: false }), false);
  assert.equal(R.shouldSkipMonth({ v: 1, final: true }), false);
});

test('openapi 薄版辨識：沒有 v 也沒有 bySrc 的文件不當聯集基底', () => {
  assert.equal(R.isOpenapiDoc({ n: 1349, rowsJson: '[]' }), true);
  assert.equal(R.isOpenapiDoc({ n: 1832, bySrc: { 上市: 975, 上櫃: 857 } }), false, 'MOPS 舊版（有 bySrc）');
  assert.equal(R.isOpenapiDoc({ v: 2 }), false);
  assert.equal(R.isOpenapiDoc(null), false);
});

test('rowsOf：陣列／物件皆可；沒有 rowsJson 回空；壞 JSON 丟錯', () => {
  assert.deepEqual(R.rowsOf({ rowsJson: '[{"c":"1101"}]' }), [{ c: '1101' }]);
  assert.deepEqual(R.rowsOf({ rowsJson: '{"a":{"c":"1101"}}' }), [{ c: '1101' }]);
  assert.deepEqual(R.rowsOf(undefined), []);
  assert.throws(() => R.rowsOf({ rowsJson: '{bad' }));
});

const at = iso => Date.parse(iso);   // 以 UTC 寫時刻；台北＝+8
test('定版看資料：次月 11 日起兩次成功抓取相隔 ≥3 日且筆數沒增加才定版', () => {
  const id = '2026-08';
  assert.equal(R.nextMonthDay(id, 11), '2026-09-11');
  assert.equal(R.nextMonthDay('2026-12', 11), '2027-01-11', '跨年');
  // 申報期內（09-09、09-10）不算
  assert.equal(R.revenueFinal(id, [{ at: at('2026-09-01T12:00Z'), n: 1900 }, { at: at('2026-09-10T12:00Z'), n: 1900 }]), false);
  // 11 日起只有一次
  assert.equal(R.revenueFinal(id, [{ at: at('2026-09-10T12:00Z'), n: 1900 }, { at: at('2026-09-11T02:00Z'), n: 1900 }]), false);
  // 09-11 與 09-13：只差 2 日
  assert.equal(R.revenueFinal(id, [{ at: at('2026-09-11T02:00Z'), n: 1900 }, { at: at('2026-09-13T07:00Z'), n: 1900 }]), false);
  // 09-11 與 09-14：差 3 日、筆數相同 ⇒ 定版
  assert.equal(R.revenueFinal(id, [{ at: at('2026-09-11T02:00Z'), n: 1900 }, { at: at('2026-09-14T07:00Z'), n: 1900 }]), true);
  // 中途筆數增加（晚申報者上表）⇒ 從增加那次重新起算
  assert.equal(R.revenueFinal(id, [{ at: at('2026-09-11T02:00Z'), n: 1900 }, { at: at('2026-09-13T07:00Z'), n: 1918 }, { at: at('2026-09-14T07:00Z'), n: 1918 }]), false);
  assert.equal(R.revenueFinal(id, [{ at: at('2026-09-11T02:00Z'), n: 1900 }, { at: at('2026-09-13T07:00Z'), n: 1918 }, { at: at('2026-09-16T07:00Z'), n: 1918 }]), true);
  // 台北日界：09-10 23:30（UTC 15:30）仍屬申報期
  assert.equal(R.revenueFinal(id, [{ at: at('2026-09-10T15:30Z'), n: 1900 }, { at: at('2026-09-13T17:00Z'), n: 1900 }]), false);
  assert.equal(R.revenueFinal('2026-12', [{ at: at('2027-01-11T02:00Z'), n: 1900 }, { at: at('2027-01-14T02:00Z'), n: 1900 }]), true, '12 月 → 次年 1 月');
  assert.equal(R.revenueFinal(id, null), false);
});

test('fetchLog：同筆數連續觀測只留起點＋最新（不跨 11 日界線）、上限 8 筆；一天三輪也不擠掉起點', () => {
  const id = '2026-08'; let log = [];
  const days = ['2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14'];
  for (const d of days) for (const h of ['01', '07', '08']) log = R.appendFetchLog(log, { at: at(`${d}T${h}:00:00Z`), n: 1900, src: 'mops' }, { monthId: id });
  assert.ok(log.length <= R.FETCH_LOG_MAX);
  assert.equal(R.taipeiDay(log.find(e => R.taipeiDay(e.at) >= '2026-09-11').at), '2026-09-11', '11 日後的起點保住');
  assert.equal(R.revenueFinal(id, log), true);
  let many = [];
  for (let i = 0; i < 20; i++) many = R.appendFetchLog(many, { at: at('2026-09-12T00:00Z') + i * 864e5, n: 1900 + i }, { monthId: id });
  assert.equal(many.length, R.FETCH_LOG_MAX); assert.equal(many.at(-1).n, 1919);
  assert.deepEqual(R.appendFetchLog(undefined, { at: 1, n: 2 }), [{ at: 1, n: 2 }]);
  const late = R.appendFetchLog([{ at: 10, n: 5 }, { at: 30, n: 5 }], { at: 20, n: 5, src: 'mirror' });
  assert.deepEqual(late.map(e => e.at), [10, 20, 30], '較舊的觀測依時間插入、不擠掉最新一筆');
});

test('捏造的 0 修正：只在歸檔是 0 且官方該格留白時改 null，其他不動', () => {
  const official = new Map(R.parseT21sc03(SII0).map(r => [r.c, r]));
  const arch = [{ c: '3718', rev: 3428522, yoy: 0, mom: 0 }, { c: '1101', rev: 1, yoy: 0, mom: -1.66 }, { c: '2867', yoy: 0, mom: 0 }];
  const { rows, yoy, mom } = R.fixFabricatedZeros(arch, official);
  assert.deepEqual(yoy, ['3718']); assert.deepEqual(mom, ['3718']);
  assert.equal(rows[0].yoy, null); assert.equal(rows[0].rev, 3428522);
  assert.equal(rows[1].yoy, 0, '官方是 10.64 不是留白：不動（數值差異不屬本修正）');
  assert.equal(rows[2].yoy, 0, '官方頁沒有這個代號：不動');
  assert.equal(arch[0].yoy, 0, '輸入未被改動');
});
