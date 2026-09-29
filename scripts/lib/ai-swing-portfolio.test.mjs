// AI 波段主動操作帳戶 單元測試：node --test scripts/lib/ai-swing-portfolio.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lotKey, nextFill, portfolioState, settleFills, parseDecision, portfolioSnapshot, estSellProceeds } from './ai-swing-portfolio.mjs';

// 30 個交易日：1111 每日 +1 元（開＝前收），2222 持平 50；3333 第 3 日起才有資料
const mkDays = (n = 30) => Array.from({ length: n }, (_, i) => ({
  date: `2026-10-${String(1 + i).padStart(2, '0')}`,
  m: { 1111: [100 + i, 1000, 99 + i, 100.5 + i, 98.5 + i], 2222: [50, 1000, 50, 50.5, 49.5], ...(i >= 3 ? { 3333: [20, 1000, 20, 20, 20] } : {}) },
}));
const at = (d, hm) => Date.parse(`${d}T${hm}:00+08:00`);
const buyDoc = (date, code, shares, px, extra = {}) => ({ date, frozenAt: at(date, '18:00'), picks: [{ code, name: code, reason: 'r', horizon: 20, priceAtDecision: px, position: { shares } }], ...extra });

test('nextFill：決策日之後第一個交易日開盤成交；無開盤用收盤並標記；尚無資料回 null；當日無該股＝失敗', () => {
  const days = mkDays();
  const f = nextFill(days, days[2].date, '1111');
  assert.equal(f.date, days[3].date); assert.equal(f.px, 102); assert.equal(f.openMissing, false);
  assert.equal(f.at, at(days[3].date, '09:00'));
  assert.equal(nextFill(days, days[29].date, '1111'), null, '隔日尚未到');
  const x = nextFill(days, days[0].date, '3333');
  assert.equal(x.failed, true, '成交日沒有該股資料（停牌等）＝進場失敗，釋出資金');
  assert.equal(nextFill(days, days[0].date, '3333', { skipMissing: true }).date, days[3].date, '賣單順延到下一個有成交的交易日');
});

test('帳戶：AI 賣出委託於隔日開盤成交、獲利併入現金；未賣的照常持有；決策日以前的記錄才算', () => {
  const days = mkDays();
  const D0 = days[2].date, D1 = days[10].date;
  const docs = [
    buyDoc(D0, '1111', 1000, 101),
    { date: D1, frozenAt: at(D1, '18:00'), picks: [], review: { sells: [{ code: '1111', key: lotKey(D0, '1111'), reason: '漲多換股' }] } },
  ];
  const s = portfolioState(docs, days);
  const lot = s.lots[0];
  assert.equal(lot.buy.px, 102); assert.equal(lot.status, 'closed');
  assert.equal(lot.sell.fill.px, 110, '賣在 D1 隔日開盤 99+11');
  assert.equal(lot.sell.fill.sellNoLookahead, true, '先決定後賣');
  assert.ok(lot.sell.fill.ledger.pnlTwd > 7000);
  assert.equal(s.account.realized, lot.sell.fill.ledger.pnlTwd);
  assert.equal(s.account.openCost, 0);
  assert.equal(s.account.cash, 500000 + lot.sell.fill.ledger.pnlTwd, '本金＋獲利都回到可用現金');
  const before = portfolioState(docs, days, D1);
  assert.equal(before.lots[0].status, 'held', '賣出委託當天（含）以前仍是持有');
  assert.equal(before.account.openCost, 102145, '成本含買進手續費 102000×0.1425%＝145');
});

test('帳戶：未成交的賣單＝賣出中（資金未釋出）；未進場＝待進場以決策價計成本；進場失敗＝作廢不佔資金', () => {
  const days = mkDays(12);
  const D0 = days[2].date, D1 = days[11].date;
  const docs = [
    buyDoc(D0, '1111', 1000, 101),
    buyDoc(days[0].date, '3333', 1000, 20),
    buyDoc(D1, '2222', 2000, 50),
    { date: D1, frozenAt: at(D1, '18:00'), picks: [], review: { sells: [{ code: '1111', key: lotKey(D0, '1111'), reason: 'x' }] } },
  ];
  const s = portfolioState(docs, days);
  const by = c => s.lots.find(l => l.code === c);
  assert.equal(by('1111').status, 'selling');
  assert.equal(by('2222').status, 'pending');
  assert.equal(by('3333').status, 'void');
  assert.equal(s.account.openCost, 102145 + 100142, '持有與待進場成本皆含買進手續費');
});

test('settleFills：只補記尚未記錄的成交（買進與賣出），已記錄不重寫', () => {
  const days = mkDays();
  const D0 = days[2].date, D1 = days[10].date;
  const docs = [buyDoc(D0, '1111', 1000, 101), { date: D1, frozenAt: at(D1, '18:00'), picks: [], review: { sells: [{ code: '1111', key: lotKey(D0, '1111'), reason: 'x' }] } }];
  const ups = settleFills(docs, days);
  const u0 = ups.find(u => u.date === D0).upd, u1 = ups.find(u => u.date === D1).upd;
  assert.equal(u0['buyFills.1111'].px, 102);
  assert.equal(u1[`sellFills.${lotKey(D0, '1111')}`].px, 110);
  const again = settleFills([{ ...docs[0], buyFills: { 1111: u0['buyFills.1111'] } }, { ...docs[1], sellFills: { [lotKey(D0, '1111')]: u1[`sellFills.${lotKey(D0, '1111')}`] } }], days);
  assert.equal(again.length, 0, '已記錄的不再寫');
});

test('parseDecision：賣出只收可賣持股、買進只收池內且未持有、最多 5 檔；格式錯回 null', () => {
  const r = parseDecision('```json\n{"sells":[{"code":"1111","reason":"停損"},{"code":"9999","reason":"x"}],"picks":[{"code":"2222","confidence":70,"horizon":"20","reason":"a","risk":"b"},{"code":"1111"},{"code":"4444"}],"note":"n"}\n```',
    new Set(['1111', '2222', '4444']), new Set(['1111']), new Set(['1111', '4444']));
  assert.deepEqual(r.sells.map(s => s.code), ['1111']);
  assert.deepEqual(r.picks.map(p => p.code), ['2222'], '已持有（含待進場）不得重複買');
  assert.equal(r.rejected, 3);
  assert.deepEqual(parseDecision('{"picks":[]}', new Set(), new Set(), new Set()).sells, [], '沒給 sells＝全部續抱');
  assert.equal(parseDecision('賣掉 1111', new Set(), new Set(), new Set()), null);
});

test('快照：持有以最新收盤計市值、列 AI 賣單；結算清單附買賣時間金額與賣出理由', () => {
  const days = mkDays(20);
  const D0 = days[2].date, D1 = days[10].date;
  const docs = [buyDoc(D0, '1111', 1000, 101), buyDoc(days[5].date, '2222', 1000, 50),
    { date: D1, frozenAt: at(D1, '18:00'), picks: [], review: { sells: [{ code: '1111', key: lotKey(D0, '1111'), reason: '漲多換股' }] } }];
  const snap = portfolioSnapshot(docs, days);
  assert.equal(snap.closed.length, 1);
  assert.equal(snap.closed[0].sellReason, '漲多換股');
  assert.equal(snap.closed[0].buy.px, 102); assert.equal(snap.closed[0].sell.px, 110);
  const h = snap.holdings.find(x => x.code === '2222');
  assert.equal(h.status, '持有中'); assert.equal(h.lastPx, 50);
  assert.equal(h.cost, 50071, '買進 50,000＋手續費 71');
  assert.equal(h.estSellCost, 71 + 150, '若賣出：手續費 71＋證交稅 150');
  assert.equal(h.netValue, 49779); assert.equal(h.unrealized, 49779 - 50071, '價格沒動也要扣掉一買一賣的費稅');
  assert.equal(snap.dataDate, days[19].date);
});

test('estSellProceeds：扣手續費與證交稅 0.3%', () => {
  assert.equal(estSellProceeds(100, 1000), 100000 - 142 - 300);
});
