// 波段帳戶摘要與每日戰績 單元測試：node --test scripts/lib/ai-swing-history.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountSummary, historyRow, rebuildHistory } from './ai-swing-history.mjs';

const mkDays = (n = 20) => Array.from({ length: n }, (_, i) => ({
  date: `2026-09-${String(1 + i).padStart(2, '0')}`,
  m: { 1111: [100 + i, 1000, 99 + i, 100.5 + i, 98.5 + i], 2222: [50, 1000, 50, 50.5, 49.5] },
}));

test('accountSummary：總值＝現金＋已進場淨市值；待進場不計入；賣出委託分開計；資金池＝本金＋已實現', () => {
  const s = accountSummary({ account: { initial: 500000, cash: 1000, realized: -500, reservedBuys: 20000, pendingSellEst: 30000, freeCash: 11000 }, closed: [{}],
    holdings: [
      { state: 'held', entryPx: 10, cost: 100000, mktValue: 110000, netValue: 109000, unrealized: 9000 },
      { state: 'selling', entryPx: 20, cost: 50000, mktValue: 49000, netValue: 48500, unrealized: -1500 },
      { state: 'pending', entryPx: null, cost: 20000, mktValue: null, netValue: null, unrealized: null },
    ] });
  assert.equal(s.total, 1000 + 109000 + 48500); assert.equal(s.netMkt, 157500); assert.equal(s.mktValue, 159000); assert.equal(s.estSellCost, 1500);
  assert.equal(s.held, 1); assert.equal(s.selling, 1); assert.equal(s.pending, 1); assert.equal(s.closedN, 1);
  assert.equal(s.unrealized, 7500); assert.equal(s.pool, 499500); assert.equal(s.freeCash, 11000);
  assert.equal(s.totalPnl, s.total - 500000);
});

test('historyRow：每列 現金＋持倉淨市值＝帳戶總值；買進／賣出筆數＝當日成交；當日損益＝總值變化', () => {
  const snap = { dataDate: '2026-09-05', account: { initial: 500000, cash: 400000, realized: 0 },
    holdings: [{ state: 'held', entryPx: 10, entryDate: '2026-09-05', cost: 100000, mktValue: 101000, netValue: 100500, unrealized: 500 }, { state: 'pending', cost: 5000 }], closed: [] };
  const r = historyRow(snap, { total: 499000 });
  assert.equal(r.cash + r.netMkt, r.total); assert.equal(r.opened, 1); assert.equal(r.pending, 1); assert.equal(r.dayPnl, r.total - 499000);
});

test('rebuildHistory：由記錄逐日重算——決策日只有待進場（現金 50 萬、總值 50 萬）、成交日起計入；舊算法的列被覆蓋', () => {
  const days = mkDays(12);
  const docs = [{ date: days[3].date, picks: [{ code: '1111', name: 'A', position: { shares: 1000, exitH: 5, estCost: 103000 } }], outcomes: {} }];
  const legacy = [{ date: days[3].date, holdings: 0, pending: 1, cash: 397000, mktValue: 103000, total: 500000 }];   // 舊算法：預扣現金＋以成本計市值
  const h = rebuildHistory(docs, days, legacy);
  assert.equal(h[0].date, days[3].date, '自第一個決策日起');
  assert.equal(h[0].cash, 500000); assert.equal(h[0].mktValue, 0); assert.equal(h[0].pending, 1); assert.equal(h[0].total, 500000);
  assert.equal(h[1].opened, 1, 'D+1 開盤成交'); assert.equal(h[1].holdings, 1); assert.equal(h[1].pending, 0);
  for (const r of h) assert.equal(r.cash + r.netMkt, r.total, `${r.date}：現金＋淨市值＝總值`);
  assert.equal(h.length, days.length - 3);
});

test('rebuildHistory：無法重算的舊列原樣保留（早於日線視窗或早於第一個決策日），不會被刪', () => {
  const days = mkDays(12);
  const docs = [{ date: days[3].date, picks: [{ code: '1111', name: 'A', position: { shares: 1000, exitH: 5, estCost: 103000 } }], outcomes: {} }];
  const old = [{ date: '2026-08-15', total: 500000 }, { date: days[1].date, total: 500000 }];
  const h = rebuildHistory(docs, days, old);
  assert.deepEqual(h.slice(0, 2).map(r => r.date), ['2026-08-15', days[1].date]);
  assert.equal(h[2].date, days[3].date);
});
