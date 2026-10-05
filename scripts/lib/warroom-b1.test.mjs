// 盤中戰情 v2 · B1 盤中機會榜 單元測試：node --test scripts/lib/warroom-b1.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  mergeRadar, toLongRow, limitOf, parseDtCodes, parseAvg20, fadeClockAt, snapToFadeSnaps, classifyShortRows,
  LONG_LIMIT, TIER_RANK,
} from './warroom-b1.mjs';
import {
  RADAR_STRAT_ORDER, RADAR_STRAT_DISPLAY, RADAR_STRAT_GLYPH, FADE_GLYPH, b1Phase, defaultStrat, extraColumn, isEarlySample,
  isConsensus, goldCodes, filterLong, stratCounts, isNewRow, minutesOnBoard, shortGlyphs, diffNewConsensus, consensusText, sortHits,
} from './warroom-b1-view.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = rel => readFileSync(join(ROOT, rel), 'utf8');
// 2026-10-05（週一）台北 hh:mm → epoch ms
const T = (h, m, s = 0) => Date.UTC(2026, 9, 5, h - 8, m, s);

const item = (code, over = {}) => ({
  code, name: `名${code}`, market: 'tse', price: 100, chg: 2, volX: 1.5, pos: 0.8, gap: 0.5, firstSeen: T(9, 30), ...over,
});

// ── 做多：雷達合併 ──────────────────────────────────────────────────────────

test('雷達合併去重：同檔跨策略合併成一列，命中依畫面順序；命中 ≥2 排前面，再依量比', () => {
  const doc = {
    date: '2026-10-05', updatedAt: T(10, 41),
    groups: {
      ignite: [item('3017', { volX: 2.4 }), item('2308', { volX: 1.6 })],
      volSurge: [item('3017', { volX: 2.4 }), item('3443', { volX: 3.1 })],
      breakHigh: [item('3443', { volX: 3.1 }), item('3017', { volX: 2.4 })],
      squeeze: [item('6274', { volX: 9.9 })],
    },
  };
  const r = mergeRadar(doc);
  assert.equal(r.dataDate, '2026-10-05');
  assert.equal(r.total, 4);
  assert.deepEqual(r.rows.map(x => x.code), ['3017', '3443', '6274', '2308']);
  assert.deepEqual(r.rows[0].hits, ['ignite', 'volSurge', 'breakHigh']);
  assert.deepEqual(r.rows[1].hits, ['volSurge', 'breakHigh']);
  assert.equal(isConsensus(r.rows[0]), true);
  assert.equal(isConsensus(r.rows[2]), false);
});

test('雷達合併：前 40 檔且每個策略至少保留前 5 名（策略下拉單選不會整個消失）', () => {
  const groups = {};
  // 起漲 10 檔量比很大、回踩 10 檔量比很小——若只依量比取前 40，回踩前 5 仍要在
  let n = 1000;
  for (const k of RADAR_STRAT_ORDER) {
    groups[k] = Array.from({ length: 10 }, (_, i) => item(String(n++), { volX: k === 'ma5Bounce' ? 0.1 + i / 100 : 5 - i / 10 }));
  }
  const r = mergeRadar({ date: '2026-10-05', groups });
  assert.equal(r.total, 80);
  assert.equal(r.rows.length, LONG_LIMIT);
  const counts = stratCounts(r.rows);
  for (const k of RADAR_STRAT_ORDER) assert.ok(counts[k] >= 5, `${k} 只有 ${counts[k]} 檔`);
  // 每策略前 5 名都在
  for (const k of RADAR_STRAT_ORDER) for (const it of groups[k].slice(0, 5)) assert.ok(r.rows.some(x => x.code === it.code), `${k} ${it.code}`);
});

test('雷達單筆：非 4 碼／價格無效丟棄；缺名稱給空字串、未知市場為 null（不捏造）', () => {
  assert.equal(toLongRow({ code: '00878', price: 20 }), null);
  assert.equal(toLongRow({ code: '2330', price: 0 }), null);
  assert.equal(toLongRow(null), null);
  const r = toLongRow({ code: '2330', price: 1000, chg: 1, market: 'xyz', firstSeen: 1759630000 });
  assert.equal(r.name, '');
  assert.equal(r.market, null);
  assert.equal(r.volX, null);
  assert.equal(r.firstSeen, 1759630000000);   // 秒 → 毫秒
  const bad = mergeRadar({ date: '10/05', groups: { ignite: 'oops' } });
  assert.equal(bad.dataDate, null);
  assert.deepEqual(bad.rows, []);
  assert.deepEqual(mergeRadar(null).rows, []);
});

test('漲跌停判定：依檔位向內取整；|漲跌| < 9% 不判', () => {
  assert.equal(limitOf(110, 100), 'up');
  assert.equal(limitOf(90, 100), 'down');
  assert.equal(limitOf(109.5, 100), null);
  assert.equal(limitOf(56.6, 51.5), 'up');     // 51.5×1.1＝56.65 → 檔位 0.1 向下取 56.6
  assert.equal(limitOf(105, 100), null);
  assert.equal(limitOf(0, 100), null);
});

// ── 做空：快照 → 轉空 ───────────────────────────────────────────────────────

test('當沖名單：殘缺（<500 檔）回 null；2＝僅先買後賣、其餘＝1', () => {
  assert.equal(parseDtCodes({ codesJson: JSON.stringify({ 2330: 1 }) }), null);
  assert.equal(parseDtCodes({ codesJson: '{bad' }), null);
  assert.equal(parseDtCodes(null), null);
  const raw = {};
  for (let i = 0; i < 520; i++) raw[String(1000 + i)] = i === 0 ? 2 : 1;
  const m = parseDtCodes({ codesJson: JSON.stringify(raw) });
  assert.equal(m.size, 520);
  assert.equal(m.get('1000'), 2);
  assert.equal(m.get('1001'), 1);
  assert.deepEqual(parseAvg20({ avgJson: '{"2330":30000}' }), { 2330: 30000 });
  assert.deepEqual(parseAvg20({ avgJson: 'x' }), {});
});

test('時段時鐘：用請求時間（台北）；非盤中 hm=999、frac=1', () => {
  assert.deepEqual(fadeClockAt(T(10, 0), false), { hm: 999, frac: 1 });
  const c = fadeClockAt(T(10, 0, 30), true);
  assert.equal(c.hm, 600);
  assert.ok(Math.abs(c.frac - 60 / 270) < 1e-9);
  assert.equal(fadeClockAt(T(9, 0), true).frac, 0.05);
  assert.equal(fadeClockAt(T(13, 40), true).frac, 1);
});

test('快照轉換：掃描期間只收真即時、4 碼、量比四捨五入 1 位（與 market-snapshot route 同）', () => {
  const snap = {
    marketOpen: true,
    quotes: {
      2330: { name: '台積電 ', price: 1000, change: 10, changePercent: 1, volume: 30_000_000, open: 990, high: 1005, low: 985, live: true, vwap: 998, market: 'tse' },
      2317: { name: '鴻海', price: 200, change: 1, changePercent: 0.5, volume: 1000, open: 199, high: 201, low: 198, live: false },
      '00878': { name: 'ETF', price: 20, change: 0, changePercent: 0, volume: 1, open: 20, high: 20, low: 20, live: true },
      6488: { name: '環球晶', price: 0, change: 0, live: true },
    },
  };
  const s = snapToFadeSnaps(snap, { 2330: 20000 });
  assert.deepEqual(s.map(x => x.code), ['2330']);
  assert.equal(s[0].name, '台積電');
  assert.equal(s[0].volX, 1.5);
  assert.equal(s[0].vwap, 998);
  // 收盤後（sweeping false）非即時也收
  assert.equal(snapToFadeSnaps({ ...snap, marketOpen: false, sweeping: false }, {}).length, 2);
});

// fade-patterns.ts FADE_PATTERNS 的同口徑夾具（下方漂移測試逐字比對原文，確保夾具與正式規則一致）
const PATTERNS = [
  { key: 'luVwap', tier: 'A', test: m => m.hiUp >= 9.4 && m.give >= 3 && m.aboveVwap === true },
  { key: 'luOpen', tier: 'A', test: m => m.hiUp >= 9.4 && m.give >= 3 },
  { key: 'earlyDeep', tier: 'A', test: m => m.hm < 600 && m.give >= 6 },
  { key: 'spikeVol', tier: 'B', test: m => m.hiUp >= 5 && m.give >= 4 && m.pace >= 2 },
  { key: 'spike', tier: 'C', test: m => m.hiUp >= 5 && m.give >= 4 },
];
const snapRow = (code, over = {}) => ({
  code, name: `名${code}`, price: 100, change: 0, changePercent: 0, volume: 2_000_000, volX: 3, market: 'tse',
  open: 100, high: 100, low: 99, vwap: null, ...over,
});
// 昨收 100：最高 110 漲停、現價 105（回吐 5、仍 +5%）＝漲停打開回落（A）
const luOpenRow = snapRow('3017', { price: 105, change: 5, changePercent: 5, high: 110, low: 99, open: 101 });
// 最高 +7、現價 +2（回吐 5）、量比節奏 ≥2 ＝ 沖高回落＋爆量（B）
const spikeVolRow = snapRow('2368', { price: 102, change: 2, changePercent: 2, high: 107, low: 100, open: 100.5, volX: 3 });
const dtAll1 = () => 1;

test('轉空 A／B 級：A 在前、同級依回吐大到小；C 級不列', () => {
  const spikeOnly = snapRow('2603', { price: 102, change: 2, changePercent: 2, high: 107, low: 100, open: 100.5, volX: 0.1 });
  const r = classifyShortRows([spikeVolRow, luOpenRow, spikeOnly], { hm: 630, frac: 0.33, marketOpen: true, dtStatus: dtAll1, patterns: PATTERNS });
  assert.deepEqual(r.rows.map(x => [x.code, x.tier, x.pattern]), [['3017', 'A', 'luOpen'], ['2368', 'B', 'spikeVol']]);
  assert.equal(r.total, 2);
  assert.equal(r.rows[0].give, 5);
  assert.equal(r.rows[0].hiUp, 10);
  assert.equal(r.rows[0].aboveVwap, null);
  assert.ok(r.rows[0].also.includes('spike'));
  assert.equal(r.rows[1].volX, +(3 / 0.33).toFixed(1));
  assert.equal(r.rows[1].pos, 0.29);
  assert.equal(r.noonDemote, false);
});

test('轉空：只列可先賣當沖（狀態 1）；僅先買後賣（2）與不可當沖（0）排除', () => {
  const r = classifyShortRows([luOpenRow, spikeVolRow], {
    hm: 630, frac: 0.33, marketOpen: true, patterns: PATTERNS, dtStatus: c => (c === '3017' ? 2 : 0),
  });
  assert.equal(r.rows.length, 0);
});

test('轉空：已翻黑歸「不建議放空」，除非同時是漲停打開的 A 級', () => {
  const flipped = snapRow('1513', { price: 99, change: -1, changePercent: -1, high: 106, low: 98, open: 101, volX: 5 });
  const luFlipped = snapRow('6446', { price: 99, change: -1, changePercent: -1, high: 110, low: 98, open: 101 });
  const r = classifyShortRows([flipped, luFlipped], { hm: 630, frac: 0.33, marketOpen: true, dtStatus: dtAll1, patterns: PATTERNS });
  assert.deepEqual(r.rows.map(x => x.code), ['6446']);
});

test('轉空：12:00 後成立者降級不列，計入 demoted；非盤中時間規則不套用', () => {
  const noon = classifyShortRows([luOpenRow, spikeVolRow], { hm: 725, frac: 0.68, marketOpen: true, dtStatus: dtAll1, patterns: PATTERNS });
  assert.equal(noon.rows.length, 0);
  assert.equal(noon.demoted, 2);
  assert.equal(noon.noonDemote, true);
  const after = classifyShortRows([luOpenRow], { hm: 999, frac: 1, marketOpen: false, dtStatus: dtAll1, patterns: PATTERNS });
  assert.equal(after.rows.length, 1);
  assert.equal(after.noonDemote, false);
});

test('轉空：流動性（<500 張）、昨收 ≤10、最高漲幅 <3%、ETF 一律不列', () => {
  const thin = { ...luOpenRow, code: '1111', volume: 400_000 };
  const cheap = snapRow('2222', { price: 9.5, change: 0.5, changePercent: 5.5, high: 9.9, low: 9, open: 9 });
  const flat = snapRow('3333', { price: 101, change: 1, changePercent: 1, high: 102, low: 100, open: 100 });
  const etf = { ...luOpenRow, code: '0050' };
  const r = classifyShortRows([thin, cheap, flat, etf], { hm: 630, frac: 0.33, marketOpen: true, dtStatus: dtAll1, patterns: PATTERNS });
  assert.equal(r.rows.length, 0);
});

// ── 漂移守門：本檔複寫的規則必須與原文逐字一致（原文一改，這裡紅，提醒同步 warroom-b1.mjs）──────

test('漂移守門：fade-patterns.ts 的 classifyFade／AVOID／TIER_RANK／FADE_PATTERNS 與本檔複寫一致', () => {
  const src = read('src/lib/fade-patterns.ts');
  const fragments = [
    "if (!/^\\d{4}$/.test(s.code) || s.code.startsWith('00')) continue;",
    'if (!(prev > 10) || !(s.high > 0) || !(s.price > 0)) continue;',
    'if ((s.volume || 0) / 1000 < 500) continue;',
    'const vwap = s.vwap && s.vwap > 0 ? s.vwap : null;',
    'const volX = s.volX ?? 0;',
    'hiUp: (s.high / prev - 1) * 100, give: (s.high - s.price) / prev * 100, chg: s.changePercent,',
    'openUp: s.open > 0 ? (s.open / prev - 1) * 100 : 0, openFall: s.open > 0 ? (s.open - s.price) / s.open * 100 : 0,',
    'volX, pace: volX / frac, aboveVwap: vwap ? s.price > vwap : null, hm,',
    'if (m.hiUp < 3) continue;',
    'if (dts != null && dts !== 1)',
    "if (bad && !(hits[0] && hits[0].tier === 'A' && hits[0].key.startsWith('lu')))",
    'const demote = marketOpen && hm >= 720',
    "main: demote ? { ...main, tier: 'X' } : main",
    'test: m => m.hiUp >= 3 && m.chg < 0 }',
    'test: m => m.openUp >= 2 && m.openFall >= 2 }',
    'test: m => m.hiUp >= 5 && m.give >= 4 && m.pace < 2 && m.hiUp < 9.4 }',
    `export const TIER_RANK: Record<Tier, number> = { A: ${TIER_RANK.A}, B: ${TIER_RANK.B}, C: ${TIER_RANK.C}, X: ${TIER_RANK.X} };`,
    'if (!marketOpen) return { hm: 999, frac: 1 };',
    'return { hm, frac: Math.min(1, Math.max(0.05, (hm - 540) / 270)) };',
    // 夾具 PATTERNS 與正式 FADE_PATTERNS 同規則
    "tier: 'A', oos: '樣本外淨 +1.89%／勝率 57%（n=68）', train: '訓練 +2.06%（n=196）', test: m => m.hiUp >= 9.4 && m.give >= 3 && m.aboveVwap === true },",
    "tier: 'A', oos: '樣本外淨 +0.84%／勝率 51%（n=315）', train: '訓練 +0.53%（n=796）', test: m => m.hiUp >= 9.4 && m.give >= 3 },",
    'test: m => m.hm < 600 && m.give >= 6 },',
    "tier: 'B', oos: '樣本外淨 +0.29%／勝率 54%（n=894）', train: '訓練 +0.41%（n=1,561）', test: m => m.hiUp >= 5 && m.give >= 4 && m.pace >= 2 },",
    "tier: 'C', oos: '樣本外淨 +0.04%（約損益兩平）', train: '訓練 +0.16%', test: m => m.hiUp >= 5 && m.give >= 4 },",
  ];
  for (const f of fragments) assert.ok(src.includes(f), `fade-patterns.ts 已改動：「${f}」——請同步 scripts/lib/warroom-b1.mjs（classifyShortRows／FADE_AVOID）與本測試`);
  // 每個轉空型態都要有單字圖示
  const keys = [...src.matchAll(/\{ key: '(\w+)', label: '[^']+', tier: '[ABCX]'/g)].map(m => m[1]);
  assert.deepEqual(keys, ['luVwap', 'luOpen', 'earlyDeep', 'spikeVol', 'spike']);
  for (const k of keys) assert.ok(FADE_GLYPH[k], `型態 ${k} 沒有單字圖示`);
  // AVOID 恰好三條
  assert.equal((src.match(/\{ key: '(flipped|openFall|lowPace)'/g) || []).length, 3);
});

test('漂移守門：market-snapshot route 的快照轉換與 snapToFadeSnaps 一致', () => {
  const src = read('src/app/api/twse/market-snapshot/route.ts');
  for (const f of [
    'if (!/^\\d{4}$/.test(code)) continue;',
    'if (!(Number(x.price) > 0)) continue;',
    'const sweeping = (s as { sweeping?: boolean }).sweeping ?? marketOpen;',
    'if (sweeping && !x.live) continue;',
    'const volX = a > 0 ? +(((x.volume ?? 0) / 1000) / a).toFixed(1) : null;',
    "market: x.market || 'tse', open: x.open ?? 0, high: x.high ?? 0, low: x.low ?? 0,",
    'vwap: (x as { vwap?: number }).vwap ?? null,',
  ]) assert.ok(src.includes(f), `market-snapshot route 已改動：「${f}」——請同步 scripts/lib/warroom-b1.mjs snapToFadeSnaps`);
});

test('漂移守門：雷達 8 策略鍵與 daemon RADAR_STRATEGIES 一致，且都有單字圖示', () => {
  const src = read('scripts/ai-daemon.mjs');
  const start = src.indexOf('const RADAR_STRATEGIES = {');
  assert.ok(start >= 0, 'daemon 找不到 RADAR_STRATEGIES');
  const block = src.slice(start, src.indexOf('\n};', start));
  const keys = [...block.matchAll(/^\s{2}(\w+):\s+\{ name:/gm)].map(m => m[1]);
  assert.deepEqual(keys, [...RADAR_STRAT_ORDER]);
  assert.deepEqual([...RADAR_STRAT_DISPLAY].sort(), [...RADAR_STRAT_ORDER].sort());
  for (const k of RADAR_STRAT_ORDER) assert.ok(RADAR_STRAT_GLYPH[k], k);
  // 合併後的列欄位 daemon 確實有寫
  for (const f of ['code, name: x.name || code, market: x.market || \'tse\',', 'price: +x.price.toFixed(2), chg: +chg.toFixed(2), volX: +volX.toFixed(1), pos: +pos.toFixed(2),',
    'gap: +gap.toFixed(2),', 'strategies: hits, firstSeen: _radarSeen.map[code],', 'updatedAt: Date.now(), date: today, strategies: meta, groups: JSON.parse(JSON.stringify(groups)),']) {
    assert.ok(src.includes(f), `daemon 雷達寫入欄位已改動：「${f}」`);
  }
});

// ── 畫面規則 ────────────────────────────────────────────────────────────────

test('顯示時機：盤前／清空窗／08:30 前不顯示昨天的榜；盤中資料日不是今天＝等待；盤後與休市照實', () => {
  const base = { ymd: '2026-10-05', dataDate: '2026-10-02', beforeOpen: false };
  assert.equal(b1Phase({ ...base, segment: 'pre' }), 'pre');
  assert.equal(b1Phase({ ...base, segment: 'preclear' }), 'pre');
  assert.equal(b1Phase({ ...base, segment: 'after', beforeOpen: true }), 'pre');
  assert.equal(b1Phase({ ...base, segment: 'open' }), 'waiting');
  assert.equal(b1Phase({ ...base, segment: 'mid', dataDate: null }), 'waiting');
  assert.equal(b1Phase({ ...base, segment: 'mid', dataDate: '2026-10-05' }), 'show');
  assert.equal(b1Phase({ ...base, segment: 'after' }), 'show');
  assert.equal(b1Phase({ ...base, segment: 'nontrading' }), 'show');
});

test('時段：開盤段預選開盤強勢＋缺口欄、尾盤段尾盤位置欄；09:10 前樣本少', () => {
  assert.equal(defaultStrat('open'), 'openStrong');
  assert.equal(defaultStrat('mid'), 'all');
  assert.equal(extraColumn('open'), 'gap');
  assert.equal(extraColumn('tail'), 'tp');
  assert.equal(extraColumn('mid'), null);
  assert.equal(isEarlySample('open', 9 * 60 + 9.9), true);
  assert.equal(isEarlySample('open', 9 * 60 + 10), false);
  assert.equal(isEarlySample('mid', 9 * 60 + 5), false);
});

test('共識、金框前 3、篩選與計數', () => {
  const rows = [
    { code: 'A', hits: ['ignite', 'volSurge'] }, { code: 'B', hits: ['ignite'] }, { code: 'C', hits: ['breakHigh', 'squeeze'] },
    { code: 'D', hits: ['ignite', 'squeeze'] }, { code: 'E', hits: ['volSurge', 'squeeze'] },
  ];
  assert.deepEqual(goldCodes(rows), ['A', 'C', 'D']);
  assert.deepEqual(filterLong(rows, { strat: 'squeeze' }).map(r => r.code), ['C', 'D', 'E']);
  assert.deepEqual(filterLong(rows, { strat: 'ignite', consensusOnly: true }).map(r => r.code), ['A', 'D']);
  assert.deepEqual(filterLong(rows).map(r => r.code), ['A', 'B', 'C', 'D', 'E']);
  const c = stratCounts(rows);
  assert.equal(c.ignite, 3);
  assert.equal(c.squeeze, 3);
  assert.equal(c.ma5Bounce, 0);
  assert.deepEqual(sortHits(['squeeze', 'breakHigh', 'nope', 'ignite']), ['ignite', 'breakHigh', 'squeeze']);
});

test('NEW 3 分鐘、上榜分鐘數、做空圖示去重', () => {
  const now = T(10, 42);
  assert.equal(isNewRow(now - 179_000, now), true);
  assert.equal(isNewRow(now - 180_000, now), false);
  assert.equal(isNewRow(now + 20_000, now), true);
  assert.equal(isNewRow(null, now), false);
  assert.equal(minutesOnBoard(T(10, 30), T(10, 42)), 12);
  assert.equal(minutesOnBoard(null, T(10, 42)), null);
  assert.deepEqual(shortGlyphs({ pattern: 'luVwap', also: ['luOpen', 'spikeVol', 'spike'] }), ['板', '爆', '落']);
  assert.deepEqual(shortGlyphs({ pattern: 'unknown' }), []);
});

test('新進共識差分：當日第一份只建基準；之後新出現的才算，同一份資料不重算、當日不重複', () => {
  const ctx = { ymd: '2026-10-05', dataDate: '2026-10-05' };
  const r1 = [{ code: '3017', name: '奇鋐', hits: ['ignite', 'volSurge'] }, { code: '2308', name: '台達電', hits: ['ma5Bounce'] }];
  const a = diffNewConsensus(null, r1, { ...ctx, asOf: 1 });
  assert.deepEqual(a.fresh, []);
  assert.deepEqual(a.state.codes, ['3017']);
  const r2 = [...r1, { code: '3037', name: '欣興', hits: ['volSurge', 'ignite'] }];
  const b = diffNewConsensus(a.state, r2, { ...ctx, asOf: 2 });
  assert.deepEqual(b.fresh.map(r => r.code), ['3037']);
  assert.equal(consensusText(b.fresh[0]), '3037 欣興 新進 ★（起漲＋爆量）');
  assert.deepEqual(diffNewConsensus(b.state, r2, { ...ctx, asOf: 2 }).fresh, []);
  assert.deepEqual(diffNewConsensus(b.state, r2, { ...ctx, asOf: 3 }).fresh, []);
  // 資料日不是今天（盤前看到昨天的榜）不算
  const c = diffNewConsensus(null, r2, { ymd: '2026-10-06', dataDate: '2026-10-05', asOf: 4 });
  assert.equal(c.state, null);
  assert.deepEqual(c.fresh, []);
  // 換日重建基準
  const d = diffNewConsensus(b.state, r2, { ymd: '2026-10-06', dataDate: '2026-10-06', asOf: 5 });
  assert.deepEqual(d.fresh, []);
  assert.equal(d.state.ymd, '2026-10-06');
});
