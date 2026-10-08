// 新聞判別·盤後趟的重試條件單元測試：node --test scripts/lib/news-verdict-retry.test.mjs
//   重現 2026-10-07 事故（01:35 失敗後舊條件 mins>=23*60 不再重試）、跨午夜同一晚同一適用日、週末三晚各自要跑、死線、次數與間隔；
//   夜間補判等盤後趟（eveningPassPending·迴圈順序模型＋daemon 原始碼釘住；2026-10-08 審查）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  eveningPassDue, eveningPassFailed, eveningPassPending, NV_EVENING_START_MIN, NV_EVENING_DEADLINE_MIN, NV_EVENING_MAX_TRIES, NV_EVENING_RETRY_GAP_MS,
} from './news-verdict-retry.mjs';

const hm = (h, m = 0) => h * 60 + m;
const oldCond = (mins, done, today) => mins >= 23 * 60 && done !== today;   // 2026-10-08 前的條件
const NOW = 1_000_000_000_000;

test('常數與 computeNewsVerdictBatch 的盤後死線同值（23:00 開跑、05:00 死線）', () => {
  assert.equal(NV_EVENING_START_MIN, 23 * 60);
  assert.equal(NV_EVENING_DEADLINE_MIN, 5 * 60);
  assert.ok(NV_EVENING_MAX_TRIES >= 2);
});

test('2026-10-07 事故重現：23:00 開跑（適用 10-08）→ 01:35 失敗；舊條件午夜後不重試，新條件同一晚同一適用日照樣重試', () => {
  const at23 = eveningPassDue({ mins: hm(23, 0), today: '2026-10-07', yesterday: '2026-10-06', target: '2026-10-08' });
  assert.deepEqual(at23, { due: true, key: '2026-10-08@2026-10-07' });
  const fail = eveningPassFailed(null, at23.key, NOW);
  // 01:35（台北 10-08）：newsVerdictTargetIso('evening') 在 00:00–09:00 的交易日回「今天」＝10-08，與 23:00 那次同一個適用日
  assert.equal(oldCond(hm(1, 35), '', '2026-10-08'), false, '舊條件：午夜後永不成立');
  const at0135 = eveningPassDue({ mins: hm(1, 35), today: '2026-10-08', yesterday: '2026-10-07', target: '2026-10-08', fail, now: NOW + NV_EVENING_RETRY_GAP_MS });
  assert.deepEqual(at0135, { due: true, key: '2026-10-08@2026-10-07' }, '同一晚、同一適用日 ⇒ 重試');
});

test('跨午夜同一晚：已完成就不再跑（重啟讀回完成鍵後也一樣）；沒完成就跑到死線前', () => {
  const key = '2026-10-09@2026-10-08';
  for (const [mins, today, yesterday] of [[hm(23, 30), '2026-10-08', '2026-10-07'], [hm(0, 10), '2026-10-09', '2026-10-08'], [hm(4, 59), '2026-10-09', '2026-10-08']]) {
    assert.equal(eveningPassDue({ mins, today, yesterday, target: '2026-10-09', done: key }).due, false, `${mins} 已完成`);
    assert.equal(eveningPassDue({ mins, today, yesterday, target: '2026-10-09', done: '2026-10-08@2026-10-07' }).due, true, `${mins} 未完成（完成鍵是前一晚的）`);
  }
});

test('窗外不跑：05:00 死線起到 22:59（含白天）；沒有適用日也不跑', () => {
  for (const mins of [hm(5, 0), hm(6, 30), hm(12, 0), hm(22, 59)]) {
    const r = eveningPassDue({ mins, today: '2026-10-09', yesterday: '2026-10-08', target: '2026-10-12' });
    assert.deepEqual(r, { due: false, key: null }, String(mins));
  }
  assert.equal(eveningPassDue({ mins: hm(23, 5), today: '2026-10-09', yesterday: '2026-10-08', target: null }).due, false);
});

test('週末：週五、週六、週日晚的適用日都是週一，但三晚各自要跑（非交易日也跑；只看適用日會把週六、週日晚整趟跳過）', () => {
  const fri = eveningPassDue({ mins: hm(23, 0), today: '2026-10-09', yesterday: '2026-10-08', target: '2026-10-12' });
  const sat = eveningPassDue({ mins: hm(23, 0), today: '2026-10-10', yesterday: '2026-10-09', target: '2026-10-12', done: fri.key });
  const sun = eveningPassDue({ mins: hm(23, 0), today: '2026-10-11', yesterday: '2026-10-10', target: '2026-10-12', done: sat.key });
  assert.equal(fri.key, '2026-10-12@2026-10-09');
  assert.deepEqual(sat, { due: true, key: '2026-10-12@2026-10-10' });
  assert.deepEqual(sun, { due: true, key: '2026-10-12@2026-10-11' });
  // 週六凌晨（週五那晚的延續）：適用日仍是週一、完成鍵仍是週五那晚
  assert.equal(eveningPassDue({ mins: hm(2, 0), today: '2026-10-10', yesterday: '2026-10-09', target: '2026-10-12' }).key, fri.key);
});

test('重試節制：失敗後隔 NV_EVENING_RETRY_GAP_MS 才再試；同一晚最多 NV_EVENING_MAX_TRIES 次（之後 exhausted）；換一晚重新起算', () => {
  const base = { mins: hm(0, 30), today: '2026-10-09', yesterday: '2026-10-08', target: '2026-10-09' };
  const key = '2026-10-09@2026-10-08';
  let fail = eveningPassFailed(null, key, NOW);
  assert.deepEqual(fail, { key, n: 1, at: NOW });
  assert.equal(eveningPassDue({ ...base, fail, now: NOW + NV_EVENING_RETRY_GAP_MS - 1 }).due, false, '間隔未到');
  assert.equal(eveningPassDue({ ...base, fail, now: NOW + NV_EVENING_RETRY_GAP_MS }).due, true);
  for (let i = 1; i < NV_EVENING_MAX_TRIES; i++) fail = eveningPassFailed(fail, key, NOW);
  assert.equal(fail.n, NV_EVENING_MAX_TRIES);
  assert.deepEqual(eveningPassDue({ ...base, fail, now: NOW + 3600e3 }), { due: false, key, exhausted: true });
  // 換一晚：前一晚的失敗紀錄不影響
  assert.equal(eveningPassDue({ mins: hm(23, 0), today: '2026-10-09', yesterday: '2026-10-08', target: '2026-10-12', fail, now: NOW }).due, true);
  assert.deepEqual(eveningPassFailed(fail, '2026-10-12@2026-10-09', NOW + 1), { key: '2026-10-12@2026-10-09', n: 1, at: NOW + 1 });
});

// ── 2026-10-08 審查：盤後趟未完成（含等重試間隔的空檔）時，夜間補判要等它 ──────────────────────────
//   夜間補判跑完才寫 night-backfill.json，wiki 年報萃取看到就開始用 Ollama ⇒ 不能在盤後趟重試之前寫。

test('eveningPassPending：失敗後等重試間隔的空檔仍「待完成」；完成、用完次數、05:00 死線後、沒有適用日 ⇒ 不再待完成', () => {
  const key = '2026-10-08@2026-10-07';
  const base = { mins: hm(1, 40), today: '2026-10-08', yesterday: '2026-10-07', target: '2026-10-08' };
  const fail1 = eveningPassFailed(null, key, NOW);
  assert.equal(eveningPassDue({ ...base, fail: fail1, now: NOW + 5 * 60_000 }).due, false, '間隔未到（due＝false）');
  assert.equal(eveningPassPending({ ...base, fail: fail1, now: NOW + 5 * 60_000 }), true, '但仍待完成 ⇒ 夜間補判要等');
  assert.equal(eveningPassPending({ ...base, done: key, fail: fail1, now: NOW }), false, '已完成');
  assert.equal(eveningPassPending({ ...base, done: '2026-10-07@2026-10-06', now: NOW }), true, '完成鍵是前一晚的 ⇒ 這一晚仍待完成');
  let fail = fail1;
  for (let i = 1; i < NV_EVENING_MAX_TRIES; i++) fail = eveningPassFailed(fail, key, NOW);
  assert.equal(eveningPassPending({ ...base, fail, now: NOW + 3600e3 }), false, '用完次數（放棄）');
  assert.equal(eveningPassPending({ ...base, mins: hm(5, 0), fail: fail1, now: NOW }), false, '05:00 死線起不再等');
  assert.equal(eveningPassPending({ ...base, target: null }), false, '沒有適用日');
});

// 迴圈順序模型：與 daemon dailyJobsLoop 同序（每輪先盤後趟、再夜間補判；循序、每輪間隔 5 分鐘、mins 取輪首時刻）。
//   attempts＝盤後趟每次嘗試的 { dur（分鐘）, ok }；gate＝夜間補判是否套 eveningPassPending 閘門。
//   回傳事件序列 [事件, 台北 HH:MM]。時間軸：10-07 23:00 起到 10-08 06:30。
function simulateNight(attempts, { gate = true } = {}) {
  const D0 = '2026-10-07', D1 = '2026-10-08';
  const ms = t => NOW + t * 60_000;
  const clock = t => `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  const events = [];
  let done = '', fail = null, nightDone = false, k = 0;
  for (let t = hm(23, 0); t < 1440 + hm(6, 30);) {
    const at = { mins: t % 1440, today: t < 1440 ? D0 : D1, yesterday: t < 1440 ? '2026-10-06' : D0, target: D1 };
    const r = eveningPassDue({ ...at, done, fail, now: ms(t) });
    if (r.due) {
      const a = attempts[k++] || { dur: 60, ok: true };
      t += a.dur;
      if (a.ok) done = r.key; else fail = eveningPassFailed(fail, r.key, ms(t));
      events.push([a.ok ? 'eve-ok' : 'eve-fail', clock(t)]);
    }
    const pending = gate && eveningPassPending({ ...at, done, fail, now: ms(t) });
    if (!nightDone && at.mins >= 75 && at.mins < hm(6, 30) && !pending) {
      events.push(['night', clock(t)]);   // 寫 night-backfill.json ⇒ wiki 年報萃取開始用 Ollama
      t += 24; nightDone = true;
    }
    t += 5;
  }
  return events;
}
const idx = (ev, name) => ev.findIndex(([e]) => e === name);

test('迴圈順序·10-07 事故：01:35 失敗 → 舊順序 01:40 先跑夜間補判（寫訊號、萃取開跑）再重試；有閘門 ⇒ 重試完成後才跑夜間補判', () => {
  const attempts = [{ dur: 155, ok: false }, { dur: 60, ok: true }];
  const old = simulateNight(attempts, { gate: false });
  assert.deepEqual(old.slice(0, 2), [['eve-fail', '01:35'], ['night', '01:40']], '無閘門：夜間補判插在重試之前（審查指出的問題）');
  assert.ok(idx(old, 'night') < idx(old, 'eve-ok'));
  const now = simulateNight(attempts);
  assert.deepEqual(now.map(([e]) => e), ['eve-fail', 'eve-ok', 'night']);
  assert.equal(now[1][1], '02:45', '01:40 那輪仍在重試間隔內（不跑補判）、01:45 重試、02:45 完成');
  assert.equal(now[2][1], '02:45', '盤後趟成功的同一輪就放行夜間補判');
});

test('迴圈順序：同一晚用完重試次數 ⇒ 放棄後才跑夜間補判；重試拖過 05:00 死線 ⇒ 05:00 起不再等；01:15 前完成 ⇒ 照常 01:15 起跑', () => {
  const allFail = simulateNight([{ dur: 150, ok: false }, { dur: 30, ok: false }, { dur: 30, ok: false }]);
  assert.deepEqual(allFail.map(([e]) => e), ['eve-fail', 'eve-fail', 'eve-fail', 'night']);
  assert.ok(allFail.at(-1)[1] < '05:00', '放棄後立刻放行，不必等到死線');
  const late = simulateNight([{ dur: 300, ok: false }, { dur: 20, ok: false }]);
  assert.equal(late[0][1], '04:00');
  const night = late.find(([e]) => e === 'night');
  assert.ok(night && night[1] >= '05:00' && night[1] < '06:30', `05:00 死線後才跑、06:30 前跑得到：${night && night[1]}`);
  const normal = simulateNight([{ dur: 125, ok: true }]);
  assert.deepEqual(normal, [['eve-ok', '01:05'], ['night', '01:15']]);
});

// 原始碼釘住：daemon 是 disk 即部署，迴圈順序模型只有在 daemon 確實這樣接時才有意義。
test('daemon 釘住：夜間補判以 eveningPassPending 擋（在盤後趟嘗試之後以當下記錄重算）；night-backfill.json 只在閘門內寫', () => {
  const daemon = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'ai-daemon.mjs'), 'utf8');
  const c = daemon.replace(/\/\/.*$/gm, '');   // 只看程式碼
  const eve = c.indexOf('const nvEve = eveningPassDue({ ...nvEveAt, done: _nvEveDone, fail: _nvEveFail, now: Date.now() });');
  const attempt = c.indexOf("await computeNewsVerdictBatch('evening', NV_EVENING_DEADLINE_MIN)");
  const pend = c.indexOf('const nvEvePending = eveningPassPending({ ...nvEveAt, done: _nvEveDone, fail: _nvEveFail, now: Date.now() });');
  const win = c.indexOf('const nvNightWindow = mins >= 60 + 15 && mins < 6 * 60 + 30 && _nvNightDate !== today;');
  const gate = c.indexOf('if (nvNightWindow && !nvEvePending) {');
  const run = c.indexOf('const did = await computeNightBackfill();');
  const sig = c.indexOf("writeSignal('night-backfill.json', { day: today, judged: !!did });");
  for (const [n, i] of Object.entries({ eve, attempt, pend, win, gate, run, sig })) assert.ok(i > 0, `找不到 ${n}`);
  assert.ok(eve < attempt && attempt < pend, '閘門在盤後趟嘗試之後重算（本輪剛成功／剛用完次數就放行）');
  assert.ok(pend < win && win < gate && gate < run && run < sig, '夜間補判與訊號都在閘門內');
  assert.ok(sig - gate < 400, '訊號寫入緊跟在閘門區塊內');
  assert.equal((c.match(/writeSignal\('night-backfill\.json'/g) || []).length, 1, 'night-backfill.json 只有一處寫入');
  assert.equal((c.match(/await computeNightBackfill\(/g) || []).length, 1, '迴圈內只有一處夜間補判');
});
