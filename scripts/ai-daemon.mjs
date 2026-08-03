#!/usr/bin/env node
// ============================================================
// Resident local-AI daemon (premium feature backend).
// Runs continuously (LaunchAgent, auto-start on login):
//   • Heartbeat → system/ai-daemon every 60s (app shows 🟢/🔴 status).
//   • Every ANALYZE_MS: for each premium+ user, analyse each holding
//     with local Ollama (holding P&L + enriched rating + 1-month news +
//     注意/處置股 swing advice + AI 推估目標價) → users/{uid}/data/portfolioAnalysis.
//
// Env: GOOGLE creds via ADC (gcloud auth application-default login) or
//      FIREBASE_SERVICE_ACCOUNT; APP_BASE (default deployed app);
//      OLLAMA_URL, OLLAMA_MODEL (default gemma4:latest);
//      ANALYZE_MS (default 1800000), HEARTBEAT_MS (default 60000).
//
// Start:  node --env-file=.env.local scripts/ai-daemon.mjs
// Install as LaunchAgent:  bash scripts/install-ai-daemon.sh
// ============================================================

import os from 'node:os';
import webpush from 'web-push';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeApp, applicationDefault, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// ── env (fallback .env.local loader) ──
if (!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID && !process.env.FIREBASE_PROJECT_ID) {
  try {
    const txt = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
    for (const line of txt.split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, ''); }
  } catch { /* ignore */ }
}
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
const APP_BASE = process.env.APP_BASE || 'https://tw-stock-helper.web.app';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
// 2026-08-02 換回 gemma4（qwythos 為 2026-06-25 起的試用，說明書載明「若仍幻覺則換回」）。
// 換模型前的實測（同一組提示、同一台機器）：
//   · NL選股 JSON 解析 5 題：gemma4 5/5 正確、21.2s；qwythos 3/5，且錯得危險——
//     「rsi10日超過60」寫成 rsi10Min:61（憑空改數字）、「回檔超過三成」把上界
//     寫成下界 offHigh60Min:-30（語意完全相反）。
//   · 長文分析：gemma4 21.2s／qwythos 26.3s，兩者皆無編造數字、無 think 外洩。
// gemma4 慣用 Markdown，已在 cleanLLM 一併正規化。
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma4:latest';
const HEARTBEAT_MS = parseInt(process.env.HEARTBEAT_MS || '60000', 10);
const ANALYZE_MS = parseInt(process.env.ANALYZE_MS || '1800000', 10);
// News refresh: every 15–30 min (clamped); writes to the local second brain.
const NEWS_MS = Math.min(30, Math.max(15, parseInt(process.env.NEWS_MIN || '20', 10))) * 60000;
const NEWS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'second-brain', 'news');
const MARKET_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'second-brain', 'market');
const HOST = os.hostname();

if (!PROJECT_ID) { console.error('✖ Missing project id. Run with --env-file=.env.local'); process.exit(1); }

let app;
try {
  const svc = process.env.FIREBASE_SERVICE_ACCOUNT;
  app = svc ? initializeApp({ credential: cert(JSON.parse(svc)), projectId: PROJECT_ID })
            : initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
} catch (e) {
  console.error('✖ Admin init failed. Run `gcloud auth application-default login`. Detail:', e.message);
  process.exit(1);
}
const db = getFirestore(app);
// 單次執行模式：`node scripts/ai-daemon.mjs --run <job>`。
// 本 daemon 原本無法單獨測試任何一個 job——只能等排程時間到、或改窗口再重啟，
// 於是「上線前驗證」變成猜謎（2026-08-03 為此卡了兩次，第一次還差點讓錯誤數字過夜）。
// ONESHOT 時所有常駐迴圈都不啟動，只跑指定 job 然後退出。
const ONESHOT = process.argv.includes('--run') ? (process.argv[process.argv.indexOf('--run') + 1] || '') : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 常駐穩定性：Node 預設遇到未捕捉的 rejection/exception 會直接退出→被 launchd
// throttle 後看似停擺(問 AI 沒回應)。改為記錄並繼續，確保 daemon 永不因單一錯誤崩潰。
process.on('unhandledRejection', e => { try { console.log(new Date().toISOString(), '⚠ unhandledRejection:', (e && e.message) || e); } catch { /* noop */ } });
process.on('uncaughtException', e => { try { console.log(new Date().toISOString(), '⚠ uncaughtException:', (e && e.message) || e); } catch { /* noop */ } });
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ── heartbeat ──
// 連線看門狗（2026-07-29 事故：Firestore 連線斷掉但行程仍活著，KeepAlive 不會重啟，
// 導致當日新聞/歸檔等全部靜默失敗 10 小時）。連續失敗達門檻即主動結束，交由 launchd 重啟。
let _hbFail = 0;
const HB_FAIL_EXIT = 8;   // 心跳每分鐘一次 → 連續 8 分鐘寫不進去＝連線已死
async function heartbeat(extra = {}) {
  try {
    await db.collection('system').doc('ai-daemon').set(
      { active: true, lastHeartbeat: Date.now(), host: HOST, model: OLLAMA_MODEL, ...extra },
      { merge: true },
    );
    if (_hbFail) { log(`✓ Firestore 連線恢復（先前連續失敗 ${_hbFail} 次）`); _hbFail = 0; }
  } catch (e) {
    _hbFail++;
    log(`⚠ heartbeat write failed(${_hbFail}/${HB_FAIL_EXIT}):`, e.message);
    if (_hbFail >= HB_FAIL_EXIT) {
      log(`✖ Firestore 連線持續失敗 ${_hbFail} 次——主動結束行程，由 launchd(KeepAlive) 重啟`);
      setTimeout(() => process.exit(1), 500);
    }
  }
}

// ── data helpers ──
async function getJSON(path) {
  try { const r = await fetch(`${APP_BASE}${path}`); return r.ok ? r.json() : null; } catch { return null; }
}

// 清掉各模型的輸出雜訊，只留最終繁中內容。
//   · think 區塊：推理模型（qwythos）會外洩思考過程
//   · Markdown：gemma4 慣用 **粗體**／### 標題／跳脫底線（STRONG\_BUY），
//     但前端一律純文字渲染（white-space: pre-wrap），符號會原樣顯示給使用者。
//     2026-08-02 換模型時實測到，故一併正規化——換模型不該讓畫面長出星號。
function cleanLLM(s) {
  if (!s) return s;
  let t = s;
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');      // 完整 think 區塊
  t = t.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
  t = t.replace(/<think>[\s\S]*$/gi, '');               // 未閉合 think 到結尾
  t = t.replace(/<\/?think(ing)?>/gi, '');
  // Markdown → 純文字（保留內容，只脫掉標記）
  t = t.replace(/```[a-z]*\n?([\s\S]*?)```/gi, '$1');   // 圍欄程式碼區塊
  t = t.replace(/^#{1,6}\s*/gm, '');                    // 標題井號
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');              // 粗體
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2');      // 斜體（避開 **）
  t = t.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1');   // 跳脫字元 STRONG\_BUY → STRONG_BUY
  t = t.replace(/^\s*[-*]\s+/gm, '・');                  // 條列符號統一
  // 去掉開頭的客套前言。
  // ⚠2026-08-02 修正既有 bug：舊版是 `(好的|以下是|…)[^。\n]*[:：]?\s*` ——
  //   `[^。\n]*` 會一路吃到**第一個句號為止**，冒號又是可選的，於是
  //   「好的，以下是分析：現價 176，評分 93。」整句被清成空字串。
  //   呼叫端看到空字串就 `if (!out) continue`，該筆分析靜默消失、毫無錯誤訊息。
  //   改為：必須以冒號收尾、且前言長度上限 30 字（只脫掉「好的，以下是分析：」
  //   這種真前言）。寧可多留幾個字，也不要整段答案不見。
  t = t.replace(/^\s*(here'?s|sure|okay|ok|let me|好的|以下是|這是)[^。\n]{0,30}?[:：]\s*/i, '');
  t = t.replace(/^[\s；;。，,、·\-—*]+/, '');
  return t.trim();
}

// 攸關真實金錢交易的鐵則——所有會產出數字/事實的 LLM 提示都必須附上。
const STRICT_RULE = '\n\n【鐵則·攸關真實金錢交易，零容錯】(1)只能引用下方【數據】中「明確出現」的數字、價格、代號、百分比與事實；(2)嚴禁編造、推算、四捨五入或補充任何未提供的數字——尤其禁止寫出任何個股價格、指數點位、目標價、未提供的漲跌幅；(3)資料沒有的就不要提，或直接說「資料未提供」；(4)寧可內容少，也絕不可寫錯或杜撰；違反即屬重大錯誤。請全程繁體中文。';

// 台股交易規則/稅務/法規知識庫（餵 QA context，防止 AI 對規則類問題亂編）。
// 教育整理，以證交所/財政部最新公告為準；2026 現況。
const TRADING_RULES = `【台股交易規則與稅務(教育整理，以主管機關最新公告為準)】
交易時間：正常交易 09:00–13:30(無午休)；盤中零股 09:00–13:30；盤後零股 13:40–14:30；盤後定價 14:00–14:30；開盤前競價 08:30–09:00。整張=1000股。
漲跌幅：每日 ±10%(前一日收盤價)。漲停很難買、跌停很難賣，持股遇跌停當天可能無法賣出。
交易成本：手續費買賣各 0.1425%(網路多6折≈0.085%)；證交稅賣出0.3%(ETF 0.1%)，券商自動代扣。來回約0.4–0.5%。
交割 T+2：週一買週三扣款、週一賣週三入帳；賣股款需T+2才可再用。
稅務：資本利得(買低賣高價差)目前免稅(2016起停徵證所稅，截至2026未復徵)；現金股利需申報(合併計入可抵8.5%上限8萬 或 分離課稅28%，稅率<28%選合併較划算)；股票股利以面值10元計。
開戶：18歲可自行開戶(2023民法成年下修為18)，未成年需法定代理人同意。
法律紅線(刑事責任)：內線交易、炒作股票、借用他人帳戶、散布假消息。
觀察股(異常交易警示，兩級)：第一級「注意股票」=標示警示、交易方式暫不變，持續異常升級；第二級「處置股票」=約每5分鐘撮合一次(第2次處置約20分鐘)、禁止當沖、委託需預收全額款券，流動性大減、想賣賣不掉；漲跌幅不變仍±10%。處置期間第1次約10個交易日、第2次起20日、重複違規最長40日。觸發條件(擇要，以交易所公告為準)：近期多日漲跌停、成交量較60日均量暴增數十倍、短期累計漲幅過大、週轉率異常。常見套路=炒手拉高→散戶追進→列處置→流動性枯竭散戶被套。建議：見「注」暫不追高、見「處」新手完全迴避。`;

// 漲停股預測知識庫（skill：本站回測實證，92日66,029檔日、2,282漲停事件，walk-forward驗證）。
const LIMITUP_SKILL = `【漲停股預測風向(本站回測實證·非投資建議)】
回測方法：92個交易日全市場收盤庫，前段訓練後20日walk-forward驗證(模型未見過驗證期)，只用可回測的價量+法人因子(PIT安全)。基準：全市場每日約2.7%個股收盤漲停。
預測力：模型每日Top10命中率20.5%(=基準7.6倍)、Top30命中17%。誠實解讀：Top10裡每5檔約1檔隔天真漲停，是「高潛力觀察名單」非保證，8成不會漲停。
最強因子(隔日漲停率/提升倍數)：①今日已漲停→明日24.7%(6.6x，動能群聚，漲停最會預測漲停) ②近5日≥2次漲停→17.9%(4.8x) ③5日漲幅≥10%→12.4%(3.3x) ④20日漲幅≥25%→11.8%(3.1x) ⑤3個月≥6次漲停(漲停王慣性)→11.0%(2.9x)、3個月0板僅0.30x ⑥爆量(量比≥4)→10.1%(2.7x) ⑦創20日新高→9.3%(2.5x) ⑧top3熱門漲停族群→7.2%(1.9x)、族群5日≥15板1.8x、冷族群僅0.22x(漲停有強烈族群群聚性) ⑨投信買超→6.6%(1.8x)。3月漲停/族群風向三因子與動能因子相關，模型以0.3阻尼納入(變體回測Top10 20.5%→21.5%·8.0x)。
反直覺發現：外資佔量≥15%反而0.86x(外資重倉的大型股幾乎不漲停)；法人連買天數對漲停幾乎無預測力(1.05x，漲停是短線動能事件、與波段法人布局是兩回事)。
連板持續(今日漲停者明日再漲停，基準約22%)：連2板以上28.4%>首板16.3%(首板最易斷)；縮量鎖死(量比<1)29.2%>爆量漲停(量比≥4)18.3%(爆量=有人出貨)。口訣「縮量鎖死連板優於爆量首板」。
族群輪動：每日漲停冠軍族群(單日≥3板)有連莊慣性；主流退潮後的接棒族群依歷史轉換矩陣統計(樣本約60日·僅供參考)；「升溫中」族群(5日板數≥前5日1.5倍)為輪動候選；盤中30分內密集鎖停的族群＝正在發動。漲停順序流：盤中逐分記錄首次鎖停時間，觀察族群點火順序。
預測覆盤：每日自動對答案並歸因——預測失敗(強漲未鎖停/上漲乏力/翻黑回檔/族群退潮/市場轉弱)、漏網漲停(突發消息型=模型天生抓不到/排名外/流動性濾網外/訊號弱)。突發消息型漏網是價量模型的天生盲區，誠實承認。
消息面(newsDaily·鉅亨標題逐日庫，22交易日校準)：當日新聞≥2則→隔日漲停1.57x、正面極性1.64x——訊號存在但弱於價量因子，且有內生性(新聞常在報導已漲停股)；7日邊際驗證未見改善，以0.3阻尼保守納入、scoreboard每日對答案持續評估去留。
漲停前夜解剖(2026-07-20·3個月漲停王20檔·261次漲停事件 vs 同池907其他日)：漲停前一天的共同長相＝當日已大漲(均+4.08% vs 其他日+0.72%)×強尾收位pos≥0.7(55% vs 36%)×破20日高(41% vs 24%)×5日已加速(+12.5% vs +8.6%)×法人5日淨買/均量偏高(0.12 vs 0.07)——與撿尾盤定版濾網(破20日高×強尾×漲3~7%)同一張臉，獨立互證。兩大陷阱：①43%的前夜自己就是漲停鎖死日(連板環節·收盤買不到)，可買者僅56%；②漲停王名單是事後選的(倖存者偏誤)，池內基準漲停率16.4%是後見之明。可買日內最佳條件：大漲3~8.5%×破20日高→明日漲停22.8%(基準16.4x1.4)·開賣淨均+1.16%；加強尾n小但開賣+1.79%。正確用法＝先用炒作型性格+近期漲停頻率圈熱池，池內等「大漲×破高(×強尾)」可買日，隔天開盤賣；不是精準預測漲停(最好也只1/4~1/5命中)，肉在開盤溢價。
RSI 高檔≠頂點(2026-07-27·1928次訊號)：RSI5>95∧RSI10>90 當日為未來5/10/20日最高點僅 29.9/22.6/17.6%（基準28.8/21.1/15.6%·1.04~1.13x＝幾乎無抓頂能力）；連續天數不使頂點率上升但第4天後前瞻報酬跳升(5日+2.44%/10日+3.75%)＝鈍化為主升段；出場實測 抱1日-0.53%(最差·兩窗同向負)<抱3日-0.11%<抱5日+0.44%<抱10日+1.18%(最佳·兩窗同向)，跌破RSI5<90才賣+0.27%(淨勝僅33.6%)。風險則確實放大：5日內曾跌≥5% 49.9%(基準27.1%)但10日內再漲≥5%亦52.7%(基準41.2%)＝雙向波動。→ 正確操作＝移動停利、勿隔日全出。
起漲點組合(2026-07-27 網格·7區間×14條件·僅6組過關且全在低檔)：⭐最強「RSI5<20 × 法人t-1買超 × 量比>1.5(今日量÷昨日量)」5日淨均+1.11%[+0.69/+1.38]·淨勝55%·10日內漲≥5% 43.2%（基準-0.17%/43.3%/35%）；次強 RSI5<20×量比>2 (+0.59%)、×法人5日買超/均量>0.05 (+0.56%)、×距60日高<0.85 (+0.45%)。❌中性區「RSI5 50~75∧RSI10 50~70」單獨-0.26%且疊14種條件無一過關（該區佔全市場38%＝日常狀態非特殊狀態）；❌「RSI5−RSI10≥10 短線急拉」-0.36%。
RSI 與漲停的關係(2026-07-27 walk-forward 檢定·不入模型)：單因子漲停率天花板僅 5.75%（雙RSI5/10≥90且連續·2.79x），低於 ret5≥10% 的 5.98%；加進模型後 Top10 命中 8.18%→8.18~8.38%（雜訊）、Top30 隨權重加重單調惡化 7.50→7.26%；當濾網更差（只留RSI5≥85 → Top30 掉到 4.93%，被篩掉的正是「模型認定強但RSI未衝高」的啟動第一天）。根因＝冗餘：RSI 是近5/10日漲跌幅的正規化，模型已直接吃 chg0/ret5/ret20 原始版本（日均 Spearman 0.459）；佐證：雙RSI≥90 但 ret5<10% 者漲停率僅 1.03%（基準一半）——高RSI的預測力幾乎全部來自「剛大漲過」。⚠反直覺：坊間「RSI 90+ 該賣」在台股資料上是最高漲停機率區（動能鈍化續航），持股警示因此建議分批而非全出；反之「RSI 超跌抄底搏漲停」的 27% 是崩跌段假象（四分段 0%/5.3%/38.8%/6.0%），平常期僅1~2%低於基準。
隔日沖選股坊間SOP檢定(2026-07-27·使用者提供三張方法論圖·720日64.2萬樣本)：①高週轉率——方向正確但1%後飽和：週轉<0.5%冷門股明開賣兩窗同向負(-0.089/-0.127)、≥1%以上各桶皆正但不再遞增→價值在「排除冷門」不在「追高週轉」，已納入撿尾盤濾網下限0.5%(第三獨立窗複驗通過)。②布林通道上軌——單獨不成立(兩窗未過)，配紅K強尾後開賣端勉強過關但regime反向(多+0.082/空-0.126)。③**「收盤收在當日相對高點/紅K」是坊間最大誤區**：紅K×收位≥0.9 明收賣-0.177/-0.171、明開賣-0.156/-0.180(雙口徑兩窗regime全同向負·淨勝32.8%)；紅K×收位≥0.7 亦為負——與本站「強尾單獨-2」「貼日內高pos≥0.9為五方案最差」三度互證。只有配「突破20日新高」時貼高才轉正。④完整SOP組合(高週轉×量放大×上軌×紅K強尾)開賣+0.221/+0.180確為正，但與現行定版濾網(+0.224/+0.222)幾乎相同且樣本少78%＝同一edge的不同寫法；疊到現行濾網上無增量(全部未改善、後半窗反而降)。
操作紀律：漲停股鎖死買不到→用漲停鎖死策略排隊；追高風險極大，處置股禁入；模型分數僅供排序觀察，單筆風險≤1%。`;

// 法人倒貨獲利了結知識庫（skill：120日444個倒貨episode實證，2026-07-16）。
const DIST_SKILL = `【法人倒貨獲利了結實證(本站120日回測·非投資建議)】
倒貨episode定義：三大法人累計籌碼創峰值後回落≥30%（444檔）。實證中位數：加碼5,176張(≈3倍日均量)、加碼期漲21%、加碼28個交易日、67%賣在20日高附近、倒貨後股價-10.1%(法人確實賣在相對高點)。加碼越多賣越狠：漲<10%組加碼1,913張 vs 漲≥60%組12,109張。
最強領先訊號：95%的倒貨案例由「外資先轉賣、投信未跟」開始；有貨在手(5日累計≥500張)時該型態後5日中位-0.33%(唯一負值組)。反直覺：外資投信「雙賣」反而+0.32%(多為強勢後調節、跌幅有限)——危險的是外資單獨先跑，不是雙賣。
融資接棒：外資賣+融資增後5日-0.32% vs 賣+融資減-0.17%——方向對但差距小(弱訊號)，僅作附註。
漲停與倒貨是不同因素：漲停前一日法人買超占比58%(基準48%)、前5日法人累計中位僅78張——漲停=短線動能事件、法人加碼=週~月布局。漲停後5日法人59%轉賣、轉賣者股價中位-2.7%——法人重倉股攻漲停常是「出貨日」(散戶追停接手)而非加碼日。
持股警示已依此升級：「外資先轉賣+有貨在手」=🔻倒貨領先訊號優先減碼；雙賣=調節提示；融資增=散戶接棒附註。`;

// 主力洗融資/洗盤知識庫（skill：2026-07 實測校準版，Yahoo ^TWII 6.6年+證交所 MI_MARGN 驗證）。
const WASHOUT_SKILL = `【牛市洗盤(洗融資)實測校準版(本站驗證·非投資建議)】
驗證方法：加權指數2019-12~今日線+證交所官方市場融資餘額，對 2020/2021/2023/2024 四段牛市修正實測。
✅成立：牛市中 6~13% 的指數修正，低點後6個月指數再漲 17~32%（4/4段全數反彈）——修正不是牛市終點，「跌了就永久出場」歷史上是錯的。實測範圍：修正6.7~12.7%、歷時1.9~19.7週（快洗2-3週、慢洗可達半年）、熱門股修正常為指數2~3倍。
❌流傳圖卡的誇大處：融資降15-30%才洗完＝4段僅1段吻合（2021 -20%），2023邊洗融資邊增、2024僅-2.5%——「融資大降」非必要條件；洗完後漲幅普遍被高報5~10個百分點。
🚨最重要的反例（倖存者偏差警示）：2024-07-11高點起跌，前3.6週-18.7%、融資-8.1%，每個「洗盤特徵」都像，實際是-28.7%、39週大空頭開端（其後僅弱反彈）。洗盤與空頭開端「事前無法區分」——任何宣稱能區分的說法都不可信。
可操作的紀律（依實測風險分層）：修正<5%=正常波動；5~13%=歷史洗盤區間→降槓桿(融資戶最優先)、不接刀、不梭哈、保留現金等確認；>15%=超出全部歷史洗盤範圍→按空頭劇本防禦（2024/7與2022皆如此展開）。
洗完確認訊號（等訊號再進場，別猜底）：①外資由賣轉連買（法人回補最重要）②量縮後首次放量收紅 ③指數站回月線且不破 ④融資止穩不再降。四訊號至少兩個成立才視為主升段啟動。`;

// 財報體質知識庫（skill：本站近2年8季財報庫·MOPS官方·回測實證）。
const FIN_SKILL = `【財報體質與本益比(本站實證·非投資建議)】
資料庫：上市櫃約1,971檔·近2年8季（損益/營益分析/資產負債，MOPS官方彙總表）。注意：MOPS Q2/Q3/Q4損益為年度累計，本站已換算單季後才計算TTM與YoY。
體質分(0-100)：獲利性30(TTM EPS>0/淨利率/ROE)＋成長性30(EPS年增/連續成長季數/營收年增)＋穩定性20(8季虧損季數)＋評價20(絕對PE帶)。
回測實證(2個財報公布事件·後20日)：最低分組跑輸大盤3.2-3.6個百分點、最高與最低分組價差最高+6.8pt、勝率45%→66%——體質分最大價值是「避開爛財報」，權重設計為重罰低分(<20扣3)、輕獎高分(≥80加2)，×1.5併入選股AI排序（與法人加權同尺度）。
PE反直覺實證：財報公布後20日，最便宜PE組僅+1.4%、最貴PE組+20.6%（成長動能行情低PE反向）——本益比在短線選股「只做評價位階展示、不做方向性加權」；低PE撿便宜是波段/存股邏輯，不是隔日沖邏輯。
持股基本面警示：體質分<20（近8季多季虧損）或 高PE(>60)＋EPS年減 → 每日提醒基本面不支撐/評價背離。
限制：僅2事件、多頭季樣本；季報一季才更新一次，適合波段品質濾網、與短線籌碼/動能因子互補而非取代。`;

// 波段起漲技能（2026-07-27 使用者定案·5日持有語意·與隔日沖模型口徑分離）
const SWING_SKILL = `【波段起漲選股（本站實證·持有5個交易日·非隔日沖）】
⚠口徑聲明：本訊號隔日開賣 -0.06%／隔日收賣 -0.44%／持有5日 +1.10%——edge 全在第5日，**不可用隔日沖的方式操作，也不併入隔日沖綜合評分**。
訊號＝三層漸嚴（940日80萬樣本·真起漲定義＝今日之後5日不再破底 且 期間曾漲≥5%；全市場基準真起漲14.9%／5日淨勝44.2%／淨均-0.08%）：
⭐三重確認：RSI5<20（跌深粗篩）∧ 法人t-1買超（外資+投信>0）∧ 量比>1.5（今日量÷昨日量）→ 真起漲18.6%·淨勝55.8%·5日淨均+1.10%·日均5.9檔
【波動 gate·2026-08-02 新增】＋vol20≥1.5%（20日日報酬標準差）→ 主窗 真起漲18.9→21.5%·5日均1.035→1.615%·淨勝55.7→59.1%；OOT 真起漲17.0→24.0%·5日均0.919→1.447%·淨勝56.9→60.1%。主窗兩半[2.295/0.278]、OOT兩半[1.99/1.05]、主窗逐年三段與OOT兩年全部改善，留存79.9%/66.8%。被排除的低波動組是**純負貢獻**：主窗 真起漲僅8.6%·5日均-1.268%·淨勝42.2%／OOT 真起漲3.1%。
⚠此 gate 只收 1.5%，不用更嚴門檻：≥2.5%/≥3% 的主窗數字漂亮（5日均+4.5%/+6.4%）但那是 2025-04 崩跌反彈的 artifact——⭐訊號有20%集中在2025-04-08與04-09兩天，把那兩檔的主窗後半拆開來看是負的(-0.194/-0.49)、2026年也是負的。這是「均值被單一行情灌爆」的典型，不可信。
⚠口徑隔離再強調：同一個 vol20，隔日沖那側是「<1.5%扣2分」的避開訊號（明開賣Δ-0.199%），波段這側是「≥1.5%才進場」的 gate——**數字相同、機制不同**，前者是低波動股跳空幅度小扣不掉費稅，後者是低波動股根本彈不動（真起漲8.6% vs 21.5%）。不要互相推論。
【KD交叉·破底風險模組·2026-08-02 新增】使用者提「KD交叉+MA5/10+RSI5/10 同測波段漲幅成功率」，完整檢定後結論是**假設被推翻但換到更有用的東西**：
· KD 交叉**不是漲幅指標**。把真起漲拆成「不破今低」與「5日內漲≥5%」兩成分後：金叉把不破底 28.1→42.6%(主窗)／34.4→49.7%(OOT)，但漲≥5% 是 35.2→34.4%／31.1→30.1%＝**零貢獻甚至微負**。死叉鏡像（不破底19.2%/24.7%、漲≥5% 34.0%/31.9%≈基準）。波動五分層×兩窗10格：對不破底 Δ+13.2~+17.0pp 全中，對漲≥5% Δ-3.2~+3.3pp 且換號。
· ⇒ 先前看到的「金叉真起漲23.5% vs 基準17.9%」提升**全部來自不破底那一半**，誤讀成「比較會漲」是錯的。推漲幅的是 vol20（漲≥5% 35.2→40.6%／31.1→39.0%），兩者**正交互補**，合流組數字正好是兩者相加，無交互作用。
· 可用查表（5日內會破今日最低的機率）：**RSI5與RSI10同日雙上穿80 47.4%/39.5%（目前最低·最強）**｜KD金叉 57.4%(主窗)/50.3%(OOT)｜無交叉≈基準 71.9%/65.6%｜死叉 80.8%/75.3%｜僅RSI10上穿(RSI5未過80) 80.3%/75.7%（最高·別碰）。
  ⚠「同日雙上穿」的優勢**只在當天**：3日內雙上穿的不破底優勢掉到 +0.6/+1.1pp、5日內轉負(-1.1/-0.6pp)——是當日事件不是狀態，隔天就失效。這是本技能「破前低無條件停損」那條規則的觸發機率預測器——死叉時預期五次有四次會停損，部位要更小或乾脆不進。
· ⚠三指標**疊不進 ⭐**：⭐核心是 RSI5<20（還在破底），與「站上MA5」樣本數 0、與「KD金叉」僅 32/1,933(1.7%)＝定義上互斥，不是資料不足而是結構衝突。
· ⚠出場規則也救不回來：測過目標+3/5/8% × 停損(破今低/-5%/-8%/不停損) 共12種組合，主窗每一格的平均都是負的，OOT 每一格都比單純抱到第5日差。破今低停損在5日尺度太緊——觸發率47~62%。
【RSI高檔·漲幅機率查表·2026-08-02 補測】使用者指正上一輪只測 RSI 低檔沒測高檔。補測後高檔側的行為與低檔側完全不同：
· **RSI 高檔是真的推「漲幅」**（與 KD 只推「不破底」相反）。5日內曾漲≥5% 的機率（主窗/OOT，全市場基準 35.2%/31.1%）：
    RSI5>80 → 39.6%/34.1%｜RSI5>90 → 43.1%/36.9%｜RSI10>80 → 47.3%/39.1%
    **RSI5與RSI10「同時」>80（雙高）→ 47.3%/38.9%**｜雙高>85 → 48.6%/42.7%
    **雙高 ∧ vol20≥1.5% → 52.6%/46.7%**（最高·n=7,856/4,651）
  五個波動分層控制皆通過＝不是「高檔股波動大」的代理。
· **單5 與 單10 是分工的，必須同時才完整**（對照組實測·2026-08-02 補測）：
    僅RSI5上穿(RSI10未過80) → 漲≥5% 僅 +2.1/+1.3pp、不破底 +0.0/+0.3pp ＝**兩者皆近乎無效**
    僅RSI10上穿(RSI5未過80) → 漲≥5% +10.9/+5.5pp，但**不破底 -8.3/-10.1pp**（更容易破底）·波動控制✗
    雙高>80 → 漲≥5% +12.1/+7.8pp **且** 不破底 +6.0/+6.7pp ＝雙重效果
  ⇒ **RSI10 是漲幅的來源、RSI5 是不破底的來源**。只看 RSI10 會拿到漲幅但同時把破底風險放大 10pp。
· **MA 條件在 RSI 雙高母體內是 no-op**：雙高 n=9,189，加 MA5>MA10 只掉到 9,185、加站上MA5&MA10 掉到 9,144（99.5%）。RSI 高檔已經蘊含均線多頭排列——這解釋了為何「KD+MA+RSI 三指標合流」怎麼組都沒有加值：MA 那一項根本沒有篩掉東西。
· ⚠**但機率高不等於賺錢——這是賠率問題**。上述所有高檔組合的 5 日淨均在主窗**全部為負**（-0.40~-0.56%）、中位數 -1.2~-1.6%。原因：摸到+5%的那 52.6% 就算全部在 +5% 出掉，**沒摸到的 47.4% 第5日平均賠 6.5%**——上檔被目標價封頂、下檔沒有封底。
· ⚠出場規則救不回來：目標+3/5/8% × 停損(破今低/-5%/-8%/不停損) 共12組，主窗每一格皆負、OOT 每一格都比單純抱到第5日差。
· ⇒ **正確用法是「機率參考」不是「買進訊號」**：RSI10>80 時可預期一半機率會出現 5% 以上的波段，但別用收盤買進+機械持有的方式去接——那個結構的期望值是負的。
· 唯一在追強母體上兩窗一致的是**避開端**：追強 ∧ KD死叉 → 主窗 中位 -2.168%(基準-0.443%)·淨勝39.5%(46.7%)、OOT 中位 -0.605%(-0.173%)·淨勝44.0%(48.9%)、不破底 -8.0pp/-7.2pp。已在追強榜加標記。
⭐⭐強化：＋(RSI10<25 或 距60日高<0.85) → 真起漲21.5~22.0%·淨勝58.2~62.7%·淨均+1.59~+2.19%
⭐⭐⭐最嚴：＋空頭日 ∧ 量≥1000張 ∧ 距60日高<0.85 → 真起漲24.3%·淨勝63.0%·淨均+2.58%·日均僅2.2檔
條件貢獻排序（重要）：法人買超 > RSI10<25 > 空頭日/量能/深回檔 > RSI5<20 本身。RSI5<20 單獨的真起漲僅15.9%（基準14.9%）＝只是圈候選池，真正的訊息量在「有沒有人在承接」。
硬性 gate：**多頭日不用**（實測5日 -0.24%·真起漲14.4% 低於基準）；空頭日才是有效市況（+1.27%·淨勝57.3%）。
驗證強度：第三獨立窗（2022-07~2023-07·訊號設計時從未見過）+1.04%·淨勝61.5%；逐年四段全正；量≥3000張 +2.22%（越大越強＝非小型股流動性假象）。
風險（必說）：即使最嚴組合真起漲也只有24.3%——四次有三次不是真轉折（會再破底或彈不到5%）。左尾重：分批小部位、破前低無條件停損、單筆風險≤1%。非投資建議。`;

// 開盤三關選股法（當沖/短線·使用者提供之方法論，2026-07-19 導入）
// 本站實證註記：第二關「跟風漲放棄」已於日線代理驗證（日配對後跟風股仍-0.36~-1.46pp）；
// 第一關/第三關需盤中歷史，0930 快照自今起累積、權重待資料足夠後回測（data-gated）。
const TRIGATE_SKILL = `【開盤三關選股法(當沖/短線·逐關檢核·任一關不過即放棄)】
第一關·量能達標：前30分鐘(9:00-9:30)成交量 ≥ 昨日總量40%。大戶真進場前30分必卯起來吃貨；漲5%但前30分量<昨日20%＝八成是拉給散戶追的假突破。
第二關·相對強度：大盤平盤震盪(±0.5%)時個股已穩站+3%、大盤小拉回時它不跟跌＝自己強(主力在顧)；大盤拉它才拉、大盤縮它就軟＝跟風漲→放棄(做跟風股等於賭大盤，不如買台指期)。本站日線實證：漲≥3%但跑輸大盤的「跟風股」隔日極差(日配對-0.36~-1.46pp/筆·淨勝僅29%)——此關有數據背書。
第三關·拉回品質(最關鍵)：前兩關過後等拉回。攻擊段大量→拉回量縮到1/3~1/4＝健康(主力沒跑)→站回均價線進場；拉回量不縮甚至越跌越大量＝出貨→移除自選、今日不再看。
紀律：三關全過才等進場點；缺數據就說缺什麼，不猜。非投資建議。`;

async function buildTriGateLive(code) {
  try {
    const today = isoDate(taipei());
    const [d0930, sq, idxDoc] = await Promise.all([
      db.collection('snap0930Archive').doc(today).get(),
      readSnapshotQuotes(),
      db.collection('marketIndex').doc('latest').get(),
    ]);
    const q = sq?.quotes?.[code];
    const idx = idxDoc.exists ? idxDoc.data() : null;
    const lines = ['【本檔三關即時數據】'];
    if (d0930.exists) {
      const by = JSON.parse(d0930.data().byCodeJson || '{}');
      const row = by[code];
      const yv = q?.prevVolume ?? null;   // 若快照無昨量欄位則以 marginSnap yVol 補
      let yVol = yv;
      if (yVol == null) {
        const m = (await db.collection('marginSnap').doc('latest').get()).data();
        yVol = m?.byCodeJson ? (JSON.parse(m.byCodeJson)[code]?.[7] ?? null) : null;
      }
      if (row && yVol > 0) {
        const r = row[1] / yVol * 100;
        lines.push(`第一關：前30分量 ${row[1]} 張／昨日總量 ${yVol} 張＝${r.toFixed(0)}%（門檻40%）→ ${r >= 40 ? '✅過關' : '❌不足'}`);
      } else lines.push('第一關：缺前30分量或昨量資料——無法檢核');
      if (row != null && d0930.data().idxChgPct != null) {
        const rs = row[0] - d0930.data().idxChgPct;
        lines.push(`第二關(9:30時點)：個股 ${row[0] >= 0 ? '+' : ''}${row[0]}% vs 大盤 ${d0930.data().idxChgPct}%（RS ${rs >= 0 ? '+' : ''}${rs.toFixed(1)}）${row[0] >= 3 && rs < 1 ? '→ ⚠跟風型態(本站實證隔日極差)' : rs >= 2 ? '→ ✅自己強' : '→ 中性，看盤中是否跟大盤起伏'}`);
      }
    } else lines.push('今日尚無 0930 快照（9:31 後才有；歷史累積中）——第一/二關請提供前30分量與大盤對比。');
    if (q?.price > 0 && idx) lines.push(`目前：個股 ${q.changePercent >= 0 ? '+' : ''}${q.changePercent}%·量 ${Math.round((q.volume || 0) / 1000)} 張 vs 大盤 ${idx.weightedChangePercent}%`);
    lines.push('第三關(拉回量縮)：需分時量能，請看分時圖攻擊段vs拉回段量能比（目標縮至1/3~1/4）。');
    return lines.join('\n');
  } catch { return ''; }
}

// ── 預測模型核心（scripts/data/model-core.json·由 build-model-core.mjs 產生）──
// 問AI「明日可否買/賣」的唯一權重來源；權重僅能經 audit-weights.mjs 重跑驗證後更新。
let MODEL_CORE = null;
try {
  const { readFileSync } = await import('node:fs');
  MODEL_CORE = JSON.parse(readFileSync(new URL('./data/model-core.json', import.meta.url), 'utf8'));
} catch { /* 檔案缺失時 PREDICT 技能自動停用，Q&A 其餘功能不受影響 */ }

// 依模型核心計算單檔「明日隔日沖」確定性評分＋建議（給問AI 注入，LLM 只轉述不發明）
async function buildPredictSkill(code) {
  if (!MODEL_CORE) return '';
  try {
    const [snap, vDoc, mDoc, hDoc] = await Promise.all([
      readSnapshotQuotes(),
      db.collection('chipVerdicts').doc('latest').get(),
      db.collection('marginSnap').doc('latest').get(),
      db.collection('marketHealth').doc('latest').get(),
    ]);
    const q = snap?.quotes?.[code];
    const v = vDoc.exists ? (JSON.parse(vDoc.data().byCodeJson || '{}')[code] || null) : null;
    const m = mDoc.exists ? (JSON.parse(mDoc.data().byCodeJson || '{}')[code] || null) : null;
    if (!q?.price) return '';
    const tb = MODEL_CORE.tierBase, adds = MODEL_CORE.adds;
    let charLabel = null;
    try { const cd = await db.collection('chipCharacter').doc('latest').get(); if (cd.exists) charLabel = JSON.parse(cd.data().byCodeJson || '{}')[code]?.label || null; } catch { /* optional */ }
    const isCore = charLabel === '長期核心';
    let sc = v?.win ?? tb[v?.tier ?? ''] ?? tb.neutral;
    const parts = [`基底 ${sc}（${v ? `${v.tier}級實測勝率` : '無籌碼判讀·中性底'}）`];
    const price = q.price, chg = +(q.changePercent ?? 0);
    const hi = q.high ?? 0, lo = q.low ?? 0;
    const pos = hi > lo ? (price - lo) / (hi - lo) : null;
    const hi20 = m?.[6] ?? null, yVol = m?.[7] ?? 0;
    const brk = hi20 != null && hi20 > 0 && price > hi20;
    const sqzT = m != null && yVol >= 300 && (m[3] ?? 0) >= yVol * 0.005 && chg > 2;
    if (brk && pos != null && pos >= 0.7) { if (!isCore) { sc += adds.brkStrong.w; parts.push(`${adds.brkStrong.name} +${adds.brkStrong.w}`); } else parts.push('🏔破高×強尾 0（長期核心無效·性格檢定）'); }
    else if (brk) parts.push(`${adds.brk.name} 0（不計分）`);
    if (sqzT) { sc += adds.sqz.w; parts.push(`${adds.sqz.name} +${adds.sqz.w}`); }
    if (pos != null && pos >= 0.8 && Math.abs(chg) > 1 && !(brk && pos >= 0.7)) { sc += adds.strongAlone.w; parts.push(`${adds.strongAlone.name} ${adds.strongAlone.w}`); }
    if (pos != null && pos <= 0.2 && Math.abs(chg) > 1) parts.push(`${adds.weak.name} 0（僅提示·兩窗不穩）`);
    const c5 = m?.[8];
    const ret5 = c5 > 0 && price > 0 ? (price / c5 - 1) * 100 : null;
    if (adds.laggard && chg >= 3) {
      const all = Object.values(snap?.quotes || {}).map(x => +(x.changePercent ?? 0)).filter(x => Number.isFinite(x));
      const mkt = all.length > 200 ? all.reduce((t, v) => t + v, 0) / all.length : null;
      if (mkt != null && mkt >= 1 && chg - mkt < 1) { sc += adds.laggard.w; parts.push(`${adds.laggard.name} ${adds.laggard.w}（大盤+${mkt.toFixed(1)}%日僅同步漲）`); }
    }
    if (adds.overheat && ret5 != null && ret5 >= 20) { if (!isCore) { sc += adds.overheat.w; parts.push(`${adds.overheat.name} ${adds.overheat.w}（5日+${ret5.toFixed(0)}%）`); } else parts.push('🔥過熱 0（長期核心不穩·僅提示）'); }
    if ((m?.[1] ?? 0) > 0 && (v?.f ?? 0) < 0) { sc += adds.bag.w; parts.push(`${adds.bag.name} ${adds.bag.w}`); }
    if ((v?.dist ?? 0) >= 30) { sc += adds.dist30.w; parts.push(`${adds.dist30.name} ${adds.dist30.w}`); }
    sc = Math.max(5, Math.min(95, Math.round(sc)));
    const th = MODEL_CORE.thresholds;
    const zone = sc >= th.bullish.min ? th.bullish : sc >= th.neutral.min ? th.neutral : th.avoid;
    const isLeader = (MODEL_CORE.leaders || []).includes(code);
    const health = hDoc.exists ? hDoc.data() : null;
    const lines = [
      `【明日隔日沖預測模型 v${MODEL_CORE.version}（2年×41萬樣本實測校準·非投資建議）】`,
      `本檔評分：${sc} 分 → ${zone.stance}。${zone.note}`,
      `計分明細：${parts.join('、')}${isLeader ? '（本檔屬產業龍頭65檔·模型準確度較高組）' : ''}`,
      v ? `籌碼判讀：${v.a}（${v.r}）${charLabel ? `·性格：${charLabel}${isCore ? '（動能訊號對此型無效，籌碼訊號屬雜訊——隔日沖建議改挑炒作型）' : ''}` : ''}` : '籌碼判讀：無資料',
      health ? `大盤 regime：健康度 ${health.health}/100（${health.mood}）${health.health < 40 ? '——🔴空頭日全體均-0.43%/筆，regime gate 優先於個股分數，建議休兵' : ''}` : '',
      `校準表（分數→實際隔日上漲率）：<40→37.8%、40-45→44.1%、46-51→47.3%、≥52→54.0%（龍頭62.7%·淨+1.06%/筆）。來回費稅 ${MODEL_CORE.costPct}%。`,
      `鐵律：僅 ≥${th.bullish.min} 分為淨正期望；出場實測定版=明早開盤一律賣出（唯一兩窗淨正規則，開高續抱實測吐光溢價-0.33%）；單筆風險≤1%、開低無條件停損；獲利集中右尾，勿因一次虧損棄守紀律。`,
    ].filter(Boolean);
    return lines.join('\n');
  } catch { return ''; }
}

async function _ollamaRaw(prompt) {
  const ctl = new AbortController();
  // 逾時自「實際送出」起算(非排隊起算)，因為佇列已序列化只送一個。
  const t = setTimeout(() => ctl.abort(), 240000);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // think:false 關閉推理模型的思考輸出(Ollama 支援時生效，否則由 cleanLLM 兜底)。
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, think: false }), signal: ctl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const out = cleanLLM((await res.json()).response?.trim() || '');
    return out || null;
  } catch (e) { clearTimeout(t); log('⚠ ollama:', e.message); return null; }
}

// ── LLM 單一序列化佇列 ──
// Ollama 一次只能跑一個模型推論；若多個 LLM 任務(波段分析/盤後總結/個人摘要/
// 覆盤/RAG…)各自發 HTTP 請求，會在 HTTP 層堆積、後排的撞 240s 逾時。改成集中
// 佇列：同時只送一個，逾時自送出起算(等候期間不計時)；互動式 RAG 問答 priority 高、插隊。
const _llmQueue = [];
let _llmBusy = false;
function _drainLLM() {
  if (_llmBusy || _llmQueue.length === 0) return;
  _llmQueue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  const job = _llmQueue.shift();
  _llmBusy = true;
  _ollamaRaw(job.prompt).then(job.resolve, () => job.resolve(null)).finally(() => { _llmBusy = false; _drainLLM(); });
}
let _llmSeq = 0;
function askOllama(prompt, opts = {}) {
  return new Promise(resolve => { _llmQueue.push({ prompt, priority: opts.priority || 0, seq: _llmSeq++, resolve }); _drainLLM(); });
}

const ACTIONS = ['續抱', '加碼', '減碼', '出脫', '換股', '觀望'];
function parseAction(text) {
  const m = text.match(/ACTION\s*[:：]\s*(續抱|加碼|減碼|出脫|換股|觀望)/);
  if (m) return m[1];
  for (const a of ACTIONS) if (text.includes(a)) return a;
  return '觀望';
}
// 去除部分模型(如 qwythos)會原樣回傳的 <...> 範例角括號。
const stripBrackets = s => s.replace(/^[<\s「]+/, '').replace(/[>\s」]+$/, '').replace(/[<>]/g, '');
function parseTrigger(text) {
  const m = text.match(/TRIGGER\s*[:：]\s*(.+)/);
  return m ? stripBrackets(m[1].trim()).slice(0, 120) : '';
}

function buildPrompt({ code, name, pnlPct, avgCost, price, rating, news, isRisk, riskType, chip }) {
  const st = rating?.stock;
  const f = rating?.fundamentals;
  const lines = [];
  lines.push(`持股：${code} ${name}；成本 ${avgCost}、現價 ${price}、未實現損益 ${pnlPct.toFixed(2)}%`);
  if (st) {
    lines.push(`AI 技術評分 ${st.score}(${st.grade}) 訊號 ${st.signal}`);
    if (st.buyZones?.length) lines.push(`支撐買點：${st.buyZones.map(z => `${z.label}${z.price}`).join('、')}`);
    if (st.sellTargets?.length) lines.push(`目標價(AI推估)：${st.sellTargets.filter(t => t.type !== 'trailing').map(t => `${t.price}(+${t.gainPercent}%)`).join('、')}；停損 ${st.stopLoss}`);
  }
  if (f?.valuation) lines.push(`估值 PER ${f.valuation.pe}/殖利率 ${f.valuation.dividendYield}%/PBR ${f.valuation.pb}`);
  if (chip) lines.push(chip); // 可靠的逐日法人籌碼 + 勝率雷達階段 + 倒貨%（取代間歇性的 rating.institutional）
  else if (f?.institutional) lines.push(`三大法人(張) 外資 ${f.institutional.foreignNetLots}、投信 ${f.institutional.trustNetLots}`);
  const newsT = (news || []).slice(0, 6).map(n => `・${n.title}`).join('\n') || '（近一月無重大新聞）';
  lines.push(`近一月新聞/公告：\n${newsT}`);
  if (isRisk) lines.push(`⚠️ 此股為${riskType === 'disposition' ? '處置股（交易受限）' : '注意股'}。`);

  return `你是台灣股市資深操盤顧問。依下列「我的持股」數據，用繁體中文給出務實建議。
嚴格依此格式輸出：
ACTION: <續抱|加碼|減碼|出脫|換股 之一>
TRIGGER: <一句話說明何時脫手或加碼的價格/條件>
分析: <150-220字，涵蓋：損益現況、技術與籌碼解讀、近一月新聞影響、目標價評估、續抱或換股理由>${isRisk ? '\n波段建議: <因屬注意/處置股，給出波段操作建議與風險說明，80-120字>' : ''}
請勿杜撰數據。結尾不需免責聲明。${STRICT_RULE}

【我的持股數據】
${lines.join('\n')}`;
}

function parseSwing(text) {
  const m = text.match(/波段建議\s*[:：]\s*([\s\S]+)/);
  return m ? m[1].trim().slice(0, 400) : null;
}
function parseRationale(text) {
  const m = text.match(/分析\s*[:：]\s*([\s\S]+?)(?:\n波段建議|$)/);
  return stripBrackets((m ? m[1] : text).trim()).slice(0, 700);
}

// ── per-user analysis ──
async function analyzeUser(uid) {
  const snap = await db.collection('users').doc(uid).collection('data').doc('holdings').get();
  const holdings = snap.exists ? (snap.data().holdings || []) : [];
  if (!holdings.length) return false;

  // aggregate by code (avg cost)
  const byCode = {};
  for (const h of holdings) {
    const c = (byCode[h.code] ??= { code: h.code, name: h.name, qty: 0, costSum: 0 });
    c.qty += h.quantity; c.costSum += h.buyPrice * h.quantity;
  }

  // 可靠籌碼脈絡（chipDaily 全個股皆有）：三大法人 + 勝率雷達階段 + 主力倒貨%
  const iwCtx = await getInstWeightCtx();
  const win60 = await loadChipWindow(60);
  const snapQ = (await readSnapshotQuotes())?.quotes || {};

  const analyses = {};
  for (const code of Object.keys(byCode)) {
    const g = byCode[code];
    const avgCost = g.qty ? +(g.costSum / g.qty).toFixed(2) : 0;
    const [rating, newsRes] = await Promise.all([
      getJSON(`/api/rating?code=${code}`),
      getJSON(`/api/twse/stock-news?code=${code}&name=${encodeURIComponent(g.name || '')}`),
    ]);
    const st = rating?.stock;
    const price = st?.price ?? avgCost;
    const pnlPct = avgCost > 0 ? ((price - avgCost) / avgCost) * 100 : 0;
    const isRisk = !!(st?.isAttention || st?.isDisposition);
    const riskType = st?.isDisposition ? 'disposition' : st?.isAttention ? 'attention' : null;
    const news = newsRes?.news || [];

    // 組籌碼摘要
    let chip = '';
    const cv = iwCtx.latest?.[code];
    if (cv) {
      const cf = cv[0] || 0, ct = cv[1] || 0, cd = cv[2] || 0;
      const streak = iwCtx.streak?.[code] || 0;
      const volLots = snapQ[code]?.volume ? Math.round(snapQ[code].volume / 1000) : 0;
      const ph = chipPhaseTier(cf, ct, cd, streak, snapQ[code]?.changePercent ?? 0, volLots);
      const dist = chipDistribution(code, win60);
      chip = `三大法人(張,最新日) 外資 ${cf}、投信 ${ct}、自營 ${cd}；勝率雷達階段「${ph.label}」(${ph.tier === 'danger' ? '轉空' : ph.tier + '級'}${ph.win ? `·勝率${ph.win}%` : ''})${streak >= 2 ? `；外資連買 ${streak} 日` : ''}${dist.peak >= 500 ? `；主力自累計峰值 ${dist.peak} 張倒貨 ${dist.distributedPct}%` : ''}`;
    }

    const out = await askOllama(buildPrompt({ code, name: g.name, pnlPct, avgCost, price, rating, news, isRisk, riskType, chip }));
    const targets = (st?.sellTargets || []).filter(t => t.type !== 'trailing').map(t => t.price).sort((a, b) => a - b);
    analyses[code] = {
      code, name: g.name || st?.name || '',
      action: out ? parseAction(out) : '觀望',
      pnlPct: +pnlPct.toFixed(2),
      targetPrice: { low: targets[0] ?? null, mid: targets[1] ?? targets[0] ?? null, high: targets[targets.length - 1] ?? null },
      stopLoss: st?.stopLoss ?? null,
      sellTrigger: out ? parseTrigger(out) : '',
      newsSummary: news.slice(0, 4).map(n => n.title).join('；').slice(0, 300),
      rationale: out ? parseRationale(out) : '（本地 AI 暫無回應）',
      isRisk, riskType,
      swingAdvice: out && isRisk ? parseSwing(out) : null,
    };
    log(`  · ${uid} ${code} → ${analyses[code].action}`);
    await sleep(200);
  }

  await db.collection('users').doc(uid).collection('data').doc('portfolioAnalysis').set({
    uid, generatedAt: Date.now(), model: OLLAMA_MODEL, analyses,
  });
  return true;
}

const SIGNAL_LABEL = { STRONG_BUY: '強力買進', BUY: '買進', WATCH: '觀察', NEUTRAL: '中性' };
const MAX_SWING_CODES = parseInt(process.env.MAX_SWING_CODES || '40', 10);

// Per-stock swing analysis (shared by code) for the real-time tracking page.
async function swingForCode(code, name) {
  const [rating, newsRes] = await Promise.all([
    getJSON(`/api/rating?code=${code}`),
    getJSON(`/api/twse/stock-news?code=${code}&name=${encodeURIComponent(name || '')}`),
  ]);
  const st = rating?.stock;
  if (!st) return false;
  const f = rating?.fundamentals;
  const news = newsRes?.news || [];
  const isRisk = !!(st.isAttention || st.isDisposition);
  const sw = rating?.swingSignal;
  const lines = [
    `${code} ${name}：現價 ${st.price}、今日 ${st.changePercent?.toFixed?.(2)}%`,
    `AI 技術評分 ${st.score}(${st.grade}) 訊號 ${st.signal}`,
    sw ? `波段訊號 ${sw.actionLabel}（紀律評分 ${sw.score}/100、${sw.trend}、乖離 ${sw.biasPct}%）${sw.chase ? '【乖離過大，嚴禁追高，須等回測】' : ''}` : '',
    st.buyZones?.length ? `支撐買點 ${st.buyZones.map(z => `${z.label}${z.price}`).join('、')}` : '',
    st.sellTargets?.length ? `目標 ${st.sellTargets.filter(t => t.type !== 'trailing').map(t => t.price).join('、')}、停損 ${st.stopLoss}` : '',
    f?.valuation ? `PER ${f.valuation.pe}/殖利率 ${f.valuation.dividendYield}%/PBR ${f.valuation.pb}` : '',
    f?.institutional ? `三大法人(張) 外資 ${f.institutional.foreignNetLots}、投信 ${f.institutional.trustNetLots}、自營商 ${f.institutional.dealerNetLots}` : '',
    `近一月新聞：\n${news.slice(0, 6).map(n => `・${n.title}`).join('\n') || '（無重大新聞）'}`,
    isRisk ? `⚠️ 此股為${st.isDisposition ? '處置股（交易受限）' : '注意股'}。` : '',
  ].filter(Boolean);

  const prompt = `你是台灣股市資深波段操盤手。僅依下列實際數據，用繁體中文寫「波段操作分析」(140-220字)，涵蓋：趨勢與支撐壓力、籌碼/估值解讀、近一月新聞影響、具體波段進出價位與停損；務必遵守「乖離過大不追高、回測均線才進場」的紀律以提升勝率。${isRisk ? '因屬注意/處置股，須說明交易限制與波段風險控管。' : ''}嚴禁杜撰數據或臆測未提供的資訊。結尾不需免責聲明。${STRICT_RULE}\n\n【數據】\n${lines.join('\n')}`;
  const out = await askOllama(prompt);
  if (!out) return false;
  await db.collection('stockAI').doc(code).set({
    code, name: name || st.name || '',
    signal: st.signal, signalLabel: SIGNAL_LABEL[st.signal] || '中性',
    swing: out.trim().slice(0, 900),
    // Cache news (title/time/source/url) so /api/rating can score sentiment
    // even when live Google News RSS is rate-limited.
    news: news.slice(0, 10).map(nw => ({ title: nw.title, time: nw.time || '', source: nw.source || '', url: nw.url || '' })),
    generatedAt: Date.now(), model: OLLAMA_MODEL,
  });
  return true;
}

async function analyzeAll() {
  await heartbeat({ note: 'analyzing' });
  const premium = await getPremiumUsers();
  log(`▶ analysing ${premium.length} premium users…`);
  let n = 0;
  for (const u of premium) { try { if (await analyzeUser(u.id)) n++; } catch (e) { log('  ✖', u.id, e.message); } }

  // Build the union of watchlist + holdings codes across premium users → per-stock swing (stockAI/{code}).
  const wanted = new Map();
  for (const u of premium) {
    try {
      const [wl, hd] = await Promise.all([
        db.collection('users').doc(u.id).collection('data').doc('watchlist').get(),
        db.collection('users').doc(u.id).collection('data').doc('holdings').get(),
      ]);
      for (const w of (wl.exists ? (wl.data().watchlist || []) : [])) if (w?.code) wanted.set(w.code, w.name || '');
      for (const h of (hd.exists ? (hd.data().holdings || []) : [])) if (h?.code) wanted.set(h.code, h.name || '');
    } catch { /* skip user */ }
  }
  const codes = [...wanted.entries()].slice(0, MAX_SWING_CODES);
  log(`▶ swing-analysing ${codes.length} unique stocks…`);
  let s = 0;
  for (const [code, name] of codes) {
    try { if (await swingForCode(code, name)) { s++; if (s % 5 === 0) await heartbeat({ note: `swing ${s}/${codes.length}` }); } }
    catch (e) { log('  ✖ swing', code, e.message); }
    await sleep(200);
  }
  await heartbeat({ analyzedUsers: n, note: 'idle' });
  log(`✓ analysis cycle done (users ${n}, swing ${s})`);
}

// ── Pre-market 策略快報 (premium) — published ~08:45 Taipei on trading days ──
// 硬編休市表只是**離線保底**：Firestore 讀不到時才用。
// ⚠它天生會漏兩類日子，不要再手動維護它：
//   ① 結算交割日（2026-02-12「市場無交易，僅辦理結算交割作業」原本就漏了）
//   ② 颱風假等臨時休市（2026 年就有 03-10 / 03-13 / 03-25 / 05-20 / 07-10 五天）
// 權威來源是 system/tradingCalendar，由 scripts/sync-trading-calendar.mjs 每日更新。
const TW_HOLIDAYS_FALLBACK = new Set([
  '2026-01-01','2026-02-12','2026-02-13','2026-02-16','2026-02-17','2026-02-18','2026-02-19','2026-02-20',
  '2026-02-27','2026-02-28','2026-04-03','2026-04-06','2026-05-01','2026-06-19','2026-09-25',
  '2026-09-28','2026-10-09','2026-10-26','2026-12-25',
]);
let TW_HOLIDAYS = new Set(TW_HOLIDAYS_FALLBACK);
let _calLoadedDate = null;

/** 從 Firestore 載入權威休市表（每日一次；失敗維持現值，不退回 fallback）。 */
/**
 * 新鮮度契約（wm-freshness-health-monitoring）——「資料日」快取。
 *
 * 每個 latest doc 都必須能回答三件事：何時更新(updatedAt)、**代表哪一天(date)**、
 * 涵蓋幾筆(n)。缺 `date` 就無法偵測「有值、很新、筆數也夠，但那是別天的資料」——
 * 本專案已經栽在這件事上四次：上櫃日期位移、加權指數落後一日、
 * stockHistory 只寫一次、chipDaily PIT 漂移。
 *
 * ⚠ `date` 是**資料日**不是寫入日。收盤後衍生的榜單一律取來源歸檔的日期，
 *   盤中即時類才用今日日期。
 */
// ════════════════════════════════════════════════════════════════════════
// 日期驗證抓取（wm-data-accuracy「發布前驗證閘門」／wm-source-aggregation
// 「Provider Fallback Chain」）
//
// 為什麼需要共用層：本專案的資料事故有一個共同形狀 ——
// **來源回了一批看起來完全正常的資料，但那是別天的**。
//   · 上櫃日期位移：TPEx 對無效日期回「最近一個交易日」而不是報錯
//   · 加權指數落後一日：openapi 鏡像固定慢一天，程式沒讀它自報的「日期」
//   · 融資融券/借券：openapi 版連日期欄位都沒有 → 完全無法驗證
//
// 三條規矩，寫死在這裡而不是散在 44 個呼叫點：
//   ① 優先用**可指定日期**的 www.twse.com.tw/rwd 端點（openapi 只當降級）
//   ② 一律讀來源**自報的日期**（欄位或標題），對不上就當失敗
//   ③ 回傳 dataDate 讓呼叫端誠實標記，而不是填 Date.now()
// ════════════════════════════════════════════════════════════════════════

/**
 * 本益比／殖利率／股價淨值比（BWIBBU）—— 有三個消費端共用，所以收斂成一支。
 *
 * openapi 版落後一個交易日（實測 2026-07-31 回 07-30）。rwd 版可指定日期、
 * 會 echo `date`，而且**欄位名與 openapi 完全一致**，所以只要把二維陣列
 * 轉回物件就能直接替換，三個消費端一行都不用改。
 *
 * @returns {{ rows: Array, dataDate: string|null, source: string }}
 */
async function fetchBwibbu() {
  const expect = ymd8(taipei());
  const res = await fetchDated(
    `https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_ALL?date=${expect}&response=json`, expect);
  if (res.ok) {
    // rwd 欄位：股票代號,股票名稱,本益比,殖利率(%),股價淨值比
    const rows = (res.json.data || []).map(r => ({
      Code: String(r[0] ?? '').trim(), Name: String(r[1] ?? '').trim(),
      PEratio: r[2], DividendYield: r[3], PBratio: r[4],
    }));
    if (rows.length > 200) return { rows, dataDate: isoFromYmd8(res.dataDate), source: 'rwd' };
  }
  // 降級：openapi（已知落後一日）。仍讀它自報的日期，誠實標記而不是假裝是今天。
  try {
    const r = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return { rows: [], dataDate: null, source: 'none' };
    const j = await r.json();
    const d = isoFromYmd8(toYmd8(j?.[0]?.['日期'] ?? j?.[0]?.Date));
    log(`  ⚠ BWIBBU 改用 openapi 降級（rwd: ${res.why}），資料日 ${d || '未知'}`);
    return { rows: Array.isArray(j) ? j : [], dataDate: d, source: 'openapi' };
  } catch { return { rows: [], dataDate: null, source: 'none' }; }
}

/** YYYYMMDD → YYYY-MM-DD（寫入 Firestore 的 date 欄位用）。 */
function isoFromYmd8(v) {
  const s = String(v ?? '');
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : null;
}

/** 民國/西元字串 → YYYYMMDD；認不得回 null。 */
function toYmd8(v) {
  const s = String(v ?? '').replace(/[^0-9]/g, '');
  if (/^\d{8}$/.test(s)) return s;                                   // 20260731
  if (/^\d{7}$/.test(s)) return `${+s.slice(0, 3) + 1911}${s.slice(3)}`; // 1150731
  return null;
}

/** 從「115年07月31日 …」這種標題把日期挖出來（TWT96U 只在 title 自報）。 */
function ymdFromTitle(title) {
  const m = String(title || '').match(/(\d{2,3})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  return `${+m[1] + 1911}${String(+m[2]).padStart(2, '0')}${String(+m[3]).padStart(2, '0')}`;
}

/**
 * 抓一支「自報日期」的 TWSE/TPEx JSON 並驗證。
 *
 * @param url        完整網址
 * @param expectYmd  期望的資料日 YYYYMMDD
 * @param dateFrom   'field'（j.date）| 'title'（j.title 內的民國日期）| 自訂函式
 * @param mode       'exact'（預設，資料日必須等於 expect）
 *                   | 'forward'（資料日 **>=** expect 即可）
 *
 * ⚠ 為什麼需要 'forward'：有些端點是**前瞻性**的。
 *   「當日可借券賣出股數」(TWT96U) 公布的是**下一個交易時段**的可借額度，
 *   而且傍晚就會滾動 —— 實測 07/31 23:17 已經是「115年08月03日」（8/1、8/2 週末）。
 *   用 'exact' 去比對「最近一個完整交易日」，daemon 每晚都會判定不符而永遠跳過。
 *   （這個錯誤是資料源健康稽核抓出來的，不是人眼。）
 * @returns {{ ok:boolean, json:object|null, dataDate:string|null, why:string }}
 */
async function fetchDated(url, expectYmd, dateFrom = 'field', mode = 'exact') {
  try {
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 20000);
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.twse.com.tw/' },
      signal: ctl.signal,
    }).finally(() => clearTimeout(tm));
    if (!r.ok) return { ok: false, json: null, dataDate: null, why: `HTTP ${r.status}` };
    const text = await r.text();
    if (text.trim().startsWith('<')) return { ok: false, json: null, dataDate: null, why: '回傳 HTML（端點路徑或參數錯誤）' };
    const j = JSON.parse(text);
    if (j.stat && j.stat !== 'OK') return { ok: false, json: j, dataDate: null, why: `stat=${String(j.stat).slice(0, 30)}` };

    const dataDate = typeof dateFrom === 'function' ? dateFrom(j)
      : dateFrom === 'title' ? ymdFromTitle(j.title)
      : toYmd8(j.date);

    if (!dataDate) return { ok: false, json: j, dataDate: null, why: '來源未自報日期（無法驗證）' };
    if (expectYmd) {
      const bad = mode === 'forward' ? dataDate < expectYmd : dataDate !== expectYmd;
      if (bad) return { ok: false, json: j, dataDate, why: `資料日 ${dataDate} ${mode === 'forward' ? '早於' : '≠'} 期望 ${expectYmd}` };
    }
    return { ok: true, json: j, dataDate, why: '' };
  } catch (e) {
    return { ok: false, json: null, dataDate: null, why: (e.message || '').slice(0, 50) };
  }
}

let _dataDateCache = { at: 0, d: null };
async function dataDate() {
  if (_dataDateCache.d && Date.now() - _dataDateCache.at < 10 * 60000) return _dataDateCache.d;
  try {
    const s = await db.collection('chipArchive').orderBy('date', 'desc').limit(1).get();
    const d = s.empty ? null : s.docs[0].id;
    if (d) _dataDateCache = { at: Date.now(), d };
    return d;
  } catch { return _dataDateCache.d; }
}

async function loadTradingCalendar() {
  const today = isoDate(taipei());
  if (_calLoadedDate === today) return;
  try {
    const d = (await db.collection('system').doc('tradingCalendar').get()).data();
    if (Array.isArray(d?.holidays) && d.holidays.length) {
      TW_HOLIDAYS = new Set(d.holidays);
      _calLoadedDate = today;
      log(`✓ 休市日曆：${d.holidays.length} 天（官方 ${d.official?.length ?? 0}・臨時 ${d.adHoc?.length ?? 0}）`);
    }
  } catch (e) { log('⚠ 休市日曆讀取失敗，沿用現值:', (e.message || '').slice(0, 60)); }
}
function taipei() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' })); }
function isoDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function isTradingDay(d) { const g = d.getDay(); return g !== 0 && g !== 6 && !TW_HOLIDAYS.has(isoDate(d)); }

const DISCLAIMER = '⚠️ 本快報為 AI 策略分析，僅供參考，不構成投資建議；所有進出場操作仍須會員自行評估後決策，並自負風險。';

async function publishPremarketBrief() {
  const today = isoDate(taipei());
  await heartbeat({ note: 'premarket-brief' });
  log('▶ generating pre-market brief…');

  const rec = await getJSON('/api/twse/ai-recommend');
  const top = (rec?.recommendations || []).slice(0, 10);
  if (!top.length) { log('  ✖ no recommendations'); return false; }

  // Deterministic, fully-grounded per-stock entry/exit note (no AI free text → no hallucination).
  // ⚠ 進場價是「均線支撐」、停利是 entry+N×(entry−停損) —— 股價拉離均線時，
  //   buy 會遠低於現價，target 甚至落在現價下方。數字沒錯（那是等回檔的限價計畫），
  //   但只寫「強力買進，建議 25.08 進場，目標 25.2」而現價 27.6，讀起來就是壞掉的建議。
  //   所以把前提寫進去；target 低於現價時直接說明這個計畫現價不成立。
  const buildNote = (label, buy, target, stop, chg, price, plan) => {
    const parts = [`${label}`];
    if (buy == null) parts.push('現價附近觀察');
    else if (plan?.pullbackRequired && price > 0) {
      parts.push(`需回檔至 ${buy}（距現價 −${plan.gapPct}%）才進場，現價不追`);
    } else parts.push(`建議 ${buy} 附近分批進場`);
    if (target != null) parts.push(`目標 ${target}`);
    if (stop != null) parts.push(`跌破 ${stop} 停損`);
    if (plan?.targetBelowPrice) parts.push('⚠ 目標價已低於現價——此計畫僅在回檔成交後才有意義，現價買進無報酬空間');
    if (chg >= 7) parts.push('今漲幅大宜回測不追高');
    else if (chg < 0) parts.push('今走弱待止穩再進');
    return parts.join('，');
  };

  const picks = [];
  for (const r of top) {
    const rating = await getJSON(`/api/rating?code=${r.code}`);
    const st = rating?.stock || r;
    let buy = st.buyZones?.find(z => z.type === 'standard')?.price ?? st.buyZones?.[0]?.price ?? null;
    let target = st.sellTargets?.find(t => t.type === 'tp1')?.price ?? null;
    let stop = st.stopLoss ?? null;
    // 自洽檢查（2026-08-01）：均線錨定的買/損/目標來自不同均線，資料修復期或
    // 均線倒掛時可能出現「停損 > 買點」「目標 ≤ 買點」（實例 7/31 快報：兆豐金
    // 買41.44/損43.77、第一金 買29.09/損30.18）——這種計畫自相矛盾，寧可不給數字
    // 也不能給一個照做必虧的計畫。違反 損<買<目標 就整組撤下，退回「現價附近觀察」。
    if (buy != null && ((stop != null && stop >= buy) || (target != null && target <= buy))) {
      buy = null; target = null; stop = null;
    }
    const signalLabel = SIGNAL_LABEL[st.signal] || '中性';
    const chg = st.changePercent ?? 0;
    const sw = rating?.swingSignal;
    const note = buildNote(signalLabel, buy, target, stop, chg, st.price, st.entryPlan)
      + (sw?.chase ? '；🚫 乖離過大嚴禁追高，等回測均線' : '');
    picks.push({
      code: st.code, name: st.name, signal: st.signal,
      signalLabel, score: st.score,
      price: st.price, changePercent: chg,
      buy, target, stop, note, entryPlan: st.entryPlan ?? null,
      swingAction: sw?.actionLabel ?? null, swingScore: sw?.score ?? null,
      swingBias: sw?.biasPct ?? null, chase: sw?.chase ?? false,
    });
    await sleep(150);
  }

  // AI writes ONLY the aggregate market strategy (lower hallucination surface; per-stock notes are deterministic).
  const picksText = picks.map(p => `${p.code} ${p.name}：評分${p.score}(${p.signalLabel})、現價${p.price}、買${p.buy ?? '-'}/目標${p.target ?? '-'}/停損${p.stop ?? '-'}`).join('\n');
  const prompt = `你是台灣股市開盤前策略分析師。僅依下列「今日 AI 精選 10 檔」實際數據，用繁體中文寫一段 100-150 字的「今日盤前大盤策略與操作基調」。只談整體氛圍、族群與操作紀律，不要逐檔列價、不要杜撰任何數據或未提供資訊。${STRICT_RULE}\n\n【今日精選】\n${picksText}`;
  const out = await askOllama(prompt);
  const marketStrategy = out ? out.replace(/^[#*\s]+/, '').trim().slice(0, 400) : '';

  const brief = {
    date: today, generatedAt: Date.now(), model: OLLAMA_MODEL,
    marketStrategy: marketStrategy || '（本地 AI 暫無大盤敘述，請參考個股量化數據）',
    picks, disclaimer: DISCLAIMER,
  };
  await db.collection('premarketBrief').doc(today).set(brief);
  await db.collection('premarketBrief').doc('latest').set(brief);

  // Push a notification to each premium member
  const premium = await getPremiumUsers();
  const topLine = picks.slice(0, 5).map(p => `${p.name}(${p.signalLabel})`).join('、');
  let pushed = 0;
  for (const u of premium) {
    try {
      const nref = db.collection('users').doc(u.id).collection('data').doc('notifications');
      const cur = (await nref.get()).data()?.notifications || [];
      const notif = {
        id: `premarket-${today}`, type: 'premarket_reminder',
        stockCode: '', stockName: '',
        message: '📢 開盤前 AI 策略快報',
        detail: `今日精選 10 檔：${topLine}…。已附你的持股操作策略。${DISCLAIMER}`,
        timestamp: Date.now(), read: false, severity: 'info',
      };
      const next = [notif, ...cur.filter(n => n.id !== notif.id)].slice(0, 50);
      await nref.set({ notifications: next }, { merge: true });
      pushed++;
    } catch (e) { log('  ✖ notify', u.id, e.message); }
  }
  log(`✓ pre-market brief published (${picks.length} picks, notified ${pushed} premium)`);
  await heartbeat({ note: 'idle' });
  return true;
}

// ── Local news wiki — cache 個股+產業新聞 to the second brain ──
// Coarse industry inference (keyword for the stock-news 產業/政策 query).
function industryOf(code, name) {
  const c = String(code);
  const n = name || '';
  if (/^23|^24|^33|^61|^53|^80|^45/.test(c) || /半導體|晶圓|IC|封測|矽/.test(n)) return '半導體';
  if (/^261|^560|^2603|^2609|^2615|^2618|^2610/.test(c) || /航運|海運|貨櫃|航空/.test(n)) return '航運';
  if (/^28|^58|^2801|^2880/.test(c) || /金融|銀行|金控|證券|保險/.test(n)) return '金融';
  if (/^20|^200/.test(c) || /鋼鐵|鋼/.test(n)) return '鋼鐵';
  if (/^13|^17/.test(c) || /塑膠|化工|塑化/.test(n)) return '塑化';
  if (/^15|^16/.test(c) || /電機|機械|電纜/.test(n)) return '電機機械';
  if (/^30|^60/.test(c) || /光電|面板|LED/.test(n)) return '光電';
  if (/^電|^24|^30/.test(n) || /電子|電腦|伺服器|散熱|零組件/.test(n)) return '電子';
  return '台股';
}

function newsToMarkdown(code, name, industry, items) {
  const lines = [`# ${code} ${name}（${industry}）新聞`, '', `> 更新：${new Date().toLocaleString('zh-TW')}（本地第二大腦快取）`, ''];
  if (!items.length) lines.push('（本次未取得相關新聞）');
  for (const it of items) lines.push(`- [${it.title}](${it.url || '#'}) — ${it.source || ''}${it.time ? `（${String(it.time).slice(0, 10)}）` : ''}`);
  return lines.join('\n') + '\n';
}

// Built-in fallback watch list (owner holdings + market majors) — used when
// Firestore is unreachable (e.g. expired ADC) and no local override exists.
const DEFAULT_WATCH = [
  ['2330', '台積電'], ['2317', '鴻海'], ['2454', '聯發科'], ['2308', '台達電'], ['2382', '廣達'],
  ['2412', '中華電'], ['2603', '長榮'], ['2881', '富邦金'], ['0050', '元大台灣50'],
  ['2344', '華邦電'], ['2408', '南亞科'], ['2409', '友達'], ['3481', '群創'],
];

// Resolve which stocks to fetch news for: Firestore → local watchlist.json → default.
async function resolveWatchCodes() {
  const wanted = new Map();
  try {
    const usersSnap = await db.collection('users').get();
    const premium = usersSnap.docs.filter(d => ['premium', 'admin', 'superadmin'].includes((d.data().level) || 'registered'));
    for (const u of premium) {
      const [wl, hd] = await Promise.all([
        db.collection('users').doc(u.id).collection('data').doc('watchlist').get(),
        db.collection('users').doc(u.id).collection('data').doc('holdings').get(),
      ]);
      for (const w of (wl.exists ? (wl.data().watchlist || []) : [])) if (w?.code) wanted.set(w.code, w.name || '');
      for (const h of (hd.exists ? (hd.data().holdings || []) : [])) if (h?.code) wanted.set(h.code, h.name || '');
    }
  } catch (e) {
    log('  ⚠ Firestore unavailable, falling back to local list:', (e.message || '').slice(0, 60));
  }
  if (wanted.size > 0) return [...wanted.entries()].slice(0, 40);

  // Local override: second-brain/watchlist.json — ["2330", ...] or [{code,name}]
  try {
    const arr = JSON.parse(readFileSync(join(NEWS_DIR, '..', 'watchlist.json'), 'utf8'));
    for (const it of arr) { if (typeof it === 'string') wanted.set(it, ''); else if (it?.code) wanted.set(it.code, it.name || ''); }
    if (wanted.size > 0) { log(`  ↩ using local watchlist.json (${wanted.size})`); return [...wanted.entries()].slice(0, 40); }
  } catch { /* no local file */ }

  log('  ↩ using built-in default watch list');
  return DEFAULT_WATCH;
}

async function refreshNewsWiki() {
  await heartbeat({ note: 'news-refresh' }).catch(() => {}); // heartbeat may fail if ADC down
  mkdirSync(NEWS_DIR, { recursive: true });
  const codes = await resolveWatchCodes();
  log(`▶ refreshing news wiki for ${codes.length} stocks…`);
  const index = [];
  let ok = 0;
  for (const [code, name] of codes) {
    try {
      const industry = industryOf(code, name);
      const res = await getJSON(`/api/twse/stock-news?code=${code}&name=${encodeURIComponent(name || '')}&industry=${encodeURIComponent(industry)}`);
      const items = (res?.news || []).map(n => ({ title: n.title, source: n.source, time: n.time, url: n.url, category: n.category }));
      if (items.length === 0) continue; // don't overwrite cache with an empty (rate-limited) fetch
      const doc = { code, name, industry, fetchedAt: Date.now(), items };
      writeFileSync(join(NEWS_DIR, `${code}.json`), JSON.stringify(doc, null, 2));
      writeFileSync(join(NEWS_DIR, `${code}.md`), newsToMarkdown(code, name, industry, items));
      index.push({ code, name, industry, count: items.length });
      ok++;
    } catch (e) { log('  ✖ news', code, e.message); }
    await sleep(400); // throttle to avoid Google News rate-limit
  }
  writeFileSync(join(NEWS_DIR, 'index.json'), JSON.stringify({ updatedAt: Date.now(), intervalMin: NEWS_MS / 60000, stocks: index }, null, 2));
  log(`✓ news wiki refreshed (${ok}/${codes.length}) → second-brain/news/`);
  await heartbeat({ note: 'idle' }).catch(() => {});
}

async function newsLoop() {
  for (;;) {
    try { await refreshNewsWiki(); } catch (e) { log('✖ news loop:', e.message); }
    await sleep(NEWS_MS);
  }
}

// ── Full-market snapshot (second brain) — continuous MIS sweep ──
// Replaces the old top-100 partial merge: keeps a fresh whole-market quote
// snapshot in Firestore (marketSnapshot/latest) for all stats/scoring.
const _num = v => { const n = parseFloat(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };

// MIS 五檔委買委賣：b/g=委買5檔價/量(張)，a/f=委賣5檔價/量(張)，皆底線分隔、由優到劣。
const _parseLevels = (priceStr, volStr) => {
  const ps = String(priceStr || '').split('_').filter(Boolean).map(_num);
  const vs = String(volStr || '').split('_').filter(Boolean).map(_num);
  const out = [];
  for (let i = 0; i < Math.min(5, ps.length); i++) if (ps[i] > 0) out.push([ps[i], vs[i] || 0]);
  return out;
};

async function misBatch(batch) {
  const exCh = batch.map(c => `${c.market}_${c.code}.tw`).join('|');
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0&_=${Date.now()}`;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://mis.twse.com.tw/' } });
    clearTimeout(t);
    if (!r.ok) return {};
    const j = await r.json();
    const out = {};
    for (const it of (j.msgArray || [])) {
      const code = it.c; if (!code) continue;
      // z=最後成交價, pz=試撮/參考價(closing-auction期間 z='-' 但 pz 有值).
      // 盤中兩筆撮合之間 MIS 常回 z='-'且pz='-'(冷門股可長達數十分鐘)，此時最佳
      // 委買價(b 第一檔)就是市場現價 → 作為第三層來源，走勢才跟得上證交所。
      // 真實價=成交z或試撮pz。委買b1/委賣a1只是掛單非成交——實案(2026-07-17 東訊)：
      // 收盤後 z/pz 皆'-'，b1=16.45 殘留買單被當現價標 live(+5.8%)，實際收 15.40(-0.96%)。
      // 回退掛單價僅供無 _lastLive 時的顯示參考，一律不得標 hasLive。
      let price = _num(it.z); if (price <= 0) price = _num(it.pz);
      const realTrade = price > 0;
      if (price <= 0) {
        const b1 = parseFloat(String(it.b || '').split('_')[0]);
        const a1 = parseFloat(String(it.a || '').split('_')[0]);
        price = b1 > 0 ? b1 : (a1 > 0 ? a1 : 0);
      }
      const volLots = _num(it.v);           // MIS v 單位=張
      const vol = volLots * 1000;            // 統一為「股」，與種子(STOCK_DAY_ALL)一致
      // 只有「真成交價 + 當日有量」才算即時真實價（開盤前試撮 v=0 不覆蓋昨收）。
      const hasLive = realTrade && volLots > 0;
      const prev = _num(it.y); if (price <= 0) price = prev;  // 僅供 change 計算
      const change = hasLive && prev > 0 ? +(price - prev).toFixed(2) : 0;
      out[code] = {
        code, name: it.n || '', price, change,
        changePercent: hasLive && prev > 0 ? +((change / prev) * 100).toFixed(2) : 0,
        open: _num(it.o), high: _num(it.h), low: _num(it.l),
        volume: vol, value: Math.round(price * vol), hasLive,
        bid: _parseLevels(it.b, it.g), ask: _parseLevels(it.a, it.f), // 五檔委買委賣（僅供當下參考，不歸檔）
      };
    }
    return out;
  } catch { clearTimeout(t); return {}; }
}

let _codesCache = null, _codesAt = 0, _codesCloseDate = '';
// 民國日期 1150715 → 20260715（西元 YYYYMMDD）
const rocToYmd = s => { s = String(s).trim(); return /^\d{7}$/.test(s) ? String(+s.slice(0, 3) + 1911) + s.slice(3) : ''; };
async function getAllMarketCodes(force = false) {
  if (!force && _codesCache && Date.now() - _codesAt < 10 * 60000) return _codesCache;
  const codes = [];
  // TSE: PRIMARY www.twse CSV (fresh right after close), FALLBACK openapi (lags).
  let tseRows = []; let closeDate = '';
  try {
    const res = await fetch('https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=json', { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } });
    if (res.ok) {
      for (const line of (await res.text()).split('\n')) {
        const m = line.match(/"([^"]*)"/g);
        if (!m || m.length < 9) continue;
        const f = m.map(s => s.slice(1, -1));
        if (!closeDate) closeDate = rocToYmd(f[0]); // 首欄為資料日期(民國) → 用於判斷是否今日結算價
        const code = (f[1] || '').trim();
        // 普通股(4碼) + ETF(00開頭4-6碼)——使用者需要追蹤全部上市櫃與 ETF
        if (/^\d{4}$/.test(code) || /^00\d{2,4}$/.test(code)) tseRows.push({ code, name: (f[2] || '').trim(), market: 'tse', close: _num(f[8]), change: _num((f[9] || '').replace('+', '')), vol: _num(f[3]) });
      }
    }
  } catch { /* fall through to openapi */ }
  if (tseRows.length === 0) {
    try {
      const r = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.ok) for (const x of await r.json()) if (/^\d{4}$/.test(x.Code) || /^00\d{2,4}$/.test(x.Code)) tseRows.push({ code: x.Code, name: x.Name, market: 'tse', close: _num(x.ClosingPrice), change: _num(x.Change), vol: _num(x.TradeVolume) });
    } catch { /* tse */ }
  }
  for (const c of tseRows) codes.push(c);
  try {
    const r = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (r.ok) for (const x of await r.json()) { const code = x.SecuritiesCompanyCode || x.Code || ''; if (/^\d{4}$/.test(code) || /^00\d{2,4}$/.test(code)) codes.push({ code, name: x.CompanyName || x.Name || '', market: 'otc', close: _num(x.Close), change: _num(x.Change), vol: _num(x.TradingShares) }); }
  } catch { /* otc */ }
  if (codes.length > 0) { _codesCache = codes; _codesAt = Date.now(); _codesCloseDate = closeDate; }
  return _codesCache || [];
}

// seed = latest TWSE close. live:false means "this is close, NOT realtime".
const seedQuote = c => ({ code: c.code, name: c.name, market: c.market || null, price: c.close, change: c.change, changePercent: (c.close - c.change) > 0 ? +((c.change / (c.close - c.change)) * 100).toFixed(2) : 0, volume: c.vol, value: Math.round(c.close * c.vol), open: 0, high: 0, low: 0, live: false });

async function writeSnapshot(quotes, marketOpen, source, sweeping = marketOpen) {
  const arr = Object.values(quotes);
  const count = arr.length;
  const liveCount = arr.filter(q => q.live).length;
  const sweepAt = Date.now();
  // Store quotes as a JSON STRING — a 1900-key map exceeds Firestore's 20k
  // per-doc index-entry limit; a string is indexed once.
  try { await db.collection('marketSnapshot').doc('latest').set({ quotesJson: JSON.stringify(quotes), count, liveCount, sweepAt, marketOpen, sweeping, source, updatedAt: Date.now(), date: isoDate(taipei()) }); }
  catch (e) { log('  ✖ snapshot write', (e.message || '').slice(0, 60)); }
  try { mkdirSync(MARKET_DIR, { recursive: true }); writeFileSync(join(MARKET_DIR, 'snapshot.json'), JSON.stringify({ count, liveCount, sweepAt, marketOpen, source, quotes }, null, 2)); } catch { /* ignore */ }
}

// ── Priority set: the stocks we refresh in REAL TIME via MIS ──
// TWSE MIS hard-limits per-IP request rate; sweeping the whole ~1976-stock
// market got this IP banned. So we poll only a bounded priority set (members'
// watchlists + holdings ∪ top-by-value hot list) at a safe rate. Everything
// else stays at the latest close (live:false) and is labelled 收盤 in the app.
const PRIORITY_CAP = 150;
const VIEWED_MAX_AGE_MS = 15 * 60000; // a viewed stock stays "priority" for 15 min
let _prioCache = null, _prioAt = 0;
// Last REAL live price per code — used to bridge closing-auction gaps where MIS
// returns z='-' AND pz='-' momentarily (avoids the price flickering to 昨收/0%).
const _lastLive = {};
let _rotIdx = 0; // 全市場輪掃游標（優先集外代碼循環掃描）

// ── 尾盤五檔累積窗（委買賣失衡的歷史原料）─────────────────────────────
// 2026-08-02 修正三個會讓「半年後有資料可回測」這件事落空的問題：
//   ①母體漂移：舊版直接歸檔 bookDepth/latest，而那份**只有優先集**
//     （自選/持股/瀏覽中，約 150 檔）——等於今天看了哪幾檔就存哪幾檔，
//     母體隨使用者行為變動，做不了全市場統計。
//   ②時點不對：舊版只檢查「今日 ≥13:00」，實測 07-31 存到的是 **16:29**
//     的快照——收盤後三小時的委託簿已非尾盤語意。
//   ③缺漏無感：9 個交易日缺 2 天（07-25、07-29）也沒有任何告警。
// 修法：13:20~13:35 這段把**全市場輪掃也一併擷取五檔**（MIS 回應本來就帶
//   bid/ask，存下來零額外請求），逐筆記錄擷取時間；13:36 才歸檔，
//   且只收時間戳落在窗內的條目。輪掃一輪 480 檔、約 2 分鐘，15 分鐘可跑
//   約 7 輪 → 全市場（~1,900 檔）可完整覆蓋一輪以上。
const DEPTH_WIN_FROM = 13 * 60 + 20, DEPTH_WIN_TO = 13 * 60 + 35;
let _depthWin = { date: '', data: {} };   // code → { bid, ask, at }

// 加權指數 t00 落地：Firebase Cloud Function 在美國機房、MIS 封鎖美國 IP →
// 線上 /api/twse/market-index 直抓 MIS 一律失敗(weighted=0/「--」)。daemon 在台灣
// 抓得到，寫入 marketIndex/latest 供 API 讀。每分一次。
let _idxAt = 0;
async function writeMarketIndex() {
  if (Date.now() - _idxAt < 55000) return;
  try {
    const r = await fetch(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw&json=1&delay=0&_=${Date.now()}`, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://mis.twse.com.tw/' } });
    if (!r.ok) return;
    const it = ((await r.json())?.msgArray || [])[0]; if (!it) return;
    const cur = _num(it.z) || _num(it.l), prev = _num(it.y);
    if (cur > 0 && prev > 0) {
      const chg = +(cur - prev).toFixed(2);
      await db.collection('marketIndex').doc('latest').set({
        weighted: cur, weightedChange: chg, weightedChangePercent: +((chg / prev) * 100).toFixed(2),
        high: _num(it.h), low: _num(it.l), prevClose: prev, tradeDate: it.d, tradeTime: it.t,
        at: Date.now(), source: 'daemon_mis',
      });
      _idxAt = Date.now();
    }
  } catch { /* 網路波動可缺 */ }
}

// Codes any user is actively viewing (written by /api/twse/mis-quote → liveRequests).
async function readViewedCodes() {
  try {
    const d = (await db.collection('marketSnapshot').doc('liveRequests').get()).data();
    const codes = d?.codes || {};
    const now = Date.now();
    return Object.keys(codes).filter(c => now - codes[c] < VIEWED_MAX_AGE_MS);
  } catch { return []; }
}

async function buildPriorityCodes(codes) {
  if (_prioCache && Date.now() - _prioAt < 60000) return _prioCache; // refresh hourly→1min so viewed stocks join fast
  const valid = new Set(codes.map(c => c.code));
  const set = new Set();
  // 1) members' watchlists + holdings, 2) actively-viewed stocks — both highest priority.
  try { for (const [code] of await resolveWatchCodes()) if (valid.has(code)) set.add(code); } catch { /* ignore */ }
  for (const code of await readViewedCodes()) if (valid.has(code) && set.size < PRIORITY_CAP) set.add(code);
  // 2.5) 昨日策略榜個股：早盤起漲提醒(earlyBird)與潛力榜需要它們的即時報價，
  //      否則中小型飆股不在掃描範圍、漲停了才後知後覺。
  try {
    const sp = (await db.collection('strategyPicks').doc('latest').get()).data();
    if (sp?.groups) {
      const cnt = {};
      for (const k of ['limitLock', 'gapUp', 'volBreak', 'secondBar', 'dipLimit', 'chip']) for (const p of (sp.groups[k] || [])) cnt[p.code] = (cnt[p.code] || 0) + 1;
      const ranked = Object.entries(cnt).sort((a, b) => b[1] - a[1]).map(([c]) => c);
      for (const code of ranked.slice(0, 60)) if (valid.has(code) && set.size < PRIORITY_CAP) set.add(code);
    }
  } catch { /* ignore */ }
  // 3) hot list (top by traded value) fills the remaining budget.
  const hot = [...codes].sort((a, b) => (b.close * b.vol) - (a.close * a.vol));
  for (const c of hot) { if (set.size >= PRIORITY_CAP) break; set.add(c.code); }
  _prioCache = [...set].slice(0, PRIORITY_CAP);
  _prioAt = Date.now();
  return _prioCache;
}

// ── 盤中即時走勢：自建分時序列 ──────────────────────────────
// Yahoo 分時延遲約 20 分鐘且開盤常無資料，故用 daemon 的真實即時 MIS 掃描，
// 針對「使用者關注」個股(自選+持股+瀏覽中)累積當日分時序列，供走勢圖即時繪製。
let _intraday = { date: '', series: {} };
async function getTrackedCodes(valid) {
  const set = new Set();
  try { for (const [code] of await resolveWatchCodes()) if (valid.has(code)) set.add(code); } catch { /* ignore */ }
  for (const code of await readViewedCodes()) if (valid.has(code)) set.add(code);
  return set;
}
function recordIntraday(quotes, trackedSet) {
  const today = isoDate(taipei());
  if (_intraday.date !== today) _intraday = { date: today, series: {} };
  const tsSec = Math.floor(Date.now() / 1000);
  const minute = Math.floor(tsSec / 60);
  for (const code of trackedSet) {
    const q = quotes[code];
    if (!q || !q.live || !(q.price > 0)) continue; // 只記真實成交價(v>0 已在 misBatch 把關)
    let s = _intraday.series[code];
    if (!s) s = _intraday.series[code] = { prev: +(q.price - q.change).toFixed(2), pts: [] };
    const last = s.pts[s.pts.length - 1];
    if (last && Math.floor(last[0] / 60) === minute) { last[0] = tsSec; last[1] = q.price; last[2] = q.volume || 0; } // 同分鐘覆蓋為最新
    else s.pts.push([tsSec, q.price, q.volume || 0]);
    if (s.pts.length > 400) s.pts.splice(0, s.pts.length - 400); // 全日270分＋早盤回補＋即時，留餘裕
  }
}
async function writeIntraday() {
  try { await db.collection('marketIntraday').doc('latest').set({ date: _intraday.date, updatedAt: Date.now(), seriesJson: JSON.stringify(_intraday.series) }); }
  catch (e) { log('✖ writeIntraday:', (e.message || '').slice(0, 80)); }
}

// 早盤回補：daemon 只從「被檢視當下」才記錄，故被檢視前的早盤缺一段。
// 每輪回補一檔(限流)，用 Yahoo 1m 補上首筆之前的早盤，讓即時走勢圖從 09:00 起完整、
// 且盤中 route 可直接回 daemon(免等 Yahoo)→速度不退步。
const _ibBackfilled = new Set(); let _ibDay = '';
async function fetchYahoo1m(sym) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 6000);
  try {
    const j = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d&includePrePost=false`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctl.signal }).then(r => r.json()).finally(() => clearTimeout(tm));
    const res = j?.chart?.result?.[0]; if (!res) return null;
    const ts = res.timestamp || []; const q = res.indicators?.quote?.[0] || {};
    const out = [];
    for (let i = 0; i < ts.length; i++) { const c = q.close?.[i]; if (c > 0) out.push([ts[i], +c.toFixed(2), q.volume?.[i] ?? 0]); }
    return out.length ? out : null;
  } catch { return null; }
}
const _taipeiMinOf = tsSec => { const t = new Date(new Date(tsSec * 1000).toLocaleString('en-US', { timeZone: 'Asia/Taipei' })); return t.getHours() * 60 + t.getMinutes(); };
async function backfillIntradayMorning(trackedSet, byCode) {
  const tw = taipei(); const mins = tw.getHours() * 60 + tw.getMinutes();
  if (mins < 9 * 60 + 10 || mins >= 13 * 60 + 35) return;   // 只在盤中且開盤 10 分後回補
  const today = isoDate(tw);
  if (_ibDay !== today) { _ibBackfilled.clear(); _ibDay = today; }
  // 找一檔：尚未回補、且序列缺早盤(首筆晚於 09:05 或整段缺)
  let target = null;
  for (const code of trackedSet) {
    if (_ibBackfilled.has(code)) continue;
    const s = _intraday.series[code];
    const firstMin = s?.pts?.length ? _taipeiMinOf(s.pts[0][0]) : 9999;
    if (firstMin > 9 * 60 + 5) { target = code; break; }
  }
  if (!target) return;
  _ibBackfilled.add(target);                                 // 無論成敗都標記，避免反覆重試
  const market = byCode[target]?.market;
  const bars = await fetchYahoo1m(`${target}.${market === 'otc' ? 'TWO' : 'TW'}`);
  if (!bars) return;
  const s = _intraday.series[target];
  const firstTs = s?.pts?.length ? s.pts[0][0] : Infinity;
  const morning = bars.filter(b => b[0] < firstTs && _taipeiMinOf(b[0]) >= 9 * 60 && _taipeiMinOf(b[0]) < 13 * 60 + 35);
  if (!morning.length) return;
  if (!s) { _intraday.series[target] = { prev: +(bars[0][1]).toFixed(2), pts: morning }; }
  else { s.pts = [...morning, ...s.pts]; if (s.pts.length > 400) s.pts.splice(400); }
  log(`  ⏮ 早盤回補 ${target} +${morning.length} 筆`);
}

async function marketSnapshotLoop() {
  for (;;) {
    try {
      const tw = taipei();
      const mins = tw.getHours() * 60 + tw.getMinutes();
      // 掃描窗 08:30–15:00：收盤後 MIS 仍供今日終價，補「13:35收盤~15:00官方結算」
      // 的空窗（實案 2026-07-17：收盤後重啟 → _lastLive 清空 → 全部退回昨日種子）。
      // 掃描窗延長至 16:30：MIS 收盤後仍回今日收盤價，補「TPEx openapi 上櫃收盤延遲
      // 一天」的缺口(實案 2026-07-17：6732 上櫃今收193.5，TPEx種子仍昨收214)。
      const active = isTradingDay(tw) && mins >= 8 * 60 + 30 && mins < 16 * 60 + 30;
      const marketNow = isTradingDay(tw) && mins >= 9 * 60 && mins < 13 * 60 + 35;
      // 收盤後 13:35–15:00：官方 STOCK_DAY_ALL 逐步更新今日結算價，強制刷新代碼表以便即時取得。
      const postClose = isTradingDay(tw) && mins >= 13 * 60 + 35 && mins < 15 * 60;
      const codes = await getAllMarketCodes(postClose);
      if (codes.length === 0) { await sleep(60000); continue; }
      writeMarketIndex().catch(() => {}); // 加權指數落地（t00 收盤後仍回今日收盤，整晚有效）

      // Always seed EVERY stock from close so the full market is present.
      const quotes = {};
      for (const c of codes) quotes[c.code] = seedQuote(c);

      if (active) {
        const byCode = {}; for (const c of codes) byCode[c.code] = c;
        const prio = await buildPriorityCodes(codes);
        await heartbeat({ note: `market-priority(${prio.length})` }).catch(() => {});
        const now = Date.now();
        const depthOut = {}; // 五檔委買委賣（僅優先集：自選/持股/瀏覽中，供決策工作台當下參考）
        // 尾盤累積窗：13:20~13:35 期間，**所有**掃到的代碼都收五檔（含全市場輪掃）
        const inDepthWin = marketNow && mins >= DEPTH_WIN_FROM && mins < DEPTH_WIN_TO;
        if (inDepthWin && _depthWin.date !== isoDate(tw)) _depthWin = { date: isoDate(tw), data: {} };
        const applyMis = (mis, captureDepth) => {
          for (const k in mis) {
            const { hasLive, bid, ask, ...q } = mis[k];
            if (hasLive && inDepthWin && (bid?.length || ask?.length)) {
              _depthWin.data[k] = { bid, ask, at: Date.now() };   // 逐筆記時間戳，歸檔時據以過濾
            }
            if (hasLive) {
              quotes[k] = { ...q, market: byCode[k]?.market || quotes[k]?.market || null, live: true, liveAt: Date.now() };
              _lastLive[k] = quotes[k];                 // remember the last REAL price
              if (captureDepth && (bid?.length || ask?.length)) depthOut[k] = { bid, ask };
            } else if (_lastLive[k]) {
              quotes[k] = { ..._lastLive[k] };          // no current price (auction gap) → keep last real
            }
            // else: no live ever seen → leave seed (昨收, live:false)
          }
        };
        // ① 優先集每輪即時（自選/持股/熱門），paced ≤1 batch / 2s (MIS-safe)
        for (let i = 0; i < prio.length; i += 60) {
          applyMis(await misBatch(prio.slice(i, i + 60).map(code => byCode[code]).filter(Boolean)), true);
          await sleep(2000);
        }
        try { await db.collection('bookDepth').doc('latest').set({ byCodeJson: JSON.stringify(depthOut), n: Object.keys(depthOut).length, at: Date.now(), date: isoDate(taipei()) }); } catch { /* ignore */ }
        // ② 全市場輪掃：其餘代碼每輪掃 8 批(480檔)，~2分鐘覆蓋全市場一輪。
        //    修正實案(2026-07-17)：全市場快照僅150檔live、1830檔掛昨日種子 →
        //    「即時漲跌」左欄混入大量昨日上漲的殘留資料。
        const prioSet = new Set(prio);
        const rest = codes.map(c => c.code).filter(c => !prioSet.has(c));
        for (let n = 0; n < 8 && rest.length; n++) {
          const batch = [];
          for (let j = 0; j < 60 && rest.length; j++) { batch.push(byCode[rest[_rotIdx % rest.length]]); _rotIdx++; }
          applyMis(await misBatch(batch.filter(Boolean)), false);
          await sleep(2000);
        }
        // 輪掃間隙沿用最後真實價（_lastLive），避免掃描空窗跳回昨日種子
        for (const c of codes) { const k = c.code; if (!quotes[k].live && _lastLive[k]) quotes[k] = { ..._lastLive[k] }; }
        const liveN = Object.values(quotes).filter(q => q.live).length;
        await writeSnapshot(quotes, marketNow, 'mixed', true);
        // 記錄使用者關注個股的分時序列(即時走勢圖用，不依賴延遲的 Yahoo)。
        try {
          const tracked = await getTrackedCodes(new Set(codes.map(c => c.code)));
          recordIntraday(quotes, tracked);
          await backfillIntradayMorning(tracked, byCode); // 每輪回補一檔早盤缺口
          await writeIntraday();
          await checkAnomalies(quotes, tracked); // 爆量急拉/急殺偵測
        } catch (e) { log('✖ intraday:', (e.message || '').slice(0, 80)); }
        log(`✓ snapshot: ${liveN}/${prio.length} live (priority), ${codes.length} total · ${Math.round((Date.now() - now) / 1000)}s`);
        if (liveN === 0) log('  ⚠ MIS returned 0 live quotes — IP may be rate-limited/blocked; serving close data');
        await sleep(4000);
      } else {
        // 收盤後顯示策略：官方 STOCK_DAY_ALL 已更新到今日 → 用今日結算價(權威)；
        // 尚未更新(仍昨日) → 沿用今日盤中最後成交價(_lastLive，含尾盤最後一筆)，待結算價出爐即時修正。
        const settled = _codesCloseDate === ymd8(tw); // seed 是否為今日結算價
        for (const c of codes) {
          const code = c.code;
          if (settled) {
            // settled 旗標僅代表上市(STOCK_DAY_ALL)已更新；上櫃種子走 TPEx openapi 常延遲一天。
            // 故今日 MIS 真收盤(_lastLive)一律優先於種子——上市兩者一致、上櫃可修正延遲。
            if (_lastLive[code]) quotes[code] = { ..._lastLive[code], live: false, settled: true };
            else quotes[code].settled = true; // 從未有即時價 → 用種子(上市為官方收盤)
          } else if (_lastLive[code]) {
            quotes[code] = { ..._lastLive[code], live: false, settled: false }; // 今日最後即時價(尾盤未結算前)
          }
          // else：從未有即時價 → 保留 seed(昨收)
        }
        await writeSnapshot(quotes, false, settled ? 'stock_day_all' : 'last_tick');
        // 尾盤結算價未出前加速輪詢(60s)以便即時修正；已結算則回到 5 分鐘。
        await sleep(!settled && postClose ? 60000 : 5 * 60000);
      }
    } catch (e) { log('✖ market snapshot loop:', e.message); await sleep(30000); }
  }
}

// ════════════════════════════════════════════════════════════
// 投資技能擴充：停損停利提醒 / 產業輪動 / 法人連續買超 / 回測勝率
// 全部把結果寫進第二大腦(Firestore)供 app 取用。
// ════════════════════════════════════════════════════════════
const _i = v => { const n = parseInt(String(v).replace(/[,\s]/g, ''), 10); return isNaN(n) ? 0 : n; };
function ymd8(d) { return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; }

async function readSnapshotQuotes() {
  try {
    const s = (await db.collection('marketSnapshot').doc('latest').get()).data();
    if (!s) return null;
    return { quotes: JSON.parse(s.quotesJson || '{}'), marketOpen: !!s.marketOpen, sweepAt: s.sweepAt };
  } catch { return null; }
}

// ── 1) 自動停損/停利提醒 ──────────────────────────────────────
// 用快照即時價 + 各用戶 portfolioAnalysis 的 AI 停損/目標價(無則 ±8%/+20%)，
// 觸價即寫 users/{uid}/data/alerts。每用戶每股每類型每日只提醒一次。
const _alerted = new Set(); let _alertDay = '';
const _chipHoldAlerted = new Set(); let _chipHoldDay = ''; // 籌碼出貨警示每股每類型每日一次
// 停利後再進場觀察：觸發停利的個股記下，回檔約 5% 時提示可留意再進場。
const _reentryWatch = {};
// 移動停利高水位：記每檔持有期間最高價，獲利後自高點回落即鎖利。
const _hwm = {};
// 持股 RSI 高檔警報的即時計算：marginSnap[12] 存的是 t-1 收盤的 Wilder 狀態，
// 用今日即時價再推一步 → 盤中 RSI。（只用收盤 RSI 的話，盤中飆上 85 要等隔天。）
function _liveRsi(st, price) {
  if (!Array.isArray(st) || st.length < 7 || !(price > 0) || !(st[6] > 0)) return null;
  const ch = price - st[6], g = Math.max(ch, 0), l = Math.max(-ch, 0);
  const u5 = (st[2] * 4 + g) / 5, d5 = (st[3] * 4 + l) / 5;
  const u10 = (st[4] * 9 + g) / 10, d10 = (st[5] * 9 + l) / 10;
  return {
    rsi5: u5 + d5 > 0 ? +(u5 / (u5 + d5) * 100).toFixed(1) : 50,
    rsi10: u10 + d10 > 0 ? +(u10 / (u10 + d10) * 100).toFixed(1) : 50,
  };
}
async function checkAlerts() {
  const snap = await readSnapshotQuotes(); if (!snap) return;
  const q = snap.quotes;
  const today = isoDate(taipei());
  // marginSnap 每輪讀一次（不是每個使用者讀一次）——唯一不變式：與線上人數脫鉤。
  let msRow = {};
  try {
    const ms = (await db.collection('marginSnap').doc('latest').get()).data();
    if (ms?.byCodeJson) msRow = JSON.parse(ms.byCodeJson);
  } catch { /* 缺 marginSnap 就跳過 RSI 警報，其餘警報照常 */ }
  if (_alertDay !== today) { _alerted.clear(); _alertDay = today; }
  const premium = await getPremiumUsers();
  for (const u of premium) {
    const uid = u.id;
    try {
      const hd = await db.collection('users').doc(uid).collection('data').doc('holdings').get();
      const holdings = hd.exists ? (hd.data().holdings || []) : []; if (!holdings.length) continue;
      const pa = (await db.collection('users').doc(uid).collection('data').doc('portfolioAnalysis').get()).data();
      const analyses = pa?.analyses || {};
      const byCode = {};
      for (const h of holdings) { const c = (byCode[h.code] ??= { qty: 0, cost: 0, name: h.name }); c.qty += h.quantity; c.cost += h.buyPrice * h.quantity; }
      const newAlerts = [];
      for (const code in byCode) {
        const g = byCode[code]; const avg = g.qty ? g.cost / g.qty : 0;
        const x = q[code]; const price = x?.price;
        if (!(price > 0) || !(avg > 0)) continue;
        const pnlPct = ((price - avg) / avg) * 100;
        const a = analyses[code] || {};
        const stop = a.stopLoss > 0 ? a.stopLoss : +(avg * 0.92).toFixed(2);
        const take = a.targetPrice?.low > 0 ? a.targetPrice.low : +(avg * 1.2).toFixed(2);
        const wkey = `${uid}:${code}`;
        // 移動停利：更新高水位；曾獲利≥10% 後，自高點回落 8% 即鎖利。
        const hw = _hwm[wkey] = Math.max(_hwm[wkey] || avg, price);
        const trailActive = avg > 0 && (hw - avg) / avg >= 0.10;
        const trailStop = +(hw * 0.92).toFixed(2);
        let type = null, thr = null, msg = null;
        if (price <= stop) { type = 'stop'; thr = stop; msg = `⛔ ${code} ${g.name} 觸及停損 ${stop}（現價 ${price}，${pnlPct.toFixed(1)}%）— 建議檢視風險`; }
        else if (price >= take && price > avg) { type = 'take'; thr = take; msg = `🎯 ${code} ${g.name} 觸及停利目標 ${take}（現價 ${price}，+${pnlPct.toFixed(1)}%）— 可考慮分批獲利`; _reentryWatch[wkey] = { takePrice: take, at: Date.now() }; }
        else if (trailActive && price <= trailStop && price > avg) { type = 'trailing'; thr = trailStop; msg = `📈 ${code} ${g.name} 移動停利觸發 ${trailStop}（自高點 ${hw.toFixed(2)} 回落 8%，仍獲利 +${pnlPct.toFixed(1)}%）— 建議鎖利出場`; }
        else if (_reentryWatch[wkey] && price <= _reentryWatch[wkey].takePrice * 0.95) { type = 'reentry'; thr = +(_reentryWatch[wkey].takePrice * 0.95).toFixed(2); msg = `🔄 ${code} ${g.name} 停利後回檔至 ${price}（較停利價 -5%）— 可留意回測支撐再進場`; delete _reentryWatch[wkey]; }
        // ── 持股 RSI 高檔警報（2026-08-03 使用者要求）─────────────────
        // ⚠**語意已按實證校正，與使用者原始假設相反**（screen-rsi85-exit.mjs·出場口徑）：
        //   使用者原要求「RSI5 與 RSI10 同時>85 → 示警要出貨下車」。實測兩窗一致否證：
        //   加上 RSI10>85 之後 續抱10日均 0.847→1.635%(主窗)／1.969→2.753%(OOT)【上升】，
        //   真頂點率(10日) 25.5→23.0%／20.8→19.4%【反而下降】。
        //   ⇒ 雙高不是見頂，是**趨勢延續＋波動雙向放大**：5日曾跌≥5% 42.2→51.9/25.0→36.9%，
        //     但 10日曾漲≥5% 也同步 55.1→66.6/48.0→59.6%，上下行各升約 10~12pp。
        //   真正比較像頂的反而是「RSI5>85 但 RSI10≤85」（單腳過熱、中期沒跟上）：
        //     真頂點率 1.16~1.35x（三組最高）、續抱報酬最低。
        //   與 2026-07-27 rsiTopExit（95/90 門檻）結論一致：抱1日最差、抱10日最佳，
        //   故一律不寫「出貨下車」，改為移動停利與分批，並揭露賣早的機率。
        const rr = _liveRsi(msRow[code]?.[12], price);
        if (rr && rr.rsi5 > 85 && pnlPct > 0) {
          const dual = rr.rsi10 > 85;
          const rtype = dual ? 'rsiDual85' : 'rsiHot85';
          const rkey = `${uid}:${code}:${rtype}`;
          if (!_alerted.has(rkey)) {
            _alerted.add(rkey);
            const m = dual
              ? `🔥 ${code} ${g.name} RSI5/RSI10 雙高（${rr.rsi5}/${rr.rsi10}）現價 ${price}（+${pnlPct.toFixed(1)}%）— **波動雙向放大，不是賣訊**：實測5日內曾跌≥5% 51.9%(基準30.5%)，但10日內曾漲≥5% 也有66.6%(基準49.3%)，續抱10日均 +1.6%~+2.8% 高於單腳過熱。建議移動停利／分批，勿隔日全出`
              : `⚠️ ${code} ${g.name} RSI5 ${rr.rsi5} 高檔（RSI10 ${rr.rsi10} 未跟上）現價 ${price}（+${pnlPct.toFixed(1)}%）— 三組中**最像頂**的一組：真頂點率 1.16~1.35x 基準、續抱報酬最低。但仍僅略高於基準，建議移動停利而非一次出清`;
            newAlerts.push({ code, name: g.name, type: rtype, price, threshold: 85, pnlPct: +pnlPct.toFixed(2), rsi5: rr.rsi5, rsi10: rr.rsi10, message: m, at: Date.now() });
          }
        }

        // ⚠RSI 警報必須在此之前——下面這行的 `continue`（同類型當日已提醒過）會結束
        //   整個迭代，若順序顛倒，只要當天已發過停損/停利警報就再也收不到 RSI 警報。
        if (type) { const key = `${uid}:${code}:${type}`; if (_alerted.has(key)) continue; _alerted.add(key); newAlerts.push({ code, name: g.name, type, price, threshold: thr, pnlPct: +pnlPct.toFixed(2), message: msg, at: Date.now() }); }

      }
      if (newAlerts.length) {
        const ref = db.collection('users').doc(uid).collection('data').doc('alerts');
        const prev = (await ref.get()).data()?.alerts || [];
        await ref.set({ updatedAt: Date.now(), alerts: [...newAlerts, ...prev].slice(0, 40) });
        pushAlerts(uid, newAlerts).catch(() => {});
        for (const al of newAlerts) log(`  🔔 ${uid} ${al.message}`);
      }
    } catch (e) { log('  ✖ alerts', uid, e.message); }
  }
}

// ── 2) 產業輪動偵測 ──────────────────────────────────────────
// 用全市場快照，依 industryOf 分群，算成交值加權平均漲跌% + 漲跌家數 + 領漲股。
async function detectSectorRotation() {
  const snap = await readSnapshotQuotes(); if (!snap) return;
  const q = snap.quotes; const sec = {};
  for (const code in q) {
    const x = q[code]; if (!x || !(x.price > 0)) continue;
    const ind = industryOf(code, x.name);
    const s = (sec[ind] ??= { industry: ind, value: 0, wpct: 0, up: 0, down: 0, flat: 0, stocks: [] });
    const v = x.value || 0, cp = x.changePercent || 0;
    s.value += v; s.wpct += cp * v;
    if (cp > 0) s.up++; else if (cp < 0) s.down++; else s.flat++;
    s.stocks.push({ code, name: x.name, changePercent: cp });
  }
  const sectors = Object.values(sec).map(s => ({
    industry: s.industry,
    avgChangePct: s.value > 0 ? +(s.wpct / s.value).toFixed(2) : 0,
    value: Math.round(s.value), up: s.up, down: s.down, flat: s.flat,
    leaders: s.stocks.sort((a, b) => b.changePercent - a.changePercent).slice(0, 5),
  })).sort((a, b) => b.avgChangePct - a.avgChangePct);
  await db.collection('sectorRotation').doc('latest').set({ updatedAt: Date.now(), date: await dataDate(), marketOpen: snap.marketOpen, sectors });
  if (sectors.length) log(`✓ 產業輪動：領漲 ${sectors[0].industry}(${sectors[0].avgChangePct}%)、領跌 ${sectors[sectors.length - 1].industry}(${sectors[sectors.length - 1].avgChangePct}%)`);
}

// ── 3) 法人連續買超追蹤 ──────────────────────────────────────
// 抓最近 6 個交易日 T86，找外資/投信連續 ≥3 日買超的個股。
function recentTradingDates(n) {
  const out = []; const cur = taipei();
  if (cur.getHours() * 60 + cur.getMinutes() < 15 * 60) cur.setDate(cur.getDate() - 1); // T86 約 15:00 後才出
  for (let i = 0; i < 16 && out.length < n; i++) { if (isTradingDay(cur)) out.push(ymd8(cur)); cur.setDate(cur.getDate() - 1); }
  return out; // 由新到舊
}
// 回溯 n 個交易日(由新到舊)，可跨遠月(recentTradingDates 只回溯 16 個日曆日)。
function backTradingDates(n) {
  const out = []; const cur = taipei();
  if (cur.getHours() * 60 + cur.getMinutes() < 15 * 60) cur.setDate(cur.getDate() - 1); // T86 約 15:00 後才出
  for (let i = 0; i < 400 && out.length < n; i++) { if (isTradingDay(cur)) out.push(ymd8(cur)); cur.setDate(cur.getDate() - 1); }
  return out;
}
// 上櫃(TPEx)三大法人：dailyTrade 端點。欄位(股數)：外資合計買賣超[10]、投信[13]、
// 自營商合計[22]、三大法人合計[23]。與 T86 定義對齊（外資含自營），單位股數/1000=張。
async function fetchTpexInst(date8) {
  try {
    // ⚠ TPEx 新版 API 只認 YYYY/MM/DD；8 位數日期會被「靜默忽略」回最新資料
    //（實案 2026-07-17：歷史回填整批變今日快照）。故轉斜線格式＋回應日期回聲驗證。
    const dSlash = `${date8.slice(0, 4)}/${date8.slice(4, 6)}/${date8.slice(6, 8)}`;
    const r = await fetch(`https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${encodeURIComponent(dSlash)}&id=&response=json`, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.tpex.org.tw/' } });
    if (!r.ok) return {}; const j = await r.json();
    if (j?.date && String(j.date) !== date8) return {}; // 回聲不符＝該日無資料(假日)或被忽略
    const rows = j?.tables?.[0]?.data; if (!Array.isArray(rows)) return {};
    const m = {};
    for (const row of rows) {
      const code = (row[0] || '').trim(); if (!/^\d{4}$/.test(code)) continue;
      m[code] = {
        name: (row[1] || '').trim(),
        foreign: Math.round(_i(row[10]) / 1000),
        trust: Math.round(_i(row[13]) / 1000),
        dealer: Math.round(_i(row[22]) / 1000),
        total: Math.round(_i(row[23]) / 1000),
      };
    }
    return m;
  } catch { return {}; }
}
// 三大法人（上市 T86 + 上櫃 TPEx 合併，全市場）。
async function fetchT86(date8) {
  const m = {};
  try {
    const r = await fetch(`https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${date8}&selectType=ALL`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (r.ok) { const j = await r.json();
      // 回音驗證：T86 會 echo `date`。不比對的話，假日/無效日期拿到的是別天的法人買賣超，
      // 而籌碼差一天在隔日沖口徑上就是完全不同的結論。
      if (j?.stat === 'OK' && String(j?.date || '') !== date8) { log(`  ⚠ T86 回音 ${j?.date} ≠ 期望 ${date8}，略過`); }
      else if (j?.stat === 'OK' && Array.isArray(j.data)) {
        for (const row of j.data) {
          const code = (row[0] || '').trim(); if (!/^\d{4}$/.test(code)) continue;
          // 外資(含外資自營) row4+row7、投信 row10、自營商合計 row11、三大法人合計 row18（張）
          m[code] = {
            name: (row[1] || '').trim(),
            foreign: Math.round((_i(row[4]) + _i(row[7])) / 1000),
            trust: Math.round(_i(row[10]) / 1000),
            dealer: Math.round(_i(row[11]) / 1000),
            total: Math.round(_i(row[18]) / 1000),
          };
        }
      }
    }
  } catch { /* TWSE fail → 仍嘗試上櫃 */ }
  // 併入上櫃（不同代號空間，不會覆蓋上市）
  try { const t = await fetchTpexInst(date8); for (const c in t) if (!m[c]) m[c] = t[c]; } catch { /* skip */ }
  return Object.keys(m).length ? m : null;
}
async function trackInstitutional() {
  const dates = recentTradingDates(6); if (!dates.length) return;
  const days = [];
  for (const d of dates) { const m = await fetchT86(d); if (m) days.push({ date: d, m }); await sleep(400); }
  if (days.length < 2) { log('  ⚠ 法人追蹤：T86 取得不足'); return; }
  const codes = new Set(); for (const d of days) for (const c in d.m) codes.add(c);
  const streak = (code, field) => { let n = 0, sum = 0, name = code; for (const d of days) { const x = d.m[code]; if (x) name = x.name; if (x && x[field] > 0) { n++; sum += x[field]; } else break; } return { days: n, lots: sum, name }; };
  const foreign = [], trust = [];
  for (const c of codes) { const f = streak(c, 'foreign'); if (f.days >= 3) foreign.push({ code: c, ...f }); const t = streak(c, 'trust'); if (t.days >= 3) trust.push({ code: c, ...t }); }
  foreign.sort((a, b) => b.days - a.days || b.lots - a.lots);
  trust.sort((a, b) => b.days - a.days || b.lots - a.lots);
  await db.collection('institutionalStreaks').doc('latest').set({ updatedAt: Date.now(), latestDate: days[0].date, daysCovered: days.length, foreign: foreign.slice(0, 30), trust: trust.slice(0, 30) });
  log(`✓ 法人連續買超(≥3日)：外資 ${foreign.length} 檔、投信 ${trust.length} 檔`);
}

// ── 4) 回測勝率統計 ──────────────────────────────────────────
// 觸發 app 的 /api/cron/backtest(用真實波段訊號模型對 stockHistory 回測)。
// 走直接 Cloud Run URL(CDN 有 60s 上限)。
// 2026-08-01 修正：舊預設是 us-central1 的直連 Cloud Run 網址——region 遷移(7/31)
// 刪除該服務後就是死網址，cron/backtest 從此打空。改走 hosting 網域（region 無關）。
const CRON_BASE = process.env.CRON_BASE || 'https://tw-stock-helper.web.app';
async function runBacktest() {
  if (!process.env.CRON_SECRET) { log('  ⚠ 回測：缺 CRON_SECRET，略過'); return; }
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 150000);
  try {
    const r = await fetch(`${CRON_BASE}/api/cron/backtest?sample=80`, { method: 'POST', headers: { 'x-cron-secret': process.env.CRON_SECRET }, signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) { log('  ✖ 回測 HTTP', r.status); return; }
    const j = await r.json();
    const h10 = j?.holdingPeriods?.['10'];
    log(`✓ 回測勝率：${j.evaluatedSignals} 訊號，持有10日勝率 ${h10?.winRate}%、均報酬 ${h10?.avgReturnPct}%`);
  } catch (e) { clearTimeout(t); log('  ✖ 回測:', e.message); }
}

// ════════════════════════════════════════════════════════════
// 進階技能 v2：當沖/隔日沖、停利後再進場、RS選股、外資期貨多空、AI盤後總結
// ════════════════════════════════════════════════════════════

// 全市場收盤 CSV(含開/高/低/收/量) — www.twse 盤後即時更新。
async function fetchCloseCsvFull() {
  try {
    const res = await fetch('https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=json', { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } });
    if (!res.ok) return [];
    const out = [];
    for (const line of (await res.text()).split('\n')) {
      const m = line.match(/"([^"]*)"/g); if (!m || m.length < 9) continue;
      const f = m.map(s => s.slice(1, -1)); const code = (f[1] || '').trim();
      if (!/^\d{4}$/.test(code)) continue;
      if (!out.dataDate) out.dataDate = rocToYmd(f[0]);   // CSV 自報資料日（供上櫃檔日期合致驗證）
      out.push({ code, name: (f[2] || '').trim(), vol: _num(f[3]), value: _num(f[4]), open: _num(f[5]), high: _num(f[6]), low: _num(f[7]), close: _num(f[8]), change: _num((f[9] || '').replace('+', '')) });
    }
    return out;
  } catch { return []; }
}

// ── 5) 當沖 / 隔日沖訊號 ──────────────────────────────────────
async function computeTradeSignals() {
  const rows = await fetchCloseCsvFull(); if (rows.length === 0) return;
  const enrich = rows.filter(r => r.close > 0 && r.high > r.low && r.value > 50_000_000).map(r => {
    const amp = (r.high - r.low) / r.open * 100;
    const closePos = (r.close - r.low) / (r.high - r.low);
    const prev = r.close - r.change; const chgPct = prev > 0 ? r.change / prev * 100 : 0;
    return { code: r.code, name: r.name, close: r.close, changePct: +chgPct.toFixed(2), amplitude: +amp.toFixed(2), closePos: +closePos.toFixed(2), value: Math.round(r.value) };
  });
  // 當沖：日內振幅大 + 量能足(可操作的日內區間)。
  const dayTrade = enrich.filter(x => x.amplitude >= 3).sort((a, b) => (b.amplitude * Math.log(b.value)) - (a.amplitude * Math.log(a.value))).slice(0, 15);
  // 隔日沖：收紅 + 收盤接近當日高點(動能延續，適合留倉隔日)。
  const overnight = enrich.filter(x => x.changePct > 1.5 && x.closePos >= 0.8).sort((a, b) => (b.changePct * b.closePos) - (a.changePct * a.closePos)).slice(0, 15);
  await db.collection('tradeSignals').doc('latest').set({ updatedAt: Date.now(), date: await dataDate(), dayTrade, overnight });
  log(`✓ 當沖/隔日沖：當沖 ${dayTrade.length} 檔、隔日沖 ${overnight.length} 檔`);
}

// ── 6) 相對強弱 RS 選股 ──────────────────────────────────────
// 取成交值前 N 大為宇宙，讀 stockHistory 算 60 日報酬，百分位排名 = RS(1-99)。
async function computeRS() {
  const rows = await fetchCloseCsvFull(); if (rows.length === 0) return;
  const universe = rows.filter(r => r.value > 1e8).sort((a, b) => b.value - a.value).slice(0, 300).map(r => r.code);
  const refs = universe.map(c => db.collection('stockHistory').doc(c));
  const rets = [];
  for (let i = 0; i < refs.length; i += 300) {
    const docs = await db.getAll(...refs.slice(i, i + 300)).catch(() => []);
    for (const d of docs) {
      if (!d.exists) continue; const data = d.data(); const bars = data.bars || [];
      if (bars.length < 65) continue;
      const last = bars[bars.length - 1].c, ago = bars[bars.length - 61].c;
      if (!(ago > 0) || !(last > 0)) continue;
      rets.push({ code: data.code, name: data.name, ret60: +(((last - ago) / ago) * 100).toFixed(1) });
    }
  }
  if (rets.length < 10) { log('  ⚠ RS：歷史不足'); return; }
  rets.sort((a, b) => a.ret60 - b.ret60);
  rets.forEach((x, i) => { x.rs = Math.round((i / (rets.length - 1)) * 98) + 1; });
  const top = [...rets].sort((a, b) => b.rs - a.rs).slice(0, 30);
  await db.collection('rsRanking').doc('latest').set({ updatedAt: Date.now(), date: await dataDate(), universe: rets.length, top });
  log(`✓ RS 選股：宇宙 ${rets.length} 檔，最強 ${top[0]?.name}(RS ${top[0]?.rs}, +${top[0]?.ret60}%)`);
}

// ── 7) 外資期貨 / 選擇權多空 (TAIFEX) ─────────────────────────
// futContractsDate 回整頁 HTML，內含台指期三大法人未平倉表；抓外資多空淨額口數。
// 選擇權 Put/Call 比由 pcRatio 頁抓。HTML 解析屬 best-effort，失敗則略過。
function _stripNum(s) { const n = parseInt(String(s).replace(/[,\s]/g, ''), 10); return isNaN(n) ? null : n; }
async function trackTaifex() {
  const dates = recentTradingDates(1); const qd = dates[0] ? `${dates[0].slice(0, 4)}/${dates[0].slice(4, 6)}/${dates[0].slice(6, 8)}` : '';
  let foreignNetOI = null, pcRatio = null;
  try {
    const r = await fetch('https://www.taifex.com.tw/cht/3/futContractsDate', { method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded' }, body: `queryType=2&marketCode=0&commodity_id=TXF&queryDate=${encodeURIComponent(qd)}` });
    const html = await r.text();
    // 鎖定資料表：外資那列後面數字群，多空淨額未平倉口數通常為第 11 個數字。
    // 資料表的「外資」列在頁面最後(前面的外資多為篩選下拉選項)，取 lastIndexOf。
    const tbl = html.slice(html.indexOf('臺股期貨') >= 0 ? html.indexOf('臺股期貨') : 0);
    const fIdx = tbl.lastIndexOf('外資');
    if (fIdx >= 0) {
      const after = tbl.slice(fIdx, fIdx + 2000).replace(/<[^>]+>/g, '|');
      const nums = (after.match(/-?[\d,]{2,}/g) || []).map(_stripNum).filter(n => n != null);
      // [多方口數,多方金額,空方口數,空方金額,淨額口數,淨額金額] → 淨額口數 ≈ nums[4]
      if (nums.length >= 5) foreignNetOI = nums[4];
    }
  } catch { /* skip */ }
  try {
    const r = await fetch(`https://www.taifex.com.tw/cht/3/pcRatio?queryStartDate=${encodeURIComponent(qd)}&queryEndDate=${encodeURIComponent(qd)}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await r.text();
    const mm = html.replace(/<[^>]+>/g, '|').match(/\|(\d{1,3}\.\d{1,2})\|/g);
    if (mm && mm.length) { const v = parseFloat(mm[mm.length - 1].replace(/\|/g, '')); if (v > 0 && v < 500) pcRatio = v; }
  } catch { /* skip */ }
  if (foreignNetOI == null && pcRatio == null) { log('  ⚠ TAIFEX：解析失敗(略過)'); return; }
  await db.collection('taifexPositions').doc('latest').set({ updatedAt: Date.now(), date: dates[0] || '', foreignTxfNetOI: foreignNetOI, putCallRatio: pcRatio });
  log(`✓ 外資期貨/選擇權：外資期貨淨 ${foreignNetOI ?? 'n/a'} 口、P/C ${pcRatio ?? 'n/a'}`);
}

// ── 8) 盤後總結貼文 (真實數據套版，零幻覺 — 不經 LLM 生成數字) ──
// 為何不用 LLM：qwythos 即使加最嚴規範仍會編造個股價格/本益比等不存在的數據。
// 攸關真實金錢，改由程式直接用第二大腦的實際數字組裝，給什麼就是什麼，杜絕幻覺。
const _pct = n => `${n >= 0 ? '+' : ''}${n}%`;
async function publishDailyPost() {
  const snap = await readSnapshotQuotes(); const q = snap?.quotes || {};
  const arr = Object.values(q).filter(x => x.price > 0);
  const up = arr.filter(x => x.changePercent > 0).length;
  const down = arr.filter(x => x.changePercent < 0).length;
  const flat = arr.filter(x => x.changePercent === 0).length;
  if (up + down === 0) { log('  ⚠ 盤後總結：無有效報價，略過'); return; }
  const gainers = [...arr].sort((a, b) => b.changePercent - a.changePercent).slice(0, 5);
  const sectors = (await db.collection('sectorRotation').doc('latest').get()).data()?.sectors || [];
  const topSec = sectors[0], botSec = sectors[sectors.length - 1];
  const foreignTop = ((await db.collection('institutionalStreaks').doc('latest').get()).data()?.foreign || []).slice(0, 3);
  const sox = ((await db.collection('globalMarkets').doc('latest').get()).data()?.markets || []).find(m => m.sym === '^SOX');

  const tone = up > down * 1.5 ? '紅盤收高、多方氣盛 📈' : down > up * 1.5 ? '賣壓沉重、空方主導 📉'
    : up > down ? '小幅收紅、漲跌互見' : down > up ? '收黑回檔、觀望偏濃' : '平盤震盪';
  const L = [];
  L.push(`【大盤】上漲 ${up} 家、下跌 ${down} 家、持平 ${flat} 家 —— ${tone}`);
  if (gainers.length) L.push(`【領漲股】${gainers.map(x => `${x.name} ${_pct(x.changePercent)}`).join('、')}`);
  if (topSec) L.push(`【族群】最強 ${topSec.industry}（${_pct(topSec.avgChangePct)}）${botSec && botSec.industry !== topSec.industry ? `、最弱 ${botSec.industry}（${_pct(botSec.avgChangePct)}）` : ''}`);
  if (foreignTop.length) L.push(`【法人】外資連續買超：${foreignTop.map(x => `${x.name}（連${x.days}日）`).join('、')}`);
  if (sox && typeof sox.changePct === 'number') L.push(`【國際】費城半導體指數 ${_pct(sox.changePct)}`);
  L.push('');
  L.push('※ 本貼文由程式依證交所實際數據自動產生，未經 AI 改寫、非投資建議。');
  const post = L.join('\n');
  await db.collection('dailyPost').doc('latest').set({ date: isoDate(taipei()), generatedAt: Date.now(), model: 'template(zero-hallucination)', post, breadth: { up, down } });
  log(`✓ 盤後總結(套版,零幻覺)`);
}

// ════════════════════════════════════════════════════════════
// 進階技能 v3（第1批）：技術選股掃描器、國際盤連動
// ════════════════════════════════════════════════════════════
const _sma = (a, n) => (a.length >= n ? a.slice(-n).reduce((s, x) => s + x, 0) / n : null);

// ── 9) 技術選股掃描器 ──────────────────────────────────────────
// 用今日收盤 CSV + stockHistory，一次掃出多種強勢訊號 → scanner/latest。
async function computeScanner() {
  const csv = await fetchCloseCsvFull(); if (csv.length === 0) return;
  const byCode = {}; for (const r of csv) byCode[r.code] = r;
  const universe = csv.filter(r => r.value > 1e8).sort((a, b) => b.value - a.value).slice(0, 400).map(r => r.code);
  const refs = universe.map(c => db.collection('stockHistory').doc(c));
  const res = { newHigh52: [], volBreakout: [], maBull: [], goldenCross: [], gapUp: [], strong: [] };
  for (let i = 0; i < refs.length; i += 300) {
    const docs = await db.getAll(...refs.slice(i, i + 300)).catch(() => []);
    for (const d of docs) {
      if (!d.exists) continue; const data = d.data(); const bars = data.bars || []; if (bars.length < 60) continue;
      const t = byCode[data.code]; if (!t || !(t.close > 0)) continue;
      const hcloses = bars.map(b => b.c);
      const closes = hcloses.concat(t.close);
      const vols = bars.map(b => b.v);
      const highs = bars.map(b => b.h);
      const prevC = t.close - t.change; const chg = prevC > 0 ? t.change / prevC * 100 : 0;
      const ma5 = _sma(closes, 5), ma10 = _sma(closes, 10), ma20 = _sma(closes, 20), ma60 = _sma(closes, 60);
      const avgVol20 = _sma(vols, 20);
      const hi52 = Math.max(...highs.slice(-240), t.high || t.close);
      const o = { code: data.code, name: data.name || t.name, close: t.close, changePct: +chg.toFixed(2) };
      if ((t.high || t.close) >= hi52 * 0.999) res.newHigh52.push(o);
      if (avgVol20 > 0 && t.vol >= avgVol20 * 2 && chg > 3) res.volBreakout.push({ ...o, volX: +(t.vol / avgVol20).toFixed(1) });
      if (ma5 && ma10 && ma20 && ma60 && ma5 > ma10 && ma10 > ma20 && ma20 > ma60) res.maBull.push(o);
      const pma5 = _sma(hcloses, 5), pma20 = _sma(hcloses, 20);
      if (ma5 && ma20 && pma5 && pma20 && pma5 <= pma20 && ma5 > ma20) res.goldenCross.push(o);
      const prevHigh = bars[bars.length - 1]?.h;
      if (prevHigh && (t.low || t.close) > prevHigh && chg > 0) res.gapUp.push(o);
      if (chg >= 9) res.strong.push(o);
    }
  }
  for (const k in res) res[k] = res[k].sort((a, b) => b.changePct - a.changePct).slice(0, 15);
  await db.collection('scanner').doc('latest').set({ updatedAt: Date.now(), date: await dataDate(), ...res });
  log(`✓ 技術掃描：新高${res.newHigh52.length} 爆量${res.volBreakout.length} 多頭排列${res.maBull.length} 黃金交叉${res.goldenCross.length} 缺口${res.gapUp.length} 飆股${res.strong.length}`);
}

// ── 10) 國際盤連動（隔夜美股 / 費半 / 匯率 / 油價）→ 開盤預期 ──
async function computeGlobalMarkets() {
  const syms = [['^SOX', '費半'], ['^IXIC', '那斯達克'], ['^DJI', '道瓊'], ['^GSPC', '標普500'], ['TWD=X', '美元台幣'], ['CL=F', '西德州原油']];
  const out = [];
  for (const [sym, name] of syms) {
    try {
      const j = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.json());
      const m = j?.chart?.result?.[0]?.meta; if (!m || !(m.regularMarketPrice > 0)) continue;
      const price = m.regularMarketPrice, prev = m.chartPreviousClose || m.previousClose || price;
      out.push({ sym, name, price: +price.toFixed(2), changePct: prev > 0 ? +(((price - prev) / prev) * 100).toFixed(2) : 0 });
    } catch { /* skip */ }
    await sleep(200);
  }
  if (!out.length) return;
  const sox = out.find(x => x.sym === '^SOX');
  const expectation = sox ? (sox.changePct > 1 ? '電子偏多' : sox.changePct < -1 ? '電子偏空' : '中性') : '中性';
  await db.collection('globalMarkets').doc('latest').set({ updatedAt: Date.now(), markets: out, expectation });
  log(`✓ 國際盤：費半 ${sox?.changePct ?? 'n/a'}% → ${expectation}`);
}

// ── 日韓早盤風向（台股開盤前的領先窗口）──────────────────────────
// 時區事實：日本與韓國都是 UTC+9，兩地 09:00 開盤 ＝ **台北 08:00**。
//   台股 08:30 試撮、09:00 開盤 ⇒ 開盤前有 30~60 分鐘的日韓實盤資訊。
//
// 預測力實測（screen-asia-premarket.mjs·2026-08-03·n=54 交易日）：
//   與台股「開盤→收盤」（唯一可交易口徑）的相關係數
//     日經合計(08:30價/前收) 0.642 ｜日韓平均合計 0.592 ｜費半隔夜(對照) 0.470
//   三分位（日韓平均合計 → 台股開→收）：
//     最弱1/3(≤-0.79%) 均 -1.298%·上漲 17%
//     中間1/3           均 +0.252%·上漲 61%
//     最強1/3(≥+1.12%) 均 +0.950%·上漲 72%
//   增量（控制費半隔夜）：費半強的一半 差 +1.117pp(同向✓)／費半弱的一半 +0.026pp≈0
//     ⇒ 日韓早盤的加值集中在「美股漲了但亞洲買不買單」的日子。
// ⚠**樣本僅 54 日**（Yahoo 5分K 60天上限），遠低於本站 480日主窗＋OOT 標準。
//   故一律標示為**初步**，並逐日歸檔 asiaPremarketArchive 供日後正式重測。
//
// 唯一不變式：daemon 每日固定 ~50 次請求（12 檔 × 4~5 輪·每檔 1 次日線），與線上人數無關。
const ASIA_IDX = [
  ['^N225', '日經225', 'JP'], ['^KS11', 'KOSPI', 'KR'], ['^KQ11', 'KOSDAQ', 'KR'],
];
// 產業風向：日韓龍頭 → 台股對應族群（供人判讀，非自動選股）
const ASIA_BELL = [
  ['005930.KS', '三星電子', '記憶體', '南亞科2408·華邦電2344·旺宏2337'],
  ['000660.KS', 'SK海力士', '記憶體', '南亞科2408·華邦電2344·旺宏2337'],
  ['8035.T', '東京威力科創', '半導體設備', '家登3680·弘塑3131·辛耘3583'],
  ['6857.T', '愛德萬測試', '半導體設備', '家登3680·弘塑3131·辛耘3583'],
  ['034220.KS', 'LG Display', '面板', '友達2409·群創3481'],
  ['6981.T', '村田製作所', '被動元件', '國巨2327·華新科2492'],
  ['6954.T', '發那科', '工業自動化', '上銀2049·亞德客-KY1590'],
  ['7203.T', '豐田', '車用電子', '和大1536·為升2231'],
  ['6758.T', 'Sony', '影像感測', '原相3227·同欣電6271'],
];
// ⚠**不可用 meta.chartPreviousClose**（2026-08-03 實測踩到）：Yahoo 在 range=Nd 下
//   回的是「整個視窗之前」的收盤，不是前一交易日——實測 KOSPI 會算出 +13.24% 跳空、
//   發那科 -17%，全是假的。必須自行把 5 分 K 依 UTC 日分組、取前一交易日最後一根收盤。
//   （日韓 09:00 開盤＝00:00 UTC，所以 UTC 日 == 當地交易日，分組不會錯位。）
// ⚠**兩個踩過的坑，改動前務必看**（2026-08-03）：
//   ① 不可用 `meta.chartPreviousClose`——Yahoo 在 range=Nd 下回的是「整個視窗之前」
//      的收盤而非前一交易日，實測算出 KOSPI 跳空 +13.24%、發那科 -17% 這種假數字。
//   ② 不可用 5 分 K 自行推導前收——流動性較低的個股會**缺整日**的 5m 資料。
//      實測村田製作所缺 07-31，前收被抓成 07-30 的 6416，算出 +12.47%（日線實為 -2.68%）。
//   ⇒ 一律以**日線**推導：前收＝倒數第2根收盤、今開＝最後一根開盤、現價＝meta。
//      已用日線逐檔對帳：日經 -2.31%、三星 -7.24%、發那科 -17.93%、村田 -2.71%，全數相符。
async function _asiaQuote(sym) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 12000);
  try {
    const j = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=10d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctl.signal }).then(r => r.ok ? r.json() : null).finally(() => clearTimeout(tm));
    const r = j?.chart?.result?.[0]; const m = r?.meta;
    if (!m) return null;
    const ts = r.timestamp || [], q = r.indicators?.quote?.[0] || {};
    const rows = [];
    for (let i = 0; i < ts.length; i++) {
      if (!(q.close?.[i] > 0)) continue;
      rows.push({ d: new Date(ts[i] * 1000).toISOString().slice(0, 10), o: q.open?.[i], c: q.close[i] });
    }
    if (rows.length < 2) return null;
    const cur = rows[rows.length - 1], prev = rows[rows.length - 2].c;
    if (!(prev > 0)) return null;
    const px = m.regularMarketPrice > 0 ? m.regularMarketPrice : cur.c;
    if (!(px > 0)) return null;
    return {
      price: +px.toFixed(2), prev: +prev.toFixed(2), prevDate: rows[rows.length - 2].d,
      gap: cur.o > 0 ? +((cur.o / prev - 1) * 100).toFixed(2) : null,   // 開盤跳空
      drift: cur.o > 0 ? +((px / cur.o - 1) * 100).toFixed(2) : null,   // 開盤後走勢（新資訊）
      total: +((px / prev - 1) * 100).toFixed(2),                       // 合計（預測力最強）
    };
  } catch { clearTimeout(tm); return null; }
}
async function computeAsiaPremarket({ lateCatchup = false } = {}) {
  const tw = taipei(); const today = isoDate(tw);
  const idx = [], bells = [];
  for (const [sym, name, mkt] of ASIA_IDX) {
    const q = await _asiaQuote(sym);
    if (q) idx.push({ sym, name, mkt, ...q });
    await sleep(250);
  }
  if (!idx.length) { log('✖ 日韓早盤：指數全數抓取失敗'); return; }
  for (const [sym, name, sector, twPeers] of ASIA_BELL) {
    const q = await _asiaQuote(sym);
    if (q) bells.push({ sym, name, sector, twPeers, ...q });
    await sleep(250);
  }
  // 綜合分數＝日經與 KOSPI 的「合計」平均（實測相關 0.592，優於費半 0.470）
  const nk = idx.find(x => x.sym === '^N225'), ks = idx.find(x => x.sym === '^KS11');
  const parts = [nk?.total, ks?.total].filter(v => v != null);
  const score = parts.length ? +(parts.reduce((a, b) => a + b, 0) / parts.length).toFixed(2) : null;
  // 分界取自三分位實測（最弱1/3 上界 -0.79%、最強1/3 下界 +1.12%）
  const bias = score == null ? null : score >= 1.12 ? 'bull' : score <= -0.79 ? 'bear' : 'neutral';
  const biasNote = bias === 'bull' ? '偏多——實測此區間台股開→收 均 +0.950%·上漲 72%（n=18）'
    : bias === 'bear' ? '偏空——實測此區間台股開→收 均 -1.298%·上漲 17%（n=18）'
    : bias === 'neutral' ? '中性——實測此區間台股開→收 均 +0.252%·上漲 61%（n=18）' : null;
  // 產業風向：同族群龍頭取平均
  const bySec = {};
  for (const b of bells) {
    const g = (bySec[b.sector] ||= { sector: b.sector, twPeers: b.twPeers, names: [], vals: [] });
    g.names.push(b.name); g.vals.push(b.total);
  }
  const sectors = Object.values(bySec).map(g => ({
    sector: g.sector, twPeers: g.twPeers, leaders: g.names.join('·'),
    chg: +(g.vals.reduce((a, b) => a + b, 0) / g.vals.length).toFixed(2),
  })).sort((a, b) => b.chg - a.chg);
  // 費半隔夜（增量檢定顯示：日韓的加值集中在費半強的日子）
  let sox = null;
  try { sox = (await db.collection('globalMarkets').doc('latest').get()).data()?.markets?.find(x => x.sym === '^SOX')?.changePct ?? null; } catch { /* 可缺 */ }
  const soxNote = sox == null ? null
    : sox > 0 ? `費半隔夜 +${sox}%（強）——**此時日韓早盤的增量最大**（實測差 +1.117pp·同向），日韓若不跟漲要提高警覺`
      : `費半隔夜 ${sox}%（弱）——實測此時日韓早盤幾乎無增量（差 +0.026pp≈0），今日主要看美股臉色`;

  const doc = {
    date: today, updatedAt: Date.now(), twOpenIn: Math.max(0, 9 * 60 - (tw.getHours() * 60 + tw.getMinutes())),
    // ⚠補跑標記：08:00–09:05 盤前窗口沒跑到（daemon 或機器當時沒開）才會為 true。
    //   補跑的快照**不是盤前觀測值**——台股已開盤，日韓走勢已含台股反饋，
    //   拿它當領先指標會是前視偏誤。回測時必須排除 lateCatchup 的樣本。
    lateCatchup,
    indices: idx, bellwethers: bells, sectors, score, bias, biasNote, sox, soxNote,
    horizon: '對應台股「開盤→收盤」（08:30 看到訊號、09:00 買、13:30 賣，可執行）；開盤跳空不可交易故不列為目標',
    evidence: '相關係數 vs 台股開→收：日經合計 0.642｜日韓平均合計 0.592｜費半隔夜 0.470（n=54 交易日·2026-05-11~07-31）。三分位單調：最弱1/3 -1.298%·上漲17%／中間 +0.252%·上漲61%／最強1/3 +0.950%·上漲72%。',
    caveats: [
      '⚠樣本僅 54 個交易日（Yahoo 5分K 60天上限），**遠低於本站 480日主窗＋第三獨立窗的標準**——本卡結論一律視為初步，不可當作已驗證權重使用。',
      '⚠日韓與台股高度同步的部分多半來自共同因子（美股隔夜、全球風險偏好），不等於因果。真正的增量只在費半強的日子（實測 +1.117pp vs +0.026pp）。',
      '⚠產業風向是「人判讀用」的對照表，未經個股層級回測——龍頭漲不等於台股同族群會漲。',
      'ℹ已逐日歸檔 asiaPremarketArchive，累積足夠樣本後會用本站標準重測並更新此處數字。',
      lateCatchup ? '⚠**本筆為補跑**：盤前窗口（08:00–09:05）未取得資料，此快照在台股開盤後才產生——台股已反應，不具領先意義，僅作歸檔完整性用途，請勿當今日盤前判斷。' : null,
    ].filter(Boolean),
  };
  // ⚠寫入順序：**歸檔先、latest 後**。補跑守衛是用 `latest.date === today` 判斷
  //   「今天已經有了」，若順序相反，一次「latest 寫成功但歸檔失敗」就會讓守衛
  //   永久認定今天已完成、再也不補跑（2026-08-03 實際發生過：FieldValue 未 import
  //   導致歸檔炸掉，latest 卻已寫入，補跑從此跳過）。latest 當 commit marker。
  await db.collection('asiaPremarketArchive').doc(today).set({
    date: today, snapshots: FieldValue.arrayUnion({
      at: Date.now(), hm: `${String(tw.getHours()).padStart(2, '0')}:${String(tw.getMinutes()).padStart(2, '0')}`, lateCatchup,
      score, idxJson: JSON.stringify(idx.map(x => [x.sym, x.gap, x.drift, x.total])),
      bellJson: JSON.stringify(bells.map(x => [x.sym, x.total])),
    }),
  }, { merge: true });
  await db.collection('asiaPremarket').doc('latest').set(doc);
  log(`✓ 日韓早盤${lateCatchup ? '(補跑)' : ''}：日經 ${nk?.total ?? 'n/a'}%·KOSPI ${ks?.total ?? 'n/a'}% → 綜合 ${score}%（${bias}）｜最強族群 ${sectors[0]?.sector} ${sectors[0]?.chg}%`);
}

// ════════════════════════════════════════════════════════════
// 進階技能 v3（第2批）：月營收追蹤、融資融券軋空候選
// ════════════════════════════════════════════════════════════
const _f = v => { const n = parseFloat(String(v).replace(/[,\s]/g, '')); return isNaN(n) ? 0 : n; };

// ── 11) 月營收追蹤（YoY / MoM）──────────────────────────────────
async function computeRevenue() {
  const rows = await fetchMonthlyRevenueAll(); // t187ap05_L+_P 合併（原僅 _P 漏台積電等 1082 檔一般業）
  if (!rows.length) return;
  const items = rows.filter(x => /^\d{4}$/.test(x['公司代號'] || '')).map(x => ({
    code: x['公司代號'], name: x['公司名稱'], industry: x['產業別'] || '',
    revenue: Math.round(_f(x['營業收入-當月營收'])),
    yoy: +_f(x['營業收入-去年同月增減(%)']).toFixed(1),
    mom: +_f(x['營業收入-上月比較增減(%)']).toFixed(1),
  })).filter(x => x.revenue > 0);
  const month = rows[0]?.['資料年月'] || '';
  const topYoY = [...items].sort((a, b) => b.yoy - a.yoy).slice(0, 20);
  const topMoM = [...items].sort((a, b) => b.mom - a.mom).slice(0, 20);
  await db.collection('revenue').doc('latest').set({ updatedAt: Date.now(), month, topYoY, topMoM });
  log(`✓ 月營收(${month})：YoY 最強 ${topYoY[0]?.name}(+${topYoY[0]?.yoy}%)`);
}

// ── 12) 融資融券軋空候選 ───────────────────────────────────────
async function computeMargin() {
  // 2026-07-31：原本用 openapi/v1/exchangeReport/MI_MARGN —— 那支**連日期欄位都沒有**，
  // 完全無法判斷拿到的是哪一天的餘額，而融資融券餘額差一天就是完全不同的軋空判讀。
  // 改用可指定日期且會回音 `date` 的 rwd 端點。
  const expect = ymd8(taipei());
  const res = await fetchDated(
    `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${expect}&selectType=ALL&response=json`, expect);
  if (!res.ok) { log('  ⚠ 融資融券：', res.why, '（略過，不寫入舊資料）'); return; }
  // rwd 版是二維陣列：代號,名稱,買進,賣出,現金償還,前日餘額,今日餘額,次一營業日限額,
  //                   (融券)買進,賣出,現券償還,前日餘額,今日餘額,次一營業日限額,…
  const tb = (res.json.tables || []).find(t => (t.data || []).length > 100);
  const rows = (tb?.data || []).map(r => ({
    '股票代號': String(r[0] || '').trim(), '股票名稱': String(r[1] || '').trim(),
    '融資前日餘額': r[5], '融資今日餘額': r[6],
    '融券前日餘額': r[11], '融券今日餘額': r[12],
  }));
  if (!rows.length) return;
  const items = rows.filter(x => /^\d{4}$/.test(x['股票代號'] || '')).map(x => {
    const marginBal = _f(x['融資今日餘額']), marginPrev = _f(x['融資前日餘額']);
    const shortBal = _f(x['融券今日餘額']), shortPrev = _f(x['融券前日餘額']);
    return {
      code: x['股票代號'], name: x['股票名稱'],
      marginBal, marginChg: marginBal - marginPrev,
      shortBal, shortChg: shortBal - shortPrev,
      shortRatio: marginBal > 0 ? +((shortBal / marginBal) * 100).toFixed(1) : 0, // 券資比%
    };
  });
  // 軋空候選：券資比高 + 融券增加(空方加碼，易軋空)。
  const squeeze = items.filter(x => x.shortRatio >= 10 && x.shortBal > 500).sort((a, b) => b.shortRatio - a.shortRatio).slice(0, 20);
  // 融資大增(散戶追價/籌碼集中觀察)。
  const marginSurge = items.filter(x => x.marginChg > 0).sort((a, b) => b.marginChg - a.marginChg).slice(0, 15);
  await db.collection('marginShort').doc('latest').set({ updatedAt: Date.now(), date: isoFromYmd8(res.dataDate), squeeze, marginSurge });
  log(`✓ 融資軋空：高券資比 ${squeeze.length} 檔(最高 ${squeeze[0]?.name} ${squeeze[0]?.shortRatio}%)`);
}

// ════════════════════════════════════════════════════════════
// 進階技能 v3（第3批）：集保大戶持股、個人化每日摘要
// ════════════════════════════════════════════════════════════

// (13 集保大戶 computeMajorHolders 已移除：死碼，由 computeMajorHoldersChange 取代)

// ── 14) 個人化每日摘要（本地 LLM，每位 premium 用戶）─────────────
async function publishUserSummaries() {
  const snap = await readSnapshotQuotes(); const q = snap?.quotes || {};
  const arr = Object.values(q).filter(x => x.price > 0);
  const up = arr.filter(x => x.changePercent > 0).length, down = arr.filter(x => x.changePercent < 0).length;
  const gm = (await db.collection('globalMarkets').doc('latest').get()).data();
  const sox = (gm?.markets || []).find(m => m.sym === '^SOX');
  const premium = await getPremiumUsers();
  for (const u of premium) {
    const uid = u.id;
    try {
      const hd = await db.collection('users').doc(uid).collection('data').doc('holdings').get();
      const holdings = hd.exists ? (hd.data().holdings || []) : []; if (!holdings.length) continue;
      const byCode = {};
      for (const h of holdings) { const c = (byCode[h.code] ??= { name: h.name, qty: 0, cost: 0 }); c.qty += h.quantity; c.cost += h.buyPrice * h.quantity; }
      const lines = Object.entries(byCode).map(([code, g]) => {
        const avg = g.qty ? g.cost / g.qty : 0; const price = q[code]?.price ?? avg;
        const pnl = avg > 0 ? ((price - avg) / avg * 100).toFixed(1) : '0';
        return `${code} ${g.name}：現價 ${price}、損益 ${pnl}%`;
      });
      const prompt = `你是私人理財助理。用繁體中文寫一段「今日個人投資摘要」(150-200字，溫和專業)，給這位投資人看：點出持股今日表現、需注意的部位、搭配大盤氛圍給1-2個務實提醒。勿杜撰數據，結尾加「※ AI 摘要，非投資建議」。${STRICT_RULE}
【大盤】上漲 ${up} 家/下跌 ${down} 家；費半 ${sox?.changePct ?? 'n/a'}%
【持股】\n${lines.join('\n')}`;
      const out = await askOllama(prompt);
      if (!out) continue;
      await db.collection('users').doc(uid).collection('data').doc('dailySummary').set({ date: isoDate(taipei()), generatedAt: Date.now(), model: OLLAMA_MODEL, summary: out.trim().slice(0, 800) });
      log(`  ✓ 個人摘要 ${uid}`);
    } catch (e) { log('  ✖ 個人摘要', uid, e.message); }
  }
}

// ════════════════════════════════════════════════════════════
// 進階技能 v3（第4批）：交易日誌自動覆盤
// ════════════════════════════════════════════════════════════
// 每位 premium 用戶的交易紀錄(users/{uid}/data/trades) → 統計勝率/盈虧 → LLM 檢討。
// 交易帳本重放（daemon 版）——逐 code 按時間重放，加權平均成本含買進手續費。
// ⚠鏡像警告：這是 src/lib/portfolio-calc.ts `buildLedger` 的精簡 mjs 副本，
//   兩邊口徑必須一致（wm-source-aggregation「mirror 漂移」風險）。
//   不一致的後果很具體：2026-08-01 前 AI 覆盤讀存死的 realizedPnL，
//   同一頁上方寫「總損益 -712,785」、下方重算寫 -533,480，使用者兩邊都不敢信。
function replayLedger(records) {
  const sorted = [...records].sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.createdAt || 0) - (b.createdAt || 0));
  const st = {}, closed = [], byStock = {};
  let buyCount = 0, oversoldCount = 0;
  for (const t of sorted) {
    if (t.type === 'dividend') continue;
    (st[t.code] ??= { lots: 0, cost: 0 });
    if (t.type === 'buy') { st[t.code].lots += t.quantity; st[t.code].cost += Math.abs(t.totalAmount); buyCount++; continue; }
    const s = st[t.code];
    const matched = Math.min(t.quantity, s.lots);
    if (t.quantity - matched > 1e-6) oversoldCount++;
    const shares = Math.round(s.lots * 1000);
    const avgCost = shares > 0 ? s.cost / shares : 0;
    const matchedCost = avgCost * Math.round(matched * 1000);
    const pnl = Math.round((t.quantity > 0 ? t.totalAmount * (matched / t.quantity) : 0) - matchedCost);
    s.lots = +(s.lots - matched).toFixed(6);
    s.cost = s.lots > 0 ? s.cost - matchedCost : 0;
    if (matched > 0) {
      closed.push({ code: t.code, name: t.name, pnl });
      (byStock[t.code] ??= { name: t.name, pnl: 0, n: 0 });
      byStock[t.code].pnl += pnl; byStock[t.code].n++;
    }
  }
  return { closed, byStock, buyCount, oversoldCount };
}

async function publishTradeReviews() {
  const premium = await getPremiumUsers();
  for (const u of premium) {
    const uid = u.id;
    try {
      const td = await db.collection('users').doc(uid).collection('data').doc('trades').get();
      const trades = td.exists ? (td.data().trades || td.data().tradeRecords || []) : [];
      // 2026-08-01：改用帳本重放，不再讀存死的 realizedPnL（那是記錄當下用
      // 手動持倉成本算的，與交易紀錄脫鉤時會給出錯誤的覆盤結論）。
      const { closed: sells, byStock, buyCount, oversoldCount } = replayLedger(trades);
      if (sells.length < 3) continue; // 太少不覆盤
      const wins = sells.filter(t => t.pnl > 0), losses = sells.filter(t => t.pnl < 0);
      const winRate = (wins.length / sells.length * 100).toFixed(0);
      const avgWin = wins.length ? Math.round(wins.reduce((s, t) => s + t.pnl, 0) / wins.length) : 0;
      const avgLoss = losses.length ? Math.round(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
      const totalRealized = Math.round(sells.reduce((s, t) => s + t.pnl, 0));
      const worst = Object.entries(byStock).sort((a, b) => a[1].pnl - b[1].pnl)[0];
      const best = Object.entries(byStock).sort((a, b) => b[1].pnl - a[1].pnl)[0];
      const prompt = `你是專業交易教練。依下列交易統計，用繁體中文寫一段「交易覆盤檢討」(180-240字)：點出交易習慣優缺點(如勝率、盈虧比、是否凹單/賣太早/過度交易)，給2-3個具體可執行的改進建議。語氣中肯鼓勵。勿杜撰數據，結尾加「※ AI 覆盤，非投資建議」。${STRICT_RULE}
【交易統計】已實現勝率 ${winRate}%(${wins.length}勝/${losses.length}負)、平均獲利 ${avgWin}、平均虧損 ${avgLoss}、盈虧比 ${avgLoss !== 0 ? Math.abs(avgWin / avgLoss).toFixed(2) : 'N/A'}、總已實現損益 ${totalRealized}、買進次數 ${buyCount}、賣出次數 ${sells.length}；最賺 ${best?.[1]?.name}(${Math.round(best?.[1]?.pnl)})、最賠 ${worst?.[1]?.name}(${Math.round(worst?.[1]?.pnl)})`;
      const out = await askOllama(prompt);
      if (!out) continue;
      await db.collection('users').doc(uid).collection('data').doc('tradeReview').set({
        generatedAt: Date.now(), model: OLLAMA_MODEL, review: out.trim().slice(0, 900),
        stats: { winRate: +winRate, wins: wins.length, losses: losses.length, avgWin, avgLoss, totalRealized, basis: 'ledger-replay', oversoldCount },
      });
      log(`  ✓ 交易覆盤 ${uid}`);
    } catch (e) { log('  ✖ 交易覆盤', uid, e.message); }
  }
}

// ════════════════════════════════════════════════════════════
// 進階技能 v3（第5批）：RAG 問答（第二大腦檢索 + 本地 LLM）
// Cloud Run 連不到本機 Ollama，故採非同步佇列：前端寫問題到
// users/{uid}/data/questions(items[])，daemon 檢索資料+Ollama 回答後回寫，前端訂閱。
// ════════════════════════════════════════════════════════════
async function buildQAContext(code, name) {
  const [rating, ai] = await Promise.all([
    getJSON(`/api/rating?code=${code}`),
    db.collection('stockAI').doc(code).get().then(d => d.exists ? d.data() : null).catch(() => null),
  ]);
  const st = rating?.stock; const f = rating?.fundamentals; const sw = rating?.swingSignal;
  const lines = [`股票：${code} ${name || st?.name || ''}`];
  if (st) {
    lines.push(`現價 ${st.price}、今日 ${st.changePercent}%、AI技術評分 ${st.score}(${st.grade})、訊號 ${st.signal}`);
    if (st.buyZones?.length) lines.push(`支撐買點：${st.buyZones.map(z => `${z.label}${z.price}`).join('、')}`);
    if (st.sellTargets?.length) lines.push(`目標價：${st.sellTargets.filter(t => t.type !== 'trailing').map(t => t.price).join('、')}、停損 ${st.stopLoss}`);
    if (st.isAttention || st.isDisposition) lines.push(`⚠️ ${st.isDisposition ? '處置股' : '注意股'}`);
  }
  if (sw) lines.push(`波段訊號 ${sw.actionLabel}(紀律分 ${sw.score}/100、${sw.trend}、乖離 ${sw.biasPct}%${sw.chase ? '、追高風險' : ''})`);
  if (f?.valuation) lines.push(`PER ${f.valuation.pe}/殖利率 ${f.valuation.dividendYield}%/PBR ${f.valuation.pb}`);
  if (f?.institutional) lines.push(`三大法人(張) 外資 ${f.institutional.foreignNetLots}、投信 ${f.institutional.trustNetLots}、自營商 ${f.institutional.dealerNetLots}`);
  if (ai?.swing) lines.push(`本地AI波段分析：${ai.swing}`);
  const news = ai?.news || [];
  if (news.length) lines.push(`近期新聞：\n${news.slice(0, 6).map(n => `・${n.title}`).join('\n')}`);
  return lines.join('\n');
}

async function answerQuestions() {
  const premium = await getPremiumUsers();
  for (const u of premium) {
    const ref = db.collection('users').doc(u.id).collection('data').doc('questions');
    let items = [];
    try { const snap = await ref.get(); items = snap.exists ? (snap.data().items || []) : []; } catch { continue; }
    const pending = items.filter(it => it.status === 'pending');
    if (!pending.length) continue;
    for (const q of pending.slice(0, 3)) {
      try {
        let ctx = await buildQAContext(q.code, q.name);
        // 規則/稅務類問題 → 附上交易規則知識庫，讓 AI 答得正確不亂編
        if (/稅|交割|T\+?2|漲停|跌停|手續費|開戶|零股|交易時間|成本|股利|證所稅|資本利得|盤後|內線|法規|幾歲|申報|注意股|處置|觀察股|警示|撮合/.test(q.question)) ctx += `\n\n${TRADING_RULES}`;
        if (/漲停|連板|鎖死|飆股|強勢股.*預測|預測.*漲停/.test(q.question)) ctx += `\n\n${LIMITUP_SKILL}`;
        if (/財報|本益比|PE|EPS|每股盈餘|毛利|營益率|淨利率|ROE|淨值|體質|基本面|估值/.test(q.question)) ctx += `\n\n${FIN_SKILL}`;
        if (/倒貨|出貨|獲利了結|散戶接棒|法人.*賣|外資.*賣|主力.*出/.test(q.question)) ctx += `\n\n${DIST_SKILL}`;
        if (/洗盤|洗融資|修正|回檔|主升段|牛市|崩盤|大跌|空頭/.test(q.question)) ctx += `\n\n${WASHOUT_SKILL}`;
        if (/波段|起漲|抄底|超跌|反彈|接刀|RSI|布局|中線|持有幾天|幾日/.test(q.question)) ctx += `\n\n${SWING_SKILL}`;
        if (/當沖|三關|盤中.*選|能不能做|今天能|拉回|量能|跟風|自己強|均價線|假突破/.test(q.question)) {
          ctx += `\n\n${TRIGATE_SKILL}`;
          const tg = await buildTriGateLive(q.code);
          if (tg) ctx += `\n\n${tg}`;
        }
        if (/明日|明天|隔日|後市|買|賣|進場|出場|留倉|抱|預測|建議|操作|可以.*嗎|該不該/.test(q.question)) {
          const pred = await buildPredictSkill(q.code);
          if (pred) ctx += `\n\n${pred}`;
        }
        const prompt = `你是台股投資助理。**只能根據下列「資料」回答**使用者問題，資料沒提到的就回「目前資料中未提供」，嚴禁編造數據或臆測。用繁體中文簡潔回答(120-220字)，結尾加「※ 依第二大腦資料整理，非投資建議」。${STRICT_RULE.replace('【數據】', '【資料】')}\n\n使用者問題：${q.question}\n\n【資料】\n${ctx}`;
        const answer = await askOllama(prompt, { priority: 10 }); // 互動式優先插隊
        await db.runTransaction(async tx => {
          const d = await tx.get(ref);
          const arr = d.exists ? (d.data().items || []) : [];
          const idx = arr.findIndex(x => x.id === q.id);
          if (idx >= 0) { arr[idx] = { ...arr[idx], answer: (answer || '（本地 AI 暫無回應，請稍後再試）').slice(0, 1200), status: 'done', answeredAt: Date.now(), model: OLLAMA_MODEL }; tx.set(ref, { items: arr }, { merge: true }); }
        });
        log(`  ✓ Q&A ${u.id} ${q.code}`);
      } catch (e) { log('  ✖ Q&A', u.id, e.message); }
    }
  }
}

// ════════════════════════════════════════════════════════════
// 進階技能 v3（第6批）：除權息行事曆、借券可賣量
// ════════════════════════════════════════════════════════════

// ── 17) 除權息行事曆（未來除權息預告）──────────────────────────
async function computeDividendCalendar() {
  let rows = [];
  try { const r = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL', { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (r.ok) rows = await r.json(); } catch { /* skip */ }
  if (!rows.length) return;
  const tw = taipei();
  const todayROC = `${tw.getFullYear() - 1911}${String(tw.getMonth() + 1).padStart(2, '0')}${String(tw.getDate()).padStart(2, '0')}`; // 民國 YYYMMDD
  const items = rows.filter(x => /^\d{4}$/.test(x.Code || ''))
    .map(x => ({ code: x.Code, name: x.Name, date: x.Date, type: x.Exdividend || '', cash: x.CashDividend || '', stockRatio: x.StockDividendRatio || '' }))
    .filter(x => x.date && x.date >= todayROC) // 只看未來(含今日)
    .sort((a, b) => a.date.localeCompare(b.date));
  await db.collection('dividendCalendar').doc('latest').set({ updatedAt: Date.now(), upcoming: items.slice(0, 40) });
  log(`✓ 除權息行事曆：未來 ${items.length} 檔，最近 ${items[0]?.name}(${items[0]?.date})`);
}

// ── 18) 借券可賣量（當日可借券賣出股數）────────────────────────
async function computeLending() {
  // 2026-07-31：原本用 openapi/v1/SBL/TWT96U —— 一樣沒有日期欄位。
  // rwd 版把日期寫在 title（「115年07月31日 當日可借券賣出股數」）。
  // ⚠ 這支**會忽略 date 參數**（「當日可借券」本來就只有當日概念，沒有歷史查詢），
  //   所以不能靠參數，只能解析 title 驗證拿到的確實是今天那一份。
  const expect = ymd8(taipei());
  const res = await fetchDated(
    `https://www.twse.com.tw/rwd/zh/marginTrading/TWT96U?date=${expect}&response=json`, expect, 'title', 'forward');
  if (!res.ok) { log('  ⚠ 借券可賣量：', res.why, '（略過，不寫入舊資料）'); return; }
  // ⚠ rwd 版是**雙欄配對**：一列放兩檔（[上市代號, 上市可借量, 上櫃代號, 上櫃可借量]），
  //   而且代號包在 `<a href=...>2330</a>` 裡。openapi 版欄位乾淨但沒有日期，
  //   要日期就得吃這個版型 —— 兩欄都收，比原本只取上市更完整。
  const unTag = v => String(v ?? '').replace(/<[^>]*>/g, '').trim();
  const items = [];
  for (const r of (res.json.data || [])) {
    for (const [ci, vi] of [[0, 1], [2, 3]]) {
      const code = unTag(r[ci]);
      const avail = _f(r[vi]);
      if (/^\d{4}$/.test(code) && avail > 0) items.push({ code, avail });
    }
  }
  items.sort((a, b) => b.avail - a.avail);
  if (!items.length) return;
  await db.collection('lending').doc('latest').set({
    updatedAt: Date.now(), date: isoFromYmd8(res.dataDate), top: items.slice(0, 30) });
  log(`✓ 借券可賣量：最高 ${items[0]?.code}(${Math.round((items[0]?.avail || 0) / 1000)}張)`);
}

// ════════════════════════════════════════════════════════════
// 進階技能 v4：大盤健康度、高股息存股、投組相關性/分散度（移動停利在 checkAlerts）
// ════════════════════════════════════════════════════════════

// ── 20) 大盤健康度儀表 ────────────────────────────────────────
async function computeMarketHealth() {
  const snap = await readSnapshotQuotes(); if (!snap) return;
  const arr = Object.values(snap.quotes).filter(x => x.price > 0);
  const up = arr.filter(x => x.changePercent > 0).length;
  const down = arr.filter(x => x.changePercent < 0).length;
  const flat = arr.filter(x => x.changePercent === 0).length;
  const limitUp = arr.filter(x => x.changePercent >= 9.5).length;
  const limitDown = arr.filter(x => x.changePercent <= -9.5).length;
  const total = up + down + flat || 1;
  const newHigh = ((await db.collection('scanner').doc('latest').get().then(d => d.data()).catch(() => null))?.newHigh52 || []).length;
  const upRatio = up / total * 100;
  let health = upRatio * 0.5 + Math.max(0, Math.min(50, (limitUp - limitDown) * 5 + 25)) * 0.25 + Math.min(100, newHigh * 4) * 0.25;
  health = Math.round(Math.max(0, Math.min(100, health)));
  const mood = health >= 65 ? '偏多／強勢' : health >= 45 ? '中性／震盪' : '偏空／弱勢';
  await db.collection('marketHealth').doc('latest').set({ updatedAt: Date.now(), date: isoDate(taipei()), health, mood, up, down, flat, limitUp, limitDown, upRatio: +upRatio.toFixed(1), newHigh });
  log(`✓ 大盤健康度：${health}/100 ${mood}（漲${up}/跌${down}）`);
}

// ── 21) 高股息存股評估 ────────────────────────────────────────
async function computeDividendStocks() {
  const bwRes = await fetchBwibbu();
  const rows = bwRes.rows;
  if (!rows.length) return;
  const items = rows.filter(x => /^\d{4}$/.test(x.Code || ''))
    .map(x => ({ code: x.Code, name: x.Name, yield: _f(x.DividendYield), pe: _f(x.PEratio), pb: _f(x.PBratio) }))
    .filter(x => x.yield >= 4 && x.pe > 0 && x.pe <= 20 && x.pb > 0 && x.pb <= 3)
    .sort((a, b) => b.yield - a.yield);
  await db.collection('dividendStocks').doc('latest').set({ updatedAt: Date.now(), date: bwRes.dataDate, source: bwRes.source, top: items.slice(0, 30) });
  log(`✓ 高股息存股：${items.length} 檔(殖利率≥4%/PER≤20/PBR≤3)，最高 ${items[0]?.name}(${items[0]?.yield}%)`);
}

// ── 22) 投組相關性 / 分散度 / 集中度（每位 premium 用戶）──────
function _pearson(a, b) {
  const n = Math.min(a.length, b.length); if (n < 10) return null;
  const x = a.slice(-n), y = b.slice(-n);
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}
async function computeUserRisk() {
  const premium = await getPremiumUsers();
  for (const u of premium) {
    try {
      const hd = await db.collection('users').doc(u.id).collection('data').doc('holdings').get();
      const holdings = hd.exists ? (hd.data().holdings || []) : []; if (holdings.length < 2) continue;
      const codes = [...new Set(holdings.map(h => h.code))];
      const docs = await db.getAll(...codes.map(c => db.collection('stockHistory').doc(c))).catch(() => []);
      const rets = {};
      for (const d of docs) { if (!d.exists) continue; const bars = d.data().bars || []; if (bars.length < 61) continue; const c = bars.slice(-61).map(b => b.c); const r = []; for (let i = 1; i < c.length; i++) if (c[i - 1] > 0) r.push((c[i] - c[i - 1]) / c[i - 1]); rets[d.id] = r; }
      const cc = Object.keys(rets); let sum = 0, np = 0, maxPair = { corr: -1 };
      for (let i = 0; i < cc.length; i++) for (let j = i + 1; j < cc.length; j++) { const co = _pearson(rets[cc[i]], rets[cc[j]]); if (co != null) { sum += co; np++; if (co > maxPair.corr) maxPair = { corr: co, a: cc[i], b: cc[j] }; } }
      const avgCorr = np ? sum / np : 0;
      const sectorVal = {}; let tot = 0;
      for (const h of holdings) { const ind = industryOf(h.code, h.name); const v = h.buyPrice * h.quantity * 1000; sectorVal[ind] = (sectorVal[ind] || 0) + v; tot += v; }
      const hhi = tot > 0 ? Object.values(sectorVal).reduce((s, v) => s + (v / tot) ** 2, 0) : 0;
      const topSec = Object.entries(sectorVal).sort((a, b) => b[1] - a[1])[0];
      await db.collection('users').doc(u.id).collection('data').doc('portfolioRisk').set({
        updatedAt: Date.now(), holdings: codes.length,
        avgCorrelation: +avgCorr.toFixed(2),
        diversification: avgCorr < 0.3 ? '良好（持股連動低）' : avgCorr < 0.6 ? '中等' : '偏低（持股高度連動，分散效果差）',
        concentrationHHI: +hhi.toFixed(2),
        concentration: hhi > 0.5 ? '過度集中' : hhi > 0.3 ? '略集中' : '分散',
        topSector: topSec ? { name: topSec[0], pct: +(topSec[1] / tot * 100).toFixed(0) } : null,
        highestPair: maxPair.a ? { a: maxPair.a, b: maxPair.b, corr: +maxPair.corr.toFixed(2) } : null,
        rebalanceHint: hhi > 0.4 || avgCorr > 0.6 ? `建議降低${topSec ? topSec[0] : '主要族群'}比重、加入低相關標的以分散風險` : '分散度尚可，維持紀律',
      });
      log(`  ✓ 投組風險 ${u.id}（平均相關 ${avgCorr.toFixed(2)}、集中HHI ${hhi.toFixed(2)}）`);
    } catch (e) { log('  ✖ 投組風險', u.id, e.message); }
  }
}

// ════════════════════════════════════════════════════════════
// 進階技能 v4 第2批：多時間框架共振、籌碼集中度週變化
// ════════════════════════════════════════════════════════════

// ── 23) 多時間框架共振（日/週/月三線齊揚）────────────────────
async function computeMultiTimeframe() {
  const csv = await fetchCloseCsvFull(); if (csv.length === 0) return;
  const universe = csv.filter(r => r.value > 1e8).sort((a, b) => b.value - a.value).slice(0, 250).map(r => r.code);
  const byName = {}; for (const r of csv) byName[r.code] = r.name;
  const refs = universe.map(c => db.collection('stockHistory').doc(c));
  const sma = (a, n) => (a.length >= n ? a.slice(-n).reduce((s, x) => s + x, 0) / n : null);
  const isoWeek = dt => { const d = new Date(dt); const j = new Date(d.getFullYear(), 0, 1); const w = Math.ceil(((d - j) / 86400000 + j.getDay() + 1) / 7); return `${d.getFullYear()}-${String(w).padStart(2, '0')}`; };
  const resample = (bars, key) => { const m = {}; for (const b of bars) m[key(b.d)] = b.c; return Object.keys(m).sort().map(k => m[k]); };
  const out = [];
  for (let i = 0; i < refs.length; i += 300) {
    const docs = await db.getAll(...refs.slice(i, i + 300)).catch(() => []);
    for (const d of docs) {
      if (!d.exists) continue; const bars = d.data().bars || []; if (bars.length < 120) continue;
      const dc = bars.map(b => b.c);
      const dBull = sma(dc, 5) > sma(dc, 10) && sma(dc, 10) > sma(dc, 20);
      const wc = resample(bars, isoWeek);
      const wBull = wc.length >= 20 && sma(wc, 5) > sma(wc, 10) && wc[wc.length - 1] > sma(wc, 20);
      const mc = resample(bars, dt => dt.slice(0, 7));
      const mBull = mc.length >= 6 && mc[mc.length - 1] > sma(mc, 6);
      if (dBull && wBull && mBull) out.push({ code: d.id, name: d.data().name || byName[d.id] });
    }
  }
  await db.collection('multiTimeframe').doc('latest').set({ updatedAt: Date.now(), date: await dataDate(), resonant: out.slice(0, 30) });
  log(`✓ 多時間框架共振：${out.length} 檔日/週/月三線齊揚`);
}

// ── 24) 籌碼集中度週變化（千張大戶占比 週 vs 週）────────────
async function computeMajorHoldersChange() {
  let rows = [];
  try { const r = await fetch('https://openapi.tdcc.com.tw/v1/opendata/1-5', { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (r.ok) rows = await r.json(); } catch { /* skip */ }
  if (!rows.length) return;
  const curMap = {};
  for (const x of rows) {
    if (x['持股分級'] !== '15') continue;
    const code = (x['證券代號'] || '').trim().replace(/^0+/, '');
    if (!/^\d{4}$/.test(code)) continue;
    const ratio = _f(x['占集保庫存數比例%']); if (ratio > 0) curMap[code] = +ratio.toFixed(2);
  }
  const date = (rows.find(x => x['﻿資料日期'] || x['資料日期']) || {})['﻿資料日期'] || rows[0]?.['資料日期'] || '';
  const doc = (await db.collection('majorHolders').doc('latest').get()).data() || {};
  let rising = doc.rising || [], lastWeekDate = doc.lastWeekDate || null, lastWeekRatios = doc.lastWeekRatios || null;
  // 偵測到新一週 → 與上一週(doc.weekRatios)比對。
  if (doc.weekDate && doc.weekDate !== date && doc.weekRatios) {
    lastWeekDate = doc.weekDate; lastWeekRatios = doc.weekRatios;
    rising = Object.keys(curMap).map(c => ({ code: c, ratio: curMap[c], change: +(curMap[c] - (lastWeekRatios[c] || 0)).toFixed(2) }))
      .filter(x => x.change > 0.3).sort((a, b) => b.change - a.change).slice(0, 20);
  }
  const top = Object.entries(curMap).map(([code, ratio]) => ({ code, ratio })).sort((a, b) => b.ratio - a.ratio).slice(0, 30);
  await db.collection('majorHolders').doc('latest').set({ updatedAt: Date.now(), date, top, weekDate: date, weekRatios: curMap, lastWeekDate, rising }, { merge: false });
  log(`✓ 集保大戶+週變化：本週 ${date}、上週 ${lastWeekDate || '尚無'}、增持榜 ${rising.length} 檔`);
}

// ════════════════════════════════════════════════════════════
// 進階技能 v4 第3批：自訂條件警報、自然語言選股
// ════════════════════════════════════════════════════════════

// ── 25) 自訂條件警報 ──────────────────────────────────────────
// 讀各 premium 用戶 users/{uid}/data/alertRules，依即時快照檢查觸發。
const _customAlerted = new Set(); let _customDay = '';
async function checkCustomAlerts() {
  const snap = await readSnapshotQuotes(); if (!snap) return; const q = snap.quotes;
  const today = isoDate(taipei()); if (_customDay !== today) { _customAlerted.clear(); _customDay = today; }
  const premium = await getPremiumUsers();
  for (const u of premium) {
    const uid = u.id;
    try {
      const rd = await db.collection('users').doc(uid).collection('data').doc('alertRules').get();
      const rules = rd.exists ? (rd.data().rules || []) : []; if (!rules.length) continue;
      const newAlerts = [];
      for (const r of rules) {
        const x = q[r.code]; if (!x || !(x.price > 0)) continue;
        let hit = false, msg = '';
        if (r.type === 'price_above' && x.price >= r.value) { hit = true; msg = `🔔 ${r.code} ${r.name} 漲破 ${r.value}（現價 ${x.price}）`; }
        else if (r.type === 'price_below' && x.price <= r.value) { hit = true; msg = `🔔 ${r.code} ${r.name} 跌破 ${r.value}（現價 ${x.price}）`; }
        else if (r.type === 'pct_above' && x.changePercent >= Math.abs(r.value)) { hit = true; msg = `🔔 ${r.code} ${r.name} 漲幅達 ${x.changePercent}%（≥${r.value}%）`; }
        else if (r.type === 'pct_below' && x.changePercent <= -Math.abs(r.value)) { hit = true; msg = `🔔 ${r.code} ${r.name} 跌幅達 ${x.changePercent}%`; }
        if (hit) { const key = `${uid}:${r.id}`; if (_customAlerted.has(key)) continue; _customAlerted.add(key); newAlerts.push({ code: r.code, name: r.name, type: 'custom', price: x.price, threshold: r.value, pnlPct: x.changePercent, message: msg, at: Date.now() }); }
      }
      if (newAlerts.length) {
        const ref = db.collection('users').doc(uid).collection('data').doc('alerts');
        const prev = (await ref.get()).data()?.alerts || [];
        await ref.set({ updatedAt: Date.now(), alerts: [...newAlerts, ...prev].slice(0, 40) });
        pushAlerts(uid, newAlerts).catch(() => {});
        for (const a of newAlerts) log(`  🔔自訂 ${uid} ${a.message}`);
      }
    } catch (e) { log('  ✖ custom alerts', uid, e.message); }
  }
}

// ── 26) 自然語言選股 ──────────────────────────────────────────
// 前端寫 users/{uid}/data/nlScreen{query,status:pending}；daemon 用 LLM 把需求轉成
// JSON 篩選條件，套用全市場評分+各技能榜→回寫結果。
// ════════════════════════════════════════════════════════════
// NL 選股防幻覺三道閘門（2026-08-01）
//
// 為什麼要確定性檢查、不能靠 LLM 自律：實測使用者問
// 「6/1-7/31期間最高交易價打5折且高於4折的7/31現貨價股票」，
// qwythos 回 {rng60Min:25, offHigh60Max:-50, offLow60Min:0} —— 沒報錯、
// 跑出 57 檔，前 30 檔裡只有 9 檔真的符合，正解 23 檔漏掉 14 檔。
// 錯法拆解：①憑空生出 rng60Min:25（問題裡沒有 25）②漏掉「高於4折」下界
// ③把自訂日期區間(6/1-7/31)默默換成「近60交易日」④把「交易價(盤中)」
// 默默換成收盤價。**部分聽懂就硬湊**比完全聽不懂更危險——它長得像答案。
//
// 三道閘門都是純程式判斷，LLM 說什麼都不算數：
//   ①數值溯源：門檻數字必須能在使用者原句找到（含中文數字/折/成/倍換算）
//   ②概念偵測：句中出現架構表達不了的概念（日期區間、盤中價、量能…）一律拒答
//   ③語意合法性：欄位值必須落在該欄位定義域（如距高點必為負）
// 通過後仍把「我怎麼理解你的話」回譯成中文一起顯示，讓使用者能當場抓誤讀。
// ════════════════════════════════════════════════════════════

// 中文數字 → 值（只處理選股會用到的小數量級）
function cnToNum(s) {
  const t = String(s).trim();
  if (/^\d+(\.\d+)?$/.test(t)) return +t;
  const D = { 零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (t === '十') return 10;
  let m = t.match(/^十([零一二兩三四五六七八九])$/); if (m) return 10 + D[m[1]];
  m = t.match(/^([零一二兩三四五六七八九])十([零一二兩三四五六七八九])?$/); if (m) return D[m[1]] * 10 + (m[2] ? D[m[2]] : 0);
  if (t.length === 1 && D[t] != null) return D[t];
  return null;
}

/** 使用者原句裡「可以當成門檻」的數值集合（供閘門①溯源比對） */
function queryNumberSet(q) {
  const set = new Set();
  const push = v => { if (Number.isFinite(v)) set.add(+Math.abs(v).toFixed(2)); };
  for (const m of q.matchAll(/\d+(?:\.\d+)?/g)) push(+m[0]);
  const NUM = '[零一二兩三四五六七八九十]+|\\d+(?:\\.\\d+)?';
  for (const m of q.matchAll(new RegExp(`(${NUM})\\s*成`, 'g'))) { const v = cnToNum(m[1]); if (v != null) push(v * 10); }
  for (const m of q.matchAll(new RegExp(`(${NUM})\\s*折`, 'g'))) { const v = cnToNum(m[1]); if (v != null) push(v * 10); }
  for (const m of q.matchAll(new RegExp(`(${NUM})\\s*倍`, 'g'))) { const v = cnToNum(m[1]); if (v != null) push(v * 100); }
  if (/一半|對半|半數/.test(q)) push(50);
  return set;
}

/** 架構表達不了的概念 —— 命中即拒答，不論 LLM 怎麼說 */
const NL_UNSUPPORTED = [
  [/\d{1,2}\s*[/／]\s*\d{1,2}|\d{4}-\d{1,2}-\d{1,2}|期間|區間內|從.{0,8}(到|至)\s*\d/, '自訂日期區間（目前只有固定視窗：近 60 個交易日、近 52 週）'],
  [/盤中|交易價|成交價|最高價|最低價|開盤價|收盤價以外/, '盤中價（最高／最低／開盤／成交價）—— 歸檔只有每日收盤價'],
  [/市值|股本|本益比|PER|PBR|淨值比|EPS/, '估值面（市值／本益比／淨值比／EPS）'],
  [/成交量|成交值|周轉率|週轉率|量比|爆量/, '量能條件（成交量／值／週轉率）'],
  [/張數|買超\s*\d|賣超\s*\d|持股比[率例]/, '法人買賣超張數／持股比率門檻（只支援「有無外資連買」）'],
  [/產業|類股|族群|概念股|供應鏈/, '產業／族群分類'],
  [/融資|融券|券資比|借券/, '信用交易（融資融券／借券）'],
];

/** 欄位定義域（閘門③）：min/max 允許範圍 */
const NL_DOMAIN = {
  minScore: [0, 100], minYield: [0, 30], minRS: [1, 99], minRevYoY: [-100, 10000],
  rsi5Min: [0, 100], rsi5Max: [0, 100], rsi10Min: [0, 100], rsi10Max: [0, 100],
  rng60Min: [0, 2000], rng60Max: [0, 2000],
  offHigh60Min: [-100, 0], offHigh60Max: [-100, 0],   // 距高點必為負或 0
  offLow60Min: [0, 5000], offLow60Max: [0, 5000],     // 距低點必為正或 0
};

const NL_LABEL = {
  minScore: '技術評分 ≥', minYield: '殖利率(%) ≥', minRS: 'RS 相對強弱 ≥', minRevYoY: '月營收年增(%) ≥',
  rsi5Min: 'RSI5 ≥', rsi5Max: 'RSI5 ≤', rsi10Min: 'RSI10 ≥', rsi10Max: 'RSI10 ≤',
  rng60Min: '近60日收盤高低差距(%) ≥', rng60Max: '近60日收盤高低差距(%) ≤',
  offHigh60Min: '距60日收盤高點(%) ≥', offHigh60Max: '距60日收盤高點(%) ≤',
  offLow60Min: '距60日收盤低點(%) ≥', offLow60Max: '距60日收盤低點(%) ≤',
};

/** 把 filters 回譯成中文，讓使用者當場檢查我有沒有誤讀 */
function describeNlFilters(f, applied) {
  const parts = [];
  for (const k of applied) {
    if (k === 'signal') { parts.push(f.signal === 'STRONG_BUY' ? '訊號＝強力買進' : '訊號＝買進(含強力買進)'); continue; }
    if (k === 'newHigh') { parts.push('創 52 週新高'); continue; }
    if (k === 'foreignBuy') { parts.push('外資連續買超'); continue; }
    parts.push(`${NL_LABEL[k] || k} ${f[k]}`);
  }
  return parts.join('、');
}

async function runNlScreens() {
  const premium = await getPremiumUsers();
  let ratingMap = null, nameMap = null, enrich = null;
  for (const u of premium) {
    const ref = db.collection('users').doc(u.id).collection('data').doc('nlScreen');
    const d = (await ref.get()).data(); if (!d || d.status !== 'pending') continue;
    try {
      // 2026-08-01 修正：舊版只支援 7 種欄位，需求提到 RSI 等不支援的概念時 LLM 回空物件，
      // 空條件跑過濾迴圈＝全部通過 → 「找到 1936 檔」。實例：使用者查
      // 「rsi5日介於60-75且rsi10日超過60」拿到全市場，還以為篩選壞了（確實壞了）。
      // 修法：①補 RSI5/RSI10 區間欄位（chipArchive 收盤序列，與波段追強同口徑）
      //       ②LLM 須把無法表達的部分放進 unsupported ③零有效條件＝回錯誤說明，不再默默全過
      //       ④部分忽略時在結果上標注。「聽不懂」必須說出來，不能假裝聽懂。
      const prompt = `把下列台股選股需求轉成 JSON(只輸出 JSON 物件、無其他文字、無說明)。可用欄位(需求沒提到的就省略不要放)：
minScore(0-100技術評分),signal("STRONG_BUY"或"BUY"),minYield(殖利率%),minRS(1-99相對強弱排名),
rsi5Min,rsi5Max,rsi10Min,rsi10Max(5日/10日RSI區間),
rng60Min,rng60Max(近60日最高價與最低價的差距%,算法(最高-最低)/最低×100),
offHigh60Min,offHigh60Max(現價距60日最高點%,一律為負或0,例如比高點低20%就是-20),
offLow60Min,offLow60Max(現價距60日最低點%,一律為正或0,例如比低點高50%就是50),
newHigh(true=創52週新高),foreignBuy(true=外資連買),minRevYoY(月營收年增%),
unsupported(字串:需求中無法用以上欄位表達的部分照原文摘出,全部可表達就省略)。
注意:RS是相對強弱「排名」、RSI是技術「指標」,兩者不同;需求寫 rsi 一律用 rsi 欄位。
範例:「近60日最高與最低差距超過60%」→{"rng60Min":60}；「從高點回檔超過三成」→{"offHigh60Max":-30}；「從低點漲上來一倍以上」→{"offLow60Min":100}
需求：「${d.query}」`;
      const out = await askOllama(prompt, { priority: 10 });
      let f = {}; try { const m = (out || '').match(/\{[\s\S]*\}/); f = m ? JSON.parse(m[0]) : {}; } catch { f = {}; }
      const SUPPORTED = ['minScore', 'signal', 'minYield', 'minRS', 'newHigh', 'foreignBuy', 'minRevYoY',
        'rsi5Min', 'rsi5Max', 'rsi10Min', 'rsi10Max', 'rng60Min', 'rng60Max', 'offHigh60Min', 'offHigh60Max', 'offLow60Min', 'offLow60Max'];
      const applied = SUPPORTED.filter(k => f[k] != null && f[k] !== false && f[k] !== '');
      const CAPABILITY = '目前支援：技術評分、買進訊號、殖利率、RS 相對強弱、RSI5/RSI10 區間、'
        + '近60日收盤高低差距%、距60日收盤高/低點%、創52週新高、外資連買、月營收年增。';
      const reject = async (why, detail) => {
        await ref.set({
          query: d.query, status: 'error',
          error: `${why}\n\n${detail ? detail + '\n\n' : ''}${CAPABILITY}\n（寧可不答，也不用近似條件湊一份看起來合理的名單。）`,
          answeredAt: Date.now(),
        });
        log(`  ⚠ NL選股 ${u.id}「${d.query}」→ 拒答：${why}｜LLM輸出 ${JSON.stringify(f).slice(0, 140)}`);
      };

      // 閘門②：句中出現架構表達不了的概念 → 直接拒答（不看 LLM 說什麼）
      const blocked = NL_UNSUPPORTED.filter(([re]) => re.test(d.query)).map(([, label]) => label);
      if (blocked.length) { await reject('這個需求超出目前的篩選能力，沒有作答。', '做不到的部分：\n・' + blocked.join('\n・')); continue; }

      // 閘門①：門檻數值必須能在你的原句找到（含中文數字／折／成／倍換算）
      const qNums = queryNumberSet(d.query);
      const fabricated = applied.filter(k => typeof f[k] === 'number' && !qNums.has(+Math.abs(f[k]).toFixed(2)));
      if (fabricated.length) {
        await reject('解析結果含有你沒有提到的數字，判定為誤解，沒有作答。',
          '這些門檻不是你說的：\n・' + fabricated.map(k => `${NL_LABEL[k] || k} ${f[k]}`).join('\n・'));
        continue;
      }

      // 閘門③：欄位值必須落在定義域（如「距高點」必為負）
      const invalid = applied.filter(k => {
        const dom = NL_DOMAIN[k]; if (!dom || typeof f[k] !== 'number') return false;
        return f[k] < dom[0] || f[k] > dom[1];
      });
      if (invalid.length) {
        await reject('解析結果的數值方向不合理，判定為誤解，沒有作答。',
          '不合理的條件：\n・' + invalid.map(k => `${NL_LABEL[k] || k} ${f[k]}`).join('\n・'));
        continue;
      }

      // LLM 自承有無法表達的部分 → 一併拒答（不做「部分符合」的半套名單）
      if (f.unsupported) { await reject('需求裡有無法表達的條件，沒有作答。', `無法處理：${String(f.unsupported).slice(0, 80)}`); continue; }

      if (!applied.length) { await reject('無法把這個需求轉成任何支援的篩選條件。'); continue; }
      if (!ratingMap) {
        const r = await getJSON('/api/rating'); ratingMap = r?.ratings || {};
        const all = await getAllMarketCodes(); nameMap = {}; for (const c of all) if (c.name) nameMap[c.code] = c.name; // 含上市+上櫃(TPEx)名稱，修上櫃股名缺失
        const scn = (await db.collection('scanner').doc('latest').get()).data() || {};
        const rs = (await db.collection('rsRanking').doc('latest').get()).data()?.top || [];
        const div = (await db.collection('dividendStocks').doc('latest').get()).data()?.top || [];
        const inst = (await db.collection('institutionalStreaks').doc('latest').get()).data()?.foreign || [];
        const rev = (await db.collection('revenue').doc('latest').get()).data()?.topYoY || [];
        // 技術面全市場指標——chipArchive 收盤序列，與波段追強/回測完全同口徑。
        // 一次掃描同時算 RSI5/10 與 60 日價格區間（零額外讀取成本）。
        // ⚠口徑誠實揭露：chipArchive 只存收盤價，**沒有盤中最高/最低**，
        //   所以「60日高低」是 60 個交易日的**收盤價**極值，不是盤中極值
        //   （實際盤中振幅會比這個大）。文案與結果都標明，不假裝是盤中價。
        const rsiMap = {}, rangeMap = {};
        try {
          const arch = await loadLuArchive();
          if (arch.length >= 15) {
            const L = arch.length - 1;
            for (const code in arch[L].close) {
              const closes = [];
              for (let k = 0; k <= L; k++) { const r = arch[k].close[code]; if (r?.[0] > 0) closes.push(r[0]); }
              if (closes.length >= 15) rsiMap[code] = rsiPair(closes);
              const w = closes.slice(-60);
              if (w.length >= 30) {
                const hi = Math.max(...w), lo = Math.min(...w), last = w[w.length - 1];
                if (lo > 0 && hi > 0) {
                  rangeMap[code] = {
                    hi60: +hi.toFixed(2), lo60: +lo.toFixed(2),
                    rng60: +((hi - lo) / lo * 100).toFixed(1),        // 區間振幅%
                    offHigh60: +((last - hi) / hi * 100).toFixed(1),  // 距高點%（≤0）
                    offLow60: +((last - lo) / lo * 100).toFixed(1),   // 距低點%（≥0）
                    days: w.length,
                  };
                }
              }
            }
          }
        } catch (e) { log('  ⚠ NL選股 技術指標載入失敗：', e.message); }
        enrich = { newHigh: new Set((scn.newHigh52 || []).map(x => x.code)), rs: Object.fromEntries(rs.map(x => [x.code, x.rs])), yield: Object.fromEntries(div.map(x => [x.code, x.yield])), foreign: new Set(inst.map(x => x.code)), rev: Object.fromEntries(rev.map(x => [x.code, x.yoy])), rsi: rsiMap, range: rangeMap };
      }
      // 依賴歸檔的條件但歸檔載入失敗 → 誠實報錯，不能默默跳過條件
      const wantsRsi = f.rsi5Min != null || f.rsi5Max != null || f.rsi10Min != null || f.rsi10Max != null;
      const wantsRange = f.rng60Min != null || f.rng60Max != null || f.offHigh60Min != null || f.offHigh60Max != null || f.offLow60Min != null || f.offLow60Max != null;
      if (wantsRsi && !Object.keys(enrich.rsi || {}).length) {
        await ref.set({ query: d.query, status: 'error', error: 'RSI 資料暫時無法取得，請稍後再試。', answeredAt: Date.now() });
        continue;
      }
      if (wantsRange && !Object.keys(enrich.range || {}).length) {
        await ref.set({ query: d.query, status: 'error', error: '價格區間資料暫時無法取得，請稍後再試。', answeredAt: Date.now() });
        continue;
      }
      const res = [];
      for (const code in ratingMap) {
        const r = ratingMap[code];
        if (f.minScore && !(r.score >= f.minScore)) continue;
        if (f.signal && r.signal !== f.signal && !(f.signal === 'BUY' && r.signal === 'STRONG_BUY')) continue;
        if (f.minYield && !(enrich.yield[code] >= f.minYield)) continue;
        if (f.minRS && !(enrich.rs[code] >= f.minRS)) continue;
        if (f.newHigh && !enrich.newHigh.has(code)) continue;
        if (f.foreignBuy && !enrich.foreign.has(code)) continue;
        if (f.minRevYoY && !(enrich.rev[code] >= f.minRevYoY)) continue;
        const rsi = enrich.rsi?.[code];
        if (f.rsi5Min != null && !(rsi?.rsi5 >= f.rsi5Min)) continue;
        if (f.rsi5Max != null && !(rsi?.rsi5 <= f.rsi5Max)) continue;
        if (f.rsi10Min != null && !(rsi?.rsi10 >= f.rsi10Min)) continue;
        if (f.rsi10Max != null && !(rsi?.rsi10 <= f.rsi10Max)) continue;
        const rg = enrich.range?.[code];
        if (f.rng60Min != null && !(rg?.rng60 >= f.rng60Min)) continue;
        if (f.rng60Max != null && !(rg?.rng60 <= f.rng60Max)) continue;
        if (f.offHigh60Min != null && !(rg?.offHigh60 >= f.offHigh60Min)) continue;
        if (f.offHigh60Max != null && !(rg?.offHigh60 <= f.offHigh60Max)) continue;
        if (f.offLow60Min != null && !(rg?.offLow60 >= f.offLow60Min)) continue;
        if (f.offLow60Max != null && !(rg?.offLow60 <= f.offLow60Max)) continue;
        res.push({
          code, name: nameMap[code] || code, score: r.score, signal: r.signal,
          rs: enrich.rs[code] ?? null, yield: enrich.yield[code] ?? null,
          ...(wantsRsi && rsi ? { rsi5: rsi.rsi5, rsi10: rsi.rsi10 } : {}),
          ...(wantsRange && rg ? { rng60: rg.rng60, hi60: rg.hi60, lo60: rg.lo60, offHigh60: rg.offHigh60, offLow60: rg.offLow60 } : {}),
        });
      }
      // 用了區間條件就依區間排序（照分數排會讓「振幅最大」的問題答非所問）
      res.sort((a, b) => (wantsRange ? (b.rng60 ?? -1) - (a.rng60 ?? -1) : 0) || b.score - a.score);
      const notes = [];
      if (wantsRange) notes.push('60日高低為「收盤價」極值（歸檔無盤中最高/最低），實際盤中振幅會比此數字大。');
      const note = notes.length ? notes.join('\n') : null;
      // interpreted＝把條件回譯成中文一起顯示：誤讀在使用者眼前，不用他去猜
      await ref.set({
        query: d.query, status: 'done', filters: f,
        interpreted: describeNlFilters(f, applied),
        ...(note ? { note } : {}),
        results: res.slice(0, 30), count: res.length, answeredAt: Date.now(),
      });
      log(`  ✓ NL選股 ${u.id}「${d.query}」→ ${res.length} 檔（條件 ${JSON.stringify(f)}）`);
    } catch (e) { await ref.set({ query: d.query, status: 'error', error: (e.message || '').slice(0, 80) }, { merge: true }); log('  ✖ NL選股', u.id, e.message); }
  }
}

// ── main loops ──
log(`🤖 ai-daemon starting · host=${HOST} · model=${OLLAMA_MODEL} · app=${APP_BASE}`);
await heartbeat({ note: 'starting' });
// ── 讀取歸因儀表（READ_TRACE=1 時啟用）────────────────────────────
// 為什麼存在：2026-08-01 Firestore 讀取暴增稽查——夜間閒置基線 ~80 reads/min
// 全部來自 daemon（停機實測 400→20/5min），但靜態分析對不上，只能逐呼叫點計數。
// 平常關閉零成本；打開時每 5 分鐘輸出 Top15 呼叫點（行號×讀取數）。
if (process.env.READ_TRACE === '1') {
  const fsMod = await import('@google-cloud/firestore');
  const tally = new Map();
  // ⚠第一版的教訓：stack 第一個 ai-daemon.mjs frame 是 wrapper 自己那一行，
  //   全部歸因到 L2074 毫無意義。改抓「wrapper 區段之外」的第一個 frame。
  const TRACE_LO = 2040, TRACE_HI = 2100;   // 本儀表區塊的行號範圍
  const rec = (kind, n) => {
    const st = (new Error().stack || '').split('\n');
    let line = null;
    for (const l of st) {
      const m = l.match(/ai-daemon\.mjs:(\d+)/);
      if (m) { const num = +m[1]; if (num < TRACE_LO || num > TRACE_HI) { line = num; break; } }
    }
    const key = `L${line ?? '?'}·${kind}`;
    tally.set(key, (tally.get(key) || 0) + n);
  };
  const dGet = fsMod.DocumentReference.prototype.get;
  fsMod.DocumentReference.prototype.get = function (...a) { rec('doc', 1); return dGet.apply(this, a); };
  const qGet = fsMod.Query.prototype.get;
  fsMod.Query.prototype.get = async function (...a) { const snap = await qGet.apply(this, a); rec('qry', snap.size || 1); return snap; };
  const gAll = fsMod.Firestore.prototype.getAll;
  fsMod.Firestore.prototype.getAll = function (...a) { rec('all', a.length); return gAll.apply(this, a); };
  setInterval(() => {
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    log('📊 READ_TRACE(5min):', top.map(([k, v]) => `${k}=${v}`).join(' '));
    tally.clear();
  }, 5 * 60000);
  log('📊 READ_TRACE 啟用');
}

setInterval(heartbeat, HEARTBEAT_MS);

// 啟動時立刻載入權威休市表 —— 不載的話整個行程都在用硬編 fallback，
// 而 fallback 抓不到颱風假（實例：2026-07-10 被當成交易日）。
loadTradingCalendar();

async function analyzeLoop() {
  for (;;) {
    try { await analyzeAll(); } catch (e) { log('✖ analyze cycle failed:', e.message); }
    await sleep(ANALYZE_MS);
  }
}
if (!ONESHOT) analyzeLoop();

// Manual test: FORCE_PREMARKET=1 publishes the brief immediately at startup.
if (process.env.FORCE_PREMARKET === '1') {
  publishPremarketBrief().catch(e => log('✖ forced premarket:', e.message));
}

// Pre-market loop: fire once between 08:45–09:15 Taipei on a trading day.
let lastPremarketDate = '';
async function premarketLoop() {
  for (;;) {
    try {
      const tw = taipei();
      const mins = tw.getHours() * 60 + tw.getMinutes();
      const today = isoDate(tw);
      if (isTradingDay(tw) && mins >= 8 * 60 + 45 && mins < 9 * 60 + 15 && lastPremarketDate !== today) {
        // Skip if already published today (survives daemon restarts).
        const existing = (await db.collection('premarketBrief').doc('latest').get()).data();
        if (existing?.date !== today) { await publishPremarketBrief(); }
        // 開盤前補齊三大法人累計籌碼（若昨日 daemon 未捕捉到 T86，此處自動補回保持最新）
        try { await computeChipCumulative(); } catch (e) { log('✖ chipCumulative premarket:', e.message); }
        lastPremarketDate = today;
      }
    } catch (e) { log('✖ premarket loop:', e.message); }
    await sleep(60000);
  }
}
if (!ONESHOT) premarketLoop();
if (!ONESHOT) newsLoop();
if (!ONESHOT) marketSnapshotLoop();

// 停損停利提醒：盤中每 60s 檢查觸價。
async function alertLoop() {
  for (;;) {
    try {
      const tw = taipei(); const mins = tw.getHours() * 60 + tw.getMinutes();
      if (isTradingDay(tw) && mins >= 9 * 60 && mins < 13 * 60 + 35) {
        // 每項獨立 try：單一函式拋錯不可拖垮整條盤中鏈（2026-07-21 教訓：
        // computeTailEndPicks TDZ 崩潰導致其後的雷達/爆量/籌碼/漲停預測整個上午全停更）
        for (const [nm, fn] of [['alerts', checkAlerts], ['chipHold', checkChipHoldings], ['rebound', checkReboundExit], ['custom', checkCustomAlerts], ['snipe', checkSnipe], ['stopDisc', trackStopDiscipline], ['crash', checkCrashDefense], ['earlyBird', checkEarlyBird], ['pattern', computeMarketPattern], ['openSell', checkOpenSell], ['tailEnd', computeTailEndPicks], ['radar', computeIntradayRadar], ['volSurge', computeVolSurge], ['chipPicks', computeChipPicks], ['news', computeNewsDaily], ['limitUp', computeLimitUpForecast], ['rsiHot', checkRsiHot]]) {
          try { await fn(); } catch (e) { log(`✖ alert loop [${nm}]:`, e.message); }
        }
      }
    } catch (e) { log('✖ alert loop:', e.message); }
    await sleep(60000);
  }
}
if (!ONESHOT) alertLoop();

// 產業輪動：盤中每 3 分鐘更新一次；盤後也更新一次。
async function sectorLoop() {
  for (;;) {
    try { await detectSectorRotation(); } catch (e) { log('✖ sector loop:', e.message); }
    try { await computeMarketWind(); } catch (e) { log('✖ market wind:', e.message); }
    try { await computeChipWind(); } catch (e) { log('✖ chip wind:', e.message); }
    try { await computeChipDivergence(); } catch (e) { log('✖ chip divergence:', e.message); }
    try { await computeSectorWind(); } catch (e) { log('✖ sector wind:', e.message); }
    try { await computeTopicPicks(); } catch (e) { log('✖ topic picks:', e.message); }
    try { await computeSwingPicks(); } catch (e) { log('✖ swing picks:', e.message); }
    try { await computeStrengthPicks(); } catch (e) { log('✖ strength picks:', e.message); }
    try { await computeGlobalMarkets(); } catch (e) { log('✖ global markets:', e.message); }
    try { await computeMarketHealth(); } catch (e) { log('✖ market health:', e.message); }
    const tw = taipei(); const mins = tw.getHours() * 60 + tw.getMinutes();
    const open = isTradingDay(tw) && mins >= 9 * 60 && mins < 13 * 60 + 35;
    await sleep(open ? 180000 : 1800000);
  }
}
if (!ONESHOT) sectorLoop();

// ════════════════════════════════════════════════════════════
// P1 · financial-services 方法論移植：同業比較 / 事件日曆 / 盤前晨報
// 數字全 deterministic、零 LLM（docs/financial-services-整合架構說明書.md）
// ════════════════════════════════════════════════════════════

// 月營收完整來源：t187ap05_L(一般業 1082 檔，含半導體) + t187ap05_P(金融證券等) 合併。
async function fetchMonthlyRevenueAll() {
  const out = []; const seen = new Set();
  for (const ep of ['t187ap05_L', 't187ap05_P']) {
    try {
      const r = await fetch(`https://openapi.twse.com.tw/v1/opendata/${ep}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      for (const x of await r.json()) { const c = x['公司代號']; if (c && !seen.has(c)) { seen.add(c); out.push(x); } }
    } catch { /* skip */ }
  }
  return out;
}

// ── 27) 同業比較（comps-analysis 台股化）───────────────────────
// 官方產業別(月營收彙總表) 分群，比 PE/PB/殖利率/月營收YoY/評分/RS，含產業中位數。
async function computePeerComps() {
  const rev = await fetchMonthlyRevenueAll();
  const bw = (await fetchBwibbu()).rows;
  if (!rev.length) return;
  const rating = (await getJSON('/api/rating'))?.ratings || {};
  const rs = Object.fromEntries((((await db.collection('rsRanking').doc('latest').get()).data())?.top || []).map(x => [x.code, x.rs]));
  const snap = await readSnapshotQuotes(); const q = snap?.quotes || {};
  const bwMap = {}; for (const x of bw) bwMap[x.Code] = { pe: _f(x.PEratio), pb: _f(x.PBratio), yld: _f(x.DividendYield) };
  const industries = {};
  for (const x of rev) {
    const code = x['公司代號']; if (!/^\d{4}$/.test(code)) continue;
    const ind = (x['產業別'] || '').trim() || '其他';
    const b = bwMap[code] || {}; const r = rating[code] || {};
    (industries[ind] ??= []).push({
      code, name: x['公司名稱'], price: q[code]?.price ?? null, changePct: q[code]?.changePercent ?? null,
      pe: b.pe > 0 ? b.pe : null, pb: b.pb > 0 ? b.pb : null, yield: b.yld > 0 ? b.yld : null,
      revYoY: +_f(x['營業收入-去年同月增減(%)']).toFixed(1),
      score: r.score ?? null, signal: r.signal ?? null, rs: rs[code] ?? null,
    });
  }
  const med = arr => { const v = arr.filter(n => n != null && isFinite(n)).sort((a, b) => a - b); return v.length ? +v[Math.floor(v.length / 2)].toFixed(2) : null; };
  const summary = {};
  for (const ind in industries) {
    const list = industries[ind]; list.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    summary[ind] = { count: list.length, medPe: med(list.map(s => s.pe)), medPb: med(list.map(s => s.pb)), medYield: med(list.map(s => s.yield)), medRevYoY: med(list.map(s => s.revYoY)) };
  }
  await db.collection('peerComps').doc('latest').set({ updatedAt: Date.now(), month: rev[0]?.['資料年月'] || '', industriesJson: JSON.stringify(industries), summaryJson: JSON.stringify(summary) });
  log(`✓ 同業比較：${Object.keys(industries).length} 產業 / ${rev.length} 檔`);
}

// ── 28) 催化劑事件日曆（catalyst-calendar 台股化）──────────────
// FOMC 2026 為 Fed 已公布之官方會期（取第二日=決議日）。
const FOMC_2026 = ['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09'];
const rocToIso = s => { const t = String(s || '').trim(); return /^\d{7}$/.test(t) ? `${+t.slice(0, 3) + 1911}-${t.slice(3, 5)}-${t.slice(5, 7)}` : null; };
const _catalystAlerted = new Set(); let _catalystDay = '';
async function buildCatalystCalendar() {
  const tw = taipei(); const today = isoDate(tw);
  const horizon = isoDate(new Date(tw.getTime() + 35 * 86400000));
  const within = ds => ds && ds >= today && ds <= horizon;
  const events = [];
  // 1 除權息（用既有 dividendCalendar，date 為民國）
  const div = (await db.collection('dividendCalendar').doc('latest').get()).data()?.upcoming || [];
  for (const x of div) { const ds = rocToIso(x.date); if (within(ds)) events.push({ date: ds, type: 'exdiv', code: x.code, name: x.name, title: `${x.name} 除權息${x.cash ? `（現金 ${x.cash}）` : ''}`, impact: 'H' }); }
  // 2 股東會（官方 t187ap41_L）
  let agm = [];
  try { const r = await fetch('https://openapi.twse.com.tw/v1/opendata/t187ap41_L', { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (r.ok) agm = await r.json(); } catch { /* skip */ }
  for (const x of agm) { const ds = rocToIso(x['開會日期']); if (within(ds)) events.push({ date: ds, type: 'agm', code: x['公司代號'], name: x['公司名稱'], title: `${x['公司名稱']} 股東會${x['是否改選董監'] === '是' ? '（改選董監）' : ''}`, impact: 'M' }); }
  // 3 月營收公布截止（每月 10 日）
  { const d = new Date(tw); d.setDate(10); if (isoDate(d) < today) d.setMonth(d.getMonth() + 1); if (within(isoDate(d))) events.push({ date: isoDate(d), type: 'revenue', title: '上市櫃月營收公布截止日', impact: 'H' }); }
  // 4 季報/年報申報截止（證交法定期限）
  const y = tw.getFullYear();
  for (const [ds, t] of [[`${y}-03-31`, '年報(含Q4)'], [`${y}-05-15`, 'Q1 季報'], [`${y}-08-14`, 'Q2 季報'], [`${y}-11-14`, 'Q3 季報']]) if (within(ds)) events.push({ date: ds, type: 'earnings', title: `${t}申報截止日`, impact: 'H' });
  // 5 FOMC
  for (const ds of FOMC_2026) if (within(ds)) events.push({ date: ds, type: 'macro', title: 'FOMC 利率決議（Fed 官方日程）', impact: 'H' });
  // 5b 法說會日程（MOPS t100sb02_1：上市 sii / 上櫃 otc，本月＋下月）
  {
    const rocDate = s => { const m = String(s || '').match(/^(\d{3})\/(\d{2})\/(\d{2})$/); return m ? `${+m[1] + 1911}-${m[2]}-${m[3]}` : null; };
    const months = [];
    { const d = new Date(tw); months.push([d.getFullYear() - 1911, String(d.getMonth() + 1).padStart(2, '0')]); d.setMonth(d.getMonth() + 1); months.push([d.getFullYear() - 1911, String(d.getMonth() + 1).padStart(2, '0')]); }
    for (const typek of ['sii', 'otc']) {
      for (const [ry, mm] of months) {
        try {
          const r = await fetch('https://mopsov.twse.com.tw/mops/web/ajax_t100sb02_1', {
            method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `encodeURIComponent=1&step=1&firstin=1&off=1&TYPEK=${typek}&year=${ry}&month=${mm}`,
          });
          if (!r.ok) continue;
          const html = await r.text();
          for (const row of html.split('<tr').slice(1)) {
            const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
            if (cells.length < 4 || !/^\d{4}$/.test(cells[0])) continue;
            const ds = rocDate(cells[2]);
            if (within(ds)) events.push({ date: ds, type: 'earnings-call', code: cells[0], name: cells[1], title: `${cells[1]} 法說會（${cells[3] || ''}）`, impact: 'H' });
          }
          await sleep(500); // MOPS 限速保護
        } catch { /* skip */ }
      }
    }
  }
  // 6 停券起日（融券強制回補窗口，官方 TWTBAU1/2 停資停券預告）
  for (const ep of ['TWTBAU1', 'TWTBAU2']) {
    try {
      const r = await fetch(`https://openapi.twse.com.tw/v1/exchangeReport/${ep}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const recallLimit = isoDate(new Date(tw.getTime() + 10 * 86400000)); // 只列近10天，避免淹沒日曆
      for (const x of await r.json()) {
        const ds = rocToIso(x.StartDate);
        if (within(ds) && ds <= recallLimit && /^\d{4}$/.test(x.Code)) events.push({ date: ds, type: 'recall', code: x.Code, name: x.Name, title: `${x.Name} 停券起日（${x.Reason}）— 融券需提前回補，留意軋空`, impact: 'M' });
      }
    } catch { /* skip */ }
  }
  events.sort((a, b) => a.date.localeCompare(b.date));
  await db.collection('catalystCalendar').doc('latest').set({ updatedAt: Date.now(), from: today, to: horizon, events: events.slice(0, 300) });
  log(`✓ 事件日曆：${events.length} 件（→${horizon}）`);

  // 持股/自選 3 日內個股事件 → 警報（每人每事件每日一次）
  if (_catalystDay !== today) { _catalystAlerted.clear(); _catalystDay = today; }
  const soonLimit = isoDate(new Date(tw.getTime() + 3 * 86400000));
  const soon = events.filter(e => e.code && e.date <= soonLimit);
  if (!soon.length) return;
  const premium = await getPremiumUsers();
  for (const u of premium) {
    const uid = u.id;
    try {
      const codes = new Set();
      const hd = (await db.collection('users').doc(uid).collection('data').doc('holdings').get()).data();
      for (const h of (hd?.holdings || [])) codes.add(h.code);
      const wd = (await db.collection('users').doc(uid).collection('data').doc('watchlist').get()).data();
      for (const w of (wd?.watchlist || [])) codes.add(w.code);
      const newAlerts = [];
      for (const e of soon.filter(e => codes.has(e.code))) {
        const key = `${uid}:${e.code}:${e.type}:${e.date}`;
        if (_catalystAlerted.has(key)) continue; _catalystAlerted.add(key);
        newAlerts.push({ code: e.code, name: e.name, type: 'catalyst', message: `📅 ${e.date} ${e.title}`, at: Date.now() });
      }
      if (newAlerts.length) {
        const ref = db.collection('users').doc(uid).collection('data').doc('alerts');
        const prev = (await ref.get()).data()?.alerts || [];
        await ref.set({ updatedAt: Date.now(), alerts: [...newAlerts, ...prev].slice(0, 40) });
        pushAlerts(uid, newAlerts).catch(() => {});
        for (const al of newAlerts) log(`  🔔 ${uid} ${al.message}`);
      }
    } catch { /* per-user skip */ }
  }
}

// ── 28.5) 每日新聞頁（使用者指定 2026-07-23）：每日 07:00 聚合四類新聞 ──
// 全球AI產業／全球局勢／美國建廠·NVIDIA供應鏈／台灣產業。
// 來源＝Google News RSS(zh-TW·各媒體標題)，去重後本地 AI 寫 2-3 句導讀（僅歸納標題，
// 不編造細節）。newsDigest/{date}+latest；連結導回原媒體。非投資建議。
const NEWS_CATS = [
  { key: 'aiGlobal', label: '🤖 全球 AI 產業', q: ['AI 晶片 產業', 'OpenAI OR Anthropic OR AI模型', '人工智慧 資料中心 投資'] },
  { key: 'world', label: '🌍 全球局勢', q: ['聯準會 OR 美國經濟', '地緣政治 中美 OR 台海', '國際股市 歐洲 OR 日本'] },
  { key: 'usFab', label: '🏗️ 美國建廠·NVIDIA 供應鏈', q: ['台積電 美國 建廠 OR 亞利桑那', 'NVIDIA 供應鏈 OR 合作夥伴', '輝達 出貨 OR 生產進度'] },
  { key: 'taiwan', label: '🇹🇼 台灣產業', q: ['台灣 半導體 產業', '台灣 電子業 營收 OR 展望', '台股 產業 動態'] },
];
async function fetchGoogleNewsRss(query, cap = 8) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 10000);
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctl.signal }).finally(() => clearTimeout(tm));
    if (!r.ok) return [];
    const xml = await r.text();
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/g; let m;
    const unesc = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    while ((m = re.exec(xml)) && items.length < cap) {
      const block = m[1];
      const pick = tag => { const mm = block.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`)); return mm ? mm[1].trim() : ''; };
      const title = unesc(pick('title'));
      const link = pick('link');
      const pub = pick('pubDate');
      const src = unesc((block.match(/<source[^>]*>([^<]+)<\/source>/) || [])[1] || '');
      if (title) items.push({ title, link, src, at: pub ? new Date(pub).getTime() : 0 });
    }
    return items;
  } catch { return []; }
}
// 櫃買指數日K累積（Yahoo ^TWOII 為壞資料——數值/日期皆錯，棄用）：
// TPEx openapi tpex_index 只回「當月」官方 OHLC，daemon 每日併入 indexHistory/otc
// 累積成長期序列（冪等·依日期合併），指數頁 API 從此讀取。
async function archiveOtcIndex() {
  try {
    const r = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_index', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return;
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) return;
    const ref = db.collection('indexHistory').doc('otc');
    const cur = (await ref.get()).data();
    const rows = cur?.rowsJson ? JSON.parse(cur.rowsJson) : {};
    let added = 0;
    for (const x of arr) {
      const d = String(x.Date || '');
      if (!/^\d{8}$/.test(d)) continue;
      const o = parseFloat(x.Open), h = parseFloat(x.High), l = parseFloat(x.Low), c = parseFloat(x.Close);
      if (!(c > 0)) continue;
      if (!rows[d]) added++;
      rows[d] = [o, h, l, c];
    }
    if (added > 0 || !cur) await ref.set({ updatedAt: Date.now(), rowsJson: JSON.stringify(rows), n: Object.keys(rows).length });
    if (added > 0) log(`✓ 櫃買指數歸檔 +${added}（累積 ${Object.keys(rows).length} 日）`);
  } catch (e) { log('✖ 櫃買指數歸檔:', (e.message || '').slice(0, 60)); }
}

async function buildNewsDigest() {
  const today = isoDate(taipei());
  const cats = [];
  for (const cat of NEWS_CATS) {
    const seen = new Set(); const items = [];
    for (const q of cat.q) {
      for (const it of await fetchGoogleNewsRss(q, 8)) {
        const key = it.title.replace(/[\s\-|｜–—「」()（）]/g, '').slice(0, 24);
        if (seen.has(key)) continue; seen.add(key);
        items.push(it);
      }
      await sleep(400);
    }
    // 只留 36 小時內（「當日最新」語意；夜間跨日時仍保有昨晚重要新聞）
    const FRESH_MS = 36 * 3600 * 1000, now = Date.now();
    const fresh = items.filter(t => !t.at || now - t.at <= FRESH_MS);
    (fresh.length >= 3 ? fresh : items).sort((a, b) => b.at - a.at);
    const top = (fresh.length >= 3 ? fresh : items).slice(0, 8);
    let brief = '';
    if (top.length >= 3) {
      try {
        const prompt = `你是財經編輯。根據下列今日新聞標題，用繁體中文寫 2~3 句「${cat.label.replace(/^\S+\s/, '')}」重點導讀。只根據標題歸納共同趨勢，不可編造標題沒有的細節，不要條列、不要加標題。\n${top.map(t => '· ' + t.title).join('\n')}`;
        brief = ((await askOllama(prompt)) || '').trim().slice(0, 400);
      } catch { /* 導讀可缺，標題列表仍完整 */ }
    }
    cats.push({ key: cat.key, label: cat.label, brief, items: top.map(t => ({ title: t.title, link: t.link, src: t.src, at: t.at })) });
  }
  const total = cats.reduce((s, c) => s + c.items.length, 0);
  if (total < 5) { log('  ⚠ 每日新聞：來源近乎空，略過本輪（明日再試）'); return; }
  const newest = Math.max(0, ...cats.flatMap(c => c.items.map(i => i.at || 0)));
  const doc = { date: today, updatedAt: Date.now(), newestAt: newest || null, cats,
    note: '來源：Google News 各媒體標題（連結導回原媒體）·AI 導讀僅歸納標題·非投資建議' };
  await db.collection('newsDigest').doc(today).set(doc);
  await db.collection('newsDigest').doc('latest').set(doc);
  log(`✓ 每日新聞 ${today}：${cats.map(c => `${c.key}${c.items.length}`).join('/')}·共${total}則`);
}

// ── 28.7) 話題×5日線選股（犀利媽法 bt-core 回測定版 2026-07-24·screen-ma5.mjs）──
// 影片方法論拆解檢定（720日·64.5萬可交易樣本·兩半窗·regime·雙口徑）：
// ✅超跌反彈：乖離5日線<-5%（隔日收賣Δ+0.37/+0.57·5日持有+1.1~1.3%·唯一淨勝近半組）
//   ×熱門族群更強且「雙regime皆正」（5日+2.11/+1.34%·淨勝52%）——話題層的實證價值
// ❌回測5日線買點：觸線守穩全變體皆負（淨勝33.7%）——「拉回5日線接」全市場不成立
// ✅跌破5日線＝隔日弱（Δ-0.16/-0.08 兩窗穩）→ 出場/避開訊號
// ✅乖離>+8%過熱勿追（收賣Δ-0.40/-0.36）——與現行 ret5 過熱互證
// Wilder RSI(5)/RSI(10)：回傳今值與昨值（昨值供交叉/連續判定）。series=舊→新收盤序列。
function rsiPair(series) {
  let up5 = 0, dn5 = 0, up10 = 0, dn10 = 0, pr5 = 50, pr10 = 50;
  for (let k = 1; k < series.length; k++) {
    const ch = series[k] - series[k - 1]; const g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (k <= 5) { up5 += g / 5; dn5 += l / 5; } else { up5 = (up5 * 4 + g) / 5; dn5 = (dn5 * 4 + l) / 5; }
    if (k <= 10) { up10 += g / 10; dn10 += l / 10; } else { up10 = (up10 * 9 + g) / 10; dn10 = (dn10 * 9 + l) / 10; }
    if (k === series.length - 2) { pr5 = up5 + dn5 > 0 ? up5 / (up5 + dn5) * 100 : 50; pr10 = up10 + dn10 > 0 ? up10 / (up10 + dn10) * 100 : 50; }
  }
  return {
    rsi5: up5 + dn5 > 0 ? +(up5 / (up5 + dn5) * 100).toFixed(1) : 50,
    rsi10: up10 + dn10 > 0 ? +(up10 / (up10 + dn10) * 100).toFixed(1) : 50,
    pr5: +pr5.toFixed(1), pr10: +pr10.toFixed(1),
  };
}

// 持股 RSI 高檔出貨警示（使用者指定 2026-07-24·影片法則「雙RSI 90+ 連續多日準備賣出」）：
// RSI5≥90 ∧ RSI10≥90 ∧ 昨日 RSI10 亦≥90（連續）→ 每股每日提醒一次。
// 誠實註記：本站回測 RSI≥95 高檔常見鈍化續航、死亡交叉才是穩定轉弱——建議分批非全出。
const _rsiHotAlerted = new Set(); let _rsiHotDay = '';
async function checkRsiHot() {
  const arch = await loadLuArchive();
  if (arch.length < 15) return;
  const quo = (await readSnapshotQuotes())?.quotes || {};
  const tw = taipei(); const today = isoDate(tw);
  if (_rsiHotDay !== today) { _rsiHotAlerted.clear(); _rsiHotDay = today; }
  const liveDay = isTradingDay(tw) && arch[arch.length - 1].date !== today;
  const rsiOf = code => {
    const closes = [];
    for (let k = Math.max(0, arch.length - 41); k < arch.length; k++) { const v = arch[k].close[code]?.[0]; if (v > 0) closes.push(v); }
    if (closes.length < 12) return null;
    const price = liveDay && quo[code]?.price > 0 ? quo[code].price : closes[closes.length - 1];
    return { ...rsiPair(liveDay ? [...closes, price] : closes), price };
  };
  const premium = await getPremiumUsers();
  for (const u of premium) {
    try {
      const hd = await db.collection('users').doc(u.id).collection('data').doc('holdings').get();
      const holdings = hd.exists ? (hd.data().holdings || []) : []; if (!holdings.length) continue;
      const newAlerts = [];
      for (const code of [...new Set(holdings.map(h => h.code))]) {
        const r = rsiOf(code); if (!r) continue;
        if (!(r.rsi5 >= 90 && r.rsi10 >= 90 && r.pr10 >= 90)) continue;
        const key = `${u.id}:${code}:rsihot`; if (_rsiHotAlerted.has(key)) continue; _rsiHotAlerted.add(key);
        const name = (holdings.find(h => h.code === code)?.name) || code;
        newAlerts.push({ code, name, type: 'rsihot', price: r.price || 0, at: Date.now(),
          message: `💣 ${name}(${code}) RSI高檔波動警戒：RSI5 ${r.rsi5}／RSI10 ${r.rsi10} 連續站上90。本站720日實證——這不是頂點訊號：今日即未來10日最高點的機率僅22.6%（基準21.1%，等於沒有抓頂能力）；但5日內出現≥5%回檔的機率50%（基準27%）＝波動放大。出場實測：隔日就賣淨-0.53%（最差且兩窗同向）、抱5日+0.44%、抱10日+1.18%（最佳）；連續達4天以上者前瞻報酬反而更強（鈍化=主升段）。建議：移動停利跟著跑、勿隔日全出；要減碼就分批，並以跌破前低或RSI死亡交叉為硬出場。非投資建議` });
      }
      if (newAlerts.length) { await pushAlerts(u.id, newAlerts); tgSendAlerts(u.id, newAlerts).catch(() => {}); }
    } catch { /* 單用戶失敗不影響其他 */ }
  }
}

// ── 28.8) 波段起漲選股 swingPicks（2026-07-27 使用者定案·5日持有語意）────
// 訊號來源：screen-rsi-entry-grid.mjs 網格 + verify-triple-oot.mjs out-of-time 驗證。
// ⚠與隔日沖綜合評分「口徑不同」：本訊號隔日開賣 -0.06%／收賣 -0.44%／持有5日 +1.10%
//   ——edge 完全在 5 日，故獨立成榜，不併入隔日沖權重。
// 分級（940日實測·真起漲＝今日後5日不破底∧期間漲≥5%；基準真起漲14.9%）：
//   ⭐  三重確認  RSI5<20 ∧ 法人買超 ∧ 量比>1.5      真起漲18.6% 淨勝55.8% 5日+1.10%
//   ⭐⭐ 強化      ＋(RSI10<25 或 距60日高<0.85)      真起漲21.5~22.0% 淨勝58~63% +1.59~2.19%
//   ⭐⭐⭐最嚴     ＋空頭日 ∧ 量≥1000張 ∧ 距60日高<0.85 真起漲24.3% 淨勝63.0% +2.58%
// 硬性 gate：多頭日不推（實測 -0.24%·真起漲14.4% 低於基準）。
// ── 波段追強（強勢整理）·2026-08-01 上榜 ─────────────────────────
// 規則：RSI5 75~90 ∧ RSI10>RSI5（10日領先·5日回冷＝強勢整理非追過熱）
//       ∧ 法人5日買超(t-1..t-5)/20日均量 > 0.05
// 實證（verify-strength-oot·乾淨資料）：主窗 5日 +0.73%[0.71/0.76]·淨勝47.4%·
// 10日內漲≥5% 53.2%（vs 基準35%）；OOT 獨立窗 +0.96%[0.15/1.09] 勝基準；
// 逐年四段全正且全勝基準；多空 regime 皆成立(+0.73/+0.75·不需空頭 gate)。
// ⚠口徑：隔日開賣 -0.07% ＝絕不可隔日沖；5日持有語意，與 swingPicks 同框不同律。
// ⚠原 spread<5 版 OOT 兩半換號且輸基準——收斂到 spread<0 才過關（幻覺防護記錄）。
async function computeStrengthPicks() {
  try {
    const arch = await loadLuArchive();
    if (arch.length < 25) { log('✖ 波段追強：歸檔僅', arch.length, '日'); return; }
    const L = arch.length - 1;
    const quo = (await readSnapshotQuotes())?.quotes || {};
    // 法人 t-1..t-5（嚴格鏡射回測：**不含今日**——收盤後 chipDaily 最新日=今日時要跳過）
    let instWin = [];
    try {
      const w = await loadChipWindow(7);
      instWin = w.filter(x => x.date < arch[L].date).slice(0, 5);
      if (instWin.length < 5) instWin = w.slice(w.length > 5 ? 1 : 0, 6);
    } catch { /* 缺法人＝整榜跳過（inst 是規則核心，不可降級） */ }
    if (instWin.length < 5) { log('✖ 波段追強：法人視窗不足'); return; }

    const items = [];
    for (const code in arch[L].close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const closes = [], vols = [], his = [], los = [];
      for (let k = 0; k <= L; k++) {
        const r = arch[k].close[code];
        if (r?.[0] > 0) { closes.push(r[0]); vols.push(r[1] || 0); his.push(r[3] || r[0]); los.push(r[4] || r[0]); }
      }
      if (closes.length < 25) continue;
      const price = closes[closes.length - 1];
      const pc = closes[closes.length - 2];
      const chg = pc > 0 ? (price / pc - 1) * 100 : 0;
      if (chg > 8.5) continue;                                   // 可交易宇宙
      const { rsi5, rsi10 } = rsiPair(closes);
      if (!(rsi5 >= 75 && rsi5 < 90 && rsi10 > rsi5)) continue;  // 強勢整理
      // 20日均量（t-1..t-20，不含今日）
      const hv = vols.slice(-21, -1);
      const av20 = hv.length ? hv.reduce((a, b) => a + b, 0) / hv.length : 0;
      if (!(av20 > 0)) continue;
      let inst5 = 0;
      for (const w of instWin) { const it = w.map[code]; if (it) inst5 += (it[0] || 0) + (it[1] || 0); }
      const inst5Ratio = inst5 / av20;
      if (!(inst5Ratio > 0.05)) continue;
      const tVol = vols[vols.length - 1];
      // 20日波動（僅標記不設 gate）：追強母體(RSI5 75~90 強勢股)與⭐起漲(跌深股)
      // 完全相反，各測各的。實測低波動追強股在兩窗都較差——主窗 5日均-1.649%·
      // 中位-1.172%·淨勝37.8%（基準 +0.876%/-0.443%/46.7%）、OOT 中位-0.735%·
      // 淨勝43.3%（基準 -0.173%/48.9%）。**但沒到設 gate 的標準**：排除後對剩餘
      // 部位的改善僅 +0.31pp(主窗)/+0.14pp(OOT)，且 OOT 前半 Δ 為 -0.025≈零。
      // 故只標記讓人自行下修，不擋——這條日均僅 1.6 檔，硬擋容易變空榜。
      let vol20 = null;
      const vSer = closes.slice(-21);
      if (vSer.length >= 21) {
        const rt = [];
        for (let k = 1; k < vSer.length; k++) if (vSer[k - 1] > 0) rt.push((vSer[k] - vSer[k - 1]) / vSer[k - 1] * 100);
        if (rt.length >= 20) {
          const mu = rt.reduce((a, b) => a + b, 0) / rt.length;
          vol20 = +Math.sqrt(rt.reduce((a, b) => a + (b - mu) ** 2, 0) / rt.length).toFixed(2);
        }
      }
      // KD 死叉標記（2026-08-02·screen-swing-highrsi.mjs）：追強母體上 KD死叉
      // 兩窗都明顯較差——主窗 中位-2.168%(基準-0.443%)·淨勝39.5%(46.7%)、
      // OOT 中位-0.605%(-0.173%)·淨勝44.0%(48.9%)、不破底 -8.0pp/-7.2pp。
      // 與 lowVol 同樣只標記不設 gate：本榜日均僅1.6檔，且「未死叉」那一側對
      // 剩餘部位的均值改善在 OOT 為 0(+0.003)、OOT前半還轉負，未達設 gate 標準。
      let kdState = null;
      {
        let K = 50, D = 50, pk = 50, pd = 50; const hs = [], ls = []; let ok = false;
        for (let t = 0; t < closes.length; t++) {
          hs.push(his[t]); ls.push(los[t]);
          if (hs.length > 9) { hs.shift(); ls.shift(); }
          if (hs.length < 9) continue;
          const hn = Math.max(...hs), ln = Math.min(...ls);
          const rsv = hn === ln ? 50 : ((closes[t] - ln) / (hn - ln)) * 100;
          pk = K; pd = D;
          K = (K * 2) / 3 + rsv / 3; D = (D * 2) / 3 + K / 3; ok = true;
        }
        if (ok) kdState = pk <= pd && K > D ? 'gold' : pk >= pd && K < D ? 'dead' : K > D ? 'above' : 'below';
      }
      items.push({
        code, name: (quo[code]?.name || '').trim() || code,
        price: +price.toFixed(2), chg: +chg.toFixed(2),
        rsi5: +rsi5.toFixed(1), rsi10: +rsi10.toFixed(1), spread: +(rsi5 - rsi10).toFixed(1),
        inst5, inst5Ratio: +inst5Ratio.toFixed(3), vol: tVol,
        vol20, lowVol: vol20 != null && vol20 < 1.5,
        kdState, kdDead: kdState === 'dead',
      });
    }
    items.sort((a, b) => b.inst5Ratio - a.inst5Ratio);
    const crowded = items.length >= 15;   // 回測日均 1.6 檔，≥15 檔＝母體偏離示警（同 swing 的擁擠揭露）
    await db.collection('strengthPicks').doc('latest').set({
      updatedAt: Date.now(), date: arch[L].date, total: items.length, crowded,
      instWindow: instWin.map(w => w.date),
      horizon: '持有 5 個交易日（強勢整理·10日內漲≥5% 機率 53.2% vs 基準 35%）',
      caveats: [
        '⚠絕不可隔日沖：本訊號隔日開賣 -0.07%／收賣 -0.21%——edge 在第5日，隔日出場沒有期望值。',
        crowded ? `⚠訊號擁擠：今日 ${items.length} 檔（回測日均 1.6 檔）——母體已偏離回測，勝率下修看待。` : null,
        items.length === 0 ? 'ℹ今日無符合——本榜日均僅 1.6 檔，空榜是常態不是故障。' : null,
        items.some(x => x.kdDead) ? `⚠KD死叉標記：本榜 ${items.filter(x => x.kdDead).length} 檔目前為 KD 死亡交叉。追強母體上實測兩窗一致較差——主窗 5日中位 -2.168%(基準-0.443%)·淨勝39.5%(46.7%)·不破今低-8.0pp；OOT 中位-0.605%(-0.173%)·淨勝44.0%(48.9%)·不破底-7.2pp。未設 gate 的原因：「未死叉」側對剩餘部位的均值改善在 OOT 為 0(+0.003) 且 OOT 前半轉負，未達本站標準——故只標記，請自行下修。` : null,
        items.some(x => x.lowVol) ? `⚠低波動標記：本榜 ${items.filter(x => x.lowVol).length} 檔的20日波動<1.5%。實測此子集在兩窗都較差（主窗 5日均-1.649%·中位-1.172%·淨勝37.8% vs 基準+0.876%/-0.443%/46.7%；OOT 中位-0.735%·淨勝43.3% vs -0.173%/48.9%）。未設為 gate 的原因：排除後對剩餘部位改善僅+0.31pp(主窗)/+0.14pp(OOT)，且OOT前半Δ≈0，未達本站設 gate 的標準——故只標記，請自行下修。` : null,
      ].filter(Boolean),
      items: items.slice(0, 20),
      evidence: {
        rule: 'RSI5 75~90 ∧ RSI10>RSI5（強勢整理）∧ 法人5日買超(t-1~t-5)/20日均量>0.05',
        highRsi: 'RSI高檔漲幅機率（2026-08-02 補測·5日內曾漲≥5%，全市場基準 35.2%(主窗)/31.1%(OOT)）：RSI5>80 → 39.6/34.1%｜RSI5>90 → 43.1/36.9%｜RSI10>80 → 47.3/39.1%｜RSI10>80∧MA5>MA10∧vol≥1.5% → 52.6/46.7%。五個波動分層控制皆通過＝非「高檔股波動大」的代理。⚠但機率高≠賺錢：上述組合的5日淨均在主窗全部為負(-0.40~-0.56%)、中位-1.2~-1.6%——摸到+5%的那半邊上檔被封頂，沒摸到的另一半第5日平均賠6.5%。目標+3/5/8% × 四種停損共12組出場規則全部救不回來。⇒ 此表是**機率參考**不是買進訊號。',
        main: '主窗 720日：5日淨均 +0.73%[前0.71/後0.76]·淨勝47.4%·10日內漲≥5% 53.2%（基準 -0.20%/43.2%/35.0%）·日均1.6檔',
        oot: 'OOT 獨立窗（2022-07~2023-07·設計時未見）+0.96%[0.15/1.09]·勝基準；逐年四段全正且全勝基準(+0.99/+0.40/+0.82/+0.90)',
        regime: '多頭日 +0.73／空頭日 +0.75——兩個 regime 皆成立，無需空頭 gate（與波段起漲不同）',
        risk: '⚠淨勝率 47.4%＝半數以上單筆是輸的，靠右尾賺錢——分批小部位·破 5 日低停損·單筆風險≤1%。價≥50 元前半窗 -0.05 略弱，高價股倉位再保守。',
        refuted: '⚠幻覺防護記錄：原「spread<5」寬版 OOT 兩半換號(-0.57/+0.29)且輸基準——收斂到 spread<0 才全關通過。挑股時勿自行放寬條件。',
      },
    });
    log(`✓ 波段追強 ${arch[L].date}：${items.length} 檔${crowded ? '（⚠擁擠）' : ''}${items[0] ? '·首選 ' + items[0].code + ' ' + items[0].name : ''}`);
  } catch (e) { log('✖ 波段追強:', (e.message || '').slice(0, 80)); }
}

async function computeSwingPicks() {
  try {
    const arch = await loadLuArchive();
    if (arch.length < 61) { log('✖ 波段起漲：歸檔僅', arch.length, '日（需 61）'); return; }   // 逐檔另有 closes.length>=61 保護
    const quo = (await readSnapshotQuotes())?.quotes || {};
    const tw = taipei();
    const liveDay = isTradingDay(tw) && arch[arch.length - 1].date !== isoDate(tw);
    const L = arch.length - 1;
    // 市場寬度（regime gate·收盤即知 PIT 安全）：上漲家數比 <50% ＝空頭日
    let up = 0, tot = 0;
    for (const code in arch[L].close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const cPrev = arch[L - 1].close?.[code]?.[0];
      const cNow = liveDay ? (quo[code]?.price ?? null) : arch[L].close[code][0];
      if (cNow > 0 && cPrev > 0) { tot++; if (cNow > cPrev) up++; }
    }
    const breadth = tot >= 500 ? +(up / tot * 100).toFixed(1) : null;
    const bearDay = breadth != null ? breadth < 50 : null;
    let instLatest = {}, instDate = null;
    try { const w = await loadChipWindow(1); if (w.length) { instLatest = w[0].map || {}; instDate = w[0].date; } } catch { /* 可缺 */ }
    const instSameDay = !!instDate && instDate === arch[L].date;

    const items = [];
    for (const code in arch[L].close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const closes = [], vols = [], his = [], los = [];
      for (let k = 0; k <= L; k++) {
        const r = arch[k].close[code];
        if (r?.[0] > 0) { closes.push(r[0]); vols.push(r[1] || 0); his.push(r[3] || r[0]); los.push(r[4] || r[0]); }
      }
      if (closes.length < 61) continue;
      const q = quo[code];
      const price = liveDay && q?.price > 0 ? q.price : closes[closes.length - 1];
      const series = liveDay ? [...closes, price] : closes;
      const { rsi5, rsi10 } = rsiPair(series);
      if (!(rsi5 < 20)) continue;                                   // 粗篩：RSI5<20
      const tVol = liveDay ? Math.round((q?.volume || 0) / 1000) : vols[vols.length - 1];
      const yVol = liveDay ? vols[vols.length - 1] : vols[vols.length - 2];
      const volX = yVol > 0 ? +(tVol / yVol).toFixed(2) : null;
      const iv = instLatest[code];
      const instT1 = iv ? (iv[0] || 0) + (iv[1] || 0) : null;
      if (!(instT1 > 0) || !(volX > 1.5)) continue;                 // ⭐三重確認
      // 波動 gate（2026-08-02 加·screen-swing-vol.mjs）：vol20＝20日日報酬標準差%。
      // ⭐內低波動股是純負貢獻——主窗 真起漲8.6%(基18.9%)·5日均-1.268%·淨勝42.2%，
      // OOT 真起漲3.1%(基17.0%)。排除後主窗兩半 [2.295/0.278]、OOT [1.99/1.05] 皆改善，
      // 主窗逐年三段與 OOT 兩年也全改善，留存 79.9%/66.8%（不是砍到見骨的濾網）。
      // ⚠門檻只收 1.5%：≥2.5%/≥3% 的漂亮數字是 2025-04 崩跌反彈造成的
      //   （2025-04-08+04-09 佔全部訊號 20%），那兩檔的主窗後半是負的。
      const vSer = series.slice(-21);
      let vol20 = null;
      if (vSer.length >= 21) {
        const rt = [];
        for (let k = 1; k < vSer.length; k++) if (vSer[k - 1] > 0) rt.push((vSer[k] - vSer[k - 1]) / vSer[k - 1] * 100);
        if (rt.length >= 20) {
          const mu = rt.reduce((a, b) => a + b, 0) / rt.length;
          vol20 = +Math.sqrt(rt.reduce((a, b) => a + (b - mu) ** 2, 0) / rt.length).toFixed(2);
        }
      }
      if (!(vol20 >= 1.5)) continue;                                // 波動 gate
      // 60日位階（不含今日·與 bt-core posture60 同口徑）
      const base = liveDay ? closes.slice(-60) : closes.slice(-61, -1);
      const hi60 = Math.max(...base);
      const posture60 = hi60 > 0 ? +(price / hi60).toFixed(3) : null;
      const deepPull = posture60 != null && posture60 < 0.85;
      const bigVol = tVol >= 1000;
      const tier = (bearDay && bigVol && deepPull) ? 3 : (rsi10 < 25 || deepPull) ? 2 : 1;
      // KD 狀態 → **破底機率**（2026-08-02·screen-swing-triple + 拆解檢定）。
      // ⚠這不是漲幅訊號：拆解顯示 KD 交叉 100% 推動「不破今低」、對「5日內漲≥5%」
      //   的貢獻是零（波動五分層×兩窗 10 格 Δ 介於 -3.2~+3.3pp 且換號）。
      //   推漲幅的是 vol20（+5.4/+7.9pp），兩者正交互補。
      // 用途：本技能原文就有「破前低無條件停損」，此欄是那條規則的觸發機率預測器。
      // 口徑：收盤 K 線（arch 已完成的 bar），盤中不重算——未完成的 bar 沒有意義。
      let kdState = null;
      {
        let K = 50, D = 50, pk = 50, pd = 50; const hs = [], ls = []; let ok = false;
        for (let t = 0; t < closes.length; t++) {
          hs.push(his[t]); ls.push(los[t]);
          if (hs.length > 9) { hs.shift(); ls.shift(); }
          if (hs.length < 9) continue;
          const hn = Math.max(...hs), ln = Math.min(...ls);
          const rsv = hn === ln ? 50 : ((closes[t] - ln) / (hn - ln)) * 100;
          pk = K; pd = D;
          K = (K * 2) / 3 + rsv / 3; D = (D * 2) / 3 + K / 3; ok = true;
        }
        if (ok) kdState = pk <= pd && K > D ? 'gold' : pk >= pd && K < D ? 'dead' : K > D ? 'above' : 'below';
      }
      // 實測破底機率（主窗/OOT）：金叉 57.4/50.3%、死叉 80.8/75.3%、基準 71.9/65.6%
      const breakRisk = kdState === 'gold' ? 'low' : kdState === 'dead' ? 'high' : 'mid';
      items.push({ code, name: (q?.name || '').trim() || code, price: +price.toFixed(2), chg: q?.changePercent ?? null,
        rsi5, rsi10, volX, instT1, vol: tVol, posture60, deepPull, bigVol, vol20, kdState, breakRisk, tier });
    }
    items.sort((a, b) => b.tier - a.tier || b.instT1 - a.instT1);
    // 訊號擁擠度：回測日均 5.9 檔（⭐全體）。崩盤日 RSI5<20 遍地、法人又普遍站買方，
    // 條件會同時鬆掉兩道 → 出榜數暴增數十倍。此時榜單母體已不是回測的母體，須明說。
    const total = items.length;
    const crowded = total >= 60;                       // ≒回測日均的 10 倍
    await db.collection('swingPicks').doc('latest').set({
      updatedAt: Date.now(), date: isoDate(tw), mode: liveDay ? 'live' : 'close',
      breadth, bearDay, instDate, instSameDay, total, crowded,
      horizon: '持有 5 個交易日（非隔日沖：本訊號隔日開賣 -0.06%／收賣 -0.44%，edge 全在第5日）·已套用 vol20≥1.5% 波動 gate',
      gate: bearDay === false ? '⚠今日為多頭日（上漲家數比 ' + breadth + '%）——實測多頭日此訊號 5日 -0.24%·真起漲僅14.4% 低於基準，本日不建議進場'
        : bearDay === true ? '✅今日為空頭日（上漲家數比 ' + breadth + '%）——此訊號的有效市況' : '大盤寬度資料不足',
      // 兩個「今天和回測不一樣」的誠實揭露，缺一就會讓人把榜單當成回測績效在看
      caveats: [
        crowded ? `⚠訊號擁擠：今日符合 ${total} 檔（回測日均僅 5.9 檔）。全市場同時跌深＋法人普遍站買方時，兩道濾網一起失去鑑別力——此時的榜單不等於回測母體，勝率請下修看待，寧可只取最前面幾檔或整天不做。` : null,
        instSameDay ? `⚠法人口徑：今日採用的是「當日」法人買賣超（${instDate}，收盤後已公布），回測用的是 t-1。方向一致但非同一變數，實測差異 +1.11%(t-1) vs +0.83%(當日)。` : null,
        'ℹ已套用波動 gate：20日波動<1.5%的低波動股一律不上榜（該子集主窗真起漲僅8.6%·5日均-1.268%、OOT真起漲3.1%，是純負貢獻）。此 gate 使本榜較 2026-08-02 前少約 20~33% 檔數。',
      ].filter(Boolean),
      counts: { t1: items.filter(x => x.tier === 1).length, t2: items.filter(x => x.tier === 2).length, t3: items.filter(x => x.tier === 3).length },
      items: items.slice(0, 30),
      evidence: {
        t1: '⭐三重確認（RSI5<20×法人t-1買超×量比>1.5）：真起漲18.6%·5日淨勝55.8%·淨均+1.10%（基準14.9%/44.2%/-0.08%）·日均5.9檔',
        kdBreak: 'KD 交叉＝**破底風險**指標，非漲幅指標（2026-08-02 拆解檢定）。5日內會破今日最低的機率：金叉 57.4%(主窗)/50.3%(OOT)、無交叉≈基準 71.9%/65.6%、死叉 80.8%/75.3%。⚠關鍵拆解：把「真起漲」拆成「不破今低」與「5日內漲≥5%」兩成分後，KD 交叉只推前者（金叉 28.1→42.6%/34.4→49.7%，波動五分層×兩窗10格全部+13.2~17.0pp），對後者貢獻是零（Δ -3.2~+3.3pp且換號）。推漲幅的是 vol20（35.2→40.6%/31.1→39.0%），兩者正交互補、合流組數字正好是兩者相加。⇒ 先前「金叉真起漲率23.5% vs 基準17.9%」的提升**全部來自不破底那一半**，不要誤讀成比較會漲。用途：本技能原文的「破前低無條件停損」，此欄即該規則的觸發機率預測器。',
        volGate: '波動 gate（2026-08-02 加）vol20≥1.5%：⭐內排除低波動後 主窗 真起漲18.9→21.5%·5日均1.035→1.615%·淨勝55.7→59.1%，OOT 真起漲17.0→24.0%·5日均0.919→1.447%·淨勝56.9→60.1%；主窗兩半[2.295/0.278]、OOT兩半[1.99/1.05]、主窗逐年三段與OOT兩年全改善；留存79.9%/66.8%。被排除的低波動組本身：主窗 真起漲僅8.6%·5日均-1.268%·淨勝42.2%／OOT 真起漲3.1% ——是純負貢獻。⚠不採更嚴門檻：≥2.5%/≥3% 的主窗數字(5日均+4.5%/+6.4%)是2025-04崩跌反彈artifact（04-08與04-09兩天佔全部訊號20%），那兩檔主窗後半為負(-0.194/-0.49)、2026年也是負的。',
        t2: '⭐⭐強化（＋RSI10<25 或 距60日高<0.85）：真起漲21.5~22.0%·淨勝58.2~62.7%·淨均+1.59~+2.19%',
        t3: '⭐⭐⭐最嚴（＋空頭日∧量≥1000張∧距60日高<0.85）：真起漲24.3%·淨勝63.0%·淨均+2.58%·日均僅2.2檔',
        oot: 'out-of-time 驗證通過：第三獨立窗（2022-07~2023-07·訊號設計時未見）5日+1.04%·淨勝61.5%（主窗+1.11%/55.0%）；逐年四段全正（+1.02/+0.31/+1.79/+0.46%）；流動性分層越大越強（量≥3000張+2.22%）＝非小型股假象',
        risk: '⚠即使最嚴組合真起漲也僅24.3%——四次有三次不是真轉折（會再破底或彈不到5%）。左尾重：分批小部位、破前低無條件停損、單筆風險≤1%。多頭日不用。',
      },
    });
    log(`✓ 波段起漲 ${isoDate(tw)}：⭐${items.filter(x => x.tier === 1).length}/⭐⭐${items.filter(x => x.tier === 2).length}/⭐⭐⭐${items.filter(x => x.tier === 3).length}·寬度${breadth}%(${bearDay ? '空頭日✅' : '多頭日⚠'})`);
  } catch (e) { log('✖ 波段起漲:', (e.message || '').slice(0, 80)); }
}

async function computeTopicPicks() {
  try {
    const arch = await loadLuArchive();                       // 62日收盤（10分鐘快取）
    if (arch.length < 25) return;
    const quo = (await readSnapshotQuotes())?.quotes || {};
    const indMap = await getIndustryMap();
    const tw = taipei();
    const liveDay = isTradingDay(tw) && arch[arch.length - 1].date !== isoDate(tw);
    // 話題層①：族群5日板數 Top3（與回測同口徑）
    const cnt = {};
    for (let k = Math.max(1, arch.length - 5); k < arch.length; k++) {
      for (const c in arch[k].close) { const p = arch[k - 1].close?.[c]?.[0]; if (p && luIsLimitUp(arch[k].close[c][0], p) && indMap[c]) cnt[indMap[c]] = (cnt[indMap[c]] || 0) + 1; }
    }
    const hotSectors = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 3).filter(([, n]) => n >= 5).map(([ind, n]) => ({ ind, n }));
    const hotSet = new Set(hotSectors.map(h => h.ind));
    // 話題層②：sectorForecast 看漲族群；③：當日新聞提及（newsDaily）
    try { const fc = (await db.collection('sectorForecast').doc('latest').get()).data(); for (const b of (fc?.bullish || [])) hotSet.add(b.sector); } catch { /* 可缺 */ }
    let newsMap = {};
    try { const nd = (await db.collection('newsDaily').doc(isoDate(tw)).get()).data(); if (nd?.mentionsJson) newsMap = JSON.parse(nd.mentionsJson); } catch { /* 可缺 */ }
    // 三重確認用法人淨買超（外資+投信）。⚠資料日隨執行時點變動：盤中取到 t-1、
    // 16:30 T86 公布後取到 t——兩者對應「不同的可執行策略」，evidence 依此切換（見下）。
    let instLatest = {}, instDate = null;
    try { const w = await loadChipWindow(1); if (w.length) { instLatest = w[0].map || {}; instDate = w[0].date; } } catch { /* 缺法人不影響其餘標記 */ }
    const instSameDay = !!instDate && instDate === arch[arch.length - 1].date;   // true＝已含今日T86
    const oversold = [], overheat = [], breakdown = [];
    for (const code in arch[arch.length - 1].close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const closes = [];
      for (let k = Math.max(0, arch.length - 41); k < arch.length; k++) { const v = arch[k].close[code]?.[0]; if (v > 0) closes.push(v); }
      if (closes.length < 20) continue;
      const q = quo[code];
      const price = liveDay && q?.price > 0 ? q.price : closes[closes.length - 1];
      const series = liveDay ? [...closes, price] : closes;   // 含「今日」的收盤序列
      const seq = series.slice(-5);
      const ma5 = seq.reduce((s, v) => s + v, 0) / 5;
      const ma20 = series.slice(-20).reduce((s, v) => s + v, 0) / 20;
      const bias5 = (price - ma5) / ma5 * 100;
      const prevC = series[series.length - 2];
      const pm5 = series.slice(-6, -1).reduce((s, v) => s + v, 0) / 5;
      // 犀利媽 RSI(5)/RSI(10)（Wilder）：雙RSI<10=稀有極端超跌（存證觀察級）；
      // 死亡交叉=八命題唯一過關；雙RSI≥90=影片「準備賣出」警示（勿接刀標記）
      const { rsi5, rsi10, pr5, pr10 } = rsiPair(series);
      const deathX = pr5 > 70 && pr5 >= pr10 && rsi5 < rsi10;
      const rsiHot = rsi5 >= 90 && rsi10 >= 90;
      const vol = Math.round((q?.volume || 0) / 1000);
      // 量比（口徑須與回測一致＝今日量÷昨日量，非20日均量）
      const arr = arch[arch.length - 1].close[code];
      const yVol = liveDay ? (arr?.[1] || 0) : (arch[arch.length - 2]?.close?.[code]?.[1] || 0);
      const tVol = liveDay ? vol : (arr?.[1] || 0);
      const volX = yVol > 0 ? +(tVol / yVol).toFixed(2) : null;
      // 法人 t-1 淨買超（外資+投信）
      const iv = instLatest[code];
      const instT1 = iv ? (iv[0] || 0) + (iv[1] || 0) : null;
      // ⭐三重確認（screen-rsi-entry-grid.mjs 網格唯一最強組合·5日淨均+1.11%[+0.69/+1.38]·淨勝55%）
      const triple = rsi5 < 20 && instT1 > 0 && volX > 1.5;
      const newsN = newsMap[code]?.n || (typeof newsMap[code] === 'number' ? newsMap[code] : 0);
      const isHot = hotSet.has(indMap[code]) || newsN >= 2;
      const item = { code, name: (q?.name || '').trim() || code, price: +price.toFixed(2), chg: q?.changePercent ?? null, bias5: +bias5.toFixed(2), rsi5, rsi10, dualRsi: rsi5 < 10 && rsi10 < 10, deathX, rsiHot, triple, volX, instT1, ind: indMap[code] || null, newsN, hot: isHot, aboveM20: price > ma20 };
      if ((bias5 < -5 || item.dualRsi || triple || (rsi5 < 12 && rsi10 < 25)) && (!liveDay || vol >= 50)) oversold.push(item);  // RSI≈10／三重確認 亦入超跌推薦
      else if (bias5 > 8 || rsiHot) overheat.push(item);   // 雙RSI90+＝危險勿接刀
      else if (deathX || (prevC > pm5 && price < ma5 && (q?.changePercent ?? 0) > -9)) breakdown.push(item);
    }
    // ⚠話題族群不再排前：在 RSI5<20 重挫族內實測 -0.53%(兩窗換號 +1.54/-1.99)＝題材退燒的接刀，
    //   與「乖離溫和回檔×話題」的正面結果相反（screen-triple-leaders.mjs）。
    oversold.sort((a, b) => (b.triple ? 1 : 0) - (a.triple ? 1 : 0) || (b.dualRsi ? 1 : 0) - (a.dualRsi ? 1 : 0) || a.bias5 - b.bias5);
    overheat.sort((a, b) => b.bias5 - a.bias5);
    breakdown.sort((a, b) => (b.deathX ? 1 : 0) - (a.deathX ? 1 : 0) || (b.hot ? 1 : 0) - (a.hot ? 1 : 0) || (b.newsN - a.newsN));
    await db.collection('topicPicks').doc('latest').set({
      updatedAt: Date.now(), date: isoDate(tw), mode: liveDay ? 'live' : 'close',
      instDate, instSameDay,
      hotSectors, bullishNote: [...hotSet].slice(0, 8),
      oversold: oversold.slice(0, 20), overheat: overheat.slice(0, 15), breakdown: breakdown.slice(0, 15),
      evidence: { oversold: `⭐三重確認(RSI5<20×法人買超×量比>1.5)＝網格唯一最強。${instSameDay
        ? `本輪法人資料＝${instDate}當日T86(16:30後公布)，對應可執行版本「明日買進」：實測5日淨均+0.83%[+0.67/+0.93]·淨勝52.4%（買明日收盤；買明日開盤僅+0.47%且兩窗不穩[1.05/0.08]，不建議）`
        : `本輪法人資料＝${instDate || 't-1'}(前一交易日)，對應可執行版本「今日收盤買」：實測5日淨均+1.11%[+0.69/+1.38]·淨勝55%·10日內漲≥5% 43.2%`}（vs基準-0.17%/43.3%）；乖離5日線<-5%：隔日收賣Δ+0.37/+0.57·5日+1.1~1.3%·×熱門族群5日+2.11/+1.34%(雙regime正)；⚡雙RSI<10=稀有極端(720日610筆·5日+0.69/+5.87%)存證觀察。⚠中性區(RSI5 50~75∧RSI10 50~70)實測低於基準(-0.26%)、疊任何條件皆未過檢定——起漲點在低檔不在中性區`, maTouch: '「拉回5日線接」回測不成立(淨勝33.7%)——本榜不提供此類', breakdown: '跌破5日線隔日Δ-0.16/-0.08(兩窗穩)＋💀高檔死亡交叉(RSI5>70下穿RSI10·八命題唯一過關·Δ-0.11/-0.18全同向)——持有者出場參考', overheat: '乖離>+8%隔日收賣Δ-0.40/-0.36——勿追；RSI體系八命題檢定：低檔金叉買進「顯著負」(等確認=讓掉反彈肉)·底背離/站回50/頂背離/跌破50/雙線續抱皆不成立——僅死亡交叉採用' },
    });
    log(`✓ 話題×5日線：超跌${oversold.length}(熱${oversold.filter(x => x.hot).length})/過熱${overheat.length}/破線${breakdown.length}·熱門族群 ${hotSectors.map(h => h.ind).join('、') || '—'}`);
  } catch (e) { log('✖ 話題×5日線:', (e.message || '').slice(0, 80)); }
}

// ── 29) 盤前晨報（morning-note 台股化：純模板零幻覺，按日期保存）──
async function publishMorningNote() {
  const tw = taipei(); if (!isTradingDay(tw)) return;
  const date = isoDate(tw);
  const [gmD, hD, iD, cD] = await Promise.all([
    db.collection('globalMarkets').doc('latest').get(),
    db.collection('marketHealth').doc('latest').get(),
    db.collection('institutionalStreaks').doc('latest').get(),
    db.collection('catalystCalendar').doc('latest').get(),
  ]);
  const g = gmD.data() || {}; const markets = g.markets || [];
  const pick = sym => markets.find(m => m.sym === sym);
  const fmt = m => m ? `${m.name} ${m.price}（${m.changePct > 0 ? '+' : ''}${m.changePct}%）` : null;
  const lines = [`# ${date} 盤前晨報`, ''];
  // 今日風向推測（新聞+國際盤 AI 定性推測，置頂）
  let forecast = null;
  try {
    const fc = (await db.collection('sectorForecast').doc('latest').get()).data();
    if (fc?.date === date && (fc.bullish?.length || fc.bearish?.length)) {
      forecast = { bullish: fc.bullish || [], bearish: fc.bearish || [], model: fc.model };
      lines.push('## 今日風向推測（AI 推測非事實）');
      for (const x of forecast.bullish) lines.push(`- 🔴 看漲：${x.sector}（${x.reason}）`);
      for (const x of forecast.bearish) lines.push(`- 🟢 看跌：${x.sector}（${x.reason}）`);
      lines.push('');
    }
  } catch { /* skip */ }
  const overnight = [pick('^SOX'), pick('^IXIC'), pick('^DJI'), pick('TWD=X'), pick('CL=F')].map(fmt).filter(Boolean);
  if (overnight.length) lines.push('## 隔夜國際盤', ...overnight.map(s => `- ${s}`), g.expectation ? `- 對台股電子預期：${g.expectation}` : null, '');
  try {
    const adr = (await db.collection('adrPremium').doc('latest').get()).data();
    if (adr?.items?.length && Date.now() - adr.updatedAt < 12 * 3600000) {
      lines.push('## ADR 溢價（開盤先行指標）', ...adr.items.map(x => `- ${x.name} ADR ${x.premium > 0 ? '溢價 +' : '折價 '}${x.premium}%（換算 ${x.implied} vs 現股 ${x.twPrice}）`), '');
    }
  } catch { /* skip */ }
  const h = hD.data();
  if (h?.health != null) lines.push('## 昨日大盤體質', `- 健康度 ${h.health}/100（${h.mood || ''}）：漲 ${h.up} / 跌 ${h.down} 家，漲停 ${h.limitUp}、跌停 ${h.limitDown}，創新高 ${h.newHigh} 檔`, '');
  const todayEvents = (cD.data()?.events || []).filter(e => e.date === date);
  if (todayEvents.length) lines.push('## 今日事件', ...todayEvents.slice(0, 12).map(e => `- ${e.title}`), '');
  const f3 = (iD.data()?.foreign || []).slice(0, 3);
  if (f3.length) lines.push('## 外資連買焦點', ...f3.map(x => `- ${x.code} ${x.name}：連 ${x.days} 日買超（累計 ${x.lots.toLocaleString()} 張）`), '');
  lines.push('---', '> 由程式依官方資料自動彙整（零 AI 生成數字），僅供參考，非投資建議。');
  const content = lines.filter(l => l != null).join('\n');
  const docData = { date, generatedAt: Date.now(), model: 'template(zero-hallucination)', content, eventCount: todayEvents.length, forecast };
  await db.collection('morningNote').doc(date).set(docData);   // 歷史按日期保存
  await db.collection('morningNote').doc('latest').set(docData);
  log(`✓ 盤前晨報 ${date}（今日事件 ${todayEvents.length} 件）`);
}

// ── 30) 投資論點追蹤（thesis-tracker 台股化）───────────────────
// 「AI 依當時數據預填草稿」：支柱/風險全部由真實數據判定（零幻覺），使用者可改。
// 每日自動檢核各支柱 ✓/✗，多數支柱瓦解時警報「你買它的理由已不成立」。
const THESIS_PILLARS = [
  { key: 'score60',    label: '技術評分 ≥60',              test: (d, c) => (d.rating[c]?.score ?? 0) >= 60 },
  { key: 'bullSignal', label: 'AI 訊號偏多',               test: (d, c) => ['BUY', 'STRONG_BUY'].includes(d.rating[c]?.signal) },
  { key: 'foreignBuy', label: '外資連續買超中',            test: (d, c) => d.inst.has(c) },
  { key: 'revGrowth',  label: '月營收年增為正',            test: (d, c) => (d.rev[c] ?? -1) > 0 },
  { key: 'rs70',       label: '相對強度 RS ≥70',           test: (d, c) => (d.rs[c] ?? 0) >= 70 },
  { key: 'yield4',     label: '殖利率 ≥4%（下檔保護）',    test: (d, c) => (d.yld[c] ?? 0) >= 4 },
];
async function _thesisData() {
  const rating = (await getJSON('/api/rating'))?.ratings || {};
  const inst = new Set((((await db.collection('institutionalStreaks').doc('latest').get()).data())?.foreign || []).map(x => x.code));
  const rev = {}; for (const x of await fetchMonthlyRevenueAll()) rev[x['公司代號']] = _f(x['營業收入-去年同月增減(%)']);
  const rs = Object.fromEntries((((await db.collection('rsRanking').doc('latest').get()).data())?.top || []).map(x => [x.code, x.rs]));
  const bw = (await fetchBwibbu()).rows;
  const yld = {}; for (const x of bw) yld[x.Code] = _f(x.DividendYield);
  return { rating, inst, rev, rs, yld };
}
async function updateTheses() {
  const data = await _thesisData();
  const premium = await getPremiumUsers();
  for (const u of premium) {
    const uid = u.id;
    try {
      const hd = (await db.collection('users').doc(uid).collection('data').doc('holdings').get()).data();
      const byCode = {};
      for (const h of (hd?.holdings || [])) { const g = (byCode[h.code] ??= { qty: 0, cost: 0, name: h.name }); g.qty += h.quantity; g.cost += h.buyPrice * h.quantity; if (h.note && !g.note) g.note = h.note; }
      const codes = Object.keys(byCode); if (!codes.length) continue;
      const ref = db.collection('users').doc(uid).collection('data').doc('theses');
      const cur = (await ref.get()).data()?.theses || {};
      const pa = (await db.collection('users').doc(uid).collection('data').doc('portfolioAnalysis').get()).data()?.analyses || {};
      const newAlerts = [];
      for (const code of codes) {
        const results = THESIS_PILLARS.map(p => ({ key: p.key, label: p.label, ok: p.test(data, code) }));
        if (!cur[code]) {
          // AI 依當時數據預填草稿：成立的支柱=買進依據；不成立的=風險
          const pillars = results.filter(r => r.ok);
          const risks = results.filter(r => !r.ok).slice(0, 3).map(r => `${r.label}：目前不成立`);
          const avg = byCode[code].qty ? byCode[code].cost / byCode[code].qty : 0;
          const a = pa[code] || {};
          cur[code] = {
            name: byCode[code].name, status: 'draft', conviction: 'medium',
            thesis: (byCode[code].note ? `${byCode[code].note}｜` : '') + (pillars.length ? `（AI 依據）${pillars.map(p => p.label).join('、')}。` : '（草稿）目前無明確多方數據依據，請補充你的買進理由。'),
            pillars: (pillars.length ? pillars : results.slice(0, 3)).map(r => ({ key: r.key, label: r.label, ok: r.ok })),
            risks, targetPrice: a.targetPrice?.low > 0 ? a.targetPrice.low : +(avg * 1.2).toFixed(2),
            stopLoss: a.stopLoss > 0 ? a.stopLoss : +(avg * 0.92).toFixed(2),
            createdAt: Date.now(), updatedAt: Date.now(), intact: true,
          };
        } else {
          // 每日檢核：以現時數據重評各支柱
          const t = cur[code];
          const byKey = Object.fromEntries(results.map(r => [r.key, r.ok]));
          t.pillars = (t.pillars || []).map(p => ({ ...p, ok: byKey[p.key] ?? p.ok }));
          const okN = t.pillars.filter(p => p.ok).length;
          const wasIntact = t.intact !== false;
          t.intact = t.pillars.length === 0 || okN >= Math.ceil(t.pillars.length / 2);
          t.updatedAt = Date.now();
          if (wasIntact && !t.intact) newAlerts.push({ code, name: t.name, type: 'thesis', message: `🧩 ${code} ${t.name} 投資論點轉弱：${t.pillars.filter(p => !p.ok).map(p => p.label).join('、')} 已不成立 — 建議檢視持有理由`, at: Date.now() });
        }
      }
      for (const code in cur) if (!byCode[code]) delete cur[code]; // 已出清的持股移除論點
      await ref.set({ updatedAt: Date.now(), theses: cur });
      if (newAlerts.length) {
        const aref = db.collection('users').doc(uid).collection('data').doc('alerts');
        const prev = (await aref.get()).data()?.alerts || [];
        await aref.set({ updatedAt: Date.now(), alerts: [...newAlerts, ...prev].slice(0, 40) });
        pushAlerts(uid, newAlerts).catch(() => {});
        for (const al of newAlerts) log(`  🔔 ${uid} ${al.message}`);
      }
    } catch (e) { log('  ✖ theses', uid, e.message); }
  }
  log('✓ 論點追蹤：檢核完成');
}

// ── 31) 配置漂移再平衡（portfolio-rebalance 台股化）─────────────
// 預設：單一個股 ≤25%、單一產業 ≤40%、現金 ≥10%（現金需使用者於 UI 輸入）。
const REBAL_LIMITS = { maxStockPct: 25, maxIndustryPct: 40, minCashPct: 10 };
async function checkAllocationDrift() {
  const snap = await readSnapshotQuotes(); if (!snap) return; const q = snap.quotes;
  const pc = (await db.collection('peerComps').doc('latest').get()).data();
  const indOf = {};
  if (pc) { const ind = JSON.parse(pc.industriesJson || '{}'); for (const k in ind) for (const s of ind[k]) indOf[s.code] = k; }
  const premium = await getPremiumUsers();
  for (const u of premium) {
    const uid = u.id;
    try {
      const hd = (await db.collection('users').doc(uid).collection('data').doc('holdings').get()).data();
      const byCode = {};
      for (const h of (hd?.holdings || [])) { const g = (byCode[h.code] ??= { qty: 0, name: h.name }); g.qty += h.quantity; }
      const codes = Object.keys(byCode); if (!codes.length) continue;
      const settings = (await db.collection('users').doc(uid).collection('data').doc('rebalanceSettings').get()).data() || {};
      const lim = { ...REBAL_LIMITS, ...(settings.limits || {}) };
      let cash = settings.cash > 0 ? settings.cash : null;
      // 有現金流水帳(cashLedger)則自動推算餘額，優先於手動值：
      // 入金 − 出金 + 股利 + 賣出入帳 − 買入扣款（totalAmount 已含稅費）
      try {
        const led = (await db.collection('users').doc(uid).collection('data').doc('cashLedger').get()).data();
        if (led?.entries?.length) {
          const td = (await db.collection('users').doc(uid).collection('data').doc('trades').get()).data();
          const ts = td?.trades || td?.tradeRecords || [];
          cash = led.entries.reduce((s, e) => s + (e.type === 'withdraw' ? -e.amount : e.amount), 0)
            + ts.filter(t => t.type === 'sell').reduce((s, t) => s + (t.totalAmount || 0), 0)
            - ts.filter(t => t.type === 'buy').reduce((s, t) => s + (t.totalAmount || 0), 0);
          if (!(cash > 0)) cash = 0;
        }
      } catch { /* ledger 讀取失敗則沿用手動值 */ }
      let totalStock = 0; const rows = [];
      for (const code of codes) { const px = q[code]?.price ?? 0; const mv = px * byCode[code].qty * 1000; totalStock += mv; rows.push({ code, name: byCode[code].name, industry: indOf[code] || '其他', price: px, qty: byCode[code].qty, mv }); }  // quantity=張 → ×1000 股（修正市值少千倍）
      const totalAll = totalStock + (cash || 0);
      if (!(totalAll > 0)) continue;
      const weights = rows.map(r => ({ ...r, mv: Math.round(r.mv), pct: +((r.mv / totalAll) * 100).toFixed(1) })).sort((a, b) => b.pct - a.pct);
      const indAgg = {};
      for (const r of weights) indAgg[r.industry] = +((indAgg[r.industry] || 0) + r.pct).toFixed(1);
      const industryWeights = Object.entries(indAgg).map(([industry, pct]) => ({ industry, pct })).sort((a, b) => b.pct - a.pct);
      const violations = [];
      for (const r of weights) if (r.pct > lim.maxStockPct && r.price > 0) {
        const excess = (r.pct - lim.maxStockPct) / 100 * totalAll;
        const lots = Math.max(1, Math.round(excess / (r.price * 1000)));
        violations.push({ type: 'stock', code: r.code, name: r.name, pct: r.pct, limit: lim.maxStockPct, suggestion: `建議減持約 ${lots} 張（≈${Math.round(excess / 10000)} 萬，交易成本約 0.44%）至 ${lim.maxStockPct}% 以下` });
      }
      for (const iw of industryWeights) if (iw.pct > lim.maxIndustryPct) violations.push({ type: 'industry', industry: iw.industry, pct: iw.pct, limit: lim.maxIndustryPct, suggestion: `${iw.industry} 曝險 ${iw.pct}% 超過 ${lim.maxIndustryPct}%，建議分散至其他產業` });
      const cashPct = cash != null ? +((cash / totalAll) * 100).toFixed(1) : null;
      if (cashPct != null && cashPct < lim.minCashPct) violations.push({ type: 'cash', pct: cashPct, limit: lim.minCashPct, suggestion: `現金水位 ${cashPct}% 低於 ${lim.minCashPct}%，建議保留調節空間` });
      await db.collection('users').doc(uid).collection('data').doc('rebalance').set({ updatedAt: Date.now(), totalStock: Math.round(totalStock), cash, cashPct, limits: lim, weights, industryWeights, violations });
    } catch (e) { log('  ✖ rebalance', uid, e.message); }
  }
  log('✓ 配置漂移：檢查完成');
}

// ── 32) 估值位階 PE Band（dcf-model 的台股散戶替代：本益比河流）──
// 近 12 個月每日本益比(官方 BWIBBU) → 百分位帶；現價落點=貴/俗位階。零推估。
async function _userCodes() {
  const codes = new Set();
  const usersSnap = await db.collection('users').get();
  for (const u of usersSnap.docs) {
    if (!['premium', 'admin', 'superadmin'].includes((u.data().level) || 'registered')) continue;
    try {
      const hd = (await db.collection('users').doc(u.id).collection('data').doc('holdings').get()).data();
      for (const h of (hd?.holdings || [])) codes.add(h.code);
      const wd = (await db.collection('users').doc(u.id).collection('data').doc('watchlist').get()).data();
      for (const w of (wd?.watchlist || [])) codes.add(w.code);
    } catch { /* skip user */ }
  }
  return [...codes].filter(c => /^\d{4}$/.test(c));
}
async function computePeBands() {
  const codes = (await _userCodes()).slice(0, 20);
  const snap = await readSnapshotQuotes(); const q = snap?.quotes || {};
  const tw = taipei();
  let done = 0;
  for (const code of codes) {
    try {
      const cur = (await db.collection('stockPeBand').doc(code).get()).data();
      if (cur && Date.now() - cur.updatedAt < 7 * 86400000) continue; // 每週更新一次即可
      const pes = []; let peNow = 0;
      for (let m = 0; m < 12; m++) {
        const d = new Date(tw.getFullYear(), tw.getMonth() - m, 1);
        const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}01`;
        try {
          const r = await fetch(`https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU?date=${ym}&stockNo=${code}&response=json`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          if (r.ok) {
            const j = await r.json(); const rows = j.data || [];
            for (const row of rows) { const pe = _f(row[3]); if (pe > 0) pes.push(pe); }
            if (m === 0) for (let i = rows.length - 1; i >= 0 && !peNow; i--) peNow = _f(rows[i][3]); // 最新一筆官方 PE
          }
        } catch { /* month skip */ }
        await sleep(1500); // www.twse 限速保護
      }
      if (pes.length < 60 || !(peNow > 0)) continue; // 資料不足(如上櫃/新股/虧損無PE)不硬算
      const below = pes.filter(p => p <= peNow).length;
      const percentile = Math.round(below / pes.length * 100); // 現在 PE 的歷史百分位
      pes.sort((a, b) => a - b);
      const pct = p => +pes[Math.min(pes.length - 1, Math.floor(pes.length * p))].toFixed(2);
      const bands = { pMin: pes[0], p25: pct(0.25), p50: pct(0.5), p75: pct(0.75), pMax: pes[pes.length - 1] };
      const price = q[code]?.price ?? 0;
      const eps = peNow > 0 && price > 0 ? +(price / peNow).toFixed(2) : null; // EPS(TTM)=官方現價/官方現PE
      const priceAt = eps ? { p25: +(bands.p25 * eps).toFixed(0), p50: +(bands.p50 * eps).toFixed(0), p75: +(bands.p75 * eps).toFixed(0) } : null;
      await db.collection('stockPeBand').doc(code).set({ code, updatedAt: Date.now(), samples: pes.length, months: 12, price, peNow, eps, percentile, bands, priceAt });
      done++;
    } catch (e) { log('  ✖ peBand', code, e.message); }
  }
  if (done) log(`✓ PE Band：更新 ${done} 檔`);
}

// ── 33) 月度投資報告（client-review 台股化：純模板）─────────────
async function publishMonthlyReports() {
  const tw = taipei();
  const prev = new Date(tw.getFullYear(), tw.getMonth() - 1, 1);
  const ym = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
  const monthStart = prev.getTime();
  const monthEnd = new Date(tw.getFullYear(), tw.getMonth(), 1).getTime();
  // 大盤當月漲跌：FMTQIK 取月初/月末加權指數
  let idxPct = null;
  try {
    const ymd = `${prev.getFullYear()}${String(prev.getMonth() + 1).padStart(2, '0')}01`;
    const r = await fetch(`https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=${ymd}&response=json`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (r.ok) { const j = await r.json(); const rows = (String(j?.date || '') === ymd ? (j.data || []) : []); if (rows.length >= 2) { const a = _f(rows[0][4]), b = _f(rows[rows.length - 1][4]); if (a > 0) idxPct = +((b - a) / a * 100).toFixed(2); } }
  } catch { /* skip */ }
  const snap = await readSnapshotQuotes(); const q = snap?.quotes || {};
  const premium = await getPremiumUsers();
  for (const u of premium) {
    const uid = u.id;
    try {
      const exist = (await db.collection('users').doc(uid).collection('data').doc('monthlyReport').get()).data();
      if (exist?.ym === ym) continue; // 已生成
      const td = (await db.collection('users').doc(uid).collection('data').doc('trades').get()).data();
      const trades = (td?.trades || td?.tradeRecords || []).filter(t => { const ts = t.at || (t.date ? Date.parse(t.date) : 0); return ts >= monthStart && ts < monthEnd; });
      const sells = trades.filter(t => t.type === 'sell' && t.realizedPnL != null);
      const hd = (await db.collection('users').doc(uid).collection('data').doc('holdings').get()).data();
      const byCode = {};
      for (const h of (hd?.holdings || [])) { const g = (byCode[h.code] ??= { qty: 0, cost: 0, name: h.name }); g.qty += h.quantity; g.cost += h.buyPrice * h.quantity; }
      if (!trades.length && !Object.keys(byCode).length) continue;
      const wins = sells.filter(t => t.realizedPnL > 0);
      const realized = Math.round(sells.reduce((s, t) => s + t.realizedPnL, 0));
      let mv = 0, cost = 0;
      for (const c in byCode) { mv += (q[c]?.price ?? 0) * byCode[c].qty; cost += byCode[c].cost; }
      const unrlPct = cost > 0 ? +((mv - cost) / cost * 100).toFixed(1) : null;
      const lines = [`# ${ym} 月度投資報告`, ''];
      lines.push('## 當月交易', trades.length ? `- 買進 ${trades.filter(t => t.type === 'buy').length} 筆、賣出 ${sells.length} 筆${sells.length ? `，勝率 ${(wins.length / sells.length * 100).toFixed(0)}%（${wins.length}/${sells.length}）` : ''}` : '- 本月無交易', sells.length ? `- 已實現損益 ${realized >= 0 ? '+' : ''}${realized.toLocaleString()} 元` : null, '');
      lines.push('## 期末持倉', Object.keys(byCode).length ? `- ${Object.keys(byCode).length} 檔、市值約 ${(mv / 10000).toFixed(1)} 萬${unrlPct != null ? `、未實現 ${unrlPct >= 0 ? '+' : ''}${unrlPct}%` : ''}` : '- 空手', '');
      if (idxPct != null) lines.push('## 大盤對照', `- 加權指數當月 ${idxPct >= 0 ? '+' : ''}${idxPct}%${unrlPct != null ? `，你的未實現報酬 ${unrlPct >= 0 ? '+' : ''}${unrlPct}%（${unrlPct >= idxPct ? '優於' : '落後'}大盤）` : ''}`, '');
      lines.push('---', '> 程式依你的交易紀錄與官方行情自動彙整，零 AI 生成數字。');
      await db.collection('users').doc(uid).collection('data').doc('monthlyReport').set({ ym, generatedAt: Date.now(), model: 'template(zero-hallucination)', content: lines.filter(l => l != null).join('\n'), stats: { trades: trades.length, sells: sells.length, realized, mv: Math.round(mv), unrlPct, idxPct } });
      log(`  ✓ 月報 ${uid} ${ym}`);
    } catch (e) { log('  ✖ 月報', uid, e.message); }
  }
}

// premium 使用者清單快取（5 分鐘）：34+ 個技能原本各自全量讀 users 集合，
// 高頻迴圈(問答8s/再平衡45s)造成 Firestore 讀取暴量——統一走此快取。
let _premiumCache = { at: 0, users: [] };
async function getPremiumUsers() {
  if (Date.now() - _premiumCache.at < 5 * 60000) return _premiumCache.users;
  const snap = await db.collection('users').get();
  _premiumCache = { at: Date.now(), users: snap.docs.filter(d => ['premium', 'admin', 'superadmin'].includes((d.data().level) || 'registered')).map(d => ({ id: d.id })) };
  return _premiumCache.users;
}

// ── Web Push：警報直接推到使用者裝置（訂閱由前端 PushSetup 寫入）──
const _vapidOk = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (_vapidOk) webpush.setVapidDetails('mailto:nicholas@gmii.tw', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
async function pushAlerts(uid, newAlerts) {
  tgSendAlerts(uid, newAlerts).catch(() => {}); // Telegram 同步推播(獨立失敗不影響 Web Push)
  if (!_vapidOk || !newAlerts?.length) return;
  try {
    const ref = db.collection('users').doc(uid).collection('data').doc('pushSubs');
    const subs = (await ref.get()).data()?.subs || [];
    if (!subs.length) return;
    const alive = [];
    let sent = 0, dead = 0, failed = 0;
    for (const raw of subs) {
      try {
        const sub = JSON.parse(raw);
        for (const a of newAlerts.slice(0, 5)) {
          // 點擊通知直接開對應個股頁：帶 ?code=，前端解析後導向個股分析
          const url = /^\d{4,6}$/.test(String(a.code || '')) ? `/?code=${a.code}` : '/';
          await webpush.sendNotification(sub, JSON.stringify({ title: `台股助手警報`, body: a.message, tag: `${a.type}-${a.code}`, url }));
          sent++;
        }
        alive.push(raw);
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { dead++; continue; } // 訂閱已失效 → 剔除
        failed++; alive.push(raw); // 暫時性錯誤保留
      }
    }
    // 送達記錄（診斷「警示有觸發但手機沒收到」用）
    log(`  📮 WebPush ${uid.slice(0, 6)}: 送出${sent} 失效剔除${dead} 失敗${failed}（訂閱${subs.length}）`);
    if (alive.length !== subs.length) await ref.set({ subs: alive, updatedAt: Date.now() }, { merge: true });
  } catch { /* push 失敗不影響警報主流程 */ }
}

// ── 57) 法說會質化預覽（financial-services earnings-preview 概念）──
// 持股/自選中 7 日內有法說會者 → 用既有評分+新聞產生 3-4 句質化預覽。
// LLM 僅做質化整理、嚴禁生成任何未提供的數字；輸出標示「AI 推測」。
async function previewEarningsCalls() {
  const cal = (await db.collection('catalystCalendar').doc('latest').get()).data();
  const tw = taipei(); const today = isoDate(tw);
  const limit = isoDate(new Date(tw.getTime() + 7 * 86400000));
  const calls = (cal?.events || []).filter(e => e.type === 'earnings-call' && e.code && e.date >= today && e.date <= limit);
  if (!calls.length) return;
  // 只做會員關注的個股，控制 LLM 用量
  const watched = new Set();
  try { for (const [code] of await resolveWatchCodes()) watched.add(code); } catch { /* ignore */ }
  const targets = calls.filter(e => watched.has(e.code)).slice(0, 6);
  for (const e of targets) {
    try {
      const prev = (await db.collection('earningsCallPreviews').doc(e.code).get()).data();
      if (prev?.date === e.date) continue; // 已生成
      const [rating, newsRes] = await Promise.all([
        getJSON(`/api/rating?code=${e.code}`),
        getJSON(`/api/twse/stock-news?code=${e.code}&name=${encodeURIComponent(e.name)}`),
      ]);
      const st = rating?.stock;
      const news = (newsRes?.news || []).slice(0, 5).map(n => `- ${n.title}`).join('\n');
      const prompt = [
        `${e.name}(${e.code}) 將於 ${e.date} 召開法說會。請用繁體中文寫 3-4 句「法說會前瞻」，說明市場可能關注的重點與股價敏感點。`,
        st ? `目前 AI 技術評分 ${st.score}、訊號 ${st.signal}、現價 ${st.price}(${st.changePercent}%)。` : '',
        news ? `近期新聞標題：\n${news}` : '',
        '嚴格規則：只能引用上面提供的數字，不得自行編造任何數字或財測；聚焦質化觀察（產業景氣、法人關注議題、股價位階）。',
      ].filter(Boolean).join('\n');
      const out = await askOllama(prompt);
      if (!out) continue;
      await db.collection('earningsCallPreviews').doc(e.code).set({
        code: e.code, name: e.name, date: e.date, preview: out.trim().slice(0, 600),
        model: process.env.OLLAMA_MODEL || 'ollama', generatedAt: Date.now(), qualitative: true,
      });
      log(`  🎤 法說會前瞻 ${e.code} ${e.name}（${e.date}）`);
    } catch { /* per-stock skip */ }
  }
}

// ── 56) Shadow Account 影子帳戶（借鏡 Vibe-Trading）──────────────
// 讀使用者交易紀錄 → 學出「你實際在用的規則」(持有天數/實際停損位/攤平頻率)
// → 與系統鐵律(隔日必出/停損-8%)比對 → 「若照規則出場」的模擬損益 vs 實際，
// 把破戒代價變成具體數字。全確定性計算，寫 users/{uid}/data/shadowAccount。
async function analyzeShadowAccount() {
  // 2026-08-01：原本全量掃 chipArchive（~1,000 docs·每次 runDailyJobs 都來一次）。
  // 影子帳戶模擬只需覆蓋使用者近期交易，260 日（約一年）綽綽有餘。
  const arch = (await db.collection('chipArchive').orderBy('date', 'desc').limit(260).get()).docs.map(d => d.data()).reverse();
  const dates = arch.map(a => a.date);
  const closes = arch.map(a => a.closeJson ? JSON.parse(a.closeJson) : {});
  const closeOn = (code, dateStr) => { const i = dates.indexOf(dateStr); return i >= 0 ? closes[i]?.[code]?.[0] : null; };
  const nextTradingIdx = dateStr => { for (let i = 0; i < dates.length; i++) if (dates[i] > dateStr) return i; return -1; };

  const premium = await getPremiumUsers();
  for (const u of premium) {
    try {
      const td = (await db.collection('users').doc(u.id).collection('data').doc('trades').get()).data();
      const trades = (td?.trades || td?.tradeRecords || []).filter(t => t.type === 'buy' || t.type === 'sell');
      if (trades.length < 4) continue;
      trades.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

      // FIFO 配對 buy→sell（同代號）
      const open = {}; const pairs = [];
      for (const t of trades) {
        if (t.type === 'buy') (open[t.code] ??= []).push({ ...t });
        else if (t.type === 'sell') {
          let qty = t.quantity;
          while (qty > 0 && open[t.code]?.length) {
            const b = open[t.code][0];
            const used = Math.min(qty, b.quantity);
            pairs.push({ code: t.code, name: t.name, buyDate: b.date, sellDate: t.date, buyPrice: b.price, sellPrice: t.price, qty: used });
            b.quantity -= used; qty -= used;
            if (b.quantity <= 0) open[t.code].shift();
          }
        }
      }
      if (!pairs.length) continue;

      const holdDaysOf = p => Math.max(0, Math.round((Date.parse(p.sellDate) - Date.parse(p.buyDate)) / 86400000));
      const rets = pairs.map(p => ({ ...p, ret: (p.sellPrice - p.buyPrice) / p.buyPrice * 100, days: holdDaysOf(p) }));
      const wins = rets.filter(p => p.ret > 0), losses = rets.filter(p => p.ret <= 0);
      const med = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

      // 「你的實際規則」(learned rules)
      const learned = {
        medHoldDays: med(rets.map(p => p.days)),
        overnightRate: Math.round(rets.filter(p => p.days <= 1).length / rets.length * 100), // 隔日沖遵守率
        avgWinExit: wins.length ? +(wins.reduce((s, p) => s + p.ret, 0) / wins.length).toFixed(1) : null,   // 實際停利位
        avgLossExit: losses.length ? +(losses.reduce((s, p) => s + p.ret, 0) / losses.length).toFixed(1) : null, // 實際停損位
        deepLossCount: losses.filter(p => p.ret < -8).length, // 拖過 -8% 鐵律才出場的次數
        winRate: Math.round(wins.length / rets.length * 100),
      };
      // 攤平行為：同代號持有中往下加碼次數
      let avgDownCount = 0; const held = {};
      for (const t of trades) {
        if (t.type === 'buy') { if (held[t.code]?.length && t.price < Math.min(...held[t.code])) avgDownCount++; (held[t.code] ??= []).push(t.price); }
        else if (t.type === 'sell') held[t.code] = [];
      }

      // 規則模擬：每筆 buy 若照「隔日收盤出」(鐵律近似)的損益 vs 實際損益（僅 chipArchive 覆蓋期間）
      let simPnL = 0, actPnL = 0, simN = 0;
      for (const p of rets) {
        const ni = nextTradingIdx(p.buyDate); if (ni < 0) continue;
        const nc = closes[ni]?.[p.code]?.[0]; if (!(nc > 0)) continue;
        simPnL += (nc - p.buyPrice) * p.qty * 1000;
        actPnL += (p.sellPrice - p.buyPrice) * p.qty * 1000;
        simN++;
      }

      const violations = [];
      if (learned.overnightRate < 70) violations.push(`隔日沖遵守率僅 ${learned.overnightRate}%（鐵律：隔日必出）— 中位持有 ${learned.medHoldDays} 天`);
      if (learned.deepLossCount > 0) violations.push(`有 ${learned.deepLossCount} 筆虧損拖過 -8% 停損鐵律才出場（實際平均停損位 ${learned.avgLossExit}%）`);
      if (avgDownCount > 0) violations.push(`向下攤平 ${avgDownCount} 次（跌勢中攤平是套牢加倍主因）`);

      await db.collection('users').doc(u.id).collection('data').doc('shadowAccount').set({
        updatedAt: Date.now(), pairsAnalyzed: rets.length, learned, avgDownCount, violations,
        ruleSim: simN >= 3 ? { n: simN, actualPnL: Math.round(actPnL), ruleBasedPnL: Math.round(simPnL), diff: Math.round(simPnL - actPnL) } : null,
      });
      log(`  🪞 影子帳戶 ${u.id.slice(0, 6)}: ${rets.length} 筆配對, 隔日沖率 ${learned.overnightRate}%, 違規 ${violations.length}`);
    } catch { /* per-user skip */ }
  }
}

// ── Telegram 推播（使用者選 TG 取代 LINE）───────────────────────
// 需 .env.local 設 TELEGRAM_BOT_TOKEN（BotFather 建立；勿提交 repo）。
// 開機 getMe → 寫 botUsername 到 config/telegram 供前端組 deep link；
// tgLinkLoop 長輪詢 getUpdates 處理「/start <uid>」自動綁定 chatId。
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const tgApi = (method, body) => fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json()).catch(() => null);
const _tgChat = new Map(); // uid -> {chatId, at}（5 分快取，省 Firestore 讀）
async function tgChatIdOf(uid) {
  const c = _tgChat.get(uid); if (c && Date.now() - c.at < 300000) return c.chatId;
  const d = (await db.collection('users').doc(uid).collection('data').doc('telegram').get()).data();
  const chatId = d?.chatId || null; _tgChat.set(uid, { chatId, at: Date.now() });
  return chatId;
}
async function tgSendAlerts(uid, newAlerts) {
  if (!TG_TOKEN || !newAlerts?.length) return;
  try {
    const chatId = await tgChatIdOf(uid); if (!chatId) return;
    for (const a of newAlerts.slice(0, 5)) {
      const link = /^\d{4,6}$/.test(String(a.code || '')) ? `\nhttps://tw-stock-helper.web.app/?code=${a.code}` : '';
      await tgApi('sendMessage', { chat_id: chatId, text: `${a.message}${link}`, disable_web_page_preview: true });
    }
  } catch { /* tg 失敗不影響主流程 */ }
}
let _tgOffset = 0;
async function tgLinkLoop() {
  if (!TG_TOKEN) { log('ℹ Telegram 推播未啟用（.env.local 缺 TELEGRAM_BOT_TOKEN）'); return; }
  try {
    const me = await tgApi('getMe', {});
    if (me?.ok) { await db.collection('config').doc('telegram').set({ botUsername: me.result.username, updatedAt: Date.now() }); log(`✓ Telegram bot @${me.result.username}`); }
  } catch { /* getMe 失敗仍續跑輪詢 */ }
  for (;;) {
    try {
      const r = await tgApi('getUpdates', { offset: _tgOffset, timeout: 25 });
      for (const u of (r?.result || [])) {
        _tgOffset = u.update_id + 1;
        const msg = u.message; if (!msg?.text) continue;
        const m = msg.text.match(/^\/start[ =]+([A-Za-z0-9]{10,64})$/); // uid 格式白名單，防路徑注入
        if (m) {
          const uid = m[1];
          await db.collection('users').doc(uid).collection('data').doc('telegram').set({ chatId: msg.chat.id, linkedAt: Date.now() }, { merge: true });
          _tgChat.delete(uid);
          await tgApi('sendMessage', { chat_id: msg.chat.id, text: '✅ 已連結台股助手：停損紀律／買點狙擊／開盤賣出提醒等警報將推播到這裡。' });
          log(`✓ Telegram 綁定 ${uid.slice(0, 6)}…`);
        } else if (msg.text.startsWith('/start')) {
          await tgApi('sendMessage', { chat_id: msg.chat.id, text: '請從台股助手網站「投資組合 → 警報推播」點「連結 Telegram」開啟本對話，才能綁定帳號。' });
        }
      }
    } catch { await sleep(10000); }
    await sleep(2000); // getUpdates timeout=25 為長輪詢，此間隔僅防快速空轉
  }
}
if (!ONESHOT) tgLinkLoop();

// ── 34) 停損紀律追蹤（處分效應對策：警報響過不能就算了）─────────
// 持股跌破停損後開始逐日追蹤：每天升級提醒「已觸發 N 天未處理，
// 若當時執行可少虧 X 元」——把拖延的代價變成具體數字。
const _disciplineAlerted = new Set(); let _disciplineDay = '';
let _lastDisciplineRun = 0;
async function trackStopDiscipline() {
  if (Date.now() - _lastDisciplineRun < 10 * 60000) return; // 盤中節流：每 10 分鐘一次
  _lastDisciplineRun = Date.now();
  const snap = await readSnapshotQuotes(); if (!snap) return; const q = snap.quotes;
  const today = isoDate(taipei());
  if (_disciplineDay !== today) { _disciplineAlerted.clear(); _disciplineDay = today; }
  const premium = await getPremiumUsers();
  for (const u of premium) {
    const uid = u.id;
    try {
      const hd = (await db.collection('users').doc(uid).collection('data').doc('holdings').get()).data();
      const byCode = {};
      for (const h of (hd?.holdings || [])) { const g = (byCode[h.code] ??= { qty: 0, cost: 0, name: h.name }); g.qty += h.quantity; g.cost += h.buyPrice * h.quantity; }
      const pa = (await db.collection('users').doc(uid).collection('data').doc('portfolioAnalysis').get()).data()?.analyses || {};
      const ref = db.collection('users').doc(uid).collection('data').doc('stopDiscipline');
      const items = (await ref.get()).data()?.items || {};
      const newAlerts = [];
      // 清掉已出清或已站回停損上方 2% 的
      for (const code in items) {
        const held = byCode[code]; const px = q[code]?.price ?? 0;
        if (!held || (px > 0 && px > items[code].stopPrice * 1.02)) delete items[code];
      }
      for (const code in byCode) {
        const g = byCode[code]; const avg = g.qty ? g.cost / g.qty : 0;
        const price = q[code]?.price ?? 0;
        if (!(price > 0) || !(avg > 0)) continue;
        const a = pa[code] || {};
        // 紀律錨點：AI 停損與「成本 -8%」取較嚴者。AI 的 ATR 停損會隨價格下移，
        // 若只看它，深度套牢(如 -18%)反而永遠不觸發——成本底線不可漂移。
        const stop = +Math.max(a.stopLoss > 0 ? a.stopLoss : 0, avg * 0.92).toFixed(2);
        if (price > stop) continue;
        if (!items[code]) {
          items[code] = { name: g.name, firstAt: Date.now(), stopPrice: stop, priceAtTrigger: price };
        }
        const it = items[code];
        const days = Math.max(1, Math.round((Date.now() - it.firstAt) / 86400000) + 1);
        const extraLoss = Math.round((it.priceAtTrigger - price) * g.qty);
        it.days = days; it.extraLoss = extraLoss; it.lastPrice = price;
        const key = `${uid}:${code}`;
        if (_disciplineAlerted.has(key)) continue; _disciplineAlerted.add(key);
        const lossPct = ((price - avg) / avg * 100).toFixed(1);
        newAlerts.push({ code, name: g.name, type: 'discipline', price, days, message: `⛔ ${code} ${g.name} 停損(${it.stopPrice})已觸發第 ${days} 天未處理（現價 ${price}，${lossPct}%）${extraLoss > 0 ? `。若觸發當日執行，可少虧約 ${extraLoss.toLocaleString()} 元` : ''} — 請面對決策：停損或明確寫下續抱理由`, at: Date.now() });
      }
      await ref.set({ updatedAt: Date.now(), items });
      if (newAlerts.length) {
        const aref = db.collection('users').doc(uid).collection('data').doc('alerts');
        const prev = (await aref.get()).data()?.alerts || [];
        await aref.set({ updatedAt: Date.now(), alerts: [...newAlerts, ...prev].slice(0, 40) });
        pushAlerts(uid, newAlerts).catch(() => {});
        for (const al of newAlerts) log(`  🔔 ${uid} ${al.message.slice(0, 80)}`);
      }
    } catch (e) { log('  ✖ discipline', uid, e.message); }
  }
  log('✓ 停損紀律：追蹤完成');
}

// ── 35) 買點狙擊（讓現金等好球）────────────────────────────────
// 收盤後：自選股評分 ≥80 者算 AI 建議買點 → 盤中價回落進入買點區間
// (買點 -3% ~ +0.5%) 即警報，每人每檔每日一次。
async function buildSnipeList() {
  const rating = (await getJSON('/api/rating'))?.ratings || {};
  const premium = await getPremiumUsers();
  // 四大法人否決：外資賣超的標的隔日沖勝率僅 39%、均報酬 -0.24%(回測)→ 不進狙擊清單
  const iwCtx = await getInstWeightCtx();
  const foreignSelling = code => (iwCtx?.latest?.[code]?.[0] || 0) < 0;
  const byUid = {};
  for (const u of premium) {
    const uid = u.id;
    try {
      const wd = (await db.collection('users').doc(uid).collection('data').doc('watchlist').get()).data();
      const hd = (await db.collection('users').doc(uid).collection('data').doc('holdings').get()).data();
      const held = new Set((hd?.holdings || []).map(h => h.code));
      const hi = (wd?.watchlist || []).filter(w => !held.has(w.code) && (rating[w.code]?.score ?? 0) >= 80 && !foreignSelling(w.code))
        .sort((a, b) => instWeight(b.code, iwCtx) - instWeight(a.code, iwCtx)) // 同分以法人加權優先
        .slice(0, 10);
      const list = [];
      for (const w of hi) {
        const full = await getJSON(`/api/rating?code=${w.code}`);
        const buy = (full?.stock?.buyZones || []).find(z => z.type === 'standard')?.price;
        if (buy > 0) list.push({ code: w.code, name: w.name || w.code, buy, score: rating[w.code].score });
      }
      if (list.length) byUid[uid] = list;
    } catch { /* skip user */ }
  }
  await db.collection('snipeList').doc('latest').set({ updatedAt: Date.now(), date: await dataDate(), byUidJson: JSON.stringify(byUid) });
  log(`✓ 買點狙擊清單：${Object.values(byUid).flat().length} 檔`);
}
const _snipeAlerted = new Set(); let _snipeDay = '';
async function checkSnipe() {
  const doc = (await db.collection('snipeList').doc('latest').get()).data();
  if (!doc?.byUidJson) return;
  const byUid = JSON.parse(doc.byUidJson);
  const snap = await readSnapshotQuotes(); if (!snap) return; const q = snap.quotes;
  const ctx = await getInstWeightCtx(); // 勝率雷達階段濾網用
  const today = isoDate(taipei());
  if (_snipeDay !== today) { _snipeAlerted.clear(); _snipeDay = today; }
  for (const uid in byUid) {
    const newAlerts = [];
    for (const s of byUid[uid]) {
      const x = q[s.code]; if (!x?.live || !(x.price > 0)) continue;
      if (x.price <= s.buy * 1.005 && x.price >= s.buy * 0.97) {
        // 勝率雷達階段濾網：只在 S/A/B+（法人主導）才提示進貨
        const v = ctx.latest?.[s.code] || [0, 0, 0];
        const volLots = x.volume ? Math.round(x.volume / 1000) : 0;
        const p = chipPhaseTier(v[0] || 0, v[1] || 0, v[2] || 0, ctx.streak?.[s.code] || 0, x.changePercent || 0, volLots);
        if (!['S', 'A', 'B+'].includes(p.tier)) continue; // 過熱/中性/外資賣超 不推
        const key = `${uid}:${s.code}`;
        if (_snipeAlerted.has(key)) continue; _snipeAlerted.add(key);
        newAlerts.push({ code: s.code, name: s.name, type: 'buyzone', price: x.price, message: `🎯 ${s.code} ${s.name} 回落進入 AI 建議買點：現價 ${x.price}、買點 ${s.buy}（評分 ${s.score}）— 好球帶。為何買：籌碼「${p.label}」勝率雷達 ${p.tier}級${p.win}%，外${v[0]}/投${v[1]}/自${v[2]}張。依部位大小評估。非投資建議。`, at: Date.now() });
      }
    }
    if (newAlerts.length) {
      try {
        const aref = db.collection('users').doc(uid).collection('data').doc('alerts');
        const prev = (await aref.get()).data()?.alerts || [];
        await aref.set({ updatedAt: Date.now(), alerts: [...newAlerts, ...prev].slice(0, 40) });
        pushAlerts(uid, newAlerts).catch(() => {});
        for (const al of newAlerts) log(`  🔔 ${uid} ${al.message.slice(0, 70)}`);
      } catch { /* skip */ }
    }
  }
}

// ── 36) 汰弱留強輪動建議（機會成本可視化）──────────────────────
// 每檔持股的評分 vs 全市場百分位；弱勢持股(評分<50 或後 30%)列出
// 「若轉入前 20 強的機會成本比較」——讓續抱 vs 認錯變成數據決策。
async function computeRotation() {
  const rating = (await getJSON('/api/rating'))?.ratings || {};
  const all = Object.values(rating).map(r => r.score).sort((a, b) => a - b);
  if (!all.length) return;
  const pctOf = s => Math.round(all.filter(x => x <= s).length / all.length * 100);
  const top20 = Object.entries(rating).sort((a, b) => b[1].score - a[1].score).slice(0, 20);
  const topAvg = Math.round(top20.reduce((s, [, r]) => s + r.score, 0) / top20.length);
  const csv = await fetchCloseCsvFull(); const nameOf = {}; for (const c of csv) nameOf[c.code] = c.name;
  const premium = await getPremiumUsers();
  for (const u of premium) {
    const uid = u.id;
    try {
      const hd = (await db.collection('users').doc(uid).collection('data').doc('holdings').get()).data();
      const byCode = {};
      for (const h of (hd?.holdings || [])) { const g = (byCode[h.code] ??= { name: h.name }); g.name = h.name; }
      const codes = Object.keys(byCode); if (!codes.length) continue;
      const items = codes.map(code => {
        const r = rating[code] || {};
        const score = r.score ?? null; const pct = score != null ? pctOf(score) : null;
        const weak = score != null && (score < 50 || pct < 30);
        return { code, name: byCode[code].name, score, percentile: pct, signal: r.signal ?? null, weak,
          note: weak ? `評分 ${score}（市場後段 ${pct}%），前 20 強平均 ${topAvg} 分 — 續抱等於放棄轉倉到強勢股的機會` : null };
      });
      const alternatives = top20.slice(0, 5).map(([code, r]) => ({ code, name: nameOf[code] || code, score: r.score, signal: r.signal }));
      await db.collection('users').doc(uid).collection('data').doc('rotation').set({ updatedAt: Date.now(), topAvg, items, alternatives });
    } catch (e) { log('  ✖ rotation', uid, e.message); }
  }
  log('✓ 汰弱留強：分析完成');
}

// ════════════════════════════════════════════════════════════
// 技能批次5：推薦成績追蹤 / 除權息決策 / 週報 / 盤中異常 / 當沖比率 /
//            停券回補 / ETF 折溢價 / 定期定額提示
// ════════════════════════════════════════════════════════════

// ── 37) AI 推薦成績追蹤（元技能：讓各榜單的可信度可衡量）────────
// 每交易日收盤後記錄 TOP20 與盤中潛力榜；5/10/20 個交易日到期時凍結報酬，
// 彙總成勝率記分板。全程式計算。
async function trackPicks() {
  const tw = taipei(); if (!isTradingDay(tw)) return;
  const date = isoDate(tw);
  const snap = await readSnapshotQuotes(); const q = snap?.quotes || {};
  const rec = await getJSON('/api/twse/ai-recommend');
  const top20 = (rec?.recommendations || []).slice(0, 20).map(r => ({ code: r.code, name: r.name || r.code, score: r.score, price: q[r.code]?.price ?? 0 })).filter(p => p.price > 0);
  let intraday = [];
  try { const ip = (await db.collection('intradayPicks').doc('latest').get()).data(); if (ip?.picks) intraday = JSON.parse(ip.picks).slice(0, 20).map(r => ({ code: r.code, name: r.name || r.code, score: r.score, price: q[r.code]?.price ?? 0 })).filter(p => p.price > 0); } catch { /* skip */ }
  await db.collection('picksHistory').doc(date).set({ date, top20, intraday }, { merge: true });

  // 到期評估：第 5/10/20 個交易日以當日收盤凍結報酬
  const hist = await db.collection('picksHistory').get();
  const docs = hist.docs.map(d => d.data()).filter(d => d.date).sort((a, b) => a.date.localeCompare(b.date));
  const idx = Object.fromEntries(docs.map((d, i) => [d.date, i]));
  for (const d of docs) {
    const age = idx[date] - idx[d.date];
    for (const h of [5, 10, 20]) {
      if (age !== h || d[`eval${h}`]) continue;
      const ev = list => (list || []).map(p => (p.price > 0 && q[p.code]?.price > 0 ? +(((q[p.code].price - p.price) / p.price) * 100).toFixed(2) : null)).filter(v => v != null);
      d[`eval${h}`] = { top20: ev(d.top20), intraday: ev(d.intraday) };
      await db.collection('picksHistory').doc(d.date).set({ [`eval${h}`]: d[`eval${h}`] }, { merge: true });
    }
  }
  const agg = { top20: {}, intraday: {} };
  for (const h of [5, 10, 20]) for (const k of ['top20', 'intraday']) {
    const rets = docs.flatMap(d => d[`eval${h}`]?.[k] || []);
    if (rets.length) agg[k][`d${h}`] = { n: rets.length, winRate: Math.round(rets.filter(v => v > 0).length / rets.length * 100), avgRet: +(rets.reduce((s, v) => s + v, 0) / rets.length).toFixed(2) };
  }
  await db.collection('picksScoreboard').doc('latest').set({ updatedAt: Date.now(), from: docs[0]?.date || date, records: docs.length, agg });
  log(`✓ 推薦成績：${date} 已記錄（歷史 ${docs.length} 日）`);
}

// ── 38) 除權息參與決策（事件前 5 日推稅後比較）──────────────────
const _exdivAlerted = new Set();
async function adviseExDiv() {
  const div = (await db.collection('dividendCalendar').doc('latest').get()).data()?.upcoming || [];
  const tw = taipei(); const today = isoDate(tw);
  const soon = isoDate(new Date(tw.getTime() + 5 * 86400000));
  const map = {};
  for (const x of div) { const ds = rocToIso(x.date); const cash = _f(x.cash); if (ds && ds >= today && ds <= soon && cash > 0) map[x.code] = { ds, cash }; }
  if (!Object.keys(map).length) return;
  const snap = await readSnapshotQuotes(); const q = snap?.quotes || {};
  const premium = await getPremiumUsers();
  for (const u of premium) {
    const uid = u.id;
    try {
      const hd = (await db.collection('users').doc(uid).collection('data').doc('holdings').get()).data();
      const byCode = {};
      for (const h of (hd?.holdings || [])) { const g = (byCode[h.code] ??= { qty: 0, name: h.name }); g.qty += h.quantity; }
      const bracket = ((await db.collection('users').doc(uid).collection('data').doc('taxSettings').get()).data()?.bracket) ?? 20;
      const newAlerts = [];
      for (const code in byCode) {
        if (!map[code]) continue;
        const key = `${uid}:${code}:${map[code].ds}`; if (_exdivAlerted.has(key)) continue; _exdivAlerted.add(key);
        const shares = byCode[code].qty * 1000;
        const gross = Math.round(map[code].cash * shares);
        const merged = Math.round(gross * (bracket / 100) - Math.min(gross * 0.085, 80000));
        const separate = Math.round(gross * 0.28);
        const nhi = gross >= 20000 ? Math.round(gross * 0.0211) : 0;
        const tax = Math.max(Math.min(merged, separate), 0) + nhi;
        const price = q[code]?.price ?? 0;
        const skipCost = Math.round(price * shares * 0.006); // 棄息=賣+買回，約 0.6% 交易成本
        const better = (gross - tax) > (gross - skipCost) ? '參加除息' : '棄息（先賣後買回）';
        newAlerts.push({ code, name: byCode[code].name, type: 'exdiv', price, message: `💸 ${code} ${byCode[code].name} ${map[code].ds} 除息（現金 ${map[code].cash}/股）：股利約 ${gross.toLocaleString()} 元，稅費約 ${tax.toLocaleString()}（稅率 ${bracket}% 取合併/分離較低者+二代健保）vs 棄息交易成本約 ${skipCost.toLocaleString()} → 試算傾向「${better}」。僅供參考。`, at: Date.now() });
      }
      if (newAlerts.length) {
        const aref = db.collection('users').doc(uid).collection('data').doc('alerts');
        const prev = (await aref.get()).data()?.alerts || [];
        await aref.set({ updatedAt: Date.now(), alerts: [...newAlerts, ...prev].slice(0, 40) });
        pushAlerts(uid, newAlerts).catch(() => {});
        for (const al of newAlerts) log(`  🔔 ${uid} ${al.message.slice(0, 70)}`);
      }
    } catch (e) { log('  ✖ exdiv', uid, e.message); }
  }
}

// ── 39) 週末復盤週報（每週六 10:00，純模板）─────────────────────
async function publishWeeklyReviews() {
  const tw = taipei();
  const weekOf = isoDate(new Date(tw.getTime() - 6 * 86400000)) + '~' + isoDate(tw);
  const weekStart = tw.getTime() - 7 * 86400000;
  // 大盤本週：FMTQIK 當月日資料取近 5 個交易日
  let idxPct = null;
  try {
    const r = await fetch(`https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=${ymd8(tw)}&response=json`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (r.ok) { const j = await r.json(); const rows = (String(j?.date || '') === ymd8(tw) ? (j.data || []) : []).slice(-5); if (rows.length >= 2) { const a = _f(rows[0][4]), b = _f(rows[rows.length - 1][4]); if (a > 0) idxPct = +((b - a) / a * 100).toFixed(2); } }
  } catch { /* skip */ }
  const sec = (await db.collection('sectorRotation').doc('latest').get()).data()?.sectors || [];
  const cal = (await db.collection('catalystCalendar').doc('latest').get()).data()?.events || [];
  const nextWeekEnd = isoDate(new Date(tw.getTime() + 7 * 86400000));
  const snap = await readSnapshotQuotes(); const q = snap?.quotes || {};
  const premium = await getPremiumUsers();
  for (const u of premium) {
    const uid = u.id;
    try {
      const td = (await db.collection('users').doc(uid).collection('data').doc('trades').get()).data();
      const trades = (td?.trades || td?.tradeRecords || []).filter(t => { const ts = t.at || t.createdAt || (t.date ? Date.parse(t.date) : 0); return ts >= weekStart; });
      const sells = trades.filter(t => t.type === 'sell' && t.realizedPnL != null);
      const hd = (await db.collection('users').doc(uid).collection('data').doc('holdings').get()).data();
      const byCode = {};
      for (const h of (hd?.holdings || [])) { const g = (byCode[h.code] ??= { qty: 0, cost: 0, name: h.name }); g.qty += h.quantity; g.cost += h.buyPrice * h.quantity; }
      if (!trades.length && !Object.keys(byCode).length) continue;
      let mv = 0, cost = 0;
      for (const c in byCode) { mv += (q[c]?.price ?? 0) * byCode[c].qty * 1000; cost += byCode[c].cost * 1000; }
      const unrl = cost > 0 ? +((mv - cost) / cost * 100).toFixed(1) : null;
      const realized = Math.round(sells.reduce((s, t) => s + t.realizedPnL, 0));
      const best = [...sells].sort((a, b) => b.realizedPnL - a.realizedPnL)[0];
      const worst = [...sells].sort((a, b) => a.realizedPnL - b.realizedPnL)[0];
      const heldCodes = new Set(Object.keys(byCode));
      const myEvents = cal.filter(e => e.date > isoDate(tw) && e.date <= nextWeekEnd && (!e.code || heldCodes.has(e.code))).slice(0, 10);
      const lines = [`# 週報 ${weekOf}`, ''];
      lines.push('## 本週交易', trades.length ? `- ${trades.length} 筆（賣出 ${sells.length}）${sells.length ? `，已實現 ${realized >= 0 ? '+' : ''}${realized.toLocaleString()} 元` : ''}` : '- 本週無交易');
      if (best && best.realizedPnL > 0) lines.push(`- 最佳：${best.code} ${best.name} +${Math.round(best.realizedPnL).toLocaleString()}`);
      if (worst && worst.realizedPnL < 0) lines.push(`- 最差：${worst.code} ${worst.name} ${Math.round(worst.realizedPnL).toLocaleString()}`);
      lines.push('', '## 持倉與大盤', `- 持倉 ${Object.keys(byCode).length} 檔${unrl != null ? `，未實現 ${unrl >= 0 ? '+' : ''}${unrl}%` : ''}${idxPct != null ? `；加權指數本週 ${idxPct >= 0 ? '+' : ''}${idxPct}%` : ''}`);
      if (sec.length) lines.push('', '## 產業輪動', `- 最強 ${sec[0].industry}（${sec[0].avgChangePct >= 0 ? '+' : ''}${sec[0].avgChangePct}%）、最弱 ${sec[sec.length - 1].industry}（${sec[sec.length - 1].avgChangePct}%）`);
      if (myEvents.length) lines.push('', '## 下週事件', ...myEvents.map(e => `- ${e.date} ${e.title}`));
      lines.push('', '---', '> 程式自動彙整，零 AI 生成數字。');
      await db.collection('users').doc(uid).collection('data').doc('weeklyReport').set({ weekOf, generatedAt: Date.now(), model: 'template(zero-hallucination)', content: lines.join('\n') });
      log(`  ✓ 週報 ${uid} ${weekOf}`);
    } catch (e) { log('  ✖ 週報', uid, e.message); }
  }
}

// ── 40) 盤中異常偵測（爆量急拉/急殺，60 秒窗口）─────────────────
// 持股另有更靈敏的「下車警示」：60秒 -1.5% 且量能爆增（4倍分鐘均量）即推播。
const _anomalyRing = {}; const _anomalyAlerted = new Map();
let _holdingsCache = { at: 0, byCode: new Map() }; // code → Set(uid) 持有者
async function _refreshHoldingsCache() {
  if (Date.now() - _holdingsCache.at < 5 * 60000) return;
  const byCode = new Map();
  try {
    const usersSnap = await db.collection('users').get();
    for (const u of usersSnap.docs) {
      if (!['premium', 'admin', 'superadmin'].includes((u.data().level) || 'registered')) continue;
      const hd = (await db.collection('users').doc(u.id).collection('data').doc('holdings').get()).data();
      for (const h of (hd?.holdings || [])) { if (!byCode.has(h.code)) byCode.set(h.code, new Set()); byCode.get(h.code).add(u.id); }
    }
    _holdingsCache = { at: Date.now(), byCode };
  } catch { /* keep stale */ }
}
async function checkAnomalies(quotes, trackedCodes) {
  const now = Date.now();
  await _refreshHoldingsCache();
  const tw = taipei(); const minsOpen = Math.max(1, tw.getHours() * 60 + tw.getMinutes() - 540);
  for (const code of trackedCodes) {
    const x = quotes[code]; if (!x?.live || !(x.price > 0)) continue;
    const ring = (_anomalyRing[code] ??= []);
    ring.push({ t: now, price: x.price, value: x.value || 0 });
    while (ring.length && now - ring[0].t > 120000) ring.shift();
    const base = ring.find(p => now - p.t >= 55000); if (!base) continue;
    const chg = ((x.price - base.price) / base.price) * 100;
    // 持股下車警示：跌 1.5%+ 且 60 秒量能 ≥4 倍分鐘均量（爆量下殺）
    const holders = _holdingsCache.byCode.get(code);
    if (holders?.size && chg <= -1.5) {
      const valDelta = (x.value || 0) - (base.value || 0);
      const avgPerMin = (x.value || 0) / minsOpen;
      if (avgPerMin > 0 && valDelta >= avgPerMin * 4) {
        const key = `${code}:exit`;
        if ((_anomalyAlerted.get(key) || 0) <= now - 30 * 60000) {
          _anomalyAlerted.set(key, now);
          for (const uid of holders) {
            try {
              const al = { code, name: x.name || code, type: 'exit', price: x.price, message: `🚨 下車警示：${code} ${x.name} 突發爆量下殺 ${chg.toFixed(1)}%/分（現價 ${x.price}，量能 ${Math.round(valDelta / avgPerMin)} 倍均量）— 你持有此股，請立即檢視是否出場`, at: now };
              const aref = db.collection('users').doc(uid).collection('data').doc('alerts');
              const prev = (await aref.get()).data()?.alerts || [];
              await aref.set({ updatedAt: now, alerts: [al, ...prev].slice(0, 40) });
              pushAlerts(uid, [al]).catch(() => {});
              log(`  🚨 ${uid} ${al.message.slice(0, 60)}`);
            } catch { /* per-user skip */ }
          }
        }
        continue; // 已發下車警示，不重複一般異常警報
      }
    }
    if (Math.abs(chg) < 2) continue;
    const dir = chg > 0 ? 'up' : 'down';
    const key = `${code}:${dir}`;
    if ((_anomalyAlerted.get(key) || 0) > now - 30 * 60000) continue; // 30 分鐘節流
    _anomalyAlerted.set(key, now);
    // 找出關注此股的用戶
    const usersSnap = await db.collection('users').get();
    for (const u of usersSnap.docs) {
      if (!['premium', 'admin', 'superadmin'].includes((u.data().level) || 'registered')) continue;
      const uid = u.id;
      try {
        const hd = (await db.collection('users').doc(uid).collection('data').doc('holdings').get()).data();
        const wd = (await db.collection('users').doc(uid).collection('data').doc('watchlist').get()).data();
        const mine = new Set([...(hd?.holdings || []).map(h => h.code), ...(wd?.watchlist || []).map(w => w.code)]);
        if (!mine.has(code)) continue;
        const al = { code, name: x.name || code, type: 'anomaly', price: x.price, message: `⚡ ${code} ${x.name} 一分鐘${dir === 'up' ? '急拉' : '急殺'} ${chg > 0 ? '+' : ''}${chg.toFixed(1)}%（現價 ${x.price}）— 留意突發消息或大單`, at: now };
        const aref = db.collection('users').doc(uid).collection('data').doc('alerts');
        const prev = (await aref.get()).data()?.alerts || [];
        await aref.set({ updatedAt: now, alerts: [al, ...prev].slice(0, 40) });
        pushAlerts(uid, [al]).catch(() => {});
        log(`  🔔 ${uid} ${al.message.slice(0, 60)}`);
      } catch { /* per-user skip */ }
    }
  }
}

// ── 41) 當沖比率出貨警示（>40% 隔日賣壓）───────────────────────
const _dtAlerted = new Set(); let _dtDay = '';
async function computeDayTradeRatio() {
  const tw = taipei();
  let rows = [];
  try {
    const r = await fetch(`https://www.twse.com.tw/rwd/zh/dayTrading/TWTB4U?date=${ymd8(tw)}&selectType=All&response=json`, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.twse.com.tw/' } });
    if (r.ok) { const j = await r.json();
      // 回音驗證：當沖比率是「撿尾盤」濾網的輸入，拿到別天的等於用錯濾網
      if (String(j?.date || '') !== ymd8(tw)) log(`  ⚠ TWTB4U 回音 ${j?.date} ≠ 期望 ${ymd8(tw)}，略過`);
      else { const tb = j.tables ? j.tables.find(t => (t.data || []).length > 10) : j; rows = tb?.data || j.data || []; } }
  } catch { /* skip */ }
  if (!rows.length) return;
  const csv = await fetchCloseCsvFull(); const volOf = {}; for (const c of csv) volOf[c.code] = c.vol;
  const items = [];
  for (const r of rows) {
    const code = (r[0] || '').trim(); if (!/^\d{4}$/.test(code)) continue;
    const dt = _i(r[3]); const vol = volOf[code] || 0;
    if (dt > 0 && vol > 0) items.push({ code, name: (r[1] || '').trim(), ratio: +((dt / vol) * 100).toFixed(1) });
  }
  if (!items.length) return;
  const high = items.filter(x => x.ratio >= 40).sort((a, b) => b.ratio - a.ratio);
  await db.collection('dayTradeRatio').doc('latest').set({ updatedAt: Date.now(), date: isoDate(tw), count: items.length, high: high.slice(0, 50) });
  log(`✓ 當沖比率：${items.length} 檔，高當沖(≥40%) ${high.length} 檔`);
  // 持股/自選高當沖警報
  const today = isoDate(tw);
  if (_dtDay !== today) { _dtAlerted.clear(); _dtDay = today; }
  const highSet = new Map(high.map(x => [x.code, x.ratio]));
  const usersSnap = await db.collection('users').get();
  for (const u of usersSnap.docs) {
    if (!['premium', 'admin', 'superadmin'].includes((u.data().level) || 'registered')) continue;
    const uid = u.id;
    try {
      const hd = (await db.collection('users').doc(uid).collection('data').doc('holdings').get()).data();
      const wd = (await db.collection('users').doc(uid).collection('data').doc('watchlist').get()).data();
      const mine = [...(hd?.holdings || []).map(h => ({ code: h.code, name: h.name })), ...(wd?.watchlist || []).map(w => ({ code: w.code, name: w.name }))];
      const newAlerts = [];
      for (const m of mine) {
        const ratio = highSet.get(m.code); if (!ratio) continue;
        const key = `${uid}:${m.code}`; if (_dtAlerted.has(key)) continue; _dtAlerted.add(key);
        newAlerts.push({ code: m.code, name: m.name, type: 'daytrade', message: `🌀 ${m.code} ${m.name} 今日當沖比率 ${ratio}%（≥40%）— 隔日沖賣壓風險，次日開盤留意`, at: Date.now() });
      }
      if (newAlerts.length) {
        const aref = db.collection('users').doc(uid).collection('data').doc('alerts');
        const prev = (await aref.get()).data()?.alerts || [];
        await aref.set({ updatedAt: Date.now(), alerts: [...newAlerts, ...prev].slice(0, 40) });
        pushAlerts(uid, newAlerts).catch(() => {});
      }
    } catch { /* per-user skip */ }
  }
}

// ── 42) ETF 折溢價監控（官方 all_etf 淨值 vs 市價）──────────────
const _etfAlerted = new Set(); let _etfDay = '';
async function computeEtfPremium() {
  let j = null;
  try { const r = await fetch('https://mis.twse.com.tw/stock/data/all_etf.txt', { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://mis.twse.com.tw/' } }); if (r.ok) j = await r.json(); } catch { /* skip */ }
  if (!j?.a1) return;
  const items = [];
  for (const g of j.a1) for (const m of (g.msgArray || [])) {
    const nav = _f(m.e), price = _f(m.f);
    if (!(nav > 0 && price > 0)) continue;
    items.push({ code: m.a, name: (m.b || '').slice(0, 14), nav, price, premium: +(((price - nav) / nav) * 100).toFixed(2) });
  }
  if (!items.length) return;
  const sorted = [...items].sort((a, b) => b.premium - a.premium);
  await db.collection('etfPremium').doc('latest').set({ updatedAt: Date.now(), date: isoDate(taipei()), count: items.length, premiumTop: sorted.slice(0, 10), discountTop: sorted.slice(-10).reverse() });
  log(`✓ ETF 折溢價：${items.length} 檔，最高溢價 ${sorted[0]?.code} ${sorted[0]?.premium}%`);
  // 持股/自選 ETF 偏離 ≥1% 警報
  const today = isoDate(taipei());
  if (_etfDay !== today) { _etfAlerted.clear(); _etfDay = today; }
  const devMap = new Map(items.filter(x => Math.abs(x.premium) >= 1).map(x => [x.code, x]));
  const usersSnap = await db.collection('users').get();
  for (const u of usersSnap.docs) {
    if (!['premium', 'admin', 'superadmin'].includes((u.data().level) || 'registered')) continue;
    const uid = u.id;
    try {
      const hd = (await db.collection('users').doc(uid).collection('data').doc('holdings').get()).data();
      const wd = (await db.collection('users').doc(uid).collection('data').doc('watchlist').get()).data();
      const mine = new Set([...(hd?.holdings || []).map(h => h.code), ...(wd?.watchlist || []).map(w => w.code)]);
      const newAlerts = [];
      for (const code of mine) {
        const x = devMap.get(code); if (!x) continue;
        const key = `${uid}:${code}`; if (_etfAlerted.has(key)) continue; _etfAlerted.add(key);
        newAlerts.push({ code, name: x.name, type: 'etfprem', price: x.price, message: `💠 ${code} ${x.name} ${x.premium > 0 ? '溢價' : '折價'} ${Math.abs(x.premium)}%（市價 ${x.price} / 淨值 ${x.nav}）— ${x.premium > 0 ? '買進成本偏貴，留意回歸' : '低於淨值，可留意布局'}`, at: Date.now() });
      }
      if (newAlerts.length) {
        const aref = db.collection('users').doc(uid).collection('data').doc('alerts');
        const prev = (await aref.get()).data()?.alerts || [];
        await aref.set({ updatedAt: Date.now(), alerts: [...newAlerts, ...prev].slice(0, 40) });
        pushAlerts(uid, newAlerts).catch(() => {});
      }
    } catch { /* per-user skip */ }
  }
}

// ── 43) ETF 定期定額提示（大盤回檔＝本月扣款好時機）─────────────
const _dcaHinted = {};
async function hintDca() {
  const h = (await db.collection('marketHealth').doc('latest').get()).data();
  if (!h || h.health >= 45) return; // 僅在大盤轉弱(回檔)時提示
  const ym = isoDate(taipei()).slice(0, 7);
  const usersSnap = await db.collection('users').get();
  for (const u of usersSnap.docs) {
    if (!['premium', 'admin', 'superadmin'].includes((u.data().level) || 'registered')) continue;
    const uid = u.id;
    if (_dcaHinted[uid] === ym) continue;
    try {
      const hd = (await db.collection('users').doc(uid).collection('data').doc('holdings').get()).data();
      const wd = (await db.collection('users').doc(uid).collection('data').doc('watchlist').get()).data();
      const etfs = [...(hd?.holdings || []).map(h2 => h2.code), ...(wd?.watchlist || []).map(w => w.code)].filter(c => /^00\d{2,4}$/.test(c));
      if (!etfs.length) continue;
      _dcaHinted[uid] = ym;
      const al = { code: etfs[0], name: 'ETF', type: 'dca', message: `📥 大盤健康度 ${h.health}/100（${h.mood}）回檔中 — 本月 ETF 定期定額可考慮於近日扣款（你追蹤：${etfs.slice(0, 4).join('、')}）`, at: Date.now() };
      const aref = db.collection('users').doc(uid).collection('data').doc('alerts');
      const prev = (await aref.get()).data()?.alerts || [];
      await aref.set({ updatedAt: Date.now(), alerts: [al, ...prev].slice(0, 40) });
      pushAlerts(uid, [al]).catch(() => {});
      log(`  🔔 ${uid} DCA 提示`);
    } catch { /* per-user skip */ }
  }
}

// ════════════════════════════════════════════════════════════
// 技能批次6：ADR 溢價 / 崩盤防禦 / 投組壓力測試 / 自訂策略回測
// ════════════════════════════════════════════════════════════

// Yahoo 日線 helper（回測/beta 用；stockHistory 僅覆蓋部分個股）
async function fetchYahooDaily(sym, range = '1y') {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 10000);
  try {
    const j = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=${range}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctl.signal }).then(r => r.json()).finally(() => clearTimeout(tm));
    const res = j?.chart?.result?.[0]; if (!res) return null;
    const ts = res.timestamp || []; const qd = res.indicators?.quote?.[0] || {};
    const bars = [];
    // OHLC 完整性防護(借鏡 Vibe-Trading)：收盤無效即丟；high/low 夾到 max/min 使自洽
    for (let i = 0; i < ts.length; i++) {
      const c = qd.close?.[i]; if (!(c > 0)) continue;
      const o = qd.open?.[i] > 0 ? qd.open[i] : c, lo = qd.low?.[i] > 0 ? qd.low[i] : c, hi = qd.high?.[i] > 0 ? qd.high[i] : c;
      bars.push({ t: ts[i], o, h: Math.max(hi, o, c, lo), l: Math.min(lo, o, c, hi), c, v: qd.volume?.[i] ?? 0 });
    }
    return bars.length ? bars : null;
  } catch { return null; }
}
const _ySym = (code, market) => `${code}.${market === 'otc' ? 'TWO' : 'TW'}`;

// ── 45) ADR 溢價監控（台股開盤先行指標）────────────────────────
const ADR_PAIRS = [
  { adr: 'TSM', code: '2330', name: '台積電', ratio: 5 },
  { adr: 'UMC', code: '2303', name: '聯電', ratio: 5 },
  { adr: 'CHT', code: '2412', name: '中華電', ratio: 10 },
];
const _adrAlerted = new Set(); let _adrDay = '';
async function computeAdrPremium() {
  const fxBars = await fetchYahooDaily('TWD=X', '5d'); const fx = fxBars?.[fxBars.length - 1]?.c;
  if (!(fx > 0)) return;
  const snap = await readSnapshotQuotes(); const q = snap?.quotes || {};
  const items = [];
  for (const p of ADR_PAIRS) {
    const bars = await fetchYahooDaily(p.adr, '5d'); const adr = bars?.[bars.length - 1]?.c;
    const tw = q[p.code]?.price;
    if (!(adr > 0) || !(tw > 0)) continue;
    const implied = +((adr * fx) / p.ratio).toFixed(2);
    items.push({ ...p, adrUsd: adr, fx, implied, twPrice: tw, premium: +(((implied - tw) / tw) * 100).toFixed(2) });
    await sleep(400);
  }
  if (!items.length) return;
  await db.collection('adrPremium').doc('latest').set({ updatedAt: Date.now(), fx, items });
  log(`✓ ADR 溢價：${items.map(x => `${x.code} ${x.premium > 0 ? '+' : ''}${x.premium}%`).join('、')}`);
  // |溢價|≥3% → 持股/自選警報（每日一次）
  const today = isoDate(taipei());
  if (_adrDay !== today) { _adrAlerted.clear(); _adrDay = today; }
  const big = items.filter(x => Math.abs(x.premium) >= 3);
  if (!big.length) return;
  const usersSnap = await db.collection('users').get();
  for (const u of usersSnap.docs) {
    if (!['premium', 'admin', 'superadmin'].includes((u.data().level) || 'registered')) continue;
    const uid = u.id;
    try {
      const hd = (await db.collection('users').doc(uid).collection('data').doc('holdings').get()).data();
      const wd = (await db.collection('users').doc(uid).collection('data').doc('watchlist').get()).data();
      const mine = new Set([...(hd?.holdings || []).map(h => h.code), ...(wd?.watchlist || []).map(w => w.code)]);
      const newAlerts = [];
      for (const x of big) {
        if (!mine.has(x.code)) continue;
        const key = `${uid}:${x.code}`; if (_adrAlerted.has(key)) continue; _adrAlerted.add(key);
        newAlerts.push({ code: x.code, name: x.name, type: 'adr', price: x.twPrice, message: `🌉 ${x.code} ${x.name} ADR ${x.premium > 0 ? '溢價' : '折價'} ${Math.abs(x.premium)}%（ADR 換算 ${x.implied} vs 現股 ${x.twPrice}）— ${x.premium > 0 ? '外資看多，開盤易高開' : '外資保守，留意開低'}`, at: Date.now() });
      }
      if (newAlerts.length) {
        const aref = db.collection('users').doc(uid).collection('data').doc('alerts');
        const prev = (await aref.get()).data()?.alerts || [];
        await aref.set({ updatedAt: Date.now(), alerts: [...newAlerts, ...prev].slice(0, 40) });
        pushAlerts(uid, newAlerts).catch(() => {});
      }
    } catch { /* per-user skip */ }
  }
}

// ── 46) 崩盤防禦模式（大跌日自動全持股防禦檢查）─────────────────
let _defenseDay = '';
async function checkCrashDefense() {
  const snap = await readSnapshotQuotes(); if (!snap?.marketOpen) return;
  const today = isoDate(taipei());
  if (_defenseDay === today) return; // 每日至多一次
  const q = snap.quotes;
  const chgs = Object.values(q).filter(x => /^\d{4}$/.test(x.code) && !x.code.startsWith('00') && x.price > 0).map(x => x.changePercent).sort((a, b) => a - b);
  if (chgs.length < 500) return;
  const median = chgs[Math.floor(chgs.length / 2)];
  const downRatio = chgs.filter(c => c < 0).length / chgs.length;
  if (!(median <= -2.5 || (downRatio >= 0.8 && median <= -1.5))) return;
  _defenseDay = today;
  log(`⚠ 崩盤防禦觸發：跌幅中位數 ${median.toFixed(2)}%、下跌比 ${(downRatio * 100).toFixed(0)}%`);
  const premium = await getPremiumUsers();
  for (const u of premium) {
    const uid = u.id;
    try {
      const hd = (await db.collection('users').doc(uid).collection('data').doc('holdings').get()).data();
      const byCode = {};
      for (const h of (hd?.holdings || [])) { const g = (byCode[h.code] ??= { qty: 0, cost: 0, name: h.name }); g.qty += h.quantity; g.cost += h.buyPrice * h.quantity; }
      const codes = Object.keys(byCode); if (!codes.length) continue;
      const pa = (await db.collection('users').doc(uid).collection('data').doc('portfolioAnalysis').get()).data()?.analyses || {};
      const items = codes.map(code => {
        const g = byCode[code]; const avg = g.qty ? g.cost / g.qty : 0;
        const price = q[code]?.price ?? 0; const chg = q[code]?.changePercent ?? 0;
        const stop = +Math.max(pa[code]?.stopLoss > 0 ? pa[code].stopLoss : 0, avg * 0.92).toFixed(2);
        const distToStop = price > 0 ? +(((price - stop) / price) * 100).toFixed(1) : null;
        return { code, name: g.name, price, todayPct: chg, pnlPct: avg > 0 && price > 0 ? +(((price - avg) / avg) * 100).toFixed(1) : null, stop, distToStop, risk: distToStop != null && distToStop <= 3 ? 'high' : distToStop != null && distToStop <= 8 ? 'mid' : 'low' };
      }).sort((a, b) => (a.distToStop ?? 99) - (b.distToStop ?? 99));
      const highN = items.filter(i => i.risk === 'high').length;
      const lines = [`# ${today} 崩盤防禦檢查`, `> 大盤急跌（跌幅中位 ${median.toFixed(1)}%、${(downRatio * 100).toFixed(0)}% 個股下跌）自動觸發`, ''];
      for (const i of items) lines.push(`- ${i.risk === 'high' ? '🔴' : i.risk === 'mid' ? '🟡' : '🟢'} ${i.code} ${i.name}：今日 ${i.todayPct >= 0 ? '+' : ''}${i.todayPct}%、損益 ${i.pnlPct != null ? (i.pnlPct >= 0 ? '+' : '') + i.pnlPct : '?'}%、距停損 ${i.distToStop ?? '?'}%（停損 ${i.stop}）`);
      lines.push('', '**建議動作**：🔴 距停損 ≤3% 者優先決策（執行停損或掛好停損單）；避免恐慌性全砍，依計畫執行。', '', '> 程式自動彙整，非投資建議。');
      await db.collection('users').doc(uid).collection('data').doc('defenseReport').set({ at: Date.now(), date: today, median: +median.toFixed(2), downRatio: +(downRatio * 100).toFixed(0), content: lines.join('\n'), highRisk: highN });
      const al = { code: items[0]?.code || '', name: '防禦模式', type: 'defense', message: `🛡 大盤急跌（中位 ${median.toFixed(1)}%）— 防禦檢查完成：${items.length} 檔持股，${highN} 檔逼近停損（🔴），請開投組頁查看防禦清單`, at: Date.now() };
      const aref = db.collection('users').doc(uid).collection('data').doc('alerts');
      const prev = (await aref.get()).data()?.alerts || [];
      await aref.set({ updatedAt: Date.now(), alerts: [al, ...prev].slice(0, 40) });
      pushAlerts(uid, [al]).catch(() => {});
      log(`  🛡 ${uid} 防禦清單 ${items.length} 檔（高風險 ${highN}）`);
    } catch (e) { log('  ✖ defense', uid, e.message); }
  }
}

// ── 47) 投組壓力測試（beta：大盤 -10% 時你的組合估計 -X%）───────
async function computeStressTest() {
  await sleep(3000); // 與前一技能的 Yahoo 連續請求隔開，避免限流
  let mBars = await fetchYahooDaily('^TWII', '6mo');
  if (!mBars || mBars.length < 40) { await sleep(5000); mBars = await fetchYahooDaily('^TWII', '6mo'); }
  if (!mBars || mBars.length < 40) { log('✖ 壓測：^TWII 歷史取得失敗（Yahoo 限流？下輪再試）'); return; }
  const mRet = []; for (let i = 1; i < mBars.length; i++) if (mBars[i - 1].c > 0) mRet.push({ t: mBars[i].t, r: (mBars[i].c - mBars[i - 1].c) / mBars[i - 1].c });
  const mByT = new Map(mRet.map(x => [x.t, x.r]));
  const snap = await readSnapshotQuotes(); const q = snap?.quotes || {};
  const _betaCache = {};
  const betaOf = async (code) => {
    if (_betaCache[code] !== undefined) return _betaCache[code];
    // 一律用 Yahoo：與 ^TWII 時間戳保證對齊（stockHistory 的 t 格式不同會導致配對失敗）
    const bars = await fetchYahooDaily(_ySym(code, q[code]?.market), '6mo'); await sleep(500);
    if (!bars || bars.length < 40) return (_betaCache[code] = null);
    const pairs = [];
    for (let i = 1; i < bars.length; i++) { const mr = mByT.get(bars[i].t); if (mr != null && bars[i - 1].c > 0) pairs.push([(bars[i].c - bars[i - 1].c) / bars[i - 1].c, mr]); }
    if (pairs.length < 30) return (_betaCache[code] = null);
    const mx = pairs.reduce((s, p) => s + p[1], 0) / pairs.length, sx = pairs.reduce((s, p) => s + p[0], 0) / pairs.length;
    let cov = 0, varm = 0;
    for (const [rs, rm] of pairs) { cov += (rs - sx) * (rm - mx); varm += (rm - mx) ** 2; }
    return (_betaCache[code] = varm > 0 ? +(cov / varm).toFixed(2) : null);
  };
  const premium = await getPremiumUsers();
  for (const u of premium) {
    const uid = u.id;
    try {
      const hd = (await db.collection('users').doc(uid).collection('data').doc('holdings').get()).data();
      const byCode = {};
      for (const h of (hd?.holdings || [])) { const g = (byCode[h.code] ??= { qty: 0, name: h.name }); g.qty += h.quantity; }
      const codes = Object.keys(byCode); if (!codes.length) continue;
      let tot = 0; const ws = {};
      for (const c of codes) { const mv = (q[c]?.price ?? 0) * byCode[c].qty; ws[c] = mv; tot += mv; }
      if (!(tot > 0)) continue;
      const betas = {}; let betaP = 0, covered = 0;
      for (const c of codes) { const b = await betaOf(c); if (b != null) { betas[c] = b; betaP += (ws[c] / tot) * b; covered += ws[c]; } }
      if (!(covered > 0)) { log(`  ✖ 壓測 ${uid}：全部持股 β 計算失敗`); continue; }
      betaP = +(betaP * (tot / covered)).toFixed(2); // 按覆蓋權重歸一
      const stress = { m5: +(-5 * betaP).toFixed(1), m10: +(-10 * betaP).toFixed(1), m20: +(-20 * betaP).toFixed(1) };
      await db.collection('users').doc(uid).collection('data').doc('portfolioRisk').set({ betaPortfolio: betaP, stress, betas, stressAt: Date.now() }, { merge: true });
      log(`  ✓ 壓測 ${uid} β=${betaP}（大盤-10% → 約 ${stress.m10}%）`);
    } catch (e) { log('  ✖ stress', uid, e.message); }
  }
}

// ── 48) 自訂策略回測器（使用者定義進出場規則 → 歷史勝率）─────────
const _smaAt = (arr, n, i) => { if (i + 1 < n) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += arr[k]; return s / n; };
function _rsi14(closes, i) {
  if (i < 14) return null; let g = 0, l = 0;
  for (let k = i - 13; k <= i; k++) { const d = closes[k] - closes[k - 1]; if (d > 0) g += d; else l -= d; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function runStrategyOnBars(bars, params) {
  const closes = bars.map(b => b.c);
  const trades = [];
  let pos = null;
  for (let i = 25; i < bars.length; i++) {
    if (pos) {
      const ret = (closes[i] - pos.entry) / pos.entry * 100;
      const days = i - pos.i;
      let exit = null;
      if (ret <= -params.exit.stopPct) exit = '停損';
      else if (ret >= params.exit.targetPct) exit = '停利';
      else if (params.exit.maExit && closes[i] < (_smaAt(closes, 20, i) ?? 0)) exit = '跌破MA20';
      else if (days >= params.exit.maxDays) exit = '到期';
      if (exit) { trades.push({ entryT: pos.t, exitT: bars[i].t, ret: +ret.toFixed(2), days, reason: exit }); pos = null; }
      continue;
    }
    let signal = false;
    const e = params.entry;
    const prevC = closes[i - 1];
    if (e.type === 'breakoutN') { let hi = 0; for (let k = i - e.n; k < i; k++) hi = Math.max(hi, bars[k].h); signal = closes[i] > hi && hi > 0; }
    else if (e.type === 'maCross') { const f0 = _smaAt(closes, 5, i - 1), s0 = _smaAt(closes, 20, i - 1), f1 = _smaAt(closes, 5, i), s1 = _smaAt(closes, 20, i); signal = f0 != null && s0 != null && f0 <= s0 && f1 > s1; }
    else if (e.type === 'rsiOversold') { const r0 = _rsi14(closes, i - 1), r1 = _rsi14(closes, i); signal = r0 != null && r0 < 30 && r1 >= 30; }
    else if (e.type === 'volBreak') { let av = 0, n = 0; for (let k = Math.max(1, i - 20); k < i; k++) { av += bars[k].v; n++; } av = n ? av / n : 0; signal = av > 0 && bars[i].v >= av * 3 && closes[i] > closes[i - 1] * 1.02; }
    else if (e.type === 'limitLock') { // 漲停且收盤鎖死（收=最高）
      const ch = closes[i] - prevC;
      if (prevC > 0 && ch > 0) { const raw = prevC * 1.1; const tk = raw < 10 ? 0.01 : raw < 50 ? 0.05 : raw < 100 ? 0.1 : raw < 500 ? 0.5 : raw < 1000 ? 1 : 5; const lim = Math.floor(raw / tk + 1e-9) * tk; signal = closes[i] >= lim - 1e-6 && closes[i] >= bars[i].h - 1e-6; }
    }
    else if (e.type === 'gapUp') { signal = bars[i].o >= prevC * 1.02 && closes[i] > bars[i].o && closes[i] > prevC; } // 跳空2%不回補且收紅
    else if (e.type === 'ma5Bounce') { const m5 = _smaAt(closes, 5, i), m20 = _smaAt(closes, 20, i); signal = m5 != null && m20 != null && closes[i] > m20 && bars[i].l <= m5 * 1.005 && closes[i] > m5 && closes[i] > prevC; } // 多頭回踩5日線收復
    else if (e.type === 'hammer') { const rng = bars[i].h - bars[i].l; const posn = rng > 0 ? (closes[i] - bars[i].l) / rng : 0; signal = prevC > 0 && rng / prevC >= 0.04 && posn >= 0.7 && bars[i].l < prevC * 0.99 && closes[i] > prevC; } // 長下影反轉(殺低收高)
    else if (e.type === 'secondBar') { // 連漲第2根K且今日強漲(使用者提出)：昨首漲、前日未漲、今日≥2%
      signal = i >= 3 && closes[i - 1] > closes[i - 2] && closes[i - 2] <= closes[i - 3] && prevC > 0 && (closes[i] - prevC) / prevC >= 0.02;
    }
    else if (e.type === 'dipLimit') { // 跌深反轉首停(使用者提出)：60日高回檔≥15%後的第一根漲停
      const isLimAt = (c, pv) => { if (!(pv > 0) || c <= pv) return false; const raw = pv * 1.1; const t = raw < 10 ? 0.01 : raw < 50 ? 0.05 : raw < 100 ? 0.1 : raw < 500 ? 0.5 : raw < 1000 ? 1 : 5; return c >= Math.floor(raw / t + 1e-9) * t - 1e-6; };
      if (i >= 3 && isLimAt(closes[i], prevC) && !isLimAt(closes[i - 1], closes[i - 2])) {
        let hi = 0; for (let k = Math.max(0, i - 60); k < i; k++) hi = Math.max(hi, bars[k].h);
        signal = hi > 0 && prevC <= hi * 0.85; // 昨收仍在高點 -15% 之下 = 深跌後首停
      }
    }
    if (signal) pos = { entry: closes[i], i, t: bars[i].t };
  }
  return trades;
}
const _btBarsCache = new Map();
async function runCustomBacktests() {
  const premium = await getPremiumUsers();
  for (const u of premium) {
    const uid = u.id;
    const ref = db.collection('users').doc(uid).collection('data').doc('customBacktest');
    const d = (await ref.get()).data();
    if (!d || d.status !== 'pending' || !d.params) continue;
    try {
      log(`▶ 自訂回測 ${uid}：${JSON.stringify(d.params).slice(0, 120)}`);
      const snap = await readSnapshotQuotes(); const q = snap?.quotes || {};
      let codes = [];
      if (d.params.universe === 'watchlist') {
        const wd = (await db.collection('users').doc(uid).collection('data').doc('watchlist').get()).data();
        codes = (wd?.watchlist || []).map(w => w.code);
      } else {
        codes = Object.values(q).filter(x => /^\d{4}$/.test(x.code) && !x.code.startsWith('00') && x.value > 0).sort((a, b) => b.value - a.value).slice(0, 100).map(x => x.code);
      }
      codes = codes.filter(c => /^\d{4}$/.test(c)).slice(0, 100);
      const allTrades = []; let covered = 0;
      for (const code of codes) {
        let bars = _btBarsCache.get(code);
        if (!bars) {
          bars = await fetchYahooDaily(_ySym(code, q[code]?.market), '1y');
          if (bars) _btBarsCache.set(code, bars);
          await sleep(350);
        }
        if (!bars || bars.length < 60) continue;
        covered++;
        for (const t of runStrategyOnBars(bars, d.params)) allTrades.push({ ...t, code, name: q[code]?.name || code });
      }
      if (_btBarsCache.size > 300) _btBarsCache.clear();
      const rets = allTrades.map(t => t.ret);
      const wins = rets.filter(r => r > 0);
      const result = {
        universe: covered, trades: allTrades.length,
        winRate: rets.length ? Math.round(wins.length / rets.length * 100) : 0,
        avgRet: rets.length ? +(rets.reduce((s, r) => s + r, 0) / rets.length).toFixed(2) : 0,
        profitFactor: (() => { const wsum = wins.reduce((s, r) => s + r, 0); const lsum = Math.abs(rets.filter(r => r <= 0).reduce((s, r) => s + r, 0)); return lsum > 0 ? +(wsum / lsum).toFixed(2) : null; })(),
        avgDays: rets.length ? +(allTrades.reduce((s, t) => s + t.days, 0) / allTrades.length).toFixed(1) : 0,
        exitDist: allTrades.reduce((m, t) => (m[t.reason] = (m[t.reason] || 0) + 1, m), {}),
        best: [...allTrades].sort((a, b) => b.ret - a.ret).slice(0, 5),
        worst: [...allTrades].sort((a, b) => a.ret - b.ret).slice(0, 5),
      };
      await ref.set({ status: 'done', finishedAt: Date.now(), result }, { merge: true });
      log(`✓ 自訂回測 ${uid}：${covered} 檔 ${allTrades.length} 筆，勝率 ${result.winRate}%`);
    } catch (e) {
      await ref.set({ status: 'error', error: String(e.message || e).slice(0, 200) }, { merge: true }).catch(() => {});
      log('✖ 自訂回測', uid, e.message);
    }
  }
}

// ── 49) 策略選股（實測驗證的隔日沖策略 → 每日候選清單）─────────
// 回測依據：近一年前100大個股、訊號日收盤買→次日收盤賣（見 git 8101183）。
const STRATEGY_STATS = {
  limitLock: { name: '漲停鎖死', icon: '🥇', winRate: 61, avgRet: 2.38, pf: 2.81, principle: '漲停鎖死＝當日需求未被滿足，未成交買單隔日開盤慣性追價', note: '掛得到就是賺到；連3停以上不追、開盤打開弱勢即棄', regimeBoost: { bull: '大盤MA20之上時 64%／+2.66%／PF3.07（全系統最強）', bear: '大盤MA20之下時優勢下降，建議減量或觀望' } },
  gapUp: { name: '跳空缺口續勢', icon: '🥈', winRate: 57, avgRet: 1.49, pf: 2.12, principle: '跳空≥2%整天不回補且收紅＝隔夜新資訊+賣壓消化完，隔日早盤慣性延續', note: '最可執行的主力策略；隔日 9:00-10:00 出場。⚡標記=量≥2倍(條件版 61%／+1.89%)' },
  volBreak: { name: '爆量突破', icon: '🥉', winRate: 55, avgRet: 1.42, pf: 2.02, principle: '3倍量+漲2%＝大資金進場日，動能未在收盤消失', note: '量比暫以昨日量近似（歷史均量累積中）' },
  secondBar: { name: '連漲第2根K（動能日）', icon: '🆕', winRate: 54, avgRet: 1.24, pf: 1.97, principle: '昨日首度收紅、今日續漲≥2%＝趨勢啟動第2天，動能尚未透支', note: '2026年4月起顯著轉強：4月63%/5月64%/6月58%、平均+2%↑；3月修正期曾失效——大盤健康度<45時降低部位', recent: { label: '近3月(4-6月)', winRate: 62, avgRet: 2.1 } },
  dipLimit: { name: '跌深反轉首停', icon: '🔄', winRate: 58, avgRet: 1.82, pf: 2.2, principle: '60日高點回檔≥15%後的第一根漲停＝空方力竭+新買盤進場，反轉初期動能未透支', note: '284筆實測；僅第一根（昨日已漲停不算），續高準備位' },
  chip: { name: '外資投信同日買', icon: '🏦', winRate: 57, avgRet: 1.16, pf: 2.04, principle: '外資(≥1000張)與投信(≥100張)同日買超＝資訊面+資金面雙重共識，隔日慣性延續', note: '83個交易日籌碼歷史實測；法人資料約16:30公布，清單於16:30後更新（15:10版為空）' },
};
async function computeStrategyPicks() {
  const rows = [];
  const tseCsv = await fetchCloseCsvFull();
  for (const r of tseCsv) rows.push({ ...r, market: 'tse' });
  // 上櫃檔必須與上市 CSV 同資料日（TPEx openapi 無日期參數·15:10 常仍昨日檔）：
  // 不合致則本輪僅上市，16:45 補跑自然補上——寧缺勿錯日混併。
  const otcArr = tseCsv.dataDate ? await fetchTpexDailyCloseValidated(tseCsv.dataDate) : null;
  if (otcArr) {
    for (const x of otcArr) { const code = x.SecuritiesCompanyCode || ''; if (/^\d{4}$/.test(code)) rows.push({ code, name: x.CompanyName || code, market: 'otc', vol: _num(x.TradingShares), value: _num(x.TransactionAmount), open: _num(x.Open), high: _num(x.High), low: _num(x.Low), close: _num(x.Close), change: _num(String(x.Change || '').trim()) }); }
  } else log('  ⚠ strategyPicks：上櫃檔與上市資料日不合致，本輪僅上市（16:45 補跑）');
  if (rows.length < 500) return;
  const tickOf = p => (p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5);
  const isLim = (c, ch) => { const pv = c - ch; if (!(pv > 0) || ch <= 0) return false; const raw = pv * 1.1; const t = tickOf(raw); return c >= Math.floor(raw / t + 1e-9) * t - 1e-6; };
  const prev = (await db.collection('strategyPicks').doc('latest').get()).data();
  const sameDay = prev?.date === isoDate(taipei());
  const prevLockStreak = Object.fromEntries(((sameDay ? prev?.prevLock : prev?.groups?.limitLock) || []).map(x => [x.code, x.streak || 1]));
  const rating = (await getJSON('/api/rating'))?.ratings || {};
  const dtHigh = new Set((((await db.collection('dayTradeRatio').doc('latest').get()).data())?.high || []).map(x => x.code));
  const enrich = r => { const pc = r.close - r.change; return { code: r.code, name: r.name, market: r.market, price: r.close, changePct: pc > 0 ? +((r.change / pc) * 100).toFixed(2) : 0, score: rating[r.code]?.score ?? null, signal: rating[r.code]?.signal ?? null, dtHigh: dtHigh.has(r.code) }; };
  // 歷史來源改用籌碼歸檔 chipArchive（已回填 83 日）：昨量、近 3 日收盤、法人皆取自此。
  // 資料日 = 今日 CSV 的交易日；arch[0] 應與其同日（同日已歸檔）或為前一交易日。
  const archSnap = await db.collection('chipArchive').orderBy('date', 'desc').limit(61).get(); // 61天：昨量/近3日收盤+60日收盤高點(跌深反轉用)
  const arch = archSnap.docs.map(x => x.data());
  const dataDate = arch[0]?.date; // 最新歸檔日（收盤後=今日；盤前/假日=最近交易日）
  const offset = 0; // arch[0]=資料日 → 昨=arch[1]
  const parseClose = i => (arch[i + offset]?.closeJson ? JSON.parse(arch[i + offset].closeJson) : null);
  const cToday = parseClose(0), cY = parseClose(1), cD = parseClose(2), cB = parseClose(3);
  const prevVol = {}; if (cY) for (const c in cY) prevVol[c] = (cY[c][1] || 0) * 1000; // 張→股
  const h0 = cY ? Object.fromEntries(Object.entries(cY).map(([k, v]) => [k, v[0]])) : null;   // 昨收
  const h1 = cD ? Object.fromEntries(Object.entries(cD).map(([k, v]) => [k, v[0]])) : null;   // 前日收
  const h2 = cB ? Object.fromEntries(Object.entries(cB).map(([k, v]) => [k, v[0]])) : null;   // 大前日收
  void cToday; void dataDate;
  const g = { limitLock: [], gapUp: [], volBreak: [], secondBar: [], dipLimit: [], chip: [] };
  // 60 日收盤高點（跌深反轉首停用；歸檔僅收盤價，以收盤高點近似）
  const max60 = {};
  for (let ai = 1; ai < Math.min(arch.length, 61); ai++) {
    const cj = arch[ai]?.closeJson ? JSON.parse(arch[ai].closeJson) : null; if (!cj) continue;
    for (const c in cj) { const v = cj[c][0]; if (v > (max60[c] || 0)) max60[c] = v; }
  }
  // 外資投信同日買：取「最新歸檔日」法人（假日/盤前=最近交易日，修正原先讀今日造成的空清單）
  const instToday = arch[0]?.instJson ? JSON.parse(arch[0].instJson) : null;
  for (const r of rows) {
    if (!(r.close > 0) || r.code.startsWith('00')) continue;
    const prevC = r.close - r.change;
    if (isLim(r.close, r.change) && r.close >= r.high - 1e-6) g.limitLock.push({ ...enrich(r), streak: (prevLockStreak[r.code] || 0) + 1 });
    if (prevC > 0 && r.open >= prevC * 1.02 && r.low > prevC && r.close > r.open) { const pv2 = prevVol[r.code]; g.gapUp.push({ ...enrich(r), volX: pv2 > 0 ? +(r.vol / pv2).toFixed(1) : null }); }
    const pv = prevVol[r.code];
    if (pv > 0 && r.vol >= pv * 3 && prevC > 0 && r.change / prevC >= 0.02 && r.change / prevC <= 0.085) g.volBreak.push(enrich(r));
    // 連漲第2根K：昨日首度收紅(前日未漲)、今日續漲≥2%
    if (h0 && h1 && h2 && prevC > 0 && r.change / prevC >= 0.02) {
      const [cY, cD, c3] = [h0[r.code], h1[r.code], h2[r.code]];
      if (cY > 0 && cD > 0 && c3 > 0 && cY > cD && cD <= c3) g.secondBar.push(enrich(r));
    }
    // 跌深反轉首停：今日漲停、昨日未漲停、昨收仍在 60 日收盤高點 -15% 之下
    if (h0 && h1 && isLim(r.close, r.change)) {
      const y = h0[r.code], d2v = h1[r.code];
      const yLim = y > 0 && d2v > 0 && isLim(y, y - d2v);
      if (!yLim && y > 0 && (max60[r.code] || 0) > 0 && y <= max60[r.code] * 0.85) g.dipLimit.push({ ...enrich(r), dd: +((1 - y / max60[r.code]) * 100).toFixed(0) });
    }
    // 外資投信同日買：外資 ≥1000 張且投信 ≥100 張
    if (instToday) {
      const [fi, ti] = instToday[r.code] || [0, 0];
      if (fi >= 1000 && ti >= 100) g.chip.push({ ...enrich(r), instF: fi, instT: ti });
    }
  }
  // 排序：AI 評分 + 四大法人加權(回測驗證·保守；評分 0-100，法人加權×1.5 → 約 ±15)
  const iwCtx = await getInstWeightCtx();
  const skey = x => (x.score ?? 0) + instWeight(x.code, iwCtx) * 1.5;
  for (const k in g) g[k].sort((a, b) => skey(b) - skey(a));
  g.limitLock = g.limitLock.slice(0, 60); g.gapUp = g.gapUp.slice(0, 30); g.volBreak = g.volBreak.slice(0, 30); g.secondBar = g.secondBar.slice(0, 30); g.dipLimit = g.dipLimit.slice(0, 30); g.chip = g.chip.slice(0, 30);
  // 大盤位置濾網（^TWII vs MA20）：漲停鎖死策略的勝率開關
  let regime = null;
  try {
    const mb = await fetchYahooDaily('^TWII', '3mo');
    if (mb && mb.length >= 21) {
      const ma20 = mb.slice(-20).reduce((s, x) => s + x.c, 0) / 20;
      regime = { index: +mb[mb.length - 1].c.toFixed(0), ma20: +ma20.toFixed(0), bull: mb[mb.length - 1].c > ma20 };
    }
  } catch { /* skip */ }
  await db.collection('strategyPicks').doc('latest').set({
    updatedAt: Date.now(), date: isoDate(taipei()), dataDate: dataDate || null, stats: STRATEGY_STATS, groups: g, regime,
    prevLock: sameDay ? (prev?.prevLock || []) : (prev?.groups?.limitLock || []),
  });
  log(`✓ 策略選股：鎖死 ${g.limitLock.length}、跳空 ${g.gapUp.length}、爆量 ${g.volBreak.length}、第2根K ${g.secondBar.length}、跌深首停 ${g.dipLimit.length}、法人 ${g.chip.length}`);
}

// ── 50) 新聞風向推測（開盤前 70 分：國際+台灣新聞 → 看漲/看跌族群）──
// 本地 LLM 做「定性」推測（族群名強制限定官方產業清單、理由需引用給定事實，
// 全程標示 AI 推測非事實）；LLM 失敗退回規則推估。數字仍零 AI 生成。
async function _newsTitles(query, n = 7) {
  try {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 8000);
    const t = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctl.signal }).then(r => r.text()).finally(() => clearTimeout(tm));
    return [...t.matchAll(/<title>([^<]+)<\/title>/g)].map(m => m[1]).filter(x => !x.includes('Google')).slice(0, n);
  } catch { return []; }
}
async function forecastSectors() {
  const date = isoDate(taipei());
  const g = (await db.collection('globalMarkets').doc('latest').get()).data() || {};
  const adr = (await db.collection('adrPremium').doc('latest').get()).data();
  const sec = (await db.collection('sectorRotation').doc('latest').get()).data()?.sectors || [];
  const pc = (await db.collection('peerComps').doc('latest').get()).data();
  const industries = pc?.summaryJson ? Object.keys(JSON.parse(pc.summaryJson)) : [];
  if (!industries.length) return;
  const twNews = await _newsTitles('台股', 7);
  const glNews = await _newsTitles('美股 半導體 科技', 7);
  const facts = [
    ...(g.markets || []).map(m => `${m.name} ${m.changePct > 0 ? '+' : ''}${m.changePct}%`),
    adr?.items?.length ? `台積電ADR溢價 ${adr.items[0].premium}%` : null,
    sec.length ? `昨日最強產業 ${sec[0].industry}(${sec[0].avgChangePct}%)、最弱 ${sec[sec.length - 1].industry}(${sec[sec.length - 1].avgChangePct}%)` : null,
  ].filter(Boolean);
  let bullish = [], bearish = [], model = OLLAMA_MODEL;
  try {
    const prompt = `你是台股盤前分析員。依下方事實與新聞標題，推測今日台股「看漲族群」與「看跌族群」各1-3個。族群名稱必須從此清單原樣選取：${industries.join('、')}。每個理由20字內且必須引用下方given的事實或新聞標題。只輸出 JSON（無其他文字）：{"bullish":[{"sector":"...","reason":"..."}],"bearish":[{"sector":"...","reason":"..."}]}${STRICT_RULE}\n【數據】${facts.join('；')}\n【台灣新聞】${twNews.join('｜')}\n【國際新聞】${glNews.join('｜')}`;
    const outStr = await askOllama(prompt, { priority: 9 });
    const m = (outStr || '').match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : {};
    const clean = a => (Array.isArray(a) ? a.filter(x => x && industries.includes(x.sector)).slice(0, 3).map(x => ({ sector: x.sector, reason: String(x.reason || '').slice(0, 40) })) : []);
    bullish = clean(j.bullish); bearish = clean(j.bearish);
  } catch { /* fallback */ }
  if (!bullish.length && !bearish.length) {
    model = 'rule-fallback';
    const sox = (g.markets || []).find(m => m.sym === '^SOX');
    if (sox?.changePct >= 1.5 && industries.includes('半導體業')) bullish.push({ sector: '半導體業', reason: `費半 +${sox.changePct}%` });
    if (sox?.changePct <= -1.5 && industries.includes('半導體業')) bearish.push({ sector: '半導體業', reason: `費半 ${sox.changePct}%` });
    if (sec[0]?.avgChangePct > 1 && industries.includes(sec[0].industry)) bullish.push({ sector: sec[0].industry, reason: '昨日最強，動能延續' });
    if (sec[sec.length - 1]?.avgChangePct < -1 && industries.includes(sec[sec.length - 1].industry)) bearish.push({ sector: sec[sec.length - 1].industry, reason: '昨日最弱' });
  }
  await db.collection('sectorForecast').doc('latest').set({ date, generatedAt: Date.now(), model, bullish, bearish, basis: { facts, twNews: twNews.slice(0, 4), glNews: glNews.slice(0, 4) }, disclaimer: 'AI 推測非事實，僅供盤前參考' });
  log(`✓ 風向推測(${model})：看漲 ${bullish.map(x => x.sector).join('/') || '—'}；看跌 ${bearish.map(x => x.sector).join('/') || '—'}`);
  // 持股比對 → forecastHits + 看跌持股推播
  const indOf = {}; if (pc?.industriesJson) { const ind = JSON.parse(pc.industriesJson); for (const k in ind) for (const s of ind[k]) indOf[s.code] = k; }
  const bull = new Set(bullish.map(x => x.sector)), bear = new Set(bearish.map(x => x.sector));
  const usersSnap = await db.collection('users').get();
  for (const u of usersSnap.docs) {
    if (!['premium', 'admin', 'superadmin'].includes((u.data().level) || 'registered')) continue;
    const uid = u.id;
    try {
      const hd = (await db.collection('users').doc(uid).collection('data').doc('holdings').get()).data();
      const seen = new Set(); const hits = [];
      for (const h of (hd?.holdings || [])) {
        if (seen.has(h.code)) continue; seen.add(h.code);
        const ind = indOf[h.code]; if (!ind) continue;
        if (bear.has(ind)) hits.push({ code: h.code, name: h.name, industry: ind, side: 'bear' });
        else if (bull.has(ind)) hits.push({ code: h.code, name: h.name, industry: ind, side: 'bull' });
      }
      await db.collection('users').doc(uid).collection('data').doc('forecastHits').set({ date, updatedAt: Date.now(), hits });
      const bearHits = hits.filter(x => x.side === 'bear');
      if (bearHits.length) {
        const al = { code: bearHits[0].code, name: '晨報風向', type: 'forecast', message: `📰 晨報風向：你的持股 ${bearHits.map(x => `${x.code} ${x.name}(${x.industry})`).join('、')} 屬今日 AI 看跌族群 — 開盤請留意（AI 推測非事實）`, at: Date.now() };
        const aref = db.collection('users').doc(uid).collection('data').doc('alerts');
        const prev = (await aref.get()).data()?.alerts || [];
        await aref.set({ updatedAt: Date.now(), alerts: [al, ...prev].slice(0, 40) });
        pushAlerts(uid, [al]).catch(() => {});
      }
    } catch { /* per-user skip */ }
  }
}

// ── 52) 籌碼歷史歸檔（每日法人/融資券/收盤 → chipArchive/{date}）────
// 讓投信作帳、外資連買、軋空等籌碼策略可誠實回測。16:30 歸檔法人+收盤、
// 21:45 補融資券（同 doc 合併）。格式：inst {code:[外資張,投信張]}、
// close {code:[收盤,量張]}、margin {code:[融資餘,融券餘]}。
// TPEx openapi 上櫃日收盤（⚠無日期參數）：回檔每列含 Date(民國)。期望日檔未發布時
// 會靜默回前一交易日——必須回聲驗證，否則跨日資料被併進同一文件
// （2026-07-22 揭發：15:10 歸檔時 TWSE 已出今日檔、TPEx 仍昨日檔 → 上櫃日K整段平移一日）。
async function fetchTpexDailyCloseValidated(expectYmd8) {
  try {
    const r = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const arr = await r.json();
    const roc = String(parseInt(expectYmd8.slice(0, 4), 10) - 1911) + expectYmd8.slice(4);
    if (!Array.isArray(arr) || !arr.length || String(arr[0]?.Date || '') !== roc) return null;
    return arr;
  } catch { return null; }
}

async function archiveChipDaily() {
  const tw = taipei(); if (!isTradingDay(tw)) return;
  const iso = isoDate(tw); const ymd = ymd8(tw);
  const J = async url => { try { const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 15000); const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.twse.com.tw/' }, signal: ctl.signal }).finally(() => clearTimeout(tm)); return r.ok ? await r.json() : null; } catch { return null; } };
  const ref = db.collection('chipArchive').doc(iso);
  const cur = (await ref.get()).data() || {};
  const patch = { date: iso, at: Date.now(), market: 'tse' };
  // 法人＝上市 T86 ＋ 上櫃 TPEx 合併（2026-07-20 修正：daemon 期原本只收上市，
  // 造成 02-26 起近五個月上櫃法人整段缺失——回測中上櫃股 tier 全空）。
  // 既有檔若只有上市（無上櫃碼）也補上櫃合併。
  const hasOtcInst = (() => { try { const m = cur.instJson ? JSON.parse(cur.instJson) : null; return m ? Object.keys(m).some(c => m[c] && ['6274', '8069', '3260', '5347', '3105'].includes(c)) : false; } catch { return false; } })();
  if (!cur.instJson || !hasOtcInst) {
    const inst = {};
    try { const m = cur.instJson ? JSON.parse(cur.instJson) : {}; Object.assign(inst, m); } catch { /* fresh */ }
    if (!cur.instJson) {
      const t86 = await J(`https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${ymd}&selectType=ALL`);
      if (t86?.stat === 'OK' && String(t86?.date || '') !== ymd) log(`  ⚠ 歸檔 T86 回音 ${t86?.date} ≠ ${ymd}，不併入`);
      else if (t86?.stat === 'OK') {
        const fI = (t86.fields || []).indexOf('外陸資買賣超股數(不含外資自營商)');
        const tI = (t86.fields || []).findIndex(f => f.startsWith('投信買賣超'));
        for (const r of (t86.data || [])) { const c = (r[0] || '').trim(); if (/^\d{4}$/.test(c)) inst[c] = [Math.round(_f(r[fI]) / 1000), Math.round(_f(r[tI]) / 1000)]; }
      }
      await sleep(1200);
    }
    const tp = await fetchTpexInst(ymd);
    for (const c in tp) if (!inst[c]) inst[c] = [tp[c].foreign, tp[c].trust];
    if (Object.keys(inst).length > 100) patch.instJson = JSON.stringify(inst);
    await sleep(1200);
  }
  {
    // ⚠ 日期正確性修正(2026-07-17)：STOCK_DAY_ALL 回的是「最近已完成交易日」——凌晨執行
    // 時是前一日收盤。原版以執行日戳記 → doc D 裝 D-1 收盤(整批偏移)。改以 CSV 自身的
    // 資料日(民國首欄)決定歸檔文件，與法人/融資(各自有官方日期參數)脫鉤。
    const rows = []; let closeYmd = '';
    try {
      const res = await fetch('https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=json', { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (res.ok) for (const line of (await res.text()).split('\n')) {
        const m = line.match(/"([^"]*)"/g); if (!m || m.length < 9) continue;
        const f = m.map(x => x.slice(1, -1));
        if (!closeYmd) closeYmd = rocToYmd(f[0]);
        const code = (f[1] || '').trim();
        if (/^\d{4}$/.test(code)) rows.push({ code, close: _num(f[8]), vol: _num(f[3]), open: _num(f[5]), high: _num(f[6]), low: _num(f[7]) });
      }
    } catch { /* skip */ }
    if (closeYmd && rows.length > 500) {
      const closeIso = `${closeYmd.slice(0, 4)}-${closeYmd.slice(4, 6)}-${closeYmd.slice(6, 8)}`;
      const cRef = db.collection('chipArchive').doc(closeIso);
      const cCur = (await cRef.get()).data() || {};
      if (!cCur.closeJson || cCur.otcPending) {
        // 上櫃合併必回聲驗證日期；未到檔先寫上市＋otcPending，16:45/21:45/重啟自動補跑重建
        const otcArr = await fetchTpexDailyCloseValidated(closeYmd);
        if (otcArr) for (const x of otcArr) { const code = x.SecuritiesCompanyCode || ''; if (/^\d{4}$/.test(code)) rows.push({ code, close: _f(x.Close), vol: _f(x.TradingShares), open: _f(x.Open), high: _f(x.High), low: _f(x.Low) }); }
        // 完整日 K [收, 量張, 開, 高, 低]
        const close = {}; for (const r of rows) if (r.close > 0) close[r.code] = [r.close, Math.round((r.vol || 0) / 1000), r.open || 0, r.high || 0, r.low || 0];
        if (!cCur.closeJson || otcArr) {
          await cRef.set({ date: closeIso, at: Date.now(), market: 'tse', closeJson: JSON.stringify(close), otcPending: !otcArr }, { merge: true });
          log(`  ✓ 收盤歸檔 → ${closeIso}（依資料真實日期${otcArr ? '·含上櫃' : '·上櫃檔未出待補'}）`);
        }
      }
    }
  }
  // 融資券（21:30 後才有今日資料；16:30 先跳過待 21:45 補）
  const mins = tw.getHours() * 60 + tw.getMinutes();
  if (!cur.marginJson && mins >= 21 * 60 + 30) {
    const mg = await J(`https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${ymd}&selectType=ALL&response=json`);
    // 回音驗證：資券餘額歸檔錯日 = 整段歷史被污染，且不會有任何徵兆
    const mtb = String(mg?.date || '') === ymd ? (mg?.tables || []).find(t => (t.data || []).length > 100) : null;
    if (mg && String(mg?.date || '') !== ymd) log(`  ⚠ 歸檔 MI_MARGN 回音 ${mg?.date} ≠ ${ymd}，不併入`);
    const margin = {};
    for (const r of (mtb?.data || [])) { const c = (r[0] || '').trim(); if (/^\d{4}$/.test(c)) margin[c] = [Math.round(_f(r[6])), Math.round(_f(r[12]))]; }
    if (Object.keys(margin).length > 100) patch.marginJson = JSON.stringify(margin);
  }
  patch.complete = !!((cur.instJson || patch.instJson) && cur.closeJson);
  await ref.set(patch, { merge: true });
  log(`✓ 籌碼歸檔 ${iso}：法人${(cur.instJson || patch.instJson) ? '✓' : '—'} 資券${(cur.marginJson || patch.marginJson) ? '✓' : '—'}（收盤另依資料日歸檔）`);
}

// ── 53) 早盤起漲提醒 earlyBird（高級會員限定）───────────────────
// 09:00–10:30：昨日策略榜個股「已上榜但尚未發動」（漲 0.3%~2%、非高當沖、
// 非連3停）→ 推播提醒可評估進場。每檔每日一次、每人每日上限 6 則。
const _ebAlerted = new Set(); let _ebDay = ''; const _ebCount = {};
let _ebPicks = { date: '', map: null };
async function checkEarlyBird() {
  const tw = taipei(); const mins = tw.getHours() * 60 + tw.getMinutes();
  if (!(mins >= 9 * 60 && mins <= 10 * 60 + 30)) return;
  const today = isoDate(tw);
  if (_ebDay !== today) { _ebAlerted.clear(); _ebDay = today; for (const k in _ebCount) delete _ebCount[k]; }
  // 昨日策略榜（快取整天）
  if (_ebPicks.date !== today) {
    const sp = (await db.collection('strategyPicks').doc('latest').get()).data();
    if (!sp?.groups) return;
    const map = {};
    for (const k of ['limitLock', 'gapUp', 'volBreak', 'secondBar', 'dipLimit', 'chip']) {
      for (const p of (sp.groups[k] || [])) {
        if (p.dtHigh || (p.streak ?? 1) >= 3) continue; // 高當沖/連3停不提醒
        (map[p.code] ??= { name: p.name, score: p.score, keys: [] });
        map[p.code].keys.push(sp.stats?.[k]?.name || k);
      }
    }
    _ebPicks = { date: today, map };
  }
  if (!_ebPicks.map) return;
  const snap = await readSnapshotQuotes(); if (!snap?.marketOpen) return;
  const q = snap.quotes;
  const hits = [];
  for (const code in _ebPicks.map) {
    if (_ebAlerted.has(code)) continue;
    const x = q[code]; if (!x?.live || !(x.price > 0)) continue;
    const chg = x.changePercent;
    if (chg < 0.3 || chg > 2) continue; // 有動但尚未發動的甜蜜窗
    _ebAlerted.add(code);
    const m = _ebPicks.map[code];
    hits.push({ code, name: m.name, price: x.price, chg, score: m.score, strategies: m.keys.join('+'), multi: m.keys.length });
  }
  if (!hits.length) return;
  const iwCtx = await getInstWeightCtx(); // 四大法人加權(t-1，PIT 安全)
  hits.sort((a, b) => b.multi - a.multi || instWeight(b.code, iwCtx) - instWeight(a.code, iwCtx) || (b.score ?? 0) - (a.score ?? 0));
  // 勝率雷達階段濾網：只推 S/A/B+（法人主導）並附籌碼理由
  const good = [];
  for (const h of hits) {
    const v = iwCtx.latest?.[h.code] || [0, 0, 0];
    const volLots = q[h.code]?.volume ? Math.round(q[h.code].volume / 1000) : 0;
    const p = chipPhaseTier(v[0] || 0, v[1] || 0, v[2] || 0, iwCtx.streak?.[h.code] || 0, h.chg, volLots);
    if (['S', 'A', 'B+'].includes(p.tier)) { h._phase = p; h._inst = v; good.push(h); }
  }
  const premium = await getPremiumUsers();
  for (const u of premium) {
    const uid = u.id;
    if ((_ebCount[uid] || 0) >= 6) continue; // 每人每日上限，防轟炸
    try {
      const room = 6 - (_ebCount[uid] || 0);
      const batch = good.slice(0, room);
      _ebCount[uid] = (_ebCount[uid] || 0) + batch.length;
      const newAlerts = batch.map(h => ({ code: h.code, name: h.name, type: 'earlybird', price: h.price, message: `🐦 早盤機會：${h.code} ${h.name} 在昨日策略榜（${h.strategies}${h.multi >= 2 ? '·⭐共識' : ''}），現漲 +${h.chg}% 尚未發動。為何買：籌碼「${h._phase.label}」勝率雷達 ${h._phase.tier}級${h._phase.win}%，外${h._inst[0]}/投${h._inst[1]}/自${h._inst[2]}張（評分 ${h.score ?? '—'}）— 可評估進場；鐵律：單筆風險≤1%、隔日必出`, at: Date.now() }));
      const aref = db.collection('users').doc(uid).collection('data').doc('alerts');
      const prev = (await aref.get()).data()?.alerts || [];
      await aref.set({ updatedAt: Date.now(), alerts: [...newAlerts, ...prev].slice(0, 40) });
      pushAlerts(uid, newAlerts).catch(() => {});
      for (const al of newAlerts) log(`  🐦 ${uid.slice(0, 6)} ${al.message.slice(0, 60)}`);
    } catch { /* per-user skip */ }
  }
}

// ── 54) 今日盤型判讀 marketPattern（開盤即時，隔日沖出場紀律）────
// 與「前日盤後策略卡」分離：策略卡回答「買什麼」(昨日收盤+籌碼)，
// 本技能回答「今天怎麼出」(今日開盤後即時加權指數)。
// 單日分類：跳空=(開-昨收)/昨收、盤中=(現價-開)/開
//   fadeDown 開高走低: 跳空≥+0.15% 且盤中≤-0.2%
//     （實測 2年66次：隔日沖開盤賣 73%/+1.48%、抱到收盤 40%/-0.44%）
//   downDown 開低走低 / reversalUp 開低走高 / upUp 開高走高 / range 平盤震盪
// 環境燈號：近5完成交易日 fadeDown ≥3天紅燈、≥2天黃燈、其餘中性（使用者拍板門檻）。
const MP_GAP = 0.15, MP_FADE = -0.2;
function classifyDayPattern(gapPct, intraPct) {
  if (gapPct >= MP_GAP && intraPct <= MP_FADE) return 'fadeDown';
  if (Math.abs(gapPct) < MP_GAP && intraPct <= -1) return 'flatDown'; // 開平殺盤(使用者追加：開平但盤中殺>1%也亮警示)
  if (gapPct <= -MP_GAP && intraPct < 0) return 'downDown';
  if (gapPct <= -MP_GAP && intraPct >= 0.2) return 'reversalUp';
  if (gapPct >= MP_GAP && intraPct >= 0) return 'upUp';
  return 'range';
}
let _mpRecent = { key: '', days: null };
async function computeMarketPattern() {
  const tw = taipei(); const mins = tw.getHours() * 60 + tw.getMinutes(); const today = isoDate(tw);
  // 近5「完成」交易日：今天收盤後(14:00起)才把今天算入，盤中只看昨日以前
  const includeToday = !isTradingDay(tw) || mins >= 14 * 60;
  const histKey = `${today}|${includeToday}`;
  if (_mpRecent.key !== histKey) {
    const bars = await fetchYahooDaily('^TWII', '1mo');
    if (bars && bars.length >= 7) {
      const done = bars.filter(b => {
        const d = new Date((b.t + 8 * 3600) * 1000).toISOString().slice(0, 10);
        return d < today || (d === today && includeToday);
      });
      const days = [];
      for (let i = 1; i < done.length; i++) {
        const prev = done[i - 1].c; const b = done[i];
        const gapPct = +((b.o - prev) / prev * 100).toFixed(2);
        const intraPct = +((b.c - b.o) / b.o * 100).toFixed(2);
        days.push({ date: new Date((b.t + 8 * 3600) * 1000).toISOString().slice(0, 10), gapPct, intraPct, pattern: classifyDayPattern(gapPct, intraPct) });
      }
      if (days.length) _mpRecent = { key: histKey, days: days.slice(-5) };
    }
  }
  const days = _mpRecent.days || [];
  // 環境燈號把「開平殺盤」也計入盤中翻黑天數（07-07 型崩跌日不漏算）
  const fadeCount = days.filter(d => d.pattern === 'fadeDown' || d.pattern === 'flatDown').length;
  const level = fadeCount >= 3 ? 'red' : fadeCount >= 2 ? 'yellow' : 'neutral';
  // 盤中即時：MIS 加權指數 t00（開盤後才有今日開盤價）
  let live = null;
  if (isTradingDay(tw) && mins >= 9 * 60 && mins < 13 * 60 + 35) {
    try {
      const j = await fetch('https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw&json=1&delay=0',
        { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TW-Stock-App/1.0)', Referer: 'https://mis.twse.com.tw/' } }).then(r => r.json());
      const x = j?.msgArray?.[0];
      const z = parseFloat(x?.z), o = parseFloat(x?.o), y = parseFloat(x?.y);
      if (z > 0 && o > 0 && y > 0) {
        const gapPct = +((o - y) / y * 100).toFixed(2);
        const intraPct = +((z - o) / o * 100).toFixed(2);
        live = { date: today, price: z, gapPct, intraPct, pattern: classifyDayPattern(gapPct, intraPct), at: Date.now() };
      }
    } catch { /* MIS 偶發失敗：保留上次 live（merge 不覆蓋） */ }
  }
  const payload = { updatedAt: Date.now(), date: today, env: { level, fadeCount, days } };
  if (live) payload.live = live;
  await db.collection('marketPattern').doc('latest').set(payload, { merge: true });
}

// ── 54b) 撿尾盤推薦股 tailPicks（尾盤即時買點清單）──────────────
// 實測最佳尾盤型態「收最高＋破5日高」(55%/+1.55%/PF2.02)：漲≥1%、收盤位置≥0.9、
// 收盤突破前5日高。分兩類：buyable(未鎖漲停＝尾盤買得到)、locked(鎖漲停＝漲停鎖死排隊)。
// 盤中(12:45–13:35)用即時快照 OHLC；收盤後用 STOCK_DAY_ALL。近5日高/均量取自 chipArchive。
const _teTick = p => p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5;
const _teIsLimitUp = (c, pc) => { if (!(pc > 0)) return false; const t = _teTick(pc); const lim = Math.floor(pc * 1.1 / t) * t; return c >= lim - 1e-9; };
async function computeTailEndPicks() {
  const tw = taipei(); const mins = tw.getHours() * 60 + tw.getMinutes(); const today = isoDate(tw);
  const trading = isTradingDay(tw);
  // 撿尾盤回歸尾盤專用窗口(使用者要求與盤中模式分離；盤中另有起漲偵測雷達)
  const liveWindow = trading && mins >= 12 * 60 + 45 && mins < 13 * 60 + 35; // 尾盤即時
  const closedToday = trading && mins >= 14 * 60;                            // 收盤後(STOCK_DAY_ALL 已更新)
  if (!liveWindow && !closedToday && trading) return;                        // 盤中前段不算(位置未定)

  // 近日高 + 均量(張)：chipArchive closeJson {code:[收盤,量張]}；instJson {code:[外資,投信]}
  const arch = (await db.collection('chipArchive').orderBy('date', 'desc').limit(21).get()).docs.map(d => d.data());
  if (!arch.length) return;
  const maps = arch.map(a => a.closeJson ? JSON.parse(a.closeJson) : {});
  const instMaps = arch.map(a => a.instJson ? JSON.parse(a.instJson) : {});
  // 外資連續買超天數(由最近往回；實測：有買超為關鍵、連6日+略優)
  const foreignStreak = code => { let s = 0; for (let k = 0; k < instMaps.length; k++) { const f = instMaps[k]?.[code]?.[0]; if (f > 0) s++; else break; } return s; };
  const hi20 = {}, avgVol = {}, prevClose = {};
  const allCodes = new Set(); for (const m of maps) for (const k in m) allCodes.add(k);
  for (const code of allCodes) {
    let h = 0, vs = 0, vn = 0;
    for (let k = 0; k < 20; k++) { const row = maps[k]?.[code]; if (!row) continue; if (row[0] > h) h = row[0]; if (k < 5 && row[1] > 0) { vs += row[1]; vn++; } }
    hi20[code] = h; avgVol[code] = vn ? vs / vn : 0; prevClose[code] = maps[0]?.[code]?.[0] || 0;
  }

  // 今日 OHLCV：盤中用快照、收盤後用 STOCK_DAY_ALL
  let rows = []; let source = 'close';
  if (liveWindow) {
    const snap = await readSnapshotQuotes(); const q = snap?.quotes || {};
    for (const code in q) { const x = q[code]; if (!x.live || !(x.price > 0) || !(x.high > 0)) continue; rows.push({ code, name: x.name, market: x.market, o: x.open, h: x.high, l: x.low, c: x.price, lots: Math.round((x.volume || 0) / 1000) }); }
    source = 'live';
  } else {
    const csv = await fetchCloseCsvFull();
    for (const r of csv) rows.push({ code: r.code, name: r.name, market: 'tse', o: r.open, h: r.high, l: r.low, c: r.close, lots: r.vol / 1000 });
  }

  // AI 評分(全市場批次)：與策略卡同源 /api/rating
  const ratingMap = (await getJSON('/api/rating'))?.ratings || {};
  // 隔日勝率(依外資連買天數)。PIT-safe 回測：連買天數只用進場時已公布的 T86(t-1 前)，
  // 修正原版偷用當日 15:00 才公布資料的未來函數(原 39-49% 灌水 → 誠實版 44-47%)。
  const winRateForStreak = s => s <= 0 ? 44 : s === 1 ? 45 : s === 2 ? 46 : s <= 5 ? 45 : 47;

  // 三大法人當日累計買賣超(張)：優先今日 T86；未公布(盤中/剛收盤約15:00前)則取最近一日
  let instMap = null, instDate = null;
  for (const d8 of [today.replace(/-/g, ''), ...recentTradingDates(4)]) {
    const m = await fetchT86(d8);
    if (m && Object.keys(m).length > 20) { instMap = m; instDate = `${d8.slice(0, 4)}-${d8.slice(4, 6)}-${d8.slice(6, 8)}`; break; }
  }
  const instFor = code => {
    const x = instMap?.[code]; if (!x) return {};
    return { instF: x.foreign, instT: x.trust, instD: x.dealer, instTot: x.total };
  };

  // 性格分類需在建 item 的迴圈之前載入（item.char 會用到；宣告在後會 TDZ 炸掉整條盤中鏈）
  let tailCharBy = {};
  try { const cd = await db.collection('chipCharacter').doc('latest').get(); if (cd.exists) tailCharBy = JSON.parse(cd.data().byCodeJson || '{}'); } catch { /* 缺分類不影響 */ }

  // 週轉率下限（2026-07-27 使用者提供隔日沖SOP檢定後採用）：當日成交股數÷發行股數 <0.5%
  // 的冷門股，明開賣兩窗同向負（主窗 -0.068%[-0.064/-0.07]·第三獨立窗 -0.137%[-0.224/-0.078]）；
  // 排除後濾網 +0.081%→+0.103%（兩窗皆升）、第三窗 +0.002%→+0.021%。只排除、不加分。
  const shrMap = await getSharesMap();
  const TURN_FLOOR = 0.5;

  const buyable = [], locked = [];
  for (const r of rows) {
    const code = r.code; if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
    const pc = prevClose[code]; if (!(pc > 0) || !(r.c > 0) || !(r.h > 0)) continue;
    const shr = shrMap[code];
    const turnover = shr > 0 ? r.lots * 1000 / shr * 100 : null;
    if (turnover != null && turnover < TURN_FLOOR) continue;   // 冷門股排除（有資料才判，無資料不誤殺）
    const chg = (r.c - pc) / pc * 100;
    const rng = r.h - r.l; const pos = rng > 0 ? (r.c - r.l) / rng : 1;
    // 主濾網（2026-07-19 audit-tailend-filter.mjs 五方案回測定版）：破20日高×pos≥0.7×漲3~7%
    // ＝2年唯一「明開賣」淨正組合（淨勝45.7%·淨均+0.055%/筆·日均17.7檔）；
    // 舊濾網（漲≥1·pos≥0.9·破5日高）為五案最差（明開賣-0.204%），已依實證汰換。
    const h20 = hi20[code]; if (!(h20 > 0 && r.c > h20)) continue;        // 突破前20日高
    const isLU = _teIsLimitUp(r.c, pc);
    if (!isLU) { if (pos < 0.7) continue; if (chg < 3 || chg > 7) continue; } // 強尾×甜蜜區（漲停另列 locked）
    const volX = avgVol[code] > 0 ? r.lots / avgVol[code] : 0;
    const fStreak = foreignStreak(code);
    const item = { code, name: (r.name || '').trim(), market: r.market || 'tse', price: +r.c.toFixed(2), chg: +chg.toFixed(2), pos: +pos.toFixed(2), volX: +volX.toFixed(1), turnover: turnover != null ? +turnover.toFixed(2) : null, fStreak, char: tailCharBy[code]?.label || null, score: ratingMap[code]?.score ?? null, winRate: winRateForStreak(fStreak), ...instFor(code) };
    (isLU ? locked : buyable).push(item);
  }
  // 綜合強度：漲幅×收盤位置 + 量比×2 + 四大法人加權(回測驗證·保守)。
  // 隔日沖 83 日回測：加權後 Top5 勝率 48.4%→51.3%、報酬 1.03%→1.26%。
  const iwCtx = await getInstWeightCtx(); // chipDaily(t-1)，PIT 安全
  // 炒作型 +2：性格分割檢定（700日）——定版濾網×炒作型 收賣+0.15/+0.19·開賣+0.29/+0.28 雙口徑穩定正，一般型僅開賣正
  const strength = x => x.chg * x.pos + x.volX * 2 + instWeight(x.code, iwCtx) + (tailCharBy[x.code]?.label === '炒作型' ? 2 : 0);
  buyable.sort((a, b) => strength(b) - strength(a));
  locked.sort((a, b) => strength(b) - strength(a));

  await db.collection('marketPattern').doc('latest').set({
    tailPicks: { updatedAt: Date.now(), date: today, source, instDate, buyable: buyable.slice(0, 60), locked: locked.slice(0, 30), buyableTotal: buyable.length },
  }, { merge: true });
  log(`  🪣 撿尾盤 ${source} buyable=${buyable.length} locked=${locked.length}`);
}

// ── 60) 三大法人累計籌碼庫 chipCumulative（證交所 T86 逐日累加）──
// 誠實界定：證交所每日只公布「當日買賣超」，無「絕對持股」。本庫＝自起始日
// 逐日累加的「累計淨買賣超(張)」＝外資/投信/自營各自的籌碼流向累計。
// 精準保證：① 每交易日只計一次(lastDate 嚴格遞進，成功納入才推進)
//   ② 缺日不推進 lastDate → 下次自動補回，不漏不重  ③ 單位一律「張」(T86 股/1000)
//   ④ 三大法人 total = 外資(含陸資自營) + 投信 + 自營商合計。
async function computeChipCumulative() {
  const doc = (await db.collection('chipCumulative').doc('latest').get()).data();
  let byCode = doc?.byCode || {};      // code -> [外資累計, 投信累計, 自營累計]（張）
  let startDate = doc?.startDate || null;
  const lastDate = doc?.lastDate || null; // 最近已納入的交易日(YYYYMMDD)

  // 待納入交易日(由舊到新)。backTradingDates 為模組層級(見上)。
  let dates;
  if (!lastDate) { dates = backTradingDates(120).reverse(); startDate = dates[0] || null; byCode = {}; }
  else { dates = backTradingDates(25).filter(d => d > lastDate).reverse(); }
  if (!dates.length) return;

  let added = 0, newLast = lastDate;
  for (const d8 of dates) {
    const m = await fetchT86(d8);
    await sleep(400); // 證交所限速保護
    if (!m || Object.keys(m).length < 50) continue; // 未公布/假日/異常 → 跳過，不推進(下次重試)
    for (const code in m) {
      const x = m[code];
      // 精準：三值皆已在 fetchT86 換算為「張」(外資 row4+row7、投信 row10、自營 row11)
      const cur = (byCode[code] ??= [0, 0, 0]);
      cur[0] += x.foreign || 0; cur[1] += x.trust || 0; cur[2] += x.dealer || 0;
    }
    newLast = d8; added++;
  }
  if (!added || !newLast) return;
  const iso = d8 => `${d8.slice(0, 4)}-${d8.slice(4, 6)}-${d8.slice(6, 8)}`;
  await db.collection('chipCumulative').doc('latest').set({
    updatedAt: Date.now(), startDate, lastDate: newLast,
    startIso: startDate ? iso(startDate) : iso(newLast), lastIso: iso(newLast),
    days: (doc?.days || 0) + added, count: Object.keys(byCode).length, byCode,
  });
  log(`✓ 三大法人累計籌碼：+${added} 交易日 → 至 ${iso(newLast)}（自 ${startDate ? iso(startDate) : iso(newLast)}，${Object.keys(byCode).length} 檔）`);
}

// ── 62) 三大法人籌碼訊號判讀 chipSignals（使用者四準則，2026-07-15）──────
// 資料：最新日 T86(外資/投信/自營，含自營) + chipArchive 歷史(連買/創新高/融資變化)。
// PIT：T86 約 15:00 出、融資約 21:30 出；盤中用最近「已公布完整」的一日，dataDate 標明。
// 四準則（皆確定性計算，非投資建議）：
//  ① 外資單日買超 ≥ 5000 張 → 隔日易有支撐（主力大買）
//  ② 三方同向買超（外資>0 且 投信>0 且 自營>0）→ 強烈多頭訊號
//  ③ 外資連買 ≥3 日 + 股價創(20日)新高 → 籌碼追蹤最佳入場
//  ④ 外資賣超 + 融資餘額增加 → 散戶接棒、危險訊號
const CHIP_HEAVY_LOTS = 5000;   // 外資單日大買門檻(張)
const CHIP_STREAK_MIN = 3;      // 連買天數門檻
const CHIP_NEWHIGH_LOOKBACK = 20;
async function computeChipSignals() {
  const arch = (await db.collection('chipArchive').orderBy('date', 'desc').limit(24).get()).docs.map(d => d.data());
  const instDocs = arch.filter(a => a.instJson);
  if (instDocs.length < CHIP_STREAK_MIN) { log('  ⚠ 籌碼訊號：chipArchive 法人資料不足'); return; }
  const inst = instDocs.map(a => JSON.parse(a.instJson));              // [外資,投信] 張（不含外資自營）
  const closeDocs = arch.filter(a => a.closeJson);
  const closes = closeDocs.map(a => JSON.parse(a.closeJson));          // [close, vol張]
  const marginDocs = arch.filter(a => a.marginJson);
  const margins = marginDocs.map(a => JSON.parse(a.marginJson));       // [資餘, 券餘] 張

  // 最新法人日 → 抓 T86 取自營商 + 權威單日淨額（含自營）
  const latestIso = instDocs[0].date; const latestYmd = latestIso.replace(/-/g, '');
  const t86 = await fetchT86(latestYmd);
  const marginIso = marginDocs[0]?.date || null;

  const rules = { foreignHeavyBuy: [], tripleAlign: [], streakNewHigh: [], retailBagholder: [] };
  const byCode = {};
  const codes = new Set(); for (const c in inst[0]) codes.add(c); if (t86) for (const c in t86) codes.add(c);

  for (const code of codes) {
    const d0 = t86?.[code];
    const f0 = d0 ? d0.foreign : (inst[0][code]?.[0] || 0);
    const tr0 = d0 ? d0.trust : (inst[0][code]?.[1] || 0);
    const de0 = d0 ? d0.dealer : 0;
    const name = d0?.name || '';
    // 外資連買天數（chipArchive 外資淨>0 連續）
    let streak = 0; for (const m of inst) { if ((m[code]?.[0] || 0) > 0) streak++; else break; }
    // 創新高：今日收盤 ≥ 前 20 日最高收盤
    const cToday = closes[0]?.[code]?.[0] || 0;
    let hi = 0; for (let k = 1; k <= CHIP_NEWHIGH_LOOKBACK && k < closes.length; k++) { const c = closes[k]?.[code]?.[0] || 0; if (c > hi) hi = c; }
    const newHigh = cToday > 0 && hi > 0 && cToday >= hi;
    // 融資餘額變化（最近兩個有資券的日）
    const mar0 = margins[0]?.[code]?.[0], mar1 = margins[1]?.[code]?.[0];
    const marginChg = (mar0 > 0 && mar1 > 0) ? mar0 - mar1 : 0;

    const tags = [];
    if (f0 >= CHIP_HEAVY_LOTS) { tags.push('foreignHeavyBuy'); rules.foreignHeavyBuy.push({ code, name, foreign: f0, trust: tr0, dealer: de0 }); }
    if (f0 > 0 && tr0 > 0 && de0 > 0) { tags.push('tripleAlign'); rules.tripleAlign.push({ code, name, foreign: f0, trust: tr0, dealer: de0, total: f0 + tr0 + de0 }); }
    if (streak >= CHIP_STREAK_MIN && newHigh) { tags.push('streakNewHigh'); rules.streakNewHigh.push({ code, name, streak, foreign: f0, close: cToday }); }
    if (f0 < 0 && marginChg > 0) { tags.push('retailBagholder'); rules.retailBagholder.push({ code, name, foreign: f0, marginUp: marginChg }); }
    if (tags.length) byCode[code] = { tags, name, foreign: f0, trust: tr0, dealer: de0, streak, newHigh, marginChg };
  }

  rules.foreignHeavyBuy.sort((a, b) => b.foreign - a.foreign);
  rules.tripleAlign.sort((a, b) => b.total - a.total);
  rules.streakNewHigh.sort((a, b) => b.streak - a.streak || b.foreign - a.foreign);
  rules.retailBagholder.sort((a, b) => a.foreign - b.foreign); // 外資賣最多在前
  for (const k in rules) rules[k] = rules[k].slice(0, 300); // 全量上榜（300 為文件大小保險上限）

  await db.collection('chipSignals').doc('latest').set({
    updatedAt: Date.now(), dataDate: latestIso, marginDate: marginIso,
    counts: { foreignHeavyBuy: rules.foreignHeavyBuy.length, tripleAlign: rules.tripleAlign.length, streakNewHigh: rules.streakNewHigh.length, retailBagholder: rules.retailBagholder.length },
    rules, byCode,
  });
  log(`✓ 籌碼訊號 ${latestIso}：外資大買${rules.foreignHeavyBuy.length}／三方同買${rules.tripleAlign.length}／連買創高${rules.streakNewHigh.length}／散戶接棒${rules.retailBagholder.length}`);
}

// ── 64) 全個股逐日三大法人庫 chipDaily（含自營，20/5/日風向基礎）──────
// chipArchive 只存[外資,投信]缺自營；此庫用 fetchT86 存全個股每日 [外資,投信,自營](張)。
// 每日一格 chipDaily/{iso}；首次回填 22 交易日。冪等：已存在的日期不重抓。
async function computeChipDaily() {
  const need = backTradingDates(120); // 新→舊（回填約半年，供回測與 20/5/日風向）
  const iso8 = d8 => `${d8.slice(0, 4)}-${d8.slice(4, 6)}-${d8.slice(6, 8)}`;
  const have = new Set((await db.collection('chipDaily').select().get()).docs.map(d => d.id));
  // 最近 5 個交易日一律重抓(升級併入上櫃 TPEx)；其餘只補缺。
  const recent = new Set(need.slice(0, 5).map(iso8));
  const targets = need.map(iso8).filter(iso => !have.has(iso) || recent.has(iso));
  if (!targets.length) return;
  let added = 0, upgraded = 0;
  for (const iso of targets) {
    const ymd = iso.replace(/-/g, '');
    const m = await fetchT86(ymd); await sleep(400);
    if (!m || Object.keys(m).length < 50) continue; // 未公布/假日 → 跳過(下次補)
    const codes = {}; for (const c in m) { const x = m[c]; codes[c] = [x.foreign || 0, x.trust || 0, x.dealer || 0]; }
    await db.collection('chipDaily').doc(iso).set({ date: iso, at: Date.now(), codesJson: JSON.stringify(codes) });
    if (have.has(iso)) upgraded++; else added++;
  }
  if (added || upgraded) log(`✓ 逐日籌碼庫：新增 ${added} 日、升級(含上櫃) ${upgraded} 日（共 ${have.size + added} 日）`);
}

// ── 65) 籌碼風向 chipWind（當日/5日/20日三大法人淨買賣加權）──────────
// 用 chipDaily 逐日累加各時間框，算：市場法人總淨額、外資/投信/合計買賣超榜、
// 產業籌碼傾向(加碼/減碼)、外資連買天數。皆確定性計算，非投資建議。
// 快取修正：原版只記日期不記天數——先要 8 天的話，後面要 60 天的倒貨偵測會拿到
// 8 天窗（漏抓倒貨）。改為記錄天數：夠長就切片、不夠就重抓更長。
let _chipWinCache = { date: '', n: 0, window: null };
async function loadChipWindow(n = 20) {
  const today = isoDate(taipei());
  if (_chipWinCache.date === today && _chipWinCache.window && _chipWinCache.n >= n) return _chipWinCache.window.slice(0, n);
  const fetchN = Math.max(n, _chipWinCache.n || 0, 20);
  const snap = await db.collection('chipDaily').orderBy('date', 'desc').limit(fetchN).get();
  const window = snap.docs.map(d => { const x = d.data(); return { date: x.date, map: x.codesJson ? JSON.parse(x.codesJson) : {} }; });
  if (window.length) _chipWinCache = { date: today, n: fetchN, window };
  return window.slice(0, n);
}
// ── 四大法人加權（回測驗證·保守權重，2026-07-15）──────────────────
// 隔日沖 78-83 日回測：基準 Top5 勝率 48.4% → 保守 51.3%、報酬 1.03%→1.26%。
// 隔離分析拉抬：三方同買+9.2 / 投信+7.5 / 外資大買+7.0 / 外資賣超-6.4(負報酬)。
// 「數據最佳(正比拉抬)」因訊號相關而過擬合、輸給保守 → 採保守輕權重。
// PIT 安全：讀 chipDaily(EOD，盤中即 t-1)，不碰當日 T86。ETF 項為第四法人
// (前瞻觀察，未進回測，小權重)。
let _instWCtx = { date: '', latest: null, streak: null, etf: null };
async function getInstWeightCtx() {
  const today = isoDate(taipei());
  if (_instWCtx.date === today && _instWCtx.latest) return _instWCtx;
  const win = await loadChipWindow(8);
  if (!win.length) return _instWCtx;
  const latest = win[0].map;
  const codes = new Set(); for (const w of win) for (const c in w.map) codes.add(c);
  const streak = {}; for (const c of codes) { let s = 0; for (const w of win) { if ((w.map[c]?.[0] || 0) > 0) s++; else break; } if (s) streak[c] = s; }
  let etf = {};
  try { etf = (await db.collection('etfInfluence').doc('latest').get()).data()?.byCode || {}; } catch { /* ignore */ }
  _instWCtx = { date: today, latest, streak, etf };
  return _instWCtx;
}
function instWeight(code, ctx) {
  const v = ctx?.latest?.[code]; if (!v) return 0;
  const f = v[0] || 0, t = v[1] || 0, d = v[2] || 0, s = ctx.streak?.[code] || 0;
  let w = (f > 0 ? 3 : f < 0 ? -6 : 0)          // 外資方向：買+3、賣超重罰-6(回測-0.24%報酬)
    + 1.0 * Math.min(s, 6)                        // 外資連買(上限6)
    + (f > 0 && t > 0 && d > 0 ? 3 : 0)           // 三方同買(最強+9.2)
    + (f >= 5000 ? 2 : 0)                          // 外資大買≥5000張(+7.0)
    + (t > 0 ? 1 : 0);                             // 投信買超(+7.5，但與三方相關故輕權)
  const e = ctx.etf?.[code];
  if (e && (e.bigEtf || e.edge)) w += 1.5;        // 第四法人：ETF 成分/邊緣(前瞻觀察)
  return w;
}

// 勝率雷達階段(伺服器版，鏡射前端 classifyPhase)。呼叫端連買≥2日時傳累計 f/t/d。
// 回傳 tier: S/A/B+/B/watch/danger + label + 回測勝率 + danger(轉空)旗標。
function chipPhaseTier(f, t, d, streak, chgPct, volLots) {
  // 2026-08-01 重定錨（audit-weights 乾淨資料重測·480日·42.3萬樣本）：
  // win 一律改為**明開盤賣出**口徑的毛勝率——產品鐵律是明開賣（exitModel），
  // 舊值(49/50/47/46)是收盤賣口徑，操作者看到的數字跟實際執行對不上。
  // 同時附 netWin(扣費稅淨勝)/net(淨均%/筆)/rank(1=最優)：
  //   A 61/51/+0.17 🥇唯一淨正·日均3檔｜B+ 60/45/+0.02｜S 59/44/-0.02｜
  //   B 58/44/-0.05｜watch 51/43/-0.09｜danger 54/39/-0.21(淨勝全場最低)
  // ⚠鏡像：src/lib/tier-meta.ts 持同一張表的 TS 副本，兩邊必須同步改。
  // danger 旗標保留波段語意（外資賣超=倒貨領先）。
  const heavy = f >= 500 && (volLots > 0 ? (f / volLots >= 0.10) : (f >= 5000)); // 外資大買(佔量≥10%且≥500張)
  const weak = f < 500 || (volLots > 0 ? (f / volLots < 0.02) : (f < 1000));
  if (f < 0) {
    if (t > 0 && (f + t + d) > 0) return { tier: 'B', label: '投信主導·外資調節', win: 58, netWin: 44, net: -0.05, rank: 4, danger: false };
    return { tier: 'danger', label: '外資賣超·危險', win: 54, netWin: 39, net: -0.21, rank: 7, danger: true };
  }
  if (heavy && t > 0) return { tier: 'S', label: '外資重倉+投信', win: 59, netWin: 44, net: -0.02, rank: 3, danger: false };
  if (f > 0 && t > 0 && d > 0) return { tier: 'A', label: '三方同買·唯一淨正', win: 61, netWin: 51, net: 0.17, rank: 1, danger: false };
  if (heavy) return { tier: 'B+', label: '外資大買·主導', win: 60, netWin: 45, net: 0.02, rank: 2, danger: false };
  // 2026-07-19 二次修正：舊53%為漲停幻覺——該形態81%樣本是漲停鎖死日（買不到），
  // 可交易部分(漲7~8.5%未鎖)實測僅33.7/43.3%·淨-1.03/-0.32%——弱勢群，非行動訊號。
  if (chgPct >= 7 && weak && t <= 0 && streak < 2) return { tier: 'watch', label: '大漲·未鎖弱勢(鎖死另計)', win: 51, netWin: 43, net: -0.09, rank: 5, danger: false };
  if (streak >= 2 || f > 0) return { tier: 'B', label: '外資布局中', win: 58, netWin: 44, net: -0.05, rank: 4, danger: false };
  return { tier: 'watch', label: '籌碼中性', win: null, netWin: null, net: null, rank: 6, danger: false };
}
// 主力倒貨偵測：window 內三大法人累計淨額的峰值 vs 現值。倒貨% = (峰值-現值)/峰值。
function chipDistribution(code, win) { // win 新→舊
  let cum = 0, peak = 0;
  for (let i = win.length - 1; i >= 0; i--) { const v = win[i].map[code]; if (v) { cum += (v[0] || 0) + (v[1] || 0) + (v[2] || 0); if (cum > peak) peak = cum; } }
  const distributedPct = peak > 0 ? Math.round(((peak - cum) / peak) * 100) : 0;
  return { peak: Math.round(peak), current: Math.round(cum), distributedPct };
}
// 外資連賣天數（連續外資淨<0）
function foreignSellStreak(code, win) { let s = 0; for (const w of win) { if ((w.map[code]?.[0] || 0) < 0) s++; else break; } return s; }

// ── 66) 法人籌碼推選榜 chipPicks（盤中戰情「法人籌碼推選股」分頁）──────────
// 4 榜：① 分級排行(勝率雷達 tier·可入場) ② 累計總籌碼 ③ 法人分別(外/投/自) ④ 布局(外資早期卡位)
// PIT 安全：法人讀 chipDaily(EOD/盤中即 t-1)；名稱/價格用即時快照。確定性，非投資建議。
const CHIP_PICK_WIN = 20;                                    // 累計視窗(交易日)
const CHIP_PICK_N = 40;                                      // 每榜上限
const TIER_RANK = { S: 5, A: 4, 'B+': 3, B: 2, watch: 1, danger: 0 };
// ── 66b) 財報引擎 finReports/finSummary（近2年8季·上市櫃·MOPS 官方）────────
// 回補：scripts/backfill-finreports.mjs。此處：季度自動增量＋每日體質摘要＋持股基本面警示。
// 資料陷阱：MOPS 彙總表 Q2/Q3/Q4 損益為「年度累計」→ finToSingles 換算單季；Q1=單季；資負=時點。
// 體質分回測(2事件·財報公布後20日)：最低分組跑輸大盤3.2-3.6pt、最高分組+6.8pt價差(年報事件)
// → 權重「重罰低分、輕獎高分」：<20→-3, <40→-1, 40-60→0, 60-80→+1, ≥80→+2（×1.5併入選股排序）。
// PE 發現：低PE短線反向(最便宜組+1.4% vs 最貴組+20.6%，成長動能行情)→PE只展示不做方向加權。
function finToSingles(quarters) { // 新→舊
  const byKey = {}; for (const x of quarters) if (x) byKey[`${x.y}Q${x.s}`] = x;
  return quarters.map(x => {
    if (!x) return null;
    if (x.s === 1) return { ...x };
    const prev = byKey[`${x.y}Q${x.s - 1}`];
    const d = k => (x[k] != null && prev?.[k] != null) ? +(x[k] - prev[k]).toFixed(2) : null;
    return { ...x, rev: d('rev'), ni: d('ni'), eps: d('eps'), op: d('op') };
  });
}
function finQuality(quarters, price) { // 鏡射 scripts/backtest-finreports.mjs（回測定案版）
  const raw = quarters.filter(x => x && (x.eps != null || x.rev != null));
  if (raw.length < 4) return null;
  const q = finToSingles(raw);
  const eps = i => q[i]?.eps;
  const ttmEps = [0, 1, 2, 3].every(i => eps(i) != null) ? +([0, 1, 2, 3].reduce((s, i) => s + eps(i), 0)).toFixed(2) : null;
  let profit = 0;
  if (ttmEps != null && ttmEps > 0) profit += 10;
  const nm0 = q[0]?.nm; if (nm0 != null) profit += nm0 >= 10 ? 10 : nm0 >= 5 ? 5 : 0;
  const ttmNi = [0, 1, 2, 3].every(i => q[i]?.ni != null) ? [0, 1, 2, 3].reduce((s, i) => s + q[i].ni, 0) : null;
  const roe = ttmNi != null && q[0]?.equity > 0 ? ttmNi / q[0].equity * 100 : null;
  if (roe != null) profit += roe > 15 ? 10 : roe > 8 ? 6 : roe > 0 ? 3 : 0;
  let growth = 0;
  const yoy = i => (eps(i) != null && eps(i + 4) != null && Math.abs(eps(i + 4)) > 0.01) ? (eps(i) - eps(i + 4)) / Math.abs(eps(i + 4)) * 100 : null;
  const y0 = yoy(0); if (y0 != null) growth += y0 > 30 ? 12 : y0 > 0 ? 7 : 0;
  let streak = 0; for (let i = 0; i < 4; i++) { const y = yoy(i); if (y != null && y > 0) streak++; else break; }
  growth += streak >= 3 ? 10 : streak === 2 ? 6 : streak === 1 ? 3 : 0;
  const rev0 = q[0]?.rev, rev4 = q[4]?.rev;
  const revYoY = rev0 > 0 && rev4 > 0 ? (rev0 - rev4) / rev4 * 100 : null;
  if (revYoY != null) growth += revYoY > 20 ? 8 : revYoY > 0 ? 4 : 0;
  const lossQ = q.slice(0, 8).filter(x => x && x.eps != null && x.eps < 0).length;
  const stable = lossQ === 0 ? 20 : lossQ === 1 ? 12 : lossQ === 2 ? 6 : 0;
  const pe = ttmEps > 0 && price > 0 ? price / ttmEps : null;
  const valuation = pe == null ? 0 : pe < 10 ? 20 : pe < 15 ? 15 : pe < 20 ? 10 : pe < 30 ? 5 : 0;
  const debtRatio = q[0]?.assets > 0 && q[0]?.debt != null ? +(q[0].debt / q[0].assets * 100).toFixed(1) : null;
  return { score: profit + growth + stable + valuation, profit, growth, stable, valuation, ttmEps, pe: pe ? +pe.toFixed(1) : null, pb: q[0]?.bps > 0 && price > 0 ? +(price / q[0].bps).toFixed(2) : null, roe: roe != null ? +roe.toFixed(1) : null, epsYoY: y0 != null ? +y0.toFixed(1) : null, revYoY: revYoY != null ? +revYoY.toFixed(1) : null, streak, lossQ, debtRatio, gm: q[0]?.gm ?? null, nm: nm0 ?? null };
}
const finW = s => s == null ? 0 : s < 20 ? -3 : s < 40 ? -1 : s < 60 ? 0 : s < 80 ? 1 : 2;
// MOPS 增量抓取（單季）
const _finNum = s => { const t = String(s ?? '').replace(/,/g, '').trim(); if (!t || t === '--' || t === '-') return null; const v = parseFloat(t.replace(/^\((.*)\)$/, '-$1')); return Number.isFinite(v) ? v : null; };
function _finParse(html) {
  const rows = [];
  for (const tm of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    let header = null;
    for (const rm of tm[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...rm[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;|\s+/g, '').trim());
      if (!cells.length) continue;
      if (cells.some(c => c.includes('公司代號'))) { header = cells; continue; }
      if (header && /^\d{4}$/.test(cells[0])) rows.push({ header, cells });
    }
  }
  return rows;
}
const _finCol = (row, ...keys) => { for (const key of keys) { const i = row.header.findIndex(h => h.includes(key)); if (i >= 0) return _finNum(row.cells[i]); } return null; };
async function _finFetchQuarter(y, s) { // 回傳 {code: patch}
  const out = {};
  for (const typek of ['sii', 'otc']) {
    for (const [table, map] of [
      ['t163sb04', r => ({ rev: _finCol(r, '營業收入', '收益', '淨收益'), op: _finCol(r, '營業利益'), ni: _finCol(r, '稅後淨利', '本期淨利', '本期稅後淨利'), eps: _finCol(r, '基本每股盈餘') })],
      ['t163sb06', r => ({ gm: _finCol(r, '毛利率'), om: _finCol(r, '營業利益率'), nm: _finCol(r, '稅後純益率') })],
      ['t163sb05', r => ({ assets: _finCol(r, '資產總額', '資產總計'), debt: _finCol(r, '負債總額', '負債總計'), equity: _finCol(r, '權益總額', '權益總計'), bps: _finCol(r, '每股參考淨值') })],
    ]) {
      try {
        const r = await fetch(`https://mopsov.twse.com.tw/mops/web/ajax_${table}`, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
          body: `encodeURIComponent=1&step=1&firstin=1&off=1&isQuery=Y&TYPEK=${typek}&year=${y - 1911}&season=0${s}`,
        });
        if (!r.ok) continue;
        for (const row of _finParse(await r.text())) Object.assign((out[row.cells[0]] ||= {}), map(row));
      } catch { /* 下次再補 */ }
      await sleep(1200);
    }
  }
  return out;
}
// 現在時點應有的最新季（公布期限：Q1=5/15, Q2=8/14, Q3=11/14, 年報=3/31）
function _finExpectedQuarter(tw) {
  const y = tw.getFullYear(), m = tw.getMonth() + 1, d = tw.getDate();
  if (m > 11 || (m === 11 && d >= 15)) return [y, 3];
  if (m > 8 || (m === 8 && d >= 15)) return [y, 2];
  if (m > 5 || (m === 5 && d >= 16)) return [y, 1];
  if (m === 4 || (m === 3 && d >= 31) || m === 5) return [y - 1, 4];
  return [y - 1, 3];
}
async function computeFinReports() {
  const tw = taipei();
  const snap = await db.collection('finReports').get();
  if (snap.empty) { log('  ⚠ 財報庫：尚未回補（node scripts/backfill-finreports.mjs）'); return; }
  const docs = snap.docs.map(d => d.data());
  // 季度增量：庫內最新季 < 應有最新季 → 抓該季併入
  const [ey, es] = _finExpectedQuarter(tw);
  const sample = JSON.parse(docs[0].quartersJson || '[]');
  const hasNew = sample.some(q => q.y === ey && q.s === es && (q.eps != null || q.rev != null));
  if (!hasNew) {
    log(`  ▶ 財報增量：抓 ${ey}Q${es}（MOPS×6 請求）…`);
    const patch = await _finFetchQuarter(ey, es);
    if (Object.keys(patch).length > 300) {
      let batch = db.batch(), n = 0;
      for (const d of docs) {
        const p = patch[d.code]; if (!p) continue;
        const qs = JSON.parse(d.quartersJson || '[]').filter(q => !(q.y === ey && q.s === es));
        qs.unshift({ y: ey, s: es, ...p }); qs.length = Math.min(qs.length, 9);
        d.quartersJson = JSON.stringify(qs);
        batch.set(db.collection('finReports').doc(d.code), { ...d, updatedAt: Date.now() });
        if (++n >= 400) { await batch.commit(); batch = db.batch(); n = 0; }
      }
      if (n) await batch.commit();
      log(`  ✓ 財報增量 ${ey}Q${es}：${Object.keys(patch).length} 檔併入`);
    } else log(`  ⚠ 財報增量 ${ey}Q${es}：尚未公布或抓取不足（${Object.keys(patch).length} 檔）`);
  }
  // 每日體質摘要 finSummary/latest（供選股加權/體檢/警示）
  const quo = (await readSnapshotQuotes())?.quotes || {};
  const byCode = {}; let scored = 0;
  for (const d of docs) {
    const price = quo[d.code]?.price;
    const fq = finQuality(JSON.parse(d.quartersJson || '[]'), price > 0 ? price : 0);
    if (!fq) continue;
    byCode[d.code] = { s: fq.score, w: finW(fq.score), pe: fq.pe, pb: fq.pb, eps: fq.ttmEps, roe: fq.roe, yoy: fq.epsYoY, ryoy: fq.revYoY, stk: fq.streak, loss: fq.lossQ, dr: fq.debtRatio, gm: fq.gm, nm: fq.nm };
    scored++;
  }
  await db.collection('finSummary').doc('latest').set({ updatedAt: Date.now(), count: scored, byCodeJson: JSON.stringify(byCode) });
  // 持股基本面警示（每日一次；score<20 或 高PE+獲利衰退）
  const today = isoDate(tw);
  const premium = await getPremiumUsers();
  for (const u of premium) {
    try {
      const hd = (await db.collection('users').doc(u.id).collection('data').doc('holdings').get()).data();
      const alerts = [];
      for (const h of (hd?.holdings || [])) {
        const f = byCode[h.code]; if (!f) continue;
        const markKey = `finwarn-${u.id}-${h.code}-${today}`;
        if (_finWarned.has(markKey)) continue;
        let msg = null;
        if (f.s < 20) msg = `📉 ${h.code} ${quo[h.code]?.name || ''} 財務體質分僅 ${f.s}/100（近8季虧損${f.loss}季${f.yoy != null ? `、EPS年增${f.yoy}%` : ''}）——基本面不支撐，波段持有需謹慎`;
        else if (f.pe != null && f.pe > 60 && f.yoy != null && f.yoy < 0) msg = `📉 ${h.code} ${quo[h.code]?.name || ''} 高本益比 ${f.pe} 倍＋EPS年減 ${Math.abs(f.yoy)}%——估值與獲利背離，留意評價修正`;
        if (msg) { _finWarned.add(markKey); alerts.push({ code: h.code, name: quo[h.code]?.name || h.code, type: 'finwarn', price: quo[h.code]?.price ?? 0, threshold: 0, pnlPct: 0, message: `${msg}（財報體檢·非投資建議）`, at: Date.now() }); }
      }
      if (alerts.length) {
        const aref = db.collection('users').doc(u.id).collection('data').doc('alerts');
        const prev = ((await aref.get()).data()?.alerts) || [];
        await aref.set({ updatedAt: Date.now(), alerts: [...alerts, ...prev].slice(0, 40) });
        pushAlerts(u.id, alerts).catch(() => {});
      }
    } catch { /* per-user skip */ }
  }
  log(`✓ 財報體質 ${scored} 檔（庫 ${docs.length} 檔·最新季 ${sample[0]?.y}Q${sample[0]?.s}）`);
}
const _finWarned = new Set();

// ── 68) 盤中爆量正名榜 volSurge（量能異常·非法人）──────────────────────
// 誠實界定：即時 feed 只給累計成交量，看不到單筆/交易人身分。此榜＝「單位時間量能暴增」，
// 上市用絕對量(≥500張級)、上櫃用比例(相對自身均量)偵測，明確標「疑似大戶/量能異常·非三大
// 法人（官方法人 15:00 後公布）」，不把量能推論為法人買賣。方向僅以當下漲跌描述(急拉/急殺)。
// 作為官方資料校正前的參數依據；每日歸檔 volSurgeArchive/{date}。
let _volPrev = { date: '', at: 0, vol: {} };   // 上次快照各檔累計量(張)
let _volAvg = { date: '', map: null };          // 20日均量(張)快取
async function loadVolAvg() {
  const today = isoDate(taipei());
  if (_volAvg.date === today && _volAvg.map) return _volAvg.map;
  const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(20).get();
  const sum = {}, cnt = {};
  for (const d of snap.docs) { const x = d.data(); if (!x.closeJson) continue; const c = JSON.parse(x.closeJson); for (const code in c) { const v = c[code][1] || 0; if (v > 0) { sum[code] = (sum[code] || 0) + v; cnt[code] = (cnt[code] || 0) + 1; } } }
  const map = {}; for (const code in sum) if (cnt[code] >= 5) map[code] = sum[code] / cnt[code];
  _volAvg = { date: today, map };
  // 落地供 API 用（market-snapshot 算量能倍數/強度分），每日一次
  try { await db.collection('volAvg20').doc('latest').set({ date: today, at: Date.now(), avgJson: JSON.stringify(Object.fromEntries(Object.entries(map).map(([c, v]) => [c, Math.round(v)]))) }); } catch { /* optional */ }
  return map;
}
const VOL_SURGE_ABS = 500;   // 上市瞬間量門檻(張)
const VOL_SURGE_X = 4;        // 單位時間 per-min 量相對均量倍數
async function computeVolSurge() {
  const tw = taipei(); const mins = tw.getHours() * 60 + tw.getMinutes();
  if (!(isTradingDay(tw) && mins >= 9 * 60 && mins < 13 * 60 + 35)) return; // 盤中限定
  const snap = await readSnapshotQuotes(); if (!snap?.quotes) return;
  const q = snap.quotes; const today = isoDate(tw); const now = Date.now();
  const avg = await loadVolAvg();
  if (_volPrev.date !== today) _volPrev = { date: today, at: 0, vol: {} };
  const intervalMin = _volPrev.at ? Math.max((now - _volPrev.at) / 60000, 0.5) : 0;
  const items = [];
  for (const code in q) {
    const x = q[code];
    if (!x.live || !(x.price > 0) || !/^\d{4}$/.test(code) || code.startsWith('00')) continue;
    const todayLots = Math.round((x.volume || 0) / 1000); if (todayLots <= 0) continue;
    const prevLots = _volPrev.vol[code];
    const delta = (prevLots != null && intervalMin > 0) ? todayLots - prevLots : 0; // 本次間隔量增(張)
    if (delta <= 0) continue;
    const a = avg[code] || 0;
    const perMinAvg = a > 0 ? a / 270 : 0;                          // 常態每分量
    const rateX = (perMinAvg > 0) ? (delta / intervalMin) / perMinAvg : 0;
    const otc = x.market === 'otc';
    const surged = otc ? (rateX >= VOL_SURGE_X && delta >= 50) : (delta >= VOL_SURGE_ABS || rateX >= VOL_SURGE_X);
    if (!surged) continue;
    const chg = +(x.changePercent ?? 0);
    items.push({ code, name: (x.name || '').trim() || code, market: x.market || 'tse', price: +x.price.toFixed(2), chg: +chg.toFixed(2), surgeLots: delta, volX: a > 0 ? +(todayLots / a).toFixed(1) : null, rateX: +rateX.toFixed(1), dir: chg >= 0 ? 'up' : 'down' });
  }
  // 更新 prev（全檔）
  const vol = {}; for (const code in q) { const v = q[code]; if (v.live && v.volume > 0) vol[code] = Math.round(v.volume / 1000); }
  _volPrev = { date: today, at: now, vol };
  items.sort((a, b) => b.surgeLots - a.surgeLots);
  const top = items.slice(0, 40);
  await db.collection('volSurge').doc('latest').set({ updatedAt: now, date: today, mode: 'live', items: top });
  if (top.length) {
    const ref = db.collection('volSurgeArchive').doc(today);
    const cur = (await ref.get()).data();
    const acc = cur?.itemsJson ? JSON.parse(cur.itemsJson) : {};
    for (const it of top) { const e = acc[it.code]; if (!e || it.surgeLots > e.surgeLots) acc[it.code] = { ...it, at: now }; }
    await ref.set({ date: today, updatedAt: now, itemsJson: JSON.stringify(acc), count: Object.keys(acc).length });
    log(`✓ 盤中爆量 ${today}：${top.length} 檔（最大 ${top[0].code} +${top[0].surgeLots}張）`);
  }
}

async function computeChipPicks() {
  const snap = await db.collection('chipDaily').orderBy('date', 'desc').limit(CHIP_PICK_WIN).get();
  const win = snap.docs.map(d => { const x = d.data(); return { date: x.date, map: x.codesJson ? JSON.parse(x.codesJson) : {} }; });
  if (!win.length) { log('  ⚠ 法人籌碼推選：chipDaily 尚無資料'); return; }
  const dataDate = win[0].date, latest = win[0].map;
  const quo = (await readSnapshotQuotes())?.quotes || {};

  // 資券借券（t-1 vs t-2）＋前 20 日高＋昨量：實證訊號 setup 與綜合評分素材
  let mgY = {}, mgY2 = {}, lnY = {}, lnY2 = {}, hi20 = {}, yVol = {}, c5map = {}, kdMap = {}, bm5Map = {}, vol20Map = {}, rsiMap = {};
  try {
    const arch = (await db.collection('chipArchive').orderBy('date', 'desc').limit(22).get()).docs.map(d => d.data());
    // 資券/借券取「最近一個有該欄位的日子」：當日歸檔 15:10 先建（僅收盤價）、
    // 資券 21:45 才回填——若盲取 arch[0] 會在 15:10~21:45 間全空（2026-07-20 實案 n=0）。
    const mgDays = arch.filter(a => a.marginJson);
    if (mgDays[0]) mgY = JSON.parse(mgDays[0].marginJson);
    if (mgDays[1]) mgY2 = JSON.parse(mgDays[1].marginJson);
    const lnDays = arch.filter(a => a.lendingJson);
    if (lnDays[0]) lnY = JSON.parse(lnDays[0].lendingJson);
    if (lnDays[1]) lnY2 = JSON.parse(lnDays[1].lendingJson);
    const maps = arch.map(a => (a.closeJson ? JSON.parse(a.closeJson) : {}));
    c5map = maps[4] || {};   // t-5 收盤（過熱懲罰 ret5 用：今日價/t-5收-1）
    const codes = new Set(); for (const m of maps) for (const k in m) codes.add(k);
    for (const c of codes) {
      let h = 0; for (let k = 0; k < Math.min(20, maps.length); k++) { const v = maps[k]?.[c]?.[0]; if (v > h) h = v; }
      hi20[c] = h; yVol[c] = maps[0]?.[c]?.[1] || 0;
    }
    // KD(9) 全市場——K>90 極度超買為實證避開訊號（screen-kd 三輪檢定，見 composite-score.ts）。
    // 口徑與 src/lib/twse-api.ts calculateKD 一致：RSV=(C−L9)/(H9−L9)×100，
    // K=⅔前K+⅓RSV、D=⅔前D+⅓K。chipArchive 列格式 [c,v,o,h,l] 有真實盤中高低。
    // 只有 22 天視窗夠不夠？夠——初始 K=50 的權重經 22 步 ⅔ 衰減後僅 (2/3)^22≈0.03%。
    const old2new = [...maps].reverse();
    for (const c of codes) {
      let K = 50, D = 50; const hs = [], ls = []; let ok = false;
      for (const m of old2new) {
        const r = m?.[c];
        if (!r || r.length < 5) continue;
        const [cl, , , hi, lo] = r;
        if (!(cl > 0 && hi > 0 && lo > 0 && hi >= lo)) continue;
        hs.push(hi); ls.push(lo);
        if (hs.length > 9) { hs.shift(); ls.shift(); }
        if (hs.length < 9) continue;
        const hn = Math.max(...hs), ln = Math.min(...ls);
        const rsv = hn === ln ? 50 : ((cl - ln) / (hn - ln)) * 100;
        K = (K * 2) / 3 + rsv / 3; D = (D * 2) / 3 + K / 3; ok = true;
      }
      if (ok) kdMap[c] = +K.toFixed(1);
      // 跌破 5 日線（收盤口徑，與回測一致）——K 80~90 配跌破 MA5 為實證避開訊號
      const cl5 = [];
      for (const m of old2new) { const r = m?.[c]; if (r?.[0] > 0) cl5.push(r[0]); }
      if (cl5.length >= 5) {
        const last5 = cl5.slice(-5);
        bm5Map[c] = cl5[cl5.length - 1] < last5.reduce((a, b) => a + b, 0) / 5;
      }
      // RSI5/RSI10（Wilder）＋ 狀態向量，供持股警報用「即時價」再推一步得到盤中 RSI。
      // 存 [rsi5, rsi10, u5, d5, u10, d10, 最後收盤]——只有前兩個給人看，後五個是
      // 讓 checkAlerts 能算出**含今日盤中價**的 RSI（只存收盤 RSI 的話，盤中飆到
      // 85 以上要等隔天才提醒，警報就失去意義）。
      if (cl5.length >= 11) {
        let u5 = 0, d5 = 0, u10 = 0, d10 = 0;
        for (let k = 1; k < cl5.length; k++) {
          const ch = cl5[k] - cl5[k - 1], g = Math.max(ch, 0), l = Math.max(-ch, 0);
          if (k <= 5) { u5 += g / 5; d5 += l / 5; } else { u5 = (u5 * 4 + g) / 5; d5 = (d5 * 4 + l) / 5; }
          if (k <= 10) { u10 += g / 10; d10 += l / 10; } else { u10 = (u10 * 9 + g) / 10; d10 = (d10 * 9 + l) / 10; }
        }
        const r6 = v => +v.toFixed(6);
        rsiMap[c] = [
          u5 + d5 > 0 ? +(u5 / (u5 + d5) * 100).toFixed(1) : 50,
          u10 + d10 > 0 ? +(u10 / (u10 + d10) * 100).toFixed(1) : 50,
          r6(u5), r6(d5), r6(u10), r6(d10), cl5[cl5.length - 1],
        ];
      }
      // 20 日已實現波動（日報酬標準差 %）——<1.5% 為實證避開訊號。
      // 檢定：十分位兩窗皆 9/9 單調、24 個控制分層全同向（見 composite-score.ts 檔尾）。
      // 22 天視窗剛好夠：需 21 根收盤算 20 個日報酬。不足 21 根者留 null（不扣分）。
      if (cl5.length >= 21) {
        const w = cl5.slice(-21), rt = [];
        for (let k = 1; k < w.length; k++) if (w[k - 1] > 0) rt.push((w[k] - w[k - 1]) / w[k - 1] * 100);
        if (rt.length >= 20) {
          const mu = rt.reduce((a, b) => a + b, 0) / rt.length;
          vol20Map[c] = +Math.sqrt(rt.reduce((a, b) => a + (b - mu) ** 2, 0) / rt.length).toFixed(2);
        }
      }
    }
    // marginSnap/latest：全市場資券借券快照（個股頁訊號條用）
    const bySnap = {};
    for (const c of codes) {
      const a = mgY[c], b = mgY2[c];
      const la = lnY[c], lb = lnY2[c];
      if (!a && la == null) continue;
      bySnap[c] = [a?.[0] ?? null, a && b ? (a[0] || 0) - (b[0] || 0) : null,
        a?.[1] ?? null, a && b ? (a[1] || 0) - (b[1] || 0) : null,
        la ?? null, la != null && lb != null ? la - lb : null,
        hi20[c] || null, yVol[c] || null, c5map[c]?.[0] ?? null, kdMap[c] ?? null, bm5Map[c] ?? null,
        vol20Map[c] ?? null, rsiMap[c] ?? null];
    }
    await db.collection('marginSnap').doc('latest').set({
      dataDate, byCodeJson: JSON.stringify(bySnap), n: Object.keys(bySnap).length, at: Date.now(),
    });
  } catch (e) { log('  ⚠ 籌碼推選 資券載入:', e.message); }

  // 籌碼性格（炒作型/一般/長期核心）：長期核心動能訊號無效（性格分割檢定 2026-07-19）
  let charBy = {};
  try { const cd = await db.collection('chipCharacter').doc('latest').get(); if (cd.exists) charBy = JSON.parse(cd.data().byCodeJson || '{}'); } catch { /* 缺分類不影響 */ }

  const items = [];
  for (const code in latest) {
    if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;      // 個股(排除 ETF)
    const q = quo[code]; const name = (q?.name || '').trim();
    if (!name) continue;                                               // 需可顯示名稱
    const f0 = latest[code][0] || 0, t0 = latest[code][1] || 0, d0 = latest[code][2] || 0;
    let fCum = 0, tCum = 0, dCum = 0;                                  // 視窗累計
    for (const w of win) { const v = w.map[code]; if (v) { fCum += v[0] || 0; tCum += v[1] || 0; dCum += v[2] || 0; } }
    let streak = 0; for (const w of win) { if ((w.map[code]?.[0] || 0) > 0) streak++; else break; }
    let fS = 0, tS = 0, dS = 0; const nS = Math.max(streak, 1);       // 連買期間累計(多日用累計判斷)
    for (let k = 0; k < nS; k++) { const v = win[k]?.map[code]; if (v) { fS += v[0] || 0; tS += v[1] || 0; dS += v[2] || 0; } }
    const useCum = streak >= 2;
    const chg = +(q?.changePercent ?? 0);
    const ph = chipPhaseTier(useCum ? fS : f0, useCum ? tS : t0, useCum ? dS : d0, streak, chg, 0);
    const dist = chipDistribution(code, win);
    items.push({
      code, name, market: q?.market || 'tse', price: q?.price ?? null, chg: +chg.toFixed(2),
      tier: ph.tier, tierLabel: ph.label, win: ph.win, netWin: ph.netWin ?? null, net: ph.net ?? null, rank: ph.rank ?? null, danger: ph.danger, streak,
      f: f0, t: t0, d: d0, foreignCum: Math.round(fCum), trustCum: Math.round(tCum), dealerCum: Math.round(dCum),
      totalCum: Math.round(fCum + tCum + dCum), distributedPct: dist.distributedPct,
      // 資券借券（t-1 餘額與日增減，張）＋實證訊號 setup
      mg: mgY[code] ? [mgY[code][0] || 0, mgY2[code] ? (mgY[code][0] || 0) - (mgY2[code][0] || 0) : 0] : null,
      sh: mgY[code] ? [mgY[code][1] || 0, mgY2[code] ? (mgY[code][1] || 0) - (mgY2[code][1] || 0) : 0] : null,
      ln: lnY[code] != null ? [lnY[code], lnY2[code] != null ? lnY[code] - lnY2[code] : 0] : null,
      sqz: !!(mgY[code] && mgY2[code] && (yVol[code] || 0) >= 300 && ((mgY[code][1] || 0) - (mgY2[code][1] || 0)) >= (yVol[code] || 0) * 0.005),
      hi20: hi20[code] || null, c5: c5map[code]?.[0] ?? null, char: charBy[code]?.label || null, k9: kdMap[code] ?? null, bm5: bm5Map[code] ?? null, vol20: vol20Map[code] ?? null,
    });
  }

  const N = CHIP_PICK_N;
  // ① 分級排行(可入場)：tier ≥ B、非危險、未大幅倒貨(<50%)
  const graded = items.filter(x => TIER_RANK[x.tier] >= 2 && !x.danger && x.distributedPct < 50)
    .sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || (b.win || 0) - (a.win || 0) || b.totalCum - a.totalCum).slice(0, N);
  // ② 個股累計總籌碼排行
  const totalCum = [...items].sort((a, b) => b.totalCum - a.totalCum).slice(0, N);
  // ③ 法人分別籌碼排行
  const byForeign = [...items].sort((a, b) => b.foreignCum - a.foreignCum).slice(0, N);
  const byTrust = [...items].sort((a, b) => b.trustCum - a.trustCum).slice(0, N);
  const byDealer = [...items].sort((a, b) => b.dealerCum - a.dealerCum).slice(0, N);
  // ④ 布局排行：外資早期卡位(連買≥2、漲幅未過度<5%、仍買、未倒貨) → 尚未噴出
  const layout = items.filter(x => x.f > 0 && x.streak >= 2 && x.chg < 5 && x.distributedPct < 40 && !x.danger)
    .sort((a, b) => b.foreignCum - a.foreignCum || b.streak - a.streak).slice(0, N);

  await db.collection('chipPicks').doc('latest').set({
    updatedAt: Date.now(), dataDate,
    counts: { graded: graded.length, layout: layout.length, universe: items.length },
    graded, totalCum, byForeign, byTrust, byDealer, layout,
  });
  log(`✓ 法人籌碼推選 ${dataDate}：可入場${graded.length}／布局${layout.length}／宇宙${items.length}`);

  // ── 全市場籌碼判讀 chipVerdicts（持倉狀態卡＋個股頁判讀共用，實證規則）──
  // 規則優先序（全部回測背書）：清倉(倒貨≥70%) > 優先減碼(外資先轉賣·95%領先) >
  // 觀望(雙賣=調節+0.32%) > 減碼(連賣) > 可加碼(S/A/B+·47-50%勝率·2年實測·未倒貨) > 續抱。
  await refreshChipMarginUp();
  const verdicts = {};
  for (const code in latest) {
    if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
    const f0 = latest[code][0] || 0, t0 = latest[code][1] || 0, d0 = latest[code][2] || 0;
    let streak = 0; for (const w of win) { if ((w.map[code]?.[0] || 0) > 0) streak++; else break; }
    let sellStreak = 0; for (const w of win) { if ((w.map[code]?.[0] || 0) < 0) sellStreak++; else break; }
    let cum5 = 0; for (let k = 0; k < 5 && k < win.length; k++) { const r = win[k].map[code]; if (r) cum5 += (r[0] || 0) + (r[1] || 0) + (r[2] || 0); }
    const dist = chipDistribution(code, win);
    const q2 = quo[code];
    const chg = +(q2?.changePercent ?? 0);
    const useCum = streak >= 2;
    let fS = 0, tS = 0, dS = 0; const nS = Math.max(streak, 1);
    for (let k = 0; k < nS && k < win.length; k++) { const r = win[k]?.map[code]; if (r) { fS += r[0] || 0; tS += r[1] || 0; dS += r[2] || 0; } }
    const ph = chipPhaseTier(useCum ? fS : f0, useCum ? tS : t0, useCum ? dS : d0, streak, chg, 0);
    const fLead = f0 < 0 && t0 >= 0 && cum5 >= 500;
    const both = f0 < 0 && t0 < 0;
    const marginUp = _chipMarginUp.has(code);
    let action, reason;
    const shownDist = Math.min(100, dist.distributedPct);
    if (dist.peak >= DUMP_PEAK_MIN && dist.distributedPct >= DUMP_PCT && f0 <= 0) { action = '清倉'; reason = `主力自峰值${dist.peak.toLocaleString()}張倒貨${shownDist}%且外資未回買`; }
    else if (fLead) { action = '優先減碼'; reason = `外資先轉賣${Math.abs(f0).toLocaleString()}張·投信未跟＝倒貨領先訊號(95%案例)，法人5日累計${cum5.toLocaleString()}張可倒${marginUp ? '；融資增=散戶接棒(弱)' : ''}`; }
    else if (both) { action = '觀望'; reason = `外資投信雙賣（回測多為強勢後調節、跌幅有限）${marginUp ? '；融資增(弱)' : ''}`; }
    else if (f0 < 0 && sellStreak >= 2) { action = '減碼'; reason = `外資連賣${sellStreak}日${marginUp ? '；融資增=散戶接棒(弱)' : ''}`; }
    else if (f0 < 0) { action = '留意'; reason = '外資單日轉賣，觀察是否連賣'; }
    else if (['S', 'A', 'B+'].includes(ph.tier) && dist.distributedPct < 40) { action = '可加碼'; reason = `${ph.label}·回測勝率${ph.win}%·未倒貨(${shownDist}%)`; }
    else { action = '續抱'; reason = `${ph.label}${ph.win ? `·勝率${ph.win}%` : ''}`; }
    verdicts[code] = { a: action, r: reason, tier: ph.tier, win: ph.win, dist: shownDist, f: f0, t: t0, d: d0, streak, sellStreak };
  }
  await db.collection('chipVerdicts').doc('latest').set({ updatedAt: Date.now(), dataDate, count: Object.keys(verdicts).length, byCodeJson: JSON.stringify(verdicts) });
  log(`✓ 籌碼判讀 ${dataDate}：${Object.keys(verdicts).length} 檔（清倉${Object.values(verdicts).filter(v => v.a === '清倉').length}/優先減碼${Object.values(verdicts).filter(v => v.a === '優先減碼').length}/可加碼${Object.values(verdicts).filter(v => v.a === '可加碼').length}）`);

  // ── 法人加碼統計 accum（盤中戰情「法人籌碼推選」第5子分頁）─────────────
  // 實證錨點(444 episode)：中位加碼 5,176 張(3倍日均量)、布局 28 日、漲 21% 後倒貨。
  // 「倒貨風險進度」＝ max(期間漲幅/21%, 加碼量/3倍日均量) → 越接近實證倒貨點越高。
  // 誠實：法人加碼≠漲停訊號(實證：漲停前法人買超佔比58% vs 基準48%)，3月板數僅供參考。
  const win60 = await loadChipWindow(60);
  const arch60 = await loadLuArchive(); // [close,vol,(o,h,l)] 舊→新
  const pxByDate = {}; for (const d of arch60) pxByDate[d.date] = d.close;
  const accum = [];
  if (win60.length >= 20) {
    const asc = [...win60].reverse(); // 舊→新
    for (const code in latest) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const q3 = quo[code]; const name = (q3?.name || '').trim(); if (!name) continue;
      // 累計序列 + 買超天數
      let cum = 0, buyDays = 0; const series = [];
      for (const w of asc) { const r = w.map[code]; const nv = r ? (r[0] || 0) + (r[1] || 0) + (r[2] || 0) : 0; if (nv > 0) buyDays++; cum += nv; series.push({ date: w.date, cum, net: nv }); }
      const cur = series[series.length - 1].cum;
      // 目前布局段：全期累計低點 → 現在
      let minI = 0; for (let i = 1; i < series.length; i++) if (series[i].cum < series[minI].cum) minI = i;
      const added = cur - series[minI].cum;
      if (added < 1000) continue;                       // 需實質加碼
      // 未倒貨（仍在布局）：現值 ≥ 峰值 70%
      let peak = -Infinity; for (const s of series) peak = Math.max(peak, s.cum);
      if (peak > 0 && cur < peak * 0.7) continue;
      // 日均量 + 期間漲幅 + 加碼價金
      let vSum = 0, vN = 0;
      for (let k = arch60.length - 20; k < arch60.length; k++) { const r = arch60[k]?.close[code]; if (r && r[1] > 0) { vSum += r[1]; vN++; } }
      const avgV = vN >= 10 ? vSum / vN : 0; if (avgV < 200) continue;
      const p0 = pxByDate[series[minI].date]?.[code]?.[0], p1 = q3?.price || pxByDate[series[series.length - 1].date]?.[code]?.[0];
      if (!(p0 > 0) || !(p1 > 0)) continue;
      const rise = (p1 - p0) / p0 * 100;
      let valueE8 = 0; // 加碼價金(億)：Σ 淨買×當日收盤
      for (let i = minI + 1; i < series.length; i++) { const px2 = pxByDate[series[i].date]?.[code]?.[0]; if (px2 > 0 && series[i].net > 0) valueE8 += series[i].net * 1000 * px2; }
      valueE8 = +(valueE8 / 1e8).toFixed(1);
      const days = series.length - 1 - minI;
      const riseProg = Math.min(150, Math.round(rise / 21 * 100));
      const volProg = Math.min(150, Math.round(added / (avgV * 3) * 100));
      const dumpRisk = Math.max(riseProg, volProg);
      const stage = dumpRisk >= 80 ? '後期(接近實證倒貨點)' : dumpRisk >= 50 ? '中期' : '初期';
      // 3月板數（資訊·非因果）
      let lu60c = 0; for (let k = 1; k < arch60.length; k++) { const a = arch60[k].close[code]?.[0], b = arch60[k - 1].close[code]?.[0]; if (a > 0 && b > 0 && luIsLimitUp(a, b)) lu60c++; }
      accum.push({ code, name, market: q3?.market || 'tse', price: +(+p1).toFixed(2), added: Math.round(added), addedXVol: avgV > 0 ? +(added / avgV).toFixed(1) : null, valueE8, buyDays, days, rise: +rise.toFixed(1), dumpRisk, stage, lu60: lu60c });
    }
    accum.sort((a, b) => b.added - a.added);
  }
  await db.collection('chipPicks').doc('latest').set({ accum: accum.slice(0, 40), accumAnchor: { addLots: 5176, addXVol: 3, days: 28, risePct: 21 } }, { merge: true });
  log(`✓ 法人布局統計：${accum.length} 檔布局中（後期 ${accum.filter(x => x.dumpRisk >= 80).length} 檔）`);
}

// ── 67) 漲停預測引擎 limitUpForecast（盤中戰情「🚀 漲停預測」分頁）──────
// 回測依據 scripts/backtest-limitup.mjs：92 日收盤庫 × 66,029 檔日 × 2,282 漲停事件，
// walk-forward 後 20 日驗證：A榜 Top10 命中 20.5%(7.6x lift)／Top30 17.0%(6.3x)。
// 模型＝分桶 lift 取 log2 加權（可解釋·確定性）。lift 權重為 2026-07 訓練期定案，
// 每日預測自動存檔對答案（scoreboard），偏離時再回測換權重。
// PIT：價量因子 = t 日收盤(盤中用即時價量)；法人 = chipDaily EOD(盤中即 t-1)。
// 消息面＝sectorForecast 看漲族群小加分(+0.5，前瞻·未回測，明確標注)。
const LU_LIFT = { // [label, predicate(升冪短路), lift]（來源：回測訓練集）
  chg0:   [['<0', v => v < 0, 0.68], ['0~3', v => v < 3, 0.59], ['3~7', v => v < 7, 1.66], ['7~9.5', v => v < 9.5, 2.62], ['已漲停', () => true, 6.57]],
  ret5:   [['5日<-3%', v => v < -3, 0.77], ['5日平淡', v => v < 3, 0.46], ['5日+3~10%', v => v < 10, 1.16], ['5日≥+10%', () => true, 3.29]],
  ret20:  [['20日跌', v => v < 0, 0.47], ['20日+0~10%', v => v < 10, 0.64], ['20日+10~25%', v => v < 25, 1.54], ['20日≥+25%', () => true, 3.13]],
  volX:   [['量縮', v => v < 1, 0.75], ['量平', v => v < 2, 1.05], ['量增2-4x', v => v < 4, 2.03], ['爆量≥4x', () => true, 2.68]],
  nearHi: [['距高>10%', v => v < -10, 1.01], ['距高2~10%', v => v < -2, 0.63], ['貼近前高', v => v < 0, 0.73], ['創20日新高', () => true, 2.48]],
  luCnt5: [['5日無板', v => v === 0, 0.63], ['5日1板', v => v === 1, 2.81], ['5日≥2板', () => true, 4.76]],
  fShare: [['外資賣超', v => v < 0, 0.90], ['外資小買', v => v < 5, 1.35], ['外資佔量5-15%', v => v < 15, 1.32], ['外資重倉', () => true, 0.86]],
  t0:     [['投信未買', v => v <= 0, 0.91], ['投信買超', () => true, 1.76]],
  // 3個月漲停/族群風向因子（2026-07 變體回測：三因子×0.3 阻尼 → Top10 20.5%→21.5%(8.0x)；
  // 阻尼抑制與 luCnt5/ret20 的相關重複計分，全權重反而 Top10 降）
  luCnt60: [['3月無板', v => v === 0, 0.30], ['3月1-2板', v => v <= 2, 1.21], ['3月3-5板', v => v <= 5, 2.18], ['3月≥6板', () => true, 2.93]],
  indLU5:  [['族群冷', v => v === 0, 0.22], ['族群1-4板', v => v < 5, 0.55], ['族群5-14板', v => v < 15, 1.14], ['族群≥15板', () => true, 1.84]],
  indHot:  [['非熱門族群', v => v === 0, 0.67], ['top3熱門族群', () => true, 1.91]],
  // 消息面(newsDaily 22日校準：≥2則1.57x/正面1.64x；7日邊際驗證未見改善——內生性
  // (新聞多在報導已漲停股)。依使用者指示以 0.3 阻尼納入，scoreboard 持續對答案再定去留)
  newsN:   [['無新聞', v => v === 0, 0.98], ['新聞1則', v => v === 1, 1.22], ['新聞≥2則', () => true, 1.57]],
  newsPol: [['負面新聞', v => v <= -1, 0.98], ['新聞中性', v => v === 0, 0.99], ['正面新聞', () => true, 1.64]],
};
const LU_NEW_SCALE = { luCnt60: 0.3, indLU5: 0.3, indHot: 0.3, newsN: 0.3, newsPol: 0.3 }; // 新因子阻尼(回測選定)
// 連板持續乘數（訓練基準 24.9%；驗證基準 21.5% → 用保守 22 起算）
const LU_CONT_BASE = 22;
const LU_CONT = {
  luCnt5: v => v >= 2 ? 1.16 : 0.88,                                   // 連2板以上續、首板易斷
  volX:   v => v < 1 ? 1.17 : v < 2 ? 1.04 : v < 4 ? 0.95 : 0.75,      // 縮量鎖死續、爆量出貨斷
  fShare: v => v < 0 ? 1.20 : v < 5 ? 0.90 : v < 15 ? 1.04 : 0.85,
  streak: v => v === 0 ? 1.25 : v <= 2 ? 0.91 : 0.88,
};
const luBucket = (k, v) => { if (v == null) return null; for (const [label, fn, lift] of LU_LIFT[k]) if (fn(v)) return { label, lift }; return null; };
const luTick = p => p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5;
const luLimitPrice = pc => { const t = luTick(pc); return +(Math.floor(pc * 1.1 / t) * t).toFixed(2); };
const luIsLimitUp = (c, pc) => pc > 0 && c > 0 && c >= luLimitPrice(pc) - 1e-9;

// ── 每日新聞庫 newsDaily（鉅亨標題→個股提及/極性；漲停預測消息因子＋逐日存檔）──
// 歷史回補：scripts/backfill-news.mjs。此函式每日/盤中(15分節流)更新當日文件。
const LU_POS = /漲停|大漲|飆|急拉|創新高|新高|報喜|樂觀|看好|急單|大單|接單暢旺|營收創|獲利創|上修|調升|買超|加碼|轉盈|旺季|受惠|吃補|噴/;
const LU_NEG = /跌停|大跌|重挫|急殺|創新低|警示|處置|注意股|下修|調降|賣超|示警|虧損|衰退|轉虧|停工|裁員|利空|降評|砍單|失守/;
let _newsDailyAt = 0;
async function computeNewsDaily() {
  if (Date.now() - _newsDailyAt < 15 * 60000) return; // 盤中節流
  const tw = taipei(); const today = isoDate(tw);
  const all = await getAllMarketCodes();
  const codesSet = new Set(all.map(c => c.code));
  const nameEntries = all.filter(c => (c.name || '').length >= 2).map(c => [c.name.trim(), c.code]).sort((a, b) => b[0].length - a[0].length);
  const startAt = Math.floor(Date.now() / 1000) - 36 * 3600; // 近36h，取台北日=今日者
  let titles = 0; const mentions = {};
  for (let page = 1; page <= 8; page++) {
    const r = await fetch(`https://api.cnyes.com/media/api/v1/newslist/category/tw_stock?startAt=${startAt}&endAt=${Math.floor(Date.now() / 1000)}&limit=30&page=${page}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) break;
    const j = await r.json(); const items = j?.items?.data || [];
    if (!items.length) break;
    for (const it of items) {
      const iso = new Date((it.publishAt + 8 * 3600) * 1000).toISOString().slice(0, 10);
      if (iso !== today) continue;
      titles++;
      const title = it.title || '';
      const pol = (LU_POS.test(title) ? 1 : 0) - (LU_NEG.test(title) ? 1 : 0);
      const hit = new Set();
      for (const m of title.matchAll(/\b(\d{4})\b/g)) if (codesSet.has(m[1])) hit.add(m[1]);
      for (const [name, code] of nameEntries) if (title.includes(name)) hit.add(code);
      for (const code of hit) { const m = (mentions[code] ||= [0, 0]); m[0]++; m[1] += pol; }
    }
    if (page >= (j?.items?.last_page || 1)) break;
    await sleep(250);
  }
  if (titles > 0) {
    await db.collection('newsDaily').doc(today).set({ date: today, at: Date.now(), titles, mentionsJson: JSON.stringify(mentions) });
    log(`✓ 新聞庫 ${today}：${titles} 則、提及 ${Object.keys(mentions).length} 檔`);
  }
  _newsDailyAt = Date.now();
}

// ── 洗盤監測器 washoutMonitor（實測校準版·年度風險提醒技能）──────────────
// 依 WASHOUT_SKILL 實測結論：修正<5%=正常、5~15%=歷史洗盤區間(降槓桿不接刀)、
// >15%=超出全部歷史洗盤範圍(空頭劇本防禦，2024/7反例)。洗完確認四訊號：
// 外資轉連買/量縮後放量收紅/站回月線/融資止穩，≥2成立=確認中。階段轉換時推播。
async function computeWashoutMonitor() {
  // 加權指數近 120 日（Yahoo，每日一次）
  let px = [];
  try {
    const p1 = Math.floor(Date.now() / 1000) - 200 * 86400;
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?period1=${p1}&period2=${Math.floor(Date.now() / 1000)}&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const res = (await r.json())?.chart?.result?.[0];
    const t = res?.timestamp || [], c = res?.indicators?.quote?.[0]?.close || [];
    for (let i = 0; i < t.length; i++) if (c[i] > 0) px.push(c[i]);
  } catch { /* skip */ }
  if (px.length < 30) { log('  ⚠ 洗盤監測：指數資料不足'); return; }
  const now = px[px.length - 1];
  let hi66 = 0; for (let i = Math.max(0, px.length - 66); i < px.length; i++) hi66 = Math.max(hi66, px[i]);
  const dd = (hi66 - now) / hi66 * 100;
  const ma20 = px.slice(-20).reduce((a, b) => a + b, 0) / 20;

  // 市場融資餘額趨勢（chipArchive marginJson 全市場資餘加總）
  const arch = (await db.collection('chipArchive').orderBy('date', 'desc').limit(40).get()).docs.map(d => d.data()).filter(x => x.marginJson);
  const marginTot = arch.map(x => { const m = JSON.parse(x.marginJson); let s = 0; for (const c in m) s += m[c][0] || 0; return s; }); // 新→舊(張)
  const mNow = marginTot[0] || 0; const mPeak = Math.max(...marginTot, 1);
  const marginDrop = (mPeak - mNow) / mPeak * 100;
  const marginStable = marginTot.length >= 5 ? (marginTot[0] >= marginTot[4] * 0.995) : false;
  // 外資 5 日淨（chipDaily 全市場加總）
  const win = await loadChipWindow(5);
  const f5 = win.reduce((s, w) => { let t2 = 0; for (const c in w.map) t2 += w.map[c][0] || 0; return s + t2; }, 0);
  // 量能：全市場 5 日均量 vs 20 日均量（chipArchive closeJson 加總）
  const arch2 = (await db.collection('chipArchive').orderBy('date', 'desc').limit(20).get()).docs.map(d => d.data()).filter(x => x.closeJson);
  const volTot = arch2.map(x => { const m = JSON.parse(x.closeJson); let s = 0; for (const c in m) s += m[c][1] || 0; return s; });
  const v5 = volTot.slice(0, 5).reduce((a, b) => a + b, 0) / Math.max(Math.min(5, volTot.length), 1);
  const v20 = volTot.reduce((a, b) => a + b, 0) / Math.max(volTot.length, 1);

  // 階段判定
  let stage, advice;
  if (dd < 5) { stage = '正常波動'; advice = '距高點回檔 <5%，正常波動範圍，照既有紀律操作。'; }
  else if (dd <= 15) { stage = '洗盤區間'; advice = '回檔落在歷史洗盤區間(6.7~12.7%)——降槓桿(融資戶最優先)、不接刀、不梭哈、保留現金等確認訊號。誠實提醒：洗盤與空頭開端事前無法區分。'; }
  else { stage = '空頭警戒'; advice = '回檔已超出全部歷史洗盤範圍(>15%)——按空頭劇本防禦(2024/7與2022皆如此展開)，以保本為先。'; }
  // 洗完確認四訊號
  const signals = [];
  if (f5 > 0) signals.push('外資5日轉淨買');
  if (v5 < v20 * 0.85) signals.push('量縮中(等放量收紅)');
  else if (volTot[0] > v20 && px[px.length - 1] > px[px.length - 2]) signals.push('放量收紅');
  if (now > ma20) signals.push('站回月線');
  if (marginStable && marginDrop > 3) signals.push('融資止穩');
  const confirming = stage === '洗盤區間' && signals.filter(s => !s.includes('等放量')).length >= 2;

  const prev = (await db.collection('washoutMonitor').doc('latest').get()).data();
  await db.collection('washoutMonitor').doc('latest').set({
    updatedAt: Date.now(), date: await dataDate(), index: Math.round(now), hi66: Math.round(hi66), dd: +dd.toFixed(1),
    marginDrop: +marginDrop.toFixed(1), foreign5: Math.round(f5), volRatio: v20 > 0 ? +(v5 / v20).toFixed(2) : null,
    stage, confirming, signals, advice,
  });
  log(`✓ 洗盤監測：回檔 -${dd.toFixed(1)}%｜${stage}${confirming ? '·洗完確認中' : ''}｜融資自峰值-${marginDrop.toFixed(1)}%｜訊號[${signals.join('、')}]`);
  // 階段轉換 → 推播（年度提醒的觸發器）
  if (prev?.stage && prev.stage !== stage) {
    const premium = await getPremiumUsers();
    const al = { code: 'TAIEX', name: '加權指數', type: 'washout', price: Math.round(now), message: `🌀 大盤階段轉換：${prev.stage} → ${stage}（距高點 -${dd.toFixed(1)}%）。${advice} 非投資建議。`, at: Date.now() };
    for (const u of premium) {
      try {
        const aref = db.collection('users').doc(u.id).collection('data').doc('alerts');
        const prevA = (await aref.get()).data()?.alerts || [];
        await aref.set({ updatedAt: Date.now(), alerts: [al, ...prevA].slice(0, 40) });
        pushAlerts(u.id, [al]).catch(() => {});
      } catch { /* per-user skip */ }
    }
    log(`  🌀 階段轉換推播：${prev.stage} → ${stage}`);
  }
}

// ── 反彈出貨警示（賣在強勢處，不是崩了才叫跑）────────────────────────
// 使用者實案(2026-07-16 群創)：持股已列清倉/減碼，盤中有一波反彈——那才是出場窗口；
// 原本只有爆量下殺警示＝賣在恐慌低點。改為：出貨狀態持股 盤中自低點反彈≥1.5% 且
// 貼近盤中高點 → 📤 趁強出脫；其後自高點回落>1% → ⏬ 反彈結束·最後出場。各每日一次。
const REBOUND_MIN = 1.5;       // 自今日低點反彈幅度門檻 %
const REBOUND_NEAR_HIGH = 0.995; // 現價 ≥ 盤中高 × 此值 = 反彈進行中(貼高點)
const FADE_FROM_HIGH = 1.0;    // 高點回落 % → 最後出場提醒
let _rebState = { date: '', fired: new Map() }; // uid:code -> {stage:1|2, peak}
async function checkReboundExit() {
  const tw = taipei(); const mins = tw.getHours() * 60 + tw.getMinutes();
  if (!(isTradingDay(tw) && mins >= 9 * 60 + 5 && mins < 13 * 60 + 30)) return;
  const today = isoDate(tw);
  if (_rebState.date !== today) _rebState = { date: today, fired: new Map() };
  const snap = await readSnapshotQuotes(); if (!snap) return;
  const q = snap.quotes;
  // 出貨狀態來源：chipVerdicts（清倉/優先減碼/減碼）
  let verdicts = {};
  try { const vd = (await db.collection('chipVerdicts').doc('latest').get()).data(); if (vd?.byCodeJson) verdicts = JSON.parse(vd.byCodeJson); } catch { /* 可缺 */ }
  const EXIT_ACTIONS = new Set(['清倉', '優先減碼', '減碼']);
  const premium = await getPremiumUsers();
  for (const u of premium) {
    const uid = u.id;
    try {
      const hd = await db.collection('users').doc(uid).collection('data').doc('holdings').get();
      const holdings = hd.exists ? (hd.data().holdings || []) : []; if (!holdings.length) continue;
      const byCode = {};
      for (const h of holdings) { (byCode[h.code] ||= { qty: 0, cost: 0, name: h.name }); byCode[h.code].qty += h.quantity * 1000; byCode[h.code].cost += h.buyPrice * h.quantity * 1000; }
      const newAlerts = [];
      for (const code in byCode) {
        const x = q[code]; if (!x?.live || !(x.price > 0) || !(x.low > 0) || !(x.high > 0)) continue;
        const v = verdicts[code];
        const avgCost = byCode[code].cost / Math.max(byCode[code].qty, 1);
        const pnlPct = avgCost > 0 ? (x.price - avgCost) / avgCost * 100 : 0;
        const exitBias = (v && EXIT_ACTIONS.has(v.a)) || pnlPct <= -8; // 籌碼出貨狀態 或 深虧
        if (!exitBias) continue;
        const name = byCode[code].name || x.name || code;
        const key = `${uid}:${code}`;
        const st = _rebState.fired.get(key);
        const bounce = (x.price - x.low) / x.low * 100;
        const reason = v && EXIT_ACTIONS.has(v.a) ? `籌碼判讀「${v.a}」(${(v.r || '').slice(0, 24)})` : `持倉虧損 ${pnlPct.toFixed(1)}%`;
        if (!st && bounce >= REBOUND_MIN && x.price >= x.high * REBOUND_NEAR_HIGH) {
          // 階段1：反彈進行中、貼近盤中高 → 趁強出脫
          _rebState.fired.set(key, { stage: 1, peak: x.high });
          newAlerts.push({ code, name, type: 'rebound', price: x.price, message: `📤 ${code} ${name} 反彈出貨窗口：自今日低點反彈 ${bounce.toFixed(1)}%（現價 ${x.price}，貼近盤中高點）。${reason}——建議趁強分批出脫，別等回落。非投資建議。`, at: Date.now() });
        } else if (st?.stage === 1) {
          const peak = Math.max(st.peak, x.high); st.peak = peak;
          if (x.price <= peak * (1 - FADE_FROM_HIGH / 100)) {
            // 階段2：反彈結束回落 → 最後出場
            st.stage = 2;
            newAlerts.push({ code, name, type: 'rebound', price: x.price, message: `⏬ ${code} ${name} 反彈結束回落中（高點 ${peak} → 現價 ${x.price}）。${reason}——最後出場窗口，避免回到低點賠更多。非投資建議。`, at: Date.now() });
          }
        }
      }
      if (newAlerts.length) {
        const aref = db.collection('users').doc(uid).collection('data').doc('alerts');
        const prev = (await aref.get()).data()?.alerts || [];
        await aref.set({ updatedAt: Date.now(), alerts: [...newAlerts, ...prev].slice(0, 40) });
        pushAlerts(uid, newAlerts).catch(() => {});
        for (const a of newAlerts) log(`  📤 ${uid.slice(0, 6)} ${a.message.slice(0, 70)}`);
      }
    } catch { /* per-user skip */ }
  }
}

// 盤中漲停順序流：記錄每檔「首次鎖停時間」（daemon 每分掃描；重啟自 latest 文件回補）
let _luFlow = { date: '', seen: new Map() }; // code -> {time, ind}
let _luArch = { at: 0, days: null }; // chipArchive 視窗快取（盤中每分呼叫，10 分重載）
async function loadLuArchive() {
  if (_luArch.days && Date.now() - _luArch.at < 10 * 60000) return _luArch.days;
  // ⚠多取 12 天再切 62：歸檔偶有空洞（例：2026-07-10 被 fix-archive-dates 清掉 closeJson），
  //   若只取 62 筆，任何一天壞掉就永遠湊不到 62，下游 `arch.length < 62` 會整個功能靜默停擺。
  const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(74).get(); // 62日：3個月漲停統計因子
  const days = snap.docs.map(d => { const x = d.data(); return x.closeJson ? { date: x.date, close: JSON.parse(x.closeJson) } : null; })
    .filter(x => x && Object.keys(x.close).length > 500).slice(0, 62).reverse(); // 新→舊取62 → 轉舊→新
  _luArch = { at: Date.now(), days };
  return days;
}

async function computeLimitUpForecast() {
  const arch = await loadLuArchive();
  if (arch.length < 22) { log('  ⚠ 漲停預測：chipArchive 不足'); return; }
  const tw = taipei(); const mins = tw.getHours() * 60 + tw.getMinutes();
  const liveWindow = isTradingDay(tw) && mins >= 9 * 60 && mins < 13 * 60 + 35;
  const quo = (await readSnapshotQuotes())?.quotes || {};
  const nameOfQ = c => ((quo[c]?.name || '').trim() || c);

  // 序列：盤後＝archive 全段(末日=今日，預測明日)；盤中＝archive(至昨日)+即時偽日(預測今日收盤)
  let series = arch; let mode = 'close';
  if (liveWindow) {
    // 快照＝MIS即時(約200檔)＋輪掃混合：不限 q.live（舊條件>500檔永不成立→盤中從不更新）。
    // 未及輪掃者價格≈昨收＝視為平盤，隨每分鐘輪掃自然收斂到全市場即時。
    const liveClose = {};
    for (const c in quo) { const q = quo[c]; if (q.price > 0) liveClose[c] = [q.price, Math.round((q.volume || 0) / 1000)]; }
    if (Object.keys(liveClose).length > 500 && arch[arch.length - 1].date !== isoDate(tw)) {
      series = [...arch, { date: isoDate(tw), close: liveClose }]; mode = 'live';
    }
  }
  const n = series.length; const t = n - 1; const today = series[t], prev = series[t - 1];
  // 法人（EOD，盤中即 t-1）＋題材看漲族群（前瞻加分）
  const instWin = await loadChipWindow(8);
  const inst = instWin[0]?.map || {};
  const streakOf = c => { let s = 0; for (const w of instWin) { if ((w.map[c]?.[0] || 0) > 0) s++; else break; } return s; };
  let bullishSet = new Set(), indMap = {};
  try { indMap = await getIndustryMap(); } catch { /* 族群因子可缺 */ }
  try {
    const fc = (await db.collection('sectorForecast').doc('latest').get()).data();
    if (fc?.bullish?.length) bullishSet = new Set(fc.bullish.map(b => b.sector));
  } catch { /* 前瞻加分可缺 */ }
  // 消息面：當日(資料日)新聞提及/極性（newsDaily，缺文件時全 0 → 中性桶，無傷）
  let newsMap = {};
  try { const nd = (await db.collection('newsDaily').doc(today.date).get()).data(); if (nd?.mentionsJson) newsMap = JSON.parse(nd.mentionsJson); } catch { /* 可缺 */ }
  // 每日漲停集合（3個月統計/族群風向因子，全部 ≤t，PIT 安全）
  const luSets = [null]; // k 對 k-1
  for (let k = 1; k < n; k++) {
    const set = new Set();
    for (const c in series[k].close) { const p = series[k - 1].close[c]?.[0]; if (p && luIsLimitUp(series[k].close[c][0], p)) set.add(c); }
    luSets.push(set);
  }
  const mktLU = luSets[t]?.size || 0; // 今日市場漲停家數
  // 個股 3 個月(≤60日)漲停次數 + 族群 5 日熱度/top3
  const lu60 = {}; for (let k = Math.max(1, t - 59); k <= t; k++) for (const c of luSets[k]) lu60[c] = (lu60[c] || 0) + 1;
  const indCnt5 = {}, indCntPrev5 = {}, indCnt60 = {};
  for (let k = Math.max(1, t - 4); k <= t; k++) for (const c of luSets[k]) { const ind = indMap[c]; if (ind) indCnt5[ind] = (indCnt5[ind] || 0) + 1; }
  for (let k = Math.max(1, t - 9); k <= t - 5; k++) for (const c of luSets[k]) { const ind = indMap[c]; if (ind) indCntPrev5[ind] = (indCntPrev5[ind] || 0) + 1; }
  for (const [c, cnt] of Object.entries(lu60)) { const ind = indMap[c]; if (ind) indCnt60[ind] = (indCnt60[ind] || 0) + cnt; }
  const hotTop3 = new Set(Object.entries(indCnt5).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]));

  // ── 族群輪動轉換：每日冠軍族群序列 → 歷史轉換矩陣（誠實：~60日樣本小，僅統計參考）──
  const dayTop = []; // 每日漲停冠軍族群（至少3板才算冠軍，濾雜訊）
  for (let k = 1; k < n; k++) {
    const c = {}; for (const code of luSets[k]) { const ind = indMap[code]; if (ind) c[ind] = (c[ind] || 0) + 1; }
    const topE = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
    dayTop.push(topE && topE[1] >= 3 ? topE[0] : null);
  }
  const trans = {}; let pv = null;
  for (const cur of dayTop) { if (!cur) continue; if (pv && cur !== pv) { (trans[pv] ??= {}); trans[pv][cur] = (trans[pv][cur] || 0) + 1; } pv = cur; }
  const curTop = [...dayTop].reverse().find(x => x) || null;
  let curStreak = 0; for (let k = dayTop.length - 1; k >= 0 && dayTop[k] === curTop; k--) curStreak++;
  const nextLikely = curTop && trans[curTop]
    ? Object.entries(trans[curTop]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([ind, cnt]) => ({ ind, n: cnt }))
    : [];
  const heating = Object.entries(indCnt5).filter(([ind, c5]) => c5 >= 3 && c5 >= (indCntPrev5[ind] || 0) * 1.5)
    .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([ind, c5]) => ({ ind, cnt5: c5, prev5: indCntPrev5[ind] || 0 }));

  // ── 今日漲停順序流（盤中每分記錄首次鎖停時間；重啟自 latest 回補）──
  const todayIso = isoDate(tw);
  if (_luFlow.date !== todayIso) {
    _luFlow = { date: todayIso, seen: new Map() };
    try {
      const old = (await db.collection('limitUpForecast').doc('latest').get()).data();
      if (old?.flowDate === todayIso) for (const f of (old.flow || [])) _luFlow.seen.set(f.code, f);
    } catch { /* 回補可缺 */ }
  }
  if (mode === 'live') {
    const hhmm = `${String(tw.getHours()).padStart(2, '0')}:${String(tw.getMinutes()).padStart(2, '0')}`;
    for (const c of luSets[t]) if (!_luFlow.seen.has(c)) _luFlow.seen.set(c, { code: c, name: nameOfQ(c), time: hhmm, ind: indMap[c] || null });
  }
  const flow = [..._luFlow.seen.values()].sort((a, b) => a.time.localeCompare(b.time));
  let igniting = []; // 最近30分鎖停族群＝此刻正在發動
  if (mode === 'live') {
    const nowM = tw.getHours() * 60 + tw.getMinutes(); const cnt = {};
    for (const f of flow) { const [h, m] = f.time.split(':').map(Number); if (nowM - (h * 60 + m) <= 30 && f.ind) cnt[f.ind] = (cnt[f.ind] || 0) + 1; }
    igniting = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([ind, c]) => ({ ind, n: c }));
  }
  const rotation = { current: curTop, streak: curStreak, nextLikely, heating, igniting, transDays: dayTop.filter(Boolean).length };

  const aList = [], bList = [];
  for (const code in today.close) {
    if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
    const [c0, v0] = today.close[code];
    const pc = prev.close[code]?.[0];
    if (!(c0 > 0) || !(pc > 0) || c0 < 5) continue;
    // live 防呆：隱含漲跌幅超出台股 ±10% 上限（含tick容差）＝歸檔昨收與官方昨收錯位
    // （除權息參考價/OTC資料異常），此檔當日資料不可信，跳過不入榜。
    if (mode === 'live' && Math.abs((c0 - pc) / pc * 100) > 11) continue;
    let vSum = 0, vN = 0, hi20 = 0;
    for (let k = t - 20; k < t; k++) { const r = series[k]?.close[code]; if (!r) continue; vSum += r[1] || 0; vN++; if (r[0] > hi20) hi20 = r[0]; }
    const avgV = vN >= 10 ? vSum / vN : 0;
    if (avgV < 100) continue; // 流動性濾網
    let luCnt5 = 0;
    for (let k = t - 4; k <= t; k++) { const p = series[k - 1]?.close[code]?.[0], c = series[k]?.close[code]?.[0]; if (p && c && luIsLimitUp(c, p)) luCnt5++; }
    const c20 = series[t - 20]?.close[code]?.[0], c5 = series[t - 5]?.close[code]?.[0];
    const row = inst[code];
    const ind = indMap[code] || null;
    const feats = {
      chg0: (c0 - pc) / pc * 100,
      ret5: c5 > 0 ? (c0 - c5) / c5 * 100 : null,
      ret20: c20 > 0 ? (c0 - c20) / c20 * 100 : null,
      volX: avgV > 0 ? (v0 || 0) / avgV : 0,
      nearHi: hi20 > 0 ? (c0 / hi20 - 1) * 100 : null,
      luCnt5,
      fShare: v0 > 0 ? (row?.[0] ?? 0) / v0 * 100 : 0,
      t0: row?.[1] ?? 0,
      luCnt60: lu60[code] || 0,
      indLU5: ind ? (indCnt5[ind] || 0) : 0,
      indHot: ind && hotTop3.has(ind) ? 1 : 0,
      newsN: newsMap[code]?.[0] || 0,
      newsPol: newsMap[code]?.[1] || 0,
    };
    let score = 0; const reasons = [];
    for (const k in LU_LIFT) {
      const b = luBucket(k, feats[k]); if (!b) continue;
      const scale = LU_NEW_SCALE[k] || 1;
      score += Math.log2(Math.max(b.lift, 0.1)) * scale;
      if (b.lift >= 1.5) reasons.push(`${b.label}(${b.lift.toFixed(1)}x)`);
    }
    let newsBonus = false;
    if (bullishSet.size && bullishSet.has(indMap[code])) { score += 0.5; newsBonus = true; }
    const q = quo[code];
    const name = (q?.name || '').trim() || code;
    const item = {
      code, name, market: q?.market || 'tse', price: +c0.toFixed(2), chg: +feats.chg0.toFixed(2),
      score: +score.toFixed(2), reasons: reasons.slice(0, 5), newsBonus,
      volX: +feats.volX.toFixed(1), luCnt5, limitPrice: luLimitPrice(c0),
    };
    aList.push(item);
    // B 榜：今日(即時)已漲停 → 連板持續評估
    if (luIsLimitUp(c0, pc)) {
      const streak = streakOf(code);
      let est = LU_CONT_BASE;
      for (const k in LU_CONT) est *= LU_CONT[k](k === 'streak' ? streak : feats[k]);
      est = Math.max(5, Math.min(55, Math.round(est)));
      bList.push({
        code, name, market: q?.market || 'tse', price: +c0.toFixed(2), est, luCnt5,
        volX: +feats.volX.toFixed(1), fShare: +feats.fShare.toFixed(1), streak,
        tag: est >= 28 ? '高' : est >= 20 ? '中' : '低',
        note: `${luCnt5 >= 2 ? `連${luCnt5}板` : '首板'}·${feats.volX < 1 ? '縮量鎖死' : feats.volX >= 4 ? '爆量(出貨警戒)' : '量能正常'}`,
      });
    }
  }
  aList.sort((a, b) => b.score - a.score);
  bList.sort((a, b) => b.est - a.est);
  const top = aList.slice(0, 30);

  // 盤後：存預測檔＋對答案（scoreboard，只在新資料日執行一次）
  let scoreboard = null;
  try { scoreboard = (await db.collection('limitUpForecast').doc('scoreboard').get()).data() || { history: [] }; } catch { scoreboard = { history: [] }; }
  if (mode === 'close') {
    const dataDate = today.date;
    const predRef = db.collection('limitUpForecast').doc(`pred-${dataDate}`);
    if (!(await predRef.get()).exists) {
      await predRef.set({
        dataDate, at: Date.now(), codes: top.map(x => x.code), bCodes: bList.map(x => ({ code: x.code, est: x.est })),
        ranks: Object.fromEntries(aList.slice(0, 120).map((x, i) => [x.code, i + 1])), // 覆盤用：前120名排名
      });
      // 對前一份預測檔評分：其 Top 名單在「今日」實際漲停幾檔
      const prevPreds = await db.collection('limitUpForecast').where('dataDate', '<', dataDate).orderBy('dataDate', 'desc').limit(1).get();
      const pd = prevPreds.docs[0]?.data();
      if (pd && !(scoreboard.history || []).some(h => h.date === dataDate)) {
        const actual = new Set();
        for (const c in today.close) { const p = prev.close[c]?.[0]; if (p && luIsLimitUp(today.close[c][0], p)) actual.add(c); }
        const hit = k => pd.codes.slice(0, k).filter(c => actual.has(c)).length;
        const bHit = (pd.bCodes || []).filter(x => actual.has(x.code)).length;
        // ── 覆盤：預測失敗原因＋漏網漲停原因（全部確定性標注）──
        const indCnt5Y = {}; // 昨日視角的族群5日熱度（退潮判定）
        for (let k = Math.max(1, t - 5); k <= t - 1; k++) for (const c of luSets[k]) { const ind = indMap[c]; if (ind) indCnt5Y[ind] = (indCnt5Y[ind] || 0) + 1; }
        const mktWeak = mktLU < (luSets[t - 1]?.size || 0) * 0.7; // 今日市場漲停家數銳減
        const failed = [];
        for (const c of pd.codes) {
          if (actual.has(c)) continue;
          const cT = today.close[c]?.[0], cP = prev.close[c]?.[0];
          const chg = cT > 0 && cP > 0 ? (cT - cP) / cP * 100 : null;
          const ind = indMap[c] || null;
          const tags = [];
          if (chg == null) tags.push('無成交資料');
          else if (chg >= 5) tags.push('強漲未鎖停');
          else if (chg >= 0) tags.push('上漲乏力');
          else tags.push('翻黑回檔');
          if (ind && (indCnt5[ind] || 0) < (indCnt5Y[ind] || 0) * 0.6) tags.push('族群退潮');
          if (mktWeak) tags.push('市場轉弱');
          failed.push({ code: c, name: nameOfQ(c), ind, chg: chg == null ? null : +chg.toFixed(2), tags });
        }
        const missed = [];
        for (const c of actual) {
          if (pd.codes.includes(c)) continue;
          if (!/^\d{4}$/.test(c) || c.startsWith('00')) continue;
          const rank = pd.ranks?.[c] || null;
          const cP1 = prev.close[c]?.[0], cP2 = series[t - 2]?.close[c]?.[0];
          const chgY = cP1 > 0 && cP2 > 0 ? (cP1 - cP2) / cP2 * 100 : null; // 預測時的當日漲幅
          let cnt60 = 0; for (let k = Math.max(1, t - 60); k <= t - 1; k++) if (luSets[k]?.has(c)) cnt60++;
          let vS = 0, vN = 0; for (let k = Math.max(0, t - 21); k < t - 1; k++) { const r = series[k]?.close[c]; if (r) { vS += r[1] || 0; vN++; } }
          const avgVY = vN >= 10 ? vS / vN : 0;
          const tag = rank ? `分數達標·排名外(第${rank}名)`
            : (avgVY < 100 || (cP1 || 0) < 5) ? '流動性濾網外(低量/低價)'
            : (chgY != null && chgY < 1 && cnt60 === 0) ? '無事前訊號(突發消息型)'
            : '訊號弱(因子未達門檻)';
          missed.push({ code: c, name: nameOfQ(c), ind: indMap[c] || null, tag, prevChg: chgY == null ? null : +chgY.toFixed(2), lu60: cnt60 });
        }
        // 漏網原因統計（模型改進的依據）
        const missTally = {};
        for (const m of missed) { const k = m.tag.replace(/\(.*\)/, ''); missTally[k] = (missTally[k] || 0) + 1; }
        const review = {
          date: dataDate, predDate: pd.dataDate, at: Date.now(),
          hit10: hit(10), hit30: hit(30), actualLU: actual.size,
          hits: pd.codes.filter(c => actual.has(c)).map(c => ({ code: c, name: nameOfQ(c) })),
          failed, missed: missed.sort((a, b) => (b.lu60 || 0) - (a.lu60 || 0)).slice(0, 40), missTally,
        };
        await db.collection('limitUpForecast').doc(`review-${dataDate}`).set(review);
        scoreboard.lastReview = review;
        scoreboard.history = [{ date: dataDate, predDate: pd.dataDate, hit10: hit(10), hit30: hit(30), bTotal: (pd.bCodes || []).length, bHit, actualLU: actual.size }, ...(scoreboard.history || [])].slice(0, 60);
        const h = scoreboard.history;
        scoreboard.agg = {
          days: h.length,
          hit10Rate: +(h.reduce((s, x) => s + x.hit10, 0) / Math.max(h.length * 10, 1) * 100).toFixed(1),
          hit30Rate: +(h.reduce((s, x) => s + x.hit30, 0) / Math.max(h.length * 30, 1) * 100).toFixed(1),
          contRate: +(h.reduce((s, x) => s + x.bHit, 0) / Math.max(h.reduce((s, x) => s + x.bTotal, 0), 1) * 100).toFixed(1),
        };
        await db.collection('limitUpForecast').doc('scoreboard').set(scoreboard);
      }
    }
  }

  // 3個月漲停統計＋族群風向榜（確定性統計，供 UI「📊 統計·風向」）
  const kings = Object.entries(lu60).filter(([c]) => /^\d{4}$/.test(c) && !c.startsWith('00'))
    .sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([c, cnt]) => ({ code: c, name: nameOfQ(c), n: cnt, ind: indMap[c] || null, isKing: cnt >= 6 }));
  const indRank = Object.entries(indCnt60).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([ind, cnt]) => ({ ind, n: cnt }));
  const wind = Object.entries(indCnt5).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([ind, c5]) => {
    const p5 = indCntPrev5[ind] || 0;
    return { ind, cnt5: c5, prev5: p5, trend: c5 >= p5 * 1.5 && c5 >= 5 ? '升溫' : c5 * 1.5 <= p5 ? '降溫' : '持平', hot: hotTop3.has(ind) };
  });

  await db.collection('limitUpForecast').doc('latest').set({
    updatedAt: Date.now(), mode, dataDate: today.date, mktLU,
    aList: top, bList: bList.slice(0, 40),
    stats: { windowDays: Math.min(60, n - 1), kings, indRank, wind },
    rotation, flow, flowDate: _luFlow.date,
    review: scoreboard?.lastReview || null,
    scoreboard: scoreboard?.agg ? { ...scoreboard.agg, last: (scoreboard.history || [])[0] || null } : null,
    backtest: { top10: 21.5, top30: 17.0, lift10: 8.0, base: 2.7 }, // 驗證期實測(v2 +3月漲停/族群風向·阻尼0.3)
  });
  log(`✓ 漲停預測 ${mode} ${today.date}：A榜${top.length}(最高分${top[0]?.score ?? '—'})／B榜連板${bList.length}／市場漲停${mktLU}家／漲停王 ${kings[0]?.code ?? '—'}×${kings[0]?.n ?? 0}／熱門族群 ${[...hotTop3].join('、') || '—'}`);
}

// ── 籌碼強化的持倉出貨警示（盤中即時；法人為 t-1 脈絡，價格為即時）──────
// A1 倒貨清倉(強·持續)：主力累計倒貨≥70%(存貨<30%)  A2 外資轉賣(減碼)  A3 勝率雷達轉空
const DUMP_PCT = 70;         // 倒貨門檻%（可回測修正）
const DUMP_PEAK_MIN = 2000;  // 峰值需為「真實累積」下限(張)，濾雜訊
// 融資增加集合（最近兩個有資券資料日，資餘增>2%；散戶接棒弱訊號附註用）
let _chipMarginUp = new Set(); let _chipMarginAt = 0;
async function refreshChipMarginUp() {
  if (Date.now() - _chipMarginAt < 15 * 60000) return;
  try {
    const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(8).get();
    const mm = snap.docs.map(d => d.data()).filter(x => x.marginJson).slice(0, 2).map(x => JSON.parse(x.marginJson));
    if (mm.length === 2) {
      const s = new Set();
      for (const c in mm[0]) { const a = mm[0][c]?.[0] || 0, b = mm[1][c]?.[0] || 0; if (b > 0 && a > b * 1.02) s.add(c); }
      _chipMarginUp = s;
    }
  } catch { /* 附註可缺 */ }
  _chipMarginAt = Date.now();
}
async function checkChipHoldings() {
  const snap = await readSnapshotQuotes(); if (!snap) return;
  const q = snap.quotes;
  const today = isoDate(taipei());
  if (_chipHoldDay !== today) { _chipHoldAlerted.clear(); _chipHoldDay = today; }
  const win = await loadChipWindow(60);
  if (win.length < 5) return;
  const ctx = await getInstWeightCtx();
  const divg = (await db.collection('chipDivergence').doc('latest').get()).data() || {};
  const distributeSet = new Set((divg.distribute || []).map(x => x.code)); // 量價背離出貨
  await refreshChipMarginUp(); // 融資增加集合（散戶接棒·弱訊號附註，15分快取）
  const premium = await getPremiumUsers();
  for (const u of premium) {
    const uid = u.id;
    try {
      const hd = await db.collection('users').doc(uid).collection('data').doc('holdings').get();
      const holdings = hd.exists ? (hd.data().holdings || []) : []; if (!holdings.length) continue;
      const codes = [...new Set(holdings.map(h => h.code))];
      const newAlerts = [];
      for (const code of codes) {
        const v = ctx.latest?.[code]; if (!v) continue;         // 無法人資料略過
        const name = (holdings.find(h => h.code === code)?.name) || code;
        const f = v[0] || 0, t = v[1] || 0, d = v[2] || 0;
        const dist = chipDistribution(code, win);
        const sellStreak = foreignSellStreak(code, win);
        const diverge = distributeSet.has(code);
        const px = q[code]?.price;

        let type = null, msg = null;
        // A1 倒貨清倉（最高優先，強、持續）。需：真實累積峰值 + 倒貨≥70% + 外資目前沒在買
        // (f≤0，濾掉近期反轉重新買超者，如華通 60日淨賣但今日轉大買)
        if (dist.peak >= DUMP_PEAK_MIN && dist.distributedPct >= DUMP_PCT && f <= 0) {
          type = 'chipclear';
          const shownPct = Math.min(100, dist.distributedPct);
          const tail = dist.current <= 0
            ? `已倒貨完畢並轉為淨賣超（自累計峰值 ${dist.peak.toLocaleString()} 張）`
            : `自累計峰值 ${dist.peak.toLocaleString()} 張倒貨 ${shownPct}%（存貨剩 ${100 - shownPct}%）`;
          msg = `🚨 ${code} ${name} 主力倒貨警示：三大法人${tail}，主力出貨接近完成，強烈建議分批清倉。${px ? `現價 ${px}。` : ''}此為主力籌碼出貨訊號、非投資建議。`;
        }
        // A2 外資轉賣（減碼）。回測強化(120日)：444 倒貨episode 中 95% 由「外資先轉賣、
        // 投信未跟」領先；有貨在手(5日累計≥500張)時該型態後5日中位 -0.33%（唯一負值組，
        // 雙賣反而 +0.32%=調節）→「外資先轉賣＋有貨」升級為倒貨領先訊號。
        // 融資接棒為弱訊號(賣+融資增 -0.32% vs 賣+融資減 -0.17%)僅附註不觸發。
        else if (f < 0) {
          type = 'chipsell';
          let cum5 = 0; for (let k = 0; k < 5 && k < win.length; k++) { const r = win[k].map[code]; if (r) cum5 += (r[0] || 0) + (r[1] || 0) + (r[2] || 0); }
          const fLead = t >= 0 && cum5 >= 500; // 外資先跑、投信未跟、且法人有貨可倒
          const marginTag = _chipMarginUp.has(code) ? '；融資增加＝散戶接棒中(弱訊號)' : '';
          const ctxTxt = diverge ? '（法人賣、股價撐高＝量價背離出貨）' : sellStreak >= 2 ? `（外資連賣 ${sellStreak} 日）` : '';
          msg = fLead
            ? `🔻 ${code} ${name} 倒貨領先訊號：外資先轉賣 ${Math.abs(f).toLocaleString()} 張、投信未跟${ctxTxt}——回測 95% 倒貨案例由外資先跑，且法人手上仍有 ${cum5.toLocaleString()} 張(5日累計)可倒${marginTag}，建議優先減碼。三大法人(張) 外${f}/投+${t}/自${d >= 0 ? '+' : ''}${d}。非投資建議。`
            : `⚠️ ${code} ${name} 外資轉賣 ${Math.abs(f).toLocaleString()} 張${ctxTxt}${t < 0 ? '（投信同賣——回測雙賣多為強勢後調節，跌幅有限）' : ''}${marginTag}，法人退場中，建議評估減碼。三大法人(張) 外${f}/投${t >= 0 ? '+' : ''}${t}/自${d >= 0 ? '+' : ''}${d}。非投資建議。`;
        }
        // A3 勝率雷達轉空（外資雖未賣但階段轉弱—保留給散戶接棒等）
        else {
          const chg = q[code]?.changePercent ?? 0; const volLots = q[code]?.volume ? Math.round(q[code].volume / 1000) : 0;
          const p = chipPhaseTier(f, t, d, ctx.streak?.[code] || 0, chg, volLots);
          if (p.danger) { type = 'chipweak'; msg = `⚠️ ${code} ${name} 籌碼轉弱：${p.label}（勝率雷達${p.win}%），留意是否減碼。非投資建議。`; }
        }

        if (type) { const key = `${uid}:${code}:${type}`; if (_chipHoldAlerted.has(key)) continue; _chipHoldAlerted.add(key); newAlerts.push({ code, name, type, price: px || 0, message: msg, at: Date.now() }); }
      }
      if (newAlerts.length) {
        const ref = db.collection('users').doc(uid).collection('data').doc('alerts');
        const prev = (await ref.get()).data()?.alerts || [];
        await ref.set({ updatedAt: Date.now(), alerts: [...newAlerts, ...prev].slice(0, 40) });
        pushAlerts(uid, newAlerts).catch(() => {});
        for (const al of newAlerts) log(`  🔔 ${uid} ${al.message.slice(0, 60)}`);
      }
    } catch (e) { log('  ✖ chipHoldings', uid, e.message); }
  }
}

async function computeChipWind() {
  const window = await loadChipWindow(20);
  if (window.length < 1) { log('  ⚠ 籌碼風向：chipDaily 尚無資料'); return; }
  const snap = await readSnapshotQuotes();
  const q = snap?.quotes || {};
  const indMap = await getIndustryMap();
  const nameOf = c => q[c]?.name || '';
  const TF = [{ key: 'd1', n: 1, label: '當日' }, { key: 'd5', n: 5, label: '5日' }, { key: 'd20', n: 20, label: '20日' }];

  // 外資連買天數(全庫)：外資淨>0 連續
  const fStreak = {};
  { const codes = new Set(); for (const w of window) for (const c in w.map) codes.add(c);
    for (const c of codes) { let s = 0; for (const w of window) { if ((w.map[c]?.[0] || 0) > 0) s++; else break; } if (s >= 2) fStreak[c] = s; } }

  const timeframes = {};
  for (const tf of TF) {
    const win = window.slice(0, tf.n); if (!win.length) continue;
    const agg = {}; // code -> [f,t,d]
    let mf = 0, mt = 0, md = 0;
    for (const w of win) for (const c in w.map) {
      const v = w.map[c]; const a = (agg[c] ??= [0, 0, 0]);
      a[0] += v[0]; a[1] += v[1]; a[2] += v[2]; mf += v[0]; mt += v[1]; md += v[2];
    }
    const codes = Object.keys(agg);
    const tot = c => agg[c][0] + agg[c][1] + agg[c][2];
    const mk = (c, net) => ({ code: c, name: nameOf(c), net: Math.round(net), f: Math.round(agg[c][0]), t: Math.round(agg[c][1]), d: Math.round(agg[c][2]), streak: fStreak[c] || 0 });
    const foreignBuy = [...codes].sort((a, b) => agg[b][0] - agg[a][0]).slice(0, 12).filter(c => agg[c][0] > 0).map(c => mk(c, agg[c][0]));
    const foreignSell = [...codes].sort((a, b) => agg[a][0] - agg[b][0]).slice(0, 12).filter(c => agg[c][0] < 0).map(c => mk(c, agg[c][0]));
    const trustBuy = [...codes].sort((a, b) => agg[b][1] - agg[a][1]).slice(0, 12).filter(c => agg[c][1] > 0).map(c => mk(c, agg[c][1]));
    const instBuy = [...codes].sort((a, b) => tot(b) - tot(a)).slice(0, 12).filter(c => tot(c) > 0).map(c => mk(c, tot(c)));
    const instSell = [...codes].sort((a, b) => tot(a) - tot(b)).slice(0, 12).filter(c => tot(c) < 0).map(c => mk(c, tot(c)));
    // 產業籌碼傾向(三大法人合計淨額分群)
    const sec = {};
    for (const c of codes) { const ind = indMap[c] || industryOf(c, nameOf(c)); if (!ind) continue; (sec[ind] ??= { industry: ind, net: 0, n: 0 }); sec[ind].net += tot(c); sec[ind].n++; }
    const secArr = Object.values(sec).filter(s => s.n >= 2).map(s => ({ industry: s.industry, net: Math.round(s.net) }));
    const add = [...secArr].sort((a, b) => b.net - a.net).slice(0, 6).filter(s => s.net > 0);
    const reduce = [...secArr].sort((a, b) => a.net - b.net).slice(0, 6).filter(s => s.net < 0);
    timeframes[tf.key] = {
      label: tf.label, days: win.length,
      marketNet: { foreign: Math.round(mf), trust: Math.round(mt), dealer: Math.round(md), total: Math.round(mf + mt + md) },
      foreignBuy, foreignSell, trustBuy, instBuy, instSell, sectorAdd: add, sectorReduce: reduce,
    };
  }
  const payload = { updatedAt: Date.now(), latestDate: window[0].date, daysAvailable: window.length, timeframes };
  await db.collection('chipWind').doc('latest').set(payload);
  const d1 = timeframes.d1?.marketNet;
  log(`✓ 籌碼風向：${window.length}日庫，當日法人合計 ${d1 ? (d1.total >= 0 ? '+' : '') + d1.total + '張' : '—'}、外資買超首 ${timeframes.d20?.foreignBuy?.[0]?.name || '—'}`);
}

// ── 66) 量價背離偵測 chipDivergence（法人籌碼 vs 股價方向）──────────
// 核心洞見：籌碼與股價背離常領先反轉。
//  吸貨(潛在轉強)：法人5日淨買超，但股價5日下跌 → 主力低接、洗盤吸籌
//  出貨(潛在轉弱)：法人5日淨賣超，但股價5日上漲 → 主力趁高減碼、散戶追價
// 用 chipDaily(法人淨額) + chipArchive(收盤) 對齊同一 5 日窗。確定性，非投資建議。
const DIV_WIN = 5;
const DIV_MIN_LOTS = 800;   // 法人 5 日淨額門檻(張)，濾掉雜訊
const DIV_MIN_PCT = 2;      // 股價 5 日變動門檻(%)
async function computeChipDivergence() {
  const instWin = await loadChipWindow(DIV_WIN + 1); // 新→舊
  if (instWin.length < 3) { log('  ⚠ 量價背離：chipDaily 不足'); return; }
  // 收盤(chipArchive) 對齊日期
  const cArch = (await db.collection('chipArchive').orderBy('date', 'desc').limit(10).get()).docs.map(d => d.data());
  const closeByDate = {}; for (const a of cArch) if (a.closeJson) closeByDate[a.date] = JSON.parse(a.closeJson);
  const endDate = instWin[0].date;
  const startDate = instWin[Math.min(DIV_WIN, instWin.length - 1)].date;
  const cEndMap = closeByDate[endDate], cStartMap = closeByDate[startDate];
  if (!cEndMap || !cStartMap) { log(`  ⚠ 量價背離：收盤對齊缺(${endDate}/${startDate})`); return; }
  const snap = await readSnapshotQuotes(); const q = snap?.quotes || {};

  // 5 日法人淨額(三大法人合計 + 外資)
  const inst = {}; // code -> [f,t,d]
  for (const w of instWin.slice(0, DIV_WIN)) for (const c in w.map) { const v = w.map[c]; const a = (inst[c] ??= [0, 0, 0]); a[0] += v[0]; a[1] += v[1]; a[2] += v[2]; }

  const accumulate = [], distribute = []; // 吸貨 / 出貨
  for (const c in inst) {
    const cEnd = cEndMap[c]?.[0], cStart = cStartMap[c]?.[0];
    if (!(cEnd > 0 && cStart > 0)) continue;
    const instNet = inst[c][0] + inst[c][1] + inst[c][2];
    const fNet = inst[c][0];
    const pct = +(((cEnd - cStart) / cStart) * 100).toFixed(2);
    const name = q[c]?.name || '';
    const item = { code: c, name, instNet: Math.round(instNet), foreign: Math.round(fNet), pricePct: pct, close: cEnd, score: Math.round(Math.abs(instNet) * Math.abs(pct)) };
    if (instNet >= DIV_MIN_LOTS && pct <= -DIV_MIN_PCT) accumulate.push(item);       // 法人買、價跌
    else if (instNet <= -DIV_MIN_LOTS && pct >= DIV_MIN_PCT) distribute.push(item);  // 法人賣、價漲
  }
  accumulate.sort((a, b) => b.score - a.score);
  distribute.sort((a, b) => b.score - a.score);

  await db.collection('chipDivergence').doc('latest').set({
    updatedAt: Date.now(), win: DIV_WIN, startDate, endDate,
    accumulate: accumulate.slice(0, 20), distribute: distribute.slice(0, 20),
    counts: { accumulate: accumulate.length, distribute: distribute.length },
  });
  log(`✓ 量價背離(${DIV_WIN}日)：吸貨候選 ${accumulate.length}、出貨候選 ${distribute.length}`);
}

// ── 63) 第四法人：ETF 被動買賣盤影響 etfInfluence（2026-07-15）──────
// 使用者觀察：市值型 ETF(0050/006208)已成準法人力量。可靠可算的部分：
//  ① 市值排名(收盤×已發行股數)→ 0050/006208 成分近似(市值前50)＋權重
//  ② 邊緣候選股(排名~45-58)：季度調整可能納入/剔除 → 提前布局/迴避
//  ③ 季度調整行事曆(3/6/9/12月，預估生效日=該月第3個週五，官方公告為準)
//  ④ ETF 溢價申購熱潮(讀 etfPremium：溢價>1%=資金流入其成份股)
// 誠實界定：高股息型(0056/00878)成分靠殖利率篩選＋委員會，無法用市值推導、
//  TWSE 無免費成分 API → 不硬編、標「以官方成分公告為準」。市值權重為近似
//  (未做自由流通調整)，實際權重以發行商公告為準。皆確定性計算，非投資建議。
const BIGCAP_ETFS = [{ code: '0050', name: '元大台灣50', aum: '4000億+' }, { code: '006208', name: '富邦台灣50', aum: '1000億+' }];
const HIDIV_ETFS = [{ code: '0056', name: '元大高股息' }, { code: '00878', name: '國泰永續高股息' }, { code: '00919', name: '群益台灣精選高息' }];
let _sharesFeedDate = null;
let _sharesCache = { date: '', map: null };
async function getIssuedShares() {
  const today = isoDate(taipei());
  if (_sharesCache.date === today && _sharesCache.map) return _sharesCache.map;
  const map = {};
  try {
    // ⚠ 這支 opendata 沒有 rwd 對應版，只能吃 openapi（實測落後一個交易日）。
    //   但**發行股數是慢變數**（只有增資/減資/可轉債轉換才動），落後一天不影響
    //   週轉率濾網的判讀 —— 這是「知情後接受」，不是沒發現。
    //   仍讀它自報的「出表日期」記錄下來，讓稽核看得見它有多舊。
    const r = await fetch('https://openapi.twse.com.tw/v1/opendata/t187ap03_L', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (r.ok) {
      const arr = await r.json();
      _sharesFeedDate = isoFromYmd8(toYmd8(arr?.[0]?.['出表日期'])) || null;
      for (const x of arr) {
      const c = (x['公司代號'] || '').trim(); const s = (x['已發行普通股數或TDR原股發行股數'] || '').replace(/,/g, '').trim();
      if (/^\d{4}$/.test(c) && /^\d+$/.test(s)) map[c] = +s;
      }
    }
  } catch { /* skip */ }
  if (Object.keys(map).length > 500) _sharesCache = { date: today, map };
  return _sharesCache.map || map;
}
// 該月第 n 個週五(0-indexed weekday: 週五=5)
function nthWeekdayOfMonth(year, month0, weekday, n) {
  const d = new Date(Date.UTC(year, month0, 1));
  let count = 0;
  for (let day = 1; day <= 31; day++) { d.setUTCDate(day); if (d.getUTCMonth() !== month0) break; if (d.getUTCDay() === weekday) { count++; if (count === n) return new Date(d); } }
  return null;
}
function nextQuarterlyReview(tw) {
  // 3/6/9/12 月；預估生效日=該月第 3 個週五(FTSE 慣例，官方公告為準)
  const y = tw.getFullYear(); const reviewMonths = [2, 5, 8, 11]; // 0-indexed 3/6/9/12
  const todayMid = Date.UTC(y, tw.getMonth(), tw.getDate());
  for (let k = 0; k < 5; k++) {
    const yy = y + Math.floor(k / 4); const mm = reviewMonths[k % 4];
    const eff = nthWeekdayOfMonth(yy, mm, 5, 3); if (!eff) continue;
    if (Date.UTC(eff.getUTCFullYear(), eff.getUTCMonth(), eff.getUTCDate()) >= todayMid) {
      const iso = `${eff.getUTCFullYear()}-${String(eff.getUTCMonth() + 1).padStart(2, '0')}-${String(eff.getUTCDate()).padStart(2, '0')}`;
      const days = Math.round((Date.UTC(eff.getUTCFullYear(), eff.getUTCMonth(), eff.getUTCDate()) - todayMid) / 86400000);
      return { effIso: iso, days, month: mm + 1, isReviewMonth: reviewMonths.includes(tw.getMonth()) };
    }
  }
  return null;
}
async function computeEtfInfluence() {
  const tw = taipei();
  const shares = await getIssuedShares();
  if (Object.keys(shares).length < 500) { log('  ⚠ 第四法人：發行股數不足'); return; }
  const snap = await readSnapshotQuotes(); if (!snap) return;
  const q = snap.quotes;
  const mc = {}; // 市值(元)
  for (const c in shares) { const x = q[c]; const p = x?.price; if (p > 0) mc[c] = p * shares[c]; }
  const rank = Object.keys(mc).sort((a, b) => mc[b] - mc[a]);
  if (rank.length < 100) return;
  const top50 = rank.slice(0, 50); const sum50 = top50.reduce((t, c) => t + mc[c], 0);
  const nmeY = c => +(mc[c] / 1e8).toFixed(0); // 億
  const wt = c => +(mc[c] / sum50 * 100).toFixed(2);

  const constituents = top50.map((c, i) => ({ rank: i + 1, code: c, name: q[c]?.name || '', mktCapYi: nmeY(c), weight: wt(c) }));
  // 邊緣候選(排名 44-60)：接近納入/剔除門檻(50) → 季度調整可能異動
  const edge = rank.slice(43, 60).map((c, i) => ({ rank: 44 + i, code: c, name: q[c]?.name || '', mktCapYi: nmeY(c), side: (44 + i) <= 50 ? '納入邊緣(守門)' : '剔除邊緣(候補)' }));

  // ETF 溢價申購熱潮(讀 etfPremium)
  const etfP = (await db.collection('etfPremium').doc('latest').get()).data();
  const premiumHot = (etfP?.premiumTop || []).filter(x => x.premium >= 1).slice(0, 6);
  const discountCold = (etfP?.discountTop || []).filter(x => x.premium <= -1).slice(0, 6);

  const review = nextQuarterlyReview(tw);

  // byCode：市值前 80 + 邊緣，供個股頁「第四法人」判讀
  const byCode = {};
  for (let i = 0; i < Math.min(80, rank.length); i++) { const c = rank[i]; byCode[c] = { mktRank: i + 1, mktCapYi: nmeY(c), weight: i < 50 ? wt(c) : null, bigEtf: i < 50 }; }
  for (const e of edge) byCode[e.code] = { ...(byCode[e.code] || { mktRank: e.rank, mktCapYi: e.mktCapYi }), edge: e.side };

  await db.collection('etfInfluence').doc('latest').set({
    updatedAt: Date.now(), date: isoDate(tw), marketOpen: !!snap.marketOpen,
    bigcapEtfs: BIGCAP_ETFS, hidivEtfs: HIDIV_ETFS,
    review, constituents, edge, premiumHot, discountCold, byCode,
    note: '市值權重為近似(未做自由流通調整)；0050/006208 追蹤市值前50，實際成分/權重/調整日以發行商及 FTSE 官方公告為準；高股息型(0056/00878)成分無法由市值推導。',
  });
  log(`✓ 第四法人ETF：市值榜 ${rank.length} 檔（龍頭 ${rank[0]} 權重≈${wt(rank[0])}%）、邊緣 ${edge.length} 檔、溢價熱潮 ${premiumHot.length}、下次季調 ${review?.effIso || '?'}(${review?.days}日)`);
}

// ── 61) 風向 2.0 marketWind（由下而上：強勢股統計 → 題材供應鏈 → 驅動力歸因）──
// 設計（2026-07-15 與使用者確認）：
//  第1層 強勢股統計（確定性）：從全市場快照撈強勢股，看「聚集在哪些鏈」，
//        並判定大盤是「結構行情(集中少數鏈)」還是「全面行情(遍地開花)」。
//  第2層 自建題材供應鏈 themeMap（存第二大腦，可隨時擴充；一檔可屬多鏈）：
//        上下游連動驗證——全鏈齊漲=真風向；只有下游=補漲/假風向候選。
//  第3層 自然語言歸因（qwythos，僅能引用餵入的統計與新聞標題）：
//        驅動力分類 產業面/國際面/政策面；證據不足強制標「證據弱」。
//  官方 33 類加權分(sectorWind)降為第二參考值。
// 人工整理供應鏈 seed（確定性、可審核；themeMap/custom 可增修不用改碼）。
const THEME_CHAINS = [
  { key: 'aiServer', name: 'AI伺服器鏈', segs: [
    { role: '上游', label: '晶片/封測', codes: ['2330', '3711', '3443', '3661'] },
    { role: '中游', label: '組裝ODM', codes: ['2382', '3231', '6669', '2376'] },
    { role: '下游', label: '散熱', codes: ['3017', '3324', '6230', '2421'] },
    { role: '下游', label: 'PCB/CCL', codes: ['2368', '3044', '2383', '6213'] },
    { role: '下游', label: '電源/機構', codes: ['2308', '2059', '8210'] }] },
  { key: 'semiEquip', name: '半導體設備材料', segs: [
    { role: '中游', label: '設備(CoWoS)', codes: ['3131', '3583', '6640', '6187', '2464'] },
    { role: '下游', label: '檢測分析', codes: ['3587', '6510'] },
    { role: '上游', label: '材料', codes: ['1560', '3532'] }] },
  { key: 'icDesign', name: 'IC設計', segs: [{ role: '族群', label: '', codes: ['2454', '3443', '3661', '3529', '8299', '6415', '3034', '4966'] }] },
  { key: 'memory', name: '記憶體', segs: [
    { role: '上游', label: '原廠', codes: ['2408', '2344', '2337'] },
    { role: '下游', label: '模組', codes: ['8299', '3260', '8088', '2451'] }] },
  { key: 'wafer', name: '矽晶圓', segs: [{ role: '族群', label: '', codes: ['6488', '5483', '3532', '6182'] }] },
  { key: 'matureFab', name: '成熟製程代工', segs: [{ role: '族群', label: '', codes: ['2303', '5347', '6770'] }] },
  { key: 'osat', name: '封測', segs: [{ role: '族群', label: '', codes: ['3711', '6239', '2449', '6147', '3374'] }] },
  { key: 'panel', name: '面板', segs: [
    { role: '中游', label: '面板廠', codes: ['3481', '2409', '6116'] },
    { role: '上游', label: '驅動IC', codes: ['3034', '3545', '8016'] }] },
  { key: 'passive', name: '被動元件', segs: [{ role: '族群', label: '', codes: ['2327', '2492', '6173'] }] },
  { key: 'pcb', name: 'PCB', segs: [{ role: '族群', label: '', codes: ['3037', '2313', '8046', '2316', '2368', '3044'] }] },
  { key: 'netcom', name: '網通', segs: [{ role: '族群', label: '', codes: ['2345', '5388', '3596', '4906', '6285', '3704'] }] },
  { key: 'leoSat', name: '低軌衛星', segs: [{ role: '族群', label: '', codes: ['3491', '2314', '3419', '6552', '4906'] }] },
  { key: 'optical', name: '光通訊/矽光子', segs: [{ role: '族群', label: '', codes: ['4979', '3450', '6451', '3363', '4977'] }] },
  { key: 'apple', name: '蘋果鏈', segs: [
    { role: '中游', label: '組裝', codes: ['2317', '4938', '2354'] },
    { role: '上游', label: '光學/零組件', codes: ['3008', '3406', '6456'] }] },
  { key: 'evAuto', name: '電動車/車用', segs: [{ role: '族群', label: '', codes: ['3665', '2308', '2360', '1536', '2231', '3552', '6288'] }] },
  { key: 'robot', name: '機器人/自動化', segs: [{ role: '族群', label: '', codes: ['2049', '1597', '1590', '2464', '6215'] }] },
  { key: 'machineTool', name: '工具機', segs: [{ role: '族群', label: '', codes: ['1583', '4526', '2049'] }] },
  { key: 'heavyElec', name: '重電/電網', segs: [
    { role: '上游', label: '重機電', codes: ['1519', '1513', '1503', '1504'] },
    { role: '下游', label: '線纜', codes: ['1605', '1608', '1618'] }] },
  { key: 'greenWind', name: '綠能/風電', segs: [{ role: '族群', label: '', codes: ['9958', '2013', '1589', '6806', '3708'] }] },
  { key: 'battery', name: '儲能/電池', segs: [{ role: '族群', label: '', codes: ['6121', '3211', '4721', '1723', '6781'] }] },
  { key: 'defense', name: '軍工/無人機', segs: [{ role: '族群', label: '', codes: ['2634', '8033', '3162', '2645', '6753', '8996'] }] },
  { key: 'container', name: '貨櫃航運', segs: [{ role: '族群', label: '', codes: ['2603', '2609', '2615'] }] },
  { key: 'bulk', name: '散裝航運', segs: [{ role: '族群', label: '', codes: ['2606', '2637', '2605', '5608'] }] },
  { key: 'airline', name: '航空', segs: [{ role: '族群', label: '', codes: ['2610', '2618', '2646'] }] },
  { key: 'tourism', name: '觀光餐飲', segs: [{ role: '族群', label: '', codes: ['2707', '2727', '2731', '5706', '2723'] }] },
  { key: 'finance', name: '金融', segs: [{ role: '族群', label: '', codes: ['2881', '2882', '2891', '2886', '2884', '5880', '2885'] }] },
  { key: 'plastics', name: '塑化', segs: [
    { role: '上游', label: '煉化', codes: ['6505', '1301'] },
    { role: '下游', label: '塑化中下游', codes: ['1303', '1326', '1308'] }] },
  { key: 'steel', name: '鋼鐵', segs: [
    { role: '上游', label: '一貫廠', codes: ['2002'] },
    { role: '下游', label: '下游加工', codes: ['2014', '2027', '2031'] }] },
  { key: 'cement', name: '水泥', segs: [{ role: '族群', label: '', codes: ['1101', '1102'] }] },
  { key: 'construction', name: '營建', segs: [{ role: '族群', label: '', codes: ['2542', '2501', '5522', '9945', '2547'] }] },
  { key: 'biotech', name: '生技新藥', segs: [{ role: '族群', label: '', codes: ['6446', '1795', '6472', '4162', '4743', '6547'] }] },
  { key: 'food', name: '食品', segs: [{ role: '族群', label: '', codes: ['1216', '1210', '1215', '1229'] }] },
  { key: 'textile', name: '紡織成衣', segs: [
    { role: '上游', label: '化纖', codes: ['1402'] },
    { role: '下游', label: '成衣', codes: ['1476', '1477'] }] },
  { key: 'shoes', name: '製鞋/運動', segs: [{ role: '族群', label: '', codes: ['9910', '9904', '9802', '9914', '9921'] }] },
  { key: 'gaming', name: '遊戲', segs: [{ role: '族群', label: '', codes: ['3293', '6180', '3546', '6111'] }] },
  { key: 'semiChannel', name: '半導體通路', segs: [{ role: '族群', label: '', codes: ['3702', '3036'] }] },
];
let _themeMapSynced = '';
async function ensureThemeMap() {
  // seed 寫入第二大腦(每日一次)；themeMap/custom 的 chains 可增修/覆蓋(同 key 覆蓋)
  const today = isoDate(taipei());
  if (_themeMapSynced !== today) {
    try { await db.collection('themeMap').doc('seed').set({ updatedAt: Date.now(), chains: THEME_CHAINS }); _themeMapSynced = today; } catch { /* ignore */ }
  }
  let chains = THEME_CHAINS;
  try {
    const custom = (await db.collection('themeMap').doc('custom').get()).data();
    if (Array.isArray(custom?.chains) && custom.chains.length) {
      const byKey = new Map(chains.map(c => [c.key, c]));
      for (const c of custom.chains) if (c?.key && Array.isArray(c.segs)) byKey.set(c.key, c);
      chains = [...byKey.values()];
    }
  } catch { /* ignore */ }
  return chains;
}

// 盤勢日常情境(5日均量→volX；昨日法人)，每日建一次
let _windCtx = { date: '', avgVol: null, yInst: null };
async function getWindCtx() {
  const today = isoDate(taipei());
  if (_windCtx.date === today && _windCtx.avgVol) return _windCtx;
  const arch = (await db.collection('chipArchive').orderBy('date', 'desc').limit(6).get()).docs.map(d => d.data());
  if (!arch.length) return _windCtx;
  const maps = arch.map(a => (a.closeJson ? JSON.parse(a.closeJson) : {}));
  const yInst = arch[0]?.instJson ? JSON.parse(arch[0].instJson) : {};
  const avgVol = {};
  const codes = new Set(); for (const m of maps) for (const k in m) codes.add(k);
  for (const code of codes) {
    let vs = 0, vn = 0;
    for (let k = 0; k < 5; k++) { const row = maps[k]?.[code]; if (row?.[1] > 0) { vs += row[1]; vn++; } }
    avgVol[code] = vn ? vs / vn : 0;
  }
  _windCtx = { date: today, avgVol, yInst };
  return _windCtx;
}

// 台股新聞標題（Google News RSS，繁中台灣版）＋當日重大訊息(強勢股)——歸因證據源
async function fetchNewsTitles(query, n = 8) {
  try {
    const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return [];
    const xml = await r.text();
    const titles = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?([^<\]]+)/g)].map(m => m[1].trim()).filter(t => t && !/Google/.test(t));
    return titles.slice(1, 1 + n); // 第一筆是 feed 名稱
  } catch { return []; }
}
async function fetchStrongAnnouncements(strongCodes) {
  const out = [];
  for (const ep of ['t187ap04_L', 't187ap04_O']) {
    try {
      const r = await fetch(`https://openapi.twse.com.tw/v1/opendata/${ep}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      for (const x of await r.json()) {
        const code = (x['公司代號'] || '').trim();
        if (strongCodes.has(code)) out.push(`${code} ${(x['公司名稱'] || '').trim()}：${(x['主旨 '] || x['主旨'] || '').trim().slice(0, 60)}`);
      }
    } catch { /* skip */ }
    await sleep(300);
  }
  return out.slice(0, 8);
}

let _windNarr = { at: 0, date: '', text: '', drivers: {}, newsUsed: [] }; // 敘事快取(30分重生)
async function computeMarketWind() {
  const tw = taipei(); const today = isoDate(tw); const mins = tw.getHours() * 60 + tw.getMinutes();
  const snap = await readSnapshotQuotes(); if (!snap) return;
  const q = snap.quotes;
  const chains = await ensureThemeMap();
  const ctx = await getWindCtx();

  // ── 第1層：強勢股統計（確定性）──
  let up = 0, down = 0, flat = 0, totalValue = 0;
  const strong = {}; // code -> {cp, volX, value, limitUp}
  for (const code in q) {
    if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
    const x = q[code]; if (!x || !(x.price > 0)) continue;
    const cp = x.changePercent || 0; const v = x.value || 0; totalValue += v;
    if (cp > 0.15) up++; else if (cp < -0.15) down++; else flat++;
    const av = ctx.avgVol?.[code] || 0;
    const volX = av > 0 ? (x.volume / 1000) / av : 0;
    const limitUp = cp >= 9.4;
    if (cp >= 2 || limitUp || (volX >= 1.8 && cp >= 1)) strong[code] = { cp, volX: +volX.toFixed(1), value: v, limitUp };
  }
  const strongCodes = new Set(Object.keys(strong));
  if (up + down + flat < 500) return; // 快照異常保護

  // ── 第2層：題材鏈聚集度＋上下游驗證 ──
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const themes = [];
  for (const ch of chains) {
    const allCodes = [...new Set(ch.segs.flatMap(s => s.codes))];
    const members = allCodes.filter(c => q[c]?.price > 0);
    if (members.length < 2) continue;
    const chgs = members.map(c => q[c].changePercent || 0).sort((a, b) => a - b);
    const medChg = chgs[Math.floor(chgs.length / 2)];
    const strongM = members.filter(c => strong[c]);
    const limitUps = strongM.filter(c => strong[c].limitUp).length;
    const conc = strongM.length / members.length;                       // 聚集度 0..1
    let yNet = 0; for (const c of members) { const i = ctx.yInst?.[c]; if (i) yNet += (i[0] || 0) + (i[1] || 0); }
    // 上下游驗證：每段 avgChg 與強勢數
    const segs = ch.segs.map(s => {
      const cs = s.codes.filter(c => q[c]?.price > 0);
      const avg = cs.length ? cs.reduce((t, c) => t + (q[c].changePercent || 0), 0) / cs.length : 0;
      return { role: s.role, label: s.label, avgChg: +avg.toFixed(2), strong: cs.filter(c => strong[c]).length, n: cs.length };
    });
    const chainSegs = segs.filter(s => s.role !== '族群');
    let chainStatus = '族群';
    if (chainSegs.length >= 2) {
      const hot = chainSegs.filter(s => s.avgChg > 0.5 && s.strong > 0).length;
      const upstreamHot = chainSegs.some(s => s.role === '上游' && s.avgChg > 0.5);
      if (hot === chainSegs.length) chainStatus = '全鏈齊漲';
      else if (hot > 0 && !upstreamHot) chainStatus = '只有中下游(補漲/假風向候選)';
      else if (hot > 0) chainStatus = '部分連動';
      else chainStatus = '未連動';
    }
    const chipTilt = clamp(yNet / 5000, -1, 1);
    const score = +clamp(conc * 48 + medChg * 6 + (chainStatus === '全鏈齊漲' ? 15 : 0) + chipTilt * 10 + limitUps * 4, 0, 100).toFixed(1);
    const leaders = strongM.sort((a, b) => strong[b].cp - strong[a].cp).slice(0, 4)
      .map(c => ({ code: c, name: q[c].name, cp: +strong[c].cp.toFixed(2), volX: strong[c].volX, limitUp: strong[c].limitUp }));
    themes.push({ key: ch.key, name: ch.name, score, strong: strongM.length, members: members.length, medChg: +medChg.toFixed(2), limitUps, yNet: Math.round(yNet), chainStatus, segs, leaders });
  }
  themes.sort((a, b) => b.score - a.score);

  // 大盤走向：廣度 × 強勢集中度
  // topShare 分母＝「有進題材庫的強勢股」(題材庫僅涵蓋精選代碼，用全市場當分母永遠判不出集中)
  const strongN = strongCodes.size;
  let themedStrongN = 0;
  { const seen = new Set(); for (const ch of chains) for (const c of new Set(ch.segs.flatMap(s => s.codes))) if (strong[c] && !seen.has(c)) { seen.add(c); themedStrongN++; } }
  const top3Strong = themes.slice(0, 3).reduce((t, x) => t + x.strong, 0);
  const topShare = themedStrongN > 0 ? +Math.min(1, top3Strong / themedStrongN).toFixed(2) : 0;
  const breadth = up + down > 0 ? up / (up + down) : 0.5;
  let dirLabel;
  if (breadth >= 0.62 || (breadth >= 0.55 && strongN >= 300)) dirLabel = '全面多頭（遍地開花）';
  else if (breadth >= 0.48 && topShare >= 0.35) dirLabel = '結構行情（資金集中少數鏈，勿追弱勢股）';
  else if (breadth >= 0.45) dirLabel = '多空拉鋸（強弱分化）';
  else dirLabel = '偏空防守（強勢股為逆勢，追價風險高）';

  // 今日加權指數（MIS t00）——敘事的權威錨點，防止 LLM 從舊新聞標題撿昨日點位
  let idxLine = '';
  try {
    const j = await fetch('https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw&json=1&delay=0',
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TW-Stock-App/1.0)', Referer: 'https://mis.twse.com.tw/' } }).then(r => r.json());
    const x = j?.msgArray?.[0]; const z = parseFloat(x?.z), y = parseFloat(x?.y);
    if (z > 0 && y > 0 && x?.d === ymd8(tw)) idxLine = `今日加權指數 ${z.toFixed(0)} 點，較昨日${z >= y ? '上漲' : '下跌'} ${Math.abs(z - y).toFixed(0)} 點（${((z - y) / y * 100).toFixed(2)}%）`;
  } catch { /* 無指數就不提供，LLM 依規則不得自己編 */ }

  // 今日三大法人買賣超金額（BFI82U，億元）——防止 LLM 杜撰外資賣超「兆元」等量級
  let instLine = '';
  try {
    const bj = await fetch(`https://www.twse.com.tw/rwd/zh/fund/BFI82U?response=json&type=day&dayDate=${ymd8(tw)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.twse.com.tw/' } }).then(r => r.json());
    if (bj?.stat === 'OK' && Array.isArray(bj.data)) {
      const yi = row => Math.round((_f(row?.[3]) / 1e8)); // 買賣差額(元)→億
      const find = kw => bj.data.find(r => (r[0] || '').includes(kw));
      const fRow = find('外資及陸資'), tRow = find('投信'), d1 = find('自營商(自行'), d2 = find('自營商(避險'), tot = find('合計');
      if (fRow && tot) {
        const f = yi(fRow), t = tRow ? yi(tRow) : 0, d = (d1 ? yi(d1) : 0) + (d2 ? yi(d2) : 0), sum = yi(tot);
        const sgn = n => (n >= 0 ? '買超' : '賣超') + Math.abs(n) + '億';
        instLine = `今日三大法人：外資${sgn(f)}、投信${sgn(t)}、自營商${sgn(d)}、合計${sgn(sum)}（單位億元，為當日金額非連續多日）`;
      }
    }
  } catch { /* 無資料就不提供 */ }

  // ── 第3層：自然語言歸因（30 分重生一次；只餵確定性統計＋新聞標題）──
  const marketOpen = isTradingDay(tw) && mins >= 9 * 60 && mins < 13 * 60 + 35;
  const needNarr = (Date.now() - _windNarr.at > 30 * 60000 || _windNarr.date !== today) && themes.length > 0;
  if (needNarr) {
    const top = themes.slice(0, 4).filter(t => t.strong >= 2);
    const mktNews = await fetchNewsTitles('台股', 8);
    const themeNews = {};
    for (const t of top.slice(0, 3)) { themeNews[t.key] = await fetchNewsTitles(t.name.replace(/\/.*$/, ''), 4); await sleep(400); }
    const annc = await fetchStrongAnnouncements(strongCodes);
    const evid = [
      ...(idxLine ? [idxLine] : []),
      ...(instLine ? [instLine] : []),
      `大盤：漲${up}/跌${down}，強勢股${strongN}檔，前3題材佔題材強勢股${Math.round(topShare * 100)}%，判定=${dirLabel}`,
      ...top.map(t => `題材[${t.name}] 強勢${t.strong}/${t.members}檔 中位漲幅${t.medChg}% 漲停${t.limitUps} 鏈驗證=${t.chainStatus} 領漲=${t.leaders.map(l => l.name).join('、')}`),
      '【市場新聞標題】', ...mktNews.map(s => `- ${s}`),
      ...Object.entries(themeNews).flatMap(([k, arr]) => [`【${top.find(t => t.key === k)?.name}新聞標題】`, ...arr.map(s => `- ${s}`)]),
      ...(annc.length ? ['【強勢股當日重大訊息】', ...annc.map(s => `- ${s}`)] : []),
    ].join('\n');
    const prompt = `你是台股盤勢風向判讀員。僅依下方【數據與新聞標題】判讀，禁止引用任何未提供的數字或事實。
特別警告一：新聞標題可能含「昨日或更早」的指數點位與漲跌點數，一律不得引用標題中的任何指數數字；指數只能引用【數據】的指數行（若無則完全不要提指數點位）。
特別警告二：三大法人/外資的買賣超金額與方向，只能引用【數據】中「今日三大法人」那一行的數字；嚴禁自行說出任何未提供的金額或量級（例如「兆元」「數千億」），嚴禁宣稱「連續N日」買超或賣超（資料只有當日，沒有連續天數）。若該行未提供，就完全不要提法人買賣超金額。${STRICT_RULE}
任務：
1. 用 2-3 句白話說明今日大盤風向（資金往哪個族群、是結構行情還是全面行情、操作上該注意什麼）。
2. 對每個列出的題材，判斷主要驅動力類別：「產業面」(訂單/營收/報價/產能/法說)、「國際面」(美股/費半/國際局勢/地緣)、「政策面」(政府政策/關稅/標案/國防預算)。必須以【新聞標題】中的內容為證據；若標題中找不到相關證據，類別一律寫「證據弱」並註明是推測。
輸出格式（每行一條，嚴格遵守，不要其他文字）：
大盤|<說明>
題材|<題材名>|<產業面或國際面或政策面或證據弱>|<1-2句說明>

【數據與新聞標題】
${evid}`;
    const out = await askOllama(prompt);
    if (out) {
      const drivers = {}; let mainText = '';
      for (const line of out.split('\n')) {
        const mkt = line.match(/^大盤\s*\|\s*(.+)/); if (mkt) { mainText = mkt[1].trim(); continue; }
        const th = line.match(/^題材\s*\|\s*([^|]+)\|\s*(產業面|國際面|政策面|證據弱)\s*\|\s*(.+)/);
        if (th) { const t = themes.find(x => th[1].trim().includes(x.name) || x.name.includes(th[1].trim())); if (t) drivers[t.key] = { type: th[2], text: th[3].trim().slice(0, 160) }; }
      }
      if (mainText) _windNarr = { at: Date.now(), date: today, text: mainText.slice(0, 300), drivers, newsUsed: mktNews.slice(0, 5) };
    }
  }

  const payload = {
    updatedAt: Date.now(), date: today, marketOpen,
    direction: { label: dirLabel, up, down, flat, strongCount: strongN, topShare, breadth: +breadth.toFixed(2) },
    themes: themes.slice(0, 14),
    narrative: _windNarr.date === today ? { text: _windNarr.text, at: _windNarr.at, drivers: _windNarr.drivers, newsUsed: _windNarr.newsUsed } : null,
  };
  await db.collection('marketWind').doc('latest').set(payload);
  if (isTradingDay(tw) && mins >= 13 * 60 + 40) await db.collection('marketWind').doc(today).set(payload); // 收盤定案存歷史
  log(`✓ 風向2.0：${dirLabel.slice(0, 8)} 強勢${strongN}檔 Top=${themes[0]?.name || '-'}(${themes[0]?.score ?? 0})${_windNarr.date === today ? ' +敘事' : ''}`);
}

// ── 59) 產業風向偵測 sectorWind（第二參考值：官方 33 類加權分）──────
// 官方 33 產業分類(代碼制) + 每日加權分(漲跌×家數廣度×籌碼×量能) +
// 對比昨日分數 → 加碼(資金流入)/減碼(流出)輪動；歷史存第二大腦 sectorWind/{date}。
// 新類別自動出現(官方新增代碼→未對映則顯示代碼，不漏)。
const TWSE_INDUSTRY = {
  '01': '水泥', '02': '食品', '03': '塑膠', '04': '紡織纖維', '05': '電機機械', '06': '電器電纜',
  '08': '玻璃陶瓷', '09': '造紙', '10': '鋼鐵', '11': '橡膠', '12': '汽車', '14': '建材營造',
  '15': '航運', '16': '觀光餐旅', '17': '金融保險', '18': '貿易百貨', '20': '其他', '21': '化學',
  '22': '生技醫療', '23': '油電燃氣', '24': '半導體', '25': '電腦及週邊', '26': '光電', '27': '通信網路',
  '28': '電子零組件', '29': '電子通路', '30': '資訊服務', '31': '其他電子', '35': '綠能環保',
  '36': '數位雲端', '37': '運動休閒', '38': '居家生活', '91': '存託憑證',
};
// 發行股數（週轉率用·慢變數·每日快取）：上市 t187ap03_L「已發行普通股數」＋上櫃 Capitals
let _shrMap = { date: '', map: null };
async function getSharesMap() {
  const today = isoDate(taipei());
  if (_shrMap.date === today && _shrMap.map) return _shrMap.map;
  const map = {};
  try {
    const r = await fetch('https://openapi.twse.com.tw/v1/opendata/t187ap03_L', { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    const txt = await r.text();
    if (txt.startsWith('[')) for (const x of JSON.parse(txt)) {
      const c = (x['公司代號'] || '').trim();
      const n = parseFloat(String(x['已發行普通股數或TDR原股發行股數'] || '').replace(/,/g, ''));
      if (/^\d{4}$/.test(c) && n > 0) map[c] = n;
    }
  } catch { /* 上市缺→僅上櫃 */ }
  try {
    const r = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (r.ok) for (const x of await r.json()) {
      const c = (x.SecuritiesCompanyCode || '').trim();
      const cap = parseFloat(String(x.Capitals || '').replace(/,/g, ''));
      if (/^\d{4}$/.test(c) && cap > 0 && !map[c]) map[c] = cap;
    }
  } catch { /* 上櫃缺 */ }
  if (Object.keys(map).length > 500) _shrMap = { date: today, map };
  return _shrMap.map || map;
}

let _indMap = { date: '', map: null }; // code -> 產業名(官方)
async function getIndustryMap() {
  const today = isoDate(taipei());
  if (_indMap.date === today && _indMap.map) return _indMap.map;
  const map = {};
  for (const ep of ['t187ap03_L', 't187ap03_O']) {
    try {
      const r = await fetch(`https://openapi.twse.com.tw/v1/opendata/${ep}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      for (const x of await r.json()) {
        const code = (x['公司代號'] || '').trim(); const ind = (x['產業別'] || '').trim();
        if (/^\d{4}$/.test(code) && ind) map[code] = TWSE_INDUSTRY[ind] || `類別${ind}`; // 未知代碼保留(新類別不漏)
      }
    } catch { /* skip */ }
    await sleep(300);
  }
  if (Object.keys(map).length > 300) _indMap = { date: today, map };
  return _indMap.map || map;
}
async function computeSectorWind() {
  const tw = taipei(); const today = isoDate(tw);
  const snap = await readSnapshotQuotes(); if (!snap) return;
  const q = snap.quotes;
  const indMap = await getIndustryMap();
  // 昨日法人(chipArchive 最近一日 inst)：盤中無當日 T86，用昨日傾向；收盤後也先用昨日(當日 15:00 後另有 T86)
  const arch = (await db.collection('chipArchive').orderBy('date', 'desc').limit(1).get()).docs.map(d => d.data());
  const instY = arch[0]?.instJson ? JSON.parse(arch[0].instJson) : {};

  const sec = {};
  for (const code in q) {
    if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
    const x = q[code]; if (!x || !(x.price > 0)) continue;
    const ind = indMap[code] || industryOf(code, x.name);
    const s = (sec[ind] ??= { industry: ind, n: 0, up: 0, down: 0, value: 0, wpct: 0, netInst: 0, stocks: [] });
    const cp = x.changePercent || 0, v = x.value || 0;
    s.n++; s.value += v; s.wpct += cp * v;
    if (cp > 0) s.up++; else if (cp < 0) s.down++;
    const inst = instY[code]; if (inst) s.netInst += (inst[0] || 0) + (inst[1] || 0); // 昨外資+投信(張)
    s.stocks.push({ code, name: x.name, cp, netInst: inst ? (inst[0] || 0) + (inst[1] || 0) : 0 });
  }

  // 昨日 sectorWind 分數(算 delta 用)
  const prev = (await db.collection('sectorWind').doc('latest').get()).data();
  const prevScore = {}; for (const p of (prev?.sectors || [])) prevScore[p.industry] = p.windScore;
  const prevIsToday = prev?.date === today;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sectors = Object.values(sec).filter(s => s.n >= 3).map(s => {
    const avgChg = s.value > 0 ? s.wpct / s.value : 0;
    const breadth = s.n > 0 ? (s.up - s.down) / s.n : 0;   // -1..1
    const chipTilt = clamp(s.netInst / 3000, -1, 1);        // 每3000張淨買賣→滿分
    // 加權分 0-100：漲跌主導、家數廣度、籌碼傾向
    const windScore = +clamp(50 + avgChg * 7 + breadth * 22 + chipTilt * 8, 0, 100).toFixed(1);
    // delta：與昨日(非同日的 latest)比；同日更新則沿用昨日已存的 base(避免 delta 歸零)
    const base = (prevIsToday ? (prev?.baseScore?.[s.industry]) : prevScore[s.industry]);
    const delta = base != null ? +(windScore - base).toFixed(1) : null;
    return {
      industry: s.industry, windScore, delta,
      avgChg: +avgChg.toFixed(2), up: s.up, down: s.down, n: s.n,
      netInst: Math.round(s.netInst),
      leaders: s.stocks.sort((a, b) => b.cp - a.cp).slice(0, 4).map(x => ({ code: x.code, name: x.name, cp: +x.cp.toFixed(2), netInst: Math.round(x.netInst) })),
    };
  }).sort((a, b) => b.windScore - a.windScore);

  // 保留今日的「昨日基準分」供同日多次更新算穩定 delta
  const baseScore = prevIsToday ? (prev?.baseScore || {}) : Object.fromEntries((prev?.sectors || []).map(p => [p.industry, p.windScore]));
  const payload = { updatedAt: Date.now(), date: today, marketOpen: snap.marketOpen, sectors, baseScore };
  await db.collection('sectorWind').doc('latest').set(payload);
  // 每日定案(收盤後)存歷史(第二大腦)
  if (isTradingDay(tw) && (tw.getHours() * 60 + tw.getMinutes()) >= 13 * 60 + 40) {
    await db.collection('sectorWind').doc(today).set({ date: today, sectors, updatedAt: Date.now() });
  }
  if (sectors.length) log(`✓ 產業風向：最強 ${sectors[0].industry}(${sectors[0].windScore})、最弱 ${sectors[sectors.length - 1].industry}(${sectors[sectors.length - 1].windScore})`);
}

// ── 58) 盤中雷達 intradayRadar（盤中戰情頁專用，與撿尾盤分離）────
// 多策略引擎：每 60 秒對全市場即時快照同時評估 6 種盤中策略，
// 前端以開關篩選；同檔命中多策略＝多重共識。全部確定性計算。
const RADAR_STRATEGIES = {
  ignite:     { name: '起漲偵測',     icon: '🚀', note: '量能超前≥2x＋漲0.5~3.5%未噴出＋買盤佔優＋逼近5日高（發動前）' },
  volSurge:   { name: '爆量長紅',     icon: '🔥', note: '量能超前≥3x＋漲3.5~8.5%未鎖停＋長紅實體＋貼日內高（初動確認）' },
  openStrong: { name: '開盤強勢延續', icon: '📈', note: '跳空開高≥1.5%＋未回補缺口＋守住開盤價（缺口續勢）' },
  ma5Bounce:  { name: '五日線回踩反彈', icon: '🌊', note: '價在5日線上＋今日曾踩5日線±1%＋自低點反彈≥1%（拉回買點）' },
  followThru: { name: '昨強今續',     icon: '💪', note: '昨日收漲≥2%＋今日續漲0~4%＋量能≥1.5x（動能第2日）' },
  chipIgnite: { name: '外資昨買今動', icon: '🧲', note: '昨日外資買超≥500張＋今日漲≥1%＋量能≥1.5x（籌碼共振）' },
  squeeze:    { name: '軋空啟動',     icon: '⚡', note: '昨日融券增≥昨量0.5%＋今日漲>2%（2年稽核46.0-47.7%·淨均+0.33~0.48%/筆vs基準·兩窗穩定正）' },
  breakHigh:  { name: '突破新高',     icon: '🏔', note: '突破20日新高＋貼日內高（2年稽核45.4-48.2%·淨+0.3~0.6%/筆·兩窗穩定正；⚠單獨突破未配強尾實測44%低於基準）' },
};
let _radarCtx = { date: '', avgVol: null, hi5: null, prevClose: null, ma5: null, yChg: null, yForeign: null, yTrust: null, ySqueeze: null, hi20: null };
let _radarSeen = { date: '', map: {} }; // code -> firstSeen ts(當日，跨策略共用)
let _radarRating = { at: 0, map: {} };  // AI 評分快取(5分)，避免每60秒重抓全市場
async function computeIntradayRadar() {
  const tw = taipei(); const mins = tw.getHours() * 60 + tw.getMinutes(); const today = isoDate(tw);
  if (!isTradingDay(tw) || mins < 9 * 60 + 10 || mins >= 13 * 60 + 35) return;

  // 每日一次：5日均量/5日高/昨收/MA5(近似:前5日收盤均)/昨日漲幅/昨日外資（chipArchive）
  if (_radarCtx.date !== today) {
    const arch = (await db.collection('chipArchive').orderBy('date', 'desc').limit(21).get()).docs.map(d => d.data());
    if (!arch.length) return;
    const maps = arch.map(a => a.closeJson ? JSON.parse(a.closeJson) : {});
    const instY = arch[0]?.instJson ? JSON.parse(arch[0].instJson) : {};
    // 軋空啟動 setup：昨日融券增 ≥ 昨量 0.5%（2年稽核 46.0-47.7%·淨正兩窗穩定）
    const mgY = arch[0]?.marginJson ? JSON.parse(arch[0].marginJson) : {};
    const mgY2 = arch[1]?.marginJson ? JSON.parse(arch[1].marginJson) : {};
    const ySqueeze = {};
    for (const code in mgY) {
      const a = mgY[code], b = mgY2[code]; if (!a || !b) continue;
      const sChg = (a[1] || 0) - (b[1] || 0);
      const yVol = maps[0]?.[code]?.[1] || 0;
      if (yVol >= 300 && sChg >= yVol * 0.005) ySqueeze[code] = sChg;
    }
    // 供撿尾盤 API 標記共用（一日一寫）
    db.collection('squeezeSetup').doc('latest').set({
      date: today, codesJson: JSON.stringify(ySqueeze), n: Object.keys(ySqueeze).length, at: Date.now(),
    }).catch(() => {});
    const avgVol = {}, hi5 = {}, prevClose = {}, ma5 = {}, yChg = {}, yForeign = {}, yTrust = {}, hi20 = {};
    const codes = new Set(); for (const m of maps) for (const k in m) codes.add(k);
    for (const code of codes) {
      let h = 0, vs = 0, vn = 0, cs = 0, cn = 0;
      for (let k = 0; k < 5; k++) {
        const row = maps[k]?.[code]; if (!row) continue;
        if (row[0] > h) h = row[0];
        if (row[0] > 0) { cs += row[0]; cn++; }
        if (row[1] > 0) { vs += row[1]; vn++; }
      }
      hi5[code] = h; avgVol[code] = vn ? vs / vn : 0; ma5[code] = cn >= 4 ? cs / cn : 0;
      let h20 = 0; for (let k = 0; k < Math.min(20, maps.length); k++) { const v = maps[k]?.[code]?.[0]; if (v > h20) h20 = v; }
      hi20[code] = h20;
      const c0 = maps[0]?.[code]?.[0], c1 = maps[1]?.[code]?.[0];
      prevClose[code] = c0 || 0;
      yChg[code] = c0 > 0 && c1 > 0 ? (c0 - c1) / c1 * 100 : 0;
      yForeign[code] = instY?.[code]?.[0] || 0;
      yTrust[code] = instY?.[code]?.[1] || 0;
    }
    _radarCtx = { date: today, avgVol, hi5, prevClose, ma5, yChg, yForeign, yTrust, ySqueeze, hi20 };
  }
  if (_radarSeen.date !== today) _radarSeen = { date: today, map: {} };
  // AI 評分快取(5分刷新)
  if (Date.now() - _radarRating.at > 300000) {
    try { _radarRating = { at: Date.now(), map: (await getJSON('/api/rating'))?.ratings || {} }; } catch { /* keep old */ }
  }

  const snap = await readSnapshotQuotes(); const q = snap?.quotes || {};
  // 時段量能校正：開盤量佔全日比重前重後輕(9:10≈25%、10:00≈45%、11:30≈70%、13:00≈90%)
  const elapsed = Math.min(1, Math.max(0.2, (mins - 9 * 60) / 270 * 0.85 + 0.18));
  const groups = {}; for (const k in RADAR_STRATEGIES) groups[k] = [];

  for (const code in q) {
    if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
    const x = q[code]; if (!x.live || !(x.price > 0) || !(x.high > 0) || !(x.low > 0) || !(x.open > 0)) continue;
    const pc = _radarCtx.prevClose?.[code]; if (!(pc > 0)) continue;
    const av = _radarCtx.avgVol?.[code]; if (!(av > 200)) continue;        // 均量>200張，排除殭屍股
    const chg = (x.price - pc) / pc * 100;
    if (chg <= 0 || chg > 9.4) continue;                                    // 收紅未鎖停的共同前提
    const lots = (x.volume || 0) / 1000;
    const volX = lots / (av * elapsed);
    const rng = x.high - x.low; const pos = rng > 0 ? (x.price - x.low) / rng : 1;
    const h5 = _radarCtx.hi5?.[code] || 0;
    const m5 = _radarCtx.ma5?.[code] || 0;
    const gap = (x.open - pc) / pc * 100;
    const body = (x.price - x.open) / x.open * 100;
    const bounce = x.low > 0 ? (x.price - x.low) / x.low * 100 : 0;

    const hits = [];
    if (chg >= 0.5 && chg <= 3.5 && volX >= 2 && pos >= 0.75 && h5 > 0 && x.price >= h5 * 0.99) hits.push('ignite');
    if (chg >= 3.5 && chg <= 8.5 && volX >= 3 && pos >= 0.85 && body >= 2.5) hits.push('volSurge');
    if (gap >= 1.5 && x.low > pc && x.price >= x.open && volX >= 1.2) hits.push('openStrong');
    if (m5 > 0 && x.price > m5 && x.low <= m5 * 1.01 && bounce >= 1 && chg <= 4) hits.push('ma5Bounce');
    if ((_radarCtx.yChg?.[code] || 0) >= 2 && chg <= 4 && volX >= 1.5 && pos >= 0.7) hits.push('followThru');
    if ((_radarCtx.yForeign?.[code] || 0) >= 500 && chg >= 1 && volX >= 1.5 && pos >= 0.7) hits.push('chipIgnite');
    if (_radarCtx.ySqueeze?.[code] != null && chg > 2) hits.push('squeeze');
    { const h20 = _radarCtx.hi20?.[code] || 0; if (h20 > 0 && x.price > h20 && pc <= h20 && pos >= 0.7) hits.push('breakHigh'); }
    if (!hits.length) continue;

    if (!_radarSeen.map[code]) _radarSeen.map[code] = Date.now();
    const rt = _radarRating.map?.[code];
    const item = {
      code, name: x.name || code, market: x.market || 'tse',
      price: +x.price.toFixed(2), chg: +chg.toFixed(2), volX: +volX.toFixed(1), pos: +pos.toFixed(2),
      toHi5: h5 > 0 ? +((x.price - h5) / h5 * 100).toFixed(2) : null,
      gap: +gap.toFixed(2),                                  // 開盤跳空%
      maRel: m5 > 0 ? +((x.price - m5) / m5 * 100).toFixed(2) : null, // 距5日線%
      yForeign: Math.round(_radarCtx.yForeign?.[code] || 0), // 昨日外資(張)
      yTrust: Math.round(_radarCtx.yTrust?.[code] || 0),     // 昨日投信(張)
      score: rt?.score ?? null, signal: rt?.signal ?? null,  // AI 評分/訊號
      strategies: hits, firstSeen: _radarSeen.map[code],
    };
    for (const s of hits) groups[s].push(item);
  }
  const meta = {};
  const iwCtx = await getInstWeightCtx(); // 四大法人加權(t-1，PIT 安全)
  const rk = x => x.volX + instWeight(x.code, iwCtx) * 0.4; // 量比為主、法人加權微調排序
  for (const k in RADAR_STRATEGIES) {
    groups[k].sort((a, b) => rk(b) - rk(a));
    meta[k] = { ...RADAR_STRATEGIES[k], total: groups[k].length };
    groups[k] = groups[k].slice(0, 10);
  }
  await db.collection('intradayRadar').doc('latest').set({
    updatedAt: Date.now(), date: today, strategies: meta, groups: JSON.parse(JSON.stringify(groups)),
  });
}

// ── 55) 開盤 9:00 隔日沖賣出提醒 openSell（高級會員）──────────────
// 掃各會員持股中 buyDate=前一交易日者，09:00–09:10 推播提醒開盤出場。
// 依據實測：開高走低盤開盤賣 73%/+1.48%、抱到收盤 40%/−0.44%。每人每日一次。
let _osDay = ''; const _osSent = new Set();
function prevTradingDate(tw) {
  const d = new Date(tw);
  do { d.setDate(d.getDate() - 1); } while (!isTradingDay(d));
  return isoDate(d);
}
async function checkOpenSell() {
  const tw = taipei(); const mins = tw.getHours() * 60 + tw.getMinutes();
  if (!(mins >= 9 * 60 && mins <= 9 * 60 + 10)) return;
  const today = isoDate(tw);
  if (_osDay !== today) { _osSent.clear(); _osDay = today; }
  const prevDate = prevTradingDate(tw);
  const premium = await getPremiumUsers();
  for (const u of premium) {
    if (_osSent.has(u.id)) continue;
    try {
      const hd = (await db.collection('users').doc(u.id).collection('data').doc('holdings').get()).data();
      const byCode = {};
      for (const h of (hd?.holdings || [])) {
        if (h.buyDate !== prevDate) continue; // 只提醒昨日進場的隔日沖單
        const g = (byCode[h.code] ??= { name: h.name, qty: 0 }); g.qty += h.quantity;
      }
      const codes = Object.entries(byCode);
      _osSent.add(u.id); // 無論有無皆標記，避免每分鐘重查
      if (!codes.length) continue;
      const list = codes.map(([c, g]) => `${c} ${g.name} ${g.qty}張`).join('、');
      const al = {
        code: codes[0][0], name: codes[0][1].name, type: 'opensell', price: 0, threshold: 0, pnlPct: 0,
        message: `⏰ 隔日沖開盤賣出提醒：昨日進場 ${list} — 鐵律 9:00–9:05 出場（實測開盤賣 73%／+1.48%，抱到收盤 40%／−0.44%）；開低直接認賠、不留倉`,
        at: Date.now(),
      };
      const aref = db.collection('users').doc(u.id).collection('data').doc('alerts');
      const prev = (await aref.get()).data()?.alerts || [];
      await aref.set({ updatedAt: Date.now(), alerts: [al, ...prev].slice(0, 40) });
      pushAlerts(u.id, [al]).catch(() => {});
      log(`  ⏰ openSell ${u.id.slice(0, 6)} ${list.slice(0, 50)}`);
    } catch { /* per-user skip */ }
  }
}

// 法人連續買超 + 回測：開機跑一次，之後每交易日收盤後(15:10)各跑一次。
async function runDailyJobs(boot = false) {
  const tag = boot ? '(boot)' : '';
  // finReports 是全量掃描（~2,000 docs）且為季頻資料——每日 15:10 跑就夠，
  // 開機重跑純浪費（2026-08-01 稽查：一天內多次重啟 × 2k ＝ 數萬次白讀）。
  const BOOT_SKIP = new Set(['finReports']);
  for (const [name, fn] of [['institutional', trackInstitutional], ['tradeSignals', computeTradeSignals], ['RS', computeRS], ['scanner', computeScanner], ['taifex', trackTaifex], ['globalMarkets', computeGlobalMarkets], ['revenue', computeRevenue], ['margin', computeMargin], ['majorHolders', computeMajorHoldersChange], ['multiTimeframe', computeMultiTimeframe], ['dividend', computeDividendCalendar], ['lending', computeLending], ['dividendStocks', computeDividendStocks], ['marketHealth', computeMarketHealth], ['peerComps', computePeerComps], ['catalystCalendar', buildCatalystCalendar], ['morningNote', publishMorningNote], ['dayTradeRatio', computeDayTradeRatio], ['chipArchive', archiveChipDaily], ['otcIndex', archiveOtcIndex], ['strategyPicks', computeStrategyPicks], ['etfPremium', computeEtfPremium], ['picksTracker', trackPicks], ['exDiv', adviseExDiv], ['dcaHint', hintDca], ['adrPremium', computeAdrPremium], ['stressTest', computeStressTest], ['theses', updateTheses], ['rebalance', checkAllocationDrift], ['stopDiscipline', trackStopDiscipline], ['snipeList', buildSnipeList], ['rotation', computeRotation], ['peBands', computePeBands], ['monthlyReports', publishMonthlyReports], ['userRisk', computeUserRisk], ['marketPattern', computeMarketPattern], ['tailEndPicks', computeTailEndPicks], ['shadowAccount', analyzeShadowAccount], ['earningsCalls', previewEarningsCalls], ['chipCumulative', computeChipCumulative], ['chipSignals', computeChipSignals], ['chipDaily', computeChipDaily], ['chipWind', computeChipWind], ['chipDivergence', computeChipDivergence], ['etfInfluence', computeEtfInfluence], ['chipPicks', computeChipPicks], ['newsDaily', computeNewsDaily], ['limitUpForecast', computeLimitUpForecast], ['finReports', computeFinReports], ['washoutMonitor', computeWashoutMonitor], ['backtest', runBacktest], ['dailyPost', publishDailyPost], ['userSummaries', publishUserSummaries], ['tradeReviews', publishTradeReviews]]) {
    if (boot && BOOT_SKIP.has(name)) { log(`  ↷ ${name}(boot 跳過·每日 15:10 排程涵蓋)`); continue; }
    try { await fn(); } catch (e) { log(`✖ ${name}${tag}:`, e.message); }
  }
}
// 官方盤後資料公布時間不同，光靠 15:10 一次會抓到前一日：T86 三大法人約 16:00、
// 期交所/集保/除權息/借券/月營收約 16:30 前、融資融券約 21:30 才出。故加兩個補抓時段。
const OFFICIAL_CATCHUP = [['institutional', trackInstitutional], ['taifex', trackTaifex], ['majorHolders', computeMajorHoldersChange], ['dividend', computeDividendCalendar], ['lending', computeLending], ['revenue', computeRevenue], ['marketHealth', computeMarketHealth], ['peerComps', computePeerComps], ['catalystCalendar', buildCatalystCalendar], ['dayTradeRatio', computeDayTradeRatio], ['chipArchive', archiveChipDaily], ['chipCumulative', computeChipCumulative], ['chipSignals', computeChipSignals], ['chipDaily', computeChipDaily], ['chipWind', computeChipWind], ['chipDivergence', computeChipDivergence], ['etfInfluence', computeEtfInfluence], ['strategyPicks', computeStrategyPicks], ['etfPremium', computeEtfPremium], ['dailyPost', publishDailyPost]];
const MARGIN_CATCHUP = [['margin', computeMargin], ['etfPremium', computeEtfPremium], ['chipArchive', archiveChipDaily], ['chipSignals', computeChipSignals], ['dailyPost', publishDailyPost]];
async function runJobSet(jobs, tag) {
  for (const [name, fn] of jobs) { try { await fn(); } catch (e) { log(`✖ ${name}${tag}:`, e.message); } }
}
let _asiaAt = 0, _asiaCatchupDate = '';   // 日韓早盤節流與補跑守衛（見 computeAsiaPremarket）
let _dailyJobsDate = '', _officialDate = '', _marginDate = '', _morningDate = '', _weeklyDate = '', _backupDate = '', _characterDate = '', _otcFixDate = '', _newsDigestDate = ''; let _depthArchDate = null; let _orderFlowDate = ''; let _snap0930Date = null; let _revDatesMonth = null; let _leadersMonth = null;
let _calSyncDate = null; let _dailyCloseDate = null; let _histTopupDate = null; let _healthAuditDate = null; let _tailTrackDate = null; let _tailEvalDate = null;
// 子程序執行 scripts/ 內腳本（記憶體隔離；邏輯不重複進 daemon）
function execScript(name, args, tag, timeoutMin = 10) {
  import('node:child_process').then(({ execFile }) => {
    // ⚠ 中文路徑：URL.pathname 是百分號編碼（%E8%82%A1…），execFile 直接用會找不到檔
    //（2026-07-24 揭發：備份/分析/漲停前夜實驗子腳本長期靜默失敗）。必須解碼。
    const script = decodeURIComponent(new URL(`./${name}`, import.meta.url).pathname);
    execFile(process.execPath, [script, ...args], { timeout: timeoutMin * 60000 }, (err, stdout) => {
      if (err) log(`✖ ${tag}:`, err.message);
      else log(`${tag}:`, String(stdout).trim().split('\n').pop());
    });
  }).catch((e) => log(`✖ ${tag} spawn:`, e.message));
}
async function dailyJobsLoop() {
  await runDailyJobs(true); // 開機先跑一輪，資料即時可用
  { // 若開機時已過各時段，先標記為今日已跑，避免緊接著重複整輪
    const tw = taipei(); const t = isoDate(tw); const m = tw.getHours() * 60 + tw.getMinutes();
    if (isTradingDay(tw)) { if (m >= 15 * 60 + 10) _dailyJobsDate = t; if (m >= 16 * 60 + 30) _officialDate = t; if (m >= 21 * 60 + 45) _marginDate = t; }
  }
  for (;;) {
    try {
      const tw = taipei(); const mins = tw.getHours() * 60 + tw.getMinutes(); const today = isoDate(tw);
      // 週六 10:00 週末復盤週報
      if (tw.getDay() === 6 && mins >= 10 * 60 && _weeklyDate !== today) {
        try { await publishWeeklyReviews(); } catch (e) { log('✖ weekly:', e.message); }
        _weeklyDate = today;
      }
      // 每日新聞（使用者定案 2026-07-29：要「當日最新」而非早上那一版）：
      // 07:00 首發，之後 07:00~23:00 每滿 3 小時刷新。
      // ⚠2026-08-01 修正：原本包在 isTradingDay 裡——**週末與假日整天不更新新聞**，
      //   7/29 改版後第一個週六（今天）才發作。世界新聞不休市，移出交易日閘門。
      // ⚠失敗不可佔位（成功才記 _newsDigestDate，失敗下輪重試）。
      if (mins >= 7 * 60 && mins <= 23 * 60) {
        try {
          const cur = (await db.collection('newsDigest').doc('latest').get()).data();
          const ageH = cur?.updatedAt ? (Date.now() - cur.updatedAt) / 3600000 : 999;
          if (cur?.date !== today || ageH >= 3) {
            await buildNewsDigest();
            _newsDigestDate = today;
          }
        } catch (e) { log('✖ 每日新聞:', (e.message || '').slice(0, 80)); }
      }
      if (isTradingDay(tw)) {
        // 08:00–09:05 日韓早盤風向（日韓 09:00 開盤＝台北 08:00，台股開盤前的領先窗口）
        // 每 15 分一輪＝4~5 輪 × 12 檔 ≈ 每日 50 次上游請求，**與線上人數無關**（唯一不變式）。
        // 09:05 那輪落在台股開盤後 5 分，用來把「開盤當下的日韓狀態」歸檔給日後回測對齊。
        if (mins >= 8 * 60 && mins <= 9 * 60 + 5 && Date.now() - _asiaAt >= 14 * 60000) {
          _asiaAt = Date.now();
          try { await computeAsiaPremarket(); } catch (e) { log('✖ 日韓早盤:', (e.message || '').slice(0, 80)); }
        }
        // 補跑：盤前窗口沒跑到（daemon 重啟／機器沒開）就整天沒資料且**靜默漏掉**，
        // 這正是 bookDepth 壞了半年沒人發現的同一種失敗模式。日韓交易到 14:00 台北，
        // 故 09:06–13:55 之間若今日無資料就補一筆，並標記 lateCatchup（非盤前觀測值）。
        if (mins > 9 * 60 + 5 && mins < 13 * 60 + 55 && _asiaCatchupDate !== today && Date.now() - _asiaAt >= 14 * 60000) {
          try {
            const cur = (await db.collection('asiaPremarket').doc('latest').get()).data();
            if (cur?.date !== today) {
              _asiaAt = Date.now();
              await computeAsiaPremarket({ lateCatchup: true });
            }
            _asiaCatchupDate = today;   // 成功確認過就不再重試（無論有無實際補跑）
          } catch (e) { log('✖ 日韓早盤補跑:', (e.message || '').slice(0, 80)); }
        }
        // 08:00 盤前晨報（事件日曆先更新，晨報才有今日事件）
        // 07:50（開盤前 70 分）盤前晨報：日曆→ADR→新聞風向→晨報
        if (mins >= 7 * 60 + 50 && _morningDate !== today) {
          try { await buildCatalystCalendar(); await computeAdrPremium(); await forecastSectors(); await publishMorningNote(); } catch (e) { log('✖ morning note:', e.message); }
          _morningDate = today;
        }
        // 每月 13 日存「營收出表日期」快照（月營收10日截止後·事件研究的事件日來源，數季後解鎖）
        if (tw.getDate() >= 13 && _revDatesMonth !== today.slice(0, 7)) {
          _revDatesMonth = today.slice(0, 7);
          try {
            const r = await fetch('https://openapi.twse.com.tw/v1/opendata/t187ap05_L', { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (r.ok) {
              const rows = await r.json();
              const by = {};
              for (const x of rows) { const c = String(x.公司代號 || '').trim(); if (/^\d{4}$/.test(c) && x.出表日期) by[c] = x.出表日期; }
              if (Object.keys(by).length > 200) {
                await db.collection('revenueDates').doc(today.slice(0, 7)).set({ month: today.slice(0, 7), byCodeJson: JSON.stringify(by), n: Object.keys(by).length, at: Date.now() });
                log(`✓ 營收出表日快照 ${today.slice(0, 7)}（${Object.keys(by).length} 檔）`);
              }
            }
          } catch (e) { log('✖ 營收出表日快照:', e.message); }
        }
        // 每日 16:10 全站資料源健康稽核（收盤各項作業都跑完之後）。
        // wm-freshness-health-monitoring：新鮮度不是「查一次」，是要有常設驗收閘 ——
        // 本專案的日期漂移已經靠人眼抓到四次（上櫃位移、加權指數落後、
        // stockHistory 只寫一次、chipDaily PIT），每一次都是使用者先發現的。
        if (mins >= 16 * 60 + 10 && _healthAuditDate !== today) {
          _healthAuditDate = today;
          execScript('audit-data-sources.mjs', ['--write'], '🩺 資料源健康稽核', 10);
          setTimeout(async () => {
            try {
              const h = (await db.collection('system').doc('dataHealth').get()).data();
              if (!h) return;
              if (h.unhealthy > 0 || h.externalUnhealthy > 0) {
                const bad = (h.results || []).filter(r => r.status !== 'OK')
                  .map(r => `${r.collection}(${r.status})`).join('、');
                log(`⚠ 資料源健康：內部異常 ${h.unhealthy}、外部異常 ${h.externalUnhealthy}${bad ? ' — ' + bad : ''}`);
              } else log('✓ 資料源健康：全部正常');
            } catch { /* 稽核失敗不影響主流程 */ }
          }, 120000);
        }
        // 每日 15:20 用 chipArchive 補正 stockHistory（官方收盤覆蓋，補尾端＋補洞）。
        // 沒有這一步，/api/history 是只寫一次的快取 —— 技術指標會永遠停在
        // 該檔第一次被查詢的那天（實測最舊落後 5 週，且中間平均 13 個洞）。
        if (mins >= 15 * 60 + 20 && _histTopupDate !== today && isTradingDay(tw)) {
          _histTopupDate = today;
          execScript('topup-stock-history.mjs', [], '📈 日線補正', 20);
        }
        // 每日 15:25 抓當日市場委託失衡（MI_5MINS）。
        // 2026-08-02 起：三年歷史已回補（orderFlowArchive），這一步是「不讓它斷」——
        // bookDepth 的教訓就是回補/建立完沒接每日更新，半年後打開只有 9 天。
        // 冪等（腳本內建已存跳過），只跑當日一天故 --days 1。
        if (mins >= 15 * 60 + 25 && _orderFlowDate !== today && isTradingDay(tw)) {
          _orderFlowDate = today;
          execScript('backfill-orderflow.mjs', ['--days', '1'], '📋 委託失衡', 5);
        }
        // 每日 18:05 觸發收盤盤勢分析（/api/cron/daily-close）。
        // 2026-08-01 事故：這支原由 Cloud Scheduler 觸發，但 job 指向 us-central1
        // 直連網址（region 遷移後已死）＋query-string secret（安全加固後被拒）——
        // 「收盤盤勢分析」自 7/29 起停更，使用者看著崩盤日的舊寬度做判斷。
        // 觸發權收回 daemon（架構鐵律：排程屬 daemon），該 scheduler job 已暫停。
        if (mins >= 18 * 60 + 5 && _dailyCloseDate !== today && isTradingDay(tw) && process.env.CRON_SECRET) {
          _dailyCloseDate = today;
          try {
            const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 240000);
            const r = await fetch(`${CRON_BASE}/api/cron/daily-close`, { method: 'POST', headers: { 'x-cron-secret': process.env.CRON_SECRET }, signal: ctl.signal }).finally(() => clearTimeout(tm));
            const j = await r.json().catch(() => null);
            log(`✓ 收盤盤勢分析：${j?.date || r.status}·寬度 ${j?.breadth?.advancePct ?? '?'}%`);
          } catch (e) { _dailyCloseDate = null; log('✖ 收盤盤勢分析:', (e.message || '').slice(0, 60)); }   // 失敗不佔位·下輪重試
        }
        // 每日 06:40 同步休市日曆（早於 07:00 新聞與 08:45 盤前快報，
        // 確保當天所有 isTradingDay() 判斷都吃到最新的表；颱風假當天才補得上）
        if (mins >= 6 * 60 + 40 && _calSyncDate !== today) {
          _calSyncDate = today;
          execScript('sync-trading-calendar.mjs', [], '📅 休市日曆同步', 5);
          setTimeout(() => { _calLoadedDate = null; loadTradingCalendar(); }, 90000);
        }
        // 每月首個交易日 17:20 重建龍頭名單＋model-core（權重不變·僅名單/日期更新）
        if (tw.getDate() <= 3 && mins >= 17 * 60 + 20 && _leadersMonth !== today.slice(0, 7)) {
          _leadersMonth = today.slice(0, 7);
          execScript('build-leaders.mjs', [], '👑 leaders refresh', 10);
          setTimeout(() => execScript('build-model-core.mjs', [], '🧠 model-core refresh', 10), 120000);
        }
        // 09:31~09:59 前30分快照歸檔（三關法 Gate1/Gate2 的未來回測原料＋當日問AI即時檢核）
        if (mins >= 9 * 60 + 31 && mins < 10 * 60 && _snap0930Date !== today) {
          _snap0930Date = today;
          try {
            const sq = await readSnapshotQuotes();
            const idx = (await db.collection('marketIndex').doc('latest').get()).data();
            const by = {};
            for (const code in (sq?.quotes || {})) {
              const q = sq.quotes[code];
              if (!q.live || !(q.price > 0)) continue;
              by[code] = [+(q.changePercent ?? 0), Math.round((q.volume || 0) / 1000) || (q.volume || 0)];
            }
            if (Object.keys(by).length > 200) {
              await db.collection('snap0930Archive').doc(today).set({
                date: today, byCodeJson: JSON.stringify(by), n: Object.keys(by).length,
                idxChgPct: idx?.weightedChangePercent ?? null, srcMins: mins, at: Date.now(),
              });
              log(`✓ 0930快照歸檔 ${today}（${Object.keys(by).length} 檔·擷取於 ${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}）`);
            }
          } catch (e) { log('✖ 0930快照歸檔:', e.message); }
        }
        // 13:50 撿尾盤榜快照存證（實盤前追蹤·使用者13:25實際可見的live版；14:00後會被close版覆蓋故先存）
        if (mins >= 13 * 60 + 50 && mins < 14 * 60 + 30 && _tailTrackDate !== today) {
          _tailTrackDate = today;
          try {
            const mp = (await db.collection('marketPattern').doc('latest').get()).data();
            const tp = mp?.tailPicks;
            if (tp?.date === today && tp.source === 'live' && (tp.buyable || []).length) {
              const items = tp.buyable.slice(0, 10).map(x => ({ code: x.code, name: x.name, price: x.price, chg: x.chg, char: x.char || null }));
              await db.collection('tailTrack').doc(today).set({ date: today, items, n: items.length, evaluated: false, at: Date.now() });
              log(`✓ 撿尾盤追蹤存證 ${today}（${items.length} 檔）`);
            }
          } catch (e) { log('✖ 撿尾盤追蹤存證:', e.message); }
        }
        // 16:55 對答案：以 chipArchive 次交易日開/收盤評估 pending 的撿尾盤追蹤（滾動統計→tailTrack/summary）
        if (mins >= 16 * 60 + 55 && _tailEvalDate !== today) {
          _tailEvalDate = today;
          try {
            const arch = (await db.collection('chipArchive').orderBy('date', 'desc').limit(8).get()).docs
              .map(d => ({ date: d.id, close: d.data().closeJson ? JSON.parse(d.data().closeJson) : null }))
              .filter(d => d.close).sort((a, b) => a.date.localeCompare(b.date));
            const idxOf = Object.fromEntries(arch.map((d, k) => [d.date, k]));
            const pend = await db.collection('tailTrack').where('evaluated', '==', false).limit(10).get()
              .catch(() => null);
            const docs = pend ? pend.docs : (await db.collection('tailTrack').orderBy('date', 'desc').limit(6).get()).docs.filter(d => !d.data().evaluated && d.data().items);
            const CO = 0.4425;
            for (const doc of docs) {
              const x = doc.data();
              const k = idxOf[x.date];
              if (k == null || k >= arch.length - 1) continue;   // 次交易日資料未到
              const nx = arch[k + 1].close;
              const outs = x.items.map(it => {
                const r = nx[it.code]; if (!r || !(r[0] > 0) || !(r[2] > 0) || !(it.price > 0)) return null;
                return { code: it.code, char: it.char, openNet: +((r[2] - it.price) / it.price * 100 - CO).toFixed(2), closeNet: +((r[0] - it.price) / it.price * 100 - CO).toFixed(2) };
              }).filter(Boolean);
              if (!outs.length) continue;
              await doc.ref.set({ evaluated: true, evalDate: arch[k + 1].date, outcomes: outs }, { merge: true });
              // 滾動彙總
              const sRef = db.collection('tailTrack').doc('summary');
              await db.runTransaction(async tx => {
                const sd = (await tx.get(sRef)).data() || { n: 0, openNetSum: 0, openWin: 0, closeNetSum: 0, closeWin: 0, days: 0, hotN: 0, hotOpenSum: 0 };
                for (const o of outs) {
                  sd.n++; sd.openNetSum += o.openNet; sd.closeNetSum += o.closeNet;
                  if (o.openNet > 0) sd.openWin++; if (o.closeNet > 0) sd.closeWin++;
                  if (o.char === '炒作型') { sd.hotN++; sd.hotOpenSum += o.openNet; }
                }
                sd.days++;
                sd.openNetAvg = +(sd.openNetSum / sd.n).toFixed(3); sd.openWinPct = +(sd.openWin / sd.n * 100).toFixed(1);
                sd.closeNetAvg = +(sd.closeNetSum / sd.n).toFixed(3); sd.closeWinPct = +(sd.closeWin / sd.n * 100).toFixed(1);
                sd.hotOpenAvg = sd.hotN ? +(sd.hotOpenSum / sd.hotN).toFixed(3) : null;
                sd.updatedAt = Date.now(); sd.note = '撿尾盤定版濾網實盤前追蹤（明開賣為定版出場）·歷史回測對照：開賣+0.055%/炒作型+0.29%';
                tx.set(sRef, sd);
              });
              log(`✓ 撿尾盤對答案 ${x.date}→${arch[k + 1].date}（${outs.length} 檔）`);
            }
          } catch (e) { log('✖ 撿尾盤對答案:', e.message); }
        }
        // 13:36 尾盤五檔歸檔（委買賣失衡的歷史原料）——2026-08-02 重寫，見 _depthWin 宣告處
        // 資料來源改為 13:20~13:35 的**全市場累積窗**（非優先集 latest），
        // 且逐筆時間戳必須落在窗內；母體固定＝當日全市場，不再隨使用者行為漂移。
        if (mins >= 13 * 60 + 36 && _depthArchDate !== today) {
          _depthArchDate = today;
          try {
            const winOK = _depthWin.date === today;
            const lo = new Date(tw); lo.setHours(13, 20, 0, 0);
            const hi = new Date(tw); hi.setHours(13, 35, 0, 0);
            const out = {};
            let stale = 0;
            if (winOK) for (const c in _depthWin.data) {
              const e = _depthWin.data[c];
              const at = new Date(new Date(e.at).toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
              if (at >= lo && at <= hi) out[c] = { bid: e.bid, ask: e.ask };
              else stale++;
            }
            const n = Object.keys(out).length;
            // Firestore 單文件 1MiB 上限：全市場約 320KB，仍加保險（超標就只存彙總失衡值）
            let json = JSON.stringify(out), mode = 'raw';
            if (json.length > 900_000) {
              const slim = {};
              for (const c in out) {
                const b = (out[c].bid || []).reduce((s, x) => s + (x[1] || 0), 0);
                const a = (out[c].ask || []).reduce((s, x) => s + (x[1] || 0), 0);
                slim[c] = [b, a];                                  // [委買總張, 委賣總張]
              }
              json = JSON.stringify(slim); mode = 'slim';
              log(`  ⚠ 尾盤五檔超過 900KB，改存彙總失衡（${n} 檔）`);
            }
            if (n >= 300) {
              await db.collection('bookDepthArchive').doc(today).set({
                date: today, byCodeJson: json, n, mode,
                winFrom: '13:20', winTo: '13:35', staleDropped: stale, archivedAt: Date.now(),
              });
              log(`✓ 尾盤五檔歸檔 ${today}（${n} 檔·${mode}·窗外丟棄 ${stale}）`);
            } else {
              // 沒歸檔就要留下痕跡——舊版靜默跳過，9 天缺 2 天都沒人知道
              await db.collection('bookDepthArchive').doc(today).set({
                date: today, n, skipped: true,
                reason: winOK ? `窗內樣本僅 ${n} 檔（<300）` : '13:20~13:35 未累積到資料（daemon 當時未運行？）',
                archivedAt: Date.now(),
              });
              log(`⚠ 尾盤五檔歸檔跳過 ${today}：${winOK ? `窗內僅 ${n} 檔` : '累積窗無資料'}`);
            }
            _depthWin = { date: '', data: {} };   // 釋放記憶體
          } catch (e) { log('✖ 尾盤五檔歸檔:', e.message); }
        }
        if (mins >= 15 * 60 + 10 && _dailyJobsDate !== today) { await runDailyJobs(); _dailyJobsDate = today; }
        if (mins >= 16 * 60 + 30 && _officialDate !== today) { await runJobSet(OFFICIAL_CATCHUP, '(official)'); _officialDate = today; }
        if (mins >= 21 * 60 + 45 && _marginDate !== today) {
          await runJobSet(MARGIN_CATCHUP, '(margin)');
          _marginDate = today;
          try { await computeChipPicks(); } catch (e) { log('✖ 資券後重算 chipPicks:', e.message); }  // 讓晚間資券立刻進榜單/評分
        }
        // 16:45 籌碼性格分類（炒作/長期核心，3 年 chipArchive；官方補抓寫完當日 archive 後）
        if (mins >= 16 * 60 + 45 && _characterDate !== today) {
          _characterDate = today;
          execScript('analyze-chip-character.mjs', ['--write'], '🧬 chip character', 15);
        }
      }
      // 17:00 第二大腦備份（每日、不分交易日——帳號/持倉隨時會變）。子程序執行不佔 daemon 記憶體。
      // 16:45 上櫃檔補跑：TPEx 官方日檔約 16:00 後發布——15:10 歸檔/策略榜若因日期
      // 不合致跳過上櫃（otcPending），此時重跑合併，並讓依賴收盤的預測用上完整資料。
      if (mins >= 16 * 60 + 45 && _otcFixDate !== today) {
        _otcFixDate = today;
        try { await archiveOtcIndex(); } catch (e) { log('✖ 櫃買指數歸檔:', e.message); }
        try { await archiveChipDaily(); } catch (e) { log('✖ otc補跑 archive:', e.message); }
        try { await computeStrategyPicks(); } catch (e) { log('✖ otc補跑 strategyPicks:', e.message); }
        try { await computeLimitUpForecast(); } catch (e) { log('✖ otc補跑 limitUp:', e.message); }
        try { await checkRsiHot(); } catch (e) { log('✖ rsiHot盤後:', e.message); }
        try { await computeSwingPicks(); } catch (e) { log('✖ 波段起漲盤後:', e.message); }   // 收盤定版價出貨警示（盤中另有每分檢查）
      }
      if (mins >= 17 * 60 && _backupDate !== today) {
        _backupDate = today;
        // 漲停前夜 5 日前瞻實驗（2026-07-20起·對答案+明日預測·冪等·滿5日自動總結後無事可做）
        execScript('prelimit-experiment.mjs', [], '🎯 漲停前夜實驗', 10);
        execScript('backup-brain.mjs', [], '🧠 brain backup', 10);
        // 17:00+ 使用數據彙總（績效/歸因/站務；在備份前完成寫入會被隔日備份涵蓋）
        execScript('compute-analytics.mjs', [], '📊 analytics', 10);
      }
    } catch (e) { log('✖ daily jobs loop:', e.message); }
    await sleep(300000); // 每 5 分鐘檢查
  }
}
if (!ONESHOT) dailyJobsLoop();

// 再平衡設定監看：使用者在 UI 更新現金部位後，45 秒內重算配置漂移
// (否則要等每日排程，看起來像「輸入沒成功」)。
async function rebalanceSettingsLoop() {
  for (;;) {
    try {
      const premium = await getPremiumUsers();
      let stale = false;
      for (const u of premium) {
        const [st, led, rb] = await Promise.all([
          db.collection('users').doc(u.id).collection('data').doc('rebalanceSettings').get(),
          db.collection('users').doc(u.id).collection('data').doc('cashLedger').get(),
          db.collection('users').doc(u.id).collection('data').doc('rebalance').get(),
        ]);
        const rbAt = rb.data()?.updatedAt || 0;
        if ((st.exists && (st.data().updatedAt || 0) > rbAt) || (led.exists && (led.data().updatedAt || 0) > rbAt)) { stale = true; break; }
      }
      if (stale) { await checkAllocationDrift(); log('✓ 配置漂移：偵測到設定變更即時重算'); }
    } catch (e) { log('✖ rebalance settings loop:', e.message); }
    // 讀取收斂：原 90s(24/7 讀每位高級會員 3 文件)→ 盤中 4 分、盤後 12 分。
    // 使用者改現金/再平衡設定後最慢 4~12 分重算，對非即時的配置調整足夠。
    const tw = taipei(); const m = tw.getHours() * 60 + tw.getMinutes();
    const active = isTradingDay(tw) && m >= 8 * 60 && m < 14 * 60;
    await sleep(active ? 240000 : 720000);
  }
}
if (!ONESHOT) rebalanceSettingsLoop();

// 互動佇列（問AI／NL選股／自訂回測）：監聽驅動，不再定時輪詢。
//
// 2026-08-01 讀取暴增稽查（READ_TRACE 實測）：舊版每 15 秒輪詢 3 個佇列 doc ×
// 每個 premium 用戶 ＝ 68 reads/min、24/7 不停——夜間閒置基線 ~5,000 reads/hr
// 的全部來源（停機實測 400→20/5min 佐證）。等人按按鈕卻整夜掃描。
//
// 改為 onSnapshot：閒置時 0 計費讀取（連線保持不算 reads），有人送出請求時
// 監聽器即時喚醒對應處理器——延遲從最壞 15 秒變即時，讀取從 ~100k/日變 ~3k/日。
// 保底：每 30 分鐘重掛監聽（涵蓋 premium 名單變動＋監聽器靜默死亡），
// 重掛時的 initial snapshot 兼作漏網掃描——wm-resilience「cascade fallback」。
const _queueDirty = { questions: true, nlScreen: true, customBacktest: true };  // boot 先掃一次
let _queueWake = null;
let _queueUnsubs = [];
function _wakeQueue(kind) {
  _queueDirty[kind] = true;
  if (_queueWake) { const w = _queueWake; _queueWake = null; w(); }
}
async function refreshQueueListeners() {
  for (const un of _queueUnsubs) { try { un(); } catch { /* already dead */ } }
  _queueUnsubs = [];
  const premium = await getPremiumUsers();
  for (const u of premium) {
    for (const [docId, kind] of [['questions', 'questions'], ['nlScreen', 'nlScreen'], ['customBacktest', 'customBacktest']]) {
      const ref = db.collection('users').doc(u.id).collection('data').doc(docId);
      _queueUnsubs.push(ref.onSnapshot(
        () => _wakeQueue(kind),
        () => { /* 監聽器出錯先不重掛——30 分鐘保底輪會整批重建 */ },
      ));
    }
  }
}
async function questionLoop() {
  try { await refreshQueueListeners(); } catch (e) { log('✖ queue listeners:', e.message); }
  let lastRefresh = Date.now();
  for (;;) {
    if (_queueDirty.questions) { _queueDirty.questions = false; try { await answerQuestions(); } catch (e) { log('✖ question loop:', e.message); } }
    if (_queueDirty.nlScreen) { _queueDirty.nlScreen = false; try { await runNlScreens(); } catch (e) { log('✖ nl screen loop:', e.message); } }
    if (_queueDirty.customBacktest) { _queueDirty.customBacktest = false; try { await runCustomBacktests(); } catch (e) { log('✖ custom backtest loop:', e.message); } }
    if (Date.now() - lastRefresh > 30 * 60000) {
      try { await refreshQueueListeners(); } catch (e) { log('✖ queue listeners:', e.message); }
      lastRefresh = Date.now();
    }
    // 等監聽器喚醒；30 分鐘保底醒來做重掛與漏網掃描
    if (!_queueDirty.questions && !_queueDirty.nlScreen && !_queueDirty.customBacktest) {
      await new Promise(res => { _queueWake = res; setTimeout(res, 30 * 60000); });
    }
  }
}
if (!ONESHOT) questionLoop();

// ── 單次執行 runner（檔尾：此時所有 function 與 module 級宣告都已就緒）─────
// 用法：node scripts/ai-daemon.mjs --run <job> [--late]
//   asia        日韓早盤風向（--late 標記為補跑）
//   chipPicks   籌碼推選（含 marginSnap 的 KD/vol20/RSI 欄位）
//   alerts      持股警報（含 RSI 高檔警報）
//   swingPicks  波段起漲榜
//   asiaBoth    先 chipPicks 再 alerts（RSI 警報需要 marginSnap 先更新）
if (ONESHOT) {
  const JOBS = {
    asia: () => computeAsiaPremarket({ lateCatchup: process.argv.includes('--late') }),
    chipPicks: () => computeChipPicks(),
    alerts: () => checkAlerts(),
    swingPicks: () => computeSwingPicks(),
    strengthPicks: () => computeStrengthPicks(),
    globalMarkets: () => computeGlobalMarkets(),
  };
  const fn = JOBS[ONESHOT];
  if (!fn) { log(`✖ 未知 job「${ONESHOT}」。可用：${Object.keys(JOBS).join(', ')}`); process.exit(1); }
  try { await fn(); log(`✓ 單次執行完成：${ONESHOT}`); process.exit(0); }
  catch (e) { log(`✖ 單次執行失敗 ${ONESHOT}:`, e.stack || e.message); process.exit(1); }
}
