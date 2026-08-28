#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 軋空濾網「漏網觸發條件」實驗室
//
// 起因（2026-08-28 使用者提問）：檢討報表逐日列出漏網，但**漏網的成因一直沒被
// 系統性記錄與回測**。5 日累積的漏網主因是 chg=4、shrtChg=4、ratio=0、vol=0——
// 也就是「當日漲幅<5%」與「融券日增≤0」這兩道擋掉了全部漏網，另兩道從沒擋錯。
// 實例：
//   6226  漲9.96% 券資比24.1% 融券日增 -12   → 隔日開盤 +9.95%（擋在 融券日增≤0）
//   4939  漲9.9%  券資比24.3% 融券日增-750   → +4.19%（同上）
//   6187  漲2.36% 券資比14.3% 融券日增+239   → +4.62%（擋在 漲幅<5%）
//   4979  漲-0.5% 券資比30.7% 融券日增+2210  → +3.51%（同上）
// 看起來像是：**券資比已經很高時，融券日增為負不必然否定**；**融券日增很大時，
// 漲幅不足也可能成立**。但「看起來像」不能當結論——所以有這支。
//
// 紀律（本專案踩過的坑，一條都不能省）：
//   · **時間序 OOT 切分**：前 70% 選參數，後 30% 只驗證一次。第一版軋空訓練
//     就是在 378 組裡挑出 83.8% 勝率的組合——那是過擬合。
//   · **安慰劑**：同樣張數的隨機抽樣跑一遍，作為「隨機也能拿到多少」的量尺。
//   · **口徑與線上一致**：隔日**開盤**買進（openRet），真機會＝開盤 ≥ +3%
//     （SQ_SUCCESS_OPEN），命中＝ret > 0。與 computeSqueezeReview 同一套。
//   · **precision 與 recall 一起看**：放寬濾網必然多抓，只報平均報酬會騙人。
//
// 用法：
//   node scripts/squeeze-gate-lab.mjs [--days=400] [--json]
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const arg = (k, d) => {
  const a = process.argv.find(x => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const DAYS = Number(arg('days', 400));
const AS_JSON = process.argv.includes('--json');

const SUCCESS_OPEN = 3;      // 真機會：隔日開盤 ≥ +3%（與 daemon 的 SQ_SUCCESS_OPEN 一致）
const HIT_OPEN = 0;          // 命中：ret > 0

const tickOf = p => (p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5);

// ── 載入 ───────────────────────────────────────────────────────────────
async function load() {
  const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(DAYS).get();
  const days = snap.docs.map(d => d.data()).filter(a => a?.closeJson).reverse().map(a => ({
    date: a.date,
    close: JSON.parse(a.closeJson),                       // code -> [close, volLots, open, ...]
    margin: a.marginJson ? JSON.parse(a.marginJson) : null, // code -> [融資餘額, 融券餘額]
  }));
  return days;
}

// ── 特徵（與 computeSqueezeReview.replayPicks 同一套定義）─────────────
function buildSamples(days) {
  const T = days.length;
  const mgAt = i => { for (let k = i; k >= 0 && k > i - 6; k--) if (days[k].margin) return k; return -1; };
  const avgVol = (t, c) => {
    let s = 0, k = 0;
    for (let i = Math.max(0, t - 19); i <= t; i++) { const v = days[i].close[c]?.[1] ?? 0; if (v > 0) { s += v; k++; } }
    return k ? s / k : 0;
  };
  const hi20 = (t, c) => { let h = 0; for (let q = 1; q <= 20; q++) { const v = days[t - q]?.close[c]?.[0] ?? 0; if (v > h) h = v; } return h; };

  const out = [];
  for (let t = 26; t < T - 1; t++) {
    const m1 = mgAt(t); if (m1 < 0) continue;
    const m2 = mgAt(m1 - 1); if (m2 < 0) continue;
    const nxt = days[t + 1];
    for (const code in days[m1].margin) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const mg = days[m1].margin[code];
      if (!mg || !(mg[0] > 0) || !(mg[1] > 0)) continue;
      const cur = days[t].close[code], p1 = days[t - 1]?.close[code], nx = nxt.close[code];
      if (!cur || !p1 || !nx) continue;
      const close = cur[0], prev = p1[0], nopen = nx[2];
      if (!(close > 10) || !(prev > 0) || !(nopen > 0)) continue;

      const av = avgVol(t, code);
      if (!(av >= 500)) continue;                          // 量能那道從沒擋錯，固定住縮小搜尋空間

      const raw = close * 1.1, tk = tickOf(raw);
      const limitNext = Math.floor(raw / tk + 1e-6) * tk;   // 隔日漲停價
      out.push({
        date: days[t].date, code,
        chg: ((close - prev) / prev) * 100,
        ratio: (mg[1] / mg[0]) * 100,                       // 券資比
        shrtChg: mg[1] - (days[m2].margin[code]?.[1] ?? 0), // 融券日增
        av, close,
        volX: (cur[1] ?? 0) / av,                           // 當日量 / 20日均量
        brk20: close >= hi20(t, code) && hi20(t, code) > 0, // 破 20 日高
        ret: ((nopen - close) / close) * 100,               // 隔日開盤報酬（線上口徑）
        buyable: nopen < limitNext - 1e-6,                  // 開盤即鎖漲停＝買不到
      });
    }
  }
  return out;
}

// ── 濾網變體 ───────────────────────────────────────────────────────────
// BASE 是線上定版；其餘每一條都只放寬**一個**已知會漏的閘門，好歸因。
const GATES = [
  { key: 'BASE', desc: '線上定版：漲≥5% × 券資比≥5% × 融券日增>0',
    f: s => s.chg >= 5 && s.ratio >= 5 && s.shrtChg > 0 },

  { key: 'V1', desc: '放寬融券日增：>0 **或** 券資比≥20%（空單已經很重時，單日回補不必然否定）',
    f: s => s.chg >= 5 && s.ratio >= 5 && (s.shrtChg > 0 || s.ratio >= 20) },
  { key: 'V1b', desc: '放寬融券日增：>0 或 券資比≥30%',
    f: s => s.chg >= 5 && s.ratio >= 5 && (s.shrtChg > 0 || s.ratio >= 30) },
  { key: 'V1c', desc: '融券日增改為 ≥0（允許持平）',
    f: s => s.chg >= 5 && s.ratio >= 5 && s.shrtChg >= 0 },

  { key: 'V2', desc: '放寬漲幅：≥5% 或（融券日增 ≥ 均量0.5%，即站上既有的「軋空啟動」定義）',
    f: s => s.ratio >= 5 && s.shrtChg > 0 && (s.chg >= 5 || s.shrtChg >= s.av * 0.005) },
  { key: 'V2b', desc: '放寬漲幅：≥3%',
    f: s => s.chg >= 3 && s.ratio >= 5 && s.shrtChg > 0 },
  { key: 'V2c', desc: '放寬漲幅：≥5% 或 破20日高',
    f: s => s.ratio >= 5 && s.shrtChg > 0 && (s.chg >= 5 || s.brk20) },

  { key: 'V3', desc: 'V1 + V2 兩道都放寬',
    f: s => s.ratio >= 5 && (s.shrtChg > 0 || s.ratio >= 20) && (s.chg >= 5 || s.shrtChg >= s.av * 0.005) },

  // ── 隔離組：**被 BASE 擋掉的那幾批單獨拿出來看** ─────────────────────
  // 前一輪證明「把它們加回 BASE」沒有增益。但那不等於它們本身沒價值——
  // 混進去被稀釋，與單獨成線是兩回事。若某一批單獨的樣本外均值明顯高於
  // 隨機基準，就值得另立一條**獨立**策略線（不同進場口徑、獨立回測）。
  { key: 'X1', desc: '隔離：漲≥5% × 券資比≥20% × **融券日增≤0**（BASE 擋掉的「高券資比但空單回補」）',
    f: s => s.chg >= 5 && s.ratio >= 20 && s.shrtChg <= 0 },
  { key: 'X2', desc: '隔離：券資比≥5% × 融券日增>0 × **漲<5%**（BASE 擋掉的「有軋空跡象但還沒發動」）',
    f: s => s.chg < 5 && s.ratio >= 5 && s.shrtChg > 0 },
  { key: 'X2b', desc: '隔離：X2 且融券日增 ≥ 均量0.5%（放量放空、股價還沒動）',
    f: s => s.chg < 5 && s.ratio >= 5 && s.shrtChg >= s.av * 0.005 },
  { key: 'X3', desc: '隔離：漲≥9%（近漲停）× 券資比≥20% × 融券日增≤0',
    f: s => s.chg >= 9 && s.ratio >= 20 && s.shrtChg <= 0 },
  { key: 'X4', desc: '隔離：X2 且破20日高（有軋空跡象＋剛創高但漲幅還小）',
    f: s => s.chg < 5 && s.ratio >= 5 && s.shrtChg > 0 && s.brk20 },

  { key: 'C1', desc: '對照：只有漲≥5%（純動能，不看券）',
    f: s => s.chg >= 5 },
  { key: 'C2', desc: '對照：只有券資比≥5%',
    f: s => s.ratio >= 5 },
];

// ── 統計 ───────────────────────────────────────────────────────────────
function stat(rows, universeB) {
  // ⚠ 只計「買得到」的：開盤即鎖漲停的部位實務上拿不到，計進來會虛胖
  const buy = rows.filter(r => r.buyable);
  const n = buy.length;
  if (!n) return { n: 0 };
  const mean = buy.reduce((a, b) => a + b.ret, 0) / n;
  const win = buy.filter(r => r.ret > HIT_OPEN).length / n * 100;
  const big = buy.filter(r => r.ret >= SUCCESS_OPEN).length;
  const caught = universeB ? buy.filter(r => r.ret >= SUCCESS_OPEN).length : null;
  return {
    n, mean: +mean.toFixed(3), win: +win.toFixed(1),
    bigRate: +(big / n * 100).toFixed(1),
    recall: universeB ? +(caught / universeB * 100).toFixed(1) : null,
    perDay: null,
  };
}

// 安慰劑：從同一母體隨機抽同樣張數，重複多次取平均與最佳
function placebo(pool, size, rounds = 200) {
  if (!pool.length || !size) return { mean: 0, best: 0 };
  let sum = 0, best = -1e9;
  // 固定種子的線性同餘，避免 Math.random（也讓結果可重現）
  let seed = 20260828;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let r = 0; r < rounds; r++) {
    let s = 0;
    for (let i = 0; i < size; i++) s += pool[Math.floor(rnd() * pool.length)].ret;
    const m = s / size;
    sum += m; if (m > best) best = m;
  }
  return { mean: +(sum / rounds).toFixed(3), best: +best.toFixed(3) };
}

// ── 主流程 ─────────────────────────────────────────────────────────────
const days = await load();
const samples = buildSamples(days);
const dates = [...new Set(samples.map(s => s.date))].sort();
const cut = dates[Math.floor(dates.length * 0.7)];
const train = samples.filter(s => s.date < cut);
const oot = samples.filter(s => s.date >= cut);

// 母體B：有空單可軋（券資比≥5%）且隔日開盤 ≥ +3%、且買得到
const uniB = seg => seg.filter(s => s.ratio >= 5 && s.ret >= SUCCESS_OPEN && s.buyable).length;
const trainB = uniB(train), ootB = uniB(oot);

const buyPool = samples.filter(s => s.buyable);

const rows = GATES.map(g => {
  const tr = train.filter(g.f), oo = oot.filter(g.f);
  const st = stat(tr, trainB), so = stat(oo, ootB);
  const pl = placebo(buyPool, so.n || 1);
  return { ...g, train: st, oot: so, placebo: pl,
    perDayOot: so.n ? +(so.n / new Set(oot.map(s => s.date)).size).toFixed(1) : 0 };
});

if (AS_JSON) { console.log(JSON.stringify({ cut, dates: dates.length, trainB, ootB, rows }, null, 1)); process.exit(0); }

console.log(`\n軋空濾網實驗｜樣本 ${samples.length} 筆 / ${dates.length} 交易日（${dates[0]} ~ ${dates[dates.length - 1]}）`);
console.log(`切分：訓練段 < ${cut}（${train.length} 筆）｜樣本外 ≥ ${cut}（${oot.length} 筆）`);
console.log(`母體B（券資比≥5% 且隔日開盤≥+3% 且買得到）：訓練段 ${trainB}｜樣本外 ${ootB}`);
console.log(`\n口徑：隔日**開盤**買進；只計買得到的（開盤鎖漲停不計）；命中＝ret>0；真機會＝ret≥+3%\n`);

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('變體', 6) + pad('訓練段 n/均值/勝率', 30) + pad('樣本外 n/均值/勝率/真機會率/召回', 46) + '每日檔數');
console.log('─'.repeat(120));
for (const r of rows) {
  const t = r.train, o = r.oot;
  const tS = t.n ? `${pad(t.n, 5)} ${pad(t.mean + '%', 9)} ${pad(t.win + '%', 8)}` : pad('—', 24);
  const oS = o.n ? `${pad(o.n, 5)} ${pad(o.mean + '%', 9)} ${pad(o.win + '%', 8)} ${pad(o.bigRate + '%', 8)} ${pad(o.recall + '%', 8)}` : pad('—', 40);
  console.log(pad(r.key, 6) + pad(tS, 30) + pad(oS, 46) + r.perDayOot);
}
console.log('\n安慰劑（同張數隨機抽樣·200 回）：');
for (const r of rows) {
  if (!r.oot.n) continue;
  const edge = +(r.oot.mean - r.placebo.mean).toFixed(3);
  console.log(`  ${pad(r.key, 6)} 樣本外 ${pad(r.oot.mean + '%', 9)}｜隨機平均 ${pad(r.placebo.mean + '%', 9)}｜隨機最佳 ${pad(r.placebo.best + '%', 9)}｜淨勝隨機 ${edge > 0 ? '+' : ''}${edge}pp${r.oot.mean <= r.placebo.best ? '  ⚠ 未超越隨機最佳' : ''}`);
}
console.log('\n說明：');
for (const r of rows) console.log(`  ${pad(r.key, 6)} ${r.desc}`);
console.log('\n⚠ 訓練段只用來看方向，**結論一律以樣本外為準**；未超越「隨機最佳」的變體不採用。');
process.exit(0);
