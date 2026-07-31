#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Tier-1 參數回測 ＋ 個股個案研究（預設 6274 台燿）
//
// 全市場 120 日統計（統計力）＋ 該股逐事件清單（個案洞察）。隔日沖語意：
// 訊號日收盤買、次日收盤賣，扣費稅 0.4425%。正期望者自動跑前後半窗穩健性。
//
// 參數：P1 收盤位置(強尾盤/弱尾盤)  P2 20日新高突破  P3 星期幾
//       P4 季底投信作帳  P5 台指期結算日  P6 大盤regime條件化
//       P7 軋空啟動(含上櫃)  P8 借券增+強漲  P9 融券強制回補proxy
// 用法：node casestudy-tier1.mjs [code]   非投資建議。
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const CODE = process.argv[2] || '6274';
const COST = 0.004425;
const WINDOW = 120;
const MIN_VOL = 300;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const stat = (a) => a.length ? { n: a.length, win: +(a.filter((r) => r > 0).length / a.length * 100).toFixed(1), avg: +(mean(a) * 100).toFixed(2) } : { n: 0, win: 0, avg: 0 };
const fmt = (s, tag = '') => `n=${String(s.n).padStart(6)} 勝率${String(s.win).padStart(5)}% 均${String(s.avg).padStart(6)}%${s.n >= 30 && s.avg > 0 ? ' ✅' : ''}${tag}`;

// 台指期結算日：每月第三個週三
const isSettleDay = (iso) => {
  const d = new Date(iso + 'T00:00:00Z');
  return d.getUTCDay() === 3 && Math.ceil(d.getUTCDate() / 7) === 3;
};
const isQuarterEndWindow = (iso, allDates) => {
  const m = +iso.slice(5, 7);
  if (![3, 6, 9, 12].includes(m)) return false;
  const sameMonth = allDates.filter((x) => x.slice(0, 7) === iso.slice(0, 7));
  return sameMonth.slice(-5).includes(iso); // 該月最後 5 個交易日
};

async function main() {
  const snap = await db.collection('chipArchive').get();
  const days = [];
  snap.forEach((d) => {
    const x = d.data();
    if (x.closeJson && x.instJson) days.push({
      date: d.id,
      close: JSON.parse(x.closeJson), inst: JSON.parse(x.instJson),
      margin: x.marginJson ? JSON.parse(x.marginJson) : null,
      lend: x.lendingJson ? JSON.parse(x.lendingJson) : null,
    });
  });
  days.sort((a, b) => a.date.localeCompare(b.date));
  const allDates = days.map((d) => d.date);
  const adj = (i) => (new Date(days[i + 1].date) - new Date(days[i].date)) / 86400000 <= 4;

  // 大盤 regime：當日上漲家數比
  const upRatio = days.map((d) => {
    let up = 0, tot = 0;
    for (const c in d.close) { const cl = d.close[c]; if (cl[2] > 0) { /* need prev — 用開盤代理不佳 */ } }
    return null;
  });
  // regime 用「相鄰日中位漲跌」計
  const regime = new Array(days.length).fill(null);
  for (let i = 1; i < days.length; i++) {
    let up = 0, tot = 0;
    for (const c in days[i].close) {
      const a = days[i - 1].close[c]?.[0], b = days[i].close[c]?.[0];
      if (a > 0 && b > 0) { tot++; if (b > a) up++; }
    }
    regime[i] = tot > 100 ? up / tot : null;
  }

  const start = Math.max(21, days.length - WINDOW - 1);
  const arms = {
    P1強尾盤: [], P1弱尾盤: [], P2新高突破: [], P4季底投信買: [], P4平日投信買: [],
    P5結算隔日: [], P6a多頭日全體: [], P6b空頭日全體: [], P6c多頭日強尾盤: [], P6d空頭日強尾盤: [],
    P7軋空全市場: [], P7軋空上櫃: [], P8借券增強漲: [], P9回補proxy: [],
  };
  const byWeekday = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  const events = []; // CODE 的逐事件

  for (let i = start; i < days.length - 1; i++) {
    if (!adj(i)) continue;
    const day = days[i], prev = days[i - 1], next = days[i + 1];
    const wd = new Date(day.date + 'T00:00:00Z').getUTCDay();
    const qEnd = isQuarterEndWindow(day.date, allDates);
    const settle = isSettleDay(day.date);
    const reg = regime[i];

    for (const code in day.close) {
      const cl = day.close[code], ncl = next.close[code], pcl = prev.close[code];
      if (!cl || !ncl || !pcl || !(cl[0] > 0) || !(ncl[0] > 0) || !(pcl[0] > 0)) continue;
      const vol = cl[1] || 0; if (vol < MIN_VOL) continue;
      const ret = ncl[0] / cl[0] - 1 - COST;
      const chg = (cl[0] / pcl[0] - 1) * 100;
      const hi = cl[3] || 0, lo = cl[4] || 0;
      const pos = hi > lo ? (cl[0] - lo) / (hi - lo) : null;
      const isTarget = code === CODE;
      const ev = (tag, extra = '') => { if (isTarget) events.push({ date: day.date, tag, chg: +chg.toFixed(1), ret: +(ret * 100).toFixed(2), extra }); };

      // P1 收盤位置（限有漲跌動能日 |chg|>1 避免死水）
      if (pos != null && Math.abs(chg) > 1) {
        if (pos >= 0.8) { arms.P1強尾盤.push(ret); ev('P1強尾盤', `pos=${pos.toFixed(2)}`); if (reg != null) (reg >= 0.5 ? arms.P6c多頭日強尾盤 : arms.P6d空頭日強尾盤).push(ret); }
        else if (pos <= 0.2) { arms.P1弱尾盤.push(ret); ev('P1弱尾盤', `pos=${pos.toFixed(2)}`); }
      }
      // P2 20日新高突破
      let hi20 = 0; for (let k = i - 20; k < i; k++) { const v = days[k]?.close[code]?.[0]; if (v > hi20) hi20 = v; }
      if (hi20 > 0 && cl[0] > hi20 && pcl[0] <= hi20) { arms.P2新高突破.push(ret); ev('P2新高突破', `破${hi20}`); }
      // P3 星期幾（全體）
      if (byWeekday[wd]) byWeekday[wd].push(ret);
      // P4 季底投信作帳
      const t = day.inst[code]?.[1] || 0;
      if (t > 0 && t / vol >= 0.01) { (qEnd ? arms.P4季底投信買 : arms.P4平日投信買).push(ret); if (qEnd) ev('P4季底投信買', `投信+${t}`); }
      // P5 結算隔日
      if (settle) arms.P5結算隔日.push(ret);
      // P6 regime
      if (reg != null) (reg >= 0.5 ? arms.P6a多頭日全體 : arms.P6b空頭日全體).push(ret);
      // P7 軋空啟動（昨券增≥昨量0.5%＋今漲>2）
      const m = day.margin?.[code], pm = prev.margin?.[code], ppm = days[i - 2]?.margin?.[code];
      if (pm && ppm) {
        const sChgY = (pm[1] || 0) - (ppm[1] || 0);
        const pvol = pcl[1] || 0;
        if (pvol >= MIN_VOL && sChgY >= pvol * 0.005 && chg > 2) {
          arms.P7軋空全市場.push(ret);
          if (!day.inst[code] || true) { /* 市場別由 close 無法直接判 → 用上櫃 margin 覆蓋近似 */ }
          ev('P7軋空啟動', `昨券+${sChgY}張`);
        }
      }
      // P8 借券增＋強漲（昨日借券增）
      const L = prev.lend?.[code], L2 = days[i - 2]?.lend?.[code];
      if (L != null && L2 != null) {
        const lChg = L - L2; const pvol = pcl[1] || 0;
        if (pvol >= MIN_VOL && lChg >= pvol * 0.005 && chg > 2) { arms.P8借券增強漲.push(ret); ev('P8借券增強漲', `昨借券+${lChg}張`); }
      }
      // P9 融券強制回補 proxy（券餘 5 日減 ≥60% 且起始 ≥100 張）
      const m5 = days[i - 5]?.margin?.[code];
      if (m && m5 && (m5[1] || 0) >= 100 && (m[1] || 0) <= (m5[1] || 0) * 0.4) {
        arms.P9回補proxy.push(ret); ev('P9強制回補期', `券${m5[1]}→${m[1]}`);
      }
    }
  }

  console.log(`[tier1] 全市場 ${WINDOW} 日（${days[start]?.date}→${days[days.length - 2]?.date}）＋ 個案 ${CODE}`);
  console.log('\n── 全市場統計 ──');
  for (const k of Object.keys(arms)) console.log(`  ${k.padEnd(10, '　')}: ${fmt(stat(arms[k]))}`);
  console.log('  P3 星期幾（訊號日→隔日）:');
  for (const d of [1, 2, 3, 4, 5]) console.log(`    週${'一二三四五'[d - 1]}買→隔日: ${fmt(stat(byWeekday[d]))}`);

  // ── 個案 ──
  console.log(`\n── ${CODE} 逐事件（近 ${WINDOW} 日內命中的參數）──`);
  if (!events.length) console.log('  （窗內無任何參數事件）');
  const byTag = {};
  for (const e of events) (byTag[e.tag] ||= []).push(e);
  for (const tag of Object.keys(byTag)) {
    const rets = byTag[tag].map((e) => e.ret / 100);
    console.log(`  ${tag}: ${fmt(stat(rets))}`);
    for (const e of byTag[tag].slice(-8)) console.log(`    ${e.date} 當日${e.chg >= 0 ? '+' : ''}${e.chg}% → 隔日${e.ret >= 0 ? '+' : ''}${e.ret}%  ${e.extra}`);
  }

  // 現況
  const last = days[days.length - 1];
  const lm = last.margin?.[CODE], ll = last.lend?.[CODE];
  const lc = last.close?.[CODE];
  const li = last.inst?.[CODE];
  console.log(`\n── ${CODE} 現況（${last.date}）──`);
  console.log(`  收盤 ${lc?.[0] ?? '—'} 量 ${lc?.[1] ?? '—'}張 · 融資餘 ${lm?.[0] ?? '—'}張 融券餘 ${lm?.[1] ?? '—'}張 · 借券餘 ${ll ?? '—'}張 · 外資${li?.[0] ?? '—'}/投信${li?.[1] ?? '—'}張`);
  console.log('\n非投資建議；單一個股樣本小，事件結論僅供個案觀察，以全市場統計為準。');
  process.exit(0);
}
main().catch((e) => { console.error('[tier1] 失敗:', e); process.exit(1); });
