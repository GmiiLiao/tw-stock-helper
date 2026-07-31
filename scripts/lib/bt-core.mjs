// ─────────────────────────────────────────────────────────────────────────
// bt-core：隔日沖統一回測平台（所有新變數/新架構的准入關卡）
// 內建本輪稽核學到的全部教訓，任何評估自動具備：
//   ① 可交易宇宙（排除 chg>8.5% 漲停/準漲停——收盤買不到）
//   ② 雙口徑（明開賣/明收賣）× 扣費稅 0.4425%
//   ③ 前後半窗獨立（方向不一致=不穩，直接淘汰）
//   ④ regime 分割（當日市場寬度≥50%=多頭日）
//   ⑤ 基準對照（效應一律以 vs 宇宙基準的 delta 表述）
// 資料：chipArchive（closeJson 5-tuple / instJson / marginJson / lendingJson）。
// 用法見 scripts/screen-variables.mjs。非投資建議。
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';

const COST = 0.4425;

export async function loadDays({ days = 480, lookback = 62, to = null } = {}) {
  if (!admin.apps.length) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS =
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
    admin.initializeApp();
  }
  const db = admin.firestore();
  let q = db.collection('chipArchive').orderBy('date', 'desc');
  if (to) q = q.where('date', '<=', to);
  const snap = await q.limit(days + lookback + 1).get();
  return snap.docs.map(d => ({ date: d.id,
    close: d.data().closeJson ? JSON.parse(d.data().closeJson) : null,
    inst: d.data().instJson ? JSON.parse(d.data().instJson) : null,
    mg: d.data().marginJson ? JSON.parse(d.data().marginJson) : null,
    ln: d.data().lendingJson ? JSON.parse(d.data().lendingJson) : null,
    dt: d.data().dayTradeJson ? JSON.parse(d.data().dayTradeJson) : null }))
    .filter(d => d.close && d.close['2330'])
    .sort((a, b) => a.date.localeCompare(b.date));
}

// 標準樣本集：每 (日,股) 一筆，欄位齊備、PIT 安全（chip 類=t-1、價量=當日收盤）
export function buildSamples(days, { minVol = 300, warm = 61 } = {}) {
  const samples = [];
  const hist = {};   // code → {closes:[], vols:[]}（舊→新，僅保留 warm 根）
  for (let i = 0; i < days.length; i++) {
    const D = days[i], P = days[i - 1], N = days[i + 1], N5 = days[i + 5];
    // 當日市場寬度（regime，收盤即知=PIT 安全）
    let up = 0, tot = 0;
    if (P) for (const code in D.close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const c = D.close[code]?.[0], pc = P.close?.[code]?.[0];
      if (c > 0 && pc > 0) { tot++; if (c > pc) up++; }
    }
    const bull = tot >= 500 ? up / tot >= 0.5 : null;
    for (const code in D.close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const r = D.close[code]; if (!r || r.length < 5) continue;
      const [c, v, o, h, l] = r;
      const H = (hist[code] ||= { closes: [], vols: [] });
      const emit = i >= warm && P && N?.close;
      if (emit && c > 0 && v >= minVol && h > l && o > 0 && H.closes.length >= warm - 1) {
        const pc = H.closes[H.closes.length - 1];
        const n = N.close[code];
        if (pc > 0 && n && n.length >= 5 && n[0] > 0 && n[2] > 0) {
          const chg = (c - pc) / pc * 100;
          const cl = H.closes, vl = H.vols;
          let hi20 = 0, hi60 = 0;
          for (let k = 1; k <= Math.min(60, cl.length); k++) { const x = cl[cl.length - k]; if (k <= 20 && x > hi20) hi20 = x; if (x > hi60) hi60 = x; }
          let av20 = 0, an = 0;
          for (let k = 1; k <= Math.min(20, vl.length); k++) { av20 += vl[vl.length - k]; an++; }
          av20 = an ? av20 / an : 0;
          let upStreak = 0;
          for (let k = cl.length - 1; k > 0 && cl[k] > cl[k - 1]; k--) upStreak++;
          if (upStreak === cl.length - 1 && chg <= 0) upStreak = 0;  // 邊界保守
          if (chg > 0) upStreak += 1; else upStreak = 0;             // 含當日
          const c5 = cl[cl.length - 5];
          const a1 = P.mg?.[code];
          const l1 = P.ln?.[code];
          // 法人特徵（t-1 前·PIT）：外資連買天數、5日外資+投信淨買佔20日均量
          let fStreak = 0; for (let k = 1; k <= 10; k++) { const f = days[i - k]?.inst?.[code]?.[0]; if (f > 0) fStreak++; else break; }
          let inst5 = 0; for (let k = 1; k <= 5; k++) { const it = days[i - k]?.inst?.[code]; if (it) inst5 += (it[0] || 0) + (it[1] || 0); }
          samples.push({
            di: i, date: D.date, code, bull,
            c, v, o, h, l, pc, chg,
            pos: (c - l) / (h - l),
            volX: vl[vl.length - 1] > 0 ? v / vl[vl.length - 1] : 0,
            gap: o > pc,
            uShadow: (h - Math.max(o, c)) / (h - l),
            hi20, hi60, brk20: hi20 > 0 && c > hi20,
            posture60: hi60 > 0 ? c / hi60 : null,
            upStreak,
            ret5: c5 > 0 ? (c - c5) / c5 * 100 : null,
            mgLevel: a1 && av20 > 0 ? (a1[0] || 0) / av20 : null,   // 資餘/20日均量（回補天數概念）
            shLevel: a1 && av20 > 0 ? (a1[1] || 0) / av20 : null,   // 券餘/20日均量
            lnLevel: l1 != null && av20 > 0 ? l1 / av20 : null,     // 借券餘/20日均量（~185日覆蓋）
            dtRatio: D.dt?.[code] != null && v > 0 ? D.dt[code] / v * 100 : null, // 當沖佔比%（當日收盤即知·僅上市）
            fStreak, inst5Ratio: av20 > 0 ? inst5 / av20 : null,
            net5: N5?.close?.[code]?.[0] > 0 ? (N5.close[code][0] - c) / c * 100 - COST : null, // 5日持有淨報酬（fwd視窗重疊·顯著性打折）
            netOpen: (n[2] - c) / c * 100 - COST,
            netClose: (n[0] - c) / c * 100 - COST,
            // 明日四價毛報酬%（出場時點模型用；高低點僅供上下界參考——盤中路徑不可知）
            rNO: (n[2] - c) / c * 100, rNH: (n[3] - c) / c * 100, rNL: (n[4] - c) / c * 100, rNC: (n[0] - c) / c * 100,
            tradable: chg <= 8.5,
          });
        }
      }
      H.closes.push(c > 0 ? c : H.closes[H.closes.length - 1] || 0);
      H.vols.push(v || 0);
      if (H.closes.length > warm) { H.closes.shift(); H.vols.shift(); }
    }
  }
  const mid = Math.floor(days.length / 2);
  for (const s of samples) s.half = s.di < mid ? 0 : 1;
  return samples;
}

const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const r3 = x => x == null ? null : +x.toFixed(3);
const pct1 = (n, d) => d ? +(n / d * 100).toFixed(1) : null;

// 標準報告：分組 vs 可交易宇宙基準（delta），兩半窗方向一致性判定＋regime 分割
// groups: [{label, cond(s)}]；回傳 {stable:[...過關組], lines}
export function report(samples, { title, groups, minN = 300 }) {
  const uni = samples.filter(s => s.tradable);
  const base = { 0: uni.filter(s => s.half === 0), 1: uni.filter(s => s.half === 1) };
  const bAvg = { 0: avg(base[0].map(s => s.netClose)), 1: avg(base[1].map(s => s.netClose)) };
  const bOpen = { 0: avg(base[0].map(s => s.netOpen)), 1: avg(base[1].map(s => s.netOpen)) };
  console.log(`\n══ ${title}（可交易宇宙 n=${uni.length.toLocaleString()}·基準明收賣 前半${r3(bAvg[0])}%/後半${r3(bAvg[1])}%）══`);
  const stable = [];
  for (const g of groups) {
    const sel = { 0: base[0].filter(g.cond), 1: base[1].filter(g.cond) };
    if (sel[0].length < minN || sel[1].length < minN) {
      console.log(`  ${g.label.padEnd(16)} 樣本不足（${sel[0].length}/${sel[1].length}）`);
      continue;
    }
    const dC = [avg(sel[0].map(s => s.netClose)) - bAvg[0], avg(sel[1].map(s => s.netClose)) - bAvg[1]];
    const dO = [avg(sel[0].map(s => s.netOpen)) - bOpen[0], avg(sel[1].map(s => s.netOpen)) - bOpen[1]];
    const okC = Math.sign(dC[0]) === Math.sign(dC[1]) && Math.min(Math.abs(dC[0]), Math.abs(dC[1])) >= 0.05;
    const okO = Math.sign(dO[0]) === Math.sign(dO[1]) && Math.min(Math.abs(dO[0]), Math.abs(dO[1])) >= 0.05;
    const win = pct1(sel[0].filter(s => s.netClose > 0).length + sel[1].filter(s => s.netClose > 0).length, sel[0].length + sel[1].length);
    let regimeNote = '';
    if (okC || okO) {   // 過關者加驗 regime
      const rb = uni.filter(s => s.bull === true).filter(g.cond), rr = uni.filter(s => s.bull === false).filter(g.cond);
      const bb = avg(uni.filter(s => s.bull === true).map(s => s.netClose)), br = avg(uni.filter(s => s.bull === false).map(s => s.netClose));
      if (rb.length >= minN && rr.length >= minN) {
        const db_ = avg(rb.map(s => s.netClose)) - bb, dr = avg(rr.map(s => s.netClose)) - br;
        regimeNote = `  regime[多${r3(db_)}/空${r3(dr)}${Math.sign(db_) === Math.sign(dr) ? '同向' : '⚠反向'}]`;
      }
    }
    const mark = okC || okO ? '✅' : '❌';
    console.log(`  ${g.label.padEnd(16)} 收賣Δ[${r3(dC[0])}/${r3(dC[1])}${okC ? '✓' : ''}] 開賣Δ[${r3(dO[0])}/${r3(dO[1])}${okO ? '✓' : ''}] 淨勝${win}%·n=${(sel[0].length + sel[1].length).toLocaleString()} ${mark}${regimeNote}`);
    if (okC || okO) stable.push({ label: g.label, dC, dO, title });
  }
  return stable;
}

export { COST, avg, r3 };
