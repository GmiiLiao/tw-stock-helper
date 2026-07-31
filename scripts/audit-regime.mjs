#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Regime 分權重稽核：被 audit-weights 判「兩窗不穩」的訊號（弱尾盤/破高單獨/
// 強尾單獨），假說＝多空市況下方向相反。以「當日市場寬度」(上漲家數比)為
// regime 代理（PIT 安全：當日收盤即知，與 marketHealth.upRatio 同義），
// 分 多頭日(寬度≥50%)/空頭日(<50%) 重新檢定，各 regime 內再看前後半窗穩定性。
// 口徑：今收買→明收賣、扣 0.4425%。若 regime 內兩窗一致才可入 model-core。
// 非投資建議；本輸出為 regime 權重的唯一依據。
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const DAYS = +(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || 480);
const COST = 0.4425, MIN_VOL = 300;
const pct = (n, d) => d ? +(n / d * 100).toFixed(1) : null;
const avg = a => a.length ? +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(3) : null;

async function main() {
  const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(DAYS + 22).get();
  const days = snap.docs.map(d => ({ date: d.id, close: d.data().closeJson ? JSON.parse(d.data().closeJson) : null }))
    .filter(d => d.close && d.close['2330'])
    .sort((a, b) => a.date.localeCompare(b.date));
  console.log(`交易日 ${days.length}（${days[0]?.date} → ${days[days.length - 1]?.date}）`);

  const samples = [];
  let bullDays = 0, bearDays = 0;
  for (let i = 21; i < days.length - 1; i++) {
    const half = i < days.length / 2 ? 0 : 1;
    const m0 = days[i - 1].close, m1 = days[i].close, m2 = days[i + 1].close;
    // 當日市場寬度（上漲家數比·個股 4 碼非 ETF）
    let up = 0, tot = 0;
    for (const code in m1) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const c = m1[code]?.[0], pc = m0?.[code]?.[0];
      if (!(c > 0 && pc > 0)) continue;
      tot++; if (c > pc) up++;
    }
    if (tot < 500) continue;
    const bull = up / tot >= 0.5;
    bull ? bullDays++ : bearDays++;
    // 前 20 日高（不含今日）
    const hi20 = {};
    for (let k = i - 20; k < i; k++) { const m = days[k].close; for (const code in m) { const v = m[code]?.[0]; if (v > (hi20[code] || 0)) hi20[code] = v; } }
    for (const code in m1) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const r = m1[code]; if (!r || r.length < 5) continue;
      const [c, v, , h, l] = r;
      const pc = m0?.[code]?.[0];
      const nc = m2?.[code]?.[0];
      if (!(c > 0 && pc > 0 && nc > 0 && h > l && v >= MIN_VOL)) continue;
      const chg = (c - pc) / pc * 100;
      const pos = (c - l) / (h - l);
      samples.push({ half, bull,
        weak: pos <= 0.2 && Math.abs(chg) > 1,
        strongAlone: pos >= 0.8 && Math.abs(chg) > 1 && !(hi20[code] > 0 && c > hi20[code] && pos >= 0.7),
        brkAlone: hi20[code] > 0 && c > hi20[code] && pos < 0.7,
        brkStrong: hi20[code] > 0 && c > hi20[code] && pos >= 0.7,
        net: (nc - c) / c * 100 - COST });
    }
  }
  console.log(`多頭日 ${bullDays}／空頭日 ${bearDays}·樣本 ${samples.length.toLocaleString()}\n`);

  const stat = arr => arr.length < 300 ? null : ({ n: arr.length, win: pct(arr.filter(s => s.net > 0).length, arr.length), net: avg(arr.map(s => s.net)) });
  const line = (label, cond, regime) => {
    const base = stat(samples.filter(s => s.bull === regime));
    const all = stat(samples.filter(s => s.bull === regime).filter(cond));
    const a = stat(samples.filter(s => s.bull === regime && s.half === 0).filter(cond));
    const b = stat(samples.filter(s => s.bull === regime && s.half === 1).filter(cond));
    if (!all) { console.log(`  ${label.padEnd(12)} 樣本不足`); return; }
    const d = base ? +(all.net - base.net).toFixed(3) : null;
    console.log(`  ${label.padEnd(12)} 淨勝${all.win}%·淨均${all.net}%（vs 基準 ${d > 0 ? '+' : ''}${d}pp）·n=${all.n.toLocaleString()}  前半[${a ? `${a.win}/${a.net}` : '-'}]  後半[${b ? `${b.win}/${b.net}` : '-'}]`);
  };

  for (const regime of [true, false]) {
    const base = stat(samples.filter(s => s.bull === regime));
    console.log(`── ${regime ? '🟢多頭日(寬度≥50%)' : '🔴空頭日(寬度<50%)'} 基準：淨勝${base?.win}%·淨均${base?.net}% ──`);
    line('弱尾盤', s => s.weak, regime);
    line('強尾單獨', s => s.strongAlone, regime);
    line('破高單獨', s => s.brkAlone, regime);
    line('破高×強尾', s => s.brkStrong, regime);
    console.log('');
  }
  console.log('※ regime 內兩窗方向一致者才可入 model-core 條件權重。非投資建議。');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
