#!/usr/bin/env node
// ── 第二大腦·官方鏡像：快照註冊表產生器（零網路請求）────────────────────────────
// 輸入：second-brain/official/_catalog/{twse,tpex}_openapi_swagger.json（官方 openapi 目錄）＋ scripts/official-mirror/inventory-2026-10-04.json（盤點）
// 輸出：scripts/official-mirror/snapshot-registry.json——每一支 openapi 路徑一筆（使用者：官網能下載的都下載），頻率／優先序取盤點：
//   盤點對得到（url 含該路徑、notes 的 paths(...) 清單、或 {n} 子表）⇒ 用盤點的 plan；對不到或盤點標 skip ⇒ 每月一次、P3（便宜：每月 1 個請求）。
// 另外加上盤點裡非 openapi 的快照（證交所 notetrans／announcement、櫃買 warning）與季財報（MOPS t163sb04／05／06）。
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CAT = process.env.OFFICIAL_CATALOG || join(ROOT, 'second-brain', 'official', '_catalog');
const PLAN2FREQ = { 'daily-snapshot': 'daily', 'weekly-snapshot': 'weekly', monthly: 'monthly', quarterly: 'quarterly' };

function inventoryIndex(entries) {
  const byPath = new Map();
  for (const e of entries) {
    const freq = PLAN2FREQ[e.plan];
    const rec = { freq: freq || 'monthly', priority: freq ? e.priority : 3, inv: e.id, title: e.title };
    const names = [];
    const m = String(e.notes || '').match(/paths\(\d+\)：?:?\s*([^；;。]+)/);
    if (m) names.push(...m[1].split(/[,，、]\s*/).map(s => s.trim()).filter(Boolean));
    const n = String(e.url).match(/\/([\w]+)_\{n\}\s*\(n=(\d+)\.\.(\d+)\)/);
    if (n) for (let i = +n[2]; i <= +n[3]; i++) names.push(`${n[1]}_${i}`);
    const direct = String(e.url).match(/openapi[^\s]*\/v1(\/[\w/]+)/);
    if (direct && !direct[1].includes('{')) names.push(direct[1].replace(/^\//, ''));
    for (const nm of names) {
      const key = nm.replace(/^\//, '').split('/').pop();
      const prev = byPath.get(key);
      if (!prev || (freq && (!prev.freqFromPlan || rec.priority < prev.priority))) byPath.set(key, { ...rec, freqFromPlan: !!freq });
    }
  }
  return byPath;
}

function swaggerEntries(file, host, base, idPrefix, idx) {
  const sw = JSON.parse(readFileSync(join(CAT, file), 'utf8'));
  return Object.entries(sw.paths).map(([path, ops]) => {
    const op = Object.values(ops)[0] || {};
    const key = path.split('/').pop();
    const hit = idx.get(key) || idx.get(path.replace(/^\//, ''));
    return {
      id: `${idPrefix}${path.replace(/^\//, '').replace(/[^\w]+/g, '_')}`, host, kind: 'json', validator: 'openapi',
      url: `${base}${path}`, title: op.summary || op.description || '', tag: (op.tags || [])[0] || '',
      freq: hit?.freq || 'monthly', priority: hit?.priority || 3, inventoryId: hit?.inv || null,
    };
  });
}

const EXTRA = [
  { id: 'twse_notetrans', host: 'www.twse.com.tw', kind: 'json', validator: 'twseSnap', url: 'https://www.twse.com.tw/rwd/zh/announcement/notetrans?response=json', title: '注意累計次數可能達處置（上市）', freq: 'daily', priority: 1, inventoryId: 'twse_notetrans' },
  { id: 'twse_announcement', host: 'www.twse.com.tw', kind: 'json', validator: 'twseSnap', url: 'https://www.twse.com.tw/rwd/zh/announcement/announcement?response=json', title: '證交所最新公告', freq: 'daily', priority: 3, inventoryId: 'twse_announcement' },
  { id: 'twse_twt96u', host: 'www.twse.com.tw', kind: 'json', validator: 'twseSnap', url: 'https://www.twse.com.tw/rwd/zh/marginTrading/TWT96U?response=json', title: '當日可借券賣出股數（上市）', freq: 'daily', priority: 1, inventoryId: 'twse_twt96u' },
  { id: 'tpex_bulletin_warning', host: 'www.tpex.org.tw', kind: 'json', validator: 'tpexSnap', url: 'https://www.tpex.org.tw/www/zh-tw/bulletin/warning?response=json', title: '上櫃注意股（當日）', freq: 'daily', priority: 2, inventoryId: 'tpex_bulletin_warning' },
  // 興櫃當日行情（www，AI 停損 A3 的 PRIMARY；openapi tpex_esb_latest_statistics 為 FALLBACK）：官方沒有可指定日期的興櫃全表
  //   （2026-10-05 實測：emerging/historical 必須帶個股代號、且只有最高／最低／均價沒有最後成交價）⇒ 每日快照累積；
  //   回聲＝tables[0].date「115年10月05日 16:33:03」（tpexSnap 取民國日期），快照鍵用官方回聲日（keyByEcho）。
  { id: 'tpex_emerging_latest', host: 'www.tpex.org.tw', kind: 'json', validator: 'tpexSnap', url: 'https://www.tpex.org.tw/www/zh-tw/emerging/latest?response=json', title: '興櫃股票當日行情表（www）', freq: 'daily', priority: 1, inventoryId: 'tpex_emerging_latest' },
];
// 季財報彙總（MOPS，sii／otc；Q2～Q4 為年初累計，解析端換算）——每季在法定期限窗內抓、期限翌日定版
const QUARTERLY = ['t163sb04', 't163sb05', 't163sb06'].map((t, i) => ({
  id: `mops_${t}`, host: 'mopsov.twse.com.tw', kind: 'text', ext: 'html', encoding: 'utf-8', unit: 'quarter', variants: ['sii', 'otc'],
  url: `https://mopsov.twse.com.tw/mops/web/ajax_${t}`, method: 'POST',
  body: 'encodeURIComponent=1&step=1&firstin=1&off=1&isQuery=Y&TYPEK={market}&year={rocYear}&season={season2}',
  mustContain: ['{marketName}', '{seasonZh}'], mustMatch: ['<td[^>]*>\\s*\\d{4}\\s*</td>'], emptyRe: '查無|無資料|查詢無', title: ['綜合損益表彙總', '資產負債表彙總', '營益分析彙總'][i], freq: 'quarterly', priority: i < 2 ? 1 : 2, inventoryId: `mops_${t}`,
}));

function main() {
  const inv = JSON.parse(readFileSync(join(HERE, 'inventory-2026-10-04.json'), 'utf8')).entries;
  const idx = inventoryIndex(inv);
  const reg = [
    ...swaggerEntries('twse_openapi_swagger.json', 'openapi.twse.com.tw', 'https://openapi.twse.com.tw/v1', 'twse_oa_', idx),
    ...swaggerEntries('tpex_openapi_swagger.json', 'www.tpex.org.tw', 'https://www.tpex.org.tw/openapi/v1', 'tpex_oa_', idx),
    ...EXTRA, ...QUARTERLY,
  ];
  const ids = new Set(); for (const r of reg) { if (ids.has(r.id)) throw new Error(`id 重複：${r.id}`); ids.add(r.id); }
  const out = { generated: new Date().toISOString().slice(0, 10), note: '由 build-registry.mjs 產生，勿手改', entries: reg };
  writeFileSync(join(HERE, 'snapshot-registry.json'), JSON.stringify(out, null, 1));
  const cnt = {}; for (const r of reg) cnt[`${r.freq}/P${r.priority}`] = (cnt[`${r.freq}/P${r.priority}`] || 0) + 1;
  console.log(`快照註冊表 ${reg.length} 筆（openapi ${reg.length - EXTRA.length - QUARTERLY.length}）`, cnt);
}

main();
