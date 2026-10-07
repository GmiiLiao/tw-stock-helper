// AI 停損規範 stop-v1.1·文字（事實句、來源標籤、紀律彙總、九處推播文字、LLM 停損文字）單元測試：
//   node --test scripts/lib/ai-stoploss-text.test.mjs
// 編號對應實作計畫 warroom/stoploss/v1.1/impl-plan.md §5（I、E8、O、H）；文字依據 references/wording.md、llm-contract.md。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import {
  STOP_FACT_KINDS, stopFactText, stopSourceLabel, scanForbidden, FORBIDDEN_WORDS, PLUNGE_TAIL_KEPT,
  disciplineTailCount, disciplineDigest, stopTouchPushText, stopPushTextS2b, trailPushTextS2b, disciplinePushTextS2b,
  defenseListText, defensePushText, plungePushText, watchDropPushText, watchDropSummaryText, overnightOpenPushText,
  STOP_PROMPT_RULE, stopPromptLines, hypotheticalStop, hypotheticalStopLine, parseStopRef, stripStopRef, extractStopPrices,
  validateLlmStopText, pnlClauseText,
} from './ai-stoploss.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const T = (h, m) => Date.UTC(2026, 9, 5, h - 8, m);

// ── I：事實句與來源標籤 ──────────────────────────────────────────────────────

const FULL = {
  stop: 47.35, low: 46.9, price: 47.8, open: 45.4, skipPct: 4.1, at: T(10, 42), basisText: '成本線·還原成本 51.47 −8%',
  distPct: 0.9, atrMultiple: 0.4, bandToday: 45.2, source: 'ATR 帶', pnlPct: -3.2,
  items: [{ code: '2330', name: '台積電', n: 3, close: 46.1, stop: 47.35, source: 'ATR 帶', p0: 46.9, diff: -800 }],
  date: '2026-07-15', factor: 0.962, from: 49.2, to: 47.35, costTo: 49.51, label: '除息', coverFrom: '2022-07-01', ratio: 0.03,
  line: 105, hwm: 114.1, gainPct: 6.2, minutes: 6, codes: ['2330 台積電'], hasBook: false, baseStop: 45.2, baseSource: 'ATR 帶',
  effectiveFrom: '2026-10-05', dataDate: '2026-10-02', withBand: true,
};

test('I53′ 每種事實句都非空、不含任何禁用詞；digest 本身不含紀律保留句（尾句只由 disciplineDigest 加）', () => {
  for (const kind of STOP_FACT_KINDS) {
    const s = stopFactText(kind, FULL);
    assert.ok(s.length > 0, kind);
    assert.deepEqual(scanForbidden(s), [], `${kind}：${s}`);
  }
  assert.equal(disciplineTailCount(stopFactText('digest', FULL)), 0);
  assert.ok(FORBIDDEN_WORDS.includes('未處理'));
});

test('I55 觸及類四種句子都帶來源標籤、結尾是「·持有{仍獲利 +x%｜損益 −x%}（未含費稅）」（wording.md §1 範例逐字）', () => {
  assert.equal(stopFactText('touch', { low: 105.5, stop: 106, at: T(10, 42), price: 106.5, source: 'ATR 帶', pnlPct: 6.2 }),
    '今日最低 105.5 觸及停損 106.0（ATR 帶·10:42 揭示）·現價 106.5·持有仍獲利 +6.2%（未含費稅）');
  const etf = { isEtf: true };
  assert.equal(stopFactText('touch', { ...etf, low: 51.9, stop: 52.35, at: T(10, 42), price: 52.8, source: '成本線', pnlPct: -8.1 }),
    '今日最低 51.90 觸及停損 52.35（成本線·10:42 揭示）·現價 52.80·持有損益 −8.1%（未含費稅）');
  assert.equal(stopFactText('gap', { ...etf, open: 50.4, stop: 52.35, skipPct: 3.7, source: 'ATR 帶', pnlPct: -11.4 }),
    '開盤 50.40，已低於停損 52.35（ATR 帶，差 3.7%）·持有損益 −11.4%（未含費稅）');
  assert.equal(stopFactText('closeTouch', { ...etf, low: 52.1, stop: 52.35, source: 'ATR 帶', pnlPct: -7.9 }),
    '收盤時判定：今日最低 52.10 低於停損 52.35（ATR 帶）·持有損益 −7.9%（未含費稅）');
  assert.equal(stopFactText('lateTouch', { ...etf, low: 52.1, stop: 52.35, source: 'ATR 帶', pnlPct: -7.9 }),
    '收盤後補判：今日最低 52.10 低於停損 52.35（ATR 帶·盤中未即時判到）·持有損益 −7.9%（未含費稅）');
  assert.equal(pnlClauseText(0), '持有損益 0.0%（未含費稅）');
  assert.equal(pnlClauseText(0.04), '持有損益 0.0%（未含費稅）');
  assert.equal(pnlClauseText(0.05), '持有仍獲利 +0.1%（未含費稅）');
  // v1 呼叫（不帶來源與損益）字樣不變——戰情 v2 前端在用
  assert.equal(stopFactText('touch', { low: 46.9, stop: 47.35, at: T(10, 42), price: 47.8 }), '今日最低 46.90 觸及停損 47.35（10:42 揭示）·現價 47.80');
});

test('I56 來源標籤唯一格式；全庫只有 stopSourceLabel 組「保本線·持有期最高收盤曾達」「事件收緊·」兩種字串', () => {
  assert.deepEqual(['cost', 'atrBand', 'breakeven', 'trail'].map(s => stopSourceLabel(s)), ['成本線', 'ATR 帶', '保本線', '追蹤線']);
  assert.equal(stopSourceLabel('event', { effectiveFrom: '2026-10-05', label: '法律事件' }), '事件收緊·10/05 法律事件');
  assert.equal(stopSourceLabel('event', { form: 'row', effectiveFrom: '2026-10-05', expiresAfter: '2026-10-12', label: '法律事件' }), '事件收緊·10/05 法律事件·至 10/12');
  assert.equal(stopSourceLabel('breakeven', { form: 'row', holdHighPct: 10.4 }), '保本線·持有期最高收盤曾達 +10.4%·未含費稅；淨額約 −0.38%');
  assert.equal(stopSourceLabel('trail', { form: 'row', holdHigh: 131, fresh: true }), '追蹤線·持有期最高收盤 131.0 −3 ATR');
  assert.equal(stopSourceLabel('trail', { form: 'row', sourceDate: '2026-10-01' }), '追蹤線·10/01 設定·只升不降');
  assert.equal(stopSourceLabel('cost', { form: 'row', adjCost: 56.9 }), '成本線·還原成本 56.90 −8%');
  assert.equal(stopSourceLabel('nope'), '');
  const files = [];
  const walk = d => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { if (!/node_modules|\.surge-cache|surge-lab|second-brain/.test(n)) walk(p); }
      else if (/\.(mjs|ts|tsx)$/.test(n) && !/\.test\.mjs$|\.d\.mts$/.test(n)) files.push(p);
    }
  };
  walk(join(ROOT, 'scripts', 'lib')); walk(join(ROOT, 'src'));
  const offenders = files.filter(f => {
    const t = readFileSync(f, 'utf8');
    return /保本線·持有期最高收盤曾達|事件收緊·/.test(t) && !f.endsWith('ai-stoploss-base.mjs');
  }).map(f => relative(ROOT, f));
  assert.deepEqual(offenders, []);
});

// ── E8：紀律彙總 ─────────────────────────────────────────────────────────────

test('E8 紀律彙總：兩檔 ⇒ 一則；結尾恰好一次保留句；差額＝(前一交易日收盤 − 觸及價)×張×1000 帶正負號一律寫出；N 是交易日', () => {
  const s = disciplineDigest([
    { code: '2330', name: '台積電', n: 3, prevClose: 50.1, stop: 52.4, stopSource: 'atrBand', triggerPx: 51.9, qty: 1 },
    { code: '2317', name: '鴻海', n: 2, prevClose: 47.2, stop: 47.35, stopSource: 'cost', triggerPx: 47, qty: 2.5 },
  ]);
  assert.equal(s, '⛔ 停損後收盤仍在停損下：2330 台積電 事件第 3 個交易日（前一交易日收盤 50.1／停損 52.4·ATR 帶；觸及時 51.9，與前一交易日收盤差額約 −1,800 元）、'
    + '2317 鴻海 事件第 2 個交易日（前一交易日收盤 47.20／停損 47.35·成本線；觸及時 47.00，與前一交易日收盤差額約 +500 元） — 請面對決策：停損或明確寫下續抱理由');
  assert.equal(disciplineTailCount(s), 1);
  assert.deepEqual(scanForbidden(s, { allowDisciplineTail: true }), []);
  assert.ok(scanForbidden(s).length > 0, '不給豁免時會抓到保留句');
  assert.equal(disciplineDigest([]), null);
});

test('保留句只出現在兩處：disciplineDigest（ai-stoploss-text.mjs）與 daemon 舊紀律分支（S2b 文字）', () => {
  const where = [];
  const scan = p => { if (readFileSync(p, 'utf8').includes('請面對決策：停損或明確寫下續抱理由')) where.push(relative(ROOT, p)); };
  for (const n of readdirSync(join(ROOT, 'scripts', 'lib'))) if (/\.mjs$/.test(n) && !/\.test\.mjs$|\.d\.mts$/.test(n)) scan(join(ROOT, 'scripts', 'lib', n));
  scan(join(ROOT, 'scripts', 'ai-daemon.mjs'));
  assert.ok(where.includes('scripts/lib/ai-stoploss-text.mjs'));
  for (const f of where) assert.ok(['scripts/ai-daemon.mjs', 'scripts/lib/ai-stoploss-text.mjs'].includes(f), f);
  const daemon = readFileSync(join(ROOT, 'scripts', 'ai-daemon.mjs'), 'utf8');
  assert.ok(disciplineTailCount(daemon) <= 1, 'daemon 最多只有舊紀律分支一處（S2b 改用 disciplinePushTextS2b 後為 0）');
});

// ── O：九處推播文字（第 9 項核可版；S2b） ───────────────────────────────────

test('O1 #1 停損推播 S2b：只描述事實、寫出停損價（第 15 項：個人推播不隱藏）；O2 S5 一級四種都含來源與損益正負', () => {
  const s = stopPushTextS2b({ code: '2317', name: '鴻海', price: 91.5, stop: 92, legacySource: 'ai', pnlPct: -8.53 });
  assert.equal(s, '⛔ 2317 鴻海 現價 91.5 已低於停損 92（AI 停損）·持有損益 -8.5%（未含費稅）');
  assert.deepEqual(scanForbidden(s), []);
  assert.ok(stopPushTextS2b({ code: '2317', name: '鴻海', price: 91, stop: 92, legacySource: 'cost', pnlPct: -9 }).includes('（成本 −8%）'));
  const base = { code: '2330', name: '台積電', stop: 106, sourceLabel: 'ATR 帶', price: 106.5, at: T(10, 42) };
  const kinds = { touch: 105.5, gap: 104, close: 105.5, late: 105.5 };
  for (const [kind, px] of Object.entries(kinds)) {
    for (const pnl of [6.2, -3.1]) {
      const t = stopTouchPushText({ ...base, pnlPct: pnl, touch: { kind, triggerPx: px, skipPct: kind === 'gap' ? 1.89 : null, facts: kind === 'gap' ? ['今日在跌停價 95.5 有成交'] : [] } });
      assert.ok(t.startsWith('⛔ 2330 台積電 '), t);
      assert.ok(t.includes('ATR 帶'), t);
      assert.ok(t.includes(pnl > 0 ? '·持有仍獲利 +6.2%（未含費稅）' : '·持有損益 −3.1%（未含費稅）'), t);
      assert.deepEqual(scanForbidden(t), [], t);
    }
  }
});

test('O3 #2 獲利回落線 S2b：不含建議／鎖利／盤中高點／持有期最高；寫明 daemon 快照高點、重啟後重新起算', () => {
  const s = trailPushTextS2b({ code: '2330', name: '台積電', price: 105, line: 105.03, hwm: 114.16, pnlPct: 6.2 });
  assert.equal(s, '📈 2330 台積電 現價 105 跌破獲利回落線 105.03（daemon 記錄的快照高點 114.16 −8%；重啟後重新起算）·持有仍獲利 +6.2%');
  for (const w of ['建議', '鎖利', '盤中高點', '持有期最高']) assert.ok(!s.includes(w), w);
  assert.deepEqual(scanForbidden(s), []);
});

test('O4 #3 停損紀律 S2b：不含「未處理」「可少虧」；逐字含保留句一次；差額＝(現價 − p0)×張×1000，高於或低於都寫', () => {
  const lo = disciplinePushTextS2b({ code: '2330', name: '台積電', stopPrice: 52.4, days: 3, price: 50.1, lossPct: -12.06, p0: 51.9, qty: 1 });
  assert.equal(lo, '⛔ 2330 台積電 停損 52.4 觸發後第 3 天，持股紀錄仍在（現價 50.1，-12.1%；觸及時 51.9，現價與觸及時差額約 -1,800 元）— 請面對決策：停損或明確寫下續抱理由');
  const hi = disciplinePushTextS2b({ code: '2330', name: '台積電', stopPrice: 52.4, days: 2, price: 52.2, lossPct: -8, p0: 51.9, qty: 2 });
  assert.ok(hi.includes('差額約 +600 元'));
  for (const s of [lo, hi]) {
    assert.ok(!s.includes('未處理') && !s.includes('可少虧'));
    assert.equal(disciplineTailCount(s), 1);
    assert.deepEqual(scanForbidden(s, { allowDisciplineTail: true }), []);
  }
});

test('O5 #4／#5 崩盤防禦：不含建議／優先決策／執行停損／掛好停損單／請；#4 S2b 寫「ATR 帶與成本 −8% 取高」、不得寫「與停損推播同口徑」', () => {
  const s2b = defenseListText({ red: 1, amber: 2, green: 3 });
  assert.equal(s2b, '🔴 距停損 ≤3%：1 檔；🟡 3–8%：2 檔；🟢 >8%：3 檔（停損＝ATR 帶與成本 −8% 取高，與停損紀律同口徑）');
  assert.ok(!s2b.includes('與停損推播同口徑'));
  assert.ok(defenseListText({ red: 0, amber: 0, green: 1, phase: 's5' }).endsWith('（停損依系統規範 stop-v1.1）'));
  const push = defensePushText({ median: -3.21, n: 5, m: 2 });
  assert.equal(push, '🛡 大盤急跌（跌幅中位 -3.2%）：持股 5 檔，距停損 ≤3% 者 2 檔（防禦清單在投組頁）');
  for (const s of [s2b, push]) for (const w of ['建議', '優先決策', '執行停損', '掛好停損單', '請']) assert.ok(!s.includes(w), `${w}：${s}`);
});

test('O6 #6–#8 公共訊息：不含確認停損／請、不帶個人停損價；#6 依 A6 裁定逐字保留「隔日沖偏多策略暫停追價。」', () => {
  const p = plungePushText({ pct: -1.234, from: 23456.7, to: 23167.2 });
  assert.equal(p, '加權指數 10 分鐘內回落 -1.23%（23,457 → 23,167）。隔日沖偏多策略暫停追價。');
  assert.ok(p.endsWith(PLUNGE_TAIL_KEPT));
  assert.ok(!p.includes('持股請確認停損價位'));
  const w = watchDropPushText({ name: '台積電', code: '2330', mv: -2.345, price: 1020, chg: -3.1 });
  assert.equal(w, '台積電(2330) 5分鐘急跌 -2.3%（現價 1020，今日 -3.1%）。自選／持股池標的。');
  const ws = watchDropSummaryText({ name: '台積電', code: '2330', mv: -2.345, price: 1020 });
  assert.equal(ws, '🔻 台積電(2330) 5分鐘 -2.3%（1020）');
  for (const s of [p, w, ws]) { assert.ok(!s.includes('確認停損') && !s.includes('請'), s); assert.deepEqual(scanForbidden(s), []); }
});

test('O7 #9 隔日沖開盤提醒：以「⏰ 若為隔日沖計畫」開頭；不含認賠／不留倉／鐵律／建議／請；「出場」只出現在「出場時點」', () => {
  const s = overnightOpenPushText({ list: '2330 台積電、2317 鴻海' });
  assert.ok(s.startsWith('⏰ 若為隔日沖計畫'));
  for (const w of ['認賠', '不留倉', '鐵律', '建議', '請']) assert.ok(!s.includes(w), w);
  assert.deepEqual(scanForbidden(s, { allowExitTiming: true }), []);
  assert.deepEqual(scanForbidden(s), ['出場'], '不給 #9 豁免時「出場」會被抓到');
  assert.equal(s.split('出場').length - 1, s.split('出場時點').length - 1);
});

// ── H：LLM 停損文字（llm-contract） ─────────────────────────────────────────

const RES = { stop: 52.4, stopSource: 'atrBand', sourceDate: '2026-10-02', adjCost: 56.9, holdHigh: null, lines: { bandLine: 49.8 } };

test('H52′ 提示詞：只給生效停損與來源標籤、不出現 ATR 帶當日值與「結構參考價」；事件收緊多一行；附規則句', () => {
  const lines = stopPromptLines(RES);
  assert.deepEqual(lines, ['停損（系統規範 stop-v1.1·ATR 帶·10/02 收盤設定·只升不降）：52.4', STOP_PROMPT_RULE]);
  assert.ok(!lines.join('\n').includes('49.8') && !lines.join('\n').includes('結構參考價'));
  const ev = { effectiveFrom: '2026-10-05', expiresAfter: '2026-10-12', label: '法律事件' };
  const withEv = stopPromptLines({ ...RES, stop: 98, stopSource: 'event' }, { event: ev, exAdjusted: true });
  assert.equal(withEv[0], '停損（系統規範 stop-v1.1·事件收緊·10/05 法律事件，至 10/12·只升不降）：98.0');
  assert.equal(withEv[1], '（因 10/05 法律事件 暫時收緊，至 10/12）');
  assert.equal(withEv[2], '（已依除權息／減資調整）');
  assert.equal(stopPromptLines({ ...RES, stopSource: 'cost' })[0], '停損（系統規範 stop-v1.1·成本線·還原成本 56.90 −8%·只升不降）：52.4');
  assert.equal(stopPromptLines({ ...RES, stopSource: 'breakeven', stop: 57, holdHigh: { price: 62.6 } })[0], '停損（系統規範 stop-v1.1·保本線·持有期最高收盤曾達 +10.0%·只升不降）：57.0');
  assert.equal(stopPromptLines(null)[0], '停損：成本資料缺，不提供停損數字');
});

test('H54 未持有的系統停損：band < B ⇒ max(ceilTick(B×0.92), band)；band ≥ B 或缺 ⇒ ceilTick(B×0.92)；B 缺 ⇒ 不給數字', () => {
  assert.equal(hypotheticalStop(60, 57.3), 57.3);
  assert.equal(hypotheticalStop(60, 50), 55.2);
  assert.equal(hypotheticalStop(60, 61), 55.2);
  assert.equal(hypotheticalStop(60, null), 55.2);
  assert.equal(hypotheticalStopLine(60, 57.3), '若以標準買點 60.0 進場，系統停損＝57.3（成本 −8% 與 ATR 帶取高）');
  assert.equal(hypotheticalStopLine(null, 57.3), '停損：未持有，依進場價 −8% 與 ATR 帶取高計');
});

test('H49–H51 STOP_REF：解析（全形冒號、逗號）；剝除整行與行中間出現的情況；剝除後才跑 parseRationale', () => {
  assert.equal(parseStopRef('ACTION: 續抱\nSTOP_REF: 52.35'), 52.35);
  assert.equal(parseStopRef('STOP_REF：1,050'), 1050);
  assert.equal(parseStopRef('沒有'), null);
  assert.equal(stripStopRef('分析: 基本面穩\nSTOP_REF: 52.35\n'), '分析: 基本面穩');
  assert.equal(stripStopRef('分析: 基本面穩 STOP_REF：52.35'), '分析: 基本面穩');
  assert.equal(stripStopRef('分析: 一\n波段建議: 二'), '分析: 一\n波段建議: 二');
});

test('extractStopPrices：只擷取停損語境；排除後接日／%／MA／線等、−8%、參考價 0.5～1.5 倍以外（llm-contract §5.3）', () => {
  const ref = { refPrice: 55 };
  assert.deepEqual(extractStopPrices('若跌破 20 日均線則減碼', ref), []);
  assert.deepEqual(extractStopPrices('TRIGGER: 跌破季線(60MA)出脫', ref), []);
  assert.deepEqual(extractStopPrices('停損設在近 10 日低點下方', ref), []);
  assert.deepEqual(extractStopPrices('停損 −8%', ref), []);
  assert.deepEqual(extractStopPrices('跌破月線 48.5 減碼', ref), []);
  assert.deepEqual(extractStopPrices('停損 5', ref), []);
  assert.deepEqual(extractStopPrices('跌破 52.35 停損；站上 61 加碼', ref).map(x => x.value), [52.35]);
  assert.deepEqual(extractStopPrices('停損 <49.8>', ref).map(x => x.value), [49.8]);
});

test('extractStopPrices 子句口徑（2026-10-07 線上查核：目標價、評分被當成停損價的誤報）：只取有停損語境的子句；同子句以「目標／評分」起頭的數字不算', () => {
  // 線上日誌原句（系統停損 6086.35，AI 寫對了；舊版記 1 筆數字不一致＋2 筆高於現價）
  assert.deepEqual(extractStopPrices('目標價為 6546.17、6730.1、7006，停損設於 6086.35', { refPrice: 6400 }).map(x => x.value), [6086.35]);
  assert.deepEqual(extractStopPrices('目標價區間涵蓋 50.55 至 53.45，建議的停損點位為 47.65', { refPrice: 50 }).map(x => x.value), [47.65]);
  assert.deepEqual(extractStopPrices('AI技術評分為66.38(B+)，停損 47.65', { refPrice: 50 }).map(x => x.value), [47.65]);
  assert.deepEqual(extractStopPrices('停損 47.65（AI評分 66.38）', { refPrice: 50 }).map(x => x.value), [47.65]);
  assert.deepEqual(extractStopPrices('停損 47.65、目標 50.55 至 53.45', { refPrice: 50 }).map(x => x.value), [47.65]);
  assert.deepEqual(extractStopPrices('停損設於 47.65，若站上 53 則加碼', { refPrice: 50 }).map(x => x.value), [47.65]);
  // 召回不變：「跌破 X，停損」型（同一句有停損）、跌破在停損之前、千分位
  assert.deepEqual(extractStopPrices('若跌破 47.65，應停損出場', { refPrice: 50 }).map(x => x.value), [47.65]);
  assert.deepEqual(extractStopPrices('TRIGGER: 跌破 98 停損', { refPrice: 100 }).map(x => x.value), [98]);
  assert.deepEqual(extractStopPrices('停損價 1,234.5，目標 1,400', { refPrice: 1300 }).map(x => x.value), [1234.5]);
  const s = extractStopPrices('目標價為 70，停損設於 47.65。', { refPrice: 50 })[0];
  assert.equal(s.sentence, '目標價為 70，停損設於 47.65', 'sentence 仍是整句（enforce 的整句移除口徑不變）');
  assert.equal(s.index, '目標價為 70，停損設於 '.length);
});

test('H53 validateLlmStopText：T1 缺／不符；T2 差 >1 檔（enforce 改數字並另起一行加註）；T3 ≥ 現價；T4 買點當停損；T5 ATR 帶當日值當停損', () => {
  const ctx = { stop: 52.35, refPrice: 55, band: 49.8, buyPoints: [53.5], lastPrice: 55, stopRef: 52.35, isEtf: true };
  const ok = validateLlmStopText({ TRIGGER: '跌破 52.35 停損；站上 61 加碼' }, { ...ctx, mode: 'measure' });
  assert.deepEqual(ok.violations, []);
  const m = validateLlmStopText({ TRIGGER: '跌破 49.8 即停損出場' }, { ...ctx, mode: 'measure' });
  assert.deepEqual(m.violations.map(v => v.code).sort(), ['bandAsStop', 'textMismatch']);
  assert.equal(m.fields.TRIGGER, '跌破 49.8 即停損出場', 'measure 不改字');
  const e = validateLlmStopText({ TRIGGER: '跌破 49.8 即停損出場' }, { ...ctx, mode: 'enforce' });
  assert.equal(e.fields.TRIGGER, '跌破 52.35 即停損出場\n（停損以系統規範 stop-v1.1 為準：52.35）');
  assert.deepEqual(validateLlmStopText({}, { ...ctx, stopRef: null, mode: 'measure' }).violations.map(v => v.code), ['refMissing']);
  assert.deepEqual(validateLlmStopText({}, { ...ctx, stopRef: 52, mode: 'measure' }).violations.map(v => v.code), ['refMismatch']);
  const t3 = validateLlmStopText({ 分析: '停損 56；基本面穩' }, { ...ctx, mode: 'enforce' });
  assert.ok(t3.violations.some(v => v.code === 'stopAbovePrice'));
  assert.equal(t3.fields['分析'], '基本面穩');
  const t4 = validateLlmStopText({ 分析: '買點 53.5 附近進場、停損 53.5' }, { ...ctx, mode: 'measure' });
  assert.ok(t4.violations.some(v => v.code === 'buyAsStop'));
});
