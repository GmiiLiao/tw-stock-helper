// 漲跌停價單元測試：node --test scripts/lib/tw-limit-price.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limitUpPrice, limitDownPrice, isLimitUpAt, stockTick } from './tw-limit-price.mjs';

// 整數（分）運算的獨立 oracle：不經浮點、逐檔搜尋合法價位
const tickC = x => (x < 1000 ? 1 : x < 5000 ? 5 : x < 10000 ? 10 : x < 50000 ? 50 : x < 100000 ? 100 : 500);
const oracleUp = P => { for (let x = Math.floor(P * 11 / 10); ; x--) if (x % tickC(x) === 0 && x * 10 <= P * 11) return x / 100; };
const oracleDn = P => { for (let x = Math.ceil(P * 9 / 10); ; x++) if (x % tickC(x) === 0 && x * 10 >= P * 9) return x / 100; };

test('實際鎖停案例（chipArchive 收盤＝最高＝漲停價）', () => {
  for (const [pc, lim] of [[457, 502], [477, 524], [918, 1005], [951, 1045], [495, 544], [45.5, 50], [48.25, 53], [91.8, 100.5], [95.7, 105]]) {
    assert.equal(limitUpPrice(pc), lim, `前收 ${pc}`);
    assert.ok(isLimitUpAt(lim, pc));
  }
});

test('前收 9.09–10 也屬不同級距（10.043 → 10.00，不是 10.04）', () => {
  assert.equal(limitUpPrice(9.13), 10);
  assert.equal(limitUpPrice(9.5), 10.45);
});

test('全價位掃描（0.01～2000 每個合法前收）與整數 oracle 完全一致', () => {
  let n = 0;
  for (let P = 1; P <= 200000; P += tickC(P)) {
    const pc = P / 100;
    assert.equal(limitUpPrice(pc), oracleUp(P), `漲停 前收 ${pc}`);
    assert.equal(limitDownPrice(pc), oracleDn(P), `跌停 前收 ${pc}`);
    n++;
  }
  assert.ok(n > 3500);
});

test('漲停價本身落在合法檔位，且再加一檔即超過 10%', () => {
  for (const pc of [9.1, 45.5, 92.4, 455, 909, 1200]) {
    const u = limitUpPrice(pc), t = stockTick(u);
    assert.ok(Math.abs(u / t - Math.round(u / t)) < 1e-9);
    assert.ok(u + t > pc * 1.1);
  }
});

test('低一檔不算漲停；無效輸入回 false', () => {
  assert.equal(isLimitUpAt(501, 457), false);
  assert.equal(isLimitUpAt(502, 0), false);
  assert.equal(isLimitUpAt(0, 457), false);
});

// ── 2026-10-09 口徑統一：ETF、佔位、舊口徑對照、與既有正確實作逐檔一致 ──
import { etfTick, tickOf, legacyLimitUpPriceV1, isLimitUpByRule, isNoLimitPlaceholder, effectiveLimitUp, TW_LIMIT_RULE_VERSION } from './tw-limit-price.mjs';
import { limitPrices as dtLimitPrices } from './daytrade-signals.mjs';
import { limitPrices as stopLimitPrices } from './ai-stoploss-base.mjs';
import { limitsFromRef as heatLimits } from './daily-heatmap/compute.mjs';

const etfTickC = x => (x < 5000 ? 1 : 5);
const oracleUpEtf = P => { for (let x = Math.floor(P * 11 / 10); ; x--) if (x % etfTickC(x) === 0 && x * 10 <= P * 11) return x / 100; };
const oracleDnEtf = P => { for (let x = Math.ceil(P * 9 / 10); ; x++) if (x % etfTickC(x) === 0 && x * 10 >= P * 9) return x / 100; };

test('口徑版本＝2', () => assert.equal(TW_LIMIT_RULE_VERSION, 2));

test('各級距邊界（前收落在邊界下方、漲停價跨進上一級距）', () => {
  // [前收, 交易所漲停, 舊式 v1 漲停]
  for (const [pc, up, v1] of [
    [9.09, 9.99, 9.99], [9.1, 10, 10.01], [9.99, 10.95, 10.98],
    [45.45, 49.95, 49.95], [45.5, 50, 50.05], [49.95, 54.9, 54.9],
    [90.9, 99.9, 99.9], [91, 100, 100.1], [99.9, 109.5, 109.8],
    [454.5, 499.5, 499.5], [455, 500, 500.5], [499.5, 549, 549],
    [909, 999, 999], [910, 1000, 1001], [999, 1095, 1098],
  ]) {
    assert.equal(limitUpPrice(pc), up, `交易所 前收 ${pc}`);
    assert.equal(legacyLimitUpPriceV1(pc), v1, `舊式 前收 ${pc}`);
    assert.ok(legacyLimitUpPriceV1(pc) >= limitUpPrice(pc), '舊式恆不低於交易所口徑（改口徑只會多判漲停）');
  }
  // 跌停跨下一級距：前收 11.11 → 9.999 → 10.00（向上進位用 9.999 所在級距 0.01 ⇒ 10.00）
  assert.equal(limitDownPrice(11.11), 10);
  assert.equal(limitDownPrice(55.6), 50.1);   // 50.04 在 ≥50 級距（0.1）⇒ 進位到 50.1
  assert.equal(limitDownPrice(1111), 1000);
});

test('ETF 檔位表（<50 0.01、≥50 0.05）全價位與整數 oracle 一致', () => {
  for (let P = 1; P <= 50000; P += (P < 5000 ? 1 : 5)) {
    assert.equal(limitUpPrice(P / 100, true), oracleUpEtf(P), `ETF 漲停 ${P / 100}`);
    assert.equal(limitDownPrice(P / 100, true), oracleDnEtf(P), `ETF 跌停 ${P / 100}`);
  }
  assert.equal(etfTick(49.99), 0.01); assert.equal(etfTick(50), 0.05);
  assert.equal(tickOf(103.55, true), 0.05); assert.equal(tickOf(103.55), 0.5);
  // 00632R 實例（src/lib/stock-readings.ts 註解）：昨收 20.13 ⇒ ETF 漲停 22.14；個股檔位會算成 22.10
  assert.equal(limitUpPrice(20.13, true), 22.14);
  assert.equal(limitUpPrice(20.13), 22.1);
  assert.equal(isLimitUpAt(22.1, 20.13, true), false);
  assert.equal(isLimitUpAt(22.14, 20.13, true), true);
});

test('9995／9999.95 無漲跌幅佔位', () => {
  assert.equal(isNoLimitPlaceholder(9995, 0.01), true);
  assert.equal(isNoLimitPlaceholder(9999.95, 0.01), true);
  assert.equal(isNoLimitPlaceholder(9995), true, '只有漲停欄時單憑 9995 判定');
  assert.equal(isNoLimitPlaceholder(9995, 8180), false, '前收 9,090 的真漲停價也是 9995——跌停欄不是 0.01 就不是佔位');
  assert.equal(limitUpPrice(9090), 9995);
  assert.equal(isNoLimitPlaceholder(502, 412), false);
  assert.equal(effectiveLimitUp({ prevClose: 100, officialUp: 9995, officialDown: 0.01 }), null);
  assert.equal(effectiveLimitUp({ prevClose: 9090, officialUp: 9995, officialDown: 8185 }), 9995);
  assert.equal(effectiveLimitUp({ prevClose: 457, officialUp: 502 }), 502);
  assert.equal(effectiveLimitUp({ prevClose: 457 }), 502, '沒有官方值才推算');
  assert.equal(effectiveLimitUp({ prevClose: 20.13, isEtf: true }), 22.14);
});

test('isLimitUpByRule：1＝舊式（重現舊結果）、2＝交易所口徑', () => {
  assert.equal(isLimitUpByRule(1, 502, 457), false);
  assert.equal(isLimitUpByRule(2, 502, 457), true);
  assert.equal(isLimitUpByRule(1, 502.5, 457), true);
});

test('無效參考價回 NaN（不捏造）', () => {
  assert.ok(Number.isNaN(limitUpPrice(0)));
  assert.ok(Number.isNaN(limitDownPrice(-1)));
  assert.ok(Number.isNaN(legacyLimitUpPriceV1(null)));
});

test('與既有正確實作（daytrade-signals／ai-stoploss-base／daily-heatmap）全價位逐檔一致', () => {
  for (let P = 1; P <= 200000; P += tickC(P)) {
    const pc = P / 100, up = limitUpPrice(pc), dn = limitDownPrice(pc);
    const a = dtLimitPrices(pc), b = stopLimitPrices(pc), c = heatLimits(pc);
    assert.equal(a.up, up, `daytrade 漲停 ${pc}`); assert.equal(a.down, dn, `daytrade 跌停 ${pc}`);
    assert.equal(b.up, up, `stoploss 漲停 ${pc}`); assert.equal(b.down, dn, `stoploss 跌停 ${pc}`);
    assert.equal(c.up, up, `heatmap 漲停 ${pc}`); assert.equal(c.down, dn, `heatmap 跌停 ${pc}`);
  }
  for (let P = 1; P <= 50000; P += (P < 5000 ? 1 : 5)) {
    const b = stopLimitPrices(P / 100, true);
    assert.equal(b.up, limitUpPrice(P / 100, true), `stoploss ETF 漲停 ${P / 100}`);
    assert.equal(b.down, limitDownPrice(P / 100, true), `stoploss ETF 跌停 ${P / 100}`);
  }
});
