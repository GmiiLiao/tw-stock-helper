// 產業別對照（code → 產業名，一律 TWSE 短名一套字）——daemon getIndustryMap 的純函式部分＋本機鏡像讀取。
//
// 2026-10-09 修正「上櫃整批沒有產業別」：舊版抓 openapi.twse.com.tw 的 t187ap03_L＋t187ap03_O，但 **openapi.twse 沒有 t187ap03_O**
//   （302 → /404.html；2026-10-03 查證 swagger 只列 _L／_P），表裡只有上市約 1,090 檔，上櫃約 890 檔整批沒有產業別；
//   總數 >300 ⇒ peerComps 後備永遠不跑（peerComps 本身也只有上市）。
//   上櫃改讀**官方鏡像** second-brain/official/www.tpex.org.tw/tpex_oa_mopsfin_t187ap03_O（櫃買 openapi mopsfin_t187ap03_O，
//   official-mirror 每個交易日 22:40 收一份；欄位 SecuritiesIndustryCode）。不打新的上游、不用 wiki(MOPS) 推導名。
//   鏡像不在／壞檔 ⇒ 退 repo 內 src/lib/t187ap03_O_fallback.json（同一官方來源的打包快照，company-list-server 也用它），
//   並在 daemonHealth.industryMap.problems 與 log 說出來；鏡像過舊照用（產業別是慢變數）但同樣標出。
//
// 口徑：上市 t187ap03_L 的「產業別」與上櫃 SecuritiesIndustryCode 是**同一套官方代碼**（2026-10-09 以鏡像 10-08 版 893 檔
//   逐檔對 wiki MOPS 名稱：每個代碼只對到一個名稱，17＝上市「金融保險業」／上櫃「金融業」同代碼）。所以兩市都以代碼查同一張
//   TWSE 短名表，同代碼必同名；32 文化創意、33 農業科技只有上櫃有公司（上市 0 檔），補進表內。
//   消費端一律用名稱分群——混用兩套字會把同一產業拆成兩群。

export const TWSE_INDUSTRY = {
  '01': '水泥', '02': '食品', '03': '塑膠', '04': '紡織纖維', '05': '電機機械', '06': '電器電纜',
  '08': '玻璃陶瓷', '09': '造紙', '10': '鋼鐵', '11': '橡膠', '12': '汽車', '14': '建材營造',
  '15': '航運', '16': '觀光餐旅', '17': '金融保險', '18': '貿易百貨', '20': '其他', '21': '化學',
  '22': '生技醫療', '23': '油電燃氣', '24': '半導體', '25': '電腦及週邊', '26': '光電', '27': '通信網路',
  '28': '電子零組件', '29': '電子通路', '30': '資訊服務', '31': '其他電子',
  '32': '文化創意', '33': '農業科技',   // 只有上櫃有公司（櫃買類別）
  '35': '綠能環保', '36': '數位雲端', '37': '運動休閒', '38': '居家生活', '91': '存託憑證',
};

/** 官方產業代碼 → 短名；未知代碼保留成「類別XX」（新類別不漏、不捏造名稱） */
export function industryNameOf(code) {
  const c = String(code ?? '').trim();
  if (!c) return null;
  return TWSE_INDUSTRY[c] || `類別${c}`;
}

/** 民國 1151008／115/10/08 → 2026-10-08；認不得回 null */
export function rocToIsoDate(v) {
  const s = String(v ?? '').replace(/\D/g, '');
  if (!/^\d{7}$/.test(s)) return null;
  return `${+s.slice(0, 3) + 1911}-${s.slice(3, 5)}-${s.slice(5, 7)}`;
}

// openapi t187ap03_L 的列（中文鍵）→ { map:{code:短名}, feedIso }
export function parseTwseCompanyRows(rows) {
  const map = {};
  let feedIso = null;
  if (!Array.isArray(rows)) return { map, feedIso };
  for (const x of rows) {
    const code = String(x?.['公司代號'] ?? '').trim();
    const name = industryNameOf(x?.['產業別']);
    if (/^\d{4}$/.test(code) && name) map[code] = name;
    if (!feedIso && x?.['出表日期']) feedIso = rocToIsoDate(x['出表日期']);
  }
  return { map, feedIso };
}

// 櫃買 mopsfin_t187ap03_O 的列（英文鍵）→ { map:{code:短名}, feedIso }
export function parseTpexCompanyRows(rows) {
  const map = {};
  let feedIso = null;
  if (!Array.isArray(rows)) return { map, feedIso };
  for (const x of rows) {
    const code = String(x?.SecuritiesCompanyCode ?? '').trim();
    const name = industryNameOf(x?.SecuritiesIndustryCode);
    if (/^\d{4}$/.test(code) && name) map[code] = name;
    if (!feedIso && x?.Date) feedIso = rocToIsoDate(x.Date);
  }
  return { map, feedIso };
}

/**
 * 鏡像資料集最後一次「驗證到上游」的日子（ISO）。快照型資料集內容沒變時不寫新檔、只在 manifest 記 status:'unchanged'，
 *   所以檔名日期會一直停在上次內容變動那天——新鮮度要看 manifest 各列的 at，不能看檔名。
 *   manifest 缺／壞 ⇒ 退回檔名日期（偏舊＝寧可多警示）。
 */
export function mirrorVerifiedIso(manifest, fileIso = null) {
  let best = null;
  const rows = manifest?.rows && typeof manifest.rows === 'object' ? manifest.rows : {};
  for (const k in rows) {
    const r = rows[k];
    if (r?.status !== 'ok' && r?.status !== 'unchanged') continue;
    const iso = typeof r.at === 'string' ? r.at.slice(0, 10) : null;
    if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) && (!best || iso > best)) best = iso;
  }
  return best || fileIso || null;
}

export const daysBetween = (fromIso, toIso) =>
  fromIso && toIso ? Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86400e3) : null;

// 合併：上市（listed，權威＝t187ap03_L）＞ 上櫃（otc，t187ap03_O）＞ peerComps（上市月營收分群，最後後備）。
//   map＝全市場；listed＝只有上市（漲停預測、話題選股、做空弱勢產業的族群口徑，見 daemon getIndustryMap 註解）。
//   上櫃代碼不覆蓋上市（同代碼不會同時掛兩市；防禦用）。
export function mergeIndustryMaps({ listed = {}, otc = {}, peer = {} } = {}) {
  const map = { ...listed };
  const listedOut = { ...listed };
  let otcN = 0, peerN = 0;
  for (const code in otc) {
    if (map[code]) continue;
    map[code] = otc[code]; otcN++;
  }
  for (const g in peer) {
    if (!Array.isArray(peer[g])) continue;
    for (const it of peer[g]) {
      const code = it?.code;
      if (!/^\d{4}$/.test(code || '') || map[code]) continue;
      map[code] = g; listedOut[code] = g; peerN++;
    }
  }
  const listedN = Object.keys(listed).length + peerN;
  return { map, listed: listedOut, counts: { listed: listedN, otc: otcN, peer: peerN, total: listedN + otcN } };
}

// 完整性閘門：上市、上櫃各自都要有貢獻（CLAUDE.md「總數 > 0 不是完整性條件」）
export const INDUSTRY_MIN_PER_MARKET = 300;
export function isIndustryMapComplete(counts) {
  return (counts?.listed || 0) >= INDUSTRY_MIN_PER_MARKET && (counts?.otc || 0) >= INDUSTRY_MIN_PER_MARKET;
}

// 快取狀態 { date, map, listed, complete, nextTryMs, ... }：完整的表當日有效；殘缺的表在冷卻（nextTryMs）內有效，之後重抓。
export function isIndustryCacheFresh(cache, { today, now }) {
  if (!cache?.map) return false;
  return (cache.complete && cache.date === today) || now < (cache.nextTryMs || 0);
}

// 抓完一輪後的下一個快取狀態（純函式）。stale-if-error：殘缺的新表不覆蓋較完整的舊表。
export function nextIndustryCache(prev, { map, listed, counts }, { today, now, retryMs }) {
  const complete = isIndustryMapComplete(counts);
  const better = complete || !prev?.map || (!prev.complete && counts.total >= Object.keys(prev.map).length);
  const next = better
    ? { ...prev, date: today, map, listed, complete, nextTryMs: complete ? 0 : now + retryMs }
    : { ...prev, nextTryMs: now + retryMs };
  return { next, complete, better };
}

/**
 * 健康狀態（純函式）：寫進 system/daemonHealth.industryMap（每小時）並進 daemon log。
 *   兩市覆蓋數分開列（listedN／otcN），某一市場整批沒有產業別要看得見（2026-10-03 前上櫃全缺至少 2 個月，log 從沒出聲）。
 *   欄位全部有值（Firestore 不收 undefined）；日期欄只用已登記的 date／feedDate（scripts/check-field-conventions.mjs）。
 *   date＝目前在用的表是哪天載入的（殘缺時沿用舊表會落後今天）；feedDate＝上櫃來源自報的出表日期。
 */
export function industryMapHealth({
  counts, complete, usingIso = null, stale = false, today = null,
  listedSrc = null, otcSrc = null, feedIso = null, mirrorAgeDays = null, staleDays = 10,
}) {
  const problems = [];
  const listedN = counts?.listed || 0, otcN = counts?.otc || 0;
  if (listedN < INDUSTRY_MIN_PER_MARKET) problems.push(`上市只有 ${listedN} 檔（<${INDUSTRY_MIN_PER_MARKET}）`);
  if (otcN < INDUSTRY_MIN_PER_MARKET) problems.push(`上櫃只有 ${otcN} 檔（<${INDUSTRY_MIN_PER_MARKET}）——官方鏡像 tpex_oa_mopsfin_t187ap03_O 與打包備援都不可用`);
  if (otcSrc === 'bundled') problems.push(`官方鏡像 tpex_oa_mopsfin_t187ap03_O 讀不到，上櫃改用 repo 內打包快照（出表 ${feedIso || '未知'}），新上櫃股會缺產業別`);
  else if (otcSrc === 'mirror' && mirrorAgeDays != null && mirrorAgeDays > staleDays) problems.push(`上櫃官方鏡像已 ${mirrorAgeDays} 天未更新，新上櫃股會缺產業別`);
  if (listedSrc && listedSrc !== 'openapi') problems.push(`上市 openapi t187ap03_L 取不到，改用${listedSrc === 'mirror' ? '官方鏡像' : ' peerComps 後備'}`);
  if (stale) problems.push(`本次載入的表殘缺，沿用 ${usingIso || '上一份'} 較完整的舊表`);
  return {
    date: usingIso || today || null,
    complete: !!complete, ok: !!complete && problems.length === 0, stale: !!stale,
    listedN, otcN, peerN: counts?.peer || 0, totalN: counts?.total || 0,
    listedSrc: listedSrc || null, otcSrc: otcSrc || null,
    feedDate: feedIso || null, mirrorAgeDays: mirrorAgeDays ?? null,
    problems,
  };
}
