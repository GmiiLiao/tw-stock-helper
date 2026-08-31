// ══════════════════════════════════════════════════════════════════
// 國際盤閘門實驗室（2026-08-31 使用者提問：08-28→08-31 準確率為何從 81.5% 掉到 21.4%）
//
// 已知事實（本檔要驗證的假設由此而來）：
//   · 08-28 全市場開高率 58.6%，模型命中 81.5% ⇒ 超額 +22.9pp
//   · 08-31 全市場開高率 20.3%，模型命中 21.4% ⇒ 超額 **+1.1pp**（幾乎失去區別力）
//   · 08-28 當晚 那斯達克 -0.52%、韓股 -0.55%
//   · 訓練出的模型明確包含國際盤條件（主模型「那斯達克漲>0.5%」、
//     軋空模型「韓股漲>1%」），但 computeSqueezePicks() **完全沒有引用模型**
//     ⇒ 國際盤這個發現被訓練出來、顯示在後台、然後忽略。
//
// 本檔要回答：把國際盤條件當成**當日發不發推薦**的閘門，是否真的提升？
// 紀律（與 docs/EXPERIMENTS.md 一致）：時間序 OOT 70/30、口徑對齊、只用 ≤t 的資料。
// ══════════════════════════════════════════════════════════════════
import { initializeApp, cert, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) initializeApp({ credential: applicationDefault() });
const db = getFirestore();
const say = (...a) => console.log(...a);
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

const DAYS = +(process.argv[2] || 250);

const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(DAYS).get();
const days = snap.docs.map(d => ({
  date: d.id,
  close: JSON.parse(d.data().closeJson || '{}'),
  margin: d.data().marginJson ? JSON.parse(d.data().marginJson) : null,
})).filter(d => Object.keys(d.close).length).reverse();

const g = (await db.collection('squeezeTraining').doc('global').get()).data();
const hist = g?.histJson ? JSON.parse(g.histJson) : {};
// PIT 對齊（第一版寫錯，會偷看未來）：
//   hist[sym]['2026-08-31'] 是美股 08-31 收盤＝台北 09-01 04:00，
//   發生在台股 08-31 開盤之後。台股 D 日開盤能用的，是 D 之前最近一個美股收盤
//   （週一開盤用的是上週五的美股）。
//   值是 {close, chg} 物件，要取 .chg（第一版當成數字比較，全部 false）。
const symDates = {};
for (const k in hist) symDates[k] = Object.keys(hist[k]).sort();
const gAt = (sym, date) => {
  const ds = symDates[sym]; if (!ds) return null;
  let lo = 0, hi = ds.length - 1, best = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (ds[mid] < date) { best = mid; lo = mid + 1; } else hi = mid - 1; }
  if (best < 0) return null;
  const v = hist[sym][ds[best]];
  return typeof v === 'object' ? (v?.chg ?? null) : (v ?? null);
};

say(`載入 ${days.length} 個交易日（${days[0]?.date} ~ ${days[days.length - 1]?.date}）`);

// 候選規則（與 computeSqueezePicks 對齊：漲≥5% ∧ 券資比≥5% ∧ 融券日增>0）
const rows = [];
for (let t = 1; t < days.length - 1; t++) {
  const prev = days[t - 1], cur = days[t], next = days[t + 1];
  if (!cur.margin || !prev.margin) continue;
  for (const code in cur.close) {
    const p = prev.close[code], c = cur.close[code], n = next.close[code];
    if (!Array.isArray(p) || !Array.isArray(c) || !Array.isArray(n)) continue;
    const pc = +p[0], cc = +c[0], no = +n[2];
    if (!(pc > 0) || !(cc > 0) || !(no > 0)) continue;
    const chg = (cc - pc) / pc * 100;
    if (chg < 5) continue;
    const m = cur.margin[code], mp = prev.margin[code];
    if (!Array.isArray(m) || !Array.isArray(mp)) continue;
    const fin = +m[0], shrt = +m[1];
    if (!(fin > 0) || !(shrt >= 0)) continue;
    const ratio = shrt / fin * 100;
    if (ratio < 5) continue;
    if (shrt - (+mp[1] || 0) <= 0) continue;          // 融券日增>0
    rows.push({ date: next.date, code, openRet: (no - cc) / cc * 100, chg, ratio, shrtChg: shrt - (+mp[1] || 0) });
  }
}
say(`候選樣本 ${rows.length} 筆（${new Set(rows.map(r => r.date)).size} 個適用日）`);

// 以「適用日」切 OOT
const dates = [...new Set(rows.map(r => r.date))].sort();
const cut = dates[Math.floor(dates.length * 0.7)];
const seg = r => (r.date < cut ? 'train' : 'oot');

const GATES = [
  ['無閘門（現況）', () => true],
  ['那斯達克 > 0%', d => (gAt('nasdaq', d) ?? 0) > 0],
  ['那斯達克 > 0.5%', d => (gAt('nasdaq', d) ?? 0) > 0.5],
  ['費半 > 0%', d => (gAt('sox', d) ?? 0) > 0],
  ['費半 > -1%', d => (gAt('sox', d) ?? 0) > -1],
  ['韓股 > 0%', d => (gAt('kospi', d) ?? 0) > 0],
  ['那斯達克>0 且 費半>-1%', d => (gAt('nasdaq', d) ?? 0) > 0 && (gAt('sox', d) ?? 0) > -1],
];

say('\n閘門                        訓練段 n/均值/勝率        樣本外 n/均值/勝率      樣本外淨勝');
const base = {};
for (const [name, fn] of GATES) {
  const out = {};
  for (const s of ['train', 'oot']) {
    const sel = rows.filter(r => seg(r) === s && fn(r.date));
    out[s] = { n: sel.length, mean: mean(sel.map(x => x.openRet)), win: sel.length ? sel.filter(x => x.openRet > 0).length / sel.length * 100 : 0 };
  }
  if (name.startsWith('無閘門')) { base.mean = out.oot.mean; base.win = out.oot.win; }
  const d = out.oot.mean - (base.mean ?? 0);
  say(`${name.padEnd(24)} ${String(out.train.n).padStart(5)} ${out.train.mean.toFixed(3).padStart(7)}% ${out.train.win.toFixed(1).padStart(5)}%   `
    + `${String(out.oot.n).padStart(5)} ${out.oot.mean.toFixed(3).padStart(7)}% ${out.oot.win.toFixed(1).padStart(5)}%   ${(d >= 0 ? '+' : '') + d.toFixed(3)}pp`);
}
// ── 安慰劑對照（docs/EXPERIMENTS.md 紀律：未超越「隨機最佳」的變體不採用）──
//   閘門是**按日**篩選的，所以安慰劑也必須按日隨機抽——
//   若按筆抽，等於偷偷打散了「同一天的股票一起被選中」這個結構，
//   會低估隨機的變異度、讓閘門看起來比實際更強。
const ootRows = rows.filter(r => seg(r) === 'oot');
const ootDates = [...new Set(ootRows.map(r => r.date))];
const best = GATES.find(x => x[0].startsWith('那斯達克>0 且'));
const kept = new Set(ootRows.filter(r => best[1](r.date)).map(r => r.date));
const nDays = kept.size;
// ⚠ 不能用 (x*1103515245+12345) % 2^31 這種 LCG：JS 是雙精度浮點，
//   乘積超過 2^53 就失去精度，數列會**退化**——第一版就是這樣，
//   跑出「隨機最佳」恰好等於閘門均值 2.514%，那是數列崩壞不是巧合。
//   假的安慰劑比沒有更危險，它會給出錯誤的信心。
//   改用 mulberry32：全程 32 位元整數運算，不碰精度上限。
let seed = 0x9e3779b9;   // 固定種子：可重現
const rand = () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const trials = [];
for (let it = 0; it < 500; it++) {
  const pick = new Set();
  const pool = [...ootDates];
  for (let k = 0; k < nDays && pool.length; k++) pick.add(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  const sel = ootRows.filter(r => pick.has(r.date));
  trials.push(mean(sel.map(x => x.openRet)));
}
trials.sort((a, b) => a - b);
const gateMean = mean(ootRows.filter(r => best[1](r.date)).map(x => x.openRet));
const p95 = trials[Math.floor(trials.length * 0.95)], maxT = trials[trials.length - 1];
say(`\n安慰劑（樣本外，按日隨機抽 ${nDays}/${ootDates.length} 天，500 次）：`);
say(`  隨機均值 中位 ${trials[Math.floor(trials.length / 2)].toFixed(3)}%｜95 分位 ${p95.toFixed(3)}%｜最佳 ${maxT.toFixed(3)}%`);
say(`  閘門均值 ${gateMean.toFixed(3)}%  ⇒ ${gateMean > maxT ? '**超越隨機最佳**' : gateMean > p95 ? '超越 95 分位（未超越隨機最佳）' : '⚠ 未超越 95 分位——不應採用'}`);

// ══ 降權變體：偏空日不空手，改為只取更嚴格的子集 ══════════════
//   硬閘門（那斯達克>0 且 費半>-1%）雖然把勝率拉到 74.8%，但推薦天數少 55%，
//   而且未超越隨機最佳 ⇒ 不採用。
//   降權的想法：偏空日仍推薦，但只留最強的那些——
//   這樣能與「無閘門」在**同一組天數**上比較，才是公平口徑
//   （硬閘門那個比較的是不同天數，本來就不對等）。
const bearDay = d => !((gAt('nasdaq', d) ?? 0) > 0 && (gAt('sox', d) ?? 0) > -1);
const VARIANTS = [
  ['無降權（現況）', () => true],
  ['偏空日只取 券資比≥15%', r => !bearDay(r.date) || r.ratio >= 15],
  ['偏空日只取 券資比≥20%', r => !bearDay(r.date) || r.ratio >= 20],
  ['偏空日只取 漲3~8.5%（不追高）', r => !bearDay(r.date) || (r.chg >= 3 && r.chg <= 8.5)],
  ['偏空日只取 融券日增≥100張', r => !bearDay(r.date) || r.shrtChg >= 100],
  ['偏空日 券資比≥15% 且 不追高', r => !bearDay(r.date) || (r.ratio >= 15 && r.chg <= 8.5)],
];
say('\n── 降權變體（全部 74 個樣本外交易日，口徑對等）──');
say('變體                              樣本外 n/均值/勝率      淨勝');
let baseM = null;
for (const [name, fn] of VARIANTS) {
  const sel = ootRows.filter(fn);
  const m = mean(sel.map(x => x.openRet));
  const w = sel.length ? sel.filter(x => x.openRet > 0).length / sel.length * 100 : 0;
  if (baseM === null) baseM = m;
  say(`${name.padEnd(30)} ${String(sel.length).padStart(5)} ${m.toFixed(3).padStart(7)}% ${w.toFixed(1).padStart(5)}%   ${((m - baseM) >= 0 ? '+' : '') + (m - baseM).toFixed(3)}pp`);
}
// 偏空日單獨看（問題就出在這些天）
const bearRows = ootRows.filter(r => bearDay(r.date));
say(`\n偏空日單獨（樣本外 ${new Set(bearRows.map(r => r.date)).size} 天、${bearRows.length} 筆）：`);
for (const [name, fn] of VARIANTS) {
  const sel = bearRows.filter(fn);
  if (!sel.length) { say(`  ${name.padEnd(30)} （無樣本）`); continue; }
  const m = mean(sel.map(x => x.openRet));
  const w = sel.filter(x => x.openRet > 0).length / sel.length * 100;
  say(`  ${name.padEnd(30)} ${String(sel.length).padStart(4)} 筆  ${m.toFixed(3).padStart(7)}%  勝率 ${w.toFixed(1)}%`);
}

// ── 降權變體的安慰劑：在**偏空日之內**隨機抽同樣筆數 ────────────
//   這個變體是按筆篩選（偏空日內挑股票），所以安慰劑也要按筆抽，
//   與前面「硬閘門按日抽」的口徑不同——用錯會得到錯的結論。
const bestVar = ['偏空日只取 券資比≥20%', r => !bearDay(r.date) || r.ratio >= 20];
const bearSel = bearRows.filter(bestVar[1]);
const kN = bearSel.length;
const tr2 = [];
for (let it = 0; it < 500; it++) {
  const pool = [...bearRows]; const pick = [];
  for (let k = 0; k < kN && pool.length; k++) pick.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  tr2.push(mean(pick.map(x => x.openRet)));
}
tr2.sort((a, b) => a - b);
const vm = mean(bearSel.map(x => x.openRet));
say(`\n安慰劑·降權（偏空日內隨機抽 ${kN}/${bearRows.length} 筆，500 次）：`);
say(`  隨機 中位 ${tr2[250].toFixed(3)}%｜95 分位 ${tr2[Math.floor(500 * 0.95)].toFixed(3)}%｜最佳 ${tr2[499].toFixed(3)}%`);
say(`  券資比≥20% ${vm.toFixed(3)}%  ⇒ ${vm > tr2[499] ? '**超越隨機最佳**' : vm > tr2[Math.floor(500 * 0.95)] ? '超越 95 分位（未超越隨機最佳）' : '⚠ 未超越 95 分位——不應採用'}`);

say(`\n切點：${cut}（訓練段 < 切點 ≤ 樣本外）`);
say('⚠ 只看樣本外。訓練段用來確認方向一致，不作為結論。');
