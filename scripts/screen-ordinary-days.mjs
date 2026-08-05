#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 第六輪：剔除恐慌日後的「平常日」搜尋 ＋ 第二委員會  —— 2026-08-05
//
// 使用者方法：①除去已知 90% 命中率的那幾天 ②同法建第二種判斷法（參數不同）。
//
// **排除集的定義必須有原則，不能挑日子**（挑掉特定日期＝另一種過擬合）：
//   平常日 ≡ |大盤中位數漲跌| < 2% ∧ 超賣廣度 ≤30檔 ∧ 超買廣度 ≤30檔
//   這會把 2025-04 關稅崩盤、2026-07 修正等**整個恐慌/亢奮狀態**剔除，
//   自然涵蓋先前所有 90%+ 組合的觸發日（它們全靠這些狀態）。
//
// 剔除後的問題變成：**平常日還有沒有可判別的結構？**
//   若有 → 那是與恐慌訊號互補的「第二判斷法」；
//   若命中率全面掉回 5x% → 證明先前高命中全部來自事件，平常日近似隨機。
//
// 第二委員會：同投票法，但在**平常日的前半窗**重選委員（參數自然不同——
//   恐慌類條件在平常日不可能觸發），再用後半窗＋OOT 巢狀驗證。
//
// 口徑：全市場可交易宇宙·扣 0.4425%·5日方向。門檻同前（硬防線）。
// 用法：node scripts/screen-ordinary-days.mjs
// ─────────────────────────────────────────────────────────────────────────
import { loadDays } from './lib/bt-core.mjs';
import { build, P_UP, P_DN, packSide, evalIds, evalVote } from './screen-multiparam-v3.mjs';

const MAIN = 480, OOT = 240, WARM = 65;
const MIN_N = 100, HALF_MIN_N = 50, HIT_HALF = 75, HIT_OOT = 75, HIT_ALL = 80;
const r2 = x => (x == null ? null : +x.toFixed(2));
const pad = (x, n) => String(x).padEnd(n), padL = (x, n) => String(x).padStart(n);

const isOrdinary = s => s.mkt != null && Math.abs(s.mkt) < 2 && s.bLo <= 30 && s.bHi <= 30;

const main = async () => {
  const all = await loadDays({ days: MAIN + OOT + 70 });
  const SM0 = build(all.slice(-(MAIN + WARM)));
  const SO0 = build(all.slice(0, OOT + WARM));
  const SM = SM0.filter(isOrdinary), SO = SO0.filter(isOrdinary);
  const dayCount = S => new Set(S.map(s => s.di)).size;
  console.log('═'.repeat(120));
  console.log('第六輪：平常日搜尋（剔除恐慌/亢奮狀態日）＋第二委員會');
  console.log(`排除定義：|大盤中位| ≥2% 或 超賣廣度>30 或 超買廣度>30 的整個交易日`);
  console.log(`主窗：${dayCount(SM0)} 日 → ${dayCount(SM)} 日（剔 ${dayCount(SM0) - dayCount(SM)} 日）｜樣本 ${SM0.length.toLocaleString()} → ${SM.length.toLocaleString()}`);
  console.log(`OOT ：${dayCount(SO0)} 日 → ${dayCount(SO)} 日（剔 ${dayCount(SO0) - dayCount(SO)} 日）｜樣本 ${SO0.length.toLocaleString()} → ${SO.length.toLocaleString()}`);
  console.log('═'.repeat(120));

  for (const [sideName, pool, dir] of [['上漲判別', P_UP, 1], ['下跌判別', P_DN, -1]]) {
    const pkM = packSide(SM, pool), pkO = packSide(SO, pool);
    const baseM = evalIds({ ...pkM, masks: [new Uint8Array(pkM.N).fill(1)] }, [0], dir);
    const baseO = evalIds({ ...pkO, masks: [new Uint8Array(pkO.N).fill(1)] }, [0], dir);
    console.log(`\n${'━'.repeat(120)}\n【${sideName}·平常日】基準：主窗 ${baseM.hit}%／OOT ${baseO.hit}%\n${'━'.repeat(120)}`);

    const combos = [];
    const np = pool.length;
    for (let i = 0; i < np; i++) {
      combos.push([i]);
      for (let j = i + 1; j < np; j++) {
        if (pool[i][1] === pool[j][1]) continue;
        combos.push([i, j]);
        for (let k = j + 1; k < np; k++) {
          if (pool[k][1] === pool[i][1] || pool[k][1] === pool[j][1]) continue;
          combos.push([i, j, k]);
        }
      }
    }
    const res = [];
    for (const ids of combos) {
      const m = evalIds(pkM, ids, dir);
      if (m && m.n >= MIN_N) res.push({ ids, m });
    }
    const label = ids => ids.map(i => pool[i][0]).join(' ∧ ');
    console.log(`  掃描 ${combos.length.toLocaleString()} 組｜樣本足夠 ${res.length.toLocaleString()} 組`);

    const pass = [];
    for (const r of res) {
      const { m } = r;
      if (m.hit < HIT_ALL || m.n0 < HALF_MIN_N || m.n1 < HALF_MIN_N || m.h0 < HIT_HALF || m.h1 < HIT_HALF) continue;
      const o = evalIds(pkO, r.ids, dir);
      if (!o || o.n < MIN_N || o.hit < HIT_OOT) continue;
      pass.push({ ...r, o });
    }
    const stable = res.filter(r => Math.min(r.m.n0, r.m.n1) >= HALF_MIN_N && r.m.days >= 30)
      .sort((a, b) => b.m.hit - a.m.hit).slice(0, 10);
    console.log('\n  ★平常日·觸發日≥30·主窗命中前 10（附 OOT——OOT 也只算平常日）：');
    for (const r of stable) {
      const o = evalIds(pkO, r.ids, dir);
      console.log(`    ${pad(label(r.ids), 62)} ${r.m.hit}%[${r.m.h0}/${r.m.h1}]·n=${r.m.n.toLocaleString()}·${r.m.days}天`
        + `｜OOT ${o && o.n >= 50 ? `${o.hit}%·n=${o.n}` : '不足'}｜均報 ${r2(r.m.ret)}%`);
    }
    console.log(`\n  ✅ 通過全部門檻：${pass.length} 組`);
    for (const p2 of pass.slice(0, 10)) {
      console.log(`    ${pad(label(p2.ids), 60)} 主窗 ${p2.m.hit}%[${p2.m.h0}/${p2.m.h1}]·n=${p2.m.n}·${p2.m.days}天`
        + `  OOT ${p2.o.hit}%·n=${p2.o.n}  均報 ${r2(p2.m.ret)}%`);
    }
    if (!pass.length) console.log('    （無）');

    // ── 第二委員會（平常日版·巢狀）──
    const singles = [];
    for (let i = 0; i < np; i++) {
      const m = evalIds(pkM, [i], dir);
      if (m && m.n0 >= 300) singles.push({ i, h0: m.h0 });
    }
    const comm2 = singles.sort((a, b) => b.h0 - a.h0).slice(0, 10).map(x => x.i);
    console.log(`\n  🗳️第二委員會（**平常日前半窗**選出·與恐慌委員會自然不同）：`);
    console.log(`    委員：${comm2.map(i => pool[i][0]).join('、')}`);
    console.log('    考場＝後半窗（選時沒看過）＋ OOT：');
    for (const need of [4, 5, 6, 7]) {
      const m = evalVote(pkM, comm2, need, dir);
      if (!m || m.n1 < 30) { console.log(`    ≥${need}票：後半窗樣本不足`); continue; }
      const o = evalVote(pkO, comm2, need, dir);
      console.log(`    ≥${need}票  後半窗 ${m.h1}%(n=${m.n1})·全窗 ${m.hit}%·${m.days}天`
        + `｜OOT ${o && o.n >= 30 ? `${o.hit}%·n=${o.n}·${o.days}天` : '不足'}｜均報 ${r2(m.ret)}%`);
    }
  }
  console.log(`\n${'═'.repeat(120)}\n平常日＝恐慌訊號的補集。此處若無結構，代表先前高命中全數來自事件。非投資建議。\n${'═'.repeat(120)}`);
  process.exit(0);
};
main().catch(e => { console.error(e); process.exit(1); });
