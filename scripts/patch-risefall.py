#!/usr/bin/env python3
"""
RiseFallPanel：把「一次渲染全部」改成「先渲染 200、按鈕展開其餘」。

原本 `{items.map(...)}` 沒有任何上限，一般交易日約 900 漲 + 800 跌
= 約 1,700 個 tile 同時進 DOM，每個 tile 內含一顆 AddCandidateButton，
各自 `useAppStore(s => s.compareCodes.includes(code))` ——
任何一次 set() 就觸發 1,700 個 selector 跑 Array.includes。
搭配 30 秒輪詢每 30 秒整批 reconcile，低階手機捲不動。

⚠ 檔頭註解寫著「不設上限」是刻意的產品決策，所以這裡**沒有**直接截斷：
預設先畫 200，其餘用一顆按鈕一次展開。看得到全部的能力保留，
只是不再無條件付整批的渲染成本。
"""
import re
import sys
from pathlib import Path

p = Path(sys.argv[1])
s = p.read_text(encoding='utf-8')
orig = s

# 1) Column 內加 limit state
old_sig = """  candidateSet: Set<string>;
}) {
  return (
    <div style={{ minWidth: 0 }}>"""
new_sig = """  candidateSet: Set<string>;
}) {
  // 預設只畫 INITIAL_TILES 個，其餘由使用者按鈕展開。
  // limit 刻意不隨 items 變動重置 —— items 每 30 秒換成新陣列，
  // 重置的話使用者剛按下的「顯示全部」會在下一輪被打回去。
  const [limit, setLimit] = useState(INITIAL_TILES);
  const rest = items.length - limit;

  // 三個統計原本寫在 render body 裡，對 ~900 筆做 3 次全掃，每次重繪都重算。
  const stat = useMemo(() => {
    let a = 0, b = 0, c2 = 0;
    for (const q of items) {
      const x = Math.abs(q.changePercent);
      if (x >= 9.9) a++;
      else if (x >= 7) b++;
      else if (x >= 5) c2++;
    }
    const up = title === '上漲';
    return `${up ? '漲停' : '跌停'}${a}·${up ? '強勢' : '急跌'}${b}·${up ? '中強' : '中跌'}${c2}`;
  }, [items, title]);

  return (
    <div style={{ minWidth: 0 }}>"""
assert old_sig in s, 'Column 簽章沒對上'
s = s.replace(old_sig, new_sig, 1)

# 2) 統計 IIFE → 用 memo 過的 stat
old_stat = re.search(r'\{\(\(\) => \{ const a = items\.filter.*?\)\(\)\}', s, re.S)
assert old_stat, '統計 IIFE 沒對上'
s = s[:old_stat.start()] + '{stat}' + s[old_stat.end():]

# 3) map 加上 slice
assert '{items.map(q => {' in s, 'items.map 沒對上'
s = s.replace('{items.map(q => {', '{items.slice(0, limit).map(q => {', 1)

# 4) 「顯示其餘」按鈕
old_empty = "      {items.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: '10px 4px' }}>無</div>}"
new_empty = """      {rest > 0 && (
        <button onClick={() => setLimit(items.length)}
          style={{ marginTop: 6, width: '100%', padding: '6px 0', borderRadius: 8, cursor: 'pointer',
            fontSize: 11.5, fontWeight: 700, color: 'var(--text-muted)',
            background: 'transparent', border: '1px dashed var(--border-primary)' }}>
          顯示其餘 {rest.toLocaleString()} 檔
        </button>
      )}
""" + old_empty
assert old_empty in s, '空狀態那行沒對上'
s = s.replace(old_empty, new_empty, 1)

# 5) 常數
anchor = '// 熱力底色：漲紅跌綠，強度隨 |漲跌幅| 遞增（台股慣例）'
assert anchor in s, '常數插入點沒對上'
s = s.replace(anchor,
    '// 單欄初次渲染的方塊數上限。全市場約 900 漲 / 800 跌，全畫會讓低階手機捲不動。\n'
    'const INITIAL_TILES = 200;\n\n' + anchor, 1)

assert s != orig
p.write_text(s, encoding='utf-8')
print('✓ RiseFallPanel 已套用（初次 200 檔 + 展開按鈕 + 統計 memo 化）')
