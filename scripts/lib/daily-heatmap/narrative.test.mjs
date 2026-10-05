import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, reportToMarkdown } from './narrative.mjs';
import { computeHeatmap } from './compute.mjs';

function payload() {
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

test('分析報告：六個段落、數字來自 payload、不含預測用語', () => {
  const p = payload();
  const r = buildReport(p);
  assert.deepEqual(r.map(x => x.key), ['overview', 'index', 'sectors', 'stocks', 'watch', 'basis']);
  assert.ok(r[0].paras[0].includes(`${p.market.n} 檔`));
  assert.ok(r[0].paras[1].includes('加權指數收 10,100'));
  const md = reportToMarkdown(r);
  for (const bad of ['將上漲', '將下跌', '看多', '看空', '建議買進', '目標價']) assert.ok(!md.includes(bad), bad);
  assert.ok(md.includes('非投資建議'));
});

test('分析報告：沒有指數資料時略過指數段、仍可產生', () => {
  const p = payload();
  const r = buildReport({ ...p, index: null });
  assert.ok(!r.some(x => x.key === 'index'));
  assert.ok(r.length >= 4);
});
