// ─────────────────────────────────────────────────────────────────────────
// 開盤感應器 v2.1：09:20／09:30 盤型三線（pattern3-v2.1；影子；純函式）
//   規格 design-v2.1 §6；定義、狀態、門檻照 design-v2 §5.1、§5.2（〔先驗〕）。三線：加權（t00 環）、櫃買（o00 環）、
//   上市一般股中位數（B_T 的 G，與同時刻複判共用）。有效開盤一律用 E′(T)，同時記未修正的 E。
//   影子：不發 B2、不發站內訊息、不推播；公開的 marketPattern.live（官方開盤口徑）語意不變、不用這裡。
//   只描述盤勢事實，非投資建議。
// ─────────────────────────────────────────────────────────────────────────
import { SUB_BASIS, P as PARAMS, rnd, tpeHmsOf } from './open-sensor-params.mjs';
import { firstAtOrAfter } from './open-sensor-capture.mjs';

export const PATTERN_ZH = Object.freeze({
  fadeDown: '開高走低', upUp: '開高走高', upHold: '開高持穩',
  reversalUp: '開低走高', downDown: '開低走低', downHold: '開低持穩',
  flatDown: '開平殺盤', flatUp: '開平走高', range: '平盤震盪', nodata: '資料不足',
});

/**
 * 一條線的盤型（design-v2 §5.2）。mode 'idx'：Y、E、P 是點位；'gen'：E、P 是%（Y＝0）。
 *   Gp＝跳空%；D＝自有效開盤的變化（idx：%；gen：百分點）；F＝缺口回補比例（|Gp| ≥ 0.40 才算）。
 */
export function classifyLine({ Y = null, E, P, mode = 'idx' }) {
  if (E == null || P == null || (mode === 'idx' && !(Y > 0))) return { key: 'nodata', label: PATTERN_ZH.nodata };
  let Gp, D, F;
  if (mode === 'idx') { Gp = (E - Y) / Y * 100; D = (P - E) / E * 100; F = Math.abs(Gp) >= 0.40 ? (E - P) / (E - Y) : null; }
  else { Gp = E; D = P - E; F = Math.abs(Gp) >= 0.40 ? (E - P) / E : null; }
  const big = Math.abs(Gp) >= 1.0;
  const below = mode === 'idx' ? P < Y : P < 0, above = mode === 'idx' ? P > Y : P > 0;
  let key, cross = null;
  if (Gp >= 0.40) { key = (F >= 0.50 || D <= -0.80) ? 'fadeDown' : D >= 0.30 ? 'upUp' : 'upHold'; if (key === 'fadeDown' && below) cross = '翻黑'; }
  else if (Gp <= -0.40) { key = (F >= 0.50 || D >= 0.80) ? 'reversalUp' : D <= -0.30 ? 'downDown' : 'downHold'; if (key === 'reversalUp' && above) cross = '翻紅'; }
  else key = D <= -1.00 ? 'flatDown' : D >= 0.80 ? 'flatUp' : 'range';
  const label = (big && !key.startsWith('flat') && key !== 'range' ? '大幅' : '') + PATTERN_ZH[key] + (cross ? `·${cross}` : '');
  const reversal = ['fadeDown', 'flatDown', 'reversalUp'].includes(key) || !!cross;
  return { key, label, cross, big, reversal, gp: rnd(Gp, 3), d: rnd(D, 3), f: rnd(F, 3) };
}

/** 限定詞（附在後面，不改狀態）：指數漲跌 − 一般股中位數 ≥ +1.0pp ⇒ 權值撐盤；≤ −1.0pp ⇒ 權值拖累、個股抗跌 */
export function qualifierOf(idxPct, genPct) {
  if (idxPct == null || genPct == null) return null;
  const d = idxPct - genPct;
  return d >= 1.0 ? '權值撐盤' : d <= -1.0 ? '權值拖累、個股抗跌' : null;
}

/**
 * 09:20／09:30 一次判讀。T＝檢查點 ms；ring＝cap.ringT／ringO；eCorr＝eCorrAt() 的結果；e＝eStart().e；
 * gNow＝同時刻 B_T 的 G（%）；writtenAt＝寫入時刻。指數現值 P＝揭示 ≥ T 的第一拍；拿不到 E 時該線 nodata，不拿官方開盤頂替。
 */
export function patternAt({ T, ringT, ringO, e, eCorr, gNow, writtenAt }) {
  const line = (ring, eSide, corr) => {
    if (!eSide) return { status: 'nodata', ...classifyLine({ E: null, P: null }), eUsed: null, eCorrected: false, revealAt: null };
    const now = firstAtOrAfter(ring, T);
    // 現值必須是 T 之後緊接的那一拍（重啟後環缺段時，較晚的拍子不能頂替 T 的盤面）
    if (!now || !(now[4] > 0) || now[0] - T > PARAMS.ringGapMs) return { status: 'nodata', ...classifyLine({ E: null, P: null }), eUsed: null, eCorrected: false, revealAt: null };
    const Y = now[4];
    const ePct = corr?.pct ?? eSide.pct;
    const eUsed = Y * (1 + ePct / 100);
    const c = classifyLine({ Y, E: eUsed, P: now[1], mode: 'idx' });
    return { status: 'ok', ...c, p: now[1], pPct: rnd((now[1] / Y - 1) * 100, 3), eUsed: rnd(eUsed, 2), eRaw: eSide.v, eCorrected: !!(corr && corr.addPp), revealAt: now[0] };
  };
  const tse = line(ringT, e?.tse, eCorr?.tse);
  const otc = line(ringO, e?.otc, eCorr?.otc);
  const eGen = eCorr?.gen?.pp ?? e?.gen ?? null;
  const genC = classifyLine({ E: eGen, P: gNow, mode: 'gen' });
  const gen = { status: genC.key === 'nodata' ? 'nodata' : 'ok', ...genC, eUsed: eGen, eRaw: e?.gen ?? null, eCorrected: eCorr?.gen?.pp != null && eCorr.gen.pp !== e?.gen, gNow: gNow ?? null };
  return {
    T: tpeHmsOf(T), writtenAt,
    lines: { tse, otc, gen },
    qualifier: qualifierOf(tse.pPct ?? null, gNow ?? null),
    basis: SUB_BASIS.pattern,
  };
}
