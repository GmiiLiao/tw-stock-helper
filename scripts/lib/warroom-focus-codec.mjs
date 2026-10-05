// ─────────────────────────────────────────────────────────────────────────────
// 盤中戰情 v2「A2 時段焦點」前後端共用的純函式（無 import；前端 ZoneFocus 與伺服器 build-focus 都用這一份）
//
// ① 各內容的資料提供時窗（FOCUS_WINDOW）：聚合路由 /api/warroom/pulse 是全體共用、CDN 快取的同一個網址，
//    不知道誰在看哪一個內容——所以只在該內容「有意義」的時窗內組裝，其餘時段回 null（前端顯示提供時窗）。
// ② 開盤三關的全市場逐檔數據（encodeGateRows／decodeGateRows）：路由不帶使用者代號（不可每人不同網址），
//    只能送全市場、由前端挑出持股與候選。約 1,750 檔，用欄式＋代號差分編碼壓到 gzip 約 6KB，只在 09:00–10:00 送。
// ③ 第二關「相對大盤」的分類（gateRsLabel）：與 daemon buildTriGateLive（問 AI 開盤三關）同口徑，不另立門檻。
//
// 單元測試：node --test scripts/lib/warroom-focus.test.mjs
// ─────────────────────────────────────────────────────────────────────────────

/** 台北「當日分鐘數」區間 [from, to)；只在交易日成立 */
export const FOCUS_WINDOW = Object.freeze({
  script: Object.freeze({ from: 0, to: 9 * 60, label: '交易日 09:00 前' }),
  gates: Object.freeze({ from: 9 * 60, to: 10 * 60, label: '09:00–10:00' }),
  daytrade: Object.freeze({ from: 9 * 60, to: 13 * 60 + 45, label: '09:00–13:45' }),
  tail: Object.freeze({ from: 12 * 60 + 45, to: 13 * 60 + 45, label: '12:45–13:45' }),
});

/** 該內容此刻是否在提供時窗內（非交易日一律 false） */
export function focusPartActive(part, minute, trading) {
  const w = FOCUS_WINDOW[part];
  if (!w || !trading || typeof minute !== 'number' || !Number.isFinite(minute)) return false;
  return minute >= w.from && minute < w.to;
}

/** 開盤三關第一關門檻（DAYTRADE_SKILL：前 30 分量 ≥ 昨量 40%；待驗證·不計分——畫面只顯示比率，不標過關） */
export const GATE1_THRESHOLD_PCT = 40;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const CODE4 = /^\d{4}$/;

/**
 * 全市場三關數據 → 欄式字串。
 * @param {Array<{ code: string, ratio: number|null, chg: number, vw: 1|0|null }>} rows
 * @returns {{ d: string, r: string, c: string, w: string, n: number }}
 *   d＝代號差分（排序後與前一檔相減）、r＝量比 %（整數；缺＝空字串）、c＝漲跌 %×100（整數）、w＝VWAP 位置（'1' 在上／'0' 在下／'-' 未知）
 */
export function encodeGateRows(rows) {
  const list = (Array.isArray(rows) ? rows : [])
    .filter(x => x && CODE4.test(x.code) && isNum(x.chg))
    .slice()
    .sort((a, b) => Number(a.code) - Number(b.code));
  const d = [], r = [], c = [];
  let w = '';
  let prev = 0;
  let last = null;
  for (const x of list) {
    if (x.code === last) continue;          // 重複代號只留第一筆
    last = x.code;
    const n = Number(x.code);
    d.push(n - prev);
    prev = n;
    r.push(isNum(x.ratio) && x.ratio >= 0 ? Math.round(x.ratio) : '');
    c.push(Math.round(x.chg * 100));
    w += x.vw === 1 ? '1' : x.vw === 0 ? '0' : '-';
  }
  return { d: d.join(','), r: r.join(','), c: c.join(','), w, n: d.length };
}

/**
 * 欄式字串 → Map(code → { ratio, chg, vw })。格式不一致（欄長對不上、非數字）一律回空 Map（不猜）。
 * @param {{ d?: string, r?: string, c?: string, w?: string } | null | undefined} g
 */
export function decodeGateRows(g) {
  const out = new Map();
  if (!g || typeof g.d !== 'string' || !g.d) return out;
  const d = g.d.split(','), r = String(g.r ?? '').split(','), c = String(g.c ?? '').split(','), w = String(g.w ?? '');
  if (r.length !== d.length || c.length !== d.length || w.length !== d.length) return out;
  let code = 0;
  for (let i = 0; i < d.length; i++) {
    const step = Number(d[i]);
    const chg = Number(c[i]);
    if (!Number.isInteger(step) || step <= 0 || !Number.isFinite(chg)) return new Map();   // 代號必須嚴格遞增
    code += step;
    const ratio = r[i] === '' ? null : Number(r[i]);
    out.set(String(code).padStart(4, '0'), {
      ratio: ratio != null && Number.isFinite(ratio) ? ratio : null,
      chg: chg / 100,
      vw: w[i] === '1' ? 1 : w[i] === '0' ? 0 : null,
    });
  }
  return out;
}

/**
 * 第二關「相對大盤」：RS＝個股漲跌% − 加權漲跌%。分類與 daemon buildTriGateLive 一致：
 *   漲 ≥3% 但 RS <1 ⇒「跟風」（日線代理實證隔日極差）；RS ≥2 ⇒「自己強」；其餘「中性」。
 * @returns {{ rs: number, label: '跟風'|'自己強'|'中性' } | null}
 */
export function gateRsLabel(chg, idxChg) {
  if (!isNum(chg) || !isNum(idxChg)) return null;
  const rs = Math.round((chg - idxChg) * 10) / 10;
  if (chg >= 3 && rs < 1) return { rs, label: '跟風' };
  if (rs >= 2) return { rs, label: '自己強' };
  return { rs, label: '中性' };
}
