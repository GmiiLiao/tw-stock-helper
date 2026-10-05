// ─────────────────────────────────────────────────────────────────────────────
// 盤中戰情 v2 · B1「盤中機會榜」共用常數與畫面純函式（前端與伺服器共用·無外部依賴·唯一實作）
//
// 做多＝盤中雷達 intradayRadar/latest 的 8 個策略合併去重（與舊版戰情雷達、picks-scoreboard 的「雷達⭐共識」同口徑：
//   命中＝出現在該策略的 groups 清單裡；命中 ≥2 策略＝★共識）。
// 做空＝伺服器以 fade-patterns 的轉空型態算 A／B 級（見 warroom-b1.mjs）。
// 本檔只放「畫面怎麼呈現」的規則：策略單字圖示、時段預選、額外欄、NEW 3 分鐘、前 3 名金框、新進共識事件的差分。
// 單元測試：node --test scripts/lib/warroom-b1.test.mjs
// ─────────────────────────────────────────────────────────────────────────────

/** daemon computeIntradayRadar 的 8 個策略鍵（scripts/ai-daemon.mjs RADAR_STRATEGIES；合併去重依此序走訪） */
export const RADAR_STRAT_ORDER = Object.freeze(['ignite', 'volSurge', 'openStrong', 'ma5Bounce', 'followThru', 'chipIgnite', 'squeeze', 'breakHigh']);

/** 畫面上的策略順序（預覽頁頁尾：起漲 爆量 新高 開盤強勢 回踩 續強 外資 軋空） */
export const RADAR_STRAT_DISPLAY = Object.freeze(['ignite', 'volSurge', 'breakHigh', 'openStrong', 'ma5Bounce', 'followThru', 'chipIgnite', 'squeeze']);

/** 單字圖示（預覽頁定案：起 爆 高 開 回 續 外 軋） */
export const RADAR_STRAT_GLYPH = Object.freeze({
  ignite: '起', volSurge: '爆', breakHigh: '高', openStrong: '開', ma5Bounce: '回', followThru: '續', chipIgnite: '外', squeeze: '軋',
});

/** 短名（下拉選單、頁尾、事件文案） */
export const RADAR_STRAT_LABEL = Object.freeze({
  ignite: '起漲', volSurge: '爆量', breakHigh: '新高', openStrong: '開盤強勢', ma5Bounce: '回踩', followThru: '續強', chipIgnite: '外資', squeeze: '軋空',
});

/** 全名（滑鼠提示；與 daemon RADAR_STRATEGIES.name 相同） */
export const RADAR_STRAT_NAME = Object.freeze({
  ignite: '起漲偵測', volSurge: '爆量長紅', openStrong: '開盤強勢延續', ma5Bounce: '五日線回踩反彈',
  followThru: '昨強今續', chipIgnite: '外資昨買今動', squeeze: '軋空啟動', breakHigh: '突破新高',
});

/** 轉空型態（fade-patterns FADE_PATTERNS 的 key）→ 單字圖示；漲停打開兩型同字，顯示時去重 */
export const FADE_GLYPH = Object.freeze({ luVwap: '板', luOpen: '板', earlyDeep: '早', spikeVol: '爆', spike: '落' });

export const NEW_WINDOW_MS = 180_000;     // NEW 標記 3 分鐘
export const CONSENSUS_MIN = 2;           // 命中 ≥2 策略＝★共識
export const GOLD_TOP_N = 3;              // 金色左框只給前 3 名共識
export const EARLY_SAMPLE_END = 9 * 60 + 10;   // 09:10 前標「樣本少」（台北當日分鐘）

const TRADING = new Set(['open', 'mid', 'tail', 'auction', 'closing']);
const isNum = v => typeof v === 'number' && Number.isFinite(v);

export function isRadarStrat(k) {
  return typeof k === 'string' && RADAR_STRAT_ORDER.includes(k);
}

/** 命中策略依畫面順序排列（未知鍵丟掉） */
export function sortHits(hits) {
  const set = new Set(Array.isArray(hits) ? hits : []);
  return RADAR_STRAT_DISPLAY.filter(k => set.has(k));
}

/**
 * 榜單要不要顯示：
 *   'pre'     盤前／試撮清空窗／交易日 08:30 前 ⇒ 不顯示昨天的榜（「09:00 開盤後產生」）
 *   'waiting' 盤中但資料日不是今天（09:00 第一份榜單還沒產生、或 daemon 停更）⇒ 不把昨天的榜當今天的
 *   'show'    其餘（盤後、休市日照實顯示，資料章會標 ■ 收盤／◆ 前交易日）
 */
export function b1Phase({ segment, beforeOpen, ymd, dataDate }) {
  if (segment === 'pre' || segment === 'preclear' || beforeOpen) return 'pre';
  if (TRADING.has(segment) && dataDate !== ymd) return 'waiting';
  return 'show';
}

/** 時段預選策略：開盤段預選「開盤強勢」，其餘全部 */
export function defaultStrat(segment) {
  return segment === 'open' ? 'openStrong' : 'all';
}

/** 依時段多一欄：開盤段「缺口」、尾盤段「尾盤位置」 */
export function extraColumn(segment) {
  if (segment === 'open') return 'gap';
  if (segment === 'tail') return 'tp';
  return null;
}

/** 開盤段 09:10 前：樣本少 */
export function isEarlySample(segment, minute) {
  return segment === 'open' && isNum(minute) && minute < EARLY_SAMPLE_END;
}

export function isConsensus(row) {
  return !!row && Array.isArray(row.hits) && row.hits.length >= CONSENSUS_MIN;
}

/** 前 3 名共識（依榜單既有排序）的代號——只有它們有金色左框 */
export function goldCodes(rows) {
  const out = [];
  for (const r of rows || []) {
    if (out.length >= GOLD_TOP_N) break;
    if (isConsensus(r)) out.push(r.code);
  }
  return out;
}

/** 做多篩選：策略（'all' 或單一策略鍵）× ★共識開關；不改原陣列 */
export function filterLong(rows, { strat = 'all', consensusOnly = false } = {}) {
  return (rows || []).filter(r => (strat === 'all' || (Array.isArray(r.hits) && r.hits.includes(strat))) && (!consensusOnly || isConsensus(r)));
}

/** 各策略在目前榜單內的檔數（下拉選單用） */
export function stratCounts(rows) {
  const out = Object.fromEntries(RADAR_STRAT_ORDER.map(k => [k, 0]));
  for (const r of rows || []) for (const k of r.hits || []) if (k in out) out[k] += 1;
  return out;
}

/** NEW：首次上榜 3 分鐘內（firstSeen 晚於 now 也算——前端時鐘每 30 秒才走一格） */
export function isNewRow(firstSeen, now) {
  return isNum(firstSeen) && firstSeen > 0 && isNum(now) && now - firstSeen < NEW_WINDOW_MS;
}

/** 上榜分鐘數（以資料時間計）；缺值回 null */
export function minutesOnBoard(firstSeen, asOf) {
  if (!isNum(firstSeen) || firstSeen <= 0 || !isNum(asOf)) return null;
  return Math.max(0, Math.round((asOf - firstSeen) / 60_000));
}

/** 做空列的型態單字圖示（主型態＋其他命中，去重） */
export function shortGlyphs(row) {
  const out = [];
  for (const k of [row?.pattern, ...(Array.isArray(row?.also) ? row.also : [])]) {
    const g = FADE_GLYPH[k];
    if (g && !out.includes(g)) out.push(g);
  }
  return out;
}

/**
 * 「雷達新進共識」差分。不改傳入的 state，回傳新 state。
 * ⚠ 2026-10-05 起 B2 的「雷達新進 ★共識」只用伺服器 warroom-feeds.mjs consensusEvents（前端另發會重複），本函式與
 *   consensusText 目前沒有呼叫端，保留給日後「前端自判新進」需要時使用；要啟用前先確認不與伺服器事件重複。
 * 規則：同一台北日、同一份資料（asOf）只算一次；當日第一次看到榜單只建立基準不發事件（避免開頁就灌一整批「新進」）；
 *       之後新出現的共識代號才算新進，當日不重複。資料日不是今天（盤前、休市）不算。
 * @returns {{ state: { ymd: string, asOf: number|null, codes: string[] }, fresh: object[] }}
 */
export function diffNewConsensus(state, rows, { ymd, asOf, dataDate }) {
  const empty = { state, fresh: [] };
  if (!ymd || dataDate !== ymd || !isNum(asOf)) return empty;
  const cons = (rows || []).filter(isConsensus);
  if (!state || state.ymd !== ymd) return { state: { ymd, asOf, codes: cons.map(r => r.code) }, fresh: [] };
  if (state.asOf === asOf) return empty;
  const seen = new Set(state.codes);
  const fresh = cons.filter(r => !seen.has(r.code));
  return { state: { ymd, asOf, codes: [...state.codes, ...fresh.map(r => r.code)] }, fresh };
}

/** 新進共識的事件文案（只描述事實）：「3037 欣興 新進 ★（起漲＋爆量）」 */
export function consensusText(row) {
  const labels = sortHits(row.hits).map(k => RADAR_STRAT_LABEL[k]).join('＋');
  return `${row.code}${row.name ? ` ${row.name}` : ''} 新進 ★（${labels}）`;
}
