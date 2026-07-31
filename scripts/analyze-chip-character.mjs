#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 法人籌碼「炒作 vs 長期持有」分類 + 隔日沖 walk-forward 回測
//
// 讀 chipArchive 全部歷史(3年回填 + 既有)，對每檔算籌碼性格指標，分類為
//   長期核心 / 炒作型 / 一般，並給 0-100 炒作活躍度分數。
// 再做 walk-forward 回測：驗證「限炒作型/降權長期核心」能否提升隔日沖 T+1 勝率。
//
// 輸出：
//   --write   將分類寫入 chipCharacter/latest（daemon 之外的一次性初始化）
//   （預設只印報告，不寫入）
//
// 誠實原則：揭露樣本數、費稅拖累、存活者偏誤；無提升就如實回報。非投資建議。
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const WRITE = process.argv.includes('--write');

// 隔日沖費稅：買賣各手續費 0.1425%×折讓(估 0.5) + 賣出證交稅 0.3%
const FEE_RATE = 0.001425 * 0.5;
const TAX_RATE = 0.003;
const ROUND_TRIP_COST = FEE_RATE * 2 + TAX_RATE; // ≈ 0.4425%

const MIN_OBS = 60;        // 分類最少觀測日
const CORR_LAG_DAYS = 3;   // 籌碼領先報酬的前瞻窗

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const sum = (a) => a.reduce((s, x) => s + x, 0);
function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 10) return 0;
  const mx = mean(xs.slice(0, n)), my = mean(ys.slice(0, n));
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}
const pct = (sortedAsc, v) => {
  // v 在升冪陣列的百分位 0..1
  let lo = 0, hi = sortedAsc.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sortedAsc[m] < v) lo = m + 1; else hi = m; }
  return sortedAsc.length ? lo / sortedAsc.length : 0;
};

// ── 載入全部 chipArchive，建立全域日期軸與每檔序列 ──
async function loadAll() {
  const docs = await db.collection('chipArchive').get();
  const byDate = [];
  docs.forEach((d) => {
    const x = d.data();
    if (!x || !x.instJson || !x.closeJson) return;
    byDate.push({ date: x.date || d.id, inst: JSON.parse(x.instJson), close: JSON.parse(x.closeJson) });
  });
  byDate.sort((a, b) => a.date.localeCompare(b.date));

  // 全域交易日序號 + 日曆鄰近旗標：nextAdj[o]=下一序號是否日曆≤4天(排除資料缺口誤算隔日)
  const ordOf = new Map();
  byDate.forEach((d, i) => ordOf.set(d.date, i));
  const nextAdj = new Array(byDate.length).fill(false);
  for (let i = 0; i < byDate.length - 1; i++) {
    const diff = Math.round((new Date(byDate[i + 1].date) - new Date(byDate[i].date)) / 86400000);
    nextAdj[i] = diff >= 1 && diff <= 4;
  }

  // 每檔：{dates, ord, net, close, vol}（僅收錄該日同時有 inst+close 的點；ord 遞增）
  const series = new Map();
  for (const day of byDate) {
    for (const code of Object.keys(day.close)) {
      const cl = day.close[code];        // [收,量張,開,高,低]
      const iv = day.inst[code];         // [外資張,投信張]
      if (!cl || !(cl[0] > 0)) continue;
      const net = iv ? (iv[0] + iv[1]) : 0;
      if (!series.has(code)) series.set(code, { dates: [], ord: [], net: [], close: [], vol: [] });
      const s = series.get(code);
      s.dates.push(day.date); s.ord.push(ordOf.get(day.date)); s.net.push(net); s.close.push(cl[0]); s.vol.push(cl[1] || 0);
    }
  }
  return { byDate, series, nextAdj };
}

// 隔日報酬（僅在下一筆是真正相鄰交易日 且 日曆≤4天時有效）：回傳 { idx:[], ret:[] }（對齊 net_t）
function nextDayReturns(s, nextAdj) {
  const idx = [], ret = [];
  for (let i = 0; i < s.close.length - 1; i++) {
    if (s.ord[i + 1] === s.ord[i] + 1 && nextAdj[s.ord[i]]) { idx.push(i); ret.push(s.close[i + 1] / s.close[i] - 1); }
  }
  return { idx, ret };
}

// ── 每檔性格指標 ──
function metricsFor(s, nextAdj) {
  const n = s.close.length;
  if (n < MIN_OBS) return null;
  // 籌碼領先：net_t 對「真正相鄰隔日」報酬（隔日沖語意），跨停牌/資料缺口不計
  const nd = nextDayReturns(s, nextAdj);
  const netAtRet = nd.idx.map((i) => s.net[i]);
  const chipLeadCorr = pearson(netAtRet, nd.ret);

  const absNet = s.net.map(Math.abs);
  const totAbs = sum(absNet), totVol = sum(s.vol) || 1;
  const instVolShare = totAbs / totVol;                 // 法人週轉佔量
  const netBias = totAbs ? sum(s.net) / totAbs : 0;      // 單向長抱↔來回
  // 累計部位回吐比例
  let cum = 0, peak = 0, peakIdx = 0;
  const cums = s.net.map((x) => (cum += x));
  cums.forEach((v, i) => { if (v > peak) { peak = v; peakIdx = i; } });
  const finalCum = cums[cums.length - 1];
  const unwindRatio = peak > 0 ? Math.max(0, (peak - finalCum) / peak) : 0;
  const turnoverValue = mean(s.close.map((c, i) => c * s.vol[i])); // 均成交值(張×價)

  return { n, instVolShare, netBias, chipLeadCorr, unwindRatio, turnoverValue };
}

// ── 分類 + 炒作分數（依全體分布百分位標準化）──
function classifyAll(metricsMap) {
  const arr = [...metricsMap.entries()];
  const dist = (key) => arr.map(([, m]) => m[key]).sort((a, b) => a - b);
  const dShare = dist('instVolShare'), dCorr = dist('chipLeadCorr'),
    dUnwind = dist('unwindRatio'), dTurn = dist('turnoverValue'), dBias = arr.map(([, m]) => Math.abs(m.netBias)).sort((a, b) => a - b);

  const out = new Map();
  for (const [code, m] of arr) {
    const pShare = pct(dShare, m.instVolShare);
    const pCorr = pct(dCorr, m.chipLeadCorr);           // 高=籌碼領先強
    const pUnwind = pct(dUnwind, m.unwindRatio);
    const pTurn = pct(dTurn, m.turnoverValue);
    const pBias = pct(dBias, Math.abs(m.netBias));

    // 炒作分數：週轉高×0.30 + 籌碼領先×0.40 + 回吐週期×0.20 + 中小規模×0.10
    const specScore = Math.round(100 * (
      0.30 * pShare + 0.40 * Math.max(0, pCorr) + 0.20 * pUnwind + 0.10 * (1 - pTurn)
    ));
    // 長期核心分數：強單向 + 低週轉 + 低領先 + 大規模
    const coreScore = 100 * (0.35 * pBias + 0.25 * (1 - pShare) + 0.20 * (1 - pCorr) + 0.20 * pTurn);

    let label = '一般';
    // 長期核心需有實質法人活動與規模（排除 bias=±1 的殭屍小股——法人零星單向漏單非「長抱」）
    if (coreScore >= 62 && specScore < 45 && pTurn >= 0.4) label = '長期核心';
    else if (specScore >= 62) label = '炒作型';

    out.set(code, { ...m, specScore, coreScore: Math.round(coreScore), label });
  }
  return out;
}

// ── walk-forward 隔日沖多訊號回測 ──
// 隔日沖：當日收盤買、隔日收盤賣，報酬扣費稅。分類採「至訊號日為止的過去窗」避免前視。
// 訊號組（同一批候選點上比較，公平對照）：
//   S1 naive        三大法人淨買/量 ≥ th
//   S2 投信主導      投信淨買/量 ≥ th（投信短線較銳利）
//   S3 起漲翻買      三大法人今日淨買>0 且 昨日淨買≤0（連買啟動首日）
//   S4 炒作×起漲     S3 且 該檔(即時分類)為炒作傾向
//   S5 排除長期核心   S1 且 該檔非長期核心（驗證使用者核心假設：長抱法人訊號是雜訊）
function backtest(byDate, series, nextAdj, opts) {
  const { threshold = 0.05, trainDays = 120, minVolLots = 300 } = opts;
  const idxOf = new Map();
  for (const [code, s] of series) { const m = new Map(); s.dates.forEach((dt, i) => m.set(dt, i)); idxOf.set(code, m); }

  const arms = { S1: [], S2: [], S3: [], S4: [], S5: [] };
  for (let di = trainDays; di < byDate.length - 1; di++) {
    const day = byDate[di], prev = byDate[di - 1];
    for (const code of Object.keys(day.inst)) {
      const cl = day.close[code]; const iv = day.inst[code];
      if (!cl || !(cl[0] > 0) || !iv) continue;
      const vol = cl[1] || 0; if (vol < minVolLots) continue;
      const foreign = iv[0], trust = iv[1], net = foreign + trust;
      const s = series.get(code); const im = idxOf.get(code); if (!s || !im) continue;
      const i = im.get(day.date); if (i == null || i + 1 >= s.close.length) continue;
      if (s.ord[i + 1] !== s.ord[i] + 1 || !nextAdj[s.ord[i]]) continue; // 真正相鄰隔日(日曆≤4天)
      const ret = s.close[i + 1] / s.close[i] - 1 - ROUND_TRIP_COST;

      // 即時分類（僅在需要時算，省成本）
      let m = null;
      const classify = () => {
        if (m !== null) return m;
        const past = { ord: s.ord.slice(0, i + 1), net: s.net.slice(0, i + 1), close: s.close.slice(0, i + 1), vol: s.vol.slice(0, i + 1), dates: s.dates.slice(0, i + 1) };
        m = past.close.length >= MIN_OBS ? metricsFor(past, nextAdj) : undefined;
        return m;
      };
      const prevIv = prev.inst[code]; const prevNet = prevIv ? prevIv[0] + prevIv[1] : 0;

      // S1
      if (net > 0 && net / vol >= threshold) {
        arms.S1.push(ret);
        // S5：排除長期核心（core 傾向：強單向 bias + 低領先 + 低週轉）
        const mm = classify();
        const isCore = mm && Math.abs(mm.netBias) > 0.35 && mm.chipLeadCorr < 0.1 && mm.instVolShare < 0.12;
        if (!isCore) arms.S5.push(ret);
      }
      // S2 投信主導
      if (trust > 0 && trust / vol >= threshold) arms.S2.push(ret);
      // S3 起漲翻買（今日轉正、昨日非正）
      if (net > 0 && prevNet <= 0 && net / vol >= threshold * 0.6) {
        arms.S3.push(ret);
        const mm = classify();
        const isSpec = mm && mm.chipLeadCorr > 0.1 && mm.instVolShare > 0.1;
        if (isSpec) arms.S4.push(ret);
      }
    }
  }
  const stat = (a) => a.length ? {
    n: a.length,
    win: +(a.filter((r) => r > 0).length / a.length * 100).toFixed(1),
    avg: +(mean(a) * 100).toFixed(2),
    med: +(a.slice().sort((x, y) => x - y)[a.length >> 1] * 100).toFixed(2),
  } : { n: 0, win: 0, avg: 0, med: 0 };
  const out = { threshold }; for (const k of Object.keys(arms)) out[k] = stat(arms[k]);
  return out;
}

async function main() {
  const { byDate, series, nextAdj } = await loadAll();
  console.log(`[chip] 載入 ${byDate.length} 交易日，${series.size} 檔序列。日期 ${byDate[0]?.date}→${byDate[byDate.length - 1]?.date}`);
  if (byDate.length < MIN_OBS + 5) console.log(`[chip] ⚠ 樣本僅 ${byDate.length} 日，統計力有限（乾跑除錯用）。`);

  const metricsMap = new Map();
  for (const [code, s] of series) { const m = metricsFor(s, nextAdj); if (m) metricsMap.set(code, m); }
  console.log(`[chip] ${metricsMap.size} 檔達 ${MIN_OBS} 日門檻，可分類。`);

  const cls = classifyAll(metricsMap);
  const byLabel = { 長期核心: [], 炒作型: [], 一般: [] };
  for (const [code, c] of cls) byLabel[c.label].push(code);
  console.log(`[chip] 分類：長期核心 ${byLabel.長期核心.length}、炒作型 ${byLabel.炒作型.length}、一般 ${byLabel.一般.length}`);

  const show = (codes, n = 12) => codes
    .map((c) => ({ c, s: cls.get(c) }))
    .sort((a, b) => (b.s.specScore - a.s.specScore))
    .slice(0, n)
    .map(({ c, s }) => `${c}(炒${s.specScore}/核${s.coreScore} 領先${s.chipLeadCorr.toFixed(2)} 佔量${(s.instVolShare * 100).toFixed(0)}% 偏${s.netBias.toFixed(2)})`)
    .join('\n    ');
  console.log('\n  【炒作型 top】\n    ' + show(byLabel.炒作型));
  console.log('\n  【長期核心 sample】\n    ' + byLabel.長期核心.slice(0, 12).map((c) => { const s = cls.get(c); return `${c}(核${s.coreScore} 偏${s.netBias.toFixed(2)} 佔量${(s.instVolShare * 100).toFixed(0)}%)`; }).join('\n    '));

  console.log('\n[chip] ── 隔日沖 walk-forward 多訊號回測（費稅後 ' + (ROUND_TRIP_COST * 100).toFixed(2) + '% 已扣）──');
  const NAMES = { S1: 'naive法人買超', S2: '投信主導', S3: '起漲翻買', S4: '炒作×起漲', S5: '排除長期核心' };
  for (const th of [0.03, 0.05, 0.08]) {
    const r = backtest(byDate, series, nextAdj, { threshold: th });
    console.log(`  門檻 佔量≥${(th * 100).toFixed(0)}%：`);
    for (const k of ['S1', 'S2', 'S3', 'S4', 'S5']) {
      const x = r[k];
      const flag = x.n >= 30 && x.avg > 0 ? ' ✅正期望' : '';
      console.log(`    ${k} ${NAMES[k].padEnd(6, '　')}: n=${String(x.n).padStart(5)} 勝率${x.win}% 均報酬${x.avg}% 中位${x.med}%${flag}`);
    }
  }

  if (WRITE) {
    // 三法人 20 日累計＋連買/連賣日數：取 chipDaily 近 30 檔（codesJson: code→[外資,投信,自營] 張）
    const daily = [];
    try {
      const ds = await db.collection('chipDaily').get();
      ds.forEach((d) => { const x = d.data(); if (x?.codesJson) daily.push({ date: x.date || d.id, m: JSON.parse(x.codesJson) }); });
      daily.sort((a, b) => a.date.localeCompare(b.date));
    } catch { /* 無 chipDaily 時三法人欄留空 */ }
    const last20 = daily.slice(-20);
    const instOf = (code) => {
      if (!last20.length) return {};
      let f = 0, t = 0, dl = 0, has = false;
      const seq = []; // 由舊到新的三大合計方向（供連買連賣）
      for (const day of last20) {
        const v = day.m[code];
        if (v) { f += v[0] || 0; t += v[1] || 0; dl += v[2] || 0; has = true; }
        seq.push(v || null);
      }
      if (!has) return {};
      const streakOf = (idx) => { // 從最新往回數同向天數；正=連買、負=連賣
        let s = 0;
        for (let i = seq.length - 1; i >= 0; i--) {
          const v = seq[i] ? seq[i][idx] || 0 : 0;
          if (v > 0) { if (s < 0) break; s++; }
          else if (v < 0) { if (s > 0) break; s--; }
          else break;
        }
        return s;
      };
      return { f20: f, t20: t, d20: dl, fStreak: streakOf(0), tStreak: streakOf(1), dStreak: streakOf(2) };
    };
    const byCode = {};
    for (const [code, c] of cls) byCode[code] = { label: c.label, spec: c.specScore, core: c.coreScore, corr: +c.chipLeadCorr.toFixed(3), share: +c.instVolShare.toFixed(3), bias: +c.netBias.toFixed(3), ...instOf(code) };
    await db.collection('chipCharacter').doc('latest').set({
      byCodeJson: JSON.stringify(byCode),
      counts: { core: byLabel.長期核心.length, spec: byLabel.炒作型.length, normal: byLabel.一般.length },
      window: { from: byDate[0]?.date, to: byDate[byDate.length - 1]?.date, days: byDate.length },
      at: Date.now(),
    });
    console.log('\n[chip] ✔ 已寫入 chipCharacter/latest（含三法人20日與連買連賣）');
  } else {
    console.log('\n[chip] （未加 --write，僅報告；分布確認後再寫入）');
  }
  process.exit(0);
}
main().catch((e) => { console.error('[chip] 失敗:', e); process.exit(1); });
