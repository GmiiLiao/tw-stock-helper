#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 撿尾盤「主濾網」替換回測：現行(漲≥1%·pos≥0.9·破5日高) vs 提案(破20日高×pos≥0.7)。
// 依 audit-weights/audit-regime 結論：破高×強尾是唯一兩窗×兩regime皆正的組合。
// 口徑：明開賣淨/明收賣淨（扣0.4425%）×前後半窗＋每日榜單數（產品可用性）。
// 非投資建議；本輸出為濾網替換的唯一依據。
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const DAYS = +(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || 480);
const COST = 0.4425, MIN_VOL = 300;
const pct = (n, d) => d ? +(n / d * 100).toFixed(1) : null;
const avg = a => a.length ? +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(3) : null;

async function main() {
  const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(DAYS + 22).get();
  const days = snap.docs.map(d => ({ date: d.id, close: d.data().closeJson ? JSON.parse(d.data().closeJson) : null,
    mg: d.data().marginJson ? JSON.parse(d.data().marginJson) : null,
    ln: d.data().lendingJson ? JSON.parse(d.data().lendingJson) : null }))
    .filter(d => d.close && d.close['2330'])
    .sort((a, b) => a.date.localeCompare(b.date));
  console.log(`交易日 ${days.length}（${days[0]?.date} → ${days[days.length - 1]?.date}）`);

  const samples = [];
  for (let i = 21; i < days.length - 1; i++) {
    const half = i < days.length / 2 ? 0 : 1;
    const m0 = days[i - 1].close, m1 = days[i].close, m2 = days[i + 1].close;
    const hi5 = {}, hi20 = {};
    for (let k = i - 20; k < i; k++) {
      const m = days[k].close;
      for (const code in m) {
        const v = m[code]?.[0]; if (!(v > 0)) continue;
        if (v > (hi20[code] || 0)) hi20[code] = v;
        if (k >= i - 5 && v > (hi5[code] || 0)) hi5[code] = v;
      }
    }
    for (const code in m1) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const r = m1[code]; if (!r || r.length < 5) continue;
      const [c, v, o, h, l] = r;
      const pc = m0?.[code]?.[0];
      const n = m2?.[code]; if (!n || n.length < 5) continue;
      const [nc, , no] = n;
      if (!(c > 0 && pc > 0 && nc > 0 && no > 0 && h > l && o > 0 && v >= MIN_VOL)) continue;
      const chg = (c - pc) / pc * 100;
      if (chg < 0.5 || chg > 8.5) continue;
      const pos = (c - l) / (h - l);
      // 資券借券（PIT 安全：t-1 餘額 vs t-2，撿尾盤 13:20 時 t 當日尚未公布）
      const yVol = m0?.[code]?.[1] || 0;
      const a1 = days[i - 1].mg?.[code], a2 = days[i - 2]?.mg?.[code];
      const mgChg = a1 && a2 ? (a1[0] || 0) - (a2[0] || 0) : null;   // 昨日融資增減(張)
      const shChg = a1 && a2 ? (a1[1] || 0) - (a2[1] || 0) : null;   // 昨日融券增減(張)
      const l1 = days[i - 1].ln?.[code], l2 = days[i - 2]?.ln?.[code];
      const lnChg = l1 != null && l2 != null ? l1 - l2 : null;       // 昨日借券餘增減(張)
      const sqzSetup = shChg != null && yVol >= 300 && shChg >= yVol * 0.005;
      samples.push({ half, date: days[i].date, chg, pos, volX: m0?.[code]?.[1] > 0 ? v / m0[code][1] : 0,
        brk5: hi5[code] > 0 && c > hi5[code], brk20: hi20[code] > 0 && c > hi20[code],
        mgChg, shChg, lnChg, sqzSetup, yVol,
        netOpen: (no - c) / c * 100 - COST, netClose: (nc - c) / c * 100 - COST });
    }
  }
  console.log(`候選樣本 ${samples.length.toLocaleString()}\n`);

  const FILTERS = {
    '現行：漲≥1·pos≥0.9·破5日高': s => s.chg >= 1 && s.pos >= 0.9 && s.brk5,
    '提案A：破20日高×pos≥0.7': s => s.brk20 && s.pos >= 0.7,
    '提案B：A＋漲≥1%': s => s.brk20 && s.pos >= 0.7 && s.chg >= 1,
    '提案C：A＋量比≥1.5': s => s.brk20 && s.pos >= 0.7 && s.volX >= 1.5,
    '提案D：A＋漲3~7甜蜜區': s => s.brk20 && s.pos >= 0.7 && s.chg >= 3 && s.chg <= 7,
  };
  const stat = arr => arr.length < 300 ? null : ({
    n: arr.length,
    openWin: pct(arr.filter(s => s.netOpen > 0).length, arr.length), openNet: avg(arr.map(s => s.netOpen)),
    closeWin: pct(arr.filter(s => s.netClose > 0).length, arr.length), closeNet: avg(arr.map(s => s.netClose)),
  });
  const base = stat(samples);
  console.log(`基準（全候選）：明開賣 淨勝${base.openWin}%·淨均${base.openNet}% ｜ 明收賣 淨勝${base.closeWin}%·淨均${base.closeNet}%\n`);
  const nDays = new Set(samples.map(s => s.date)).size;
  for (const [name, f] of Object.entries(FILTERS)) {
    const sel = samples.filter(f);
    const all = stat(sel), a = stat(sel.filter(s => s.half === 0)), b = stat(sel.filter(s => s.half === 1));
    if (!all) { console.log(`${name}: 樣本不足`); continue; }
    const perDay = +(sel.length / nDays).toFixed(1);
    console.log(`── ${name}（日均 ${perDay} 檔·n=${all.n.toLocaleString()}）`);
    console.log(`  明開賣：淨勝${all.openWin}%·淨均${all.openNet}%（vs基準 ${(all.openNet - base.openNet).toFixed(3)}）  前半[${a ? a.openNet : '-'}] 後半[${b ? b.openNet : '-'}]`);
    console.log(`  明收賣：淨勝${all.closeWin}%·淨均${all.closeNet}%（vs基準 ${(all.closeNet - base.closeNet).toFixed(3)}）  前半[${a ? a.closeNet : '-'}] 後半[${b ? b.closeNet : '-'}]\n`);
  }
  // ── 最終落地規則驗證（daemon 已實裝）：破20日高×pos≥0.7×漲3~7 ── 每日等權組合模擬（明開賣）
  const FINAL = s2 => s2.brk20 && s2.pos >= 0.7 && s2.chg >= 3 && s2.chg <= 7;
  for (const [label, from] of [['全窗', null], ['近240日', days[days.length - 241]?.date]]) {
    const sel = samples.filter(FINAL).filter(s2 => !from || s2.date >= from);
    const byDay = {};
    for (const x of sel) (byDay[x.date] ||= []).push(x.netOpen);
    const dayRets = Object.values(byDay).map(a => a.reduce((t, v) => t + v, 0) / a.length);
    const posDays = dayRets.filter(v => v > 0).length;
    console.log(`最終規則·${label}：${Object.keys(byDay).length} 個交易日有榜、日組合均 ${avg(dayRets)}%、正報酬日 ${pct(posDays, dayRets.length)}%、樣本 ${sel.length.toLocaleString()}`);
  }
  // ── 資券借券疊加測試（在定版濾網之上，t-1 資料 PIT 安全）──
  console.log('── 資券借券疊加（基準＝定版濾網全體）──');
  const fin = samples.filter(FINAL);
  const finBase = stat(fin);
  console.log(`定版全體：明開賣 淨勝${finBase.openWin}%·淨均${finBase.openNet}% ｜ 明收賣淨均${finBase.closeNet}%·n=${finBase.n.toLocaleString()}\n`);
  const overlay = (label, cond) => {
    const sel = fin.filter(cond);
    const all = stat(sel), a = stat(sel.filter(x => x.half === 0)), b = stat(sel.filter(x => x.half === 1));
    if (!all) { console.log(`  ${label.padEnd(16)} 樣本不足(n=${sel.length})`); return; }
    console.log(`  ${label.padEnd(16)} 明開賣 淨勝${all.openWin}%·淨均${all.openNet}%（vs定版 ${(all.openNet - finBase.openNet).toFixed(3)}）·明收賣淨均${all.closeNet}%·n=${all.n.toLocaleString()}  半窗開賣[${a ? a.openNet : '-'}/${b ? b.openNet : '-'}]`);
  };
  overlay('⚡軋空setup', x => x.sqzSetup);
  overlay('無軋空setup', x => x.shChg != null && !x.sqzSetup);
  overlay('昨融資增', x => x.mgChg != null && x.mgChg > 0);
  overlay('昨融資減/平', x => x.mgChg != null && x.mgChg <= 0);
  overlay('昨融資大增≥1%量', x => x.mgChg != null && x.yVol >= 300 && x.mgChg >= x.yVol * 0.01);
  overlay('昨券增(任何)', x => x.shChg != null && x.shChg > 0);
  overlay('昨券減/平', x => x.shChg != null && x.shChg <= 0);
  overlay('昨借券增', x => x.lnChg != null && x.lnChg > 0);
  overlay('昨借券減/平', x => x.lnChg != null && x.lnChg <= 0);
  overlay('無資券資料(上櫃部分)', x => x.mgChg == null);
  console.log('');
  console.log('※ 判準：兩口徑淨均皆優於現行、前後半窗同向、日均檔數足夠成榜（≥3）。非投資建議。');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
