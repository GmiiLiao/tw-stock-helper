#!/usr/bin/env python3
"""Yahoo 分K 收集器的宇宙與「應有清單」（collect.mjs 啟動時呼叫）。
來源全是官方口徑的本機快取：scripts/surge-lab/.surge-cache/panel.npz（官方日成交量，每晚 23:10/23:50 更新）、code_market.json（上市/上櫃）。
輸出 JSON 到 stdout：
  panelLastDay  官方資料最後一天
  market        {code: 'tse'|'otc'|None}
  active        最近 5 個官方交易日有成交量的代號（今日要抓的宇宙）
  expected      {day: [代號…]} 最近 EXPECT_DAYS 個官方交易日「有成交」的代號（覆蓋率稽核的分母）
時序（2026-10-09 全站掃描第 7 項·只加註解、不改邏輯）：collect.mjs 平日 18:10 跑，而 panel.npz 要到當晚 23:10/23:50 起漲影子那幾輪
  才更新 ⇒ 18:10 讀到的 panel 只到「前一個交易日」：panelLastDay＝前一交易日；active 宇宙不含「今天才首日有成交」的代號
  （例：今天新上市），expected 也沒有今天這一天。這是預期中的落後一天，不是缺口——隔天 18:10 那輪 panel 已含今天，
  宇宙補上該代號，而每日模式 1 分K 抓近 8 日、5／60 分K 抓近 10 日的重疊窗會把今天的分K 自動補回；覆蓋率稽核的分母也隔天才含今天。
"""
import json, sys
import numpy as np

CACHE = '/Users/gmii/Documents/股票助手app/tw-stock-app/scripts/surge-lab/.surge-cache'
EXPECT_DAYS = 70          # 5 分K 保留 60 個交易日，多留幾天
ACTIVE_DAYS = 5

p = np.load(f'{CACHE}/panel.npz', allow_pickle=True)
dates = [str(d) for d in p['dates']]
codes = [str(c) for c in p['codes']]
V = p['V'].astype(float)
mkt = json.load(open(f'{CACHE}/code_market.json'))
traded = np.isfinite(V) & (V > 0)
active = [c for j, c in enumerate(codes) if traded[-ACTIVE_DAYS:, j].any()]
expected = {dates[t]: [codes[j] for j in np.where(traded[t])[0]] for t in range(max(0, len(dates) - EXPECT_DAYS), len(dates))}
json.dump(dict(panelLastDay=dates[-1], market={c: mkt.get(c) for c in active}, active=active, expected=expected), sys.stdout, ensure_ascii=False)
