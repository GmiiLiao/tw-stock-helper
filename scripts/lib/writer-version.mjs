// ─────────────────────────────────────────────────────────────────────────────
// 寫入端版本登記（2026-10-09 WM-SCAN G4-42／G2-39／G2-40；技能 wm-realtime-seed-pipeline、wm-freshness-health-monitoring 週更增補）
//   上游做法：寫入端把「自己是從哪個 commit 部署的」寫進 seed-meta（不是資料本身），讀取端才分得出
//   「寫入端還在跑舊碼」與「資料真的缺」。
//   本站對應：**不碰資料文件**（daemon 很多文件是「代號→資料」的 map，多一個欄位會被當成一檔股票＝修A壞B），
//   改把每個 collection「最後由哪一份程式寫入」彙整進單一文件 system/writerVersions：
//     daemon：{ codeHash, commit, dirty, startedAt, flushedAt, collections: { <頂層 collection>: { codeHash, lastWriteAt } } }
//     scripts：{ <頂層 collection>: { <寫入端>: { commit, dirty, at } } }（每日熱力、分析師團隊、起漲影子等發佈程式）
//   只記頂層 collection 名稱，不記文件路徑（路徑可能含 uid）。
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process';

export const WRITER_DOC = ['system', 'writerVersions'];
const WRITER_PATH = WRITER_DOC.join('/');

/** 文件路徑的頂層 collection（'a/b/c/d' → 'a'）；非字串或空字串回 null。 */
export function collectionOf(path) {
  if (typeof path !== 'string' || !path) return null;
  const top = path.split('/')[0];
  return top || null;
}

/** 純記錄器：record(path, now) 記下頂層 collection 的最後寫入時刻；takeChanges() 取出未 flush 的變更。
 *  codeHash 可傳字串或函式（daemon 的雜湊在開機後非同步算出，flush 時才取值）。 */
export function createWriterRegistry(codeHash) {
  const hashOf = typeof codeHash === 'function' ? codeHash : () => codeHash;
  const lastWrite = new Map();
  let pending = new Set();
  return {
    record(path, now = Date.now()) {
      if (path === WRITER_PATH) return;   // 登記文件本身不登記，否則每次 flush 都產生新變更
      const c = collectionOf(path);
      if (!c) return;
      lastWrite.set(c, now);
      pending.add(c);
    },
    hasChanges: () => pending.size > 0,
    /** 回傳 { <collection>: { codeHash, lastWriteAt } } 並清空待寫集合 */
    takeChanges() {
      const out = {};
      const h = hashOf() ?? null;
      for (const c of pending) out[c] = { codeHash: h, lastWriteAt: lastWrite.get(c) };
      pending = new Set();
      return out;
    },
    /** flush 失敗時把變更放回去，下輪再寫 */
    restore(changes) { for (const c of Object.keys(changes)) pending.add(c); },
  };
}

/**
 * 攔截 firebase-admin 的寫入（DocumentReference.set／update／create、WriteBatch／Transaction 的 set／update／create）
 * 只呼叫 registry.record(ref.path)；參數與回傳值原樣轉交，不改寫入內容。重複安裝不會疊加。
 */
export function installWriteRecorder({ DocumentReference, WriteBatch, Transaction }, registry) {
  const MARK = Symbol.for('twstock.writerRecorder');
  const wrap = (proto, method, refOf) => {
    const orig = proto?.[method];
    if (typeof orig !== 'function' || orig[MARK]) return;
    const patched = function (...args) {
      try { const p = refOf(this, args)?.path; if (p) registry.record(p); } catch { /* 記錄失敗不影響寫入 */ }
      return orig.apply(this, args);
    };
    patched[MARK] = true;
    proto[method] = patched;
  };
  for (const m of ['set', 'update', 'create']) {
    wrap(DocumentReference?.prototype, m, self => self);
    wrap(WriteBatch?.prototype, m, (_self, args) => args[0]);
    wrap(Transaction?.prototype, m, (_self, args) => args[0]);
  }
}

/** git HEAD（短 sha）與指定檔案是否有未 commit 的修改；git 不可用時 commit=null、dirty=null。 */
export function gitWriterStamp(cwd, files = []) {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8', timeout: 10_000 }).trim();
    const st = files.length
      ? execFileSync('git', ['status', '--porcelain', '--', ...files], { cwd, encoding: 'utf8', timeout: 10_000 }).trim()
      : '';
    return { commit, dirty: st.length > 0 };
  } catch {
    return { commit: null, dirty: null };
  }
}

/** 發佈程式用：登記「這個 collection 最後由哪個程式、哪個 commit 寫入」（merge；同一 collection 可有多個寫入端，各自一格）。 */
export async function stampScriptWriter(db, collection, writer, stamp) {
  await db.collection(WRITER_DOC[0]).doc(WRITER_DOC[1]).set(
    { scripts: { [collection]: { [writer]: { commit: stamp.commit, dirty: stamp.dirty, at: Date.now() } } } },
    { merge: true },
  );
}

/** 發佈成功後呼叫：失敗只警告、不影響發佈結果（登記是旁路資訊）。files＝這個寫入端的程式檔（相對 repo 根或絕對路徑）。 */
export async function stampAfterPublish(db, collection, writer, repoRoot, files) {
  try { await stampScriptWriter(db, collection, writer, gitWriterStamp(repoRoot, files)); }
  catch (e) { console.warn(`⚠ 寫入端版本登記失敗（${collection}/${writer}）：${String(e?.message || e).slice(0, 80)}`); }
}
