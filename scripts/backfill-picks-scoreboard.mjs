#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 推薦記分板回填 —— 2026-08-05
//
// 為什麼需要：trackPicks 的 eval 格式從 `{top20:[報酬…]}` 改成
//   `{top20:{all,tradable}, base:[…]}`（加了可交易性與同期基準）。
//   舊的 23 日歷史是舊格式，新彙總讀不到 → 記分板會歸零重來。
//   而且舊評估用的是「當天的 snapshot 價」，只有在到期當日跑才正確；
//   改用 chipArchive 的歷史收盤重算，過去每一天都能算，也不依賴排程有沒有漏跑。
//
// ⚠**這不是把數字調好看**：回填用的是官方收盤歸檔，該負的照樣負。
//   回填之後 TOP20 5日勝率仍是 32%、超額 -2.12pp。
//
// 用法：node scripts/backfill-picks-scoreboard.mjs [--write]
//       不加 --write 只印結果不寫入。
// ─────────────────────────────────────────────────────────────────────────
import { aggregatePicks, scoreboardDoc, PICK_HORIZONS } from './lib/picks-scoreboard.mjs';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

process.env.GOOGLE_APPLICATION_CREDENTIALS ||=
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
const db = getFirestore(initializeApp({ credential: applicationDefault(), projectId: 'tw-stock-helper' }));

const WRITE = process.argv.includes('--write');
const LISTS = ['top20', 'intraday', 'daily', 'growth', 'defensive',
               'radar', 'chipPicks', 'volSurge', 'swing', 'strength', 'overnight',
               'panicDip', 'overheatExit', 'voteDip', 'overheatV2', 'overheatV3', 'wExit'];
// 2026-09-30：記分板只列未扣成本（成本依持有方式另計，見 CostReference）；與 daemon trackPicks 同口徑
const HOLD = PICK_HORIZONS;
const CALIB = 'v2';   // 與 daemon trackPicks 的 CALIB 同步

const main = async () => {
  // chipArchive：[收盤, 量(張), 開, 高, 低]（⚠[2] 是開盤價，不是漲跌%）
  const arch = await db.collection('chipArchive').orderBy('date').get();
  // 空的歸檔（例：2026-07-10 颱風休市 closeJson='{}'）不是交易日——算進去會讓跨過它的持有天數少一天（2026-10-02 修，同 loadLuArchive 的 >500 檔門檻）
  const days = arch.docs.map(d => d.data()).filter(v => /^\d{4}-\d{2}-\d{2}$/.test(v.date || '') && v.closeJson)
    .map(v => ({ date: v.date, close: JSON.parse(v.closeJson) })).filter(d => Object.keys(d.close).length > 500);
  const di = Object.fromEntries(days.map((d, i) => [d.date, i]));
  console.log(`▶ chipArchive ${days.length} 日；`);

  const ph = await db.collection('picksHistory').get();
  const hist = ph.docs.map(d => d.data()).filter(d => d.date).sort((a, b) => a.date.localeCompare(b.date));
  console.log(`▶ picksHistory ${hist.length} 日（${hist[0]?.date} → ${hist[hist.length - 1]?.date}）\n`);

  const px = (date, code) => { const c = days[di[date]]?.close?.[code]; return c && c[0] > 0 ? c[0] : null; };
  const chg = (date, code) => {
    const i = di[date]; if (i == null || i === 0) return null;
    const c = px(date, code), p = days[i - 1]?.close?.[code]?.[0];
    return c != null && p > 0 ? (c - p) / p * 100 : null;
  };
  const universe = date => {
    const cl = days[di[date]]?.close || {};
    return Object.keys(cl).filter(c => {
      if (!/^\d{4}$/.test(c) || c.startsWith('00')) return false;
      if (!(cl[c][0] > 0) || (cl[c][1] || 0) < 300) return false;
      const g = chg(date, c);
      return g != null && g <= 8.5;              // 進場日漲停＝收盤價買不到
    });
  };

  let wrote = 0;
  for (const rec of hist) {
    const i = di[rec.date];
    if (i == null) { console.log(`  ${rec.date} ✖ 不在 chipArchive，跳過`); continue; }
    const patch = {};
    for (const h of HOLD) {
      if (i + h >= days.length) continue;                       // 尚未到期
      const exit = days[i + h].date;
      const out = {};
      for (const k of LISTS) {
        const all = [], tradable = [];
        for (const p of (rec[k] || [])) {
          // 進場價一律用官方收盤歸檔（與基準同口徑），沒有才退回記錄當下的價
          const e = px(rec.date, p.code) ?? (p.price > 0 ? p.price : null);
          const x = px(exit, p.code);
          if (e == null || x == null) continue;
          const r = +(((x - e) / e) * 100).toFixed(2);
          all.push(r);
          if (!((chg(rec.date, p.code) ?? 0) > 8.5)) tradable.push(r);
        }
        if (all.length) out[k] = { all, tradable };
      }
      out.base = universe(rec.date).map(c => {
        const e = px(rec.date, c), x = px(exit, c);
        return e != null && x != null ? +(((x - e) / e) * 100).toFixed(2) : null;
      }).filter(v => v != null);
      patch[`eval${h}`] = out;
    }
    if (Object.keys(patch).length) {
      if (WRITE) await db.collection('picksHistory').doc(rec.date).set(patch, { merge: true });
      Object.assign(rec, patch);
      wrote++;
    }
  }
  console.log(`▶ 重算 ${wrote} 日的 eval${WRITE ? '（已寫入）' : '（未寫入·加 --write 才寫）'}\n`);

  // ── 彙總（lib/picks-scoreboard.mjs：與 daemon 同一份；基準與榜單取同一批進場日）──
  const A = aggregatePicks(hist, LISTS);

  const pad = (s, n) => String(s).padEnd(n), padL = (s, n) => String(s).padStart(n);
  console.log(pad('榜單', 12) + padL('窗', 5) + padL('勝率', 7) + padL('均報', 9) + padL('基準', 9) + padL('超額', 9)
    + padL('漲停剔除後超額', 16) + padL('進場日', 8) + padL('n', 6));
  console.log('─'.repeat(81));
  for (const k of LISTS) for (const h of HOLD) {
    const r = A[k]?.[`d${h}`]; if (!r) continue;
    console.log(pad(k, 12) + padL(`${h}日`, 5) + padL(`${r.winRate}%`, 7) + padL(`${r.avgRet}%`, 9)
      + padL(`${r.base?.avgRet ?? '—'}%`, 9) + padL(`${r.excess >= 0 ? '+' : ''}${r.excess}pp`, 9)
      + padL(r.excessTradable != null ? `${r.excessTradable >= 0 ? '+' : ''}${r.excessTradable}pp（剔${r.skipped}）` : '—', 16)
      + padL(r.entryDays, 8) + padL(r.n, 6));
  }
  console.log('\n未累積到的榜單：' + LISTS.filter(k => !A[k]).join('、') + '（今日起才開始記錄）');

  if (WRITE) {
    // 寫完整文件（全歷史／現行口徑／舊口徑）——舊版只寫 agg 卻用 set 覆蓋，會把 daemon 維護的現行口徑洗掉
    await db.collection('picksScoreboard').doc('latest').set(scoreboardDoc(hist, LISTS, CALIB));
    console.log('\n✓ picksScoreboard/latest 已更新');
  }
  process.exit(0);
};
main().catch(e => { console.error(e); process.exit(1); });
