// ─────────────────────────────────────────────────────────────────────────────
// 🧠 AI 交易員經驗庫（2026-09-30 使用者：「讓交易員增加特徵訓練能力——失利的成為未來避開風險的辨別能力，
//   獲利的成為未來精準選股可靠度提升的能力；盤後空閒時間訓練，結果存第二大腦，未來方便其它功能使用」）
//
//   純函式（特徵、分段、學習、比對、呈現）；I/O 在 scripts/ai-lab-learn.mjs（盤後由 daemon 以獨立行程執行）。
//   · 樣本：{ key, date, f:{特徵:分段}, y:淨報酬（波段＝5 日淨%；當沖＝淨 R）, src }
//       key＝'swing'｜'dt-long'｜'dt-short'。
//   · 學法（可解釋、防過擬合）：每個「特徵=分段」與同 key 其餘樣本比較平均淨報酬（Welch t）；
//       日期前 70% 訓練、後 30% 驗證——**兩段方向一致且合併 |t|≥2、兩段樣本都夠**才算「已驗證」，
//       否則最多是「觀察中」（只記錄、不進 AI 決策）。
//   · 結果：risk（平均顯著較差＝該避開的條件）／edge（顯著較好＝可提高可靠度的條件）。
//   · 特徵只用決策當下（含）以前可得的資料，訓練與即時比對共用同一套函式——不偷看、口徑一致。
// ─────────────────────────────────────────────────────────────────────────────

export const LEARN_VERSION = 'lab-learn-v1';

// ── 分段表（固定切點＝可讀、可比；改切點＝改版本）───────────────────────────
const CUTS = {
  gain5: [[-Infinity, 0, '<0%'], [0, 5, '0~5%'], [5, 10, '5~10%'], [10, 20, '10~20%'], [20, Infinity, '≥20%']],
  gain20: [[-Infinity, 0, '<0%'], [0, 10, '0~10%'], [10, 30, '10~30%'], [30, 60, '30~60%'], [60, Infinity, '≥60%']],
  gain60: [[-Infinity, 0, '<0%'], [0, 20, '0~20%'], [20, 60, '20~60%'], [60, 100, '60~100%'], [100, Infinity, '≥100%']],
  chg1: [[-Infinity, -3, '<-3%'], [-3, 0, '-3~0%'], [0, 3, '0~3%'], [3, 7, '3~7%'], [7, 9.5, '7~9.5%'], [9.5, Infinity, '≥9.5%(近漲停)']],
  rsi5: [[-Infinity, 30, '<30'], [30, 50, '30~50'], [50, 70, '50~70'], [70, 85, '70~85'], [85, Infinity, '≥85']],
  rsi14: [[-Infinity, 40, '<40'], [40, 60, '40~60'], [60, 70, '60~70'], [70, 80, '70~80'], [80, Infinity, '≥80']],
  volX: [[-Infinity, 0.7, '<0.7倍'], [0.7, 1.3, '0.7~1.3倍'], [1.3, 2, '1.3~2倍'], [2, 3, '2~3倍'], [3, Infinity, '≥3倍']],
  vol20: [[-Infinity, 1.5, '<1.5%'], [1.5, 2.5, '1.5~2.5%'], [2.5, 4, '2.5~4%'], [4, Infinity, '≥4%']],
  streak: [[-Infinity, 1, '0日'], [1, 3, '1~2日'], [3, 5, '3~4日'], [5, Infinity, '≥5日']],
  maAbove: [[-Infinity, 1, '0條'], [1, 2, '1條'], [2, 3, '2條'], [3, Infinity, '3條']],
  amtM: [[-Infinity, 50, '<0.5億'], [50, 200, '0.5~2億'], [200, 1000, '2~10億'], [1000, Infinity, '≥10億']],
  pos20: [[-Infinity, 0.3, '<30%'], [0.3, 0.7, '30~70%'], [0.7, 0.9, '70~90%'], [0.9, Infinity, '≥90%']],
  riskPct: [[-Infinity, 1, '<1%'], [1, 2, '1~2%'], [2, 3, '2~3%'], [3, Infinity, '≥3%']],
  costR: [[-Infinity, 0.15, '<0.15R'], [0.15, 0.3, '0.15~0.3R'], [0.3, Infinity, '≥0.3R']],
  scorePct: [[-Infinity, 50, '<50%'], [50, 65, '50~65%'], [65, 80, '65~80%'], [80, Infinity, '≥80%']],
  partPct: [[-Infinity, 40, '<40%'], [40, 70, '40~70%'], [70, Infinity, '≥70%']],
};
export const FEATURE_LABEL = {
  gain5: '近5日漲幅', gain20: '近20日漲幅', gain60: '近60日漲幅', chg1: '當日漲跌', rsi5: 'RSI5', rsi14: 'RSI14', volX: '量比(當日/20日均量)',
  vol20: '20日波動', streak: '連漲天數', maAbove: '站上均線(5/20/60)', amtM: '20日均成交額', pos20: '20日區間位置',
  side: '方向', type: '型態', bucket: '觸發時段', riskPct: '每股風險(停損距離)', costR: '成本占R', scorePct: '規則符合度',
  marketPct: '大盤分項', stockPct: '個股分項', entryPct: '進場分項', regime: '大盤狀態', news: '新聞判讀', sector: '族群', warn: '警訊',
};
const bucketOf = (name, v) => {
  if (!Number.isFinite(v)) return null;
  for (const [lo, hi, label] of CUTS[name]) if (v >= lo && v < hi) return label;
  return null;
};

// ── 波段：日線特徵（days＝還原後「舊→新」[{date, m:{code:[收,量(張),開,高,低]}}]；只用 ≤t）──────────
export function dailyFeatures(days, t, code) {
  const row = days[t]?.m?.[code]; if (!row || !(row[0] > 0) || t < 60) return null;
  const c = k => days[t - k]?.m?.[code]?.[0];
  const closes = []; for (let k = 60; k >= 0; k--) { const v = c(k); if (!(v > 0)) return null; closes.push(v); }
  const n = closes.length - 1, last = closes[n];
  const ret = (a, b) => (b > 0 ? (a / b - 1) * 100 : NaN);
  const diffs = []; for (let i = 1; i <= n; i++) diffs.push(closes[i] - closes[i - 1]);
  const rsi = k => { let up = 0, dn = 0; for (const d of diffs.slice(-k)) (d > 0 ? (up += d) : (dn -= d)); return up + dn > 0 ? (up / (up + dn)) * 100 : 50; };
  let vs = 0, vk = 0; for (let k = 1; k <= 20; k++) { const v = days[t - k]?.m?.[code]?.[1]; if (v > 0) { vs += v; vk++; } }
  const avgVol = vk ? vs / vk : 0;
  const rets = []; for (let i = n - 19; i <= n; i++) rets.push(ret(closes[i], closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  let streak = 0; for (let i = n; i > 0 && closes[i] > closes[i - 1]; i--) streak++;
  const ma = k => closes.slice(n - k + 1).reduce((a, b) => a + b, 0) / k;
  const maAbove = [5, 20, 60].filter(k => last > ma(k)).length;
  const w20 = closes.slice(n - 19); const hi = Math.max(...w20), lo = Math.min(...w20);
  let amt = 0; for (let k = 0; k < 20; k++) { const r = days[t - k]?.m?.[code]; if (r?.[0] > 0) amt += r[0] * (r[1] || 0) * 1000; }
  const raw = { gain5: ret(last, closes[n - 5]), gain20: ret(last, closes[n - 20]), gain60: ret(last, closes[0]), chg1: ret(last, closes[n - 1]),
    rsi5: rsi(5), rsi14: rsi(14), volX: avgVol > 0 ? (row[1] || 0) / avgVol : NaN, vol20: sd, streak, maAbove, amtM: amt / 20 / 1e6, pos20: hi > lo ? (last - lo) / (hi - lo) : 0.5 };
  const f = {}; for (const k in raw) { const b = bucketOf(k, raw[k]); if (b) f[k] = b; }
  return { f, raw };
}

// ── 當沖：觸發當下的特徵（訓練用 daytradeJournal 條目；即時用觸發事件，欄位相同）──────────────
export function dtFeatures(e) {
  if (!e || !e.side || !e.type) return null;
  const f = { side: e.side === 'long' ? '做多' : '做空', type: e.type };
  const m = e.minute;
  if (Number.isFinite(m)) f.bucket = m < 570 ? '09:00-09:30' : m < 630 ? '09:30-10:30' : m < 750 ? '10:30-12:30' : '12:30-';
  const set = (k, v) => { const b = bucketOf(k, v); if (b) f[k] = b; };
  if (e.entry > 0 && e.d > 0) set('riskPct', (e.d / e.entry) * 100);
  set('costR', e.costR);
  const s = e.score;
  if (s?.knownMax > 0) set('scorePct', (s.total / s.knownMax) * 100);
  for (const [k, name] of [['market', 'marketPct'], ['stock', 'stockPct'], ['entry', 'entryPct']]) {
    const p = s?.parts?.[k]; if (p?.knownMax > 0) { const b = bucketOf('partPct', (p.score / p.knownMax) * 100); if (b) f[name] = b; }
  }
  if (e.regime) f.regime = String(e.regime).slice(0, 20);
  f.news = e.news ? String(e.news).slice(0, 10) : '無';
  f.sector = e.sector ? '有族群動能' : '無';
  for (const w of e.warnings || []) f[`warn:${String(w).replace(/[\d.]+/g, '#').slice(0, 24)}`] = '有';
  return { f };
}

// ── 學習 ─────────────────────────────────────────────────────────────────────
const stat = ys => {
  const n = ys.length; if (!n) return { n: 0, mean: NaN, sd: NaN, win: NaN };
  const mean = ys.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(ys.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, sd, win: (ys.filter(y => y > 0).length / n) * 100 };
};
const welchT = (a, b) => { if (a.n < 2 || b.n < 2) return 0; const se = Math.sqrt(a.sd ** 2 / a.n + b.sd ** 2 / b.n); return se > 0 ? (a.mean - b.mean) / se : 0; };
const r2 = v => (Number.isFinite(v) ? +v.toFixed(2) : null);

/**
 * samples → { key: { base, split, rules[] } }。minN：訓練段最少樣本；驗證段至少 max(10, minN/3)。
 */
export function learn(samples, { minN = { swing: 60, 'dt-long': 20, 'dt-short': 20 }, maxRules = 30 } = {}) {
  const out = {};
  for (const key of [...new Set(samples.map(s => s.key))]) {
    const S = samples.filter(s => s.key === key && Number.isFinite(s.y));
    const dates = [...new Set(S.map(s => s.date))].sort();
    const cut = dates[Math.floor(dates.length * 0.7)] ?? dates[dates.length - 1];
    const tr = S.filter(s => s.date < cut), ho = S.filter(s => s.date >= cut);
    const base = stat(S.map(s => s.y));
    const need = minN[key] ?? 30, needHo = Math.max(10, Math.round(need / 3));
    const combos = new Map();
    for (const s of S) for (const [k, v] of Object.entries(s.f)) { const id = `${k}=${v}`; if (!combos.has(id)) combos.set(id, { k, v }); }
    const rules = [];
    for (const [id, { k, v }] of combos) {
      const inB = x => x.f[k] === v;
      const all = stat(S.filter(inB).map(s => s.y)), rest = stat(S.filter(x => !inB(x)).map(s => s.y));
      if (all.n < 15) continue;
      const a = stat(tr.filter(inB).map(s => s.y)), aR = stat(tr.filter(x => !inB(x)).map(s => s.y));
      const b = stat(ho.filter(inB).map(s => s.y)), bR = stat(ho.filter(x => !inB(x)).map(s => s.y));
      const t = welchT(all, rest), tTr = welchT(a, aR), tHo = welchT(b, bR);
      const dir = Math.sign(all.mean - rest.mean);
      const consistent = a.n >= need && b.n >= needHo && Math.sign(a.mean - aR.mean) === dir && Math.sign(b.mean - bR.mean) === dir;
      const status = Math.abs(t) < 2 ? null : consistent ? 'validated' : 'observing';   // 合併顯著但驗證段未確認＝觀察中
      if (!status) continue;
      rules.push({ id, feature: k, bucket: v, label: `${FEATURE_LABEL[k] || (k.startsWith('warn:') ? `警訊「${k.slice(5)}」` : k)} ${k.startsWith('warn:') ? '' : v}`.trim(),
        kind: dir < 0 ? 'risk' : 'edge', status, n: all.n, mean: r2(all.mean), win: r2(all.win), restMean: r2(rest.mean), t: r2(t),
        // diff＝此條件 − 同期其餘（相對差才是判斷依據；各期整體行情不同，原始平均會誤導）
        train: { n: a.n, mean: r2(a.mean), diff: r2(a.mean - aR.mean), t: r2(tTr) }, holdout: { n: b.n, mean: r2(b.mean), diff: r2(b.mean - bR.mean), t: r2(tHo) } });
    }
    rules.sort((x, y) => (x.status === y.status ? Math.abs(y.t) - Math.abs(x.t) : x.status === 'validated' ? -1 : 1));
    out[key] = { base: { n: base.n, mean: r2(base.mean), win: r2(base.win) }, split: { cut, trainN: tr.length, holdoutN: ho.length, days: dates.length }, unit: key === 'swing' ? '5日淨%' : '淨R', rules: rules.slice(0, maxRules) };
  }
  return out;
}

/** 某筆候選符合哪些「已驗證」規則（只回 validated；觀察中不影響 AI） */
export function matchLessons(learned, key, f) {
  const L = learned?.[key]; if (!L || !f) return [];
  return L.rules.filter(r => r.status === 'validated' && f[r.feature] === r.bucket);
}
/** 給 prompt 的一行：⚠ 風險／✓ 優勢（附歷史 n、平均、勝率與整體比較） */
export function lessonText(r, unit) {
  return `${r.kind === 'risk' ? '⚠風險' : '✓優勢'}：${r.label}（歷史 n=${r.n}，平均 ${r.mean}${unit === '淨R' ? 'R' : '%'}、勝率 ${r.win}%；其餘 ${r.restMean}${unit === '淨R' ? 'R' : '%'}）`;
}

export function renderLearnMarkdown(doc) {
  const L = [`# 🧠 AI 交易員經驗庫 ${doc.date}`, '', `- 版本 ${doc.version}｜訓練完成 ${new Date(doc.at + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 16)}（台北）`,
    `- 方法：每個「特徵=分段」vs 同類其餘樣本的平均淨報酬（Welch t）；日期前 70% 訓練、後 30% 驗證，兩段方向一致且 |t|≥2 才「已驗證」並提供給 AI；其餘「觀察中」只記錄。`,
    `- 樣本來源：${Object.entries(doc.sources || {}).map(([k, v]) => `${k} ${v}`).join('、')}`, ''];
  for (const [key, x] of Object.entries(doc.learned || {})) {
    L.push(`## ${key === 'swing' ? '波段交易員' : key === 'dt-long' ? '當沖交易員·做多' : '當沖交易員·做空'}（${x.unit}；n=${x.base.n}、整體平均 ${x.base.mean}、勝率 ${x.base.win}%；驗證段自 ${x.split.cut}）`, '');
    if (!x.rules.length) { L.push('- 樣本不足或尚無顯著特徵', ''); continue; }
    L.push('| 狀態 | 類型 | 特徵 | n | 平均 | 勝率 | 其餘平均 | t | 訓練段 相對差 | 驗證段 相對差 |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const r of x.rules) L.push(`| ${r.status === 'validated' ? '已驗證' : '觀察中'} | ${r.kind === 'risk' ? '⚠風險' : '✓優勢'} | ${r.label} | ${r.n} | ${r.mean} | ${r.win}% | ${r.restMean} | ${r.t} | ${r.train.diff > 0 ? '+' : ''}${r.train.diff}（n${r.train.n}） | ${r.holdout.diff > 0 ? '+' : ''}${r.holdout.diff}（n${r.holdout.n}） |`);
    L.push('');
  }
  L.push('> 歷史統計不保證未來；模擬研究用，非投資建議。');
  return L.join('\n');
}
