#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 空頭日是「訊號增益」還是「市場擇時」？—— 2026-08-05 成分拆解
//
// 觀察到的現象：本站多個互不相關的短線訊號都在空頭日才成立——
//   波段起漲（空頭日 gate）、超跌反彈（空頭市況更強）、
//   推薦榜前 5 名（空頭日 +0.233%/+0.165%，是 65 組濾網中最接近正報酬者）。
// 很容易得到一個漂亮結論：「空頭日會放大所有訊號」。
//
// **但這正是本站栽過兩次的陷阱**（MA20 溫吞區＝波動代理、KD交叉＝不破底代理）：
//   複合現象一定要拆開，否則會把功勞算在錯的變數上。這裡有兩個競爭假說：
//
//   Ⓗ1 市場擇時：空頭日的**隔日全市場就是反彈的**。
//       那麼任何訊號在空頭日都會變好，跟訊號本身無關——
//       真正該講的是「空頭日隔天買什麼都比較好」，而不是「訊號更準」。
//   Ⓗ2 訊號增益：空頭日時，訊號**相對基準的超額 Δ 也變大**。
//       這才是「空頭日讓訊號更有效」。
//
//   兩者可以同時成立，也可以只成立一個。判別方式：
//     · 看 baseline（可交易宇宙等權）隨大盤漲跌分桶的走勢 → 檢驗 Ⓗ1
//     · 看各訊號的 Δ 隨同一分桶的走勢 → 檢驗 Ⓗ2
//
// 口徑：隔日沖 今收買→明開賣·扣 0.4425%；可交易宇宙 chg≤8.5。
//       主窗 480 日與第三獨立窗 240 日分開跑，兩窗一致才算數。
// 用法：node scripts/screen-bearday-amplifier.mjs
// ─────────────────────────────────────────────────────────────────────────
import { loadDays } from './lib/bt-core.mjs';
import { build, fiveFixed, validated } from './screen-recommend-rank.mjs';

const MAIN = 480, OOT = 240, WARM = 62;
const r3 = x => (x == null ? null : +x.toFixed(3));
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const wr = a => (a.length ? +(a.filter(v => v > 0).length / a.length * 100).toFixed(1) : null);
const KEY = s => fiveFixed(s) + validated(s) * 3;

// 大盤分桶（當日可交易宇宙中位數漲幅·收盤即知＝PIT 安全）
const BUCKETS = [
  { label: '大跌 ≤-1.5%', lo: -99, hi: -1.5 },
  { label: '中跌 -1.5~-0.5%', lo: -1.5, hi: -0.5 },
  { label: '小跌 -0.5~0%', lo: -0.5, hi: 0 },
  { label: '小漲 0~0.5%', lo: 0, hi: 0.5 },
  { label: '中漲 0.5~1.5%', lo: 0.5, hi: 1.5 },
  { label: '大漲 ≥1.5%', lo: 1.5, hi: 99 },
];

// 受測訊號：刻意選**互不相關**的三個，看是不是一起被放大
const SIGNALS = {
  '推薦榜前5（Ⓒ排序）': { topN: 5 },
  '破高×強尾×漲3~7%': { cond: s => s.brk20 && s.pos >= 0.7 && s.chg >= 3 && s.chg <= 7 },
  '低波動避開後的高分群': { cond: s => (s.vol20 ?? 0) >= 1.5 && KEY(s) >= 78 },
  '超跌（收位<0.3×跌>2%）': { cond: s => s.pos < 0.3 && s.chg <= -2 },
};

function bucketOf(mktChg) {
  if (mktChg == null) return null;
  return BUCKETS.find(b => mktChg > b.lo && mktChg <= b.hi) || null;
}

/** 每日取前 N（topN 型）或直接條件過濾（cond 型） */
function pick(dayArr, sig) {
  if (sig.topN) return [...dayArr].sort((a, b) => KEY(b) - KEY(a)).slice(0, sig.topN);
  return dayArr.filter(sig.cond);
}

function analyse(samples, tag) {
  console.log(`\n${'═'.repeat(104)}\n${tag}\n${'═'.repeat(104)}`);
  const byDay = {};
  for (const s of samples) (byDay[s.di] ||= []).push(s);
  const days = Object.values(byDay);

  // ── Ⓗ1：baseline（全宇宙等權）隨大盤分桶 ──
  console.log('\nⒽ1 市場擇時檢驗｜隔日全市場（可交易宇宙等權·明開賣扣費稅）');
  const pad = (x, n) => String(x).padEnd(n), padL = (x, n) => String(x).padStart(n);
  console.log('  ' + pad('今日大盤', 20) + padL('隔日基準淨均', 14) + padL('基準淨勝', 10) + padL('交易日數', 10) + padL('樣本', 10));
  console.log('  ' + '─'.repeat(64));
  const baseByBucket = {};
  for (const b of BUCKETS) {
    const ds = days.filter(d => bucketOf(d[0].mktChg) === b);
    const rets = ds.flatMap(d => d.map(s => s.netOpen));
    if (rets.length < 500) { console.log('  ' + pad(b.label, 20) + padL('樣本不足', 14)); continue; }
    baseByBucket[b.label] = avg(rets);
    console.log('  ' + pad(b.label, 20) + padL(`${r3(avg(rets))}%`, 14) + padL(`${wr(rets)}%`, 10)
      + padL(ds.length, 10) + padL(rets.length.toLocaleString(), 10));
  }

  // ── Ⓗ2：各訊號的超額 Δ 隨同一分桶 ──
  console.log('\nⒽ2 訊號增益檢驗｜各訊號相對「同分桶基準」的超額 Δ（Δ 隨跌幅變大才算增益）');
  console.log('  ' + pad('訊號', 26) + BUCKETS.map(b => padL(b.label.split(' ')[0], 11)).join(''));
  console.log('  ' + '─'.repeat(26 + 11 * BUCKETS.length));
  for (const [name, sig] of Object.entries(SIGNALS)) {
    let line = '  ' + pad(name, 26);
    const abs = [];
    for (const b of BUCKETS) {
      const ds = days.filter(d => bucketOf(d[0].mktChg) === b);
      const sel = ds.flatMap(d => pick(d, sig).map(s => s.netOpen));
      const base = baseByBucket[b.label];
      if (sel.length < 150 || base == null) { line += padL('—', 11); abs.push(null); continue; }
      line += padL(`${r3(avg(sel) - base)}`, 11);
      abs.push(r3(avg(sel)));
    }
    console.log(line);
    console.log('  ' + pad('  └絕對淨均%', 26) + abs.map(x => padL(x == null ? '—' : x, 11)).join(''));
  }
}

const main = async () => {
  const all = await loadDays({ days: MAIN + OOT + 5 });
  analyse(build(all.slice(-(MAIN + WARM))), `【主窗 ${MAIN} 日】`);
  analyse(build(all.slice(0, OOT + WARM)), `【第三獨立窗 OOT ${OOT} 日】`);
  console.log(`\n${'═'.repeat(104)}`);
  console.log('判讀方式：');
  console.log('  · Ⓗ1 那張表若「跌幅越大 → 隔日基準淨均越高」＝**空頭日的效果主要是市場擇時**，');
  console.log('    該講的是「大跌隔天全市場反彈」，不是「訊號更準」。');
  console.log('  · Ⓗ2 那張表若 Δ 也隨跌幅單調變大＝訊號本身**額外**被放大（兩者可並存）。');
  console.log('  · 兩窗方向必須一致；只有主窗成立的一律不採信。');
  console.log('═'.repeat(104));
  process.exit(0);
};
main().catch(e => { console.error(e); process.exit(1); });
