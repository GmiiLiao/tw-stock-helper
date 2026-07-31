#!/usr/bin/env node
// ── 財報體質分小樣本回測：財報公布後 20 交易日報酬 事件研究 ──────────────
// 事件：2026-03-31(2025Q4/年報揭曉)、2026-05-15(2026Q1)。PIT：各事件只用當時已公布的季度。
// 價格：chipArchive(92日收盤庫)。分組：體質分五分位 + PE 四分位。誠實：僅 2 個事件、一個多頭季。
import admin from 'firebase-admin';
process.env.GOOGLE_APPLICATION_CREDENTIALS ||= '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

// ── 累計→單季換算（MOPS 彙總表 Q2/Q3/Q4 的損益為年度累計；Q1=單季；資產負債為時點值）──
// quarters 新→舊 [{y,s,rev,ni,eps,...}] → singles 新→舊（單季 rev/ni/eps；率值與時點值原樣帶過）
export function toSingles(quarters) {
  const byKey = {}; for (const x of quarters) if (x) byKey[`${x.y}Q${x.s}`] = x;
  return quarters.map(x => {
    if (!x) return null;
    if (x.s === 1) return { ...x };
    const prev = byKey[`${x.y}Q${x.s - 1}`];
    const d = k => (x[k] != null && prev?.[k] != null) ? +(x[k] - prev[k]).toFixed(2) : null;
    return { ...x, rev: d('rev'), ni: d('ni'), eps: d('eps'), op: d('op') };
  });
}

// ── 體質分（0-100，確定性；與 daemon 共用同一套規則）──────────────────
// quarters 新→舊：[{y,s,rev,op,ni,eps,gm,om,nm,assets,debt,equity,bps}]（累計制原始值）
export function finQuality(quarters, price) {
  const raw = quarters.filter(x => x && (x.eps != null || x.rev != null));
  if (raw.length < 4) return null;
  const q = toSingles(raw); // 單季化
  const eps = i => q[i]?.eps;
  const ttmEps = [0, 1, 2, 3].every(i => eps(i) != null) ? +([0, 1, 2, 3].reduce((s, i) => s + eps(i), 0)).toFixed(2) : null;
  // 獲利性 30
  let profit = 0;
  if (ttmEps != null && ttmEps > 0) profit += 10;
  const nm0 = q[0]?.nm; if (nm0 != null) profit += nm0 >= 10 ? 10 : nm0 >= 5 ? 5 : 0;
  const ttmNi = [0, 1, 2, 3].every(i => q[i]?.ni != null) ? [0, 1, 2, 3].reduce((s, i) => s + q[i].ni, 0) : null;
  const roe = ttmNi != null && q[0]?.equity > 0 ? ttmNi / q[0].equity * 100 : null;
  if (roe != null) profit += roe > 15 ? 10 : roe > 8 ? 6 : roe > 0 ? 3 : 0;
  // 成長性 30
  let growth = 0;
  const yoy = i => (eps(i) != null && eps(i + 4) != null && Math.abs(eps(i + 4)) > 0.01) ? (eps(i) - eps(i + 4)) / Math.abs(eps(i + 4)) * 100 : null;
  const y0 = yoy(0); if (y0 != null) growth += y0 > 30 ? 12 : y0 > 0 ? 7 : 0;
  let streak = 0; for (let i = 0; i < 4; i++) { const y = yoy(i); if (y != null && y > 0) streak++; else break; }
  growth += streak >= 3 ? 10 : streak === 2 ? 6 : streak === 1 ? 3 : 0;
  const rev0 = q[0]?.rev, rev4 = q[4]?.rev;
  const revYoY = rev0 > 0 && rev4 > 0 ? (rev0 - rev4) / rev4 * 100 : null;
  if (revYoY != null) growth += revYoY > 20 ? 8 : revYoY > 0 ? 4 : 0;
  // 穩定性 20
  const lossQ = q.slice(0, 8).filter(x => x.eps != null && x.eps < 0).length;
  const stable = lossQ === 0 ? 20 : lossQ === 1 ? 12 : lossQ === 2 ? 6 : 0;
  // 評價 20（絕對 PE 帶；同業相對留給 daemon）
  const pe = ttmEps > 0 && price > 0 ? price / ttmEps : null;
  const valuation = pe == null ? 0 : pe < 10 ? 20 : pe < 15 ? 15 : pe < 20 ? 10 : pe < 30 ? 5 : 0;
  return { score: profit + growth + stable + valuation, profit, growth, stable, valuation, ttmEps, pe: pe ? +pe.toFixed(1) : null, roe: roe ? +roe.toFixed(1) : null, epsYoY: y0 ? +y0.toFixed(1) : null, streak, lossQ };
}

const isMain = process.argv[1] && process.argv[1].endsWith('backtest-finreports.mjs');
if (isMain) {
  console.log('載入 finReports…');
  const finSnap = await db.collection('finReports').get();
  const fin = {}; for (const d of finSnap.docs) { const x = d.data(); fin[x.code] = JSON.parse(x.quartersJson || '[]'); }
  console.log(`  ${Object.keys(fin).length} 檔`);
  console.log('載入 chipArchive 收盤…');
  const archSnap = await db.collection('chipArchive').orderBy('date', 'asc').get();
  const days = archSnap.docs.map(d => { const x = d.data(); return x.closeJson ? { date: x.date, close: JSON.parse(x.closeJson) } : null; }).filter(x => x && Object.keys(x.close).length > 500);
  const dateIdx = Object.fromEntries(days.map((d, i) => [d.date, i]));
  const firstOnAfter = iso => { for (let i = 0; i < days.length; i++) if (days[i].date >= iso) return i; return -1; };

  // 事件：{名稱, 進場日(公布次日), 當時可用季數起點 index into quarters(新→舊)}
  // quarters[0]=2026Q1, [1]=2025Q4...；3/31 時 2026Q1 未公布 → 從 index 1 起
  const EVENTS = [
    ['2025Q4/年報(3/31公布)', '2026-04-01', 1],
    ['2026Q1(5/15公布)', '2026-05-16', 0],
  ];
  const HOLD = 20;
  for (const [tag, entryIso, qStart] of EVENTS) {
    const e0 = firstOnAfter(entryIso);
    if (e0 < 0 || e0 + HOLD >= days.length) { console.log(`\n${tag}: 價格窗不足，跳過`); continue; }
    const entryD = days[e0], exitD = days[e0 + HOLD];
    const rows = [];
    for (const code in fin) {
      const p0 = entryD.close[code]?.[0], p1 = exitD.close[code]?.[0];
      if (!(p0 > 5) || !(p1 > 0)) continue;
      const vol = entryD.close[code]?.[1] || 0; if (vol < 100) continue; // 流動性
      const qq = fin[code].slice(qStart);
      const fq = finQuality(qq, p0);
      if (!fq) continue;
      rows.push({ code, score: fq.score, pe: fq.pe, ret: (p1 - p0) / p0 * 100 });
    }
    rows.sort((a, b) => a.score - b.score);
    const nQ = 5, seg = Math.floor(rows.length / nQ);
    console.log(`\n══ ${tag}：${entryD.date} 進場 → ${exitD.date} 出場（${rows.length} 檔）══`);
    const mean = a => a.reduce((s, x) => s + x, 0) / Math.max(a.length, 1);
    const mktMean = mean(rows.map(r => r.ret));
    console.log(`  全市場平均 ${mktMean.toFixed(2)}%`);
    for (let k = 0; k < nQ; k++) {
      const g = rows.slice(k * seg, k === nQ - 1 ? rows.length : (k + 1) * seg);
      const m = mean(g.map(x => x.ret)); const win = g.filter(x => x.ret > 0).length / g.length * 100;
      console.log(`  體質分Q${k + 1}(${k === 0 ? '最低' : k === nQ - 1 ? '最高' : ' '}) 分數${Math.round(mean(g.map(x => x.score)))} → 20日均報酬 ${m.toFixed(2)}%（勝率${win.toFixed(0)}%, n=${g.length}）`);
    }
    // PE 四分位（僅獲利股）
    const peRows = rows.filter(r => r.pe != null && r.pe > 0).sort((a, b) => a.pe - b.pe);
    const seg4 = Math.floor(peRows.length / 4);
    for (let k = 0; k < 4; k++) {
      const g = peRows.slice(k * seg4, k === 3 ? peRows.length : (k + 1) * seg4);
      console.log(`  PE Q${k + 1}(${k === 0 ? '最便宜' : k === 3 ? '最貴' : ' '}) PE中位${(g[Math.floor(g.length / 2)]?.pe ?? 0).toFixed(1)} → 20日均報酬 ${mean(g.map(x => x.ret)).toFixed(2)}%（n=${g.length}）`);
    }
  }
  console.log('\n（僅 2 事件、多頭季，樣本小；確定性統計，非投資建議）');
  process.exit(0);
}
