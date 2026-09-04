#!/usr/bin/env node
// H3 重測（2026-09-07 週一 10:30·使用者 09-04 糾正）：
// 台積電 z 常缺席是 CLAUDE.md 已記的已知現象（「2330 連 6 次揭示無成交價、累積量卻在漲」），
// 拿它驗揭示節奏是選錯標的。改用低價高量股（09-04 成交量前列·z 幾乎每拍有值）。
// ⚠ 純測試不接生產；每請求間隔 6 秒（與 daemon 同 MIS 配額）；三檔輪流各 4 輪＝12 請求/72 秒。
import { writeFileSync } from 'node:fs';
const H = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://mis.twse.com.tw/stock/index.jsp' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CODES = ['2409', '2324', '3481'];           // 友達／仁寶／群創（09-04 量 15.7/14.0/13.0 萬張）
const out = [];
for (let round = 0; round < 4; round++) {
  for (const c of CODES) {
    const t0 = Date.now();
    try {
      const r = await fetch(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_${c}.tw&json=1&delay=0`, { headers: H, signal: AbortSignal.timeout(10000) });
      const j = await r.json();
      const q = j?.msgArray?.[0] || {};
      out.push({ code: c, at: t0, tlong: +q.tlong || null, t: q.t, z: q.z, v: q.v, b1: String(q.b || '').split('_')[0] });
      console.log(`[${c}] at=${new Date(t0).toISOString().slice(11, 19)} 揭示=${q.t} z=${q.z} v=${q.v} 齡=${q.tlong ? ((t0 - +q.tlong) / 1000).toFixed(1) : '?'}s`);
    } catch (e) { out.push({ code: c, at: t0, error: String(e) }); console.log(`[${c}] ERR ${e}`); }
    await sleep(6000);
  }
}
const path = `/tmp/twse-probe3-${new Date().toISOString().slice(0, 10)}.json`;
writeFileSync(path, JSON.stringify(out, null, 1));
console.log('樣本存於', path);
// 每檔揭示步進摘要
for (const c of CODES) {
  const rows = out.filter(x => x.code === c && x.tlong);
  const steps = rows.slice(1).map((x, i) => ((x.tlong - rows[i].tlong) / 1000).toFixed(0));
  console.log(`${c} 揭示步進(秒)=[${steps.join(',')}]  z有值 ${rows.filter(x => x.z !== '-').length}/${rows.length}`);
}
