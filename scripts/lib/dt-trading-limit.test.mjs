// 當沖 AI 帳戶交易規則 單元測試：node --test scripts/lib/dt-trading-limit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DT_DAILY_LIMIT, limitUsed, limitLeft, maxLots, tradeBlock, limitRequestOf, lotTranches } from './dt-trading-limit.mjs';

test('每日額度 100 萬；已用＝已成交記錄的進場價金（不含手續費、平倉不回補）', () => {
  assert.equal(DT_DAILY_LIMIT, 1_000_000);
  const recs = [
    { status: 'filled', fillPx: 41.05, shares: 6000, ledger: { pnlTwd: 500 } },   // 已平倉仍佔額度（不回補）
    { status: 'filled', fillPx: 100, shares: 2000 },                              // 持倉中
    { status: 'skipped', fillPx: null, shares: null },
    { status: 'no-limit' },
  ];
  assert.equal(limitUsed(recs), 246300 + 200000);
  assert.equal(limitLeft(1_000_000, recs), 553700);
  assert.equal(limitLeft(400_000, recs), 0, '不出現負數');
});

test('maxLots：剩餘額度內最多幾張（只能整張）', () => {
  assert.equal(maxLots(41.05, 553700), 13);
  assert.equal(maxLots(600, 553700), 0, '1 張 60 萬 > 剩餘 ⇒ 0');
  assert.equal(maxLots(0, 1e6), 0);
  assert.equal(maxLots(50, 50000), 1, '剛好 1 張');
});

test('tradeBlock：處置股、非當沖標的、名單取不到一律不交易；做空需可先賣後買', () => {
  assert.equal(tradeBlock({ side: 'long', disposition: false, elig: 1 }), null);
  assert.equal(tradeBlock({ side: 'long', disposition: false, elig: 2 }), null, '2＝僅先買後賣 ⇒ 做多可');
  assert.equal(tradeBlock({ side: 'short', disposition: false, elig: 1 }), null);
  assert.match(tradeBlock({ side: 'short', disposition: false, elig: 2 }), /不可先賣後買/);
  assert.match(tradeBlock({ side: 'long', disposition: false, elig: 0 }), /非現股當沖標的/);
  assert.match(tradeBlock({ side: 'long', disposition: true, elig: 1 }), /處置/);
  assert.match(tradeBlock({ side: 'long', disposition: null, elig: 1 }), /處置名單取不到/);
  assert.match(tradeBlock({ side: 'long', disposition: false, elig: null }), /資格名單取不到/);
});

test('limitRequestOf：現金超過額度才申請（建議額度＝現金×2、進位到 10 萬）；待審中不重複；被拒後現金創新高才再申請', () => {
  assert.equal(limitRequestOf({ cash: 990_000, limit: 1_000_000 }), null);
  assert.equal(limitRequestOf({ cash: 1_000_000, limit: 1_000_000 }), null, '等於不算超過');
  assert.deepEqual(limitRequestOf({ cash: 1_053_210, limit: 1_000_000 }), { current: 1_000_000, cash: 1_053_210, proposed: 2_200_000 });
  assert.equal(limitRequestOf({ cash: 1_200_000, limit: 1_000_000, last: { status: 'pending', cash: 1_050_000 } }), null, '待審中');
  assert.equal(limitRequestOf({ cash: 1_040_000, limit: 1_000_000, last: { status: 'rejected', cash: 1_050_000 } }), null, '被拒後未創新高');
  assert.equal(limitRequestOf({ cash: 1_060_000, limit: 1_000_000, last: { status: 'rejected', cash: 1_050_000 } })?.proposed, 2_200_000);
  assert.equal(limitRequestOf({ cash: 1_060_000, limit: 2_200_000, last: { status: 'approved', cash: 1_050_000 } }), null, '核准後額度已高於現金');
});

test('lotTranches：分批出場也只能整張——n 張分三批、餘數往後；股數合計不變', () => {
  assert.deepEqual(lotTranches(1000), [0, 0, 1000], '1 張不拆（舊版 333／333／334 是零股）');
  assert.deepEqual(lotTranches(2000), [0, 1000, 1000]);
  assert.deepEqual(lotTranches(3000), [1000, 1000, 1000]);
  assert.deepEqual(lotTranches(4000), [1000, 1000, 2000]);
  assert.deepEqual(lotTranches(13000), [4000, 4000, 5000]);
  assert.deepEqual(lotTranches(0), [0, 0, 0]);
});
