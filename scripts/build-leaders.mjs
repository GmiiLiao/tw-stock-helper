#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 產業龍頭名單產生器（回測驗證用）
// 來源：peerComps/latest.industriesJson（37 產業，MOPS 官方分類）
//     × chipArchive 近 60 交易日平均成交值（收盤×量張，客觀流動性/規模代理）。
// 規則：每產業取平均成交值前 2 名（僅普通股 4 碼、需 60 日內≥40 日有資料）。
// 輸出：scripts/data/industry-leaders.json —— 全部由資料產生、可重現，不背誦名單。
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

async function main() {
  const pc = (await db.collection('peerComps').doc('latest').get()).data();
  const industries = JSON.parse(pc.industriesJson);

  // 近 60 交易日平均成交值
  const snap = await db.collection('chipArchive').get();
  const days = snap.docs.map(d => ({ id: d.id, x: d.data() })).filter(d => d.x.closeJson)
    .sort((a, b) => a.id.localeCompare(b.id)).slice(-60);
  const sumVal = {}, cnt = {};
  for (const d of days) {
    const close = JSON.parse(d.x.closeJson);
    for (const c in close) {
      const [p, volLots] = close[c];
      if (!(p > 0)) continue;
      sumVal[c] = (sumVal[c] || 0) + p * (volLots || 0) * 1000;
      cnt[c] = (cnt[c] || 0) + 1;
    }
  }

  const leaders = [];
  for (const [ind, members] of Object.entries(industries)) {
    const ranked = (members || [])
      // 只取上市（2026-10-09 移植 MOPS 月營收口徑：peerComps 起含上櫃、每列帶 mkt）：名單由 build-model-core 等模型使用，
      //   納入上櫃＝名單定義改變，要改先問使用者（同 swing-formula-shadow／squeeze-train）
      .filter(m => /^\d{4}$/.test(m.code) && (m.mkt ?? '上市') === '上市' && (cnt[m.code] || 0) >= 40)
      .map(m => ({ code: m.code, name: m.name, industry: ind, avgValueE8: +((sumVal[m.code] / cnt[m.code]) / 1e8).toFixed(2) }))
      .sort((a, b) => b.avgValueE8 - a.avgValueE8);
    for (const m of ranked.slice(0, 2)) leaders.push(m);
  }
  leaders.sort((a, b) => b.avgValueE8 - a.avgValueE8);

  const out = {
    generatedAt: new Date().toISOString(),
    rule: '每產業(peerComps 37 業·MOPS 分類)取近 60 交易日平均成交值前 2 名；普通股 4 碼、≥40 日有資料',
    window: { from: days[0]?.id, to: days[days.length - 1]?.id, days: days.length },
    count: leaders.length,
    leaders,
  };
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'industry-leaders.json'), JSON.stringify(out, null, 1));
  console.log(`[leaders] ${leaders.length} 檔（${Object.keys(industries).length} 產業×前2）→ scripts/data/industry-leaders.json`);
  console.log('前 12：', leaders.slice(0, 12).map(l => `${l.code}${l.name}(${l.industry},${l.avgValueE8}億/日)`).join(' '));
  process.exit(0);
}
main().catch(e => { console.error('[leaders] 失敗:', e); process.exit(1); });
