#!/usr/bin/env node
// ── 回補上市櫃近 2 年 8 季財報 → finReports/{code} ──────────────────────
// 來源：MOPS 彙總表（mopsov.twse.com.tw，官方）
//   t163sb04 綜合損益（營收/營業利益/稅後淨利/EPS）
//   t163sb06 營益分析（毛利率/營益率/稅後純益率）
//   t163sb05 資產負債（資產/負債/權益/每股淨值）
// 8 季 × 2 市場 × 3 表 = 48 請求（1.2s 間隔）。冪等：整批重建（財報定案後不變）。
// 單位：損益表為千元；營益分析營收為百萬元；比率為 %。EPS 為元。
import admin from 'firebase-admin';
process.env.GOOGLE_APPLICATION_CREDENTIALS ||= '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

// 近 8 季（新→舊）：[西元年, 季]
const QUARTERS = [[2026, 1], [2025, 4], [2025, 3], [2025, 2], [2025, 1], [2024, 4], [2024, 3], [2024, 2]];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = s => { const t = String(s ?? '').replace(/,/g, '').trim(); if (!t || t === '--' || t === '-' || t === 'N/A') return null; const v = parseFloat(t.replace(/^\((.*)\)$/, '-$1')); return Number.isFinite(v) ? v : null; };

async function fetchMops(table, typek, year, season) {
  const body = `encodeURIComponent=1&step=1&firstin=1&off=1&isQuery=Y&TYPEK=${typek}&year=${year - 1911}&season=0${season}`;
  const r = await fetch(`https://mopsov.twse.com.tw/mops/web/ajax_${table}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' }, body,
  });
  if (!r.ok) throw new Error(`${table} ${typek} ${year}Q${season} HTTP ${r.status}`);
  return r.text();
}

// 解析 MOPS 彙總 HTML：多個 <table>（按產業別分表、欄位不同），以各表 header 對映欄位
function parseTables(html) {
  const rows = []; // {header: [..], cells: [..]}
  for (const tm of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    let header = null;
    for (const rm of tm[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...rm[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;|\s+/g, '').trim());
      if (!cells.length) continue;
      if (cells.some(c => c.includes('公司代號'))) { header = cells; continue; }
      if (header && /^\d{4}$/.test(cells[0])) rows.push({ header, cells });
    }
  }
  return rows;
}
const col = (row, ...keys) => {
  for (const key of keys) { const i = row.header.findIndex(h => h.includes(key)); if (i >= 0) return num(row.cells[i]); }
  return null;
};

const data = {}; // code -> {name, market, q: {"2026Q1": {...}}}
const put = (code, name, market, qk, patch) => {
  const d = (data[code] ||= { name: name || '', market, q: {} });
  if (name && !d.name) d.name = name;
  Object.assign((d.q[qk] ||= {}), patch);
};

for (const [year, season] of QUARTERS) {
  const qk = `${year}Q${season}`;
  for (const typek of ['sii', 'otc']) {
    const market = typek === 'sii' ? 'tse' : 'otc';
    // 損益
    try {
      const rows = parseTables(await fetchMops('t163sb04', typek, year, season));
      for (const r of rows) put(r.cells[0], r.cells[1], market, qk, {
        rev: col(r, '營業收入', '收益', '淨收益'), op: col(r, '營業利益'), ni: col(r, '稅後淨利', '本期淨利', '本期稅後淨利'),
        eps: col(r, '基本每股盈餘'),
      });
      console.log(`✓ 損益 ${qk} ${typek}: ${rows.length} 檔`);
    } catch (e) { console.log(`✖ 損益 ${qk} ${typek}:`, e.message); }
    await sleep(1200);
    // 營益分析
    try {
      const rows = parseTables(await fetchMops('t163sb06', typek, year, season));
      for (const r of rows) put(r.cells[0], r.cells[1], market, qk, {
        gm: col(r, '毛利率'), om: col(r, '營業利益率'), nm: col(r, '稅後純益率'),
      });
      console.log(`✓ 營益 ${qk} ${typek}: ${rows.length} 檔`);
    } catch (e) { console.log(`✖ 營益 ${qk} ${typek}:`, e.message); }
    await sleep(1200);
    // 資產負債
    try {
      const rows = parseTables(await fetchMops('t163sb05', typek, year, season));
      for (const r of rows) put(r.cells[0], r.cells[1], market, qk, {
        assets: col(r, '資產總額', '資產總計'), debt: col(r, '負債總額', '負債總計'),
        equity: col(r, '權益總額', '權益總計'), bps: col(r, '每股參考淨值'),
      });
      console.log(`✓ 資負 ${qk} ${typek}: ${rows.length} 檔`);
    } catch (e) { console.log(`✖ 資負 ${qk} ${typek}:`, e.message); }
    await sleep(1200);
  }
}

// 寫入：quarters 陣列（新→舊，依 QUARTERS 順序）
const codes = Object.keys(data).filter(c => /^\d{4}$/.test(c));
console.log(`\n共 ${codes.length} 檔，開始寫入…`);
let batch = db.batch(), n = 0, written = 0;
for (const code of codes) {
  const d = data[code];
  const quarters = QUARTERS.map(([y, s]) => ({ y, s, ...(d.q[`${y}Q${s}`] || {}) }));
  batch.set(db.collection('finReports').doc(code), {
    code, name: d.name, market: d.market, updatedAt: Date.now(),
    quartersJson: JSON.stringify(quarters),
  });
  if (++n >= 400) { await batch.commit(); written += n; batch = db.batch(); n = 0; }
}
if (n) { await batch.commit(); written += n; }
console.log(`finReports 寫入 ${written} 檔`);
// 樣本驗證
const s = data['2330'];
if (s) console.log('樣本 2330 台積電:', JSON.stringify(QUARTERS.slice(0, 2).map(([y, q]) => ({ q: `${y}Q${q}`, ...s.q[`${y}Q${q}`] }))));
process.exit(0);
