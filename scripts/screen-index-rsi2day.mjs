#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 使用者假說（第二版）：大盤 RSI5 連 2 日極端 ＋ 隔日轉向 —— 2026-08-05
//
// 假說原文：
//   Ⓐ 連 2 日 RSI5>80，且下個交易日大盤轉跌 → 下跌開始
//   Ⓑ 連 2 日 RSI5<30，且下個交易日大盤轉漲 → 上漲開始
//
// 與第一版（RSI5>90∧RSI10>85 / RSI5<20∧RSI10<30）的差異：
//   · 只用 RSI5，拿掉 RSI10
//   · 門檻放寬 80/30（原 90/20）→ 樣本會變多，這是好的
//   · **新增「連 2 日」持續性條件**
//
// ⚠成分拆解：這次條件由**三**塊組成，全部要單獨驗證貢獻：
//     ⓐ RSI5 極端（T 日）
//     ⓑ 連 2 日（T 與 T-1 都極端）← 使用者這次新增的元件
//     ⓒ 隔日轉向（T+1 才知道）
//   若不拆，會分不出是「持續性有用」還是「只是門檻放寬導致樣本變多」。
//   對照組因此包含「單日極端」——若單日與連 2 日差不多，ⓑ 就沒有貢獻。
//
// ⚠進場一律 T+1 收盤（ⓒ 要等 T+1 才知道）。另外單獨列出「T 日收盤就進」
//   的版本，用來量化「等確認」的代價——第一版量到是 -1.0pp。
//
// 口徑：^TWII 日線（指數不可直接買賣，測的是大盤方向，不扣費稅）。
// 用法：node scripts/screen-index-rsi2day.mjs
// ─────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';

const CACHE = path.join(process.env.TMPDIR || '/tmp', 'twii-daily.json');
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r2 = x => (x == null ? null : +x.toFixed(2));
const wr = a => (a.length ? +(a.filter(v => v > 0).length / a.length * 100).toFixed(1) : null);
const pad = (x, n) => String(x).padEnd(n), padL = (x, n) => String(x).padStart(n);

async function loadTwii() {
  if (fs.existsSync(CACHE)) {
    const j = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (j?.bars?.length > 500) return j.bars;
  }
  const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?interval=1d&range=10y',
    { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const res = (await r.json())?.chart?.result?.[0];
  const ts = res?.timestamp || [], q = res?.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (!(q.close?.[i] > 0)) continue;
    bars.push({ d: new Date(ts[i] * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }), c: q.close[i] });
  }
  fs.writeFileSync(CACHE, JSON.stringify({ bars, at: Date.now() }));
  return bars;
}

function rsi(cl, p) {
  const o = new Array(cl.length).fill(null);
  if (cl.length <= p) return o;
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
  const bars = await loadTwii();
  const C = bars.map(b => b.c);
  const R5 = rsi(C, 5);
  const fwd = (i, n) => (i + n < C.length ? (C[i + n] - C[i]) / C[i] * 100 : null);
  const maxDD = (i, n) => { let m = 0; for (let k = 1; k <= n && i + k < C.length; k++) m = Math.min(m, (C[i + k] - C[i]) / C[i] * 100); return m; };
  const maxRU = (i, n) => { let m = 0; for (let k = 1; k <= n && i + k < C.length; k++) m = Math.max(m, (C[i + k] - C[i]) / C[i] * 100); return m; };
  const chg = i => (i > 0 ? (C[i] - C[i - 1]) / C[i - 1] * 100 : null);

  console.log('═'.repeat(104));
  console.log(`加權指數 ^TWII：${bars.length} 根（${bars[0].d} → ${bars[bars.length - 1].d}）`);
  console.log(`  今日收盤 ${r2(C[C.length - 1])}｜RSI5 ${r2(R5[R5.length - 1])}｜昨日 RSI5 ${r2(R5[R5.length - 2])}`);
  console.log('═'.repeat(104));

  // i = 進場日索引（T+1）。條件用 i-1(=T) 與 i-2(=T-1)
  const hi1 = i => R5[i - 1] != null && R5[i - 1] > 80;
  const hi2 = i => hi1(i) && R5[i - 2] != null && R5[i - 2] > 80;
  const lo1 = i => R5[i - 1] != null && R5[i - 1] < 30;
  const lo2 = i => lo1(i) && R5[i - 2] != null && R5[i - 2] < 30;

  const CASES = [
    {
      title: 'Ⓐ 下跌假說：連 2 日 RSI5>80 ＋ 隔日轉跌',
      dir: -1,
      sets: [
        ['基準（全部交易日）', i => true],
        ['ⓐ 單日 RSI5>80', hi1],
        ['ⓐ+ⓑ 連2日 RSI5>80', hi2],
        ['ⓒ 只有隔日轉跌', i => chg(i) < 0],
        ['單日>80 ∧ 隔日跌（拿掉連2日）', i => hi1(i) && chg(i) < 0],
        ['★連2日>80 ∧ 隔日跌（完整假說）', i => hi2(i) && chg(i) < 0],
        ['連2日>80 ∧ 隔日續漲（被排除那批）', i => hi2(i) && chg(i) >= 0],
      ],
    },
    {
      title: 'Ⓑ 上漲假說：連 2 日 RSI5<30 ＋ 隔日轉漲',
      dir: 1,
      sets: [
        ['基準（全部交易日）', i => true],
        ['ⓐ 單日 RSI5<30', lo1],
        ['ⓐ+ⓑ 連2日 RSI5<30', lo2],
        ['ⓒ 只有隔日轉漲', i => chg(i) > 0],
        ['單日<30 ∧ 隔日漲（拿掉連2日）', i => lo1(i) && chg(i) > 0],
        ['★連2日<30 ∧ 隔日漲（完整假說）', i => lo2(i) && chg(i) > 0],
        ['連2日<30 ∧ 隔日續跌（被排除那批）', i => lo2(i) && chg(i) <= 0],
      ],
    },
  ];

  const results = {};
  for (const cse of CASES) {
    console.log(`\n${'━'.repeat(104)}\n${cse.title}\n  進場＝T+1 收盤（含確認條件者）；報酬為指數變動%\n${'━'.repeat(104)}`);
    console.log(pad('條件', 36) + padL('次數', 6) + padL('5日均', 9) + padL('10日均', 9) + padL('20日均', 9)
      + padL('20日最大跌', 11) + padL('20日最大漲', 11) + padL(cse.dir < 0 ? '20日跌率' : '20日漲率', 10));
    console.log('─'.repeat(104));
    const R = {};
    for (const [label, cond] of cse.sets) {
      const idx = [];
      for (let i = 15; i < C.length - 20; i++) if (cond(i)) idx.push(i);
      if (!idx.length) { console.log(pad(label, 36) + padL(0, 6)); continue; }
      const f = n => idx.map(i => fwd(i, n)).filter(v => v != null);
      const f20 = f(20);
      R[label] = { n: idx.length, f5: avg(f(5)), f10: avg(f(10)), f20: avg(f20), idx };
      console.log(pad(label, 36) + padL(idx.length, 6)
        + padL(r2(avg(f(5))), 9) + padL(r2(avg(f(10))), 9) + padL(r2(avg(f20)), 9)
        + padL(r2(avg(idx.map(i => maxDD(i, 20)))), 11) + padL(r2(avg(idx.map(i => maxRU(i, 20)))), 11)
        + padL(`${cse.dir < 0 ? wr(f20.map(v => -v)) : wr(f20)}%`, 10));
    }
    results[cse.dir] = R;

    // ── 三個增量檢定：ⓑ 連2日有貢獻嗎？ⓒ 確認有貢獻嗎？整體優於基準嗎？ ──
    const base = R['基準（全部交易日）'];
    const full = Object.entries(R).find(([k]) => k.startsWith('★'))?.[1];
    const one = Object.entries(R).find(([k]) => k.startsWith('單日'))?.[1];
    const two = Object.entries(R).find(([k]) => k.startsWith('ⓐ+ⓑ'))?.[1];
    const onlyC = Object.entries(R).find(([k]) => k.startsWith('ⓒ'))?.[1];
    const want = cse.dir < 0 ? '應為負' : '應為正';
    const ok = v => (cse.dir < 0 ? v < 0 : v > 0);
    console.log('\n  增量檢定（20 日均報酬）：');
    if (full && one) {
      const d = full.f20 - one.f20;
      console.log(`    ⓑ「連2日」的貢獻：完整 ${r2(full.f20)}% − 單日版 ${r2(one.f20)}% = ${r2(d)}pp（${want}）→ ${ok(d) ? '有貢獻' : '**無貢獻/反向**'}`);
    }
    if (full && onlyC) {
      const d = full.f20 - onlyC.f20;
      console.log(`    ⓐⓑ「RSI 條件」的貢獻：完整 ${r2(full.f20)}% − 只有隔日轉向 ${r2(onlyC.f20)}% = ${r2(d)}pp（${want}）→ ${ok(d) ? '有貢獻' : '**無貢獻/反向**'}`);
    }
    if (full && base) {
      const d = full.f20 - base.f20;
      console.log(`    整體 vs 基準：${r2(full.f20)}% − ${r2(base.f20)}% = ${r2(d)}pp（${want}）→ ${ok(d) ? '**方向成立**' : '**方向不成立**'}`);
    }
    if (two && full) {
      const d = full.f20 - two.f20;
      console.log(`    ⓒ「等隔日確認」的代價：完整 ${r2(full.f20)}% − 不等確認 ${r2(two.f20)}% = ${r2(d)}pp（${want}）→ ${ok(d) ? '確認有幫助' : '**等確認反而更差**'}`);
    }

    // 三等分窗穩定性（只對完整假說與不等確認版）
    const third = Math.floor(C.length / 3);
    const seg = (idx, lo, hi) => {
      const a = idx.filter(i => i >= lo && i < hi).map(i => fwd(i, 20)).filter(v => v != null);
      return a.length >= 3 ? `${r2(avg(a))}%(n=${a.length})` : `n=${a.length}`;
    };
    const baseSeg = (lo, hi) => {
      const a = [];
      for (let i = Math.max(15, lo); i < Math.min(hi, C.length - 20); i++) { const v = fwd(i, 20); if (v != null) a.push(v); }
      return `${r2(avg(a))}%`;
    };
    console.log('\n  三等分窗（20 日均）：');
    console.log(`    ${pad('窗口', 10)}${padL('完整假說', 18)}${padL('不等確認版', 18)}${padL('同期基準', 12)}`);
    for (const [lo, hi, lab] of [[0, third, '第1/3'], [third, 2 * third, '第2/3'], [2 * third, C.length, '第3/3']]) {
      console.log(`    ${pad(lab, 10)}${padL(full ? seg(full.idx, lo, hi) : '—', 18)}${padL(two ? seg(two.idx, lo, hi) : '—', 18)}${padL(baseSeg(lo, hi), 12)}`);
    }
  }

  console.log(`\n${'═'.repeat(104)}\n判讀提醒\n${'═'.repeat(104)}`);
  console.log('  · 「ⓑ連2日的貢獻」若接近 0 或反向 ⇒ 加「連 2 日」沒有用，只是把樣本變少。');
  console.log('  · 「ⓒ等確認的代價」若為反向 ⇒ 重演第一版結論：確認型條件會挑掉最好的機會。');
  console.log('  · 三等分窗任一窗反向、或樣本 <20，一律不下結論。');
  console.log('  · 指數不可直接買賣；測的是大盤方向，不是可交易報酬。非投資建議。');
  process.exit(0);
};
main().catch(e => { console.error(e); process.exit(1); });
