#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 五大因子逐項檢定 —— 2026-08-05（使用者：「提高推薦選股，不要亂推薦」）
//
// scoring-server.ts 的 scoreStock() 是站上**唯一沒跑過 bt-core** 的評分器。
// 它每項給 0~20 分，總分 100：
//   ① 動能   chg>7→20 / >4→17 / >2→14 / >0→10 / =0→6 / >-2→4 / else→0
//   ② 量能   成交值 >50億→20 / >10億→17 / >5億→14 / >1億→10 / >5千萬→6 / else→2
//   ③ 收盤位置 pos≥.85→20 / ≥.70→16 / ≥.50→12 / ≥.30→7 / else→3
//   ④ 穩定性 價≥500→18 / ≥100→16 / ≥30→14 / ≥10→10 / else→6
//   ⑤ 價值形態 近漲停(7~9.9)→18 / 漲停→15 / 漲0~5→15 / 跌停→0 / else→12
//
// 兩個一望即知的疑點，先讓資料說話而不是我說：
//   · ①和⑤**都在獎勵今日漲幅**（雙重計分），而⑤給「接近漲停」最高的 18 分
//   · ③貼日高給滿分，但本站 2026-07-19 稽核的結論是「收位≥90% 組隔日實測最差」
//
// 口徑：隔日沖（今收買→明開賣，netOpen）為主；另附 5 日持有（net5）看是否
//       只是窗口不對。全部限可交易宇宙（chg≤8.5，漲停買不到）。
//       兩半窗同號＋第三獨立窗 OOT，皆為 bt-core 內建。
//
// 用法：node scripts/screen-five-factors.mjs
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, report, COST } from './lib/bt-core.mjs';

const MAIN = 480, OOT = 240;

// 成交值（元）≈ 收盤 × 張數 × 1000。scoreStock 用的是 TWSE 的 Trade_Value 欄位，
// 這裡用歸檔重建；量級一致，分桶門檻沿用原始設定。
const value = s => s.c * s.v * 1000;

const FACTORS = {
  '①動能(今日漲幅)': [
    { label: 'chg>7（原給20·最高）', cond: s => s.chg > 7 },
    { label: 'chg 4~7（原17）', cond: s => s.chg > 4 && s.chg <= 7 },
    { label: 'chg 2~4（原14）', cond: s => s.chg > 2 && s.chg <= 4 },
    { label: 'chg 0~2（原10）', cond: s => s.chg > 0 && s.chg <= 2 },
    { label: 'chg -2~0（原4）', cond: s => s.chg > -2 && s.chg <= 0 },
    { label: 'chg<-2（原0·最低）', cond: s => s.chg <= -2 },
  ],
  '②量能(成交值)': [
    { label: '>50億（原20·最高）', cond: s => value(s) > 5e9 },
    { label: '10~50億（原17）', cond: s => value(s) > 1e9 && value(s) <= 5e9 },
    { label: '5~10億（原14）', cond: s => value(s) > 5e8 && value(s) <= 1e9 },
    { label: '1~5億（原10）', cond: s => value(s) > 1e8 && value(s) <= 5e8 },
    { label: '<1億（原6/2·最低）', cond: s => value(s) <= 1e8 },
  ],
  '③收盤位置': [
    { label: 'pos≥0.85（原20·最高）', cond: s => s.pos >= 0.85 },
    { label: 'pos 0.70~0.85（原16）', cond: s => s.pos >= 0.70 && s.pos < 0.85 },
    { label: 'pos 0.50~0.70（原12）', cond: s => s.pos >= 0.50 && s.pos < 0.70 },
    { label: 'pos 0.30~0.50（原7）', cond: s => s.pos >= 0.30 && s.pos < 0.50 },
    { label: 'pos<0.30（原3·最低）', cond: s => s.pos < 0.30 },
  ],
  '④穩定性(股價層級)': [
    { label: '價≥500（原18·最高）', cond: s => s.c >= 500 },
    { label: '價 100~500（原16）', cond: s => s.c >= 100 && s.c < 500 },
    { label: '價 30~100（原14）', cond: s => s.c >= 30 && s.c < 100 },
    { label: '價 10~30（原10）', cond: s => s.c >= 10 && s.c < 30 },
    { label: '價<10（原6·最低）', cond: s => s.c < 10 },
  ],
  '⑤價值形態': [
    { label: '接近漲停 7~9.9（原18·最高）', cond: s => s.chg >= 7 && s.chg < 9.9 },
    { label: '溫和漲 0~5（原15）', cond: s => s.chg > 0 && s.chg < 5 },
    { label: '其他（原12）', cond: s => !(s.chg >= 7) && !(s.chg > 0 && s.chg < 5) && s.chg > -9.9 },
  ],
};

// 現行總分的實際行為：把五項照原規則加總，看高分組是否真的比較好
function realScore(s) {
  const chg = s.chg, val = value(s), pos = s.pos, p = s.c;
  const m = chg > 7 ? 20 : chg > 4 ? 17 : chg > 2 ? 14 : chg > 0 ? 10 : chg === 0 ? 6 : chg > -2 ? 4 : 0;
  let v = val > 5e9 ? 20 : val > 1e9 ? 17 : val > 5e8 ? 14 : val > 1e8 ? 10 : val > 5e7 ? 6 : 2;
  if (chg > 1 && val > 5e8) v = Math.min(v + 3, 20);
  let t = pos >= 0.85 ? 20 : pos >= 0.70 ? 16 : pos >= 0.50 ? 12 : pos >= 0.30 ? 7 : 3;
  if (s.o > s.pc * 1.005 && chg > 1) t = Math.min(t + 2, 20);
  const st = p >= 500 ? 18 : p >= 100 ? 16 : p >= 30 ? 14 : p >= 10 ? 10 : 6;
  const va = chg >= 9.9 ? 15 : (chg >= 7 && chg < 9.9) ? 18 : chg <= -9.9 ? 0 : (chg > 0 && chg < 5) ? 15 : 12;
  return m + v + t + st + va;
}

// 2026-08-05 修正後的評分（與 scoring-server.ts 同步·改完必須回頭重測）
function fixedScore(s) {
  const chg = s.chg, val = value(s), pos = s.pos, p = s.c;
  const m = chg > 8.5 ? 0 : chg >= 3 ? 16 : chg > 0 ? 10 : chg === 0 ? 8 : chg > -2 ? 8 : 6;
  let v = val > 5e9 ? 20 : val > 1e9 ? 17 : val > 5e8 ? 14 : val > 1e8 ? 10 : val > 5e7 ? 6 : 2;
  if (chg > 1 && val > 5e8) v = Math.min(v + 3, 20);
  let t = pos >= 0.85 ? 8 : pos >= 0.70 ? 12 : pos >= 0.50 ? 14 : pos >= 0.30 ? 15 : 16;
  if (s.o > s.pc * 1.005 && chg > 1) t = Math.min(t + 1, 20);
  const st = p >= 500 ? 18 : p >= 100 ? 16 : p >= 30 ? 14 : p >= 10 ? 10 : 6;
  const va = chg >= 9.9 ? 4 : (chg >= 7 && chg < 9.9) ? 8 : chg <= -9.9 ? 0 : (chg > 0 && chg < 5) ? 15 : 12;
  return m + v + t + st + va;
}

const run = async (days, tag) => {
  const S = buildSamples(days).filter(s => s.tradable && s.netOpen != null);
  console.log(`\n${'═'.repeat(78)}\n${tag}｜可交易樣本 ${S.length.toLocaleString()} 筆（${days[0].date} → ${days[days.length - 1].date}）\n${'═'.repeat(78)}`);

  for (const [name, groups] of Object.entries(FACTORS)) {
    report(S, { title: `${name}｜隔日沖（今收買→明開賣·已扣${COST}%）`, groups, minN: 300 });
  }

  // 總分分桶：現行評分器實際排序能力
  const buckets = [
    { label: '總分 ≥85（A+）', cond: s => realScore(s) >= 85 },
    { label: '總分 75~85（A）', cond: s => realScore(s) >= 75 && realScore(s) < 85 },
    { label: '總分 65~75（B）', cond: s => realScore(s) >= 65 && realScore(s) < 75 },
    { label: '總分 50~65（C）', cond: s => realScore(s) >= 50 && realScore(s) < 65 },
    { label: '總分 <50', cond: s => realScore(s) < 50 },
  ];
  report(S, { title: '現行五大因子總分｜隔日沖', groups: buckets, minN: 300 });

  // 修正後總分：檢查①階梯是否恢復單調 ②高分組是否不再是最差
  const fixed = [
    { label: '修正後 ≥85', cond: s => fixedScore(s) >= 85 },
    { label: '修正後 75~85', cond: s => fixedScore(s) >= 75 && fixedScore(s) < 85 },
    { label: '修正後 65~75', cond: s => fixedScore(s) >= 65 && fixedScore(s) < 75 },
    { label: '修正後 50~65', cond: s => fixedScore(s) >= 50 && fixedScore(s) < 65 },
    { label: '修正後 <50', cond: s => fixedScore(s) < 50 },
  ];
  report(S, { title: '★修正後五大因子總分｜隔日沖', groups: fixed, minN: 300 });

  // 同一組但看 5 日持有——排除「只是窗口不對」
  const S5 = S.filter(s => s.net5 != null);
  report(S5.map(s => ({ ...s, netOpen: s.net5 })), { title: '現行五大因子總分｜5 日持有（淨）', groups: buckets, minN: 300 });
};

const main = async () => {
  const all = await loadDays({ days: MAIN + OOT + 5 });
  await run(all.slice(-(MAIN + 62)), `【主窗 ${MAIN} 日·兩半窗內建】`);
  await run(all.slice(0, OOT + 62), `【第三獨立窗 OOT ${OOT} 日】`);
  process.exit(0);
};
main().catch(e => { console.error(e); process.exit(1); });
