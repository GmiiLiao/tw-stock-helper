#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 融資融券參數 × 隔日沖 120 日回測
//
// 問題：在「法人買超」訊號上疊融資融券參數，對隔日勝率的影響？
// 交易語意：訊號日收盤買、次一交易日收盤賣，扣費稅 0.4425%。
// 範圍：近 120 個交易日、上市個股（MI_MARGN 僅上市；上櫃無資券資料，誠實排除）。
//
// 訊號組（B0 為基準，其餘為疊加/獨立參數）：
//   B0 法人買超基準      三大法人淨買/量 ≥3%（僅計有資券資料的上市股）
//   B1 ＋融資減          B0 且 當日融資餘額減少（主力進、散戶出＝籌碼乾淨）
//   B2 ＋融資增          B0 且 當日融資餘額增加（散戶跟進）
//   B3 ＋融資大增        B0 且 融資增 ≥ 當日量 2%（散戶重度接棒——驗證危險訊號）
//   B4 洗盤結束型        5 日融資減 ≥ 餘額 5% 且 今日上漲（無法人條件）
//   B5 高券資比＋法人買  券資比 ≥15% 且 法人淨買>0（軋空潛力）
//   B6 融券增＋強漲      當日融券增 ≥ 量 0.5% 且 漲 >2%（軋空啟動）
// 非投資建議；樣本與結論如實輸出。
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const COST = 0.004425;      // 隔日沖來回費稅
const WINDOW = parseInt(process.env.BT_WINDOW || '120');  // 交易日
const OFFSET = parseInt(process.env.BT_OFFSET || '0');    // 由最新往前偏移(穩健性檢查)
const MIN_VOL_LOTS = 300;   // 濾冷門
const NET_TH = 0.03;        // 法人淨買/量 門檻

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

async function main() {
  const snap = await db.collection('chipArchive').get();
  const days = [];
  snap.forEach((d) => {
    const x = d.data();
    if (x.instJson && x.closeJson && x.marginJson) days.push({
      date: d.id, inst: JSON.parse(x.instJson), close: JSON.parse(x.closeJson), margin: JSON.parse(x.marginJson),
    });
  });
  days.sort((a, b) => a.date.localeCompare(b.date));
  // 需要 t-1(融資變化)、t-5(5日融資減)、t+1(隔日報酬) → 取 WINDOW+7
  const win = days.slice(-(WINDOW + 7 + OFFSET), OFFSET ? -OFFSET : undefined);
  console.log(`[margin-bt] 可用資券日 ${days.length}，回測窗 ${win.length} 日（${win[6]?.date} → ${win[win.length - 2]?.date} 為訊號日範圍）`);
  if (win.length < 40) { console.log('[margin-bt] ⚠ 資料不足（需回填完成），中止。'); process.exit(1); }

  // 日曆鄰近守衛（避免缺口誤算隔日）
  const adjNext = (i) => (new Date(win[i + 1].date) - new Date(win[i].date)) / 86400000 <= 4;

  const arms = { B0: [], B1: [], B2: [], B3: [], B4: [], B5: [], B6: [], B7: [], B8: [] };
  for (let i = 6; i < win.length - 1; i++) {
    if (!adjNext(i)) continue;
    const day = win[i], prev = win[i - 1], next = win[i + 1];
    for (const code of Object.keys(day.margin)) {
      const cl = day.close[code]; const ncl = next.close[code];
      if (!cl || !ncl || !(cl[0] > 0) || !(ncl[0] > 0)) continue;
      const vol = cl[1] || 0; if (vol < MIN_VOL_LOTS) continue;
      const ret = ncl[0] / cl[0] - 1 - COST;

      const m = day.margin[code]; const pm = prev.margin[code];
      if (!m || !pm) continue;
      const mChg = m[0] - pm[0];               // 融資餘額日變化(張)
      const sChg = m[1] - pm[1];               // 融券餘額日變化(張)
      const m5 = win[i - 5].margin[code];      // 5 日前融資餘
      const iv = day.inst[code]; const net = iv ? (iv[0] + (iv[1] || 0)) : 0;
      const chgPct = (cl[0] / (prev.close[code]?.[0] || cl[0]) - 1) * 100;

      const b0 = net > 0 && net / vol >= NET_TH;
      if (b0) {
        arms.B0.push(ret);
        if (mChg < 0) arms.B1.push(ret);
        if (mChg > 0) arms.B2.push(ret);
        if (mChg >= vol * 0.02) arms.B3.push(ret);
      }
      if (m5 && m5[0] > 0 && (m5[0] - m[0]) >= m5[0] * 0.05 && chgPct > 0) arms.B4.push(ret);
      if (m[0] > 0 && m[1] / m[0] >= 0.15 && net > 0) arms.B5.push(ret);
      if (sChg >= vol * 0.005 && chgPct > 2) arms.B6.push(ret);
      // 可部署變體（盤中可得：融券為昨日增量 + 今日盤中漲幅）
      const ppm = win[i - 2].margin[code];
      const pvol = prev.close[code]?.[1] || 0;
      if (ppm && pvol >= MIN_VOL_LOTS) {
        const sChgY = pm[1] - ppm[1]; // 昨日融券增
        if (sChgY >= pvol * 0.005 && chgPct > 2) arms.B7.push(ret);
        const p3 = win[i - 3].margin[code];
        if (p3 && sChgY > 0 && (ppm[1] - p3[1]) > 0 && chgPct > 2) arms.B8.push(ret); // 融券連2日增+今日強漲
      }
    }
  }

  const NAMES = {
    B0: '法人買超基準　　', B1: '＋融資減(乾淨)　', B2: '＋融資增(散戶跟)', B3: '＋融資大增(接棒)',
    B4: '洗盤結束型　　　', B5: '高券資比＋法人買', B6: '融券增＋強漲　　',
    B7: '昨券增＋今強漲🎯', B8: '券連2增＋今強漲',
  };
  const stat = (a) => a.length ? {
    n: a.length,
    win: +(a.filter((r) => r > 0).length / a.length * 100).toFixed(1),
    avg: +(mean(a) * 100).toFixed(2),
    med: +(a.slice().sort((x, y) => x - y)[a.length >> 1] * 100).toFixed(2),
  } : { n: 0, win: 0, avg: 0, med: 0 };

  const base = stat(arms.B0);
  console.log(`\n[margin-bt] ── 120 日隔日沖回測（費稅 ${(COST * 100).toFixed(2)}% 已扣·僅上市）──`);
  for (const k of Object.keys(arms)) {
    const s = stat(arms[k]);
    const d = k === 'B0' || s.n === 0 ? '' : `  Δ勝率 ${(s.win - base.win) >= 0 ? '+' : ''}${(s.win - base.win).toFixed(1)}pp`;
    const flag = s.n >= 30 && s.avg > 0 ? ' ✅正期望' : '';
    console.log(`  ${k} ${NAMES[k]}: n=${String(s.n).padStart(6)} 勝率${s.win}% 均${s.avg}% 中位${s.med}%${d}${flag}`);
  }
  console.log('\n[margin-bt] 樣本<30 的訊號不具參考性；正期望需勝率×賺賠比綜合看。非投資建議。');
  process.exit(0);
}
main().catch((e) => { console.error('[margin-bt] 失敗:', e); process.exit(1); });
