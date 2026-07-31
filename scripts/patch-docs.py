#!/usr/bin/env python3
"""
修正 CLAUDE.md 與程式碼的不一致。

問題：CLAUDE.md 寫「前端輪詢一律用 useSharedPoll」並附範例，但
  - 沒寫 import 路徑（實際在 @/hooks/，不是 @/lib/）
  - useSharedPoll 目前**零呼叫點**，是預備模組不是現行做法
  - 26 個有 setInterval 的檔案裡只有 3 個接上 gate

文件把「目標狀態」寫成「現行慣例」，接手的人會照著找不到的東西寫。
"""
from pathlib import Path

C = Path('CLAUDE.md')
s = C.read_text(encoding='utf-8')

old = """**前端輪詢一律用 `useSharedPoll`**

```ts
const { data } = useSharedPoll('/api/twse/market-index', fetcher, { regularMs: 5_000 });
```
它處理：多元件共用一條輪詢、`document.hidden` 時停擺、休市時停擺、間隔每次重算、
失敗指數退避、jitter。手寫 `setInterval` 這六項全都會漏。"""

new = """**前端輪詢：現況是「加 gate」，不是「換 hook」**

現行做法 —— 在既有的 poll function 第一行加一道 gate，計時器照跑但不發請求：

```ts
import { shouldPollNow } from '@/lib/market-clock';

const poll = async () => {
  if (!shouldPollNow()) return;   // 休市 or 分頁在背景 → 跳過
  ...
};
```

只擋背景分頁、休市仍要更新的資料（美股、daemon 產出）用 `isForeground()`。

**進度：26 個含 `setInterval` 的檔案裡，目前只有 3 個接上 gate**
（`AlertEngine` / `Header` / `AiNewsTicker`，加上 `lib/useLiveQuotes.ts` 用遞迴 setTimeout）。
其餘 23 個清單在 `docs/OPTIMIZATION-TODO.md`。新增輪詢時請直接加 gate。

`src/hooks/useSharedPoll.ts` 是**已寫好但尚未採用**的替代方案（目前零呼叫點）。
它多做的是：多元件共用一條輪詢、間隔每次重算、失敗指數退避、jitter。
當你遇到「同一支 API 被多個元件各自輪詢」時才值得換過去 —— 單純為了統一而重寫不划算。
換的時候路徑是 `@/hooks/useSharedPoll`（不是 `@/lib/`）。"""

assert old in s, 'CLAUDE.md 的 useSharedPoll 段落沒對上'
C.write_text(s.replace(old, new, 1), encoding='utf-8')
print('  ✓ CLAUDE.md：改成描述現況，補上正確路徑與採用進度')

# ── useSharedPoll.ts 加狀態標頭 ─────────────────────────────
H = Path('src/hooks/useSharedPoll.ts')
h = H.read_text(encoding='utf-8')
marker = "'use client';\n"
banner = """'use client';

// ⚠ 狀態：已寫好，但目前**零呼叫點**（2026-07-31 確認）。
//
// 第 5 步刻意選了風險較低的做法：保留既有 setInterval、只加 market-clock gate，
// 沒有把 26 個輪詢點重寫成這個 hook。省下的請求量是一樣的。
//
// 什麼時候才值得換過來：當你遇到「同一支 API 被多個元件各自輪詢」
// （例如 /api/twse/market-index 目前有 3 個常駐元件在打）。
// 那是 gate 解不掉、只有共用 channel 能解的問題。
// 單純為了統一風格而重寫 23 個檔案，不划算。
"""
assert marker in h
H.write_text(h.replace(marker, banner, 1), encoding='utf-8')
print('  ✓ useSharedPoll.ts：加上「尚未採用」狀態標頭')
