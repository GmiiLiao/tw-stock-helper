// ─────────────────────────────────────────────────────────────────────────
// K>90 極度超買「避開訊號」增量檢定 —— 2026-08-02（承 screen-kd-refine.mjs）
//
// 前兩輪結論：KD 十二命題中，只有「K>90 極度超買」在兩窗 × 兩 regime 四格
// 全部負且顯著低於基準（買進端 K<20/K<10 主窗有、OOT 全垮，且與 RSI5
// 相關 0.84＝高度冗餘）。
//
// 但過關不等於可用。專案鐵律（2026-07-27 RSI 對漲停模型判定不採時立的）：
//   「新指標入模型前必做 walk-forward 增量檢定＋冗餘度量，
//     單獨看漂亮 ≠ 有增量」——當時發現高 RSI 的預測力**全部來自「剛大漲過」**。
//
// K>90 先驗上有完全相同的嫌疑：K 高必然是收在 9 日高檔區，
// 與「今日漲幅 chg」「5 日漲幅 ret5」「距 60 日高位階 posture60」天然重疊。
// 本輪就是要拆開：控制住這些之後，K>90 還剩多少獨立的負向預測力？
//
// 判準：控制變數分層後，每一層內 K>90 都要比同層非 K>90 差，
//       且兩窗方向一致。任何一層換號＝預測力來自控制變數，不是 KD。
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, avg, r3 } from './lib/bt-core.mjs';

const PERIOD = 9;
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
      if (s.hs.length > PERIOD) { s.hs.shift(); s.ls.shift(); }
      if (s.hs.length < PERIOD) continue;
      const hn = Math.max(...s.hs), ln = Math.min(...s.ls);
      const rsv = hn === ln ? 50 : ((c - ln) / (hn - ln)) * 100;
      s.k = (s.k * 2) / 3 + rsv / 3;
      s.d = (s.d * 2) / 3 + s.k / 3;
      out[`${i}_${code}`] = s.k;
    }
  }
  return out;
}
function buildRSI(days) {
  const st = {}, out = {};
  for (let i = 0; i < days.length; i++) {
    for (const code in days[i].close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const c = days[i].close[code]?.[0];
      if (!(c > 0)) continue;
      const s = (st[code] ||= { p: null, u: 0, d: 0, n: 0 });
      if (s.p != null) {
        const ch = c - s.p, g = Math.max(ch, 0), l = Math.max(-ch, 0);
        s.n++;
        if (s.n <= 5) { s.u += g / 5; s.d += l / 5; } else { s.u = (s.u * 4 + g) / 5; s.d = (s.d * 4 + l) / 5; }
        if (s.n >= 5) out[`${i}_${code}`] = s.u + s.d > 0 ? (s.u / (s.u + s.d)) * 100 : 50;
      }
      s.p = c;
    }
  }
  return out;
}

const load = async (opt) => {
  const days = await loadDays(opt);
  const samples = buildSamples(days);
  const kd = buildKD(days), rsi = buildRSI(days);
  for (const s of samples) { s.k = kd[`${s.di}_${s.code}`]; s.rsi5 = rsi[`${s.di}_${s.code}`]; }
  return { days, all: samples.filter(s => s.tradable && s.k != null && s.rsi5 != null && s.netOpen != null) };
};

const W = { 主窗: await load({ days: 480 }), OOT: await load({ days: 250, to: '2023-07-31' }) };
const m = a => (a.length ? avg(a.map(s => s.netOpen)) : null);

/** 分層對照：每層內 K>90 vs 非 K>90 */
function stratify(title, layers) {
  console.log(`\n${'═'.repeat(74)}\n══ ${title}\n${'═'.repeat(74)}`);
  console.log('  層                    窗    K>90            非K>90          差值    判定');
  for (const [ln, lf] of layers) {
    for (const [wn, w] of Object.entries(W)) {
      const pool = w.all.filter(lf);
      const hi = pool.filter(s => s.k > 90), lo = pool.filter(s => s.k <= 90);
      if (hi.length < 100 || lo.length < 100) { console.log(`  ${ln.padEnd(20)} ${wn.padEnd(5)} 樣本不足(${hi.length}/${lo.length})`); continue; }
      const a = m(hi), b = m(lo), d = a - b;
      console.log(`  ${ln.padEnd(20)} ${wn.padEnd(5)} ${String(r3(a)).padStart(7)}%(n=${String(hi.length).padStart(5)})  ${String(r3(b)).padStart(7)}%(n=${String(lo.length).padStart(6)})  ${String(r3(d)).padStart(7)}  ${d < 0 ? '較差✓' : '較好✗'}`);
    }
  }
}

// ① 控制今日漲幅（最大嫌疑：K 高＝剛大漲過）
stratify('① 控制「今日漲幅 chg」後，K>90 還差嗎？', [
  ['chg ≤ 0%', s => s.chg <= 0],
  ['chg 0~2%', s => s.chg > 0 && s.chg <= 2],
  ['chg 2~5%', s => s.chg > 2 && s.chg <= 5],
  ['chg 5~8.5%', s => s.chg > 5],
]);

// ② 控制 5 日漲幅
stratify('② 控制「近5日漲幅 ret5」後', [
  ['ret5 ≤ 0%', s => s.ret5 != null && s.ret5 <= 0],
  ['ret5 0~5%', s => s.ret5 != null && s.ret5 > 0 && s.ret5 <= 5],
  ['ret5 > 5%', s => s.ret5 != null && s.ret5 > 5],
]);

// ③ 控制 RSI5（冗餘度最高的既有指標）
stratify('③ 控制「RSI5」後（KD 與 RSI5 相關 0.84）', [
  ['RSI5 ≤ 60', s => s.rsi5 <= 60],
  ['RSI5 60~80', s => s.rsi5 > 60 && s.rsi5 <= 80],
  ['RSI5 > 80', s => s.rsi5 > 80],
]);

// ④ 控制 60 日位階
stratify('④ 控制「距60日高位階 posture60」後', [
  ['posture60 < 0.9', s => s.posture60 != null && s.posture60 < 0.9],
  ['posture60 ≥ 0.9', s => s.posture60 != null && s.posture60 >= 0.9],
]);

console.log(`\n${'═'.repeat(74)}\n══ 判定\n${'═'.repeat(74)}`);
console.log('  每一層、兩個窗都「較差✓」＝ K>90 有獨立於控制變數的負向預測力，可入權重。');
console.log('  任何一層出現「較好✗」或兩窗換號 ＝ 預測力來自控制變數本身，KD 無增量，不採。');
process.exit(0);
