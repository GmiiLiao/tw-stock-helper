// AI 交易員經驗庫 單元測試：node --test scripts/lib/ai-lab-learn.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyFeatures, dtFeatures, learn, matchLessons, lessonText, renderLearnMarkdown } from './ai-lab-learn.mjs';

const mkDays = (n = 80) => Array.from({ length: n }, (_, i) => ({ date: `D${String(i).padStart(3, '0')}`, m: { 1111: [100 + i, 1000 + (i % 5) * 100, 99 + i, 101 + i, 98 + i] } }));

test('dailyFeatures：只用 ≤t 的資料（改動 t 之後的日子不影響特徵）；60 日不足回 null', () => {
  const days = mkDays();
  const a = dailyFeatures(days, 70, '1111');
  const b = dailyFeatures(days.map((d, i) => (i > 70 ? { ...d, m: { 1111: [999, 1, 999, 999, 999] } } : d)), 70, '1111');
  assert.deepEqual(a.f, b.f);
  assert.equal(a.f.streak, '≥5日'); assert.equal(a.f.maAbove, '3條');
  assert.equal(dailyFeatures(days, 30, '1111'), null);
});

test('dtFeatures：觸發當下欄位 → 分段', () => {
  const r = dtFeatures({ side: 'long', type: 'ORB', minute: 560, entry: 100, d: 1.5, costR: 0.2, score: { total: 60, knownMax: 80, parts: { market: { score: 5, knownMax: 10 } } }, warnings: ['乖離 3.2%'], regime: '多頭', news: null, sector: '半導體' });
  assert.equal(r.f.side, '做多'); assert.equal(r.f.bucket, '09:00-09:30'); assert.equal(r.f.riskPct, '1~2%');
  assert.equal(r.f.scorePct, '65~80%'); assert.equal(r.f.marketPct, '40~70%'); assert.equal(r.f['warn:乖離 #%'], '有'); assert.equal(r.f.news, '無'); assert.equal(r.f.sector, '有族群動能');
});

// 合成樣本：A=壞 在訓練與驗證都顯著較差；B=壞 只在訓練段差（驗證段反轉）；C 隨機
function synth() {
  const S = []; let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let d = 0; d < 100; d++) for (let k = 0; k < 20; k++) {
    const A = rnd() < 0.3 ? '壞' : '好', B = rnd() < 0.3 ? '壞' : '好', C = rnd() < 0.5 ? 'x' : 'y';
    let y = (rnd() - 0.5) * 4;
    if (A === '壞') y -= 1.5;
    if (B === '壞') y += d < 70 ? -1.5 : 1.5;
    S.push({ key: 'swing', date: `d${String(d).padStart(3, '0')}`, f: { A, B, C }, y });
  }
  return S;
}

test('learn：兩段一致且顯著＝已驗證風險；只在訓練段成立＝不驗證；隨機特徵不入選', () => {
  const L = learn(synth());
  const r = id => L.swing.rules.find(x => x.id === id);
  assert.equal(r('A=壞').status, 'validated'); assert.equal(r('A=壞').kind, 'risk');
  assert.equal(r('A=好').kind, 'edge');
  assert.notEqual(r('B=壞')?.status, 'validated', '驗證段反轉 ⇒ 不可驗證');
  assert.equal(r('C=x'), undefined);
  assert.equal(L.swing.split.holdoutN, 600);
});

test('matchLessons：只回已驗證規則；lessonText 附歷史統計', () => {
  const L = learn(synth());
  const m = matchLessons(L, 'swing', { A: '壞', B: '壞', C: 'x' });
  assert.ok(m.every(x => x.status === 'validated'));
  assert.ok(m.some(x => x.id === 'A=壞'));
  assert.match(lessonText(m.find(x => x.id === 'A=壞'), '5日淨%'), /⚠風險.*n=\d+/);
  assert.deepEqual(matchLessons(L, 'dt-long', { A: '壞' }), []);
  assert.match(renderLearnMarkdown({ date: 'X', version: 'v', at: 0, learned: L, sources: { a: 1 } }), /已驗證/);
});
