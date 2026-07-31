#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 撿尾盤評分權重稽核（2 年·收盤代理）
// 對象：/api/twse/intraday-picks 的五權重（量比30/動能25/位置20/跳空10/體質15）。
// 方法：chipArchive closeJson [收,量,開,高,低] 以「收盤時點」代理尾盤 13:20 狀態，
//   候選=漲 0.5~8.5%、量≥300 張（與線上榜單同濾網）。
//   結果雙口徑：①明日開盤>今收（撿尾盤的原始目標=開高賣）②明日收盤淨報酬(扣0.4425%)。
//   前後半窗皆列，方向不一致者視為不穩。體質分(scoreStock)無法離線重建→僅稽核四價量權重
//   ＋四權重合成分數的分位單調性。非投資建議；本輸出為修正權重的唯一依據。
// 用法：node scripts/audit-tailend.mjs [--days=480]
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const DAYS = +(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || 480);
const COST = 0.4425, MIN_VOL = 300;

function pct(n, d) { return d ? +(n / d * 100).toFixed(1) : null; }
function avg(a) { return a.length ? +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(3) : null; }

async function main() {
  const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(DAYS + 2).get();
  const days = snap.docs.map(d => ({ date: d.id, close: d.data().closeJson ? JSON.parse(d.data().closeJson) : null }))
    .filter(d => d.close && d.close['2330'])
    .sort((a, b) => a.date.localeCompare(b.date));
  console.log(`交易日 ${days.length}（${days[0]?.date} → ${days[days.length - 1]?.date}）`);

  // 樣本：{半窗, volX, chg, pos, gap, score4, openUp, netClose}
  const samples = [];
  for (let i = 1; i < days.length - 1; i++) {
    const half = i < days.length / 2 ? 0 : 1;
    const m0 = days[i - 1].close, m1 = days[i].close, m2 = days[i + 1].close;
    for (const code in m1) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const r = m1[code]; if (!r || r.length < 5) continue;
      const [c, v, o, h, l] = r;
      const p0 = m0?.[code]; const pc = p0?.[0], yv = p0?.[1];
      const n = m2?.[code]; if (!n || n.length < 5) continue;
      const [nc, , no] = n;
      if (!(c > 0 && pc > 0 && nc > 0 && no > 0 && h > l && o > 0)) continue;
      if (!(v >= MIN_VOL)) continue;
      const chg = (c - pc) / pc * 100;
      if (chg < 0.5 || chg > 8.5) continue;                       // 線上榜單同濾網
      const volX = yv > 0 ? v / yv : 0;
      const pos = (c - l) / (h - l);
      const gap = o > pc;
      // 線上四價量分（滿分 85，體質除外）
      const volPart = Math.min(volX / 2.5, 1) * 30;
      const momPart = (chg <= 5 ? chg / 5 : Math.max((8.5 - chg) / 3.5, 0.5)) * 25;
      const score4 = volPart + momPart + pos * 20 + (gap ? 10 : 0);
      samples.push({ half, volX, chg, pos, gap, score4,
        openUp: no > c, netClose: (nc - c) / c * 100 - COST, netOpen: (no - c) / c * 100 - COST });
    }
  }
  console.log(`樣本 ${samples.length.toLocaleString()}（候選濾網：漲0.5~8.5%·量≥${MIN_VOL}張）\n`);

  const stat = arr => arr.length < 200 ? null : ({
    n: arr.length,
    openUp: pct(arr.filter(s => s.openUp).length, arr.length),
    netWin: pct(arr.filter(s => s.netClose > 0).length, arr.length),
    netAvg: avg(arr.map(s => s.netClose)),
    openNet: avg(arr.map(s => s.netOpen)),
  });
  const show = (label, cond) => {
    const a = stat(samples.filter(s => s.half === 0).filter(cond));
    const b = stat(samples.filter(s => s.half === 1).filter(cond));
    const all = stat(samples.filter(cond));
    const f = x => x ? `開高${x.openUp}%·明開賣淨均${x.openNet}%·明收賣淨均${x.netAvg}%·n=${x.n.toLocaleString()}` : '樣本不足';
    console.log(`  ${label.padEnd(18)} 全窗[${f(all)}]  前半[${a ? `${a.openUp}/${a.openNet}/${a.netAvg}` : '-'}]  後半[${b ? `${b.openUp}/${b.openNet}/${b.netAvg}` : '-'}]`);
  };

  console.log('── 基準（全部候選）──');
  show('候選全體', () => true);

  console.log('\n── 量比（宣稱：1.5~3 最佳、>5 爆量利多出盡）──');
  show('volX <1', s => s.volX < 1);
  show('volX 1~1.5', s => s.volX >= 1 && s.volX < 1.5);
  show('volX 1.5~3', s => s.volX >= 1.5 && s.volX < 3);
  show('volX 3~5', s => s.volX >= 3 && s.volX < 5);
  show('volX ≥5', s => s.volX >= 5);

  console.log('\n── 動能漲幅（宣稱：1~7% 甜蜜區）──');
  show('chg 0.5~1', s => s.chg < 1);
  show('chg 1~3', s => s.chg >= 1 && s.chg < 3);
  show('chg 3~5', s => s.chg >= 3 && s.chg < 5);
  show('chg 5~7', s => s.chg >= 5 && s.chg < 7);
  show('chg 7~8.5', s => s.chg >= 7);

  console.log('\n── 收盤位置（宣稱：貼高最佳）──');
  show('pos ≤0.2', s => s.pos <= 0.2);
  show('pos 0.2~0.5', s => s.pos > 0.2 && s.pos < 0.5);
  show('pos 0.5~0.7', s => s.pos >= 0.5 && s.pos < 0.7);
  show('pos 0.7~0.9', s => s.pos >= 0.7 && s.pos < 0.9);
  show('pos ≥0.9', s => s.pos >= 0.9);

  console.log('\n── 跳空開高（宣稱：站上昨收 +10）──');
  show('gap 有', s => s.gap);
  show('gap 無', s => !s.gap);

  console.log('\n── 四價量合成分（滿分85·線上公式）分位單調性 ──');
  const sorted = [...samples].sort((a, b) => a.score4 - b.score4);
  for (let q = 0; q < 5; q++) {
    const lo = sorted[Math.floor(q / 5 * sorted.length)]?.score4, hi = sorted[Math.min(sorted.length - 1, Math.floor((q + 1) / 5 * sorted.length) - 1)]?.score4;
    show(`Q${q + 1} (${lo?.toFixed(0)}~${hi?.toFixed(0)}分)`, s => s.score4 >= lo && (q === 4 ? true : s.score4 <= hi));
  }

  console.log('\n── 線上硬濾網組合（漲≥1%·pos≥0.9·突破5日高 代理=pos≥0.9∧chg≥1∧gap）──');
  show('強組合', s => s.chg >= 1 && s.pos >= 0.9 && s.gap);

  console.log('\n※ 體質分(scoreStock 15%)需線上風險資料無法離線重建，未稽核——後續以 tier 代理另測。');
  console.log('※ 收盤值為尾盤 13:20 的代理（誤差=最後 10 分鐘變動）。非投資建議。');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
