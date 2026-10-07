// ─────────────────────────────────────────────────────────────────────────
// 開盤感應器 v2.1：Firestore 寫入（db 由呼叫端注入，測試用假 db）
//   規格 design-v2.1 §8。所有快照欄位都在交易內「讀→不存在才寫」；決策由 open-sensor-check.mjs 的 decide* 純函式做。
//   ⚠ 10:05 不寫 orderFlowArchive/{date}（會建出空殼，15:25 的 backfill-orderflow 會把該日當已存在而跳過）；
//     indexMarks 只在盤後、文件已存在且沒有 indexMarks 時才複製。
//   ⚠ 影子：這裡不寫 aiMessages、不寫 alerts、不推播。
// ─────────────────────────────────────────────────────────────────────────
import { dropUndefined } from './firestore-clean.mjs';
import { statsAfterFinal, rhoMetaAfter, thresholdMetaOf } from './open-sensor-check.mjs';

const isAlreadyExists = e => e?.code === 6 || /ALREADY_EXISTS|already exists/i.test(String(e?.message || ''));

export function createOpenSensorStore(db) {
  const dayRef = date => db.collection('openSensor').doc(date);

  /** 讀當日文件（重啟時接回 cur／trail／已寫的檢查點） */
  async function readDay(date) {
    const s = await dayRef(date).get();
    return s.exists ? s.data() : null;
  }

  /** 交易：decide(文件現況|null) → patch|null；有 patch 才 merge 寫入 */
  function txDay(date, decide) {
    return db.runTransaction(async tx => {
      const ref = dayRef(date);
      const snap = await tx.get(ref);
      const cur = snap.exists ? snap.data() : null;
      const patch = decide(cur);
      if (!patch) return { wrote: false, doc: cur };
      tx.set(ref, dropUndefined(patch), { merge: true });
      return { wrote: true, doc: cur, patch };
    });
  }

  /** openSensorUniverse/{date}：create() 寫一次；已存在回 'exists' */
  async function createUniverse(date, doc) {
    try { await db.collection('openSensorUniverse').doc(date).create(dropUndefined(doc)); return 'created'; }
    catch (e) { if (isAlreadyExists(e)) return 'exists'; throw e; }
  }

  /** openSensorStats/outside：定格後計一次（countedDates 冪等） */
  function countOutside(date, cur, now) {
    return db.runTransaction(async tx => {
      const ref = db.collection('openSensorStats').doc('outside');
      const s = await tx.get(ref);
      const next = statsAfterFinal(s.exists ? s.data() : null, date, cur, now);
      if (!next) return false;
      tx.set(ref, dropUndefined(next));
      return true;
    });
  }

  /** orderFlowArchive/{date}.indexMarks：文件已存在（15:25 已建）而且沒有 indexMarks 才寫；不建空殼 */
  function copyIndexMarks(date, indexMarks) {
    return db.runTransaction(async tx => {
      const ref = db.collection('orderFlowArchive').doc(date);
      const s = await tx.get(ref);
      if (!s.exists) return 'noDoc';
      if (s.data()?.indexMarks) return 'exists';
      tx.set(ref, { indexMarks: dropUndefined(indexMarks) }, { merge: true });
      return 'written';
    });
  }

  /** openSensorMeta/threshold：同一 asOf 已寫過就跳過 */
  function writeThreshold(rep, now) {
    return db.runTransaction(async tx => {
      const ref = db.collection('openSensorMeta').doc('threshold');
      const s = await tx.get(ref);
      if (s.exists && s.data()?.asOf === rep.asOf) return false;
      tx.set(ref, dropUndefined(thresholdMetaOf(rep, now)));
      return true;
    });
  }

  /** openSensorMeta/rho：追加當日 ρ 實測（同日不重複） */
  function appendRho(date, rhoRatio, now) {
    return db.runTransaction(async tx => {
      const ref = db.collection('openSensorMeta').doc('rho');
      const s = await tx.get(ref);
      const next = rhoMetaAfter(s.exists ? s.data() : null, date, rhoRatio, now);
      if (!next.added && s.exists) return 0;
      const { added, ...doc } = next;
      tx.set(ref, dropUndefined(doc));
      return added;
    });
  }

  return { readDay, txDay, createUniverse, countOutside, copyIndexMarks, writeThreshold, appendRho };
}
