#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 個股盤中 5 分 K 歸檔 —— 2026-08-03（當沖模式的唯一驗證原料）
//
// **為什麼非做不可、而且非現在不可**：
//   Yahoo 的 5 分 K 只保留 **60 個交易日**，而且是滾動的——今天不抓，最舊的
//   那一天明天就永久消失。台灣的個股逐筆歷史是 TWSE 付費訂閱，公開來源只有
//   這一個。當沖三關法的第一關（前30分量能）與第三關（拉回品質）都要盤中
//   資料，自建的 snap0930Archive 目前僅 10 日。
//   ⇒ 現在一次回補 60 日 + 每日增量：1 年後有 250 日可做初步驗證、2 年後達
//     本站 480 日主窗＋第三獨立窗的標準。不做的話兩年後仍是零。
//   （同 bookDepth 的教訓：原料要在意識到的當下就開始存，不能等要用才想抓。）
//
// ⚠**資料品質實測（2026-08-03 建立當下就查，別等兩年後才發現）**：
//   Yahoo 的 TW 個股 5分K **價格路徑可靠，但成交量不可靠**。
//   實測 Yahoo 全日累積量 ÷ TWSE 官方全日量：1101 為 83.7/91.8/82.4%（逐日不同），
//   1102 在 2026-07-31 甚至只有 **32.5%**——而且該日 54 根 bar 完整，
//   ⇒ 不是漏根，是**每根的量本身就少計**，且縮放係數逐日逐檔亂跳。
//   結論（已據此改設計）：
//     · **跨日量比較不可用** ⇒ 三關法第一關「前30分量÷昨日總量」**不能用本檔資料**，
//       必須用自家 snap0930Archive（daemon 直接從 MIS 抓，口徑可靠）
//     · **價格路徑可用** ⇒ 第三關的「拉回幅度、站回均價線」可用本檔
//     · **同日內量形狀**待驗證（若縮放係數在單日內為常數則可用於第三關的量縮比）
//   故每日 doc 另存 volQuality（Yahoo累積÷官方量的分布），日後回測可據此篩日或校正。
//
// 儲存策略（Firestore 單 doc 1 MiB 硬限）：
//   不存全部 54 根，改存 **09:00~13:30 每 15 分鐘一個取樣點**（19 點）的
//   [收盤價, 當日累積量(張)]。第一關只需要 09:30 的累積量；第三關需要量能
//   的段落比較，15 分粒度足夠分辨「攻擊段大量 vs 拉回量縮到 1/3~1/4」。
//   宇宙＝昨日量 ≥300 張（與 bt-core buildSamples 的 minVol 同口徑，確保
//   日後回測的母體與現有平台一致）。
//
// 用法：
//   node scripts/archive-intraday.mjs --backfill   一次性回補現有 60 日
//   node scripts/archive-intraday.mjs              每日增量（抓最近 5 日補洞）
// 節流：每檔間隔 300ms。請求數與線上人數無關（唯一不變式）。
// ─────────────────────────────────────────────────────────────────────────
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

process.env.GOOGLE_APPLICATION_CREDENTIALS ||=
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
const db = getFirestore(initializeApp({ credential: applicationDefault(), projectId: 'tw-stock-helper' }));

const BACKFILL = process.argv.includes('--backfill');
const PACE = 300;
const MIN_VOL = 300;                       // 張·與 bt-core minVol 同口徑
const MAX_BYTES = 900 * 1024;              // 留 100KB 餘裕給 1MiB 硬限
const sleep = ms => new Promise(r => setTimeout(r, ms));
const Y = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const H = { headers: { 'User-Agent': 'Mozilla/5.0' } };

/** 台北日期字串 */
const twDate = ts => new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
/** 台北時分（分鐘數） */
const twMin = ts => {
  const p = new Date(ts * 1000).toLocaleTimeString('en-GB', { timeZone: 'Asia/Taipei', hour12: false }).split(':');
  return +p[0] * 60 + +p[1];
};
// 取樣點：09:00~13:30 每 15 分（19 點）
const MARKS = Array.from({ length: 19 }, (_, i) => 9 * 60 + i * 15);

async function fetchBars(sym, range) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`${Y}${encodeURIComponent(sym)}?interval=5m&range=${range}`, H);
      if (r.status === 404) return null;                         // 代號後綴不對，換一個
      if (r.ok) {
        const j = await r.json();
        const res = j?.chart?.result?.[0];
        if (res?.timestamp?.length) return res;
        return { empty: true };
      }
      if (r.status === 429 || r.status >= 500) { await sleep(2000 * (a + 1)); continue; }
      return null;
    } catch { await sleep(1500 * (a + 1)); }
  }
  return null;
}

/** bars → { 日期: [ [收盤,累積量張] × 19 ] } */
function digest(res) {
  const ts = res.timestamp || [], q = res.indicators?.quote?.[0] || {};
  const byDay = {};
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i], v = q.volume?.[i];
    if (!(c > 0)) continue;
    const d = twDate(ts[i]), m = twMin(ts[i]);
    const b = (byDay[d] ||= { bars: [] });
    b.bars.push([m, c, v > 0 ? v : 0]);
  }
  const out = {};
  for (const d in byDay) {
    const bars = byDay[d].bars.sort((a, b) => a[0] - b[0]);
    if (bars.length < 10) continue;                              // 半日交易/資料殘缺不收
    let cum = 0, bi = 0;
    const pts = [];
    for (const mk of MARKS) {
      while (bi < bars.length && bars[bi][0] <= mk) { cum += bars[bi][2]; bi++; }
      const last = bi > 0 ? bars[bi - 1][1] : bars[0][1];
      pts.push([+last.toFixed(2), Math.round(cum / 1000)]);      // 價、累積張數
    }
    out[d] = pts;
  }
  return out;
}

const main = async () => {
  // 宇宙：最新一日 chipArchive 中量 ≥300 張者
  const last = (await db.collection('chipArchive').orderBy('date', 'desc').limit(1).get()).docs[0];
  const close = JSON.parse(last.data().closeJson || '{}');
  const codes = Object.keys(close)
    .filter(c => /^\d{4}$/.test(c) && !c.startsWith('00') && (close[c]?.[1] || 0) >= MIN_VOL)
    .sort();
  console.log(`▶ 盤中 5分K 歸檔｜模式：${BACKFILL ? '一次性回補 60 日' : '每日增量(近5日)'}`);
  console.log(`  宇宙：${codes.length} 檔（昨量 ≥${MIN_VOL} 張·與 bt-core 同口徑）\n`);

  // 後綴解析快取（.TW / .TWO）——存 Firestore 避免每次重猜
  const sufRef = db.collection('system').doc('yahooSuffix');
  const suffix = (await sufRef.get()).data()?.map || {};

  const byDate = {};      // 日期 → { code: pts }
  let ok = 0, miss = 0, t0 = Date.now();
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    let res = null, used = suffix[c] || null;
    for (const suf of used ? [used] : ['.TW', '.TWO']) {
      res = await fetchBars(c + suf, BACKFILL ? '60d' : '5d');
      if (res && !res.empty) { used = suf; break; }
      if (!used) await sleep(PACE);
    }
    if (!res || res.empty) { miss++; await sleep(PACE); continue; }
    if (suffix[c] !== used) suffix[c] = used;
    for (const [d, pts] of Object.entries(digest(res))) (byDate[d] ||= {})[c] = pts;
    ok++;
    if (ok % 100 === 0) {
      const el = (Date.now() - t0) / 1000;
      console.log(`  ${i + 1}/${codes.length}｜成功 ${ok} 缺 ${miss}｜已收 ${Object.keys(byDate).length} 個交易日｜剩約 ${Math.round((codes.length - i) * (el / (i + 1)) / 60)} 分`);
    }
    await sleep(PACE);
  }
  await sufRef.set({ map: suffix, at: Date.now() }, { merge: true });

  // 量品質對帳：Yahoo 全日累積 ÷ TWSE 官方全日量（見檔頭·逐日逐檔亂跳，故必存）
  const dates0 = Object.keys(byDate).sort();
  const qualBy = {};
  for (const d of dates0) {
    try {
      const ca = (await db.collection('chipArchive').doc(d).get()).data();
      if (!ca?.closeJson) continue;
      const cl = JSON.parse(ca.closeJson);
      const rs = [];
      for (const c in byDate[d]) {
        const off = cl[c]?.[1];
        if (off > 0) rs.push(byDate[d][c][byDate[d][c].length - 1][1] / off);
      }
      if (!rs.length) continue;
      rs.sort((a, b) => a - b);
      qualBy[d] = {
        n: rs.length,
        median: +rs[rs.length >> 1].toFixed(3),
        p10: +rs[Math.floor(rs.length * 0.1)].toFixed(3),
        p90: +rs[Math.floor(rs.length * 0.9)].toFixed(3),
        below50pct: +(rs.filter(x => x < 0.5).length / rs.length).toFixed(3),
      };
    } catch { /* 對不到就不存品質，不影響主資料 */ }
  }

  // 寫入：每日一 doc，超過大小上限就降取樣（19 → 10 點）
  const dates = Object.keys(byDate).sort();
  console.log(`\n▶ 寫入 ${dates.length} 個交易日…`);
  let wrote = 0, shrunk = 0;
  for (const d of dates) {
    let map = byDate[d];
    let json = JSON.stringify(map);
    if (Buffer.byteLength(json) > MAX_BYTES) {
      // 降為每 30 分鐘一點（取偶數索引），寧可粗一點也不要整天寫不進去
      const half = {};
      for (const c in map) half[c] = map[c].filter((_, i) => i % 2 === 0);
      map = half; json = JSON.stringify(map); shrunk++;
    }
    if (Buffer.byteLength(json) > MAX_BYTES) { console.log(`  ${d} ✖ 降取樣後仍過大(${Math.round(Buffer.byteLength(json) / 1024)}KB)，跳過`); continue; }
    await db.collection('intradayArchive').doc(d).set({
      date: d, byCodeJson: json, n: Object.keys(map).length,
      marks: map[Object.keys(map)[0]]?.length === 19 ? 15 : 30,   // 取樣間隔(分)
      volQuality: qualBy[d] || null,        // Yahoo累積÷官方量的分布（見下方 note）
      fetchedAt: Date.now(),
      note: 'Yahoo 5分K 壓縮：09:00~13:30 每15分取樣的 [收盤價, 當日累積量(張)]。Yahoo 僅保留60交易日故逐日歸檔。⚠**價格路徑可靠但成交量少計且逐日逐檔亂跳**（實測 median 0.8~0.9、最差單檔 0.325）——跨日量比較不可用，三關法第一關請改用 snap0930Archive；本檔用於第三關的價格路徑與同日量形狀。volQuality 為當日對帳分布。',
    }, { merge: true });
    wrote++;
  }
  console.log(`\n✓ 完成：${ok} 檔成功／${miss} 檔無資料｜寫入 ${wrote} 日${shrunk ? `（其中 ${shrunk} 日降為30分取樣）` : ''}｜耗時 ${Math.round((Date.now() - t0) / 60000)} 分`);
  const fin = (await db.collection('intradayArchive').get()).docs.map(x => x.id).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort();
  console.log(`  intradayArchive 現有 ${fin.length} 日：${fin[0]} → ${fin[fin.length - 1]}`);
  console.log(`  距本站標準（480日主窗＋OOT）還差約 ${Math.max(0, 480 - fin.length)} 日`);
  process.exit(0);
};
main();
