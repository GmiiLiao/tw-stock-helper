#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 使用者假說檢定：大盤 RSI 極端 ＋ 隔日轉向 → 大跌/大漲開始  —— 2026-08-05
//
// 假說原文：
//   Ⓐ RSI5>90 且 RSI10>85，且**下個交易日大盤轉跌** → 大跌開始
//   Ⓑ RSI5<20 且 RSI10<30，且**下個交易日大盤轉漲** → 大漲開始
//
// ⚠**這是「複合條件」，必須拆開測**（本站栽過兩次：MA20溫吞區＝波動代理、
//   KD交叉＝不破底代理）。條件由兩塊組成：
//     ① RSI 極端（在 T 日觀察到）
//     ② 隔日轉向（在 T+1 日才知道）
//   如果不拆，會分不出功勞屬於「RSI 抓到極端」還是「單純的隔日動能延續」
//   ——後者是眾所周知的效應，不需要 RSI 也成立。
//   所以四組都測：baseline / 只有① / 只有② / ①∧②（使用者的完整假說）。
//
// ⚠**確認型訊號的代價是遲到**（本站 KD 黃金交叉檢定的既有教訓）：
//   條件②要等 T+1 收盤才知道，所以進場只能在 T+1 收盤，
//   T+1 當天的跌幅**你沒賺到／沒躲掉**。本腳本一律從 T+1 收盤起算，
//   不從 T 日收盤起算——那會是看到未來。
//
// 口徑：加權指數 ^TWII 日線（Yahoo，單次請求）。報酬為指數本身的變動%
//   （指數不能直接買，此處測的是「大盤方向」而非可交易報酬，故不扣費稅）。
// 用法：node scripts/screen-index-rsi-turn.mjs
// ─────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';

const CACHE = path.join(process.env.TMPDIR || '/tmp', 'twii-daily.json');
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const r2 = x => (x == null ? null : +x.toFixed(2));
const wr = a => (a.length ? +(a.filter(v => v > 0).length / a.length * 100).toFixed(1) : null);
const pad = (x, n) => String(x).padEnd(n), padL = (x, n) => String(x).padStart(n);

async function loadTwii() {
  if (fs.existsSync(CACHE)) {
    const j = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (j?.bars?.length > 500) return j.bars;
  }
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?interval=1d&range=10y';
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  const ts = res?.timestamp || [], q = res?.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i], h = q.high?.[i], l = q.low?.[i], o = q.open?.[i];
    if (!(c > 0)) continue;
    bars.push({ d: new Date(ts[i] * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }), o, h, l, c });
  }
  fs.writeFileSync(CACHE, JSON.stringify({ bars, at: Date.now() }));
  return bars;
}

/** Wilder RSI（與站上 checkAlerts 的 _liveRsi 同法） */
function rsi(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  g /= period; l /= period;
  out[period] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (period - 1) + (d > 0 ? d : 0)) / period;
    l = (l * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

const main = async () => {
  const bars = await loadTwii();
  const C = bars.map(b => b.c);
  const R5 = rsi(C, 5), R10 = rsi(C, 10);
  console.log('═'.repeat(100));
  console.log(`加權指數 ^TWII 日線：${bars.length} 根（${bars[0].d} → ${bars[bars.length - 1].d}）`);
  console.log(`  最新收盤 ${r2(C[C.length - 1])}（對帳用：站上 marketIndex 今日收盤 44611.6）`);
  console.log(`  今日 RSI5 ${r2(R5[R5.length - 1])} / RSI10 ${r2(R10[R10.length - 1])}`);
  console.log('═'.repeat(100));

  // 進場一律在 T+1 收盤（條件②要等 T+1 才知道）；報酬＝T+1 收盤起算
  const fwd = (i, n) => (i + n < C.length ? (C[i + n] - C[i]) / C[i] * 100 : null);
  const maxDD = (i, n) => {           // T+1 收盤起 n 日內的最大跌幅（相對進場價）
    let mn = 0;
    for (let k = 1; k <= n && i + k < C.length; k++) mn = Math.min(mn, (C[i + k] - C[i]) / C[i] * 100);
    return mn;
  };
  const maxRU = (i, n) => {
    let mx = 0;
    for (let k = 1; k <= n && i + k < C.length; k++) mx = Math.max(mx, (C[i + k] - C[i]) / C[i] * 100);
    return mx;
  };
  const chg = i => (i > 0 ? (C[i] - C[i - 1]) / C[i - 1] * 100 : null);

  // ── 四組定義（i 為 T+1 的索引，也就是實際進場日）──
  const GROUPS = {
    bear: {
      title: 'Ⓐ 大跌假說：RSI5>90 ∧ RSI10>85，且隔日大盤轉跌',
      dir: -1,
      sets: {
        '基準（全部交易日）': i => i >= 15,
        '① 只有 RSI 極端（T日 RSI5>90∧RSI10>85）': i => i >= 15 && R5[i - 1] > 90 && R10[i - 1] > 85,
        '② 只有隔日轉跌（T+1 大盤下跌）': i => i >= 15 && chg(i) < 0,
        '①∧② 使用者的完整假說': i => i >= 15 && R5[i - 1] > 90 && R10[i - 1] > 85 && chg(i) < 0,
        '①∧隔日續漲（被假說排除的那批）': i => i >= 15 && R5[i - 1] > 90 && R10[i - 1] > 85 && chg(i) >= 0,
        '放寬門檻 RSI5>85∧RSI10>80 ∧隔日跌': i => i >= 15 && R5[i - 1] > 85 && R10[i - 1] > 80 && chg(i) < 0,
      },
    },
    bull: {
      title: 'Ⓑ 大漲假說：RSI5<20 ∧ RSI10<30，且隔日大盤轉漲',
      dir: 1,
      sets: {
        '基準（全部交易日）': i => i >= 15,
        '① 只有 RSI 極端（T日 RSI5<20∧RSI10<30）': i => i >= 15 && R5[i - 1] != null && R5[i - 1] < 20 && R10[i - 1] < 30,
        '② 只有隔日轉漲（T+1 大盤上漲）': i => i >= 15 && chg(i) > 0,
        '①∧② 使用者的完整假說': i => i >= 15 && R5[i - 1] != null && R5[i - 1] < 20 && R10[i - 1] < 30 && chg(i) > 0,
        '①∧隔日續跌（被假說排除的那批）': i => i >= 15 && R5[i - 1] != null && R5[i - 1] < 20 && R10[i - 1] < 30 && chg(i) <= 0,
      },
    },
  };

  for (const g of Object.values(GROUPS)) {
    console.log(`\n${'━'.repeat(100)}\n${g.title}\n  進場＝T+1 收盤（條件要等 T+1 才知道，不可從 T 日收盤起算＝看未來）\n${'━'.repeat(100)}`);
    console.log(pad('條件', 40) + padL('次數', 6) + padL('5日均', 9) + padL('10日均', 9) + padL('20日均', 9)
      + padL('20日最大跌', 11) + padL('20日最大漲', 11) + padL(g.dir < 0 ? '20日跌%' : '20日漲%', 9));
    console.log('─'.repeat(100));
    const rows = {};
    for (const [label, cond] of Object.entries(g.sets)) {
      const idx = [];
      for (let i = 15; i < C.length - 20; i++) if (cond(i)) idx.push(i);
      if (!idx.length) { console.log(pad(label, 40) + padL(0, 6)); continue; }
      const f5 = idx.map(i => fwd(i, 5)).filter(v => v != null);
      const f10 = idx.map(i => fwd(i, 10)).filter(v => v != null);
      const f20 = idx.map(i => fwd(i, 20)).filter(v => v != null);
      const dd = idx.map(i => maxDD(i, 20));
      const ru = idx.map(i => maxRU(i, 20));
      const hit = g.dir < 0 ? wr(f20.map(v => -v)) : wr(f20);
      rows[label] = { n: idx.length, f5: avg(f5), f10: avg(f10), f20: avg(f20), dd: avg(dd), ru: avg(ru), hit, idx };
      console.log(pad(label, 40) + padL(idx.length, 6)
        + padL(r2(avg(f5)), 9) + padL(r2(avg(f10)), 9) + padL(r2(avg(f20)), 9)
        + padL(r2(avg(dd)), 11) + padL(r2(avg(ru)), 11) + padL(`${hit}%`, 9));
    }

    // 增量檢定：①∧② 是否優於「只有②」——這才是 RSI 有沒有貢獻的關鍵
    const full = rows['①∧② 使用者的完整假說'], only2 = Object.entries(rows).find(([k]) => k.startsWith('②'))?.[1];
    const base = rows['基準（全部交易日）'];
    if (full && only2 && base) {
      console.log(`\n  增量檢定（RSI 到底有沒有貢獻）：`);
      console.log(`    完整假說 20日均 ${r2(full.f20)}%  vs  只有隔日轉向 ${r2(only2.f20)}%  vs  基準 ${r2(base.f20)}%`);
      const incr = full.f20 - only2.f20;
      console.log(`    ⇒ 加上 RSI 條件的增量：${r2(incr)}pp（${g.dir < 0 ? '應為負才算有效' : '應為正才算有效'}）`
        + ` → ${(g.dir < 0 ? incr < 0 : incr > 0) ? '方向符合' : '**方向不符**'}`);
      // 兩半窗
      const half = Math.floor(C.length / 2);
      const h = arr => {
        const a = arr.filter(i => i < half).map(i => fwd(i, 20)).filter(v => v != null);
        const b = arr.filter(i => i >= half).map(i => fwd(i, 20)).filter(v => v != null);
        return [a.length >= 3 ? r2(avg(a)) : `n=${a.length}`, b.length >= 3 ? r2(avg(b)) : `n=${b.length}`];
      };
      const hh = h(full.idx);
      console.log(`    兩半窗 20日均：[${hh[0]} / ${hh[1]}]（樣本太少時直接標 n）`);
    }
  }

  // ── 等確認的代價：① 的條件在 T 日收盤就完全已知，合法進場點是 T 日 ──
  console.log(`\n${'━'.repeat(100)}\n【等確認的代價】RSI 條件在 T 日收盤就已知 ⇒ 合法進場點是 T 日，不必等 T+1\n${'━'.repeat(100)}`);
  console.log(pad('進場方式', 44) + padL('次數', 6) + padL('5日均', 9) + padL('10日均', 9) + padL('20日均', 9) + padL('20日勝', 9));
  console.log('─'.repeat(86));
  const variants = [
    ['超賣 RSI5<20∧RSI10<30｜T日收盤就進', i => R5[i] != null && R5[i] < 20 && R10[i] < 30, 0],
    ['超賣同上｜等隔日轉漲確認才進（使用者版）', i => R5[i - 1] != null && R5[i - 1] < 20 && R10[i - 1] < 30 && chg(i) > 0, 0],
    ['超買 RSI5>90∧RSI10>85｜T日收盤就進', i => R5[i] > 90 && R10[i] > 85, 0],
    ['超買同上｜等隔日轉跌確認才進（使用者版）', i => R5[i - 1] > 90 && R10[i - 1] > 85 && chg(i) < 0, 0],
  ];
  for (const [label, cond] of variants) {
    const idx = [];
    for (let i = 15; i < C.length - 20; i++) if (cond(i)) idx.push(i);
    if (!idx.length) { console.log(pad(label, 44) + padL(0, 6)); continue; }
    const f5 = idx.map(i => fwd(i, 5)).filter(v => v != null);
    const f10 = idx.map(i => fwd(i, 10)).filter(v => v != null);
    const f20 = idx.map(i => fwd(i, 20)).filter(v => v != null);
    console.log(pad(label, 44) + padL(idx.length, 6) + padL(r2(avg(f5)), 9) + padL(r2(avg(f10)), 9)
      + padL(r2(avg(f20)), 9) + padL(`${wr(f20)}%`, 9));
  }

  console.log(`\n${'═'.repeat(100)}\n判讀提醒\n${'═'.repeat(100)}`);
  console.log('  · 若「①∧②」與「只有②」差不多 ⇒ 功勞在**隔日轉向**（動能延續），RSI 沒有增量。');
  console.log('  · 若「①」單獨就有效 ⇒ 不需要等隔日確認，等確認反而遲到。');
  console.log('  · 次數太少（<20）的組別一律不下結論——指數層級的極端 RSI 本來就罕見。');
  console.log('  · 指數不可直接買賣；此處測的是大盤方向，不是可交易報酬。非投資建議。');
  process.exit(0);
};
main().catch(e => { console.error(e); process.exit(1); });
