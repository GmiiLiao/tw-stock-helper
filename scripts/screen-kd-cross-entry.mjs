// ─────────────────────────────────────────────────────────────────────────
// 「上漲 KD 交會＝起漲點」與「KD 開放且下跌＝續跌」機率檢定 —— 2026-08-02
//
// 使用者假設（來自 2026-07-31 四張看盤圖）：
//   A 上漲日 KD 交會（K 剛穿過 D、兩線貼合）＝ 起漲點
//   B KD 開放（K 遠低於 D）且下跌 ＝ 續跌
//
// ⚠**可執行性鐵律**：漲停日收盤買不到（掛單排隊、可交易宇宙排除 chg>8.5%）。
//   所以本檢定的進場點一律用**明日開盤**，出場用第 5 日收盤。
//   用「今日收盤進場」會把買不到的漲停股算成有買到，回測必然虛胖——
//   這正是專案「明開賣鐵律」的同一個道理反過來用。
//
// 指標定義（與 swingEntry 的「真起漲」對齊，但改成從可執行進場價起算）：
//   真起漲 = 後 5 日最低 ≥ 進場價（不破進場價）∧ 後 5 日最高 ≥ 進場價×1.05
//   續跌   = 後 5 日最低 ≤ 進場價×0.95
//   淨報酬 = (第5日收盤 / 明開盤 − 1)×100 − 費稅 0.4425%
//
// 關卡：兩半窗方向一致 + 第三獨立窗 OOT + 與基準比較。
// ─────────────────────────────────────────────────────────────────────────
import { loadDays } from './lib/bt-core.mjs';

const COST = 0.4425, P = 9;

function analyse(days) {
  const st = {}, rows = [];
  for (let i = 0; i < days.length; i++) {
    const D = days[i], N1 = days[i + 1];
    for (const code in D.close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const r = D.close[code];
      if (!r || r.length < 5) continue;
      const [c, v, , h, l] = r;
      if (!(c > 0 && h > 0 && l > 0 && h >= l)) continue;
      const s = (st[code] ||= { k: 50, d: 50, hs: [], ls: [], pc: null });
      s.hs.push(h); s.ls.push(l);
      if (s.hs.length > P) { s.hs.shift(); s.ls.shift(); }
      const prevClose = s.pc; s.pc = c;
      if (s.hs.length < P) continue;
      const hn = Math.max(...s.hs), ln = Math.min(...s.ls);
      const rsv = hn === ln ? 50 : ((c - ln) / (hn - ln)) * 100;
      const pk = s.k, pd = s.d;
      s.k = (pk * 2) / 3 + rsv / 3;
      s.d = (pd * 2) / 3 + s.k / 3;
      if (!(prevClose > 0) || !N1) continue;
      const chg = (c / prevClose - 1) * 100;
      if (!(v >= 300)) continue;                       // 流動性下限（同 bt-core）
      const nOpen = N1.close[code]?.[2];
      if (!(nOpen > 0)) continue;                      // 明日要開得出來（未停牌）
      // 後 5 日（自明日起）高低與第 5 日收盤
      let lo5 = Infinity, hi5 = -Infinity, c5 = null;
      for (let kk = 1; kk <= 5; kk++) {
        const rr = days[i + kk]?.close?.[code];
        if (!rr || rr.length < 5) { lo5 = Infinity; break; }
        if (rr[4] < lo5) lo5 = rr[4];
        if (rr[3] > hi5) hi5 = rr[3];
        if (kk === 5) c5 = rr[0];
      }
      if (!(c5 > 0) || lo5 === Infinity) continue;
      rows.push({
        di: i, code, chg,
        k: s.k, d: s.d, spread: s.k - s.d, prevSpread: pk - pd,
        gold: pk <= pd && s.k > s.d,
        conv: Math.abs(s.k - s.d) < 2,
        net5Open: (c5 / nOpen - 1) * 100 - COST,          // 明開盤進場·第5日收盤出場
        realStart: lo5 >= nOpen && hi5 >= nOpen * 1.05,   // 真起漲
        keepFall: lo5 <= nOpen * 0.95,                    // 續跌（自進場價 -5%）
      });
    }
  }
  const mid = Math.floor(days.length / 2);
  for (const x of rows) x.half = x.di < mid ? 0 : 1;
  return rows;
}

const load = async (opt) => { const d = await loadDays(opt); return { days: d, rows: analyse(d) }; };
const W = { 主窗: await load({ days: 480 }), OOT: await load({ days: 250, to: '2023-07-31' }) };

const pct = (a, f) => (a.length ? +((a.filter(f).length / a.length) * 100).toFixed(1) : null);
const avg = a => (a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(3) : null);

function row(label, cond, minN = 200) {
  const cells = [];
  for (const [wn, w] of Object.entries(W)) {
    const sel = w.rows.filter(cond);
    if (sel.length < minN) { cells.push(`${wn} 不足(${sel.length})`.padEnd(52)); continue; }
    const h = [0, 1].map(hf => pct(sel.filter(x => x.half === hf), x => x.realStart));
    const same = h[0] != null && h[1] != null;
    cells.push(`${wn} 真起漲 ${String(pct(sel, x => x.realStart)).padStart(5)}%[${h[0]}/${h[1]}] 續跌 ${String(pct(sel, x => x.keepFall)).padStart(5)}% 5日淨 ${String(avg(sel.map(x => x.net5Open))).padStart(7)}% n=${String(sel.length).padStart(6)}`.padEnd(52));
    void same;
  }
  console.log(`  ${label.padEnd(26)} ${cells.join(' ')}`);
}
const H = t => console.log(`\n${'═'.repeat(140)}\n══ ${t}\n${'═'.repeat(140)}`);

console.log('進場＝明日開盤、出場＝第5日收盤、扣費稅 0.4425%');
console.log('真起漲＝後5日最低≥進場價 ∧ 後5日最高≥進場價×1.05；續跌＝後5日最低≤進場價×0.95\n');
H('基準（全體·同樣進出場口徑）');
row('全市場', () => true);
row('當日上漲(chg>0)', x => x.chg > 0);
row('當日下跌(chg<0)', x => x.chg < 0);

H('假設 A：上漲 ∧ KD 交會（金叉且兩線貼合）＝ 起漲點？');
row('漲停 ∧ 金叉 ∧ 交會', x => x.chg >= 9.5 && x.gold && x.conv, 100);
row('漲停 ∧ 金叉（不限貼合）', x => x.chg >= 9.5 && x.gold, 100);
row('漲停（全部）', x => x.chg >= 9.5, 100);
row('大漲5~9.5 ∧ 金叉∧交會', x => x.chg >= 5 && x.chg < 9.5 && x.gold && x.conv, 100);
row('小漲0~5 ∧ 金叉∧交會', x => x.chg > 0 && x.chg < 5 && x.gold && x.conv, 100);
row('上漲 ∧ 金叉∧交會(全)', x => x.chg > 0 && x.gold && x.conv, 100);
row('上漲 ∧ 金叉(不限貼合)', x => x.chg > 0 && x.gold, 100);
row('上漲 ∧ 無金叉', x => x.chg > 0 && !x.gold, 100);

H('假設 B：KD 開放（K 遠低於 D）且下跌 ＝ 續跌？');
row('下跌 ∧ K−D ≤ −8', x => x.chg < 0 && x.spread <= -8);
row('下跌 ∧ K−D ≤ −15', x => x.chg < 0 && x.spread <= -15, 100);
row('跌停 ∧ K−D ≤ −8', x => x.chg <= -9.5 && x.spread <= -8, 100);
row('下跌 ∧ K−D ≥ 0（未開放）', x => x.chg < 0 && x.spread >= 0);
row('下跌 ∧ 開放且擴大中', x => x.chg < 0 && x.spread <= -8 && x.spread < x.prevSpread);

H('對照：K 位階（交會發生在低檔還是高檔）');
for (const [zl, zf] of [['K<20', x => x.k < 20], ['K 20~50', x => x.k >= 20 && x.k < 50], ['K≥50', x => x.k >= 50]]) {
  row(`上漲∧金叉∧交會 ∧ ${zl}`, x => x.chg > 0 && x.gold && x.conv && zf(x), 100);
}
console.log(`\n${'═'.repeat(140)}`);
console.log('判準：真起漲率須顯著高於同口徑基準且兩半窗一致、OOT 同向；5日淨報酬須為正才可交易。');
console.log('      續跌率須顯著高於基準才算「開放且下跌＝續跌」成立。');
process.exit(0);
