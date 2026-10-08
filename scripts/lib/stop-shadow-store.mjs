// ─────────────────────────────────────────────────────────────────────────────
// AI 停損規範 stop-v1.1·影子試算（S3）的 Firestore 讀寫（stop-shadow-runner.mjs 注入用；測試以記憶體版取代）。
// 寫入只有四處，全部是影子期新文件（不碰 alerts、不推播）：
//   stopBooks/{uid}（整份覆寫；daemon 單一寫入）、stopBooks/{uid}/shadowDays/{資料日}（影子紀錄：若切換會送什麼、舊制實際送什麼、對照）、
//   stopEventShadow/{資料日}（全市場事件收緊命中與漏網紀錄）、stopSpecAudit/{資料日}（只放計數）。
// 讀取：持股、chipArchive（只取 date／closeJson 等欄位）、newsVerdict（latest 先只取 updatedAt，變了才讀整份）、dividendCalendar/latest。
// 上游請求 0（全部讀 Firestore）。非投資建議。
// newsVerdict 讀回後一律轉成明文欄位（plainNewsVerdictDoc；2026-10-08 起大文件改存壓縮欄位 verdictGz／seenGz）——
//   下游 ruleBearEvents（ai-stoploss-event）／newsBoardFromDoc（warroom-news）是前後端共用模組，只認明文 verdictJson。
// ─────────────────────────────────────────────────────────────────────────────
import { plainNewsVerdictDoc } from './news-verdict-codec.mjs';

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
/** Firestore 拒收 undefined：物件鍵刪除、陣列元素轉 null */
function clean(v) {
  if (Array.isArray(v)) return v.map(x => (x === undefined ? null : clean(x)));
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out = {};
    for (const k of Object.keys(v)) if (v[k] !== undefined) out[k] = clean(v[k]);
    return out;
  }
  return v;
}

export const BOOK_COLL = 'stopBooks';
export const DAY_SUB = 'shadowDays';
export const EVENT_COLL = 'stopEventShadow';
export const AUDIT_COLL = 'stopSpecAudit';
const DAY_ARRAYS = ['wouldPush', 'wouldDocOnly', 'eventRecords', 'legacySent'];

/** 計數物件的葉子 → FieldValue.increment（巢狀 map 走 set merge） */
function incrementsOf(counts, FieldValue) {
  const out = {};
  for (const [k, v] of Object.entries(isObj(counts) ? counts : {})) {
    if (isObj(v)) { const sub = incrementsOf(v, FieldValue); if (Object.keys(sub).length) out[k] = sub; }
    else if (typeof v === 'number' && Number.isFinite(v) && v !== 0) out[k] = FieldValue.increment(v);
  }
  return out;
}

export function createFirestoreStopStore({ db, FieldValue, FieldPath }) {
  const bookRef = uid => db.collection(BOOK_COLL).doc(uid);
  const dayRef = (uid, ymd) => bookRef(uid).collection(DAY_SUB).doc(ymd);
  /** dayLog：{ ymd, at, arrays:{ wouldPush?, wouldDocOnly?, eventRecords?, legacySent? }, fields:{ wouldDigest?, compare?, … } } */
  const dayPayload = log => {
    const out = { date: log.ymd, updatedAt: log.at };
    for (const k of DAY_ARRAYS) {
      const items = (log.arrays?.[k] ?? []).filter(isObj).map(clean);
      if (items.length) out[k] = FieldValue.arrayUnion(...items);
    }
    for (const [k, v] of Object.entries(isObj(log.fields) ? log.fields : {})) out[k] = clean(v);
    return out;
  };
  const byId = (coll, id, fields) => db.collection(coll).where(FieldPath.documentId(), '==', id).select(...fields).get()
    .then(q => (q.empty ? null : q.docs[0].data()));
  return {
    async getBook(uid) { const s = await bookRef(uid).get(); return s.exists ? s.data() : null; },
    /** 停損簿整份覆寫（影子期只有 daemon 寫；不 merge 以免殘留舊欄位）＋同一批次附加當日影子紀錄 */
    async saveBook(uid, encodedBook, dayLog = null) {
      const b = db.batch();
      b.set(bookRef(uid), encodedBook);
      if (dayLog) b.set(dayRef(uid, dayLog.ymd), dayPayload(dayLog), { merge: true });
      await b.commit();
    },
    async appendDayLog(uid, dayLog) { await dayRef(uid, dayLog.ymd).set(dayPayload(dayLog), { merge: true }); },
    async getDayLog(uid, ymd) { const s = await dayRef(uid, ymd).get(); return s.exists ? s.data() : null; },
    async getHoldings(uid) {
      const s = await db.collection('users').doc(uid).collection('data').doc('holdings').get();
      return s.exists ? (s.data().holdings || []) : [];
    },
    /** chipArchive 截至 toYmd（含）的最近 n 份，只取 date 與 closeJson */
    async getArchiveWindow(toYmd, n) {
      const q = await db.collection('chipArchive').where('date', '<=', toYmd).orderBy('date', 'desc').limit(n).select('date', 'closeJson').get();
      return q.docs.map(d => d.data());
    },
    /** chipArchive [fromYmd, beforeYmd) 分頁讀（每頁 pageSize 份、最多 max 份），每頁交給 onPage 後即釋放 */
    async scanArchiveRange(fromYmd, beforeYmd, onPage, { pageSize = 100, max = 800 } = {}) {
      let last = null, n = 0;
      for (;;) {
        let q = db.collection('chipArchive').where('date', '>=', fromYmd).where('date', '<', beforeYmd).orderBy('date').limit(pageSize).select('date', 'closeJson');
        if (last) q = q.startAfter(last);
        const snap = await q.get();
        if (snap.empty) break;
        onPage(snap.docs.map(d => d.data()));
        n += snap.size;
        last = snap.docs[snap.size - 1].get('date');
        if (snap.size < pageSize || n >= max) break;
      }
      return n;
    },
    /** 某日歸檔的收盤與法人欄位（archiveDayStatus 判定到齊＋前一交易日官方收盤） */
    getArchiveDay(ymd) { return byId('chipArchive', ymd, ['date', 'closeJson', 'instJson', 'otcPending', 'gapFixSource']); },
    async getNewsLatestUpdatedAt() { return (await byId('newsVerdict', 'latest', ['updatedAt']))?.updatedAt ?? null; },
    async getNewsLatest() { const s = await db.collection('newsVerdict').doc('latest').get(); return s.exists ? plainNewsVerdictDoc(s.data()) : null; },
    async getNewsDay(ymd) { const s = await db.collection('newsVerdict').doc(ymd).get(); return s.exists ? plainNewsVerdictDoc(s.data()) : null; },
    async getEventShadowRecent(beforeYmd, n) {
      const q = await db.collection(EVENT_COLL).where('date', '<', beforeYmd).orderBy('date', 'desc').limit(n).select('date', 'events').get();
      return q.docs.map(d => d.data());
    },
    async setEventShadow(ymd, data) { await db.collection(EVENT_COLL).doc(ymd).set(clean(data)); },
    async mergeAudit(ymd, data) { await db.collection(AUDIT_COLL).doc(ymd).set(clean(data), { merge: true }); },
    async incrementAudit(ymd, counts, meta = {}) {
      const inc = incrementsOf(counts, FieldValue);
      if (!Object.keys(inc).length) return;
      await db.collection(AUDIT_COLL).doc(ymd).set({ ...clean(meta), ...inc }, { merge: true });
    },
    /** 除權息行事曆（daemon computeDividendCalendar 寫；只有上市 4 碼、前 40 筆）中日期＝rocYmd（民國 YYYMMDD）的代號 */
    async getDividendCodesOn(rocYmd) {
      const s = await db.collection('dividendCalendar').doc('latest').get();
      const up = s.exists ? (s.data().upcoming || []) : [];
      return up.filter(x => x && x.date === rocYmd && x.code).map(x => x.code);
    },
  };
}
