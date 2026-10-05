// ─────────────────────────────────────────────────────────────────────────────
// 盤中戰情 v2：B2 即時異動流／C1 族群資金／C2 漲停順序流 的純函式（唯一實作；伺服器 build-feeds.ts 與前端共用）
//
// 輸入一律是 daemon 已寫好的 Firestore 文件內容（只讀；這裡不碰網路、不碰 Firestore），輸出畫面要的 payload。
// 資料來源與欄位（2026-10-05 對 scripts/ai-daemon.mjs 寫入端逐一核對）：
//   volSurge/latest          { updatedAt, date, items:[{code,name,market,price,chg,surgeLots,volX,rateX,dir}] }（前 40，每輪覆寫）
//   volSurgeArchive/{日期}    { date, updatedAt, itemsJson:{code:{…item, at}} }（每檔當日最大一次）
//   intradayRadar/latest     { updatedAt, date, strategies:{k:{name,…}}, groups:{k:[{code,name,…,strategies,firstSeen}]} }
//   limitUpForecast/live     { updatedAt, mode, flow:[{code,name,time:'HH:MM',ind}], flowDate, bList:[{code,luCnt5,…}] }
//                            flow＝當日「首次觸及漲停」時間序（daemon 每輪記；要求今日最高真的到過漲停價；不追蹤開板）
//   newsVerdict/latest       AI 讀完內文的判別——B2 新聞事件由 warroom-news.mjs 產生（這裡只轉出 newsTimeTag）
//   mopsNews/latest          { date, updatedAt, items:[{key,code,name,subject,at}] }（官方重大訊息索引，未判別）
//   limitQueue/latest        { updatedAt, date, inWindow, windowEnd:'09:15', n, items:[{code,name,queueLots,limitPrice,chg}] }（搶漲停排隊）
//   marketWind/latest        { updatedAt, dataDate, marketOpen, themes:[{key,name,wChg,medChg,valueShare,strong,members,leaders}], narrative:{text,at}|null }
//   themeMap/seed、custom     { chains:[{key,name,segs:[{codes:[…]}]}] }（custom 同 key 覆蓋 seed，與 daemon ensureThemeMap 同規則）
// 沒有對應文件的事件類型（首觸跌停、新增處置）不產生、不捏造。
// 單元測試：node --test scripts/lib/warroom-feeds.test.mjs
// ─────────────────────────────────────────────────────────────────────────────

const TPE_OFFSET_MS = 8 * 3_600_000;
const MIN_MS = 60_000;
const CODE_RE = /^\d{4,6}$/;
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM_RE = /^(\d{1,2}):(\d{2})$/;
const MINUS = '−';

/** B2 伺服器端固定回傳的事件數上限（所有人同一份、不帶 since，前端去重累積） */
export const FEED_EVENT_CAP = 40;
/** 同檔同類合併視窗 */
export const FEED_MERGE_WINDOW_MS = 10 * MIN_MS;
/** 雷達「新進」：上榜分鐘數 ≤3 */
export const CONSENSUS_NEW_MS = 3 * MIN_MS;
/** C2 族群成形門檻：同族群第 3 家 */
export const FORMED_AT = 3;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const validCode = (v) => {
  const s = typeof v === 'number' ? String(v) : str(v);
  return CODE_RE.test(s) ? s : null;
};

/** '+1.80%'／'−0.82%'／'0.00%'；非數字回 null */
export function fmtPctText(n, digits = 2) {
  if (!isNum(n)) return null;
  const s = n > 0 ? '+' : n < 0 ? MINUS : '';
  return `${s}${Math.abs(n).toFixed(digits)}%`;
}

/** 'YYYY-MM-DD' 或 'YYYYMMDD' → 'YYYY-MM-DD'；認不得回 null */
export function normYmd(v) {
  const s = str(v);
  if (YMD_RE.test(s)) return s;
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** 台北日期 ymd 的 hh:mm → epoch ms；格式不符回 null */
export function taipeiMsOf(ymd, hhmm) {
  const d = YMD_RE.exec(normYmd(ymd) ?? '');
  const t = HHMM_RE.exec(str(hhmm));
  if (!d || !t) return null;
  const h = +t[1], m = +t[2];
  if (h > 23 || m > 59) return null;
  return Date.UTC(+d[1], +d[2] - 1, +d[3], h, m) - TPE_OFFSET_MS;
}

/** 安全解析 JSON 字串欄位（daemon 以 xxxJson 存大物件）；壞掉回 null */
export function parseJsonField(v) {
  if (isObj(v)) return v;
  if (typeof v !== 'string' || !v) return null;
  try {
    const o = JSON.parse(v);
    return isObj(o) ? o : null;
  } catch {
    return null;
  }
}

/** 同一份文件物件的大型 JSON 欄位只解析一次（伺服器端 reader 在 TTL 內回同一個物件；爆量歸檔約 200KB） */
const parsedCache = new WeakMap();
function parseDocField(doc, field) {
  if (!isObj(doc)) return null;
  let m = parsedCache.get(doc);
  if (!m) { m = new Map(); parsedCache.set(doc, m); }
  if (!m.has(field)) m.set(field, parseJsonField(doc[field]));
  return m.get(field);
}

const lots = (n) => Math.round(n).toLocaleString('zh-TW');

// ── 題材對照（themeMap）────────────────────────────────────────────────────

/**
 * themeMap/seed＋custom → 題材索引。custom 以 key 覆蓋 seed（保留 seed 的順序；custom 新 key 接在後面）——與 daemon ensureThemeMap 同規則。
 * @returns {{ themes: {key:string,name:string,codes:string[]}[], byCode: Record<string,string[]> }}
 */
export function buildThemeIndex(seedChains, customChains) {
  const byKey = new Map();
  const add = (list, override) => {
    if (!Array.isArray(list)) return;
    for (const c of list) {
      const key = str(c?.key);
      if (!key || !Array.isArray(c?.segs)) continue;
      if (!override && byKey.has(key)) continue;
      const codes = [];
      for (const s of c.segs) for (const raw of (Array.isArray(s?.codes) ? s.codes : [])) {
        const code = validCode(raw);
        if (code && !codes.includes(code)) codes.push(code);
      }
      byKey.set(key, { key, name: str(c.name) || key, codes });
    }
  };
  add(seedChains, false);
  add(customChains, true);
  const themes = [...byKey.values()];
  const byCode = {};
  for (const t of themes) for (const code of t.codes) (byCode[code] ||= []).push(t.key);
  return { themes, byCode };
}

// ── C1 族群資金 ─────────────────────────────────────────────────────────────

/** 指令句字樣（站上規範：只描述事實，不寫「勿追」「建議」這類指令） */
const INSTRUCTION_RE = /勿|避免|建議|宜|留意|注意|謹慎|小心|追高|追價|操作|可考慮|伺機|布局|佈局|減碼|加碼|停損|停利|觀望|切忌|不妨|應(?:該|避|留|注|減|加|保|觀)/;
const SENTENCE_MAX = 80;

const MIN_CLAUSE = 6;
const clip = (s) => (s.length > SENTENCE_MAX ? `${s.slice(0, SENTENCE_MAX - 1)}…` : s);

/**
 * 從 AI 敘事取第一句「不含指令字樣」的事實（敘事只依新聞標題產生，只能展示、不進評分）；
 * 整句含指令時，保留指令子句之前的事實子句（例：「資金集中權值，操作上建議…」→「資金集中權值。」）；沒有合格內容回 null。
 */
export function pickFactSentence(text) {
  const s = str(text);
  if (!s) return null;
  // 不用 lookbehind：這個檔也會打進前端，舊版 iOS Safari（<16.4）遇到 lookbehind 整個模組解析失敗
  const parts = (s.match(/[^。！？!?；;]+[。！？!?；;]?/g) ?? []).map((x) => x.trim()).filter(Boolean);
  for (const p of parts) {
    if (!INSTRUCTION_RE.test(p)) return clip(p.replace(/[；;]$/, '。'));
    const lead = [];
    for (const c of p.split(/[，,、]/)) {
      if (INSTRUCTION_RE.test(c)) break;
      lead.push(c.trim());
    }
    const fact = lead.join('，').replace(/[。！？!?；;]$/, '');
    if (fact.length >= MIN_CLAUSE) return clip(`${fact}。`);
  }
  return null;
}

/** 官方公告標題常帶換行留下的空白（「達公 布注意」）：中文字之間的空白拿掉 */
export function tidySubject(s) {
  return str(s).replace(/([㐀-鿿，、（）()])\s+(?=[㐀-鿿，、（）()])/g, '$1').replace(/\s{2,}/g, ' ');
}

/**
 * marketWind themes → C1 列（未排序；排序與「我的族群置頂」在前端依使用者持股做）。
 * @param {object|null} windDoc marketWind/latest
 * @param {{themes:{key,name,codes}[]}|null} themeIndex
 * @param {Set<string>|null} touchedCodes 今日觸及漲停的代號（flow；與 wind 同一資料日才給，否則 null＝不顯示家數）
 */
export function buildSectorRows(windDoc, themeIndex, touchedCodes) {
  const themes = Array.isArray(windDoc?.themes) ? windDoc.themes : [];
  const byKey = new Map((themeIndex?.themes ?? []).map((t) => [t.key, t]));
  const rows = [];
  for (const t of themes) {
    const key = str(t?.key);
    const name = str(t?.name);
    if (!key || !name) continue;
    const mapped = byKey.get(key);
    const leaders = Array.isArray(t.leaders) ? t.leaders.map((l) => validCode(l?.code)).filter(Boolean) : [];
    const codes = mapped ? mapped.codes : leaders;
    rows.push({
      key, name,
      wChg: isNum(t.wChg) ? t.wChg : null,
      medChg: isNum(t.medChg) ? t.medChg : null,
      valueShare: isNum(t.valueShare) ? t.valueShare : null,
      strong: isNum(t.strong) ? t.strong : null,
      members: isNum(t.members) ? t.members : null,
      touched: touchedCodes ? codes.filter((c) => touchedCodes.has(c)).length : null,
      codes,
    });
  }
  return rows;
}

/** 列的漲跌口徑：成交值加權（wChg）優先，舊文件沒有才退回中位數 */
export const sectorChgOf = (r) => (isNum(r?.wChg) ? r.wChg : isNum(r?.medChg) ? r.medChg : null);

/** 沒有 AI 摘要時的事實句：「資金流入前列：A、B；流出前列：C」 */
export function flowSummaryOf(rows) {
  const withChg = rows.filter((r) => isNum(sectorChgOf(r)));
  const ins = withChg.filter((r) => sectorChgOf(r) > 0).sort((a, b) => sectorChgOf(b) - sectorChgOf(a)).slice(0, 2).map((r) => r.name);
  const outs = withChg.filter((r) => sectorChgOf(r) < 0).sort((a, b) => sectorChgOf(a) - sectorChgOf(b)).slice(0, 2).map((r) => r.name);
  const parts = [];
  if (ins.length) parts.push(`資金流入前列：${ins.join('、')}`);
  if (outs.length) parts.push(`流出前列：${outs.join('、')}`);
  return parts.length ? parts.join('；') : null;
}

/**
 * C1 頂列摘要：AI 敘事的第一句事實（附產出時間），沒有就用確定性的流入／流出摘要。
 * @returns {{ text: string, asOf: number|null, ai: boolean } | null}
 */
export function sectorSummary(windDoc, rows) {
  const n = windDoc?.narrative;
  const atMs = isNum(n?.at) ? n.at : null;
  const fact = pickFactSentence(n?.text);
  if (fact) return { text: fact, asOf: atMs, ai: true };
  const flow = flowSummaryOf(rows);
  return flow ? { text: flow, asOf: null, ai: false } : null;
}

/** 前端排序：持股族群置頂（依漲跌），其餘依漲跌由高到低；名額不足時保留最弱 2 列，讓「流出」也看得到 */
export function orderSectorRows(rows, mineCodes, limit) {
  const mineSet = mineCodes instanceof Set ? mineCodes : new Set(mineCodes ?? []);
  const isMine = (r) => r.codes.some((c) => mineSet.has(c));
  const byChg = (a, b) => (sectorChgOf(b) ?? -Infinity) - (sectorChgOf(a) ?? -Infinity);
  const mine = rows.filter(isMine).sort(byChg).map((r) => ({ ...r, mine: true }));
  const rest = rows.filter((r) => !isMine(r)).sort(byChg).map((r) => ({ ...r, mine: false }));
  if (limit == null || mine.length + rest.length <= limit) return [...mine, ...rest];
  if (mine.length >= limit) return mine.slice(0, limit);
  const slots = limit - mine.length;
  // 名額 ≥4 時，固定留最後 2 格給最弱（流出）的族群，否則雙向橫條只剩流入
  const keepTail = slots >= 4 ? rest.filter((r) => (sectorChgOf(r) ?? 0) < 0).slice(-2) : [];
  const head = rest.filter((r) => !keepTail.includes(r)).slice(0, slots - keepTail.length);
  return [...mine, ...head, ...keepTail];
}

// ── C2 漲停順序流 ───────────────────────────────────────────────────────────

/**
 * limitUpForecast/live.flow → 時間序（舊到新）。族群優先用題材對照（themeMap，依 marketWind 分數排序挑主題材），
 * 沒有對照的退回官方產業別（ind；只標名稱，不數「族群成形」——官方產業類過粗）。
 * boards：bList.luCnt5（近 5 日漲停次數，含今日）＝1 寫「首板」，≥2 寫「5日N板」（不是連板數，不冒充）；不在 bList 的不寫。
 */
export function buildLimitFlow(luDoc, themeIndex, themeOrderKeys) {
  const flowDate = normYmd(luDoc?.flowDate);
  const raw = Array.isArray(luDoc?.flow) ? luDoc.flow : [];
  const boardsOf = new Map();
  for (const b of (Array.isArray(luDoc?.bList) ? luDoc.bList : [])) {
    const code = validCode(b?.code);
    if (code && isNum(b.luCnt5) && b.luCnt5 >= 1) boardsOf.set(code, b.luCnt5 === 1 ? '首板' : `5日${b.luCnt5}板`);
  }
  const order = new Map((themeOrderKeys ?? []).map((k, i) => [k, i]));
  const themeName = new Map((themeIndex?.themes ?? []).map((t) => [t.key, t.name]));
  const items = [];
  const seen = new Set();
  raw.forEach((f, i) => {
    const code = validCode(f?.code);
    const time = str(f?.time);
    if (!code || !HHMM_RE.test(time) || seen.has(code)) return;
    seen.add(code);
    items.push({ i, code, name: str(f.name) || code, time, ind: str(f.ind) || null });
  });
  items.sort((a, b) => a.time.localeCompare(b.time) || a.i - b.i);

  const counts = new Map();
  const rows = items.map((it, idx) => {
    const keys = themeIndex?.byCode?.[it.code] ?? [];
    let primary = null;
    for (const k of keys) {
      if (primary == null) { primary = k; continue; }
      const a = order.get(k) ?? Infinity, b = order.get(primary) ?? Infinity;
      if (a < b) primary = k;
    }
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
    const groupRank = primary ? counts.get(primary) : null;
    return {
      code: it.code, name: it.name, time: it.time,
      at: flowDate ? taipeiMsOf(flowDate, it.time) : null,
      rank: idx + 1,
      group: primary ? themeName.get(primary) ?? primary : it.ind,
      groupKey: primary,
      groupKind: primary ? 'theme' : it.ind ? 'industry' : null,
      groupRank,
      formed: groupRank === FORMED_AT,
      inFormedGroup: false,
      boards: boardsOf.get(it.code) ?? null,
    };
  });
  for (const r of rows) r.inFormedGroup = r.groupKey != null && (counts.get(r.groupKey) ?? 0) >= FORMED_AT;
  return { flowDate, rows, total: rows.length };
}

// ── B2 事件 ─────────────────────────────────────────────────────────────────

const evId = (kind, code, at) => `s:${kind}:${code}:${at}`;

/** 爆量急拉／急殺：本輪前 perCycle 檔（daemon 已依量增排序）＋當日歸檔量增最大的 archiveTop 檔。只收今日文件。 */
export function surgeEvents(latestDoc, archiveDoc, ymd, { perCycle = 5, archiveTop = 8 } = {}) {
  const out = [];
  const mk = (it, at) => {
    const code = validCode(it?.code);
    if (!code || !isNum(at) || !isNum(it.surgeLots) || it.surgeLots <= 0) return null;
    const up = it.dir ? it.dir !== 'down' : !(isNum(it.chg) && it.chg < 0);
    const parts = [`量增 ${lots(it.surgeLots)} 張`];
    if (isNum(it.rateX) && it.rateX > 0) parts.push(`每分量 ×${it.rateX.toFixed(1)}`);
    const pct = fmtPctText(it.chg);
    if (pct) parts.push(pct);
    const kind = up ? 'surgeUp' : 'surgeDown';
    return { id: evId(kind, code, at), at, kind, code, name: str(it.name) || code, text: parts.join('·'), side: up ? 'long' : 'short' };
  };
  if (latestDoc && normYmd(latestDoc.date) === ymd && isNum(latestDoc.updatedAt)) {
    for (const it of (Array.isArray(latestDoc.items) ? latestDoc.items : []).slice(0, perCycle)) {
      const e = mk(it, latestDoc.updatedAt);
      if (e) out.push(e);
    }
  }
  const acc = archiveDoc && normYmd(archiveDoc.date) === ymd ? parseDocField(archiveDoc, 'itemsJson') : null;
  if (acc) {
    const list = Object.values(acc).filter((x) => isObj(x) && isNum(x.surgeLots) && isNum(x.at))
      .sort((a, b) => b.surgeLots - a.surgeLots).slice(0, archiveTop);
    for (const it of list) {
      const e = mk(it, it.at);
      if (e) out.push(e);
    }
  }
  return out;
}

/** 首觸漲停（C2 的列 → B2 事件）。「第 N 家」＝當日觸及漲停的先後序。 */
export function limitTouchEvents(flow, ymd) {
  if (!flow || flow.flowDate !== ymd) return [];
  const out = [];
  for (const r of flow.rows) {
    if (!isNum(r.at)) continue;
    let text = `第 ${r.rank} 家`;
    if (r.groupKind === 'theme' && r.groupRank != null) text += `·${r.group} 第 ${r.groupRank} 家${r.formed ? '·族群成形' : ''}`;
    else if (r.group) text += `·${r.group}`;
    out.push({ id: evId('limitTouch', r.code, r.at), at: r.at, kind: 'limitTouch', code: r.code, name: r.name, text, side: 'long' });
  }
  return out;
}

/**
 * 雷達新進共識：上榜 ≤3 分鐘且命中 ≥2 個策略榜（與既有雷達頁 ⭐ 同口徑：以出現在幾個策略榜計），事件時間＝首次上榜。只收今日文件。
 */
export function consensusEvents(radarDoc, ymd, { newMs = CONSENSUS_NEW_MS } = {}) {
  if (!radarDoc || normYmd(radarDoc.date) !== ymd || !isNum(radarDoc.updatedAt) || !isObj(radarDoc.groups)) return [];
  const meta = isObj(radarDoc.strategies) ? radarDoc.strategies : {};
  const hits = new Map();
  for (const [k, list] of Object.entries(radarDoc.groups)) {
    if (!Array.isArray(list)) continue;
    for (const it of list) {
      const code = validCode(it?.code);
      if (!code) continue;
      const cur = hits.get(code) ?? { it, keys: [] };
      if (!cur.keys.includes(k)) cur.keys.push(k);
      hits.set(code, cur);
    }
  }
  const out = [];
  for (const [code, { it, keys }] of hits) {
    if (keys.length < 2 || !isNum(it.firstSeen)) continue;
    if (radarDoc.updatedAt - it.firstSeen > newMs || it.firstSeen > radarDoc.updatedAt) continue;
    const names = keys.map((k) => str(meta[k]?.name) || k);
    out.push({ id: evId('consensus', code, it.firstSeen), at: it.firstSeen, kind: 'consensus', code, name: str(it.name) || code, text: `新進 ★（${names.join('＋')}）`, side: 'long' });
  }
  return out;
}

/**
 * 搶漲停排隊（limitQueue/latest；daemon computeLimitQueue：買一貼漲停×賣一全空×當日最高尚未觸及漲停）。
 * 只在 daemon 自報的提醒窗內（inWindow＝交易日 09:00–09:15）且文件是今日時產生——取代專注模式下不掛載的全頁排隊警示。
 * ⚠ 這是「排隊」不是「已漲停」：文案一律寫「尚未成交上去」。
 * 文件沒有每檔首次出現的時間 ⇒ id 以「代號＋日期」固定（`s:queue:${code}:${ymd}`），事件時間＝這一輪的 updatedAt：
 *   前端以 id 去重累積，同一檔當日只留第一次看到的那一則（張數為當時的委買張數）。
 */
export function queueEvents(queueDoc, ymd, { cap = 8 } = {}) {
  if (!isObj(queueDoc) || queueDoc.inWindow !== true || normYmd(queueDoc.date) !== ymd || !isNum(queueDoc.updatedAt)) return [];
  const windowEnd = HHMM_RE.test(str(queueDoc.windowEnd)) ? str(queueDoc.windowEnd) : null;
  const items = (Array.isArray(queueDoc.items) ? queueDoc.items : [])
    .map((x) => ({ code: validCode(x?.code), name: str(x?.name), lots: isNum(x?.queueLots) && x.queueLots > 0 ? x.queueLots : null }))
    .filter((x) => x.code)
    .sort((a, b) => (b.lots ?? 0) - (a.lots ?? 0))
    .slice(0, cap);
  return items.map((x) => ({
    id: evId('queue', x.code, ymd),
    at: queueDoc.updatedAt,
    kind: 'queue',
    code: x.code,
    name: x.name || x.code,
    text: `漲停排隊${x.lots != null ? ` ${lots(x.lots)} 張` : ''}·尚未成交上去${windowEnd ? `（至 ${windowEnd}）` : ''}`,
    side: 'long',
  }));
}

// 新聞判別（媒體 M）的 B2 事件改由 warroom-news.mjs 產生（b2MarketNewsEvents／mineNewsEvents：權重沿用
// rankMediaVerdicts、只列今日適用的判別、規範 §1 程式強制）。時間標記與它同一支，這裡轉出供既有呼叫端使用。
export { newsTimeTag } from './warroom-news.mjs';

/**
 * 重訊（官方 O）：今日 mopsNews 索引。events 只收「今日有動靜的代號」（漲停流、雷達、爆量、新聞判別）的最新 cap 則，
 * 避免整批營收公告淹沒異動流；index：每檔最新一則 [at, 標題前段]（前端補「我的持股」的重訊）。
 */
export function mopsEvents(mopsDoc, ymd, activeCodes, { cap = 10, indexCap = 300, subjectMax = 18 } = {}) {
  const index = {};
  if (!mopsDoc || normYmd(mopsDoc.date) !== ymd || !Array.isArray(mopsDoc.items)) return { events: [], index };
  const items = mopsDoc.items
    .map((x) => ({ code: validCode(x?.code), name: str(x?.name), subject: tidySubject(x?.subject), at: x?.at }))
    .filter((x) => x.code && x.subject && isNum(x.at))
    .sort((a, b) => b.at - a.at);
  const active = activeCodes instanceof Set ? activeCodes : new Set(activeCodes ?? []);
  const events = [];
  let n = 0;
  for (const x of items) {
    if (!index[x.code] && n < indexCap) {
      index[x.code] = [x.at, x.subject.length > subjectMax ? `${x.subject.slice(0, subjectMax)}…` : x.subject];
      n++;
    }
    if (events.length < cap && active.has(x.code)) {
      events.push({ id: evId('mops', x.code, x.at), at: x.at, kind: 'mops', code: x.code, name: x.name || x.code, text: x.subject.length > 60 ? `${x.subject.slice(0, 59)}…` : x.subject, source: 'O' });
    }
  }
  return { events, index };
}

/** 合併多個事件清單：同 id 去重、新到舊、最多 cap 則 */
export function mergeServerEvents(lists, cap = FEED_EVENT_CAP) {
  const byId = new Map();
  for (const list of lists) for (const e of (list ?? [])) if (e && !byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)).slice(0, cap);
}

/** 補名稱：新聞判別文件沒有名稱，用其他來源（漲停流、雷達、爆量、重訊）已知的名稱補上 */
export function fillNames(events, names) {
  return events.map((e) => (e.name === e.code && names.has(e.code) ? { ...e, name: names.get(e.code) } : e));
}

// ── 前端：同檔同類 10 分鐘合併 ─────────────────────────────────────────────

/**
 * events 必須新到舊。同 code＋同 kind、與該組最新一則相距 ≤ windowMs 的併成一組（顯示最新一則＋「（×n）」）；沒有代號的不併。
 * @returns {{ head: object, count: number }[]}
 */
export function mergeFeedGroups(events, windowMs = FEED_MERGE_WINDOW_MS) {
  const out = [];
  const open = new Map();
  for (const e of events) {
    if (!e || !isNum(e.at)) continue;
    const key = e.code ? `${e.kind}|${e.code}` : null;
    const g = key ? open.get(key) : null;
    if (g && g.head.at - e.at <= windowMs) {
      g.count += 1;
      continue;
    }
    const ng = { head: e, count: 1 };
    out.push(ng);
    if (key) open.set(key, ng);
  }
  return out;
}

/** 依「我的」優先排序：最近 pinMs 內的我的警示（local）最多 pinMax 則置頂，其餘新到舊 */
export function pinMineFirst(groups, nowMs, { pinMs = 15 * MIN_MS, pinMax = 3, isPinnable } = {}) {
  const can = isPinnable ?? ((g) => !!g.head.mine);
  const pinned = [];
  const rest = [];
  for (const g of groups) {
    if (pinned.length < pinMax && can(g) && nowMs - g.head.at <= pinMs) pinned.push(g);
    else rest.push(g);
  }
  return [...pinned, ...rest];
}
