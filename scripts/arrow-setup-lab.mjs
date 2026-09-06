#!/usr/bin/env node
// ───────────────────────────────────────────────────────────
// 🎯 「箭頭 K 線」事件日回測（2026-09-05·使用者第二次澄清：要的是那一根虛線框的機會）
//
// 影片圖：平底盤整 → 一串小陽線（連陽）→ 【同一天】漲停 ∧ 向上跳空缺口 ∧ 倍量 → 停頓一兩天 → 主升行情
// 事件日 t 定義（全部同日）：
//   E1 漲停：c_t/c_{t-1} −1 ≥ 9.5%
//   E2 缺口：l_t > h_{t-1}（開盤就跳過昨高，整天不回補）
//   E3 倍量：v_t ≥ 2× 前 20 日均量（不含 t）
// 前置條件（t 之前）：
//   P1 連陽：[t−10, t−1] 內有 ≥4 天連續「收>開」
//   P2 平底：c_{t-1} 距 [t−20, t−1] 最低收盤 ≤ +15%，且該區間 (最高−最低)/最低 ≤ 30%（還沒漲過一段）
// 進場：A＝t+1 開盤；B＝t+2 開盤（影片停頓一兩天再啟動）。開盤即漲停買不到者剔除。
// 評估：5/10/20 日收盤淨報酬（成本 0.4425%）、真起漲、+10%/+20%/+30% 命中（20 日內最高收）、5 日最深回撤
// 對照：基準（宇宙全部 stock-day）、只 E1∧E2∧E3（無前置）、安慰劑（同量隨機）
// 宇宙：20 日均成交額 ≥ 5,000 萬；同檔 20 日內重複只算第一次
// ───────────────────────────────────────────────────────────
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync, writeFileSync } from 'node:fs';

initializeApp({ credential: cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'))) });
const db = getFirestore();
function mulberry32(seed) { return function () { let t = (seed += 0x6D2B79F5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const COST = 0.4425, WARM = 25, FWD = 20;
const RUN_MIN = +(process.env.RUN_MIN || 4);

const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(420).get();
const days = snap.docs.map(d => d.data()).filter(a => a.closeJson).map(a => ({ date: a.date, close: JSON.parse(a.closeJson) })).reverse();
let names = {};
try { const s = (await db.collection('marketSnapshot').doc('latest').get()).data(); const q = s?.quotesJson ? JSON.parse(s.quotesJson) : (s?.quotes || {}); for (const k in q) names[k] = q[k].name; } catch { /* 名稱可省 */ }
const pct = (a, b) => b > 0 ? (a - b) / b * 100 : null;

const rows = [];
for (let t = WARM; t < days.length - FWD; t++) {
  const D = days[t];
  for (const code of Object.keys(D.close)) {
    const ser = [];
    for (let k = t - WARM; k <= t; k++) { const x = days[k].close[code]; ser.push(Array.isArray(x) && x[0] > 0 && x[2] > 0 && x[3] > 0 && x[4] > 0 ? x : null); }
    if (ser.slice(-21).some(x => !x)) continue;
    const n = ser.length; const X = i => ser[n - 1 - i];          // X(0)=t, X(1)=t-1 …
    const c = i => X(i)[0], v = i => X(i)[1], o = i => X(i)[2], h = i => X(i)[3], l = i => X(i)[4];
    const avgAmt = Array.from({ length: 20 }, (_, i) => c(i + 1) * v(i + 1) * 1000).reduce((s, x) => s + x, 0) / 20;
    if (avgAmt < 50_000_000) continue;
    const chgT = pct(c(0), c(1));
    const base = Array.from({ length: 20 }, (_, i) => v(i + 1)).reduce((s, x) => s + x, 0) / 20;
    const E1 = chgT >= 9.5, E2 = l(0) > h(1), E3 = base > 0 && v(0) >= 2 * base;
    // P1 連陽（t-10..t-1 內最長連續收>開）
    let run = 0, best = 0; for (let i = 10; i >= 1; i--) { if (c(i) > o(i)) { run++; best = Math.max(best, run); } else run = 0; }
    const P1 = best >= RUN_MIN;
    // P2 平底
    const closes20 = Array.from({ length: 20 }, (_, i) => c(i + 1)); const lo = Math.min(...closes20), hi = Math.max(...closes20);
    const P2 = pct(c(1), lo) <= 15 && pct(hi, lo) <= 30;
    // ── 順序比對（2026-09-06 使用者：要照影片順序 平底→連陽→箭頭日）──
    let runAdj = 0, runEndOff = -1;                       // 緊鄰事件日的連陽（允許 t-1 或 t-2 結束，容忍一根停頓）
    for (const off of [1, 2]) { let r = 0; for (let i = off; i <= off + 9; i++) { if (c(i) > o(i)) r++; else break; } if (r > runAdj) { runAdj = r; runEndOff = off; } }
    const runGain = runAdj >= 2 ? pct(c(runEndOff), c(runEndOff + runAdj)) : null;   // 連陽段總漲幅
    const baseStart = runEndOff + runAdj + 1;              // 連陽之前的底部區 [t-baseStart-14, t-baseStart]
    const baseCl = Array.from({ length: 15 }, (_, i) => X(baseStart + i)).filter(Boolean).map(x => x[0]);
    const baseFlat = baseCl.length >= 10 ? pct(Math.max(...baseCl), Math.min(...baseCl)) : null;
    // 形狀模板：15 天平底(0) → 5 天緩升到 +8% → 事件日 +18%；候選取近 21 日收盤，相對 21 日前正規化
    const TEMPLATE = [...Array(15).fill(0), 1.6, 3.2, 4.8, 6.4, 8, 18];
    const path21 = Array.from({ length: 21 }, (_, i) => X(20 - i)?.[0]).filter(x => x > 0);
    let shape = null;
    if (path21.length === 21) { const b0 = path21[0]; const p = path21.map(x => (x - b0) / b0 * 100); const mean = a => a.reduce((s2, x) => s2 + x, 0) / a.length; const mp = mean(p), mt = mean(TEMPLATE); let num = 0, dp = 0, dt = 0; for (let i = 0; i < 21; i++) { num += (p[i] - mp) * (TEMPLATE[i] - mt); dp += (p[i] - mp) ** 2; dt += (TEMPLATE[i] - mt) ** 2; } shape = dp > 0 ? num / Math.sqrt(dp * dt) : null; }
    const n1 = days[t + 1].close[code], n2 = days[t + 2]?.close[code];
    if (!Array.isArray(n1) || !(n1[2] > 0)) continue;
    const fwd = k => days[t + k]?.close[code]?.[0] || null;
    const mk = (entry, from) => {
      if (!(entry > 0)) return null;
      const r5 = pct(fwd(5), entry), r10 = pct(fwd(10), entry), r20 = pct(fwd(20), entry);
      if (r5 == null || r10 == null || r20 == null) return null;
      let minLow5 = Infinity, maxC20 = -Infinity;
      for (let k = from; k <= from + 4; k++) { const x = days[t + k]?.close[code]; if (x?.[4] > 0) minLow5 = Math.min(minLow5, x[4]); }
      for (let k = from; k <= 20; k++) { const x = days[t + k]?.close[code]; if (x?.[0] > 0) maxC20 = Math.max(maxC20, x[0]); }
      const up = pct(maxC20, entry);
      return { entry, r5, r10, r20, mdd: pct(minLow5, entry), hit10: up >= 10, hit20: up >= 20, hit30: up >= 30, trueStart: minLow5 >= l(0) && up >= 5 };
    };
    const A = pct(n1[2], c(0)) >= 9.5 ? null : mk(n1[2], 1);
    const B = Array.isArray(n2) && n2[2] > 0 && pct(n2[2], n1[0]) < 9.5 ? mk(n2[2], 2) : null;
    rows.push({ code, t, date: D.date, E1, E2, E3, P1, P2, run: best, runAdj, runGain, baseFlat, shape, chgT, volX: base > 0 ? v(0) / base : 0, baseUp: pct(c(1), lo), A, B });
  }
}
// 市場事件日排除（2026-09-05 補）：當日宇宙內漲停 >60 檔＝全市場事件（2025-04-10 關稅反彈、2026-06-18…），不是個股形態
const luByDate = {}; for (const r of rows) if (r.E1) luByDate[r.date] = (luByDate[r.date] || 0) + 1;
const EVENT_DAYS = new Set(Object.entries(luByDate).filter(([, n]) => n > 60).map(([d]) => d));
if (process.env.EXCL_EVENT === '1') { const before = rows.length; for (let i = rows.length - 1; i >= 0; i--) if (EVENT_DAYS.has(rows[i].date)) rows.splice(i, 1); console.log(`排除市場事件日 ${EVENT_DAYS.size} 天（${[...EVENT_DAYS].sort().join(', ')}）：${before}→${rows.length}`); }
const splitT = days[WARM + Math.floor((days.length - WARM - FWD) * 0.7)].date;
const dedup = arr => { const last = {}; return arr.filter(r => { if (last[r.code] != null && r.t - last[r.code] < 20) return false; last[r.code] = r.t; return true; }); };
function stat(arr, k = 'A') {
  const a = arr.map(r => r[k]).filter(Boolean); const n = a.length; if (!n) return 'n=0';
  const m = f => a.reduce((s, r) => s + r[f], 0) / n, p = f => a.filter(r => r[f]).length / n * 100;
  const med = [...a].sort((x, y) => x.r20 - y.r20)[Math.floor(n / 2)].r20 - COST;
  return `n=${String(n).padStart(6)} 5日${(m('r5') - COST).toFixed(2).padStart(6)}% 10日${(m('r10') - COST).toFixed(2).padStart(6)}% 20日${(m('r20') - COST).toFixed(2).padStart(6)}%(中位${med.toFixed(2)}%) 勝20 ${(a.filter(r => r.r20 - COST > 0).length / n * 100).toFixed(1)}% 真起漲${p('trueStart').toFixed(1)}% 命中+10/+20/+30 ${p('hit10').toFixed(0)}/${p('hit20').toFixed(0)}/${p('hit30').toFixed(0)}% 5日最深${m('mdd').toFixed(2)}%`;
}
const out = []; const P = s => { console.log(s); out.push(s); };
P(`資料 ${days[0].date}→${days[days.length - 1].date}｜主窗 <${splitT}｜成本 ${COST}%｜連陽門檻 ≥${RUN_MIN}`);
const SETS = {
  '基準（宇宙全部）': r => true,
  '只 E1 漲停': r => r.E1,
  'E1∧E2 漲停且跳空': r => r.E1 && r.E2,
  'E1∧E2∧E3 事件日（無前置）': r => r.E1 && r.E2 && r.E3,
  '事件日 ∧ P1 連陽': r => r.E1 && r.E2 && r.E3 && r.P1,
  '事件日 ∧ P2 平底': r => r.E1 && r.E2 && r.E3 && r.P2,
  '🎯 箭頭：事件日 ∧ P1 ∧ P2': r => r.E1 && r.E2 && r.E3 && r.P1 && r.P2,
  '── 跳空漲停 × 量能分層（回答為何加倍量變差）──': () => false,
  'E1∧E2 ∧ 量<1×（鎖死縮量）': r => r.E1 && r.E2 && r.volX < 1,
  'E1∧E2 ∧ 量1–2×': r => r.E1 && r.E2 && r.volX >= 1 && r.volX < 2,
  'E1∧E2 ∧ 量2–4×': r => r.E1 && r.E2 && r.volX >= 2 && r.volX < 4,
  'E1∧E2 ∧ 量≥4×（爆量）': r => r.E1 && r.E2 && r.volX >= 4,
  'E1∧E2 ∧ P1 連陽（不限量）': r => r.E1 && r.E2 && r.P1,
  'E1∧E2 ∧ P2 平底（不限量）': r => r.E1 && r.E2 && r.P2,
  'E1∧E2 ∧ P1 ∧ P2（不限量）': r => r.E1 && r.E2 && r.P1 && r.P2,
  '── 順序比對（平底→緊鄰連陽→箭頭日）──': () => false,
  'SEQ3：事件日(含倍量) ∧ 緊鄰連陽≥3 ∧ 連陽漲幅2–15% ∧ 底部平坦≤30%': r => r.E1 && r.E2 && r.E3 && r.runAdj >= 3 && r.runGain >= 2 && r.runGain <= 15 && r.baseFlat != null && r.baseFlat <= 30,
  'SEQ3 ∧ 形狀相似 ≥0.8': r => r.E1 && r.E2 && r.E3 && r.runAdj >= 3 && r.runGain >= 2 && r.runGain <= 15 && r.baseFlat != null && r.baseFlat <= 30 && r.shape >= 0.8,
  'SEQ3 不限量': r => r.E1 && r.E2 && r.runAdj >= 3 && r.runGain >= 2 && r.runGain <= 15 && r.baseFlat != null && r.baseFlat <= 30,
  'SEQ3 不限量 ∧ 形狀 ≥0.8': r => r.E1 && r.E2 && r.runAdj >= 3 && r.runGain >= 2 && r.runGain <= 15 && r.baseFlat != null && r.baseFlat <= 30 && r.shape >= 0.8,
  'SEQ2：緊鄰連陽≥2（放寬）∧ 倍量 ∧ 平底': r => r.E1 && r.E2 && r.E3 && r.runAdj >= 2 && r.baseFlat != null && r.baseFlat <= 30,
  '── 支線候選：強勢連陽（段漲 >15%，連陽裡已含漲停）──': () => false,
  '支線A：緊鄰連陽≥3 ∧ 段漲15–40% ∧ 底平≤30%（不限量）': r => r.E1 && r.E2 && r.runAdj >= 3 && r.runGain > 15 && r.runGain <= 40 && r.baseFlat != null && r.baseFlat <= 30,
  '支線A ∧ 形狀≥0.8': r => r.E1 && r.E2 && r.runAdj >= 3 && r.runGain > 15 && r.runGain <= 40 && r.baseFlat != null && r.baseFlat <= 30 && r.shape >= 0.8,
  '支線B：段漲>40%（已噴一段）∧ 形狀≥0.8': r => r.E1 && r.E2 && r.runAdj >= 3 && r.runGain > 40 && r.shape >= 0.8,
  '主線+支線A 合併（段漲2–40%）∧ 形狀≥0.8': r => r.E1 && r.E2 && r.runAdj >= 3 && r.runGain >= 2 && r.runGain <= 40 && r.baseFlat != null && r.baseFlat <= 30 && r.shape >= 0.8,
  '形狀相似 ≥0.85 單獨（漲停跳空，不管連陽）': r => r.E1 && r.E2 && r.shape >= 0.85,
  '形狀相似 ≥0.85 ∧ 倍量': r => r.E1 && r.E2 && r.E3 && r.shape >= 0.85,
};
for (const [name, f] of Object.entries(SETS)) {
  const all = rows.filter(f), d = name.startsWith('基準') ? all : dedup(all);
  P(`\n▶ ${name}`);
  P(`  A(t+1開盤) 主窗 ${stat(d.filter(r => r.date < splitT))}`);
  P(`  A(t+1開盤) OOT  ${stat(d.filter(r => r.date >= splitT))}`);
  P(`  A(t+1開盤) 全部 ${stat(d)}`);
  P(`  B(t+2開盤) 全部 ${stat(d, 'B')}`);
}
const target = dedup(rows.filter(SETS[process.env.CASE_SET || '🎯 箭頭：事件日 ∧ P1 ∧ P2']));
const rnd = mulberry32(20260905); const pl = []; const idx = new Set();
while (pl.length < target.length && idx.size < rows.length) { const i = Math.floor(rnd() * rows.length); if (!idx.has(i)) { idx.add(i); pl.push(rows[i]); } }
P(`\n▶ 安慰劑（同量隨機）\n  A 全部 ${stat(pl)}`);
// 逐案時間軸
P(`\n▶ 🎯 箭頭案例全列（n=${target.length}，依日期）：連陽天數／當日漲幅／量倍／底部位置 → A 進場後 5/10/20 日淨報酬、20日內最高、5日最深`);
for (const r of target.sort((a, b) => a.date.localeCompare(b.date))) {
  const a = r.A; const path = a ? `5日${(a.r5 - COST).toFixed(1)}% 10日${(a.r10 - COST).toFixed(1)}% 20日${(a.r20 - COST).toFixed(1)}% 最深${a.mdd.toFixed(1)}% ${a.hit30 ? '🚀+30%' : a.hit20 ? '📈+20%' : a.hit10 ? '↗+10%' : ''} ${a.trueStart ? '✅' : ''}` : '（t+1 開盤漲停買不到）';
  const seq = Array.from({ length: 8 }, (_, k) => { const x = days[r.t + k + 1]?.close[r.code]; return x ? `${pct(x[0], days[r.t + k]?.close[r.code]?.[0])?.toFixed(1)}` : '-'; }).join('/');
  P(`  ${r.date} ${r.code} ${(names[r.code] || '').padEnd(5, '　')} 連陽${r.runAdj}(段漲${r.runGain?.toFixed(1) ?? '-'}%) 形狀${r.shape?.toFixed(2) ?? '-'} 當日+${r.chgT.toFixed(1)}% 量${r.volX.toFixed(1)}× 底平${r.baseFlat?.toFixed(0) ?? '-'}% → ${path}  後8日逐日%：${seq}`);
}
// 鄰居變體案例：跳空漲停 ∧ 縮量（鎖死型）——依日期列前 15 名與後 8 名（20 日淨報酬）
const lv = dedup(rows.filter(SETS['E1∧E2 ∧ 量<1×（鎖死縮量）'])).filter(r => r.A);
const lineLV = r => { const a = r.A; const seq = Array.from({ length: 8 }, (_, k) => { const x = days[r.t + k + 1]?.close[r.code]; return x ? `${pct(x[0], days[r.t + k]?.close[r.code]?.[0])?.toFixed(1)}` : '-'; }).join('/'); return `  ${r.date} ${r.code} ${(names[r.code] || '').padEnd(5, '　')} 連陽${r.run} 當日+${r.chgT.toFixed(1)}% 量${r.volX.toFixed(2)}× 底部+${r.baseUp.toFixed(0)}% → 5日${(a.r5 - COST).toFixed(1)}% 10日${(a.r10 - COST).toFixed(1)}% 20日${(a.r20 - COST).toFixed(1)}% 最深${a.mdd.toFixed(1)}% ${a.hit30 ? '🚀' : a.hit20 ? '📈' : a.hit10 ? '↗' : ''}  後8日：${seq}`; };
const lvS = [...lv].sort((a, b) => b.A.r20 - a.A.r20);
P(`\n▶ 鄰居變體案例：跳空漲停 ∧ 縮量<1×（n=${lv.length}）前 15／後 8`);
for (const r of lvS.slice(0, 15)) P(lineLV(r)); P('  …'); for (const r of lvS.slice(-8)) P(lineLV(r));
const byM = {}; for (const r of lv) { const m = r.date.slice(0, 7); byM[m] = (byM[m] || 0) + 1; }
P(`  月份分布：${Object.entries(byM).sort().map(([m, n]) => `${m}:${n}`).join(' ')}`);
const w = lv.filter(r => r.A.r20 - COST > 0).length; P(`  勝 ${w}／負 ${lv.length - w}；t+1 開盤即漲停買不到（排除前）：${rows.filter(SETS['E1∧E2 ∧ 量<1×（鎖死縮量）']).filter(r => !r.A).length} 筆`);
writeFileSync('/tmp/arrow-setup-lab.out', out.join('\n'));
process.exit(0);
