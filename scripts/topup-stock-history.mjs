#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// stockHistory 補正：用自家 chipArchive（官方收盤）把每檔的日線補齊。
//
// 為什麼需要：`/api/history` 是**只寫一次**的快取 —— 只有 doc 不存在時才抓
// Yahoo 並寫入，之後永遠回傳舊的。實測 1,082 檔**沒有一檔**是最新的：
//   2026-07-29 → 578 檔（落後 2 天）
//   2026-07-27 → 162 檔
//   2026-07-24 → 101 檔
//   2026-06-22 → 101 檔（落後 5 週以上）
//
// 而且不只尾端落後，中間**還有洞**（Yahoo 逐檔漏日K，漲停股尤甚）。
// 實例 5880：7-21 → 7-27 → 7-29，中間 7-22/23/24/28 全缺。
//
// 後果（截圖實證）：`/api/rating` 的 price 是今日官方收盤，但 buyZones／
// stopLoss／RSI／MACD／均線支撐全部由這份過期 bars 算出 ——
// 盤前快報就出現「玉山金現價 37.7，建議買 32.53、目標 33.23」這種
// 目標價低於現價 12% 的荒謬建議，合庫金甚至停損(24.14) > 買點(24.08)。
//
// 修法：chipArchive 有全市場官方收盤 [收,量張,開,高,低]，直接覆蓋合併 ——
// 官方值優先，補洞與補尾端一次做完。冪等，可重複執行。
//
// 用法：node scripts/topup-stock-history.mjs [--dry] [--days=400] [--code=2330]
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const DRY = process.argv.includes('--dry');
const ONLY = (process.argv.find(a => a.startsWith('--code=')) || '').slice(7) || null;
const DAYS = +((process.argv.find(a => a.startsWith('--days=')) || '').slice(7)) || 400;

/** 讀近 N 個歸檔日 → { iso: { code: [收,量張,開,高,低] } }（舊→新） */
async function loadArchive(days) {
  const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(days).get();
  const out = [];
  for (const doc of snap.docs) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(doc.id)) continue;
    const raw = doc.data().closeJson;
    if (!raw) continue;
    const map = JSON.parse(raw);
    if (Object.keys(map).length <= 500) continue;     // 與 loadLuArchive 同門檻
    out.push({ d: doc.id, map });
  }
  return out.reverse();
}

function archiveBar(d, r) {
  // [收, 量張, 開, 高, 低] → DailyBar。量單位換回股數，與 Yahoo 來源一致。
  const c = r[0];
  return {
    d,
    o: +(r[2] || c).toFixed(2),
    h: +(r[3] || c).toFixed(2),
    l: +(r[4] || c).toFixed(2),
    c: +c.toFixed(2),
    v: Math.round((r[1] || 0) * 1000),
  };
}

async function main() {
  const archive = await loadArchive(DAYS);
  if (!archive.length) { console.error('[hist] chipArchive 讀不到資料'); process.exit(1); }
  const newest = archive[archive.length - 1].d;
  console.log(`[hist] chipArchive ${archive.length} 個交易日（${archive[0].d} → ${newest}）`);

  const snap = ONLY
    ? await db.collection('stockHistory').where(admin.firestore.FieldPath.documentId(), '==', ONLY).get()
    : await db.collection('stockHistory').get();
  console.log(`[hist] stockHistory ${snap.size} 檔待處理`);

  let touched = 0, appended = 0, patched = 0, already = 0;
  let batch = db.batch(), inBatch = 0;

  for (const doc of snap.docs) {
    const code = doc.id;
    const data = doc.data();
    const bars = Array.isArray(data.bars) ? data.bars : [];
    if (!bars.length) continue;

    const byDate = new Map(bars.map(b => [b.d, b]));
    const before = byDate.size;
    let addedTail = 0, filledHole = 0;
    const oldLast = data.lastDate || bars[bars.length - 1]?.d || '';

    for (const day of archive) {
      const r = day.map[code];
      if (!Array.isArray(r) || !(r[0] > 0)) continue;
      // 不要往前長出比原本 firstDate 更早的資料（維持既有窗長語意）
      if (data.firstDate && day.d < data.firstDate) continue;
      const had = byDate.has(day.d);
      byDate.set(day.d, archiveBar(day.d, r));    // 官方值優先，覆蓋 Yahoo
      if (!had) (day.d > oldLast ? addedTail++ : filledHole++);
    }

    if (byDate.size === before && addedTail === 0 && filledHole === 0) { already++; continue; }

    const merged = [...byDate.values()].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    const lastDate = merged[merged.length - 1].d;
    touched++; appended += addedTail; patched += filledHole;

    if (DRY) {
      if (touched <= 8) console.log(`  (dry) ${code}: ${oldLast} → ${lastDate}｜補尾 ${addedTail}、補洞 ${filledHole}`);
      continue;
    }
    batch.set(doc.ref, {
      bars: merged,
      lastDate,
      firstDate: merged[0].d,
      updatedAt: Date.now(),
      topupAt: Date.now(),
    }, { merge: true });
    // ⚠ batch 上限不是筆數是 payload（11.5MB）。每檔 733 根 bars ≈ 45KB，
    //   200 筆就爆掉。壓到 40 筆（約 1.8MB）留足安全邊際。
    if (++inBatch >= 40) { await batch.commit(); batch = db.batch(); inBatch = 0; process.stdout.write('.'); }
  }
  if (!DRY && inBatch) await batch.commit();

  console.log(`\n[hist] ${DRY ? '(dry) ' : ''}更新 ${touched} 檔｜補尾端 ${appended} 根、補中間空洞 ${patched} 根｜已是最新 ${already} 檔`);
  process.exit(0);
}

main().catch(e => { console.error('[hist] 失敗:', e.message); process.exit(1); });
