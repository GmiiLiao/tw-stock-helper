// 開盤感應器 v2.1 結構軸／七種狀態／資料閘門（design-v2.1 §3、§5.6、§12.4）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weightsAxis, genAxis, classify, domRule, stateKeyOf, gates, NAMED } from './open-sensor-judge.mjs';

// ── 夾具：W30（2330 最大）＋流動一般股 ─────────────────────────────
const W30 = ['2330', ...Array.from({ length: 29 }, (_, i) => String(2400 + i))];
function uniOf(liquidN = 20) {
  const tse = {};
  W30.forEach((c, i) => { tse[c] = { y: 100, cap: c === '2330' ? 5000 : 100 - i, lots: 10000 }; });
  const liquid = Array.from({ length: liquidN }, (_, i) => String(3000 + i));
  for (const c of liquid) tse[c] = { y: 50, cap: 10, lots: 1000 };
  return { tse, w30: W30, w30Set: new Set(W30), liquid, liquidSet: new Set(liquid) };
}
const q = (pct, y = 100, r = 1000) => ({ p: y * (1 + pct / 100), y, v: 1000, o: y, r, live: true });
/** 權值：2330 tsmc%、其餘 29 檔依序 up 檔 +rest%、down 檔 −rest%、其餘 0% */
function wBuf(buf, { tsmc, up, down, rest = 1 }) {
  buf.set('2330', q(tsmc));
  W30.slice(1).forEach((c, i) => buf.set(c, q(i < up ? rest : i < up + down ? -rest : 0)));
  return buf;
}

test('weightsDir：W 在 ±0.50 邊界、其餘 29 檔恰 15 同向才確認', () => {
  const uni = uniOf();
  // tsmc 權重壓倒性 ⇒ W ≈ tsmc
  let w = weightsAxis(wBuf(new Map(), { tsmc: 0.49, up: 20, down: 0, rest: 0.49 }), uni);
  assert.equal(w.dir, 'flat');
  w = weightsAxis(wBuf(new Map(), { tsmc: 0.8, up: 15, down: 0, rest: 0.8 }), uni);
  assert.ok(w.raw >= 0.5); assert.equal(w.restUp, 15); assert.equal(w.dir, 'up');
  w = weightsAxis(wBuf(new Map(), { tsmc: 0.8, up: 14, down: 0, rest: 0.8 }), uni);
  assert.ok(w.raw >= 0.5); assert.equal(w.dir, 'unconfirmed');
  w = weightsAxis(wBuf(new Map(), { tsmc: -0.6, up: 0, down: 15, rest: 0.6 }), uni);
  assert.equal(w.dir, 'down');
});

test('weightsDir：不夠新的不算任何一方；未確認副標三種', () => {
  const uni = uniOf();
  const buf = wBuf(new Map(), { tsmc: 1, up: 16, down: 0, rest: 1 });
  for (const c of W30.slice(1, 3)) buf.set(c, { ...buf.get(c), live: false });   // 2 檔不夠新
  const w = weightsAxis(buf, uni);
  assert.equal(w.restUp, 14); assert.equal(w.dir, 'unconfirmed');
  // 台積電獨撐：W>0、台積電同號、X 反號
  let w2 = weightsAxis(wBuf(new Map(), { tsmc: 2, up: 3, down: 20, rest: 1 }), uni);
  assert.equal(w2.dir, 'unconfirmed'); assert.equal(w2.sub, 'tsmcSolo');
  w2 = weightsAxis(wBuf(new Map(), { tsmc: -2, up: 20, down: 3, rest: 1 }), uni);
  assert.equal(w2.sub, 'tsmcWeak');
  w2 = weightsAxis(wBuf(new Map(), { tsmc: 2, up: 10, down: 5, rest: 1 }), uni);   // X 同號 ⇒ 權值分歧
  assert.equal(w2.dir, 'unconfirmed'); assert.equal(w2.sub, 'split');
});

test('genDir：只收流動宇宙（上櫃代號不在名單即不算）；G、B 邊界', () => {
  const uni = uniOf(10);
  const buf = new Map();
  uni.liquid.forEach((c, i) => buf.set(c, q(i < 6 ? 0.4 : -0.4, 50)));
  buf.set('6488', q(9, 50));   // 上櫃代號：不在 liquid，不影響
  let g = genAxis(buf, uni);
  assert.equal(g.fresh, 10); assert.equal(g.up, 6); assert.equal(g.upRatio, 0.6);
  assert.ok(Math.abs(g.median - 0.4) < 1e-6); assert.equal(g.dir, 'up');
  uni.liquid.forEach((c, i) => buf.set(c, q(i < 4 ? 0.4 : -0.4, 50)));
  g = genAxis(buf, uni);
  assert.equal(g.upRatio, 0.4); assert.equal(g.dir, 'down');
  uni.liquid.forEach(c => buf.set(c, q(0.19, 50)));
  assert.equal(genAxis(buf, uni).dir, 'flat');
});

// ── classify：直接給軸（raw 為原值） ──────────────────────────────────
const W = (raw, dir, sub = null) => ({ raw, pct: raw, dir, sub });
const G = (raw, dir) => ({ raw, median: raw, dir });

test('R0–R5 各一筆', () => {
  assert.equal(classify({ gatesOk: false, w: W(2, 'up'), g: G(1, 'up'), vol: 'big' }).key, 'undetermined');
  assert.equal(classify({ gatesOk: true, w: W(2, 'unconfirmed', 'tsmcSolo'), g: G(1, 'up'), vol: 'big' }).rule, 'R1');
  assert.equal(classify({ gatesOk: true, w: W(0.2, 'flat'), g: G(0.1, 'flat'), vol: 'big' }).rule, 'R2');
  assert.equal(classify({ gatesOk: true, w: W(0.2, 'flat'), g: G(0.8, 'up'), vol: 'big' }).rule, 'R3');
  assert.equal(classify({ gatesOk: true, w: W(-1, 'down'), g: G(0.6, 'up'), vol: 'big' }).rule, 'R4');
  assert.equal(classify({ gatesOk: true, w: W(1, 'up'), g: G(0.8, 'up'), vol: 'big' }).rule, 'R5');
});

test('七種命名狀態各一筆', () => {
  const k = (w, g, vol) => classify({ gatesOk: true, w, g, vol });
  assert.equal(k(W(1.0, 'up'), G(0.9, 'up'), 'big').key, 'allUpHeavy');           // ① |S|<1 ⇒ 全面
  assert.equal(k(W(-1.0, 'down'), G(-0.9, 'down'), 'small').key, 'allDownLight');  // ②
  assert.equal(k(W(3, 'up'), G(0.5, 'up'), 'small').key, 'wUpLight');              // ③
  assert.equal(k(W(0.6, 'up'), G(2.5, 'up'), 'big').key, 'genUpHeavy');            // ④ |W| ≤ 0.67|G|
  assert.equal(k(W(-3, 'down'), G(0.1, 'flat'), 'big').key, 'wDownHeavy');         // ⑤ R4
  assert.equal(k(W(3, 'up'), G(0.5, 'up'), 'big').key, 'wUpHeavy');                // ⑥
  const seven = k(W(0.1, 'flat'), G(0.05, 'flat'), 'big');
  assert.equal(seven.key, 'noDirection'); assert.equal(seven.label, '⑦ 無方向'); assert.equal(seven.lamp, 'neutral');
  assert.equal(Object.keys(NAMED).length, 6);
});

test('表中 6 個「外」格各一筆', () => {
  const k = (w, g, vol) => classify({ gatesOk: true, w, g, vol });
  const cases = [
    [W(-1.0, 'down'), G(-0.9, 'down'), 'big', 'outside:big|all|down', '不在狀態內（量大·全面·跌）'],
    [W(-0.6, 'down'), G(-2.5, 'down'), 'big', 'outside:big|gen|down', '不在狀態內（量大·一般股·跌）'],
    [W(1.0, 'up'), G(0.9, 'up'), 'small', 'outside:small|all|up', '不在狀態內（量縮·全面·漲）'],
    [W(-3, 'down'), G(-0.5, 'down'), 'small', 'outside:small|w|down', '不在狀態內（量縮·權值·跌）'],
    [W(0.6, 'up'), G(2.5, 'up'), 'small', 'outside:small|gen|up', '不在狀態內（量縮·一般股·漲）'],
    [W(-0.6, 'down'), G(-2.5, 'down'), 'small', 'outside:small|gen|down', '不在狀態內（量縮·一般股·跌）'],
  ];
  for (const [w, g, vol, sk, label] of cases) {
    const st = k(w, g, vol);
    assert.equal(st.key, 'outside'); assert.equal(st.outsideReason, 'cell');
    assert.equal(stateKeyOf(st), sk); assert.equal(st.label, label); assert.equal(st.lamp, 'gray');
  }
});

test('R2 ⇒ ⑦ 與 R3 ⇒ 權值未表態：量任意都一樣', () => {
  for (const vol of ['big', 'small', 'pending']) {
    assert.equal(classify({ gatesOk: true, w: W(0.3, 'flat'), g: G(0.1, 'flat'), vol }).key, 'noDirection');
    const st = classify({ gatesOk: true, w: W(0.3, 'flat'), g: G(-0.6, 'down'), vol });
    assert.equal(stateKeyOf(st), 'outside:wUnstated'); assert.equal(st.label, '不在狀態內（權值未表態）');
  }
});

test('量未定的優先序：一般股·跌＋量未定 ⇒ 不在狀態內（不是 volPending）；權值·漲＋量未定 ⇒ volPending、候選 ③⑥', () => {
  const a = classify({ gatesOk: true, w: W(-0.6, 'down'), g: G(-2.5, 'down'), vol: 'pending' });
  assert.equal(a.key, 'outside'); assert.equal(a.outsideReason, 'cell'); assert.equal(a.label, '不在狀態內（一般股·跌）');
  const b = classify({ gatesOk: true, w: W(3, 'up'), g: G(0.5, 'up'), vol: 'pending' });
  assert.equal(b.key, 'volPending'); assert.equal(b.label, '量能未定');
  assert.deepEqual(b.candidates, ['量大＝⑥ 量大權值漲', '量縮＝③ 量縮權值漲']);
  const c = classify({ gatesOk: true, w: W(1.0, 'up'), g: G(0.9, 'up'), vol: 'pending' });
  assert.deepEqual(c.candidates, ['量大＝① 全面量大上漲', '量縮＝不在狀態內']);
  // 權值未確認不看量
  assert.equal(classify({ gatesOk: true, w: W(2, 'unconfirmed', 'split'), g: G(1, 'up'), vol: 'pending' }).label, '不在狀態內（權值未確認·權值分歧）');
});

test('固定樣本〔樣本內·代理〕：10/05、7/31、7/29、7/28', () => {
  const k = (w, g, vol) => classify({ gatesOk: true, w, g, vol }).key;
  // 10/05 09:02：W +2.6、其餘 25 漲 3 跌、G +0.58、B 0.80 ⇒ ⑥
  assert.equal(k(W(2.6, 'up'), G(0.58, 'up'), 'big'), 'wUpHeavy');
  // 7/31 09:02：W ≈ +7.5、G +4.32（權值約一般股 1.6–2.1 倍）⇒ 量大 ⑥、量縮 ③
  assert.equal(k(W(7.5, 'up'), G(4.32, 'up'), 'big'), 'wUpHeavy');
  assert.equal(k(W(7.5, 'up'), G(4.32, 'up'), 'small'), 'wUpLight');
  // 7/29 09:02：W −0.46、一般股 +0.58 ⇒ 權值未表態（不再亮 ④）
  const st729 = classify({ gatesOk: true, w: W(-0.46, 'flat'), g: G(0.58, 'up'), vol: 'big' });
  assert.equal(stateKeyOf(st729), 'outside:wUnstated');
  // 7/28 09:10：W −3.72、其餘 26 跌、G −2.79、S −0.92 ＋量縮 ⇒ ②
  assert.equal(k(W(-3.72, 'down'), G(-2.79, 'down'), 'small'), 'allDownLight');
  // 7/28 09:02：S −1.39（W −3.6、G −2.21）＋量縮 ⇒ 不在狀態內（量縮·權值·跌）
  const st728 = classify({ gatesOk: true, w: W(-3.6, 'down'), g: G(-2.21, 'down'), vol: 'small' });
  assert.equal(stateKeyOf(st728), 'outside:small|w|down');
});

test('domRule：κ＝0.67、|S| ≥ 1.00', () => {
  assert.equal(domRule(W(3.1, 'up'), G(2.0, 'up')).dom, 'w');     // |S| 1.1、|G| ≤ 0.67×3.1
  assert.equal(domRule(W(3.1, 'up'), G(2.1, 'up')).dom, 'all');   // |G| > 0.67|W|
  assert.equal(domRule(W(3, 'up'), G(2.01, 'up')).dom, 'all');    // |S| 0.99 < 1
  assert.equal(domRule(W(1, 'up'), G(2.5, 'up')).dom, 'gen');
});

test('gates：G1–G6、G10 原因字串都出現在 reasons', () => {
  const T = 1_000_000;
  const okW = { fresh: 30, capCovPct: 100, tsmcFresh: true };
  const okG = { fresh: 100, n: 100, revealMed: T - 10_000 };
  const base = { T, w: okW, g: okG, q: { lots: 1 }, qAuc: { lots: 1 }, isFirst: true, tradingDay: true, ringN: 5, zeroLive: false, sharesOk: true };
  assert.deepEqual(gates(base), { ok: true, reasons: [] });
  const r = gates({ ...base, w: { fresh: 26, capCovPct: 93, tsmcFresh: false }, g: { fresh: 50, n: 100, revealMed: T - 60_000 }, q: null, qAuc: null, ringN: 0, zeroLive: true, sharesOk: false, sharesNote: '最新 2026-09-01' });
  assert.equal(r.ok, false);
  for (const tag of ['G1:', 'G2:', 'G3:', 'G4:t00', 'G4:無開盤競價量', 'G5:', 'G6:', 'G10:']) assert.ok(r.reasons.some(s => s.startsWith(tag)), tag);
  assert.ok(r.reasons.find(s => s.startsWith('G2:')).includes('50/100（門檻 60）'));
  assert.ok(gates({ ...base, tradingDay: false }).reasons[0].startsWith('G5:今天不是交易日'));
  assert.equal(gates({ ...base, isFirst: false, qAuc: null }).ok, true);   // 複判不需要 Q_auc
});
