#!/usr/bin/env node
// 飆股模型 v2 後台頁的「容錯＋格式化」純函式驗證（src/lib/surge-v2-format.ts）。
// 用法：node scripts/verify-surge-v2-format.mjs [fixture.json]
//   不帶參數＝只跑內建的合成資料（依規格自建）；帶 fixture 路徑＝另外對真實內容跑「不丟例外＋結構不變式」。
// 刻意不叫 *.test.mjs：它直接 import .ts（需 Node 內建型別剝除，Node ≥ 22.18／23.6），不納入 check-test-count 的測試基線。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  num, str, parsePick, parseReport, isWarnPick, ledgerStatusLabel, barWidths, signTone, ciTone,
  fmtNum, fmtCount, fmtRatio, fmtPercent, fmtRate, fmtInterval, fmtDateTime, fmtText, fmtFlag, DAY_RE,
} from '../src/lib/surge-v2-format.ts';

const BAD = [null, undefined, NaN, Infinity, -Infinity, '', 'abc', '12', {}, [], true];

const pick = (o = {}) => ({
  rank: 1, code: '6538', name: '倉和', score: 0.31, winProb: 0.31, past20: 0.01,
  family: { id: 1, label: '連漲後再加速型', dist: 0.12 },
  state: { luClose20: 2, luOpen20: 0, luLock20: 0, luBroken20: 1, luSmall20: 0, luBig20: 1, streak: 0, vr: 0.58, attn20: 10, disp: 0, otc: 0 },
  news: { bull0: 0.0, bear0: 0.0, cnt3: 1 }, exit: { tp: 0.25, sl: 0.10, maxHold: 20 }, flags: ['開盤即漲停≥1'], ...o,
});
const FULL = {
  schema: 'surge-v2/1', asOfDay: '2026-10-07', entryDay: '2026-10-08', builtTime: '2026-10-07T23:40:00+08:00', status: 'shadow',
  verdict: { text: '未通過', passed: false, rule: '超額 95% 區間下界 > 0' },
  validation: {
    target: '隔日開盤進場', rows: [{ phase: '起漲', fold: '2025H2', top: 6.18, base: -0.09, diffLo: 4.2, diffHi: 8.4, win: 43, holdDays: 15.1 }],
    hitRows: [{ phase: '起漲', fold: '2025H2', prec: 30.3, base: 8.6, lift: 21.7, liftLo: 15.7, liftHi: 28.0 }],
    importance: [{ group: '價量籌碼營收', pp: 10.9 }, { group: '新聞', pp: -2.1 }], notes: ['限制一'],
  },
  picks: { start: [pick(), pick({ code: '2221', name: '大甲', state: { ...pick().state, disp: 1 }, flags: ['處置中'] })], cont: [pick({ code: '3008' })] },
  disposal: {
    modes: [{ id: 0, label: '處置後仍飆型', n: 135, pre20: 0.78, during: 0.365, post20: 0.168, reach25: 0.91, note: 'n' }],
    today: [{ code: '2221', name: '大甲', day: 7, pre20: 1.22, since: 0.17, mode: 0, modeLabel: '處置後仍飆型', dist: 0.118 }], predictability: '可預測性低',
  },
  swaps: {
    rule: '第3日未達+3%', validation: [{ variant: '同籌碼且高分', fold: '全部', n: 123, swap: 1.2, hold: 0.3, diff: 0.9, lo: -0.5, hi: 2.4 }],
    today: [{ hold: pick(), to: pick({ code: '2330', name: '台積電' }), chipDist: 0.35, why: '同籌碼' }],
  },
  ledger: { summary: { days: 0, picks: 0, closed: 0, meanRet: null, win: null }, rows: [{ pickDay: '2026-10-08', code: '6538', name: '倉和', phase: '起漲', status: 'open', ret: null, exitDay: null }] },
  pipeline: { lastRun: '2026-10-07T23:40:00+08:00', steps: [{ name: '新聞抓取', ok: true, note: '+212 則' }], dataNotes: ['注意股狀態只到 2026-10-02'] },
};

test('數字格式化：壞值一律「—」不丟例外', () => {
  for (const b of BAD) {
    for (const f of [fmtNum, fmtCount, fmtRatio, fmtPercent, fmtRate]) {
      if (typeof b === 'number' && Number.isFinite(b)) continue;
      assert.equal(f(b), '—', `${f.name}(${String(b)})`);
    }
    assert.equal(fmtInterval(b, 1), '—'); assert.equal(fmtInterval(1, b), '—');
    assert.equal(fmtFlag(b), '—');
  }
  assert.equal(fmtNum(6.18, 1, true), '+6.2'); assert.equal(fmtNum(-0.09, 2, true), '-0.09'); assert.equal(fmtNum(0, 1, true), '0.0');
  assert.equal(fmtCount(1234.6), '1,235'); assert.equal(fmtRatio(0.31), '31.0%'); assert.equal(fmtRatio(0.17, 0, true), '+17%');
  assert.equal(fmtPercent(6.18, 2, true), '+6.18%'); assert.equal(fmtInterval(4.2, 8.4), '[+4.2, +8.4]%');
});

test('勝率 fmtRate：≤1 視為比例、>1 視為百分數', () => {
  assert.equal(fmtRate(0.43), '43.0%'); assert.equal(fmtRate(43), '43.0%'); assert.equal(fmtRate(0), '0.0%');
});

test('日期時間：台北時間；無效字串原樣、缺值「—」', () => {
  assert.equal(fmtDateTime('2026-10-07T23:40:00+08:00'), '10-07 23:40');
  assert.equal(fmtDateTime('2026-10-07T15:40:00Z'), '10-07 23:40');
  assert.equal(fmtDateTime('不是日期'), '不是日期');
  for (const b of [null, undefined, '', 5, {}]) assert.equal(fmtDateTime(b), '—');
  assert.equal(fmtText(null), '—'); assert.equal(fmtText('  '), '—'); assert.equal(fmtText('x'), 'x');
});

test('num／str 收斂', () => {
  assert.equal(num(0), 0); assert.equal(num('1'), null); assert.equal(num(NaN), null); assert.equal(str(''), null); assert.equal(str(3), null);
});

test('day 格式（API 與元件共用的合法性）', () => {
  assert.ok(DAY_RE.test('2026-10-07'));
  for (const b of ['2026-1-7', '20261007', '2026-10-07x', '../x', '2026-10-07/../a', ' 2026-10-07']) assert.ok(!DAY_RE.test(b), b);
});

test('parseReport：完整輸入逐欄保留', () => {
  const r = parseReport(FULL);
  assert.equal(r.asOfDay, '2026-10-07'); assert.equal(r.verdict.passed, false);
  assert.equal(r.validation.rows[0].top, 6.18); assert.equal(r.validation.importance.length, 2);
  assert.equal(r.picks.start.length, 2); assert.equal(r.picks.cont[0].code, '3008');
  assert.equal(r.picks.start[0].state.luClose20, 2); assert.equal(r.picks.start[0].family.label, '連漲後再加速型');
  assert.equal(r.disposal.today[0].dist, 0.118); assert.equal(r.swaps.today[0].to.code, '2330');
  assert.equal(r.ledger.rows[0].status, 'open'); assert.equal(r.ledger.summary.meanRet, null);
  assert.equal(r.pipeline.steps[0].ok, true);
});

test('parseReport：非物件輸入回 null（呼叫端顯示格式不符）', () => {
  for (const b of [null, undefined, 5, 'x', [], [1]]) assert.equal(parseReport(b), null);
});

test('parseReport：空物件／缺整段／缺欄位／錯型別都不丟例外、陣列為空、數值為 null', () => {
  const empty = parseReport({});
  assert.deepEqual([empty.picks.start, empty.picks.cont, empty.validation.rows, empty.ledger.rows, empty.pipeline.steps, empty.swaps.today, empty.disposal.modes], [[], [], [], [], [], [], []]);
  assert.equal(empty.verdict.passed, null); assert.equal(empty.ledger.summary.win, null); assert.equal(empty.asOfDay, null);
  // 每一段被換成各種壞值
  for (const key of Object.keys(FULL)) {
    for (const b of BAD) assert.doesNotThrow(() => parseReport({ ...FULL, [key]: b }), `${key}=${String(b)}`);
  }
  // 子結構內的壞值（陣列元素、巢狀欄位）
  const nasty = {
    validation: { rows: [null, 5, 'x', { top: NaN, diffLo: '1' }, []], hitRows: 'x', importance: [{ pp: Infinity }], notes: [1, null, '', '備註'] },
    picks: { start: [null, 3, {}, { code: 5, state: 'x', news: [], exit: null, flags: [1, 'a'] }], cont: {} },
    disposal: { modes: [{}, null], today: 'x' }, swaps: { validation: [null], today: [{ hold: 5, to: null }, {}] },
    ledger: { summary: [], rows: [{ ret: NaN }, null] }, pipeline: { steps: [null, { ok: 'yes' }], dataNotes: [null, 'n'] },
  };
  const r = parseReport(nasty);
  assert.equal(r.validation.rows.length, 1);   // 只有 { top: NaN, diffLo: '1' } 是物件；null／數字／字串／陣列列被丟
  assert.equal(r.validation.rows[0].top, null); assert.equal(r.validation.rows[0].diffLo, null);
  assert.deepEqual(r.validation.notes, ['備註']); assert.deepEqual(r.pipeline.dataNotes, ['n']);
  assert.equal(r.picks.start.length, 2);   // 只剩 {} 與 {code:5,...}（null／3 被丟）
  assert.equal(r.picks.start[1].code, '—'); assert.deepEqual(r.picks.start[1].flags, ['a']); assert.equal(r.picks.cont.length, 0);
  assert.equal(r.swaps.today[0].hold, null); assert.equal(r.swaps.today[0].to, null);
  assert.equal(r.pipeline.steps.length, 1); assert.equal(r.pipeline.steps[0].ok, null); assert.equal(r.ledger.rows[0].ret, null);
});

test('名單輔助：警示判斷、帳本狀態、長條寬度', () => {
  const r = parseReport(FULL);
  assert.equal(isWarnPick(r.picks.start[0]), false); assert.equal(isWarnPick(r.picks.start[1]), true);
  assert.equal(isWarnPick(parsePick({ state: { luLock20: 2 } })), true); assert.equal(isWarnPick(parsePick({ flags: ['處置中'] })), true);
  assert.equal(isWarnPick(parsePick({})), false);
  assert.equal(parsePick(null), null); assert.equal(parsePick([]), null);
  assert.equal(ledgerStatusLabel('tp'), '停利'); assert.equal(ledgerStatusLabel('sl'), '停損'); assert.equal(ledgerStatusLabel('time'), '到期出場');
  assert.equal(ledgerStatusLabel('open'), '持有中'); assert.equal(ledgerStatusLabel('weird'), 'weird'); assert.equal(ledgerStatusLabel(null), '—');
  assert.deepEqual(barWidths([10, -5, null]), [100, 50, 0]); assert.deepEqual(barWidths([]), []); assert.deepEqual(barWidths([0, null]), [0, 0]);
  assert.equal(signTone(1), 'up'); assert.equal(signTone(-1), 'down'); assert.equal(signTone(0), 'neutral'); assert.equal(signTone(NaN), 'neutral');
  assert.equal(ciTone(1, 2), 'up'); assert.equal(ciTone(-2, -1), 'down'); assert.equal(ciTone(-1, 1), 'neutral'); assert.equal(ciTone(null, 1), 'neutral');
});

test('輸出可被 JSON 序列化（Firestore 單文件 ≤900KB 的下游）：parse 結果不含 NaN／undefined 洩漏', () => {
  const s = JSON.stringify(parseReport(FULL));
  assert.ok(!s.includes('NaN')); assert.ok(!s.includes('undefined'));
});

// ── 外部 fixture（真實內容）：只驗「不丟例外＋結構不變式」，不驗內容值 ──
const fixturePath = process.argv.find(a => a.endsWith('.json'));
if (fixturePath) {
  test(`fixture ${fixturePath}：可解析、可格式化`, () => {
    let raw = JSON.parse(readFileSync(fixturePath, 'utf8'));
    if (raw && typeof raw.reportJson === 'string') raw = JSON.parse(raw.reportJson);   // 允許給整份 Firestore 文件形狀
    if (raw && raw.report && typeof raw.report === 'object') raw = raw.report;           // 允許給 API 回應形狀
    const r = parseReport(raw);
    assert.ok(r, 'parseReport 不得回 null');
    for (const list of [r.picks.start, r.picks.cont]) for (const p of list) {
      for (const f of [fmtNum, fmtRatio]) f(p.score);
      isWarnPick(p); fmtRatio(p.past20, 1, true); fmtCount(p.state.luLock20);
    }
    for (const x of r.validation.rows) { fmtPercent(x.top); fmtInterval(x.diffLo, x.diffHi); }
    for (const x of r.ledger.rows) { fmtRatio(x.ret); ledgerStatusLabel(x.status); }
    fmtDateTime(r.builtTime);
    console.log(`# fixture 摘要：asOf=${r.asOfDay} 起漲${r.picks.start.length} 續漲${r.picks.cont.length} 驗證列${r.validation.rows.length} 處置模態${r.disposal.modes.length} 今日處置${r.disposal.today.length} 換股建議${r.swaps.today.length} 帳本${r.ledger.rows.length} 步驟${r.pipeline.steps.length}`);
  });
}
