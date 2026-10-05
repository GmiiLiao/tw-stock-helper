// ── T1 分軌前向登錄的實作釘選（implementation_pins）閘門：純函式（pre-commit 的 scripts/check-tracks-pins.mjs 用）──────────
// 前向登錄 T1-TRACKS-FWD-2026-10-05 釘選 17 個檔（多數是 a35 與其他研究共用的模組：build.py、official_features.py、disposal.py…）。
// sha256 一不符，a36_tracks_fwd_rules.check_pins ⇒ C7 不通過 ⇒ 每天只寫 wait、期限一過變成永不補產的缺口。
// 所以 commit 觸及釘選檔時，staged 內容的 sha256 必須等於登錄值，或前向偏差紀錄（staged 版）已有對應的
// 「PIN-UPDATE: <scripts/surge-lab/檔名> <新 sha256>」列（與 check_pins 讀同一種行，規則見登錄 implementation_pins.rule）。

export const REG_JSON = 'scripts/surge-lab/tracks/registration_t1_tracks_forward.json';
export const DEV_LOG = 'scripts/surge-lab/tracks/DEVIATIONS_t1_tracks_forward.md';
const PIN_LINE = /^\s*PIN-UPDATE:\s*(\S+)\s+([0-9a-f]{64})\s*$/;

/** 前向偏差紀錄文字 → { 路徑: Set(sha256) }（與 a36_tracks_fwd_rules.pin_updates 同一條正規式） */
export function parsePinUpdates(text) {
  const out = {};
  for (const ln of String(text || '').split('\n')) {
    const m = ln.match(PIN_LINE);
    if (m) (out[m[1]] ||= new Set()).add(m[2]);
  }
  return out;
}

/**
 * pins＝{ 路徑: 登錄 sha256 }；staged＝這次 commit 觸及的路徑；shaOf(路徑) → staged 內容的 sha256（刪除＝null）；updates＝parsePinUpdates。
 * 回傳 [{ file, now, registered }]：觸及且既不等於登錄值、也沒有 PIN-UPDATE 列的釘選檔。
 */
export function pinViolations({ pins, staged, shaOf, updates }) {
  const touched = new Set(staged);
  const bad = [];
  for (const [file, want] of Object.entries(pins || {})) {
    if (!touched.has(file)) continue;
    const now = shaOf(file);
    if (now === want || (now && updates[file]?.has(now))) continue;
    bad.push({ file, now, registered: want });
  }
  return bad;
}
