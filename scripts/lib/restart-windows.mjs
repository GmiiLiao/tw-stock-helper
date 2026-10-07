// ─────────────────────────────────────────────────────────────────────────
// daemon 重啟保護窗（scripts/can-restart-daemon.mjs 的判定核心）
//   純函式：不讀時鐘、不碰 Firestore、不讀日誌；呼叫端給「台北時間的分鐘數」與「是否交易日」。
//   2026-10-07 抽出（原本寫在 can-restart-daemon.mjs 裡、沒有測試）：同日依使用者裁定 O7
//   新增開盤感應器窗 08:30–10:05，順手補上「判定」與「最早可重啟時刻」的單元測試。
// ─────────────────────────────────────────────────────────────────────────

/** 距離下一個窗太近也要擋（重啟到穩定需要一兩分鐘），單位：分鐘 */
export const NEAR_GAP_MIN = 3;
const DAY_MIN = 24 * 60;

// 保護窗（台北時間，分鐘）。只在**交易日**生效。
// 每一條都要寫清楚「重啟會失去什麼」——沒有代價說明的保護窗會被下一個人拿掉。
export const WINDOWS = Object.freeze([
  // 盤前判別窗（2026-08-31 補）：07:00 晨間新聞判別、08:00 軋空與漲停判別。
  // 這段重啟會讓已完成的判別**整個重跑**——守衛旗標存在記憶體裡，重啟即歸零。
  // 實測今天 08:20 重啟，軋空判別在 08:11 已完成卻於 08:31 又跑一次，
  // 白白吃掉 11 分鐘；而盤前判別本來就要跑到 08:46 才就緒（距開盤 14 分鐘）。
  // 再吃掉一次就會壓到開盤，使用者盤前拿不到當沖資格與判別。
  { from: 7 * 60, to: 9 * 60, name: '盤前判別窗（晨間新聞＋軋空/漲停判別）',
    cost: '已完成的判別整個重跑；實測單趟需 46 分鐘，重跑會壓到 09:00 開盤' },
  { from: 7 * 60 + 20, to: 7 * 60 + 50, name: '當沖資格盤前抓取',
    cost: '站上整個交易日掛昨天的當沖名單（合規風險：使用者可能對不可當沖的股票下當沖單）' },
  { from: 8 * 60, to: 9 * 60 + 5, name: '開盤前新聞判別',
    cost: '該窗外不再執行，當日沒有任何事前判別' },
  { from: 8 * 60 + 30, to: 9 * 60 + 10, name: '即時價還原敏感窗',
    cost: '_lastLive 清空，冷門股可能數十分鐘沒有即時價（CLAUDE.md 記載已發生兩次）' },
  // 開盤感應器（2026-10-07 使用者裁定 O7「如建議進行」；規格 design-v2.1 §11.2）：
  //   盤前名單、擷取緩衝 B_T、t00／o00 環都只在記憶體；09:02 首判後每 10 分鐘複判到 10:00 屬觀察點。
  //   indexRing（環揭示 09:00–10:03）在牆鐘 10:03:30 寫出、r1000 最晚 10:04 寫出——都在本窗結束（10:05 放行）之前落地
  //   （2026-10-07 審查：原本 10:05:30 才寫 indexRing，10:05:00–10:05:3x 重啟會讓環蒸發，已提前）。
  { from: 8 * 60 + 30, to: 10 * 60 + 5, name: '開盤感應器（盤前名單＋09:02 首判＋每 10 分鐘複判至 10:00＋09:20／09:30 盤型＋10:03:30 indexRing）',
    cost: '名單、擷取緩衝與 t00 環都在記憶體，重啟即蒸發；當日之後的檢查點只能 late 或 nodata，不可補；10:03:30 前重啟 indexRing 缺段（寫一次、不可補）' },
  { from: 9 * 60, to: 9 * 60 + 20, name: '搶漲停排隊警示',
    cost: '該日唯一的偵測窗，錯過就沒有第二次' },
  { from: 13 * 60 + 20, to: 13 * 60 + 40, name: '尾盤五檔累積窗',
    cost: '_depthWin 整窗蒸發，只能寫殘缺版（CLAUDE.md 記載已發生三次）' },
  { from: 15 * 60 + 5, to: 15 * 60 + 25, name: '每日收盤歸檔',
    cost: '當日 chipArchive 可能只寫一半，下游榜單整批位移' },
  { from: 16 * 60 + 25, to: 16 * 60 + 55, name: '官方補抓＋上櫃併入',
    cost: '上櫃資料整天缺席（CLAUDE.md 記載的痛點）' },
  { from: 21 * 60 + 40, to: 22 * 60 + 35, name: '資券歸檔＋訓練資料＋檢討報表',
    cost: '次交易日候選、軋空訓練樣本、檢討報表三者全部缺當日' },
].map(w => Object.freeze(w)));

export const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * 交易日某一分鐘能不能重啟。
 * @param {{mins:number, isTradingDay:boolean, windows?:readonly object[], gap?:number}} p  mins＝台北時間 0–1439
 * @returns {{ok:boolean, reason:'nonTrading'|'active'|'near'|'clear', active:object[], near:object|null, upcoming:object[]}}
 *   active：正在其中的窗；near：gap 分鐘內就要開始的窗（active 為空時才看）；upcoming：之後的窗（依開始時刻排序）。
 */
export function restartVerdict({ mins, isTradingDay, windows = WINDOWS, gap = NEAR_GAP_MIN }) {
  if (!Number.isInteger(mins) || mins < 0 || mins >= DAY_MIN) throw new Error(`mins 要是 0–${DAY_MIN - 1} 的整數：${mins}`);
  if (!isTradingDay) return { ok: true, reason: 'nonTrading', active: [], near: null, upcoming: [] };
  const active = windows.filter(w => mins >= w.from && mins < w.to);
  const upcoming = windows.filter(w => w.from > mins).sort((a, b) => a.from - b.from);
  if (active.length) return { ok: false, reason: 'active', active, near: null, upcoming };
  const near = upcoming.find(w => w.from - mins <= gap) || null;
  if (near) return { ok: false, reason: 'near', active, near, upcoming };
  return { ok: true, reason: 'clear', active, near: null, upcoming };
}

/**
 * 從 mins 起（含）最早可重啟的分鐘；交易日內都不行回 null。
 *   舊版只報「目前所在窗的結束」：窗與窗首尾相接時（例：07:00–09:00 接 08:30–10:05）會報出一個到了仍被擋的時刻。
 */
export function earliestRestart({ mins, isTradingDay, windows = WINDOWS, gap = NEAR_GAP_MIN }) {
  for (let m = mins; m < DAY_MIN; m++) if (restartVerdict({ mins: m, isTradingDay, windows, gap }).ok) return m;
  return null;
}
