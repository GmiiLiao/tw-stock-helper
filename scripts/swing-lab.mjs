// ─────────────────────────────────────────────────────────────────────────
// 🧪 swing-lab：波段技巧實證流水線（2026-08-15 使用者需求）
// 「檢視技巧→回測實證→後台視覺驗證→準確度高才生成 skill」的第一段。
//
// 事件驅動回測（與 bt-core 的逐日樣本互補）：進場後逐日跟蹤出場規則
// （移動停利/翻黑/破線/固定日），這是 bt-core 樣本框架做不到的路徑依賴出場。
// 承襲 bt-core 全部教訓：可交易宇宙 chg≤8.5%、量≥300張、費稅 0.4425%、
// 主窗（近480日）兩半一致性、獨立 OOT 窗（更早年段）、基準對照 delta。
// 同一 code 同時間只允許一個部位（不重疊）。
// 結果寫 swingLab/latest 供後台「波段技巧實驗室」（超管專用）視覺驗證。
// 非投資建議。
// ─────────────────────────────────────────────────────────────────────────
import admin from 'firebase-admin';
import { loadDays } from './lib/bt-core.mjs';
import { computePagoda } from './lib/pagoda.mjs';

const COST = 0.4425;
const MAX_HOLD = 40;

// ── 指標 ──────────────────────────────────────────────────────────────
function rsi(closes, period, idx) {
  if (idx < period) return null;
  let g = 0, l = 0;
  for (let k = idx - period + 1; k <= idx; k++) {
    const d = closes[k] - closes[k - 1];
    if (d > 0) g += d; else l -= d;
  }
  if (g + l === 0) return 50;
  return 100 * g / (g + l);
}
function ma(closes, period, idx) {
  if (idx + 1 < period) return null;
  let s = 0;
  for (let k = idx - period + 1; k <= idx; k++) s += closes[k];
  return s / period;
}
function vol20(closes, idx) {   // 20日日報酬標準差%
  if (idx < 20) return null;
  const rets = [];
  for (let k = idx - 19; k <= idx; k++) rets.push(closes[k] / closes[k - 1] - 1);
  const m = rets.reduce((s, v) => s + v, 0) / rets.length;
  return Math.sqrt(rets.reduce((s, v) => s + (v - m) ** 2, 0) / rets.length) * 100;
}
function atr(series, period, idx) {
  if (idx < period) return null;
  let s = 0;
  for (let k = idx - period + 1; k <= idx; k++) {
    const tr = Math.max(series.h[k] - series.l[k], Math.abs(series.h[k] - series.c[k - 1]), Math.abs(series.l[k] - series.c[k - 1]));
    s += tr;
  }
  return s / period;
}

// ── 資料成形：days → 每 code 序列（含法人）──────────────────────────
function buildSeries(days) {
  const S = {};
  for (let i = 0; i < days.length; i++) {
    const D = days[i];
    for (const code in D.close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const r = D.close[code];
      if (!r || !(r[0] > 0)) continue;
      const st = (S[code] ||= { di: [], c: [], v: [], o: [], h: [], l: [], f: [], t: [] });
      st.di.push(i); st.c.push(r[0]); st.v.push(r[1] || 0);
      st.o.push(r[2] ?? r[0]); st.h.push(r[3] ?? r[0]); st.l.push(r[4] ?? r[0]);
      const it = D.inst?.[code];
      st.f.push(it?.[0] ?? 0); st.t.push(it?.[1] ?? 0);   // 外資/投信 買賣超（張）
    }
  }
  return S;
}

// ── 事件驅動模擬 ──────────────────────────────────────────────────────
// entryFn(st,k,ctx) → true=今收買；exitFn(st,k,pos) → true=今收賣。
// pos = { ei(進場idx), entry, maxC, 附屬欄位 }。回傳成交清單。
function simulate(S, days, { entryFn, exitFn, label }) {
  const trades = [];
  for (const code in S) {
    const st = S[code];
    const n = st.c.length;
    if (n < 80) continue;
    let pos = null;
    for (let k = 61; k < n - 1; k++) {
      const chg = st.c[k - 1] > 0 ? (st.c[k] / st.c[k - 1] - 1) * 100 : 0;
      if (pos) {
        pos.maxC = Math.max(pos.maxC, st.c[k]);
        const held = k - pos.ei;
        if (held >= 1 && (exitFn(st, k, pos) || held >= MAX_HOLD)) {
          const net = (st.c[k] / pos.entry - 1) * 100 - COST;
          trades.push({ code, dEntry: days[st.di[pos.ei]].date, dExit: days[st.di[k]].date, held, net: +net.toFixed(3) });
          pos = null;
        }
        continue;
      }
      // 可交易宇宙：非漲停（chg≤8.5）、量≥300張
      if (chg > 8.5 || st.v[k] < 300) continue;
      if (entryFn(st, k, chg)) pos = { ei: k, entry: st.c[k], maxC: st.c[k] };
    }
  }
  return { label, trades };
}

// ── 技巧定義 ──────────────────────────────────────────────────────────
function starEntry(st, k) {   // ⭐三重確認＋波動 gate（波段模式現行訊號的重放）
  const r5 = rsi(st.c, 5, k);
  if (r5 == null || r5 >= 20) return false;
  if ((st.f[k - 1] + st.t[k - 1]) <= 0) return false;          // 法人 t-1 買超
  if (!(st.v[k - 1] > 0 && st.v[k] / st.v[k - 1] > 1.5)) return false;  // 量比>1.5
  const vv = vol20(st.c, k);
  return vv != null && vv >= 1.5;
}
function pagodaState(st, k) {   // 至 k 為止的寶塔線色（用近 60 根即可，O(1) 窗）
  const from = Math.max(0, k - 60);
  const pg = computePagoda(st.c.slice(from, k + 1), 3);
  return pg;
}

function defineTechniques() {
  return [
    {
      id: 'pagoda', name: '🗼 寶塔線（翻紅×月線上進·翻黑出）',
      desc: '進：寶塔翻紅當日且收>MA20；出：翻黑或跌破MA20（先到者）。',
      entryFn: (st, k) => {
        const m = ma(st.c, 20, k);
        if (m == null || st.c[k] <= m) return false;
        const pg = pagodaState(st, k);
        return pg.color === 'red' && pg.flip === 'up';
      },
      exitFn: (st, k) => {
        const m = ma(st.c, 20, k);
        const pg = pagodaState(st, k);
        return pg.color === 'green' || (m != null && st.c[k] < m);
      },
    },
    {
      id: 'pagodaLoose', name: '🗼 寶塔線寬鬆版（綠K且破月線才出）',
      desc: '進同上；出：綠K「且」收<MA20（使用者原始規則的字面版）。',
      entryFn: (st, k) => {
        const m = ma(st.c, 20, k);
        if (m == null || st.c[k] <= m) return false;
        const pg = pagodaState(st, k);
        return pg.color === 'red' && pg.flip === 'up';
      },
      exitFn: (st, k) => {
        const m = ma(st.c, 20, k);
        const pg = pagodaState(st, k);
        return pg.color === 'green' && m != null && st.c[k] < m;
      },
    },
    {
      id: 'starTrail', name: '⭐三重確認＋移動停利10%',
      desc: '進：現行⭐訊號；出：自持有期最高收盤回落10%（或滿40日）。對照組=⭐固定第5日。',
      entryFn: starEntry,
      exitFn: (st, k, pos) => st.c[k] <= pos.maxC * 0.90,
    },
    {
      id: 'starAtr', name: '⭐三重確認＋2×ATR移動停利',
      desc: '進：現行⭐訊號；出：收盤 < 持有期最高收 − 2×ATR(20)。',
      entryFn: starEntry,
      exitFn: (st, k, pos) => {
        const a = atr(st, 20, k);
        return a != null && st.c[k] <= pos.maxC - 2 * a;
      },
    },
    {
      id: 'starHold5', name: '⭐三重確認＋固定第5日（現行·對照組）',
      desc: '現行波段口徑重放：進⭐、第5個交易日收盤賣。',
      entryFn: starEntry,
      exitFn: (st, k, pos) => (k - pos.ei) >= 5,
    },
    {
      id: 'sitcom', name: '🏦 投信認養（連3買×佔量顯著）',
      desc: '進：投信連3日買超且3日累計≥20日均量5%；出：投信連2日賣超或第10日。',
      entryFn: (st, k) => {
        if (!(st.t[k - 1] > 0 && st.t[k - 2] > 0 && st.t[k - 3] > 0)) return false;
        let av = 0; for (let j = k - 20; j < k; j++) av += st.v[j];
        av /= 20;
        return av > 0 && (st.t[k - 1] + st.t[k - 2] + st.t[k - 3]) / av >= 0.05;
      },
      exitFn: (st, k, pos) => (st.t[k] < 0 && st.t[k - 1] < 0) || (k - pos.ei) >= 10,
    },
    {
      id: 'box', name: '📦 箱型收斂帶量突破',
      desc: '進：前20日箱寬<12%、今收破箱頂且量比>1.5；出：跌回箱頂之下或第10日。',
      entryFn: (st, k, chg) => {
        if (chg < 1) return false;
        let hi = 0, lo = Infinity;
        for (let j = k - 20; j < k; j++) { if (st.c[j] > hi) hi = st.c[j]; if (st.c[j] < lo) lo = st.c[j]; }
        if (!(lo > 0 && (hi / lo - 1) < 0.12)) return false;
        if (!(st.c[k] > hi)) return false;
        return st.v[k - 1] > 0 && st.v[k] / st.v[k - 1] > 1.5;
      },
      exitFn: (st, k, pos) => {
        if ((k - pos.ei) >= 10) return true;
        return st.c[k] < pos.entry * 0.985;   // 跌回箱頂（進場價≈箱頂）之下即假突破出場
      },
    },
  ];
}

// ── 統計 ──────────────────────────────────────────────────────────────
const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
function statBlock(trades) {
  if (!trades.length) return { n: 0 };
  const nets = trades.map(t => t.net);
  const wins = nets.filter(v => v > 0).length;
  const sorted = nets.slice().sort((a, b) => a - b);
  return {
    n: trades.length,
    netAvg: +avg(nets).toFixed(3),
    netMed: +sorted[sorted.length >> 1].toFixed(3),
    winRate: +(wins / nets.length * 100).toFixed(1),
    avgHold: +avg(trades.map(t => t.held)).toFixed(1),
    p10: +sorted[Math.floor(sorted.length * 0.1)].toFixed(2),
    p90: +sorted[Math.floor(sorted.length * 0.9)].toFixed(2),
  };
}
function splitByDate(trades, cut) {
  return [trades.filter(t => t.dEntry < cut), trades.filter(t => t.dEntry >= cut)];
}

async function main() {
  const t0 = Date.now();
  console.log('載入 991 日歸檔…');
  const days = await loadDays({ days: 930, lookback: 61 });
  console.log('days:', days.length, days[0].date, '→', days[days.length - 1].date);
  const S = buildSeries(days);
  console.log('序列 codes:', Object.keys(S).length);

  // 窗切分：主窗=近 480 個交易日、OOT=其之前（獨立年段）
  const mainStart = days[Math.max(0, days.length - 480)].date;
  const mainMid = days[Math.max(0, days.length - 240)].date;

  // 宇宙基準（delta 用）：每日全可交易樣本 5 日淨報酬——沿用既有實證值意義，
  // 這裡以「隨機進場持有5日」重放（同宇宙同成本）。
  const baseline = simulate(S, days, {
    label: 'baseline', entryFn: (st, k, chg) => (st.di[k] + st.c[k]) % 17 === 0 && chg <= 8.5,  // 決定性偽隨機抽樣
    exitFn: (st, k, pos) => (k - pos.ei) >= 5,
  });

  const out = { updatedAt: Date.now(), date: days[days.length - 1].date, mainStart, oootNote: `OOT=主窗前獨立年段（${days[0].date}~${mainStart}）`, techniques: [] };
  const baseMain = statBlock(baseline.trades.filter(t => t.dEntry >= mainStart));
  const baseOot = statBlock(baseline.trades.filter(t => t.dEntry < mainStart));
  out.baseline = { main: baseMain, oot: baseOot };
  console.log('基準（偽隨機持有5日）主窗:', JSON.stringify(baseMain), 'OOT:', JSON.stringify(baseOot));

  for (const tech of defineTechniques()) {
    const t1 = Date.now();
    const { trades } = simulate(S, days, tech);
    const mainT = trades.filter(t => t.dEntry >= mainStart);
    const ootT = trades.filter(t => t.dEntry < mainStart);
    const [h1, h2] = splitByDate(mainT, mainMid);
    const main = statBlock(mainT), oot = statBlock(ootT);
    const half1 = statBlock(h1), half2 = statBlock(h2);
    // 判定：主窗淨均>0 且 兩半同向 且 OOT 同向 且 主窗淨均 > 基準
    const dirOk = main.n >= 100 && main.netAvg > 0 && half1.n >= 30 && half2.n >= 30
      && Math.sign(half1.netAvg) === Math.sign(half2.netAvg) && half1.netAvg > 0
      && oot.n >= 50 && oot.netAvg > 0;
    const beatBase = main.netAvg != null && baseMain.netAvg != null && main.netAvg > baseMain.netAvg
      && oot.netAvg != null && baseOot.netAvg != null && oot.netAvg > baseOot.netAvg;
    const verdict = dirOk && beatBase ? 'pass' : (main.n < 100 ? 'insufficient' : 'fail');
    // 權益曲線（依出場日累加淨%·全期）
    const byExit = trades.slice().sort((a, b) => a.dExit.localeCompare(b.dExit));
    let cum = 0;
    const curveFull = byExit.map(t => { cum += t.net; return [t.dExit, +cum.toFixed(1)]; });
    const step = Math.max(1, Math.floor(curveFull.length / 160));
    const curve = curveFull.filter((_, i) => i % step === 0 || i === curveFull.length - 1);
    // 年度分解
    const perYear = {};
    for (const t of trades) { const y = t.dEntry.slice(0, 4); (perYear[y] ||= []).push(t.net); }
    const years = Object.entries(perYear).map(([y, arr]) => ({ y, n: arr.length, netAvg: +avg(arr).toFixed(3), winRate: +(arr.filter(v => v > 0).length / arr.length * 100).toFixed(1) }));
    out.techniques.push({
      id: tech.id, name: tech.name, desc: tech.desc, verdict,
      main, oot, half1, half2, years, curve,
      recent: trades.slice(-15).reverse(),
    });
    console.log(`${tech.name}: 主窗 n=${main.n} 淨均=${main.netAvg} 勝=${main.winRate}%｜兩半 ${half1.netAvg}/${half2.netAvg}｜OOT n=${oot.n} 淨均=${oot.netAvg}｜判定=${verdict}（${((Date.now() - t1) / 1000).toFixed(1)}s）`);
  }

  const db = admin.firestore();
  // Firestore 不允許巢狀陣列（curve 是 [[日期,累計]]）——整包只存 JSON 字串
  await db.collection('swingLab').doc('latest').set({ updatedAt: out.updatedAt, date: out.date, reportJson: JSON.stringify(out) });
  console.log(`✓ swingLab/latest 已寫入（${((Date.now() - t0) / 1000).toFixed(0)}s）`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
