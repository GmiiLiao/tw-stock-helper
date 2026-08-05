#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// AI 推薦成績記分板稽核 —— 2026-08-05（使用者問「勝率怎麼這麼差？」）
//
// 要回答的是**兩個不同的問題**，記分板目前只答得出第一個：
//   ① 這些推薦的絕對報酬是多少？        → 記分板有（5日 -5.44% 等）
//   ② 同一段期間，隨便買一檔會怎樣？    → 記分板**沒有**，所以①無法判讀
// 本站 bt-core 的鐵律就是「一定要跟同期基準比」——記分板卻是全站唯一沒做
// 這件事的地方。-5.44% 若同期大盤 -8%，那是贏；若同期 +2%，那是輸。
// 光看絕對值無法分辨，這個腳本就是把基準補上。
//
// 另外三件要一起查的事：
//   · 可交易性：推薦當日若漲停(chg>8.5%)，收盤價買不到 → 這種樣本本來就不該計分
//   · 費稅：記分板是純價差，沒扣 0.4425% 來回成本
//   · 只追蹤 top20/intraday 兩榜，另外三個分頁（動能/成長/防禦）從未記錄
//
// 用法：node scripts/audit-picks-scoreboard.mjs
// ─────────────────────────────────────────────────────────────────────────
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

process.env.GOOGLE_APPLICATION_CREDENTIALS ||=
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
const db = getFirestore(initializeApp({ credential: applicationDefault(), projectId: 'tw-stock-helper' }));

const COST = 0.4425;                 // 手續費×2＋證交稅（與 bt-core 同口徑）
const r2 = v => +v.toFixed(2);
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const wr = a => (a.length ? Math.round(a.filter(v => v > 0).length / a.length * 100) : null);

const main = async () => {
  // ── 1) 收盤歸檔：日期 → { code: [收盤, 量(張), 開, 高, 低] } ────────
//    ⚠2026-08-05 踩到：我第一版以為 [2] 是漲跌%，其實是**開盤價**。
//    於是「漲停」判定變成「開盤價 > 8.5」→ 100% 命中，基準宇宙只剩 13 檔，
//    整張表全錯。漲跌%必須自己用前一日收盤算。（bt-core 的解讀是 [c,v,o,h,l]）
  const arch = await db.collection('chipArchive').orderBy('date').get();
  const days = [];
  for (const d of arch.docs) {
    const v = d.data();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date || '') || !v.closeJson) continue;
    days.push({ date: v.date, close: JSON.parse(v.closeJson) });
  }
  const di = Object.fromEntries(days.map((d, i) => [d.date, i]));
  console.log(`▶ chipArchive：${days.length} 個交易日（${days[0]?.date} → ${days[days.length - 1]?.date}）\n`);

  // ── 2) 推薦歷史 ──────────────────────────────────────────────────
  const ph = await db.collection('picksHistory').get();
  const hist = ph.docs.map(d => d.data()).filter(d => d.date).sort((a, b) => a.date.localeCompare(b.date));
  console.log(`▶ picksHistory：${hist.length} 日（${hist[0]?.date} → ${hist[hist.length - 1]?.date}）`);
  console.log(`  記錄的榜單：${[...new Set(hist.flatMap(h => Object.keys(h).filter(k => Array.isArray(h[k]))))].join('、')}\n`);

  // 收盤價存取；回傳 null 代表該日該檔無資料（停牌/下市/上櫃缺漏）
  const px = (date, code) => { const c = days[di[date]]?.close?.[code]; return c && c[0] > 0 ? c[0] : null; };
  const vol = (date, code) => { const c = days[di[date]]?.close?.[code]; return c ? (c[1] || 0) : 0; };
  // 漲跌%＝(今收-昨收)/昨收，昨收取前一個交易日的歸檔
  const chg = (date, code) => {
    const i = di[date]; if (i == null || i === 0) return null;
    const c = px(date, code), p = days[i - 1]?.close?.[code]?.[0];
    return c != null && p > 0 ? (c - p) / p * 100 : null;
  };

  // ── 3) 逐榜逐窗重算，同時算同期基準 ────────────────────────────────
  const LISTS = ['top20', 'intraday'];
  const HOLD = [5, 10, 20];

  // 基準宇宙：與 bt-core buildSamples 同口徑（4碼普通股·量≥300張·非漲停）
  const universe = date => {
    const cl = days[di[date]]?.close || {};
    return Object.keys(cl).filter(c => {
      if (!/^\d{4}$/.test(c) || c.startsWith('00')) return false;
      if (!(cl[c][0] > 0) || (cl[c][1] || 0) < 300) return false;
      const g = chg(date, c);
      return g != null && g <= 8.5;          // 可交易宇宙：漲停買不到，排除
    });
  };

  const rows = [];
  for (const list of LISTS) {
    for (const h of HOLD) {
      const pick = [], base = [], pickTradable = [];
      let nLimitUp = 0, nMissing = 0, nDays = 0;
      for (const rec of hist) {
        const i = di[rec.date];
        if (i == null || i + h >= days.length) continue;      // 尚未到期
        const exitDate = days[i + h].date;
        const items = rec[list] || [];
        if (!items.length) continue;
        nDays++;
        for (const p of items) {
          const e = px(rec.date, p.code), x = px(exitDate, p.code);
          if (e == null || x == null) { nMissing++; continue; }
          const r = (x - e) / e * 100;
          pick.push(r);
          // 可交易性：推薦當日漲停就買不到收盤價
          if ((chg(rec.date, p.code) ?? 0) > 8.5) nLimitUp++; else pickTradable.push(r);
        }
        // 同期基準：同一天、同一持有期、可交易宇宙的等權平均
        const u = universe(rec.date);
        for (const c of u) {
          const e = px(rec.date, c), x = px(exitDate, c);
          if (e != null && x != null) base.push((x - e) / e * 100);
        }
      }
      if (!pick.length) continue;
      rows.push({
        list, h, nDays,
        pickN: pick.length, pickWR: wr(pick), pickAvg: r2(avg(pick)), pickMed: r2(med(pick)),
        tradableN: pickTradable.length, tradableAvg: pickTradable.length ? r2(avg(pickTradable)) : null,
        tradableWR: wr(pickTradable),
        baseN: base.length, baseWR: wr(base), baseAvg: r2(avg(base)), baseMed: r2(med(base)),
        limitUp: nLimitUp, missing: nMissing,
      });
    }
  }

  // ── 4) 輸出 ─────────────────────────────────────────────────────
  console.log('══════════ 推薦 vs 同期基準（同日進場·同持有期·等權）══════════\n');
  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  console.log(pad('榜單', 10) + padL('持有', 5) + padL('推薦勝率', 10) + padL('推薦均報', 10) + padL('推薦中位', 10)
    + padL('基準勝率', 10) + padL('基準均報', 10) + padL('基準中位', 10) + padL('超額', 9) + padL('n', 7));
  console.log('─'.repeat(90));
  for (const r of rows) {
    const excess = r2(r.pickAvg - r.baseAvg);
    console.log(pad(r.list, 10) + padL(`${r.h}日`, 5) + padL(`${r.pickWR}%`, 10) + padL(`${r.pickAvg}%`, 10) + padL(`${r.pickMed}%`, 10)
      + padL(`${r.baseWR}%`, 10) + padL(`${r.baseAvg}%`, 10) + padL(`${r.baseMed}%`, 10)
      + padL(`${excess >= 0 ? '+' : ''}${excess}pp`, 9) + padL(r.pickN, 7));
  }

  console.log('\n══════════ 可交易性與費稅 ══════════\n');
  console.log(pad('榜單', 10) + padL('持有', 5) + padL('推薦當日漲停(買不到)', 22) + padL('剔除後均報', 13) + padL('扣費稅後', 11) + padL('對比基準', 11));
  console.log('─'.repeat(74));
  for (const r of rows) {
    const net = r.tradableAvg != null ? r2(r.tradableAvg - COST) : null;
    const vs = net != null ? r2(net - (r.baseAvg - COST)) : null;
    console.log(pad(r.list, 10) + padL(`${r.h}日`, 5)
      + padL(`${r.limitUp} / ${r.pickN}（${Math.round(r.limitUp / r.pickN * 100)}%）`, 22)
      + padL(net != null ? `${r.tradableAvg}%` : '—', 13)
      + padL(net != null ? `${net}%` : '—', 11)
      + padL(vs != null ? `${vs >= 0 ? '+' : ''}${vs}pp` : '—', 11));
  }

  // ── 5) 大盤同期走勢（讓「市況」這個解釋可被檢驗）─────────────────
  console.log('\n══════════ 追蹤期間的大盤背景 ══════════\n');
  const first = hist[0]?.date, last = days[days.length - 1]?.date;
  const u0 = universe(first);
  const eqStart = u0.map(c => px(first, c)).filter(Boolean);
  const eqEnd = u0.map(c => px(last, c)).filter(Boolean);
  if (eqStart.length && eqEnd.length) {
    const rets = u0.map(c => { const a = px(first, c), b = px(last, c); return a && b ? (b - a) / a * 100 : null; }).filter(v => v != null);
    console.log(`  ${first} → ${last}（${di[last] - di[first]} 個交易日）`);
    console.log(`  可交易宇宙 ${rets.length} 檔等權：平均 ${r2(avg(rets))}%、中位 ${r2(med(rets))}%、上漲比例 ${wr(rets)}%`);
  }

  // ── 6) 未被追蹤的榜單 ─────────────────────────────────────────────
  console.log('\n══════════ 未被追蹤的分頁 ══════════\n');
  console.log('  UI 有 5 個分頁：AI精選TOP20 / 盤中潛力 / 動能強勢 / 成長潛力 / 穩健防禦');
  console.log('  picksHistory 只記錄：top20、intraday');
  console.log('  ⇒ 動能強勢、成長潛力、穩健防禦 **從未被記錄過**，沒有任何歷史可回溯計算。');
  console.log('     要有成績只能從今天開始存，5 個交易日後才有第一筆 5 日數字。\n');
  process.exit(0);
};
main().catch(e => { console.error(e); process.exit(1); });
