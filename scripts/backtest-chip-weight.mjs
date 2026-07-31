// 回測：隔日沖候選「法人加權前 vs 後」勝率對照（買收盤、隔日收盤出）。
// 資料：chipDaily(法人[外資,投信,自營]) + chipArchive(收盤,量)。皆每日一格緊湊文件。
// 候選池近似撿尾盤：漲≥1% + 爆量(≥1.5×5日均量) + 破5日高(收盤)。
// 用意：隔離「法人加權項」對隔日沖勝率的邊際貢獻（基準與加權用同一池）。
import { initializeApp, applicationDefault, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT_ID = 'tw-stock-helper';
const svc = process.env.FIREBASE_SERVICE_ACCOUNT;
initializeApp(svc ? { credential: cert(JSON.parse(svc)), projectId: PROJECT_ID } : { credential: applicationDefault(), projectId: PROJECT_ID });
const db = getFirestore();

const CHG_MIN = 1.0, VOLX_MIN = 1.5; // 候選池門檻

async function load() {
  const [cd, ca] = await Promise.all([
    db.collection('chipDaily').orderBy('date').get(),
    db.collection('chipArchive').orderBy('date').get(),
  ]);
  const instByDate = {}; for (const d of cd.docs) { const x = d.data(); instByDate[x.date] = x.codesJson ? JSON.parse(x.codesJson) : {}; }
  const closeByDate = {}; for (const d of ca.docs) { const x = d.data(); if (x.closeJson) closeByDate[x.date] = JSON.parse(x.closeJson); }
  return { instByDate, closeByDate };
}

function run({ inst, close, dates, W }) {
  // 每檔外資連買天數(至某日)
  const results = { base: {}, wt: {} };
  for (const N of [5, 10]) { results.base[N] = { win: 0, n: 0, ret: 0 }; results.wt[N] = { win: 0, n: 0, ret: 0 }; }
  let pooledDays = 0, candTotal = 0;

  for (let di = 6; di < dates.length - 1; di++) {
    const D = dates[di], Dn = dates[di + 1];
    const cD = close[D], cN = close[Dn], iD = inst[D];
    if (!cD || !cN || !iD) continue;
    const prev = dates[di - 1];
    const cand = [];
    for (const code in cD) {
      const px = cD[code]?.[0], vol = cD[code]?.[1];
      const pPrev = close[prev]?.[code]?.[0];
      if (!(px > 0 && pPrev > 0)) continue;
      const chg = (px - pPrev) / pPrev * 100;
      if (chg < CHG_MIN) continue;
      // 5日均量 + 5日高(收盤)
      let vs = 0, vn = 0, hi = 0;
      for (let k = 1; k <= 5; k++) { const r = close[dates[di - k]]?.[code]; if (r) { if (r[1] > 0) { vs += r[1]; vn++; } if (r[0] > hi) hi = r[0]; } }
      const avgVol = vn ? vs / vn : 0;
      const volX = avgVol > 0 ? vol / avgVol : 0;
      if (volX < VOLX_MIN) continue;
      if (!(hi > 0 && px >= hi)) continue; // 破5日高
      // 法人
      const f = iD[code]?.[0] || 0, t = iD[code]?.[1] || 0, dd = iD[code]?.[2] || 0;
      let streak = 0; for (let k = 0; k < 20; k++) { const im = inst[dates[di - k]]; if ((im?.[code]?.[0] || 0) > 0) streak++; else break; }
      const nextRet = (cN[code]?.[0] - px) / px * 100;
      if (!Number.isFinite(nextRet)) continue;
      const base = chg + volX * 2 + (f > 0 ? 3 : f < 0 ? -3 : 0) + Math.min(streak, 6) * 0.5;
      const instW = W.triple * (f > 0 && t > 0 && dd > 0 ? 1 : 0)
        + W.heavy * (f >= 5000 ? 1 : 0)
        + W.streak * Math.min(streak, W.streakCap)
        + W.trust * (t > 0 ? 1 : 0)
        + (W.dealer || 0) * (dd > 0 ? 1 : 0)
        - W.retail * (f < 0 ? 1 : 0);
      cand.push({ code, base, wt: base + instW, nextRet });
    }
    if (cand.length < 3) continue;
    pooledDays++; candTotal += cand.length;
    for (const N of [5, 10]) {
      const byBase = [...cand].sort((a, b) => b.base - a.base).slice(0, N);
      const byWt = [...cand].sort((a, b) => b.wt - a.wt).slice(0, N);
      for (const x of byBase) { results.base[N].n++; results.base[N].ret += x.nextRet; if (x.nextRet > 0) results.base[N].win++; }
      for (const x of byWt) { results.wt[N].n++; results.wt[N].ret += x.nextRet; if (x.nextRet > 0) results.wt[N].win++; }
    }
  }
  return { results, pooledDays, candTotal };
}

const { instByDate, closeByDate } = await load();
const dates = Object.keys(instByDate).filter(d => closeByDate[d]).sort();
console.log(`可用交易日(法人∩收盤): ${dates.length}（${dates[0]} → ${dates[dates.length - 1]}）`);

const WEIGHTS = [
  { name: '基準(無法人加權)', W: { triple: 0, heavy: 0, streak: 0, trust: 0, retail: 0, streakCap: 6 } },
  { name: '保守', W: { triple: 3, heavy: 2, streak: 0.5, trust: 1, retail: 3, streakCap: 6 } },
  { name: '中等', W: { triple: 5, heavy: 3, streak: 1.0, trust: 1.5, retail: 5, streakCap: 8 } },
  { name: '積極', W: { triple: 8, heavy: 5, streak: 1.5, trust: 2, retail: 8, streakCap: 10 } },
  { name: '數據最佳(正比拉抬)', W: { triple: 5, heavy: 3, streak: 0.5, trust: 4, dealer: 1, retail: 6, streakCap: 6 } },
];

// ── 訊號隔離分析：每個法人訊號單獨對隔日沖勝率的貢獻（全候選池）──
function isolate() {
  const sig = {}; // name -> {win,n,ret}
  const add = (name, on, ret) => { const s = (sig[name] ??= { win: 0, n: 0, ret: 0 }); if (on) { s.n++; s.ret += ret; if (ret > 0) s.win++; } };
  for (let di = 6; di < dates.length - 1; di++) {
    const D = dates[di], Dn = dates[di + 1], cD = closeByDate[D], cN = closeByDate[Dn], iD = instByDate[D];
    if (!cD || !cN || !iD) continue;
    const prev = dates[di - 1];
    for (const code in cD) {
      const px = cD[code]?.[0], vol = cD[code]?.[1], pPrev = cD[prev]?.[0] ?? closeByDate[prev]?.[code]?.[0];
      if (!(px > 0 && pPrev > 0)) continue;
      const chg = (px - pPrev) / pPrev * 100; if (chg < CHG_MIN) continue;
      let vs = 0, vn = 0, hi = 0;
      for (let k = 1; k <= 5; k++) { const r = closeByDate[dates[di - k]]?.[code]; if (r) { if (r[1] > 0) { vs += r[1]; vn++; } if (r[0] > hi) hi = r[0]; } }
      const volX = vn ? vol / (vs / vn) : 0; if (volX < VOLX_MIN) continue;
      if (!(hi > 0 && px >= hi)) continue;
      const f = iD[code]?.[0] || 0, t = iD[code]?.[1] || 0, dd = iD[code]?.[2] || 0;
      let streak = 0; for (let k = 0; k < 20; k++) { if ((instByDate[dates[di - k]]?.[code]?.[0] || 0) > 0) streak++; else break; }
      const ret = (cN[code]?.[0] - px) / px * 100; if (!Number.isFinite(ret)) continue;
      add('全候選池(基準)', true, ret);
      add('外資買超(f>0)', f > 0, ret);
      add('外資賣超(f<0)', f < 0, ret);
      add('外資大買(≥5000張)', f >= 5000, ret);
      add('投信買超(t>0)', t > 0, ret);
      add('自營買超(d>0)', dd > 0, ret);
      add('三方同買(f,t,d>0)', f > 0 && t > 0 && dd > 0, ret);
      add('外資連買≥3日', streak >= 3, ret);
      add('外資連買≥5日', streak >= 5, ret);
      // ── 疊加組合（找最高勝率）──
      const triple = f > 0 && t > 0 && dd > 0;
      add('◆三方同買+連買≥3', triple && streak >= 3, ret);
      add('◆三方同買+連買≥5', triple && streak >= 5, ret);
      add('◆三方同買+外資大買', triple && f >= 5000, ret);
      add('◆外資大買+連買≥3', f >= 5000 && streak >= 3, ret);
      add('◆投信買+外資買', t > 0 && f > 0, ret);
      add('◆投信買+外資大買', t > 0 && f >= 5000, ret);
      add('◆三方同買+投信≥1000', triple && t >= 1000, ret);
    }
  }
  const base = sig['全候選池(基準)']; const bw = base.win / base.n * 100;
  console.log(`\n══ 訊號隔離分析（全候選池，隔日沖勝率）══`);
  for (const [name, s] of Object.entries(sig)) {
    const w = s.win / s.n * 100, r = s.ret / s.n, lift = w - bw;
    console.log(`  ${name.padEnd(18)} 勝率 ${w.toFixed(1)}% (${lift >= 0 ? '+' : ''}${lift.toFixed(1)}) 均報酬 ${r.toFixed(2)}% n=${s.n}`);
  }
}
isolate();

const fmt = (r) => r.n ? `勝率 ${(r.win / r.n * 100).toFixed(1)}% 均報酬 ${(r.ret / r.n).toFixed(2)}% (n=${r.n})` : '無';
for (const { name, W } of WEIGHTS) {
  const { results, pooledDays, candTotal } = run({ inst: instByDate, close: closeByDate, dates, W });
  console.log(`\n【${name}】 回測日數 ${pooledDays}、平均候選 ${(candTotal / (pooledDays || 1)).toFixed(0)} 檔/日`);
  console.log(`  Top5  基準: ${fmt(results.base[5])}`);
  console.log(`  Top5  加權: ${fmt(results.wt[5])}`);
  console.log(`  Top10 基準: ${fmt(results.base[10])}`);
  console.log(`  Top10 加權: ${fmt(results.wt[10])}`);
}
process.exit(0);
