// newsVerdict 寫入大小保護單元測試：node --test scripts/lib/news-verdict-write.test.mjs
//   Firestore 大小估算（官方範例）、2026-10-07 實案規模不再超過上限且無損、降級順序（日文件無損優先／latest 相容優先）、
//   merge 留著的舊欄位要算進去、壓縮時要刪掉明文欄位、最後手段丟最舊判別、不改動輸入。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fitNewsVerdictDoc, firestoreDocBytes, firestoreValueBytes, NV_DOC_SOFT_MAX, NV_SEEN_TRIM, NV_MANAGED_FIELDS, NV_LOSSY_LEVELS, NV_LEVEL_TEXT,
} from './news-verdict-write.mjs';
import { verdictsOf, seenOf, gzB64, NV_DOC_LIMIT } from './news-verdict-codec.mjs';

// ── 測試資料：擬真中文（固定種子亂數，壓縮率不會好得不真實） ──────────────────────
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const POOL = '台積電鴻海聯發科營收月增年減法說會展望訂單出貨伺服器晶片封裝客戶產能擴產毛利率法人買超賣超股價漲停跌停利多利空中性強弱檢調搜索約談起訴羈押工安停工火災罰款董事會股利現金增資併購供應鏈蘋果輝達美國關稅匯率庫存調整第四季明年新高衰退成長回溫報價上漲下跌缺貨'.split('');
const text = (r, n) => Array.from({ length: n }, () => POOL[Math.floor(r() * POOL.length)]).join('');
const AT0 = Date.parse('2026-10-08T23:00:00+08:00');

/** n 檔判別；evN 檔帶完整稽核軌跡；carriedN 檔是承接來的（at 較舊） */
function makeVerdicts({ n = 420, evN = 40, carriedN = 0, seed = 7, reasonLen = 90 } = {}) {
  const r = rng(seed);
  const out = {};
  for (let i = 0; i < n; i++) {
    const code = String(1101 + i);
    const carried = i < carriedN;
    out[code] = {
      label: ['利多', '利空', '中性'][i % 3], confidence: '中', strength: '中', reason: text(r, reasonLen),
      keyQuote: text(r, 40), impactPath: text(r, 30), priced: '否', challenge: text(r, 50), eventType: '訂單', certainty: '已確認', novelty: '首次',
      px: 100 + i, pxSrc: 'snapshot', pxAt: AT0, challenged: true, revision: text(r, 50), gate: null, unverifiedNums: null,
      dirChecked: true, strengthChecked: true, quotes: [text(r, 50), text(r, 50)], quoteVerified: 2, quoteFailed: 0,
      strengthBasis: text(r, 25), unsupported: null, basis: 'content', n: 3, pass: carried ? 'evening' : 'morning',
      at: carried ? AT0 - 86400e3 + i : AT0 + i * 1000, articles: 2, minCoMentions: 1,
      ...(carried ? { carriedFrom: '2026-10-08' } : {}),
      ...(i < evN ? {
        ruleClass: 'C16a', ruleFacts: { C16a: 'yes' }, ruleTrail: { C16a: { since: '2026-10-09', eventDate: '2026-10-08' } },
        ruleEvidence: { C16a: { key: `k${i}`, day: '2026-10-09', trig: '搜索', ctx: text(r, 80), title: text(r, 40), src: '經濟日報', pub: AT0, ans: text(r, 60), quote: text(r, 60), dateText: '10月8日', qctx: text(r, 80), eventDate: '2026-10-08', state: 'yes' } },
      } : {}),
    };
  }
  return out;
}
function makeSeen({ n = 420, titles = 45, len = 22, seed = 11 } = {}) {
  const r = rng(seed);
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [String(1101 + i), Array.from({ length: titles }, () => text(r, len))]));
}
const DAY = 'newsVerdict/2026-10-09';
const META = {
  date: '2026-10-09', dataDate: '2026-10-08', targetDate: '2026-10-09', generatedOn: '2026-10-08', updatedAt: AT0, lastPass: 'evening',
  universeSize: 160, universeFrom: 'news', judged: 20, skipped: 0, failed: 0, stopped: false, note: '新聞判別由 AI 讀完內文後給出；僅此來源可影響評分。非投資建議。',
};
const ARCHIVE_ORDER = ['plain', 'seen-gz', 'gz', 'gz-text', 'gz-noev', 'seen-trim', 'seen-drop', 'drop-old'];
const DISPLAY_ORDER = ['plain', 'text', 'noev', 'gz-noev', 'drop-old'];

/** 從上限無限大開始，每次把上限設成上一級的大小 −1，逐級走完階梯 */
function walk(o) {
  const levels = [];
  let max = Infinity, prev = null;
  for (let i = 0; i < 20; i++) {
    const r = fitNewsVerdictDoc({ ...o, maxBytes: max });
    levels.push(r);
    if (r.level === 'drop-old') break;
    assert.ok(r.bytes <= max, `${r.level} ${r.bytes} ≤ ${max}`);
    if (prev) assert.ok(r.bytes < prev.bytes, `${r.level} 比 ${prev.level} 小`);
    prev = r; max = r.bytes - 1;
  }
  return levels;
}
/** 把一次寫入的欄位還原回判別表／已見標題（模擬讀取端） */
const readBack = fields => ({ verdicts: verdictsOf(fields), seen: seenOf(fields) });

test('Firestore 大小估算＝官方範例（users/jeff/tasks/my_task_id 共 147 bytes）；各型別', () => {
  assert.equal(firestoreDocBytes('users/jeff/tasks/my_task_id', { type: 'Personal', done: false, priority: 1, description: 'Learn Cloud Firestore' }), 147);
  assert.equal(firestoreValueBytes('台'), 4, '中文 UTF-8 3 bytes＋1');
  assert.equal(firestoreValueBytes(null), 1);
  assert.equal(firestoreValueBytes(1.5), 8);
  assert.equal(firestoreValueBytes([1, 'a']), 8 + 2);
  assert.equal(firestoreValueBytes({ ab: true }), 3 + 1);
  assert.equal(firestoreValueBytes(new Date()), 8);
  assert.equal(firestoreValueBytes(new Uint8Array(10)), 10);
});

test('2026-10-07 實案規模（判別表拿掉證據仍 >550KB＋已見標題）：舊寫法超過 1MB；新寫法 ≤ 安全門檻、無損、讀回一字不差', () => {
  const verdicts = makeVerdicts({ n: 420, evN: 40, carriedN: 373 });
  const seen = makeSeen({ n: 420, titles: 30 });
  const vBytes = Buffer.byteLength(JSON.stringify(verdicts)), sBytes = Buffer.byteLength(JSON.stringify(seen));
  assert.ok(vBytes > 550_000, `判別表 ${vBytes}`);
  assert.ok(firestoreDocBytes(DAY, { ...META, verdictJson: JSON.stringify(verdicts), seenJson: JSON.stringify(seen) }) > NV_DOC_LIMIT, `舊寫法 ${vBytes}+${sBytes} 超過 1MB`);
  const r = fitNewsVerdictDoc({ docPath: DAY, verdicts, seen, meta: META });
  assert.ok(['seen-gz', 'gz'].includes(r.level), r.level);
  assert.equal(r.lossy, false);
  assert.ok(r.bytes <= NV_DOC_SOFT_MAX, `${r.bytes}`);
  assert.equal(r.bytes, firestoreDocBytes(DAY, { ...META, ...r.fields }), '估算含 meta 與 sizeLevel');
  const back = readBack(r.fields);
  assert.deepEqual(back.verdicts, verdicts);
  assert.deepEqual(back.seen, seen);
  assert.equal(r.fields.sizeLevel, r.level);
  assert.deepEqual([...r.clear].sort(), NV_MANAGED_FIELDS.filter(k => !(k in r.fields)).sort());
  assert.ok(r.clear.includes('seenJson'), '壓縮已見標題時一定要刪掉舊的明文 seenJson（merge 不會自己刪）');
});

test('放得下就照舊寫明文（尚未更新的讀取端不受影響）；clear 只列壓縮欄位', () => {
  const verdicts = makeVerdicts({ n: 30 }), seen = makeSeen({ n: 30, titles: 10 });
  const r = fitNewsVerdictDoc({ docPath: DAY, verdicts, seen, meta: META });
  assert.equal(r.level, 'plain');
  assert.equal(r.fields.verdictJson, JSON.stringify(verdicts));
  assert.equal(r.fields.seenJson, JSON.stringify(seen));
  assert.deepEqual(r.clear.sort(), ['seenGz', 'verdictGz']);
  assert.equal(r.dropped, 0);
});

test('日文件降級順序（無損優先）：plain → seen-gz → gz → gz-text → gz-noev → seen-trim → seen-drop → drop-old；每級都放得下且更小', () => {
  const verdicts = makeVerdicts({ n: 260, evN: 120, carriedN: 100 }), seen = makeSeen({ n: 260, titles: 60 });
  const before = JSON.stringify(verdicts);
  const levels = walk({ docPath: DAY, verdicts, seen, meta: META });
  assert.deepEqual(levels.map(r => r.level), ARCHIVE_ORDER);
  assert.equal(JSON.stringify(verdicts), before, '不改動輸入的判別表');
  const by = Object.fromEntries(levels.map(r => [r.level, r]));
  for (const lv of ARCHIVE_ORDER) assert.equal(NV_LOSSY_LEVELS.has(lv), ['gz-text', 'gz-noev', 'seen-trim', 'seen-drop', 'drop-old'].includes(lv), lv);
  for (const lv of ARCHIVE_ORDER) assert.ok(NV_LEVEL_TEXT[lv], `${lv} 有說明`);
  // 無損三級：讀回一字不差
  for (const lv of ['plain', 'seen-gz', 'gz']) assert.deepEqual(readBack(by[lv].fields), { verdicts, seen }, lv);
  assert.deepEqual(by.gz.clear.sort(), ['seenJson', 'verdictJson']);
  // gz-text：證據留鍵、狀態、事件日期；文字欄拿掉；判別本身不動
  const t = readBack(by['gz-text'].fields).verdicts['1101'];
  assert.equal(t.ruleEvidence.C16a.eventDate, '2026-10-08');
  assert.equal(t.ruleEvidence.C16a.key, 'k0');
  for (const k of ['ctx', 'title', 'src', 'ans', 'quote', 'dateText', 'qctx']) assert.ok(!(k in t.ruleEvidence.C16a), k);
  assert.equal(t.reason, verdicts['1101'].reason);
  // gz-noev：證據整段拿掉，ruleFacts／ruleTrail 照留
  const nv = readBack(by['gz-noev'].fields).verdicts['1101'];
  assert.ok(!('ruleEvidence' in nv));
  assert.deepEqual(nv.ruleTrail, verdicts['1101'].ruleTrail);
  assert.deepEqual(nv.ruleFacts, { C16a: 'yes' });
  // seen-trim：每檔只留最近 NV_SEEN_TRIM 則；seen-drop：不存且兩個 seen 欄位都刪
  const st = readBack(by['seen-trim'].fields).seen['1101'];
  assert.deepEqual(st, seen['1101'].slice(-NV_SEEN_TRIM));
  assert.ok(!('seenGz' in by['seen-drop'].fields) && !('seenJson' in by['seen-drop'].fields));
  assert.ok(by['seen-drop'].clear.includes('seenGz') && by['seen-drop'].clear.includes('seenJson'));
  // drop-old：承接來的先丟、再丟最舊的；有丟幾筆
  const d = by['drop-old'];
  assert.ok(d.dropped > 0);
  const kept = Object.keys(readBack(d.fields).verdicts);
  assert.equal(kept.length, 260 - d.dropped);
  if (d.dropped <= 100) assert.ok(kept.every(c => !verdicts[c].carriedFrom || Number(c) > 1100 + d.dropped), '承接的先丟');
  else assert.ok(kept.every(c => !verdicts[c].carriedFrom), '承接的全丟光才輪到新判別');
});

test('latest 降級順序（相容優先：網站讀者要部署新版才讀得到壓縮欄位）：plain → text → noev → gz-noev → drop-old；沒有 seen 欄位', () => {
  const verdicts = makeVerdicts({ n: 260, evN: 120 });
  const levels = walk({ docPath: 'newsVerdict/latest', verdicts, meta: { date: '2026-10-09', targetDate: '2026-10-09', updatedAt: AT0, lastPass: 'evening', covered: 260 }, archive: false });
  assert.deepEqual(levels.map(r => r.level), DISPLAY_ORDER);
  for (const r of levels) {
    assert.ok(!('seenJson' in r.fields) && !('seenGz' in r.fields));
    assert.ok(r.clear.includes('seenJson') && r.clear.includes('seenGz'));
  }
  assert.ok('verdictJson' in levels[2].fields && !('verdictGz' in levels[2].fields), 'noev 仍是明文');
  assert.ok('verdictGz' in levels[3].fields, 'gz-noev 才壓縮');
  // latest 不帶 seen 參數也照樣（傳了也不寫）
  const r = fitNewsVerdictDoc({ docPath: 'newsVerdict/latest', verdicts, seen: makeSeen({ n: 5 }), archive: false });
  assert.ok(!('seenJson' in r.fields));
});

test('merge 留著的舊欄位要算進大小：舊的明文大欄位（會被刪）不算；其他大欄位要算；這次覆寫的 meta 不重算', () => {
  const verdicts = makeVerdicts({ n: 200, evN: 0 }), seen = makeSeen({ n: 200, titles: 20 });
  const base = fitNewsVerdictDoc({ docPath: DAY, verdicts, seen, meta: META });
  // 舊文件有 600KB 的明文 seenJson、verdictJson：都是這支管的欄位，這次會被覆寫或刪掉 ⇒ 不影響
  const keepManaged = { ...META, verdictJson: 'x'.repeat(600_000), seenJson: 'y'.repeat(600_000), intradayAt: AT0 };
  const r1 = fitNewsVerdictDoc({ docPath: DAY, verdicts, seen, meta: META, keep: keepManaged });
  assert.equal(r1.level, base.level);
  assert.equal(r1.bytes, base.bytes + Buffer.byteLength('intradayAt') + 1 + 8, '只多 intradayAt 這個留著的小欄位');
  // 舊文件有別的大欄位（不是這支管的、這次沒覆寫）⇒ 要算進去，逼出更深的降級
  const r2 = fitNewsVerdictDoc({ docPath: DAY, verdicts, seen, meta: META, keep: { legacyBlob: 'z'.repeat(800_000) } });
  assert.ok(ARCHIVE_ORDER.indexOf(r2.level) > ARCHIVE_ORDER.indexOf(base.level), `${base.level} → ${r2.level}`);
  assert.ok(r2.bytes <= NV_DOC_SOFT_MAX);
});

test('丟判別順序：承接來的（carriedFrom）先、再依判別時刻由舊到新（每輪少一成，直到放得下）', () => {
  const r0 = rng(3);
  const verdicts = {
    1101: { label: '利多', at: 5, reason: text(r0, 700) },
    1102: { label: '利多', at: 1, reason: text(r0, 700) },
    1103: { label: '利多', at: 9, carriedFrom: '2026-10-08', reason: text(r0, 700) },
    1104: { label: '利多', at: 3, reason: text(r0, 700) },
  };
  const path = 'newsVerdict/latest';
  const sizeOf = codes => firestoreDocBytes(path, { verdictGz: gzB64(JSON.stringify(Object.fromEntries(codes.map(c => [c, verdicts[c]])))), sizeLevel: 'drop-old' });
  // 上限剛好放得下兩筆（1101、1104），放不下三筆
  const maxBytes = sizeOf(['1101', '1104']);
  assert.ok(sizeOf(['1101', '1102', '1104']) > maxBytes);
  const r = fitNewsVerdictDoc({ docPath: path, verdicts, archive: false, maxBytes });
  assert.equal(r.level, 'drop-old');
  assert.deepEqual(Object.keys(verdictsOf(r.fields)).sort(), ['1101', '1104'], '先丟承接的 1103、再丟最舊的 1102');
  assert.equal(r.dropped, 2);
  assert.ok(r.bytes <= maxBytes);
  assert.equal(Object.keys(verdicts).length, 4, '不改動輸入');
});

test('壞輸入不丟錯：判別表不是物件當空表；空判別表放得下', () => {
  for (const v of [null, undefined, [], 'x']) {
    const r = fitNewsVerdictDoc({ docPath: DAY, verdicts: v, seen: null });
    assert.equal(r.level, 'plain');
    assert.equal(r.fields.verdictJson, '{}');
  }
});

test('模擬一整趟分段存檔（merge 寫入＋刪除欄位）：文件從舊格式長大到要壓縮，每次寫完的實際文件都 ≤ 門檻、讀回＝記憶體裡的判別', () => {
  const DELETE = Symbol('delete');
  const mergeSet = (doc, data) => {   // Firestore set(..., { merge: true }) 的頂層語意
    const out = { ...doc };
    for (const [k, v] of Object.entries(data)) { if (v === DELETE) delete out[k]; else out[k] = v; }
    return out;
  };
  const allV = makeVerdicts({ n: 460, evN: 60, carriedN: 373 });
  const allS = makeSeen({ n: 460, titles: 30 });
  // 起點：舊版寫入端寫的明文文件（夜補先建、只有 30 檔）
  const codes = Object.keys(allV);
  let doc = { date: '2026-10-09', targetDate: '2026-10-09', lastPass: 'night', intradayAt: AT0,
    verdictJson: JSON.stringify(Object.fromEntries(codes.slice(-30).map(c => [c, allV[c]]))), seenJson: JSON.stringify({}) };
  const prev = { ...doc };
  const levels = new Set();
  for (let n = 40; n <= codes.length; n += 60) {
    const verdicts = Object.fromEntries(codes.slice(0, n).map(c => [c, allV[c]]));
    const seen = Object.fromEntries(codes.slice(0, n).map(c => [c, allS[c]]));
    const r = fitNewsVerdictDoc({ docPath: DAY, verdicts, seen, meta: { ...META, judged: n }, keep: prev });
    const data = { ...META, judged: n, ...r.fields, ...Object.fromEntries(r.clear.map(k => [k, DELETE])) };
    doc = mergeSet(doc, data);
    levels.add(r.level);
    const actual = firestoreDocBytes(DAY, doc);
    assert.ok(actual <= NV_DOC_SOFT_MAX, `n=${n} ${r.level} 實際 ${actual}`);
    assert.equal(actual, r.bytes, `n=${n} 估算＝merge 後的實際文件`);
    assert.ok(!('verdictJson' in doc && 'verdictGz' in doc) && !('seenJson' in doc && 'seenGz' in doc), '同一欄位不會兩種格式並存');
    const back = verdictsOf(doc);
    if (!r.lossy) {
      assert.ok(JSON.stringify(back) === JSON.stringify(verdicts), `n=${n} ${r.level} 無損讀回`);
      assert.ok(JSON.stringify(seenOf(doc)) === JSON.stringify(seen), `n=${n} ${r.level} 已見標題無損讀回`);
    } else if (r.level !== 'drop-old') {
      assert.deepEqual(Object.keys(back), Object.keys(verdicts), `n=${n} ${r.level} 有損也不丟判別`);
    }
  }
  assert.ok(levels.has('plain') && levels.has('seen-gz'), `從明文一路長到壓縮：${[...levels]}`);
});
