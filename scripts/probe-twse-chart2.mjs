#!/usr/bin/env node
// 測試案件 H2/H3（2026-09-04 10:30）：延遲對比＋揭示節奏驗證。
// ⚠ 純測試不接生產；全部請求間隔 ≥6 秒（daemon 同配額，不疊爆）。
import { writeFileSync } from 'node:fs';
const H = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://mis.twse.com.tw/stock/index.jsp' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const grab = async (url) => {
  const t0 = Date.now();
  const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(10000) });
  return { at: t0, ms: Date.now() - t0, body: (await r.text()).slice(0, 4000) };
};
const out = { probes: [] };
// H3：兩次間隔 6 秒的快照——比對揭示時戳（tlong）步進是否 5 秒一拍
for (let i = 0; i < 3; i++) {
  out.probes.push({ kind: 'snapshot', ...(await grab('https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_2330.tw&json=1&delay=0')) });
  await sleep(6000);
}
// H1/H2：分時序列（若盤中可用）
out.probes.push({ kind: 'chart', ...(await grab('https://mis.twse.com.tw/stock/api/getChartOhlcStatis.jsp?ex_ch=tse_2330.tw')) });
const path = `/tmp/twse-probe2-${new Date().toISOString().slice(0, 10)}.json`;
writeFileSync(path, JSON.stringify(out, null, 1));
console.log('樣本存於', path);
for (const p of out.probes) console.log(`[${p.kind}] ${p.ms}ms → ${p.body.slice(0, 140).replace(/\n/g, '')}`);
