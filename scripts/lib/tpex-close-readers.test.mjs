// node --test scripts/lib/tpex-close-readers.test.mjs
// daemon 接線的自動測試（2026-10-08 審查 LOW）：raceWithin（宇宙 20 秒、班車 60 秒上限；逾時回 slow、下載在背景完成後下一輪 0 請求命中快取）、
// createSharesCache（發行股數兩市到齊才算當日完整；不完整疊在上一份完整表上、10 分鐘後重試）。全部注入，不打網路。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { raceWithin, createSharesCache } from './tpex-close-readers.mjs';
import { createTpexClose } from './tpex-close-quotes.mjs';
import { datedPayload, mockFetch } from './tpex-close.fixture.mjs';

const slowRes = () => ({ status: 'slow', rows: null });
const delay = (ms, v) => new Promise(r => setTimeout(() => r(v), ms));

test('raceWithin：先完成回結果；逾時回 slow（promise 照跑）；丟錯回 failed', async () => {
  assert.deepEqual(await raceWithin(delay(5, { status: 'ok' }), 200, slowRes), { status: 'ok' });
  let finished = false;
  const p = delay(80).then(() => { finished = true; return { status: 'ok' }; });
  assert.equal((await raceWithin(p, 10, slowRes)).status, 'slow');
  assert.equal(finished, false);
  await p; assert.equal(finished, true, '逾時後下載沒有被中止');
  const r = await raceWithin(Promise.reject(new Error('boom')), 100, slowRes);
  assert.equal(r.status, 'failed'); assert.match(r.reason, /boom/);
  const late = delay(30).then(() => { throw new Error('late'); });
  assert.equal((await raceWithin(late, 5, slowRes)).status, 'slow');
  await assert.rejects(late, /late/);   // 逾時後才丟錯：raceWithin 已掛 catch，不會變成 unhandled rejection
});

test('宇宙接線：慢速下載 20 秒（此處縮成 30ms）先回 slow，背景完成後寫快取；下一輪 0 請求命中', async () => {
  const f = mockFetch(() => ({ status: 200, chunks: [{ delay: 120, data: JSON.stringify(datedPayload('2026-10-08')) }] }));
  const svc = createTpexClose({
    root: mkdtempSync(join(tmpdir(), 'tpex-readers-')), mirrorRoot: null, network: 'auto', fetchImpl: f, log: () => {},
    now: () => Date.parse('2026-10-08T15:00:00+08:00'), limits: { minRows: 5, minStocks4: 3, minEtf00: 1 },
    download: { ttfbMs: 2000, stallMs: 2000, capMs: 5000, tickMs: 10 },
  });
  const first = await raceWithin(svc.getTpexClose('2026-10-08'), 30, slowRes);
  assert.equal(first.status, 'slow'); assert.equal(f.calls.length, 1);
  const joined = await svc.getTpexClose('2026-10-08');   // 同程序合流：等的是同一個進行中的下載
  assert.equal(joined.status, 'ok'); assert.equal(f.calls.length, 1);
  const next = await raceWithin(svc.getTpexClose('2026-10-08'), 30, slowRes);
  assert.equal(next.status, 'ok'); assert.equal(next.cached, 'memory'); assert.equal(f.calls.length, 1, '下一輪 0 請求');
});

test('發行股數：兩市到齊＝當日完整（當天不再抓）；跨日重抓', async () => {
  let day = '2026-10-08'; const t = 0; const calls = { tse: 0, otc: 0 };
  const tse = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [String(1000 + i), 1e6 + i]));
  const otc = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [String(3000 + i), 2e6 + i]));
  const get = createSharesCache({ today: () => day, now: () => t, fetchTse: async () => { calls.tse++; return tse; }, fetchOtc: async () => { calls.otc++; return otc; } });
  const m1 = await get();
  assert.equal(Object.keys(m1).length, 1000); assert.equal(m1['3000'], 2e6);
  await get(); assert.deepEqual(calls, { tse: 1, otc: 1 }, '當天命中快取');
  day = '2026-10-09'; await get(); assert.deepEqual(calls, { tse: 2, otc: 2 });
});

test('發行股數：上櫃缺 ⇒ 不當成當日完整；疊在上一份完整表上回傳、10 分鐘內不重抓、之後重試補齊', async () => {
  let day = '2026-10-08'; let t = 0; let otcOk = true; const calls = { tse: 0, otc: 0 }; const logs = [];
  const tse = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [String(1000 + i), 1e6 + i]));
  const otc = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [String(3000 + i), 2e6 + i]));
  const get = createSharesCache({ today: () => day, now: () => t, log: m => logs.push(m),
    fetchTse: async () => { calls.tse++; return tse; },
    fetchOtc: async () => { calls.otc++; if (!otcOk) throw new Error('本機沒有'); return otc; } });
  await get();                                   // 10-08 完整
  day = '2026-10-09'; otcOk = false;
  const m2 = await get();
  assert.equal(m2['3000'], 2e6, '上櫃股數沿用上一份完整表（慢變數）'); assert.equal(Object.keys(m2).length, 1000);
  assert.match(logs.at(-1), /不完整（上市 600／上櫃 0）.*疊在 2026-10-08/);
  t += 5 * 60_000; await get(); assert.deepEqual(calls, { tse: 2, otc: 2 }, '10 分鐘內不重抓');
  t += 6 * 60_000; otcOk = true;
  await get(); assert.deepEqual(calls, { tse: 3, otc: 3 }, '10 分鐘後重試');
  await get(); assert.deepEqual(calls, { tse: 3, otc: 3 }, '補齊後當日完整');
});

test('發行股數：開機時上櫃就缺 ⇒ 只回上市（不捏造）、不寫成當日完整', async () => {
  let t = 0; let n = 0;
  const tse = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [String(1000 + i), 1e6 + i]));
  const get = createSharesCache({ today: () => '2026-10-08', now: () => t, fetchTse: async () => { n++; return tse; }, fetchOtc: async () => ({}) });
  assert.equal(Object.keys(await get()).length, 600);
  t += 11 * 60_000; await get(); assert.equal(n, 2, '不完整表不會被當成當日完整而整天不重試');
});
