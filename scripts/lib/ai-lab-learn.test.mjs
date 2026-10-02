// AI 交易員經驗庫 單元測試：node --test scripts/lib/ai-lab-learn.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyFeatures, dtFeatures, learn, matchLessons, lessonText, renderLearnMarkdown, holdingFeatures, decisionSamples } from './ai-lab-learn.mjs';

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

// ── 決策層經驗（2026-10-01 使用者：會員開啟的 AI 實驗所取得的經驗也列為訓練來源）──
const tAt = (date, hm) => Date.parse(`${date}T${hm}:00+08:00`);
const realDays = (n = 90) => Array.from({ length: n }, (_, i) => {
  const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
  return { date: d, m: { 1111: [100 + i, 1000, 99 + i, 101 + i, 98 + i], 2222: [50, 1000, 50, 50.5, 49.5], 3333: [80 - i * 0.1, 900, 80, 81, 79] } };
});

test('holdingFeatures：日線特徵＋已持有天數、持有報酬（賣出決策時）', () => {
  const days = realDays();
  const H = holdingFeatures(days, 70, '1111', { heldDays: 4, pnlPct: 7.2 });
  assert.equal(H.f.heldD, '3~5日'); assert.equal(H.f.pnlAtSell, '5~15%');
  assert.equal(H.f.streak, dailyFeatures(days, 70, '1111').f.streak, '含日線特徵（同一套函式）');
  assert.equal(holdingFeatures(days, 30, '1111', { heldDays: 4, pnlPct: 1 }), null, '日線不足 60 日');
});

test('decisionSamples：實驗與會員帳戶的實際買賣成交 → 同一（決策日, 代號, 買/賣）只算一筆；賣出 y＝賣後 5 日報酬取負號（賣出避開的跌幅）', () => {
  const days = realDays(); const D = days[70].date, S = days[75].date, D2 = days[72].date;
  const y5 = (date, code) => ({ [`${D}:1111`]: 3, [`${D}:2222`]: -1, [`${D2}:3333`]: 2, [`${S}:1111`]: 4 }[`${date}:${code}`] ?? null);
  const buy = (code, px, extra = {}) => ({ code, position: { shares: 1000 }, ...extra, _px: px });
  const doc = (date, picks, fills = {}, sellFills = {}) => ({ date, picks, buyFills: fills, sellFills });
  const lab = [
    doc(D, [buy('1111'), buy('2222')], { 1111: { px: 171, date: days[71].date }, 2222: { failed: true } }),
    doc(S, [], {}, { [`${D}_1111`]: { date: days[76].date, px: 176, ledger: { buy: { px: 171, at: tAt(days[71].date, '09:00') }, sell: { px: 176 } } } }),
  ];
  const memA = [doc(D, [buy('1111')], { 1111: { px: 171, date: days[71].date } }), doc(D2, [buy('3333')], { 3333: { px: 72.8, date: days[73].date } })];
  const memB = [doc(D, [buy('1111')], { 1111: { px: 171, date: days[71].date } })];
  const { samples, stats } = decisionSamples([{ src: '實驗帳戶', docs: lab }, { src: '會員帳戶', docs: memA }, { src: '會員帳戶', docs: memB }], days, y5);
  const buys = samples.filter(s => s.key === 'swing-buy'), sells = samples.filter(s => s.key === 'swing-sell');
  assert.deepEqual(buys.map(s => `${s.date}:${s.code}`).sort(), [`${D}:1111`, `${D2}:3333`], '1111 三個帳戶同日買＝一筆；2222 成交失敗不算；會員獨有的 3333 是新樣本');
  assert.equal(buys.find(s => s.code === '1111').y, 3);
  assert.equal(stats.buy['實驗帳戶'], 1); assert.equal(stats.buy['會員帳戶'], 3); assert.equal(stats.distinctBuy, 2);
  assert.equal(sells.length, 1); assert.equal(sells[0].y, -4, '賣後續漲 4% ⇒ 賣太早（避開 −4%）');
  assert.equal(sells[0].f.heldD, '3~5日', '71→75 持有 5 個交易日（與 reviewHoldings 同口徑：含買進日）');
  assert.equal(sells[0].f.pnlAtSell, '0~5%', '決策日收盤 175 vs 買進 171');
  assert.ok(samples.every(s => !('uid' in s)), '樣本不帶會員身分');
});

test('lessonText：波段句尾附同日相對差（舊文件無 rel 時文字不變）；AI 買進經驗加註來源與同日相對差；賣出經驗以「賣後 5 日」表述', () => {
  const r = { kind: 'risk', label: 'RSI5 ≥85', n: 40, mean: -2.5, win: 30, restMean: 0.8 };
  assert.equal(lessonText(r, '5日淨%'), '⚠風險：RSI5 ≥85（歷史 n=40，平均 -2.5%、勝率 30%；其餘 0.8%）');
  assert.equal(lessonText({ ...r, rel: -2.1 }, '5日淨%'), '⚠風險：RSI5 ≥85（歷史 n=40，平均 -2.5%、勝率 30%；其餘 0.8%；較同日其他候選 -2.1%）');
  assert.equal(lessonText({ ...r, kind: 'edge', mean: 0.54, restMean: 0.45, rel: 0.23 }, '5日淨%'), '✓優勢：RSI5 ≥85（歷史 n=40，平均 0.54%、勝率 30%；其餘 0.45%；較同日其他候選 +0.23%）');
  assert.equal(lessonText({ ...r, rel: -2.1 }, '5日淨%', 'swing-buy'), '⚠風險（AI 過去買進經驗）：RSI5 ≥85（歷史 n=40，5 日平均 -2.5%、勝率 30%，較同日其他 AI 買進 -2.1%）');
  assert.equal(lessonText({ ...r, rel: -2.1 }, '5日淨%', 'swing-sell'), '⚠賣太早經驗：RSI5 ≥85（歷史 n=40，過去在此條件賣出後 5 日平均 +2.5%，較同日其他賣出 +2.1%）');
  assert.match(lessonText({ ...r, kind: 'edge', mean: 3, restMean: -0.5, rel: 2.4 }, '5日淨%', 'swing-sell'), /^✓賣得對經驗：.*賣出後 5 日平均 -3%，較同日其他賣出 -2\.4%/);
});

// 決策層合成樣本：每個日期有共同行情（mkt）＋個股雜訊；feature M 只與「哪天」有關（大漲日 M=高 比例高）、同日內無效果；
//   feature E 在同日內真有效果（E=壞 少 2.5%）
function synthDecisions({ dates = 40, perDay = 12, seed = 11 } = {}) {
  let sd = seed; const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  const S = [];
  for (let d = 0; d < dates; d++) {
    const mkt = (rnd() - 0.5) * 12;
    for (let k = 0; k < perDay; k++) {
      const M = rnd() < (mkt > 0 ? 0.8 : 0.2) ? '高' : '低', E = rnd() < 0.35 ? '壞' : '好';
      S.push({ key: 'swing-buy', date: `d${String(d).padStart(3, '0')}`, f: { M, E }, y: mkt + (rnd() - 0.5) * 6 + (E === '壞' ? -2.5 : 0) });
    }
  }
  return S;
}

test('learn 決策層：以同日其他 AI 決策為基準——只跟行情日有關的特徵不會被驗證；同日內真效果仍可驗證；日期太少不驗證', () => {
  const L = learn(synthDecisions())['swing-buy'];
  const r = id => L.rules.find(x => x.id === id);
  assert.notEqual(r('M=高')?.status, 'validated', '大漲日比例高≠特徵有效（未去同日平均時會被誤判）');
  assert.equal(r('E=壞')?.status, 'validated'); assert.equal(r('E=壞').kind, 'risk'); assert.ok(r('E=壞').rel < -1.5, '相對同日其他決策');
  const few = learn(synthDecisions({ dates: 8, perDay: 30 }))['swing-buy'];
  assert.notEqual(few.rules.find(x => x.id === 'E=壞')?.status, 'validated', '只有 8 個日期（訓練段 <10 日）⇒ 最多觀察中');
});

// 2026-10-02 使用者核可：swing 母體也是「同一天數百檔」，同樣以同日其他樣本為基準
//   （真實資料安慰劑：同日內打亂特徵 100 輪，未去均每輪假驗證 15.6 條／52 分段，去均後 2.1 條）
test('learn 波段（swing）：以同日其他樣本為基準——只跟行情日有關的特徵不驗證；同日內真效果仍驗證；顯示平均維持原始值', () => {
  const S = synthDecisions().map(s => ({ ...s, key: 'swing' }));
  const L = learn(S).swing;
  const r = id => L.rules.find(x => x.id === id);
  const ctrl = learn(S.map(s => ({ ...s, key: 'dt-long' })), { minN: { 'dt-long': 60 } })['dt-long'];   // 對照：不去同日平均的 key
  assert.equal(ctrl.rules.find(x => x.id === 'M=高')?.status, 'validated', '對照組：未去同日平均時「大漲日比例高」被誤判為已驗證');
  assert.notEqual(r('M=高')?.status, 'validated', 'swing 去同日平均後不驗證');
  assert.equal(r('E=壞')?.status, 'validated'); assert.equal(r('E=壞').kind, 'risk'); assert.ok(r('E=壞').rel < -1.5, '相對同日其他樣本');
  const bad = S.filter(s => s.f.E === '壞'), good = S.filter(s => s.f.E !== '壞'), avg = xs => +(xs.reduce((a, s) => a + s.y, 0) / xs.length).toFixed(2);
  assert.equal(r('E=壞').mean, avg(bad), '平均＝原始 5 日報酬（未減同日平均）'); assert.equal(r('E=壞').restMean, avg(good));
  assert.match(lessonText(r('E=壞'), '5日淨%'), /^⚠風險：E 壞（歷史 n=\d+，平均 -?[\d.]+%、勝率 [\d.]+%；其餘 -?[\d.]+%；較同日其他候選 -[\d.]+%）$/);
});

test('matchLessons 賣出經驗：結論要與絕對方向一致才提供給 AI；kindText 標示相對', async () => {
  const { kindText } = await import('./ai-lab-learn.mjs');
  const mk = (kind, mean) => ({ id: `x=${kind}${mean}`, feature: 'heldD', bucket: '1~2日', status: 'validated', kind, mean, restMean: 0, label: 'x' });
  const learned = { 'swing-sell': { rules: [mk('edge', -1.05), mk('edge', 2), mk('risk', 0.5), mk('risk', -3)] } };
  const got = matchLessons(learned, 'swing-sell', { heldD: '1~2日' }).map(r => `${r.kind}${r.mean}`);
  assert.deepEqual(got, ['edge2', 'risk-3'], '賣後仍漲 1.05% 不能說「賣得對」；賣後跌 0.5% 不能說「賣太早」');
  assert.equal(kindText('swing-sell', mk('edge', -1.05)), '相對較佳（不提供給 AI）');
  assert.equal(kindText('swing-sell', mk('risk', -3)), '⚠賣太早');
  assert.equal(kindText('swing', mk('risk', -3)), '⚠風險');
});

test('learn：決策層 key 的單位與門檻', () => {
  const S = synth().map(s => ({ ...s, key: 'swing-sell' }));
  const L = learn(S);
  assert.equal(L['swing-sell'].unit, '賣出避開%（賣後 5 日報酬取負號·未扣成本）');
  assert.equal(learn(synth()).swing.unit, '5日%（未扣成本）', '既有 key 不變');
  assert.match(renderLearnMarkdown({ date: 'X', version: 'v', at: 0, learned: L, sources: {} }), /AI 賣出經驗/);
});
