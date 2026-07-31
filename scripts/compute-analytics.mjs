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
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const DAY = 86400000;
const sum = (a) => a.reduce((s, x) => s + x, 0);
const r2 = (x) => Math.round(x * 100) / 100;

// ── ①② 交易績效 ──
function perfOf(trades) {
  const buys = trades.filter((t) => t.type === 'buy');
  const sells = trades.filter((t) => t.type === 'sell' && typeof t.realizedPnL === 'number');
  const wins = sells.filter((t) => t.realizedPnL > 0);
  const losses = sells.filter((t) => t.realizedPnL <= 0);
  const grossWin = sum(wins.map((t) => t.realizedPnL));
  const grossLoss = Math.abs(sum(losses.map((t) => t.realizedPnL)));
  // FIFO 配對算持有天數（依 code）
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
  // 最大連敗
  let maxConsecLoss = 0, cur = 0;
  for (const t of sells.sort((a, b) => (a.date || '').localeCompare(b.date || ''))) {
    if (t.realizedPnL <= 0) { cur++; maxConsecLoss = Math.max(maxConsecLoss, cur); } else cur = 0;
  }
  const totalBuyAmt = sum(buys.map((t) => t.totalAmount || 0));
  const totalSellAmt = sum(sells.map((t) => t.totalAmount || 0));
  const overnight = holdDays.filter((d) => d >= 1 && d <= 2).length;
  return {
    totalTrades: trades.length, buys: buys.length, sells: sells.length, closed: sells.length,
    winRate: sells.length ? r2(wins.length / sells.length * 100) : null,
    moneyWinRate: grossWin + grossLoss > 0 ? r2(grossWin / (grossWin + grossLoss) * 100) : null,
    netRealizedPnL: Math.round(sum(sells.map((t) => t.realizedPnL))),
    totalBuyAmount: Math.round(totalBuyAmt), totalSellAmount: Math.round(totalSellAmt),
    avgWin: wins.length ? Math.round(grossWin / wins.length) : null,
    avgLoss: losses.length ? Math.round(grossLoss / losses.length) : null,
    payoff: wins.length && losses.length && grossLoss > 0 ? r2((grossWin / wins.length) / (grossLoss / losses.length)) : null,
    expectancy: sells.length ? Math.round(sum(sells.map((t) => t.realizedPnL)) / sells.length) : null,
    maxConsecLoss,
    dayTrades: trades.filter((t) => t.dayTrade).length,
    holdDaysMedian: holdDays.length ? holdDays.sort((a, b) => a - b)[holdDays.length >> 1] : null,
    overnightShare: holdDays.length ? r2(overnight / holdDays.length * 100) : null,
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
    if (trades.length) {
      const p = perfOf(trades);
      await db.collection('userPerf').doc(u.id).set({ ...p, at: Date.now() });
      if (p.closed > 0) {
        platform.activeTraders++;
        platform.closed += p.closed;
        platform.wins += Math.round((p.winRate ?? 0) / 100 * p.closed);
        platform.netPnL += p.netRealizedPnL;
      }
      platform.trades += p.totalTrades;
      platform.buyAmt += p.totalBuyAmount;
    }
    // 歸因：ctx 未回填 outcome 者，FIFO 配對賣出
    try {
      const ctxs = await u.ref.collection('ctx').get();
      if (!ctxs.empty) {
        const sells = trades.filter((t) => t.type === 'sell' && typeof t.realizedPnL === 'number')
          .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        const usedSell = new Set();
        for (const c of ctxs.docs) {
          const ctx = c.data();
          if (!ctx.outcome) {
            // 找同 code、日期 ≥ 買入日、未用過的最早賣出
            const s = sells.find((x) => x.code === ctx.code && (x.date || '') >= (ctx.tradeDate || '') && !usedSell.has(x.id));
            if (s) {
              usedSell.add(s.id);
              const holdDays = Math.max(0, Math.round((new Date(s.date) - new Date(ctx.tradeDate)) / DAY));
              ctx.outcome = { realizedPnL: s.realizedPnL, sellDate: s.date, holdDays };
              await c.ref.set({ outcome: ctx.outcome }, { merge: true });
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
