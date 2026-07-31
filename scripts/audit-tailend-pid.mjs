#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 資券借券 → 線性 PID 濾波權重測試（撿尾盤定版濾網池內）
// 假說（使用者提出）：單日二值門檻把雜訊當訊號；先「約束」（日變化÷昨量、
// 限幅 ±5% 量）再過線性 PID（P=當日、I=λ衰減積分=趨勢、D=一階差分）收斂後，
// 或可浮現穩定方向訊號。
// 檢定：池內按 PID 輸出五分位 → 明開賣淨均是否單調、前後半窗是否同向。
// 資料：chipArchive marginJson[資餘,券餘]（~708日）/lendingJson（~185日），
// 一律 t-1 前(含)的序列（PIT 安全）。非投資建議；本輸出為權重取捨唯一依據。
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const DAYS = +(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || 480);
const COST = 0.4425, MIN_VOL = 300;
const LOOKBACK = 10;          // PID 輸入序列長度（t-10 ~ t-1）
const CLAMP_IN = 0.05;        // 約束①：單日變化限幅 ±5% 昨量
const LAMBDA = 0.7;           // 積分衰減（防 windup）
const CLAMP_OUT = 0.1;        // 約束②：PID 輸出限幅
const avg = a => a.length ? +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(3) : null;

// 線性 PID：輸入正規化序列 xs（舊→新），回傳末端輸出
function pid(xs, Kp, Ki, Kd) {
  let I = 0, prev = 0, u = 0;
  for (let k = 0; k < xs.length; k++) {
    const x = xs[k];
    I = LAMBDA * I + x;
    u = Kp * x + Ki * I + Kd * (x - (k ? prev : x));
    prev = x;
  }
  return Math.max(-CLAMP_OUT, Math.min(CLAMP_OUT, u));
}

async function main() {
  const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(DAYS + 22).get();
  const days = snap.docs.map(d => ({ date: d.id,
    close: d.data().closeJson ? JSON.parse(d.data().closeJson) : null,
    mg: d.data().marginJson ? JSON.parse(d.data().marginJson) : null,
    ln: d.data().lendingJson ? JSON.parse(d.data().lendingJson) : null }))
    .filter(d => d.close && d.close['2330'])
    .sort((a, b) => a.date.localeCompare(b.date));
  console.log(`交易日 ${days.length}（${days[0]?.date} → ${days[days.length - 1]?.date}）`);
  console.log(`約束：輸入限幅±${CLAMP_IN * 100}%量·積分衰減λ=${LAMBDA}·輸出限幅±${CLAMP_OUT}·lookback=${LOOKBACK}\n`);

  // 定版濾網池樣本（同 audit-tailend-filter），附三條 PID 輸入序列
  const samples = [];
  for (let i = 21; i < days.length - 1; i++) {
    const half = i < days.length / 2 ? 0 : 1;
    const m0 = days[i - 1].close, m1 = days[i].close, m2 = days[i + 1].close;
    const hi20 = {};
    for (let k = i - 20; k < i; k++) { const m = days[k].close; for (const code in m) { const v = m[code]?.[0]; if (v > (hi20[code] || 0)) hi20[code] = v; } }
    for (const code in m1) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const r = m1[code]; if (!r || r.length < 5) continue;
      const [c, v, o, h, l] = r;
      const pc = m0?.[code]?.[0];
      const n = m2?.[code]; if (!n || n.length < 5) continue;
      const no = n[2];
      if (!(c > 0 && pc > 0 && no > 0 && h > l && o > 0 && v >= MIN_VOL)) continue;
      const chg = (c - pc) / pc * 100;
      const pos = (c - l) / (h - l);
      if (!(hi20[code] > 0 && c > hi20[code] && pos >= 0.7 && chg >= 3 && chg <= 7)) continue; // 定版濾網
      // PID 輸入序列（t-LOOKBACK ~ t-1；日變化÷當日量、限幅）
      const mgS = [], shS = [], lnS = [];
      let lnOk = true;
      for (let k = i - LOOKBACK; k < i; k++) {
        const a1 = days[k].mg?.[code], a0 = days[k - 1]?.mg?.[code];
        const vol = days[k].close?.[code]?.[1] || 0;
        if (!a1 || !a0 || !(vol > 0)) { mgS.push(0); shS.push(0); }
        else {
          mgS.push(Math.max(-CLAMP_IN, Math.min(CLAMP_IN, ((a1[0] || 0) - (a0[0] || 0)) / vol)));
          shS.push(Math.max(-CLAMP_IN, Math.min(CLAMP_IN, ((a1[1] || 0) - (a0[1] || 0)) / vol)));
        }
        const l1 = days[k].ln?.[code], l0 = days[k - 1]?.ln?.[code];
        if (l1 == null || l0 == null || !(vol > 0)) { lnS.push(0); lnOk = false; }
        else lnS.push(Math.max(-CLAMP_IN, Math.min(CLAMP_IN, (l1 - l0) / vol)));
      }
      const hasMg = mgS.some(x => x !== 0) || shS.some(x => x !== 0);
      samples.push({ half, mgS, shS, lnS, hasMg, lnOk, netOpen: (no - c) / c * 100 - COST });
    }
  }
  const pool = samples.filter(s => s.hasMg);
  console.log(`定版濾網池 ${samples.length.toLocaleString()}·有資券序列 ${pool.length.toLocaleString()}·有借券完整序列 ${samples.filter(s => s.lnOk).length.toLocaleString()}\n`);

  // 五分位單調性檢定：兩半窗「各自」分位（避免 regime 混淆），輸出各分位淨均
  const quintiles = (arr, key) => {
    const out = [];
    for (const half of [0, 1]) {
      const sub = arr.filter(s => s.half === half).map(s => ({ u: key(s), r: s.netOpen })).sort((a, b) => a.u - b.u);
      if (sub.length < 500) { out.push(null); continue; }
      const qs = [];
      for (let q = 0; q < 5; q++) {
        const seg = sub.slice(Math.floor(q / 5 * sub.length), Math.floor((q + 1) / 5 * sub.length));
        qs.push(avg(seg.map(x => x.r)));
      }
      out.push(qs);
    }
    return out;
  };
  const mono = qs => { // 單調方向：+1 遞增 / -1 遞減 / 0 不單調（容忍一次平手）
    if (!qs) return null;
    let upv = 0, dn = 0;
    for (let k = 1; k < qs.length; k++) { if (qs[k] > qs[k - 1]) upv++; else if (qs[k] < qs[k - 1]) dn++; }
    return upv >= 3 && dn <= 1 ? 1 : dn >= 3 && upv <= 1 ? -1 : 0;
  };

  const GAINS = [
    ['P only(原始限幅)', 1, 0, 0],
    ['I only(趨勢累積)', 0, 1, 0],
    ['D only(變化率)', 0, 0, 1],
    ['PI(1,0.5)', 1, 0.5, 0],
    ['PID(1,0.5,0.25)', 1, 0.5, 0.25],
    ['ID(0.5,1)', 0, 1, 0.5],
  ];
  for (const [series, key0] of [['融資', 'mgS'], ['融券', 'shS'], ['借券', 'lnS']]) {
    const arr = series === '借券' ? samples.filter(s => s.lnOk) : pool;
    console.log(`── ${series} PID 五分位（明開賣淨均%·Q1=輸出最低→Q5最高）──`);
    for (const [name, Kp, Ki, Kd] of GAINS) {
      const [qa, qb] = quintiles(arr, s => pid(s[key0], Kp, Ki, Kd));
      const ma = mono(qa), mb = mono(qb);
      const stable = qa && qb && ma !== 0 && ma === mb;
      console.log(`  ${name.padEnd(16)} 前半[${qa ? qa.join(', ') : '樣本不足'}]${ma != null ? `(${ma > 0 ? '↑' : ma < 0 ? '↓' : '亂'})` : ''}  後半[${qb ? qb.join(', ') : '樣本不足'}]${mb != null ? `(${mb > 0 ? '↑' : mb < 0 ? '↓' : '亂'})` : ''}  ${stable ? '✅兩窗同向單調' : '❌'}`);
    }
    console.log('');
  }
  console.log('※ 判準：某 PID 組合需「兩半窗各自五分位單調且方向一致」才可入權重；掃 6 組增益本身有多重檢定風險，過關後仍需留出樣本驗證。非投資建議。');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
