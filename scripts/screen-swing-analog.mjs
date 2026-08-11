#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 波段類比預測（analog forecasting）驗證腳本
//
// 使用者需求（2026-08-11）：
//   「波段推薦指標為5日獲利百分比，用歷史走勢與推薦股走勢相似度推論
//     能在連續5日以及連續20日，預計提升最高百分比機率來排行」
//
// 做法：把個股當下的走勢正規化成特徵向量，在四年歷史（988 交易日 × 約 1,900 檔）
//   裡找最相似的 K 個片段，用那些片段**後續實際發生**的結果，推估
//   未來 5 日／20 日的最大漲幅（MFE）與達標機率，作為排行鍵。
//
// ⚠ 這個腳本的存在理由是「先證明它有沒有用」，不是先做出來再說。
//   本專案的准入標準：兩窗方向一致 ＋ 獨立 OOT 窗仍成立，否則不上線。
//
// ⚠⚠ 最重要的一個陷阱（設計時就必須擋掉）：
//   **MFE（期間最大漲幅）在數學上天生隨波動度上升**。
//   一檔日波動 4% 的股票，未來 5 日「曾經漲過 5%」的機率本來就遠高於日波動 1% 的股票，
//   這跟「會不會漲」無關，純粹是路徑振幅。
//   所以任何相似度模型只要不小心把波動度吃進特徵，就會自動把高波動股排到前面，
//   然後對照「全宇宙平均」時看起來非常準——但它其實沒有提供任何增量資訊，
//   使用者照著買會系統性地買到最會亂跳的股票。
//   ⇒ 因此基準必須有兩條：
//      ① 全宇宙基準（naive）
//      ② **波動度匹配基準**：同一個 vol20 十分位內的平均 MFE
//      模型必須贏過 ②，只贏 ① 一律視為未通過。
//
// 用法：
//   node scripts/screen-swing-analog.mjs                 # 全量驗證（慢，約數分鐘）
//   node scripts/screen-swing-analog.mjs --quick         # 抽樣快跑
// 非投資建議。
// ─────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVE_DIR = path.join(__dirname, '..', 'second-brain', 'backup', 'chipArchive');

const QUICK = process.argv.includes('--quick');

// ── 參數 ─────────────────────────────────────────────────────────────────
const WARM = 60;          // 特徵需要的暖身根數（vol20/pos60）
const FWD5 = 5, FWD20 = 20;
const K = 200;            // 近鄰數：太小雜訊大、太大退化成全宇宙平均
const LIB_CAP = QUICK ? 30000 : 80000;   // 每個評估月的類比庫上限（記憶體與時間）
const MIN_VOL = 300;      // 張，流動性下限（與 bt-core 同口徑）
const HIT5 = 5, HIT20 = 10;   // 「達標」門檻：5日內曾漲≥5%、20日內曾漲≥10%

const log = (...a) => console.log(...a);
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r2 = x => (x == null || !isFinite(x) ? '—' : x.toFixed(2));

// ── 1) 載入本地歸檔 ───────────────────────────────────────────────────────
// 走本地第二大腦而不是 Firestore：988 天 × 1,900 檔如果逐日打 Firestore，
// 光讀取費用與時間都不合理，而且這是離線研究，不需要即時性。
function loadArchive() {
  const files = fs.readdirSync(ARCHIVE_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const dates = [], raw = [];
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, f), 'utf8')); } catch { continue; }
    if (!j.closeJson) continue;
    let close;
    try { close = JSON.parse(j.closeJson); } catch { continue; }
    // 空洞防護：歸檔偶有殘缺日（fix-archive-dates 清過的、或當日抓取失敗）。
    // 少於 500 檔一律視為壞日直接丟掉——留著會在特徵裡製造假跳空。
    if (Object.keys(close).length < 500) continue;
    dates.push(j.date || f.slice(0, 10));
    raw.push(close);
  }
  return { dates, raw };
}

// ── 2) 轉成逐檔矩陣 ───────────────────────────────────────────────────────
function buildMatrix({ dates, raw }) {
  const nD = dates.length;
  const codeSet = new Set();
  for (const day of raw) for (const c in day) if (/^\d{4}$/.test(c) && !c.startsWith('00')) codeSet.add(c);
  const codes = [...codeSet].sort();
  const idx = new Map(codes.map((c, i) => [c, i]));
  const nC = codes.length;
  const mk = () => new Float32Array(nC * nD).fill(NaN);
  const C = mk(), H = mk(), L = mk(), V = mk();
  for (let d = 0; d < nD; d++) {
    const day = raw[d];
    for (const code in day) {
      const i = idx.get(code); if (i === undefined) continue;
      const r = day[code]; if (!r || !(r[0] > 0)) continue;
      const p = i * nD + d;
      C[p] = r[0]; V[p] = r[1] || 0;
      H[p] = r[3] > 0 ? r[3] : r[0];
      L[p] = r[4] > 0 ? r[4] : r[0];
    }
  }
  return { dates, codes, nD, nC, C, H, L, V };
}

// ── 3) 特徵與目標 ─────────────────────────────────────────────────────────
// 特徵刻意只用「價量走勢形狀」，不摻法人/融資——使用者要的是**走勢相似度**。
// 全部取對數報酬，讓不同價位的股票可比。
// ⚠ 特徵**刻意不含 vol20**（2026-08-11 第一版實測後修正）：
//   第一版把 vol20 放進特徵，結果模型 Top10% 的 MFE 與「純用波動度排序」
//   完全一樣（三窗 -0.02/+0.08/-0.13pp）——相似度只是波動度的代理，零增量。
//   而且那批股票的 5 日最大跌幅 -6.58% vs 宇宙 -4.07%，等於把最會亂跳的排最前面。
//   ⇒ 形狀相似度只比走勢形狀（各期報酬＋位階），振幅由「超額 MFE」目標另外處理。
const NF = 6;
const F_NAMES = ['r1', 'r3', 'r5', 'r10', 'r20', 'pos60'];

function buildSamples(M) {
  const { dates, codes, nD, nC, C, H, L, V } = M;
  const feat = [], meta = [];
  for (let i = 0; i < nC; i++) {
    const base = i * nD;
    for (let d = WARM; d < nD - FWD20; d++) {
      const c0 = C[base + d];
      if (!(c0 > 0)) continue;
      if (!(V[base + d] >= MIN_VOL)) continue;                 // 流動性
      const cPrev = C[base + d - 1];
      if (!(cPrev > 0)) continue;
      const chg = (c0 / cPrev - 1) * 100;
      if (chg > 8.5) continue;                                  // 可交易宇宙（收盤買不到漲停）

      // 走勢特徵
      const at = k => C[base + d - k];
      const c1 = at(1), c3 = at(3), c5 = at(5), c10 = at(10), c20 = at(20);
      if (!(c1 > 0 && c3 > 0 && c5 > 0 && c10 > 0 && c20 > 0)) continue;
      let sum = 0, sum2 = 0, n = 0;
      for (let k = 0; k < 20; k++) {
        const a = C[base + d - k], b = C[base + d - k - 1];
        if (a > 0 && b > 0) { const lr = Math.log(a / b); sum += lr; sum2 += lr * lr; n++; }
      }
      if (n < 18) continue;
      const mean = sum / n;
      const vol20 = Math.sqrt(Math.max(sum2 / n - mean * mean, 0)) * 100;   // 日波動%
      let hi60 = 0;
      for (let k = 0; k < 60; k++) { const x = H[base + d - k]; if (x > hi60) hi60 = x; }
      if (!(hi60 > 0)) continue;
      // RSI Wilder（與站上同口徑）＋量比：用來近似波段兩榜的候選母體
      const rsiOf = per => {
        let up = 0, dn = 0;
        for (let k = per; k >= 1; k--) {
          const a = C[base + d - k + 1], b = C[base + d - k];
          if (!(a > 0 && b > 0)) return null;
          const ch = a - b;
          if (k === per) { up = Math.max(ch, 0); dn = Math.max(-ch, 0); }
          else { up = (up * (per - 1) + Math.max(ch, 0)) / per; dn = (dn * (per - 1) + Math.max(-ch, 0)) / per; }
        }
        return dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
      };
      const rsi5 = rsiOf(5), rsi10 = rsiOf(10);
      if (rsi5 == null || rsi10 == null) continue;
      let av20 = 0, an = 0;
      for (let k = 1; k <= 20; k++) { const vv = V[base + d - k]; if (vv >= 0) { av20 += vv; an++; } }
      av20 = an ? av20 / an : 0;
      const volX = av20 > 0 ? V[base + d] / av20 : 0;

      // 目標：未來 5/20 日的最大漲幅（相對今日收盤）與最大跌幅
      let mfe5 = -Infinity, mfe20 = -Infinity, mae5 = Infinity, mae20 = Infinity;
      let ok = true;
      for (let k = 1; k <= FWD20; k++) {
        const hh = H[base + d + k], ll = L[base + d + k];
        if (!(hh > 0) || !(ll > 0)) { if (k <= FWD5) { ok = false; break; } else break; }
        const up = (hh / c0 - 1) * 100, dn = (ll / c0 - 1) * 100;
        if (k <= FWD5) { if (up > mfe5) mfe5 = up; if (dn < mae5) mae5 = dn; }
        if (up > mfe20) mfe20 = up; if (dn < mae20) mae20 = dn;
      }
      if (!ok || !isFinite(mfe5) || !isFinite(mfe20)) continue;
      const c5f = C[base + d + FWD5], c20f = C[base + d + FWD20];

      feat.push([
        Math.log(c0 / c1) * 100,
        Math.log(c0 / c3) * 100,
        Math.log(c0 / c5) * 100,
        Math.log(c0 / c10) * 100,
        Math.log(c0 / c20) * 100,
        (c0 / hi60) * 100,
      ]);
      meta.push({
        d, code: codes[i], date: dates[d], c0, vol20, rsi5, rsi10, volX,
        // 波段候選集（近似站上兩榜的母體；缺法人欄位故為近似，已於報告揭露）
        cand: (rsi5 < 20 && volX > 1.5) || (rsi5 >= 75 && rsi5 < 90 && rsi10 > rsi5),
        mfe5, mfe20, mae5, mae20,
        ret5: c5f > 0 ? (c5f / c0 - 1) * 100 : null,
        ret20: c20f > 0 ? (c20f / c0 - 1) * 100 : null,
      });
    }
  }
  return { feat, meta };
}

// ── 4) 逐日橫斷面標準化 ───────────────────────────────────────────────────
// ⚠ 一定要**逐日**做 z-score，不能全期一次做：
//   2022 空頭與 2025 多頭的報酬分布完全不同，全期標準化會讓「相似」
//   變成「同一個年份」，模型就退化成在背年份而不是在比走勢。
function zscoreByDay(feat, meta) {
  const byDay = new Map();
  for (let i = 0; i < meta.length; i++) {
    const k = meta[i].d;
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(i);
  }
  const Z = new Float32Array(feat.length * NF);
  for (const [, ids] of byDay) {
    for (let f = 0; f < NF; f++) {
      let s = 0, s2 = 0;
      for (const i of ids) { const v = feat[i][f]; s += v; s2 += v * v; }
      const n = ids.length, m = s / n;
      const sd = Math.sqrt(Math.max(s2 / n - m * m, 1e-9));
      for (const i of ids) Z[i * NF + f] = (feat[i][f] - m) / sd;
    }
  }
  return Z;
}

// ── 5) 類比預測 ───────────────────────────────────────────────────────────
// 對每一筆查詢，只用**嚴格更早**的資料當類比庫（無前視）。
// 逐月重建類比庫並抽樣到 LIB_CAP：這是效能取捨，且會在報告裡揭露。
function runAnalog(Z, meta, evalFrom) {
  const order = meta.map((_, i) => i).sort((a, b) => meta[a].d - meta[b].d);
  const months = [...new Set(meta.map(m => m.date.slice(0, 7)))].sort().filter(mo => mo >= evalFrom);
  const preds = new Array(meta.length).fill(null);
  let done = 0;

  for (const mo of months) {
    // 類比庫：日期嚴格早於本月，且**目標已實現**（d + 20 < 本月起始日索引）
    const firstIdxOfMonth = order.find(i => meta[i].date.slice(0, 7) === mo);
    if (firstIdxOfMonth === undefined) continue;
    const cutD = meta[firstIdxOfMonth].d;
    const libAll = order.filter(i => meta[i].d + FWD20 < cutD);
    if (libAll.length < 5000) continue;
    // 均勻抽樣（不是取最近的：取最近會讓類比庫偏向單一 regime）
    const step = Math.max(1, Math.floor(libAll.length / LIB_CAP));
    const lib = [];
    for (let i = 0; i < libAll.length; i += step) lib.push(libAll[i]);
    const nL = lib.length;
    const LZ = new Float32Array(nL * NF);
    for (let j = 0; j < nL; j++) for (let f = 0; f < NF; f++) LZ[j * NF + f] = Z[lib[j] * NF + f];

    // 由**類比庫自身**（全為過去資料，因果安全）算出波動度十分位的平均 MFE，
    // 用來把每一筆的 MFE 拆成「波動度該有的」＋「超額」。
    // 排行若用超額，就不會只是把高波動股撈到前面。
    const volSorted = [...lib].sort((a, b) => meta[a].vol20 - meta[b].vol20);
    const volEdges = [], bucketMean5 = [], bucketMean20 = [];
    for (let g = 0; g < 10; g++) {
      const seg = volSorted.slice(Math.floor(nL * g / 10), Math.floor(nL * (g + 1) / 10));
      volEdges.push(meta[seg[seg.length - 1]].vol20);
      bucketMean5.push(avg(seg.map(i => meta[i].mfe5)));
      bucketMean20.push(avg(seg.map(i => meta[i].mfe20)));
    }
    const bucketOf = v => { for (let g = 0; g < 10; g++) if (v <= volEdges[g]) return g; return 9; };
    const exc5 = new Map(), exc20 = new Map();
    for (const i of lib) { const g = bucketOf(meta[i].vol20); exc5.set(i, meta[i].mfe5 - bucketMean5[g]); exc20.set(i, meta[i].mfe20 - bucketMean20[g]); }

    const queries = order.filter(i => meta[i].date.slice(0, 7) === mo);
    // 近鄰暫存（用固定大小陣列做部分選擇，比全排序快得多）
    const bestD = new Float64Array(K), bestI = new Int32Array(K);
    for (const q of queries) {
      const qb = q * NF;
      bestD.fill(Infinity); bestI.fill(-1);
      let worst = Infinity, worstSlot = 0, filled = 0;
      for (let j = 0; j < nL; j++) {
        const lb = j * NF;
        let dist = 0;
        for (let f = 0; f < NF; f++) { const dd = Z[qb + f] - LZ[lb + f]; dist += dd * dd; if (dist >= worst && filled >= K) break; }
        if (filled < K) {
          bestD[filled] = dist; bestI[filled] = lib[j]; filled++;
          if (filled === K) { worst = -Infinity; for (let t = 0; t < K; t++) if (bestD[t] > worst) { worst = bestD[t]; worstSlot = t; } }
        } else if (dist < worst) {
          bestD[worstSlot] = dist; bestI[worstSlot] = lib[j];
          worst = -Infinity; for (let t = 0; t < K; t++) if (bestD[t] > worst) { worst = bestD[t]; worstSlot = t; }
        }
      }
      if (filled < 20) continue;
      let s5 = 0, s20 = 0, h5 = 0, h20 = 0, sr5 = 0, sr20 = 0, e5 = 0, e20 = 0, g5 = 0, g20 = 0, n = 0, nr = 0;
      for (let t = 0; t < filled; t++) {
        const ii = bestI[t], m = meta[ii];
        s5 += m.mfe5; s20 += m.mfe20;
        e5 += exc5.get(ii) ?? 0; e20 += exc20.get(ii) ?? 0;
        if (m.mfe5 >= HIT5) h5++;
        if (m.mfe20 >= HIT20) h20++;
        g5 += m.mfe5 + m.mae5; g20 += m.mfe20 + m.mae20;   // mae 為負 ⇒ 上檔減下檔
        if (m.ret5 != null) { sr5 += m.ret5; nr++; }
        if (m.ret20 != null) sr20 += m.ret20;
        n++;
      }
      preds[q] = { mfe5: s5 / n, mfe20: s20 / n, p5: h5 / n, p20: h20 / n,
        ret5: nr ? sr5 / nr : null, ret20: nr ? sr20 / nr : null,
        exc5: e5 / n, exc20: e20 / n, edg5: g5 / n, edg20: g20 / n, n };
      if (++done % 20000 === 0) log(`   …已預測 ${done.toLocaleString()} 筆`);
    }
    log(`  ${mo} 類比庫 ${nL.toLocaleString()} · 查詢 ${queries.length.toLocaleString()}`);
  }
  return preds;
}

// ── 6) 報告 ───────────────────────────────────────────────────────────────
// 三條線一起看：模型十分位 / 全宇宙基準 / **波動度匹配基準**。
function decile(rows, key) {
  const s = rows.filter(r => r.pred[key] != null).sort((a, b) => b.pred[key] - a.pred[key]);
  const n = s.length, out = [];
  for (let g = 0; g < 10; g++) out.push(s.slice(Math.floor(n * g / 10), Math.floor(n * (g + 1) / 10)));
  return out;
}

function volMatchedBaseline(rows, topRows, field) {
  // 把 top 組每一筆，換成「同一 vol20 十分位的全體平均」，再平均。
  const sorted = [...rows].sort((a, b) => a.m.vol20 - b.m.vol20);
  const n = sorted.length;
  const bucketOf = new Map();
  const bucketMean = [];
  for (let g = 0; g < 10; g++) {
    const seg = sorted.slice(Math.floor(n * g / 10), Math.floor(n * (g + 1) / 10));
    for (const r of seg) bucketOf.set(r, g);
    bucketMean.push(avg(seg.map(r => field(r.m))));
  }
  const vals = topRows.map(r => bucketMean[bucketOf.get(r) ?? 0]).filter(v => v != null);
  return avg(vals);
}

function reportWindow(label, rows) {
  if (rows.length < 500) { log(`\n── ${label}：樣本不足（${rows.length}）`); return null; }
  log(`\n── ${label}（n=${rows.length.toLocaleString()}）──`);
  const res = {};

  // 每個「排行鍵」都要對照三條線：全宇宙 / 波動度匹配 / 純波動度Top。
  // 只贏全宇宙不算數——那條線任何高波動選股都能贏。
  const evalKey = (rankKey, outField, hitFn, hitTh, tag) => {
    const uni = avg(rows.map(r => outField(r.m)));
    const uniHit = rows.filter(r => hitFn(r.m)).length / rows.length * 100;
    const top = decile(rows, rankKey)[0];
    if (!top.length) return null;
    const topV = avg(top.map(r => outField(r.m)));
    const topHit = top.filter(r => hitFn(r.m)).length / top.length * 100;
    const volBase = volMatchedBaseline(rows, top, outField);
    const volTop = [...rows].sort((a, b) => b.m.vol20 - a.m.vol20).slice(0, top.length);
    const volTopV = avg(volTop.map(r => outField(r.m)));
    const ret = avg(top.map(r => (tag.startsWith('5') ? r.m.ret5 : r.m.ret20)).filter(v => v != null));
    const retU = avg(rows.map(r => (tag.startsWith('5') ? r.m.ret5 : r.m.ret20)).filter(v => v != null));
    const mae = avg(top.map(r => (tag.startsWith('5') ? r.m.mae5 : r.m.mae20)));
    const maeU = avg(rows.map(r => (tag.startsWith('5') ? r.m.mae5 : r.m.mae20)));
    log(`  [${rankKey.padEnd(5)}] ${tag}  Top10% ${r2(topV)}%（達標${hitTh}% ${r2(topHit)}%·宇宙 ${r2(uni)}%/${r2(uniHit)}%）`
      + `  Δ波動匹配 ${r2(topV - volBase)}pp${topV - volBase > 0 ? '' : '⛔'}`
      + `  Δ純波動 ${r2(topV - volTopV)}pp${topV - volTopV > 0 ? '' : '⛔'}`
      + `  ｜實際報酬 ${r2(ret)}%(宇宙${r2(retU)}%)  最大跌 ${r2(mae)}%(宇宙${r2(maeU)}%)`);
    return { topV, volBase, volTopV, incr: topV - volBase, vsVol: topV - volTopV, ret, retU, mae, maeU, topHit, uniHit };
  };

  res.mfe5_by_mfe5 = evalKey('mfe5', m => m.mfe5, m => m.mfe5 >= HIT5, HIT5, '5日最大漲幅');
  res.mfe5_by_exc5 = evalKey('exc5', m => m.mfe5, m => m.mfe5 >= HIT5, HIT5, '5日最大漲幅');
  res.mfe5_by_ret5 = evalKey('ret5', m => m.mfe5, m => m.mfe5 >= HIT5, HIT5, '5日最大漲幅');
  log('');
  res.mfe20_by_mfe20 = evalKey('mfe20', m => m.mfe20, m => m.mfe20 >= HIT20, HIT20, '20日最大漲幅');
  res.mfe20_by_exc20 = evalKey('exc20', m => m.mfe20, m => m.mfe20 >= HIT20, HIT20, '20日最大漲幅');
  res.mfe20_by_ret20 = evalKey('ret20', m => m.mfe20, m => m.mfe20 >= HIT20, HIT20, '20日最大漲幅');
  return res;
}

// ── main ─────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  log('▶ 載入本地歸檔…');
  const arch = loadArchive();
  log(`  ${arch.dates.length} 個交易日：${arch.dates[0]} → ${arch.dates[arch.dates.length - 1]}`);
  const M = buildMatrix(arch);
  log(`  ${M.nC} 檔`);
  log('▶ 建樣本（特徵＋未來 5/20 日 MFE/MAE）…');
  const { feat, meta } = buildSamples(M);
  log(`  樣本 ${meta.length.toLocaleString()} 筆`);
  log('▶ 逐日橫斷面標準化…');
  const Z = zscoreByDay(feat, meta);

  // 評估起點：留前段當類比庫（至少一年）
  const allMonths = [...new Set(meta.map(m => m.date.slice(0, 7)))].sort();
  const evalFrom = allMonths[Math.floor(allMonths.length * 0.35)];
  log(`▶ 類比預測（K=${K}·類比庫上限 ${LIB_CAP.toLocaleString()}·評估自 ${evalFrom}）…`);
  const preds = runAnalog(Z, meta, evalFrom);

  const rows = [];
  for (let i = 0; i < meta.length; i++) if (preds[i]) rows.push({ m: meta[i], pred: preds[i] });
  log(`\n▶ 可評估樣本 ${rows.length.toLocaleString()} 筆`);

  // 兩窗（評估期前半/後半）＋ 獨立 OOT（最後 20% 月份）
  const months = [...new Set(rows.map(r => r.m.date.slice(0, 7)))].sort();
  const ootFrom = months[Math.floor(months.length * 0.8)];
  const inSample = rows.filter(r => r.m.date.slice(0, 7) < ootFrom);
  const oot = rows.filter(r => r.m.date.slice(0, 7) >= ootFrom);
  const mid = inSample.length ? inSample[Math.floor(inSample.length / 2)].m.date : null;

  // ── 候選集內檢定（這才是產品的真實情境）──────────────────────────
  // 使用者要排行的是**已篩出的推薦股**，不是全市場。
  // 候選集內波動度分散小得多，「照波動度排」不是實際會用的策略，
  // 所以控制組換成：候選集自身平均、以及候選集內照波動度排。
  const candReport = (label, rs) => {
    const rows2 = rs.filter(r => r.m.cand);
    if (rows2.length < 300) { log(`\n[候選集] ${label}：樣本不足（${rows2.length}）`); return null; }
    const out = {};
    log(`\n[候選集] ${label}（n=${rows2.length.toLocaleString()}）`);
    for (const [rk, of_, hit, th, tag] of [
      ['exc5', m => m.mfe5, m => m.mfe5 >= HIT5, HIT5, '5日最大漲幅'],
      ['mfe5', m => m.mfe5, m => m.mfe5 >= HIT5, HIT5, '5日最大漲幅'],
      ['edg5', m => m.mfe5, m => m.mfe5 >= HIT5, HIT5, '5日最大漲幅'],
      ['exc20', m => m.mfe20, m => m.mfe20 >= HIT20, HIT20, '20日最大漲幅'],
      ['mfe20', m => m.mfe20, m => m.mfe20 >= HIT20, HIT20, '20日最大漲幅'],
      ['edg20', m => m.mfe20, m => m.mfe20 >= HIT20, HIT20, '20日最大漲幅'],
    ]) {
      const n = rows2.length, cut = Math.max(30, Math.floor(n * 0.3));
      const top = [...rows2].sort((a, b) => b.pred[rk] - a.pred[rk]).slice(0, cut);
      const volTop = [...rows2].sort((a, b) => b.m.vol20 - a.m.vol20).slice(0, cut);
      const base = avg(rows2.map(r => of_(r.m)));
      const tv = avg(top.map(r => of_(r.m))), vv = avg(volTop.map(r => of_(r.m)));
      const isD5 = tag.startsWith('5');
      const rT = avg(top.map(r => (isD5 ? r.m.ret5 : r.m.ret20)).filter(v => v != null));
      const rB = avg(rows2.map(r => (isD5 ? r.m.ret5 : r.m.ret20)).filter(v => v != null));
      log(`   [${rk.padEnd(5)}] ${tag} Top30% ${r2(tv)}%（候選集基準 ${r2(base)}%·Δ${r2(tv - base)}pp）`
        + ` 內部純波動Top ${r2(vv)}%·Δ${r2(tv - vv)}pp${tv - vv > 0 ? '' : '⛔'}`
        + ` ｜實際報酬 ${r2(rT)}% vs ${r2(rB)}%·Δ${r2(rT - rB)}pp`);
      out[rk] = { d: tv - base, dVol: tv - vv, dRet: rT - rB };
    }
    return out;
  };

  const A = reportWindow('主窗前半', inSample.filter(r => r.m.date < mid));
  const B = reportWindow('主窗後半', inSample.filter(r => r.m.date >= mid));
  const O = reportWindow(`OOT 獨立窗（${ootFrom} 起）`, oot);

  const cA = candReport('主窗前半', inSample.filter(r => r.m.date < mid));
  const cB = candReport('主窗後半', inSample.filter(r => r.m.date >= mid));
  const cO = candReport(`OOT（${ootFrom} 起）`, oot);
  if (cA && cB && cO) {
    log('\n── 候選集內判定（三窗 Δ候選基準、Δ內部純波動、Δ實際報酬 皆須為正）──');
    for (const k of ['exc5', 'mfe5', 'edg5', 'exc20', 'mfe20', 'edg20']) {
      const d = [cA[k].d, cB[k].d, cO[k].d], dv = [cA[k].dVol, cB[k].dVol, cO[k].dVol], dr = [cA[k].dRet, cB[k].dRet, cO[k].dRet];
      const pass = d.every(v => v > 0) && dv.every(v => v > 0) && dr.every(v => v > 0);
      log(`   ${k.padEnd(6)} Δ基準[${d.map(r2).join('/')}] Δ內部波動[${dv.map(r2).join('/')}] Δ報酬[${dr.map(r2).join('/')}] ⇒ ${pass ? '✅ 通過' : '❌ 未通過'}`);
    }
  }

  log('\n══════════ 全宇宙判定（准入：三窗 vs 波動匹配、vs 純波動 全部為正）══════════');
  const verdict = (name, key) => {
    if (!A || !B || !O || !A[key]) return log(`  ${name}：窗數不足`);
    const incr = [A[key].incr, B[key].incr, O[key].incr];
    const vsVol = [A[key].vsVol, B[key].vsVol, O[key].vsVol];
    const ret = [A[key].ret - A[key].retU, B[key].ret - B[key].retU, O[key].ret - O[key].retU];
    const pass = incr.every(v => v > 0) && vsVol.every(v => v > 0);
    log(`  ${name.padEnd(26)} Δ波動匹配[${incr.map(r2).join('/')}] Δ純波動[${vsVol.map(r2).join('/')}] `
      + `實際報酬Δ[${ret.map(r2).join('/')}] ⇒ ${pass ? '✅ 通過' : '❌ 未通過'}`);
    return pass;
  };
  log('  ── 5 日 ──');
  verdict('依「預測MFE」排行', 'mfe5_by_mfe5');
  verdict('依「預測超額MFE」排行', 'mfe5_by_exc5');
  verdict('依「預測報酬」排行', 'mfe5_by_ret5');
  log('  ── 20 日 ──');
  verdict('依「預測MFE」排行', 'mfe20_by_mfe20');
  verdict('依「預測超額MFE」排行', 'mfe20_by_exc20');
  verdict('依「預測報酬」排行', 'mfe20_by_ret20');
  log(`\n耗時 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  log('※ MFE 為期間最大漲幅＝賣在最高點的上界，不是可實現報酬；已一併列出實際持有報酬與最大跌幅。非投資建議。');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
