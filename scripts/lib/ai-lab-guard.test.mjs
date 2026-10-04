import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askWithOutcome, llmNextStep, isInfraFailure, twClock, addMinutes, nextOpenOf, latestTradingDayAsOf, expectedSwingDataDate,
  swingFreezeGate, isFailureFreeze, mergeRecordsById, alignArchiveDays, priceFactorsFromDoc, shadowDayCheck, createBudget } from './ai-lab-guard.mjs';
import { beforeNextOpen } from './canonical-gate.mjs';

// 2026-10 交易日曆：週末＋10-10 國慶休市
const isTd = iso => { const g = new Date(`${iso}T12:00:00Z`).getUTCDay(); return g !== 0 && g !== 6 && iso !== '2026-10-10' && iso !== '2026-10-09'; };

test('Ollama 結果：連線／HTTP／逾時屬基礎設施，不計重試額度；空回覆與看不懂計次', async () => {
  assert.equal(isInfraFailure('connect'), true); assert.equal(isInfraFailure('timeout'), true); assert.equal(isInfraFailure('http'), true);
  assert.equal(isInfraFailure('empty'), false); assert.equal(isInfraFailure('ok'), false);
  assert.deepEqual(await askWithOutcome({ askOllamaEx: async () => ({ text: null, kind: 'connect', detail: 'ECONNREFUSED' }) }, 'p'), { text: null, kind: 'connect', detail: 'ECONNREFUSED' });
  assert.equal((await askWithOutcome({ askOllamaEx: async () => ({ text: 'x', kind: 'ok' }) }, 'p')).kind, 'ok');
  assert.equal((await askWithOutcome({ askOllamaEx: async () => ({ text: '', kind: 'ok' }) }, 'p')).kind, 'empty', 'ok 但空字串＝空回覆');
  assert.equal((await askWithOutcome({ askOllamaEx: async () => { throw new Error('boom'); } }, 'p')).kind, 'connect');
  // 舊介面（只回字串）：null 無法分辨原因 ⇒ 'empty'（計次，沿用舊語意），不冒充連線失敗
  assert.equal((await askWithOutcome({ askOllama: async () => null }, 'p')).kind, 'empty');
  assert.equal((await askWithOutcome({ askOllama: async () => '{"a":1}' }, 'p')).text, '{"a":1}');
});

test('llmNextStep：連不上撐到最後一次才凍結；看不懂第 3 次或最後一次才凍結', () => {
  assert.equal(llmNextStep({ kind: 'connect', parsedOk: false, attempts: 99 }), 'retry-infra', '連線類不看次數');
  assert.equal(llmNextStep({ kind: 'timeout', parsedOk: false, lastChance: true }), 'freeze-infra');
  assert.equal(llmNextStep({ kind: 'ok', parsedOk: true, attempts: 1 }), 'ok');
  assert.equal(llmNextStep({ kind: 'ok', parsedOk: false, attempts: 1 }), 'retry-parse');
  assert.equal(llmNextStep({ kind: 'empty', parsedOk: false, attempts: 3 }), 'freeze-parse');
  assert.equal(llmNextStep({ kind: 'ok', parsedOk: false, attempts: 1, lastChance: true }), 'freeze-parse');
});

test('時鐘與下一個開盤：與 canonical-gate.beforeNextOpen 同定義', () => {
  assert.equal(twClock(Date.parse('2026-10-02T09:05:00Z')), '2026-10-02T17:05');
  assert.equal(addMinutes('2026-10-02T23:50', 20), '2026-10-03T00:10');
  assert.equal(nextOpenOf('2026-10-02', isTd), '2026-10-05T08:30', '週五 → 下週一');
  assert.equal(nextOpenOf('2026-10-08', isTd), '2026-10-12T08:30', '跨國慶連假');
  for (const now of ['2026-10-05T08:29', '2026-10-05T08:30', '2026-10-03T12:00']) assert.equal(beforeNextOpen('2026-10-02', now, isTd), now < nextOpenOf('2026-10-02', isTd));
});

test('G2-31 波段選股資料日：午夜後那一輪仍是前一交易日，當天 17:00 起才是今天', () => {
  assert.equal(expectedSwingDataDate('2026-10-06T00:30', isTd), '2026-10-05', '週二凌晨＝週一的盤後');
  assert.equal(expectedSwingDataDate('2026-10-06T08:20', isTd), '2026-10-05');
  assert.equal(expectedSwingDataDate('2026-10-06T16:59', isTd), '2026-10-05', '17:00 前仍不是今天');
  assert.equal(expectedSwingDataDate('2026-10-06T17:00', isTd), '2026-10-06', '同一個日曆日的傍晚＝新資料日（舊版日曆日冪等會整段跳過）');
  assert.equal(expectedSwingDataDate('2026-10-05T03:00', isTd), '2026-10-02', '週一凌晨＝上週五');
  assert.equal(expectedSwingDataDate('2026-10-03T20:00', isTd), '2026-10-02', '週六');
  assert.equal(latestTradingDayAsOf('2026-10-06T13:30', isTd, 13 * 60 + 30), '2026-10-06');
  assert.equal(latestTradingDayAsOf('2026-10-06T13:29', isTd, 13 * 60 + 30), '2026-10-05');
});

const close = (n, otc = true) => { const m = { 2330: [1], 2317: [1], 2454: [1], 2882: [1] }; if (otc) Object.assign(m, { 6274: [1], 8069: [1], 3260: [1] }); for (let i = 0; m && Object.keys(m).length < n; i++) m[String(1100 + i)] = [1]; return JSON.stringify(m); };

test('G2-30 波段凍結閘門：上櫃未併入、或榜單以殘缺歸檔算出 ⇒ 不凍結', () => {
  const full = { closeJson: close(1800), otcPending: false };
  const okHold = { universeAll: 1790, updatedAt: 1000 }, okPicks = { universeN: 1800, updatedAt: 900 };
  assert.deepEqual(swingFreezeGate({ archiveDoc: full, swingHold: okHold, swingPicks: okPicks }), { ready: true, missing: [] });
  const tseOnly = { closeJson: close(1050, false), otcPending: true };
  const g1 = swingFreezeGate({ archiveDoc: tseOnly, swingHold: { universeAll: 1050 }, swingPicks: { universeN: 1050 } });
  assert.equal(g1.ready, false); assert.ok(g1.missing.some(m => /上櫃收盤/.test(m)));
  const g2 = swingFreezeGate({ archiveDoc: full, swingHold: { universeAll: 1050, updatedAt: 1 }, swingPicks: okPicks });
  assert.ok(g2.missing.some(m => /波段持有榜以殘缺歸檔/.test(m)), '歸檔已到齊但持有榜仍是 15:10 版');
  const g3 = swingFreezeGate({ archiveDoc: full, swingHold: okHold, swingPicks: { universeN: 1050 } });
  assert.ok(g3.missing.some(m => /波段起漲榜以殘缺歸檔/.test(m)));
  // 舊版起漲榜沒有 universeN：看時間（比持有榜早超過 10 分鐘＝兩市到齊前的版本）
  assert.equal(swingFreezeGate({ archiveDoc: full, swingHold: { universeAll: 1800, updatedAt: 3_600_000 }, swingPicks: { updatedAt: 0 } }).ready, false);
  assert.equal(swingFreezeGate({ archiveDoc: full, swingHold: { universeAll: 1800, updatedAt: 3_600_000 }, swingPicks: { updatedAt: 3_100_000 } }).ready, true);
  assert.equal(swingFreezeGate({ archiveDoc: null, swingHold: okHold, swingPicks: okPicks }).ready, false);
});

test('失敗凍結辨識：只有失敗凍結可被重新決策覆蓋', () => {
  assert.equal(isFailureFreeze({ failure: { kind: 'ollama-unreachable' }, picks: [] }), true);
  assert.equal(isFailureFreeze({ note: 'Ollama 回覆 3 次皆無法解析，今日不操作（持股全部續抱）', picks: [], review: { sells: [] } }), true, '上線前的舊凍結檔');
  assert.equal(isFailureFreeze({ note: '皆無法解析', picks: [{ code: '1', position: { shares: 1000 } }] }), false, '有委託就不是失敗凍結');
  assert.equal(isFailureFreeze({ note: '觀望', picks: [] }), false, 'AI 決定不操作≠失敗');
  assert.equal(isFailureFreeze(null), false);
});

test('G2-20 重啟接回：同 id 取進度較多者，不以較殘缺的版本覆蓋', () => {
  const persisted = [{ id: 'a', status: 'filled', decidedAt: 1, exitAt: 9 }, { id: 'b', status: 'pending' }];
  const current = [{ id: 'a', status: 'filled', decidedAt: 1 }, { id: 'b', status: 'skipped', decidedAt: 2 }, { id: 'c', status: 'pending' }];
  const m = mergeRecordsById(persisted, current);
  assert.deepEqual(m.map(r => r.id), ['a', 'b', 'c']);
  assert.equal(m[0].exitAt, 9, '記憶體版尚未出場 ⇒ 保留已出場的 live 版');
  assert.equal(m[1].status, 'skipped');
  assert.equal(persisted[1].status, 'pending', '不改傳入陣列');
});

test('G2-28 歸檔對齊：殘缺日保留一格（缺值）；空殼依休市日曆（沒日曆＝丟掉）；尾端空殼丟掉', () => {
  const docs = [
    { date: '2026-10-05' },                                     // 尾端空殼（今天盤前）
    { date: '2026-10-02', closeJson: close(1800) },
    { date: '2026-10-01', closeJson: close(1050, false) },      // 只有上市
    { date: '2026-09-30' },                                     // 中間空殼（交易日：整天缺值）
    { date: '2026-09-29', closeJson: close(1800) },
    { date: '2026-09-27' },                                     // 週日的空殼（颱風假型：非交易日）
    { date: '2026-09-26', closeJson: close(1800) },
  ];
  const r = alignArchiveDays(docs, { isTradingDayIso: isTd });
  assert.deepEqual(r.days.map(d => d.date), ['2026-09-26', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  assert.deepEqual(r.partialDates, ['2026-09-30', '2026-10-01']);
  assert.deepEqual(r.droppedTail, ['2026-10-05']);
  assert.deepEqual(r.droppedShells, ['2026-09-27']);
  assert.equal(r.days[3].m['6274'], undefined, '上櫃缺值，不從別天借');
  assert.ok(r.days[3].m['2330']);
  // 沒有日曆：空殼一律丟（與「臨時休市由歸檔空洞反推」同口徑），殘缺日照樣保留
  const r2 = alignArchiveDays(docs);
  assert.deepEqual(r2.days.map(d => d.date), ['2026-09-26', '2026-09-29', '2026-10-01', '2026-10-02']);
  assert.deepEqual(r2.droppedShells, ['2026-09-27', '2026-09-30']);
});

test('G2-26 priceEvents：不存在或沒有 items ＝讀取失敗；空陣列＝窗內沒有事件', () => {
  assert.throws(() => priceFactorsFromDoc(undefined), /不存在/);
  assert.throws(() => priceFactorsFromDoc({ dataDate: 'x' }), /items/);
  assert.deepEqual(priceFactorsFromDoc({ items: [] }), {});
  assert.deepEqual(priceFactorsFromDoc({ items: [{ code: '1', date: '2026-10-01', factor: 0.5 }] }), { 1: [{ date: '2026-10-01', factor: 0.5 }] });
});

test('G2-23 v3 影子資料日：必須是預期的最新交易日且兩市收盤＋法人到齊', () => {
  const inst = JSON.stringify({ 2330: 1, 6274: 1 });
  const ok = { closeJson: close(1800), instJson: inst, otcPending: false };
  assert.equal(shadowDayCheck({ lastDate: '2026-10-05', expected: '2026-10-05', archiveDoc: ok }).ok, true);
  assert.match(shadowDayCheck({ lastDate: '2026-10-02', expected: '2026-10-05', archiveDoc: ok }).why, /不改寫舊日/);
  assert.match(shadowDayCheck({ lastDate: '2026-10-05', expected: '2026-10-05', archiveDoc: { ...ok, otcPending: true } }).why, /上櫃收盤/);
  assert.match(shadowDayCheck({ lastDate: '2026-10-05', expected: '2026-10-05', archiveDoc: { ...ok, instJson: JSON.stringify({ 2330: 1 }) } }).why, /上櫃法人/);
  assert.equal(shadowDayCheck({ lastDate: 'x', expected: null, archiveDoc: ok }).ok, false);
});

test('G4-29 牆鐘預算', () => {
  let t = 0; const b = createBudget(1000, () => t);
  assert.equal(b.expired(), false); t = 999; assert.equal(b.left(), 1); t = 1000; assert.equal(b.expired(), true);
});
