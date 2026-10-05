import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanWords, findSimplified, EMOJI_RE, MARKDOWN_RES, EXTERNAL_LINK_RE, maskAllowed, isNegated } from './words.mjs';
import { DISCLAIMER, DISCLAIMER_SHORT, USE_RULES } from './constants.mjs';
import { buildReport, reportToMarkdown } from '../daily-heatmap/narrative.mjs';
import { renderMarkdown } from '../daily-heatmap/render.mjs';
import { computeHeatmap } from '../daily-heatmap/compute.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const terms = (text, rules) => scanWords(text, rules ? { rules } : undefined).map(h => h.term);

test('R09 禁用語：04 §3.2 詞表逐項命中', () => {
  const bad = ['目標價 500', '價格目標', '目標區', '停損', '停利', '止損', '止盈', '進場', '出場', '買進', '買入', '賣出', '加碼', '減碼', '逢低布局', '低接', '布局',
    '搶進', '卡位', '保證獲利', '必漲', '必跌', '穩賺', '穩賠', '一定會漲', '確定上漲', '確定下跌', '翻倍', '建議投資人', '推薦個股', '值得買', '勝率', '命中率', '建議價',
    '壓力位', '支撐區', 'Buy', 'target price', 'stop-loss'];
  for (const t of bad) assert.ok(scanWords(t, { rules: ['R09'] }).length > 0, `應命中：${t}`);
});

test('R09 白名單：描述事實的買賣用語不可誤殺（買賣超、外資買超、融資買進、借券賣出、買進成交…）', () => {
  const ok = ['外資買超 100 億', '投信賣超', '三大法人買賣超', '買賣超', '融資買進餘額減少', '借券賣出餘額', '融券賣出', '外資連續買進', '自營商賣出', '法人減碼',
    '買進成交均價', '賣出成交張數', '買進張數', '賣出金額', '追價風險', '追高風險', '處置股', '注意股', '分盤交易', '維持保證金', '融資保證金', '公司買進庫藏股',
    '公司賣出不動產', '大廠加碼資本支出', '擴大投資加碼擴產', '全球布局', '產能布局', '供應鏈佈局', '類比與混合訊號IC', '少數帶動型', '單檔帶動',
    '預計於 10/8 召開法說會', '公司將於 10/8 公告', '市場衝擊', '預期型', '營運目標', '熱度名次', '官方產業別', '買氣', '賣壓'];
  for (const t of ok) assert.deepEqual(scanWords(t), [], `不應命中：${t}`);
});

test('否定／免責用法放行（非投資建議、不構成推薦、不是買賣訊號、不預測）；「非常看多」不放行', () => {
  const ok = ['非投資建議', '不構成推薦', '不是動能或買賣訊號', '不預測之後走勢', '不含價格目標、買賣或進出場指示', '描述統計非訊號', '研究期不計分，不進任何模型分數', 'n<8 不排名'];
  for (const t of ok) assert.deepEqual(scanWords(t), [], `應放行：${t}`);
  assert.ok(terms('非常看多').includes('看多'));
  assert.ok(terms('非投資建議，建議買進').includes('買進'), '逗號後的新子句不受前一句否定影響');
  assert.equal(isNegated('非投資建議', 3), true);
});

test('程式固定句（免責、useRules）整段放行', () => {
  for (const t of [DISCLAIMER, DISCLAIMER_SHORT, USE_RULES.nature, ...USE_RULES.forbidden]) assert.deepEqual(scanWords(t), [], `固定句不應命中：${t.slice(0, 20)}`);
  assert.ok(maskAllowed(DISCLAIMER_SHORT).trim() === '');
});

test('R10 預測句型：將＋漲跌、可望、看多空、續強、衝、挑戰 N 點、預期＋漲跌幅、機率', () => {
  const bad = ['將上漲', '將大跌', '將持續突破', '將站上', '將跌破', '可望', '有望', '看多', '看空', '看漲', '看跌', '續強', '續漲', '上攻', '衝高', '直衝', '挑戰 22000 點',
    '預估漲跌幅', '預期明日大漲', '預計將上漲', '上看 100', '下探 90', '站上 5 日', '明日開高機率大', '資金簇擁', '有撐', '勢必', '料將'];
  for (const t of bad) assert.ok(scanWords(t, { rules: ['R10'] }).length > 0, `應命中：${t}`);
  const soft = scanWords('法人看好電子股', { rules: ['R10'] });
  assert.equal(soft[0].level, 'warn');
});

test('R19 分數／訊號／評級名詞（含英文）', () => {
  for (const t of ['技術評分 80', '評級', '評等', '分數', '訊號', '信號', '模型看好', '排名第3', '推薦榜', 'picksHistory', 'signal', 'score', 'baseScore', 'rating']) {
    assert.ok(scanWords(t, { rules: ['R19'] }).length > 0, `應命中：${t}`);
  }
});

test('R22 傳導語氣：導致／因此將／必然 為 block；帶動／造成 為 warn；「帶動型」標籤放行', () => {
  for (const t of ['導致下跌', '因此將上漲', '必然反彈', '勢必', '致使']) assert.equal(scanWords(t, { rules: ['R22'] })[0].level, 'block', t);
  for (const t of ['帶動股價', '造成賣壓', '使得']) assert.equal(scanWords(t, { rules: ['R22'] })[0].level, 'warn', t);
  assert.deepEqual(scanWords('少數帶動型・單檔帶動', { rules: ['R22'] }), []);
});

test('R20 簡體字偵測：簡體專用字命中、繁體常用字（含容易誤判者）不命中', () => {
  assert.deepEqual(findSimplified('这是发现的数据，涨跌与价格'), ['这', '发', '现', '数', '据', '涨', '与', '价', '格'].filter(c => findSimplified(c).length));
  assert.ok(findSimplified('我们为什么买进').length >= 3);
  for (const t of ['核准', '泛用塑膠原料', '皇后', '干擾', '范姓', '征服', '划算', '著作', '台積電', '里程', '面板', '制度', '才能', '發現', '數據', '漲跌', '價格', '買進', '網路', '資訊服務業', '電子零組件業', '類比與混合訊號IC']) {
    assert.deepEqual(findSimplified(t), [], `繁體不應命中：${t}`);
  }
});

test('R20 emoji／Markdown／外部連結偵測', () => {
  assert.ok(EMOJI_RE.test('⚠ 警告') && EMOJI_RE.test('📈') && EMOJI_RE.test('✅'));
  assert.ok(!EMOJI_RE.test('等權平均 +0.57%，→ 持平。（AI待驗）'));
  for (const t of ['**粗體**', '### 標題', '`code`', '[a](http://x)', '- 項目', '1. 項目', 'a\\_b', 'a | b']) assert.ok(MARKDOWN_RES.some(m => m.re.test(t)), `應偵測：${t}`);
  assert.ok(!MARKDOWN_RES.some(m => m.re.test('上市等權平均 +0.57%，指數與等權相差 -0.25pp。')));
  assert.ok(EXTERNAL_LINK_RE.test('見 https://example.com') && EXTERNAL_LINK_RE.test('www.twse.com.tw') && EXTERNAL_LINK_RE.test('twse.com.tw'));
  assert.ok(!EXTERNAL_LINK_RE.test('證交所公告'));
});

// ═══ 誤殺回歸（上線條件）：既有模板輸出與歷史熱力報告當負樣本，禁用詞表誤報必須為 0 ═══════════════
function samplePayload() {
  const mi = (c, close) => [c, { code: c, name: `N${c}`, close, high: close, low: close, val: 5e8 }];
  const codes = ['1101', '1102', '1103', '1104', '1105', '1106', '1107', '1108', '1109', '1110'];
  const tp = (c, close, ref) => [c, { code: c, name: `O${c}`, close, chg: close - ref, chgText: '', open: close, high: close, low: close, vol: 1, val: 5e8, shares: 1e8, nextRef: ref, nextLimitUp: ref * 1.1, nextLimitDown: ref * 0.9 }];
  const oc = ['6101', '6102', '6103', '6104', '6105', '6106', '6107', '6108'];
  const stocks = new Map([...codes, ...oc].map(c => [c, { name: c, market: '上市', industry: c.startsWith('11') ? '水泥工業' : '其他', chains: [], group: null, families: [], upstream: [], downstream: [] }]));
  return computeHeatmap({
    date: '2026-10-02', wiki: { generatedAt: 'x', stocks },
    mi: { rows: new Map(codes.map((c, i) => mi(c, 100 + i))), index: { close: 10100, change: 100 }, breadth: null, officialStockValue: null },
    ref: { rows: new Map(codes.map(c => [c, { limitUp: 120, ref: 100, limitDown: 80, prevClose: 100 }])) },
    qfiis: { rows: new Map(codes.map(c => [c, { shares: 1e8 }])) }, t187: null,
    tpex: { rows: new Map(oc.map((c, i) => tp(c, 50 + i, 50))) }, tpexPrev: { rows: new Map(oc.map(c => [c, { close: 50, nextRef: 50, nextLimitUp: 55, nextLimitDown: 45 }])) },
    miPrev: null, inst: null, tradingDates: ['2026-10-01', '2026-10-02'],
  });
}
const falsePositives = text => ({ words: scanWords(text).map(h => `${h.rule}:${h.term}`), simplified: findSimplified(text) });

test('誤殺回歸：narrative.mjs buildReport 輸出（payload 同 narrative.test）零誤報', () => {
  const md = reportToMarkdown(buildReport(samplePayload()));
  assert.ok(md.length > 500);
  assert.deepEqual(falsePositives(md), { words: [], simplified: [] });
});

test('誤殺回歸：render.mjs renderMarkdown 輸出零誤報', () => {
  const md = renderMarkdown(samplePayload(), { degraded: ['測試降級'] });
  assert.ok(md.length > 1000);
  assert.deepEqual(falsePositives(md), { words: [], simplified: [] });
});

test('誤殺回歸：second-brain/daily-heatmap/reports/*.md 歷史報告零誤報（檔案存在時）', t => {
  const dir = join(ROOT, 'second-brain', 'daily-heatmap', 'reports');
  if (!existsSync(dir)) return t.skip('reports 目錄不存在（乾淨 checkout）');
  const files = readdirSync(dir).filter(f => f.endsWith('.md'));
  if (files.length === 0) return t.skip('reports 為空');
  const bad = [];
  for (const f of files) {
    const fp = falsePositives(readFileSync(join(dir, f), 'utf8'));
    if (fp.words.length || fp.simplified.length) bad.push({ f, ...fp });
  }
  assert.deepEqual(bad, [], `誤報檔數 ${bad.length}／${files.length}`);
});
