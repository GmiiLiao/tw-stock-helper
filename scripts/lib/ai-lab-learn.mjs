// ─────────────────────────────────────────────────────────────────────────────
// 🧠 AI 交易員經驗庫（2026-09-30 使用者：「讓交易員增加特徵訓練能力——失利的成為未來避開風險的辨別能力，
//   獲利的成為未來精準選股可靠度提升的能力；盤後空閒時間訓練，結果存第二大腦，未來方便其它功能使用」）
//
//   純函式（特徵、分段、學習、比對、呈現）；I/O 在 scripts/ai-lab-learn.mjs（盤後由 daemon 以獨立行程執行）。
//   · 樣本：{ key, date, f:{特徵:分段}, y:報酬（波段＝5 日%·未扣成本；當沖＝淨 R，當沖另案）, src }
//       key＝'swing'｜'dt-long'｜'dt-short'。
//   · 學法（可解釋、防過擬合）：每個「特徵=分段」與同 key 其餘樣本比較平均淨報酬（Welch t）；
//       日期前 70% 訓練、後 30% 驗證——**兩段方向一致且合併 |t|≥2、兩段樣本都夠**才算「已驗證」，
//       否則最多是「觀察中」（只記錄、不進 AI 決策）。波段與決策層 key 先減同日平均（以同日其他樣本為基準，見 DEMEAN_KEYS）。
//   · 結果：risk（平均顯著較差＝該避開的條件）／edge（顯著較好＝可提高可靠度的條件）。
//   · 特徵只用決策當下（含）以前可得的資料，訓練與即時比對共用同一套函式——不偷看、口徑一致。
//   · 決策層經驗（2026-10-01 使用者：「用戶開啟的 ai 實驗功能，取得的經驗也一併列為特徵訓練的來源」）：
//       swing-buy＝AI 實際成交的買進、swing-sell＝AI 實際成交的賣出，來源＝實驗帳戶＋所有會員 AI 帳戶。
//       ⚠ 候選池各帳戶相同（同一天同一份榜單）⇒ 會員的候選池對 swing 母體幾乎不增加樣本；真正新增的是「各帳戶依自己的資金、
//       持股與目標做出的不同買賣決策」。同一（決策日, 代號, 買/賣）跨帳戶 y 完全相同，只算一筆——重複計入只會讓 t 值假性變大。
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
  heldD: [[-Infinity, 3, '1~2日'], [3, 6, '3~5日'], [6, 11, '6~10日'], [11, 21, '11~20日'], [21, Infinity, '>20日']],
  pnlAtSell: [[-Infinity, -5, '<-5%'], [-5, 0, '-5~0%'], [0, 5, '0~5%'], [5, 15, '5~15%'], [15, Infinity, '≥15%']],
};
export const FEATURE_LABEL = {
  gain5: '近5日漲幅', gain20: '近20日漲幅', gain60: '近60日漲幅', chg1: '當日漲跌', rsi5: 'RSI5', rsi14: 'RSI14', volX: '量比(當日/20日均量)',
  vol20: '20日波動', streak: '連漲天數', maAbove: '站上均線(5/20/60)', amtM: '20日均成交額', pos20: '20日區間位置',
  side: '方向', type: '型態', bucket: '觸發時段', riskPct: '每股風險(停損距離)', costR: '成本占R', scorePct: '規則符合度',
  marketPct: '大盤分項', stockPct: '個股分項', entryPct: '進場分項', regime: '大盤狀態', news: '新聞判讀', sector: '族群', warn: '警訊',
  heldD: '已持有天數', pnlAtSell: '持有報酬(未扣費稅·賣出決策時)',
};
/** 各 key 的 y 單位（顯示用） */
export const LEARN_UNIT = { swing: '5日%（未扣成本）', 'swing-buy': '5日%（未扣成本）', 'swing-sell': '賣出避開%（賣後 5 日報酬取負號·未扣成本）' };
/** 各 key 的名稱（第二大腦／後台） */
export const LEARN_NAME = { swing: '波段交易員', 'swing-buy': 'AI 買進經驗（實驗＋會員帳戶）', 'swing-sell': 'AI 賣出經驗（實驗＋會員帳戶）', 'dt-long': '當沖交易員·做多', 'dt-short': '當沖交易員·做空' };
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

/**
 * 持股（賣出決策）特徵：決策日日線特徵＋已持有天數＋持有報酬（未扣成本）。訓練（AI 實際賣出）與即時（持股檢視）共用。
 * heldDays＝買進成交日到決策日的交易日數（含買進日，同 reviewHoldings）；pnlPct＝決策日收盤 ÷ 買進成交價 − 1（%）。
 */
export function holdingFeatures(days, t, code, { heldDays, pnlPct } = {}) {
  const D = dailyFeatures(days, t, code); if (!D) return null;
  const f = { ...D.f };
  const h = bucketOf('heldD', heldDays); if (h) f.heldD = h;
  const p = bucketOf('pnlAtSell', pnlPct); if (p) f.pnlAtSell = p;
  return { f, raw: { ...D.raw, heldDays, pnlPct } };
}

const twDateOf = at => (Number.isFinite(at) ? new Date(at + 8 * 3600e3).toISOString().slice(0, 10) : null);

/**
 * AI 決策層樣本。accounts＝[{ src, docs:[波段決策文件] }]（實驗帳戶放第一個：同一筆決策的特徵取第一個帳戶）；
 * y5(date, code)＝決策日之後第一個交易日開盤進、第 5 個交易日收盤的報酬 %（未扣成本；未到期回 null）。
 *   swing-buy：picks 有股數且 buyFills 有成交價（資金不足作廢的不算）→ f＝決策日日線特徵、y＝y5
 *   swing-sell：sellFills 有交易單 → f＝holdingFeatures、y＝−y5（賣後 5 日漲＝賣太早為負；跌＝賣得對為正）
 * 回傳 { samples, stats:{ buy:{src:筆數}, sell:{src:筆數}, distinctBuy, distinctSell } }；樣本不帶帳戶身分。
 */
export function decisionSamples(accounts, days, y5, { rawCloseOf = null } = {}) {
  const idx = new Map(days.map((d, i) => [d.date, i]));
  const seen = new Set(), samples = [];
  const stats = { buy: {}, sell: {}, distinctBuy: 0, distinctSell: 0 };
  const bump = (side, src) => { stats[side][src] = (stats[side][src] || 0) + 1; };
  for (const { src, docs } of accounts || []) for (const d of docs || []) {
    const t = idx.get(d.date); if (t == null) continue;
    for (const p of d.picks || []) {
      const fill = d.buyFills?.[p.code];
      if (!(p.position?.shares > 0) || !(fill?.px > 0) || fill.failed) continue;
      bump('buy', src);
      const k = `b:${d.date}:${p.code}`; if (seen.has(k)) continue;
      const F = dailyFeatures(days, t, p.code), y = y5(d.date, p.code);
      if (!F || y == null) continue;
      seen.add(k); samples.push({ key: 'swing-buy', date: d.date, code: p.code, f: F.f, y, src }); stats.distinctBuy++;
    }
    for (const [lk, sf] of Object.entries(d.sellFills || {})) {
      if (!sf?.ledger?.buy?.px || sf.failed) continue;
      const code = sf.code || lk.slice(lk.indexOf('_') + 1);
      bump('sell', src);
      const k = `s:${d.date}:${code}`; if (seen.has(k)) continue;
      // 持有報酬用「未還原」收盤（與即時持股檢視同口徑：成交價是當時的原始價；還原價遇減資／除權會失真·審查 LOW）
      const tb = idx.get(twDateOf(sf.ledger.buy.at)), close = rawCloseOf?.(d.date, code) ?? days[t].m?.[code]?.[0];
      const H = holdingFeatures(days, t, code, { heldDays: tb != null ? t - tb + 1 : NaN, pnlPct: close > 0 ? (close / sf.ledger.buy.px - 1) * 100 : NaN });
      const y = y5(d.date, code);
      if (!H || y == null) continue;
      seen.add(k); samples.push({ key: 'swing-sell', date: d.date, code, f: H.f, y: -y, src }); stats.distinctSell++;
    }
  }
  return { samples, stats };
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
// 決策層 key：同一天的 AI 決策共享當天行情——以「同日其他 AI 決策」為基準（y 減同日平均、同日至少 2 筆才可比），
//   且驗證要跨足夠多個日期。否則多一個會員只是在同一天多加樣本，t 值假性變大（2026-10-01 審查 MEDIUM：
//   模擬零效果特徵的假驗證率由 ~5% 升到 15~18%；去同日平均後維持 1.4~2.9%，且會員越多真效果越容易被驗證）。
// swing（2026-10-02 使用者核可）：母體每個取樣日數百檔、共享當天行情，問題同上且規模更大。真實資料安慰劑（同日內打亂特徵、
//   保留每日分段占比，100 輪）：未去均每輪假驗證 15.6 條／52 分段（29.9%，與實際已驗證 15 條相當），去均後 2.1 條（4.0%）；
//   實際已驗證 15→7 條。顯示仍用原始平均（mean／restMean），檢定與 rel 用同日相對值。
const DEMEAN_KEYS = new Set(['swing', 'swing-buy', 'swing-sell']);
const MIN_DATES = { train: 10, holdout: 5 };
const nDates = xs => new Set(xs.map(s => s.date)).size;

export function learn(samples, { minN = { swing: 60, 'swing-buy': 30, 'swing-sell': 30, 'dt-long': 20, 'dt-short': 20 }, maxRules = 30 } = {}) {
  const out = {};
  for (const key of [...new Set(samples.map(s => s.key))]) {
    let S = samples.filter(s => s.key === key && Number.isFinite(s.y));
    const demean = DEMEAN_KEYS.has(key);
    if (demean) {
      const g = new Map(); for (const s of S) { const a = g.get(s.date) || [0, 0]; a[0] += s.y; a[1]++; g.set(s.date, a); }
      S = S.filter(s => g.get(s.date)[1] >= 2).map(s => ({ ...s, yr: s.y, y: s.y - g.get(s.date)[0] / g.get(s.date)[1] }));
    }
    const rawY = s => (demean ? s.yr : s.y);   // 顯示用原始值；檢定用 y（決策層＝同日相對值）
    const dates = [...new Set(S.map(s => s.date))].sort();
    const cut = dates[Math.floor(dates.length * 0.7)] ?? dates[dates.length - 1];
    const tr = S.filter(s => s.date < cut), ho = S.filter(s => s.date >= cut);
    const base = stat(S.map(rawY));
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
      const consistent = a.n >= need && b.n >= needHo && Math.sign(a.mean - aR.mean) === dir && Math.sign(b.mean - bR.mean) === dir
        && (!demean || (nDates(tr.filter(inB)) >= MIN_DATES.train && nDates(ho.filter(inB)) >= MIN_DATES.holdout));
      const status = Math.abs(t) < 2 ? null : consistent ? 'validated' : 'observing';   // 合併顯著但驗證段未確認＝觀察中
      if (!status) continue;
      const allR = demean ? stat(S.filter(inB).map(rawY)) : all, restR = demean ? stat(S.filter(x => !inB(x)).map(rawY)) : rest;
      rules.push({ id, feature: k, bucket: v, label: `${FEATURE_LABEL[k] || (k.startsWith('warn:') ? `警訊「${k.slice(5)}」` : k)} ${k.startsWith('warn:') ? '' : v}`.trim(),
        kind: dir < 0 ? 'risk' : 'edge', status, n: all.n, mean: r2(allR.mean), win: r2(allR.win), restMean: r2(restR.mean), t: r2(t),
        ...(demean ? { rel: r2(all.mean - rest.mean) } : {}),   // 決策層：相對同日其他 AI 決策的平均差（檢定依據）
        // diff＝此條件 − 同期其餘（相對差才是判斷依據；各期整體行情不同，原始平均會誤導）
        train: { n: a.n, mean: r2(a.mean), diff: r2(a.mean - aR.mean), t: r2(tTr) }, holdout: { n: b.n, mean: r2(b.mean), diff: r2(b.mean - bR.mean), t: r2(tHo) } });
    }
    rules.sort((x, y) => (x.status === y.status ? Math.abs(y.t) - Math.abs(x.t) : x.status === 'validated' ? -1 : 1));
    out[key] = { base: { n: base.n, mean: r2(base.mean), win: r2(base.win) }, split: { cut, trainN: tr.length, holdoutN: ho.length, days: dates.length }, unit: LEARN_UNIT[key] ?? '淨R', rules: rules.slice(0, maxRules) };
  }
  return out;
}

/**
 * 賣出經驗的結論要與絕對方向一致才成立：「賣得對」須此條件賣後平均真的下跌（y＝避開的跌幅 > 0）、「賣太早」須賣後平均真的上漲。
 * 只是「比其他賣出好／差」但方向相反的（例：賣後仍漲 1%，只是其他賣出漲 3.7%）不下結論、不提供給 AI（2026-10-01 審查 MEDIUM）。
 */
export const sellVerdictOk = r => (r.kind === 'edge' ? r.mean > 0 : r.mean < 0);
/** 某筆候選符合哪些「已驗證」規則（只回 validated；觀察中不影響 AI；賣出經驗另須方向成立） */
export function matchLessons(learned, key, f) {
  const L = learned?.[key]; if (!L || !f) return [];
  return L.rules.filter(r => r.status === 'validated' && f[r.feature] === r.bucket && (key !== 'swing-sell' || sellVerdictOk(r)));
}
/** 規則的類型文字（後台／第二大腦）：賣出經驗方向不成立者標「相對」 */
export function kindText(key, r) {
  if (key !== 'swing-sell') return r.kind === 'risk' ? '⚠風險' : '✓優勢';
  if (!sellVerdictOk(r)) return r.kind === 'risk' ? '相對較差（不提供給 AI）' : '相對較佳（不提供給 AI）';
  return r.kind === 'risk' ? '⚠賣太早' : '✓賣得對';
}
/**
 * 給 prompt 的一行：⚠ 風險／✓ 優勢（附歷史 n、平均、勝率與整體比較）。key：swing｜swing-buy｜swing-sell。
 * swing 有 rel（去同日平均後的檢定依據）時句尾加「較同日其他候選 ±x%」——原始平均與其餘的高低可能與結論相反
 *   （例：⚠ 20日區間位置 30~70% 平均 0.54% 高於其餘 0.45%，但比同日其他候選低 0.23%）；舊文件沒有 rel ⇒ 文字不變。
 * swing-sell 的 y＝賣出避開的跌幅，給 AI 時換回直觀的「賣後 5 日平均漲跌」（正＝賣後續漲＝賣太早）。
 */
export function lessonText(r, unit, key = 'swing') {
  const sg = v => (v == null || !Number.isFinite(+v) ? '—' : `${v > 0 ? '+' : ''}${+(+v).toFixed(2)}`);
  const rel = r.rel ?? (r.mean != null && r.restMean != null ? r.mean - r.restMean : null);   // 相對同日其他 AI 決策
  if (key === 'swing-sell') return `${r.kind === 'risk' ? '⚠賣太早經驗' : '✓賣得對經驗'}：${r.label}（歷史 n=${r.n}，過去在此條件賣出後 5 日平均 ${sg(-r.mean)}%，較同日其他賣出 ${sg(rel == null ? null : -rel)}%）`;
  if (key === 'swing-buy') return `${r.kind === 'risk' ? '⚠風險' : '✓優勢'}（AI 過去買進經驗）：${r.label}（歷史 n=${r.n}，5 日平均 ${sg(r.mean)}%、勝率 ${r.win}%，較同日其他 AI 買進 ${sg(rel)}%）`;
  const relTxt = r.rel != null ? `；較同日其他候選 ${sg(r.rel)}%` : '';
  return `${r.kind === 'risk' ? '⚠風險' : '✓優勢'}：${r.label}（歷史 n=${r.n}，平均 ${r.mean}${unit === '淨R' ? 'R' : '%'}、勝率 ${r.win}%；其餘 ${r.restMean}${unit === '淨R' ? 'R' : '%'}${relTxt}）`;
}

export function renderLearnMarkdown(doc) {
  const L = [`# 🧠 AI 交易員經驗庫 ${doc.date}`, '', `- 版本 ${doc.version}｜訓練完成 ${new Date(doc.at + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 16)}（台北）`,
    `- 方法：每個「特徵=分段」vs 同類其餘樣本的平均淨報酬（Welch t）；日期前 70% 訓練、後 30% 驗證，兩段方向一致且 |t|≥2 才「已驗證」並提供給 AI；其餘「觀察中」只記錄。`,
    `- 波段與 AI 決策層以同日其他樣本為基準（先減同日平均，排除當天大盤漲跌）：檢定與訓練／驗證段相對差用同日相對值，表中平均、勝率、其餘平均為原始值。`,
    `- 樣本來源：${Object.entries(doc.sources || {}).map(([k, v]) => `${k} ${v}`).join('、')}`, ''];
  for (const [key, x] of Object.entries(doc.learned || {})) {
    L.push(`## ${LEARN_NAME[key] || key}（${x.unit}；n=${x.base.n}、整體平均 ${x.base.mean}、勝率 ${x.base.win}%；驗證段自 ${x.split.cut}）`, '');
    if (!x.rules.length) { L.push('- 樣本不足或尚無顯著特徵', ''); continue; }
    L.push('| 狀態 | 類型 | 特徵 | n | 平均 | 勝率 | 其餘平均 | t | 訓練段 相對差 | 驗證段 相對差 |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const r of x.rules) L.push(`| ${r.status === 'validated' ? '已驗證' : '觀察中'} | ${kindText(key, r)} | ${r.label} | ${r.n} | ${r.mean} | ${r.win}% | ${r.restMean} | ${r.t} | ${r.train.diff > 0 ? '+' : ''}${r.train.diff}（n${r.train.n}） | ${r.holdout.diff > 0 ? '+' : ''}${r.holdout.diff}（n${r.holdout.n}） |`);
    L.push('');
  }
  L.push('> 歷史統計不保證未來；模擬研究用，非投資建議。');
  return L.join('\n');
}
