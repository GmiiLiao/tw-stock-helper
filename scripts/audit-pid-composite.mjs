#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 多參數獨立 PID → 組合權重 回測（使用者假說第二輪）
// 六參數各自獨立線性 PID（遞迴式：I=λ衰減積分·防windup，輸入/輸出限幅約束）：
//   ①法人籌碼(外資+投信淨買/量·t-1) ②融資(資增/量·t-1) ③融券(券增/量·t-1)
//   ④借券(借券餘增/量·t-1·僅~185日有資料，缺值=中性0) ⑤價(日漲跌幅) ⑥量(量變化率)
//   （①~④ chip 類一律用 t-1 前狀態=PIT 安全；⑤⑥當日收盤已知可用）
// 整理權重：前半窗(train)各因子 PID 輸出 z 分數與隔日淨報酬的 IC(相關係數)
//   → 權重=IC 正規化(Σ|w|=1) → 綜合分=Σw·z。
// 判斷：後半窗(test·未見過)十分位淨報酬單調性＋Top-Bottom 價差＋Top10% 是否淨正。
// 口徑：今收買→明收賣(主)＋明開賣(輔)，扣 0.4425%。全市場宇宙(量≥300張)。
// 非投資建議；本輸出為權重取捨唯一依據。
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const DAYS = +(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || 480);
const TRADABLE = process.argv.includes('--tradable');  // 宇宙層排除漲停/準漲停(chg>8.5%)：z/IC權重/驗證全在可交易宇宙內
const COST = 0.4425, MIN_VOL = 300;
const LAMBDA = 0.7, KP = 1, KI = 0.5, KD = 0.25;   // 固定增益（上輪 18 組掃描已示無敏感組合，不再掃）
const CLAMP_IN = 1, CLAMP_OUT = 2;                  // 輸入已各自正規化到 ~±1 再限幅；輸出限幅
const FACTORS = ['inst', 'mg', 'sh', 'ln', 'price', 'vol'];
const FNAME = { inst: '法人籌碼', mg: '融資', sh: '融券', ln: '借券', price: '價(動能)', vol: '量(變化)' };
const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const r3 = x => x == null ? null : +x.toFixed(3);

function corr(xs, ys) {
  const n = xs.length; if (n < 100) return null;
  const mx = avg(xs), my = avg(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

async function main() {
  const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(DAYS + 2).get();
  const days = snap.docs.map(d => ({ date: d.id,
    close: d.data().closeJson ? JSON.parse(d.data().closeJson) : null,
    inst: d.data().instJson ? JSON.parse(d.data().instJson) : null,
    mg: d.data().marginJson ? JSON.parse(d.data().marginJson) : null,
    ln: d.data().lendingJson ? JSON.parse(d.data().lendingJson) : null }))
    .filter(d => d.close && d.close['2330'])
    .sort((a, b) => a.date.localeCompare(b.date));
  console.log(`交易日 ${days.length}（${days[0]?.date} → ${days[days.length - 1]?.date}）·PID(Kp=${KP},Ki=${KI},Kd=${KD},λ=${LAMBDA})·輸出限幅±${CLAMP_OUT}${TRADABLE ? '·可交易宇宙(排除chg>8.5%)' : ''}`);

  // 遞迴 PID 狀態：state[code] = {f:{I,prev,u}}
  const state = {};
  const upd = (st, x) => {
    x = Math.max(-CLAMP_IN, Math.min(CLAMP_IN, x));
    st.I = LAMBDA * st.I + x;
    st.u = Math.max(-CLAMP_OUT, Math.min(CLAMP_OUT, KP * x + KI * st.I + KD * (x - st.prev)));
    st.prev = x;
  };
  const getSt = (code, f) => ((state[code] ||= {})[f] ||= { I: 0, prev: 0, u: 0 });

  const samples = [];  // {di, code, z:{f}, u:{f}, netClose, netOpen}
  const WARM = 15;
  for (let i = 1; i < days.length; i++) {
    const D = days[i], P = days[i - 1], N = days[i + 1];
    const dayRows = [];
    for (const code in D.close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const r = D.close[code]; if (!r || r.length < 5) continue;
      const [c, v] = r;
      const pc = P.close?.[code]?.[0], pv = P.close?.[code]?.[1];
      if (!(c > 0 && pc > 0 && v >= MIN_VOL)) { continue; }
      // ⑤⑥ 價量：當日收盤已知 → 先更新再取用
      const chg = (c - pc) / pc * 100;
      upd(getSt(code, 'price'), chg / 10);
      upd(getSt(code, 'vol'), pv > 0 ? (v / pv - 1) / 3 : 0);
      if (i >= WARM && N?.close && !(TRADABLE && chg > 8.5)) {
        const n = N.close[code];
        if (n && n.length >= 5 && n[0] > 0 && n[2] > 0) {
          const u = {}; for (const f of FACTORS) u[f] = getSt(code, f).u;  // chip 類此刻＝≤t-1 狀態
          dayRows.push({ code, u, chg, netClose: (n[0] - c) / c * 100 - COST, netOpen: (n[2] - c) / c * 100 - COST });
        }
      }
    }
    // 橫斷面 z 分數（逐因子）
    if (dayRows.length >= 100) {
      for (const f of FACTORS) {
        const vals = dayRows.map(x => x.u[f]);
        const m = avg(vals), sd = Math.sqrt(avg(vals.map(x => (x - m) ** 2))) || 1;
        for (const x of dayRows) (x.z ||= {})[f] = Math.max(-3, Math.min(3, (x.u[f] - m) / sd));
      }
      for (const x of dayRows) samples.push({ di: i, code: x.code, z: x.z, chg: x.chg, netClose: x.netClose, netOpen: x.netOpen });
    }
    // ①~④ chip 類：形成訊號「之後」才吸收當日值（明日才可用＝PIT 安全）
    for (const code in D.close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const v = D.close[code]?.[1] || 0; if (!(v > 0)) continue;
      const it = D.inst?.[code];
      upd(getSt(code, 'inst'), it ? ((it[0] || 0) + (it[1] || 0)) / v / 0.2 : 0);
      const a1 = D.mg?.[code], a0 = P.mg?.[code];
      upd(getSt(code, 'mg'), a1 && a0 ? ((a1[0] || 0) - (a0[0] || 0)) / v / 0.05 : 0);
      upd(getSt(code, 'sh'), a1 && a0 ? ((a1[1] || 0) - (a0[1] || 0)) / v / 0.05 : 0);
      const l1 = D.ln?.[code], l0 = P.ln?.[code];
      upd(getSt(code, 'ln'), l1 != null && l0 != null ? (l1 - l0) / v / 0.05 : 0);
    }
  }
  const mid = Math.floor(days.length / 2);
  const train = samples.filter(s => s.di < mid), test = samples.filter(s => s.di >= mid);
  console.log(`樣本 ${samples.length.toLocaleString()}（train ${train.length.toLocaleString()}／test ${test.length.toLocaleString()}·全市場量≥${MIN_VOL}張）\n`);

  // ── 單因子 IC（train / test 各自）──
  console.log('── 單因子 IC（PID輸出z vs 明收賣淨報酬）──');
  const w = {};
  for (const f of FACTORS) {
    const icTr = corr(train.map(s => s.z[f]), train.map(s => s.netClose));
    const icTe = corr(test.map(s => s.z[f]), test.map(s => s.netClose));
    w[f] = icTr || 0;
    console.log(`  ${FNAME[f].padEnd(6)} train IC=${r3(icTr)}  test IC=${r3(icTe)}  ${icTr && icTe && Math.sign(icTr) === Math.sign(icTe) && Math.abs(icTe) >= 0.005 ? '（同號）' : '（換號或≈0）'}`);
  }
  const sumW = Object.values(w).reduce((s, v) => s + Math.abs(v), 0) || 1;
  for (const f of FACTORS) w[f] /= sumW;
  console.log(`\n整理後權重（train IC 正規化）：${FACTORS.map(f => `${FNAME[f]}=${r3(w[f])}`).join('、')}\n`);

  // ── 綜合分十分位（train 內樣本內 vs test 樣本外）──
  const decile = (arr, key, retKey) => {
    const sorted = [...arr].sort((a, b) => key(a) - key(b));
    const out = [];
    for (let q = 0; q < 10; q++) {
      const seg = sorted.slice(Math.floor(q / 10 * sorted.length), Math.floor((q + 1) / 10 * sorted.length));
      out.push(r3(avg(seg.map(x => x[retKey]))));
    }
    return out;
  };
  const comp = s => FACTORS.reduce((t, f) => t + w[f] * s.z[f], 0);
  for (const [label, arr] of [['train(樣本內·必然好看)', train], ['test(樣本外·唯一算數)', test]]) {
    const dC = decile(arr, comp, 'netClose');
    const dO = decile(arr, comp, 'netOpen');
    console.log(`── ${label} 綜合分十分位 ──`);
    console.log(`  明收賣淨均: [${dC.join(', ')}]  Top-Bottom=${r3(dC[9] - dC[0])}pp`);
    console.log(`  明開賣淨均: [${dO.join(', ')}]  Top10%=${dO[9]}%\n`);
  }
  // ── 可交易性檢查（Top 十分位是不是漲停股幻覺？）──
  console.log('── 可交易性檢查（test）──');
  const teSorted = [...test].sort((a, b) => comp(a) - comp(b));
  const top10 = teSorted.slice(Math.floor(0.9 * teSorted.length));
  const luPct = +(top10.filter(x => x.chg >= 9.4).length / top10.length * 100).toFixed(1);
  const nearPct = +(top10.filter(x => x.chg >= 8.5).length / top10.length * 100).toFixed(1);
  console.log(`Top10% 中今日漲停(≥9.4%)占 ${luPct}%、≥8.5% 占 ${nearPct}%（漲停鎖死＝收盤買不到）`);
  // 可交易宇宙（chg≤8.5 排除漲停/準漲停）重算十分位
  const tradable = test.filter(x => x.chg <= 8.5);
  const dT = decile(tradable, comp, 'netClose'), dTO = decile(tradable, comp, 'netOpen');
  console.log(`可交易宇宙(test·chg≤8.5·n=${tradable.length.toLocaleString()}) 綜合分十分位：`);
  console.log(`  明收賣: [${dT.join(', ')}]  Top-Bottom=${r3(dT[9] - dT[0])}pp  Top10%=${dT[9]}%`);
  console.log(`  明開賣: [${dTO.join(', ')}]  Top10%=${dTO[9]}%`);
  // 價動能單因子 vs 綜合分（可交易宇宙）——組合是否只是動能的殼？
  const dP = decile(tradable, x => x.z.price, 'netClose');
  console.log(`  對照·純價動能因子十分位(明收賣): [${dP.join(', ')}]  Top10%=${dP[9]}%`);
  // 每日 Top20 組合模擬（可交易·實務口徑）
  const byDay = {};
  for (const x of tradable) (byDay[x.di] ||= []).push(x);
  const dayRetC = [], dayRetO = [];
  for (const di in byDay) {
    const rows = byDay[di].sort((a, b) => comp(b) - comp(a)).slice(0, 20);
    if (rows.length < 10) continue;
    dayRetC.push(avg(rows.map(x => x.netClose)));
    dayRetO.push(avg(rows.map(x => x.netOpen)));
  }
  const posC = dayRetC.filter(v => v > 0).length, posO = dayRetO.filter(v => v > 0).length;
  console.log(`每日Top20組合(test·${dayRetC.length}日)：明收賣日均 ${r3(avg(dayRetC))}%·正日${+(posC / dayRetC.length * 100).toFixed(1)}% ｜ 明開賣日均 ${r3(avg(dayRetO))}%·正日${+(posO / dayRetO.length * 100).toFixed(1)}%`);
  console.log('');
  console.log('※ 判準：test 十分位需大致單調、Top-Bottom 價差顯著、且 Top10% 淨均>0 才有實用價值；train 數字僅供對照過擬合程度。非投資建議。');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
