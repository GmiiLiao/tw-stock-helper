// ─────────────────────────────────────────────────────────────────────────
// 「上漲 ∧ KD 金叉 ∧ 交會」動態出場檢定 —— 2026-08-02
//
// 前一輪（screen-kd-cross-grid）結論：母體真起漲率 22.7%/21.7% 確實高於基準 18%，
// 但**固定持有 5 日**下 42 個格子的中位數全部為負＝過半虧損、靠右尾撐平均。
// 使用者提議：改成「破前低停損、續強就抱」的動態出場，看能不能把分布救回來。
//
// 出場規則（全部同一個進場：今日收盤，母體同前）：
//   A 固定5日（對照組）
//   B 停損＝進場日最低價，最長持有 10 日
//   C 停損＝進場日最低價，最長持有 20 日
//   D 移動停損＝前一日最低價（逐日上移），最長 20 日
//   E 移動停損＝跌破 MA5 收盤出場，最長 20 日
//
// ⚠成交假設（保守，不美化）：
//   觸發停損當日以 min(停損價, 當日開盤) 成交 —— 跳空開低就吃跳空，
//   不假設能在停損價精準成交。這是日線回測能做到的最誠實假設。
// 判準：平均與**中位數**皆為正、主窗兩半同向、OOT 同向。
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, avg, r3 } from './lib/bt-core.mjs';

const COST = 0.4425, P = 9;

function buildKD(days) {
  const st = {}, out = {};
  for (let i = 0; i < days.length; i++) {
    for (const code in days[i].close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const r = days[i].close[code];
      if (!r || r.length < 5) continue;
      const [c, , , h, l] = r;
      if (!(c > 0 && h > 0 && l > 0 && h >= l)) continue;
      const s = (st[code] ||= { k: 50, d: 50, hs: [], ls: [] });
      s.hs.push(h); s.ls.push(l);
      if (s.hs.length > P) { s.hs.shift(); s.ls.shift(); }
      if (s.hs.length < P) continue;
      const hn = Math.max(...s.hs), ln = Math.min(...s.ls);
      const rsv = hn === ln ? 50 : ((c - ln) / (hn - ln)) * 100;
      const pk = s.k, pd = s.d;
      s.k = (pk * 2) / 3 + rsv / 3;
      s.d = (pd * 2) / 3 + s.k / 3;
      out[`${i}_${code}`] = { gold: pk <= pd && s.k > s.d, conv: Math.abs(s.k - s.d) < 2 };
    }
  }
  return out;
}

/** 每檔的逐日 OHLC 序列（含 MA5），供出場模擬逐日前進 */
function buildSeries(days) {
  const ser = {};
  for (let i = 0; i < days.length; i++) {
    for (const code in days[i].close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const r = days[i].close[code];
      if (!r || r.length < 5) continue;
      const [c, , o, h, l] = r;
      if (!(c > 0 && h > 0 && l > 0 && o > 0)) continue;
      const a = (ser[code] ||= { idx: {}, bars: [] });
      a.idx[i] = a.bars.length;
      const n = a.bars.length;
      const prev5 = a.bars.slice(Math.max(0, n - 4));
      const ma5 = n >= 4 ? (prev5.reduce((s, b) => s + b.c, 0) + c) / 5 : null;
      a.bars.push({ di: i, o, h, l, c, ma5 });
    }
  }
  return ser;
}

/** 出場模擬：回傳淨報酬% 與持有天數 */
function simulate(bars, pos, rule) {
  const entry = bars[pos].c;
  let stop = rule.stop === 'entryLow' ? bars[pos].l : null;
  const maxHold = rule.maxHold;
  for (let k = 1; k <= maxHold; k++) {
    const b = bars[pos + k];
    if (!b) return null;                                  // 資料不足＝丟棄，不猜
    if (rule.stop === 'prevLow') stop = bars[pos + k - 1].l;   // 移動停損：昨日低
    if (rule.stop === 'ma5') {
      // 收盤跌破 MA5 → 隔日開盤出場（收盤才知道，不能當日出）
      if (b.ma5 != null && b.c < b.ma5) {
        const nx = bars[pos + k + 1];
        const px = nx ? nx.o : b.c;
        return { ret: (px / entry - 1) * 100 - COST, days: k + (nx ? 1 : 0) };
      }
    } else if (stop != null && b.l <= stop) {
      const px = Math.min(stop, b.o);                     // 跳空開低就吃跳空
      return { ret: (px / entry - 1) * 100 - COST, days: k };
    }
    if (k === maxHold) return { ret: (b.c / entry - 1) * 100 - COST, days: k };
  }
  return null;
}

const RULES = [
  { name: 'A 固定5日(對照)', stop: null, maxHold: 5 },
  { name: 'B 破進場低·最長10日', stop: 'entryLow', maxHold: 10 },
  { name: 'C 破進場低·最長20日', stop: 'entryLow', maxHold: 20 },
  { name: 'D 移動停損(昨低)·20日', stop: 'prevLow', maxHold: 20 },
  { name: 'E 破MA5出場·最長20日', stop: 'ma5', maxHold: 20 },
];

const load = async (opt) => {
  const days = await loadDays(opt);
  const samples = buildSamples(days);
  const kd = buildKD(days), ser = buildSeries(days);
  const sigs = [];
  for (const s of samples) {
    const x = kd[`${s.di}_${s.code}`];
    if (!x?.gold || !x.conv) continue;
    if (!(s.tradable && s.chg > 0)) continue;
    const a = ser[s.code]; if (!a) continue;
    const pos = a.idx[s.di]; if (pos == null) continue;
    const rec = { half: s.half, code: s.code, di: s.di };
    let ok = true;
    for (const r of RULES) {
      const out = simulate(a.bars, pos, r);
      if (!out) { ok = false; break; }
      rec[r.name] = out;
    }
    if (ok) sigs.push(rec);
  }
  return sigs;
};

const W = { 主窗: await load({ days: 480 }), OOT: await load({ days: 250, to: '2023-07-31' }) };
const med = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return +(b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2).toFixed(3); };
const pct = (a, f) => (a.length ? +((a.filter(f).length / a.length) * 100).toFixed(1) : null);

console.log('母體＝上漲 ∧ KD金叉 ∧ 交會(|K−D|<2) ∧ 可交易(chg≤8.5%)；進場＝今日收盤；扣費稅 0.4425%');
console.log('停損成交假設：觸發當日以 min(停損價, 當日開盤) 成交（跳空開低就吃跳空，不美化）\n');
console.log(`樣本：主窗 ${W.主窗.length.toLocaleString()}｜OOT ${W.OOT.length.toLocaleString()}\n`);
console.log('  出場規則'.padEnd(24) + '窗    平均      中位數     勝率    平均持有   兩半窗均值          判定');
console.log('  ' + '─'.repeat(118));
for (const r of RULES) {
  for (const [wn, sigs] of Object.entries(W)) {
    const rets = sigs.map(s => s[r.name].ret);
    const dys = sigs.map(s => s[r.name].days);
    const h = [0, 1].map(hf => r3(avg(sigs.filter(s => s.half === hf).map(s => s[r.name].ret))));
    const m = r3(avg(rets)), md = med(rets);
    const same = Math.sign(h[0]) === Math.sign(h[1]);
    const good = m > 0 && md > 0 && same;
    console.log(`  ${(wn === '主窗' ? r.name : '').padEnd(22)} ${wn.padEnd(5)} ${String(m).padStart(8)}% ${String(md).padStart(9)}% ${String(pct(rets, x => x > 0)).padStart(6)}% ${String(r3(avg(dys))).padStart(8)}日  [${h[0]}/${h[1]}]${same ? '' : '⚠換號'}`.padEnd(112) + (good ? '✅' : ''));
  }
  console.log('  ' + '─'.repeat(118));
}
console.log('\n判準：平均與中位數皆為正 ∧ 主窗兩半同向 ∧ OOT 同樣成立，才算動態出場救得起來。');
process.exit(0);
