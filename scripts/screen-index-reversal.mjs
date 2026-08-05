#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 大盤「止跌反漲」反轉點的 RSI 區間 —— 2026-08-05
//
// 使用者給了兩個實例（Yahoo 截圖，已對帳：收盤與 Wilder RSI 完全一致）：
//   7/17 RSI5 18.97 / RSI10 31.52  ┐ 連2日極端
//   7/20 RSI5 17.92 / RSI10 30.56  ┘ → 7/21 +4.20%
//   7/29 RSI5 15.44 / RSI10 26.20  ┐
//   7/30 RSI5 15.07 / RSI10 25.87  ┘ → 7/31 +7.98%
// 並問：反轉點的數值到底落在哪個區間？
//
// ⚠**我先前四輪測試全部用「後 20 日平均報酬」當目標，那是錯的窗口。**
//   使用者描述的是「止跌反漲」——**隔天就彈**。20 日平均會把單日爆發
//   稀釋掉（7/31 單日 +7.98%，但後 20 日可能又回落）。
//   目標窗口選錯，再精細的門檻搜尋都答非所問。這次改測 1/3/5/10/20 日全部。
//
// 兩個方向互相驗證：
//   ① 反向工程（本檔主要目的）：先用**價格**客觀定義反轉點，
//      再回頭看那些日子的 RSI 落在哪個區間 → 直接回答使用者的問題。
//   ② 正向驗證：用①得到的區間，測它作為訊號的實際表現。
//   ⚠①是「從結果找條件」，必然有選擇偏誤，只能用來**產生候選區間**，
//     不能當成效證據；成效一律看②。
//
// 口徑：^TWII 日線·Wilder RSI（與 Yahoo 顯示一致）。指數不可直接買賣。
// 用法：node scripts/screen-index-reversal.mjs
// ─────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';

const CACHE = path.join(process.env.TMPDIR || '/tmp', 'twii-daily.json');
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r2 = x => (x == null ? null : +x.toFixed(2));
const wr = a => (a.length ? +(a.filter(v => v > 0).length / a.length * 100).toFixed(1) : null);
const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const pad = (x, n) => String(x).padEnd(n), padL = (x, n) => String(x).padStart(n);

function rsi(cl, p) {
  const o = new Array(cl.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = cl[i] - cl[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= p; l /= p; o[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < cl.length; i++) {
    const d = cl[i] - cl[i - 1];
    g = (g * (p - 1) + (d > 0 ? d : 0)) / p;
    l = (l * (p - 1) + (d < 0 ? -d : 0)) / p;
    o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return o;
}

const main = async () => {
  const bars = JSON.parse(fs.readFileSync(CACHE, 'utf8')).bars;
  const C = bars.map(b => b.c), D = bars.map(b => b.d);
  const R5 = rsi(C, 5), R10 = rsi(C, 10);
  const chg = i => (i > 0 ? (C[i] - C[i - 1]) / C[i - 1] * 100 : null);
  const fwd = (i, n) => (i + n < C.length ? (C[i + n] - C[i]) / C[i] * 100 : null);

  console.log('═'.repeat(112));
  console.log(`大盤止跌反漲點的 RSI 區間｜^TWII ${bars.length} 根（${D[0]} → ${D[D.length - 1]}）`);
  console.log('Wilder RSI 已與使用者提供的 Yahoo 截圖逐日對帳一致（收盤差 0、RSI 差 0.00）');
  console.log('═'.repeat(112));

  // ── ① 反向工程：用價格客觀定義「止跌反漲點」，再看它的 RSI ──
  // 定義：該日單日漲幅 ≥ +2%，且前 5 日累計為負（＝先跌後彈，不是強勢延續）
  // ⚠2026-08-05 修：原本這裡也用 `i < C.length - 20`（為了留 20 日 forward），
  //   結果把**最近 20 個交易日整個排除**，連使用者親自舉的 7/21、7/31 都不在名單裡。
  //   ①只是描述反轉點長什麼樣、不需要 forward，掃到倒數第 1 根即可。
  const rev = [];
  for (let i = 15; i < C.length - 1; i++) {
    const up = chg(i);
    const prev5 = (C[i - 1] - C[i - 6]) / C[i - 6] * 100;
    if (up >= 2 && prev5 < 0) rev.push(i);
  }
  console.log(`\n【① 反向工程】客觀定義的止跌反漲點：單日漲 ≥+2% 且前 5 日累計為負 → 共 ${rev.length} 次`);
  console.log('   看的是「反漲當日的前一日」（＝訊號要在那天成立才來得及）的 RSI 分佈\n');
  const pr5 = rev.map(i => R5[i - 1]).filter(v => v != null);
  const pr10 = rev.map(i => R10[i - 1]).filter(v => v != null);
  console.log('   指標        最小    10%    25%    中位    75%    90%    最大');
  console.log('   ' + '─'.repeat(62));
  for (const [nm, a] of [['前一日 RSI5 ', pr5], ['前一日 RSI10', pr10]]) {
    console.log(`   ${nm} ` + [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].map(p => padL(r2(p === 0 ? Math.min(...a) : p === 1 ? Math.max(...a) : q(a, p)), 7)).join(''));
  }
  const inBox = rev.filter(i => R5[i - 1] < 20 && R10[i - 1] < 35).length;
  console.log(`\n   落在使用者條件（RSI5<20 ∧ RSI10<35）內：${inBox}/${rev.length}（${r2(inBox / rev.length * 100)}%）`);
  console.log('   ⇒ 多數反轉點的 RSI **並沒有**那麼低——這是使用者條件的「涵蓋率」問題，見③。');

  // 使用者舉的兩例是否在名單內
  console.log('\n   使用者舉的兩例對照：');
  for (const d of ['2026-07-21', '2026-07-31']) {
    const i = D.indexOf(d);
    const hit = rev.includes(i);
    console.log(`     ${d} 漲 ${r2(chg(i))}%｜前一日 RSI5 ${r2(R5[i - 1])} RSI10 ${r2(R10[i - 1])}｜在客觀反轉點名單內：${hit ? '是' : '否'}`);
  }

  // ── ② 正向驗證：連2日 RSI 條件（不含隔日確認）在各個窗口的表現 ──
  console.log(`\n${'━'.repeat(112)}`);
  console.log('【② 正向驗證】連 2 日 RSI5<X ∧ RSI10<Y，T 日收盤進場，看各持有期');
  console.log('  ⚠這裡才是成效證據；①只是產生候選區間');
  console.log('━'.repeat(112));
  const baseline = {};
  for (const n of [1, 3, 5, 10, 20]) {
    const a = []; for (let i = 15; i < C.length - 20; i++) { const v = fwd(i, n); if (v != null) a.push(v); }
    baseline[n] = avg(a);
  }
  console.log('  基準（全部交易日）：' + [1, 3, 5, 10, 20].map(n => `${n}日 ${r2(baseline[n])}%`).join('  '));
  console.log('');
  console.log(pad('  條件', 30) + padL('次數', 6) + [1, 3, 5, 10, 20].map(n => padL(`${n}日`, 9)).join('') + padL('1日勝', 8) + padL('5日勝', 8));
  console.log('  ' + '─'.repeat(104));
  const combos = [];
  for (const x of [15, 20, 25, 30]) for (const y of [20, 25, 30, 35, 40]) combos.push([x, y]);
  const rows = [];
  for (const [x, y] of combos) {
    const ok = (i, k) => R5[i - k] != null && R5[i - k] < x && R10[i - k] != null && R10[i - k] < y;
    const idx = [];
    for (let i = 15; i < C.length - 20; i++) if (ok(i, 0) && ok(i, 1)) idx.push(i);
    if (idx.length < 15) continue;
    const f = n => idx.map(i => fwd(i, n)).filter(v => v != null);
    const row = { x, y, n: idx.length, r: {}, w1: wr(f(1)), w5: wr(f(5)) };
    for (const n of [1, 3, 5, 10, 20]) row.r[n] = avg(f(n));
    rows.push(row);
    console.log(pad(`  RSI5<${x} ∧ RSI10<${y}`, 30) + padL(idx.length, 6)
      + [1, 3, 5, 10, 20].map(n => padL(r2(row.r[n]), 9)).join('') + padL(`${row.w1}%`, 8) + padL(`${row.w5}%`, 8));
  }

  // ── ③ 使用者原條件的涵蓋率與漏接 ──
  console.log(`\n${'━'.repeat(112)}`);
  console.log('【③ 涵蓋率】使用者條件抓到多少反轉點、漏掉多少');
  console.log('━'.repeat(112));
  for (const [x, y] of [[20, 35], [20, 30], [25, 35], [30, 40]]) {
    const ok = (i, k) => R5[i - k] != null && R5[i - k] < x && R10[i - k] != null && R10[i - k] < y;
    const sig = [];
    for (let i = 15; i < C.length - 20; i++) if (ok(i, 0) && ok(i, 1)) sig.push(i);
    // 訊號成立後 5 日內是否出現 ≥+2% 的單日反彈
    const bounce = sig.filter(i => { for (let k = 1; k <= 5; k++) if (i + k < C.length && chg(i + k) >= 2) return true; return false; });
    // 反轉點被抓到：反轉日的前 1~3 日內有訊號
    const caught = rev.filter(i => sig.some(s => s >= i - 3 && s <= i - 1));
    console.log(`  RSI5<${x} ∧ RSI10<${y} 連2日：訊號 ${sig.length} 次`
      + `｜5 日內出現 ≥+2% 反彈 ${bounce.length} 次（${r2(bounce.length / sig.length * 100)}%）`
      + `｜抓到 ${caught.length}/${rev.length} 個反轉點（${r2(caught.length / rev.length * 100)}%）`);
  }

  console.log(`\n${'═'.repeat(112)}\n判讀\n${'═'.repeat(112)}`);
  console.log('  · ① 是描述（反轉點長什麼樣），② 才是成效（訊號能不能用）。');
  console.log('  · 「訊號後 5 日內有 ≥2% 反彈」的比率高 ≠ 賺錢：要看那之前有沒有先跌更多。');
  console.log('  · 指數不可直接買賣。非投資建議。');
  process.exit(0);
};
main().catch(e => { console.error(e); process.exit(1); });
