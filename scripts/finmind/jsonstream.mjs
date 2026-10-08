// ── FinMind 回應的串流切列 ─────────────────────────────────────────────────────
// 回應格式 {"msg":"success","status":200,"data":[{...},{...}]}。TXO 逐筆一天 107MB JSON、77.5 萬列——
// 不整份 JSON.parse：逐塊掃描，把 data 陣列的每個元素原文切出來（呼叫端直接寫進 gzip），外層只留 msg／status。
// 不依賴欄位順序；字串內的括號、跳脫字元、"data":[ 字樣都不會誤判。

const Q = 34, BS = 92, LB = 123, RB = 125, LS = 91, RS = 93, COMMA = 44;
const isWs = c => c === 32 || c === 9 || c === 10 || c === 13;

export function createRowSplitter() {
  let depth = 0, inStr = false, esc = false;
  let mode = 'outer';          // outer：外層物件；data：data 陣列內
  let outer = '';              // 外層原文（data 陣列內容以 [] 取代）
  let hasData = false;
  let elem = null;             // { kind: 'container'|'string'|'scalar', parts: [] }
  let elemStart = 0;

  function push(chunk) {
    const rows = [];
    let seg = 0;
    const s = String(chunk);
    const endElem = endIdx => {
      rows.push(elem.parts.join('') + s.slice(elemStart, endIdx));
      elem = null;
    };
    const closeData = i => { depth = 1; mode = 'outer'; outer += ']'; seg = i + 1; };
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (c === BS) esc = true;
        else if (c === Q) { inStr = false; if (elem?.kind === 'string' && depth === 2) endElem(i + 1); }
        continue;
      }
      if (mode === 'outer') {
        if (c === Q) inStr = true;
        else if (c === LS && depth === 1 && /"data"\s*:\s*$/.test(outer + s.slice(seg, i))) {
          outer += s.slice(seg, i + 1); seg = i + 1; depth = 2; mode = 'data'; hasData = true;
        } else if (c === LB || c === LS) depth++;
        else if (c === RB || c === RS) depth--;
        continue;
      }
      // mode === 'data'
      if (!elem) {
        if (isWs(c) || c === COMMA) continue;
        if (c === RS && depth === 2) { closeData(i); continue; }
        elemStart = i;
        if (c === LB || c === LS) { elem = { kind: 'container', parts: [] }; depth++; }
        else if (c === Q) { elem = { kind: 'string', parts: [] }; inStr = true; }
        else elem = { kind: 'scalar', parts: [] };
        continue;
      }
      if (elem.kind === 'container') {
        if (c === Q) inStr = true;
        else if (c === LB || c === LS) depth++;
        else if (c === RB || c === RS) { depth--; if (depth === 2) endElem(i + 1); }
      } else if (elem.kind === 'scalar' && (c === COMMA || c === RS || isWs(c))) {
        endElem(i);
        if (c === RS) closeData(i);
      }
    }
    if (mode === 'outer') outer += s.slice(seg);
    else if (elem) { elem.parts.push(s.slice(elemStart)); elemStart = 0; }
    return rows;
  }

  function end() {
    if (mode !== 'outer' || depth !== 0 || inStr || elem) throw new Error('回應 JSON 不完整（可能被截斷）');
    let meta;
    try { meta = JSON.parse(outer); } catch { throw new Error('回應不是合法 JSON'); }
    return { msg: meta?.msg ?? null, status: meta?.status ?? null, hasData, outer: meta };
  }

  return { push, end };
}

/** 一次處理整份文字（測試與小回應用）。 */
export function splitAll(text) {
  const sp = createRowSplitter();
  const rows = sp.push(text);
  return { rows, meta: sp.end() };
}
