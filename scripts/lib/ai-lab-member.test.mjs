// AI 實驗·會員設定 單元測試：node --test scripts/lib/ai-lab-member.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMemberSettings, netInvestedOf, withdrawableOf, MEMBER_LIMITS } from './ai-lab-member.mjs';

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
