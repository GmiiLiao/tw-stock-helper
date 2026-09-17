# 兩層比對實測（2026-09-17 21:34 台北）

第一層：9 支 RSS，近 14 日曆日內共 352 則，耗時 1.0s、9 次請求。
第二層規則：標題 Dice ≥ 0.5 且發布時間差 ≤ 8 小時；每個出處抓一次內文（直接抓 → Google 解碼 → headless Chrome），合成一篇。

## 全球首例！愛立信攜聯發科突破5G 定位精準度 加速自駕車、無人機應用

- 第一層：經濟日報｜2026-09-17 19:27｜https://money.udn.com/money/story/5612/9761488
- 第二層命中同故事 6 則（±8h、Dice≥0.5）｜本則耗時 **3.0s**、請求 13 次

| 出處 | 標題 | 時間 | Δt(h) | 相似 | 取內文步驟 | 字數 |
|---|---|---|---|---|---|---|
| 經濟日報 | 全球首例！愛立信攜聯發科突破5G 定位精準度 加速自駕車、無人機應用 | 2026-09-17 19:27 | — | 種子 | 直接抓 HTTP 200 正文 1024 字 | 1024 |
| UDN | 全球首例！愛立信攜聯發科突破5G定位精準度 加速自駕車、無人機應用 - UDN | 2026-09-17 19:27 | 0 | 0.95 | Google 解碼→udn.com → 直接抓 HTTP 200 正文 1253 字 | 1253 |
| money.udn.com | 全球首例！愛立信攜聯發科突破5G 定位精準度 加速自駕車、無人機應用 - mon | 2026-09-17 19:27 | 0 | 0.84 | Google 解碼→money.udn.com → 直接抓 HTTP 200 正文 1024 字 | 1024 |
| 鉅亨 | 愛立信攜手聯發科突破5G定位精準度 加速自駕車、無人機與智慧製造應用 | 2026-09-17 14:17 | -5.2 | 0.77 | feed 自帶正文 | 308 |
| Yahoo財經 | 愛立信攜手聯發科突破5G定位精準度 加速自駕車、無人機與智慧製造應用 | 2026-09-17 14:17 | -5.2 | 0.77 | 直接抓 HTTP 200 正文 1435 字 | 1435 |
| 鉅亨網 | 愛立信攜手聯發科突破5G定位精準度 加速自駕車、無人機與智慧製造應用 - 鉅亨網 | 2026-09-17 14:17 | -5.2 | 0.73 | Google 解碼→m.cnyes.com → 直接抓 HTTP 200 正文 1227 字 | 1227 |
| 科技新報 | 愛立信、聯發科完成 5G 定位精準度，加速自駕車、無人機等應用突破 | 2026-09-17 12:24 | -7.1 | 0.71 | 直接抓 HTTP 200 正文 1070 字 | 1070 |

**合成結果**：底稿 Yahoo財經（1435 字），其他出處補充 17 句。

<details><summary>合成全文（2711 字）</summary>

愛立信攜手聯發科突破5G定位精準度 加速自駕車、無人機與智慧製造應用 鉅亨網記者吳承諦 2026年9月17日週四 下午2:17 加入為 Google 偏好來源 （另開新視窗） 將 Yahoo 加入 Google 優先推薦來源 將 Yahoo 設為首選來源，在 Google 上查看更多我們的精彩報導 加入首選來源 （另開新視窗） 聯發科 2454.TW 4,500 ( 0.66% ) ERIC-B.ST 101.1 ( 2.16% ) 愛立信攜手聯發科突破5G定位精準度 加速自駕車、無人機與智慧製造應用 愛立信與聯發科(2454-TW)成功完成全球首例基於3GPP標準的全球導航衛星系統（Global Navigation Satellite System, GNSS）即時動態定位（Real-Time Kinematic, RTK）端到端測試，透過商用5G網路成功實現公寸級（Decimeter-level）高精準戶外定位，為需要精準定位資訊的工業及自動化應用帶來重要突破。傳統GNSS通常僅能提供數公尺等級的定位精準度。此次測試將GNSS RTK修正資料整合至5G網路基礎架構，並完成從網路到終端裝置的端到端驗證。透過行動網路將RTK修正資料傳送至終端，裝置可即時修正大氣造成的訊號延遲及衛星誤差，進一步將定位誤差縮小至約30公分。廣告 廣告 這樣的精準度，意味著定位能力可從「知道大概在哪裡」，進一步提升到「知道確切位置」。例如，對自動配送車輛、無人機或工業機器人而言，不只是能抵達目的地，更能精準停靠指定裝卸區、降落點或作業位置，有助於減少最後一哩仍需人工介入的環節，推動更完整的自動化作業。其他場景如智慧港口可藉由精準定位方式，提供船舶精準導航靠泊服務，取代傳統人工高危險作業方式。此次解決方案基於3GPP Release 16標準，透過LTE定位協定（LTE Positioning Protocol, LPP）傳送GNSS RTK修正資料，無須仰賴專有系統或複雜的外接硬體，即可透過行動網路提供高精準定位能力。在此次測試中，僅使用終端裝置內建天線，即實現30公分以內的戶外定位精準度；若搭配測地級（geodetic-grade）天線，更可進一步達到公分級定位精準度。此次測試採用愛立信5G核心網路，包括愛立信網路定位平台（Ericsson Network Location, ENL）及最新推出的5G Advanced定位服務（5G Advanced Location Services），並結合無線接取網路（RAN），透過行動網路高效傳送OSR及SSR修正資料。終端裝置則採用聯發科技最新5G數據機技術，可即時處理進階GNSS修正資訊，同時兼顧能源效率。愛立信RAN軟體產品負責人Johan Hultell表示：「這是5G生態系的重要里程碑。透過與聯發科技合作，我們讓高精準定位技術更容易被裝置製造商及企業採用，加速其在製造、交通運輸等領域的應用。」 聯發科技無線通訊系統發展本部總經理黃合淇表示：「此次與愛立信的合作展現5G Advanced技術如何為消費者與企業創造全新價值。聯發科技整合GNSS功能的數據機已具備支援先進定位服務的能力，為下一代智慧裝置的發展奠定基礎。」 更多鉅亨報導 • 愛立信攜手聯發科與AT&T 完成北美首例先進移動性功能實網試驗 • 愛立信：基地台帶動邊緣運算升級 網通ASIC、晶片代工台廠卡位軟硬整合新商機

【其他出處補充】（UDN）國際電信設備商 愛立信 17日宣布與 聯發科 （2454）成功完成全球首例基於3GPP標準的全球導航衛星系統（GNSS）即時動態定位（RTK）端到端測試，透過商用5G網路成功實現公寸級（Decimeter-level）高精準戶外定位，突破5G定位精準度，為需要精準定位資訊的工業及自動化應用帶來重要突破，更加速自駕車、無人機與智慧製造應用 愛立信表示，傳統GNSS通常僅能提供數公尺等級的定位精準度。（UDN）訂閱《科技玩家》YouTube頻道！（UDN）💡 追新聞》》在Google News按下追蹤，科技玩家好文不漏接！（UDN）📢 iPhone 18 Pro各國售價比一比！（UDN）飛日韓買可能更貴 它比美國高1.7萬 📢2026蘋果發表會懶人包／6大新品重點 iPhone摺疊機74900元起 📢最貴iPhone不完美！（UDN）iPhone Duo 5缺點1次看 📢 蘋果iPhone Duo可用觸控筆！（UDN）對決Galaxy Z Fold8、1圖看7大比較 📢iPhone 18缺席！（UDN）蘋果2階段發表「很聰明」 5大銷售策略玩心理戰 📢 iPhone 18 Pro、iPhone 17Pro買誰？（UDN）一文掌握升級亮點 愛立信 聯發科 登入後開始簽到 會員來簽到 您即將前往會員中心 登入簽到送 LINE POINTS 🪙 您即將前往會員中心 每日打卡送 LINE POINTS 🪙 立即登入 立即前往（鉅亨網）〈央行理監事會〉利率連10凍、對房市鬆綁 楊金龍不跟進美國升息：走自己的路 債市已跌到「最大痛苦點」 華爾街資金喊「太便宜」開始搶進長債 比AI投資更驚人！（鉅亨網）庫克13年砸8790億美元 做了這件事 英特爾喊話打破台積電壟斷！（科技新報）此次測試將 RTK 修正資料整合至 5G 網路，透過商用 5G 網路與終端裝置內建天線實現 30 公分內的戶外定位精準度。（科技新報）愛立信指出， 高精準定位可支援自動配送車輛、無人機及工業機器人精準抵達指定作業位置，減少最後一哩人工介入，進一步推動智慧製造、物流及港口等場景的自動化應用。（科技新報）（首圖來源：愛立信） 延伸閱讀： 串聯 4,000 顆處理器！（科技新報）華為 Ascend 960 首導入 NPO，靠「堆晶片」拚超大算力 黃仁勳估中國 2030 年成功自研先進曝光機，外媒揭目前技術落差 文章看完覺得有幫助，何不給我們一個鼓勵 請我們喝杯咖啡 想請我們喝幾杯咖啡？（科技新報）每杯咖啡 65 元 x 1 x 3 x 5 x 您的咖啡贊助將是讓我們持續走下去的動力 總金額共新臺幣 0 元 《關於請喝咖啡的 Q & A》 留給我們的話 取消 確認 從這裡可透過《Google 新聞》追蹤 TechNews 科技新知，時時更新 科技新報粉絲團 加入好友 訂閱免費電子報 --> 關鍵字: GNSS , 愛立信 , 聯發科（經濟日報）※ 歡迎用「轉貼」或「分享」的方式轉傳文章連結；未經授權，請勿複製轉貼文章內容

</details>

## 00934換股納群聯、長榮航 除息旺季後鎖定低基期成長股

- 第一層：鉅亨｜2026-09-17 10:16｜https://news.cnyes.com/news/id/6586252
- 第二層命中同故事 2 則（±8h、Dice≥0.5）｜本則耗時 **2.5s**、請求 7 次

| 出處 | 標題 | 時間 | Δt(h) | 相似 | 取內文步驟 | 字數 |
|---|---|---|---|---|---|---|
| 鉅亨 | 00934換股納群聯、長榮航 除息旺季後鎖定低基期成長股 | 2026-09-17 10:16 | — | 種子 | feed 自帶正文 | 293 |
| CMoney | 00934換股納群聯、長榮航 除息旺季後鎖定低基期成長股 - CMoney | 2026-09-17 10:41 | 0.4 | 0.89 | Google 解碼→www.cmoney.tw → 直接抓 HTTP 200 正文 230 字 | 230 |
| news.cnyes.com | 00934換股納群聯、長榮航 除息旺季後鎖定低基期成長股 - news.cnye | 2026-09-17 10:16 | 0 | 0.82 | Google 解碼→news.cnyes.com → 直接抓 HTTP 200 正文 1712 字 | 1712 |

**合成結果**：底稿 news.cnyes.com（1712 字），其他出處補充 3 句。

<details><summary>合成全文（1994 字）</summary>

台股 00934換股納群聯、長榮航 除息旺季後鎖定低基期成長股 鉅亨網記者陳于晴 台北 2026-09-17 10:16 台股除權息旺季告一段落，高股息 ETF 布局重心也迎來轉換。中信成長高股息( 00934-TW )迎來成分股調整，本次新增群聯( 8299-TW )、長榮航( 2618-TW )、興富發( 2542-TW )、文曄( 3036-TW )及中興電( 1513-TW )等股票，刪除聯發科、緯穎、亞翔及大立光等成分股，並提高鈊象、技嘉等持股權重。整體布局從除權息旺季掌握股利收入，轉向更重視企業成長潛力的攻擊型配置，鎖定相對低基期、具營運成長或復甦空間的投資機會。00934換股納群聯、長榮航 除息旺季後鎖定低基期成長股。(鉅亨網資料照) 本次新增成分股中，以群聯權重6.72%最受矚目，一舉躍居第三大成分股；長榮航、興富發及文曄權重則分別為2.77%、2.72%及2.27%，中興電為1.74%。既有成分股方面，鈊象權重增加3.53個百分點至6.79%，成為第二大成分股；技嘉增加2.52個百分點至3.07%，大聯大及可成的權重也同步提高，呈現電子與非電子產業並進的布局方向。‌ 從產業配置觀察，相較上半年調整，航運業比重由7.02%提高至12.01%，文化創意由3.26%提高至6.79%，電子通路則由2.24%提高至5.41%。半導體、電腦及週邊設備比重雖分別降至22.01%及20.60%，仍是投資組合的兩大核心，顯示此次調整是在保有科技產業參與度的同時，擴大尋找其他產業的成長機會。00934經理人張圭慧表示，本次換股的重點，在於「攻擊型」配置不單以科技股比重高低判斷，更著重下一階段的獲利成長來源。新增群聯、提高威剛權重，使記憶體相關布局更加鮮明；搭配廣達、華碩及技嘉等持股，保留AI與運算硬體題材的參與空間，再透過鈊象、航運及電子通路等不同產業，分散成長動能來源。除權息旺季過後，選股焦點也由當年度股利，逐步轉向未來營運表現。此次調整主軸為尋找相對低基期且具成長性的企業，除了觀察股價位置，更重視獲利能否改善、產業需求是否回升，以及成長前景是否已充分反映於評價，藉由定期換股調整配置，爭取下一階段的資本增值機會。00934今年的績效與配息表現，也呼應其兼顧成長與收益的產品定位。配息方面，今年5月、6月每受益權單位配發0.25元，7月、8月提高至0.30元，9月進一步增至0.33元，較前次增加一成；今年以來含息報酬率已超過五成，且9月初股價亦改寫掛牌以來新高，反映高股息策略也能參與成長股行情。⁠ 此次換股後，00934調整後前十大成分股依序為廣達、鈊象、群聯、長榮、華碩、威剛、聯詠、技嘉、瑞昱及漢唐，涵蓋AI、遊戲、記憶體與航運等領域。隨著布局重心轉向企業成長潛力，00934透過成分股汰換與權重調整，持續落實成長與高息兼顧的投資策略，適合不想錯失台股成長、同時又有收益需求的投資人分批佈局。※免責聲明：文中所提的個股、基金、期貨商品內容僅供參考，並非投資建議，投資人應獨立判斷，審慎評估風險，自負盈虧。美股科技產業將迎來黃金十年成長前景?掌握全球財經資訊 點我下載APP ‌ 文章標籤 台股ETF 00934 換股 群聯 更多 相關行情 台股首頁 我要存股 群聯 1970 -0.76 % 長榮航 42.05 +1.82 % 興富發 46.85 +2.07 % 文曄 204 +6.81 % 中興電 165 +1.54 % 中信成長高股息 29.47 +0.17 % 更多 鉅亨贏指標 了解更多 # 定海雙針 興富發 84.62 % 勝率 # 帶量突破均線糾結 興富發 84.62 % 勝率 # 極短線強勢 興富發 84.62 % 勝率 # 極短線弱勢 群聯 74.07 % 勝率 延伸閱讀 〈焦點股〉中信00406A年化配息率上看17%吸睛 居ETF成交量冠軍 ‌ 鉅亨講座 看更多 講座 公告 上一篇 「E」人更多了！貝萊德調查台灣ETF滲透率53%冠亞太 明年配置意願飆至74% 下一篇 00981A除息前夕灌入2.4億元 首日填息近6成 10/13股息入帳 0

【其他出處補充】（鉅亨）台股除權息旺季告一段落，高股息 ETF 布局重心也迎來轉換。（CMoney）鉅亨網 cnYES.com 10小時前 長榮航 00934 中信成長高股息 興富發 中興電 鈊象 展開 +5 00934換股納群聯、長榮航 除息旺季後鎖定低基期成長股 加入Google偏好 將網站加入你的 google 偏好搜尋來源，更容易搜尋到喜愛的內容 台股除權息旺季告一段落，高股息 ETF 布局重心也迎來轉換。（CMoney）中信成長高股息(00934-TW)迎來成分股調整... 查看全文 0 0P 0則留言 分享 留言 讚 取消 送出 留言... 目前沒有任何討論

</details>

## 《櫃買市場券商買超前30名 3-2》韋僑(301)、光頡(296) - 富聯網

- 第一層：Google News 個股 RSS（分類 feed 無此股）・富聯網｜2026-09-17 07:33｜https://news.google.com/rss/articles/CBMiiAFBVV95cUxOWXhqaV9pdUZ0eGtWY2xXT2pGTTlDeGJiMzlZRUZLX01TWjQyRVJmSWxjRGQ2empWeGFqR3B3ZzFnZkt5NUNtYUZ1cmdZSkR3eFhHSTZNUU50VFBNTFA4N1BEaE10Q19RZWE1aXhXLVc3VkZoaUlJTEJXY1ZfU1N0eGpJcExjcS1m
- 第二層命中同故事 1 則（±8h、Dice≥0.5）｜本則耗時 **41.3s**、請求 9 次

| 出處 | 標題 | 時間 | Δt(h) | 相似 | 取內文步驟 | 字數 |
|---|---|---|---|---|---|---|
| 富聯網 | 《櫃買市場券商買超前30名 3-2》韋僑(301)、光頡(296) - 富聯網 | 2026-09-17 07:33 | — | 種子 | Google 解碼→ww2.money-link.com.tw → 直接抓 HTTP 200 正文 0 字 → headless Chrome 正文 0 字 | 0 |
| 富聯網 | 《櫃買市場券商買超前30名 3-2》韋僑(301)、光頡(296) - 富聯網 | 2026-09-17 07:33 | 0 | 1 | Google 解碼→ww2.money-link.com.tw → 直接抓 HTTP 200 正文 0 字 → headless Chrome 正文 0 字 | 0 |

**合成結果**：底稿 無可用內文，其他出處補充 0 句。

<details><summary>合成全文（0 字）</summary>

（無）

</details>


## 請求紀錄（39 次，合計 51.0s）

| 目標 | 狀態 | ms |
|---|---|---|
| https://news.ltn.com.tw/rss/business.xml | 200 | 143 |
| https://money.udn.com/rssfeed/news/1001/5591?ch=money | 200 | 153 |
| https://money.udn.com/rssfeed/news/1001/5590?ch=money | 200 | 183 |
| https://technews.tw/feed/ | 200 | 231 |
| https://news.cnyes.com/rss/v1/news/category/tw_stock | 200 | 328 |
| https://www.moneydj.com/KMDJ/RssCenter.aspx?svc=NW&fno=1&arg=X0000000 | 200 | 353 |
| https://feeds.feedburner.com/ettoday/finance | 200 | 502 |
| https://feeds.feedburner.com/rsscna/finance | 200 | 541 |
| https://tw.stock.yahoo.com/rss?category=tw-market | 200 | 988 |
| https://news.google.com/rss/search?q=%E5%85%89%E9%A0%A1&hl=zh-TW&gl=TW&ceid=TW:z | 200 | 824 |
| https://news.google.com/rss/search?q=%E8%81%AF%E7%99%BC%E7%A7%91&hl=zh-TW&gl=TW& | 200 | 37 |
| https://money.udn.com/money/story/5612/9761488 | 200 | 162 |
| https://news.google.com/rss/articles/CBMiUEFVX3lxTFBtUWdJTEhYenNKYXJMel80cXAzT1F | 200 | 212 |
| https://news.google.com/_/DotsSplashUi/data/batchexecute | 200 | 139 |
| https://udn.com/news/story/7240/9761488 | 200 | 144 |
| https://news.google.com/rss/articles/CBMiWkFVX3lxTE5RRXdDdEx2VTE2bllndlJkYjdoT1h | 200 | 189 |
| https://news.google.com/_/DotsSplashUi/data/batchexecute | 200 | 177 |
| https://money.udn.com/money/story/5612/9761488 | 200 | 135 |
| https://tw.stock.yahoo.com/news/%E6%84%9B%E7%AB%8B%E4%BF%A1%E6%94%9C%E6%89%8B%E8 | 200 | 414 |
| https://news.google.com/rss/articles/CBMiS0FVX3lxTE5JZkdQMXB4YlJNUTczakg3bUxJOWZ | 200 | 248 |
| https://news.google.com/_/DotsSplashUi/data/batchexecute | 200 | 115 |
| https://m.cnyes.com/news/id/6608970 | 200 | 931 |
| https://technews.tw/2026/09/17/ericsson-mtk-gnss/ | 200 | 116 |
| https://news.google.com/rss/search?q=%E7%BE%A4%E8%81%AF&hl=zh-TW&gl=TW&ceid=TW:z | 200 | 28 |
| https://news.google.com/rss/articles/CBMiWEFVX3lxTE02Zld2clVtalExT09fX0o4SGdrVG5 | 200 | 186 |
| https://news.google.com/_/DotsSplashUi/data/batchexecute | 200 | 173 |
| https://www.cmoney.tw/forum/article/184757677 | 200 | 1391 |
| https://news.google.com/rss/articles/CBMiT0FVX3lxTFA2cHN6cTloN3N2UmQ1UkJzMzhXMFU | 200 | 194 |
| https://news.google.com/_/DotsSplashUi/data/batchexecute | 200 | 128 |
| https://news.cnyes.com/news/id/6586252 | 200 | 406 |
| https://news.google.com/rss/search?q=%E5%85%89%E9%A0%A1&hl=zh-TW&gl=TW&ceid=TW:z | 200 | 31 |
| https://news.google.com/rss/articles/CBMiiAFBVV95cUxOWXhqaV9pdUZ0eGtWY2xXT2pGTTl | 200 | 249 |
| https://news.google.com/_/DotsSplashUi/data/batchexecute | 200 | 110 |
| https://ww2.money-link.com.tw/RealtimeNews/NewsContent.aspx?SN | 200 | 86 |
| chrome:https://ww2.money-link.com.tw/RealtimeNews/NewsContent.aspx?SN | dom | 20025 |
| https://news.google.com/rss/articles/CBMiiAFBVV95cUxOWXhqaV9pdUZ0eGtWY2xXT2pGTTl | 200 | 531 |
| https://news.google.com/_/DotsSplashUi/data/batchexecute | 200 | 125 |
| https://ww2.money-link.com.tw/RealtimeNews/NewsContent.aspx?SN | 200 | 84 |
| chrome:https://ww2.money-link.com.tw/RealtimeNews/NewsContent.aspx?SN | dom | 20022 |

非投資建議。
