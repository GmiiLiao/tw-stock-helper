// Firestore（Admin SDK，daemon 未開 ignoreUndefinedProperties）拒收任何層級的 undefined：整筆寫入失敗。
// 2026-09-24 daytradeAlerts 956 次寫入失敗即此因。凍結檔（寫一次不改）寫入前一律過這支：
// 物件中值為 undefined 的鍵刪除、陣列中的 undefined 轉 null（保持索引），其餘原樣。
export function dropUndefined(v) {
  if (Array.isArray(v)) return v.map(x => (x === undefined ? null : dropUndefined(x)));
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out = {};
    for (const k of Object.keys(v)) if (v[k] !== undefined) out[k] = dropUndefined(v[k]);
    return out;
  }
  return v;
}
