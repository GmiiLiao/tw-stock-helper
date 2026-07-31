#!/usr/bin/env python3
"""第 7d 步：三個重繪／重抓熱點。"""
import sys
from pathlib import Path

H = Path('src/components/Header/Header.tsx')
S = Path('src/components/StockDetail/StockDetail.tsx')
done = []

# ══════════════════════════════════════════════════════════════
# 1) Header 時鐘拆成葉節點
#
# 原本 setInterval(tick, 1000) 直接 setState 在 Header 上，
# 讓一個 17KB 的大元件每秒完整重繪、背景分頁也照跑。
# 檔內註解自承這造成搜尋框必須改成 uncontrolled 才不會打斷 IME —— 那是治標。
# 把時鐘變成自己持有 state 的葉節點後，每秒重繪的範圍縮到一個 <span>。
# ══════════════════════════════════════════════════════════════
s = H.read_text(encoding='utf-8')

old_state = "  const [currentTime, setCurrentTime] = useState('');\n"
assert old_state in s, 'Header: currentTime state 沒對上'
s = s.replace(old_state, '', 1)

old_clock = """  // ── Clock ──────────────────────────────────────────────────────
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setCurrentTime(now.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
"""
assert old_clock in s, 'Header: clock effect 沒對上'
s = s.replace(old_clock, '', 1)

old_span = "        <span className={styles.clockTime}>{currentTime}</span>"
assert old_span in s, 'Header: clock span 沒對上'
s = s.replace(old_span, "        <Clock className={styles.clockTime} />", 1)

# 葉節點元件插在 export default function Header 之前
anchor = 'export default function Header() {'
clock_component = '''// 時鐘拆成獨立葉節點：每秒重繪的範圍只有這一個 <span>，
// 而不是整個 Header（17KB、含大盤/美股/夜盤多個 widget）。
// 分頁在背景時停擺 —— 使用者看不到的時鐘不需要走。
function Clock({ className }: { className?: string }) {
  const [now, setNow] = useState('');
  useEffect(() => {
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      setNow(new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    };
    tick();
    const id = setInterval(tick, 1000);
    const onVis = () => tick();
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, []);
  return <span className={className}>{now}</span>;
}

'''
assert anchor in s
s = s.replace(anchor, clock_component + anchor, 1)

# ══════════════════════════════════════════════════════════════
# 2) Header 搜尋 debounce
#
# 原本每一個按鍵都對 ~1,700 檔做 toLowerCase().includes() 全掃。
# ══════════════════════════════════════════════════════════════
old_search_head = """  // ── Search ─────────────────────────────────────────────────────
  useEffect(() => {
    if (searchQuery.length < 1) {"""
new_search_head = """  // ── Search ─────────────────────────────────────────────────────
  // 原本每一個按鍵都對 ~1,700 檔做 toLowerCase().includes() 全掃。
  // 150ms debounce：連續輸入時只在停頓後掃一次。
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(searchQuery), 150);
    return () => clearTimeout(id);
  }, [searchQuery]);

  useEffect(() => {
    if (debouncedQuery.length < 1) {"""
assert old_search_head in s, 'Header: search effect 開頭沒對上'
s = s.replace(old_search_head, new_search_head, 1)

old_q = "    const q = searchQuery.trim().toLowerCase();"
assert old_q in s, 'Header: search q 沒對上'
s = s.replace(old_q, "    const q = debouncedQuery.trim().toLowerCase();", 1)

old_deps = "  }, [searchQuery, allStocksLocal]);"
assert old_deps in s, 'Header: search deps 沒對上'
s = s.replace(old_deps, "  }, [debouncedQuery, allStocksLocal]);", 1)

H.write_text(s, encoding='utf-8')
done.append('Header：時鐘拆成葉節點、搜尋加 150ms debounce')

# ══════════════════════════════════════════════════════════════
# 3) StockDetail 依賴地獄 + 未取消的串行抓取
#
# `allStocks` 在 loadStockData 的 deps 裡，但它只是被當快取讀一次。
# Header 每 2 分鐘 setAllStocks() 換成新陣列 → callback identity 變
# → effect 重跑 → 重打 3~12 次 stock-history（每次間隔 300ms）
# + 重跑 8 組技術指標 + recharts 全圖重建。
# 使用者只是打開個股頁發呆，而歷史 K 線一天只變一次。
#
# 另外那個 for 迴圈沒有取消機制，切換股票時舊的 12 次串行抓取會繼續跑完。
# ══════════════════════════════════════════════════════════════
s = S.read_text(encoding='utf-8')

old_load = """  // ── Load chart / signal data ──────────────────────────────────
  const loadStockData = useCallback(async () => {
    if (!selectedStock) return;
    setLoading(true);
    try {
      let stocks = allStocks;"""
new_load = """  // ── Load chart / signal data ──────────────────────────────────
  // allStocks 只在這裡當「已經抓過的清單」讀一次，不是重跑的觸發條件。
  // 放在 deps 裡會讓 Header 每 2 分鐘的 setAllStocks() 把整個載入流程重跑一遍。
  const allStocksRef = useRef(allStocks);
  allStocksRef.current = allStocks;
  // 換股/換週期時作廢上一輪 —— 那個 for 迴圈是串行 + 每次 sleep 300ms，
  // 沒有這道 guard 的話舊的 12 次抓取會繼續跑完，還會把結果寫回畫面。
  const runIdRef = useRef(0);

  const loadStockData = useCallback(async () => {
    if (!selectedStock) return;
    const myRun = ++runIdRef.current;
    setLoading(true);
    try {
      let stocks = allStocksRef.current;"""
assert old_load in s, 'StockDetail: loadStockData 開頭沒對上'
s = s.replace(old_load, new_load, 1)

old_loop = """        const monthData = await fetchStockHistory(selectedStock, dateStr);
        allCandles.push(...monthData);
        await new Promise(r => setTimeout(r, 300));"""
new_loop = """        if (runIdRef.current !== myRun) return;   // 已換股，放棄這一輪
        const monthData = await fetchStockHistory(selectedStock, dateStr);
        allCandles.push(...monthData);
        await new Promise(r => setTimeout(r, 300));"""
assert old_loop in s, 'StockDetail: for 迴圈沒對上'
s = s.replace(old_loop, new_loop, 1)

old_commit = """      }).sort((a, b) => a.time - b.time);
      setCandles(unique);"""
new_commit = """      }).sort((a, b) => a.time - b.time);
      if (runIdRef.current !== myRun) return;   // 別把舊股票的 K 線寫進畫面
      setCandles(unique);"""
assert old_commit in s, 'StockDetail: setCandles 沒對上'
s = s.replace(old_commit, new_commit, 1)

old_fin = """    } finally {
      setLoading(false);
    }
  }, [selectedStock, chartPeriod, allStocks]);"""
new_fin = """    } finally {
      if (runIdRef.current === myRun) setLoading(false);
    }
  }, [selectedStock, chartPeriod]);"""
assert old_fin in s, 'StockDetail: deps 沒對上'
s = s.replace(old_fin, new_fin, 1)

S.write_text(s, encoding='utf-8')
done.append('StockDetail：allStocks 移出 deps、串行抓取加作廢 guard')

for d in done:
    print(f'  ✓ {d}')
