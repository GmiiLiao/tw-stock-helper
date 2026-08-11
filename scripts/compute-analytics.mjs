#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 後台使用數據彙總（daemon 每日 17:10 子程序執行）
//
// ① userPerf/{uid}     每使用者交易績效：勝率(筆/金額)、累計次數/金額、
//                      淨損益(扣費稅)、賺賠比/期望值、持有天數、當沖占比、連敗。
// ② platformStats/latest  平台匿名彙總（招募展示口徑：不含個人身分）。
// ③ 歸因：users/{uid}/ctx 買入快照 FIFO 配對賣出 → 回填 outcome →
//    featureAttribution/latest（功能別勝率：經由X功能選出的交易實際勝率）。
// ④ usageSummary/latest  站務：DAU/WAU/MAU、留存 D1/D7、動作熱度、頁面熱度
//    （來源 activity_logs；usageDaily/{date} 按日落地）。
//
// 讀 users/{uid}/data/trades（與前端 TradeRecord 同構）。非投資建議。
//
// ⚠ 損益一律走 replayLedger 重放，**不可**讀交易紀錄上存死的 t.realizedPnL：
//   那是記錄當下用手動持倉 buyPrice 算的快照，且 store.updateTradeRecord 一編輯
//   就 delete 掉它 ⇒ `typeof t.realizedPnL === 'number'` 會把每一筆被訂正過的交易
//   整筆濾掉，勝率/期望值/連敗/歸因全部失真，而畫面上仍是個看起來合理的數字。
//   細節與兩個使用陷阱見 scripts/lib/ledger-replay.mjs 檔頭。
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';
import { replayLedger, statRows } from './lib/ledger-replay.mjs';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const DAY = 86400000;
const sum = (a) => a.reduce((s, x) => s + x, 0);
const r2 = (x) => Math.round(x * 100) / 100;
// 寫進 userPerf / ctx.outcome 的口徑標記：舊資料（讀存死 realizedPnL 的那批）
// 沒有這個欄位，據此判斷要不要重算，否則已回填的 ctx 會永遠停在錯誤的損益上。
const LEDGER_BASIS = 'ledger-replay';

// ── ①② 交易績效 ──
// 回傳 { perf, closed }：closed 是重放後的全部平倉列（含全額超賣列，給 ③ 歸因配對用）。
function perfOf(trades) {
  const { closed, buyCount, sellCount, oversoldCount, totalBuyAmount, totalSellAmount } = replayLedger(trades);
  // 全額超賣（matchedLots === 0）的列 pnl 恆為 0——既不是勝也不是負，
  // 留在分母裡會稀釋勝率、把期望值除大。明細仍列出（見 ③ 與 oversoldSells）。
  const stat = statRows(closed);
  const wins = stat.filter((c) => c.pnl > 0);
  const losses = stat.filter((c) => c.pnl < 0);
  const grossWin = sum(wins.map((c) => c.pnl));
  const grossLoss = Math.abs(sum(losses.map((c) => c.pnl)));
  const netRealizedPnL = Math.round(sum(stat.map((c) => c.pnl)));
  // FIFO 配對算持有天數（依 code）——與損益口徑無關，維持原本算法
  const q = {}; const holdDays = [];
  const sorted = [...trades].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  for (const t of sorted) {
    if (t.type === 'buy') { (q[t.code] ||= []).push({ date: t.date, qty: t.quantity }); }
    else if (t.type === 'sell') {
      let need = t.quantity;
      while (need > 0 && (q[t.code] || []).length) {
        const lot = q[t.code][0];
        const take = Math.min(need, lot.qty);
        const d = Math.max(0, Math.round((new Date(t.date) - new Date(lot.date)) / DAY));
        holdDays.push(d);
        lot.qty -= take; need -= take;
        if (lot.qty <= 0) q[t.code].shift();
      }
    }
  }
  // 最大連敗（重放值；超賣列不參與，否則一筆沒有損益的紀錄會偽造出連敗）
  let maxConsecLoss = 0, cur = 0;
  for (const c of [...stat].sort((a, b) => (a.date || '').localeCompare(b.date || ''))) {
    if (c.pnl < 0) { cur++; maxConsecLoss = Math.max(maxConsecLoss, cur); } else cur = 0;
  }
  const overnight = holdDays.filter((d) => d >= 1 && d <= 2).length;
  return {
    perf: {
      totalTrades: trades.length, buys: buyCount, sells: sellCount,
      closed: stat.length,              // 有成本可對應的平倉筆數＝所有比率的分母
      oversoldSells: sellCount - stat.length, // 全額超賣：待使用者補買進紀錄
      wins: wins.length, losses: losses.length,
      winRate: stat.length ? r2(wins.length / stat.length * 100) : null,
      moneyWinRate: grossWin + grossLoss > 0 ? r2(grossWin / (grossWin + grossLoss) * 100) : null,
      netRealizedPnL,
      totalBuyAmount: Math.round(totalBuyAmount), totalSellAmount: Math.round(totalSellAmount),
      avgWin: wins.length ? Math.round(grossWin / wins.length) : null,
      avgLoss: losses.length ? Math.round(grossLoss / losses.length) : null,
      payoff: wins.length && losses.length && grossLoss > 0 ? r2((grossWin / wins.length) / (grossLoss / losses.length)) : null,
      expectancy: stat.length ? Math.round(netRealizedPnL / stat.length) : null,
      maxConsecLoss,
      dayTrades: trades.filter((t) => t.dayTrade).length,
      holdDaysMedian: holdDays.length ? holdDays.sort((a, b) => a - b)[holdDays.length >> 1] : null,
      overnightShare: holdDays.length ? r2(overnight / holdDays.length * 100) : null,
      // 稽核用：basis 標明口徑；mismatch 是重算與存死值差 >1 元的筆數（存死值只當參考）
      basis: LEDGER_BASIS, mismatchCount: closed.filter((c) => c.mismatch).length, oversoldCount,
    },
    closed,
  };
}

// ── ③ 歸因 ──
function attributionBuckets(ctx) {
  // 一筆 ctx 歸屬的功能桶（可複數：出現在多榜就都算）
  const b = [];
  if (ctx.inCandidates) b.push('候選便條');
  if (ctx.graded) b.push(`分級榜${ctx.graded.tier ? `(${ctx.graded.tier})` : ''}`);
  if (ctx.tailPick) b.push('撿尾盤榜');
  if (ctx.limitUpRank) b.push('漲停預測榜');
  if (ctx.volSurgeRank) b.push('爆量榜');
  if (ctx.layoutRank) b.push('布局榜');
  const fp = (ctx.footprint || []).map((f) => f.a);
  if (fp.includes('open_desk')) b.push('決策工作台');
  if (b.length === 0) b.push('自行選股(無榜單)');
  return b;
}

async function main() {
  const t0 = Date.now();
  const users = await db.collection('users').get();
  const platform = { users: users.size, activeTraders: 0, closed: 0, wins: 0, netPnL: 0, buyAmt: 0, trades: 0 };
  const attribution = {}; // bucket -> {n, wins, pnl}

  for (const u of users.docs) {
    // 交易績效
    let trades = [];
    try {
      const td = (await u.ref.collection('data').doc('trades').get()).data();
      trades = Array.isArray(td?.records) ? td.records : Array.isArray(td?.list) ? td.list : Array.isArray(td) ? td : (td?.tradeRecords || []);
    } catch { /* 無交易 */ }
    let closedRows = [];
    if (trades.length) {
      const { perf: p, closed } = perfOf(trades);
      closedRows = closed;
      await db.collection('userPerf').doc(u.id).set({ ...p, at: Date.now() });
      if (p.closed > 0) {
        platform.activeTraders++;
        platform.closed += p.closed;
        platform.wins += p.wins;   // 直接累加實數，不要用 winRate 反推（會有捨入漂移）
        platform.netPnL += p.netRealizedPnL;
      }
      platform.trades += p.totalTrades;
      platform.buyAmt += p.totalBuyAmount;
    }
    // 歸因：ctx 未回填 outcome 者，FIFO 配對賣出（損益取重放值，非存死欄位）
    try {
      const ctxs = await u.ref.collection('ctx').get();
      if (!ctxs.empty) {
        // 只有「有成本可對應」的賣出能當結果——全額超賣列 pnl 恆 0，
        // 拿它回填 outcome 等於憑空製造一筆「不賺不賠」拉低歸因勝率。
        const sells = statRows(closedRows)
          .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        const usedSell = new Set();
        // 第一輪：先把「已用新口徑回填過」的 outcome 佔用的賣出標記起來，
        // 免得第二輪把同一筆賣出再配給別的 ctx。
        for (const c of ctxs.docs) {
          const o = c.data().outcome;
          if (o?.basis === LEDGER_BASIS && o.sellId) usedSell.add(o.sellId);
        }
        for (const c of ctxs.docs) {
          const ctx = c.data();
          // 舊資料的 outcome 是用存死的 realizedPnL 寫的（沒有 basis 欄位）——
          // 不重算的話那批會永遠停在錯值上，歸因表看起來有數字卻是錯的。
          if (!ctx.outcome || ctx.outcome.basis !== LEDGER_BASIS) {
            // 找同 code、日期 ≥ 買入日、未用過的最早賣出
            const s = sells.find((x) => x.code === ctx.code && (x.date || '') >= (ctx.tradeDate || '') && !usedSell.has(x.id));
            if (s) {
              usedSell.add(s.id);
              const holdDays = Math.max(0, Math.round((new Date(s.date) - new Date(ctx.tradeDate)) / DAY));
              ctx.outcome = { realizedPnL: s.pnl, sellDate: s.date, holdDays, sellId: s.id, basis: LEDGER_BASIS };
              await c.ref.set({ outcome: ctx.outcome }, { merge: true });
            } else {
              ctx.outcome = null;   // 配不到賣出＝尚未結算，不進歸因（舊錯值也不再採用）
            }
          }
          if (ctx.outcome) {
            for (const bkt of attributionBuckets(ctx)) {
              (attribution[bkt] ||= { n: 0, wins: 0, pnl: 0 });
              attribution[bkt].n++;
              if (ctx.outcome.realizedPnL > 0) attribution[bkt].wins++;
              attribution[bkt].pnl += ctx.outcome.realizedPnL;
            }
          }
        }
      }
    } catch { /* ctx 讀取失敗不阻斷 */ }
  }

  await db.collection('platformStats').doc('latest').set({
    ...platform,
    winRate: platform.closed ? r2(platform.wins / platform.closed * 100) : null,
    at: Date.now(),
  });
  const attrOut = Object.fromEntries(Object.entries(attribution).map(([k, v]) => [k,
    { n: v.n, winRate: r2(v.wins / v.n * 100), totalPnL: Math.round(v.pnl), avgPnL: Math.round(v.pnl / v.n) }]));
  await db.collection('featureAttribution').doc('latest').set({ buckets: attrOut, at: Date.now() });

  // ── ④ 站務（activity_logs 近 35 天）──
  const cut = Date.now() - 35 * DAY;
  const logs = await db.collection('activity_logs').where('timestamp', '>=', cut).get();
  const byDay = {}; const firstSeen = {}; const actionCnt = {}; const pageCnt = {};
  logs.forEach((d) => {
    const x = d.data();
    const day = new Date(x.timestamp + 8 * 3600000).toISOString().slice(0, 10);
    (byDay[day] ||= new Set()).add(x.uid);
    firstSeen[x.uid] = Math.min(firstSeen[x.uid] ?? Infinity, x.timestamp);
    actionCnt[x.action] = (actionCnt[x.action] || 0) + 1;
    if (x.action === 'navigate' && x.details?.page) pageCnt[x.details.page] = (pageCnt[x.details.page] || 0) + 1;
  });
  const days = Object.keys(byDay).sort();
  const dau = Object.fromEntries(days.map((d) => [d, byDay[d].size]));
  const now = Date.now();
  const uniq = (fromMs) => { const s = new Set(); logs.forEach((d) => { const x = d.data(); if (x.timestamp >= fromMs) s.add(x.uid); }); return s.size; };
  // 留存：以 35 天窗內 firstSeen 為錨（近似值，樣本小時僅供參考）
  let d1n = 0, d1r = 0, d7n = 0, d7r = 0;
  for (const [uid, fs] of Object.entries(firstSeen)) {
    const active = (fromMs, toMs) => logs.docs.some((d) => { const x = d.data(); return x.uid === uid && x.timestamp >= fromMs && x.timestamp < toMs; });
    if (now - fs >= 2 * DAY) { d1n++; if (active(fs + DAY, fs + 2 * DAY)) d1r++; }
    if (now - fs >= 8 * DAY) { d7n++; if (active(fs + 7 * DAY, fs + 8 * DAY)) d7r++; }
  }
  await db.collection('usageSummary').doc('latest').set({
    dau, wau: uniq(now - 7 * DAY), mau: uniq(now - 30 * DAY),
    todayDau: dau[days[days.length - 1]] ?? 0,
    retention: { d1: d1n ? r2(d1r / d1n * 100) : null, d1n, d7: d7n ? r2(d7r / d7n * 100) : null, d7n },
    actions: actionCnt, pages: pageCnt, windowDays: 35, at: Date.now(),
  });

  console.log(`[analytics] users=${users.size} traders=${platform.activeTraders} closed=${platform.closed} 歸因桶=${Object.keys(attrOut).length} logs=${logs.size}（${((Date.now() - t0) / 1000).toFixed(0)}s）`);
  process.exit(0);
}
main().catch((e) => { console.error('[analytics] 失敗:', e); process.exit(1); });
