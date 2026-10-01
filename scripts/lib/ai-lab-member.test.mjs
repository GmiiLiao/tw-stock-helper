// AI 實驗·會員設定 單元測試：node --test scripts/lib/ai-lab-member.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMemberSettings, netInvestedOf, withdrawableOf, pendingFlowOf, withdrawableNow, goalProgress, MEMBER_LIMITS, GOAL_DAYS } from './ai-lab-member.mjs';

const T = '2026-10-02', NOW = 1_800_000_000_000;

test('首次投入：產生入金異動；低於最低投入或格式錯誤拒絕', () => {
  const r = applyMemberSettings({ capital: 300000 }, null, { today: T, now: NOW });
  assert.equal(r.ok, true); assert.deepEqual(r.flow, { date: T, amount: 300000, at: NOW });
  assert.equal(netInvestedOf(r.next.flows), 300000);
  assert.match(applyMemberSettings({ capital: 30000 }, null, { today: T }).error, /至少 50,000/);
  for (const bad of [-1, 1.5, '300000', MEMBER_LIMITS.maxCapital + 1]) assert.equal(applyMemberSettings({ capital: bad }, null, { today: T }).ok, false, String(bad));
});

test('加碼＝入金、減少＝提領；提領不可超過可提領現金；金額不變不產生異動', () => {
  const cur = { flows: [{ date: '2026-10-01', amount: 300000 }] };
  assert.equal(applyMemberSettings({ capital: 500000 }, cur, { today: T }).flow.amount, 200000);
  const w = applyMemberSettings({ capital: 200000 }, cur, { today: T, withdrawable: 150000 });
  assert.equal(w.ok, true); assert.equal(w.flow.amount, -100000);
  const x = applyMemberSettings({ capital: 100000 }, cur, { today: T, withdrawable: 150000 });
  assert.equal(x.ok, false); assert.match(x.error, /可提領現金不足.*150,000/);
  assert.equal(applyMemberSettings({ capital: 300000 }, cur, { today: T }).flow, null);
  assert.equal(applyMemberSettings({ capital: 0 }, cur, { today: T, withdrawable: 300000 }).flow.amount, -300000, '填 0＝提領全部可提領現金');
  assert.match(applyMemberSettings({ capital: 40000 }, cur, { today: T, withdrawable: 300000 }).error, /0 或至少 50,000/);
});

test('填 0＝提領全部可提領現金：含獲利（淨投入可為負）；持股中的部分留在帳戶；沒有可提領現金則拒絕', () => {
  const cur = { flows: [{ date: '2026-10-01', amount: 300000 }] };
  const profit = applyMemberSettings({ capital: 0 }, cur, { today: T, withdrawable: 358565 });
  assert.equal(profit.flow.amount, -358565, '獲利一起提領（審查發現：舊版獲利會卡在帳戶裡）');
  assert.equal(netInvestedOf(profit.next.flows), -58565);
  assert.equal(applyMemberSettings({ capital: 0 }, cur, { today: T, withdrawable: 100000 }).flow.amount, -100000, '持股中的資金等 AI 賣出後再提領');
  assert.match(applyMemberSettings({ capital: 0 }, cur, { today: T, withdrawable: 0 }).error, /沒有可提領的現金/);
});

test('資金異動筆數上限（避免文件無限長）', () => {
  const flows = Array.from({ length: MEMBER_LIMITS.maxFlows }, (_, i) => ({ date: T, amount: i % 2 ? 10000 : -10000 }));
  assert.match(applyMemberSettings({ capital: 999999 }, { flows }, { today: T, withdrawable: 1e9 }).error, /上限/);
});

test('當沖額度與獲利成長目標：範圍檢查；目標可清除', () => {
  const r = applyMemberSettings({ daytradeLimit: 2000000, growthTarget: 35.55 }, null, { today: T });
  assert.equal(r.ok, true); assert.equal(r.next.daytradeLimit, 2000000); assert.equal(r.next.growthTarget, 35.6);
  assert.equal(applyMemberSettings({ daytradeLimit: -1 }, null, { today: T }).ok, false);
  assert.equal(applyMemberSettings({ growthTarget: 0 }, null, { today: T }).ok, false);
  assert.equal(applyMemberSettings({ growthTarget: 1001 }, null, { today: T }).ok, false);
  assert.equal(applyMemberSettings({ growthTarget: null }, { growthTarget: 30 }, { today: T }).next.growthTarget, null);
});

test('withdrawableOf：已交割現金－應付－委託買單保留；沒有快照＝淨投入', () => {
  assert.equal(withdrawableOf({ settledCash: 200000, payable: 30000, reservedBuys: 50000, cash: 260000 }, 300000), 120000);
  assert.equal(withdrawableOf(null, 300000), 300000);
  assert.equal(withdrawableOf({ settledCash: 10000, payable: 30000, reservedBuys: 0 }, 300000), 0, '不為負');
});

test('獲利期間：只接受 5／10／20／60／120／240 日；目標或期間變更＝重新起算；只加碼／提領不重算；清除目標＝不追蹤', () => {
  assert.deepEqual([...GOAL_DAYS], [5, 10, 20, 60, 120, 240]);
  const r = applyMemberSettings({ growthTarget: 10, goalDays: 20 }, null, { today: T });
  assert.equal(r.ok, true); assert.equal(r.next.goalDays, 20); assert.equal(r.next.goalStartDate, T);
  for (const bad of [0, 15, '20', 300, null]) assert.equal(applyMemberSettings({ goalDays: bad }, null, { today: T }).ok, false, String(bad));
  const cur = { flows: [{ date: '2026-10-01', amount: 300000 }], growthTarget: 10, goalDays: 20, goalStartDate: '2026-10-01' };
  assert.equal(applyMemberSettings({ capital: 400000 }, cur, { today: T }).next.goalStartDate, '2026-10-01', '只加碼不重算期間');
  assert.equal(applyMemberSettings({ goalDays: 60 }, cur, { today: T }).next.goalStartDate, T, '改期間＝重新起算');
  assert.equal(applyMemberSettings({ growthTarget: 12 }, cur, { today: T }).next.goalStartDate, T, '改目標＝重新起算');
  assert.equal(applyMemberSettings({ growthTarget: 10, goalDays: 20 }, cur, { today: T }).next.goalStartDate, '2026-10-01', '值沒變不重算');
  assert.equal(applyMemberSettings({ growthTarget: null }, cur, { today: T }).next.goalStartDate, null, '清除目標');
  assert.equal(applyMemberSettings({ goalDays: 60 }, { goalDays: 20 }, { today: T }).next.goalStartDate, null, '沒有目標時只存期間、不起算');
});

test('goalProgress：滾動期間——自設定日的下一個交易日起算、每 N 日一期；本期報酬＝時間加權 growth 相除；到期自動進入下一期並記上一期達標與否', () => {
  const mk = (date, growth) => ({ date, growth, cumRetPct: +((growth - 1) * 100).toFixed(2) });
  const hist = [mk('2026-10-01', 1.00), mk('2026-10-02', 1.02), mk('2026-10-05', 1.03), mk('2026-10-06', 1.05), mk('2026-10-07', 1.04), mk('2026-10-08', 1.10)];
  assert.equal(goalProgress(hist, { growthTarget: null }), null, '沒設目標');
  const p = goalProgress(hist, { growthTarget: 5, goalDays: 5, goalStartDate: '2026-10-01' });
  assert.equal(p.period, 2); assert.equal(p.day, 0); assert.equal(p.daysLeft, 5); assert.equal(p.periodRetPct, 0); assert.equal(p.periodStart, null, '新的一期自下一個交易日起算');
  assert.deepEqual(p.lastPeriod, { n: 1, retPct: 10, achieved: true }, '第 1 期 10-02～10-08：1.10÷1.00');
  const q = goalProgress(hist, { growthTarget: 20, goalDays: 10, goalStartDate: '2026-10-01' });
  assert.equal(q.period, 1); assert.equal(q.day, 5); assert.equal(q.daysLeft, 5); assert.equal(q.periodStart, '2026-10-02');
  assert.equal(q.periodRetPct, 10); assert.equal(q.progress, 50); assert.equal(q.lastPeriod, null); assert.equal(q.cumRetPct, 10);
  assert.equal(goalProgress(hist, { growthTarget: 10, goalDays: 20, goalStartDate: '2026-09-30' }).periodRetPct, 10, '目標設在第一筆戰績之前：基準 1');
  assert.equal(goalProgress(hist, { growthTarget: 10, goalDays: 7, goalStartDate: '2026-10-01' }).days, 20, '期間不合法＝預設 20 日');
  const loss = goalProgress([mk('2026-10-02', 0.95)], { growthTarget: 10, goalDays: 20, goalStartDate: '2026-10-01' });
  assert.equal(loss.periodRetPct, -5); assert.equal(loss.progress, 0, '虧損時進度不為負');
  const empty = goalProgress([], { growthTarget: 10, goalDays: 20, goalStartDate: T });
  assert.equal(empty.day, 0); assert.equal(empty.period, 1); assert.equal(empty.cumRetPct, null);
});

test('快照之後的入金／提領：以 flowsIncluded 判斷；可提領＝快照可提領＋之後異動；沒有快照＝淨投入；重算前連續提領不可超領', () => {
  const flows = [{ date: '2026-10-01', amount: 300000, at: 1 }, { date: '2026-10-02', amount: -30000, at: 3 }];
  const snap = { at: 2, flowsIncluded: 1, account: { settledCash: 49644, payable: 0, reservedBuys: 0 } };
  assert.equal(pendingFlowOf(flows, snap), -30000);
  assert.equal(withdrawableNow(snap, flows), 19644);
  assert.match(applyMemberSettings({ capital: 250000 }, { flows }, { today: T, withdrawable: withdrawableNow(snap, flows) }).error, /可提領現金不足.*19,644/, '審查情境：提領 3 萬後再提 2 萬被拒');
  assert.equal(pendingFlowOf(flows, { at: 2, account: {} }), -30000, '舊快照沒有 flowsIncluded：以時間比對');
  assert.equal(pendingFlowOf(flows, null), 0);
  assert.equal(withdrawableNow(null, flows), 270000, '沒有快照＝淨投入');
  assert.equal(withdrawableNow({ flowsIncluded: 0, account: { settledCash: 0 } }, [{ date: T, amount: 300000 }]), 300000, '0 元快照＋首次入金');
});
