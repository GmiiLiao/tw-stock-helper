#!/usr/bin/env node
// TWSE MIS 分時端點探測（2026-09-03 晚·使用者要求評估 TWSE 優先於 Yahoo）
// getChartOhlcStatis.jsp 收盤後回 Not Found，格式無樣本 ⇒ 盤中打一次取真實回應。
// ⚠ 與快線/主迴圈同 MIS 配額（每 5 秒 3 請求·同 IP）——本探測只打 3 次、間隔 6 秒。
import { writeFileSync } from 'node:fs';

const H = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://mis.twse.com.tw/stock/index.jsp' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = [];
for (const [label, url] of [
  ['ohlc-2330', 'https://mis.twse.com.tw/stock/api/getChartOhlcStatis.jsp?ex_ch=tse_2330.tw'],
  ['ohlc-otc', 'https://mis.twse.com.tw/stock/api/getChartOhlcStatis.jsp?ex_ch=otc_5483.tw'],
  ['ohlc-multi', 'https://mis.twse.com.tw/stock/api/getChartOhlcStatis.jsp?ex_ch=tse_2330.tw|tse_2317.tw'],
]) {
  try {
    const t0 = Date.now();
    const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(10000) });
    const text = await r.text();
    out.push({ label, status: r.status, ms: Date.now() - t0, body: text.slice(0, 3000) });
    console.log(`[${label}] ${r.status} ${Date.now() - t0}ms → ${text.slice(0, 120)}`);
  } catch (e) { out.push({ label, error: String(e) }); console.log(`[${label}] ERR ${e}`); }
  await sleep(6000);
}
const path = `/tmp/twse-chart-probe-${new Date().toISOString().slice(0, 10)}.json`;
writeFileSync(path, JSON.stringify(out, null, 1));
console.log('樣本存於', path);
