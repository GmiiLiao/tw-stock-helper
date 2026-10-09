import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TWSE_INDUSTRY, industryNameOf, rocToIsoDate, parseTwseCompanyRows, parseTpexCompanyRows, mirrorVerifiedIso, daysBetween,
  mergeIndustryMaps, isIndustryMapComplete, isIndustryCacheFresh, nextIndustryCache, industryMapHealth, INDUSTRY_MIN_PER_MARKET,
} from './industry-map.mjs';

const readText = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const fill = (n, start, name) => Object.fromEntries(Array.from({ length: n }, (_, i) => [String(start + i), name]));

test('industryNameOf：兩市同一張代碼表；17 一律「金融保險」（上櫃官方名「金融業」同代碼併類）；未知代碼不捏造名稱', () => {
  assert.equal(industryNameOf('24'), '半導體');
  assert.equal(industryNameOf('17'), '金融保險');
  assert.equal(industryNameOf('32'), '文化創意');
  assert.equal(industryNameOf('33'), '農業科技');
  assert.equal(industryNameOf(' 99 '), '類別99');
  assert.equal(industryNameOf(''), null);
  assert.equal(industryNameOf(null), null);
});

test('rocToIsoDate：民國 7 碼（含斜線）→ ISO；認不得回 null', () => {
  assert.equal(rocToIsoDate('1151008'), '2026-10-08');
  assert.equal(rocToIsoDate('115/10/04'), '2026-10-04');
  assert.equal(rocToIsoDate('20261008'), null);
  assert.equal(rocToIsoDate(undefined), null);
});

test('parseTpexCompanyRows：上櫃英文鍵；同代碼與上市解析出同名（兩市同一口徑）；非 4 碼與缺代碼略過', () => {
  const otc = parseTpexCompanyRows([
    { Date: '1151008', SecuritiesCompanyCode: '1240', SecuritiesIndustryCode: '33' },
    { SecuritiesCompanyCode: '5876', SecuritiesIndustryCode: '17' },
    { SecuritiesCompanyCode: '3105', SecuritiesIndustryCode: '24' },
    { SecuritiesCompanyCode: '00679B', SecuritiesIndustryCode: '20' },
    { SecuritiesCompanyCode: '6488', SecuritiesIndustryCode: '' },
  ]);
  assert.deepEqual(otc.map, { 1240: '農業科技', 5876: '金融保險', 3105: '半導體' });
  assert.equal(otc.feedIso, '2026-10-08');
  const tse = parseTwseCompanyRows([{ 出表日期: '1151007', 公司代號: '2330', 產業別: '24' }, { 公司代號: '2881', 產業別: '17' }]);
  assert.deepEqual(tse.map, { 2330: '半導體', 2881: '金融保險' });
  assert.equal(tse.feedIso, '2026-10-07');
  assert.equal(otc.map['3105'], tse.map['2330']);   // 同代碼同名：族群不會被拆成兩群
  assert.deepEqual(parseTpexCompanyRows(null), { map: {}, feedIso: null });
});

test('打包快照 t187ap03_O_fallback.json（上櫃最後後備）：≥300 檔、每個代碼都在代碼表內（沒有「類別XX」）', () => {
  const { map, feedIso } = parseTpexCompanyRows(JSON.parse(readText('../../src/lib/t187ap03_O_fallback.json')));
  assert.ok(Object.keys(map).length >= INDUSTRY_MIN_PER_MARKET, `只有 ${Object.keys(map).length} 檔`);
  const unknown = Object.entries(map).filter(([, v]) => v.startsWith('類別'));
  assert.deepEqual(unknown, []);
  assert.match(feedIso, /^\d{4}-\d{2}-\d{2}$/);
  const names = new Set(Object.values(TWSE_INDUSTRY));
  for (const v of new Set(Object.values(map))) assert.ok(names.has(v), v);
});

test('mirrorVerifiedIso：內容沒變的快照只記 unchanged——新鮮度看 manifest 的 at，不看檔名；壞 manifest 退回檔名日', () => {
  const man = { rows: {
    '2026-10-02': { status: 'ok', file: '2026-10-02.json.gz', at: '2026-10-04T10:12:20.733Z' },
    '2026-10-08': { status: 'unchanged', same: '2026-10-02.json.gz', at: '2026-10-08T14:45:31.934Z' },
    '2026-10-09': { status: 'error', at: '2026-10-09T14:45:00.000Z' },
  } };
  assert.equal(mirrorVerifiedIso(man, '2026-10-02'), '2026-10-08');
  assert.equal(mirrorVerifiedIso(null, '2026-10-02'), '2026-10-02');
  assert.equal(mirrorVerifiedIso({ rows: 'x' }, null), null);
  assert.equal(daysBetween('2026-10-08', '2026-10-19'), 11);
  assert.equal(daysBetween(null, '2026-10-19'), null);
});

test('mergeIndustryMaps：map＝兩市；listed＝只有上市（漲停預測／話題選股／做空弱勢產業用）；上櫃不覆蓋上市', () => {
  const r = mergeIndustryMaps({ listed: { 2330: '半導體', 2881: '金融保險' }, otc: { 3105: '半導體', 2330: '其他' } });
  assert.deepEqual(r.map, { 2330: '半導體', 2881: '金融保險', 3105: '半導體' });
  assert.deepEqual(r.listed, { 2330: '半導體', 2881: '金融保險' });
  assert.equal(r.listed['3105'], undefined);
  assert.deepEqual(r.counts, { listed: 2, otc: 1, peer: 0, total: 3 });
});

test('mergeIndustryMaps：peerComps 只補上市缺口，算進 listed', () => {
  const r = mergeIndustryMaps({ listed: {}, otc: { 3105: '半導體' }, peer: { 半導體: [{ code: '2330' }, { code: '3105' }, { code: 'x' }], 壞: 'no' } });
  assert.deepEqual(r.listed, { 2330: '半導體' });
  assert.equal(r.map['3105'], '半導體');
  assert.deepEqual(r.counts, { listed: 1, otc: 1, peer: 1, total: 2 });
});

test('isIndustryMapComplete：「總數 > 門檻」不是完整性條件——2026-10-09 前實況（上市 1,089、上櫃 0）＝不完整', () => {
  assert.equal(isIndustryMapComplete({ listed: 1089, otc: 0, total: 1089 }), false);
  assert.equal(isIndustryMapComplete({ listed: 0, otc: 893, total: 893 }), false);
  assert.equal(isIndustryMapComplete({ listed: 1095, otc: 893 }), true);
});

test('nextIndustryCache／isIndustryCacheFresh：完整表當日有效；殘缺新表不覆蓋較完整舊表、冷卻後重試', () => {
  const full = mergeIndustryMaps({ listed: fill(400, 1000, '半導體'), otc: fill(400, 5000, '光電') });
  const a = nextIndustryCache({}, full, { today: '2026-10-09', now: 0, retryMs: 1000 });
  assert.equal(a.complete, true); assert.equal(a.better, true);
  assert.equal(isIndustryCacheFresh(a.next, { today: '2026-10-09', now: 5 }), true);
  assert.equal(isIndustryCacheFresh(a.next, { today: '2026-10-10', now: 5 }), false);   // 換日重載
  const partial = mergeIndustryMaps({ listed: fill(400, 1000, '半導體') });
  const b = nextIndustryCache(a.next, partial, { today: '2026-10-10', now: 100, retryMs: 1000 });
  assert.equal(b.better, false);
  assert.equal(Object.keys(b.next.map).length, 800);   // 沿用舊的完整表
  assert.equal(b.next.date, '2026-10-09');
  assert.equal(isIndustryCacheFresh(b.next, { today: '2026-10-10', now: 500 }), true);   // 冷卻內不重抓
  assert.equal(isIndustryCacheFresh(b.next, { today: '2026-10-10', now: 1200 }), false);
  assert.equal(isIndustryCacheFresh({ map: null }, { today: '2026-10-10', now: 0 }), false);
});

test('industryMapHealth：上櫃整批缺要明說是上櫃、不是「總數夠多」', () => {
  const h = industryMapHealth({ counts: { listed: 1089, otc: 0, peer: 0, total: 1089 }, complete: false, today: '2026-10-09', listedSrc: 'openapi' });
  assert.equal(h.ok, false); assert.equal(h.complete, false);
  assert.equal(h.listedN, 1089); assert.equal(h.otcN, 0);
  assert.equal(h.problems.length, 1);
  assert.match(h.problems[0], /上櫃只有 0 檔/);
});

test('industryMapHealth：鏡像正常＝ok；鏡像過舊／退到打包快照／上市退鏡像都要列 problem（完整但不 ok）', () => {
  const counts = { listed: 1095, otc: 893, peer: 0, total: 1988 };
  const ok = industryMapHealth({ counts, complete: true, usingIso: '2026-10-09', today: '2026-10-09', listedSrc: 'openapi', otcSrc: 'mirror', feedIso: '2026-10-08', mirrorAgeDays: 1 });
  assert.equal(ok.ok, true); assert.deepEqual(ok.problems, []);
  assert.equal(ok.feedDate, '2026-10-08'); assert.equal(ok.date, '2026-10-09'); assert.equal(ok.totalN, 1988);
  const old = industryMapHealth({ counts, complete: true, today: '2026-10-25', listedSrc: 'openapi', otcSrc: 'mirror', mirrorAgeDays: 17, staleDays: 10 });
  assert.equal(old.complete, true); assert.equal(old.ok, false);
  assert.match(old.problems[0], /已 17 天未更新/);
  const bundled = industryMapHealth({ counts, complete: true, today: '2026-10-09', listedSrc: 'mirror', otcSrc: 'bundled', feedIso: '2026-10-04' });
  assert.equal(bundled.ok, false);
  assert.ok(bundled.problems.some(p => /打包快照（出表 2026-10-04）/.test(p)));
  assert.ok(bundled.problems.some(p => /改用官方鏡像/.test(p)));
  const stale = industryMapHealth({ counts: { listed: 0, otc: 893, total: 893 }, complete: false, usingIso: '2026-10-08', stale: true, today: '2026-10-09' });
  assert.equal(stale.date, '2026-10-08');
  assert.ok(stale.problems.some(p => /沿用 2026-10-08/.test(p)));
});

test('industryMapHealth：欄位全部有值（Firestore 不收 undefined）；日期欄只用已登記的 date／feedDate', () => {
  const h = industryMapHealth({ counts: null, complete: false });
  for (const [k, v] of Object.entries(h)) assert.notEqual(v, undefined, k);
  for (const k of Object.keys(h)) if (/(At|Date)$/.test(k)) assert.ok(['feedDate'].includes(k), k);
});

// ── daemon 呼叫端口徑（使用者裁定 2026-10-03：這三處重訓／切分樣本前只用上市）──
const DAEMON = readText('../ai-daemon.mjs');
const bodyOf = name => {
  const i = DAEMON.indexOf(`async function ${name}(`);
  assert.ok(i >= 0, name);
  const j = DAEMON.indexOf('\nasync function ', i + 10);
  return DAEMON.slice(i, j < 0 ? undefined : j);
};

test('daemon：漲停預測 LU_LIFT、話題選股、做空弱勢產業 +2 只用上市表（listedOnly）', () => {
  for (const fn of ['computeLimitUpForecast', 'computeTopicPicks', 'computeShortCandidates']) {
    const b = bodyOf(fn);
    const calls = b.match(/getIndustryMap\([^)]*\)/g) || [];
    assert.ok(calls.length >= 1, `${fn} 沒有呼叫 getIndustryMap`);
    for (const c of calls) assert.match(c, /listedOnly: true/, `${fn}：${c}`);
  }
});

test('daemon：不再打 openapi.twse 上不存在的 t187ap03_O；daemonHealth 帶 industryMap', () => {
  assert.ok(!/opendata\/\$\{ep\}/.test(bodyOf('loadIndustryMap')));
  assert.ok(!DAEMON.includes("'t187ap03_L', 't187ap03_O'"));
  assert.match(bodyOf('writeDaemonHealth'), /industryMap: _indMap\.health \|\| null/);
});

test('daemon：資料到齊班車跨日不跑、推薦成績名單帶日期；跨午夜續跑重取時刻', () => {
  assert.match(DAEMON, /if \(mins >= 16 \* 60 \+ 45 && _otcFixDate !== today && _shuttleNowIso === today && Date\.now\(\) >= _otcReadyNextAt\)/);
  assert.match(DAEMON, /step\('推薦成績名單', \(\) => trackPicks\(\{ canonical: true, date: today \}\)\)/);
  const carry = bodyOf('canonCarryTick');
  assert.match(carry, /const tw = taipei\(\); const today = isoDate\(tw\); const mins = /);
  assert.match(carry, /if \(today !== loopToday \|\| mins >= CANON_CARRY_END_MIN\) return;/);
});
