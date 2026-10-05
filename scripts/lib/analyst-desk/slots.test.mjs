import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSlots, refsOfRaw, renderSlots, renderClaim, fmtValue, roundHalfAway, claimTier, tierMarks } from './slots.mjs';
import * as K from './constants.mjs';

const pack = {
  refs: {
    'm.ew': { v: 0.57, unit: '%', fmt: 'sg2', asOf: '2026-10-02', tier: '官方衍生', source: 'x' },
    'm.n': { v: 1144137, unit: '張', fmt: 'int', asOf: '2026-10-02', tier: '官方', source: 'x' },
    'm.up': { v: 0.614, unit: '比率', fmt: 'pct0', asOf: '2026-10-02', tier: '官方衍生', source: 'x' },
    'm.upP': { v: 61.4, unit: '%', fmt: 'pct0', asOf: '2026-10-02', tier: '官方衍生', source: 'x' },
    'm.val': { v: 4123.45, unit: '億', fmt: 'bn1', asOf: '2026-10-02', tier: '官方', source: 'x' },
    'ix.pts': { v: -12.34, unit: '點', fmt: 'pts1', asOf: '2026-10-02', tier: '官方', source: 'x' },
    'cal.exd': { v: '2026-10-09', unit: '文字', fmt: 'date', asOf: '2026-10-02', tier: '官方', source: 'x' },
    'nv.1.label': { v: '利多', unit: '文字', fmt: 'txt', asOf: '2026-10-02', tier: '媒體', source: 'x' },
    'nv.1.none': { v: null, unit: '文字', fmt: 'txt', asOf: '2026-10-02', tier: '媒體', source: 'x' },
    'wk.1.chain': { v: 'AI伺服器鏈', unit: '文字', fmt: 'txt', asOf: '2026-10-02', tier: '站內整理', source: 'x' },
    'ai.1.x': { v: 'p', unit: '文字', fmt: 'txt', asOf: '2026-10-02', tier: 'AI待驗', source: 'x' },
  },
};

test('extractSlots：解析 {{ref|fmt}} 與 [ref:id]，保序、標記種類', () => {
  const r = extractSlots('等權 {{m.ew|sg2}}% 與 {{m.n}} 張 [ref:wk.1.chain][ref:nv.1.label]。');
  assert.deepEqual(r.map(x => [x.ref, x.fmt, x.kind]), [['m.ew', 'sg2', 'slot'], ['m.n', null, 'slot'], ['wk.1.chain', null, 'cite'], ['nv.1.label', null, 'cite']]);
  assert.deepEqual(extractSlots('沒有槽位 {單括號} {{ }} [ref:]'), []);
  assert.equal(extractSlots('{{a.b|}}')[0].fmt, '');
  assert.deepEqual(extractSlots(null), []);
});

test('refsOfRaw：槽位∪標記，去重、依首次出現順序', () => {
  assert.deepEqual(refsOfRaw('{{m.ew|sg2}} {{m.ew}} [ref:m.n] {{ix.pts|pts1}}'), ['m.ew', 'm.n', 'ix.pts']);
});

test('roundHalfAway：半數遠離零，避開二進位誤差（1.005→1.01）', () => {
  assert.equal(roundHalfAway(1.005, 2), 1.01);
  assert.equal(roundHalfAway(0.575, 2), 0.58);
  assert.equal(roundHalfAway(-0.575, 2), -0.58);
  assert.equal(roundHalfAway(2.5, 0), 3);
  assert.equal(roundHalfAway(-2.5, 0), -3);
  assert.equal(roundHalfAway(0.57, 1), 0.6);
});

test('fmtValue sg2：帶號兩位小數、零不帶號、負零歸零', () => {
  assert.equal(fmtValue(0.57, 'sg2'), '+0.57');
  assert.equal(fmtValue(-0.4, 'sg2'), '-0.40');
  assert.equal(fmtValue(0, 'sg2'), '0.00');
  assert.equal(fmtValue(-0.004, 'sg2'), '0.00');
  assert.equal(fmtValue(0.004, 'sg2'), '0.00');
  assert.equal(fmtValue(1.005, 'sg2'), '+1.01');
  assert.equal(fmtValue(-0.005, 'sg2'), '-0.01');
  assert.equal(fmtValue('0.57', 'sg2'), '+0.57');
});

test('fmtValue int／pts1／bn1：千分位與四捨五入', () => {
  assert.equal(fmtValue(1144137, 'int'), '1,144,137');
  assert.equal(fmtValue(999.5, 'int'), '1,000');
  assert.equal(fmtValue(-1234.5, 'int'), '-1,235');
  assert.equal(fmtValue(0.4, 'int'), '0');
  assert.equal(fmtValue(-12.34, 'pts1'), '-12.3');
  assert.equal(fmtValue(1234.56, 'pts1'), '+1,234.6');
  assert.equal(fmtValue(4123.45, 'bn1'), '4,123.5');
  assert.equal(fmtValue(0.04, 'bn1'), '0.0');
});

test('fmtValue pct0：比率×100 取整並自帶 %；unit 為 % 時 v 已是百分數', () => {
  assert.equal(fmtValue(0.614, 'pct0'), '61%');
  assert.equal(fmtValue(0.615, 'pct0'), '62%');
  assert.equal(fmtValue(0.614, 'pct0', '比率'), '61%');
  assert.equal(fmtValue(61.4, 'pct0', '%'), '61%');
  assert.equal(fmtValue(-0.034, 'pct0'), '-3%');
});

test('fmtValue date／txt／缺值', () => {
  assert.equal(fmtValue('2026-10-02', 'date'), '10/02');
  assert.equal(fmtValue('2026-09-05', 'date'), '9/05');
  assert.equal(fmtValue('不是日期', 'date'), K.MISSING_TEXT);
  assert.equal(fmtValue('  利多\n ', 'txt'), '利多');
  assert.equal(fmtValue(true, 'txt'), '是');
  assert.equal(fmtValue(null, 'sg2'), K.MISSING_TEXT);
  assert.equal(fmtValue(undefined, 'txt'), K.MISSING_TEXT);
  assert.equal(fmtValue(NaN, 'int'), K.MISSING_TEXT);
  assert.equal(fmtValue('abc', 'int'), K.MISSING_TEXT);
  assert.equal(fmtValue('', 'txt'), K.MISSING_TEXT);
});

test('renderSlots：依 pack 值與預設 fmt 填值，不信任 LLM 寫的 fmt', () => {
  const r = renderSlots('上市等權 {{m.ew|sg2}}%，成交 {{m.n}} 張，上漲比 {{m.up|pct0}}。', pack);
  assert.equal(r.text, '上市等權 +0.57%，成交 1,144,137 張，上漲比 61%。');
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.badFmt, []);
});

test('renderSlots：LLM 的 |fmt 與 pack 預設不同＝badFmt（R16），渲染仍用預設', () => {
  const r = renderSlots('{{m.ew|int}}%', pack);
  assert.equal(r.text, '+0.57%');
  assert.deepEqual(r.badFmt, [{ ref: 'm.ew', written: 'int', expected: 'sg2', reason: 'differs-from-pack' }]);
  const u = renderSlots('{{m.ew|pct9}}', pack);
  assert.equal(u.badFmt[0].reason, 'unknown-fmt');
  assert.equal(u.text, '+0.57');
});

test('renderSlots：缺值回「來源未提供」並列入 missing（pack 無此 ref／v 為 null／格式化失敗）', () => {
  const r = renderSlots('A {{zz.none.x|sg2}} B {{nv.1.none}} C {{nv.1.label|int}}', pack);
  assert.equal(r.text, 'A 來源未提供 B 來源未提供 C 利多');
  assert.deepEqual(r.missing.sort(), ['nv.1.none', 'zz.none.x']);
  // fmt 預設取 pack：nv.1.label 是 txt，LLM 寫 int → badFmt，且渲染成文字
  assert.equal(r.badFmt.length, 1);
});

test('renderSlots：pct0 自帶 %，吃掉緊接的重複 %；其他格式保留 %', () => {
  assert.equal(renderSlots('上漲比 {{m.up|pct0}}%。', pack).text, '上漲比 61%。');
  assert.equal(renderSlots('等權 {{m.ew|sg2}}%。', pack).text, '等權 +0.57%。');
  assert.equal(renderSlots('上漲比 {{m.upP}}％', pack).text, '上漲比 61%');
});

test('renderSlots：[ref:id] 不填值、移除並收斂空白；不在 pack 的標記列入 missing', () => {
  const r = renderSlots('其陽列入觀察 [ref:nv.1.label] [ref:no.such.id]。', pack);
  assert.equal(r.text, '其陽列入觀察。');
  assert.deepEqual(r.missing, ['no.such.id']);
});

test('renderSlots：date 與 txt 槽位', () => {
  assert.equal(renderSlots('除息日 {{cal.exd|date}}，題材 {{wk.1.chain}}', pack).text, '除息日 10/09，題材 AI伺服器鏈');
});

test('claimTier：取 refs 最低等級；連動最高只到「站內整理」；無 ref 回 null', () => {
  assert.equal(claimTier(['m.ew', 'm.n'], pack, 'fact'), '官方衍生');
  assert.equal(claimTier(['m.n', 'nv.1.label'], pack, 'fact'), '媒體');
  assert.equal(claimTier(['m.n', 'wk.1.chain', 'ai.1.x'], pack, 'fact'), 'AI待驗');
  assert.equal(claimTier(['m.n'], pack, 'linkage'), '站內整理');
  assert.equal(claimTier(['ai.1.x'], pack, 'linkage'), 'AI待驗');
  assert.equal(claimTier([], pack, 'fact'), null);
});

test('renderClaim：等級標記由程式附加（AI待驗／站內整理／先驗），媒體與官方不附', () => {
  const a = renderClaim({ raw: '產業鏈 {{wk.1.chain}}。', kind: 'fact' }, pack);
  assert.equal(a.text, '產業鏈 AI伺服器鏈。（站內整理）');
  const b = renderClaim({ raw: '{{m.ew|sg2}}% {{ai.1.x}}', kind: 'fact' }, pack);
  assert.ok(b.text.endsWith('（AI待驗）'));
  const c = renderClaim({ raw: '等權 {{m.ew|sg2}}%。', kind: 'fact' }, pack);
  assert.equal(c.text, '等權 +0.57%。');
  const d = renderClaim({ raw: '等權 {{m.ew|sg2}}%。', kind: 'linkage' }, pack);
  assert.equal(d.text, '等權 +0.57%。（站內整理）');
  assert.deepEqual(tierMarks(['m.ew', 'wk.1.chain', 'ai.1.x'], pack, 'fact'), ['AI待驗', '站內整理']);
});

test('constants：卡片標題由程式產生，依 dayLabel 規則（前交易日／當日／下一交易日）', () => {
  assert.equal(K.cardTitle('prev', '2026-10-01', '2026-10-05'), '昨日股市（前交易日 10/01）');
  assert.equal(K.cardTitle('data', '2026-10-02', '2026-10-02'), '今日盤後（當日 10/02）');
  assert.equal(K.cardTitle('data', '2026-10-02', '2026-10-05'), '今日盤後（前交易日 10/02）');
  assert.equal(K.cardTitle('next', '2026-10-05', '2026-10-02'), '明日預期（下一交易日 10/05）');
  assert.equal(K.cardTitle('next', '2026-10-05', '2026-10-05'), '明日預期（當日 10/05）');
  assert.equal(K.cardTitle('next', '2026-10-05'), '明日預期（下一交易日 10/05）');
  assert.equal(K.cardTitle('data', '2026-10-02'), '今日盤後（前交易日 10/02）');
  assert.equal(K.cardTitle('data', null), '今日盤後（資料日）');
  assert.throws(() => K.cardTitle('x', '2026-10-02'));
  assert.ok(K.CARD_TITLE_RE.test(K.cardTitle('prev', '2026-09-30', '2026-10-05')));
});

test('constants：免責常數、useRules、封閉清單', () => {
  assert.equal(K.DISCLAIMER_SHORT, 'AI 整理，非投資建議；個股為資料觀察名單，非買賣建議。');
  assert.ok(K.DISCLAIMER.startsWith('本頁由 AI 分析師依證交所、櫃買中心、公開資訊觀測站'));
  assert.ok(K.DISCLAIMER.endsWith('投資請自行判斷並承擔風險。'));
  assert.ok(!K.DISCLAIMER.includes('**'));
  assert.equal(K.POOL_RULE, 'pool-v1');
  assert.equal(K.USE_RULES.usedForScoring, false);
  assert.ok(Object.isFrozen(K.USE_RULES));
  const u = K.buildUseRules();
  u.forbidden.push('x');
  assert.equal(K.USE_RULES.forbidden.length, 3, 'buildUseRules 回傳深拷貝，不影響常數');
  assert.deepEqual(K.FMTS, ['sg2', 'int', 'pts1', 'bn1', 'pct0', 'date', 'txt']);
  assert.equal(K.tierIndex('官方') < K.tierIndex('傳聞'), true);
});

test('constants：匯出的物件鍵名不得符合禁用鍵名樣式、不得發明 At／Date 結尾', () => {
  const bad = [];
  const walk = (v, path) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === 'object' && !(v instanceof RegExp)) {
      for (const [k, x] of Object.entries(v)) {
        if (K.FORBIDDEN_KEY_RE.test(k) || (/(At|Date)$/.test(k) && !K.ALLOWED_DATE_KEYS.includes(k))) bad.push(`${path}.${k}`);
        walk(x, `${path}.${k}`);
      }
    }
  };
  for (const [name, v] of Object.entries(K)) if (!['FORBIDDEN_KEY_RE', 'KEY_SCAN_EXEMPT'].includes(name)) walk(v, name);
  assert.deepEqual(bad, []);
});
