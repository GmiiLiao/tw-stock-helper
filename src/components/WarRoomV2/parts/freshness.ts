// 資料章／每列價齡的純函式（唯一實作在 scripts/lib/warroom-freshness.mjs，有單元測試；這裡只轉出口）。
export {
  stampOf, rowAgeOf, toEpochMs, hhmmss, hhmm, mmdd, FRESH_THRESHOLDS, ROW_AGE, STAMP_GLYPH,
  type FreshKind, type StampState, type StampInfo, type StampInput, type RowAge,
} from '../../../../scripts/lib/warroom-freshness.mjs';
