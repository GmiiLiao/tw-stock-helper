#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 推薦榜「絕對正報酬」濾網搜尋 —— 2026-08-05
//
// 現況：排序鍵 Ⓒ 的**超額**四個半窗全正（比隨便買好），但**絕對淨報酬**
//   只有主窗為正（+0.115%）、第三獨立窗約打平（-0.001%）。
//   對使用者而言「比隨便買好」但不賺錢，仍然是不該推的單。
//
// 本腳本問的是一個更嚴格的問題：
//   **有沒有一組濾網，能讓絕對淨報酬在主窗與 OOT 都為正、且兩半窗同號？**
//   有 → 推薦榜就用那組，寧可每天只出 3 檔或空榜。
//   沒有 → 就誠實地說「今日無符合實證標準的推薦」，不要硬湊 20 檔。
//   （與本站既有原則一致：空榜是常態，不是故障。）
//
// 口徑：隔日沖 今收買→明開賣，已扣 0.4425% 來回費稅；可交易宇宙 chg≤8.5。
// 用法：node scripts/screen-recommend-gate.mjs
// ─────────────────────────────────────────────────────────────────────────
import { loadDays } from './lib/bt-core.mjs';
import { build, fiveFixed, validated } from './screen-recommend-rank.mjs';

const MAIN = 480, OOT = 240, WARM = 62;
// 2026-09-30：GROSS=1 ⇒ 以未扣成本報酬重跑（bt-core 的 netOpen 已扣 0.4425%，這裡加回；bt-core 本身不動）
const ADD_BACK = process.env.GROSS === '1' ? 0.4425 : 0;
const ret = s => s.netOpen + ADD_BACK;
const r3 = x => (x == null ? null : +x.toFixed(3));
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const wr = a => (a.length ? +(a.filter(v => v > 0).length / a.length * 100).toFixed(1) : null);
const KEY = s => fiveFixed(s) + validated(s) * 3;

/** 每日先過硬門檻，再取前 N 名（N=0 代表不限名次、全收） */
function select(samples, { gate, N, minKey }) {
  const byDay = {};
  for (const s of samples) (byDay[s.di] ||= []).push(s);
  const picked = [];
  let days = 0, emptyDays = 0;
  for (const di in byDay) {
    days++;
    let arr = byDay[di].filter(gate);
    if (minKey != null) arr = arr.filter(s => KEY(s) >= minKey);
    arr = [...arr].sort((a, b) => KEY(b) - KEY(a));
    if (N) arr = arr.slice(0, N);
    if (!arr.length) emptyDays++;
    picked.push(...arr);
  }
  return { picked, days, emptyDays };
}

function evalRule(samples, rule) {
  const halves = [0, 1].map(hf => {
    const { picked } = select(samples.filter(s => s.half === hf), rule);
    return { net: avg(picked.map(ret)), n: picked.length };
  });
  const { picked, days, emptyDays } = select(samples, rule);
  if (!picked.length) return null;
  const net = avg(picked.map(ret));
  const bothPos = halves[0].net > 0 && halves[1].net > 0;
  return {
    net: r3(net), halves: halves.map(h => r3(h.net)), win: wr(picked.map(ret)),
    n: picked.length, perDay: +(picked.length / days).toFixed(1),
    emptyPct: +(emptyDays / days * 100).toFixed(0), bothPos,
  };
}

const GATES = {
  '無（只用排序）': () => true,
  'adj≥0（無避開訊號）': s => validated(s) >= 0,
  'adj>0（有正向訊號）': s => validated(s) > 0,
  '破高×強尾': s => s.brk20 && s.pos >= 0.7,
  '破高×強尾×漲3~7%': s => s.brk20 && s.pos >= 0.7 && s.chg >= 3 && s.chg <= 7,
  '破高×強尾×adj≥0': s => s.brk20 && s.pos >= 0.7 && validated(s) >= 0,
  '破高×強尾×vol20≥1.5': s => s.brk20 && s.pos >= 0.7 && (s.vol20 ?? 0) >= 1.5,
  '破高×強尾×漲3~7×vol≥1.5': s => s.brk20 && s.pos >= 0.7 && s.chg >= 3 && s.chg <= 7 && (s.vol20 ?? 0) >= 1.5,
  // regime 維度：本站的波段起漲就是「空頭日限定」才成立，推薦榜也該試一次。
  // 空頭日定義＝當日可交易宇宙中位數漲幅 <0（收盤即知·PIT 安全）。
  '空頭日': s => (s.mktChg ?? 0) < 0,
  '空頭日×adj≥0': s => (s.mktChg ?? 0) < 0 && validated(s) >= 0,
  '空頭日×破高強尾漲3~7': s => (s.mktChg ?? 0) < 0 && s.brk20 && s.pos >= 0.7 && s.chg >= 3 && s.chg <= 7,
  '空頭日×破高強尾×vol≥1.5': s => (s.mktChg ?? 0) < 0 && s.brk20 && s.pos >= 0.7 && (s.vol20 ?? 0) >= 1.5,
  '多頭日×破高強尾漲3~7': s => (s.mktChg ?? 0) >= 0 && s.brk20 && s.pos >= 0.7 && s.chg >= 3 && s.chg <= 7,
};

const main = async () => {
  const all = await loadDays({ days: MAIN + OOT + 5 });
  const W = { 主窗: build(all.slice(-(MAIN + WARM))), OOT: build(all.slice(0, OOT + WARM)) };
  for (const k in W) console.log(`${k} 可交易樣本 ${W[k].length.toLocaleString()}｜基準${ADD_BACK ? '均報（未扣成本）' : '淨均'} ${r3(avg(W[k].map(ret)))}%`);

  const pad = (x, n) => String(x).padEnd(n), padL = (x, n) => String(x).padStart(n);
  const Ns = [0, 3, 5, 10, 20];

  console.log(`\n${'═'.repeat(112)}`);
  console.log('目標：**主窗與 OOT 的絕對淨報酬都 >0，且各自兩半窗同為正**（不是只比基準好）');
  console.log('═'.repeat(112));
  console.log(pad('濾網', 26) + padL('每日檔數', 9)
    + padL('主窗淨均', 10) + padL('主窗兩半', 18) + padL('主窗勝', 8)
    + padL('OOT淨均', 10) + padL('OOT兩半', 18) + padL('OOT勝', 7) + '  判定');
  console.log('─'.repeat(112));

  const winners = [];
  for (const [gname, gate] of Object.entries(GATES)) {
    for (const N of Ns) {
      const m = evalRule(W['主窗'], { gate, N });
      const o = evalRule(W['OOT'], { gate, N });
      if (!m || !o || m.n < 300 || o.n < 200) continue;
      const pass = m.bothPos && o.bothPos;
      const label = `${gname}${N ? `·前${N}` : '·全收'}`;
      console.log(pad(label, 26) + padL(m.perDay, 9)
        + padL(`${m.net}%`, 10) + padL(`[${m.halves[0]}/${m.halves[1]}]`, 18) + padL(`${m.win}%`, 8)
        + padL(`${o.net}%`, 10) + padL(`[${o.halves[0]}/${o.halves[1]}]`, 18) + padL(`${o.win}%`, 7)
        + '  ' + (pass ? '✅四半窗全正' : m.net > 0 && o.net > 0 ? '△兩窗均正但半窗有負' : '❌'));
      if (pass) winners.push({ label, m, o, gname, N });
    }
  }

  console.log(`\n${'═'.repeat(112)}\n結論\n${'═'.repeat(112)}`);
  if (!winners.length) {
    console.log('  ✖ **沒有任何組合達到「四個半窗全正」**。');
    console.log('    ⇒ 推薦榜不應宣稱能穩定賺錢；產品端該做的是誠實揭露超額而非絕對報酬，');
    console.log('      並保留「今日無符合實證標準」的空榜可能，而不是硬湊名額。');
  } else {
    console.log(`  ✅ ${winners.length} 組達標，依 OOT 淨均排序：`);
    winners.sort((a, b) => b.o.net - a.o.net);
    for (const w of winners.slice(0, 8)) {
      console.log(`    ${w.label.padEnd(26)} 主窗 ${w.m.net}%[${w.m.halves}]·勝${w.m.win}%  OOT ${w.o.net}%[${w.o.halves}]·勝${w.o.win}%  每日約 ${w.m.perDay} 檔`);
    }
    console.log('\n  ⚠ 選用前必看：每日檔數太少代表樣本重疊高、且實務上常常空榜；');
    console.log('    空榜是正常結果，不要為了湊名額放寬條件——那就回到「亂推薦」了。');
  }
  process.exit(0);
};
main().catch(e => { console.error(e); process.exit(1); });
