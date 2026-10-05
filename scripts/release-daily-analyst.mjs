#!/usr/bin/env node
// 放行／撤回「分析報告」AI 分析文字對一般使用者的可見性（研究期閘門；使用者 2026-10-05 裁定：先抽樣審閱再放行）。
//   node scripts/release-daily-analyst.mjs --status      看目前狀態（只讀）
//   node scripts/release-daily-analyst.mjs --on          放行（寫 Firestore system/analystRelease {released:true}）
//   node scripts/release-daily-analyst.mjs --off         撤回（released:false；一般使用者立刻退回資料模板版，快取最多 60 秒）
//   個股「資料觀察名單」不受此旗標影響——研究期永遠只有管理員看得到。預設（文件不存在）＝未放行。
import { pathToFileURL } from 'node:url';

export const RELEASE_COLLECTION = 'system';
export const RELEASE_DOC = 'analystRelease';

/** 純函式：依 argv 決定動作。回傳 'on'｜'off'｜'status'｜null（參數不合法）。 */
export function parseAction(argv) {
  const on = argv.includes('--on'), off = argv.includes('--off'), st = argv.includes('--status');
  if (on && off) return null;
  if (on) return 'on';
  if (off) return 'off';
  return st || argv.length === 0 ? 'status' : null;
}

/** db 為 Firestore 介面（collection().doc().get()/set()）；測試注入假 db。 */
export async function applyRelease({ db, action, now = Date.now() }) {
  const ref = db.collection(RELEASE_COLLECTION).doc(RELEASE_DOC);
  if (action === 'status') { const snap = await ref.get(); return { released: snap.exists && snap.data()?.released === true, exists: snap.exists, updatedAt: snap.exists ? snap.data()?.updatedAt ?? null : null }; }
  const released = action === 'on';
  await ref.set({ released, updatedAt: now });
  return { released, exists: true, updatedAt: now };
}

async function cli() {
  const action = parseAction(process.argv.slice(2));
  if (!action) { console.error('用法：--status｜--on｜--off'); process.exit(2); }
  const { default: admin } = await import('firebase-admin');
  process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS
    || '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
  admin.initializeApp();
  const r = await applyRelease({ db: admin.firestore(), action });
  console.log(`${r.released ? '已放行（一般使用者可見 AI 分析文字）' : '未放行（僅管理員可見；一般使用者看資料模板版）'}${r.updatedAt ? `｜更新 ${new Date(r.updatedAt).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' })}` : '｜尚未設定過（預設未放行）'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli().catch(e => { console.error('失敗：', e.message); process.exit(1); });
