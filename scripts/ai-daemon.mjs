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
import { backfillMopsRevenue } from './backfill-mops-revenue.mjs';
import { replayLedger, statRows } from './lib/ledger-replay.mjs';
import { buildStrategySeries, buildStrategyWindows, computeHoldingStrategy } from './lib/holding-strategy.mjs';
import { judgePagoda } from './lib/pagoda.mjs';

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

// 數字校驗：把回答裡的「有單位數字」逐一比對來源資料，對不上就是編造的。
// 用途不只新聞判別——「嚴禁編造數字」這條規則同時寫在每日分析、個股分析、
// 問AI 三個提示詞裡，但**只有提示詞、沒有任何程式在檢查**（J 族：規則只寫在
// 提示裡就會失效，今天已證實模型會無視）。傷害最大的是問AI，
// 因為使用者會直接照著那個數字做決定。
// ⚠ 只驗有單位的數字。純序號、年份、條列編號不算，否則誤報會蓋掉真警訊。
// 量測模式：只記錄不改輸出。用來在**套用前**先確認誤報率——
// 每日分析與個股分析是長文、數字來源較雜，貿然套用可能製造大量假警報，
// 而假警報會蓋掉真警訊（這專案吃過很多次）。先觀察幾天再決定。
function probeNumbers(tag, answer, sourceText) {
  try {
    const bad = unverifiedNumbers(answer, sourceText, 'derive');
    if (bad.length) log(`  [數字校驗·量測] ${tag}：${bad.length} 個對不上 → ${bad.slice(0, 5).join('、')}`);
    else log(`  [數字校驗·量測] ${tag}：全部可查證`);
  } catch { /* 量測不可影響主流程 */ }
}

// mode='quote'：模型**只該引用**資料（問AI）⇒ 驗完整單位集，含元/張/點。
// mode='derive'：模型**本來就會算**（分析路徑會給目標價、停損、部位張數）
//   ⇒ 只驗事實型單位（%/倍/億/萬），否則誤報會蓋掉真警訊。
// 分界不是憑感覺，是量出來的（2026-08-31，400 次分析輸出）：
//   查不到的數字裡 元146/張74/點5 = 225 個（＝算出來的），
//   億13/萬5/%4 = 22 個（＝引用型）。
//   全單位集誤報率 20%，只看事實型降到 3%。
function unverifiedNumbers(answer, sourceText, mode = 'quote') {
  const norm = t => String(t || '').replace(/[,，\s]/g, '');
  const corpus = norm(sourceText);
  const re = mode === 'derive'
    ? /\d+(?:\.\d+)?(?:%|％|倍|億|萬)/g
    : /\d+(?:\.\d+)?(?:%|％|倍|億|萬|元|張|點)/g;
  const nums = [...new Set(norm(answer).match(re) || [])];
  return nums.filter(n => !corpus.includes(n) && !corpus.includes(n.replace(/％/, '%')));
}

// 啟動時把**自身程式碼的雜湊**寫進 system/daemonBuild，供稽核比對
// 「執行中的 daemon 是不是最新碼」。改了程式卻忘了重啟會**靜默跑舊碼**：
// 不報錯、不告警，只是修正沒生效（2026-08-30 實際發生過一次）。
// ⚠ 用內容雜湊而非 mtime：git checkout / touch 這類不改內容的操作也會
//   更新 mtime ⇒ 假警報。第一版就是 mtime，寫完當場誤報。
// ⚠ 宣告必須在使用之前（今天第五次踩到宣告順序）。
let _daemonCodeHash = null;
async function _recordDaemonBuild() {
  try {
    const { readFileSync } = await import('node:fs');
    const { createHash } = await import('node:crypto');
    _daemonCodeHash = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex').slice(0, 16);
    await db.collection('system').doc('daemonBuild').set({
      codeHash: _daemonCodeHash, startedAt: Date.now(), host: os.hostname(), updatedAt: Date.now(),
    });
  } catch (e) { log('⚠ 記錄 daemon 版本失敗:', (e.message || '').slice(0, 40)); }
}

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
// ── 模式技能：三個模式各一份，格式統一（口徑標頭 → 進場 → 出場 → 避開 → 限制）
// 多模態鐵律：每個模式的權重必須各自回測，**絕不互借**。同一個變數在不同持有期
// 可以完全相反（vol20 在隔日沖是扣分、在波段是 gate；RSI 高檔對買方與持有者相反）。
// ── 操作模式（2026-08-03 模式化）─────────────────────────────────────
// 多模態鐵律：每個模式的權重必須各自回測，**絕不互借**。同一個變數在不同持有期
// 可以完全相反——vol20 在隔日沖是扣分項、在波段是進場 gate；RSI 高檔對買方是
// 「別追」、對持有者卻「不是賣訊」。混用是本專案最容易犯也最貴的錯。
const MODES = {
  nextday: { key: 'nextday', label: '隔日沖', icon: '🎯', horizon: '今收買→明開賣', hasModel: true },
  swing:   { key: 'swing',   label: '波段',   icon: '🌊', horizon: '今收買→第5日收盤賣', hasModel: false },
  daytrade:{ key: 'daytrade',label: '當沖',   icon: '⏳', horizon: '當日買賣', hasModel: false },
};
const MODE_SKILL = () => ({ nextday: NEXTDAY_SKILL, swing: SWING_SKILL, daytrade: DAYTRADE_SKILL });
/** 使用者當前模式（存 users/{uid}.tradingMode，預設隔日沖＝本站主模式） */
async function getUserMode(uid) {
  try {
    const m = (await db.collection('users').doc(uid).get()).data()?.tradingMode;
    return MODES[m] ? m : 'nextday';
  } catch { return 'nextday'; }
}
/** 跨模式口徑警告：問題命中他模式技能時，明說兩者不可互推 */
function crossModeWarning(active, other) {
  const A = MODES[active], B = MODES[other];
  return `【⚠跨模式口徑警告】使用者目前在 **${A.icon}${A.label}模式**（${A.horizon}），但這個問題牽涉 **${B.icon}${B.label}**（${B.horizon}）的訊號。
兩者的持有期、出場規則與成本口徑都不同，**實測數字不可互相推論**。回答時必須：
① 明說這是哪個模式的數字；② 若使用者想用他模式的訊號操作目前模式，直接講清楚實測後果（例如波段起漲訊號拿去隔日沖是 -0.06%）；③ 不要把兩個模式的數字混在同一句話裡比較。`;
}

const NEXTDAY_SKILL = `【隔日沖模式（本站主模式·資料最全·已校準）】
◆口徑：買在今日收盤 → 賣在**明日開盤**。可交易宇宙＝當日漲幅 ≤8.5%（漲逾此收盤買不到）。成本 0.4425%（手續費×2＋證交稅0.3%）。
◆基準（先記住這個，否則會高估自己）：可交易宇宙明開賣 **-0.13%·淨勝約41%**——隨便買一檔平均是賠的。這不是「有訊號就做」的遊戲，是「大部分日子不做」的遊戲。

【出場｜這是全站最大的單一效應，先講】
一律**明早開盤賣**。screen-exit.mjs 700日×兩半窗實測五種出場：
· A 明早開盤賣 → 定版池 +0.061/+0.118%·淨勝46-47%（**唯一兩窗穩定淨正**）
· C1 開高抱到收盤 → **-0.33%**（把開盤溢價吐光·直覺被否證）
· C3 開高≥2%才抱 ≈ 打平｜C4 開低凹到收盤 淨勝率最高(51-53%) 但均值更差（凹單勝率假象·左尾肥）
⇒ **開盤溢價就是隔日沖的全部 edge，拿了就走。**

【進場｜唯一淨正的濾網】
撿尾盤定版濾網＝**破20日高 × 收盤位置pos≥0.7 × 當日漲3~7%**
· 明開賣 淨勝45.7%·淨均 +0.055%/筆（五方案回測中唯一淨正）·日均17.7檔
· 明收賣口徑仍 -0.463% ⇒ 此濾網**限「明早強勢即賣」紀律**，不可抱
· 舊濾網（漲≥1·pos≥0.9·破5日高）五案最差(-0.204%)已汰換
資券借券疊加、PID 遞迴控制（六參數×43萬樣本）皆測過且**全數不採**——資訊不在那裡。

【評分｜加分只有兩項，扣分有八項】
分數＝校準後的隔日上漲機率概念值。⚠**用法是「找沒有扣分的」不是「找分數最高的」**。
加分：🏔破高×強尾 +2（45.4-48.2%·淨均+0.3~0.6%/筆）｜⚡軋空 +2（46.0-47.7%·+0.33~0.48%）
扣分：🐑跟風 -2（-0.36~-1.46pp·淨勝29%）｜💪強尾單獨 -2（41.3-43.8%·舊版+2為誤已修正）｜🔥5日漲≥20%過熱 -2（-0.24~-0.55pp）｜🪤散戶接棒 -2（-1.8~-2.3pp）｜📉K>90 -2（-0.265/-0.244·勝34.5/29.7%）｜📉K80~90∧跌破5MA -2（-0.263/-0.248·勝37.7/33.4%）｜😴vol20<1.5%低波動 -2（Δ-0.199/-0.159）｜倒貨≥30% -1
性格條款：長期核心股停用動能加分（破高×強尾、過熱懲罰皆不適用·性格分割檢定）。
週轉率<0.5% 冷門股排除（-0.088/-0.128）。

【分數怎麼讀｜官方校準·別誤讀】
<40 → 實測上漲 36%（34-38%兩窗）｜40-45 → 44%｜46-51 → 47%｜**≥52 → 47%（淨≈0）**
⚠≥52 是**排序上的最強分組，不是淨正保證**。真正的淨正入場＝「≥52 ∧ 撿尾盤定版濾網 ∧ 明早開盤賣」三者同時，缺一不可。
tier 排序（開賣口徑）：A(+0.17) > B+(+0.02) > S(-0.02) > B(-0.05) > watchHot(-0.09) > danger(-0.21) > neutral(-0.26)

【空手條件｜符合任一就不要做】
🚫危險級｜🐑跟風（開賣-1.6%）｜🔥5日漲逾20%｜🪤散戶接棒｜漲逾8.5%（買不到）

【⚠口徑隔離｜這些訊號不可用於隔日沖】
· 🌊波段起漲：隔日開賣 **-0.06%**，edge 全在第5日
· 🚀波段追強：隔日開賣 **-0.07%**
· 🌡RSI高檔勿買高點／KD破底風險：波段口徑（持有5日），且對買方與持有者意義相反
拿 5 日語意的訊號做隔日沖會直接虧掉——這三個都實測過。非投資建議。`;

const SWING_SKILL = `【波段模式（本站實證·持有5個交易日·非隔日沖）】
◆口徑：買在今日收盤 → 賣在**第5個交易日收盤**。可交易宇宙 chg≤8.5%，成本 0.4425%。
◆基準：可交易宇宙 5日淨均 -0.30%(主窗)／+0.36%(OOT)·淨勝 42.6%／48.2%。
◆本模式**沒有 0~100 評分卡**（刻意不建）——用「榜單 ∧ gate ∧ 提醒」三層，每一項各自有兩窗實證。
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
【波段技巧·勿買在高點·2026-08-03】**同一個 RSI 高檔訊號，對「買方」與「持有者」意義相反**——這是本技巧的核心，也是最容易搞錯的地方：
· **還沒買 → 是差的進場點**（可交易宇宙 chg≤8.5%·扣費稅·買後5日）：
    基準 主窗 -0.125%／中位 -0.693%｜OOT +0.448%／-0.051%
    RSI5>85 主窗 -0.356%／-1.236%（Δ-0.231/-0.543）｜OOT +0.194%／-0.443%（Δ-0.254/-0.392）
    雙高>85 主窗 -0.268%／-1.160%（Δ-0.143/-0.467）｜OOT +0.164%／-0.641%（Δ-0.284/-0.590）
  三組在**兩窗 × 均數與中位數 全部較差**，中位數落差(-0.39~-0.59pp)大於均數落差 ⇒ 追高的代價主要在「多數個案」而非平均。等回檔再進，不要追。
· **已經持有 → 高檔不是賣訊**：續抱1/3/5/10/20日均 +0.346/+0.431/+0.458/+1.037/+1.896%（RSI5>85·主窗），抱越久越好；真頂點率(今收為未來10日最高收盤)僅 1.10~1.35x 基準。⚠但中位數在主窗全為負 → 一半以上個案賣掉比較好、平均卻是抱著好（右尾驅動），所以只能移動停利／分批，不能一次全出也不該追。
· **雙高(RSI5∧RSI10 皆>85)不是更該賣，是波動雙向放大**：加上 RSI10>85 後 續抱10日均 0.847→1.635%(主窗)／1.969→2.753%(OOT)【上升】、真頂點率 25.5→23.0%／20.8→19.4%【下降】；5日曾跌≥5% 42.2→51.9%／25.0→36.9%，但 10日曾漲≥5% 也同步 55.1→66.6%／48.0→59.6%。
· **真正比較像頂的是「RSI5>85 但 RSI10≤85」**（單腳過熱、中期沒跟上）：真頂點率 1.16x/1.22x/1.24x(主窗5/10/20日)、1.24x/1.31x/1.35x(OOT)＝三組最高，續抱報酬三組最低。
· 用途定位：**提醒不下指令**。持股清單與個股頁只顯示提醒（🌡勿買高點／⚠️單腳過熱／🔥雙高），不併入隔日沖綜合評分（口徑隔離），由使用者自行判斷。
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
風險（必說）：即使最嚴組合真起漲也只有24.3%——四次有三次不是真轉折（會再破底或彈不到5%）。左尾重：分批小部位、破前低無條件停損、單筆風險≤1%。非投資建議。

【第2套預選機制：PID 斜率曲線·2026-08-11 上線·**實驗級功能，不是已驗證訊號**】
◆做法：把 20 日走勢除以該檔自身日波動 σ 後做 PID 分解——P 現況（對 5 日均線的偏離）、
  I 累積、D 斜率、D2 加速度——逐日橫斷面 z-score 後分 8 型（k-means；分型中心以
  2022-07~2024-03 擬合後**凍結**，再套用到後續兩窗，避免偷看未來）。每型取相似度最高前 20 檔。
◆**回答時必須先講清楚它的等級**：歷史三窗（主窗前半／後半／OOT）中，八種曲線
  **沒有任何一種**同時滿足「淨報酬Δ與勝率Δ皆為正」。它現在的身分是前瞻實驗，
  裁判是 60 個交易日的實記（進度見 選股→訊號榜單→波段模式）。
  ⇒ 不得與⭐三重確認／波段追強同級陳述，也不得說「回測顯示這型勝率高」。
◆歷史三窗傾向（僅供排序與揭露，非保證）：
  · 曲線4 加速上升·強於趨勢：淨報酬Δ 5日[.16/.30/.19]、20日[.67/.98/1.26] **三窗全正**，
    最大累計成長 20日 15.23%（八型最高），但**勝率Δ 反而全負、回檔 -10.30% 最深**
    ⇒ 右尾驅動：少數大贏、多數小輸（與 rsi85HoldAlert 同構）。
  · 曲線5 減速橫盤：20日勝率Δ[+0.92/+0.19/+0.80] 三窗全正 ⇒ 勝率型，成長平庸但回檔淺。
  · 曲線8 加速橫盤·強於趨勢：勝率Δ[-1.40/-3.12/-2.00] 全負 ⇒ 適合當**排除濾網**（追高橫盤）。
◆**最大累計成長一律要與同期最大回檔一起講**。前一版（走勢相似度推最大漲幅）已實測：
  只照最大漲幅排行＝系統性買進最會亂跳的股票，回檔加深約六成而報酬無增量（見 swingAnalog）。
非投資建議。
【🗼 寶塔線技能·2026-08-15 使用者定義·古典規則未經本站回測】
◆寶塔線(3)＝三線轉向：收盤>前三根寶塔線最高點→翻紅；收盤<前三根最低點→翻黑；否則延續。
◆波段口徑（日K）：紅K且站上月線(MA20)→未翻黑前可續抱；綠K且跌破月線→賣出；紅K在月線下＝觀察（不符續抱）；綠K在月線上＝警戒（留意翻黑）。
◆短線口徑（隔日沖/當沖）：同規則，K線圖改 60 分K、均線改 20 根 60 分K。
⚠檢定結果（2026-08-15 swing-lab·991 交易日事件驅動·扣費稅）：**未過**。翻紅×月線上進/翻黑出：主窗 n=17,177 淨均 -0.062%·勝率 25.7%·前後半 -0.58/+0.40 方向不一致；寬鬆版（綠K且破月線才出）淨均 +0.27% 但同樣前後半換向。趨勢跟蹤型規則在盤整期反覆假翻轉是主因。⇒ 定位=**判讀輔助**（現況的顏色語言），不是進出場訊號；與「明早開盤賣」鐵律衝突時，隔日沖持股以鐵律優先。同批檢定：⭐三重確認＋固定第5日為唯一全關卡通過者（主窗 +1.147%·勝54%·兩半 +0.66/+1.76·OOT +0.53，基準 -0.16/-0.03）；移動停利10%/2×ATR 平均更高（+1.48/+1.08）但近半年段轉負（兩半不一致）＝不穩定不採用；投信認養連3買、箱型收斂突破皆未過。`;

// 開盤三關選股法（當沖/短線·使用者提供之方法論，2026-07-19 導入）
// 本站實證註記：第二關「跟風漲放棄」已於日線代理驗證（日配對後跟風股仍-0.36~-1.46pp）；
// 第一關/第三關需盤中歷史，0930 快照自今起累積、權重待資料足夠後回測（data-gated）。
const DAYTRADE_SKILL = `【當沖模式（⚠**本模式無評分模型·資料累積中**）】
◆口徑：當日買、當日賣。證交稅減半 0.15%（一般 0.3%），手續費兩趟 ⇒ 成本約 0.2925%，低於隔日沖的 0.4425%。
◆**誠實揭露（最重要）**：本站對當沖**尚無經驗證的評分模型**，也不會給你分數。原因是原料不足：
  · 三關法第一關（前30分量能）與第三關（拉回品質）都需要**個股盤中歷史**
  · 自建 snap0930Archive 目前僅 10 個交易日；Yahoo 5分K 只保留 60 交易日（滾動過期）
  · 本站標準是 480 日主窗 ＋ 第三獨立窗 OOT ⇒ 還差約 1.5~2 年
  · 已於 2026-08-03 建立 intradayArchive 逐日歸檔並一次性回補 60 日，資料到位後會用同一套關卡驗證再開放評分
  在那之前，本模式提供的是**已驗證的那一關 ＋ 即時觀察工具**，判斷權完全在你。

【開盤三關選股法（使用者方法論·逐關檢核·任一關不過即放棄）】
第一關·量能達標：前30分鐘(9:00-9:30)成交量 ≥ 昨日總量40%。大戶真進場前30分必卯起來吃貨；漲5%但前30分量<昨日20%＝八成是拉給散戶追的假突破。
  → 狀態：**待驗證**（需盤中歷史·資料累積中）。app 會顯示實際比率供你自行判斷，但不計分。
第二關·相對強度：大盤平盤震盪(±0.5%)時個股已穩站+3%、大盤小拉回時它不跟跌＝自己強(主力在顧)；大盤拉它才拉、大盤縮它就軟＝跟風漲→放棄（做跟風股等於賭大盤，不如買台指期）。
  → 狀態：**✅已驗證並入權重**。日線代理實證（screen-gate2.mjs·700日兩窗同向）：漲≥3%但RS<1的跟風股，日配對後仍 -0.36~-1.46pp/筆·淨勝僅28.9%。🐑跟風徽章即由此而來（隔日沖綜合評分 -2）。
  ⚠注意：此關的驗證是**日線代理**（日終RS），不是盤中即時RS。方向獲支持，但盤中版本仍待原料到位後複驗。
第三關·拉回品質(最關鍵)：攻擊段大量→拉回量縮到 1/3~1/4 ＝健康(主力沒跑)→站回均價線進場；拉回量不縮甚至越跌越大量＝出貨→移除自選、今日不再看。
  → 狀態：**待驗證**（需盤中歷史·資料累積中）。

【本模式可用的即時工具（觀察用·非訊號）】
📡盤中雷達｜⚡盤中爆量｜🚀漲停預測｜📈即時漲跌｜三關即時數據（有多少算多少，缺就說缺）

【⚠不可挪用的東西】
· 隔日沖計分卡：那是「今收買→明開賣」口徑，當沖持有期短一個數量級、成本也不同，直接套用沒有依據
· 波段⭐三層：5日語意，與當沖無關
紀律：三關全過才等進場點；缺數據就說缺什麼，**不猜**。本模式無評分，不要向使用者暗示有。非投資建議。`;

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

// ── Ollama 健康探測與 daemon 健康文件（wm-llm-provider-routing F11·wm-observability F14·2026-09-04）──
// 單供應商（本機 Ollama）沒有降級鏈，能做的是**早知道**：開機＋每小時打 /api/tags（5 秒逾時），
// 連同熔斷器狀態、每日任務耗時一起寫 system/daemonHealth（獨立文件，不與 16:10 audit 覆寫的 dataHealth 互踩）。
let _ollamaHealth = { ok: null, at: 0, latencyMs: null, models: null, error: null };
let _ollamaFailStreak = 0;
async function probeOllama() {
  const t0 = Date.now();
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const j = r.ok ? await r.json() : null;
    const models = Array.isArray(j?.models) ? j.models.map(m => m.name) : null;
    _ollamaHealth = { ok: r.ok, at: Date.now(), latencyMs: Date.now() - t0, models, error: r.ok ? null : `HTTP ${r.status}`,
      hasModel: models ? models.includes(OLLAMA_MODEL) : null };
    if (!r.ok) log(`❌ Ollama 探測失敗：HTTP ${r.status}`);
    else if (models && !models.includes(OLLAMA_MODEL)) log(`❌ Ollama 可達但沒有模型 ${OLLAMA_MODEL}（現有：${models.join(', ')}）`);
  } catch (e) {
    _ollamaHealth = { ok: false, at: Date.now(), latencyMs: Date.now() - t0, models: null, error: String(e.message || e).slice(0, 120), hasModel: null };
    log(`❌ Ollama 探測失敗：${_ollamaHealth.error}（識讀 pass 會整批失敗）`);
  }
  return _ollamaHealth;
}
const _jobTimings = {};   // name → { ms, at, tag }（F14：08:30 前完成的硬要求需要量測每段耗時）
async function timedJob(name, fn, tag = '') {
  const t0 = Date.now();
  try { await fn(); } catch (e) { log(`✖ ${name}${tag}:`, e.message); }
  const ms = Date.now() - t0; _jobTimings[name] = { ms, at: Date.now(), tag };
  if (ms > 60_000) log(`⏱ ${name}${tag} 耗時 ${(ms / 1000).toFixed(0)}s`);
  return ms;
}
function slowestJobs(n = 5) { return Object.entries(_jobTimings).sort((a, b) => b[1].ms - a[1].ms).slice(0, n).map(([k, v]) => `${k} ${(v.ms / 1000).toFixed(0)}s`).join('、'); }
let _hotStats = null;   // 快線揭示落後統計（5 分鐘一筆，見 hotQuoteLoop）
async function writeDaemonHealth() {
  try {
    await db.collection('system').doc('daemonHealth').set({
      at: Date.now(), pid: process.pid, ollama: _ollamaHealth, breakers: breakerSnapshot(),
      jobTimings: _jobTimings, slowest: slowestJobs(8), hotLag: _hotStats,
    });
  } catch (e) { log('⚠ daemonHealth 寫入失敗:', e.message); }
}
async function daemonHealthLoop() {
  for (;;) {
    await probeOllama();
    await writeDaemonHealth();
    await sleep(3_600_000);
  }
}

async function _ollamaRaw(prompt, temperature) {
  const ctl = new AbortController();
  // 逾時自「實際送出」起算(非排隊起算)，因為佇列已序列化只送一個。
  const t = setTimeout(() => ctl.abort(), 240000);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // think:false 關閉推理模型的思考輸出(Ollama 支援時生效，否則由 cleanLLM 兜底)。
      // ⚠ **取樣溫度**（2026-08-30 加）：原本完全沒設，用 Ollama 預設（多數模型 0.8）。
      //   那對創作合適，對「判別」這種分類任務等於直接製造隨機性——
      //   實測 2882 國泰金同一批新聞、相隔幾分鐘的三次判別，
      //   在「中性（0 分）」與「利多/強（約 +8 分）」之間跳動。
      //   判別路徑改用低溫（見呼叫端 opts.temperature），未指定者維持原行為，
      //   避免一次改動影響所有既有輸出。
      body: JSON.stringify({
        model: OLLAMA_MODEL, prompt, stream: false, think: false,
        ...(temperature != null ? { options: { temperature } } : {}),
      }), signal: ctl.signal,
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
  _ollamaRaw(job.prompt, job.temperature).then(job.resolve, () => job.resolve(null)).finally(() => { _llmBusy = false; _drainLLM(); });
}
let _llmSeq = 0;
function askOllama(prompt, opts = {}) {
  return new Promise(resolve => { _llmQueue.push({ prompt, priority: opts.priority || 0, temperature: opts.temperature, seq: _llmSeq++, resolve }); _drainLLM(); });
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

// ── 持股策略分析（2026-08-12 使用者需求）────────────────────────────
// 三塊全部**零 LLM**、從 chipArchive 實算——可驗證、不會編故事：
//   ① 隔日沖建議：該股今日型態對照撿尾盤定版濾網（破20日高×收位≥0.7×漲3~7%）
//     ＋炒作型/長期核心＋明開賣鐵律。
//   ② 持有日獲利分析：該股**全歷史逐日進場**後第 1/2/3/5/10/20 日的中位報酬與勝率
//     （描述統計，非對使用者這筆進場的預測——UI 必須這樣標）。
//   ③ 相似波段：近 20 日走勢除以自身波動後，在全市場歷史找最像的 30 段，
//     看它們後續 5/10/20 日的中位報酬/勝率＋最大成長與最大回檔**成對**。
//     ⚠ 誠實揭露不可省：相似度→未來報酬在本站歷史檢定**未通過**
//     （最大漲幅在數學上隨波動放大——analog 實驗實測 Top10% 回檔 -6.58% vs 宇宙 -4.07%），
//     所以它是參考描述，絕不能當訊號排序用。
let _stratCtx = { archDate: '', ctx: null };
// ── 🗼 寶塔線技能（2026-08-15 使用者定義）────────────────────────────
// 波段：日K 寶塔線(3)×月線（MA20）——紅K×線上未翻黑前續抱、綠K×線下賣出。
// 短線：同規則改 60 分K（MA=20 根 60 分K）。60 分K 收盤來自 intradayArchive
// 的 15 分取樣（整點索引 4/8/12/16/18），今日已完成小時另從 marketIntraday
// （追蹤股）補上。古典規則技能，未經本站 480 日主窗＋OOT 回測驗證。
let _pagoda60Map = {};
let _pagodaAt = 0;
async function computePagodaSignals() {
  try {
    const ctx = await getStrategyCtx();
    const daily = {}; const flipUpDaily = [];
    for (const code in ctx.series) {
      const j = judgePagoda(ctx.series[code].c, 20, 3);
      if (!j) continue;
      daily[code] = j;
      if (j.flip === 'up' && j.above) flipUpDaily.push(code);
    }
    // 60 分K：近 14 個歸檔日（~70 根）＋今日已完成小時（追蹤股）
    const h60 = {}; const flipUp60 = [];
    const seriesByCode = {};
    const snap = await db.collection('intradayArchive').orderBy('date', 'desc').limit(14).get();
    const days = snap.docs.map(d => d.data()).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    for (const day of days) {
      const by = JSON.parse(day.byCodeJson || '{}');
      for (const code in by) {
        const pts = by[code];
        if (!Array.isArray(pts) || pts.length < 19) continue;
        const closes = [4, 8, 12, 16, 18].map(i => pts[i]?.[0]).filter(v => v > 0);
        if (closes.length === 5) (seriesByCode[code] ??= []).push(...closes);
      }
    }
    try {   // 今日已完成小時（marketIntraday 只有追蹤股；沒有就用到昨日，誠實即可）
      const mi = (await db.collection('marketIntraday').doc('latest').get()).data();
      const today = isoDate(taipei());
      if (mi?.date === today && mi.seriesJson && !days.some(d => d.date === today)) {
        const by = JSON.parse(mi.seriesJson);
        const tw = taipei();
        const bounds = [10, 11, 12, 13].filter(hh => tw.getHours() * 60 + tw.getMinutes() >= hh * 60)
          .map(hh => { const b = new Date(tw); b.setHours(hh, 0, 0, 0); return b.getTime() / 1000; });
        if (tw.getHours() * 60 + tw.getMinutes() >= 13 * 60 + 30) { const b = new Date(tw); b.setHours(13, 30, 0, 0); bounds.push(b.getTime() / 1000); }
        for (const code in by) {
          const pts = by[code]?.pts; if (!Array.isArray(pts) || !seriesByCode[code]) continue;
          for (const bSec of bounds) {
            let px = 0;
            for (const pt of pts) { if (pt[0] <= bSec && pt[1] > 0) px = pt[1]; else if (pt[0] > bSec) break; }
            if (px > 0) seriesByCode[code].push(px);
          }
        }
      }
    } catch { /* 今日補點失敗不擋 */ }
    for (const code in seriesByCode) {
      const j = judgePagoda(seriesByCode[code], 20, 3);
      if (!j) continue;
      h60[code] = j;
      if (j.flip === 'up' && j.above) flipUp60.push(code);
    }
    _pagoda60Map = h60;
    await db.collection('pagodaSignals').doc('latest').set({
      date: isoDate(taipei()), updatedAt: Date.now(),
      dailyJson: JSON.stringify(daily), h60Json: JSON.stringify(h60),
      flipUpDaily: flipUpDaily.slice(0, 100), flipUp60: flipUp60.slice(0, 100),
      nDaily: Object.keys(daily).length, n60: Object.keys(h60).length,
    });
    log(`✓ 寶塔線：日K ${Object.keys(daily).length} 檔（翻多且線上 ${flipUpDaily.length}）｜60分K ${Object.keys(h60).length} 檔（翻多 ${flipUp60.length}）`);
  } catch (e) { log('  ⚠ 寶塔線計算：', (e.message || '').slice(0, 80)); }
}

async function getStrategyCtx() {
  // 以「最新歸檔日」為快取鍵而非日曆日：15:10 今日收盤歸檔落地後，
  // 傍晚的分析週期會自動重建脈絡吃到今天——用日曆日當鍵會整晚吃早上的舊窗。
  const newest = (await readArchive(1))[0]?.date || '';
  if (_stratCtx.ctx && _stratCtx.archDate === newest) { _stratCtx.ctx.pagoda60Map = _pagoda60Map; return _stratCtx.ctx; }
  const asc = (await readArchive(262)).slice().reverse();   // 舊→新（readArchive 已濾空殼）
  const series = buildStrategySeries(asc);
  const windows = buildStrategyWindows(series);
  let charMap = {};
  try { const cd = await db.collection('chipCharacter').doc('latest').get(); if (cd.exists) charMap = JSON.parse(cd.data().byCodeJson || '{}'); } catch { /* 無分類則略 */ }
  // 股名對照（相似例顯示用）：快照 quotes 全市場都有 name
  let nameMap = {};
  try { const q = (await readSnapshotQuotes())?.quotes || {}; for (const cc in q) if (q[cc]?.name) nameMap[cc] = q[cc].name; } catch { /* 缺名不擋 */ }
  // 族群對照（同族群優先取樣用）：peerComps 同業表為「相近話題/上下游」的代理
  let indMap = {};
  try {
    const pc = (await db.collection('peerComps').doc('latest').get()).data();
    if (pc?.industriesJson) { const ind = JSON.parse(pc.industriesJson); for (const g in ind) for (const it of ind[g]) if (it?.code) indMap[it.code] = g; }
  } catch { /* 缺分類不擋 */ }
  _stratCtx = { archDate: newest, ctx: { series, windows, charMap, nameMap, indMap, pagoda60Map: _pagoda60Map } };
  log(`  · 持股策略脈絡就緒（資料至 ${newest}）：${Object.keys(series).length} 檔、${windows.count} 個相似窗`);
  return _stratCtx.ctx;
}

// ── per-user analysis ──
async function analyzeUser(uid) {
  const snap = await db.collection('users').doc(uid).collection('data').doc('holdings').get();
  const holdings = snap.exists ? (snap.data().holdings || []) : [];
  if (!holdings.length) return false;

  // aggregate by code (avg cost)
  const byCode = {};
  for (const h of holdings) {
    const c = (byCode[h.code] ??= { code: h.code, name: h.name, qty: 0, costSum: 0, buyDate: null });
    c.qty += h.quantity; c.costSum += h.buyPrice * h.quantity;
    if (h.buyDate && (!c.buyDate || h.buyDate < c.buyDate)) c.buyDate = h.buyDate;   // 最早買進日→持有天數
  }

  // 可靠籌碼脈絡（chipDaily 全個股皆有）：三大法人 + 勝率雷達階段 + 主力倒貨%
  const iwCtx = await getInstWeightCtx();
  const stratCtx = await getStrategyCtx().catch(() => null);   // 持股策略脈絡（失敗不擋 LLM 分析）
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
      // 持股策略（隔日沖對照/持有日 profile/相似波段）——零 LLM 實算，見 computeHoldingStrategy
      strategy: stratCtx ? computeHoldingStrategy(stratCtx, code, g.buyDate) : null,
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
  if (out) probeNumbers('分析', out, prompt);
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
  // ⚠ 驗日期要用 title（真資料日），不能用 date 欄（服務日）——2026-09-01 抓到的
  //   B 族缺陷：date 欄恆等於「今天」，於是**每天盤前（含 boot 輪）這裡都把
  //   昨天的 PER/PBR 標成今天**。改 title 後盤前會誠實地降級 openapi（自報昨日）。
  const res = await fetchDated(
    `https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_ALL?date=${expect}&response=json`, expect, 'title');
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

/** 從標題把民國日期挖出來。兩種實測格式都要吃：
 *   TWT96U 借券 →「115年08月11日 …」
 *   BWIBBU 殖利率 →「115/08/11 個股日本益比…」
 * ⚠ TWSE 月初 off-by-one（2026-09-01 實測）：9/1 盤前 BWIBBU title 印
 *   「115/09/0」——資料日其實是上月末 08/31（TWSE 的「日-1」顯示在月界翻車，
 *   連指定 date=20260831 查詢也回同一份）。日=0 用 Date.UTC 自動借位換算成
 *   上月末（1 月 0 日也會正確借成前一年 12/31）。這是換算上游的已知顯示錯誤，
 *   數值反推內容確為前一交易日，不是猜測。 */
function ymdFromTitle(title) {
  const m = String(title || '').match(/(\d{2,3})\s*[年/]\s*(\d{1,2})\s*[月/]\s*(\d{1,2})\s*日?/);
  if (!m) return null;
  let y = +m[1] + 1911, mo = +m[2], d = +m[3];
  if (d === 0) { const dt = new Date(Date.UTC(y, mo - 1, 0)); y = dt.getUTCFullYear(); mo = dt.getUTCMonth() + 1; d = dt.getUTCDate(); }
  return `${y}${String(mo).padStart(2, '0')}${String(d).padStart(2, '0')}`;
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

// ── chipArchive 讀取的唯一入口（2026-08-12 建立）────────────────────────
//
// 為什麼要有這個：當日的歸檔文件是**分批**長出來的——15:10 先寫收盤、15:00 後法人、
// 21:45 才回填資券。更糟的是 daemon 一重啟就會在盤前跑一次 archiveChipDaily，
// 於是整個交易日的 00:00~15:10 之間，`orderBy('date','desc')` 的**第一筆是空殼**
// （只有 date/at/market，沒有任何 JSON 欄位）。實測 2026-08-12 就是這種文件。
//
// 空殼不會讓程式壞掉，只會安靜地給出錯的答案，而且有兩種：
//   ① `arch[0].instJson` → undefined → 法人買賣超整片變 0（產業輪動、雷達、風向）；
//   ② `arch.map(a => a.closeJson ? ... : {})` → maps[0] 變空物件，
//      **後面每一天都往後位移一格**：所謂「5 日均量」其實是 4 天＋1 天空白、
//      「昨收」指到前天。這種錯在畫面上完全看不出來。
// 6954 那支早就手寫過同樣的濾法（註解記著 2026-07-20 實案 n=0），
// 但沒有推廣出去 —— 這就是同一個 bug 會出現第二次的原因，故收斂成單一入口。
//
// field 指定「這一天必須有哪個欄位才算數」：要日 K 序列用 closeJson（預設）、
// 要資券用 marginJson、要借券用 lendingJson，各自取「最近一個有該欄位的日子」。
async function readArchive(limit, field = 'closeJson') {
  const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(limit).get();
  return snap.docs.map(d => d.data()).filter(a => a && a[field]);
}

// 榜單要標的「資料日」——三個時段的答案不一樣，少想一個就會標錯：
//   ① 盤中(marketOpen)          → 今天（盤中即時價）
//   ② 13:30 收盤後但 15:10 前   → **今天**（今天的收盤已經產生，只是還沒歸檔；
//                                  這格若照 dataDate() 走會退回昨天，是回歸性錯誤）
//   ③ 收盤已歸檔／盤前／非交易日 → 最近一個有資料的歸檔日
// ⚠ 不要拿 liveDay 當標籤依據：它的定義是「歸檔還沒有今天」，
//   在 00:00~09:00 也成立，於是深夜的榜單會自稱「盤中即時」。
async function boardDataDate(tw, marketOpen) {
  if (marketOpen) return isoDate(tw);
  const mins = tw.getHours() * 60 + tw.getMinutes();
  if (isTradingDay(tw) && mins >= 13 * 60 + 30) return isoDate(tw);
  return await dataDate();
}

// 「這批資料代表哪一天」——自己判斷盤中與否，呼叫端不必傳。
// 2026-08-29 新增：站上有 8 個 collection 把 `date` 寫成日曆今天，於是週六的文件
// 自稱資料日 2026-08-29（不可能的日期），稽核第三道閘門也因此對它們全盲。
// 不動既有的 `date`（有些消費端把它當「產生日」用），改為**另外補 dataDate**；
// 稽核的欄位優先序已改成 dataDate 優先。
async function currentDataDate() {
  const tw = taipei();
  const mins = tw.getHours() * 60 + tw.getMinutes();
  const open = isTradingDay(tw) && mins >= 9 * 60 && mins < 13 * 60 + 30;
  return await boardDataDate(tw, open);
}

let _dataDateCache = { at: 0, d: null };
async function dataDate() {
  if (_dataDateCache.d && Date.now() - _dataDateCache.at < 10 * 60000) return _dataDateCache.d;
  try {
    // ⚠ 不能取「最新的文件」，要取「最新的**有資料**的文件」。
    //   否則盤前空殼一建立，dataDate() 就回今天，而 sectorRotation / tradeSignals /
    //   rsRanking / scanner / multiTimeframe / snipeList 這 7 張表全都拿它當
    //   「資料日期」印在畫面上 ⇒ 昨天的資料掛today的日期（稽核已見 strategyPicks
    //   與 topicPicks 標 2026-08-12，其餘全站都是 2026-08-11）。
    const docs = await readArchive(5);
    const d = docs[0]?.date || null;
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
  if (out) probeNumbers('個股分析', out, prompt);
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

// ── 台股檔位（tick）──────────────────────────────────────────────────
// 合法成交價必落在檔位格上：<10→0.01、<50→0.05、<100→0.1、<500→0.5、
// <1000→1、其餘 5。用途是驗價，不是報價：任何不在格上的「價格」都不可能
// 成交（2026-08-19 實測全市場 1,057 檔被中點寫成非法價）。
// ⚠ ETF（受益憑證）走另一套檔位表：未滿 50 元 0.01、50 元以上 0.05——
//   用個股表去驗 ETF 會把 0050 的 103.55、006207 的 32.69 這種**合法價**
//   誤判成髒值而丟棄（2026-08-19 實測 80 檔 ETF 全中）。
const _isEtfCode = c => /^00\d{2,4}$/.test(String(c || ''));
const _tickOf = (p, isEtf) => isEtf
  ? (p < 50 ? 0.01 : 0.05)
  : (p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5);
const _onTick = (p, code) => {
  if (!(p > 0)) return false;
  const t = _tickOf(p, _isEtfCode(code));
  return Math.abs(p / t - Math.round(p / t)) < 0.02;   // 容忍浮點誤差，不容忍半檔
};

async function misBatch(batch) {
  const _twNow = taipei();
  const _nowMins = _twNow.getHours() * 60 + _twNow.getMinutes();
  const inCloseAuction = _nowMins >= 13 * 60 + 24 && _nowMins <= 13 * 60 + 35;
  // 連續交易時段（試撮窗除外）：z/pz 缺席時允許以五檔中價當即時價（見下）
  const inRegularCont = _nowMins >= 9 * 60 && _nowMins < 13 * 60 + 30 && !inCloseAuction;
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
      // z=本盤成交價（該 5 秒揭示內有成交才有值）；pz 雙語義：連續交易時段＝上一盤
      // 成交價回聲（活躍股 z 常為 '-'，pz 是主要載體，拿掉會讓 2330 都停更），
      // 集合競價時段（開盤前/收盤前/分盤處置股全日）＝試撮指示價、可能永不成交。
      // 兩種語義用「當日高低價」判別：真成交必落在 [當日低, 當日高] 內（高低由成交
      // 更新），試撮可以超出。實案 2026-08-13 1435（分盤、全日 66 張）：13:00 試撮
      // 25.75 > 當日高 25.50 ⇒ 這道護欄會攔下；收盤集合競價窗預期收在新高/新低，故豁免。
      let price = _num(it.z);
      if (price <= 0) price = _num(it.pz);
      let realTrade = price > 0;
      const _up = _num(it.u), _dn = _num(it.w);   // MIS: u=漲停 w=跌停（d 是日期欄，不可誤用）
      const _hi = _num(it.h), _lo = _num(it.l);
      if (realTrade) {
        if ((_up > 0 && price > _up + 1e-9) || (_dn > 0 && price < _dn - 1e-9)) realTrade = false;
        else if (!inCloseAuction && ((_hi > 0 && price > _hi + 1e-9) || (_lo > 0 && price < _lo - 1e-9))) realTrade = false;
      }
      if (!realTrade) price = 0;
      // ── 五檔中價層（2026-08-18 實測定案）：盤中連續交易時段，MIS 對個股常
      // 「v 前進但 z='-'」（2330 連 6 次揭示無 z、量卻 +10 張）——成交價欄位缺席
      // 不等於沒成交。此時買一/賣一中點就是市場現價（流動股與成交價差 <1 檔），
      // 據此個股才能跟上大盤指數的 5 秒節奏（指數的 z 每揭示必有）。
      // ⚠ 僅限盤中連續時段：東訊事故（收盤後殘單 b1 被當現價 +5.8%）的教訓保留——
      // 收盤後/試撮窗一律不用掛單價。漲跌停界內才收。
      let quoteLive = false;
      if (!realTrade && inRegularCont) {
        const _b1 = parseFloat(String(it.b || '').split('_')[0]);
        const _a1 = parseFloat(String(it.a || '').split('_')[0]);
        // ── 檔位合法性（2026-08-19 實測 1,057 檔中招）────────────────────
        // 中點 (b1+a1)/2 幾乎必然落在檔位之間：台泥 24.02，但檔位 0.05 ⇒
        // 市場上只有 24.00 與 24.05，24.02 是**不可能成交的價格**。
        // 後果不只是難看：漲停鎖死股會因為「21.48 < 漲停 21.50」被 isLimitUp
        // 判否而跌出漲停榜（使用者 2026-08-19 回報「漲停榜沒有上櫃」）。
        // 正解不是把中點四捨五入，而是回到「價格是什麼」的定義：
        //   上一筆真實成交價若仍落在買一~賣一之間，五檔就沒有推翻它 ⇒ 沿用，
        //   它本來就是真價、必然合法檔位；只有當書整個移開（prev < b1 或
        //   prev > a1）才把價格移到最近的那一邊——那才是市場真的動了。
        // 這樣既保住 5 秒節奏（書一動就跟上），又不再捏造不存在的價格。
        // ⚠ _prev 必須先驗檔位：8/18~8/19 的舊快照裡存著上一版中點寫下的
        //   非法價（24.02），restoreLastLive 會把它接回記憶體。若照單全收，
        //   24.02 永遠落在 [24.00, 24.05] 內 ⇒ 錯價自我延續、永不痊癒。
        const _prevRaw = _lastLive[code]?.price || 0;
        const _prev = _prevRaw > 0 && _onTick(_prevRaw, code) ? _prevRaw : 0;
        let _p = 0;
        if (_b1 > 0 && _a1 > 0) {
          if (_prev > 0) _p = _prev >= _b1 && _prev <= _a1 ? _prev : (_prev > _a1 ? _a1 : _b1);
          else _p = _b1;   // 今日尚無可信真實價（重啟/首輪/舊髒值）→ 取買一，合法檔位且可立即成交
        }
        if (_p > 0 && !(_up > 0 && _p > _up + 1e-9) && !(_dn > 0 && _p < _dn - 1e-9)) {
          price = +_p.toFixed(2);
          quoteLive = true;
        }
        // ── 鎖停單邊書（2026-08-19 使用者實報：首頁漲停榜缺上櫃）──
        // 漲停鎖死時賣一必空、跌停鎖死時買一必空 ⇒ 上面的雙邊中點永遠不成立；
        // 而鎖死後成交極少，z 可長時間缺席——冷門股（上櫃尤甚）因此從即時榜單
        // 消失。鎖死時掛單價不是猜測：買一貼著漲停價（=u）就是市價本身。
        // 嚴格條件：盤中連續時段＋單邊貼停＋對側全空；hasLive 仍要求今日有量。
        // ⚠ 必須加驗「當日最高/最低是否真的到過停板」（2026-08-27 迴歸修正）
        //   單邊貼停的書況不只出現在鎖死，**開盤後的巨量買單排隊也是同一個形態**
        //   ——買一掛在漲停價、賣一全空，但股票根本還沒在漲停價成交過。
        //   昨天只看書況就採用停板價，於是 09:01~09:17 產生一批假漲停：
        //   實案 6890 來億-KY 今日最高 183、漲停價 192.5，卻被記成 09:01 鎖停；
        //   當日漲停順序流 72 檔裡有 14 檔是這樣來的。
        //   真鎖死的充分條件是**它已經在停板價成交過**，即 h 已等於漲停價
        //   （跌停同理 l 等於跌停價）。h/l 由成交更新，掛單不會動到它。
        else if (_up > 0 && _b1 >= _up - 1e-9 && !(_a1 > 0) && _hi > 0 && _hi >= _up - 1e-9) {
          price = _up; quoteLive = true;          // 漲停鎖死（且確實成交過）
        } else if (_dn > 0 && _a1 > 0 && _a1 <= _dn + 1e-9 && !(_b1 > 0) && _lo > 0 && _lo <= _dn + 1e-9) {
          price = _dn; quoteLive = true;          // 跌停鎖死（且確實成交過）
        }
      }
      if (price <= 0) {
        const b1 = parseFloat(String(it.b || '').split('_')[0]);
        const a1 = parseFloat(String(it.a || '').split('_')[0]);
        price = b1 > 0 ? b1 : (a1 > 0 ? a1 : 0);
      }
      // ── 排隊搶漲停（2026-08-27 使用者需求）────────────────────────────
      // 上面那個「已成交過才算鎖停」的判準，把另一種書況篩了出來：
      //   買一貼在漲停價 × 賣一全空 × **當日最高還沒到過漲停**
      // ＝ 大量買單正在排隊搶漲停，但還沒真的成交上去。
      // 它不是鎖停（所以不能當成漲停價），但**本身就是強烈的攻擊訊號**，
      // 尤其開盤前十幾分鐘出現時。獨立成 queueUp 欄位，不污染價格。
      const _qb1 = parseFloat(String(it.b || '').split('_')[0]);
      const _qa1 = parseFloat(String(it.a || '').split('_')[0]);
      const _qVol = parseFloat(String(it.g || '').split('_')[0]) || 0;   // 買一委買張數
      const queueUp = _up > 0 && _qb1 >= _up - 1e-9 && !(_qa1 > 0) && !(_hi > 0 && _hi >= _up - 1e-9);
      const volLots = _num(it.v);           // MIS v 單位=張
      const vol = volLots * 1000;            // 統一為「股」，與種子(STOCK_DAY_ALL)一致
      // 只有「真成交價 + 當日有量」才算即時真實價（開盤前試撮 v=0 不覆蓋昨收）。
      const hasLive = (realTrade && volLots > 0) || (quoteLive && volLots > 0);   // 今日有量才可信
      const prev = _num(it.y); if (price <= 0) price = prev;  // 僅供 change 計算
      const change = hasLive && prev > 0 ? +(price - prev).toFixed(2) : 0;
      out[code] = {
        code, name: it.n || '', price, change, prev, mVal: _num(it.m),
        changePercent: hasLive && prev > 0 ? +((change / prev) * 100).toFixed(2) : 0,
        open: _num(it.o), high: _num(it.h), low: _num(it.l),
        volume: vol, value: Math.round(price * vol), hasLive, realTrade,
        // 揭示時戳（MIS tlong，ms）：與 liveAt（抓取時刻）分開——實測兩者可差 35–41 秒（WM-SCAN R7）。
        // 缺就 null，不拿抓取時刻冒充。
        revealAt: Number(it.tlong) > 0 ? Number(it.tlong) : null,
        // 只在成立時帶欄位——2,000 檔的快照不該為了少數幾檔多背 false
        ...(queueUp ? { queueUp: true, queueLots: Math.round(_qVol), limitPrice: _up } : {}),
        bid: _parseLevels(it.b, it.g), ask: _parseLevels(it.a, it.f), // 五檔委買委賣（僅供當下參考，不歸檔）
      };
    }
    return out;
  } catch { clearTimeout(t); return {}; }
}

// ── 內外盤（取樣式）─────────────────────────────────────────────────
// ⚠ 先講清楚限制：**TWSE MIS 沒有內外盤欄位**。
//   實測 getStockInfo 只回 a/b(五檔價)、f/g(五檔量)、z(成交價)、tv(單量)、v(累計量)，
//   真正的內外盤要逐筆成交明細（每筆撮在買價還是賣價），那是券商 tick API 才有。
//
// 這裡做的是**可誠實交代的逼近**：
//   每次輪詢取「累計量的增量 Δv」，用當下的成交價相對最佳五檔判方向：
//     成交價 ≥ 賣一 → 外盤（買方主動吃賣單）
//     成交價 ≤ 買一 → 內盤（賣方主動砍買單）
//     介於中間     → 中性（不計入任一邊）
//   ⇒ **總量是精確的**（Δv 累加起來就是當日全量），只有「方向」是 5 秒取樣。
//     急拉急殺的瞬間可能被歸到相鄰的取樣區間，但比例上的偏差有限。
//   前端必須標示「取樣」，不可讓使用者誤以為是券商等級的逐筆內外盤。
let _flow = { date: '', by: {} };   // code → { in, out, mid, lastVol }
function accumulateFlow(code, q, tw) {
  const today = isoDate(tw);
  if (_flow.date !== today) _flow = { date: today, by: {} };
  if (!q?.hasLive || !(q.price > 0)) return;
  // ⚠ since：**從 daemon 首次看到這一檔開始算**。重啟、或該檔中途才進優先集時，
  //   前面的成交量不在樣本內——UI 必須把這個時間標出來，否則使用者會誤以為是全日累計。
  const e = _flow.by[code] || (_flow.by[code] = { in: 0, out: 0, mid: 0, lastVol: q.volume, since: Date.now() });
  const dv = q.volume - e.lastVol;
  e.lastVol = q.volume;
  if (!(dv > 0)) return;                       // 沒有新成交
  // _parseLevels 回的是 [[價, 量], ...]，不是物件——取 [0][0] 才是最佳價
  const a1 = q.ask?.[0]?.[0] ?? 0, b1 = q.bid?.[0]?.[0] ?? 0;
  if (a1 > 0 && q.price >= a1) e.out += dv;
  else if (b1 > 0 && q.price <= b1) e.in += dv;
  else e.mid += dv;
}

let _codesCache = null, _codesAt = 0, _codesCloseDate = '';
// 民國日期 1150715 → 20260715（西元 YYYYMMDD）
const rocToYmd = s => { s = String(s).trim(); return /^\d{7}$/.test(s) ? String(+s.slice(0, 3) + 1911) + s.slice(3) : ''; };
let _otcCloseDate = '';

// TPEx 帶日期端點：openapi 鏡像落後或整個回空時的後備來源。
// TPEx 只認 YYYY/MM/DD，且**必須回聲驗證**——否則它會靜默忽略日期參數
// 回最新資料（實案：首輪回填整批變今日快照）。dateYmd 為空時不做回聲比對，
// 純粹當「拿到一份上櫃清單」用（宇宙缺市場比日期差一天嚴重得多）。
async function _fetchOtcDated(dateYmd) {
  try {
    const useEcho = /^\d{8}$/.test(dateYmd || '');
    const slash = useEcho ? `${dateYmd.slice(0, 4)}/${dateYmd.slice(4, 6)}/${dateYmd.slice(6, 8)}` : '';
    const url = `https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=${encodeURIComponent(slash)}&type=EW&id=&response=json`;
    const j = await (await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.tpex.org.tw/' }, signal: AbortSignal.timeout(12000) })).json();
    const tb = useEcho ? (String(j?.date || '') === dateYmd ? j?.tables?.[0] : null) : j?.tables?.[0];
    const out = [];
    for (const r2 of (tb?.data || [])) {
      const code = String(r2[0] || '').trim();
      if (/^\d{4}$/.test(code) || /^00\d{2,4}$/.test(code)) {
        // open/high/low 供歸檔補洞組完整日 K（2026-09-17 加；既有兩個呼叫端只讀 close/change/vol，加欄位不影響）
        out.push({ code, name: String(r2[1] || '').trim(), market: 'otc', close: _num(r2[2]), change: _num(r2[3]), vol: _num(r2[8]), open: _num(r2[4]), high: _num(r2[5]), low: _num(r2[6]) });
      }
    }
    return out;
  } catch (e) {
    // R10（2026-09-12）：以前是靜默 `catch { return [] }`——outage 與「今天沒資料」同值。
    // 回傳形狀不動（8 個呼叫端多數已以 length===0 棄權），但故障必須留痕。
    log(`  ⚠ STOCK_DAY_ALL 抓取失敗（回空）：${(e?.message || '').slice(0, 80)}`);
    return [];
  }
}
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
        if (/^\d{4}$/.test(code) || /^00\d{2,4}$/.test(code)) tseRows.push({ code, name: (f[2] || '').trim(), market: 'tse', close: _num(f[8]), change: _num((f[9] || '').replace('+', '')), vol: _num(f[3]), open: _num(f[5]), high: _num(f[6]), low: _num(f[7]) });
      }
    }
  } catch { /* fall through to openapi */ }
  if (tseRows.length === 0) {
    try {
      const r = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.ok) for (const x of await r.json()) if (/^\d{4}$/.test(x.Code) || /^00\d{2,4}$/.test(x.Code)) tseRows.push({ code: x.Code, name: x.Name, market: 'tse', close: _num(x.ClosingPrice), change: _num(x.Change), vol: _num(x.TradeVolume), open: _num(x.OpeningPrice), high: _num(x.HighestPrice), low: _num(x.LowestPrice) });
    } catch { /* tse */ }
  }
  for (const c of tseRows) codes.push(c);
  // ── 上櫃種子（2026-08-11 修）────────────────────────────────────────
  // ⚠ 這個 openapi 鏡像**自帶 Date 欄位（民國 YYYMMDD）**，但舊版從來不讀它。
  //   上市那半有 closeDate 回音驗證，上櫃這半沒有 —— 於是「上櫃種子是哪一天的」
  //   系統完全不知道，鏡像落後時就把昨日收盤當今日餵給「即時漲跌」。
  //   （CLAUDE.md 明文規則：openapi 一律假設是舊的，且必須讀它自報的日期比對。）
  // 修法：讀鏡像自報日 → 與上市的 closeDate 比對 → 落後就改用**帶日期**的
  //       afterTrading/dailyQuotes（回聲驗證，回補腳本已實測可靠）重抓。
  let otcRows = []; let otcDate = '';
  try {
    const r = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (r.ok) for (const x of await r.json()) {
      const code = x.SecuritiesCompanyCode || x.Code || '';
      if (!otcDate && x.Date) otcDate = rocToYmd(String(x.Date));
      if (/^\d{4}$/.test(code) || /^00\d{2,4}$/.test(code)) otcRows.push({ code, name: x.CompanyName || x.Name || '', market: 'otc', close: _num(x.Close), change: _num(x.Change), vol: _num(x.TradingShares), open: _num(x.Open), high: _num(x.High), low: _num(x.Low) });
    }
  } catch (e) { log(`  ⚠ 上櫃 openapi 鏡像抓取失敗：${(e.message || '').slice(0, 60)}`); }
  if (closeDate && otcDate && otcDate < closeDate) {
    const fixed = await _fetchOtcDated(closeDate);
    if (fixed.length > 500) { otcRows = fixed; log(`  ⚠ 上櫃種子落後(${otcDate}<${closeDate})，已改用帶日期端點重抓 ${fixed.length} 檔`); otcDate = closeDate; }
    else log(`  ⚠ 上櫃種子落後(${otcDate}<${closeDate})，帶日期端點只回 ${fixed.length} 檔，維持鏡像值`);
  }
  // ── 整個市場消失的防線（2026-08-19 實案）──────────────────────────────
  // 上面的 TPEx 抓取原本是 `catch { /* otc */ }` 靜默吞掉，且**沒有任何後備**
  //（上市那半有 openapi 後備，上櫃這半沒有）。於是一次暫時性失敗就會讓
  // otcRows=[]，而 codes 仍有 1,229 檔上市 ⇒ `codes.length > 0` 成立 ⇒
  // **把「只有上市」的宇宙當成權威寫進快取**，連上一份好的快取都被覆蓋。
  // 後果：全站上櫃股整批消失（快照 2,132→1,229 檔），漲停榜再也不會有上櫃，
  // 而且不會報錯——正是使用者 2026-08-19 回報的現象。
  if (otcRows.length === 0) {
    log('  ⚠ 上櫃清單抓取失敗（鏡像回空）→ 改用帶日期端點後備');
    const alt = await _fetchOtcDated(closeDate || _codesCloseDate || '');
    if (alt.length > 500) { otcRows = alt; otcDate = closeDate || otcDate; log(`  ✓ 上櫃後備成功 ${alt.length} 檔`); }
    else {
      // 最後一道：沿用上一份快取裡的上櫃（stale-if-error）。寧可用舊的上櫃種子，
      // 也不要讓整個市場從站上蒸發——即時價本來就由 MIS 逐輪覆蓋。
      const prevOtc = (_codesCache || []).filter(c => c.market === 'otc');
      if (prevOtc.length > 0) { otcRows = prevOtc; log(`  ⚠ 上櫃後備亦失敗 → 沿用上一份快取 ${prevOtc.length} 檔（stale-if-error）`); }
      else log('  ✗ 上櫃完全無來源且無快取可沿用——本輪宇宙將缺少上櫃');
    }
  }
  codes.push(...otcRows);
  _otcCloseDate = otcDate;
  // 只有「兩個市場都在」才可以覆蓋快取：任何一邊整批消失都視為抓取失敗，
  // 保留舊快取而不是把殘缺宇宙固化下來。
  // ⚠ **種子的開高低只有在資料日就是今天時才能用**（2026-08-29 使用者回報
  //   「開高低怎麼都一樣」時修）。盤中的種子是**昨天**的收盤檔，把它的高低
  //   當成今天顯示，比顯示 0 更糟——那是拿昨天的區間冒充今天的。
  //   （這正是 CLAUDE.md「種子帶的是昨日漲跌」那條的同一個坑，只是換成 OHLC。）
  //   收盤後種子換成今日檔，那時才放行。
  {
    // 種子的 OHLC 與種子的 close 是**同一天、同一列**，所以只要整份報價都來自
    // 種子（收盤後、週末、非交易日），顯示它就是正確的——畫面本來就是那一天的盤。
    // 危險只發生在**盤中**：價格會被今日即時價蓋掉，而種子 OHLC 仍是昨天的，
    // 兩者混在一起就變成「今天的價、昨天的高低」。
    // （同 CLAUDE.md「種子帶的是昨日漲跌，盤中一律歸零顯示平盤」那條的處理。）
    const _tw = taipei();
    const _mins = _tw.getHours() * 60 + _tw.getMinutes();
    const _liveWindow = isTradingDay(_tw) && _mins >= 9 * 60 && _mins < 13 * 60 + 35;
    if (_liveWindow && closeDate !== ymd8(_tw)) {
      for (const c of codes) { c.open = 0; c.high = 0; c.low = 0; }
    }
  }
  const hasTse = codes.some(c => c.market === 'tse');
  const hasOtc = codes.some(c => c.market === 'otc');
  if (codes.length > 0 && hasTse && hasOtc) {
    _codesCache = codes; _codesAt = Date.now(); _codesCloseDate = closeDate;
  } else if (codes.length > 0 && !_codesCache) {
    _codesCache = codes; _codesAt = Date.now(); _codesCloseDate = closeDate;   // 首次啟動，殘缺也好過空手
    log(`  ⚠ 首次載入宇宙殘缺（tse=${hasTse} otc=${hasOtc}），暫用之並待下輪修復`);
  } else if (!hasOtc || !hasTse) {
    log(`  ⚠ 本輪宇宙殘缺（tse=${hasTse} otc=${hasOtc}）→ 不覆蓋快取，沿用上一份 ${(_codesCache || []).length} 檔`);
  }
  return _codesCache || [];
}

// seed = latest TWSE close. live:false means "this is close, NOT realtime".
const seedQuote = c => ({ code: c.code, name: c.name, market: c.market || null, price: c.close, change: c.change, changePercent: (c.close - c.change) > 0 ? +((c.change / (c.close - c.change)) * 100).toFixed(2) : 0, volume: c.vol, value: Math.round(c.close * c.vol), open: c.open || 0, high: c.high || 0, low: c.low || 0, live: false });

async function writeSnapshot(quotes, marketOpen, source, sweeping = marketOpen) {
  const arr = Object.values(quotes);
  const count = arr.length;
  const liveCount = arr.filter(q => q.live).length;
  const sweepAt = Date.now();
  // Store quotes as a JSON STRING — a 1900-key map exceeds Firestore's 20k
  // per-doc index-entry limit; a string is indexed once.
  // 內外盤取樣：只寫有累積到量的個股，避免整包 2000 檔都塞 0
  const flowOut = {};
  for (const c in _flow.by) { const e = _flow.by[c]; if (e.in + e.out + e.mid > 0) flowOut[c] = [e.in, e.out, e.mid, e.since]; }
  try { await db.collection('marketSnapshot').doc('flow').set({ date: _flow.date, n: Object.keys(flowOut).length, byCodeJson: JSON.stringify(flowOut), at: Date.now() }); } catch { /* optional */ }
  try { await db.collection('marketSnapshot').doc('latest').set({ dataDate: await boardDataDate(taipei(), marketOpen), quotesJson: JSON.stringify(quotes), count, liveCount, sweepAt, marketOpen, sweeping, source, updatedAt: Date.now(), date: isoDate(taipei()), seedDateTse: _codesCloseDate || null, seedDateOtc: _otcCloseDate || null }); }
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
// ── 大盤/櫃買盤中逐點序列（2026-08-14 使用者需求：點左上指數彈出走勢圖）──
// 同一個 MIS 請求帶 t00+o00（不增加上游額度），每 ~55 秒累積一點
// [epochMs, 指數, 累積成交值(億)]，寫 marketIndexIntraday/latest。
// 重啟自快照還原當日序列（同 restoreLastLive 的教訓：記憶體序列重啟即蒸發）。
const _idxIntra = { date: '', tse: [], otc: [], prevTse: 0, prevOtc: 0, restored: false };
async function restoreIdxIntra() {
  _idxIntra.restored = true;
  try {
    const d = (await db.collection('marketIndexIntraday').doc('latest').get()).data();
    if (d?.date === isoDate(taipei())) {
      _idxIntra.date = d.date;
      _idxIntra.tse = JSON.parse(d.tseJson || '[]');
      _idxIntra.otc = JSON.parse(d.otcJson || '[]');
      log(`✓ 還原今日指數序列 tse ${_idxIntra.tse.length} 點 / otc ${_idxIntra.otc.length} 點`);
    }
  } catch { /* 無舊序列可還原 */ }
}

async function writeMarketIndex() {
  if (Date.now() - _idxAt < 55000) return;
  try {
    if (!_idxIntra.restored) await restoreIdxIntra();
    const r = await fetch(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw|otc_o00.tw&json=1&delay=0&_=${Date.now()}`, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://mis.twse.com.tw/' } });
    if (!r.ok) return;
    const arr = (await r.json())?.msgArray || [];
    const tse = arr.find(m => m.c === 't00'), otc = arr.find(m => m.c === 'o00');
    if (!tse) return;
    const cur = _num(tse.z) || _num(tse.l), prev = _num(tse.y);
    if (!(cur > 0 && prev > 0)) return;
    const chg = +(cur - prev).toFixed(2);
    const oCur = otc ? (_num(otc.z) || _num(otc.l)) : 0, oPrev = otc ? _num(otc.y) : 0;
    const doc = {
      weighted: cur, weightedChange: chg, weightedChangePercent: +((chg / prev) * 100).toFixed(2),
      high: _num(tse.h), low: _num(tse.l), prevClose: prev, tradeDate: tse.d, tradeTime: tse.t,
      value: _num(tse.m) > 0 ? +( _num(tse.m) / 1000).toFixed(1) : 0,   // m=累積成交金額(十萬元)→億（t00 無 v 欄）
      at: Date.now(), source: 'daemon_mis',
    };
    if (oCur > 0 && oPrev > 0) {
      doc.otc = oCur; doc.otcChange = +(oCur - oPrev).toFixed(2);
      doc.otcChangePercent = +(((oCur - oPrev) / oPrev) * 100).toFixed(2);
      doc.otcPrevClose = oPrev; doc.otcHigh = _num(otc.h); doc.otcLow = _num(otc.l); doc.otcValue = _num(otc.m) > 0 ? +(_num(otc.m) / 1000).toFixed(1) : 0;
    }
    await db.collection('marketIndex').doc('latest').set(doc);
    _idxAt = Date.now();

    // 盤中累積序列（09:00–13:35）；跨日自動重置
    const tw = taipei();
    const mins = tw.getHours() * 60 + tw.getMinutes();
    const today = isoDate(tw);
    if (isTradingDay(tw) && mins >= 9 * 60 && mins <= 13 * 60 + 35) {
      if (_idxIntra.date !== today) { _idxIntra.date = today; _idxIntra.tse = []; _idxIntra.otc = []; }
      _idxIntra.tse.push([Date.now(), cur, _num(tse.m) > 0 ? +(_num(tse.m) / 1000).toFixed(1) : 0]);
      if (oCur > 0) _idxIntra.otc.push([Date.now(), oCur, _num(otc.m) > 0 ? +(_num(otc.m) / 1000).toFixed(1) : 0]);
      _idxIntra.prevTse = prev; _idxIntra.prevOtc = oPrev;
      await db.collection('marketIndexIntraday').doc('latest').set({
        date: today, updatedAt: Date.now(),
        prevCloseTse: prev, prevCloseOtc: oPrev || null,
        tseJson: JSON.stringify(_idxIntra.tse), otcJson: JSON.stringify(_idxIntra.otc),
      });
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
  // ⚠ 這兩步都要有 cap 檢查。原本第 1 步（自選/持股）**無上限**地 add，
  //   一旦全站自選＋持股去重後超過 PRIORITY_CAP，第 2 步的 `set.size < CAP`
  //   就恆為 false ⇒ **「開啟任何個股就變即時」這個功能整個失效**，
  //   而且畫面上只是「這檔比較慢更新」，不會有任何錯誤。
  //   目前實測 21 檔還沒踩到，屬於會隨用戶成長自己引爆的地雷。
  //   兩步都設 cap 後最壞情況是各佔一半，瀏覽中的個股一定進得去。
  const WATCH_BUDGET = Math.floor(PRIORITY_CAP / 2);
  try {
    for (const [code] of await resolveWatchCodes()) {
      if (valid.has(code) && set.size < WATCH_BUDGET) set.add(code);
    }
  } catch { /* ignore */ }
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
const _ibBackfilled = new Map();   // code → 'done' | 退避到期時戳
let _ibDay = '';
// ── 外部源熔斷（wm-resilience-circuit-breaker·WM-SCAN F1·2026-09-04）──────────
// 只包 Yahoo 族（chart 與 news 兩個 host），**不包 MIS**（MIS 的 null 多是 z 缺席等市場現實）。
// Read Outcome 三態：只有 throw（連線失敗/逾時/非 JSON）算失敗；HTTP 200 但無資料是 miss，不計。
// 連續 threshold 次失敗 → 冷卻（5 分起，每次再跳閘加倍，上限 30 分）；冷卻中呼叫端直接拿 null，
// 與「上游沒資料」同一形狀，呼叫端既有的退避/重試邏輯不變。冷卻到期後第一次呼叫即半開探測。
const _breakers = new Map();
function _breaker(key) { let b = _breakers.get(key); if (!b) { b = { failures: 0, until: 0, trips: 0, lastError: '' }; _breakers.set(key, b); } return b; }
function breakerOpen(key) { return Date.now() < _breaker(key).until; }
function breakerOk(key) { const b = _breaker(key); if (b.trips) log(`✓ 熔斷恢復 ${key}（曾跳閘 ${b.trips} 次）`); b.failures = 0; b.trips = 0; b.until = 0; }
function breakerFail(key, err, { threshold = 3, cooldownMs = 300_000, maxCooldownMs = 1_800_000 } = {}) {
  const b = _breaker(key); b.failures++; b.lastError = String(err?.message || err || '').slice(0, 120);
  if (b.failures >= threshold) {
    b.trips++; const cd = Math.min(cooldownMs * 2 ** (b.trips - 1), maxCooldownMs);
    b.until = Date.now() + cd; b.failures = 0;
    log(`⛔ 熔斷 ${key}：連續 ${threshold} 次失敗（${b.lastError}），冷卻 ${Math.round(cd / 60000)} 分`);
  }
}
function breakerSnapshot() { const o = {}; for (const [k, b] of _breakers) o[k] = { open: Date.now() < b.until, until: b.until || null, trips: b.trips, failures: b.failures, lastError: b.lastError || null }; return o; }

async function fetchYahoo1m(sym) {
  if (breakerOpen('yahoo-chart')) return null;
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 6000);
  try {
    const j = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d&includePrePost=false`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctl.signal }).then(r => r.json()).finally(() => clearTimeout(tm));
    breakerOk('yahoo-chart');
    const res = j?.chart?.result?.[0]; if (!res) return null;
    const ts = res.timestamp || []; const q = res.indicators?.quote?.[0] || {};
    const out = [];
    for (let i = 0; i < ts.length; i++) { const c = q.close?.[i]; if (c > 0) out.push([ts[i], +c.toFixed(2), q.volume?.[i] ?? 0]); }
    return out.length ? out : null;
  } catch (e) { breakerFail('yahoo-chart', e); return null; }
}
const _taipeiMinOf = tsSec => { const t = new Date(new Date(tsSec * 1000).toLocaleString('en-US', { timeZone: 'Asia/Taipei' })); return t.getHours() * 60 + t.getMinutes(); };
async function backfillIntradayMorning(trackedSet, byCode) {
  const tw = taipei(); const mins = tw.getHours() * 60 + tw.getMinutes();
  // 2026-09-03 使用者指定：09:00 起即時監聽，缺口一出現就補、不等 09:10。
  // ⚠ 配套必改：原本「無論成敗都標記」在 09:00 就跑會變成**永不回補**——
  //   Yahoo 分鐘線開盤初常整條缺席（2026-09-01 實測），第一試必敗、標記後不再試。
  //   改成**成功才標記 done**，失敗退避 90 秒後可重試（Map 存 nextAt）。
  if (mins < 9 * 60 || mins >= 13 * 60 + 35) return;
  const today = isoDate(tw);
  if (_ibDay !== today) { _ibBackfilled.clear(); _ibDay = today; }
  // 找一檔：尚未補成、退避已過、且序列缺早盤（首筆晚於 09:01 或整段缺）
  let target = null;
  const now = Date.now();
  for (const code of trackedSet) {
    const st = _ibBackfilled.get(code);
    if (st === 'done') continue;
    if (typeof st === 'number' && now < st) continue;        // 退避中
    const s = _intraday.series[code];
    const firstMin = s?.pts?.length ? _taipeiMinOf(s.pts[0][0]) : 9999;
    if (firstMin > 9 * 60 + 1) { target = code; break; }
  }
  if (!target) return;
  _ibBackfilled.set(target, now + 90_000);                   // 先掛退避；成功後改標 done
  const market = byCode[target]?.market;
  const bars = await fetchYahoo1m(`${target}.${market === 'otc' ? 'TWO' : 'TW'}`);
  if (!bars) return;
  const s = _intraday.series[target];
  const firstTs = s?.pts?.length ? s.pts[0][0] : Infinity;
  const morning = bars.filter(b => b[0] < firstTs && _taipeiMinOf(b[0]) >= 9 * 60 && _taipeiMinOf(b[0]) < 13 * 60 + 35);
  if (!morning.length) return;                               // 沒補到＝退避後再試（Yahoo 資料未出）
  if (!s) { _intraday.series[target] = { prev: +(bars[0][1]).toFixed(2), pts: morning }; }
  else { s.pts = [...morning, ...s.pts]; if (s.pts.length > 400) s.pts.splice(400); }
  _ibBackfilled.set(target, 'done');
  log(`  ⏮ 早盤回補 ${target} +${morning.length} 筆`);
}

// ── 重啟後把「今天已經掃到的即時價」接回來（2026-08-12）────────────────
//
// _lastLive 是純記憶體的，行程一重啟就整個清空。後果不是報錯，而是
// **全市場安靜地退回昨日收盤**：每一檔都要等到 MIS 再次回一筆「真的成交」
// 才會重新變成即時，而 misBatch 刻意只認 z/pz（不拿掛單價充數，見該處註解），
// 所以冷門股可能數十分鐘都停在昨收，熱門股也要好幾輪。
//
// 2026-07-17 就出過同一件事（註解記在下方掃描窗那段），但當時的處置是
// 「延長掃描窗」——那只解決收盤後的空窗，沒有解決「重啟就失憶」本身。
// 2026-08-12 使用者回報「友達的價格怎麼沒有即時更新」即是此症：
// 我在 08:50（開盤前 10 分鐘）重啟 daemon，2409 直到 09:23 才重新取得即時價。
//
// 快照本來就把今日即時價寫在 Firestore（live:true + liveAt），直接讀回來即可。
// ⚠ 一定要比對 liveAt 是不是「今天」——跨日殘留沿用會把昨天的價當今天的。
async function restoreLastLive() {
  try {
    const s = (await db.collection('marketSnapshot').doc('latest').get()).data();
    if (!s?.quotesJson) return;
    const today = isoDate(taipei());
    const q = JSON.parse(s.quotesJson);
    let n = 0;
    for (const k in q) {
      const v = q[k];
      if (!v?.live || !v.liveAt) continue;
      if (isoDate(new Date(v.liveAt)) !== today) continue;
      _lastLive[k] = v; n++;
    }
    log(n ? `✓ 還原今日即時價 ${n} 檔（重啟不再整批退回昨收）` : '· 快照無今日即時價可還原（正常：盤前或非交易日）');
  } catch (e) { log('✖ 還原今日即時價失敗：', (e.message || '').slice(0, 80)); }
}

// ── 5 秒快線（2026-08-14）：使用者正在看的股票（自選/持股/瀏覽中/策略榜，
// buildPriorityCodes 前 120 檔＝單一 MIS 請求）獨立於全市場輪掃、每 5 秒掃一次，
// 寫入小型 marketSnapshot/hot（~20KB）。web 端把它蓋在 30 秒全市場快照上。
// MIS 揭示週期本身是 5 秒——這條線就是即時性的物理上限，不能也不必更快。
// 頻寬帳：快線 1 req/5s ＋ 主迴圈 1 req/3s ≈ 2.7 req/5s < MIS 限制 3 req/5s。
// 指數 5 秒級發布（快線搭車）。headline（marketIndex/latest·小文件）每班車都寫；
// 盤中序列（走勢圖用）≥50 秒才補一點——圖表 1 分鐘解析度足夠，不用灌爆文件。
// ⚠ t00/o00 沒有 v 欄（成交值不在 getStockInfo），序列第三欄暫為 0，量條另尋來源。
// 距下一個「MIS 揭示邊界 + offset 毫秒」還有多久（邊界＝整 5 秒牆鐘）
function msToNextReveal(offsetMs = 1000) {
  const now = Date.now();
  const next = Math.ceil((now - offsetMs) / 5000) * 5000 + offsetMs;
  return Math.max(50, next - now);
}

async function publishIndexFromHot(t, o) {
  if (!t || !(t.price > 0) || !(t.prev > 0)) return;
  const chg = +(t.price - t.prev).toFixed(2);
  // 成交值：t00 的 m 欄＝累積成交金額（十萬元）——2026-08-17 以自家快照加總
  // （6,542億 vs m/1000=7,637億·官方含冷門/零股故略高）與上週五全日 10,645 億量級雙重校準。
  const valYi = t.mVal > 0 ? +(t.mVal / 1000).toFixed(1) : 0;
  const doc = {
    weighted: t.price, weightedChange: chg, weightedChangePercent: +((chg / t.prev) * 100).toFixed(2),
    high: t.high, low: t.low, prevClose: t.prev,
    tradeDate: isoDate(taipei()).replace(/-/g, ''), tradeTime: taipei().toTimeString().slice(0, 8),
    value: valYi, at: Date.now(), source: 'daemon_mis',
  };
  if (o && o.price > 0 && o.prev > 0) {
    const oc = +(o.price - o.prev).toFixed(2);
    doc.otc = o.price; doc.otcChange = oc; doc.otcChangePercent = +((oc / o.prev) * 100).toFixed(2);
    doc.otcPrevClose = o.prev; doc.otcHigh = o.high; doc.otcLow = o.low;
    doc.otcValue = o.mVal > 0 ? +(o.mVal / 1000).toFixed(1) : 0;
  }
  await db.collection('marketIndex').doc('latest').set(doc);
  _idxAt = Date.now();   // writeMarketIndex 的 55 秒守門會自動讓路（只在快線停機時段接手）
  const tw = taipei();
  const mins = tw.getHours() * 60 + tw.getMinutes();
  const today = isoDate(tw);
  if (isTradingDay(tw) && mins >= 9 * 60 && mins <= 13 * 60 + 35) {
    if (!_idxIntra.restored) await restoreIdxIntra();
    if (_idxIntra.date !== today) { _idxIntra.date = today; _idxIntra.tse = []; _idxIntra.otc = []; }
    const lastT = _idxIntra.tse[_idxIntra.tse.length - 1]?.[0] || 0;
    if (Date.now() - lastT >= 50e3) {
      _idxIntra.tse.push([Date.now(), t.price, valYi]);
      if (o && o.price > 0) _idxIntra.otc.push([Date.now(), o.price, o.mVal > 0 ? +(o.mVal / 1000).toFixed(1) : 0]);
      await db.collection('marketIndexIntraday').doc('latest').set({
        date: today, updatedAt: Date.now(),
        prevCloseTse: t.prev, prevCloseOtc: (o && o.prev > 0) ? o.prev : null,
        tseJson: JSON.stringify(_idxIntra.tse), otcJson: JSON.stringify(_idxIntra.otc),
      });
    }
  }
}

async function hotQuoteLoop() {
  let _hotN = 0, _hotFresh = 0;
  // 2026-09-17 量測：固定 120 檔批次的回應被 MIS 凍住約 30 秒（120 檔揭示時戳同時跳）。主迴圈批次組成每輪不同，
  // 落後只有 P50 約 20 秒 ⇒ 每輪把優先集「輪轉」一個起點，讓 ex_ch 字串每輪不同。上游請求數不變。
  // 防護（wm-resilience）：輪換後若連續 3 輪 0 live（盤中），退回固定順序 10 分鐘並留 log；不靜默。
  // 量測（wm-freshness 的 seed 時鐘 vs content 時鐘）：每輪算 liveAt−revealAt 的 P50/P90 與「揭示時戳前進比例」，
  // 5 分鐘一報並寫進 daemonHealth.hotLag——這是明天開盤驗證輪換有沒有效的唯一依據。
  let _hotRound = 0, _hotRotate = true, _hotRotateOffUntil = 0, _hotZero = 0;
  const _hotPrevReveal = {}; let _hotLags = [], _hotChanged = 0, _hotCompared = 0;
  for (;;) {
    try {
      const tw = taipei();
      const mins = tw.getHours() * 60 + tw.getMinutes();
      const hotActive = isTradingDay(tw) && mins >= 8 * 60 + 55 && mins < 13 * 60 + 35;
      if (!hotActive) { await sleep(60000); continue; }
      const t0 = Date.now();
      const codes = await getAllMarketCodes(false);
      if (!codes.length) { await sleep(15000); continue; }
      const byCode = {}; for (const c of codes) byCode[c.code] = c;
      const prio0 = (await buildPriorityCodes(codes)).slice(0, 120);
      if (!_hotRotate && Date.now() > _hotRotateOffUntil) { _hotRotate = true; log('· 快線：恢復輪換批次'); }
      const off = _hotRotate && prio0.length ? (_hotRound++ % prio0.length) : 0;
      const prio = [...prio0.slice(off), ...prio0.slice(0, off)];
      // 指數搭同一班車（2026-08-17 使用者要求 5 秒內更新）：120+2 檔一個請求，
      // 上游請求數零增加。t00/o00 只進指數發布，不進個股報價。
      const batch = [...prio.map(c => byCode[c]).filter(Boolean), { market: 'tse', code: 't00' }, { market: 'otc', code: 'o00' }];
      if (batch.length <= 2) { await sleep(15000); continue; }
      const mis = await misBatch(batch);   // 護欄（pz 紀律/漲跌停/高低價）都在裡面
      {
        const nowMs = Date.now(); const liveQ = Object.values(mis).filter(q => q?.hasLive);
        if (liveQ.length === 0 && mins >= 9 * 60 + 2) { if (++_hotZero >= 3 && _hotRotate) { _hotRotate = false; _hotRotateOffUntil = nowMs + 10 * 60000; _hotZero = 0; log('⚠ 快線：輪換批次後連續 3 輪 0 live，退回固定批次 10 分鐘'); } }
        else _hotZero = 0;
        for (const k in mis) { const q = mis[k]; if (!q?.hasLive || !(q.revealAt > 0)) continue; _hotLags.push((nowMs - q.revealAt) / 1000);
          if (_hotPrevReveal[k] != null) { _hotCompared++; if (q.revealAt !== _hotPrevReveal[k]) _hotChanged++; } _hotPrevReveal[k] = q.revealAt; }
      }
      publishIndexFromHot(mis.t00, mis.o00).catch(() => {});
      const out = {};
      for (const c of batch) {
        if (c.code === 't00' || c.code === 'o00') continue;   // 指數不進個股報價
        const k = c.code; const q = mis[k];
        if (q?.hasLive) {
          const merged = { code: k, name: q.name, price: q.price, change: q.change, changePercent: q.changePercent,
            open: q.open, high: q.high, low: q.low, volume: q.volume, value: q.value,
            market: c.market, live: true, liveAt: Date.now(), revealAt: q.revealAt ?? null };
          _lastLive[k] = merged;            // 主迴圈快照下一輪也直接受益
          out[k] = merged;
        } else if (_lastLive[k]) {
          out[k] = _lastLive[k];            // 兩筆撮合之間沿用最後真實價
        }
      }
      if (Object.keys(out).length) {
        await db.collection('marketSnapshot').doc('hot').set({
          quotesJson: JSON.stringify(out), n: Object.keys(out).length, at: Date.now(), date: isoDate(tw),
        });
      }
      // 心跳：每 ~5 分鐘報一次本期拿到新成交的檔次（觀察 MIS 供應健康度）
      _hotFresh += Object.values(mis).filter(q => q?.hasLive).length;
      if (++_hotN >= 60) {
        const ls = _hotLags.slice().sort((a, b) => a - b); const pct = p => (ls.length ? ls[Math.min(ls.length - 1, Math.floor(ls.length * p))].toFixed(0) : '—');
        const freshPct = _hotCompared ? Math.round(_hotChanged / _hotCompared * 100) : null;
        _hotStats = { at: Date.now(), p50: ls.length ? +pct(0.5) : null, p90: ls.length ? +pct(0.9) : null, freshPct, rotate: _hotRotate, samples: ls.length };
        log(`✓ 快線：近5分鐘 ${_hotFresh} 檔次新成交（每輪 ${batch.length} 檔）｜揭示落後 P50 ${pct(0.5)}s P90 ${pct(0.9)}s｜揭示更新率 ${freshPct ?? '—'}%｜輪換 ${_hotRotate ? '開' : '關'}`);
        _hotN = 0; _hotFresh = 0; _hotLags = []; _hotChanged = 0; _hotCompared = 0;
      }
      // 鎖相（2026-08-17 使用者指正「應該只有一個時間同步擴散」）：
      // MIS 揭示貼齊整 5 秒牆鐘（實測 t 欄全為 :00/:05/:10…）。與其用自己的
      // 相位每 5 秒睡一輪（平均多等 2.5 秒、且每個使用者相位都不同），
      // 改在「揭示邊界 +1 秒」準時抓——資料落地時刻確定，前端據此對錶。
      await sleep(msToNextReveal(1000));
    } catch (e) { log('✖ 快線', (e.message || '').slice(0, 60)); await sleep(10000); }
  }
}

// ── 🤖 AI 監控子代理（2026-08-17 重做）────────────────────────────────
// 舊架構的三個死因：訊息存 web 實例記憶體（多實例各自為政）、產生要靠
// Cloud Run 連不到的本機 Ollama（永遠退回 4 則樣板）、沒有排程。
// 重做為 daemon 產生 → aiMessages/latest → web 只讀。
// 排程（使用者定案）：盤前 5 分鐘（08:55）啟動 → 盤中持續 → 13:32 收盤總結。
// 內容鐵則：只引用本站實證訊號與實際數據，動作訊息必附口徑與依據，非投資建議。
const _agent = { queue: [], lastByKey: {}, day: '', flags: {} };

async function pushAgentMsg({ type, label, emoji, text, summary, severity = 'info', stocks = [], dedupeKey = null, cooldownMs = 30 * 60e3 }) {
  const now = Date.now();
  // 佇列是行程記憶體，但寫出去是整份覆蓋 ⇒ 空佇列直接 set 會**洗掉線上既有訊息**。
  // 單次執行（--run）就會踩到：實測 2026-09-01 盤中判別把面板洗到只剩 1 則。
  // 首次推送前先把同一天的既有訊息讀回來。
  if (!_agent.hydrated) {
    _agent.hydrated = true;
    try {
      const cur = (await db.collection('aiMessages').doc('latest').get()).data();
      if (cur && cur.date === isoDate(taipei())) {
        const prev = JSON.parse(cur.messagesJson || '[]');
        if (Array.isArray(prev) && prev.length && !_agent.queue.length) _agent.queue = [...prev].reverse();
      }
    } catch { /* 讀不到就照原樣新建 */ }
  }
  if (dedupeKey) {
    if (_agent.lastByKey[dedupeKey] && now - _agent.lastByKey[dedupeKey] < cooldownMs) return;
    _agent.lastByKey[dedupeKey] = now;
  }
  _agent.queue.push({
    id: `msg_${now}_${Math.random().toString(36).slice(2, 6)}`,
    type, label, emoji, text, summary, severity, stocks,
    timestamp: now, agentId: 'daemon-agent',
  });
  while (_agent.queue.length > 8) _agent.queue.shift();
  try {
    await db.collection('aiMessages').doc('latest').set({
      updatedAt: now, date: isoDate(taipei()),
      messagesJson: JSON.stringify([..._agent.queue].reverse()),   // newest first
    });
  } catch { /* 下輪重試 */ }
}

async function agentTick(quotes, marketNow) {
  try {
    const tw = taipei();
    if (!isTradingDay(tw)) return;
    const mins = tw.getHours() * 60 + tw.getMinutes();
    const today = isoDate(tw);
    if (_agent.day !== today) {
      _agent.day = today; _agent.flags = {}; _agent.lastByKey = {};
      // 換日清盤面敘事，但**保留新聞判別完成訊號**：晨間趟 07:00 推送時
      // _agent.day 還是昨天，08:55 首次 agentTick 一重置就會把它清掉
      // ——那正是使用者早上要看的那則。
      // ⚠ 要加時效：agentTick 只在交易日跑 ⇒ 不設上限的話，
      //   週五 23:00 的判別訊息會一路撐到**週一**面板（中間沒有 tick 清掉）。
      //   14 小時足以涵蓋 23:00→08:55 與 07:00→08:55，且擋掉跨週末殘留。
      _agent.queue = _agent.queue.filter(m =>
        m.type === 'newsVerdict' && Date.now() - (m.timestamp || 0) < 14 * 3600e3);
    }
    if (mins < 8 * 60 + 55 || mins > 14 * 60 + 30) return;   // 盤前 5 分鐘（08:55）啟動 → 14:30 盤後才關閉（2026-08-17 使用者定案）
    // 心跳（2026-08-18 使用者回報「顯示離線」）：訊息 10 分鐘一則是設計節奏，
    // 上線與否要看心跳不是看訊息年齡——視窗內每 ≤60 秒蓋章一次。
    if (Date.now() - (_agent.hbAt || 0) > 60e3) {
      _agent.hbAt = Date.now();
      db.collection('system').doc('monitor-agent').set({ active: true, lastHeartbeat: Date.now() }, { merge: true }).catch(() => {});
    }

    // ① 08:55 盤前特報（晨報摘要＋隔日沖鐵律提醒）
    if (!_agent.flags.preOpen) {
      _agent.flags.preOpen = true;
      let brief = '';
      try {
        const mn = (await db.collection('morningNote').doc('latest').get()).data();
        if (mn?.date === today && mn.summary) brief = String(mn.summary).slice(0, 180);
      } catch { /* 晨報缺就略 */ }
      await pushAgentMsg({
        type: 'brief', label: '盤前特報', emoji: '🌅', severity: 'info',
        text: `${brief || '今日晨報尚未產出。'}\n\n⏰ 出場鐵律提醒：昨日尾盤進場的隔日沖部位，今日**開盤市價賣出**（700 日實測唯一穩定淨正出場；開高續抱平均吐光溢價 -0.33%）。波段部位依持有日口徑，勿混用。`,
        summary: '盤前特報：晨報摘要＋隔日沖「今早開盤賣」鐵律提醒。',
      });
    }

    // 盤後段（13:35–14:30）：14:00 定價交易提醒後待命，14:30 關閉
    if (!marketNow) {
      if (mins >= 14 * 60 && !_agent.flags.post1400) {
        _agent.flags.post1400 = true;
        await pushAgentMsg({
          type: 'brief', label: '盤後提醒', emoji: '🕑', severity: 'info',
          text: '盤後定價交易 14:00–14:30（以今日收盤價撮合）、盤後零股 13:40–14:30。今日法人籌碼與歸檔資料 15:10 起陸續更新，屆時各榜單自動刷新。',
          summary: '盤後定價/零股交易時段 14:00–14:30；法人資料 15:10 起更新。',
          dedupeKey: 'post1400',
        });
      }
      return;
    }

    // ② 盤勢特報：每 10 分鐘（指數＋家數，全為即時實數）
    const idxDoc = { w: 0, chg: 0, pct: 0 };
    try {
      const d = (await db.collection('marketIndex').doc('latest').get()).data();
      if (d?.weighted > 0) { idxDoc.w = d.weighted; idxDoc.chg = d.weightedChange; idxDoc.pct = d.weightedChangePercent; }
    } catch { /* skip */ }
    let up = 0, dn = 0;
    for (const k in quotes) { const q = quotes[k]; if (!q.live) continue; if (q.changePercent > 0) up++; else if (q.changePercent < 0) dn++; }
    if (idxDoc.w > 0 && up + dn > 300) {
      const tone = idxDoc.pct >= 0.5 ? '偏多' : idxDoc.pct <= -0.5 ? '偏空' : '震盪';
      const breadth = up > dn * 1.5 ? '買氣熱絡' : dn > up * 1.5 ? '賣壓沉重' : '多空拉鋸';
      await pushAgentMsg({
        type: 'trend', label: '盤勢特報', emoji: '📊',
        severity: idxDoc.pct <= -0.5 ? 'warning' : 'info',
        text: `加權指數 ${idxDoc.w.toLocaleString('zh-TW')} 點（${idxDoc.chg >= 0 ? '+' : ''}${idxDoc.chg}，${idxDoc.pct >= 0 ? '+' : ''}${idxDoc.pct}%），盤勢${tone}。上漲 ${up} 家／下跌 ${dn} 家，${breadth}。${dn > up * 1.5 ? '市場強弱偏弱時，隔日沖偏多策略先保守。' : ''}`,
        summary: `加權 ${idxDoc.w.toLocaleString('zh-TW')}（${idxDoc.pct >= 0 ? '+' : ''}${idxDoc.pct}%）·漲${up}跌${dn}·${breadth}`,
        dedupeKey: 'trend', cooldownMs: 10 * 60e3,
      });
    }

    // ③ 機會偵測：每 10 分鐘（盤中爆量榜·附隔日沖濾網門檻，不是無條件推薦）
    try {
      const vs = (await db.collection('volSurge').doc('latest').get()).data();
      const items = (vs?.items || []).slice(0, 3);
      if (vs?.date === today && items.length) {
        const names = items.map(i => `${i.name || ''}(${i.code})`).join('、');
        await pushAgentMsg({
          type: 'opportunity', label: '機會偵測', emoji: '🎯', severity: 'success',
          text: `盤中量能異常偵測：${names}。\n⚠ 爆量≠訊號：隔日沖需通過定版濾網（破20日新高 × 收位≥0.7 × 漲3~7%）才具實證淨正期望；散戶接棒／倒貨進度>60% 一律跳過。請至 ⚡盤中戰情 或 🪣撿尾盤 檢視完整評分。`,
          summary: `量能異常：${names}——需過定版濾網再考慮。`,
          stocks: items.map(i => String(i.code)),
          dedupeKey: 'surge', cooldownMs: 10 * 60e3,
        });
      }
    } catch { /* skip */ }

    // ④ 急跌警示（事件型）：指數 10 分鐘內回落 ≥0.7%
    if (idxDoc.w > 0) {
      if (!_agent.idxTrail) _agent.idxTrail = [];
      _agent.idxTrail.push([Date.now(), idxDoc.w]);
      while (_agent.idxTrail.length && Date.now() - _agent.idxTrail[0][0] > 11 * 60e3) _agent.idxTrail.shift();
      const past = _agent.idxTrail[0];
      if (past && (idxDoc.w / past[1] - 1) * 100 <= -0.7) {
        await pushAgentMsg({
          type: 'risk', label: '急跌警示', emoji: '⚠️', severity: 'danger',
          text: `加權指數 10 分鐘內回落 ${((idxDoc.w / past[1] - 1) * 100).toFixed(2)}%（${Math.round(past[1]).toLocaleString('zh-TW')} → ${Math.round(idxDoc.w).toLocaleString('zh-TW')}）。持股請確認停損價位；隔日沖偏多策略暫停追價。`,
          summary: `急跌警示：指數 10 分鐘回落 ${((idxDoc.w / past[1] - 1) * 100).toFixed(2)}%`,
          dedupeKey: 'plunge', cooldownMs: 30 * 60e3,
        });
      }
    }

    // ⑦ 自選/持股池即時異動警示（2026-08-17 使用者需求）：
    // 全體會員自選＋持股聯集（resolveWatchCodes——快線優先集的同一來源，價新鮮度 ≤30 秒）。
    // 隱私線：警示只標「自選/持股池」，不標是誰的、不揭停損價位（那是個人資料）。
    // 規則（皆為實數觸發·每檔每類 20 分鐘冷卻）：5分鐘急拉≥+2%／急跌≤-2%／觸及漲停。
    try {
      if (!_agent.px) _agent.px = {};
      const watchSet = new Set();
      try { for (const [code] of await resolveWatchCodes()) watchSet.add(code); } catch { /* skip */ }
      let checked = 0;
      for (const code of watchSet) {
        if (++checked > 80) break;   // 池上限，護 CPU 與訊息量
        const q = quotes[code];
        if (!q?.live || !(q.price > 0)) continue;
        const trail = (_agent.px[code] ||= []);
        trail.push([Date.now(), q.price]);
        while (trail.length && Date.now() - trail[0][0] > 6 * 60e3) trail.shift();
        const base = trail[0];
        if (!base || Date.now() - base[0] < 3 * 60e3) continue;   // 至少 3 分鐘的基期才判定
        const mv = (q.price / base[1] - 1) * 100;
        const prev = q.price - (q.change || 0);
        const nearLimitUp = prev > 0 && q.changePercent >= 9.7;
        if (nearLimitUp) {
          await pushAgentMsg({
            type: 'alert', label: '追蹤股觸漲停', emoji: '🔒', severity: 'warning',
            text: `${q.name || ''}(${code}) 觸及/逼近漲停 ${q.price}（${q.changePercent >= 0 ? '+' : ''}${q.changePercent}%）。自選/持股池標的。⚠ 隔日沖口徑「今日收盤買」漲停買不到；已持有者留意漲停打開的賣壓。`,
            summary: `🔒 ${q.name || ''}(${code}) 觸漲停 ${q.price}——收盤買不到，勿追。`,
            stocks: [code], dedupeKey: `lu:${code}`, cooldownMs: 60 * 60e3,
          });
        } else if (mv >= 2) {
          await pushAgentMsg({
            type: 'alert', label: '追蹤股急拉', emoji: '⚡', severity: 'success',
            text: `${q.name || ''}(${code}) 5分鐘急拉 +${mv.toFixed(1)}%（現價 ${q.price}，今日 ${q.changePercent >= 0 ? '+' : ''}${q.changePercent}%）。自選/持股池標的。追價前先過定版濾網與倒貨進度，勿追高。`,
            summary: `⚡ ${q.name || ''}(${code}) 5分鐘 +${mv.toFixed(1)}%（${q.price}）`,
            stocks: [code], dedupeKey: `up:${code}`, cooldownMs: 20 * 60e3,
          });
        } else if (mv <= -2) {
          await pushAgentMsg({
            type: 'risk', label: '追蹤股急跌', emoji: '🔻', severity: 'danger',
            text: `${q.name || ''}(${code}) 5分鐘急跌 ${mv.toFixed(1)}%（現價 ${q.price}，今日 ${q.changePercent >= 0 ? '+' : ''}${q.changePercent}%）。自選/持股池標的——持有者請即刻確認停損價位與部位。`,
            summary: `🔻 ${q.name || ''}(${code}) 5分鐘 ${mv.toFixed(1)}%（${q.price}）——確認停損`,
            stocks: [code], dedupeKey: `dn:${code}`, cooldownMs: 20 * 60e3,
          });
        }
      }
    } catch (e) { log('  ⚠ 追蹤警示：', (e.message || '').slice(0, 50)); }

    // ⑧ 法人×大戶 推漲/倒貨跡象（2026-08-17 使用者需求）：台股**無盤中法人資料**
    // （EOD 15:00 後才有）——此為「昨日法人買賣超(PIT) × 今日盤中價量 × 內外盤取樣」
    // 的推斷跡象，內文據實標示。池＝自選/持股 ∪ 盤中爆量榜前15。
    try {
      if (!_agent.instMap || Date.now() - (_agent.instAt || 0) > 30 * 60e3) {
        const arch = await readArchive(1, 'instJson');
        _agent.instMap = arch[0]?.instJson ? JSON.parse(arch[0].instJson) : {};
        try { const va = (await db.collection('volAvg20').doc('latest').get()).data(); _agent.avgMap = va?.avgJson ? JSON.parse(va.avgJson) : {}; } catch { _agent.avgMap = {}; }
        _agent.instAt = Date.now();
      }
      const pool8 = new Set();
      try { for (const [c] of await resolveWatchCodes()) pool8.add(c); } catch { /* skip */ }
      try { const vs8 = (await db.collection('volSurge').doc('latest').get()).data(); for (const it8 of (vs8?.items || []).slice(0, 15)) pool8.add(String(it8.code)); } catch { /* skip */ }
      let n8 = 0;
      for (const code of pool8) {
        if (++n8 > 100) break;
        const q = quotes[code]; if (!q?.live || !(q.price > 0)) continue;
        const it = _agent.instMap[code]; if (!it) continue;
        const instNet = (it[0] || 0) + (it[1] || 0);           // 外資+投信（張·昨日EOD）
        const avg = _agent.avgMap[code] || 0;
        const volX = avg > 0 ? ((q.volume || 0) / 1000) / avg : 0;
        const fl = _flow.by?.[code];
        const outR = fl && (fl.in + fl.out) > 50 ? fl.out / (fl.in + fl.out) : null;  // 外盤佔比≈主動買
        const prevC = q.price - (q.change || 0);
        const dayHighPct = q.high > 0 && prevC > 0 ? (q.high / prevC - 1) * 100 : 0;
        const pctFromHigh = q.high > 0 ? (q.price / q.high - 1) * 100 : 0;
        if (instNet > 0 && q.changePercent >= 3 && volX >= 2) {
          await pushAgentMsg({
            type: 'opportunity', label: '法人推漲跡象', emoji: '🏦', severity: 'success',
            text: `${q.name || ''}(${code}) 昨日外資+投信買超 ${Math.round(instNet).toLocaleString('zh-TW')} 張，今日 +${q.changePercent}%·量 ${volX.toFixed(1)} 倍均量${outR != null ? `·外盤佔比 ${(outR * 100).toFixed(0)}%${outR >= 0.6 ? '（主動買盤主導）' : ''}` : ''}。⚠ 推斷跡象：台股無盤中法人資料，這是昨日 EOD 籌碼 × 今日價量的組合；追價前仍須過定版濾網與倒貨進度（>60% 不追）。`,
            summary: `🏦 ${q.name || ''}(${code}) 昨買超${Math.round(instNet)}張×今日+${q.changePercent}%·量${volX.toFixed(1)}倍`,
            stocks: [code], dedupeKey: `push:${code}`, cooldownMs: 60 * 60e3,
          });
        } else if (instNet < 0 && dayHighPct >= 4 && pctFromHigh <= -3 && volX >= 2) {
          await pushAgentMsg({
            type: 'risk', label: '疑似出貨警示', emoji: '📤', severity: 'danger',
            text: `${q.name || ''}(${code}) 昨日外資+投信賣超 ${Math.round(-instNet).toLocaleString('zh-TW')} 張，今日衝高 +${dayHighPct.toFixed(1)}% 後自高點回落 ${pctFromHigh.toFixed(1)}%·量 ${volX.toFixed(1)} 倍${outR != null && outR <= 0.4 ? '·內盤主導（主動賣壓）' : ''}。⚠ 推斷跡象（昨日 EOD 籌碼 × 今日盤中價量）；持有者確認停損位，未持有者勿接刀。`,
            summary: `📤 ${q.name || ''}(${code}) 昨賣超×衝高回落${pctFromHigh.toFixed(1)}%——疑似出貨`,
            stocks: [code], dedupeKey: `dump:${code}`, cooldownMs: 60 * 60e3,
          });
        }
      }
    } catch (e) { log('  ⚠ 法人跡象：', (e.message || '').slice(0, 50)); }

    // ⑤ 13:08 買進行動窗（撿尾盤＋波段候選——本站兩個實證進場口徑都是「收盤前買」）
    if (mins >= 13 * 60 + 8 && !_agent.flags.tailEnd) {
      _agent.flags.tailEnd = true;
      let swingTxt = '';
      try {
        const sp = (await db.collection('swingPicks').doc('latest').get()).data();
        const stars = (sp?.date === today && sp.bearDay === true) ? (sp.items || []).filter(x => x.tier === 1) : [];
        if (stars.length) swingTxt = `\n🌊 波段⭐三重確認今日候選（空頭日 gate 通過）：${stars.slice(0, 5).map(x => `${x.name || ''}(${x.code})`).join('、')}——口徑=今日收盤買·持有5個交易日（主窗+1.15%/勝54%），與隔日沖口徑勿混用。`;
        else if (sp?.date === today && sp.bearDay === false) swingTxt = '\n🌊 波段⭐：今日為多頭日（gate 不通過），實測此訊號多頭日 5日-0.24%——本日不進場是紀律不是遺漏。';
      } catch { /* skip */ }
      await pushAgentMsg({
        type: 'opportunity', label: '買進行動窗', emoji: '🪣', severity: 'success',
        text: `13:00–13:25 撿尾盤觀察窗開啟。隔日沖唯一實證淨正組合：**定版濾網（破20日新高×收位≥0.7×漲3~7%）× 明早開盤賣**；候選與評分見 📡即時追蹤 → 🪣撿尾盤。13:25–13:30 為試撮時段，價格會跳、掛單可撤，勿被試撮假價騙進場。${swingTxt}`,
        summary: '買進行動窗：撿尾盤 13:00-13:25·定版濾網候選見🪣分頁。',
        dedupeKey: 'tailEnd',
      });
    }

    // ⑥ 13:32 收盤總結
    if (mins >= 13 * 60 + 32 && !_agent.flags.close) {
      _agent.flags.close = true;
      await pushAgentMsg({
        type: 'brief', label: '收盤總結', emoji: '🔔', severity: 'info',
        text: `今日收盤：加權指數 ${idxDoc.w.toLocaleString('zh-TW')} 點（${idxDoc.chg >= 0 ? '+' : ''}${idxDoc.chg}，${idxDoc.pct >= 0 ? '+' : ''}${idxDoc.pct}%），上漲 ${up} 家／下跌 ${dn} 家。\n⏰ 明早提醒：今日尾盤進場的隔日沖部位，明日開盤市價賣出（鐵律）。盤後 15:10 起法人籌碼與歸檔資料陸續更新。`,
        summary: `收盤：加權 ${idxDoc.w.toLocaleString('zh-TW')}（${idxDoc.pct >= 0 ? '+' : ''}${idxDoc.pct}%）·明早鐵律出場提醒`,
        dedupeKey: 'close',
      });
    }
  } catch (e) { log('  ⚠ 子代理：', (e.message || '').slice(0, 60)); }
}

async function marketSnapshotLoop() {
  await restoreLastLive();
  for (;;) {
    try {
      const tw = taipei();
      const mins = tw.getHours() * 60 + tw.getMinutes();
      // 掃描窗 08:30–15:00：收盤後 MIS 仍供今日終價，補「13:35收盤~15:00官方結算」
      // 的空窗（實案 2026-07-17：收盤後重啟 → _lastLive 清空 → 全部退回昨日種子）。
      // 掃描窗延長至 16:30：MIS 收盤後仍回今日收盤價，補「TPEx openapi 上櫃收盤延遲
      // 一天」的缺口(實案 2026-07-17：6732 上櫃今收193.5，TPEx種子仍昨收214)。
      const active = isTradingDay(tw) && mins >= 8 * 60 + 30 && mins < 16 * 60 + 30;
      // 跨夜清倉：restoreLastLive 的「只還原今天」只在重啟時把關；daemon 長跑跨夜時
      // 記憶體 _lastLive 沒人清（實案 2026-08-14：305 檔昨日殘價標 live 混入今日快照，
      // 1435 的 8/13 假試撮價 25.75 顯示成今日 +8.65%）。逐輪把非今日的殘留刪掉，
      // 冷門股在拿到今日首筆真成交前回種子昨收——寧可持平，不可掛昨價。
      {
        const todayIso = isoDate(tw);
        for (const k in _lastLive) {
          const la = _lastLive[k]?.liveAt;
          if (!la || isoDate(new Date(la)) !== todayIso) delete _lastLive[k];
        }
      }
      const marketNow = isTradingDay(tw) && mins >= 9 * 60 && mins < 13 * 60 + 35;
      // 收盤後 13:35–15:00：官方 STOCK_DAY_ALL 逐步更新今日結算價，強制刷新代碼表以便即時取得。
      const postClose = isTradingDay(tw) && mins >= 13 * 60 + 35 && mins < 15 * 60;
      const codes = await getAllMarketCodes(postClose);
      if (codes.length === 0) { await sleep(60000); continue; }
      writeMarketIndex().catch(() => {}); // 加權指數落地（t00 收盤後仍回今日收盤，整晚有效）
      // 🗼 寶塔線每 ~15 分鐘重算（讀 Firestore 為主，無上游請求；掃描窗外也要跑——
      // 週末/盤後開站看的是最近交易日的判定，不能等到下次開盤才有資料）
      if (Date.now() - _pagodaAt > 15 * 60e3) { _pagodaAt = Date.now(); computePagodaSignals().catch(() => {}); }

      // Always seed EVERY stock from close so the full market is present.
      const quotes = {};
      for (const c of codes) quotes[c.code] = seedQuote(c);
      // ⚠ 掃描窗外也要套回今日掃到的真實價（2026-08-11 修）：
      //   舊版只在 `if (active)` 裡套 _lastLive，於是 16:30 一過，
      //   每一輪都把整份快照重鋪成種子——**白天辛苦掃到的今日收盤全部丟掉**，
      //   上櫃那半又因為 openapi 鏡像落後而退回昨天。
      //   使用者在半夜看到的「有些是昨天的」就是這個。
      //   種子只在「這一檔今天從未掃到」時才該出現。
      if (!active) {
        const today = isoDate(tw);
        for (const k in _lastLive) {
          const v = _lastLive[k];
          if (!quotes[k] || !v) continue;
          if (isoDate(new Date(v.liveAt || 0)) !== today) continue;   // 跨日殘留不可沿用
          quotes[k] = { ...v };
        }
      }

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
              if (q.realTrade) accumulateFlow(k, { ...q, hasLive, bid, ask }, tw);   // 內外盤只取真成交（中價無主動方向）
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
        for (let i = 0; i < prio.length; i += 120) {
          applyMis(await misBatch(prio.slice(i, i + 120).map(code => byCode[code]).filter(Boolean)), true);
          await sleep(3000);   // 快線佔 1 req/5s，主迴圈放緩到 1 req/3s，合計 ~2.7 req/5s < MIS 限制
        }
        // 空榜要自己解釋（稽核原則）：盤外本來就沒有五檔，n=0 是真實狀態不是故障
        // ——但**只在盤外**附理由；盤中 n=0 不給理由，讓稽核照樣報警
        //（bookDepth 曾壞半年沒人發現，那道保護不可弱化）。
        try { await db.collection('bookDepth').doc('latest').set({ byCodeJson: JSON.stringify(depthOut), n: Object.keys(depthOut).length, at: Date.now(), date: isoDate(taipei()), ...(Object.keys(depthOut).length === 0 && !marketNow ? { emptyReason: '盤外無五檔（五檔僅盤中 09:00~13:35 存在）' } : {}) }); } catch { /* ignore */ }
        // ② 全市場輪掃：其餘代碼每輪掃 8 批(960檔·單批120實測OK)，~1分鐘覆蓋全市場一輪。
        //    修正實案(2026-07-17)：全市場快照僅150檔live、1830檔掛昨日種子 →
        //    「即時漲跌」左欄混入大量昨日上漲的殘留資料。
        const prioSet = new Set(prio);
        const rest = codes.map(c => c.code).filter(c => !prioSet.has(c));
        for (let n = 0; n < 8 && rest.length; n++) {
          const batch = [];
          for (let j = 0; j < 120 && rest.length; j++) { batch.push(byCode[rest[_rotIdx % rest.length]]); _rotIdx++; }
          applyMis(await misBatch(batch.filter(Boolean)), false);
          await sleep(3000);
        }
        // 輪掃間隙沿用最後真實價（_lastLive），避免掃描空窗跳回昨日種子
        for (const c of codes) { const k = c.code; if (!quotes[k].live && _lastLive[k]) quotes[k] = { ..._lastLive[k] }; }
        const liveN = Object.values(quotes).filter(q => q.live).length;
        // 盤中：今日尚無真成交的檔（分盤處置/極冷門）漲跌歸零顯示平盤——種子帶的是
        // 「昨日」漲跌，不歸零會像 1435 一樣以昨日 +7.59% 掛在今日即時漲幅榜上。
        if (marketNow) {
          for (const k in quotes) {
            const q = quotes[k];
            if (!q.live && (q.change || q.changePercent)) quotes[k] = { ...q, change: 0, changePercent: 0 };
          }
        }
        await writeSnapshot(quotes, marketNow, 'mixed', true);
        agentTick(quotes, marketNow).catch(() => {});
        // 大盤脈動（30 秒節流）：只讀 Firestore/記憶體快照，零上游請求，
        // 不影響「請求數與線上人數脫鉤」的不變式。
        if (Date.now() - _pulseAt > 30000) { _pulseAt = Date.now(); computeMarketPulse().catch(e => log('✖ 大盤脈動:', e.message)); }
        // 搶漲停排隊（09:15 前）：quotes 就在手上，零額外上游請求
        computeLimitQueue(quotes).catch(e => log('✖ 搶漲停排隊:', e.message));
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
  // ── 隔日沖候選：可交易宇宙 gate（2026-08-05 上線驗證時抓到）──────
  // 舊版沒有 gate，實際榜上第一頁全是 +10/+9.98/+9.97% 的漲停股——
  // **隔日沖的定義就是「今日收盤買」，漲停買不到，整張榜等於不可執行**。
  // 這與 ai-recommend 剛加的 gate 是同一條規則，但當時只補了 web 那一邊，
  // 漏了 daemon 這邊；是在瀏覽器看實際榜單才發現的。
  //   ⇒ 教訓：同一條口徑規則若有兩個產生點，補一邊等於沒補。
  // 排序改用 closePos（收盤強度）為主、漲幅為輔——上限 8.5% 之後，
  // 再用漲幅乘權會把排序推向 8.4% 那一格，那正是四窗檢定❌的區間。
  const overnight = enrich
    .filter(x => x.changePct > 1.5 && x.changePct <= 8.5 && x.closePos >= 0.8)
    .sort((a, b) => (b.closePos - a.closePos) || (b.changePct - a.changePct))
    .slice(0, 15);
  await db.collection('tradeSignals').doc('latest').set({ updatedAt: Date.now(), date: await dataDate(), dayTrade, overnight });
  const luDropped = enrich.filter(x => x.changePct > 8.5 && x.closePos >= 0.8).length;
  log(`✓ 當沖/隔日沖：當沖 ${dayTrade.length} 檔、隔日沖 ${overnight.length} 檔（因漲停買不到剔除 ${luDropped} 檔）`);
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
  await db.collection('dailyPost').doc('latest').set({ dataDate: await currentDataDate(), date: isoDate(taipei()), generatedAt: Date.now(), model: 'template(zero-hallucination)', post, breadth: { up, down } });
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
      // ⚠2026-08-06 修正：原本用 meta.chartPreviousClose（range=5d）——實測 6 檔錯 5 檔，
      //   費半顯示 **+14.95%（實際 -1.40%）**、原油 -10.58%（實際 -0.08%），因為它回的是
      //   「整個視窗之前」的收盤而非前一交易日。這個錯誤還會傳染到「電子偏多/偏空」判定
      //   與晨報的隔夜國際盤段。改用 _yahooQuote（日線×小時線交叉驗證·以報價所屬交易日為基準）。
      const q = await _yahooQuote(sym); if (!q) continue;
      out.push({ sym, name, price: q.price, changePct: q.total, prevDate: q.prevDate, quoteAt: q.quoteAt ?? null });
    } catch { /* skip */ }
    await sleep(200);
  }
  if (!out.length) return;
  const sox = out.find(x => x.sym === '^SOX');
  const expectation = sox ? (sox.changePct > 1 ? '電子偏多' : sox.changePct < -1 ? '電子偏空' : '中性') : '中性';
  await db.collection('globalMarkets').doc('latest').set({ updatedAt: Date.now(), markets: out, expectation });
  log(`✓ 國際盤：費半 ${sox?.changePct ?? 'n/a'}% → ${expectation}`);
}

// ── 公開資訊觀測站「當日重大訊息」接入（2026-09-17 計畫第一段·使用者決定「要接」）──
//   免費、官方、第一手、帶精確發言時間。本段**只抓取與去重，不判別、不進評分**（第一段規格：先把量尺做對）。
//   端點：新版 MOPS JSON API `POST t05st02 {TYPEK, year, month, day}`（民國年）。實測：TYPEK sii／otc 回同一份
//   （上市上櫃都在，市場別在每列的 parameters.marketKind），且列裡混有**前一日晚間補登**的公告 ⇒ 依發言日分桶存檔。
//   ⚠ openapi 的 t187ap04_L 是「前一日」鏡像（出表日比發言日晚一天，2026-09-17 實測），只能當備援，這裡不用。
//   去重鍵 = marketKind-enterDate-serialNumber-companyId（序號在同公司同日內唯一）。
//   內文（「說明」欄）另打 t05st02_detail：每輪最多 MOPS_DETAIL_CAP 筆、300ms 間隔，抓不到留 null 不捏造；
//   apiName 不是 t05st02_detail 的列（中期報告 t59sb01 等）沒有這種內文，只存主旨。
//   文件：mopsNews/{發言日} itemsJson（key→item）＋ mopsNews/latest（今日、依時間新→舊）。
const MOPS_API = 'https://mops.twse.com.tw/mops/api/';
const MOPS_DETAIL_CAP = 150;
const MOPS_BODY_MAX = 1200;
function mopsRocToMs(d, t) {
  const m = String(d || '').match(/^(\d{2,3})\/(\d{2})\/(\d{2})$/); if (!m) return null;
  const [hh, mm, ss] = String(t || '00:00:00').split(':').map(Number);
  return Date.UTC(+m[1] + 1911, +m[2] - 1, +m[3], (hh || 0) - 8, mm || 0, ss || 0);   // 台北時間 → UTC ms
}
async function mopsPost(api, body) {
  const r = await fetch(MOPS_API + api, {
    method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j?.code !== 200) throw new Error(`MOPS ${j?.code ?? '?'} ${j?.message || ''}`.trim());
  return j.result;
}
async function ingestMops() {
  const tw = taipei(); const today = isoDate(tw);
  const res = await mopsPost('t05st02', { TYPEK: 'sii', year: String(tw.getFullYear() - 1911), month: String(tw.getMonth() + 1).padStart(2, '0'), day: String(tw.getDate()).padStart(2, '0') });
  const rows = Array.isArray(res?.data) ? res.data : [];
  const byDay = {};
  for (const r of rows) {
    const m = String(r[0] || '').match(/^(\d{2,3})\/(\d{2})\/(\d{2})$/); if (!m) continue;
    const day = `${+m[1] + 1911}-${m[2]}-${m[3]}`;
    const at = mopsRocToMs(r[0], r[1]); if (!at) continue;
    const p = (r[5] && r[5].parameters) || {};
    const code = String(r[2] || '').trim(); if (!code) continue;
    const key = `${p.marketKind || '?'}-${p.enterDate || ''}-${p.serialNumber ?? ''}-${code}`;
    (byDay[day] ||= {})[key] = {
      key, code, name: String(r[3] || '').trim(), subject: String(r[4] || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      at, market: p.marketKind || null, enter: p.enterDate || null, serial: p.serialNumber ?? null,
      api: (r[5] && r[5].apiName) || null, body: null,
    };
  }
  if (!Object.keys(byDay).length) { log('  ⚠ MOPS 重訊：查詢成功但無列（清晨可能尚無公告）'); }
  let added = 0, detailed = 0, detailFail = 0, budget = MOPS_DETAIL_CAP;
  for (const day of Object.keys(byDay).sort()) {
    const ref = db.collection('mopsNews').doc(day);
    const prev = (await ref.get()).data();
    const items = prev?.itemsJson ? JSON.parse(prev.itemsJson) : {};
    const fresh = Object.values(byDay[day]).filter(x => !items[x.key]);
    for (const x of fresh) { items[x.key] = x; added++; }
    // 內文：新的先補，額度有剩再補上一輪沒補到的（超過 150 則的日子分幾輪補齊，不會永遠缺）
    const wantBody = [...fresh, ...Object.values(items).filter(x => !x.body && !fresh.includes(x))]
      .filter(x => !x.body && x.api === 't05st02_detail' && x.market && x.enter && x.serial != null);
    let bodyTouched = 0;
    for (const x of wantBody) {
      if (budget <= 0) break;
      budget--; bodyTouched++;
      try {
        const d = await mopsPost('t05st02_detail', { marketKind: x.market, enterDate: x.enter, serialNumber: x.serial, companyId: x.code });
        const row = Array.isArray(d?.data) ? d.data[0] : null;
        const body = row ? String(row[9] || '').replace(/\r/g, '').trim() : '';
        if (body) { items[x.key].body = body.slice(0, MOPS_BODY_MAX); detailed++; } else detailFail++;
      } catch { detailFail++; }
      await sleep(300);
    }
    if (!fresh.length && !bodyTouched && prev) continue;   // 這天沒有新公告也沒補到內文：不重寫
    // Firestore 單文件 1MiB：季報／董事會截止日可達上千則，超標就只保留最新 300 則的內文
    let json = JSON.stringify(items);
    if (json.length > 900_000) {
      const keep = new Set(Object.values(items).sort((a, b) => b.at - a.at).slice(0, 300).map(x => x.key));
      for (const k in items) if (!keep.has(k)) items[k].body = null;
      json = JSON.stringify(items);
      log(`  ⚠ MOPS ${day} 超過 900KB，僅保留最新 300 則內文`);
    }
    await ref.set({
      date: day, dataDate: day, n: Object.keys(items).length, updatedAt: Date.now(), fetchedAt: Date.now(),
      itemsJson: json, source: 'mops.twse.com.tw/mops/api/t05st02',
      note: '公開資訊觀測站當日重大訊息原文（官方第一手·僅抓取去重，未判別、未進評分）。非投資建議。',
    }, { merge: true });
  }
  // latest ＝ 今日那份（清晨無公告時 n=0，稽核 allowEmpty；不拿前一日冒充今日）
  const tDoc = (await db.collection('mopsNews').doc(today).get()).data();
  const tItems = tDoc?.itemsJson ? Object.values(JSON.parse(tDoc.itemsJson)).sort((a, b) => b.at - a.at) : [];
  await db.collection('mopsNews').doc('latest').set({
    date: today, dataDate: today, n: tItems.length, updatedAt: Date.now(), fetchedAt: Date.now(),
    items: tItems.map(x => ({ key: x.key, code: x.code, name: x.name, subject: x.subject, at: x.at, market: x.market, hasBody: !!x.body })),
    days: Object.keys(byDay).sort(),
    note: '今日重大訊息索引（內文在 mopsNews/{日期}）。僅抓取去重，未判別。非投資建議。',
  });
  log(`✓ MOPS 重訊：${rows.length} 列（${Object.keys(byDay).sort().join('、') || '無'}）→ 新增 ${added}、內文 ${detailed}${detailFail ? `、內文失敗 ${detailFail}` : ''}；今日 ${tItems.length} 則`);
  return true;
}

// ── 產業現貨／原物料報價（2026-09-17 計畫第一段·使用者決定「先接免費來源」）──
//   只抓取存檔（sectorSpot/{日}＋latest），**不進任何評分**；供之後的產業層判別（M8）與對答案引用。
//   免費來源：Yahoo Finance 期貨連續合約（走既有 _yahooQuote：日線×小時線交叉驗證、以報價所屬交易日為基準）
//   與 DRAMeXchange 首頁公開的 DRAM 現貨表（Session Average／Session Change，頁面自報 Last Update）。
//   付費或抓不到的（DRAMeXchange 合約價、WitsView 面板、SCFI 頁面是圖片、BDI 需授權）**不接、不捏造**。
const SPOT_FUTURES = [
  ['CL=F', '西德州原油', 'USD/桶', ['塑化', '航運', '油電燃氣']],
  ['BZ=F', '布蘭特原油', 'USD/桶', ['塑化', '航運']],
  ['NG=F', '天然氣', 'USD/MMBtu', ['油電燃氣', '塑化']],
  ['HG=F', '銅', 'USD/磅', ['電線電纜', 'PCB', '電子零組件']],
  ['ALI=F', '鋁', 'USD/噸', ['金屬', '汽車零組件']],
  ['GC=F', '黃金', 'USD/盎司', ['貴金屬']],
  ['SI=F', '白銀', 'USD/盎司', ['貴金屬', '太陽能']],
];
async function computeSectorSpot() {
  const today = isoDate(taipei());
  const items = []; const sources = {};
  for (const [sym, name, unit, sectors] of SPOT_FUTURES) {
    try {
      const q = await _yahooQuote(sym);
      // asOf＝這筆報價所屬的交易日（UTC 日，Yahoo 語意），chgPct＝對前一交易日收盤
      if (q) { items.push({ key: sym, name, unit, price: q.price, chgPct: q.total ?? null, asOf: q.curDay ?? null, prevDate: q.prevDate ?? null, quoteAt: q.quoteAt ?? null, source: 'yahoo', sectors }); sources.yahoo = true; }
    } catch { /* 單一標的失敗不擋 */ }
    await sleep(200);
  }
  try {
    const html = await (await fetch('https://www.dramexchange.com/', { headers: _NEWS_UA, signal: AbortSignal.timeout(15000) })).text();
    const cells = t => [...t.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map(r => [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => c[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()));
    const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map(m => cells(m[0]));
    const dram = tables.find(rows => rows[0]?.[0] === 'Item' && /Daily High/i.test(rows[0]?.[1] || ''));
    // 頁面自報的更新時刻（例「Last Update:Sep.17 2026 14:40 (GMT+8)」）——這才是資料時點，不拿抓取時刻冒充
    const upd = (html.match(/DRAM Spot Price[\s\S]{0,600}?Last Update:\s*([A-Za-z]{3}\.?\s*\d{1,2}\s+\d{4}\s+\d{1,2}:\d{2})/) || [])[1] || null;
    const updMs = upd ? Date.parse(upd.replace('.', ' ') + ' GMT+0800') : NaN;
    if (dram) {
      for (const row of dram.slice(1)) {
        const price = parseFloat(row[5]); const chg = parseFloat(String(row[6] || '').replace('%', ''));
        if (!(price > 0) || !/DDR/.test(row[0] || '')) continue;
        items.push({ key: `DRAM:${row[0]}`, name: `DRAM 現貨 ${row[0]}`, unit: 'USD', price, chgPct: Number.isFinite(chg) ? chg : null,
          asOf: Number.isFinite(updMs) ? isoDate(new Date(new Date(updMs).toLocaleString('en-US', { timeZone: 'Asia/Taipei' }))) : null, quoteAt: Number.isFinite(updMs) ? updMs : null,
          source: 'dramexchange', sectors: ['記憶體'] });
      }
      if (dram.length > 1) sources.dramexchange = true;
    }
  } catch { /* DRAMeXchange 抓不到就沒有記憶體那組，缺就缺 */ }
  if (!items.length) { log('✖ 產業現貨報價：所有來源皆無資料，不寫入'); return false; }
  const doc = { date: today, dataDate: today, n: items.length, updatedAt: Date.now(), fetchedAt: Date.now(), items, sources,
    note: '免費來源的產業現貨／原物料報價（Yahoo 期貨連續合約＋DRAMeXchange 公開現貨表）。只存檔不評分。非投資建議。' };
  await db.collection('sectorSpot').doc(today).set(doc);
  await db.collection('sectorSpot').doc('latest').set(doc);
  log(`✓ 產業現貨報價：${items.length} 項（${Object.keys(sources).join('＋')}）`);
  return true;
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
// ⚠**第三個坑（2026-08-06 使用者發現「日韓明明在跌卻顯示漲」）**：
//   Yahoo 的**日線會整根漏掉某一交易日**——當天 ^N225 與 ^KS11 的 08/05 日 K 是 null
//   （08/05 是全亞洲大漲日），我們靜默跳過 null 後就拿 08/04 當前收，
//   算出日經 +1.92%／KOSPI -0.34%，實際是 **-1.70%／-4.75%**——**方向相反**。
//   而同一時間**小時線有 08/05**（66287.96／6637.73）。
//   ⇒ 修法不是換來源，是**兩個來源交叉驗證**：日線與小時線各自推「前一交易日收盤」，
//     **取日期較晚者**。兩種來源的失敗模式都是「漏掉整日」，漏日的一方日期必然偏早，
//     取較晚者可同時修好日線漏日（本次）與 5分K/小時線漏日（村田 07-31 那次）。
//   ⇒ 兩邊都取不到 → 回 null（fail-closed），寧可空著也不出一個可能反向的數字。
async function _asiaSeries(sym, interval, range) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 12000);
  try {
    const j = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctl.signal }).then(r => r.ok ? r.json() : null).finally(() => clearTimeout(tm));
    const r = j?.chart?.result?.[0]; if (!r?.meta) return null;
    const ts = r.timestamp || [], q = r.indicators?.quote?.[0] || {};
    // 依 UTC 日分組（日韓 09:00 開盤＝00:00 UTC·收盤仍在同一 UTC 日，不會錯位）
    const byDay = new Map();
    for (let i = 0; i < ts.length; i++) {
      if (!(q.close?.[i] > 0)) continue;
      const d = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      const cur = byDay.get(d);
      if (cur) { cur.c = q.close[i]; if (!(cur.o > 0) && q.open?.[i] > 0) cur.o = q.open[i]; }
      else byDay.set(d, { o: q.open?.[i] > 0 ? q.open[i] : null, c: q.close[i] });
    }
    return { meta: r.meta, days: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])) };
  } catch { clearTimeout(tm); return null; }
}
// 供日韓與美股共用。**基準日不可用「今天」**：美股一場交易在 UTC 上屬於前一天
// （台北 09:30 時，最後一場美股是 UTC 前一日），用「今天」會把當場收盤誤當前收 → 0%。
// 正解＝以 regularMarketTime 換算出「這筆報價所屬的交易日」，前收＝該日之前最後一日。
async function _yahooQuote(sym) {
  const [sD, sI] = await Promise.all([_asiaSeries(sym, '1d', '10d'), _asiaSeries(sym, '1h', '5d')]);
  const meta = sD?.meta || sI?.meta; if (!meta) return null;
  const px = meta.regularMarketPrice > 0 ? meta.regularMarketPrice : null;
  if (!(px > 0)) return null;
  const lastDay = ser => (ser?.days?.length ? ser.days[ser.days.length - 1][0] : null);
  const curDay = meta.regularMarketTime > 0
    ? new Date(meta.regularMarketTime * 1000).toISOString().slice(0, 10)
    : (lastDay(sD) || lastDay(sI));
  if (!curDay) return null;
  // 各來源的「最後一個早於報價交易日的日子」＝該來源認定的前一交易日
  const prevOf = ser => {
    if (!ser?.days?.length) return null;
    for (let i = ser.days.length - 1; i >= 0; i--) {
      const [d, v] = ser.days[i];
      if (d < curDay && v.c > 0) return { d, c: v.c };
    }
    return null;
  };
  const pD = prevOf(sD), pI = prevOf(sI);
  // 取日期較晚者（見上方註解：漏日的一方必然偏早）
  const prevRow = !pD ? pI : !pI ? pD : (pI.d > pD.d ? pI : pD);
  if (!prevRow) return null;
  const disagree = pD && pI && pD.d !== pI.d ? `日線前收=${pD.d}／小時線前收=${pI.d}，採用較晚者 ${prevRow.d}` : null;
  if (disagree) log(`  ⚠ ${sym} 前收來源不一致：${disagree}（日線漏日）`);
  const prev = prevRow.c;
  // 今開：日線當場 bar 優先，缺則用小時線當場第一根
  const todayD = sD?.days?.find(([d]) => d === curDay)?.[1];
  const todayI = sI?.days?.find(([d]) => d === curDay)?.[1];
  const open = todayD?.o > 0 ? todayD.o : (todayI?.o > 0 ? todayI.o : null);
  return {
    price: +px.toFixed(2), prev: +prev.toFixed(2), prevDate: prevRow.d, curDay,
    // ⚠Yahoo 免費報價對日韓約延遲 20 分：regularMarketTime 是**這筆報價的實際時間**，
    //   不是抓取時間。不揭露的話使用者會以為 08:30 看到的是 08:30 的盤況。
    quoteAt: meta.regularMarketTime > 0 ? meta.regularMarketTime * 1000 : null,
    prevSrc: prevRow === pI ? 'hourly' : 'daily', prevWarn: disagree,
    gap: open > 0 ? +((open / prev - 1) * 100).toFixed(2) : null,   // 開盤跳空
    drift: open > 0 ? +((px / open - 1) * 100).toFixed(2) : null,   // 開盤後走勢（新資訊）
    total: +((px / prev - 1) * 100).toFixed(2),                     // 合計（預測力最強）
  };
}

const _asiaQuote = _yahooQuote;

async function computeAsiaPremarket({ lateCatchup = false, slot = null } = {}) {
  const tw = taipei(); const today = isoDate(tw);
  const minsNow = tw.getHours() * 60 + tw.getMinutes();
  // 階段語意（回測必須分流）：premarket=台股開盤前的領先觀測；
  //   open=開盤當下對齊用；track=開盤後追蹤（日韓已含台股反饋，非領先指標）。
  const phase = minsNow < 9 * 60 ? 'premarket' : minsNow <= 9 * 60 + 10 ? 'open' : 'track';
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
  const nk = idx.find(x => x.sym === '^N225'), ks = idx.find(x => x.sym === '^KS11'), kq = idx.find(x => x.sym === '^KQ11');
  const parts = [nk?.total, ks?.total].filter(v => v != null);
  const score = parts.length ? +(parts.reduce((a, b) => a + b, 0) / parts.length).toFixed(2) : null;
  // 日韓**分別**的漲跌方向（使用者要求 2026-08-06）：綜合分數會把一漲一跌互相抵消，
  // 看起來「中性」但實際是分歧——分歧本身就是資訊，必須分開出示。
  // ⚠只給方向不給 bias 分級：三分位門檻是用**綜合分數**校準的，套到單一市場等於借用未驗證的口徑。
  const dirOf = v => v == null ? null : v >= 0.3 ? 'up' : v <= -0.3 ? 'down' : 'flat';
  const krVals = [ks?.total, kq?.total].filter(v => v != null);
  const jp = nk ? { name: '日本', chg: nk.total, dir: dirOf(nk.total), detail: `日經225 ${nk.total >= 0 ? '+' : ''}${nk.total}%` } : null;
  const kr = krVals.length ? {
    name: '韓國', chg: +(krVals.reduce((a, b) => a + b, 0) / krVals.length).toFixed(2),
    dir: dirOf(krVals.reduce((a, b) => a + b, 0) / krVals.length),
    detail: [ks && `KOSPI ${ks.total >= 0 ? '+' : ''}${ks.total}%`, kq && `KOSDAQ ${kq.total >= 0 ? '+' : ''}${kq.total}%`].filter(Boolean).join('·'),
  } : null;
  const split = jp && kr && jp.dir !== kr.dir && jp.dir !== 'flat' && kr.dir !== 'flat'
    ? `⚠日韓分歧：日本${jp.chg >= 0 ? '漲' : '跌'}、韓國${kr.chg >= 0 ? '漲' : '跌'}——綜合分數會互相抵消，此時綜合訊號的參考度下降` : null;
  // 報價新鮮度：Yahoo 免費源對日韓約延遲 20 分鐘，取各檔 regularMarketTime 的最舊者
  const qAts = idx.map(x => x.quoteAt).filter(v => v > 0);
  const quoteAt = qAts.length ? Math.min(...qAts) : null;
  const delayMin = quoteAt ? Math.round((Date.now() - quoteAt) / 60000) : null;
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
    lateCatchup, slot, phase,
    indices: idx, bellwethers: bells, sectors, score, bias, biasNote, sox, soxNote,
    jp, kr, split, quoteAt, delayMin,
    delayNote: delayMin == null ? 'ℹ報價時間未提供，無法確認新鮮度'
      : `ℹ報價時間 ${new Date(quoteAt + 8 * 3600e3).toISOString().slice(11, 16)}（台北）·約落後 ${delayMin} 分——Yahoo 免費源對日韓延遲約 20 分，非即時盤中價`,
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
      slot: slot ?? null, phase, quoteAt: quoteAt ?? null, delayMin: delayMin ?? null,
      score, jpChg: jp?.chg ?? null, krChg: kr?.chg ?? null,
      idxJson: JSON.stringify(idx.map(x => [x.sym, x.gap, x.drift, x.total])),
      bellJson: JSON.stringify(bells.map(x => [x.sym, x.total])),
    }),
  }, { merge: true });
  await db.collection('asiaPremarket').doc('latest').set(doc);
  log(`✓ 日韓早盤${slot ? `[${slot}]` : ''}${lateCatchup ? '(補跑)' : ''}：🇯🇵${jp?.chg ?? 'n/a'}%·🇰🇷${kr?.chg ?? 'n/a'}% → 綜合 ${score}%（${bias}）`
    + `${split ? '·分歧' : ''}｜延遲 ${delayMin ?? '?'} 分｜最強族群 ${sectors[0]?.sector} ${sectors[0]?.chg}%`);
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
    last: Math.round(_f(x['營業收入-去年當月營收'])),
    prevRev: Math.round(_f(x['營業收入-上月營收'])),
    yoy: +_f(x['營業收入-去年同月增減(%)']).toFixed(1),
    mom: +_f(x['營業收入-上月比較增減(%)']).toFixed(1),
  })).filter(x => x.revenue > 0);
  const month = rows[0]?.['資料年月'] || '';
  // ⚠ 排行必須設**分母下限**（2026-08-11）：YoY = 當月/去年同月 - 1，
  //   去年同月趨近於零時會噴出天文數字。實測 2026-07 未設限時榜首是
  //   聯上 +1,096,391%、富旺 +316,265% —— 數學上沒錯，但當排行完全沒有意義，
  //   而且會讓人誤以為那是超級成長股（實際是營建業認列時點集中造成的基期假象）。
  //   下限取 10,000 千元（＝1 千萬）：只剔除 79/1,820 檔就消掉純分母假象，
  //   再高就開始砍到真實資料（50,000 會砍掉 302 檔）。
  //   ⚠ 這道下限**不能消除營建業的認列集中**（全坤建 +5,220% 仍在榜上），
  //     那不是資料錯誤而是產業特性，故改以 caveat 揭露而非繼續加嚴。
  const BASE_FLOOR = 10000;
  const yoyOk = x => (x.last ?? 0) >= BASE_FLOOR;
  const momOk = x => (x.prevRev ?? x.prev ?? 0) >= BASE_FLOOR;
  let topYoY = items.filter(yoyOk).sort((a, b) => b.yoy - a.yoy).slice(0, 20);
  let topMoM = items.filter(momOk).sort((a, b) => b.mom - a.mom).slice(0, 20);
  let outMonth = month, src = 'openapi';

  // ── 取新：若 revenueArchive 已有更新的月份，改用它 ──────────────────────
  // ⚠ **openapi t187ap05 落後一整個月**（不是一天）——這件事下方歸檔處的註解
  //   從 2026-08-10 就寫著了，卻沒人回頭修 latest：於是使用者看到的月營收排行
  //   一直慢一個月。2026-08-11 實測：openapi 還停在 11506(6月)，
  //   而 MOPS 管線早已把 2026-07 的 1,820 檔寫進 revenueArchive。
  //   同一個病理：**較新的來源就在旁邊，只是沒有人比對過**。
  //   ⇒ 這裡改成比對兩邊的「資料所屬月」，取較新的那一份重建排行。
  const toId = m => (/^\d{5,6}$/.test(String(m)) ? `${parseInt(String(m).slice(0, -2), 10) + 1911}-${String(m).slice(-2)}` : '');
  try {
    const apiId = toId(month);
    // ⚠ **不要用 orderBy('__name__','desc')**——Firestore 會要求建複合索引而整段拋錯
    //   （本專案已踩過一次，2026-08-11 這裡又踩了第二次）。
    //   revenueArchive 一年才 12 筆，直接取回本地排序即可。
    const all = await db.collection('revenueArchive').select('n').get();
    const ids = all.docs.map(d => d.id).filter(x => /^\d{4}-\d{2}$/.test(x)).sort();
    const archId = ids[ids.length - 1] || '';
    if (archId && (!apiId || archId > apiId)) {
      const a = (await db.collection('revenueArchive').doc(archId).get()).data() || {};
      const ar = a.rowsJson ? JSON.parse(a.rowsJson) : null;
      const list = Array.isArray(ar) ? ar : Object.values(ar || {});
      // 產業別只有 openapi 有，用代號補回去（缺了不影響排行，只影響顯示）
      const indBy = {};
      for (const x of rows) { const c = x['公司代號']; if (c) indBy[c] = x['產業別'] || ''; }
      const built = list
        .filter(x => x && /^\d{4}$/.test(String(x.c)) && x.rev > 0 && Number.isFinite(x.yoy))
        .map(x => ({ code: String(x.c), name: x.n || String(x.c), industry: indBy[String(x.c)] || '',
          revenue: Math.round(x.rev), last: Math.round(x.last ?? 0), prevRev: Math.round(x.prev ?? 0),
          yoy: +Number(x.yoy).toFixed(1), mom: +Number(x.mom ?? 0).toFixed(1) }));
      if (built.length >= 800) {
        topYoY = built.filter(yoyOk).sort((a2, b2) => b2.yoy - a2.yoy).slice(0, 20);
        topMoM = built.filter(momOk).sort((a2, b2) => b2.mom - a2.mom).slice(0, 20);
        outMonth = `${archId.slice(0, 4) - 1911}${archId.slice(5, 7)}`;   // 回填成民國格式，維持既有介面
        src = `archive:${archId}`;
        log(`  ℹ 月營收改用歸檔 ${archId}（${built.length} 檔）——openapi 仍停在 ${apiId || '?'}`);
      }
    }
  } catch (e) { log('  ⚠ 月營收取新失敗，沿用 openapi:', e.message); }

  // dataMonth 一律寫西元的「資料所屬月」，讓前端與稽核不必自己換算民國
  await db.collection('revenue').doc('latest').set({
    updatedAt: Date.now(), month: outMonth, dataMonth: toId(outMonth), source: src, topYoY, topMoM,
    baseFloor: BASE_FLOOR,
    // ⚠ 單位換算：TWSE 月營收的單位是**千元**，千元→萬元是 ÷10（不是 ÷1000）。
    //   第一版寫成 /1000 → 顯示「< 10 萬元」，實際門檻是 1,000 萬元，差 100 倍。
    caveat: `已排除去年同月（或上月）營收 < ${(BASE_FLOOR / 10).toLocaleString()} 萬元者——基期趨近於零會讓 YoY 噴出無意義的天文數字。`
      + '仍需留意營建業採**認列時點集中**，單月 YoY 可達數十倍而非實質成長。非投資建議。',
  });

  // ── 逐檔逐月歸檔（2026-08-10 補）────────────────────────────────
  // 先前這裡抓了全市場 1,800+ 檔，算完兩張 20 名排行榜就把原始資料丟掉，
  // `revenue/latest` 每月被覆蓋 → 三年月營收歷史等於零。
  // rows 已經在手上，歸檔不需要再打一次上游。
  // ⚠ `資料年月` 是**民國**（如 "11506"），doc id 要轉西元且用「資料所屬月」，
  //   不是公布月，才與 revenueArchive 的回補結果對得起來。
  const m = String(month);
  if (/^\d{5,6}$/.test(m)) {
    const yr = parseInt(m.slice(0, m.length - 2), 10) + 1911;
    const mo = m.slice(-2);
    const id = `${yr}-${mo}`;
    const arch = rows.filter(x => /^\d{4}$/.test(x['公司代號'] || '')).map(x => ({
      c: x['公司代號'], n: x['公司名稱'],
      rev: Math.round(_f(x['營業收入-當月營收'])),
      prev: Math.round(_f(x['營業收入-上月營收'])),
      last: Math.round(_f(x['營業收入-去年當月營收'])),
      mom: +_f(x['營業收入-上月比較增減(%)']).toFixed(2),
      yoy: +_f(x['營業收入-去年同月增減(%)']).toFixed(2),
      cum: Math.round(_f(x['累計營業收入-當月累計營收'])),
    })).filter(x => x.rev > 0);
    // ⚠**防退化覆蓋**（2026-08-10 當場踩到）：這裡的來源是 openapi t187ap05，
    //   實測 2026-06 只涵蓋 1,347 檔，而 MOPS 彙總表（scripts/backfill-mops-revenue.mjs）
    //   同月有 1,847 檔——openapi 少了 500 檔，而且還落後一個月。
    //   第一版沒有這道閘門，daemon 跑完直接把回補好的厚資料蓋成薄的。
    //   規則：**只准補上或加厚，不准變薄**。
    const prevN = (await db.collection('revenueArchive').doc(id).get()).data()?.n ?? 0;
    if (arch.length < 800) {
      log(`⚠ 月營收歸檔 ${id} 僅 ${arch.length} 檔（<800），不寫入避免污染歷史`);
    } else if (arch.length < prevN) {
      log(`⚠ 月營收歸檔 ${id} 略過：本次 ${arch.length} 檔 < 既有 ${prevN} 檔（openapi 涵蓋較窄，不覆蓋）`);
    } else {
      const j = JSON.stringify(arch);
      await db.collection('revenueArchive').doc(id).set({ month: id, n: arch.length, rowsJson: j, bytes: j.length, at: Date.now() });
      log(`✓ 月營收歸檔 ${id}：${arch.length} 檔 ${(j.length / 1024).toFixed(0)}KB`);
    }
  }
  log(`✓ 月營收(${toId(outMonth) || outMonth}·${src})：YoY 最強 ${topYoY[0]?.name}(+${topYoY[0]?.yoy}%)`);
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
      if (out) probeNumbers('每日分析', out, prompt);
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
//
// 帳本重放（replayLedger / statRows）已抽到 scripts/lib/ledger-replay.mjs，
// 與 compute-analytics.mjs 共用同一份——原本這裡有一份 mjs 副本，後台分析要用時
// 差點再抄第三份。口徑、兩個使用陷阱（全量重放再篩期間／全額超賣不進分母）
// 都寫在那個檔案的檔頭，改口徑時連同 src/lib/portfolio-calc.ts 一起改。

async function publishTradeReviews() {
  const premium = await getPremiumUsers();
  for (const u of premium) {
    const uid = u.id;
    try {
      const td = await db.collection('users').doc(uid).collection('data').doc('trades').get();
      const trades = td.exists ? (td.data().trades || td.data().tradeRecords || []) : [];
      // 2026-08-01：改用帳本重放，不再讀存死的 realizedPnL（那是記錄當下用
      // 手動持倉成本算的，與交易紀錄脫鉤時會給出錯誤的覆盤結論）。
      const { closed, byStock, buyCount, oversoldCount } = replayLedger(trades);
      const sells = statRows(closed); // 全額超賣列 pnl 恆 0，不能進勝率分母/期望值除數
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
      if (out) probeNumbers('每日分析', out, prompt);
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
        // ── 模式感知注入（2026-08-03）──────────────────────────────
        // 舊版是純關鍵字比對：使用者在波段模式問「這檔明天能不能買」，會拿到
        // 隔日沖的數字卻不知道自己看的是別的口徑。改為：
        //   ① 當前模式的技能**一律注入**（不管問題長怎樣）
        //   ② 關鍵字命中他模式時，該技能照樣注入，但**額外附上口徑警告**
        const _mode = await getUserMode(u.id);
        const _M = MODES[_mode], _SK = MODE_SKILL();
        ctx += `\n\n【使用者目前的操作模式】${_M.icon}${_M.label}（${_M.horizon}）${_M.hasModel ? '' : '——⚠本模式尚無經驗證的評分模型，回答時不可給分數或暗示有模型'}\n${_SK[_mode]}`;
        const _crossed = new Set();
        // 規則/稅務類問題 → 附上交易規則知識庫，讓 AI 答得正確不亂編
        if (/稅|交割|T\+?2|漲停|跌停|手續費|開戶|零股|交易時間|成本|股利|證所稅|資本利得|盤後|內線|法規|幾歲|申報|注意股|處置|觀察股|警示|撮合/.test(q.question)) ctx += `\n\n${TRADING_RULES}`;
        if (/漲停|連板|鎖死|飆股|強勢股.*預測|預測.*漲停/.test(q.question)) ctx += `\n\n${LIMITUP_SKILL}`;
        if (/財報|本益比|PE|EPS|每股盈餘|毛利|營益率|淨利率|ROE|淨值|體質|基本面|估值/.test(q.question)) ctx += `\n\n${FIN_SKILL}`;
        if (/倒貨|出貨|獲利了結|散戶接棒|法人.*賣|外資.*賣|主力.*出/.test(q.question)) ctx += `\n\n${DIST_SKILL}`;
        if (/洗盤|洗融資|修正|回檔|主升段|牛市|崩盤|大跌|空頭/.test(q.question)) ctx += `\n\n${WASHOUT_SKILL}`;
        if (/波段|起漲|抄底|超跌|反彈|接刀|RSI|布局|中線|持有幾天|幾日/.test(q.question) && _mode !== 'swing') { ctx += `\n\n${SWING_SKILL}`; _crossed.add('swing'); }
        if (/隔日沖|明開|撿尾盤|明早賣|綜合評分/.test(q.question) && _mode !== 'nextday') { ctx += `\n\n${NEXTDAY_SKILL}`; _crossed.add('nextday'); }
        if (/當沖|三關|盤中.*選|能不能做|今天能|拉回|量能|跟風|自己強|均價線|假突破/.test(q.question)) {
          if (_mode !== 'daytrade') { ctx += `\n\n${DAYTRADE_SKILL}`; _crossed.add('daytrade'); }
          const tg = await buildTriGateLive(q.code);
          if (tg) ctx += `\n\n${tg}`;
        }
        for (const other of _crossed) ctx += `\n\n${crossModeWarning(_mode, other)}`;
        if (/明日|明天|隔日|後市|買|賣|進場|出場|留倉|抱|預測|建議|操作|可以.*嗎|該不該/.test(q.question)) {
          const pred = await buildPredictSkill(q.code);
          if (pred) ctx += `\n\n${pred}`;
        }
        const prompt = `你是台股投資助理，回答時要同時具備下列四種分析師的能力
（使用者 2026-08-29 指定），依問題性質選用，必要時互相對照：
【全球經濟分析師】利率與通膨、匯率、景氣循環位置、主要經濟體政策走向、資金流向。
【股市產業分析師】產業供需與價格週期、公司在產業中的位置、營收獲利結構、評價區間。
【戰略分析師】地緣政治與國際局勢、關稅與出口管制、政策與法規變動、企業競合與布局。
【供應鏈分析師】上中下游傳導路徑、客戶與供應商集中度、產能與交期、替代與轉單風險。
不同角色的看法不一致時要說出來，不要硬湊成單一結論。

⚠ **界線**（四角色與「只依資料回答」的分工，不可混淆）：
· **事實**一律只能來自下方「資料」——股價、成交量、財報數字、法人買賣、
  新聞內容、公司公告。資料沒有的事實就說「目前資料中未提供」，**嚴禁編造**，
  也不可用「一般而言」把猜測講成事實。
· **分析框架與推理**可以用你的一般知識（產業如何運作、升息通常怎麼傳導、
  供應鏈上下游關係），但推論的**起點必須是資料裡的事實**，
  且要說清楚哪部分是資料、哪部分是推論。
· 使用者問到資料涵蓋範圍外的事（例如某項總經數據、未提供的財報細節），
  就直說資料裡沒有，可以說明「若要判斷這件事需要什麼資料」，
  但不要憑空給數字或結論。

**只能根據下列「資料」回答**使用者問題，資料沒提到的就回「目前資料中未提供」，嚴禁編造數據或臆測。用繁體中文簡潔回答(120-220字)，結尾加「※ 依第二大腦資料整理，非投資建議」。${STRICT_RULE.replace('【數據】', '【資料】')}\n\n使用者問題：${q.question}\n\n【資料】\n${ctx}`;
        let answer = await askOllama(prompt, { priority: 10 }); // 互動式優先插隊
        // 數字校驗（使用者 2026-08-29 指定的防幻想約束 A）：
        //   回答裡對不上來源資料的數字＝編造的。不刪除整段回答
        //   （其餘內容可能有用），但要**在答案裡明說**哪些數字查不到，
        //   否則使用者會照著假數字做決定。
        if (answer) {
          const bad = unverifiedNumbers(answer, prompt);
          if (bad.length) {
            answer += `\n\n⚠ 下列數字未能在提供的資料中查證，請勿採信：${bad.slice(0, 5).join('、')}`;
            log(`  ⚠ 問AI 數字校驗未過（${q.id}）：${bad.slice(0, 4).join('、')}`);
          }
        }
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
  await db.collection('marketHealth').doc('latest').set({ dataDate: await currentDataDate(), updatedAt: Date.now(), date: isoDate(taipei()), health, mood, up, down, flat, limitUp, limitDown, upRatio: +upRatio.toFixed(1), newHigh });
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
      // ⚠原本是 `< 2 就跳過`（相關係數需要配對）——但 computeStressTest 也寫同一份
      //   portfolioRisk 文件，導致**只持有 1 檔的會員**只拿到 stress 那一半欄位，
      //   前端 avgCorrelation.toFixed() 直接炸 → 投資組合整頁全白（2026-08-06 事故）。
      //   改為 1 檔也照算：集中度/族群本來就算得出來，相關係數則明確寫 null。
      const holdings = hd.exists ? (hd.data().holdings || []) : []; if (!holdings.length) continue;
      const codes = [...new Set(holdings.map(h => h.code))];
      const docs = await db.getAll(...codes.map(c => db.collection('stockHistory').doc(c))).catch(() => []);
      const rets = {};
      for (const d of docs) { if (!d.exists) continue; const bars = d.data().bars || []; if (bars.length < 61) continue; const c = bars.slice(-61).map(b => b.c); const r = []; for (let i = 1; i < c.length; i++) if (c[i - 1] > 0) r.push((c[i] - c[i - 1]) / c[i - 1]); rets[d.id] = r; }
      const cc = Object.keys(rets); let sum = 0, np = 0, maxPair = { corr: -1 };
      for (let i = 0; i < cc.length; i++) for (let j = i + 1; j < cc.length; j++) { const co = _pearson(rets[cc[i]], rets[cc[j]]); if (co != null) { sum += co; np++; if (co > maxPair.corr) maxPair = { corr: co, a: cc[i], b: cc[j] }; } }
      const avgCorr = np ? sum / np : null;   // 無配對（單一持股）→ null，不可假裝成 0
      const sectorVal = {}; let tot = 0;
      for (const h of holdings) { const ind = industryOf(h.code, h.name); const v = h.buyPrice * h.quantity * 1000; sectorVal[ind] = (sectorVal[ind] || 0) + v; tot += v; }
      const hhi = tot > 0 ? Object.values(sectorVal).reduce((s, v) => s + (v / tot) ** 2, 0) : 0;
      const topSec = Object.entries(sectorVal).sort((a, b) => b[1] - a[1])[0];
      // ⚠**必須 merge**：computeStressTest 寫同一份文件的 β/壓力測試欄位，
      //   舊版無 merge 的 set() 會把它們整個抹掉（誰後跑誰贏），文件形狀因此在
      //   兩種不相容的 schema 之間跳動——這正是前端崩潰的另一半原因。
      await db.collection('users').doc(u.id).collection('data').doc('portfolioRisk').set({
        updatedAt: Date.now(), holdings: codes.length,
        avgCorrelation: avgCorr == null ? null : +avgCorr.toFixed(2),
        diversification: avgCorr == null ? '單一持股，無相關性可比'
          : avgCorr < 0.3 ? '良好（持股連動低）' : avgCorr < 0.6 ? '中等' : '偏低（持股高度連動，分散效果差）',
        concentrationHHI: +hhi.toFixed(2),
        concentration: hhi > 0.5 ? '過度集中' : hhi > 0.3 ? '略集中' : '分散',
        topSector: topSec ? { name: topSec[0], pct: +(topSec[1] / tot * 100).toFixed(0) } : null,
        highestPair: maxPair.a ? { a: maxPair.a, b: maxPair.b, corr: +maxPair.corr.toFixed(2) } : null,
        rebalanceHint: hhi > 0.4 || (avgCorr != null && avgCorr > 0.6)
          ? `建議降低${topSec ? topSec[0] : '主要族群'}比重、加入低相關標的以分散風險` : '分散度尚可，維持紀律',
      }, { merge: true });
      log(`  ✓ 投組風險 ${u.id}（平均相關 ${avgCorr == null ? 'n/a(單一持股)' : avgCorr.toFixed(2)}、集中HHI ${hhi.toFixed(2)}）`);
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
// ── 月營收歸檔「加厚」（2026-08-10）──────────────────────────────────
// computeRevenue 走 openapi t187ap05，實測只涵蓋 ~1,350 檔且落後一個月。
// MOPS 彙總表（靜態 HTML）同月有 ~1,847 檔，所以每天回頭把最近 2 個月補厚。
// 兩邊都有防退化閘門（只准加厚不准變薄），重複跑是冪等的。
async function thickenRevenueArchive() {
  try { await backfillMopsRevenue(2, (m) => log(`  ${m}`)); }
  catch (e) { log(`⚠ 月營收加厚失敗：${e.message}`); }
}

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

  // ── 週歸檔（2026-08-10 補）──────────────────────────────────────
  // 上面那行是 `{ merge: false }` **整份覆蓋**，歷史深度只有「本週＋上週」兩點。
  // 集保是每週一次的資料，一年只有 52 個觀測點，覆蓋掉等於永久失去。
  // ⚠ 而且**補不回來**：openapi 1-5 忽略 date 參數恆回最新週；官網歷史下拉只留
  //   51 週且是逐檔查詢（2,000 檔 × 51 週）。這條序列的起點就是第一次歸檔那天，
  //   斷一週就永遠缺一週——不要讓它斷。
  // rows 已在手上（2.3MB），歸檔不再打上游。存全部 15 個分級而非只存千張比例，
  // 否則日後想改用別的分級口徑就沒有原料。
  try {
    const dist = {};
    for (const x of rows) {
      const c = String(x['證券代號'] || '').trim().replace(/^0+/, '');
      if (!/^\d{4}$/.test(c)) continue;
      const lv = parseInt(String(x['持股分級'] || ''), 10);
      if (!(lv >= 1 && lv <= 15)) continue;          // 16/17 是合計列，計入會重複
      const e = dist[c] || (dist[c] = { r: new Array(15).fill(0), p: 0 });
      e.r[lv - 1] = +_f(x['占集保庫存數比例%']).toFixed(2);
      e.p += Math.round(_f(x['人數']));
    }
    const nCodes = Object.keys(dist).length;
    const isoWeek = /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : null;
    if (isoWeek && nCodes >= 800) {
      const j = JSON.stringify(dist);
      await db.collection('tdccArchive').doc(isoWeek).set({ date: isoWeek, n: nCodes, distJson: j, bytes: j.length, at: Date.now() });
      log(`✓ 集保週歸檔 ${isoWeek}：${nCodes} 檔 × 15 分級 ${(j.length / 1024).toFixed(0)}KB`);
    } else {
      log(`⚠ 集保週歸檔略過：日期 "${date}"、解析 ${nCodes} 檔`);
    }
  } catch (e) { log(`⚠ 集保週歸檔失敗：${e.message}`); }

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
      // 🔄 換股意圖（2026-08-17 使用者需求）：偵測「想換股」→ 直接給即時推薦，
      // 不走 LLM 篩選（換股不是篩選條件，LLM 會硬湊）。推薦基礎＝實證綜合評分
      // 分級排行（chipPicks.graded·兩窗回測權重）× 即時價量，排除漲停/準漲停；
      // 換出側只「檢視」使用者持股今日最弱者，不下指令。
      if (/換股|換掉|想換|替換|轉倉|換一檔|換別的|換其他|賣.{0,6}買什麼/.test(d.query)) {
        try {
          const [cpSnap, snapQ] = await Promise.all([
            db.collection('chipPicks').doc('latest').get(),
            readSnapshotQuotes(),
          ]);
          const graded = cpSnap.data()?.graded || [];
          const quotes = snapQ?.quotes || {};
          const recs = [];
          for (const g of graded) {
            const q = quotes[g.code];
            if (!q || !(q.price > 0)) continue;
            if ((q.changePercent ?? 0) > 8.5) continue;   // 漲停/準漲停收盤買不到
            // graded 欄位：tier(S/A/B分級)+netWin(明開賣淨勝率%)+danger(倒貨旗標)
            if (g.danger) continue;   // 倒貨旗標者不推
            recs.push({ code: g.code, name: g.name || q.name || '', score: g.netWin ?? null,
              signal: g.tier === 'S' ? 'STRONG_BUY' : 'BUY', rs: null, yield: null,
              tierLabel: g.tierLabel || g.tier || null });
            if (recs.length >= 8) break;
          }
          let weakTxt = '';
          try {
            const hd = (await db.collection('users').doc(u.id).collection('data').doc('holdings').get()).data();
            const hs = (hd?.holdings || []).map(h => ({ ...h, chg: quotes[h.code]?.changePercent ?? null }))
              .filter(h => h.chg != null).sort((a, b) => a.chg - b.chg).slice(0, 2);
            if (hs.length) weakTxt = `換出側檢視（你今日最弱的持股，僅供比對非指令）：${hs.map(h => `${h.name}(${h.code}) ${h.chg >= 0 ? '+' : ''}${h.chg}%`).join('、')}。`;
          } catch { /* 無持股則略 */ }
          const twN = taipei(); const mN = twN.getHours() * 60 + twN.getMinutes();
          const live = isTradingDay(twN) && mN >= 9 * 60 && mN < 13 * 60 + 30;
          await ref.set({
            query: d.query, status: 'done', at: Date.now(), answeredAt: Date.now(),
            interpreted: '偵測到「換股」意圖 → 即時換股推薦（不經篩選條件解析）',
            note: `依據：法人籌碼分級排行（S/A級·兩窗實證）× ${live ? '盤中即時' : '最近收盤'}價量；「評分」欄＝該分級歷史明開賣淨勝率%；已排除今日漲停/準漲停（收盤買不到）與倒貨旗標股。${weakTxt}提醒：請以「決策工作台」逐檔比對籌碼判讀與勝率後再決定；評分是排序與避開工具，非進場保證。非投資建議。`,
            results: recs, count: recs.length,
          });
          log(`  🔄 NL換股推薦 ${u.id}「${String(d.query).slice(0, 30)}」→ ${recs.length} 檔`);
          continue;
        } catch (e) { log('  ⚠ 換股推薦失敗，退回一般解析：', (e.message || '').slice(0, 50)); }
      }
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
if (!ONESHOT) _recordDaemonBuild();   // 記錄本次啟動載入的程式碼版本
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
if (!ONESHOT) { marketSnapshotLoop(); hotQuoteLoop(); }

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
// ════════════════════════════════════════════════════════════
// 興櫃（ESB, Emerging Stock Board）——2026-08-19 使用者實報 7924 TLC-KY 搜不到
//
// ⚠ 刻意**不併入 loadCodes() 的宇宙**，寫成獨立的 marketSnapshot/emerging：
//   興櫃與上市櫃的市場語意不同，混進主宇宙會污染所有選股與榜單——
//   · **沒有漲跌停**：+9.9% 只是正常成交，不是漲停。混入 isLimitUp 濾網
//     （4 碼且非 00 開頭，7924 完全符合）就會產生假漲停。
//   · 撮合方式是議價，參考價是**前一日均價**而非昨收，「漲跌幅」語意不同。
//   · 流動性極低，量價指標（量增倍數、周轉率）拿上市櫃的門檻套用毫無意義。
//   ⇒ 只供**搜尋與個股查看**，不進任何推薦/排行/漲停榜。
async function computeEmerging() {
  const r = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_esb_latest_statistics', {
    headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`ESB status ${r.status}`);
  const arr = await r.json();
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('ESB 回空');
  const out = {};
  let dataDate = '';
  for (const x of arr) {
    const code = String(x.SecuritiesCompanyCode || '').trim();
    if (!/^\d{4}$/.test(code)) continue;
    if (!dataDate && x.Date) { const y = rocToYmd(String(x.Date)); if (y) dataDate = `${y.slice(0,4)}-${y.slice(4,6)}-${y.slice(6,8)}`; }
    // 參考價＝前一日均價（興櫃沒有「昨收」）。成交價缺席時退回均價，再退回參考價。
    const prev = _num(x.PreviousAveragePrice);
    const last = _num(x.LatestPrice) || _num(x.Average) || prev;
    if (!(last > 0)) continue;
    const chg = prev > 0 ? +(last - prev).toFixed(2) : 0;
    out[code] = {
      code, name: String(x.CompanyName || '').trim() || code,
      price: last, prev, change: chg,
      changePercent: prev > 0 ? +((chg / prev) * 100).toFixed(2) : 0,
      high: _num(x.Highest), low: _num(x.Lowest), avg: _num(x.Average),
      volume: _num(x.TransactionVolume),          // 股
      bid: _num(x.BuyingPrice), ask: _num(x.SellingPrice),
      market: 'esb',
    };
  }
  const n = Object.keys(out).length;
  if (n === 0) throw new Error('ESB 解析後 0 檔');
  await db.collection('marketSnapshot').doc('emerging').set({
    quotesJson: JSON.stringify(out), n, date: dataDate || isoDate(taipei()),
    updatedAt: Date.now(),
  });
  log(`✓ 興櫃 ${n} 檔（資料日 ${dataDate || '?'}）`);
}

async function emergingLoop() {
  for (;;) {
    try { await computeEmerging(); } catch (e) { log('✖ 興櫃:', (e.message || '').slice(0, 60)); }
    const tw = taipei(); const mins = tw.getHours() * 60 + tw.getMinutes();
    // 興櫃交易 09:00–15:00（比集中市場晚收）。盤中 3 分鐘、其餘 30 分鐘。
    const open = isTradingDay(tw) && mins >= 9 * 60 && mins < 15 * 60;
    await sleep(open ? 180000 : 1800000);
  }
}
if (!ONESHOT) emergingLoop();

// ════════════════════════════════════════════════════════════
// 軋空候選（2026-08-26 使用者需求：列出有軋空條件的股票，如台虹）
//
// ⚠ 這條規則是**實測校準**的，不是照抄坊間說法。240 個交易日、169,878 筆
//   事件（價>10、20日均量≥500張）回測，關鍵發現與直覺相反：
//   · 「券資比越高越會軋」是**錯的**。疊在漲≥5% 上：
//       純動能對照(漲≥5%)      5日 +2.03%  勝率50%
//       券資比 10~15%          5日 +3.72%  勝率57%  三段[2.75/4.59/3.27] ← 最佳
//       券資比 10~20%          5日 +3.48%  勝率56%
//       券資比 ≥15%            5日 +2.09%  勝率51%
//       券資比 ≥20%            5日 +1.46%  勝率49%  ← 反而低於純動能
//     推測：極高券資比多半是空方看對（基本面轉壞）或可轉債/避險空單，不會被軋。
//   · 單看券資比≥30%（不疊漲幅）前後半不一致(1.54 vs -0.41)，不可用。
//   · 「回補天數(days-to-cover)≥3」在台股樣本幾乎為 0（融券量相對成交量太小），
//     這個美股常用指標在台股不適用，已捨棄。
//   ⇒ 定版：漲≥5% × 券資比 10~20%，其中 10~15% 標 ⭐⭐、15~20% 標 ⭐。
//     邊際效益僅約 +1.7pp（相對純動能），**這是傾向不是預測**，文案不可誇大。
//
// PIT 誠實：融資券當日 21:45 才公布 ⇒ 券資比一律用**最近一個已歸檔日**（t-1），
// 漲幅用今日（盤中即時價）。兩者資料日都要標出來，不可混為一談。
const SQUEEZE_SKILL = `【軋空候選·實測校準版(本站回測·非投資建議)】
定版條件：當日漲≥5% × 券資比10~20% × 20日均量≥500張 × 價>10。
實測(240日/16.9萬筆)：5日淨均 +3.48%、勝率56%；其中券資比10~15%最強(+3.72%/57%)。
純動能對照(僅漲≥5%)為 +2.03%/50% ⇒ 券資比的邊際貢獻約 +1.5~1.7pp，是傾向非預測。
反直覺：券資比≥20% 反而掉到 +1.46%(低於純動能)——極高券資比多為空方看對或避險空單。
台股不適用 days-to-cover(融券量相對成交量過小，樣本近乎 0)。
券資比為 t-1(資券21:45才公布)，漲幅為當日。`;

// ── 隔日軋空推薦（每日 08:00：美股昨夜已收，資訊最完整）──────────────
// 流程：模型條件篩出候選 → 逐檔比對「當日或 2 日內」新聞是否有實質利多 →
//       有利多者標為主力推薦。
//
// ⚠ 新聞比對的誠實界線：RSS 標題不是基本面判讀，**只能當加權不能當理由**。
//   本站規則（CLAUDE.md）：不要給資料欄位捏造預設值——找不到利多就寫「無」，
//   不可用「市場氣氛佳」這類空話填充。利多關鍵詞採白名單，且要求標題同時
//   出現股名/代號，避免同名雜訊。
// 基本面/事件型利多（會改變公司價值的事），刻意**不含**「漲停/飆/創新高」這類
// 純價格描述——那是結果不是原因，拿它當利多等於用結果解釋結果（實案：台虹當日
// 新聞清一色「連兩根漲停飆上天價」，若計為利多會自我循環）。
const BULLISH_KW = ['漲價', '調漲', '報價上揚', '大單', '訂單', '接單', '出貨', '擴產', '產能',
  '法說', '營收創', '獲利', '轉盈', '認證', '通過', '合作', '簽約',
  '得標', '併購', '取得', '上調', '調升', '目標價', '評等', '新產品', '量產', '投片', '打入'];
// ⚠ 2026-08-26 修正：原本把「漲停/飆/爆量」一律硬剔，**過度殺傷**。
//   實案：今周刊〈台虹做什麼的？漲停鎖死1.5萬張搶買，原來和輝達也有關！看懂
//   PTFE題材多猛〉——標題同時有「漲停鎖死」與「和輝達有關/PTFE題材」，
//   舊規則會因為前者剔掉整則，於是**真正的催化劑被自己的濾網丟掉**。
//   ⇒ 只硬剔「機器自動生成的價格速報」（那是真的沒有資訊），其餘一律送進
//     AI，由它依「價格描述不算利多」的規則判斷。判別力放在 AI 不放在正則。
const MACHINE_NEWS = /盤中速報|收盤速報|漲速|自動生成|快訊[:：]?\s*股價/;
const BEARISH_KW = ['下修', '調降', '減產', '砍單', '虧損', '衰退', '認列', '罰款', '召回', '停產', '訴訟'];

// 鉅亨網個股新聞（**有真正的內文**）。Google News RSS 走不通——它的連結是 JS
// 轉址、伺服器端抓回來只有 11 個字「Google News」，且 article id 已加密無法解出
// 原始網址（2026-08-26 實測兩條路都試過）。鉅亨提供 JSON API 與 128~900 字內文，
// 是台灣主要財經媒體，適合當「讀內容再判斷」的來源。
async function fetchCnyesNews(keyword, cap = 6) {
  try {
    const url = `https://api.cnyes.com/media/api/v1/search/news?q=${encodeURIComponent(keyword)}&limit=${cap * 2}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return [];
    const j = await r.json();
    const raw = j?.items?.data || j?.data?.items || j?.items || [];
    const arr = Array.isArray(raw) ? raw : (raw.data || []);
    const strip = t => String(t || '').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
    return arr.slice(0, cap).map(it => ({
      id: it.newsId || 0,
      title: strip(it.title || it.name),
      content: strip(it.content || it.summary || it.abstract).slice(0, 900),
      at: it.publishAt ? it.publishAt * 1000 : 0,
      link: it.newsId ? `https://news.cnyes.com/news/id/${it.newsId}` : '',
    })).filter(x => x.title);
  } catch { return []; }
}

// 鉅亨的**內文只在網頁上**（2026-08-27 三條路都實測）：
//   api/v1/news/{id}     → HTTP 200 但 items 是空物件（0 字）
//   api/v1/newspage/{id} → 404
//   news.cnyes.com/news/id/{id} → <article> 有完整內文（實測 1,071 字）✓
// 搜尋 API 的 content 欄只有 20~160 字摘要，達不到 hasBody 的 60 字門檻 ⇒
// 08-27 的 12 檔判別有 11 檔 basis=title，等於沒讀新聞就下多空判斷。
async function fetchCnyesBody(newsId) {
  try {
    const r = await fetch(`https://news.cnyes.com/news/id/${newsId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return '';
    const m = (await r.text()).match(/<article[\s\S]*?<\/article>/);
    if (!m) return '';
    return m[0]
      .replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 1600);
  } catch { return ''; }
}

// ── 跨站補內文（使用者指示 2026-08-27）────────────────────────────────
// 「新聞無法看到內文，就找其它網站相同類似標題來識讀內文，不可用無法取得內文來塞」
//
// 為什麼需要：鉅亨對冷門股常常只有「盤中速報」機器稿（實測前鼎 20 則全是），
// Google News 覆蓋廣但**只給標題**（連結是加密轉址，內文抓不到，兩條路都試過）。
// 於是拿 Google News 的標題去搜同一則報導在**別的媒體**的版本，那邊抓得到內文。
// 實測：「前鼎 光通訊 訂單」→ 工商時報 724 字（矽光子/800G 送樣）——正是鉅亨
// 完全沒有的題材；「弘塑、辛耘接單看到2030年」→ 自由時報 1,012 字。
const ALT_NEWS_DOMAINS = /(^|\.)(ltn\.com\.tw|udn\.com|ctee\.com\.tw|technews\.tw|moneydj\.com|cnyes\.com|wealth\.com\.tw|businesstoday\.com\.tw|chinatimes\.com|nownews\.com|ettoday\.net)$/i;

const _stripHtml = h => h
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/gi, ' ')
  .replace(/\s+/g, ' ').trim();

function extractArticleBody(html) {
  for (const re of [/<article[\s\S]*?<\/article>/i, /<div[^>]+class="[^"]*(?:article|content|story|post)[^"]*"[\s\S]*?<\/div>/i]) {
    const m = html.match(re);
    if (m) { const t = _stripHtml(m[0]); if (t.length >= 200) return t; }
  }
  // 退而求其次：把夠長的 <p> 串起來（純導覽列的 <p> 通常很短，會被濾掉）
  return [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => _stripHtml(m[1])).filter(t => t.length > 25).join(' ').slice(0, 2200);
}

// ── 新聞來源優先序（使用者指定 2026-08-28）────────────────────────────
//   ① 工商時報・經濟日報（優先）② Yahoo／Google／MSN（輔助）③ 其他財經網
// 實測（2026-08-28）：
//   · 經濟日報 money.udn.com/search/result/1001/{kw} 可直接搜尋，穩定、有內文
//     有日期——昇達科抓到 1,306 字「馬斯克太空 AI 布局…昇達科提前迎大單」。
//   · 工商時報 www.ctee.com.tw 的 /search 與 /wp-json 都回 **403**（擋 bot），
//     但**文章頁抓得到**（實測 724 字），故改用 DDG `site:ctee.com.tw` 定位。
//   · MSN 的搜尋路徑回 **404**、內容重度 JS 與個人化 ⇒ **不納入**，不假裝它能用。
// ── 當前市場主旋律（使用者指定 2026-08-28）──────────────────────────
// 用途有兩層：① **選稿**——同樣抓到 5 則，優先把命中主旋律的餵給 AI；
//             ② **判別**——prompt 要求 AI 對這些題材追出傳導路徑到這一檔。
// 這不是「看到關鍵字就利多」：命中只代表**值得細看**，是否構成利多仍由內文決定
// （例如「戰爭」對航運是運價利多、對觀光是利空，方向必須從內文讀出來）。
const HOT_THEMES = [
  '戰爭', '地緣', '關稅', '制裁', '石油', '油價', 'OPEC', '通膨', '通澎', '升息', '降息', 'CPI', '聯準會', 'Fed',
  'AI', '人工智慧', '算力', '資料中心', '半導體', '晶圓', '先進封裝', 'CoWoS', 'HBM',
  '光通訊', 'CPO', '矽光子', '記憶體', 'DRAM', 'NAND', '電力', '電網', '儲能', '重電',
  '機器人', '人形機器人', '無人機', '太空', '衛星', '低軌衛星', 'LEO',
];
const HOT_PEOPLE = ['川普', 'Trump', '馬斯克', 'Musk', '黃仁勳', '黃仁勛', 'Huang', '蘇姿丰', 'Su', '鮑爾', 'Powell'];
const _HOT_RE = new RegExp(`(${[...HOT_THEMES, ...HOT_PEOPLE].join('|')})`, 'i');
/** 一則新聞命中哪些主旋律（去重、最多 6 個） */
function hotHits(text) {
  const t = String(text || '');
  return [...new Set([...HOT_THEMES, ...HOT_PEOPLE].filter(k => t.includes(k)))].slice(0, 6);
}

const _NEWS_NOISE = /本文共\d+字|(?:',\s*'\s*)+|加入為 Google 偏好來源|另開新視窗|將 Yahoo (?:加入|設為)[^。]{0,30}|延伸閱讀|更多內容/g;
const _cleanBody = t => String(t || '').replace(_NEWS_NOISE, ' ').replace(/\s+/g, ' ').trim();

// 沒有發布時間就無法判斷時效，而「兩個月前的舊文被當成今天的利多」是最糟的錯
// （實測前鼎在經濟日報命中的兩篇都是 6 月的）。四種寫法依序試。
function extractPublishedAt(html) {
  const pats = [
    /"datePublished"\s*:\s*"([^"]{10,40})"/,
    /property="article:published_time"\s+content="([^"]{10,40})"/,
    /<time[^>]+datetime="([^"]{10,40})"/,
    /(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/,
  ];
  for (const re of pats) {
    const m = html.match(re);
    if (!m) continue;
    const v = m.length > 2 ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+08:00` : m[1];
    const t = Date.parse(v);
    if (Number.isFinite(t) && t > 0) return t;
  }
  return 0;
}

// ⛔ **論壇/討論區一律不採用**（使用者 2026-09-01 明令）。
//   理由：那是網友對話不是事實來源，且充斥推測、情緒與帶風向。
//   判別的用途是預期市場反應，不是收集意見——把論壇當內文會直接污染判別。
//   ⚠ 跨站找內文那條路（以標題搜尋）最容易撈到論壇，必須在**入口**擋掉，
//     不能只靠提示詞叫模型忽略（規則只寫在提示裡就會失效，今天已證實多次）。
const FORUM_DENY = /ptt\.cc|pttweb|mobile01|cmoney\.tw\/forum|wantgoo\.com\/stock\/\d+\/forum|dcard|reddit|facebook|threads\.net|xuite|pixnet\/blog|blogspot|forum|bbs|discuss|\/board\//i;
const isForumUrl = (u) => FORUM_DENY.test(String(u || ''));

const _NEWS_UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36', 'Accept-Language': 'zh-TW,zh;q=0.9' };

async function fetchArticleAt(url, name) {
  try {
    const r = await fetch(url, { headers: _NEWS_UA, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    const html = await r.text();
    const body = _cleanBody(extractArticleBody(html));
    // 品質閘門：抽出來的字必須含公司名，否則多半抓到側邊欄的標題湯
    if (body.length < 200 || (name && !body.includes(name))) return null;
    const title = _cleanBody((html.match(/<title>([^<]{4,120})</) || [])[1] || '').split(/[|｜-]/)[0].trim();
    return { title: title || `${name} 相關報導`, body: body.slice(0, 1600), at: extractPublishedAt(html), url, host: new URL(url).hostname.replace(/^www\./, '') };
  } catch { return null; }
}

/** ① 經濟日報（優先來源·可直接搜尋） */
async function fetchUdnMoney(keyword, cap = 3) {
  const out = [];
  try {
    const r = await fetch(`https://money.udn.com/search/result/1001/${encodeURIComponent(keyword)}`, { headers: _NEWS_UA, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return out;
    const links = [...new Set([...(await r.text()).matchAll(/https:\/\/money\.udn\.com\/money\/story\/\d+\/\d+/g)].map(m => m[0]))];
    // ⚠ 先多抓幾篇再**依發布時間由新到舊**取 cap 篇：搜尋結果不保證依日期排序，
    //   直接取前 N 篇會拿到幾個月前的舊文（實測前鼎命中的兩篇都是 6 月的），
    //   而舊聞會被時效過濾掉，等於白抓。
    const got = [];
    for (const u of links.slice(0, cap + 3)) {
      await sleep(400);
      const a = await fetchArticleAt(u, keyword);
      if (a) got.push(a);
    }
    got.sort((x, y) => (y.at || 0) - (x.at || 0));
    out.push(...got.slice(0, cap));
  } catch { /* 單一來源失敗不擋 */ }
  return out;
}

/** ① 工商時報（優先來源·站內搜尋擋 bot，改由 DDG 定位文章頁） */
async function fetchCtee(keyword, cap = 2) {
  const out = [];
  try {
    const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(`site:ctee.com.tw ${keyword}`)}`, { headers: _NEWS_UA, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return out;
    const links = [...new Set([...(await r.text()).matchAll(/uddg=([^&"]+)/g)]
      .map(m => { try { return decodeURIComponent(m[1]); } catch { return ''; } })
      .filter(u => /ctee\.com\.tw\/(news|newspaper)\//.test(u)))];
    const got = [];
    for (const u of links.slice(0, cap + 2)) {
      await sleep(400);
      const a = await fetchArticleAt(u, keyword);
      if (a) got.push(a);
    }
    got.sort((x, y) => (y.at || 0) - (x.at || 0));   // 同上：新的優先
    out.push(...got.slice(0, cap));
  } catch { /* DDG 被擋就算了，經濟日報那條仍在 */ }
  return out;
}

// Yahoo 逐檔新聞頁——跨站補內文的**主力**（2026-08-27 實測後改為優先）。
// 為什麼不是用搜尋引擎當主力：DuckDuckGo 在連續查詢後會直接回 0 筆
// （實測同一組查詢前一分鐘還有結果、之後全空），把判別品質綁在會擋機器人的
// 第三方搜尋上並不可靠。Yahoo 這支是**per-stock 端點**，不需要搜尋，
// 冷門股也有（實測前鼎 34 篇、金居 40 篇、亞泰金屬 40 篇，皆含實質內容）。
const _YH_BOILER = /加入為 Google 偏好來源|另開新視窗|將 Yahoo (?:加入|設為)[^。]{0,30}|Yahoo 奇摩股市|延伸閱讀|更多內容|文章.{0,4}來源/g;

async function fetchYahooStockBodies(code, name, cap = 2) {
  if (!/^\d{4,6}[A-Z]?$/.test(String(code || ''))) return [];
  const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' };
  let links = [];
  if (breakerOpen('yahoo-news')) return [];   // 熔斷冷卻中（見 fetchYahoo1m 上方說明）
  for (const sfx of ['TW', 'TWO']) {
    try {
      const r = await fetch(`https://tw.stock.yahoo.com/quote/${code}.${sfx}/news`, { headers: UA, signal: AbortSignal.timeout(12000) });
      breakerOk('yahoo-news');   // 有 HTTP 回應＝host 可達；!ok 是該檔無頁，屬 miss
      if (!r.ok) continue;
      const t = await r.text();
      // 去重要把 query string 砍掉——同一篇會以帶參數/不帶參數兩種形式出現
      links = [...new Set([...t.matchAll(/https:\/\/tw\.stock\.yahoo\.com\/news\/[^"'\\ ]{20,}/g)]
        .map(m => m[0].split('?')[0]))];
      if (links.length) break;
    } catch (e) { breakerFail('yahoo-news', e); /* 換另一個後綴 */ }
    await sleep(300);
  }
  if (!links.length) return [];
  // 題材稿優先於【公告】：公告有價值（營收/財報）但題材才解釋隔日走勢
  links.sort((a, b) => (/%E5%85%AC%E5%91%8A/.test(a) ? 1 : 0) - (/%E5%85%AC%E5%91%8A/.test(b) ? 1 : 0));
  const out = [];
  // 2026-09-17：多抓幾篇再**依日期由新到舊**取 cap 篇（與經濟日報同一套做法）。
  //   舊版取前 cap 篇：題材稿排前面但可能是幾週前的，近兩日那篇被擠掉 ⇒ 判別落入
  //   「內文皆逾期、近兩日只有標題」的資訊不足（反查 249 筆的主因之一）。
  for (const l of links) {
    if (out.length >= cap + 3) break;
    try {
      await sleep(400);
      const r = await fetch(l, { headers: UA, signal: AbortSignal.timeout(12000) });
      if (!r.ok) continue;
      const html = await r.text();
      const m = html.match(/<article[\s\S]*?<\/article>/i);
      if (!m) continue;
      const body = _stripHtml(m[0]).replace(_YH_BOILER, ' ').replace(/\s+/g, ' ').trim();
      if (body.length < 200 || (name && !body.includes(name))) continue;
      let title = '';
      try { title = decodeURIComponent(l.split('/news/')[1] || '').replace(/-\d{6,}.*$/, '').replace(/-/g, ' ').trim(); } catch { /* slug 解碼失敗就留空 */ }
      // 發布日期：Yahoo 文章頁是 SPA、無 <time> 標籤，但 <article> 內文開頭
      // 有「2026年8月26日週三 下午5:43」。取 article 區塊內**第一個**中文日期
      // （後面的可能是相關新聞）。解析不到就留 0 → 上層 bodyGeneric 標時效不明。
      // 2026-09-01 實測缺日期的代價：3086/3540 的 4 月面額變更公告被當 0 日前
      // 新聞餵進判別（at 被捏造成 Date.now()，捏造預設值 A 族）。
      let at = 0;
      const dm = body.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
      if (dm) {
        const ts = Date.UTC(+dm[1], +dm[2] - 1, +dm[3]) - 8 * 3600000;   // 台北該日 00:00
        // 未來日期＝解析錯（撞到年報預告等），照樣不填
        if (ts > Date.UTC(2020, 0, 1) && ts < Date.now() + 86400000) at = ts;
      }
      out.push({ title: title || `${name} 相關報導`, body: body.slice(0, 1600), host: 'tw.stock.yahoo.com', url: l, at });
    } catch { /* 換下一篇 */ }
  }
  out.sort((a, b) => (b.at || 0) - (a.at || 0));   // 缺日期（at=0）排最後
  return out.slice(0, cap);
}

// name 是品質閘門：抽出來的字裡**必須出現公司名**，否則多半抓到的是側邊欄
// 導覽連結（實測鉅亨頁面就會給出 610 字的標題湯，看起來很像內文）。
async function fetchBodyByTitle(title, name) {
  const q = String(title || '').replace(/[｜|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!q) return null;
  let urls = [];
  try {
    const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return null;
    const t = await r.text();
    urls = [...new Set([...t.matchAll(/uddg=([^&"]+)/g)].map(m => { try { return decodeURIComponent(m[1]); } catch { return ''; } })
      .filter(u => { try { return ALT_NEWS_DOMAINS.test(new URL(u).hostname); } catch { return false; } }))];
    // ⛔ 論壇/討論區一律剔除（使用者 2026-09-01 明令）——網友對話不是事實來源，
    //    且充斥推測與帶風向。必須在**入口**擋，不能只靠提示詞叫模型忽略。
    urls = urls.filter(u => !isForumUrl(u));
  } catch { return null; }
  for (const u of urls.slice(0, 3)) {
    try {
      await sleep(400);
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' }, signal: AbortSignal.timeout(12000) });
      if (!r.ok) continue;
      const body = extractArticleBody(await r.text());
      if (body.length >= 200 && (!name || body.includes(name))) {
        return { body: body.slice(0, 1600), host: new URL(u).hostname.replace(/^www\./, ''), url: u };
      }
    } catch { /* 換下一個 */ }
  }
  return null;
}

// ── 次交易日開盤前 1 小時：讀新聞**內文**，由 AI 判別利多與否 ────────────
// 使用者指定（2026-08-26）：次日開盤前 1 小時核對國際新聞內容，需要仔細閱讀
// 內容並經 AI 判別是否利多，**每一檔都要出判別提示**（不是只標記有利多的）。
//
// 誠實界線：
//   · 判別依據一律標明是「內文」還是「僅標題」——抓不到內文時不可假裝讀過。
//   · 盤中速報/漲停飆漲這類**價格報導不是利多**（結果不能拿來解釋原因），
//     prompt 明講，並在程式端再擋一次。
//   · AI 無法判定就回「中性/資訊不足」，不可為了湊出推薦而美化。
// 多來源新聞彙整（2026-08-26 使用者實例後補）：
//   鉅亨 API  → 有內文，但**覆蓋不足**：實測台虹當日 5 則全是盤中速報，
//               PTFE/輝達 這個真正的題材一則都沒有 ⇒ 單一來源＝系統性盲點。
//   Google News → 覆蓋廣（各媒體都收），但**只拿得到標題**（連結是 JS 轉址、
//               id 已加密，內文抓不到，兩條路都實測過）。
//   ⇒ 兩者合併，並據實標示每一則是「有內文」還是「僅標題」。
// 單檔逾時保護（2026-09-01 實測需要）：盤後趟在世界先進那檔卡住 16 分鐘不動，
// 而 LLM 佇列是通的（分析工作每 10 秒完成一個）⇒ 卡點不在 LLM。
// 根因還沒查明，但**一檔卡住不該拖垮整趟**——88 檔的盤後趟因此永遠跑不完。
// 5 次 LLM 呼叫 × 240 秒逾時＝最壞 20 分鐘，這裡設 6 分鐘：
// 正常單檔 60~100 秒，超過就是異常，跳過它繼續下一檔。
async function withTimeout(p, ms, label) {
  let t;
  try {
    return await Promise.race([
      p,
      new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`逾時 ${ms / 1000}s：${label}`)), ms); }),
    ]);
  } finally { clearTimeout(t); }
}
const STOCK_TIMEOUT_MS = 6 * 60000;

// 本輪實際取得新聞的來源（不是「宣稱會用」的來源）。
// 寫死標籤會過期，也會說謊——2026-08-29 使用者截圖抓到畫面仍寫
// 「鉅亨（內文）＋GoogleNews（標題）」，但 fetchStockNewsMulti 早已改成
// 經濟日報／工商時報優先。改成據實回報：某來源當天掛掉就不會被列出。
const _newsSrcUsed = new Set();
const NEWS_SRC_ORDER = ['工商時報', '經濟日報', 'Yahoo', 'GoogleNews', '鉅亨', '跨站比對'];
function resetNewsSrcUsed() { _newsSrcUsed.clear(); }
function newsSourceLabel() {
  const used = NEWS_SRC_ORDER.filter(k => _newsSrcUsed.has(k));
  const extra = [..._newsSrcUsed].filter(k => !NEWS_SRC_ORDER.includes(k));
  const all = [...used, ...extra];
  return all.length ? all.join('＋') : '（本輪未取得任何新聞）';
}

async function fetchStockNewsMulti(keyword, code) {
  const out = [];
  const push = (a, src) => (_newsSrcUsed.add(src), out).push({
    // ⚠ at 解析不到就 null——不可捏造成 Date.now()（A 族）：
    //   2026-09-01 實測 4 月的面額變更公告被標成 0 日前混進「2 日內」判別。
    //   下游鮮度過濾全部有 n.at && 前置檢查（4627/4643/4675 行），null 安全。
    title: a.title, content: a.body, at: a.at || null, link: a.url,
    src, hasBody: true, bodyFrom: a.host, bodyGeneric: !a.at,   // 抓不到日期就標記，時效不明
  });
  // ⚠ 閘門要數的是**近期**內文，不是任何內文（2026-09-17 對 8 個交易日 1,203 筆判別反查：
  //   254 筆資訊不足裡 249 筆的理由是「有含內文的報導但最新一則已超過 14 日、近兩日只有標題」）。
  //   舊版 bodies() 把經濟日報搜到的幾個月前舊文也算數 ⇒ bodies()≥2 成立、Yahoo／鉅亨那兩條
  //   **根本沒被打**，近兩日的題材全留在標題級。改成只數 3 日內（≈兩個交易日視窗）的內文，
  //   舊文仍保留在 out（下游 14 日回退照用），只是不再擋住後面的來源。
  //   視窗與 judgeOneStock 同一把尺：回溯到前兩個交易日的起點（週一涵蓋四／五／六／日），下限 3 日。
  const FRESH_MS = (() => {
    try {
      const back = prevTradingIsos(isoDate(taipei()), 3); const from = back[2] || back[1] || back[0];
      const [yy, mm, dd] = from.split('-').map(Number);
      return Math.max(3 * 86400000, Date.now() - (Date.UTC(yy, mm - 1, dd) - 8 * 3600000));
    } catch { return 3 * 86400000; }
  })();
  const bodies = () => out.filter(x => x.hasBody && x.at && Date.now() - x.at <= FRESH_MS).length;
  const dedupKey = t => String(t || '').replace(/\s/g, '').slice(0, 16);

  // ── ① 優先來源：經濟日報・工商時報（使用者指定 2026-08-28）──────────
  try { for (const a of await fetchUdnMoney(keyword, 3)) push(a, '經濟日報'); } catch { /* 單一來源失敗不擋 */ }
  await sleep(300);
  try { for (const a of await fetchCtee(keyword, 2)) push(a, '工商時報'); } catch { /* 同上 */ }

  // ── ② 輔助：Yahoo 逐檔新聞（per-stock 端點，冷門股也有）────────────
  //    只在優先來源沒湊到 2 則內文時才打——省請求，也避免 prompt 灌太多則。
  if (bodies() < 2) {
    try {
      for (const y of await fetchYahooStockBodies(code, keyword, 2)) {
        push({ title: y.title, body: y.body, at: y.at || 0, url: y.url, host: y.host }, 'Yahoo');
      }
    } catch { /* 同上 */ }
  }

  // ── ② 輔助：Google News（只有標題，但覆蓋最廣，用來看有沒有漏掉的題材）──
  await sleep(300);
  try {
    for (const n of await fetchGoogleNewsRss(keyword, 8)) {
      if (out.some(x => dedupKey(x.title) === dedupKey(n.title))) continue;
      out.push({ title: n.title, content: '', at: n.at, link: n.link, src: n.src || 'GoogleNews', hasBody: false });
    }
  } catch { /* 同上 */ }

  // ── ③ 其他財經網：鉅亨（有內文，但冷門股常只有盤中速報機器稿）──────
  if (bodies() < 2) {
    await sleep(300);
    try {
      let got = 0;
      for (const n of await fetchCnyesNews(keyword, 6)) {
        let content = n.content || '';
        if (n.id && got < 2 && !MACHINE_NEWS.test(n.title)) {
          const b = await fetchCnyesBody(n.id);
          if (b.length >= 60) { content = _cleanBody(b); got++; }
          await sleep(300);
        }
        if (out.some(x => dedupKey(x.title) === dedupKey(n.title))) continue;
        out.push({ ...n, content, src: '鉅亨', hasBody: content.length >= 60,
          bodyFrom: content.length >= 60 ? 'news.cnyes.com' : undefined });
      }
    } catch { /* 同上 */ }
  }

  // ── ③ 最後手段：以標題到白名單財經網找同一則報導 ────────────────────
  //    使用者指示：不可用「無法取得內文」搪塞。
  try {
    if (!out.some(x => x.hasBody && !MACHINE_NEWS.test(x.title) && x.at && Date.now() - x.at <= FRESH_MS)) {
      let filled = 0;
      for (const n of out) {
        if (filled >= 2) break;
        if (n.hasBody || MACHINE_NEWS.test(n.title)) continue;
        const alt = await fetchBodyByTitle(n.title, keyword);
        if (alt) {
          n.content = _cleanBody(alt.body); n.hasBody = true; n.bodyFrom = alt.host;
          if (!n.link) n.link = alt.url;
          filled++;
        }
        await sleep(400);
      }
    }
  } catch { /* 同上 */ }

  const allBodies = out.filter(x => x.hasBody).length;
  if (allBodies) {
    const srcs = [...new Set(out.filter(x => x.hasBody).map(x => x.src))];
    log(`    ↳ ${keyword}：內文 ${allBodies} 則（${srcs.join('・')}）${bodies() ? '' : '，皆逾 3 日'}`);
  }
  return out;
}

// ── 每檔的新聞判別核心（軋空與漲停預測共用·2026-08-28 抽出）──────────
// ⚠ **不可以複製第二份**：這段裡有使用者逐條指定的規則（讀完內文、產業鏈
//   連動、主旋律敏感度、舊聞信心上限、無內文不判多空…）。複製出去必然各自
//   漂移——CLAUDE.md 記過注意股/處置股被複製三份的教訓。
// 回傳判別與佐證，呼叫端自行決定組裝與存檔方式。
// 名稱延伸表：找出「本檔名稱 + 下一個字」會變成另一檔股票的那些字。
// 用途：計算「被指名提及幾次」時，必須排除「南亞**科**」這種
//   ——它是另一家公司，不是本檔的提及。
// ⚠ 不能用「後面接中文就不算」：那會誤殺「南亞今日」「台聚集團」這種正常用法
//   （同一個教訓在標題認股那邊已經踩過一次，見 NAME_TRAP_PREFIX 的註解）。
// 硬負面事件的關鍵詞。⚠ 它**不決定多空方向**——方向一律由 AI 讀完內文判斷
// （使用者硬規定：禁止用標題/關鍵字調分）。它只負責把事件挑出來寫進提示，
// 因為實測發現模型會被公司的「營運正常」聲明帶走：
//   3037 欣興遭檢調搜索 → 判中性，理由是「公司多次強調營運正常」。
//   提示詞裡已寫「否認不能中和」，模型讀了卻沒照做 ⇒ 只寫在提示裡不夠。
const HARD_NEGATIVE = /檢調|搜索|搜查|約談|起訴|羈押|背信|掏空|訴訟|求償|裁罰|罰鍰|停工|停產|火災|爆炸|下修|財測下修|認列(虧損|減損)|虧損擴大|減資|保留意見|列為(全額交割|處置)|禁止|召回|抽單|砍單|流標|解約/;

let _nameIdxCache = null;
async function nameIndex() {
  if (_nameIdxCache) return _nameIdxCache;
  try {
    const snap = (await db.collection('marketSnapshot').doc('latest').get()).data();
    const q = snap?.quotesJson ? JSON.parse(snap.quotesJson) : {};
    _nameIdxCache = Object.values(q).map(x => x?.name).filter(n => n && n.length >= 2);
  } catch (e) {
    // ⚠ **失敗不可快取**：快取空陣列等於整輪都拿不到名稱延伸表，
    //   「南亞科」又會被算成「南亞」的提及，而且不會自己恢復——
    //   靜默劣化回原本的 bug。留 null 讓下一檔重試，並據實告警。
    log('  ↳ ⚠ 名稱索引讀取失敗，提及計數暫時無法排除相似名稱:', (e.message || '').slice(0, 40));
    return [];
  }
  return _nameIdxCache;
}
function extensionCharsOf(name, allNames) {
  const out = new Set();
  for (const n of allNames) {
    if (n !== name && n.startsWith(name) && n.length > name.length) out.add(n[name.length]);
  }
  return out;
}

async function judgeOneStock(it, ctx, opts = {}) {
  const { calMap = {}, gLine = '', indMap = {} } = ctx || {};
    const kw = (it.name || '').replace(/[*＊\-].*$/, '').trim() || it.code;
  // ⏱ 階段計時（2026-09-01）：曾有單檔 16 分鐘的紀錄，root cause 一直沒抓到。
  //   最起碼要能回答「卡在抓取還是判別」。慢於 90 秒才輸出，不洗版。
  const _t0 = Date.now();
  const news = await fetchStockNewsMulti(kw, it.code);
  const _tFetch = Date.now() - _t0;
  // ⚠ 供函式尾端 return 使用：_picked 宣告在內層區塊，外面取不到。
  //   （宣告作用域問題今天已踩過三次：newsAdjOf、flush、const核）
  let _pickedOut = [];
  // 分流管線的省錢閘門（使用者 2026-08-29）：晨間那趟只處理「標題沒判過的」。
  //   多數晨間稿是盤後稿的改寫，沒有新標題就代表沒有新資訊 ⇒ 沿用既有判別、
  //   不花這一次 AI。這是 150 檔能在 08:00 前跑完的關鍵。
  // ⚠ 判斷「有沒有新東西」用全部抓到的新聞，但真的要判時仍以完整視窗為上下文，
  //   不只拿增量去判——否則判別會失去脈絡。
  if (opts.seenTitles && opts.seenTitles.length) {
    // ⚠ 條件必須是「沒有新的**有內文**文章」，不是「一則新標題都沒有」
    //   （2026-08-29 實測：後者跳過率 0/90，設計完全落空）。
    //   每檔會抓 10~15 則，其中多數是 Google News 的純標題，
    //   而它每次回傳的組合都在變 ⇒「零新標題」實務上永遠不成立。
    //   判別是靠有內文的文章驅動的：沒有新的內文＝沒有新資訊可判，
    //   重判只是把同一批內文再讀一次。
    const freshBody = news.filter(n => n.title && n.hasBody && !titleSeen(n.title, opts.seenTitles));
    if (!freshBody.length) return { skipped: true, reason: 'no-new-body', recent: [], allTitles: news.map(n => n.title).filter(Boolean) };
  }
  // ⚠ 新聞視窗要跨過**非交易日**（使用者指示 2026-08-28）：
  //   固定 48 小時在週一早上只涵蓋「週六 08:00 ~ 週一 08:00」——**週四、
  //   週五的新聞整批漏掉**，而那正是企業發佈消息最密集的兩天。連假更慘。
  //   ⇒ 改成回溯到「前兩個**交易日**的起點」，中間的週末與假日自動被包進來：
  //     週一 → 從上週四 00:00 起算（涵蓋 四/五/六/日）；
  //     一般日 → 從前天 00:00 起算，與原本的 2 日相當。
  const now = Date.now();
  const _winStart = (() => {
    const tw2 = taipei();
    const back = prevTradingIsos(isoDate(tw2), 3);      // [今日, 前一交易日, 前兩交易日]
    const from = back[2] || back[1] || back[0];
    const [yy, mm, dd] = from.split('-').map(Number);
    // 以台北 00:00 為界；轉成毫秒時扣掉 +08:00 時差
    return Date.UTC(yy, mm - 1, dd) - 8 * 3600000;
  })();
  const TWO_D = Math.max(2 * 86400000, now - _winStart);
  const MAX_BACK = 14 * 86400000;
  let recent = news.filter(n => n.at && now - n.at <= TWO_D);
  // ── 找不到近 2 日就回退到「最近最新的」（使用者 2026-08-26 指定）────────
  //   空手判「資訊不足」對使用者沒有幫助；有舊資料總比沒有好。
  //   但**時效必須誠實標示並降低權重**：6 天前的法說預告與今天的接單公告，
  //   對隔日開盤的意義完全不同。回退上限 14 天，超過就真的當沒有。
  let stale = false, ageDays = null;
  // ⚠ 回退條件不能只看「近兩日完全沒新聞」（2026-08-28 實測抓到）：
  //   信昌電近兩日有 7 則 Google News **標題**，所以 recent 非空，於是 14 日內
  //   那幾則**有內文**的經濟日報報導（9 天前）永遠不會被拉進來，最後落到
  //   「資訊不足」——但我們手上其實是有內容的，這正是使用者說的「不可用
  //   無法取得內文來塞」。
  //   ⇒ 改成：近兩日**沒有任何含內文的實質報導**時，就把 14 日內有內文的
  //     補進來並標記 stale（prompt 已有時效警語與信心上限）。
  const hasRecentBody = recent.some(n => n.hasBody && !MACHINE_NEWS.test(n.title));
  if (recent.length === 0 || !hasRecentBody) {
    const older = news
      .filter(n => n.at && now - n.at <= MAX_BACK && (recent.length === 0 || (n.hasBody && !MACHINE_NEWS.test(n.title))))
      .sort((a, b) => b.at - a.at);
    if (older.length) {
      recent = recent.length === 0 ? older.slice(0, 6) : [...recent, ...older.slice(0, 3)];
      stale = true;
      ageDays = +((now - older[0].at) / 86400000).toFixed(1);
    }
  }
  // 只剔機器速報；其餘（含帶「漲停」字眼但可能有題材的）都送 AI 判斷
  const material = recent.filter(n => !MACHINE_NEWS.test(n.title));
  const withBody = material.filter(n => n.hasBody);

  const events = calMap[it.code] || [];
  const evLine = events.length
    ? events.map(e => `${e.date} ${e.title}${e.impact === 'H' ? '（高影響）' : ''}`).join('；')
    : '';
  let verdict = events.length
    ? { label: '中性', bullish: false, confidence: '低', reason: `近 2 日無實質新聞，但有已排定事件：${evLine}`, basis: 'event', n: recent.length }
    : { label: '資訊不足', bullish: false, reason: `近 14 日查無實質新聞，亦無已排定事件`, basis: 'none', n: recent.length };
  // ⚠ 沒有內文就**不下多空判斷**（使用者指示 2026-08-27）：
  //   實測 08-27 開盤前 12 檔，11 檔 basis=title。判「利多」的 3 檔當日
  //   0/3 漲≥5%、平均 +1.45%；反而判「中性」的前鼎 +9.83%、力旺 +9.96%、
  //   聯一光 +10.00%——只憑標題的判別**與結果反向**，輸出它比不輸出更糟，
  //   還會讓使用者以為系統讀過新聞。標題照樣列給使用者自己看，但 label
  //   一律「資訊不足」，不主張多空。有排定事件時仍走 AI（basis=event）。
  // ⚠ 不可加 `&& !events.length`：實測凱美(2375) 有排定事件就繞過這道閘門，
  //   結果 basis=title 卻judged「利多/高」——正是這條規則要擋的東西。
  //   事件本身在 UI 另有「📅 已排定事件」欄位，不會因此消失。
  if (material.length && !withBody.length) {
    // ⚠ 理由要說**真正的原因**。抓到內文但因為太舊被時效過濾掉，卻寫成
    //   「取不到內文」是在說謊——2026-08-28 實測：日誌明明記著「內文 3 則
    //   （經濟日報）」，判別卻宣稱取不到。分成兩種情況據實描述。
    const oldBodies = news.filter(n2 => n2.hasBody && !MACHINE_NEWS.test(n2.title) && n2.at);
    const newestOld = oldBodies.length ? Math.max(...oldBodies.map(n2 => n2.at)) : 0;
    const oldDays = newestOld ? Math.round((now - newestOld) / 86400000) : 0;
    verdict = {
      label: '資訊不足', bullish: false, confidence: '低',
      reason: newestOld
        ? `有 ${oldBodies.length} 則含內文的報導，但最新一則已是 ${oldDays} 天前（超過 14 日時效上限），不足以支撐隔日判斷；近兩日只有 ${material.length} 則標題級新聞`
        : `找到 ${material.length} 則相關新聞，優先來源（經濟日報/工商時報）與輔助來源都取不到內文，依規定不做多空判斷（標題列於下方供自行研判）`,
      basis: 'title', n: recent.length, nMaterial: material.length, stale, ageDays,
      staleBodyDays: oldDays || null,
    };
  } else if (material.length || events.length) {
    const basis = withBody.length ? 'content' : (material.length ? 'title' : 'event');
    // 選稿也要有敏感度（使用者指定 2026-08-28）：同樣是 5 則，優先餵命中
    // 當前市場主旋律的那幾則——AI 只讀 4 則，挑錯就等於沒讀到關鍵新聞。
    const pool = (withBody.length ? withBody : material);
    const src = pool.slice().sort((a, b) =>
      hotHits(`${b.title} ${b.content || ''}`).length - hotHits(`${a.title} ${a.content || ''}`).length
    );

    // 同一則故事最多引用 3 篇（使用者 2026-08-29 指定）。
    // 同一件事被各家改寫標題重發是常態；不設上限的話，4 個名額會被
    // 同一則故事的改寫稿佔滿，判別看不到其他題材，等於用重複資訊做判斷。
    // 相似度用與別處相同的 Dice 0.6（改門檻要三處一起改：
    //   news-sentiment.ts 的 SIM_THRESHOLD、本檔的 TITLE_SIM、這裡）。
    const _groups = [];
    const _picked = [];
    for (const n of src) {
      const g = _bigrams(n.title || '');
      let grp = _groups.find(x => _dice(x.g, g) >= TITLE_SIM);
      if (!grp) { grp = { g, n: 0 }; _groups.push(grp); }
      if (grp.n >= 3) continue;          // 同故事已引用 3 篇
      grp.n++; _picked.push(n);
      if (_picked.length >= 4) break;
    }
    // 500 字會把一篇 1,000~1,600 字的稿子攔腰砍斷，等於沒讀完（使用者要求完整讀完）
    _pickedOut = _picked;
    const body = _picked.map((n, i) => {
      const hot = hotHits(`${n.title} ${n.content || ''}`);
      const from = n.bodyFrom ? `（內文來源：${n.bodyFrom}${n.bodyGeneric ? '，以公司名搜尋取得，**可能不是近兩日的報導**，判斷時請降低權重並在風險欄註明' : ''}）` : '';
      return `【新聞${i + 1}】${n.title}${from}${hot.length ? `\n〔命中主旋律：${hot.join('、')}〕` : ''}\n${n.content ? n.content.slice(0, 1200) : '（無內文，僅標題）'}`;
    }).join('\n\n');
    // 「本檔有沒有真的被寫到」是正確性的第一道關卡：只在標題出現、內文
    // 通篇在講別家公司的，多半是順帶提及，不足以支撐多空判斷。
    // ⚠ 提及次數不可用單純子字串計數（2026-08-29 實測抓到）：
    //   「南亞科」含有「南亞」⇒ 1303 南亞被算成有 N 次提及，
    //   判別因此拿**別家公司**的新聞當自家消息，還判成利多。
    //   排除會延伸成另一檔股票名的那些出現位置。
    const _allNames = await nameIndex();
    const _ext = extensionCharsOf(it.name, _allNames);
    const countMentions = (text) => {
      let n2 = 0, i = text.indexOf(it.name);
      while (i >= 0) {
        const next = text[i + it.name.length] || '';
        if (!_ext.has(next)) n2++;
        i = text.indexOf(it.name, i + 1);
      }
      return n2;
    };
    // ⚠ 這三處都要用 _picked（實際餵給判別的那幾篇），不能用 src（完整池）：
    //   提示詞寫的是「本檔在**以下新聞**中被指名提及 N 次」，
    //   若統計範圍比判別看到的還大，模型會拿到對不上的數字；
    //   負面事件同理——挑出判別根本沒看到的事件會讓它無從回答。
    const mentions = _picked.reduce((n2, x) => n2 + countMentions(`${x.title} ${x.content || ''}`), 0);
    // 只挑出「與本檔同時出現」的負面事件，避免把同業的壞消息算到自己頭上
    const negHits = [...new Set(_picked.flatMap(x => {
      const t = `${x.title} ${x.content || ''}`;
      if (!countMentions(t)) return [];
      const m = t.match(HARD_NEGATIVE);
      return m ? [m[0]] : [];
    }))].slice(0, 4);
    const indName = indMap[it.code] || '';
    // ══ D 拒答門檻（防幻想管線第 1 關，使用者 2026-08-29 指定順序 D→C→C→A）══
    //   問題需要的資料我有沒有？沒有就不進入生成，避免模型硬答。
    //   ⚠ 寫在程式裡而非提示詞：提示詞已寫過「提及 0 次就判資訊不足」，
    //     但模型仍會硬掰（1303 南亞拿南亞科的新聞判利多就是這樣來的）。
    const hasBodyEvidence = _picked.some(x => x.hasBody);
    if (!hasBodyEvidence || mentions === 0) {
      return {
        verdict: {
          label: '資訊不足', bullish: false, confidence: '低', strength: '弱',
          reason: !hasBodyEvidence
            ? '取得的報導均無內文，無法據以判斷'
            : `${_picked.length} 則報導中本檔一次都沒有被指名提及，這些報導不是在講它`,
          basis, n: recent.length, gate: 'D-拒答門檻',
        },
        events, stale, ageDays, recent, material, withBody,
        allTitles: news.map(n => n.title).filter(Boolean),
      };
    }

    const prompt = `你同時扮演四個角色，四者都要用上（使用者 2026-08-29 指定）：
【全球經濟分析師】利率通膨、匯率、景氣循環位置、主要經濟體政策、資金流向。
【股市產業分析師】產業供需與價格週期、公司在產業中的位置、營收獲利結構、
  評價區間、市場既有預期與這則消息的落差。
【戰略分析師】地緣政治、關稅與出口管制、政策法規變動、企業競合與布局意圖。
【供應鏈分析師】上中下游傳導路徑、客戶與供應商集中度、產能與交期、
  替代與轉單風險、這一檔在鏈上的實際位置。
角色間結論不一致時要說出來，並以「市場會如何反應」為最終依歸
——這份判別的用途是預期市場反應，不是評價公司好壞。

以下是 ${it.code} ${it.name} 近兩日的新聞。請判斷這些新聞對「隔日股價」是否構成**實質利多**。

【已知事實（請以此為錨，不要臆測這家公司做什麼）】
· ${it.code} ${it.name}${indName ? `　官方產業別：${indName}` : '　（產業別未知）'}
${negHits.length ? `· ⚠ 內文中偵測到可能的負面事件字眼：${negHits.join('、')}。\n  請**正面回答**它對本檔是否構成實質風險；公司發重訊聲明「營運正常/無重大影響」是當事人說法，**不足以把它中和成中性**。若確實與本檔無關（例如是同業或客戶的事）才可判中性。\n` : ''}${opts.coMentionNote ? `· ${opts.coMentionNote}\n` : ''}· 本檔在以下新聞中被指名提及共 ${mentions} 次${mentions === 0 ? '——**一次都沒有**，代表這些報導不是在講它，請判「資訊不足」或「中性」，不可硬扯關聯' : mentions <= 2 ? '（次數很少，可能只是順帶提及，請據此壓低信心）' : ''}

嚴格規則：
1. 「股價上漲/漲停/爆量/急拉/成交量大」這類**價格與行情描述不算利多**——那是結果不是原因。
2. 只有會改變**這家公司自己**的價值或營運預期的事才算利多：它接到訂單、它擴產、它的產品漲價、它取得認證、它法說優於預期、它併購或得標、它新產品量產。⚠ 主詞很重要：**同業**擴產（供給增加）、**原料**漲價（下游成本上升）、**客戶**轉單給別人，對本檔都是**利空**而不是利多。判斷前先確認這件事的主詞是誰、本檔站在哪一邊。
3. 若新聞只是重複報導股價表現、或內容與該公司無關，請判為「中性」。
   ⚠ 實測違規案例（2026-08-29）：「被列為熱門零股、市場關注度提升」被判成利多。
   那是**關注度描述**，不是營運事實——這類一律中性。同類還有：入選各種榜單、
   成交量排行、被納入某某概念股清單、股東人數變化、當沖比率高。
   同樣不算利多的還有：ESG/永續/綠建築認證、得獎、公益活動、企業形象、
   人事調整（非核心經營層）、單純的展會參展——除非文中明確連結到訂單或營收。
3b. **利空是正常且必要的結論**（實測 111 檔判出 0 則利空，明顯失衡）。
   下列一律優先考慮利空：檢調搜索/調查、訴訟或求償、主管機關裁罰、
   下修財測或營收年減、客戶抽單或流失、訂單被競爭者取得、停工/減產/火災、
   認列虧損或減損、庫存過高、大股東或董監持股大減、減資彌補虧損、
   會計師出具保留意見、下游砍價、原料成本大漲（對下游）。
3c. **公司否認不能把利空變成中性**。「營運正常、無重大影響」是當事人說法，
   不是事實查核。實測案例：某檔遭檢調搜索、公司聲明營運正常 ⇒ 被判中性。
   正確做法：事件本身是實質風險就判利空，並在理由裡註明公司已否認。
4. **區分「已確認事實」與「傳聞/市場預期/可能」**：若題材只是「有可能」「市場預期」
   「送樣認證中」，信心最高只能給「中」，並在風險欄指出不確定性與量產時程。
5. 標題同時有行情字眼（漲停、爆量）與題材字眼（供應鏈、認證、訂單）時，
   請看**題材**判斷，不要因為有行情字眼就判中性。
6. 不確定就判「中性」，不要為了給答案而美化。
7. **要考慮國際局勢與產業鏈上下游連動**，不要只看這家公司自己的消息。例如：產油國
   增減產 → 油價 → 航運與石化同步受影響；記憶體/晶圓報價 → IC 設計·封測·設備；
   運價 → 貨櫃·散裝；匯率 → 出口電子；費半與美系同業財報 → 台系供應鏈。
   若判斷用到這類傳導，**必須在「連動」欄寫出路徑**（誰的什麼事 → 影響什麼 →
   為何影響到這一檔），並註明這是**推論**不是已確認事實；推論性的連動信心最高給「中」。
8. **當前市場主旋律要特別敏感**：戰爭與地緣衝突、石油與油價、美國通膨與利率、
   AI 與算力、半導體與先進封裝、光通訊(CPO/矽光子)、記憶體、電力與電網、機器人、
   無人機、太空與低軌衛星；關鍵人物：川普、馬斯克、黃仁勳、蘇姿丰、鮑爾。
   新聞若牽涉這些，請**明確判斷它對這一檔是利多還是利空**，不要因為是宏觀題材
   就含糊帶過。⚠ 但**命中關鍵字不等於利多**——同一件事對不同產業方向相反
   （例：戰爭推升運價利多航運、卻壓抑觀光；油價上漲利多油氣、卻墊高塑化成本）。
   方向必須從**內文**讀出來，讀不出來就判中性。
9. **連動要正確，不可硬扯**（這條優先於第 7、8 點）：
   · 傳導路徑必須與上面「官方產業別」相容。產業別對不上就不要編一條鏈出來，
   寧可寫「無」——錯的連動比沒有連動更糟，它會讓人以為有根據。
   · 路徑要寫清楚**這一檔在鏈上的位置**（上游材料／中游製造／下游應用／設備商），
   不能只寫「受惠 AI 需求」這種對半導體全體都成立的話。
   · 新聞裡沒提到這家公司卻要主張連動時，必須在「連動」欄開頭寫「推論：」，
   且信心最高只能給「低」。

國際盤昨夜：${gLine || '（無資料）'}
${stale ? `\n⚠ **注意時效**：近 2 日查無新聞，以下是**${ageDays} 天前**的較舊報導。舊消息多半已被股價反映，除非是尚未兌現的重大事件，否則信心最高只能給「低」，並在風險欄註明消息已隔 ${ageDays} 天。\n` : ''}
${evLine ? `\n**已排定事件**（來自交易所行事曆，非傳聞）：${evLine}\n法說會/業績發表會當日或隔日開盤前，市場常對其內容反應；但**內容未知時不可預設為利多**，請判為中性並在風險欄註明「法說內容未知」。\n` : ''}
${body || '（近 2 日無實質新聞）'}

**強度＝你預期市場會有多大反應**（使用者指定的用途：判別要能跨個股比較高低）。
不是「這件事好不好」，而是「這件事會讓股價動多少」。

⚠ **強度不可由關鍵字直接對應**（使用者 2026-08-29 明令）。
必須走完下列推理，強度是**推理與挑戰之後**的結論：

① 先從內文找出**最關鍵的那一句**（不是標題，是文中真正承載事實的那句）。
   ⚠ **挑「有事實含量」的，不是挑「最像結論」的**（實測案例）：
     2882 國泰金的報導裡同時有
       (a)「李長庚認為台灣半導體與 AI 產業還有好幾年好光景」← 總經評論
       (b)「上半年大賺 765 億元、每股純益 4.95 元、股利配發會比過去好」← 營運事實
     模型挑了 (a)，於是影響路徑只能寫「帶動投資人信心、間接支撐股價」這種推想，
     整條判別被自檢刪光。正確答案是 (b)——有數字、可查證、直接關係本公司獲利。
   優先序：**本公司的營運數字 > 本公司的具體事件 > 對本公司的預測 > 產業/總經評論**。
   高層對大環境的樂觀看法，除非文中把它連到本公司的訂單或財務數字，
   否則**不是本檔的利多**，只是評論。
② 【供應鏈分析師＋全球經濟分析師】推它的**影響路徑與量級**：
   這件事透過什麼機制影響營收／毛利／獲利／評價？影響多大、多快、持續多久？
   是一次性還是結構性？佔本業比重多少？
③ 【股市產業分析師】問**市場是否已經知道**：已被預期或已反映的消息，即使事件本身很大，
   對隔日股價的**增量**反應也小。反之，未被預期的小事也可能有大反應。
④ 提出**初步挑戰**（正式的多輪挑戰在下一階段，這裡先自我反駁一次）：
   最可能推翻你這個判斷的反方論點是什麼？
   （例：數字漂亮但來自一次性業外、擴產但客戶未確定、
     搜索但標的是子公司且金額小、成長但基期極低）
⑤ 經過④之後才給強度。若挑戰站得住腳，就必須調降強度或改判中性。

同樣是「營收成長」，年增 200% 與年增 5% 的強度必須不同——
但那是因為②的量級不同，不是因為看到「200%」這個字串。

⚠ 強度與信心是兩件事：信心＝你對判斷本身有多確定；強度＝事件本身多大。

請用**繁體中文**依此格式回答，不要多餘文字：
判別: 利多/利空/中性
關鍵句: （引用內文最關鍵的一句，30 字內；沒有可引用的寫「無」）
影響路徑: （這句話透過什麼機制影響營收/獲利/評價，含量級，50 字內）
已被預期: 是/否/不確定
事件類型: 訂單/財測/法說/擴產/法律/處分/減資/併購/產業報價/宏觀/營收財報/新產品/人事/其他  ← 只挑一個，寫「發生了什麼」，不寫好壞
確定性: 已確認/預期/傳聞  ← 已確認＝公司或官方已公告的事實；預期＝法人或媒體的預估；傳聞＝未經證實
新穎性: 首次/重複  ← 這件事是首次揭露，還是先前已被報導過的舊事重提
挑戰: （最可能推翻上述判斷的反方論點，40 字內；想不到寫「無」）
強度: 極強/強/中/弱   ← 必須是經過上面「挑戰」之後的定案
信心: 高/中/低
理由: （一句話，50 字內，須指出是哪一則新聞的什麼事實）
連動: （一句話，60 字內，國際局勢或產業鏈的傳導路徑；沒有用到寫「無」）
風險: （一句話，50 字內，指出這個判斷最大的不確定性；無明顯風險寫「無」）`;
    // 判別是分類任務，低溫以求一致（見 _ollamaRaw 的溫度註解）
    const ans = await askOllama(prompt, { priority: 1, temperature: NEWS_TEMP });
    if (ans) {
      const mv = ans.match(/判別\s*[:：]\s*(利多|利空|中性)/);
      const ms = ans.match(/強度\s*[:：]\s*(極強|強|中|弱)/);
      const mkey = ans.match(/關鍵句\s*[:：]\s*(.+)/);
      const mpath = ans.match(/影響路徑\s*[:：]\s*(.+)/);
      const mprc = ans.match(/已被預期\s*[:：]\s*(是|否|不確定)/);
      // L1 抽取欄（2026-09-17 計畫第一段）：只多存欄位供分組對答案，**不進判定規則**。
      //   事件類型限定在清單內，清單外／沒答 ⇒ null（不捏造預設值）。
      const mety = ans.match(/事件類型\s*[:：]\s*(訂單|財測|法說|擴產|法律|處分|減資|併購|產業報價|宏觀|營收財報|新產品|人事|其他)/);
      const mcert = ans.match(/確定性\s*[:：]\s*(已確認|預期|傳聞)/);
      const mnov = ans.match(/新穎性\s*[:：]\s*(首次|重複)/);
      const mchal = ans.match(/挑戰\s*[:：]\s*(.+)/);
      const mc = ans.match(/信心\s*[:：]\s*(高|中|低)/);
      const mr = ans.match(/理由\s*[:：]\s*(.+)/);
      const mk = ans.match(/風險\s*[:：]\s*(.+)/);
      const ml = ans.match(/連動\s*[:：]\s*(.+)/);
      const label = mv ? mv[1] : '中性';
      verdict = {
        label, bullish: label === '利多',
        // ⚠ 時效上限用**程式強制**，不能只寫在 prompt 裡：本地模型不一定照做
        //   （2026-08-28 實測：精材拿 13.6 天前的舊聞卻給「高」信心，而 prompt
        //   明寫「舊聞信心最高只能給低」）。規則要能被違反就等於沒有規則。
        confidence: stale ? '低' : (mc ? mc[1] : '低'),
        // 強度＝預期的市場反應大小（與信心是兩件事）。缺值保守取「中」。
        strength: ms ? ms[1] : '中',
        // 推理鏈存下來——強度是怎麼推出來的必須可稽核，
        // 否則無從分辨「有推理」與「照關鍵字對應」。
        keyQuote: mkey ? mkey[1].trim().slice(0, 40) : null,
        impactPath: mpath ? mpath[1].trim().slice(0, 60) : null,
        priced: mprc ? mprc[1] : null,
        eventType: mety ? mety[1] : null, certainty: mcert ? mcert[1] : null, novelty: mnov ? mnov[1] : null,
        challenge: mchal ? mchal[1].trim().slice(0, 50) : null,
        reason: mr ? mr[1].trim().slice(0, 70) : ans.slice(0, 70),
        risk: stale
          ? `消息已隔 ${ageDays} 天，多半已反映在股價${mk ? `；${mk[1].trim().slice(0, 44)}` : ''}`
          : (mk ? mk[1].trim().slice(0, 70) : null),
        // 本地模型會吐 LaTeX（實測 `$\rightarrow$`），顯示前正規化成箭頭
        chain: ml && !/^無$/.test(ml[1].trim())
          ? ml[1].trim().replace(/\$?\\(?:rightarrow|to|Rightarrow)\$?/g, '→').replace(/\s*->\s*/g, ' → ').replace(/\s+/g, ' ').slice(0, 80)
          : null,   // 國際局勢／產業鏈傳導路徑
        basis, n: recent.length, nMaterial: material.length,
        stale, ageDays,
      };

    // ══ 第二階段：四角色輪番挑戰後才定案（使用者 2026-08-29 明令）══
    //   「識讀後需多次挑戰後才能定值，而不是一次性就定值」。
    //   第一階段的④只是自我反駁一次，強度容易停在初判的直覺值。
    //   這裡讓四個角色**各自提出最強反對意見**，再綜合定案——
    //   挑戰若成立就必須調降強度或改判，並說出是哪一個挑戰改變了結論。
    // ⚠ 成本：每檔多一次 AI 呼叫（約 +20 秒）。110 檔約 73 分鐘，
    //   盤後窗（23:00 起）足夠；晨間窗靠跳過已判標題，不受影響。
    if (verdict && verdict.label !== '資訊不足' && !stale) {
      const chPrompt = `以下是對 ${it.code} ${it.name} 的**初步判別**，請挑戰它。\n`
        + `初判：${verdict.label}／強度${verdict.strength}／信心${verdict.confidence}\n`
        + `關鍵句：${verdict.keyQuote || '（無）'}\n`
        + `影響路徑：${verdict.impactPath || '（無）'}\n`
        + `市場已預期：${verdict.priced || '（未答）'}\n`
        + `理由：${verdict.reason || ''}\n\n`
        + `新聞原文：\n${body || '（無）'}\n\n`
        + `請讓四個角色**各自提出最強的反對意見**（沒有可反對的就寫「無」）：\n`
        + `【全球經濟分析師】從利率/匯率/景氣循環/資金面反駁\n`
        + `【股市產業分析師】從「市場是否早已知道並反映」「與既有預期的落差」反駁\n`
        + `【戰略分析師】從地緣政治/政策法規/競爭對手反制反駁\n`
        + `【供應鏈分析師】從客戶集中度/產能交期/替代與轉單風險反駁\n\n`
        + `然後綜合這些挑戰給出**定案**。\n`
        + `⚠ **綜合時的權重（使用者 2026-08-29 指定）**：\n`
        + `  【股市產業分析師】的意見在**方向**上權重最高——這份判別的用途是\n`
        + `  「預期市場會如何反應」，而它是四個角色中最貼近市場定價的。\n`
        + `  其他三位的挑戰若與它衝突，除非指出**明確的事實錯誤**\n`
        + `  （原文沒這回事、講的是別家公司、數字錯誤），否則**不應推翻方向**，\n`
        + `  只能用來調降強度或信心。\n`
        + `  ⚠ 「不確定性」「尚待觀察」「量產時程未定」這類**本來就存在的風險**，\n`
        + `  不是推翻方向的理由——任何題材都有不確定性，用它否定一切等於\n`
        + `  永遠只能判中性，那樣這份判別就沒有任何價值。\n`
        + `  只有當挑戰足以讓「市場不會照這個方向反應」時，才改判中性。\n`
        + `⚠ 不要為了與初判一致而敷衍——維持初判也要說明四個挑戰為何都不成立。\n\n`
        + `**同時**做一件事：逐條檢查初判中的每一項陳述，在新聞原文裡找不找得到依據。\n`
        + `找不到依據的情況：原文根本沒說、講的是**別家公司**、`
        + `把「可能/預期」寫成已發生的事實、數字是你自己推算的。\n`
        + `找不到依據的陳述**必須刪除**，不可改寫成更模糊的說法保留。\n\n`
        + `依此格式回答，不要多餘文字：\n`
        + `挑戰經濟: （一句話或「無」）\n挑戰產業: （一句話或「無」）\n`
        + `挑戰戰略: （一句話或「無」）\n挑戰供應鏈: （一句話或「無」）\n`
        + `無依據: （逐條列出原文找不到依據的陳述；全部有依據寫「無」）\n`
        + `定案判別: 利多/利空/中性\n定案強度: 極強/強/中/弱\n定案信心: 高/中/低\n`
        + `定案理由: （只保留原文找得到依據的內容，50 字內）\n`
        + `修正說明: （若與初判不同，說明是哪一個挑戰或哪一句無依據改變了結論；相同寫「維持初判」）`;
      try {
        const a3 = await askOllama(chPrompt, { priority: 1, temperature: NEWS_TEMP });
        if (a3) {
          const f = (re) => { const m = a3.match(re); return m ? m[1].trim() : null; };
          const fl = f(/定案判別\s*[:：]\s*(利多|利空|中性)/);
          const fs = f(/定案強度\s*[:：]\s*(極強|強|中|弱)/);
          const fc = f(/定案信心\s*[:：]\s*(高|中|低)/);
          if (fl) {
            verdict = {
              ...verdict,
              label: fl, bullish: fl === '利多',
              strength: fs || verdict.strength,
              confidence: fc || verdict.confidence,
              challenged: true,
              dirChecked: true,                      // 方向自檢已併入本次（原本是獨立一次呼叫）
              reason: f(/定案理由\s*[:：]\s*(.+)/)?.slice(0, 70) || verdict.reason,
              unsupported: (() => { const u = f(/無依據\s*[:：]\s*(.+)/); return u && u !== '無' ? [`挑戰: ${u.slice(0, 60)}`] : []; })(),
              challenges: {
                經濟: f(/挑戰經濟\s*[:：]\s*(.+)/)?.slice(0, 50) || null,
                產業: f(/挑戰產業\s*[:：]\s*(.+)/)?.slice(0, 50) || null,
                戰略: f(/挑戰戰略\s*[:：]\s*(.+)/)?.slice(0, 50) || null,
                供應鏈: f(/挑戰供應鏈\s*[:：]\s*(.+)/)?.slice(0, 50) || null,
              },
              revision: f(/修正說明\s*[:：]\s*(.+)/)?.slice(0, 60) || null,
            };
          }
        }
      } catch { /* 挑戰失敗就沿用初判，不猜 */ }
    }

    // ══ A 數字校驗（純程式、零成本；在 C 之後各跑一次）══
    //   把判別文字裡的數字逐一比對原文，對不上就是**捏造的數字**
    //   ——傷害最大的一類幻想（假營收、假成長率、假目標價）。
    //   ⚠ 只擋數字；無數字的敘述性幻想由 C 自檢負責。
    const corpusNums = _picked.map(x => `${x.title} ${x.content || ''}`).join(' ').replace(/[,，]/g, '');
    const verifyNums = (v, tag) => {
      if (!v) return v;
      const nums = [...new Set(
        [v.reason, v.impactPath, v.keyQuote].filter(Boolean).join(' ').replace(/[,，]/g, '')
          .match(/\d+(?:\.\d+)?\s*(?:%|％|倍|億|萬|元|奈米)/g) || []
      )];
      const bad = nums.filter(n => {
        const key = n.replace(/\s+/g, '');
        return !corpusNums.includes(key) && !corpusNums.includes(key.replace(/％/, '%'));
      });
      if (!bad.length) return v;
      log(`  ↳ ⚠ ${it.code} 數字校驗(${tag})未過：${bad.slice(0, 3).join('、')}（已降信心）`);
      return {
        ...v,
        // 數字錯不代表方向錯，所以不刪判別；但要據實標示並降信心
        // ——會引用不實數字的模型，其他陳述也不該被完全採信。
        confidence: v.confidence === '高' ? '中' : '低',
        unverifiedNums: [...new Set([...(v.unverifiedNums || []), ...bad])].slice(0, 4),
        reason: `${v.reason || ''}〔⚠ 數字未查證：${bad.slice(0, 3).join('、')}〕`.slice(0, 110),
      };
    };

    // ══ C→A→C→A（使用者 2026-08-29 指定順序 D C A C A）══
    //   兩輪的**目的不同**，這是關鍵：
    //     第一輪 C：只查「方向」有沒有依據 → 定案利多/利空/中性
    //     第二輪 C：方向定了之後，只查「強度」合不合理 → 定案權重
    //   混在一起問，模型會用強度來遷就方向（或反之），兩者都不可靠。
    //   每輪 C 之後緊接 A 做數字校驗，避免修正過程中引入新的假數字。
    // ⚠ 只對**會影響評分**的判別跑。中性與資訊不足權重為 0，
    //   驗它不會改變任何結果，卻要多花呼叫——成本要花在有用的地方。
    const askJSON = async (prompt) => {
      try { return await askOllama(prompt, { priority: 1, temperature: NEWS_TEMP }); } catch { return null; }
    };
    const evidence = _picked.map(x => `《${x.title}》${(x.content || '').slice(0, 500)}`).join('\n');

    // （原本這裡有「第一輪 C：查方向」的獨立呼叫，2026-09-01 併入四角色挑戰那一次
    //   ——兩者都在問「這個判斷站不站得住」，分開問等於同一件事付兩次成本。
    //   合併後仍保留 dirChecked 標記與 unsupported 清單，可稽核性不變。）
    verdict = verifyNums(verdict, '方向');

    // ══ E 引用強制（使用者 2026-08-29 加入，順序 D C A E C A）══
    //   要求逐字引用原文支撐每一項主張，**程式端逐句驗證引文是否真的存在**。
    //   這是整條管線裡唯一「語意層但程式可驗證」的約束：
    //     A 只擋得住數字，C 是模型自己查自己（可能同樣幻想），
    //     E 則把主張綁到「原文裡確實存在的那句話」，引不出來就是編的。
    //   引不出任何有效引文 ⇒ 理由整段不可信 ⇒ 改判中性。
    if (verdict && (verdict.label === '利多' || verdict.label === '利空')) {
      const norm = t => String(t || '').replace(/[\s「」『』"'“”，,。．.、；;：:！!？?（）()]/g, '');
      const corpusE = norm(_picked.map(x => `${x.title} ${x.content || ''}`).join(' '));
      const pE = `以下是你對 ${it.code} ${it.name} 的判別理由。\n`
        + `請為其中的**每一項主張**，從新聞原文中**逐字引用**支撐它的句子。\n`
        + `⚠ 必須一字不差地照抄原文，不可改寫、不可拼接不同句子、不可自己加字。\n`
        + `引不出原文句子的主張，就是沒有依據的。\n\n`
        + `【判別理由】${verdict.reason || ''}\n`
        + `【強度依據】${verdict.impactPath || ''}\n\n`
        + `【新聞原文】\n${evidence}\n\n`
        + `**同時**定案強度（＝你預期市場會有多大反應）。依原文事實檢查：\n`
        + `· 量級在原文裡有沒有具體支撐（金額、比率、佔營收比重、客戶名稱）？\n`
        + `  只有形容詞（「大幅」「強勁」）而無具體數字時，強度**不得超過「中」**。\n`
        + `· 一次性項目強度上限「中」；市場已知並反映者須調降。\n`
        + `· 極強只保留給：原文有具體數字且量級極大，或明確的重大法律/監管事件。\n\n`
        + `格式（最多 3 條引用）：\n`
        + `引用1: 「逐字照抄的原文句子」\n引用2: 「…」\n引用3: 「…」\n`
        + `無法引用: （列出理由中找不到原文支撐的主張；全部都引得出來寫「無」）\n`
        + `淨化理由: （**只保留**上述引用能支撐的內容，50 字內）\n`
        + `強度依據: （原文中支撐這個強度的具體事實；沒有寫「無具體數字」）\n`
        + `定案強度: 極強/強/中/弱`;
      const rE = await askJSON(pE);
      if (rE) {
        // 主要解析：「引用N: …」。
        let quotes = [...rE.matchAll(/引用\d\s*[:：]\s*[「"']?(.+?)[」"']?\s*$/gm)]
          .map(m => m[1].trim()).filter(q => q && q !== '無' && q.length >= 6);
        // ⚠ 後備解析：模型不照格式時（換行、改標籤、只用引號）不能當成「引不出來」
        //   ——那會把有依據的判別誤殺成中性。改抓回應中所有引號片段再驗證；
        //   驗證仍然是程式做的，所以放寬解析不會放寬把關。
        if (!quotes.length) {
          quotes = [...rE.matchAll(/[「『"“]([^」』"”]{8,80})[」』"”]/g)]
            .map(m => m[1].trim()).filter(q => q && q !== '無');
        }
        const verified = quotes.filter(q => corpusE.includes(norm(q)));
        const failed = quotes.length - verified.length;
        const cleaned = (rE.match(/淨化理由\s*[:：]\s*(.+)/) || [])[1]?.trim();
        if (!verified.length) {
          // 一條有效引文都拿不出來 ⇒ 這個判別沒有原文根據
          log(`  ↳ ${it.code} 引用強制未過（${quotes.length} 條引用全部對不上原文）→ 改判中性`);
          verdict = {
            ...verdict, label: '中性', bullish: false, strength: '弱', confidence: '低',
            reason: '引用強制未過：無法從原文逐字引出支撐此判別的句子',
            quoteVerified: 0, quoteFailed: failed, gate: 'E-引用強制',
          };
        } else {
          verdict = {
            ...verdict,
            reason: (cleaned || verdict.reason || '').slice(0, 70),
            quotes: verified.slice(0, 3).map(q => q.slice(0, 60)),
            quoteVerified: verified.length, quoteFailed: failed,
            // 強度自檢已併入本次（原本是第三次呼叫）
            strengthChecked: true,
            strength: (rE.match(/定案強度\s*[:：]\s*(極強|強|中|弱)/) || [])[1] || verdict.strength,
            strengthBasis: (rE.match(/強度依據\s*[:：]\s*(.+)/) || [])[1]?.trim().slice(0, 50) || null,
            // 有引文對不上＝模型至少編了一句，其他陳述也不該完全採信
            confidence: failed > 0 ? (verdict.confidence === '高' ? '中' : '低') : verdict.confidence,
          };
          if (failed) log(`  ↳ ${it.code} 引用強制：${verified.length} 條通過、${failed} 條對不上原文（已降信心）`);
        }
      }
      verdict = verifyNums(verdict, '引用後');
    }

    // （原本這裡有「第二輪 C：查強度」的獨立呼叫，2026-09-01 併入引用強制那一次
    //   ——兩者都在檢視同一批原文證據，分開問等於把原文再讀一遍。
    //   合併後仍保留 strengthChecked 與 strengthBasis，可稽核性不變。）

    // 中性／資訊不足沒有方向，強度就沒有意義。不歸零的話畫面會出現
    // 「中性·強度強」這種自相矛盾的組合（強度是初判留下的，
    // 而中性判別不會走到第二輪 C 去修它）。
    if (verdict && (verdict.label === '中性' || verdict.label === '資訊不足')) {
      verdict = { ...verdict, strength: '弱' };
    }

    // ══ 法律事件的方向由規則決定，不交給模型（使用者 2026-08-29 明令）══
    //   「公司被搜索就應為利空，在法律判定前均屬利空」。
    // 為什麼要寫成程式：提示詞已寫過兩版「公司否認不能中和利空」，
    //   模型讀了仍判中性——3037 欣興遭檢調搜索被判「中性/高」，
    //   理由是「公司多次聲明營運正常」。**而該檔當日開→收 −7.50%**，
    //   模型錯、規則對。這是「規則只寫在提示裡就會失效」的又一例。
    // ⚠ 分工要清楚：**AI 仍負責讀內文認定事實**（被搜索的是不是本檔自己），
    //   規則只決定**方向**。這沒有違反「禁止用標題關鍵字調分」——
    //   關鍵字只用來觸發提問，主體認定由 AI 讀內文回答。
    if (verdict && negHits.length && verdict.label !== '利空') {
      const LEGAL = /檢調|搜索|搜查|約談|起訴|羈押|背信|掏空|調查/;
      if (negHits.some(h => LEGAL.test(h))) {
        const subjQ = `以下是 ${it.code} ${it.name} 的相關報導。\n`
          + _picked.map(x => `【${x.title}】${(x.content || '').slice(0, 400)}`).join('\n')
          + `\n\n只回答一個問題：這些報導中的檢調搜索／調查／起訴，`
          + `**對象是不是 ${it.name} 這家公司本身（含其子公司或負責人）**？`
          + `若對象是同業、客戶、供應商或其他公司，就不是。\n`
          + `只回：「是」或「否」，再用一句話說明對象是誰。`;
        try {
          const a2 = await askOllama(subjQ, { priority: 1, temperature: NEWS_TEMP });
          if (/^\s*是/.test(a2 || '')) {
            verdict = {
              ...verdict,
              label: '利空', bullish: false,
              confidence: verdict.confidence === '低' ? '中' : verdict.confidence,
              // ⚠ 長度要控制：原版拼出來超過 100 字，畫面截斷在句中
              //   （「…但此為公司」）反而讓資訊不完整。壓縮但兩項關鍵資訊都留：
              //   ①這是規則覆寫不是 AI 判的 ②AI 原本判什麼。
              reason: `【規則】涉檢調搜索，法律判定前視為利空（AI 原判${verdict.label}：`
                + `${(verdict.reason || '').replace(/[。\n].*$/, '').slice(0, 24)}）`,
              ruleOverride: 'legal-event',
            };
          }
        } catch { /* 二次提問失敗就維持原判，不猜 */ }
      }
    }
    } else {
      verdict = { label: '中性', bullish: false, confidence: '低', reason: 'AI 判別未回應，保守視為中性', basis, n: recent.length, nMaterial: material.length };
    }
  }
  // allTitles＝這次**抓到的全部**標題。分流管線的 seen 必須記這個，
  // 不能只記 recent：跳過判斷是拿全部抓到的新聞去比對，
  // 若 seen 只有近期視窗內的，視窗外的文章永遠看起來是新的 ⇒ 幾乎跳不掉。
  // （2026-08-29 實測：只記 recent 時 25 檔只跳過 5 檔，設計預期落空。）
  const allTitles = news.map(n => n.title).filter(Boolean);
  { // ⏱ 慢件回報：>90 秒才輸出（正常單檔 60~90 秒）。判別段含所有 LLM 輪次。
    const _total = Date.now() - _t0;
    if (_total > 90000) log(`    ⏱ ${it.code} ${it.name || ''} 慢件：總 ${(_total / 1000).toFixed(0)}s（抓取 ${(_tFetch / 1000).toFixed(0)}s、判別 ${((_total - _tFetch) / 1000).toFixed(0)}s）`);
  }
  return { verdict, events, stale, ageDays, recent, material, withBody, allTitles, picked: _pickedOut };
}

// 新聞判別的共用背景：國際盤、事件日曆、官方產業別。
// 抽出來的理由同 judgeOneStock——複製第二份必然漂移。
// wantDates：要納入事件日曆的日子（通常是「資料日」與「適用交易日」）。
async function newsJudgeContext(wantDates = []) {
  let gToday = {};
  try {
    const g = (await db.collection('squeezeTraining').doc('global').get()).data();
    const hist = g?.histJson ? JSON.parse(g.histJson) : {};
    for (const k in hist) { const ds = Object.keys(hist[k]).sort(); const d2 = ds[ds.length - 1]; if (d2) gToday[k] = hist[k][d2]; }
  } catch { /* 缺國際盤只影響背景說明 */ }
  const gLine = ['sox', 'nasdaq', 'sp500', 'n225', 'kospi', 'vix']
    .filter(k => gToday[k]).map(k => `${k} ${gToday[k].chg >= 0 ? '+' : ''}${gToday[k].chg}%`).join('、');

  let calMap = {};
  try {
    const cal = (await db.collection('catalystCalendar').doc('latest').get()).data();
    const want = new Set(wantDates.filter(Boolean));
    for (const e of (cal?.events || [])) {
      if (!e.code || !want.has(e.date)) continue;
      (calMap[e.code] ||= []).push({ date: e.date, title: e.title, type: e.type, impact: e.impact });
    }
  } catch { /* 缺日曆不擋 */ }

  let indMap = {};
  try { indMap = await getIndustryMap(); } catch { /* 沒有產業別只是少一個錨 */ }

  // M1-b 判別時點記價（2026-09-17 計畫第一段）：判別寫入時記下「當時的價格」，
  //   對答案才能從可交易的起點算（盤中趟尤其：新聞出來前的漲幅不可算成新聞效應）。
  //   來源＝marketSnapshot/latest 的 price（盤中＝最新成交、盤後＝當日收盤、晨間＝前日收盤）；
  //   pxOpen 記快照當時是否盤中，pxAt 記快照時刻——一趟共用一份，最多落後該趟的長度。
  let px = {}, pxOpen = false, pxAt = null;
  try {
    const s = (await db.collection('marketSnapshot').doc('latest').get()).data();
    const q = s?.quotesJson ? JSON.parse(s.quotesJson) : {};
    for (const c in q) if (q[c]?.price > 0) px[c] = q[c].price;
    pxOpen = !!s?.marketOpen; pxAt = s?.updatedAt ?? null;
  } catch { /* 缺價只是少記一欄，不擋判別 */ }

  return { gToday, gLine, calMap, indMap, px, pxOpen, pxAt };
}
// 判別寫入時附上的時點價欄位（batch／intraday 兩個寫入端共用，避免各自漂移）
function verdictPxFields(ctx, code) {
  const p = ctx?.px?.[code];
  return p > 0 ? { px: p, pxSrc: ctx.pxOpen ? 'live' : 'close', pxAt: ctx.pxAt ?? null } : { px: null, pxSrc: null, pxAt: null };
}

// ── 漲停預測的新聞判別（2026-08-28）──────────────────────────────────
// 為什麼做這個：漲停預測是站上唯一**沒有**新聞 AI 識讀的預測線。同日的實驗
// 證明了純籌碼＋動能的重新工程化拿不到任何增益（候選模型 vs 線上模型
// 31 日對決 107/930 vs 107/930，差距 0.00pp）——線上模型已經把那類資訊用盡。
// ⇒ 剩下唯一沒被利用的資訊就是新聞內容，這是最後一個可測的槓桿。
//
// ⚠ **不宣稱它會有效**。軋空那邊的證據是：只憑標題的判別與結果反向；讀完
//   內文的版本從 08-27 才開始累積，newsLift 目前 n=3 完全不能下結論。
//   正確做法是先接上、逐日存檔、由檢討報表算 newsLift 對答案，累積數週再說。
// ══════════════════════════════════════════════════════════════════
// 新聞內文判別管線（使用者 2026-08-29 指定的分流作法）
//
// 為什麼要分兩趟：
//   ① 台灣盤後新聞在**當日 24:00 前**陸續出齊
//   ② 國際與晨間新聞要到**隔日 06:00~07:00** 才到
//   一趟跑不完 150 檔，而且不論排在哪個時點都會錯過另一批。
//
// 晨間那趟**先過濾已判過的標題**，只在真的有新內容時才花一次 AI。
//   多數晨間稿是盤後稿的改寫（實測同故事 Dice 0.7~0.97），
//   過濾掉之後 150 檔才跑得完 08:00 的死線。
//
// ⚠ 這條管線是「新聞能不能影響分數」的唯一合法來源
//   （使用者明令：只用標題絕對禁止調分）。沒判到的股票就據實顯示
//   「未判別」，**不捏造中性值**。
// ══════════════════════════════════════════════════════════════════
// 判別用的取樣溫度。0.15 而非 0：留一點點隨機性避免模型卡在退化輸出，
// 但遠低於預設 0.8——實測預設溫度會讓同一批新聞的判別在
// 「中性」與「利多/強」之間跳動（2882 國泰金，三次跑出兩種結果）。
const NEWS_TEMP = +(process.env.NEWS_TEMP || 0.15);
const NEWS_VERDICT_N = +(process.env.NV_LIMIT || 150);    // 退回用的成交金額宇宙大小
// 安全上限（防暴走），不是刻意設限：使用者 2026-08-29 明確要求不限前 150 檔。
// 實測來源掃描一次約 110 檔，400 有充分餘裕；真的爆量時按專屬報導優先截斷。
const NEWS_VERDICT_CAP = +(process.env.NV_CAP || 400);
const NEWS_VERDICT_GAP_MS = 1200;    // 每檔之間的間隔，避免對上游造成突發負載

const _normT = t => String(t || '').replace(/[\s\p{P}]/gu, '');
const _bigrams = t => {
  const x = _normT(t), o = new Set();
  for (let i = 0; i < x.length - 1; i++) o.add(x.slice(i, i + 2));
  return o;
};
const _dice = (a, b) => {
  if (!a.size || !b.size) return 0;
  let i = 0; for (const g of a) if (b.has(g)) i++;
  return (2 * i) / (a.size + b.size);
};
// ⚠ 門檻與 src/lib/news-sentiment.ts 的 SIM_THRESHOLD 必須一致（0.6，
//   已用真實標題校準：同故事改寫 0.745~0.974、不同故事 0.000）。
//   兩份實作是不得已——daemon 是 .mjs、網站是 .ts，跨執行環境無法共用；
//   **改門檻時兩邊都要改**，這行註解就是提醒。
const TITLE_SIM = 0.6;
const titleSeen = (title, seen) => {
  if (!seen || !seen.length) return false;
  const g = _bigrams(title);
  return seen.some(s => _dice(_bigrams(s), g) >= TITLE_SIM);
};

// ══════════════════════════════════════════════════════════════════
// 來源監看式宇宙（使用者 2026-08-29 指示）
//
// 原本是「拿成交金額前 150 檔，逐檔問有沒有新聞」——問法是反的：
//   ① 問 150 次，其中大半根本沒有新聞（純浪費）
//   ② 有大新聞的中小型股因為排不進前 150，**永遠看不到**
//   ③ 150 檔 × 每檔 6 次查詢 ≈ 900 次上游請求
// 改成「先問一次今天哪些股票在新聞裡」，宇宙自然＝真的有新聞可判的股票，
// 也自然不受 150 限制。實測：5 次抓取 → 305 則標題 → 110 檔。
//
// ⚠ 工商時報直接抓 RSS 是 403，必須走 Google News 的 site: 查詢（實測 100 則）。
// ══════════════════════════════════════════════════════════════════
const NEWS_SWEEP_FEEDS = [
  ['經濟日報', 'https://money.udn.com/rssfeed/news/1001/5591?ch=money'],
  ['經濟日報', 'https://money.udn.com/rssfeed/news/1001/5590?ch=money'],
  ['鉅亨網',   'https://news.cnyes.com/rss/v1/news/category/tw_stock'],
  ['工商時報', null],   // null ⇒ 走 Google News site: 查詢（直接抓 403）
  ['MoneyDJ',  null],
  ['財政部',   null],
  ['經濟部',   null],
];
// 新聞視窗的起點是**上一個交易日**，不是「今天減 N 天」（使用者 2026-08-31 指示）。
// 固定 4 天跨得過週末，但**跨不過長假**——春節休 9 天的話，
// 假期間累積的新聞會整段漏掉，而那些正是開盤後要反應的。
// 下限 2 天（連續交易日之間也要留一點餘裕），上限 12 天（防日曆異常）。
function newsSweepMaxAgeMs() {
  try {
    const today = isoDate(taipei());
    const prev = prevTradingIsos(today, 2)[1];           // 上一個交易日
    if (!prev) return 4 * 86400000;
    const gapMs = new Date(`${today}T00:00:00+08:00`).getTime()
      - new Date(`${prev}T00:00:00+08:00`).getTime();
    // 從上一個交易日的開盤前算起，再加一天涵蓋當日
    return Math.min(12 * 86400000, Math.max(2 * 86400000, gapMs + 86400000));
  } catch { return 4 * 86400000; }
}
const NEWS_SWEEP_SITE = { 工商時報: 'ctee.com.tw', MoneyDJ: 'moneydj.com', 財政部: 'mof.gov.tw', 經濟部: 'moea.gov.tw' };

// 來源名會被誤認成股票（實測「工商時報」→ 認出「時報」）⇒ 比對前先剝掉尾巴
const stripNewsSuffix = t => String(t || '')
  .replace(/\s*[-|–—]\s*(證券|日報|產業|商情|新聞|熱門股|台股)\s*[-|–—]\s*.*$/, '')
  .replace(/\s*[-|–—]\s*(工商時報|經濟日報|MoneyDJ|鉅亨網|自由財經|中央社|Yahoo奇摩股市)\s*$/, '')
  .replace(/\s*\|\s*[^|]{2,12}\s*\|\s*[^|]{2,12}\s*$/, '');

// 方位／範圍字開頭的複合詞會把兩字公司名包進去（實測「東南亞」→ 認出「南亞」）。
// ⚠ 只擋這一類。曾試過「後面接中文就否決」，結果誤殺「台聚集團」的台聚、
//   「華夏強攻」的華夏——中文公司名後面本來就常接動詞名詞，那條規則在中文行不通
//   （實測宇宙從 110 掉到 70，全是誤殺）。
const NAME_TRAP_PREFIX = '東西南北中大小新舊上下前後內外全泛環跨';

async function sweepNewsSources() {
  const out = [];
  const seen = new Set();
  const now = Date.now();
  const maxAgeMs = newsSweepMaxAgeMs();
  let dropOld = 0, dropNoDate = 0;
  await Promise.all(NEWS_SWEEP_FEEDS.map(async ([src, url]) => {
    const u = url || `https://news.google.com/rss/search?q=${encodeURIComponent('site:' + NEWS_SWEEP_SITE[src])}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
    try {
      const r = await fetch(u, { headers: _NEWS_UA, signal: AbortSignal.timeout(15000) });
      if (!r.ok) { log(`  ↳ 來源掃描 ${src} HTTP ${r.status}`); return; }
      const xml = await r.text();
      for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)) {
        const it = m[0];
        const pick = tag => {
          const g = it.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
          return g ? g[1].trim() : '';
        };
        const title = pick('title'); if (!title) continue;
        const key = stripNewsSuffix(title).slice(0, 30);
        if (seen.has(key)) continue;          // 同一則被多來源收錄只留一份
        seen.add(key);
        const pub = pick('pubDate');
        const at = pub ? new Date(pub).getTime() : 0;
        // ⚠ **必須擋年齡**（2026-08-29 實測）：政府來源經 Google News 回來的
        //   幾乎都是陳年法規文件——財政部中位年齡 **1166 天**（96% 超過 3 天）、
        //   經濟部中位 4.9 天、最舊到 7730 天（21 年前）。工商時報也混進一則 6239 天的。
        //   不擋的話，三年前稅務函釋裡提到的股票會被當成「今天有新聞」進入宇宙。
        //   窗口取 4 天：足以跨過週末（週五的新聞在週一仍然有效）。
        if (!at) { dropNoDate++; continue; }        // 無日期＝無法驗證新鮮度，寧可不要
        if (now - at > maxAgeMs) { dropOld++; continue; }
        out.push({ src, title, link: pick('link'), at });
      }
    } catch (e) { log(`  ↳ 來源掃描 ${src} 失敗: ${(e.message || '').slice(0, 40)}`); }
  }));
  // 據實記錄丟掉了多少，否則「宇宙變小」會查不出原因
  if (dropOld || dropNoDate) log(`  ↳ 來源掃描濾除：過舊 ${dropOld} 則、無日期 ${dropNoDate} 則（視窗 ${(maxAgeMs / 86400000).toFixed(0)} 天＝上一交易日起算）`);
  return out;
}

// 從標題認出個股。長名優先，避免「大立」吃掉「大立光」。
function extractCodesFromTitle(rawTitle, nameList, quotes) {
  const t = stripNewsSuffix(rawTitle);
  const taken = [];
  const out = new Set();
  for (const m of t.matchAll(/[（(]\s*([1-9]\d{3})\s*[）)]/g)) if (quotes[m[1]]) out.add(m[1]);
  for (const [code, nm] of nameList) {
    let i = t.indexOf(nm);
    while (i >= 0) {
      if (!taken.some(([a, b]) => i < b && i + nm.length > a)) {
        const before = i > 0 ? t[i - 1] : '';
        // 三字以上的名稱幾乎不會被包進更長的詞，只有兩字名要擋
        if (nm.length >= 3 || !(before && NAME_TRAP_PREFIX.includes(before))) {
          taken.push([i, i + nm.length]);
          out.add(code);
        }
      }
      i = t.indexOf(nm, i + 1);
    }
  }
  return [...out];
}

// 來源監看式宇宙：回傳 [{code, name, articles:[{title,link,src,at,coMentions}]}]
// coMentions＝這篇文章同時提到幾檔。使用者 2026-08-29 提醒「一篇有多檔」——
//   一篇「概念股清單」列 20 檔若照單全收，等於 20 檔各拿一次利多，
//   那是重複計分換個形式重演。所以把它記下來交給判別階段揭露。
async function newsDrivenUniverse() {
  const snap = (await db.collection('marketSnapshot').doc('latest').get()).data();
  if (!snap?.quotesJson) return [];
  const quotes = JSON.parse(snap.quotesJson);
  const nameList = Object.entries(quotes)
    .filter(([, v]) => v?.name && v.name.length >= 2)
    .map(([c, v]) => [c, v.name])
    .sort((a, b) => b[1].length - a[1].length);

  const articles = await sweepNewsSources();
  const byCode = new Map();
  let withStock = 0;
  for (const a of articles) {
    const codes = extractCodesFromTitle(a.title, nameList, quotes);
    if (!codes.length) continue;
    withStock++;
    for (const c of codes) {
      if (!byCode.has(c)) byCode.set(c, { code: c, name: quotes[c].name, articles: [] });
      byCode.get(c).articles.push({ ...a, coMentions: codes.length });
    }
  }
  const rows = [...byCode.values()];
  // 排序：專屬報導（coMentions 少）且篇數多的優先——被順帶提及的排後面，
  // 這樣遇到死線截斷時，被砍掉的是最邊緣的。
  rows.sort((x, y) =>
    y.articles.length - x.articles.length ||
    Math.min(...x.articles.map(a => a.coMentions)) - Math.min(...y.articles.map(a => a.coMentions)));
  log(`  ↳ 來源掃描：${articles.length} 則標題 → ${withStock} 篇認出個股 → 宇宙 ${rows.length} 檔`);
  return rows;
}

// 判別宇宙＝成交金額前 N 檔（取自 chipArchive，PIT 安全）。
// 用成交金額而非漲幅：使用者會看的是熱門股，而漲幅榜每天洗牌，
// 用它當宇宙會讓「昨天判過的標題」幾乎無法複用，晨間那趟就跑不完。
async function newsVerdictUniverse(n = NEWS_VERDICT_N) {
  // 用 marketSnapshot 而非 chipArchive：它同時有 name 與 value（成交金額），
  // 一次讀取就解決「排序」與「名稱」兩件事（名稱是 judgeOneStock 的搜尋關鍵字，
  // 沒有名稱只用代號會抓不到新聞）。
  const snap = (await db.collection('marketSnapshot').doc('latest').get()).data();
  if (!snap?.quotesJson) return [];
  const q = JSON.parse(snap.quotesJson);
  const rows = [];
  for (const code in q) {
    const x = q[code];
    if (!x || !x.name) continue;
    const v = +x.value || (+x.price || 0) * (+x.volume || 0);
    if (!(v > 0)) continue;
    rows.push({ code, name: x.name, value: v });
  }
  rows.sort((a, b) => b.value - a.value);
  return rows.slice(0, n);
}

// 新聞判別完成訊號（使用者 2026-09-01 指示：完成任務時應出現訊號提示）。
//   四趟判別都用它，訊息裡帶「這一趟做了什麼、結果長怎樣」——
//   只寫「完成」等於沒說，使用者無法判斷結果是否正常。
// ⚠ 突發利空提高嚴重度：盤中冒出利空是當日最該立刻知道的事。
async function pushVerdictDone(pass, { judged = 0, skipped = 0, failed = 0, stopped = false, verdicts = {}, targetDate = '' }) {
  const PASS_LABEL = { evening: '盤後', morning: '晨間', intraday: '盤中', night: '夜間補判' };
  const label = PASS_LABEL[pass] || pass;
  const now = Date.now();
  const fresh = Object.entries(verdicts).filter(([, v]) => now - (v.at || 0) < 3 * 3600000);
  const dist = {};
  for (const [, v] of fresh) dist[v.label] = (dist[v.label] || 0) + 1;
  const bear = fresh.filter(([, v]) => v.label === '利空');
  const bull = fresh.filter(([, v]) => v.label === '利多' && (v.strength === '強' || v.strength === '極強'));
  const distTxt = Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}${n}`).join('·') || '無';
  const parts = [`判別 ${judged}`, skipped ? `沿用 ${skipped}` : null, failed ? `失敗 ${failed}` : null,
    stopped ? '**因死線提前停止**' : null].filter(Boolean);
  await pushAgentMsg({
    type: 'newsVerdict',
    label: `${label}新聞識讀完成`,
    emoji: bear.length ? '⚠️' : '📰',
    severity: bear.length ? 'warn' : 'info',
    text: `${parts.join('·')}｜${distTxt}`
      + (bear.length ? `\n⚠ 利空：${bear.slice(0, 3).map(([c, v]) => `${c}(${v.strength})`).join('、')}` : '')
      + (bull.length ? `\n利多強：${bull.slice(0, 3).map(([c]) => c).join('、')}` : ''),
    summary: `${label}判別完成 ${judged} 檔${bear.length ? `·利空 ${bear.length}` : ''}`,
    stocks: [...bear, ...bull].slice(0, 5).map(([c]) => c),
    // 同一趟不重複推送；盤中每 25 分鐘一趟，冷卻 20 分鐘避免洗版
    dedupeKey: `nv_${pass}_${targetDate}`,
    cooldownMs: pass === 'intraday' ? 20 * 60000 : 6 * 3600000,
  });
}

// ══ 夜間覆蓋率補判（使用者 2026-09-01 指示：夜間 Ollama 很閒，安排工作）══
//
// 要解決的缺口：宇宙來自「來源掃描」，掃不到的股票就沒有判別
//   ⇒ 推薦榜 62 檔中只有 31 檔有判別，**一半的股票使用者看不到新聞面**。
// 但 fetchStockNewsMulti 會**逐檔搜尋**（經濟日報/工商時報/Yahoo/GoogleNews），
//   找得到掃描漏掉的新聞——只是每檔都要花時間，白天沒有餘裕。
//
// 夜間時段（實測）：
//   23:00-01:15 盤後趟 → 01:15-02:00 閒置 → 02:00-02:30 訓練 → 02:30-06:40 閒置
//   ⇒ 約 4 小時 55 分可用，以 90 秒/檔算可補判約 190 檔。
//
// ⚠ 只補「使用者實際看得到」的股票：推薦榜、軋空候選、漲停預測。
//   全市場 2000 檔補不完，也沒必要——沒人看的股票判了也是浪費。
// ⚠ D 拒答門檻照常生效：逐檔搜尋若仍無內文或本檔零提及，就判「資訊不足」，
//   不會為了衝覆蓋率而編造判別。
async function computeNightBackfill(deadlineMins = 6 * 60 + 30) {
  const tw = taipei();
  const today = newsVerdictTargetIso('evening', tw);
  const ref = db.collection('newsVerdict').doc(today);
  const prev = (await ref.get()).data() || {};
  const verdicts = prev.verdictJson ? JSON.parse(prev.verdictJson) : {};
  const seenAll = prev.seenJson ? JSON.parse(prev.seenJson) : {};

  // 蒐集「使用者看得到」的股票
  const want = new Map();
  const add = (code, name, src) => {
    if (!code || !/^[1-9]\d{3}$/.test(code) || verdicts[code]) return;   // 已有判別就不重判
    if (!want.has(code)) want.set(code, { code, name: name || code, srcs: [] });
    want.get(code).srcs.push(src);
  };
  try {
    const snap = (await db.collection('marketSnapshot').doc('latest').get()).data();
    const q = snap?.quotesJson ? JSON.parse(snap.quotesJson) : {};
    const nameOf = c => q[c]?.name || c;
    for (const [col, doc, key, label] of [
      ['aiRecommend', 'latest', 'recommendations', '推薦榜'],
      ['squeezeSetup', 'latest', 'items', '軋空候選'],
      ['limitUpForecast', 'latest', 'aList', '漲停預測'],
    ]) {
      try {
        const d = (await db.collection(col).doc(doc).get()).data() || {};
        for (const x of (d[key] || []).slice(0, 60)) add(x.code || x, nameOf(x.code || x), label);
      } catch { /* 單一來源缺就跳過 */ }
    }
  } catch (e) { log('✖ 夜間補判：讀不到清單', (e.message || '').slice(0, 40)); return false; }

  if (!want.size) { log('  ↳ 夜間補判：清單中的股票都已有判別，無事可做'); return true; }

  const dlTs = (() => {
    const now = tw.getHours() * 60 + tw.getMinutes();
    return tw.getTime() + ((deadlineMins - now) + (deadlineMins <= now ? 1440 : 0)) * 60000;
  })();
  const ctx = await newsJudgeContext([today]);
  const rows = [...want.values()];
  let judged = 0, thin = 0, stopped = false;
  log(`  ↳ 夜間補判：${rows.length} 檔待補（推薦榜/軋空/漲停中尚無判別者）`);
  for (const u of rows) {
    if (taipei().getTime() >= dlTs) { stopped = true; break; }
    try {
      const r = await withTimeout(judgeOneStock({ code: u.code, name: u.name }, ctx, {}), STOCK_TIMEOUT_MS, `夜補 ${u.code}`);
      const v = r?.verdict;
      if (!v) continue;
      if (v.label === '資訊不足') { thin++; }      // 據實記錄，不算失敗
      verdicts[u.code] = {
        label: v.label, confidence: v.confidence, strength: v.strength || '中', reason: v.reason,
        basis: v.basis, n: v.n, pass: 'night', at: Date.now(),
        keyQuote: v.keyQuote || null, impactPath: v.impactPath || null, priced: v.priced || null,
        eventType: v.eventType || null, certainty: v.certainty || null, novelty: v.novelty || null,
        ...verdictPxFields(ctx, u.code),
        challenged: !!v.challenged, dirChecked: !!v.dirChecked, strengthChecked: !!v.strengthChecked,
        strengthBasis: v.strengthBasis || null, quotes: v.quotes || null,
        quoteVerified: v.quoteVerified ?? null, gate: v.gate || null,
        unverifiedNums: v.unverifiedNums || null, revision: v.revision || null,
        srcList: u.srcs.join('／'),
      };
      seenAll[u.code] = [...new Set([...(seenAll[u.code] || []), ...(r.allTitles || [])])].slice(-90);
      judged++;
      if (judged % 20 === 0) {
        await ref.set({ verdictJson: JSON.stringify(verdicts), seenJson: JSON.stringify(seenAll), updatedAt: Date.now() }, { merge: true });
      }
    } catch (e) { log(`  ↳ 夜補 ${u.code}: ${(e.message || '').slice(0, 40)}`); }
  }
  await ref.set({
    date: today, targetDate: today, dataDate: isoDate(tw), updatedAt: Date.now(),
    lastPass: 'night', verdictJson: JSON.stringify(verdicts), seenJson: JSON.stringify(seenAll),
  }, { merge: true });
  await db.collection('newsVerdict').doc('latest').set({
    date: today, targetDate: today, updatedAt: Date.now(), lastPass: 'night',
    covered: Object.keys(verdicts).length, verdictJson: JSON.stringify(verdicts),
  });
  log(`✓ 夜間補判：新增 ${judged} 檔（其中資訊不足 ${thin}）` +
      `${stopped ? '·**因死線停止**' : ''}，總覆蓋 ${Object.keys(verdicts).length} 檔`);
  await pushVerdictDone('night', { judged, failed: thin, stopped, verdicts, targetDate: today });
  return judged > 0 || thin > 0;
}

// ══ 新聞判別的對答案（newsLift）══════════════════════════════════
// 為什麼一定要有這個：±20 的調分是評分器裡最大的單一槓桿，而現在的係數
//   是**設計值不是量出來的**。2026-08-29 把它從「標題關鍵字」換成
//   「AI 讀完內文」，理由是前者被證實與結果反向；但「讀內文比較好」
//   本身也還沒有樣本外證據。沒有這個對答案機制，它會永遠停在「看起來合理」。
//
// 口徑（寫死在這裡，避免日後漂移）：
//   判別在**開盤前**就已存在（盤後趟前一晚、晨間趟當日 07:00），
//   所以可據以在開盤進場 ⇒ 標的＝**適用交易日的開盤→收盤報酬**。
//   用 doc 的 targetDate 對齊，不是產生日（generatedOn）。
async function computeNewsVerdictReview(days = 40) {
  const arch = await readArchive(days + 2, 'closeJson');
  if (arch.length < 2) return false;
  const byDate = {};
  for (const a of arch) byDate[a.date] = JSON.parse(a.closeJson || '{}');

  const snap = await db.collection('newsVerdict')
    .orderBy('targetDate', 'desc').limit(days).get();

  const groups = { 利多: [], 利空: [], 中性: [] };
  let usedDays = 0;
  for (const d of snap.docs) {
    // ⚠ 跳過 latest：它是同一批判別的鏡像（同樣帶 targetDate 與 verdictJson），
    //   不排除的話最近那個交易日會被重複計入一次，樣本數與均值都會偏。
    //   這種「摘要文件混進歷史查詢」的錯誤很難從結果看出來——
    //   數字看起來完全合理，只是其中一天的權重是兩倍。
    if (d.id === 'latest') continue;
    const x = d.data();
    const day = x.targetDate;
    if (!day || !byDate[day]) continue;          // 該交易日還沒收盤／無存檔 ⇒ 跳過
    const v = x.verdictJson ? JSON.parse(x.verdictJson) : {};
    let used = 0;
    for (const code in v) {
      const row = byDate[day][code];
      if (!Array.isArray(row)) continue;
      const close = +row[0], open = +row[2];
      if (!(open > 0) || !(close > 0)) continue;  // 缺 OHLC 就跳過，不用收盤頂替
      const label = v[code].label;
      if (!groups[label]) continue;
      groups[label].push({ day, code, ret: (close - open) / open * 100, conf: v[code].confidence });
      used++;
    }
    if (used) usedDays++;
  }

  const stat = arr => {
    if (!arr.length) return { n: 0, mean: null, win: null };
    const mean = arr.reduce((a, x) => a + x.ret, 0) / arr.length;
    const win = arr.filter(x => x.ret > 0).length / arr.length * 100;
    return { n: arr.length, mean: +mean.toFixed(3), win: +win.toFixed(1) };
  };
  const bull = stat(groups.利多), bear = stat(groups.利空), neu = stat(groups.中性);
  // newsLift ＝ 判利多組相對中性組的超額。中性組是這條策略的對照組。
  const lift = (bull.mean != null && neu.mean != null) ? +(bull.mean - neu.mean).toFixed(3) : null;

  await db.collection('newsVerdictReview').doc('summary').set({
    updatedAt: Date.now(),
    basis: '適用交易日的開盤→收盤報酬(%)；判別於開盤前既有，故可據以進場',
    days: usedDays,
    bull, bear, neutral: neu,
    newsLift: lift,
    // ⚠ 樣本不足時**不給結論**，也不要讓下游誤以為已驗證
    conclusive: !!(bull.n >= 200 && neu.n >= 200 && usedDays >= 15),
    note: '樣本未達門檻前不得據此調整係數。非投資建議。',
  });
  log(`✓ 新聞判別對答案：利多 n=${bull.n} 均值 ${bull.mean}%｜中性 n=${neu.n} 均值 ${neu.mean}%｜` +
      `利空 n=${bear.n} 均值 ${bear.mean}%｜newsLift ${lift}％（${usedDays} 個交易日）` +
      `${(bull.n >= 200 && neu.n >= 200 && usedDays >= 15) ? '' : ' ← 樣本不足，尚不能下結論'}`);
  // ⚠ 找不到任何可對答案的交易日時**不可回報成功**：
  //   排程是「成功才標記今日已跑」，回 true 等於這天不再重試。
  //   15:30 跑時若當日 chipArchive 還沒寫入（歸檔在 15:10，偶爾延遲），
  //   就會整天算不到 newsLift 而且無人知曉——這正是 dayTradeRatio
  //   斷 8 天的同型錯誤（單次嘗試、失敗不重試、靜默）。
  // ── M1 多口徑分組對答案（2026-09-17 計畫第一段·docs/NEWS-VERDICT-LEARNING-PLAN-2026-09-17.md）──
  //   單一「開→收」口徑看不出錯在哪一層：新聞效應可能在跳空就出完、也可能延到 5 日。
  //   這裡對同一批判別另算 gap(昨收→今開)／o2c／c2c／d5x(開盤進場→第 5 個交易日收盤，扣同日宇宙等權)，
  //   並依 label×{confidence,strength,priced,basis,pass} 分組，寫 newsVerdictReview/breakdown。
  //   只記錄、不影響任何評分；樣本不足的組 n 照實列，讀的人自己看 n。
  try {
    const dates = arch.map(a => a.date).sort();                 // 舊→新
    const idx = Object.fromEntries(dates.map((d, i) => [d, i]));
    const uniMean = {};                                          // 每日宇宙等權：o2c 與 d5（開→t+4 收）
    const uni = (day) => {
      if (uniMean[day]) return uniMean[day];
      const i = idx[day]; const m = byDate[day]; const m5 = dates[i + 4] ? byDate[dates[i + 4]] : null;
      let s1 = 0, n1 = 0, s5 = 0, n5 = 0;
      for (const c in m) { const r = m[c]; if (!(r?.[2] > 0) || !(r?.[0] > 0)) continue; s1 += (r[0] - r[2]) / r[2] * 100; n1++; const q = m5?.[c]; if (q?.[0] > 0) { s5 += (q[0] - r[2]) / r[2] * 100; n5++; } }
      return (uniMean[day] = { o2c: n1 ? s1 / n1 : null, d5: n5 ? s5 / n5 : null });
    };
    const rows = [];
    for (const d of snap.docs) {
      if (d.id === 'latest') continue;
      const x = d.data(); const day = x.targetDate; if (!day || !byDate[day] || idx[day] == null) continue;
      const prevDay = dates[idx[day] - 1], d5Day = dates[idx[day] + 4];
      const v = x.verdictJson ? JSON.parse(x.verdictJson) : {};
      for (const code in v) {
        const r = byDate[day][code]; if (!Array.isArray(r) || !(r[0] > 0) || !(r[2] > 0)) continue;
        const p = prevDay ? byDate[prevDay]?.[code]?.[0] : null; const c5 = d5Day ? byDate[d5Day]?.[code]?.[0] : null;
        const u = uni(day);
        const o2c = (r[0] - r[2]) / r[2] * 100;
        const px = v[code].px > 0 ? v[code].px : null;   // M1-b：判別時點價（盤後／晨間趟＝前收，盤中趟＝當時成交價）
        rows.push({ v: v[code], gap: p > 0 ? (r[2] - p) / p * 100 : null, o2c, o2cx: u.o2c != null ? o2c - u.o2c : null,
          c2c: p > 0 ? (r[0] - p) / p * 100 : null, d5x: (c5 > 0 && u.d5 != null) ? (c5 - r[2]) / r[2] * 100 - u.d5 : null,
          pxc: px ? (r[0] - px) / px * 100 : null, px5: (px && c5 > 0) ? (c5 - px) / px * 100 : null });
      }
    }
    const H = ['gap', 'o2c', 'o2cx', 'c2c', 'd5x', 'pxc', 'px5'];
    const stat = (arr) => { const o = { n: arr.length }; for (const h of H) { const a = arr.map(r => r[h]).filter(x => x != null); o[h] = a.length ? { n: a.length, mean: +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(3), win: +(a.filter(x => x > 0).length / a.length * 100).toFixed(1) } : null; } return o; };
    const groups = {};
    const add = (k, r) => (groups[k] ||= []).push(r);
    for (const r of rows) {
      const L = r.v.label || '?'; add(`label=${L}`, r);
      for (const f of ['confidence', 'strength', 'priced', 'basis', 'pass', 'eventType', 'certainty', 'novelty', 'pxSrc']) add(`label=${L}|${f}=${r.v[f] ?? 'null'}`, r);
    }
    const out = {}; for (const k in groups) out[k] = stat(groups[k]);
    await db.collection('newsVerdictReview').doc('breakdown').set({
      updatedAt: Date.now(), days: usedDays, rows: rows.length,
      horizons: 'gap=昨收→今開｜o2c=今開→今收｜o2cx=o2c−同日宇宙等權｜c2c=昨收→今收｜d5x=今開→第5個交易日收−同日宇宙等權｜pxc=判別時點價→今收｜px5=判別時點價→第5個交易日收（%；px 自 2026-09-17 起才有）',
      groups: out, note: '只記錄不加權；分組 n 小的不可下結論。非投資建議。',
    });
    const g = k => out[k] ? `${k}: n=${out[k].n} o2cx ${out[k].o2cx?.mean ?? '—'} d5x ${out[k].d5x?.mean ?? '—'}` : '';
    log(`  · 分組對答案：${g('label=利多|priced=否')}｜${g('label=利多|priced=是')}｜${g('label=中性')}｜${g('label=利空')}`);
  } catch (e) { log('  ⚠ 分組對答案失敗:', (e.message || '').slice(0, 80)); }
  return usedDays > 0;
}

// ══ 盤中即時新聞判別（使用者 2026-08-31 指示）══════════════════
//   判別原本只跑盤後 23:00 與盤前 07:00 ⇒ **盤中發生的事完全看不到**，
//   而那正是當日影響最大的一類：
//     欣興 3037 盤中遭檢調搜索 → 當日開→收 −7.50%
//     世界先進工廠失火
//   這類消息盤前不存在，隔天才判別已經沒有意義。
//
// 設計上刻意「輕」：
//   · 只看**最近 45 分鐘內發佈**的文章，不重掃整個視窗
//   · 已判過的標題直接跳過（沿用 seen 機制）
//   · 硬死線，絕不佔住盤中其他工作
//   · 判別寫進當日 doc，網站立即讀得到
async function computeIntradayNewsVerdict(windowMin = 45, deadlineMin = 12) {
  const tw = taipei();
  const today = isoDate(tw);
  const ref = db.collection('newsVerdict').doc(today);
  const prev = (await ref.get()).data() || {};
  const verdicts = prev.verdictJson ? JSON.parse(prev.verdictJson) : {};
  const seenAll = prev.seenJson ? JSON.parse(prev.seenJson) : {};

  const rows = await newsDrivenUniverse();
  const cut = Date.now() - windowMin * 60000;
  // 只留「最近 windowMin 分鐘內有新文章」的個股
  const hot = rows.filter(r => r.articles.some(a => (a.at || 0) >= cut));
  if (!hot.length) return true;                  // 沒有新消息＝正常，不是失敗

  const deadlineTs = Date.now() + deadlineMin * 60000;
  const ctx = await newsJudgeContext([today]);
  let judged = 0, skipped = 0, hit = [];
  for (const u of hot) {
    if (Date.now() >= deadlineTs) break;
    try {
      const r = await withTimeout(judgeOneStock({ code: u.code, name: u.name }, ctx, { seenTitles: seenAll[u.code] || [] }), STOCK_TIMEOUT_MS, `盤中判別 ${u.code}`);
      if (r?.skipped) { skipped++; continue; }
      const v = r?.verdict;
      if (!v) continue;
      verdicts[u.code] = {
        label: v.label, confidence: v.confidence, strength: v.strength || '中', reason: v.reason,
        basis: v.basis, n: v.n, pass: 'intraday', at: Date.now(),
        keyQuote: v.keyQuote || null, impactPath: v.impactPath || null,
        priced: v.priced || null, challenge: v.challenge || null,
        eventType: v.eventType || null, certainty: v.certainty || null, novelty: v.novelty || null,
        ...verdictPxFields(ctx, u.code),
        challenged: !!v.challenged, revision: v.revision || null,
        gate: v.gate || null, unverifiedNums: v.unverifiedNums || null,
        dirChecked: !!v.dirChecked, strengthChecked: !!v.strengthChecked,
        strengthBasis: v.strengthBasis || null,
        quotes: v.quotes || null, quoteVerified: v.quoteVerified ?? null,
      };
      seenAll[u.code] = [...new Set([...(seenAll[u.code] || []), ...(r.allTitles || [])])].slice(-90);
      judged++;
      // 盤中的重點是突發利空——把它們單獨記下來，供前端與告警使用
      if (v.label === '利空') hit.push(`${u.code}${u.name}(${v.strength})`);
    } catch { /* 單檔失敗不擋整輪 */ }
  }
  if (!judged && !skipped) return true;
  await ref.set({
    date: today, targetDate: today, dataDate: isoDate(tw), updatedAt: Date.now(),
    lastPass: 'intraday', intradayAt: Date.now(),
    verdictJson: JSON.stringify(verdicts), seenJson: JSON.stringify(seenAll),
  }, { merge: true });
  await db.collection('newsVerdict').doc('latest').set({
    date: today, targetDate: today, updatedAt: Date.now(), lastPass: 'intraday',
    covered: Object.keys(verdicts).length, verdictJson: JSON.stringify(verdicts),
  });
  log(`✓ 盤中新聞判別：新消息 ${hot.length} 檔 → 判別 ${judged}、沿用 ${skipped}` +
      `${hit.length ? `　⚠ 突發利空：${hit.join('、')}` : ''}`);
  await pushVerdictDone('intraday', { judged, skipped, verdicts, targetDate: today });
  return true;
}

// pass: 'evening'（盤後）| 'morning'（國際與晨間，只處理新標題）
// deadlineMins: 台北時間的分鐘數死線，超過就停（晨間那趟必須讓位給 08:00）
// 這批判別是**給哪一個交易日用的**（＝存檔的鍵）。
//   盤後趟 23:00 → 下一個交易日（週五晚上判的是給週一用的）
//   晨間趟 07:00 → 當日（若當日是交易日；09:00 開盤前完成）
// ⚠ 一定要用適用交易日而不是日曆日（2026-08-29 設計時修正）：
//   否則週五晚與週一早這兩趟**同樣是給週一用的判別會落在兩個不同的 doc**，
//   將來要算 newsLift 對答案時根本無法確定「這批是給哪天用的」，
//   驗證會從一開始就失效。順帶：兩趟寫同一個 doc 之後，
//   晨間趟自然讀得到盤後趟的 seen 清單，跨日承接的特例也就不需要了。
function newsVerdictTargetIso(pass, tw) {
  if (pass === 'morning' && isTradingDay(tw)) return isoDate(tw);
  const d = new Date(tw.getTime());
  do { d.setDate(d.getDate() + 1); } while (!isTradingDay(d));
  return isoDate(d);
}

// deadlineMins：台北時間的「幾點幾分」死線（分鐘數）。
// ⚠ 必須換算成**絕對時間戳**再比較，不能拿當下的 mins 直接比：
//   盤後趟 23:00 開跑、死線 05:00 ⇒ 1380 >= 300 為真，會立刻停止。
//   跨午夜是這條管線的常態（盤後趟本來就跨日），這個 bug 一定會踩到。
async function computeNewsVerdictBatch(pass, deadlineMins = null) {
  const tw = taipei();
  const deadlineTs = deadlineMins == null ? null : (() => {
    const nowMins = tw.getHours() * 60 + tw.getMinutes();
    const addDays = deadlineMins <= nowMins ? 1 : 0;   // 死線已過今日該時刻 ⇒ 指的是明天
    return tw.getTime() + ((deadlineMins - nowMins) + addDays * 1440) * 60000;
  })();
  const today = newsVerdictTargetIso(pass, tw);   // ＝適用交易日
  const ref = db.collection('newsVerdict').doc(today);
  const prev = (await ref.get()).data() || {};
  let verdicts = prev.verdictJson ? JSON.parse(prev.verdictJson) : {};
  let seenAll = prev.seenJson ? JSON.parse(prev.seenJson) : {};

  // ⚠ **日界問題**（差點漏掉）：晨間那趟在隔日 07:00 跑，doc(today) 是全新的，
  //   seen 為空 ⇒ 什麼都跳不掉，省錢設計整個失效；而且前一晚判過的股票
  //   在新文件裡會變成「沒有判別」，等於每天早上把昨晚的成果丟掉。
  //   使用者的規格就寫明了「有前日盤後相同標題新聞就略過」。
  //   改用適用交易日為鍵之後，同一天的兩趟已經共用一個 doc，
  //   這裡只剩「跨交易日」的承接（例如週一早上想跳過上週五就判過的標題）。
  //   只承接**前一個交易日**，再舊的不承接：判別會過期，
  //   拿一週前的判別去影響今天的分數比沒有判別更糟。
  if (!Object.keys(seenAll).length || !Object.keys(verdicts).length) {
    const yIso = prevTradingIsos(today, 2)[1] || isoDate(new Date(tw.getTime() - 86400000));
    const y = (await db.collection('newsVerdict').doc(yIso).get()).data();
    if (y) {
      const yv = y.verdictJson ? JSON.parse(y.verdictJson) : {};
      const ys = y.seenJson ? JSON.parse(y.seenJson) : {};
      // 承接的判別標記來源日，讓下游看得出它不是今天新判的
      // ⚠ 承接要**設保存期限**：這裡是「今日空就整份複製前一日」，
      //   等於每天繼承前一天的全部 ⇒ 判別單向累積，數月後 latest 會存著
      //   上千筆早已過時的判別，而且會被送到前端。
      //   評分端雖有時效衰減（過期權重歸零），但那是最後一道，
      //   不該讓上游先累積一堆垃圾再靠下游擋。
      //   7 天：比最長的新聞有效期（10 日）短，確保過期的不會被承接進來。
      const CARRY_MAX_MS = 7 * 86400000;
      const nowMs = Date.now();
      let dropped = 0;
      for (const c in yv) {
        if (verdicts[c]) continue;
        if (!yv[c]?.at || nowMs - yv[c].at > CARRY_MAX_MS) { dropped++; continue; }
        // 承接的判別時點價屬於前一個適用日，對今天無意義 ⇒ 清掉（不然 pxc 會拿錯日的起點算）
        verdicts[c] = { ...yv[c], carriedFrom: yIso, px: null, pxSrc: null, pxAt: null };
      }
      if (dropped) log(`  ↳ 承接時丟棄 ${dropped} 筆逾 7 日的舊判別`);
      for (const c in ys) if (!seenAll[c]) seenAll[c] = ys[c];
      log(`  ↳ 承接前一日(${yIso})：判別 ${Object.keys(yv).length} 檔、已見標題 ${Object.keys(ys).length} 檔`);
    }
  }

  // 來源監看式宇宙（使用者 2026-08-29 改用）：宇宙＝真的有新聞的股票，不受前 150 限制。
  // 掃不到時退回成交金額前 N 檔——但要誠實說清楚：**這不是真正的備援**。
  // 兩條路都要靠 marketSnapshot 取得代號↔名稱對照（沒有名稱就沒有搜尋
  // 關鍵字，也無法從標題認出個股），所以 marketSnapshot 掛掉時兩條都會空。
  // 它只擋「來源網站集體失效」這一種情況。真正的保護是 marketSnapshot
  // 本身已納入稽核；別誤以為這裡有雙保險。
  let universe = await newsDrivenUniverse();
  let universeFrom = 'news';
  if (!universe.length) {
    universe = await newsVerdictUniverse();
    universeFrom = 'turnover-fallback';
    log('  ↳ ⚠ 來源掃描無結果，退回成交金額宇宙');
  }
  if (!universe.length) { log('✖ 新聞判別：宇宙為空，不寫入'); return false; }
  // NEWS_VERDICT_N 現在是**安全上限**而非目標值（防暴走，不是刻意設限）。
  // 晨間趟改用「新聞最新的優先」排序（盤後趟維持專屬報導優先）。
  // 理由：晨間窗只有 60 分鐘（07:00→08:00 死線），而每檔需判別時要 72 秒
  // ⇒ 最壞情況只跑得完約 50 檔。既然一定會被截斷，就要確保**被砍掉的是
  // 新聞最舊的那些**，而不是照專屬報導排序砍掉剛出爐的消息。
  // 跳過率高時這個排序不影響結果（全部沿用），只在真的塞不下時才發揮作用。
  if (pass === 'morning') {
    universe = universe.slice().sort((a, b) =>
      Math.max(...b.articles.map(x => x.at || 0)) - Math.max(...a.articles.map(x => x.at || 0)));
  }
  if (universe.length > NEWS_VERDICT_CAP) {
    log(`  ↳ 宇宙 ${universe.length} 檔 > 上限 ${NEWS_VERDICT_CAP}，截斷（已按專屬報導優先排序，被砍的是最邊緣的）`);
    universe = universe.slice(0, NEWS_VERDICT_CAP);
  }

  const ctx = await newsJudgeContext([today]);
  let judged = 0, skipped = 0, failed = 0, stopped = false;
  // 分段存檔的失敗次數要出現在**最終摘要**裡。上一版只在 catch 裡 log 一行，
  // 結果 flush 因 TDZ 每次都失敗、分段存檔從未真正執行，而我是靠 grep 才發現的。
  // 設計缺陷被 catch 吞成一行小 log ⇒ 功能看似存在、實際從未運作。
  let flushFail = 0;

  // ⚠ **必須宣告在迴圈之前**：const 有 TDZ，寫在迴圈後面的話
  //   迴圈內的 flush(false) 每次都會拋 Cannot access before initialization，
  //   而 catch 把它吞成一行 log ⇒ 分段存檔**看似存在、實際從未執行**。
  //   我今天在 ai-recommend 的 newsAdjOf 已經犯過一次同樣的錯。
  // ⚠ **分段存檔**（2026-08-29 加）：這個 job 要跑 40 分鐘，原本只在最後才寫入，
  //   一被中斷就整批丟失（我自己今天丟過兩次）。而它的產出會影響評分，
  //   半途中斷等於「使用者今天沒有新聞判別」卻無人知曉。
  //   每 20 檔存一次：中斷時已完成的部分仍然可用，重跑也能從既有進度繼續。
  const flush = async (final) => {
  await ref.set({
    date: today,
    // ⚠ dataDate 在本專案的定義是「**資料自身**的日期」（漂移偵測用），
    //   不是「適用日」。塞未來的適用交易日進去是誤用——今天沒被抓到只是
    //   因為漂移閘門不套用 session:'always'，哪天標籤改成 daily 就會無故報錯。
    //   新聞資料來自產生當下 ⇒ dataDate = generatedOn。
    dataDate: isoDate(tw),
    // 沿用既有的 targetDate 慣例（名冊裡已定義為「這份清單適用於哪一個交易日」，
    // 刻意與資料日分開）。另立 targetTradingDate 只會製造同義詞漂移。
    targetDate: today,               // 這批判別適用的交易日（＝doc 鍵）
    generatedOn: isoDate(tw),        // 實際產生的日曆日（可能早於適用日一天）
    updatedAt: Date.now(),
    lastPass: pass,
    universeSize: universe.length,
    universeFrom,                    // news ＝來源監看；turnover-fallback ＝掃描失敗退回
    judged, skipped, failed, stopped,
    verdictJson: JSON.stringify(verdicts),
    seenJson: JSON.stringify(seenAll),
    note: '新聞判別由 AI 讀完內文後給出；僅此來源可影響評分。非投資建議。',
  }, { merge: true });
  await db.collection('newsVerdict').doc('latest').set({
    date: today, targetDate: today, generatedOn: isoDate(tw),
    updatedAt: Date.now(), lastPass: pass,
    covered: Object.keys(verdicts).length,
    verdictJson: JSON.stringify(verdicts),
  });
    if (final) {
      log(`✓ 新聞判別(${pass})：判別 ${judged}、沿用 ${skipped}、失敗 ${failed}` +
          `${stopped ? '、**因死線提前停止**' : ''}，累計覆蓋 ${Object.keys(verdicts).length} 檔` +
          `${flushFail ? `　⚠ 分段存檔失敗 ${flushFail} 次（中斷會丟失進度）` : ''}`);
  await pushVerdictDone(pass, { judged, skipped, failed, stopped, verdicts, targetDate: today });
    }
  };


  for (const u of universe) {
    const code = u.code;
    const minCo = (u.articles || []).length ? Math.min(...u.articles.map(a => a.coMentions)) : 1;
    if (deadlineTs != null && taipei().getTime() >= deadlineTs) { stopped = true; break; }
    const seen = seenAll[code] || [];
    try {
      const r = await withTimeout(judgeOneStock(
        { code, name: u.name || code },
        ctx,
        // 晨間那趟才過濾已判標題；盤後那趟是當日第一次，全部都要判。
        // 使用者 2026-08-29 提醒「一篇有多檔」：把該股在來源報導裡的處境
        // 明講給判別者，讓它自己分辨「專屬報導」與「族群清單裡被順帶提及」。
        // 只在確實偏向清單式報導時才講——沒事加一句反而是誘導。
        {
          ...(pass === 'morning' ? { seenTitles: seen } : {}),
          // ⚠ 使用者 2026-08-29 訂正：**多檔連動是正常的**，不可因此打折。
          //   「蘋果M6先進封裝→台積電/弘塑/均華/長興」本來就是供應鏈連動，
          //   那正是使用者要求加強的產業鏈識讀。我原本叫 AI「可能只是被順帶提及，
          //   多半判中性」，等於**主動壓抑真正的連動訊號**——方向完全相反。
          //   正確做法是要求它針對**這一檔自身**個別判斷，而不是因為同篇有多檔就降級。
          ...(minCo >= 2 ? {
            coMentionNote: `本檔出現在同時提及 ${minCo} 檔的報導中（供應鏈／族群連動很常見，`
              + `**這不代表訊息較弱**）。請針對【${code} ${u.name}】自己判斷。`
              + `⚠ 同一篇報導對不同公司的方向**可以相反**，務必分清這一檔站在哪一邊：`
              + `例如 A 搶下 B 的訂單（A 利多、B 利空）、客戶轉單、被競爭者取代、`
              + `原料或報價上漲（上游利多、下游成本壓力為利空）、`
              + `同業擴產（供給增加對既有業者可能是利空）。`
              + `若它確實只是被列名而該事件與它無關，才判中性。`,
          } : {}),
        }
      ), STOCK_TIMEOUT_MS, `判別 ${code}`);
      if (r && r.skipped) { skipped++; continue; }
      const v = r && r.verdict;
      if (!v) { failed++; continue; }
      verdicts[code] = {
        label: v.label, confidence: v.confidence, strength: v.strength || '中', reason: v.reason,
        keyQuote: v.keyQuote || null, impactPath: v.impactPath || null,
        priced: v.priced || null, challenge: v.challenge || null,
        eventType: v.eventType || null, certainty: v.certainty || null, novelty: v.novelty || null,
        ...verdictPxFields(ctx, code),
        challenged: !!v.challenged, revision: v.revision || null,
        gate: v.gate || null, unverifiedNums: v.unverifiedNums || null,
        dirChecked: !!v.dirChecked, strengthChecked: !!v.strengthChecked,
        quotes: v.quotes || null, quoteVerified: v.quoteVerified ?? null, quoteFailed: v.quoteFailed ?? null,
        strengthBasis: v.strengthBasis || null, unsupported: v.unsupported || null,
        basis: v.basis, n: v.n, pass, at: Date.now(),
        // 使用者 2026-08-29 提醒「一篇有多檔」：把該股在來源文章裡的處境記下來。
        // minCo=1 代表有專屬報導；minCo 大代表只在多檔清單裡被順帶提及，
        // 後續要不要因此降權，等 newsLift 分組看得出差異再決定——現在先留證據。
        articles: (u.articles || []).length || null,
        minCoMentions: (u.articles || []).length ? Math.min(...u.articles.map(a => a.coMentions)) : null,
      };
      // 記下這輪看過的標題，供下一趟（與明日晨間）跳過
      const titles = (r.allTitles || []).slice(0, 60);
      seenAll[code] = [...new Set([...seen, ...titles])].slice(-90);
      judged++;
    } catch (e) {
      failed++;
      log(`✖ 新聞判別 ${code}:`, (e.message || '').slice(0, 50));
    }
    if ((judged + skipped) % 20 === 0) {
      try { await flush(false); }
      catch (e) { flushFail++; log('  ↳ 分段存檔失敗（續跑）:', (e.message || '').slice(0, 40)); }
    }
    await new Promise(r2 => setTimeout(r2, NEWS_VERDICT_GAP_MS));
  }

  await flush(true);
  // 同上：全部失敗（judged=0 且 skipped=0）不可回報成功，否則整天不再重試。
  // ⚠ 晨間趟「全部沿用」是**正常成功**（judged=0、skipped=N），不能一起擋掉。
  return (judged + skipped) > 0;
}

async function computeLimitUpNewsVerdict(deadlineMins = null) {
  const _dlTs = deadlineMins == null ? null : (() => {
    const t = taipei(); const now = t.getHours() * 60 + t.getMinutes();
    return t.getTime() + ((deadlineMins - now) + (deadlineMins <= now ? 1440 : 0)) * 60000;
  })();
  resetNewsSrcUsed();   // 每輪重算，避免標籤累積上一輪的來源
  const fc = (await db.collection('limitUpForecast').doc('latest').get()).data();
  const list = (fc?.aList || []).slice(0, 20);
  if (!list.length) { log('  ⚠ 漲停新聞判別：無候選'); return; }
  const targetDate = fc.dataDate ? nextTradingDay(fc.dataDate) : null;

  const ctx = await newsJudgeContext([fc.dataDate, targetDate]);
  const out = [];
  let _dlHit = 0;
  for (const it of list) {
    // 死線到了就停——已判的照樣寫入，未判的下次再說。
    // 不能為了「判完整批」而拖到 09:00 開盤（使用者盤前要用）。
    if (_dlTs != null && taipei().getTime() >= _dlTs) { _dlHit = list.length - out.length; break; }
    const { verdict, events, stale, ageDays, recent, material, withBody } = await judgeOneStock(it, ctx);
    out.push({
      code: it.code, name: it.name, price: it.price, chg: it.chg,
      score: it.score, reasons: it.reasons, volX: it.volX, luCnt5: it.luCnt5,
      events,
      news: {
        stale, ageDays,
        checked: recent.length, material: material.length, priceOnly: recent.length - material.length,
        basis: verdict.basis,
        top: (withBody.length ? withBody : material).slice(0, 3).map(n => ({ title: n.title, link: n.link, at: n.at, from: n.bodyFrom || n.src || '', generic: !!n.bodyGeneric })),
      },
      verdict,
      primary: verdict.bullish && verdict.confidence !== '低' && !stale,
    });
    await sleep(600);
  }
  const doc = {
    updatedAt: Date.now(),
    dataDate: fc.dataDate ?? null,
    targetDate,                                  // 這份判別是給哪一個交易日用的
    global: ctx.gToday,
    items: out,
    primaryCount: out.filter(x => x.primary).length,
    withContent: out.filter(x => x.verdict?.basis === 'content').length,
    note: '漲停預測的新聞判別。與軋空判別共用同一套規則（讀完內文、產業鏈連動、'
        + '主旋律敏感度、舊聞信心上限、無內文不判多空）。**尚未證明能提升命中率**，'
        + 'newsLift 需累積數週才有結論；在那之前不應據此加權。',
  };
  if (_dlHit) { doc.stoppedAtDeadline = _dlHit; log(`  ⚠ 漲停判別因 08:50 死線提前停止，未判 ${_dlHit} 檔`); }
  await db.collection('limitUpRecommend').doc('latest').set(doc);
  // 手動重跑不得覆蓋當日存檔（同 squeezeRec：日期檔是對答案用的事前判別）
  if (targetDate && !ONESHOT) await db.collection('limitUpRecommend').doc(targetDate).set(doc);
  else if (targetDate) log(`  · 手動執行：只更新 latest，不覆蓋 ${targetDate} 的事前判別存檔`);
  log(`✓ 漲停新聞判別（適用 ${targetDate ?? '?'}）：${out.length} 檔，讀到內文 ${doc.withContent} 檔，主力推薦 ${doc.primaryCount} 檔`);
}

async function computeSqueezeNewsVerdict() {
  resetNewsSrcUsed();   // 每輪重算，避免標籤累積上一輪的來源
  const picks = (await db.collection('squeezePicks').doc('latest').get()).data();
  if (!picks?.items?.length) { log('  ⚠ 新聞判別：無候選'); return; }
  const model = (await db.collection('squeezeModel').doc('latest').get()).data();

  // 國際盤（美股昨夜已收，此時最完整）
  let gToday = {};
  try {
    const g = (await db.collection('squeezeTraining').doc('global').get()).data();
    const hist = g?.histJson ? JSON.parse(g.histJson) : {};
    for (const k in hist) { const ds = Object.keys(hist[k]).sort(); const d2 = ds[ds.length - 1]; if (d2) gToday[k] = { date: d2, ...hist[k][d2] }; }
  } catch { /* 缺國際盤只影響背景說明 */ }
  const gLine = ['sox', 'nasdaq', 'sp500', 'n225', 'kospi', 'vix']
    .filter(k => gToday[k]).map(k => `${k} ${gToday[k].chg >= 0 ? '+' : ''}${gToday[k].chg}%`).join('、');

  // ── 事件日曆併入（2026-08-26 使用者實例：能率亞洲）─────────────────
  // 使用者問「UDN 那篇能率亞洲的新聞為什麼沒收錄」。查證：該文發布於 08-20，
  // 距今 6 天，依「當日或 2 日內」規格本就不該收 —— 判別「資訊不足」沒有錯。
  // **但真正的催化劑不是那篇報導，是它預告的那場法說會（8/26 15:40 真的開了），
  //   而站上的 catalystCalendar 早就有這筆**。等於資訊一直在系統裡，
  //   只是新聞判別從來沒去查事件日曆。
  // ⇒ 法說會/業績發表會/除權息/股東會這類**已排定事件**，對隔日開盤的意義
  //   往往強過一篇報導，必須併入判別依據。
  let calMap = {};
  try {
    const cal = (await db.collection('catalystCalendar').doc('latest').get()).data();
    const want = new Set([picks.archDate, picks.targetDate].filter(Boolean));
    for (const e of (cal?.events || [])) {
      if (!e.code || !want.has(e.date)) continue;
      (calMap[e.code] ||= []).push({ date: e.date, title: e.title, type: e.type, impact: e.impact });
    }
  } catch { /* 缺日曆不擋 */ }

  const out = [];
  // 產業別＝連動判斷的**事實錨點**（使用者要求「加強產業鏈關連性與正確性」
  // 2026-08-28）。沒有它，AI 只能從新聞猜這檔屬於哪條鏈，於是產出「聽起來
  // 合理但沒根據」的傳導路徑（實測：揚明光被說成蘋果鏈、上詮被說成 PCB）。
  // getIndustryMap 走官方 t187ap03 且每日快取，不會增加上游請求。
  let indMap = {};
  try { indMap = await getIndustryMap(); } catch { /* 沒有產業別只是少一個錨，不擋 */ }


  for (const it of picks.items.slice(0, 12)) {
    const { verdict, events, stale, ageDays, recent, material, withBody } =
      await judgeOneStock(it, { calMap, gLine, indMap });
    out.push({
      ...it,
      events,
      news: {
        stale, ageDays,
        checked: recent.length, material: material.length, priceOnly: recent.length - material.length,   // priceOnly 現在的語意＝被剔除的機器速報
        basis: verdict.basis,
        top: (withBody.length ? withBody : material).slice(0, 3).map(n => ({ title: n.title, link: n.link, at: n.at, from: n.bodyFrom || n.src || '', generic: !!n.bodyGeneric })),
      },
      verdict,                                   // 每一檔都有判別提示（含中性/資訊不足）
      // 主力推薦要求：判利多 × 信心非低 × **非舊消息**（舊消息多半已反映）
      primary: verdict.bullish && verdict.confidence !== '低' && !stale,
    });
    await sleep(600);
  }
  out.sort((a, b) => (b.primary - a.primary) || (b.tier - a.tier) || (b.chg - a.chg));
  // 逐日存檔：新聞判別的價值不能靠說的，要能對答案。存下「當時的判別」
  // 才可能在隔日算出「利多組 vs 中性組」的實際差異（使用者 2026-08-26 要求
  // 累積訓練內容的核心）。latest 供前端讀，日期檔供 squeezeReview 對答案。
  const recDoc = {
    updatedAt: Date.now(),
    targetDate: picks.targetDate ?? null,       // 這份判別是給哪一個交易日用的
    archDate: picks.archDate ?? null,
    mode: picks.mode ?? null,
    modelRunId: model?.runId ?? null,
    modelMain: model?.main?.name ?? null,
    modelSqueeze: model?.squeezeProb?.name ?? null,
    global: gToday,
    // ── 市況揭露（2026-08-31 實驗結論）──────────────────────
    //   本策略在「國際盤偏空日」的樣本外勝率僅 **49.6%**（41 天、397 筆）——等於擲硬幣。
    //   而 08-28→08-31 那次命中率掉到 21.4%，正是這種日子。
    //   ⚠ 為什麼是**揭露**而不是加濾網：試過的濾網全部沒通過安慰劑檢定
    //     （硬閘門未超越隨機最佳；券資比≥20% 降權未超越 95 分位；
    //      「不追高」在偏空日甚至有害，勝率僅 37.3%）。
    //     揭露事實不需要通過安慰劑檢定，改動模型才需要。
    //     見 docs/EXPERIMENTS.md ⑤。
    intlRegime: (() => {
      const nq = gToday?.nasdaq?.chg, sx = gToday?.sox?.chg;
      if (nq == null || sx == null) return null;          // 取不到就不宣稱，不猜
      return (nq > 0 && sx > -1) ? 'ok' : 'bear';
    })(),
    intlRegimeNote: '國際盤偏空日（那斯達克≤0 或 費半≤-1%）本策略樣本外勝率僅 49.6%'
      + '（41 個交易日、397 筆）——與擲硬幣相當。此為揭露，非濾網：'
      + '試過的濾網均未通過安慰劑檢定，詳見實驗紀錄⑤。',
    items: out,
    primaryCount: out.filter(x => x.primary).length,
    newsSource: newsSourceLabel(),   // 據實回報本輪真正取到新聞的來源（優先序：工商／經濟 → Yahoo／Google → 鉅亨）
    note: '新聞判別由本機 AI 讀內文/標題後給出；機器速報不採計。判別僅為加權，非投資建議。',
  };
  await db.collection('squeezeRecommend').doc('latest').set(recDoc);
  // ⚠ **手動重跑不得覆蓋當日存檔**（2026-08-27 我自己踩到）：
  //   doc(targetDate) 是 squeezeReview 的 newsLift 用來對答案的「事前判別」存檔。
  //   我為了測試新聞內文改動，用 `--run squeezeRec` 重跑了數次——那時
  //   squeezePicks 已切回**盤中模式**（候選是「今天已經漲的股票」），
  //   於是當日存檔被換成一批**因為漲才入選**的股票，newsLift 變成循環論證。
  //   累積型資料被污染不會自己消失（CLAUDE.md 記過同型）⇒ 只有排程跑才寫日期檔，
  //   手動 CLI 一律只更新 latest。
  if (picks.targetDate && !ONESHOT) await db.collection('squeezeRecommend').doc(picks.targetDate).set(recDoc);
  else if (picks.targetDate) log(`  · 手動執行：只更新 latest，不覆蓋 ${picks.targetDate} 的事前判別存檔`);
  log(`✓ 軋空新聞判別（適用 ${picks.targetDate ?? '?'}）：${out.length} 檔，主力推薦 ${out.filter(x => x.primary).length} 檔`);
}

// ── 國際盤日線歷史：每日合併更新（軋空訓練與判讀的共同底料）──────────
// ⚠ 時序事實（PIT 關鍵）：美股 t 日盤 = 台北 t 日 21:30 ~ t+1 04:00。
//   所以台北 t 日晚上 21:45 記訓練資料時，**美股 t 日還沒收盤**——當天只拿得到
//   亞股(日/韓/台)與匯率。美股 t 日的數字要到 t+1 凌晨才存在。
//   這不影響訓練（訓練是回頭對齊歷史，屆時美股 t 日早已落地），
//   但**影響即時判讀的時點**：要用到美股 t 日，判讀就必須排在 t+1 早上，
//   而那正好也是隔日沖真正下單前的時點。故：
//     · 21:45 記訓練資料（台股面完整）
//     · 隔日 08:00 產出推薦（此時美股昨夜已收，資訊最完整）
async function updateGlobalHistory() {
  const { fetchAllGlobalHistory } = await import('./lib/squeeze-data.mjs');
  const fresh = await fetchAllGlobalHistory('1y', 250);
  const ref = db.collection('squeezeTraining').doc('global');
  const cur = (await ref.get()).data();
  let hist = {};
  try { hist = cur?.histJson ? JSON.parse(cur.histJson) : {}; } catch { hist = {}; }
  let added = 0;
  for (const k in fresh) {
    hist[k] = hist[k] || {};
    for (const d in fresh[k]) { if (!hist[k][d]) added++; hist[k][d] = fresh[k][d]; }
  }
  const days = Object.keys(hist.sox || {}).length;
  await ref.set({ histJson: JSON.stringify(hist), updatedAt: Date.now(), days }, { merge: true });
  log(`✓ 國際盤歷史更新：新增 ${added} 筆，累計 ${days} 日`);
}

// 次一交易日（跳過週末與休市日）。找不到就回 null，寧可標「未知」也不要猜。
// ⚠ 全程用 UTC 算術：taipei() 不吃參數（它永遠回「現在」），而 new Date(局部字串)
//   的 getDay() 會隨機器時區漂移。日期推進這種事不可以依賴機器設定。
function nextTradingDay(fromIso) {
  const [y, m, d] = fromIso.split('-').map(Number);
  let ms = Date.UTC(y, m - 1, d);
  for (let i = 1; i <= 12; i++) {
    ms += 86400000;
    const dt = new Date(ms);
    const iso = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
    const dow = dt.getUTCDay();
    if (dow !== 0 && dow !== 6 && !TW_HOLIDAYS.has(iso)) return iso;
  }
  return null;
}

// ── 開盤搶漲停排隊警示（2026-08-27 使用者需求）─────────────────────────
// 偵測「買一貼漲停 × 賣一全空 × 當日最高尚未觸及漲停」＝大量買單正在排隊
// 搶漲停但還沒成交上去。這是攻擊訊號，出現在**開盤後十幾分鐘**最有意義：
// 此時價格還沒鎖死，理論上仍追得到；一旦真的鎖上就買不到了。
//
// ⚠ 用詞紀律：這是「排隊搶漲停」不是「已漲停」。介面與推播都不可寫成漲停，
//   否則使用者會以為已成局——它可能排到一半就散掉。
const QUEUE_WINDOW_END = 9 * 60 + 15;      // 使用者指定：09:15 前
let _queueSeen = { date: '', codes: new Set() };

async function computeLimitQueue(quotes) {
  const tw = taipei();
  const mins = tw.getHours() * 60 + tw.getMinutes();
  const today = isoDate(tw);
  const inWindow = isTradingDay(tw) && mins >= 9 * 60 && mins < QUEUE_WINDOW_END;
  if (_queueSeen.date !== today) _queueSeen = { date: today, codes: new Set() };

  const items = [];
  for (const code in quotes) {
    const q = quotes[code];
    if (!q?.queueUp) continue;
    if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
    if ((q.market ?? '') === 'esb') continue;               // 興櫃無漲跌停
    items.push({
      code, name: q.name || code,
      limitPrice: q.limitPrice ?? null,
      queueLots: q.queueLots ?? 0,
      price: q.price, chg: q.changePercent ?? 0,
      volume: Math.round((q.volume || 0) / 1000),            // 張
      market: q.market ?? null,
    });
  }
  items.sort((a, b) => b.queueLots - a.queueLots);

  await db.collection('limitQueue').doc('latest').set({
    updatedAt: Date.now(), date: today,
    inWindow, windowEnd: '09:15',
    n: items.length,
    items: items.slice(0, 30),
    note: '買一貼漲停×賣一全空×當日最高尚未觸及漲停＝**排隊搶漲停**（尚未成交上去，不是已漲停）。',
  });

  // 推播：只在 09:15 前、且是「今天第一次看到這檔排隊」時發，避免整個早盤洗版
  if (inWindow && items.length) {
    const fresh = items.filter(x => !_queueSeen.codes.has(x.code));
    for (const x of fresh) _queueSeen.codes.add(x.code);
    if (fresh.length) {
      const top = fresh.slice(0, 5);
      await pushAgentMsg({
        type: 'queue', label: '搶漲停排隊', emoji: '🚨',
        text: `${top.map(x => `${x.code} ${x.name}（委買 ${x.queueLots.toLocaleString()} 張掛在漲停 ${x.limitPrice}）`).join('、')}${fresh.length > top.length ? ` 等 ${fresh.length} 檔` : ''}——買單排隊搶漲停，**尚未成交上去**，鎖上就買不到了。`,
        summary: `${fresh.length} 檔排隊搶漲停（${tw.getHours()}:${String(tw.getMinutes()).padStart(2, '0')}）`,
        severity: 'high',
        stocks: top.map(x => x.code),
        dedupeKey: `queue-${today}-${fresh.map(x => x.code).join('-').slice(0, 40)}`,
        cooldownMs: 60 * 1000,
      });
      log(`🚨 搶漲停排隊 ${fresh.length} 檔：${top.map(x => `${x.code}(${x.queueLots}張)`).join(' ')}`);
    }
  }
  return items.length;
}

// ── 大盤即時脈動監控（2026-08-26 使用者需求）─────────────────────────
//
// 為什麼要監控這個：大盤漲跌與量能**直接決定漲停家數**，也就決定軋空的環境。
// 實測 246 個交易日：
//     大盤 ≥ +1.5%   → 漲停均 67.2 檔、跌停 4.1
//     大盤 +0.5~1.5% → 漲停均 44.1 檔、跌停 2.7
//     大盤 -0.5~+0.5%→ 漲停均 43.3 檔、跌停 6.7
//     大盤 -1.5~-0.5%→ 漲停均 35.4 檔、跌停 7.0
//     大盤 ≤ -1.5%   → 漲停均 27.2 檔、**跌停 35.7（跌停多於漲停）**
//   量能（vs 20日均全日值）：<0.8x 39~50 檔、1.0~1.2x 48.2、≥1.2x 54.8
//   最危險組合：跌<-0.5% × 量能<0.9x → 漲停 29.6 / **跌停 30.7**
//
// ⚠ 誠實限制：**盤中量能沒有「同時刻」歷史基準**（本站的盤中指數曲線今日才
//   開始逐日歸檔）。台股量能是 U 型分佈，用全日均量除以已過時間去比會系統性
//   誤判為縮量。所以現階段：
//     · 漲跌幅與漲停/跌停家數 → 即時可判，無需基準，直接用
//     · 成交值 → 只呈現絕對值與「對昨日全日」的比例，**明確標示非同時刻**，
//       並從今日起累積同時刻曲線，等樣本夠了再啟用量能評級
const PULSE_LEVELS = [
  { key: 'strong', min: 1.5, label: '極佳', luExp: 67, ldExp: 4, note: '漲停家數期望最高（實測均 67 檔），軋空環境最有利' },
  { key: 'good', min: 0.5, label: '偏多', luExp: 44, ldExp: 3, note: '漲停家數略高於平均' },
  { key: 'flat', min: -0.5, label: '持平', luExp: 43, ldExp: 7, note: '接近長期平均（45 檔）' },
  { key: 'weak', min: -1.5, label: '偏空', luExp: 35, ldExp: 7, note: '漲停家數下降，軋空成功率降低' },
  { key: 'bad', min: -99, label: '危險', luExp: 27, ldExp: 36, note: '實測跌停家數(35.7)反超漲停(27.2)——這種盤不宜追軋空' },
];

async function computeMarketPulse() {
  const tw = taipei(); const mins = tw.getHours() * 60 + tw.getMinutes();
  const marketNow = isTradingDay(tw) && mins >= 9 * 60 && mins < 13 * 60 + 35;
  const idx = (await db.collection('marketIndex').doc('latest').get()).data();
  if (!idx) return;
  const chg = idx.weightedChangePercent ?? 0;
  const value = idx.value ?? null;                   // 成交值（億）
  const lvl = PULSE_LEVELS.find(l => chg >= l.min) || PULSE_LEVELS[PULSE_LEVELS.length - 1];

  // 即時漲停/跌停家數（直接數，不需要任何基準）
  const quo = (await readSnapshotQuotes())?.quotes || {};
  const tickOf = p => (p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5);
  let lu = 0, ld = 0, up = 0, dn = 0, n = 0, liveN = 0;
  for (const code in quo) {
    if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
    const q = quo[code];
    if ((q.market ?? '') === 'esb') continue;         // 興櫃無漲跌停
    const price = q.price, prev = price - (q.change ?? 0);
    // 收盤後 live 會是 false，但價格已結算仍可數家數——原本要求 q.live
    // 導致盤後家數全為 0。改為只要有有效價格就計入，另記是否為即時。
    if (!(price > 0) || !(prev > 0)) continue;
    if (q.live) liveN++;
    n++;
    if (q.change > 0) up++; else if (q.change < 0) dn++;
    const rawU = prev * 1.1, tu = tickOf(rawU);
    if (price >= Math.floor(rawU / tu + 1e-9) * tu - 1e-6 && q.change > 0) lu++;
    const rawD = prev * 0.9, td2 = tickOf(rawD);
    if (price <= Math.ceil(rawD / td2 - 1e-9) * td2 + 1e-6 && q.change < 0) ld++;
  }

  // 昨日全日成交值（僅供對照，**非同時刻**，介面必須標示）
  let prevVal = null;
  try {
    const arch = await readArchive(3, 'closeJson');
    // ⚠ closeJson 的量是**張**，成交值＝價 × 張 × **1000 股**。
    //   漏掉這個 ×1000 會少一千倍（實測算出 10 億、實際 9,703 億）——
    //   CLAUDE.md 明列的經典錯誤，這裡再犯一次。
    if (arch[0]) { const m = JSON.parse(arch[0].closeJson); let v = 0; for (const c in m) { const r = m[c]; if (r?.[0] > 0 && r?.[1] > 0) v += r[0] * r[1] * 1000; } prevVal = +(v / 1e8).toFixed(0); }
  } catch { /* 缺就不對照 */ }

  // 警示判定（只在「有實據」的情境才示警，不亂喊）
  const warns = [];
  if (chg <= -1.5) warns.push({ level: 'danger', text: `大盤 ${chg.toFixed(2)}%：實測此區間跌停(35.7)反超漲停(27.2)，軋空追價風險高` });
  else if (chg <= -0.5) warns.push({ level: 'warn', text: `大盤 ${chg.toFixed(2)}%：漲停家數期望降至 ${lvl.luExp} 檔（平均 45），軋空成功率下降` });
  if (ld > lu && n > 200) warns.push({ level: 'danger', text: `即時跌停(${ld}) 已超過漲停(${lu})——空方主導，建議收手` });
  if (chg >= 1.5) warns.push({ level: 'good', text: `大盤 +${chg.toFixed(2)}%：實測漲停家數期望 67 檔，軋空環境最有利` });

  const doc = {
    updatedAt: Date.now(), marketNow,
    twii: { chg: +chg.toFixed(2), value, prevValue: prevVal, valueVsPrevFullDay: (value != null && prevVal) ? +(value / prevVal).toFixed(2) : null },
    otc: { chg: idx.otcChangePercent ?? null },
    counts: { limitUp: lu, limitDown: ld, up, down: dn, counted: n, live: liveN },
    countsBasis: liveN > n * 0.5 ? 'live' : 'settled',   // 盤中＝即時；盤後＝已結算收盤
    level: { key: lvl.key, label: lvl.label, luExp: lvl.luExp, ldExp: lvl.ldExp, note: lvl.note,
      // 實際 vs 期望：偏離本身就是訊息（實際遠低於期望＝盤面比指數更弱）
      luActualVsExp: lvl.luExp ? +(lu / lvl.luExp).toFixed(2) : null },
    warns,
    evidence: { days: 246, avgLimitUp: 45.4, table: PULSE_LEVELS.map(l => ({ label: l.label, min: l.min, luExp: l.luExp, ldExp: l.ldExp })) },
    volNote: '盤中成交值僅與「昨日全日」對照，**非同時刻基準**——台股量能為 U 型分佈，用全日均量除以已過時間會系統性誤判為縮量。同時刻曲線自 2026-08-26 起累積中。',
  };
  await db.collection('marketPulse').doc('latest').set(doc);

  // 盤中狀態轉變才推播（避免同一句話一直洗版）
  if (marketNow && warns.length) {
    const top = warns.find(w => w.level === 'danger') || warns[0];
    await pushAgentMsg({
      type: 'market', label: '大盤脈動', emoji: top.level === 'danger' ? '🚨' : top.level === 'good' ? '🚀' : '⚠️',
      text: `${top.text}（即時漲停 ${lu} / 跌停 ${ld}）`,
      summary: `大盤 ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%·漲停${lu}/跌停${ld}`,
      severity: top.level === 'danger' ? 'high' : 'normal',
      dedupeKey: `pulse-${lvl.key}-${ld > lu ? 'inv' : 'norm'}`,
      cooldownMs: 30 * 60 * 1000,
    });
  }
  return doc;
}

// ── 軋空推薦每日對答案 × 漏網診斷（2026-08-26 使用者需求）──────────────
//
// 誠實前提（寫在最前面，因為它決定整套系統怎麼設計）：
//   **隔日勝率 9 成做不到**。本站最好的樣本外結果是 68.4%，專業機構的隔日
//   策略普遍 55~65%。宣稱 90% 隔日勝率的系統不是過擬合就是話術。
//   可以追求 9 成的是**召回率（漏網率<10%）**：「明日真正軋空的股票，
//   有多少比例出現在我的候選名單裡」。兩個數字語意完全不同，必須分開報。
//
// 每日產出：
//   ① 命中率（precision）：我推薦的，隔日開盤真的漲的比例
//   ② 召回率（recall）：隔日真的軋空的，我有抓到的比例  ← 這個追 9 成
//   ③ 漏網清單 + **逐檔診斷是哪一道濾網擋掉的**（可據以逐日修正）
const SQ_SUCCESS_OPEN = 3;      // 「隔日真的軋空」的定義：開盤報酬 ≥ +3%
const SQ_HIT_OPEN = 0;          // 「推薦命中」的定義：開盤報酬 > 0（隔日沖實際可取得）

async function computeSqueezeReview({ backfillDays = 0 } = {}) {
  const arch = await readArchive(Math.max(40, backfillDays + 30), 'closeJson');
  const days = arch.slice().reverse().map(a => ({
    date: a.date,
    close: JSON.parse(a.closeJson),
    margin: a.marginJson ? JSON.parse(a.marginJson) : null,
  }));
  const T = days.length;
  if (T < 26) return;
  const tickOf = p => (p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5);
  const mgAt = i => { for (let k = i; k >= 0 && k > i - 6; k--) if (days[k].margin) return k; return -1; };
  const avgVol = (t, c) => { let s2 = 0, k = 0; for (let i = Math.max(0, t - 19); i <= t; i++) { const v = days[i].close[c]?.[1] ?? 0; if (v > 0) { s2 += v; k++; } } return k ? s2 / k : 0; };

  // 重放「當時」的候選（用 t 日收盤後全資料，與線上 nextday 模式同口徑）
  const replayPicks = (t) => {
    const m1 = mgAt(t); if (m1 < 0) return null;
    const m2 = mgAt(m1 - 1); if (m2 < 0) return null;
    const out = [];
    for (const code in days[m1].margin) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const mg = days[m1].margin[code]; if (!mg || !(mg[0] > 0) || !(mg[1] > 0)) continue;
      const cur = days[t].close[code], p1 = days[t - 1]?.close[code];
      if (!cur || !p1) continue;
      const close = cur[0], prev = p1[0];
      if (!(close > 10) || !(prev > 0)) continue;
      const chg = ((close - prev) / prev) * 100;
      const ratio = (mg[1] / mg[0]) * 100;
      const shrtChg = mg[1] - (days[m2].margin[code]?.[1] ?? 0);
      const av = avgVol(t, code);
      const pass = chg >= 5 && ratio >= 5 && shrtChg > 0 && av >= 500;
      out.push({ code, chg, ratio, shrtChg, av, close, pass });
    }
    return out;
  };

  const reviews = [];
  const start = Math.max(26, T - 1 - Math.max(1, backfillDays));
  for (let t = start; t < T - 1; t++) {
    const all = replayPicks(t); if (!all) continue;
    const nxt = days[t + 1];
    const openRet = (o) => { const nx = nxt.close[o.code]; if (!nx) return null; const oo = nx[2]; return oo > 0 ? ((oo - o.close) / o.close) * 100 : null; };
    const buyable = (o) => { const nx = nxt.close[o.code]; if (!nx) return null; const raw = o.close * 1.1, tk = tickOf(raw); return nx[2] > 0 ? nx[2] < Math.floor(raw / tk + 1e-9) * tk - 1e-6 : null; };

    const picked = all.filter(o => o.pass).map(o => ({ ...o, ret: openRet(o), buy: buyable(o) })).filter(o => o.ret != null);
    const hit = picked.filter(o => o.ret > SQ_HIT_OPEN);
    // ⚠ 召回率的母體必須講清楚，否則數字沒有意義（第一版就踩到）：
    //   母體A「全部機會」＝任何隔日開盤≥+3% 的股票。用軋空濾網去追這個母體，
    //     召回率必然極低（實測 4.3%）——因為多數跳空與軋空無關（法說、
    //     題材、大盤整體跳空…）。拿這個數字說「漏網 95%」是誤導。
    //   母體B「軋空型機會」＝隔日開盤≥+3% **且本來就有空單可軋**
    //     （券資比≥5%，即這檔股票存在被軋的物理條件）。這才是本策略該負責
    //     的範圍，也是「漏網率<10%」該追的對象。
    //   兩個都報，不藏。
    const universe = all.map(o => ({ ...o, ret: openRet(o) })).filter(o => o.ret != null && o.av >= 500 && o.close > 10);
    const successAll = universe.filter(o => o.ret >= SQ_SUCCESS_OPEN);
    const success = successAll.filter(o => o.ratio >= 5);          // 母體B：有空單可軋
    const caught = success.filter(o => o.pass);
    const missed = success.filter(o => !o.pass);

    // 逐檔診斷：是哪一道濾網擋掉的（可能多道，記全部）
    const why = { chg: 0, ratio: 0, shrtChg: 0, vol: 0 };
    const missDetail = missed.map(o => {
      const reasons = [];
      if (!(o.chg >= 5)) { reasons.push('當日漲幅<5%'); why.chg++; }
      if (!(o.ratio >= 5)) { reasons.push('券資比<5%'); why.ratio++; }
      if (!(o.shrtChg > 0)) { reasons.push('融券日增≤0'); why.shrtChg++; }
      if (!(o.av >= 500)) { reasons.push('均量<500張'); why.vol++; }
      return { code: o.code, chg: +o.chg.toFixed(2), ratio: +o.ratio.toFixed(1), shrtChg: o.shrtChg, ret: +o.ret.toFixed(2), reasons };
    }).sort((a, b) => b.ret - a.ret);

    // 新聞判別加值：把當日存檔的 AI 判別接回來，看「利多組」是否真的比較好。
    // 沒有存檔（該日還沒上線判別）就是 null——不可為了有數字而假造。
    let newsLift = null;
    try {
      const rec = (await db.collection('squeezeRecommend').doc(nxt.date).get()).data();
      if (rec?.items?.length) {
        const byCode = {};
        for (const it of rec.items) byCode[it.code] = it.verdict?.label ?? null;
        const grp = { 利多: [], 中性: [], 資訊不足: [], 利空: [] };
        for (const o of picked) { const lb = byCode[o.code]; if (lb && grp[lb]) grp[lb].push(o.ret); }
        const g = (k) => grp[k].length ? { n: grp[k].length, avg: +(grp[k].reduce((a, b) => a + b, 0) / grp[k].length).toFixed(3), win: +(grp[k].filter(v => v > 0).length / grp[k].length * 100).toFixed(1) } : { n: 0 };
        newsLift = { bull: g('利多'), neutral: g('中性'), none: g('資訊不足'), bear: g('利空') };
      }
    } catch { /* 無存檔就是 null */ }

    reviews.push({
      date: days[t].date, targetDate: nxt.date,
      newsLift,
      picked: picked.length,
      hit: hit.length,
      precision: picked.length ? +(hit.length / picked.length * 100).toFixed(1) : null,
      avgRet: picked.length ? +(picked.reduce((s2, o) => s2 + o.ret, 0) / picked.length).toFixed(3) : null,
      buyRate: picked.length ? +(picked.filter(o => o.buy).length / picked.length * 100).toFixed(1) : null,
      successTotal: success.length,                 // 母體B：軋空型機會
      successAll: successAll.length,                // 母體A：全部跳空機會
      caught: caught.length,
      recall: success.length ? +(caught.length / success.length * 100).toFixed(1) : null,
      recallAll: successAll.length ? +(caught.length / successAll.length * 100).toFixed(1) : null,
      missed: missed.length,
      why,
      missTop: missDetail.slice(0, 12),
    });
  }
  if (!reviews.length) { log('  ⚠ 軋空檢討：無可對答案的日子'); return; }

  // 逐日寫入 + 彙總
  for (const r of reviews) {
    await db.collection('squeezeReview').doc(r.date).set({ ...r, updatedAt: Date.now() });
  }
  const agg = (k) => reviews.map(r => r[k]).filter(v => v != null);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const summary = {
    updatedAt: Date.now(),
    days: reviews.length,
    from: reviews[0].date, to: reviews[reviews.length - 1].date,
    totalPicked: sum(reviews.map(r => r.picked)),
    totalHit: sum(reviews.map(r => r.hit)),
    precision: sum(reviews.map(r => r.picked)) ? +(sum(reviews.map(r => r.hit)) / sum(reviews.map(r => r.picked)) * 100).toFixed(1) : null,
    avgRet: agg('avgRet').length ? +(sum(agg('avgRet')) / agg('avgRet').length).toFixed(3) : null,
    totalSuccess: sum(reviews.map(r => r.successTotal)),
    totalSuccessAll: sum(reviews.map(r => r.successAll)),
    recallAll: sum(reviews.map(r => r.successAll)) ? +(sum(reviews.map(r => r.caught)) / sum(reviews.map(r => r.successAll)) * 100).toFixed(1) : null,
    totalCaught: sum(reviews.map(r => r.caught)),
    recall: sum(reviews.map(r => r.successTotal)) ? +(sum(reviews.map(r => r.caught)) / sum(reviews.map(r => r.successTotal)) * 100).toFixed(1) : null,
    totalMissed: sum(reviews.map(r => r.missed)),
    whyAgg: reviews.reduce((acc, r) => { for (const k in r.why) acc[k] = (acc[k] || 0) + r.why[k]; return acc; }, {}),
    // 新聞判別加值彙總（只算有存檔判別的日子；天數不足時 n 會很小，介面要標示）
    newsLiftAgg: (() => {
      const acc = { bull: [], neutral: [], none: [], bear: [] };
      for (const r of reviews) { if (!r.newsLift) continue; for (const k in acc) { const g = r.newsLift[k]; if (g?.n) for (let i = 0; i < g.n; i++) acc[k].push(g.avg); } }
      const f = (a) => a.length ? { n: a.length, avg: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3) } : { n: 0 };
      return { bull: f(acc.bull), neutral: f(acc.neutral), none: f(acc.none), bear: f(acc.bear) };
    })(),
    daysWithNews: reviews.filter(r => r.newsLift).length,
    // ── 漏網特徵分佈（使用者要求「需記錄」·2026-08-28）────────────────
    // 原本漏網只逐日存 missTop，沒有累積視角，於是「是不是有沒察覺到的觸發
    // 條件」只能靠翻每天的報表用肉眼找。這裡把漏網依特徵分桶累積起來。
    // ⚠ 這是**觀察用的描述統計，不是結論**。要判斷某個桶值不值得成為新規則，
    //   一律回去跑 scripts/squeeze-gate-lab.mjs（372 日 OOT ＋ 安慰劑）。
    //   2026-08-28 已測過一輪：放寬漲幅明確有害、放寬融券日增幾乎是平的、
    //   五個隔離組單獨成線全部不成立（最像「軋空前夜」的 X2b 樣本外是負的）。
    missPatterns: (() => {
      const all = reviews.flatMap(r => r.missTop || []);
      const bucket = (label, f) => { const g = all.filter(f); return { label, n: g.length, avgRet: g.length ? +(g.reduce((a, b) => a + (b.ret || 0), 0) / g.length).toFixed(2) : null }; };
      return {
        total: all.length,
        byRatio: [bucket('券資比 5~10%', x => x.ratio >= 5 && x.ratio < 10), bucket('10~20%', x => x.ratio >= 10 && x.ratio < 20), bucket('20~30%', x => x.ratio >= 20 && x.ratio < 30), bucket('≥30%', x => x.ratio >= 30)],
        byShrt: [bucket('融券日增 >0', x => x.shrtChg > 0), bucket('=0', x => x.shrtChg === 0), bucket('<0（空單回補）', x => x.shrtChg < 0)],
        byChg: [bucket('當日漲 <0%', x => x.chg < 0), bucket('0~3%', x => x.chg >= 0 && x.chg < 3), bucket('3~5%', x => x.chg >= 3 && x.chg < 5), bucket('≥5%', x => x.chg >= 5)],
        note: '描述統計，供觀察；要改規則請跑 squeeze-gate-lab（OOT＋安慰劑）',
      };
    })(),
    note: '命中率＝推薦的隔日開盤上漲比例。召回率(母體B)＝「隔日開盤≥+3% 且券資比≥5%(有空單可軋)」中被抓到的比例——這才是本策略該負責的範圍。recallAll(母體A)＝對全部跳空機會的涵蓋率，本來就會低，因為多數跳空與軋空無關。隔日勝率 9 成不可能（最強催化劑代理實測僅 62~64%），可追求 9 成的是召回率。',
  };
  await db.collection('squeezeReview').doc('summary').set(summary);
  log(`✓ 軋空檢討 ${reviews.length} 日：命中率 ${summary.precision}%｜召回率 ${summary.recall}%｜漏網 ${summary.totalMissed} 檔`);
  { const mp = summary.missPatterns;
    const top = a => a.filter(x => x.n).sort((x, y) => y.n - x.n).slice(0, 2).map(x => `${x.label}×${x.n}`).join('、');
    if (mp.total) log(`   漏網分佈：券資比[${top(mp.byRatio)}]｜融券[${top(mp.byShrt)}]｜漲幅[${top(mp.byChg)}]`); }
  log(`   漏網主因：${Object.entries(summary.whyAgg).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('、')}`);
  return summary;
}

// ── 軋空訓練資料：每日漲停股的「當日 × 前一日」完整狀態 ────────────────
// 使用者需求（2026-08-26）：把每日漲停股當日與前一日的狀態、以及美/台/日/韓
// 等可能連動的大盤資料都採集起來，放進第二大腦當訓練用資料。
//
// 為什麼是漲停股：軋空的觀察對象就是「已經軋起來的那些」，把它們的前一日長相
// 存下來，才能回答「什麼樣的前一日會導致隔日軋空」。同時存一組**對照樣本**
// （當日漲 3~5% 但沒漲停）——只存正例的資料集訓練不出判別力。
async function recordSqueezeTraining() {
  const { buildStockFeatures, buildLabels } = await import('./lib/squeeze-data.mjs');
  const arch = await readArchive(30, 'closeJson');
  if (arch.length < 25) return;
  const days = arch.slice().reverse().map(a => ({
    date: a.date,
    close: JSON.parse(a.closeJson),
    margin: a.marginJson ? JSON.parse(a.marginJson) : null,
    inst: a.instJson ? JSON.parse(a.instJson) : null,
    lend: a.lendingJson ? JSON.parse(a.lendingJson) : null,
  }));
  const t = days.length - 1;                       // 今日（已含資券）
  const today = days[t].date;
  if (Object.keys(days[t].close).length < 1500) { log('  ⚠ 軋空訓練資料：今日歸檔殘缺，略過'); return; }

  const tickOf = p => (p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5);
  const isLU = (c, prev) => { if (!(prev > 0) || !(c > prev)) return false; const raw = prev * 1.1; const tk = tickOf(raw); return c >= Math.floor(raw / tk + 1e-9) * tk - 1e-6; };

  // 國際盤：當日各指數（PIT 合法——美股 t 日盤早於台股 t+1 開盤）
  let global = {};
  try {
    const g = (await db.collection('squeezeTraining').doc('global').get()).data();
    const hist = g?.histJson ? JSON.parse(g.histJson) : {};
    for (const k in hist) { const rec = hist[k]?.[today]; if (rec) global[k] = { close: rec.close, chg: rec.chg }; }
  } catch { /* 缺國際盤不擋 */ }

  const rows = [];
  for (const code in days[t].close) {
    if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
    const cur = days[t].close[code], p1 = days[t - 1]?.close[code];
    if (!cur || !p1) continue;
    const close = cur[0], prevClose = p1[0];
    if (!(close > 10) || !(prevClose > 0)) continue;
    const chg = ((close - prevClose) / prevClose) * 100;
    const limitUp = isLU(close, prevClose);
    // 正例＝當日漲停；對照＝漲 3~5%（沒漲停但也有動能）
    const isControl = !limitUp && chg >= 3 && chg < 5;
    if (!limitUp && !isControl) continue;
    const fT = buildStockFeatures(days, t, code);
    const fY = buildStockFeatures(days, t - 1, code);      // ← 前一日狀態（使用者指定）
    if (!fT || !(fT.avgVol >= 300)) continue;
    rows.push({ code, cls: limitUp ? 1 : 0, t: fT, y: fY || null });
  }
  if (!rows.length) { log('  ⚠ 軋空訓練資料：今日無樣本'); return; }
  const nLU = rows.filter(r => r.cls === 1).length;
  await db.collection('squeezeTraining').doc(today).set({
    date: today, updatedAt: Date.now(),
    n: rows.length, nLimitUp: nLU, nControl: rows.length - nLU,
    global,                                    // 美/台/日/韓/VIX/匯率當日狀態
    rowsJson: JSON.stringify(rows),
    schema: 'v1: rows[].t=當日特徵, rows[].y=前一日特徵, cls=1漲停/0對照(漲3~5%)',
  });
  log(`✓ 軋空訓練資料 ${today}：漲停 ${nLU} 檔 + 對照 ${rows.length - nLU} 檔（國際盤 ${Object.keys(global).length} 項）`);
}

async function computeSqueezePicks() {
  const arch = await readArchive(30, 'closeJson');
  if (arch.length < 21) return;
  const ascClose = arch.slice().reverse();                      // 舊→新
  const marginDoc = (await readArchive(10, 'marginJson'))[0];    // 最近一個有資券的日子
  if (!marginDoc) { log('✖ 軋空候選：無資券歸檔'); return; }
  // ── 兩種模式，日期一定要標清楚（使用者指定 2026-08-26）──────────────
  //   nextday：TWSE 盤後全部資料到齊（收盤 15:10 + 法人 16:30 + 資券 21:45），
  //            此時 closeJson 與 marginJson **同為今日** ⇒ 口徑與回測定版一致
  //            （同日券資比×同日漲幅，樣本外 +3.48% vs 落後口徑 +3.26%），
  //            產出的是「**次一交易日**」的候選清單。
  //   intraday：盤中即時版，券資比只能用 t-1，標的是今天。
  const _archDate = ascClose[ascClose.length - 1].date;
  const fullData = marginDoc.date === _archDate;                // 資券已補到最新歸檔日
  const mode = fullData ? 'nextday' : 'intraday';
  const targetDate = fullData ? nextTradingDay(_archDate) : _archDate;
  const margin = JSON.parse(marginDoc.marginJson);
  const quo = (await readSnapshotQuotes())?.quotes || {};
  const L = ascClose.length - 1;
  const closeMaps = ascClose.map(a => JSON.parse(a.closeJson));
  const prevMap = closeMaps[L - 1] || {};
  // 站上**早就有**一個「軋空啟動」訊號（squeezeSetup：昨日融券增≥昨量0.5%，
  // 2 年稽核 46.0~47.7%），用在撿尾盤的理由標籤。若這裡再自立一套「軋空」，
  // 同一個詞在站上就有兩種定義——正是今天早上圓餅圖分母那個坑。
  // ⇒ 直接合體。實測（240日）：
  //     純動能漲≥5%        +2.04% 勝率50%
  //     A 軋空啟動×漲≥5%    +2.28% 勝率50%（單獨用幾乎沒贏基準）
  //     B 券資比10~20%×漲≥5% +3.45% 勝率56%
  //     A∩B               +3.81% 勝率56% 三段[2.85/5.16/2.88] ← 最佳且最穩
  //     B 但無 A           +2.69% 勝率54% 三段[2.83/3.96/0.42] ← 近段塌陷
  let setupMap = {};
  try {
    const sq = (await db.collection('squeezeSetup').doc('latest').get()).data();
    if (sq?.codesJson) setupMap = JSON.parse(sq.codesJson);
  } catch { /* 缺 setup 只影響分級，不擋榜 */ }

  const avgVol = (code) => {
    let s = 0, k = 0;
    for (let i = Math.max(0, L - 19); i <= L; i++) { const v = closeMaps[i][code]?.[1] ?? 0; if (v > 0) { s += v; k++; } }
    return k ? s / k : 0;
  };
  // 前 20 日收盤高（**排除當日**——含當日會讓「破高」在真正創高那天永遠不成立，
  // 這個坑 2026-08-26 在 marginSnap 踩過一次，不再犯）
  const hi20Of = (code) => {
    let h = 0;
    for (let q = 1; q <= 20; q++) { const v = closeMaps[L - q]?.[code]?.[0] ?? 0; if (v > h) h = v; }
    return h;
  };

  // 借券賣出餘額（TWT93U）與前一日，用於方向判定
  const lendDoc = (await readArchive(10, 'lendingJson'))[0];
  const lendPrevDoc = (await readArchive(10, 'lendingJson'))[1];
  const lendMap = lendDoc ? JSON.parse(lendDoc.lendingJson) : {};
  const lendPrevMap = lendPrevDoc ? JSON.parse(lendPrevDoc.lendingJson) : {};
  // 前一個有資券的日子（算融券日增）
  const marginPrevDoc = (await readArchive(10, 'marginJson'))[1];
  const marginPrev = marginPrevDoc ? JSON.parse(marginPrevDoc.marginJson) : {};
  // 三大法人（使用者 2026-08-26 要求併入榜單）：instJson = [外資, 投信]（張）。
  // ⚠ 台股**沒有盤中法人資料**，T86 收盤後才出 ⇒ 這裡一律是最近已公布日，
  //   doc 要把該日期標出來，不可讓人以為是即時。自營商本站未逐日歸檔，故不列。
  const instDoc = (await readArchive(10, 'instJson'))[0];
  const instMap = instDoc ? JSON.parse(instDoc.instJson) : {};
  const instDate = instDoc?.date ?? null;
  // 法人 5 日累計（連續買超是催化劑的實證足跡，實測投信連買≥3日勝率 64.1%）
  const instDays = (await readArchive(12, 'instJson')).slice(0, 5).map(a => JSON.parse(a.instJson));

  const items = [];
  for (const code in margin) {
    if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
    const [mgn, shrt] = margin[code];
    if (!(mgn > 0) || !(shrt > 0)) continue;
    const ratio = (shrt / mgn) * 100;
    // ── 上限拿掉，改為 ≥5%（2026-08-26 使用者以 5 檔實例質疑後兩度重測）──
    //   ① 原本 10~20% 會漏掉券資比 5~10% 的股票，而使用者舉的 5 檔漲停股裡
    //      有 4 檔落在 5~10%。重測確認 5~10% 有效（樣本外 1.337%/60.0%）。
    //   ② **更重要的自我修正**：我先前判定「券資比≥20% 反而變差」是用
    //      **5 日收盤報酬**測的。但使用者是隔日沖——改用**隔日開盤·可買**
    //      口徑重測，結論完全相反：≥20%×融券日增>0 樣本外 1.85%/68.4%，
    //      ≥30% 更高達 2.093%/74.4%，是全場最佳。
    //      經濟意義說得通：軋空是**開盤跳空**現象，不是多日趨勢——空單重壓
    //      的股票隔天開高最兇，但幾天後可能被基本面拉回（空方本來就看對）。
    //      教訓：換持有期就可能翻盤，回測口徑必須跟實際執行一致。
    if (ratio < 5) continue;
    // ── 融券日增必須為正（⚡軋空 徽章的核心條件，實測有效）─────────────
    //   融券日增>0  樣本外 1.207%/60.6%（n=4642）✅
    //   融券日增<0  樣本外 0.817%/52.6%（n=1279）❌ 明顯低於基準
    //   語意合理：空單還在增加＝燃料還在累積；已在回補＝燃料燒完了。
    const mPrev = marginPrev[code];
    const shrtChg = mPrev ? shrt - (mPrev[1] ?? 0) : null;
    if (!(shrtChg > 0)) continue;
    // ── 借券方向（重要的反直覺結果）────────────────────────────────
    //   借券賣出餘額常是融券的 3~19 倍（千附 57 vs 1,075），直覺會以為
    //   「把借券加進來才是真空單」。**實測完全相反**：
    //     真空單比(融券+借券)/融資 50~100%  樣本外 1.026%/58.1% ❌輸基準
    //     真空單比 100%+                   樣本外 0.837%/56.4% ❌
    //     借券增加                          樣本外 0.874%/55.6% ❌
    //   原因：借券賣出多為法人避險/套利部位（可轉債、ETF 造市），不是方向性
    //   看空，不會被軋而恐慌回補。反而**借券減少**（法人在收避險部位）較好：
    //     券資比10~15% × 借券減  樣本外 1.989%/69.7%（n=66）
    //   ⇒ 借券**不併入券資比**，只當分級的加分項。
    const lendNow = lendMap[code], lendPrev2 = lendPrevMap[code];
    const lendChg = (lendNow != null && lendPrev2 != null) ? lendNow - lendPrev2 : null;
    const q = quo[code];
    const live = q?.live && q.price > 0;
    const price = live ? q.price : (closeMaps[L][code]?.[0] ?? 0);
    const prev = live ? (q.price - q.change) : (prevMap[code]?.[0] ?? 0);
    if (!(price > 10) || !(prev > 0)) continue;
    const chg = ((price - prev) / prev) * 100;
    if (chg < 5) continue;
    const av = avgVol(code);
    if (av < 500) continue;
    const todayVol = live ? Math.round((q.volume ?? 0) / 1000) : (closeMaps[L][code]?.[1] ?? 0);
    const setupChg = setupMap[code];                             // 昨日融券增張數（有值＝A 成立）
    // 分級（隔日開盤·可買口徑·樣本外；皆已疊「漲≥5% × 融券日增>0」）：
    //   3 = 券資比 ≥20%     1.850%/68.4%（n=95；其中 ≥30% 達 2.093%/74.4%）
    //   2 = 券資比 10~15%   1.473%/65.0%（n=137）
    //   1 = 券資比 5~10%    1.337%/60.0%（n=420）
    //   0 = 券資比 15~20%   0.844%/52.4%（n=63）← **樣本外未過基準**，仍列出
    //       但標警示。兩側區間都有效卻獨獨這一段凹陷，n 又只有 63，多半是
    //       雜訊；把中間挖掉是為了讓數字好看的過擬合，不做。誠實標示即可。
    // ── 最高級「精選」（2026-08-26 為追求高勝率而設）─────────────────
    //   券資比≥30% × 突破前20日高：樣本外 2.385%/**勝率75.8%**（n=33），
    //   三段[1.88/2.27/2.38] 逐段走高。頻率約 0.5 檔/日（兩天才一檔）——
    //   這就是提高勝率的代價：更嚴的門檻換更少的機會，沒有第三條路。
    //   ⚠ n=33 偏小，介面須標示；且這是「隔日開盤·可買」口徑。
    const h20 = hi20Of(code);
    const brk20 = h20 > 0 && price > h20;
    const tier = (ratio >= 30 && brk20) ? 4
      : ratio >= 20 ? 3 : (ratio >= 15 ? 0 : (ratio >= 10 ? 2 : 1));
    const iv = instMap[code];
    const fgn = iv ? (iv[0] ?? 0) : null, trust = iv ? (iv[1] ?? 0) : null;
    let f5 = 0, t5 = 0, tStreak = 0, seen = 0;
    for (const m of instDays) { const v = m[code]; if (!v) continue; seen++; f5 += v[0] ?? 0; t5 += v[1] ?? 0; }
    for (const m of instDays) { const v = m[code]; if (v && (v[1] ?? 0) > 0) tStreak++; else break; }
    items.push({
      code, name: q?.name || '', price: +price.toFixed(2), chg: +chg.toFixed(2),
      prev: +prev.toFixed(2),   // 前日收盤（2026-09-17 使用者：盤中表格要多一欄「前日價」對照即時價）
      fgn, trust, instNet: iv ? (fgn + trust) : null,
      fgn5: seen ? f5 : null, trust5: seen ? t5 : null, inst5: seen ? f5 + t5 : null,
      trustStreak: tStreak,
      mgn, shrt, ratio: +ratio.toFixed(1),
      shrtChg, lend: lendNow ?? null, lendChg,
      trueRatio: lendNow != null ? +(((shrt + lendNow) / mgn) * 100).toFixed(1) : null,  // 僅供顯示參考，不入選股條件
      volX: av > 0 ? +(todayVol / av).toFixed(1) : 0,
      setup: setupChg != null ? Math.round(setupChg) : null,
      tier, brk20, hi20: h20 || null,
      band: ratio < 10 ? '5~10%' : ratio < 15 ? '10~15%' : ratio < 20 ? '15~20%' : (ratio < 30 ? '20~30%' : '≥30%'),
      weakBand: ratio >= 15 && ratio < 20,       // 樣本外未過基準的區間，介面要標警示
      live: !!live,
    });
  }
  items.sort((a, b) => b.tier - a.tier || b.ratio - a.ratio || b.chg - a.chg);

  // ── 近期實際戰績（2026-08-26 加）─────────────────────────────────────
  // 只掛 240 日回測數字是不誠實的：使用者是隔日沖，會照著明天下單，
  // 而訊號可能正在回檔。這裡用**同一條定版規則**回放最近 30 個交易日的
  // 收盤後選股與隔日實際報酬，讓「現在的手感」跟「長期期望值」並列。
  // 實測 2026-08-26：長期隔日 +1.62%/勝率55%，但近 30 日 -0.33%/45%。
  let recent = null;
  try {
    const hist = (await readArchive(70, 'closeJson')).slice().reverse();   // 舊→新
    const hMaps = hist.map(a => JSON.parse(a.closeJson));
    const hMg = hist.map(a => (a.marginJson ? JSON.parse(a.marginJson) : null));
    const H = hist.length;
    const hAvgVol = (t, code) => { let s = 0, k = 0; for (let i = Math.max(0, t - 19); i <= t; i++) { const v = hMaps[i][code]?.[1] ?? 0; if (v > 0) { s += v; k++; } } return k ? s / k : 0; };
    let sum = 0, cnt = 0, win = 0, sigDays = 0;
    for (let t = Math.max(25, H - 31); t < H - 1; t++) {
      if (!hMg[t]) continue;
      let dayN = 0;
      for (const code in hMg[t]) {
        if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
        const [mg2, sh2] = hMg[t][code];
        if (!(mg2 > 0) || !(sh2 > 0)) continue;
        const rt = (sh2 / mg2) * 100;
        if (rt < 10 || rt >= 20) continue;
        const p1 = hMaps[t][code]?.[0] ?? 0, p0 = hMaps[t - 1][code]?.[0] ?? 0;
        if (!(p1 > 10) || !(p0 > 0)) continue;
        if (((p1 - p0) / p0) * 100 < 5) continue;
        if (hAvgVol(t, code) < 500) continue;
        const nx = hMaps[t + 1][code]?.[0] ?? 0;
        if (!(nx > 0)) continue;
        const f1 = ((nx - p1) / p1) * 100;
        sum += f1; cnt++; if (f1 > 0) win++; dayN++;
      }
      if (dayN > 0) sigDays++;
    }
    if (cnt > 0) recent = { n: cnt, days: sigDays, avgNextDay: +(sum / cnt).toFixed(2), winRate: Math.round((win / cnt) * 100) };
  } catch { /* 戰績算不出來不擋榜單 */ }

  await db.collection('squeezePicks').doc('latest').set({
    mode, targetDate,               // 這份清單「是給哪一天用的」
    archDate: _archDate,            // 分析所根據的收盤資料日
    marginDate: marginDoc.date,     // 融資券資料日
    instDate,                       // 三大法人資料日（T86 收盤後才出，非即時）
    recent,
    updatedAt: Date.now(),
    priceDate: ascClose[L].date,
    marginDate: marginDoc.date,        // 券資比資料日（t-1）
    rule: '漲≥5% × 券資比≥5% × 融券日增>0 × 20日均量≥500張 × 價>10；⭐⭐⭐⭐精選＝再疊「券資比≥30% × 突破前20日高」（樣本外勝率75.8%·約0.5檔/日）',
    evidence: {
      // 2026-08-26 重測（隔日開盤·可買口徑·樣本外）：
      oosBase: 1.092, oosBaseWin: 58.5,   // 基準：漲≥5%
      t4: 2.385, t4Win: 75.8, t4n: 33,    // ⭐⭐⭐⭐ 精選：券資比≥30% × 破高（約 0.5 檔/日）
      t3: 1.850, t3Win: 68.4, t3n: 95,    // ⭐⭐⭐ 券資比≥20%
      t2: 1.473, t2Win: 65.0, t2n: 137,   // ⭐⭐ 券資比10~15%
      t1: 1.337, t1Win: 60.0, t1n: 420,   // ⭐ 券資比5~10%
      t0: 0.844, t0Win: 52.4, t0n: 63,    // ⚠ 券資比15~20%（樣本外未過基準）
      shUp: 1.207, shUpWin: 60.6,         // 融券日增>0
      shDown: 0.817, shDownWin: 52.6,     // 融券日增<0（明顯較差）
      sblTrue50: 1.026, sblTrue100: 0.837, sblUp: 0.874,   // 借券併入反而變差的證據
      base5d: 2.04, baseWin: 50,          // 純動能對照（僅漲≥5%）
      setupOnly: 2.28, setupWin: 50,      // A：既有軋空啟動 × 漲≥5%
      bandOnly: 3.45, bandWin: 56,        // B：券資比10~20% × 漲≥5%
      combo: 3.81, comboWin: 56,          // A∩B ← 定版最高級
      bNoA: 2.69, bNoAWin: 54,            // B 但無 A（近段轉弱 0.42）
      band20up: 1.46,                     // 券資比≥20% 反而低於純動能
      n: 170132, days: 240,
    },
    items: items.slice(0, 40),
    count: items.length,
  });
  log(`✓ 軋空候選 ${items.length} 檔｜模式 ${mode}｜資料日 ${_archDate}｜適用交易日 ${targetDate}`);
}

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
    try { await computeSqueezePicks(); } catch (e) { log('✖ 軋空候選:', e.message); }
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
    // 與 src/lib/news-server.ts 的 decodeHTMLEntities 同一課：
    //   ① 實體表要含 &nbsp; 與數值實體，否則畫面直接印出「&nbsp;」「&#8230;」；
    //   ② 解碼會把 &lt;a…&gt; 還原成真標籤，**解完必須再去一次標籤**，
    //      否則等於自己把 HTML 放進標題（2026-08-29 個股新聞就是這樣漏到畫面上的）。
    const unesc = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
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

// ── 28.7) 波段第 2 套預選：PID 斜率曲線分型 swingCurvePicks ───────────────
// 使用者指定（2026-08-11）：「用 PID 演算法找出 5/20 日最高勝率漲幅的斜率曲線，
//   至少 5 種，依曲線相似度來預選推薦股，設為第 2 套預選機制，
//   並做 60 日的記錄後看是哪一種的勝率高」。
//
// 分型來自 scripts/screen-swing-pid.mjs（987 交易日 × 2,015 檔·三窗驗證），
// 定義凍結於 scripts/data/swing-pid-curves.json。
//
// ⚠ **這裡的 PID 算式必須與研究腳本逐行相同**，否則記錄下來的分類
//   不是被驗證過的那個分類，60 日實記就對不上歷史統計、整個實驗作廢。
//   改任何一行前先跑 screen-swing-pid.mjs 確認分型未變。
//
// ⚠ 歷史三窗**無任何曲線通過**「淨報酬與勝率三窗皆正」的嚴格門檻——
//   這是刻意保留的實驗，由 60 日前瞻實記當裁判。UI 必須標「觀察中」，
//   不得與已驗證的 swingPicks／strengthPicks 同級呈現。
const CURVE_PICK_N = 20;        // 每型取相似度最高的前 20 檔＝該型當日「預選股」
const CURVE_TARGET_DAYS = 60;   // 使用者指定的實記天數

let _curveDefs = null;
function loadCurveDefs() {
  if (_curveDefs) return _curveDefs;
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), 'data', 'swing-pid-curves.json');
    _curveDefs = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) { log('✖ 曲線定義讀取失敗:', e.message); _curveDefs = null; }
  return _curveDefs;
}

// 單檔 PID（與 screen-swing-pid.mjs 同式；closes 為舊→新、長度需 ≥ L）
function pidOf(closes, L = 20) {
  if (closes.length < L) return null;
  const w = closes.slice(-L);
  const p0 = w[0];
  if (!(p0 > 0)) return null;
  const r = [];
  let s = 0, s2 = 0, n = 0;
  for (let k = 0; k < L; k++) {
    if (!(w[k] > 0)) return null;
    r.push(Math.log(w[k] / p0));
    if (k > 0) { const lr = r[k] - r[k - 1]; s += lr; s2 += lr * lr; n++; }
  }
  const mu = s / n;
  const sigma = Math.sqrt(Math.max(s2 / n - mu * mu, 1e-12));
  if (!(sigma > 1e-6)) return null;
  const xs = Array.from({ length: L }, (_, i) => i);
  const xbar = (L - 1) / 2;
  let sxx = 0; for (const x of xs) sxx += (x - xbar) ** 2;
  const rbar = r.reduce((a, b) => a + b, 0) / L;
  let sxy = 0; for (let k = 0; k < L; k++) sxy += (xs[k] - xbar) * (r[k] - rbar);
  const slope = sxy / sxx;
  const halfSlope = (a, b) => {
    let sx = 0, sy = 0, m = 0;
    for (let k = a; k < b; k++) { sx += xs[k]; sy += r[k]; m++; }
    const mx = sx / m, my = sy / m;
    let xx = 0, xy = 0;
    for (let k = a; k < b; k++) { xx += (xs[k] - mx) ** 2; xy += (xs[k] - mx) * (r[k] - my); }
    return xx > 0 ? xy / xx : 0;
  };
  const d2 = halfSlope(L / 2, L) - halfSlope(0, L / 2);
  // 積分項：誤差對 5 日均線（⚠ 不可用對迴歸線的殘差和——含截距的 OLS 殘差和恆為 0）
  let errSum = 0, errNow = 0, en = 0;
  for (let k = 4; k < L; k++) {
    let ma = 0; for (let j = 0; j < 5; j++) ma += r[k - j];
    ma /= 5;
    const e = r[k] - ma;
    errSum += e; en++;
    if (k === L - 1) errNow = e;
  }
  if (!en) return null;
  return { P: errNow / sigma, I: (errSum / en) / sigma, D: slope / sigma, D2: d2 / sigma, sigma: sigma * 100, curve: r.map(v => v / sigma) };
}

async function computeSwingCurves() {
  const defs = loadCurveDefs();
  if (!defs) return;
  const arch = await loadLuArchive();
  if (arch.length < 22) { log('✖ 曲線分型：歸檔僅', arch.length, '日'); return; }
  const L = defs.window || 20;
  const today = arch[arch.length - 1].date;
  const quo = (await readSnapshotQuotes())?.quotes || {};

  // 逐檔 PID
  const raw = [];
  for (const code in arch[arch.length - 1].close) {
    if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
    const closes = [];
    for (const day of arch) { const r = day.close[code]; if (r?.[0] > 0) closes.push(r[0]); }
    if (closes.length < L + 1) continue;
    const last = arch[arch.length - 1].close[code];
    const vol = last[1] || 0;
    if (vol < 300) continue;                                  // 流動性（與研究同口徑）
    const prev = arch[arch.length - 2]?.close[code]?.[0];
    if (!(prev > 0)) continue;
    if ((last[0] / prev - 1) * 100 > 8.5) continue;           // 可交易宇宙
    const f = pidOf(closes, L);
    if (!f) continue;
    raw.push({ code, price: last[0], vol, ...f });
  }
  if (raw.length < 200) { log('✖ 曲線分型：可用樣本僅', raw.length); return; }

  // 橫斷面 z-score（與研究同：逐日標準化，否則不同市況下的「相似」不可比）
  const F = ['P', 'I', 'D', 'D2'];
  const mz = {};
  for (const f of F) {
    const v = raw.map(x => x[f]);
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(Math.max(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length, 1e-9));
    mz[f] = { m, sd };
  }
  for (const x of raw) x.z = F.map(f => (x[f] - mz[f].m) / mz[f].sd);

  // 最近分型
  for (const x of raw) {
    let best = null, bd = Infinity;
    for (const c of defs.centroids) {
      let s = 0; for (let i = 0; i < 4; i++) s += (x.z[i] - c.z[i]) ** 2;
      if (s < bd) { bd = s; best = c; }
    }
    x.curveId = best.id; x.curveName = best.name; x.dist = Math.sqrt(bd);
  }

  // 每型取相似度最高的前 N 檔＝當日預選股
  const byCurve = {};
  for (const c of defs.centroids) {
    const g = raw.filter(x => x.curveId === c.id).sort((a, b) => a.dist - b.dist).slice(0, CURVE_PICK_N);
    byCurve[c.id] = {
      name: c.name, total: raw.filter(x => x.curveId === c.id).length,
      score5: c.score5, score20: c.score20,
      picks: g.map(x => ({ code: x.code, name: (quo[x.code]?.name || '').trim() || x.code,
        price: +x.price.toFixed(2), dist: +x.dist.toFixed(3), sigma: +x.sigma.toFixed(2) })),
    };
  }
  await db.collection('swingCurvePicks').doc(today).set({
    date: today, at: Date.now(), version: defs.version, window: L, pickN: CURVE_PICK_N,
    universe: raw.length, byCurve, settled5: false, settled20: false,
  });
  await db.collection('swingCurvePicks').doc('latest').set({
    date: today, at: Date.now(), version: defs.version, universe: raw.length,
    curves: defs.centroids.map(c => ({ id: c.id, name: c.name, curve: c.curve,
      score5: c.score5, score20: c.score20,
      hist: c.windows?.length ? {
        net5: +(c.windows.reduce((s, w) => s + w.d5, 0) / c.windows.length).toFixed(2),
        win5: +(c.windows.reduce((s, w) => s + w.dw5, 0) / c.windows.length).toFixed(2),
        net20: +(c.windows.reduce((s, w) => s + w.d20, 0) / c.windows.length).toFixed(2),
        win20: +(c.windows.reduce((s, w) => s + w.dw20, 0) / c.windows.length).toFixed(2),
        grow5: +(c.windows.reduce((s, w) => s + w.g5, 0) / c.windows.length).toFixed(2),
        grow20: +(c.windows.reduce((s, w) => s + w.g20, 0) / c.windows.length).toFixed(2),
        draw5: +(c.windows.reduce((s, w) => s + w.a5, 0) / c.windows.length).toFixed(2),
        draw20: +(c.windows.reduce((s, w) => s + w.a20, 0) / c.windows.length).toFixed(2),
      } : null })),
    byCurve,
    note: '第2套預選機制·觀察中。歷史三窗無任何曲線通過「淨報酬與勝率皆為正」的嚴格門檻，'
      + `由 ${CURVE_TARGET_DAYS} 日前瞻實記當裁判。非投資建議。`,
  });
  log(`  ✓ 曲線分型 ${today}：宇宙 ${raw.length} 檔 → ${defs.centroids.length} 型 × 前 ${CURVE_PICK_N} 檔`);
}

// 對答案：滿 5/20 個交易日就回填實際結果，並累積記分板
async function scoreSwingCurves() {
  const arch = await loadLuArchive();
  if (arch.length < 22) return;
  const dates = arch.map(d => d.date);
  const closeAt = (di, code) => arch[di]?.close?.[code];
  const snap = await db.collection('swingCurvePicks').orderBy('date', 'desc').limit(CURVE_TARGET_DAYS + 30).get();
  const board = {};   // curveId → 累積
  let recorded = 0;

  for (const doc of snap.docs) {
    if (doc.id === 'latest' || doc.id === 'scoreboard') continue;
    const d = doc.data();
    const di = dates.indexOf(d.date);
    if (di < 0) continue;                       // 超出歸檔視窗＝無法對答案（已計入的仍留在 scoreboard）
    const upd = {};
    for (const horizon of [5, 20]) {
      const key = `settled${horizon}`;
      if (d[key]) continue;
      const ti = di + horizon;
      if (ti >= dates.length) continue;         // 還沒到期
      for (const cid in d.byCurve || {}) {
        for (const p of d.byCurve[cid].picks || []) {
          const now = closeAt(ti, p.code);
          if (!now?.[0]) continue;
          const net = (now[0] / p.price - 1) * 100 - 0.4425;
          let mfe = -Infinity, mae = Infinity;
          for (let k = di + 1; k <= ti; k++) {
            const r = closeAt(k, p.code); if (!r) continue;
            const hi = r[3] > 0 ? r[3] : r[0], lo = r[4] > 0 ? r[4] : r[0];
            mfe = Math.max(mfe, (hi / p.price - 1) * 100);
            mae = Math.min(mae, (lo / p.price - 1) * 100);
          }
          const b = (board[cid] ||= {});
          const h = (b[horizon] ||= { n: 0, win: 0, net: 0, grow: 0, draw: 0 });
          h.n++; if (net > 0) h.win++;
          h.net += net;
          if (isFinite(mfe)) h.grow += mfe;
          if (isFinite(mae)) h.draw += mae;
        }
      }
      upd[key] = true;
    }
    if (Object.keys(upd).length) await doc.ref.set(upd, { merge: true });
    recorded++;
  }

  const defs = loadCurveDefs();
  const out = {};
  for (const cid in board) {
    const r = {};
    for (const h of [5, 20]) {
      const x = board[cid][h];
      if (!x?.n) continue;
      r[`d${h}`] = { n: x.n, winRate: +(x.win / x.n * 100).toFixed(2), avgNet: +(x.net / x.n).toFixed(3),
        avgGrow: +(x.grow / x.n).toFixed(2), avgDraw: +(x.draw / x.n).toFixed(2) };
    }
    out[cid] = { name: defs?.centroids?.find(c => c.id === +cid)?.name || cid, ...r };
  }
  // 目前領先者（勝率為使用者指定的裁判標準）
  const rank5 = Object.entries(out).filter(([, v]) => v.d5?.n >= 100).sort((a, b) => b[1].d5.winRate - a[1].d5.winRate);
  const rank20 = Object.entries(out).filter(([, v]) => v.d20?.n >= 100).sort((a, b) => b[1].d20.winRate - a[1].d20.winRate);
  await db.collection('swingCurvePicks').doc('scoreboard').set({
    at: Date.now(), recordedDays: recorded, targetDays: CURVE_TARGET_DAYS,
    complete: recorded >= CURVE_TARGET_DAYS,
    byCurve: out,
    leader5: rank5[0] ? { id: +rank5[0][0], name: rank5[0][1].name, winRate: rank5[0][1].d5.winRate } : null,
    leader20: rank20[0] ? { id: +rank20[0][0], name: rank20[0][1].name, winRate: rank20[0][1].d20.winRate } : null,
    note: `實記進度 ${recorded}/${CURVE_TARGET_DAYS} 日。樣本數未達 100 的分型不列入領先判定。非投資建議。`,
  });
  log(`  ✓ 曲線記分板：已記錄 ${recorded}/${CURVE_TARGET_DAYS} 日`
    + (rank5[0] ? `·5日領先 ${rank5[0][1].name} ${rank5[0][1].d5.winRate}%` : ''));
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
    const _snap = await readSnapshotQuotes();
    const quo = _snap?.quotes || {};
    const marketOpen = !!_snap?.marketOpen;
    const tw = taipei();
    // liveDay 只管「取價要用快照還是歸檔」，不可拿來當盤中與否的標籤（見 boardDataDate）
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
    // date＝這份榜單「產生」的日曆日；dataDate＝底層資料真正屬於哪個交易日。
    // 收盤模式下這兩者在 00:00~15:10 之間會差一天，UI 只能標 dataDate，
    // 否則就是把昨天的收盤資料掛上今天的日期（使用者 2026-08-11 已抓過同類錯誤）。
    await db.collection('swingPicks').doc('latest').set({
      updatedAt: Date.now(), date: isoDate(tw), dataDate: await boardDataDate(tw, marketOpen), mode: marketOpen ? 'live' : 'close',
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
    const _snap = await readSnapshotQuotes();
    const quo = _snap?.quotes || {};
    const marketOpen = !!_snap?.marketOpen;
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
    // dataDate：同 swingPicks，收盤模式一律標資料日而非日曆日
    await db.collection('topicPicks').doc('latest').set({
      updatedAt: Date.now(), date: isoDate(tw), dataDate: await boardDataDate(tw, marketOpen), mode: marketOpen ? 'live' : 'close',
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
      // 現金來源優先序（2026-08-12 對帳修正，與前端 CashLedger 同一把尺）：
      //   ① 銀行實際餘額經交割調整 = bankBalance − 未交割買進待扣 + 未交割賣出待入
      //   ② 帳本重放（入金−出金+股利+賣出−買入）——僅在沒有銀行餘額時退用
      //   ③ rebalanceSettings 手動值——僅在連流水帳都沒有時
      // 原本只有②：帳本任何未記的出入金/利息/折讓差都讓它漂（實測與銀行差 29.1 萬），
      // 而且畫面上「資金總覽」顯示銀行對帳、這張再平衡卡卻顯示帳本值——
      // 同一頁兩個「現金」對不上，使用者無從判斷哪個能信。
      try {
        const led = (await db.collection('users').doc(uid).collection('data').doc('cashLedger').get()).data();
        if (led?.entries?.length || typeof led?.bankBalance === 'number') {
          const td = (await db.collection('users').doc(uid).collection('data').doc('trades').get()).data();
          const ts = td?.trades || td?.tradeRecords || [];
          if (typeof led.bankBalance === 'number') {
            // ⚠鏡像警告：T+2 規則抄自 src/lib/tw-settlement.ts（跳過週末的近似），
            //   兩邊必須一致，否則同一筆未交割款前端算進、daemon 不算。
            const addTradingDays = (dIso, n) => {
              const [y, m, dd] = dIso.split('-').map(Number); const d = new Date(y, m - 1, dd);
              let a = 0; while (a < n) { d.setDate(d.getDate() + 1); const g = d.getDay(); if (g !== 0 && g !== 6) a++; }
              return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            };
            const today = isoDate(taipei());
            // ⚠鏡像警告：銀行錨點自動逐日滾動抄自 src/lib/tw-settlement.ts rollBankToToday
            //   （2026-08-14 使用者指正：輸入的餘額是錨點，之後的交割款進出系統都知道，
            //   要自動滾動；錨點視為已含錨點日當天早上的交割）。兩邊必須一致。
            // 錨點時刻缺失（只會是舊版存檔；2026-09-17 實查 2/2 份都有 bankAt）：**不滾動**任何交割，
            //   等於以今天當錨點——與前端 CashLedger 同一分支同一結果（那邊會標示「錨點日未知」）。
            //   寫成明確分支而不是 `|| Date.now()`，讓「沒有資料」與「資料就是今天」在程式裡分得開。
            const anchorDate = led.bankAt > 0
              ? new Date(led.bankAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' })
              : today;
            let est = led.bankBalance;
            for (const t of ts) {
              if ((t.type !== 'buy' && t.type !== 'sell') || !t.date) continue;
              const sd = addTradingDays(t.date, 2);
              if (sd > anchorDate && sd <= today) est += (t.type === 'sell' ? 1 : -1) * (t.totalAmount || 0);
            }
            for (const e of (led.entries || [])) {
              if (!e.date || e.date <= anchorDate || e.date > today) continue;
              est += e.type === 'withdraw' ? -(e.amount || 0) : (e.amount || 0);
            }
            const pending = t => t.date && addTradingDays(t.date, 2) > today;
            const deduct = ts.filter(t => t.type === 'buy' && pending(t)).reduce((s, t) => s + (t.totalAmount || 0), 0);
            const credit = ts.filter(t => t.type === 'sell' && pending(t)).reduce((s, t) => s + (t.totalAmount || 0), 0);
            cash = est - deduct + credit;
          } else {
            cash = led.entries.reduce((s, e) => s + (e.type === 'withdraw' ? -e.amount : e.amount), 0)
              + ts.filter(t => t.type === 'sell').reduce((s, t) => s + (t.totalAmount || 0), 0)
              - ts.filter(t => t.type === 'buy').reduce((s, t) => s + (t.totalAmount || 0), 0);
          }
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
      const allTrades = td?.trades || td?.tradeRecords || [];
      const trades = allTrades.filter(t => { const ts = t.at || (t.date ? Date.parse(t.date) : 0); return ts >= monthStart && ts < monthEnd; });
      // ⚠ 兩件事都必須做對，缺一個數字就是錯的：
      //   ① 用 replayLedger 重放而非讀 t.realizedPnL——使用者一旦編輯修正過交易，
      //      store 會 delete 掉那個欄位，`t.realizedPnL != null` 直接把該筆濾掉，
      //      月報的勝率/已實現就漏算（越訂正資料、報表越失真）。
      //   ② 重放要餵**全量**歷史再依日期篩，不能只餵當月：
      //      上月買本月賣的部位在只餵當月時會被判成超賣，損益歸 0。
      const sells = statRows(replayLedger(allTrades).closed)
        .filter(c => { const ts = c.date ? Date.parse(c.date) : 0; return ts >= monthStart && ts < monthEnd; })
        .map(c => ({ ...c, realizedPnL: c.pnl }));
      const hd = (await db.collection('users').doc(uid).collection('data').doc('holdings').get()).data();
      const byCode = {};
      for (const h of (hd?.holdings || [])) { const g = (byCode[h.code] ??= { qty: 0, cost: 0, name: h.name }); g.qty += h.quantity; g.cost += h.buyPrice * h.quantity; }
      if (!trades.length && !Object.keys(byCode).length) continue;
      const wins = sells.filter(t => t.realizedPnL > 0);
      const realized = Math.round(sells.reduce((s, t) => s + t.realizedPnL, 0));
      // ⚠ qty 單位是「張」，市值要 ×1000 股。原本漏了，unrlPct 是比值所以看起來正常，
      //   但「市值約 X 萬」那一行整整小 1000 倍（250 萬的部位印成「0.3 萬」）。
      //   週報那支同樣的計算有乘、月報沒乘——同一份資料兩份報表對不起來。
      let mv = 0, cost = 0;
      for (const c in byCode) { mv += (q[c]?.price ?? 0) * byCode[c].qty * 1000; cost += byCode[c].cost * 1000; }
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
  const arch = (await readArchive(262)).reverse();   // readArchive 已濾空殼，+2 緩衝
  const dates = arch.map(a => a.date);
  const closes = arch.map(a => JSON.parse(a.closeJson));
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
      const body = { chat_id: chatId, text: `${a.message}${link}`, disable_web_page_preview: true };
      // 反轉訊號要求點擊確認：附 inline 按鈕，callback 由 tgLinkLoop 回寫 ack
      if (a.requireAck && a.id) body.reply_markup = { inline_keyboard: [[{ text: '✅ 我已收到', callback_data: `ack:${uid}:${a.id}` }]] };
      await tgApi('sendMessage', body);
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
        const cq = u.callback_query;
        if (cq?.data) {
          const am = cq.data.match(/^ack:([A-Za-z0-9]{10,64}):([a-z0-9]{6,20})$/);
          if (am) {
            try {
              const aref = db.collection('users').doc(am[1]).collection('data').doc('alerts');
              const arr = (await aref.get()).data()?.alerts || [];
              const next = arr.map(a => a.id === am[2] ? { ...a, ack: Date.now(), ackVia: 'telegram' } : a);
              await aref.set({ updatedAt: Date.now(), alerts: next });
              await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: '✅ 已確認收到' });
              await tgApi('editMessageReplyMarkup', { chat_id: cq.message?.chat?.id, message_id: cq.message?.message_id, reply_markup: { inline_keyboard: [] } });
              log(`  ✅ TG 確認收到 ${am[1].slice(0, 6)} ${am[2]}`);
            } catch { await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: '確認失敗，請在網站上點擊' }); }
          }
          continue;
        }
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
        // ⚠ g.qty 是「張」，要 ×1000 股才是元。原本漏乘，警示寫「可少虧約 50 元」
        //   而實際是 50,000 元 —— 數字看起來完全正常，只是小到讓這則紀律提醒失去意義。
        const extraLoss = Math.round((it.priceAtTrigger - price) * g.qty * 1000);
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
// 2026-08-05 大改（使用者問「勝率怎麼這麼差？是選股能力太差嗎？」）。
//
// 舊版有三個讓數字**無法判讀**的缺口，全站只有這裡犯：
//   ① 沒有同期基準 —— 「5日 -5.44%」到底好不好？實測那段期間可交易宇宙
//      等權是 -3.72%，所以答案是「比隨便買還差 2.1pp」。少了基準，同一個
//      -5.44% 在多頭市場是災難、在崩盤市場可能是勝利，看的人無從分辨。
//      這正是 bt-core 存在的理由，記分板卻繞過了它。
//   ② 沒有可交易性檢查 —— 實測 TOP20 有 37% 的推薦當日就漲停，收盤價根本
//      買不到。把買不到的標的計入成績，量的是幻想部位。
//   ③ 沒扣費稅 —— 純價差不是實拿。
// 另外 UI 有 5 個分頁，這裡卻只記 2 個榜，另外 3 個從來沒有歷史。
//
// 現在：5 榜全記、每個窗口都附同期基準與超額、標記漲停不可買、給扣費稅淨值。
// **超額（vs 基準）才是選股能力**，絕對報酬主要由市況決定。
// 2026-08-05（使用者：「戰情頁裡所有預測推薦選股也要出示推薦命中率」）：
//   選股頁 5 榜 ＋ 戰情頁 3 榜（雷達共識/籌碼推選/盤中爆量）＋ 波段 2 榜。
//   ⚠漲停預測不在此列——它**已有**自己的對答案機制（limitUpForecast.scoreboard，
//     口徑是「隔日有沒有漲停」而不是報酬率），重複追蹤會出現兩個互相矛盾的數字。
const PICK_LISTS = ['top20', 'intraday', 'daily', 'growth', 'defensive',
                    'radar', 'chipPicks', 'volSurge', 'swing', 'strength', 'overnight',
                    'panicDip', 'overheatExit',
                    'voteDip', 'overheatV2', 'overheatV3', 'wExit'];   // 反轉訊號（凍結·前瞻驗證·17 榜）
const PICK_COST = 0.4425;     // 手續費×2＋證交稅（與 bt-core 同口徑）
// 推薦口徑版本。**改動評分/濾網/排序鍵時務必 +1**，否則新舊成績會被平均在一起。
const CALIB = 'v2';           // v2 = 2026-08-05 四窗修正＋漲停 gate＋已驗證訊號×3

/** chipArchive 一日：{ code: [收盤, 量(張), 開, 高, 低] }。⚠[2] 是開盤價不是漲跌% */
async function _closeMap(date) {
  try {
    const d = (await db.collection('chipArchive').doc(date).get()).data();
    return d?.closeJson ? JSON.parse(d.closeJson) : null;
  } catch { return null; }
}

/** 可交易宇宙同期等權報酬：4碼普通股·量≥300張·進場日非漲停（與 bt-core 同口徑） */
function _baseline(entryMap, prevMap, exitMap) {
  const rets = [];
  for (const c in entryMap) {
    if (!/^\d{4}$/.test(c) || c.startsWith('00')) continue;
    const e = entryMap[c]?.[0], v = entryMap[c]?.[1] || 0, x = exitMap[c]?.[0];
    if (!(e > 0) || !(x > 0) || v < 300) continue;
    const pc = prevMap?.[c]?.[0];
    if (pc > 0 && (e - pc) / pc * 100 > 8.5) continue;      // 進場日漲停＝買不到
    rets.push((x - e) / e * 100);
  }
  return rets;
}

const _agg = (rets) => {
  if (!rets.length) return null;
  const s = [...rets].sort((a, b) => a - b);
  return {
    n: rets.length,
    winRate: Math.round(rets.filter(v => v > 0).length / rets.length * 100),
    avgRet: +(rets.reduce((a, v) => a + v, 0) / rets.length).toFixed(2),
    medRet: +s[s.length >> 1].toFixed(2),
  };
};

async function trackPicks() {
  const tw = taipei(); if (!isTradingDay(tw)) return;
  const date = isoDate(tw);
  const snap = await readSnapshotQuotes(); const q = snap?.quotes || {};
  const rec = await getJSON('/api/twse/ai-recommend');

  // 進場日漲跌%：用歸檔的今收與昨收算（snapshot 的 changePercent 盤中會變）
  const todayMap = await _closeMap(date);
  const prevDate = (await db.collection('chipArchive').where('date', '<', date).orderBy('date', 'desc').limit(1).get()).docs[0]?.id || null;
  const prevMap = prevDate ? await _closeMap(prevDate) : null;
  const chgOf = code => {
    const c = todayMap?.[code]?.[0] ?? q[code]?.price, p = prevMap?.[code]?.[0];
    return c > 0 && p > 0 ? +((c - p) / p * 100).toFixed(2) : null;
  };
  const pack = list => (list || []).slice(0, 20)
    // ⚠各榜的欄位不一致：chipPicks.graded 用 win/netWin 沒有 score、volSurge 也沒有。
    //   Firestore 不接受 undefined，一個 undefined 會讓**整批寫入失敗**（今天踩到）。
    //   ?? null 是必要的，不是防禦性冗餘。
    .map(r => ({ code: r.code, name: r.name || r.code, score: r.score ?? r.net ?? null,
                 price: q[r.code]?.price ?? r.price ?? 0, chg: chgOf(r.code) ?? null }))
    .filter(p => p.price > 0);

  const rows = {
    top20: pack(rec?.recommendations),
    daily: pack(rec?.strategies?.daily),
    growth: pack(rec?.strategies?.growth),
    defensive: pack(rec?.strategies?.defensive),
    intraday: [],
  };
  try {
    const ip = (await db.collection('intradayPicks').doc('latest').get()).data();
    if (ip?.picks) rows.intraday = pack(JSON.parse(ip.picks));
  } catch { /* 盤中榜可能當日未產生，不影響其他榜 */ }

  // ── 戰情頁三榜 ＋ 波段兩榜（每一榜各自 try，一榜缺不影響其他榜）──
  const grab = async (coll, pick) => {
    try {
      const d = (await db.collection(coll).doc('latest').get()).data();
      return d ? (pick(d) || []) : [];
    } catch { return []; }
  };
  // 雷達：取「命中≥2 策略」的共識股——面板上金框優先的就是這一組
  rows.radar = pack(await grab('intradayRadar', d => {
    const seen = {};
    for (const k in (d.groups || {})) for (const it of (d.groups[k] || [])) {
      const g = (seen[it.code] ||= { ...it, _n: 0 });
      g._n++;
    }
    return Object.values(seen).filter(x => x._n >= 2).sort((a, b) => (b.score || 0) - (a.score || 0));
  }));
  rows.chipPicks = pack(await grab('chipPicks', d => d.graded));       // 分級排行（實證綜合評分）
  rows.volSurge  = pack(await grab('volSurge', d => (d.items || []).filter(x => x.dir === 'up')));
  rows.swing     = pack(await grab('swingPicks', d => d.items));
  rows.strength  = pack(await grab('strengthPicks', d => d.items));
  // ⚠選股頁「⚡隔日沖候選」吃的是 tradeSignals.overnight，**不是** chipPicks。
  //   一開始我把命中率掛成 chipPicks——那會用甲榜的成績去背書乙榜，
  //   跟「標籤動了內容沒動」是同一種說謊。榜單鍵一定要對著實際資料源。
  rows.overnight = pack(await grab('tradeSignals', d => d.overnight));
  // 反轉訊號 v1（2026-08-05 凍結）：panicDip 多年一遇、常為空（空榜是常態）；
  // overheatExit 是**避開訊號**——它的超額為負才代表訊號有效，讀記分板時要反著看。
  rows.panicDip = pack(await grab('reversalSignals', d => d.up));
  rows.overheatExit = pack(await grab('reversalSignals', d => d.down));
  // voteDip=投票制抄底(半窗80%/OOT61%)；overheatV2=爆量出貨(避開訊號·超額應為負)
  rows.voteDip = pack(await grab('reversalSignals', d => d.up2));
  rows.overheatV2 = pack(await grab('reversalSignals', d => d.down2));
  rows.overheatV3 = pack(await grab('reversalSignals', d => d.down3));   // 低價過熱(避開訊號·OOT 65%)
  rows.wExit = pack(await grab('reversalSignals', d => d.down4));         // 加權出貨(T3語意·收盤口徑會低估)
  // ── 口徑版本章（2026-08-05）────────────────────────────────────
  // 今天同時改了三件會影響「推薦是什麼」的事：五大因子依四窗檢定修正、
  // 加可交易宇宙 gate（漲停剔除）、排序鍵加上已驗證訊號×3。
  // ⇒ 今天之後記錄的推薦，與 2026-08-04 以前**不是同一個系統**。
  //   若混在同一個平均裡，使用者看到的 -2.12pp 會被讀成「現行推薦很爛」，
  //   但那其實是**已汰換評分器**的成績。標記版本，彙總時分開算。
  await db.collection('picksHistory').doc(date).set({ date, calib: CALIB, ...rows }, { merge: true });

  // ── 到期評估：第 5/10/20 個交易日以當日收盤凍結，同時凍結同期基準 ──
  const hist = await db.collection('picksHistory').get();
  const docs = hist.docs.map(d => d.data()).filter(d => d.date).sort((a, b) => a.date.localeCompare(b.date));
  const idx = Object.fromEntries(docs.map((d, i) => [d.date, i]));
  for (const d of docs) {
    const age = idx[date] - idx[d.date];
    for (const h of [5, 10, 20]) {
      if (age !== h || d[`eval${h}`]?.base) continue;      // 已評過（含基準）就跳過
      const entryMap = await _closeMap(d.date);
      const ePrevDate = docs[idx[d.date] - 1]?.date || null;
      const ePrevMap = ePrevDate ? await _closeMap(ePrevDate) : null;
      const out = {};
      for (const k of PICK_LISTS) {
        // all＝全部推薦；tradable＝剔除進場日漲停（收盤價買不到的不算數）
        const all = [], tradable = [];
        for (const p of (d[k] || [])) {
          const x = q[p.code]?.price;
          if (!(p.price > 0) || !(x > 0)) continue;
          const r = +(((x - p.price) / p.price) * 100).toFixed(2);
          all.push(r);
          if (!(p.chg > 8.5)) tradable.push(r);
        }
        if (all.length) out[k] = { all, tradable };
      }
      // 同期基準：同一進場日、同一持有期、可交易宇宙等權
      if (entryMap && todayMap) out.base = _baseline(entryMap, ePrevMap, todayMap);
      d[`eval${h}`] = out;
      await db.collection('picksHistory').doc(d.date).set({ [`eval${h}`]: out }, { merge: true });
    }
  }

  // ── 彙總：每榜每窗 = 推薦 / 可交易推薦 / 同期基準 / 超額 ──
  const agg = {};
  for (const h of [5, 10, 20]) {
    const baseRets = docs.flatMap(d => d[`eval${h}`]?.base || []);
    const base = _agg(baseRets);
    for (const k of PICK_LISTS) {
      const all = docs.flatMap(d => d[`eval${h}`]?.[k]?.all || []);
      const trad = docs.flatMap(d => d[`eval${h}`]?.[k]?.tradable || []);
      const a = _agg(all); if (!a) continue;
      const t = _agg(trad);
      (agg[k] ||= {})[`d${h}`] = {
        ...a,
        netRet: +(a.avgRet - PICK_COST).toFixed(2),             // 扣來回費稅
        tradableN: t?.n ?? 0, tradableAvg: t?.avgRet ?? null, tradableWin: t?.winRate ?? null,
        skipped: all.length - (t?.n ?? 0),                      // 進場日漲停·買不到
        base: base ? { n: base.n, winRate: base.winRate, avgRet: base.avgRet, medRet: base.medRet } : null,
        // 超額＝選股能力。絕對報酬主要由市況決定，這一項才是「選得準不準」
        excess: base ? +(a.avgRet - base.avgRet).toFixed(2) : null,
        excessTradable: base && t ? +(t.avgRet - base.avgRet).toFixed(2) : null,
        entryDays: docs.filter(d => d[`eval${h}`]?.[k]?.all?.length).length,
      };
    }
  }
  // 只用現行口徑（v2）再算一份——這才是「現在這張榜」的成績。
  // 舊口徑那份仍然保留並照實顯示，但要標明它量的是已汰換的系統。
  const v2 = docs.filter(d => d.calib === CALIB);
  const aggV2 = {};
  for (const h of [5, 10, 20]) {
    const baseRets = v2.flatMap(d => d[`eval${h}`]?.base || []);
    const base = _agg(baseRets);
    for (const k of PICK_LISTS) {
      const all = v2.flatMap(d => d[`eval${h}`]?.[k]?.all || []);
      const trad = v2.flatMap(d => d[`eval${h}`]?.[k]?.tradable || []);
      const a = _agg(all); if (!a) continue;
      const t = _agg(trad);
      (aggV2[k] ||= {})[`d${h}`] = {
        ...a, netRet: +(a.avgRet - PICK_COST).toFixed(2),
        tradableN: t?.n ?? 0, tradableAvg: t?.avgRet ?? null, tradableWin: t?.winRate ?? null,
        skipped: all.length - (t?.n ?? 0),
        base: base ? { n: base.n, winRate: base.winRate, avgRet: base.avgRet, medRet: base.medRet } : null,
        excess: base ? +(a.avgRet - base.avgRet).toFixed(2) : null,
        excessTradable: base && t ? +(t.avgRet - base.avgRet).toFixed(2) : null,
        entryDays: v2.filter(d => d[`eval${h}`]?.[k]?.all?.length).length,
      };
    }
  }

  await db.collection('picksScoreboard').doc('latest').set({
    updatedAt: Date.now(), from: docs[0]?.date || date, records: docs.length, cost: PICK_COST, agg,
    calib: CALIB, calibFrom: v2[0]?.date || date, recordsV2: v2.length, aggV2,
    note: '超額＝推薦均報 − 同期可交易宇宙等權均報，是「選股能力」；絕對報酬主要由市況決定。tradable 為剔除進場日漲停(收盤價買不到)後的口徑。netRet 已扣 0.4425% 來回費稅。',
  });
  log(`✓ 推薦成績：${date} 已記錄 ${PICK_LISTS.filter(k => rows[k].length).length} 榜（歷史 ${docs.length} 日）`);
}


// ── 37b) 推薦榜「已驗證訊號」修正量（2026-08-05）──────────────────
// 為什麼要有這個 job：ai-recommend 只拿得到**單日** STOCK_DAY_ALL，算不出
//   20 日高／5 日漲幅／20 日波動／KD／5 日均線。這些正是本站唯一一批
//   通過「兩半窗＋第三獨立窗＋regime」的隔日沖訊號（composite-score.ts）。
//   依三層架構鐵律（daemon→Firestore→web），由這裡算好寫進 Firestore。
//
// **對決結果決定了設計**（screen-recommend-rank.mjs·主窗480日＋OOT240日·
//   每日取前 20 名·明開賣扣費稅）：
//     Ⓐ 修正後五大因子單獨   主窗Δ+0.236[0.058/0.375✓]  OOT Δ+0.159[0.194/0.138✓]
//     Ⓑ 已驗證訊號單獨       主窗Δ+0.053 ❌兩半窗不同號   OOT Δ+0.140
//     Ⓒ Ⓐ＋Ⓑ×3            主窗Δ+0.249[0.068/0.391✓]  OOT Δ+0.184[0.173/0.190✓] ← 四種配置全勝
//     Ⓓ Ⓐ＋Ⓑ×6            主窗Δ+0.233 ❌
//   ⇒ **Ⓑ 單獨比 Ⓐ 還差**——這些訊號多是 −2 的「避開型」，擅長刪掉爛的、
//     不擅長把好的排到前面。所以是**疊加**不是取代，權重 ×3 不是 ×6。
//   ⚠誠實邊界：Ⓒ 相對基準的超額兩窗四半窗全正，但**絕對淨報酬只有主窗為正
//     (+0.115%)，OOT 約打平 (-0.001%)**。它是「比隨便買好」，不是「穩定賺」。
const ADJ_W = 3;

async function computeRecommendAdj() {
  const tw = taipei(); if (!isTradingDay(tw)) return;
  // 近 30 個交易日足夠算 20 日高／20 日波動／KD(9)／MA5
  const days = (await readArchive(30))
    .map(v => ({ date: v.date, close: JSON.parse(v.closeJson) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (days.length < 22) { log('  ✖ 推薦修正量：歸檔不足 22 日，略過'); return; }
  const D = days[days.length - 1], P = days[days.length - 2];

  // 當日大盤漲跌%＝可交易宇宙中位數（跟風懲罰的第二關代理，收盤即知＝PIT 安全）
  const gs = [];
  for (const c in D.close) {
    if (!/^\d{4}$/.test(c) || c.startsWith('00')) continue;
    const a = D.close[c]?.[0], b = P.close?.[c]?.[0];
    if (a > 0 && b > 0) gs.push((a - b) / b * 100);
  }
  gs.sort((a, b) => a - b);
  const mktChg = gs.length ? gs[gs.length >> 1] : null;

  const out = {};
  for (const code in D.close) {
    if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
    const row = D.close[code]; if (!row || row.length < 5) continue;
    const [c, v, , h, l] = row;
    const pc = P.close?.[code]?.[0];
    if (!(c > 0) || !(pc > 0) || !(h > l)) continue;
    const chg = (c - pc) / pc * 100;
    if (chg > 8.5) continue;                                   // 可交易宇宙外，不必算

    // 歷史序列（不含今日）
    const cl = [], hh = [], ll = [];
    for (let k = 0; k < days.length - 1; k++) {
      const r = days[k].close?.[code];
      if (!r || !(r[0] > 0)) continue;
      cl.push(r[0]); hh.push(r[3] > 0 ? r[3] : r[0]); ll.push(r[4] > 0 ? r[4] : r[0]);
    }
    if (cl.length < 20) continue;

    const pos = (c - l) / (h - l);
    let hi20 = 0; for (let k = 1; k <= Math.min(20, cl.length); k++) hi20 = Math.max(hi20, cl[cl.length - k]);
    const c5 = cl[cl.length - 5];
    const ret5 = c5 > 0 ? (c - c5) / c5 * 100 : null;
    const rets = [];
    for (let k = 1; k < Math.min(21, cl.length); k++) {
      const a = cl[cl.length - k], b = cl[cl.length - k - 1];
      if (a > 0 && b > 0) rets.push((a - b) / b * 100);
    }
    const mean = rets.reduce((s2, x) => s2 + x, 0) / (rets.length || 1);
    const vol20 = rets.length >= 15 ? Math.sqrt(rets.reduce((s2, x) => s2 + (x - mean) ** 2, 0) / rets.length) : null;
    // KD(9) 的 K（與回測腳本同法：RSV 三分之一平滑）
    let k9 = null;
    if (cl.length >= 9) {
      let K = 50;
      const seq = [...cl, c], sh = [...hh, h], sl = [...ll, l];
      for (let t = Math.max(8, seq.length - 30); t < seq.length; t++) {
        const hi = Math.max(...sh.slice(t - 8, t + 1)), lo = Math.min(...sl.slice(t - 8, t + 1));
        K = K * 2 / 3 + (hi > lo ? (seq[t] - lo) / (hi - lo) * 100 : 50) / 3;
      }
      k9 = K;
    }
    const ma5 = (cl.slice(-4).reduce((s2, x) => s2 + x, 0) + c) / 5;
    const belowMA5 = c < ma5;

    // ── 與 screen-recommend-rank.mjs 的 validated() 逐條對齊 ──
    let adj = 0; const why = [];
    const brk20 = hi20 > 0 && c > hi20;
    const strongTail = pos >= 0.8 && Math.abs(chg) > 1;
    if (brk20 && pos >= 0.7) { adj += 2; why.push('🏔破高×強尾 +2'); }
    else if (strongTail) { adj -= 2; why.push('💪強尾單獨 −2'); }
    if (mktChg != null && mktChg >= 1 && chg >= 3 && chg - mktChg < 1) { adj -= 2; why.push('🐑跟風 −2'); }
    if (ret5 != null && ret5 >= 20) { adj -= 2; why.push(`🔥5日+${ret5.toFixed(0)}% 過熱 −2`); }
    if (k9 != null && k9 > 90) { adj -= 2; why.push(`📉K${Math.round(k9)}極度超買 −2`); }
    else if (k9 != null && k9 > 80 && belowMA5) { adj -= 2; why.push(`📉K${Math.round(k9)}×破5MA −2`); }
    if (vol20 != null && vol20 < 1.5) { adj -= 2; why.push(`😴低波動${vol20.toFixed(1)}% −2`); }
    if (adj !== 0) out[code] = { a: adj, w: why };
  }

  await db.collection('recommendAdj').doc('latest').set({
    updatedAt: Date.now(), date: D.date, weight: ADJ_W, n: Object.keys(out).length,
    // 空頭日旗標（2026-08-05）：65 組濾網全測後，唯一逼近「絕對正報酬」的子集
    //   是「空頭日的前 5 名」——主窗 +0.233%[兩半 -0.013/0.411]·淨勝 52.4%、
    //   OOT +0.165%[0.077/0.210]·淨勝 54.3%（基準 -0.134%/-0.185%）。
    //   ⚠主窗前半窗 -0.013% 未達本站「四半窗全正」門檻 ⇒ **提示不計分**，
    //   與站上其他未過關項目（⚠弱尾等）同一處理原則。
    mktChg: mktChg == null ? null : +mktChg.toFixed(2),
    bearDay: mktChg != null ? mktChg < 0 : null,
    map: JSON.stringify(out),
    note: '已驗證訊號修正量（composite-score 中通過兩半窗＋OOT＋regime 者）。排序鍵＝五大因子 + a×weight。實證見 screen-recommend-rank.mjs：Ⓒ 於主窗/OOT×前20/前50 四種配置全勝；⚠超額穩定但絕對淨報酬僅主窗為正、OOT 約打平。',
  });
  log(`✓ 推薦修正量：${D.date} ${Object.keys(out).length} 檔有修正（權重 ×${ADJ_W}）`);
}


// ── 37c) 反轉訊號 v1（2026-08-05 凍結·前瞻驗證中）──────────────────
// 兩條規則出自全參數族搜尋（screen-multiparam-chips.mjs·14,600 組）＋
// 10 年指數恐慌日研究（79 個獨立恐慌日）：
//   🩹 panicDip（恐慌抄底）＝ RSI10連2日<25 ∧ 超賣廣度>30檔 ∧ 個股5日跌>15%
//        ∧ 大盤中位數跌>2% ∧ **加權指數距20日高 ≤ -10%**
//      最後一條是 3/31 型災難的判別器：79 個恐慌日中「已深跌」組 5日勝 76%/+2.31%
//      vs「剛開跌」組 61%/+0.63%；它以 -9.51% vs -10% 的毫釐之差排除了
//      2025-03-31（觸發後 5 日 -22.43% 的那天）——**邊界極薄，所以要前瞻驗證**。
//      多年一遇，空榜是常態。
//   🚪 overheatExit（過熱出貨·避開訊號）＝ RSI5連2日>80 ∧ 收位>0.9
//        ∧ 外資連賣≥3日(t-1) ∧ 借券餘/20日均量>1(t-1)
//      主窗 81.1%[77.4/84.9]·OOT 70.6%——籌碼兩條件提供純價量拿不到的增量
//      （純價量最高 ~68%）。⚠是「持有者該出/空手別追」，不是放空；
//      記分板上它的超額應為**負**才代表訊號有效。
//   🗳️ voteDip（投票制抄底·2026-08-05 晚間凍結）＝ 10 人委員會投票 ≥7 票。
//      委員（凍結名單）：廣度>30檔／5日跌>15%／RSI10連2日<20／大盤跌>2%／
//      RSI10連2日<25／RSI5連2日<15／5日跌>10%／大盤跌>1%／低於MA20>10%／60日位階<0.7。
//      **巢狀驗證通過**：只用前半窗選委員=與全窗版 10/10 相同（無選擇偏誤）；
//      沒看過的後半窗 80.0%(n=630)、OOT 61.4%(n=70·47觸發日·基準44.7%=+16.7pp)。
//      誠實數字＝全窗86.4%/半窗80%/OOT61%——**不是90%**，90% 經三輪窮舉證明
//      在「觸發分散＋OOT維持」下結構性不可得。
//   📉 overheatV2（爆量出貨·v2 候選）＝ 收位>0.9 ∧ 量比>5 ∧ 破20日高 ∧ 三法人合計昨賣超(t-1)。
//      73.3%[68.9/76.7]·n=206·觸發145天·OOT 58.3%——命中低於 v1 但觸發分散得多。
// ⚠規則已凍結；改任何門檻都必須把 REV_CALIB +1 並在記分板分流（同 CALIB 教訓）。
const REV_CALIB = 'v1';

async function computeReversalSignals() {
  const tw = taipei(); if (!isTradingDay(tw)) return;
  const days = (await readArchive(82)).map(x => ({ date: x.date,   // 80+2 空殼緩衝
    close: JSON.parse(x.closeJson),
    inst: x.instJson ? JSON.parse(x.instJson) : null,
    mg: x.marginJson ? JSON.parse(x.marginJson) : null,
    ln: x.lendingJson ? JSON.parse(x.lendingJson) : null }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (days.length < 30) { log('  ✖ 反轉訊號：歸檔不足 30 日'); return; }
  const N = days.length, D = days[N - 1], P = days[N - 2];

  // 大盤中位數漲跌（收盤即知＝PIT 安全）
  const gs = [];
  for (const c in D.close) {
    if (!/^\d{4}$/.test(c) || c.startsWith('00')) continue;
    const a = D.close[c]?.[0], b = P.close?.[c]?.[0];
    if (a > 0 && b > 0) gs.push((a - b) / b * 100);
  }
  gs.sort((a, b) => a - b);
  const mktChg = gs.length ? +gs[gs.length >> 1].toFixed(2) : null;

  // 加權指數距 20 日高（daemon 是唯一合法上游·單次請求）
  let twiiDD20 = null;
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?interval=1d&range=3mo', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const res = (await r.json())?.chart?.result?.[0];
    const cl = (res?.indicators?.quote?.[0]?.close || []).filter(x => x > 0);
    if (cl.length >= 21) {
      const cur = cl[cl.length - 1];
      let hi = 0; for (let k = 2; k <= 21; k++) hi = Math.max(hi, cl[cl.length - k]);
      twiiDD20 = +((cur / hi - 1) * 100).toFixed(2);
    }
  } catch { /* 取不到就存 null → panicDip 當日不觸發（fail-closed，寧漏勿誤） */ }

  const rsiStep = (st, d, p) => {
    if (st.n < p) { st.g += d > 0 ? d : 0; st.l += d < 0 ? -d : 0; st.n++;
      if (st.n === p) { st.g /= p; st.l /= p; st.v = st.l === 0 ? 100 : 100 - 100 / (1 + st.g / st.l); } return; }
    st.g = (st.g * (p - 1) + (d > 0 ? d : 0)) / p; st.l = (st.l * (p - 1) + (d < 0 ? -d : 0)) / p;
    st.v = st.l === 0 ? 100 : 100 - 100 / (1 + st.g / st.l);
  };
  const qsnap = await readSnapshotQuotes(); const qn = qsnap?.quotes || {};
  const up = [], down = [], cands = [];
  let bLo = 0;
  for (const code in D.close) {
    if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
    const row = D.close[code]; if (!row || row.length < 5) continue;
    const [c, v, , h, l] = row; if (!(c > 0)) continue;
    const cl = [], vl = [];
    for (let k = 0; k < N; k++) { const r0 = days[k].close?.[code]; if (r0 && r0[0] > 0) { cl.push(r0[0]); vl.push(r0[1] || 0); } }
    if (cl.length < 22) continue;
    const s5 = { g: 0, l: 0, n: 0, v: null }, s10 = { g: 0, l: 0, n: 0, v: null };
    let p5 = null, p10 = null;
    for (let k = 1; k < cl.length; k++) { p5 = s5.v; p10 = s10.v; rsiStep(s5, cl[k] - cl[k - 1], 5); rsiStep(s10, cl[k] - cl[k - 1], 10); }
    const pc = cl[cl.length - 2];
    const chg = (c - pc) / pc * 100;
    if (!(v >= 300) || chg > 8.5) continue;                    // 可交易宇宙（漲停買不到）
    if (s10.v < 20 && p10 < 20) bLo++;                          // 超賣廣度（規則凍結口徑：RSI10連2日<20）
    const c5 = cl[cl.length - 5];
    let av20 = 0, hi20 = 0, hi60 = 0;
    for (let k = 1; k <= Math.min(60, cl.length - 1); k++) {
      const x = cl[cl.length - 1 - k];                                  // 不含今日的前 k 日
      if (k <= 20) { av20 += vl[vl.length - 1 - k] || 0; if (x > hi20) hi20 = x; }
      if (x > hi60) hi60 = x;
    }
    av20 /= 20;
    const ma20 = cl.length >= 20 ? cl.slice(-20).reduce((a2, x) => a2 + x, 0) / 20 : null;
    let fSell = 0; for (let k = 2; k <= 11; k++) { const f = days[N - k]?.inst?.[code]?.[0]; if (f < 0) fSell++; else break; }
    const it1 = P.inst?.[code];
    let upN = 0; for (let k = cl.length - 1; k > 0 && cl[k] > cl[k - 1]; k--) upN++;   // 連漲天數
    const b1r = days[N - 2]?.close?.[code], b2r = days[N - 3]?.close?.[code];
    const w3 = !!(b1r && b2r && c > row[2] && b1r[0] > b1r[2] && b2r[0] > b2r[2]
      && c > b1r[0] && b1r[0] > b2r[0] && Math.abs(c - row[2]) / pc * 100 >= 1);      // 三白兵
    const mgP = P.mg?.[code];
    const sr = mgP && (mgP[0] || 0) > 0 ? (mgP[1] || 0) / mgP[0] : null;              // 券資比(t-1)
    cands.push({ code, name: qn[code]?.name || code, price: c, chg: +chg.toFixed(2), upN, w3, sr,
      fMag: it1 != null && av20 > 0 ? (it1[0] || 0) / av20 : null,                    // 外資買賣力道/均量(t-1)
      tSell: it1 != null && (it1[1] || 0) < 0,                                        // 投信昨賣超
      r5: s5.v, r10: s10.v, p5, p10,
      ret5: c5 > 0 ? (c - c5) / c5 * 100 : null,
      pos: h > l ? (c - l) / (h - l) : 0.5,
      upSh: h > l ? (h - Math.max(row[2], c)) / (h - l) : 0,    // 上影線比例（row[2]=開盤）
      amp: pc > 0 ? (h - l) / pc * 100 : 0, fSell,
      lnLv: P.ln?.[code] != null && av20 > 0 ? P.ln[code] / av20 : null,
      ma20rel: ma20 > 0 ? (c / ma20 - 1) * 100 : null,
      p20: hi20 > 0 ? c / hi20 : null, p60: hi60 > 0 ? c / hi60 : null,
      volX: av20 > 0 ? v / av20 : null,
      tot1: it1 ? (it1[0] || 0) + (it1[1] || 0) + (it1[2] || 0) : null });
  }
  for (const s of cands) {
    if (s.r10 < 25 && s.p10 < 25 && s.ret5 != null && s.ret5 < -15
      && bLo > 30 && mktChg != null && mktChg < -2 && twiiDD20 != null && twiiDD20 <= -10) {
      up.push({ code: s.code, name: s.name, price: s.price, chg: s.chg });
    }
    if (s.r5 > 80 && s.p5 > 80 && s.pos > 0.9 && s.fSell >= 3 && s.lnLv != null && s.lnLv > 1) {
      down.push({ code: s.code, name: s.name, price: s.price, chg: s.chg });
    }
  }
  const up2 = [], down2 = [], down3 = [], down4 = [];
  for (const s of cands) {
    // 🗳️ voteDip：凍結委員會 10 人投票 ≥7（市場級條件對所有股票同時計票——委員會如此凍結）
    let votes = 0;
    if (bLo > 30) votes++;
    if (s.ret5 != null && s.ret5 < -15) votes++;
    if (s.r10 < 20 && s.p10 < 20) votes++;
    if (mktChg != null && mktChg < -2) votes++;
    if (s.r10 < 25 && s.p10 < 25) votes++;
    if (s.r5 < 15 && s.p5 < 15) votes++;
    if (s.ret5 != null && s.ret5 < -10) votes++;
    if (mktChg != null && mktChg < -1) votes++;
    if (s.ma20rel != null && s.ma20rel < -10) votes++;
    if (s.p60 != null && s.p60 < 0.7) votes++;
    if (votes >= 7) up2.push({ code: s.code, name: s.name, price: s.price, chg: s.chg, votes });
    // 📉 overheatV2：爆量創高收最高·法人在對面出
    if (s.pos > 0.9 && s.volX != null && s.volX > 5 && s.p20 != null && s.p20 >= 1 && s.tot1 != null && s.tot1 < 0) {
      down2.push({ code: s.code, name: s.name, price: s.price, chg: s.chg });
    }
    // 🎈 overheatV3（2026-08-05 第八輪凍結）：低價股過熱＋長上影＋放量
    //    ＝ RSI5連2日>80 ∧ 長上影(>50%振幅·振幅3%↑) ∧ 股價<20 ∧ 量比>3
    //    平常日 73.5%[74.7/72.5]·觸發115天·**OOT 65%(n=80)——八輪全系列最佳樣本外**。
    //    「股價<20」是第七輪補上的維度：低價股過熱=散戶行情=均值回歸最強。
    if (s.r5 > 80 && s.p5 > 80 && s.upSh > 0.5 && s.amp >= 3 && s.price < 20
      && s.volX != null && s.volX > 3) {
      down3.push({ code: s.code, name: s.name, price: s.price, chg: s.chg });
    }
    // ⚖️ wExit（2026-08-05 第九輪凍結·wexit-v1·邏輯迴歸加權出貨）
    //    17 條件權重只在主窗前半窗學（精確值同步存 scripts/data/overheat-weighted-v1.json），
    //    切分值＝half0 覆蓋率 0.5 pct 分位。目標＝T3「5日內恐觸-3%低點」：
    //    後半窗(未見) 76.4%·n=785｜OOT 77.2%·n=561·149天（基準41.8%＝超額+35.4pp）——九輪最強樣本外。
    //    加權勝等權投票 OOT +7.1pp＝權重有真增量。⚠記分板用收盤報酬計超額（該口徑 OOT 僅59.3%），
    //    會低估本榜的 T3 語意；改任何權重＝wexit calib +1。
    const z = 0.405847355295998
      + (s.r5 > 80 && s.p5 > 80 ? 0.023078428045801 : 0)
      + (s.r5 > 85 && s.p5 > 85 ? 0.034809141945533 : 0)
      + (s.upSh > 0.5 && s.amp >= 3 ? 0.292751781068495 : 0)
      + (s.price < 20 ? -0.231706167381413 : 0)
      + (s.price < 50 ? -0.145116100160978 : 0)
      + (s.volX != null && s.volX > 5 ? 0.176332778937549 : 0)
      + (s.volX != null && s.volX > 3 ? 0.221879878624839 : 0)
      + (s.w3 ? 0.221703534687933 : 0)
      + (s.p20 != null && s.p20 >= 1 ? -0.011415177900330 : 0)
      + (s.pos > 0.9 ? -0.042114952784194 : 0)
      + (s.fSell >= 3 ? -0.125146387404233 : 0)
      + (s.fMag != null && s.fMag < -0.03 ? 0.091476091596072 : 0)
      + (s.lnLv != null && s.lnLv > 1 ? -0.550226688197395 : 0)
      + (s.sr != null && s.sr > 0.2 ? 0.274508021011354 : 0)
      + (s.upN >= 3 ? -0.168197391490819 : 0)
      + (s.ret5 != null && s.ret5 > 15 ? 0.615191644652741 : 0)
      + (s.tSell ? -0.259666171095008 : 0);
    if (z >= 1.334394970169651) down4.push({ code: s.code, name: s.name, price: s.price, chg: s.chg, score: +z.toFixed(3) });
  }
  await db.collection('reversalSignals').doc('latest').set({
    updatedAt: Date.now(), date: D.date, calib: REV_CALIB,
    breadth: bLo, mktChg, twiiDD20, up, down, up2, down2, down3, down4,
    note: 'panicDip=恐慌抄底(5條件·多年一遇·空榜是常態)；overheatExit=過熱出貨(避開訊號·記分板超額應為負·非放空)。v1 凍結於 2026-08-05；樣本內數字不可對外宣稱，成績以 picksScoreboard 前瞻累積為準。',
  });
  log(`✓ 反轉訊號：🩹恐慌抄底 ${up.length}·🗳️投票抄底 ${up2.length}·🚪過熱出貨 ${down.length}·📉爆量出貨 ${down2.length}·🎈低價過熱 ${down3.length}·⚖️加權出貨 ${down4.length}（廣度${bLo}·大盤${mktChg}%·距20日高${twiiDD20}%）`);
  await pushReversalAlerts(D.date, { up, up2, down, down2, down3, down4, bLo, mktChg }).catch(e => log('  ✖ 反轉推播', e.message));
}

// ── 反轉訊號直接推播＋點擊確認（2026-08-05 使用者要求）────────────
// 上漲訊號（恐慌/投票抄底）＝市場級事件·推給全部會員；
// 下跌訊號（四條出貨規則）＝只推「該用戶持股/自選有中」的個股（人性化：與我有關才提醒）。
// 每則 requireAck：Web 顯示「✅ 收到」按鈕、Telegram 附 inline 按鈕；
// 隔日訊號日若前一則仍未確認，再提醒一次（只補一次，不無限轟炸）。
async function pushReversalAlerts(date, sig) {
  const upAll = [
    ...sig.up.map(x => ({ ...x, rule: '🩹恐慌抄底' })),
    ...sig.up2.map(x => ({ ...x, rule: '🗳️投票抄底' })),
  ];
  const dnAll = []; const seenDn = new Set();
  for (const [arr, rule] of [[sig.down, '🚪過熱出貨'], [sig.down2, '📉爆量出貨'], [sig.down3, '🎈低價過熱'], [sig.down4, '⚖️加權出貨']]) {
    for (const x of arr) if (!seenDn.has(x.code)) { seenDn.add(x.code); dnAll.push({ ...x, rule }); }
  }
  if (!upAll.length && !dnAll.length) return;
  const premium = await getPremiumUsers();
  let idSeq = 0; const mkId = () => `r${Date.now().toString(36)}${(idSeq++).toString(36)}`;
  for (const u of premium) {
    const uid = u.id;
    try {
      const aref = db.collection('users').doc(uid).collection('data').doc('alerts');
      const prev = (await aref.get()).data()?.alerts || [];
      const haveKey = new Set(prev.map(a => a.key).filter(Boolean));
      const newAlerts = [];
      // 上漲＝市場級：所有會員都收
      if (upAll.length) {
        const key = `rev:${date}:up`;
        if (!haveKey.has(key)) {
          const rules = [...new Set(upAll.map(x => x.rule))].join('＋');
          const ex = upAll.slice(0, 3).map(x => `${x.code} ${x.name}`).join('、');
          newAlerts.push({ code: upAll[0].code, name: upAll[0].name, type: 'reversalUp',
            price: upAll[0].price ?? 0, threshold: 0, pnlPct: 0, key, id: mkId(), requireAck: true,
            message: `📈 反轉訊號日（${date}）：${rules} 觸發 ${upAll.length} 檔（大盤中位 ${sig.mktChg}%·超賣廣度 ${sig.bLo}）例 ${ex}。請點「✅ 收到」確認。非投資建議`, at: Date.now() });
        }
      }
      // 下跌＝個人化：只推持股/自選有中的
      if (dnAll.length) {
        const [wl, hd] = await Promise.all([
          db.collection('users').doc(uid).collection('data').doc('watchlist').get(),
          db.collection('users').doc(uid).collection('data').doc('holdings').get(),
        ]);
        const mine = new Set();
        for (const w of (wl.exists ? (wl.data().watchlist || []) : [])) if (w?.code) mine.add(w.code);
        for (const h of (hd.exists ? (hd.data().holdings || []) : [])) if (h?.code) mine.add(h.code);
        for (const x of dnAll.filter(x => mine.has(x.code)).slice(0, 3)) {
          const key = `rev:${date}:dn:${x.code}`;
          if (haveKey.has(key)) continue;
          newAlerts.push({ code: x.code, name: x.name, type: 'reversalDown',
            price: x.price ?? 0, threshold: 0, pnlPct: 0, key, id: mkId(), requireAck: true,
            message: `📉 出貨訊號（${date}）：你持股/自選的 ${x.code} ${x.name} 觸發【${x.rule}】——重放統計 5 日內約 2/3~3/4 會出現 -3% 低點（前瞻驗證中·非放空訊號）。請點「✅ 收到」確認。非投資建議`, at: Date.now() });
        }
      }
      // 未確認補提醒（48h 內·只補一次）
      const unacked = prev.filter(a => a.requireAck && !a.ack && !a.reminded
        && String(a.type).startsWith('reversal') && Date.now() - a.at < 48 * 3600e3 && Date.now() - a.at > 12 * 3600e3);
      const merged = prev.map(a => unacked.includes(a) ? { ...a, reminded: true } : a);
      const reminders = unacked.slice(0, 2).map(a => ({ ...a, id: a.id, at: Date.now(),
        message: `⏰ 尚未確認收到：${a.message.slice(0, 60)}…（請點「✅ 收到」）` }));
      if (newAlerts.length || reminders.length) {
        await aref.set({ updatedAt: Date.now(), alerts: [...newAlerts, ...merged].slice(0, 40) });
        pushAlerts(uid, [...newAlerts, ...reminders]).catch(() => {});
        log(`  🔔 反轉推播 ${uid.slice(0, 6)}: 新 ${newAlerts.length}·補提醒 ${reminders.length}`);
      }
    } catch (e) { log('  ✖ 反轉推播', uid.slice(0, 6), e.message); }
  }
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
      const allTrades = td?.trades || td?.tradeRecords || [];
      const trades = allTrades.filter(t => { const ts = t.at || t.createdAt || (t.date ? Date.parse(t.date) : 0); return ts >= weekStart; });
      // 同月報：全量重放取得成本基礎，再依日期篩本週（理由見 publishMonthlyReports）
      const sells = statRows(replayLedger(allTrades).closed)
        .filter(c => { const ts = c.date ? Date.parse(c.date) : 0; return ts >= weekStart; })
        .map(c => ({ ...c, realizedPnL: c.pnl }));
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
// ⚠ TWTB4U 有**兩種形狀**，而且兩種都自稱 stat=OK（2026-08-27 查證）：
//   ① 資格清單（當日沖銷交易標的）——盤前就發布，fields 只有 3 欄
//      ［證券代號・證券名稱・暫停現股賣出後現款買進當沖註記］
//   ② 加上統計——當日傍晚才補上，多出［當日沖銷交易成交股數・買進金額・賣出金額］
// 舊版用「筆數 > 10」挑表，兩種都通過；接著讀 r[3]，形狀①是 undefined，
// `_i(undefined)` 給 0 ⇒ 全數被 `dt > 0` 濾掉 ⇒ items 空 ⇒ **靜默 return**：
// 沒有日誌、沒有告警、也不會補抓，漏掉的那天永遠不會回來。
// 實測日誌：08-13~16、08-18~25 整段空白，全靠 30 小時後的稽核 DATE_DRIFT 才發現。
// 這是 CLAUDE.md 記過的同一型（端點身分沒驗證＋給缺席欄位捏預設值）。
// ⇒ ① 驗**欄位名**不是筆數；② 統計未發布就往回找最近有統計的交易日補上；
//    ③ date 填**來源自報的資料日**；④ 每條早退路徑都要留下日誌。
const DT_VOL_FIELD = '當日沖銷交易成交股數';
async function fetchDayTradeRows(ymd) {
  try {
    const r = await fetch(`https://www.twse.com.tw/rwd/zh/dayTrading/TWTB4U?date=${ymd}&selectType=All&response=json`, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.twse.com.tw/' } });
    if (!r.ok) return { err: `HTTP ${r.status}` };
    const j = await r.json();
    if (String(j?.stat || '') !== 'OK') return { err: `stat=${j?.stat || '?'}` };
    // 回音驗證：當沖比率是「撿尾盤」濾網的輸入，拿到別天的等於用錯濾網
    if (String(j?.date || '') !== ymd) return { err: `回音 ${j?.date || '—'}≠${ymd}` };
    const tb = (j.tables || []).find(t => (t.fields || []).includes(DT_VOL_FIELD));
    if (!tb) return { err: '統計未發布(僅資格清單)' };
    return { rows: tb.data || [], col: tb.fields.indexOf(DT_VOL_FIELD) };
  } catch (e) { return { err: String(e?.message || e).slice(0, 40) }; }
}
// 由 fromIso 起（含當日）往回列出交易日。用 UTC 整數日運算，與機器時區脫鉤
// ——跟 nextTradingDay 同一套寫法，避免 taipei() 的本地欄位在跨日相減時漂移。
function prevTradingIsos(fromIso, n) {
  const [y, m, d] = fromIso.split('-').map(Number);
  let ms = Date.UTC(y, m - 1, d);
  const out = [];
  for (let i = 0; i < 20 && out.length < n; i++, ms -= 86400000) {
    const dt = new Date(ms);
    const iso = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
    const dow = dt.getUTCDay();
    if (dow !== 0 && dow !== 6 && !TW_HOLIDAYS.has(iso)) out.push(iso);
  }
  return out;
}
async function computeDayTradeRatio() {
  const tw = taipei();
  const todayIso = isoDate(tw);

  let hit = null; const tried = [];
  for (const iso of prevTradingIsos(todayIso, 5)) {
    const got = await fetchDayTradeRows(iso.replace(/-/g, ''));
    if (got.rows) { hit = { iso, ...got }; break; }
    tried.push(`${iso.slice(5)}:${got.err}`);
  }
  if (!hit) { log(`⚠ 當沖比率：近 5 個交易日都取不到統計（${tried.join('・')}）`); return; }

  // 不要用舊資料蓋掉新的（回溯補抓時才會踩到）
  const cur = (await db.collection('dayTradeRatio').doc('latest').get()).data();
  if (cur?.date && cur.date > hit.iso) { log(`  · 當沖比率：現有 ${cur.date} 較 ${hit.iso} 新，不覆蓋`); return; }

  // 分母＝當日全市場成交量（股）。STOCK_DAY_ALL **沒有 date 參數**、只給最新一天，
  // 所以只有它自報的資料日 == 統計日時才能用；補抓舊日子一律走自家歸檔。
  // ⚠ closeJson 的量是**張**，TWTB4U 是**股**，換算差 1000 倍。
  let volOf = null, volSrc = '';
  const csv = await fetchCloseCsvFull();
  if (csv.length && csv.dataDate === hit.iso.replace(/-/g, '')) {
    volOf = {}; for (const c of csv) volOf[c.code] = c.vol; volSrc = 'STOCK_DAY_ALL';
  } else {
    const a = (await db.collection('chipArchive').doc(hit.iso).get()).data();
    if (a?.closeJson) {
      const m = JSON.parse(a.closeJson); volOf = {};
      for (const c in m) { const v = m[c]?.[1]; if (v > 0) volOf[c] = v * 1000; }
      volSrc = `歸檔${hit.iso}`;
    }
  }
  if (!volOf) { log(`⚠ 當沖比率：${hit.iso} 取不到當日成交量（CSV 資料日 ${csv.dataDate || '—'}、歸檔無 closeJson），略過`); return; }

  const items = [];
  for (const r of hit.rows) {
    const code = (r[0] || '').trim(); if (!/^\d{4}$/.test(code)) continue;
    const dt = _i(r[hit.col]); const vol = volOf[code] || 0;
    if (dt > 0 && vol > 0) items.push({ code, name: (r[1] || '').trim(), ratio: +((dt / vol) * 100).toFixed(1) });
  }
  if (!items.length) { log(`⚠ 當沖比率：${hit.iso} 有統計欄位(${hit.rows.length} 列)但配不到成交量（來源 ${volSrc}），略過`); return; }
  const high = items.filter(x => x.ratio >= 40).sort((a, b) => b.ratio - a.ratio);
  await db.collection('dayTradeRatio').doc('latest').set({ updatedAt: Date.now(), date: hit.iso, count: items.length, high: high.slice(0, 50) });
  log(`✓ 當沖比率：${items.length} 檔，高當沖(≥40%) ${high.length} 檔（資料日 ${hit.iso}・量源 ${volSrc}${hit.iso === todayIso ? '' : '・回溯補抓'}）`);

  // 持股/自選高當沖警報——只在資料日就是今天時發，補抓舊日子不該吵使用者
  if (hit.iso !== todayIso) return;
  const today = todayIso;
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

// ── 41b) 當沖資格名單（全站合規標示的唯一來源·2026-08-27 使用者要求）────
// 目的：使用者若對「不可現股當沖」的股票做當沖，會構成**違規**（券商會擋、
// 但下單前不知道等於白做工，且處置股誤觸更麻煩）。站上任何顯示個股的地方
// 都要能立刻看出可不可以當沖。
//
// 權威來源就是交易所每日公布的「當日沖銷交易標的」，**盤前就發布**：
//   上市 TWSE  rwd/zh/dayTrading/TWTB4U  → tables 內含「證券代號」那張
//   上櫃 TPEx  openapi/v1/tpex_securities → 逐檔含暫停註記
// ⚠ 這兩份**同時也是 computeDayTradeRatio 的資格清單那一形狀**，但用途完全不同：
//   那邊要的是「當日沖銷交易成交股數」統計（傍晚才出），這邊只要資格，盤前即可。
//   不要因為看到同一個 URL 就把兩者合併——它們的可用時刻差 12 小時。
//
// 狀態定義（與 chipArchive.dtOtcEligibleJson 既有語意一致，不另創第二套）：
//   1 = 可現股當沖（先買後賣、先賣後買皆可）
//   2 = 有「暫停現股賣出後現款買進」註記 ⇒ **只能先買後賣**
//   不在名單內 = 不可現股當沖（處置股即屬此類，交易所已從名單移除，
//               實測 1435 中福不在名單中，與「處置股禁止當沖」相符）
//
// ⚠ **抓不到就不要寫**：若只拿到半邊（例如上櫃掛掉），整份名單會讓 700 多檔
//   上櫃股在畫面上變成「不可當沖」——這是會讓使用者錯過交易的假警報，
//   比沒有標示更糟。故兩個市場都必須有貢獻才寫入（同 loadCodes 的教訓）。
async function computeDayTradeEligible() {
  const tw = taipei();
  const ymd = ymd8(tw);
  const roc = String(tw.getFullYear() - 1911) + ymd.slice(4);
  const iso4 = ymd.slice(0, 4), iso4m = ymd.slice(4, 6), iso4d = ymd.slice(6, 8);
  const get = async (url) => {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.twse.com.tw/' }, signal: AbortSignal.timeout(15000) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  };

  const map = {};
  let tseN = 0, otcN = 0, srcDate = '';

  const j = await get(`https://www.twse.com.tw/rwd/zh/dayTrading/TWTB4U?date=${ymd}&selectType=All&response=json`);
  if (String(j?.date || '') === ymd) {
    const tb = (j.tables || []).find(t => (t.fields || []).includes('證券代號'));
    for (const r of (tb?.data || [])) {
      const c = String(r[0] || '').trim();
      if (!/^\d{4,6}[A-Z]?$/.test(c)) continue;
      map[c] = String(r[2] || '').trim() ? 2 : 1; tseN++;
    }
    if (tseN) srcDate = isoDate(tw);
  } else if (j) log(`  ⚠ 當沖資格：TWTB4U 回音 ${j?.date} ≠ ${ymd}`);

  await sleep(800);
  // ⚠ 上櫃**必須用可指定日期的 www 端點當 PRIMARY**（2026-08-28 實跑抓到）：
  //   openapi/v1/tpex_securities 是**傍晚才更新的鏡像**——08-28 下午 14:10 查
  //   它仍自報 1150827。盤前 07:30 用它，回音檢查必然不符，於是當天重試 144 次
  //   全失敗、站上整天掛著昨天的資格名單。
  //   這正是 CLAUDE.md 開宗明義那條：「要當日資料就用可指定日期的端點當
  //   PRIMARY，openapi 只當 FALLBACK」——我第一版直接踩了。
  //   www/zh-tw/intraday/list?date=YYYY/MM/DD 實測 date 回音正確、844 列、
  //   欄位與 openapi 版完全一致。
  const dSlash = `${iso4}/${iso4m}/${iso4d}`;
  const prim = await get(`https://www.tpex.org.tw/www/zh-tw/intraday/list?date=${dSlash}&type=Daily&response=json`);
  const ptb = (prim?.tables || []).find(t => (t.fields || []).includes('證券代號'));
  if (String(prim?.date || '') === ymd && ptb?.data?.length) {
    for (const r of ptb.data) {
      const c = String(r[0] || '').trim();
      if (!/^\d{4,6}[A-Z]?$/.test(c)) continue;
      map[c] = String(r[2] || '').trim() ? 2 : 1; otcN++;
    }
  } else {
    if (prim) log(`  ⚠ 當沖資格：上櫃主來源回音 ${prim?.date || '—'} ≠ ${ymd}，改用 openapi 後備`);
    await sleep(500);
    const secs = await get('https://www.tpex.org.tw/openapi/v1/tpex_securities');
    if (Array.isArray(secs) && secs.length > 100) {
      const d0 = String(secs[0]?.['資料日期'] || '');
      if (d0 && d0 !== roc) log(`  ⚠ 當沖資格：上櫃後備回音 ${d0} ≠ ${roc}`);
      else for (const x of secs) {
        const c = String(x['證券代號'] || '').trim();
        if (!/^\d{4,6}[A-Z]?$/.test(c)) continue;
        map[c] = String(x['暫停現股賣出後現款買進當沖註記'] || '').trim() ? 2 : 1; otcN++;
      }
    }
  }

  if (!tseN || !otcN) { log(`⚠ 當沖資格：上市 ${tseN}／上櫃 ${otcN}，缺一邊不寫入（避免整市場被誤標為不可當沖）`); return false; }
  const only2 = Object.values(map).filter(v => v === 2).length;
  await db.collection('dayTradeEligible').doc('latest').set({
    updatedAt: Date.now(), date: srcDate || isoDate(tw),
    tseCount: tseN, otcCount: otcN, count: Object.keys(map).length, restricted: only2,
    codesJson: JSON.stringify(map),
    note: '1=可現股當沖；2=暫停先賣後買（僅能先買後賣）；不在名單=不可現股當沖。另需本人已開立當沖資格。',
  });
  log(`✓ 當沖資格：${Object.keys(map).length} 檔可當沖（上市 ${tseN}／上櫃 ${otcN}），其中僅先買後賣 ${only2} 檔`);
  return true;
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
  await db.collection('etfPremium').doc('latest').set({ dataDate: await currentDataDate(), updatedAt: Date.now(), date: isoDate(taipei()), count: items.length, premiumTop: sorted.slice(0, 10), discountTop: sorted.slice(-10).reverse() });
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
  if (breakerOpen('yahoo-chart')) return null;   // 熔斷冷卻中：與「無資料」同形狀（見 fetchYahoo1m 上方說明）
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 10000);
  try {
    const j = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=${range}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctl.signal }).then(r => r.json()).finally(() => clearTimeout(tm));
    breakerOk('yahoo-chart');
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
  } catch (e) { breakerFail('yahoo-chart', e); return null; }
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
      // ×1000（張→股）：β 加權是比值、係數相消，數學上原本就對——
      // 但留著會讓「qty×price 必須 ×1000」的單位稽核永遠有一筆例外要人工判讀，
      // 例外累積起來就是下一個真錯誤的藏身處。補上，稽核歸零。
      for (const c of codes) { const mv = (q[c]?.price ?? 0) * byCode[c].qty * 1000; ws[c] = mv; tot += mv; }
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
  // readArchive 保證 arch[0] 一定有 closeJson——原本裸讀時，盤前空殼會讓
  // dataDate 變成今天、cToday 卻是 null，整段撿尾盤靜默失效。
  const arch = await readArchive(63); // 61+2：昨量/近3日收盤+60日收盤高點(跌深反轉用)
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
  // 外資投信「同日」買：法人必須與 arch[0]（最新收盤歸檔日）同一天。收盤 15:10 已歸檔、
  // 法人尚未寫入的窗內 arch[0] 沒有 instJson ⇒ 本輪**不貼**這個標籤（16:45 補跑會補上），
  // 不可退到 arch[1]——那是拿昨天的法人配今天的收盤，日期位移一格（R13·2026-09-12）。
  let instToday = arch[0]?.instJson ? JSON.parse(arch[0].instJson) : null;
  // ⚠ 「有 instJson」不等於「上市法人進來了」（2026-09-14 實案）：15:00 TPEx 法人常比 T86 先出，
  //   15:15 的 instJson 只有上櫃 ⇒ 全上市的候選對不到任何法人 ⇒ 法人榜 0，16:47 補跑才變 13。
  //   與 archiveChipDaily 的 hasTseInst 同一組權值股樣本判定；缺上市就整個標籤棄權，不出半套榜。
  const instHasTse = !!instToday && ['2330', '2317', '2454', '2882'].some(c => instToday[c]);
  if (instToday && !instHasTse) { log(`  ⚠ strategyPicks：${arch[0]?.date || '?'} 法人歸檔只有上櫃（T86 未出），本輪略過「外資投信同日買」標籤（16:45 補跑）`); instToday = null; }
  else if (!instToday) log(`  ⚠ strategyPicks：${arch[0]?.date || '?'} 尚無法人歸檔，本輪略過「外資投信同日買」標籤`);
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

// ── 歸檔上櫃補洞（2026-09-17）──
//   archiveChipDaily 只補「STOCK_DAY_ALL 現在報的那一天」的 otcPending；更早的日子若當天 TPEx 沒出
//   就永遠停在 otcPending（實案 2026-08-20：1,091 檔、上櫃整批缺，四檔上櫃股在 08-21 被算成兩日 +20%，
//   dailySeq／波段持有的 10 日序列跨過這個洞就少一天）。這裡掃最近 N 份文件，對 otcPending 的那幾天
//   用**帶日期＋回聲驗證**的 TPEx 端點補上櫃日 K；只補缺的代號、不動已有的；補不到就留著下次再試。
//   ⚠ 只補 closeJson；該日的其他上櫃欄位（法人等）各有自己的補抓路徑，不在這裡混做。
// Yahoo 逐檔某一日的日 K → [收, 張, 開, 高, 低]；bar 日期（台北）必須等於 iso 才回，否則 null
async function yahooDailyBar(code, sfx, iso) {
  try {
    const p1 = Math.floor(Date.parse(`${iso}T00:00:00+08:00`) / 1000) - 86400 * 2, p2 = p1 + 86400 * 5;
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${code}.${sfx}?period1=${p1}&period2=${p2}&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
    const j = r.ok ? await r.json() : null; const res = j?.chart?.result?.[0]; if (!res?.timestamp) return null;
    const q = res.indicators?.quote?.[0] || {};
    for (let i = 0; i < res.timestamp.length; i++) {
      const day = new Date(res.timestamp[i] * 1000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
      if (day !== iso) continue;
      const c = q.close?.[i]; if (!(c > 0)) return null;
      return [+c.toFixed(2), Math.round((q.volume?.[i] || 0) / 1000), +(q.open?.[i] || 0).toFixed(2), +(q.high?.[i] || 0).toFixed(2), +(q.low?.[i] || 0).toFixed(2)];
    }
    return null;
  } catch { return null; }
}
async function backfillOtcPending(days = 15) {
  const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(days).get();
  let fixed = 0, pending = 0;
  for (const d of snap.docs) {
    const x = d.data();
    if (!x.otcPending || !x.closeJson) continue;
    pending++;
    const ymd = d.id.replace(/-/g, '');
    const otc = await _fetchOtcDated(ymd);   // 回聲驗證：日期對不上回空
    const close = JSON.parse(x.closeJson);
    let added = 0, src = 'tpex';
    for (const r of otc) {
      if (!/^\d{4}$/.test(r.code) || !(r.close > 0) || close[r.code]) continue;
      close[r.code] = [r.close, Math.round((r.vol || 0) / 1000), r.open || 0, r.high || 0, r.low || 0];
      added++;
    }
    // TPEx 帶日期端點也沒有時，退到 Yahoo 逐檔日 K（使用者 2026-09-17 指示「檢查 yahoo 是否有資料能補上」；
    // 實測 08-20 四檔上櫃股 Yahoo 都有當日 bar）。⚠ Yahoo 逐檔會漏日 K（漲停股尤甚，見 8d7d980），
    // 所以每根 bar 必須**回聲驗證日期＝目標日**才收；缺的檔就缺、不拿鄰日冒充。上櫃宇宙來自快照的 market=otc。
    if (!otc.length) {
      const markets = await marketIndexMap().catch(() => ({}));
      const want = Object.keys(markets).filter(c => markets[c] === 'otc' && /^\d{4}$/.test(c) && !close[c]);
      if (!want.length) { log(`  ⚠ 上櫃補洞 ${d.id}：TPEx 無資料，且快照無可補的上櫃代號`); continue; }
      let miss = 0;
      for (const code of want.slice(0, 1200)) {
        const bar = await yahooDailyBar(code, 'TWO', d.id);
        if (bar) { close[code] = bar; added++; } else miss++;
        await sleep(150);
      }
      src = 'yahoo';
      log(`  ↳ 上櫃補洞 ${d.id}：TPEx 無資料，Yahoo 逐檔補 ${added} 檔、缺 ${miss} 檔（只收日期回聲相符的 bar）`);
    }
    if (!added) { log(`  ⚠ 上櫃補洞 ${d.id}：${otc.length ? `端點有 ${otc.length} 列但無新代號可補` : '兩個來源都補不到'}，留待下次`); continue; }
    await d.ref.set({ closeJson: JSON.stringify(close), otcPending: false, otcFixedAt: Date.now(), otcFixSource: src }, { merge: true });
    fixed++;
    log(`✓ 上櫃補洞 ${d.id}：補入 ${added} 檔（${Object.keys(close).length} 檔·${src}）`);
    await sleep(500);
  }
  if (!pending) log(`  · 上櫃補洞：最近 ${days} 份歸檔無 otcPending`);
  return fixed;
}

// ── 價格結構事件偵測（2026-09-17，「chipArchive 減資未調整」待辦的第一步：先量、只記錄）──
//   歸檔的收盤序列**沒有**做減資／面額變更／分割／大額除權的調整，這些日子的「漲跌幅」是假的
//   （實案 6949 面額 10→0.5：1,490→67.1；2380 減資：6.6→21.5），均線位置、N 日連續成長、
//   做空候選都會被污染。反查 2026-06-04～09-17：19 件（減資 6、面額變更 4、除權／分割類 9）。
//   台股漲跌幅上限 10%，所以「相鄰兩個有收盤的日子」比值落在 [0.8, 1.2] 之外必是結構事件或資料錯誤，
//   兩者都該被看見。這裡每日重算最近 90 個交易日的事件表寫 priceEvents/latest，並用 TWSE 減資恢復買賣
//   參考價（rwd TWTAUU，上市）標註可對上的那幾件；其餘 kind 標「未對來源」不猜原因。
//   ⚠ 這一步**不改任何消費端**：先把事件表放出來，各榜要不要用、怎麼用，逐榜驗證後再接。
const PRICE_EVENT_LO = 0.8, PRICE_EVENT_HI = 1.2;
async function computePriceEvents(days = 90) {
  const arch = (await readArchive(days + 5, 'closeJson'))
    .map(x => ({ date: x.date, close: JSON.parse(x.closeJson || '{}') }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (arch.length < 5) return false;
  const last = {}; const events = [];
  for (const d of arch) for (const c in d.close) {
    const q = d.close[c]?.[0]; if (!(q > 0)) continue;
    const L = last[c];
    if (L && /^\d{4}$/.test(c)) {
      const r = q / L.p;
      if (r > PRICE_EVENT_HI || r < PRICE_EVENT_LO) events.push({ date: d.date, code: c, prevDate: L.d, prev: L.p, close: q, ratio: +r.toFixed(4), gapDays: Math.round((Date.parse(d.date) - Date.parse(L.d)) / 864e5), kind: '未對來源', ref: null });
    }
    last[c] = { p: q, d: d.date };
  }
  // 上市減資恢復買賣參考價（帶區間、回聲在 title）：對得上的標 kind=減資、ref=恢復買賣參考價
  try {
    const from = arch[0].date.replace(/-/g, ''), to = arch[arch.length - 1].date.replace(/-/g, '');
    const r = await fetch(`https://www.twse.com.tw/rwd/zh/reducation/TWTAUU?startDate=${from}&endDate=${to}&response=json`, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.twse.com.tw/' }, signal: AbortSignal.timeout(15000) });
    const j = r.ok ? await r.json() : null;
    const fi = Array.isArray(j?.fields) ? j.fields : [];
    const iDate = fi.indexOf('恢復買賣日期'), iCode = fi.indexOf('股票代號'), iRef = fi.indexOf('恢復買賣參考價'), iWhy = fi.indexOf('減資原因');
    if (j?.stat === 'OK' && iDate >= 0 && iCode >= 0) {
      for (const row of (j.data || [])) {
        const m = String(row[iDate] || '').match(/^(\d{2,3})\/(\d{2})\/(\d{2})$/); if (!m) continue;
        const iso = `${+m[1] + 1911}-${m[2]}-${m[3]}`;
        const ev = events.find(e => e.code === String(row[iCode]).trim() && e.date === iso);
        if (ev) { ev.kind = `減資(${row[iWhy] || '?'})`; ev.ref = _num(row[iRef]) || null; }
      }
    }
  } catch (e) { log('  ⚠ 減資參考價對照失敗（事件表照寫，kind 留未對來源）:', (e.message || '').slice(0, 50)); }
  const names = await nameIndexMap().catch(() => ({}));
  const markets = await marketIndexMap().catch(() => ({}));
  for (const e of events) e.name = names[e.code] || null;
  // ── 還原係數（2026-09-17 使用者決定：加係數、逐榜接入）──
  //   factor＝「事件前價格 × factor ≈ 事件後口徑」。來源優先序：
  //   ① TWSE 減資恢復買賣參考價（上市，精確）：factor = ref / prev
  //   ② Yahoo 逐檔事件（第三方；上櫃減資／面額變更／除權息都有）：split num/den＝股數倍率 s、除息金額 D
  //      ⇒ 事件後參考價 = (prev − D) / s，factor = 那個 / prev。實測 2380 減資 6.6→23.86 與 TWSE 參考價一字不差。
  //   ③ MOPS 面額變更公告（主旨「面額由「新台幣X元」變更為「新台幣Y元」」）：只做交叉比對／②缺時的後備，factor = Y/X。
  //   Yahoo 的事件日：除權息＝除權息日（＝我們的事件日）；減資／面額變更＝停止買賣起日（落在 prevDate 與事件日之間）。
  //   ⚠ 首日檢核：事件日收盤必須落在 prev×factor 的 ±12% 內（漲跌幅 10%＋誤差），否則係數不採用（不捏造）。
  const yCache = {};
  const yahooEvents = async (code) => {
    if (yCache[code]) return yCache[code];
    const order = markets[code] === 'otc' ? ['TWO', 'TW'] : ['TW', 'TWO'];
    for (const sfx of order) {
      try {
        const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${code}.${sfx}?interval=1d&range=6mo&events=div%2Csplit`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) });
        const j = r.ok ? await r.json() : null; const res = j?.chart?.result?.[0]; if (!res) continue;
        const ev = res.events || {};
        const iso = ts => new Date(ts * 1000).toISOString().slice(0, 10);
        yCache[code] = {
          splits: Object.values(ev.splits || {}).map(x => ({ date: iso(x.date), s: (+x.numerator) / (+x.denominator) })).filter(x => x.s > 0),
          divs: Object.values(ev.dividends || {}).map(x => ({ date: iso(x.date), amount: +x.amount || 0 })),
        };
        return yCache[code];
      } catch { /* 換後綴 */ }
      await sleep(150);
    }
    return (yCache[code] = { splits: [], divs: [] });
  };
  let mopsPar = {};
  try { mopsPar = await mopsParValueChanges(arch[0].date); } catch { /* 沒有 MOPS 交叉就沒有 */ }
  let withFactor = 0, rejected = 0;
  for (const e of events) {
    const inWin = d => d > e.prevDate && d <= e.date;
    let factor = null, src = null, detail = null;
    if (e.ref > 0) { factor = e.ref / e.prev; src = 'twse'; }
    else {
      const y = await yahooEvents(e.code);
      const sp = y.splits.filter(x => inWin(x.date)); const dv = y.divs.filter(x => inWin(x.date));
      const s = sp.reduce((a, x) => a * x.s, 1); const D = dv.reduce((a, x) => a + x.amount, 0);
      if (sp.length || dv.length) {
        factor = ((e.prev - D) / s) / e.prev; src = 'yahoo'; detail = { s: +s.toFixed(6), div: +D.toFixed(4) };
        if (e.kind === '未對來源') e.kind = s < 1 ? '減資' : s >= 2 ? '面額變更/分割' : s > 1 ? (D > 0 ? '除權息' : '除權') : '除息';
      }
      const mp = mopsPar[e.code]?.find(x => x.date >= e.prevDate && x.date <= e.date);
      if (mp) { e.mops = { oldPar: mp.oldPar, newPar: mp.newPar, at: mp.date }; if (factor == null) { factor = mp.newPar / mp.oldPar; src = 'mops'; if (e.kind === '未對來源') e.kind = '面額變更'; } }
      await sleep(120);
    }
    if (factor != null) {
      const dev = e.close / (e.prev * factor) - 1;
      if (Math.abs(dev) > 0.12) { e.factorRejected = { factor: +factor.toFixed(6), src, firstDayDev: +(dev * 100).toFixed(1) }; factor = null; src = null; rejected++; }
    }
    e.factor = factor != null ? +factor.toFixed(6) : null; e.factorSrc = src; if (detail) e.yahoo = detail;
    if (e.factor) withFactor++;
  }
  events.sort((a, b) => b.date.localeCompare(a.date));
  await db.collection('priceEvents').doc('latest').set({
    dataDate: arch[arch.length - 1].date, updatedAt: Date.now(), fetchedAt: Date.now(), n: events.length, items: events,
    window: { from: arch[0].date, to: arch[arch.length - 1].date, days: arch.length }, band: [PRICE_EVENT_LO, PRICE_EVENT_HI],
    withFactor, rejected,
    note: '相鄰有收盤日比值超出 ±20% 的價格結構事件（減資／面額變更／分割／大額除權或資料錯誤）。factor＝事件前價格×factor≈事件後口徑（來源 twse／yahoo／mops，首日 ±12% 檢核不過者不給）。歸檔原始序列不回寫；已接入的榜見各 doc 的 priceEventsApplied。非投資建議。',
  });
  log(`✓ 價格結構事件：${events.length} 件（${arch[0].date}～${arch[arch.length - 1].date}；有係數 ${withFactor}、檢核剔除 ${rejected}、TWSE 減資 ${events.filter(e => e.ref).length}）`);
  return true;
}
// 代號→市場（自快照；tse/otc）
async function marketIndexMap() {
  const snap = (await db.collection('marketSnapshot').doc('latest').get()).data();
  const q = snap?.quotesJson ? JSON.parse(snap.quotesJson) : {};
  const out = {}; for (const c in q) if (q[c]?.market) out[c] = q[c].market; return out;
}
// MOPS 面額變更公告解析：{code: [{date, oldPar, newPar}]}（只讀 mopsNews 有的日子；09-16 起才有資料）
async function mopsParValueChanges(fromIso) {
  const snap = await db.collection('mopsNews').where('date', '>=', fromIso).get();
  const out = {};
  for (const d of snap.docs) {
    if (d.id === 'latest') continue;
    const items = d.data().itemsJson ? Object.values(JSON.parse(d.data().itemsJson)) : [];
    for (const it of items) {
      const m = String(it.subject || '').match(/面額[由從]?「?新台幣\s*([\d.]+)\s*元」?變更為「?新台幣\s*([\d.]+)\s*元/);
      if (!m) continue;
      (out[it.code] ||= []).push({ date: d.id, oldPar: +m[1], newPar: +m[2] });
    }
  }
  return out;
}
// ── 還原係數的套用（各榜逐一接入時共用；2026-09-17 先接 dailySeq、swingHold）──
//   輸入「舊→新」的 days（[{date, m}]），回傳新陣列：事件日之前（date < ev.date）該檔的 收/開/高/低 × factor，
//   張數不動（成交額請用原始 days 算）。沒有係數的事件不動（只在事件表上看得到）。不改動傳入物件。
async function loadPriceFactors() {
  const d = (await db.collection('priceEvents').doc('latest').get()).data();
  const out = {};
  for (const e of (d?.items || [])) if (e.factor > 0 && e.code && e.date) (out[e.code] ||= []).push({ date: e.date, factor: e.factor });
  return out;
}
function applyPriceFactors(days, factors) {
  const codes = Object.keys(factors || {});
  if (!codes.length) return days;
  return days.map(d => {
    let copy = null;
    for (const code of codes) {
      const row = d.m[code]; if (!row) continue;
      let f = 1; for (const ev of factors[code]) if (d.date < ev.date) f *= ev.factor;
      if (f === 1) continue;
      if (!copy) copy = { ...d.m };
      copy[code] = row.map((v, i) => (i === 1 ? v : (v > 0 ? +(v * f).toFixed(2) : v)));
    }
    return copy ? { ...d, m: copy } : d;
  });
}
// 代號→名稱（自快照；失敗回空表，呼叫端自行 catch）
async function nameIndexMap() {
  const snap = (await db.collection('marketSnapshot').doc('latest').get()).data();
  const q = snap?.quotesJson ? JSON.parse(snap.quotesJson) : {};
  const out = {}; for (const c in q) if (q[c]?.name) out[c] = q[c].name; return out;
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
  // 上市樣本（權值股，必定在 T86 名單內）——與 hasOtcInst 對稱，用來判斷上市那半有沒有進來
  const hasTseInst = (() => { try { const m = cur.instJson ? JSON.parse(cur.instJson) : null; return m ? ['2330', '2317', '2454', '2882'].some(c => m[c]) : false; } catch { return false; } })();
  if (!cur.instJson || !hasOtcInst || !hasTseInst) {
    const inst = {};
    try { const m = cur.instJson ? JSON.parse(cur.instJson) : {}; Object.assign(inst, m); } catch { /* fresh */ }
    // ⚠**守門要看「上市有沒有」，不能看「instJson 存不存在」**（2026-08-10 修）：
    //   舊版是 `if (!cur.instJson)`——只要某一輪先把上櫃寫進去（TPEx 較早出或 T86 該次失敗），
    //   之後每一輪都看到 instJson 已存在而**永遠跳過 T86**，上市法人就此補不回來。
    //   實測：2026-07-21 起連續 14 天的法人資料只有上櫃（779 檔）、完全沒有 2330 等上市股。
    //   ⇒ 改為與 hasOtcInst 對稱的 hasTseInst 判定：缺哪一邊就補哪一邊。
    if (!hasTseInst) {
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
  // ⚠ 條件不能只寫 `!cur.marginJson`（2026-08-11）：只要上市那半先寫進去，
  //   這道判斷就永遠成立不了，上櫃**再也不會補**——與 hasOtcInst 當初的 bug 同型。
  //   用上櫃樣本股（6274 台燿／8069 元太／5483 中美晶）判斷上櫃那半到底進來沒有。
  const hasOtcMargin = (() => {
    try { const m = cur.marginJson ? JSON.parse(cur.marginJson) : null;
      return m ? ['6274', '8069', '5483'].some(c => m[c]) : false; } catch { return false; }
  })();
  if ((!cur.marginJson || !hasOtcMargin) && mins >= 21 * 60 + 30) {
    const mg = await J(`https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${ymd}&selectType=ALL&response=json`);
    // 回音驗證：資券餘額歸檔錯日 = 整段歷史被污染，且不會有任何徵兆
    const mtb = String(mg?.date || '') === ymd ? (mg?.tables || []).find(t => (t.data || []).length > 100) : null;
    if (mg && String(mg?.date || '') !== ymd) log(`  ⚠ 歸檔 MI_MARGN 回音 ${mg?.date} ≠ ${ymd}，不併入`);
    // 沿用既有（可能已有上市那半），避免重跑時把上市資料丟掉
    const margin = (() => { try { return cur.marginJson ? JSON.parse(cur.marginJson) : {}; } catch { return {}; } })();
    for (const r of (mtb?.data || [])) { const c = (r[0] || '').trim(); if (/^\d{4}$/.test(c)) margin[c] = [Math.round(_f(r[6])), Math.round(_f(r[12]))]; }
    // ── 上櫃資券合併（2026-08-11 補）──────────────────────────────────
    // ⚠ **每日流程原本只收上市**，上櫃資券只存在於一次性腳本 backfill-margin-tpex.mjs。
    //   後果不是「少一點」而是**宇宙砍半**：實測 2026-08-11 當日 marginJson 僅 1,066 檔
    //   （08-10 為 1,865），而當天「法人籌碼推選」的宇宙從 1,880 掉到 1,075。
    //   這與 2026-07-20 那次「daemon 只收上市法人 → 上櫃法人整段缺失五個月」
    //   是**完全相同的形狀**，只是換成資券——當時修了法人卻沒回頭看資券。
    //   ⇒ 比照法人區塊：回音驗證日期後合併，且只補不覆蓋（上市優先）。
    try {
      const dSlash = encodeURIComponent(`${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}`);
      const tpm = await J(`https://www.tpex.org.tw/www/zh-tw/margin/balance?date=${dSlash}&response=json`);
      if (tpm && String(tpm.date || '') !== ymd) log(`  ⚠ 歸檔上櫃資券回音 ${tpm?.date} ≠ ${ymd}，不併入`);
      else if (Array.isArray(tpm?.tables?.[0]?.data)) {
        let add = 0;
        for (const r of tpm.tables[0].data) {
          const c = String(r[0] || '').trim();
          if (/^\d{4}$/.test(c) && !margin[c]) { margin[c] = [Math.round(_f(r[2])), Math.round(_f(r[3]))]; add++; }
        }
        if (add) log(`  ℹ 上櫃資券併入 ${add} 檔`);
      }
    } catch (e) { log('  ⚠ 上櫃資券合併失敗:', e.message); }
    if (Object.keys(margin).length > 100) patch.marginJson = JSON.stringify(margin);
  }
  // ── 借券餘額 + 當沖張數（2026-08-10 補上每日歸檔）────────────────
  // ⚠**這兩項原本只有回補腳本寫過，從來沒接進每日流程**，所以自 2026-07-17
  //   最後一次手動回補後就斷了 21 個交易日。後果不是「少一點資料」而是
  //   **overheatV1 規則（條件含 借券/均量>1）自 7/18 起永遠不可能觸發**——
  //   daemon log 天天顯示「過熱出貨 0」看起來很正常，其實是資料沒了。
  //   ⚠這是 bookDepth 那次教訓的原封重演：**回補完沒接每日更新，等於沒有這個資料源**。
  //   兩者都做回音驗證（自報日期 ≠ 目標日就不寫），寧可留空也不寫錯日的資料。
  // ⚠ 與資券/法人同型的潛伏 bug（2026-08-11 預防性修）：只寫 `!cur.lendingJson` 的話，
  //   只要上市那半先成功、上櫃那次失敗（網路抖動/TPEx 晚出），
  //   lendingJson 就會以「只有上市」的狀態定案，**當天永遠不再補上櫃**。
  //   目前實測 12/12 天上櫃樣本齊全＝還沒引爆，但條件本身是錯的。
  const hasOtcLend = (() => {
    try { const m = cur.lendingJson ? JSON.parse(cur.lendingJson) : null;
      return m ? ['6274', '8069', '5483'].some(c => m[c] !== undefined) : false; } catch { return false; }
  })();
  if (!cur.lendingJson || !hasOtcLend) {
    const dSlash = `${tw.getFullYear()}/${String(tw.getMonth() + 1).padStart(2, '0')}/${String(tw.getDate()).padStart(2, '0')}`;
    const lend = (() => { try { return cur.lendingJson ? JSON.parse(cur.lendingJson) : {}; } catch { return {}; } })();
    const twL = await J(`https://www.twse.com.tw/rwd/zh/marginTrading/TWT93U?date=${ymd}&response=json`);
    if (twL?.stat === 'OK' && String(twL?.date || '') === ymd && Array.isArray(twL.data)) {
      for (const r of twL.data) { const c = String(r[0] || '').trim(); if (/^\d{4}$/.test(c)) lend[c] = Math.round(_f(r[12]) / 1000); }
    }
    await sleep(1200);
    const tpL = await J(`https://www.tpex.org.tw/www/zh-tw/margin/sbl?date=${dSlash}&response=json`);
    // ⚠ 上櫃這半**原本沒有回音驗證**，但上方註解卻寫著「兩者都做回音驗證」——
    //   註解與程式碼不符比沒有註解更危險：下一個人（包括我自己）會相信它。
    //   實測這支對未來日期會誠實回 0 筆，所以尚未造成錯日資料，
    //   但 BWIBBU 那支就是「忽略 date 參數照回最新一份」——同一家機構不同端點行為並不一致，
    //   不能假設。補上與上市同口徑的驗證。
    if (tpL && String(tpL.date || '') !== ymd) log(`  ⚠ 歸檔上櫃借券回音 ${tpL?.date} ≠ ${ymd}，不併入`);
    else if (Array.isArray(tpL?.tables?.[0]?.data)) {
      for (const r of tpL.tables[0].data) { const c = String(r[0] || '').trim(); if (/^\d{4}$/.test(c)) lend[c] = Math.round(_f(r[12]) / 1000); }
    }
    if (Object.keys(lend).length > 100) patch.lendingJson = JSON.stringify(lend);
    await sleep(1200);
  }
  // ⚠ 又是同型閘門（本日第三次）：只看 dayTradeJson 的話，上市當沖先寫入後
  //   新增的上櫃兩欄就**永遠不會被寫**。新增欄位時必須同步放寬觸發條件。
  if (!cur.dayTradeJson || !cur.dtOtcEligibleJson || !cur.dtOtcStat) {
    const dt = await J(`https://www.twse.com.tw/exchangeReport/TWTB4U?response=json&date=${ymd}&selectType=All`);
    if (dt?.stat === 'OK' && String(dt?.date || '') === ymd) {
      // ⚠**不能只用「證券代號」找表**：這支 API 回兩張都含證券代號的表——
      //   一張是「暫停現股賣出後現款買進當沖註記」(3欄)、一張才是當沖成交量(6欄)，
      //   而且兩者順序在不同呼叫間會變。只找證券代號會隨機抓到註記表 → 解析出 0 筆 → 靜默不寫。
      //   ⇒ 必須同時要求「證券代號」**與**「當日沖銷…成交股數」兩個欄位。
      const tbl = (dt.tables || []).find(x => (x.fields || []).includes('證券代號')
        && (x.fields || []).some(f => /當日沖銷.*成交股數/.test(String(f).replace(/\s/g, ''))));
      if (tbl?.data?.length) {
        const iCode = tbl.fields.indexOf('證券代號');
        const iVol = tbl.fields.findIndex(f => /當日沖銷.*成交股數/.test(String(f).replace(/\s/g, '')));
        const by = {};
        for (const row of tbl.data) {
          const c = String(row[iCode] || '').trim(); if (!/^\d{4}$/.test(c)) continue;
          const lots = Math.round(parseFloat(String(row[iVol] || '0').replace(/,/g, '')) / 1000);
          if (lots > 0) by[c] = lots;
        }
        // ⚠ **dayTradeJson 只有上市，沒有上櫃**（2026-08-11 確認：962 檔·上櫃樣本 0/3）。
        //   這是已知的設計限制（bt-core 的 dtRatio 欄位註解已載明「僅上市」），不是漏抓。
        //   ⇒ **不要**看到只有 900 多檔就順手加上櫃：dtRatio 是回測用過的變數，
        //     擴充母體等於換一個變數，必須重跑兩窗＋OOT 才能用。
        //   在這裡留字，是因為法人/資券/借券都補了上櫃，只有這欄沒有——
        //   沒有說明的話，下一個人（包括我自己）會以為這是遺漏而「順手修好」。
        if (Object.keys(by).length > 100) patch.dayTradeJson = JSON.stringify(by);
      }
    }
    await sleep(1200);

    // ── 上櫃當沖（2026-08-11 使用者指定加入）──────────────────────────
    // ⚠ **TPEx 沒有公布逐檔當沖成交量**——這不是漏抓，是上游真的沒有。
    //   查證範圍：openapi swagger 全部 225 支端點中提到「當沖」的只有 5 支，
    //   逐檔那支 tpex_securities 只有標的清單與暫停註記、無成交量；
    //   www/zh-tw/intraday/stat 只接受 type=Daily（市場總計，n=1）；
    //   日收盤報價 tpex_mainboard_daily_close_quotes 的 18 個欄位也沒有當沖欄。
    //   ⇒ 能拿到的只有「資格清單」與「市場總量」，兩者都存，但**必須與 dayTradeJson 分開**：
    //     dayTradeJson 是**逐檔張數**，把資格清單併進去會讓 dtRatio 變成
    //     「有些檔是量、有些檔是 1」的垃圾，而且完全看不出來。
    //   ⇒ dtRatio 的母體因此**仍然只有上市**，回測可比性不受本次改動影響。
    try {
      // ⚠ 這裡**必須自己宣告 dSlash**：上面那個是借券區塊的 block-scoped const，
      //   跨區塊引用會是 ReferenceError，而且會被下方的 try/catch 吞成一行警告
      //   「上櫃當沖抓取失敗」——看起來像上游問題，其實是我們自己的作用域錯誤。
      const dSlash = `${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
      const secs = await J('https://www.tpex.org.tw/openapi/v1/tpex_securities');
      const roc = String(parseInt(iso.slice(0, 4), 10) - 1911) + ymd.slice(4);
      if (Array.isArray(secs) && secs.length > 100) {
        const d0 = String(secs[0]?.['資料日期'] || '');
        if (d0 && d0 !== roc) log(`  ⚠ 上櫃當沖標的回音 ${d0} ≠ ${roc}，不寫入`);
        else {
          const el = {};
          for (const x of secs) {
            const c = String(x['證券代號'] || '').trim();
            if (!/^\d{4}$/.test(c)) continue;
            const susp = String(x['暫停現股賣出後現款買進當沖註記'] || '').trim();
            el[c] = susp ? 2 : 1;         // 1=可現股當沖　2=暫停先賣後買（僅能先買後賣）
          }
          if (Object.keys(el).length > 100) patch.dtOtcEligibleJson = JSON.stringify(el);
        }
      }
      await sleep(1200);
      const st = await J(`https://www.tpex.org.tw/www/zh-tw/intraday/stat?date=${dSlash}&type=Daily&response=json`);
      const stb = st?.tables?.[0];
      if (st && String(st.date || '') !== ymd) log(`  ⚠ 上櫃當沖統計回音 ${st?.date} ≠ ${ymd}，不寫入`);
      else if (stb?.fields?.length && stb?.data?.[0]) {
        const g = name => { const i = stb.fields.findIndex(f => String(f).replace(/\s/g, '') === name); return i < 0 ? null : _f(stb.data[0][i]); };
        const lots = g('當日沖銷交易總成交股數');
        patch.dtOtcStat = {
          lots: lots != null ? Math.round(lots / 1000) : null,          // 張
          pctOfMarket: String(stb.data[0][stb.fields.findIndex(f => /占市場比重/.test(String(f)))] || ''),
          buyAmt: g('當日沖銷交易總買進成交金額'), sellAmt: g('當日沖銷交易總賣出成交金額'),
          note: '上櫃當沖**市場總量**（TPEx 未公布逐檔量）',
        };
      }
    } catch (e) { log('  ⚠ 上櫃當沖抓取失敗:', e.message); }
  }

  patch.complete = !!((cur.instJson || patch.instJson) && cur.closeJson);
  // ⚠ 沒有任何實料就**不要建文件**（2026-08-12）。
  //   本函式會在 daemon 重啟時的補跑清單裡被叫到，若那時是盤前，
  //   所有 fetch 都拿不到當日資料、每個 if 區塊都跳過，patch 只剩
  //   {date, at, market, complete:false}——但 `set()` 照樣把它寫下去，
  //   於是 chipArchive 多出一份「日期最新、內容全空」的殼。
  //   它不會讓任何程式壞掉，只會讓 orderBy('date','desc') 的第一筆變成空的：
  //   法人資料整片歸零、日 K 視窗整體位移一天、dataDate() 回報錯的資料日期。
  //   已存在的文件仍要 merge（15:10 寫收盤、21:45 補資券就是靠這條路）。
  const hasPayload = Object.keys(patch).some(k => !['date', 'at', 'market', 'complete'].includes(k));
  if (!hasPayload && !Object.keys(cur).length) {
    log(`· 籌碼歸檔 ${iso}：本輪無任何當日資料，略過建檔（避免產生空殼文件）`);
    return;
  }
  await ref.set(patch, { merge: true });
  const _instTag = (() => { try { const m = JSON.parse(patch.instJson || cur.instJson || 'null'); if (!m) return '—';
    const tse = ['2330', '2317', '2454', '2882'].some(c => m[c]), otc = ['6274', '8069', '3260', '5347', '3105'].some(c => m[c]);
    return tse && otc ? '✓' : tse ? '上市✓上櫃缺' : otc ? '上櫃✓上市缺' : '？'; } catch { return '？'; } })();
  log(`✓ 籌碼歸檔 ${iso}：法人${_instTag} 資券${(cur.marginJson || patch.marginJson) ? '✓' : '—'}`
    + ` 借券${(cur.lendingJson || patch.lendingJson) ? '✓' : '—'} 當沖${(cur.dayTradeJson || patch.dayTradeJson) ? '✓' : '—'}（收盤另依資料日歸檔）`);
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
  const arch = await readArchive(23);   // 21+2；濾空殼後 maps 不會出現 {} 位移
  if (!arch.length) return;
  const maps = arch.map(a => JSON.parse(a.closeJson));
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
    // R10（2026-09-12）：CSV 空（含抓取失敗）就棄權——原本會拿 0 檔算盤型並覆寫 marketPattern/latest，
    // 上一份好的撿尾盤榜被「今天沒有」蓋掉，而那其實是 TWSE 一次暫時性失敗。
    if (csv.length === 0) { log('  ⚠ 撿尾盤/盤型：STOCK_DAY_ALL 回空，本輪棄權（保留上一份 latest）'); return; }
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
  const arch = await readArchive(26);   // 24+2；inst/close 再各自子過濾
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
  const arch = await readArchive(20);
  const sum = {}, cnt = {};
  for (const x of arch) { const c = JSON.parse(x.closeJson); for (const code in c) { const v = c[code][1] || 0; if (v > 0) { sum[code] = (sum[code] || 0) + v; cnt[code] = (cnt[code] || 0) + 1; } } }
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
    const arch = await readArchive(24);   // 22+2；margin/lending 於下方各取「最近有該欄位的日子」
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
    // ── hi20 必須是「**今天以前**的 20 日高」（2026-08-26 使用者截圖查出）──
    // 舊版從 k=0 起算，而 15:10 收盤歸檔後 maps[0] 就是**今天**，於是
    // 「今日收在 20 日新高」時 hi20 恰好等於今日收盤，`price > hi20` 永遠為 false
    //  ⇒ 🏔破高(+2) 在真正突破的當天反而不觸發，改判成 💪強尾(−2)，
    //    同一檔股票憑空少 4 分，而且只在**收盤後**發作（盤中 maps[0] 還是昨天，
    //    所以白天看是對的、晚上規劃隔日單時是錯的，最難察覺的一種）。
    //    實案：台虹 8039 收 320.5 創高，hi20 也被算成 320.5 → 顯示 💪強尾。
    const archIsToday = arch[0]?.date === isoDate(taipei());
    const hiFrom = archIsToday ? 1 : 0;          // 歸檔已含今日 → 從 t-1 起算
    for (const c of codes) {
      let h = 0; for (let k = hiFrom; k < Math.min(20 + hiFrom, maps.length); k++) { const v = maps[k]?.[c]?.[0]; if (v > h) h = v; }
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
  const arch = await readArchive(40, 'marginJson');
  const marginTot = arch.map(x => { const m = JSON.parse(x.marginJson); let s = 0; for (const c in m) s += m[c][0] || 0; return s; }); // 新→舊(張)
  const mNow = marginTot[0] || 0; const mPeak = Math.max(...marginTot, 1);
  const marginDrop = (mPeak - mNow) / mPeak * 100;
  const marginStable = marginTot.length >= 5 ? (marginTot[0] >= marginTot[4] * 0.995) : false;
  // 外資 5 日淨（chipDaily 全市場加總）
  const win = await loadChipWindow(5);
  const f5 = win.reduce((s, w) => { let t2 = 0; for (const c in w.map) t2 += w.map[c][0] || 0; return s + t2; }, 0);
  // 量能：全市場 5 日均量 vs 20 日均量（chipArchive closeJson 加總）
  const arch2 = await readArchive(20);
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
  const days = (await readArchive(74)).map(x => ({ date: x.date, close: JSON.parse(x.closeJson) }))
    .filter(x => Object.keys(x.close).length > 500).slice(0, 62).reverse(); // 新→舊取62 → 轉舊→新
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
    // 第二道防線（2026-08-27）：即使上游報價出錯，也不把「今日最高從未到過
    // 漲停價」的股票記進順序流。luSets 是用即時價算的，報價一旦失真就會污染
    // 這份逐分累積的清單，而它**寫進去就不會自己消失**（seen 是累積的）。
    for (const c of luSets[t]) {
      if (_luFlow.seen.has(c)) continue;
      const q = quo[c];
      const prevC = prev.close[c]?.[0];
      if (q && prevC > 0) {
        const raw = prevC * 1.1, tk = luTick(raw), limitP = Math.floor(raw / tk + 1e-9) * tk;
        const hi = q.high || 0;
        if (!(hi > 0 && hi >= limitP - 1e-6)) continue;   // 今日最高沒到過漲停 → 不記
      }
      _luFlow.seen.set(c, { code: c, name: nameOfQ(c), time: hhmm, ind: indMap[c] || null });
    }
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
        // chg 補齊（2026-09-01）：A 榜有 chg、B 榜沒有——同榜不同 schema 讓下游
        // 合併兩榜時拿到 undefined（newsDump 實測印出「漲undefined%」）。
        code, name, market: q?.market || 'tse', price: +c0.toFixed(2), chg: +feats.chg0.toFixed(2), est, luCnt5,
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
        // ── 新聞判別加值（2026-08-28 接上）──────────────────────────
        // 漲停預測是站上最後一條沒有新聞 AI 的預測線。同日的正面對決證明
        // 純籌碼＋動能已無增益（107/930 vs 107/930），所以新聞是唯一剩下的
        // 槓桿——但**是不是真的有用，只能靠這個數字回答**。
        // 沒有存檔就是 null，不為了有數字而假造（同 squeezeReview 的規矩）。
        let newsLift = null;
        try {
          const rec = (await db.collection('limitUpRecommend').doc(dataDate).get()).data();
          if (rec?.items?.length) {
            const byCode = {};
            for (const x of rec.items) byCode[x.code] = x.verdict?.label ?? null;
            const grp = { 利多: [], 中性: [], 資訊不足: [], 利空: [] };
            for (const c of pd.codes) { const lb = byCode[c]; if (lb && grp[lb]) grp[lb].push(actual.has(c) ? 1 : 0); }
            const g = k => grp[k].length
              ? { n: grp[k].length, hitRate: +(grp[k].reduce((a, b) => a + b, 0) / grp[k].length * 100).toFixed(1) }
              : { n: 0 };
            newsLift = { bull: g('利多'), neutral: g('中性'), none: g('資訊不足'), bear: g('利空') };
          }
        } catch { /* 無存檔就是 null */ }

        const review = {
          date: dataDate, predDate: pd.dataDate, at: Date.now(),
          hit10: hit(10), hit30: hit(30), actualLU: actual.size,
          hits: pd.codes.filter(c => actual.has(c)).map(c => ({ code: c, name: nameOfQ(c) })),
          failed, missed: missed.sort((a, b) => (b.lu60 || 0) - (a.lu60 || 0)).slice(0, 40), missTally,
          newsLift,
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
    const mm = (await readArchive(8, 'marginJson')).slice(0, 2).map(x => JSON.parse(x.marginJson));
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
  const cArch = await readArchive(10);
  const closeByDate = {}; for (const a of cArch) closeByDate[a.date] = JSON.parse(a.closeJson);
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

// ── 🐻 做空風控候選榜 shortCandidates（2026-09-03·使用者核准第一期）────
// 設計原則（股市分析師規畫定稿）：空單虧損不對稱（理論無上限），
// **風控過濾放在選股之前**——先砍「不能空的」與「會被軋的」，再挑弱勢股。
// 全部組件取自站上現成資料（詳 note）；新增訊號未經 OOT 前只做展示排序，
// 分數僅供排列，不宣稱勝率。⚠ 榜單為研究輔助，非投資建議。
//
// 資格層：可先賣現股當沖（繞開平盤下融券限制的合法路徑）·非處置股·
//         非除權息回補期(14日)·流動性(20日均額>5000萬)。興櫃天然不在 chipArchive。
// 風控層：軋空候選榜反查排除（站上獨有優勢）·券資比>15% 排除。
// 評分層：外資連賣·量價背離出貨·寶塔翻空·均線空頭·反轉訊號4空方清單·
//         AI 利空判別（讀內文版·priced 減半）·當日弱勢。
// 市況層：大盤健康度<50 → active；否則 watch（榜照出，標示觀察模式）。

// 處置股名單（TWSE＋TPEx openapi）。回傳 Set<code>，僅含「今日在處置期間內」者。
// ⚠ 民國日期期間解析：'115/09/03～115/09/09' 或 '1150903~1150909' 兩種格式都要吃。
async function fetchPunishSet() {
  const parseRocDate = (t) => {
    const m1 = String(t || '').match(/(\d{2,3})\/(\d{1,2})\/(\d{1,2})/);
    if (m1) return `${+m1[1] + 1911}${String(+m1[2]).padStart(2, '0')}${String(+m1[3]).padStart(2, '0')}`;
    const m2 = String(t || '').match(/(\d{7})/);
    if (m2) return `${+m2[1].slice(0, 3) + 1911}${m2[1].slice(3)}`;
    return null;
  };
  const today = ymd8(taipei());
  const out = new Set();
  const UA = { 'User-Agent': 'Mozilla/5.0' };
  try {
    const j = await fetch('https://openapi.twse.com.tw/v1/announcement/punish', { headers: UA, signal: AbortSignal.timeout(12000) }).then(r => r.json());
    for (const x of (Array.isArray(j) ? j : [])) {
      const seg = String(x.DispositionPeriod || '').split(/[～~]/);
      const from = parseRocDate(seg[0]), to = parseRocDate(seg[1]);
      if (x.Code && from && to && today >= from && today <= to) out.add(String(x.Code).trim());
    }
  } catch { /* 單邊失敗不擋，由呼叫端記 skippedFilters */ }
  try {
    const j = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_disposal_information', { headers: UA, signal: AbortSignal.timeout(12000) }).then(r => r.json());
    for (const x of (Array.isArray(j) ? j : [])) {
      const seg = String(x.DispositionPeriod || '').split(/[～~]/);
      const from = parseRocDate(seg[0]), to = parseRocDate(seg[1]);
      const code = String(x.SecuritiesCompanyCode || '').trim();
      if (code && from && to && today >= from && today <= to) out.add(code);
    }
  } catch { /* 同上 */ }
  return out;
}

async function computeShortCandidates() {
  const archRaw = await readArchive(21, 'closeJson');
  if (archRaw.length < 21) { log('  ⚠ 做空候選：chipArchive 不足 21 日'); return; }
  // readArchive 回 raw doc（closeJson 是字串）——先 parse 成 {date, map}
  const arch = archRaw.map(d => ({ date: d.date, map: JSON.parse(d.closeJson) }));
  const asc = arch.slice().reverse();                          // 舊→新
  const latest = arch[0];
  const close = latest.map;
  const skipped = [];

  // ── 各資料源（缺哪個就跳過該濾網並誠實記錄，不捏造也不擋整支）────────
  const [dtDoc, pagodaDoc, divgDoc, nvDoc, healthDoc, sqDoc, divCalDoc, revDoc, marginArr, lendArr, windDoc, prevBoard] = await Promise.all([
    db.collection('dayTradeEligible').doc('latest').get().then(d => d.data()).catch(() => null),
    db.collection('pagodaSignals').doc('latest').get().then(d => d.data()).catch(() => null),
    db.collection('chipDivergence').doc('latest').get().then(d => d.data()).catch(() => null),
    db.collection('newsVerdict').doc('latest').get().then(d => d.data()).catch(() => null),
    db.collection('marketHealth').doc('latest').get().then(d => d.data()).catch(() => null),
    db.collection('squeezePicks').doc('latest').get().then(d => d.data()).catch(() => null),
    db.collection('dividendCalendar').doc('latest').get().then(d => d.data()).catch(() => null),
    db.collection('reversalSignals').doc('latest').get().then(d => d.data()).catch(() => null),
    readArchive(3, 'marginJson').catch(() => []),
    readArchive(3, 'lendingJson').catch(() => []),
    db.collection('sectorWind').doc('latest').get().then(d => d.data()).catch(() => null),
    db.collection('shortCandidates').doc('latest').get().then(d => d.data()).catch(() => null),
  ]);
  const punish = await fetchPunishSet();
  if (!punish.size) skipped.push('處置股(名單抓取失敗或今日空)');

  const dtMap = dtDoc?.codesJson ? JSON.parse(dtDoc.codesJson) : null;
  if (!dtMap) skipped.push('當沖先賣資格(無資料→整層跳過會放進不可空標的，故改為全部標記未知)');
  const pagoda = pagodaDoc?.dailyJson ? JSON.parse(pagodaDoc.dailyJson) : {};
  const distSet = new Set((divgDoc?.distribute || []).map(x => x.code));
  let verdicts = {};
  try { if (nvDoc?.verdictJson) verdicts = JSON.parse(nvDoc.verdictJson); } catch { /* 缺判別→利空加權跳過 */ }
  if (!Object.keys(verdicts).length) skipped.push('AI利空判別(無累積判別)');
  const squeezeSet = new Set((sqDoc?.items || []).map(x => x.code));
  let margin = {};
  try { if (marginArr?.[0]?.marginJson) margin = JSON.parse(marginArr[0].marginJson); } catch { /* 缺資券→券資比濾網跳過 */ }
  if (!Object.keys(margin).length) skipped.push('券資比(無資券歸檔)');
  const exSoon = new Set();
  const exWarn = new Map();                                    // code → 距除權息天數(15~30)
  {
    // dividendCalendar 的 date 是**民國格式**（'1150903' 或 '115/09/03'）——不是 ISO
    const rocToMs = (t) => {
      const m = String(t || '').replace(/\//g, '').match(/^(\d{3})(\d{2})(\d{2})$/);
      return m ? Date.UTC(+m[1] + 1911, +m[2] - 1, +m[3]) - 8 * 3600000 : null;
    };
    const now = Date.now();
    for (const e of (divCalDoc?.upcoming || [])) {
      const t = rocToMs(e.date);
      if (!e.code || t == null) continue;
      if (t > now && t - now < 14 * 86400000) exSoon.add(String(e.code));
      else if (t > now && t - now < 30 * 86400000) exWarn.set(String(e.code), Math.ceil((t - now) / 86400000));
    }
  }
  const revHit = {};                                           // code → [清單名]
  for (const [k, label] of [['down', '過熱出貨'], ['down2', '爆量出貨'], ['down3', '低價過熱'], ['down4', '加權出貨']]) {
    for (const x of (revDoc?.[k] || [])) if (x.code) (revHit[x.code] ||= []).push(label);
  }
  const chipWin = await loadChipWindow(8).catch(() => []);
  if (!chipWin.length) skipped.push('法人連賣(chipDaily 視窗空)');
  // 借券餘額（A1 因子·二期補上）：{code: 股數}，取最近兩個有資料日算日增
  let lendMap = {}, lendPrev = {};
  try {
    if (lendArr?.[0]?.lendingJson) lendMap = JSON.parse(lendArr[0].lendingJson);
    if (lendArr?.[1]?.lendingJson) lendPrev = JSON.parse(lendArr[1].lendingJson);
  } catch { /* 缺借券→該因子跳過 */ }
  if (!Object.keys(lendMap).length) skipped.push('借券餘額(無歸檔)');
  // 產業標示＋弱勢產業集合（sectorWind 尾 3 名）
  let indMap = {};
  try { indMap = await getIndustryMap(); } catch { /* 缺產業只是少標示 */ }
  const weakSectors = new Set((windDoc?.sectors || []).slice(-3).map(x => x.industry));
  // NEW 標記：比對前一版榜單
  const prevSet = new Set((prevBoard?.items || []).map(x => x.code));
  const nowHM = (() => { const t = taipei(); return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`; })();
  const nameMap = {};
  try { const q = (await readSnapshotQuotes())?.quotes || {}; for (const cc in q) if (q[cc]?.name) nameMap[cc] = q[cc].name; } catch { /* 缺名不擋 */ }

  // 20 日均額與 MA 序列（closeJson: code → [收,量張,開,高,低]）
  const seriesOf = (code) => asc.map(d => d.map[code]).filter(r => Array.isArray(r) && r[0] > 0);
  const items = [];
  const trainRows = [];                                        // 特徵快照（shortTraining 用）
  for (const code of Object.keys(close)) {
    const r = close[code];
    if (!Array.isArray(r) || !(r[0] > 0)) continue;
    const price = r[0];
    const ser = seriesOf(code);
    if (ser.length < 21) continue;
    // 資格層 ───────────────────────────────
    const avgAmt = ser.slice(-20).reduce((s, x) => s + x[0] * (x[1] || 0) * 1000, 0) / 20;
    if (avgAmt < 50_000_000) continue;                          // E7 流動性
    if (punish.has(code)) continue;                             // E3 處置
    if (exSoon.has(code)) continue;                             // E5 回補期
    const dt = dtMap ? (dtMap[code] || 0) : -1;                 // -1=未知
    if (dtMap && dt !== 1) continue;                            // E1/E2 可先賣現股當沖
    // 風控層 ───────────────────────────────
    if (squeezeSet.has(code)) continue;                         // E6 軋空榜反查
    const mg = margin[code];
    const shortRatio = Array.isArray(mg) && mg[0] > 0 ? (mg[1] || 0) / mg[0] * 100 : null;
    if (shortRatio != null && shortRatio > 15) continue;        // 券資比高=軋空燃料
    // 評分層 ───────────────────────────────
    const reasons = [];
    let score = 0;
    const prev = ser[ser.length - 2][0];
    const chg = prev > 0 ? (price - prev) / prev * 100 : 0;
    if (chg < -2) { score += 2; reasons.push(`當日跌${chg.toFixed(1)}%`); }
    const closes = ser.map(x => x[0]);
    const ma = (n) => closes.slice(-n).reduce((s, x) => s + x, 0) / n;
    const ma5 = ma(5), ma20 = ma(20);
    if (ma5 < ma20 && price < ma20) { score += 4; reasons.push('空頭排列(5<20·價在20日線下)'); }
    const low20 = Math.min(...closes.slice(-21, -1));
    if (price < low20) { score += 3; reasons.push('破20日低'); }
    const pg = pagoda[code];
    if (pg?.flip === 'down') { score += 5; reasons.push('寶塔翻黑'); }
    else if (pg && pg.above === false) { score += 2; reasons.push('寶塔線下'); }
    if (distSet.has(code)) { score += 6; reasons.push('量價背離·出貨候選'); }
    if (chipWin.length) {
      const streak = foreignSellStreak(code, chipWin);
      if (streak >= 3) { score += Math.min(8, streak * 2); reasons.push(`外資連賣${streak}日`); }
    }
    for (const lb of (revHit[code] || [])) { score += 8; reasons.push(`反轉訊號·${lb}`); }
    // 借券餘額日增（A1·法人做空主管道）：增幅 > 20 日均量 10% 才算有力道
    let lendChgPct = null;
    {
      const ln = lendMap[code], lp = lendPrev[code];
      if (ln != null && lp != null) {
        const avgVol20 = ser.slice(-20).reduce((s2, x) => s2 + (x[1] || 0), 0) / 20 * 1000;   // 股
        if (avgVol20 > 0) {
          lendChgPct = +(((ln - lp) / avgVol20) * 100).toFixed(1);
          if (ln > lp && (ln - lp) > avgVol20 * 0.1) { score += 4; reasons.push(`借券增(${lendChgPct}%日均量)`); }
        }
      }
    }
    const v = verdicts[code];
    if (v && v.label === '利空') {
      const base = v.strength === '極強' ? 12 : v.strength === '強' ? 10 : v.strength === '中' ? 6 : 3;
      const pts = v.priced === '是' ? Math.round(base / 2) : base;
      score += pts; reasons.push(`AI利空(${v.strength}${v.priced === '是' ? '·已反映減半' : ''})`);
    }
    const ind = indMap[code] || null;
    if (ind && weakSectors.has(ind)) { score += 2; reasons.push(`弱勢產業(${ind})`); }
    // 特徵快照（訓練樣本·全部通過資格+風控層者，含未入榜——避免選擇偏誤）
    trainRows.push({ code, score, chg: +chg.toFixed(2),
      sellStreak: chipWin.length ? foreignSellStreak(code, chipWin) : null,
      bearMa: ma5 < ma20 && price < ma20 ? 1 : 0, brk20: price < low20 ? 1 : 0,
      pagoda: pg?.flip === 'down' ? 2 : (pg && pg.above === false ? 1 : 0),
      dist: distSet.has(code) ? 1 : 0, rev: (revHit[code] || []).length,
      lendChgPct, shortRatio: shortRatio == null ? null : +shortRatio.toFixed(1),
      nv: v && v.label === '利空' ? `${v.strength}${v.priced === '是' ? 'P' : ''}` : null });
    if (score < 8 || reasons.length < 2) continue;              // 至少兩訊號共振
    // 支撐/壓力參考（空單的獲利目標與停損）：近月(21日)最低收=支撐、MA20=壓力
    // ⚠ 視窗只有 21 日就誠實叫近月——不寫 60 日（closes 根本沒 60 筆，A 族的表親）
    const low60 = Math.min(...closes);
    const item = { code, name: nameMap[code] || code, price, open: r[2] > 0 ? r[2] : null, chg: +chg.toFixed(2), score, reasons,
      shortRatio: shortRatio == null ? null : +shortRatio.toFixed(1),
      dayTradeShort: dt === 1 ? true : dt === -1 ? null : false,
      industry: ind,
      support: +low60.toFixed(2), supportPct: +((low60 - price) / price * 100).toFixed(1),
      resist: +ma20.toFixed(2), resistPct: +((ma20 - price) / price * 100).toFixed(1),
      lend: lendMap[code] ?? null, lendChgPct,
      coverDays: exWarn.get(code) ?? null };
    if (!prevSet.has(code)) item.newAt = nowHM;
    if (v && v.label === '利空') { item.verdictReason = (v.reason || '').slice(0, 120); item.verdictQuote = (v.keyQuote || '').slice(0, 80); }
    items.push(item);
  }
  items.sort((a, b) => b.score - a.score);
  const health = healthDoc?.health;
  const mode = health != null && health < 50 ? 'active' : 'watch';
  const doc = {
    updatedAt: Date.now(), dataDate: latest.date || null, mode,
    health: health ?? null,
    items: items.slice(0, 20), totalPassed: items.length,
    trainJson: JSON.stringify(trainRows),                       // 全部通過股的特徵快照（訓練用·含未入榜）
    skippedFilters: skipped,
    note: '做空風控候選。⚠ 歷史回測(2026-09-03·EXPERIMENTS⑦·399天)：機械因子版'
      + '隔日c2c勝率僅48%未過安慰劑、**o2c(開盤進收盤出=當沖空口徑)54-55%兩窗穩定**、'
      + '5日留倉OOT反彈+0.41% ⇒ 定位=當沖空參考·嚴禁波段留倉依據。'
      + '偏空日無超額(全市場齊跌)·多頭日相對超額較大但絕對值貼零——mode僅供參考。'
      + '回測缺AI利空因子(生產版有·前瞻累積驗證中)。'
      + '資格層：可先賣現股當沖·非處置·非除權息回補期(14日)·20日均額>5000萬。'
      + '風控層：軋空候選榜反查排除·券資比>15%排除。研究輔助，非投資建議。',
  };
  await db.collection('shortCandidates').doc('latest').set(doc);
  // 排程跑才寫日期檔（review 對答案的事前存檔）；手動 CLI 只更新 latest——
  // 同 squeezeRecommend 的規矩：事前存檔不可被事後重跑污染。
  if (latest.date && !ONESHOT) await db.collection('shortCandidates').doc(latest.date).set(doc);
  log(`✓ 做空候選：${items.length} 檔過濾後入榜 ${Math.min(20, items.length)} 檔（${mode}·健康度${health ?? '?'}）`
    + (skipped.length ? `　⚠ 跳過濾網：${skipped.join('、')}` : ''));
}

// ── 🐻 做空訓練樣本（2026-09-03·使用者核准）───────────────────────
// 每晚 21:45 搭資券歸檔班車：把當日 shortCandidates 的特徵快照（全部通過
// 資格+風控層者·含未入榜=正負例齊全）存進 shortTraining/{date}。
// 標籤（隔日開→收、5日最大跌幅兩種口徑）**訓練時**從 chipArchive 現算
// ——不逐日回填，PIT 安全且不會有回填斷檔。累積 ~200 交易日後
// 複用 squeeze-train 框架訓練（OOT 70/30＋安慰劑同規）。
async function recordShortTraining() {
  const board = (await db.collection('shortCandidates').doc('latest').get()).data();
  if (!board?.trainJson || !board.dataDate) { log('  ⚠ 做空訓練樣本：無當日榜'); return false; }
  const today = isoDate(taipei());
  if (board.dataDate !== today) { log(`  ⚠ 做空訓練樣本：榜資料日 ${board.dataDate} ≠ 今日，不記（避免週末殘留混入）`); return false; }
  const rows = JSON.parse(board.trainJson);
  await db.collection('shortTraining').doc(board.dataDate).set({
    date: board.dataDate, updatedAt: Date.now(),
    n: rows.length, rowsJson: board.trainJson,
    health: board.health ?? null, mode: board.mode,
    note: '特徵快照（資格+風控層通過全體·含未入榜）。標籤訓練時從 chipArchive 現算：口徑A=隔日開→收、口徑B=5日最大跌幅。',
  });
  log(`✓ 做空訓練樣本：${board.dataDate} ${rows.length} 檔特徵入庫`);
  return true;
}

// ── 🐻 做空候選每日對答案（2026-09-03）─────────────────────────────
// 昨日榜單（shortCandidates/{前一交易日}·排程寫入的事前存檔）對今日結果：
// 空方勝＝今日收<昨收。兩口徑都算（收→收、開→收），history 滾動保留 60 日。
async function computeShortReview() {
  const arch = await readArchive(2, 'closeJson');
  if (arch.length < 2) return false;
  const todayD = arch[0], prevD = arch[1];
  const prevBoard = (await db.collection('shortCandidates').doc(prevD.date).get()).data();
  if (!prevBoard?.items?.length) { log(`  · 做空對答案：${prevD.date} 無事前存檔（首日或假日）`); return false; }
  const closeT = JSON.parse(todayD.closeJson);
  const rows = [];
  for (const it of prevBoard.items) {
    const r = closeT[it.code];
    if (!Array.isArray(r) || !(r[0] > 0)) continue;
    const c2c = it.price > 0 ? (r[0] - it.price) / it.price * 100 : null;        // 收→收
    const o2c = r[2] > 0 ? (r[0] - r[2]) / r[2] * 100 : null;                    // 開→收（隔日沖口徑）
    rows.push({ code: it.code, name: it.name, score: it.score, c2c: c2c == null ? null : +c2c.toFixed(2), o2c: o2c == null ? null : +o2c.toFixed(2) });
  }
  if (!rows.length) return false;
  const ok = rows.filter(x => x.c2c != null);
  const win = ok.filter(x => x.c2c < 0).length;                                  // 空方勝=跌
  const avg = ok.reduce((s, x) => s + x.c2c, 0) / ok.length;
  const day = { date: todayD.date, boardDate: prevD.date, n: ok.length,
    winRate: +(win / ok.length * 100).toFixed(1), avgChg: +avg.toFixed(2),
    best: ok.slice().sort((a, b) => a.c2c - b.c2c)[0] || null,                   // 跌最多=空方最賺
    worst: ok.slice().sort((a, b) => b.c2c - a.c2c)[0] || null,
    mode: prevBoard.mode, health: prevBoard.health ?? null };
  const cur = (await db.collection('shortReview').doc('latest').get()).data() || {};
  const history = (cur.history || []).filter(h => h.date !== day.date);
  history.unshift(day);
  await db.collection('shortReview').doc('latest').set({
    updatedAt: Date.now(), latestDay: day, history: history.slice(0, 60),
    rowsJson: JSON.stringify(rows),
    note: '空方勝=跌。c2c=昨收→今收、o2c=今開→今收（隔日沖口徑）。前瞻累積·樣本內數字不可對外宣稱。非投資建議。',
  });
  log(`✓ 做空對答案：${prevD.date} 榜 ${ok.length} 檔 → 今日勝率 ${day.winRate}%·均 ${day.avgChg}%（空方勝=跌·${prevBoard.mode}）`);
  return true;
}

// ── 🎯 縮量跳空漲停（2026-09-05 使用者核准·EXPERIMENTS ⑨）──────────────────
// 影片「大漲前四特徵」台股化：事件日 = 漲停 ∧ 向上跳空（低>昨高）∧ 當日量 <2× 前 20 日均量
//（量 <1× 標★；倍量在台股是反效果——實測量≥4× 20日 +0.07%、<1× +6.89%）。
// 實測（排除全市場漲停 >60 檔的事件日、去重、t+1 開盤進場、成本 0.4425%）：
//   20 日淨 +6.89%／中位 +1.46%／勝率 53.6%／+30% 命中 28%／5 日最深 −8.8%／22% 隔日開盤鎖漲停買不到。
// 13:36 從快照定榜並推播；15:10 歸檔後重算（不再推播）；每日 review 對答案累積樣本外。停損線＝事件日最低。
let _gapLuDate = '';

// ───────────────────────────────────────────────────────────
// 📈 波段持有（2026-09-16 使用者指定）：近 5／10／20／60 日「連續成長」榜各 25 檔＋整合榜。
//
// 口徑（與 09-16 對談中的即席計算完全一致，方便對照）：
//   · 漲幅＝N 個交易日前收盤 → 最新收盤（收盤對收盤）；N 日內任一天缺收盤就不算（避免日期位移）。
//   · 「連續」用三個數字描述：上漲日數／N、最長連漲、目前連漲（平盤不算漲也不中斷）；
//     並附期間最大回檔——單看漲幅會把「幾根大漲堆出來」和「天天小漲」混成一團。
//   · 流動性閘：20 日均成交額 ≥ 5,000 萬（張×收盤×1000），冷門股不上榜。
//   · 型態標籤：穩健＝上漲日 ≥ 60% 且最大回檔 ≤ 8%；劇烈＝最大回檔 > 12%；其餘＝一般。
//   · 整合榜：四榜取聯集，分數＝Σ(26 − 該榜名次)，先比上榜數再比分數；同時列四榜名次，
//     讓人一眼看出「四個窗都在漲」和「只有短窗衝一下」的差別。
//   · 資料日＝最新收盤歸檔日（chipArchive）；每交易日 16:45 上櫃補跑後產出（收盤定版），
//     另存 swingHold/{dataDate} 當歷史資料（其他功能可引用），latest 只前進不倒退。
//   · 減資／除權息參考價未還原（chipArchive 既有限制），payload.caveats 明示。
// 非投資建議。
// ───────────────────────────────────────────────────────────
// ── 📊 全市場每檔「近 10 日漲跌×成交量＋三線位置」（2026-09-17 使用者：自選各子分頁列上要有）──
// 寫 dailySeq/latest 一份（~2,100 檔 × 23 個數字 ≈ 200KB），web 端 /api/twse/daily-seq 只回要的檔。
// 形狀：[ma5, ma20, ma60, chg1, vol1, …, chg10, vol10]；ma 旗標 1=收盤站上、0=之下、-1=資料不足（不捏造）。
// 資料日＝最新收盤歸檔日；與 computeSwingHold 同一班車（16:45 上櫃補跑後），以 dataDate 冪等。
async function computeDailySeq({ force = false } = {}) {
  const tw = taipei();
  const arch = await readArchive(70, 'closeJson');
  if (arch.length < 11) { log('  ⚠ dailySeq：chipArchive 不足 11 日'); return false; }
  // 價格結構事件還原（2026-09-17 第一批接入）：事件日前的價格乘係數，張數不動；沒有係數的事件不動
  const factors = await loadPriceFactors().catch(() => ({}));
  const days = applyPriceFactors(arch.slice().reverse().map(a => ({ date: a.date, m: JSON.parse(a.closeJson) })), factors);
  const latest = days[days.length - 1];
  const cur = (await db.collection('dailySeq').doc('latest').get()).data();
  // 冪等以「資料日相同且宇宙沒變大」為準：15:10 歸檔只有上市、16:45 才補上櫃——只看資料日會讓上櫃永遠補不進來（09-17 實案 1,089 檔）
  const uniN = Object.keys(latest.m).filter(c => /^\d{4,6}$/.test(c)).length;
  if (!force && cur?.dataDate === latest.date && (cur.n ?? 0) >= uniN * 0.95) { log(`  · dailySeq：${latest.date} 已產出（${cur.n} 檔），略過`); return true; }
  const out = {};
  for (const code of Object.keys(latest.m)) {
    if (!/^\d{4,6}$/.test(code)) continue;
    const cl = days.map(d => d.m[code]?.[0]).filter(v => v > 0);
    if (cl.length < 2) continue;
    const c = cl[cl.length - 1];
    const ma = n => (cl.length >= n ? (c > cl.slice(-n).reduce((s2, v) => s2 + v, 0) / n ? 1 : 0) : -1);
    const win = days.slice(-11);
    const seq = [];
    for (let i = 1; i < win.length; i++) {
      const p = win[i - 1].m[code]?.[0], q = win[i].m[code];
      if (!(p > 0) || !(q?.[0] > 0)) continue;
      seq.push(+(((q[0] / p) - 1) * 100).toFixed(1), Math.round(q[1] || 0));
    }
    if (!seq.length) continue;
    out[code] = [ma(5), ma(20), ma(60), ...seq];
  }
  const doc = { updatedAt: Date.now(), date: isoDate(tw), dataDate: latest.date, n: Object.keys(out).length, byCodeJson: JSON.stringify(out), priceEventsApplied: Object.keys(factors).length };
  await db.collection('dailySeq').doc('latest').set(doc);
  log(`✓ dailySeq ${latest.date}：${doc.n} 檔（${Math.round(doc.byCodeJson.length / 1024)}KB）`);
  return true;
}

const SWING_HOLD_WINDOWS = [5, 10, 20, 60];
const SWING_HOLD_TOP = 25;
const SWING_HOLD_MIN_AMT = 50_000_000;
async function computeSwingHold({ force = false } = {}) {
  const tw = taipei();
  const arch = await readArchive(90, 'closeJson');          // 新→舊
  if (arch.length < 61) { log('  ⚠ 波段持有：chipArchive 不足 61 日'); return false; }
  const daysRaw = arch.slice().reverse().map(a => ({ date: a.date, m: JSON.parse(a.closeJson) }));   // 舊→新（原始，算成交額用）
  // 價格結構事件還原（2026-09-17 第一批接入）：漲幅／連漲／回檔／均線都用還原後價格；成交額用原始價×原始張數
  const factors = await loadPriceFactors().catch(() => ({}));
  const days = applyPriceFactors(daysRaw, factors);
  const latest = days[days.length - 1];
  const cur = (await db.collection('swingHold').doc('latest').get()).data();
  // 冪等以「資料日相同且宇宙沒變大」為準（見 computeDailySeq 同註）：上櫃 16:45 才進歸檔，不能只看資料日
  const uniNow = Object.keys(latest.m).filter(c => /^\d{4}$/.test(c)).length;
  if (!force && cur?.dataDate === latest.date && (cur.universeAll ?? 0) >= uniNow * 0.95) { log(`  · 波段持有：${latest.date} 已產出（宇宙 ${cur.universeAll} 檔），略過`); return true; }
  // 名稱：宇宙清單優先，缺的用快照
  const names = {};
  for (const c of (_codesCache || [])) names[c.code] = { name: c.name, market: c.market };
  // 宇宙快取殘缺時（實案 09-17 重啟時 TPEx 掛掉，_codesCache 只有上市）用快照補缺的名稱，不讓上櫃股名稱空白
  { const q = (await readSnapshotQuotes())?.quotes || {}; for (const c in q) if (!names[c]) names[c] = { name: q[c].name, market: q[c].market }; }
  const amtDays = daysRaw.slice(-20);
  const amtOf = {};
  for (const code of Object.keys(latest.m)) {
    let s = 0, n = 0; for (const d of amtDays) { const r = d.m[code]; if (r && r[0] > 0) { s += r[0] * (r[1] || 0) * 1000; n++; } }
    amtOf[code] = n ? s / n : 0;
  }
  const universe = Object.keys(latest.m).filter(c => /^\d{4}$/.test(c) && amtOf[c] >= SWING_HOLD_MIN_AMT);
  const boards = {};
  for (const N of SWING_HOLD_WINDOWS) {
    const win = days.slice(-(N + 1));
    const rows = [];
    for (const code of universe) {
      const cl = win.map(d => d.m[code]?.[0]);
      if (cl.some(v => !(v > 0))) continue;
      const c0 = cl[0], c = cl[N];
      let up = 0, streak = 0, maxStreak = 0, maxDD = 0, peak = c0;
      for (let i = 1; i <= N; i++) {
        if (cl[i] > cl[i - 1]) { up++; streak++; if (streak > maxStreak) maxStreak = streak; } else if (cl[i] < cl[i - 1]) streak = 0;
        if (cl[i] > peak) peak = cl[i]; const dd = (peak - cl[i]) / peak * 100; if (dd > maxDD) maxDD = dd;
      }
      const gain = (c / c0 - 1) * 100;
      if (!(gain > 0)) continue;
      const type = (up / N >= 0.6 && maxDD <= 8) ? '穩健' : maxDD > 12 ? '劇烈' : '一般';
      // 2026-09-17 使用者：列上要有「價格在 5/20/60 日線之上」的小提示，與區間逐日漲跌×成交量的縮圖（辨識起漲／回落）
      const allCl = days.map(d => d.m[code]?.[0]).filter(v => v > 0);
      const maAbove = [5, 20, 60].map(n => (allCl.length >= n ? c > allCl.slice(-n).reduce((s2, v) => s2 + v, 0) / n : null));
      // Firestore 不接受巢狀陣列 ⇒ 攤平成 [漲跌%, 張, 漲跌%, 張, …]，前端每 2 個一組還原
      const seq = win.slice(1).flatMap((d, i) => [+(((cl[i + 1] / cl[i]) - 1) * 100).toFixed(1), Math.round(d.m[code]?.[1] || 0)]);
      rows.push({ code, name: names[code]?.name || '', market: names[code]?.market || '', c0, price: c, gain: +gain.toFixed(1), up, maxStreak, streak, maxDD: +maxDD.toFixed(1), type, amtM: Math.round(amtOf[code] / 1e6), ma: maAbove, seq });
    }
    rows.sort((a, b) => b.gain - a.gain);
    boards['d' + N] = { window: N, from: win[0].date, to: latest.date, eligible: rows.length, items: rows.slice(0, SWING_HOLD_TOP).map((r, i) => ({ rank: i + 1, ...r })) };
  }
  // 整合榜
  const combo = {};
  for (const N of SWING_HOLD_WINDOWS) for (const it of boards['d' + N].items) {
    const c = (combo[it.code] ||= { code: it.code, name: it.name, market: it.market, price: it.price, boards: 0, score: 0, ranks: {}, gains: {}, streak: it.streak, amtM: it.amtM, ma: it.ma, seq: null, seqWin: 0 });
    if (N === 20 || (c.seqWin !== 20 && N > c.seqWin)) { c.seq = it.seq; c.seqWin = N; }   // 整合榜縮圖：優先用 20 日窗，否則用最長的那個
    c.boards++; c.score += SWING_HOLD_TOP + 1 - it.rank; c.ranks['d' + N] = it.rank; c.gains['d' + N] = it.gain;
  }
  const comboItems = Object.values(combo).sort((a, b) => b.boards - a.boards || b.score - a.score).slice(0, SWING_HOLD_TOP).map((r, i) => ({ rank: i + 1, ...r }));
  const doc = {
    updatedAt: Date.now(), date: isoDate(tw), dataDate: latest.date,
    universe: universe.length, universeAll: uniNow, liquidityGate: '20 日均成交額 ≥ 5,000 萬', windows: SWING_HOLD_WINDOWS, top: SWING_HOLD_TOP,
    method: '漲幅＝N 個交易日前收盤→最新收盤；上漲日／最長連漲／目前連漲（平盤不算漲也不中斷）＋期間最大回檔；穩健＝上漲日≥60% 且回檔≤8%，劇烈＝回檔>12%。整合榜＝四榜聯集，分數 Σ(26−名次)，先比上榜數再比分數。',
    caveats: [`漲幅是收盤對收盤，不含盤中高低；減資／面額變更／除權息以 priceEvents 係數還原（本次 ${Object.keys(factors).length} 檔），沒有係數的事件股仍會失真。`, '這是動能排行不是進場訊號：本站尚未對「連續成長榜」做持有期回測，勝率／期望值未知，請與波段起漲榜（有回測）分開看。', '每交易日 16:45 上櫃檔補跑後定版；當日盤中看到的是前一交易日收盤的排行。'],
    priceEventsApplied: Object.keys(factors).length,
    boards, combo: { items: comboItems },
  };
  await db.collection('swingHold').doc(latest.date).set(doc);
  if (!cur?.dataDate || cur.dataDate <= latest.date) await db.collection('swingHold').doc('latest').set(doc);
  log(`✓ 波段持有 ${latest.date}：宇宙 ${universe.length} 檔｜5日 ${boards.d5.items[0]?.code || '—'} +${boards.d5.items[0]?.gain ?? 0}%｜整合榜首 ${comboItems[0]?.code || '—'}（上榜 ${comboItems[0]?.boards ?? 0} 榜）`);
  return true;
}

async function computeGapLimitUp({ push = false } = {}) {
  const tw = taipei(); const today = process.env.GAPLU_DATE || isoDate(tw);   // GAPLU_DATE=YYYY-MM-DD：用歸檔重算指定事件日（測試/補算）
  const archRaw = await readArchive(process.env.GAPLU_DATE ? 420 : 23 + 25, 'closeJson');   // 補算舊日要讀夠深
  if (archRaw.length < 22) { log('  ⚠ 跳空漲停：chipArchive 不足 22 日'); return false; }
  const arch = archRaw.map(d => ({ date: d.date, map: JSON.parse(d.closeJson) }));
  const snap = await readSnapshotQuotes();
  const names = {}; for (const [k, q] of Object.entries(snap?.quotes || {})) if (q.name) names[k] = q.name;
  let todayMap, prior, srcNote;
  const ai = arch.findIndex(d => d.date === today);
  if (ai >= 0) { todayMap = arch[ai].map; prior = arch.slice(ai + 1); srcNote = '歸檔'; }
  else {
    if (!isTradingDay(tw)) { log('  · 跳空漲停：非交易日且歸檔無今日，略過'); return false; }   // 週末重算會把週五 live 當今日→假事件日
    if (!snap) return false;
    todayMap = {};
    for (const [k, q] of Object.entries(snap.quotes)) if (q.live && q.price > 0) todayMap[k] = [q.price, Math.round((q.volume || 0) / 1000), q.open || 0, q.high || 0, q.low || 0, q.queueUp ? 1 : 0];
    prior = arch; srcNote = '快照';
  }
  prior = prior.slice(0, 21);                                   // t-1 … t-21
  const prevDate = prior[0].date;
  const punish = await fetchPunishSet().catch(() => new Set());
  // ── 順序比對（2026-09-06 使用者：要照影片順序 平底 → 緊鄰的一串小陽線 → 箭頭日）──
  // 箭頭日 t：漲停 ∧ 今低>昨高；緊鄰連陽：結束於 t-1（或 t-2，容忍一根停頓）且 ≥3 根、段漲 2–15%；
  // 平底：連陽之前 15 日 (高-低)/低 ≤30%；形狀：近 21 日收盤路徑與影片模板（15 天平 → 5 天緩升 → 跳升）Pearson ≥0.8。
  // 倍量只當標籤（實測強制倍量 20 日 +4.2%／不限量 +7.7%）。EXPERIMENTS ⑨。
  const TEMPLATE = [...Array(15).fill(0), 1.6, 3.2, 4.8, 6.4, 8, 18];
  const pearson = (p, q) => { const m = a => a.reduce((s2, x) => s2 + x, 0) / a.length; const mp = m(p), mq = m(q); let num = 0, dp = 0, dq = 0; for (let i = 0; i < p.length; i++) { num += (p[i] - mp) * (q[i] - mq); dp += (p[i] - mp) ** 2; dq += (q[i] - mq) ** 2; } return dp > 0 && dq > 0 ? num / Math.sqrt(dp * dq) : null; };
  const items = [], near = []; let luTotal = 0;
  for (const code of Object.keys(todayMap)) {
    const T = todayMap[code]; const P = prior[0].map[code];
    if (!Array.isArray(T) || !Array.isArray(P) || !(T[0] > 0) || !(P[0] > 0)) continue;
    const chg = (T[0] - P[0]) / P[0] * 100;
    if (chg < 9.5) continue;
    luTotal++;
    if (!(T[4] > 0) || !(P[3] > 0) || T[4] <= P[3]) continue;   // 缺口：今低 > 昨高
    const hist = prior.map(d => d.map[code]);                   // hist[0]=t-1 … 需連續完整
    if (hist.slice(0, 21).some(x => !Array.isArray(x) || !(x[0] > 0) || !(x[2] > 0))) continue;
    const h20 = hist.slice(0, 20);
    const base = h20.reduce((s2, x) => s2 + (x[1] || 0), 0) / 20;
    const amt = h20.reduce((s2, x) => s2 + x[0] * (x[1] || 0) * 1000, 0) / 20;
    if (!(base > 0) || amt < 50_000_000) continue;
    const volX = T[1] / base;
    // 緊鄰連陽（結束於 t-1 或 t-2）
    let runAdj = 0, runEnd = 0;
    for (const off of [0, 1]) { let r = 0; for (let i = off; i < off + 10 && i < hist.length; i++) { const x = hist[i]; if (x && x[2] > 0 && x[0] > x[2]) r++; else break; } if (r > runAdj) { runAdj = r; runEnd = off; } }
    const runGain = runAdj >= 2 && hist[runEnd + runAdj] ? (hist[runEnd][0] - hist[runEnd + runAdj][0]) / hist[runEnd + runAdj][0] * 100 : null;
    const baseCl = hist.slice(runEnd + runAdj, runEnd + runAdj + 15).filter(x => x?.[0] > 0).map(x => x[0]);
    const baseFlat = baseCl.length >= 10 ? (Math.max(...baseCl) - Math.min(...baseCl)) / Math.min(...baseCl) * 100 : null;
    const path = [...hist.slice(0, 20).map(x => x[0]).reverse(), T[0]]; const b0 = path[0];
    const shape = pearson(path.map(x => (x - b0) / b0 * 100), TEMPLATE);
    const lo20 = Math.min(...h20.map(x => x[0]));
    const it = { code, name: names[code] || code, price: T[0], chg: +chg.toFixed(2), volX: +volX.toFixed(2), star: volX < 1, heavy: volX >= 2,
      runAdj, runGain: runGain == null ? null : +runGain.toFixed(1), baseFlat: baseFlat == null ? null : +baseFlat.toFixed(1), shape: shape == null ? null : +shape.toFixed(2),
      baseUp: +((P[0] - lo20) / lo20 * 100).toFixed(1), eventLow: T[4], eventHigh: T[3], open: T[2], queueUp: !!T[5], punish: punish.has(code) };
    // 主線：小陽線 2–15%；支線A（2026-09-06 使用者：友達/彩晶案）：強勢連陽 15–40%（連陽裡已含一根漲停）——
    // 回測 n=154 20 日 +8.7%/勝 53.9%，但 5 日均 −0.3%、最深 −8.8%（進場後常先回檔），故標籤明示。>40% 只有 19 筆主窗負，不收。
    const seqOk = runAdj >= 3 && runGain != null && runGain >= 2 && runGain <= 40 && baseFlat != null && baseFlat <= 30;
    it.branch = runGain != null && runGain > 15 ? '強勢連陽' : '主線';
    if (seqOk && shape >= 0.8) items.push(it);
    else if (shape >= 0.8 || seqOk) near.push({ ...it, why: seqOk ? '形狀 <0.8' : runAdj < 3 ? `連陽只有 ${runAdj} 根` : runGain != null && (runGain < 2 || runGain > 40) ? `連陽段漲 ${runGain.toFixed(1)}% 不在 2–40%` : '底部不平' });
  }
  items.sort((a, b) => (b.shape ?? 0) - (a.shape ?? 0));
  near.sort((a, b) => (b.shape ?? 0) - (a.shape ?? 0));
  const marketEvent = luTotal > 60;
  const doc = {
    date: today, at: Date.now(), updatedAt: Date.now(), prevDate, source: srcNote, items, near: near.slice(0, 12), luTotal, marketEvent,
    rule: '影片順序：平底(連陽前15日高低差≤30%) → 緊鄰連陽≥3根(主線段漲2–15%／支線·強勢連陽15–40%) → 箭頭日(漲停 ∧ 今低>昨高) ∧ 21日走勢與模板形狀相似≥0.8·20日均額≥5000萬·停損=事件日低；倍量/縮量只作標籤',
    stats: '順序＋形狀版實測(排除全市場漲停日·去重·t+1開盤進場·扣成本)：主線 n=48 20日淨+7.7%·中位+3.1%·勝率56.3%·10日+7.2%·5日最深-6.7%；支線強勢連陽 n=124 20日+8.3%·勝率53.2%·+30%命中26%·但5日均-0.2%·最深-9.2%（常先回檔）；合併 n=167 +8.3%/54.5%；安慰劑+2.2%/48%。跌破事件日低必出。非投資建議。',
  };
  await db.collection('gapLimitUp').doc(today).set(doc);
  // latest 只往前走：GAPLU_DATE 補算舊日不得把 latest 蓋回過去
  const curLatest = (await db.collection('gapLimitUp').doc('latest').get()).data();
  if (!curLatest?.date || curLatest.date <= today) await db.collection('gapLimitUp').doc('latest').set({ ...doc, reviewHistory: curLatest?.reviewHistory ?? [], reviewSummary: curLatest?.reviewSummary ?? null, reviewedDays: curLatest?.reviewedDays ?? 0 });
  log(`✓ 影片形態（${srcNote}）：${items.length} 檔（形似但順序不完整 ${near.length}·今日漲停 ${luTotal} 檔${marketEvent ? '·⚠ 全市場事件日' : ''}）`);
  if (push && items.length && !marketEvent) {
    const list = items.slice(0, 8).map(i => `${i.branch === '強勢連陽' ? '[強勢連陽]' : ''}${i.name}(${i.code}) 形狀${i.shape} 連陽${i.runAdj}(+${i.runGain}%) 量${i.volX}×${i.heavy ? '倍量' : i.star ? '縮量' : ''} 停損${i.eventLow}${i.queueUp ? ' 買一貼停' : ''}${i.punish ? ' 處置' : ''}`).join('、');
    const message = `🎯 影片形態（平底→連陽→漲停跳空）${items.length} 檔（${today}）：${list}。主線實測 20日淨+7.7%·勝率56%；[強勢連陽]支線 20日+8.3%·勝率53%但常先回檔(5日-0.2%·最深-9%)；明日開盤進場、鎖漲停＝買不到，跌破停損線必出。非投資建議。`;
    const alert = { code: items[0].code, name: items[0].name, type: 'gapLimitUp', price: items[0].price, message, at: Date.now() };
    try {
      const us = await db.collection('users').get();
      let sent = 0;
      for (const u of us.docs) { try { await pushAlerts(u.id, [alert]); sent++; } catch { /* 單用戶失敗不影響其他 */ } }
      log(`  · 跳空漲停推播 ${sent} 位使用者`);
    } catch (e) { log('  ⚠ 跳空漲停推播失敗:', e.message); }
  } else if (push && marketEvent) log('  · 全市場事件日（漲停 >60 檔）不推播——訊號在這種日子失效');
  return true;
}
// 對答案：對最近 25 個交易日的榜單，用歸檔算 t+1 開盤進場後的 5/20 日淨報酬、停損是否觸發、是否買得到
async function computeGapLimitUpReview() {
  const archRaw = await readArchive(27, 'closeJson');
  if (archRaw.length < 3) return false;
  const asc = archRaw.map(d => ({ date: d.date, map: JSON.parse(d.closeJson) })).reverse();
  const idx = Object.fromEntries(asc.map((d, i) => [d.date, i]));
  const COST = 0.4425;
  const qs = await db.collection('gapLimitUp').orderBy('date', 'desc').limit(30).get();
  const history = []; const pool = [];
  for (const d of qs.docs) {
    if (d.id === 'latest') continue;
    const b = d.data(); const t = idx[b.date]; if (t == null || !b.items?.length) continue;
    const n1 = asc[t + 1]; if (!n1) continue;
    const rows = b.items.map(it => {
      const o1 = n1.map[it.code]?.[2]; if (!(o1 > 0)) return { code: it.code, name: it.name, unbuyable: null };
      if ((o1 - it.price) / it.price * 100 >= 9.5) return { code: it.code, name: it.name, unbuyable: true };
      const at = k => asc[t + k]?.map[it.code]?.[0] || null;
      const r5 = at(5) ? +(((at(5) - o1) / o1 * 100) - COST).toFixed(2) : null;
      const r20 = at(20) ? +(((at(20) - o1) / o1 * 100) - COST).toFixed(2) : null;
      let minLow5 = Infinity, maxC = -Infinity, avail = 0;
      for (let k = 1; k <= 20; k++) { const x = asc[t + k]?.map[it.code]; if (!x) break; avail = k; if (k <= 5 && x[4] > 0) minLow5 = Math.min(minLow5, x[4]); maxC = Math.max(maxC, x[0]); }
      const stopHit = minLow5 < Infinity ? minLow5 < it.eventLow : null;
      return { code: it.code, name: it.name, unbuyable: false, entry: o1, r5, r20, days: avail, maxUp: maxC > 0 ? +((maxC - o1) / o1 * 100).toFixed(1) : null, stopHit };
    });
    const done = rows.filter(r => r.r20 != null);
    const day = { date: b.date, n: b.items.length, unbuyable: rows.filter(r => r.unbuyable).length,
      n20: done.length, win20: done.length ? +(done.filter(r => r.r20 > 0).length / done.length * 100).toFixed(1) : null,
      avg20: done.length ? +(done.reduce((s2, r) => s2 + r.r20, 0) / done.length).toFixed(2) : null,
      avg5: (() => { const a = rows.filter(r => r.r5 != null); return a.length ? +(a.reduce((s2, r) => s2 + r.r5, 0) / a.length).toFixed(2) : null; })(),
      hit30: done.length ? +(done.filter(r => r.maxUp >= 30).length / done.length * 100).toFixed(0) : null,
      stopHit: rows.filter(r => r.stopHit).length };
    day.marketEvent = !!b.marketEvent;
    history.push(day); if (!b.marketEvent) pool.push(...done);   // 全市場事件日的成績不進樣本外總結（08-03 一天 43 筆 +21% 會灌爆）
    await db.collection('gapLimitUp').doc(b.date).set({ review: day, reviewRowsJson: JSON.stringify(rows) }, { merge: true });
  }
  const summary = pool.length ? { n: pool.length, win20: +(pool.filter(r => r.r20 > 0).length / pool.length * 100).toFixed(1), avg20: +(pool.reduce((s2, r) => s2 + r.r20, 0) / pool.length).toFixed(2), hit30: +(pool.filter(r => r.maxUp >= 30).length / pool.length * 100).toFixed(0) } : null;
  await db.collection('gapLimitUp').doc('latest').set({ reviewHistory: history.slice(0, 25), reviewSummary: summary, reviewedDays: history.length }, { merge: true });
  log(`✓ 跳空漲停對答案：${history.length} 日榜、20日完成 ${pool.length} 筆${summary ? `·勝率 ${summary.win20}%·均 ${summary.avg20}%` : ''}`);
  return true;
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
    dataDate: await currentDataDate(),
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
  // 空殼會讓 maps[0] 變 {} 並把整串日期往後推一格（5日均量少一天、昨收變前天）。
  const arch = await readArchive(8);
  if (!arch.length) return _windCtx;
  const maps = arch.map(a => JSON.parse(a.closeJson));
  const yInst = arch.find(a => a.instJson)?.instJson ? JSON.parse(arch.find(a => a.instJson).instJson) : {};
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
    dataDate: await currentDataDate(),   // 資料日（≠ 產生日）
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
  // limit(1) 會抓到盤前空殼 ⇒ 法人買賣超整片變 0。改取「最近一個有法人的日子」。
  const arch = await readArchive(5, 'instJson');
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
  const payload = { updatedAt: Date.now(), dataDate: await currentDataDate(), date: today, marketOpen: snap.marketOpen, sectors, baseScore };
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
let _radarOpen = { date: '', map: {} };   // 開盤段輪間記錄（60秒/輪·差分=1分K 粒度）
let _radarRating = { at: 0, map: {} };  // AI 評分快取(5分)，避免每60秒重抓全市場
async function computeIntradayRadar() {
  const tw = taipei(); const mins = tw.getHours() * 60 + tw.getMinutes(); const today = isoDate(tw);
  // 2026-09-03 使用者指定：09:00 就要開始偵測。開盤段（09:00–09:10）全日量能
  // 基準失真（elapsed 下限撐不住第一分鐘的極端比例），改走**輪間差分方向偵測**
  // ——警示束 60 秒/輪，輪間差分＝1 分 K 粒度；5 分方向=連續多輪累積。
  // 09:10 起照舊走原策略（分支隔離，原邏輯零改動）。
  if (!isTradingDay(tw) || mins < 9 * 60 || mins >= 13 * 60 + 35) return;

  // 每日一次：5日均量/5日高/昨收/MA5(近似:前5日收盤均)/昨日漲幅/昨日外資（chipArchive）
  if (_radarCtx.date !== today) {
    // 同 8045：先濾掉空殼再取序列，否則 maps 整串位移、mgY 會拿到空物件。
    const arch = await readArchive(23);
    if (!arch.length) return;
    const maps = arch.map(a => JSON.parse(a.closeJson));
    const instY = arch.find(a => a.instJson)?.instJson ? JSON.parse(arch.find(a => a.instJson).instJson) : {};
    // 軋空啟動 setup：昨日融券增 ≥ 昨量 0.5%（2年稽核 46.0-47.7%·淨正兩窗穩定）
    // 資券 21:45 才回填 ⇒ 必須取「最近兩個有 marginJson 的日子」而不是 arch[0]/arch[1]。
    const mgDays = arch.filter(a => a.marginJson);
    const mgY = mgDays[0] ? JSON.parse(mgDays[0].marginJson) : {};
    const mgY2 = mgDays[1] ? JSON.parse(mgDays[1].marginJson) : {};
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
  if (_radarOpen.date !== today) _radarOpen = { date: today, map: {} };
  const opening = mins < 9 * 60 + 10;                       // 開盤段：輪間差分方向偵測
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
    if (opening) {
      // ── 開盤段（09:00–09:10）：輪間差分方向偵測，不用全日量能基準 ──
      const hist = _radarOpen.map[code] || (_radarOpen.map[code] = []);
      const vNow = (x.volume || 0) / 1000;
      const prev1 = hist[hist.length - 1], prev2 = hist[hist.length - 2];
      hist.push({ p: x.price, v: vNow, at: Date.now() });
      if (hist.length > 6) hist.shift();
      if (prev1 && prev2) {
        const dV1 = vNow - prev1.v, dV0 = prev1.v - prev2.v;               // 本輪/上輪的分鐘量
        const rising = x.price > prev1.p && prev1.p >= prev2.p;            // 連兩輪上攻（1分K方向）
        const volAccel = dV1 > 0 && dV1 > dV0 * 1.3;                       // 分鐘量加速
        if (rising && x.price > x.open && pos >= 0.7 && volAccel) {
          if (chg >= 0.5 && chg <= 3.5) hits.push('ignite');
          else if (chg >= 3.5 && chg <= 8.5 && body >= 2.5) hits.push('volSurge');
        }
        if (gap >= 1.5 && x.low > pc && x.price >= x.open && dV1 > 0) hits.push('openStrong');
      }
    } else {
    if (chg >= 0.5 && chg <= 3.5 && volX >= 2 && pos >= 0.75 && h5 > 0 && x.price >= h5 * 0.99) hits.push('ignite');
    if (chg >= 3.5 && chg <= 8.5 && volX >= 3 && pos >= 0.85 && body >= 2.5) hits.push('volSurge');
    if (gap >= 1.5 && x.low > pc && x.price >= x.open && volX >= 1.2) hits.push('openStrong');
    if (m5 > 0 && x.price > m5 && x.low <= m5 * 1.01 && bounce >= 1 && chg <= 4) hits.push('ma5Bounce');
    if ((_radarCtx.yChg?.[code] || 0) >= 2 && chg <= 4 && volX >= 1.5 && pos >= 0.7) hits.push('followThru');
    if ((_radarCtx.yForeign?.[code] || 0) >= 500 && chg >= 1 && volX >= 1.5 && pos >= 0.7) hits.push('chipIgnite');
    if (_radarCtx.ySqueeze?.[code] != null && chg > 2) hits.push('squeeze');
    { const h20 = _radarCtx.hi20?.[code] || 0; if (h20 > 0 && x.price > h20 && pc <= h20 && pos >= 0.7) hits.push('breakHigh'); }
    }
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
  for (const [name, fn] of [['institutional', trackInstitutional], ['tradeSignals', computeTradeSignals], ['RS', computeRS], ['scanner', computeScanner], ['taifex', trackTaifex], ['globalMarkets', computeGlobalMarkets], ['sectorSpot', computeSectorSpot], ['revenue', computeRevenue], ['revenueThicken', thickenRevenueArchive], ['margin', computeMargin], ['majorHolders', computeMajorHoldersChange], ['multiTimeframe', computeMultiTimeframe], ['dividend', computeDividendCalendar], ['lending', computeLending], ['dividendStocks', computeDividendStocks], ['marketHealth', computeMarketHealth], ['peerComps', computePeerComps], ['catalystCalendar', buildCatalystCalendar], ['morningNote', publishMorningNote], ['dayTradeEligible', computeDayTradeEligible], ['dayTradeRatio', computeDayTradeRatio], ['chipArchive', archiveChipDaily], ['priceEvents', computePriceEvents], ['otcIndex', archiveOtcIndex], ['strategyPicks', computeStrategyPicks], ['etfPremium', computeEtfPremium], ['recommendAdj', computeRecommendAdj], ['reversalSignals', computeReversalSignals], ['shortCandidates', computeShortCandidates], ['shortReview', computeShortReview], ['gapLimitUp', computeGapLimitUp], ['gapLimitUpReview', computeGapLimitUpReview], ['picksTracker', trackPicks], ['exDiv', adviseExDiv], ['dcaHint', hintDca], ['adrPremium', computeAdrPremium], ['stressTest', computeStressTest], ['theses', updateTheses], ['rebalance', checkAllocationDrift], ['stopDiscipline', trackStopDiscipline], ['snipeList', buildSnipeList], ['rotation', computeRotation], ['peBands', computePeBands], ['monthlyReports', publishMonthlyReports], ['userRisk', computeUserRisk], ['marketPattern', computeMarketPattern], ['tailEndPicks', computeTailEndPicks], ['shadowAccount', analyzeShadowAccount], ['earningsCalls', previewEarningsCalls], ['chipCumulative', computeChipCumulative], ['chipSignals', computeChipSignals], ['chipDaily', computeChipDaily], ['chipWind', computeChipWind], ['chipDivergence', computeChipDivergence], ['etfInfluence', computeEtfInfluence], ['chipPicks', computeChipPicks], ['newsDaily', computeNewsDaily], ['limitUpForecast', computeLimitUpForecast], ['finReports', computeFinReports], ['washoutMonitor', computeWashoutMonitor], ['backtest', runBacktest], ['dailyPost', publishDailyPost], ['userSummaries', publishUserSummaries], ['tradeReviews', publishTradeReviews]]) {
    if (boot && BOOT_SKIP.has(name)) { log(`  ↷ ${name}(boot 跳過·每日 15:10 排程涵蓋)`); continue; }
    await timedJob(name, fn, tag);
  }
  const total = Object.values(_jobTimings).filter(v => v.tag === tag).reduce((s, v) => s + v.ms, 0);
  log(`⏱ dailyJobs${tag} 總耗時 ${(total / 60000).toFixed(1)} 分；最慢：${slowestJobs(5)}`);
  writeDaemonHealth();
}
// 官方盤後資料公布時間不同，光靠 15:10 一次會抓到前一日：T86 三大法人約 16:00、
// 期交所/集保/除權息/借券/月營收約 16:30 前、融資融券約 21:30 才出。故加兩個補抓時段。
const OFFICIAL_CATCHUP = [['institutional', trackInstitutional], ['taifex', trackTaifex], ['majorHolders', computeMajorHoldersChange], ['dividend', computeDividendCalendar], ['lending', computeLending], ['revenue', computeRevenue], ['revenueThicken', thickenRevenueArchive], ['marketHealth', computeMarketHealth], ['peerComps', computePeerComps], ['catalystCalendar', buildCatalystCalendar], ['dayTradeRatio', computeDayTradeRatio], ['chipArchive', archiveChipDaily], ['gapLimitUp', computeGapLimitUp], ['swingHold', computeSwingHold], ['dailySeq', computeDailySeq], ['chipCumulative', computeChipCumulative], ['chipSignals', computeChipSignals], ['chipDaily', computeChipDaily], ['chipWind', computeChipWind], ['chipDivergence', computeChipDivergence], ['etfInfluence', computeEtfInfluence], ['strategyPicks', computeStrategyPicks], ['etfPremium', computeEtfPremium], ['dailyPost', publishDailyPost]];   // gapLimitUp 排在 chipArchive 之後：15:10 版歸檔上櫃可能未併入（2026-09-07 實案 34→12 檔），16:30 併入後重算
const MARGIN_CATCHUP = [['margin', computeMargin], ['etfPremium', computeEtfPremium], ['chipArchive', archiveChipDaily], ['chipSignals', computeChipSignals], ['dailyPost', publishDailyPost]];
async function runJobSet(jobs, tag) {
  for (const [name, fn] of jobs) await timedJob(name, fn, tag);
}
let _intradayDate = '';   // 個股5分K歸檔每日一次
let _asiaAt = 0, _asiaCatchupDate = '';   // 日韓早盤節流與補跑守衛（見 computeAsiaPremarket）
let _sqRecDate = '';          // 每日 08:00 軋空推薦守衛
let _dtEligDate = '';   // 當沖資格名單當日是否已抓（盤前 07:30 起）
let _pulseAt = 0;             // 大盤脈動節流（30 秒）
let _globalHistDate = '';     // 國際盤歷史每日更新守衛
let _nvEveDate = '';          // 新聞內文判別·盤後那趟（23:00）
let _nvMornDate = '';         // 新聞內文判別·晨間那趟（07:00，08:00 死線）
let _nvReviewDate = '';       // 新聞判別對答案（15:30）
let _nvIntradayAt = 0;        // 盤中新聞判別的上次執行時刻
let _mopsAt = 0;              // 公開資訊觀測站重大訊息：每 30 分鐘一輪（2026-09-17）
let _nvNightDate = '';        // 夜間覆蓋率補判（01:15 起，06:30 死線）
let _shortCandAt = 0;         // 做空候選：盤中每 10 分鐘一輪（2026-09-03）
let _squeezeTrainDate = '';   // 軋空模型訓練（每個交易日之後 02:00）冪等守衛；開機時從 squeezeModel/latest.updatedAt 接回，重啟不重訓
let _squeezeTrainInit = false;
let _asiaSlotDate = '', _asiaSlotsDone = new Set();   // 具名時刻表守衛（見 dailyJobsLoop 的 ASIA_SLOTS）
// 日韓早盤固定時刻（台北時間·分鐘）。08:30 為使用者指定必跑；09:00 後為盤中追蹤。
const ASIA_SLOTS = [
  [8 * 60, '08:00'], [8 * 60 + 15, '08:15'], [8 * 60 + 30, '08:30'], [8 * 60 + 45, '08:45'],
  [9 * 60, '09:00'], [9 * 60 + 5, '09:05'],
  [9 * 60 + 30, '09:30'], [10 * 60 + 30, '10:30'], [11 * 60 + 30, '11:30'],
  [12 * 60 + 30, '12:30'], [13 * 60 + 30, '13:30'],
];
let _dailyJobsDate = '', _officialDate = '', _marginDate = '', _morningDate = '', _weeklyDate = '', _backupDate = '', _characterDate = '', _otcFixDate = '', _newsDigestDate = ''; let _depthArchDate = null; let _orderFlowDate = ''; let _snap0930Date = null; let _revDatesMonth = null; let _leadersMonth = null;
let _calSyncDate = null; let _dailyCloseDate = null; let _histTopupDate = null; let _healthAuditDate = null; let _tailTrackDate = null; let _tailEvalDate = null;
// 子程序執行 scripts/ 內腳本（記憶體隔離；邏輯不重複進 daemon）
// ⚠ **必須 return**（2026-08-31 差點釀成無窮迴圈）：
//   舊版沒有 return，函式回傳 undefined。我改成「回報成敗」後，
//   呼叫端 `if (await execScript(...)) _xxxDate = today` 會永遠拿到 undefined
//   ⇒ 永遠不標記完成 ⇒ 250 日訓練、行事曆同步、健康稽核在迴圈裡**無限重跑**。
//   是做共用函式的影響面掃描才擋下來的（使用者提醒「嚴禁修 A 錯 B」）。
function execScript(name, args, tag, timeoutMin = 10) {
  return import('node:child_process').then(({ execFile }) => {
    // ⚠ 中文路徑：URL.pathname 是百分號編碼（%E8%82%A1…），execFile 直接用會找不到檔
    //（2026-07-24 揭發：備份/分析/漲停前夜實驗子腳本長期靜默失敗）。必須解碼。
    const script = decodeURIComponent(new URL(`./${name}`, import.meta.url).pathname);
    // ⚠ **要回報成敗**（2026-08-31 發現）：舊版把錯誤全部吞掉、
    //   永遠不 reject、也不回傳任何成敗指標。於是所有
    //   `try { await execScript(...); _xxxDate = today } catch` 的寫法
    //   **一律會走到標記那行**——我當天早上「改為成功才標記」的修正
    //   因此完全無效，訓練失敗照樣整天不重試。
    //   改為 resolve(boolean)，呼叫端才有辦法判斷。
    return new Promise(resolve => {
      execFile(process.execPath, [script, ...args], { timeout: timeoutMin * 60000 }, (err, stdout) => {
        if (err) { log(`✖ ${tag}:`, err.message); resolve(false); }
        else { log(`${tag}:`, String(stdout).trim().split('\n').pop()); resolve(true); }
      });
    });
  }).catch((e) => { log(`✖ ${tag} spawn:`, e.message); return false; });
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
      // 開盤前 1 小時（08:00）核對新聞內容並由 AI 判別（使用者指定）
      // 當沖資格名單盤前就發布，而它必須在 09:00 開盤前到位（使用者要靠它避免違規），
      // 所以不能只靠 15:10 的每日 job——那是收盤後，整個交易日都拿昨天的名單。
      if (isTradingDay(tw) && mins >= 7 * 60 + 30 && _dtEligDate !== today) {
        // ⚠ **成功才標記今日已跑**。原本先標記再呼叫，等於「這天只嘗試一次」：
        //   07:30 那一次遇到上游抖動就整個交易日拿昨天的資格標今天的股票，
        //   而稽核要 16:10 才會發現——盤都收了。這正是 dayTradeRatio 斷 8 天
        //   的同型錯誤（單次嘗試、失敗不重試、靜默）。
        //   dailyJobsLoop 每輪都會再進來，所以失敗自然會在下一輪重試。
        try { if (await computeDayTradeEligible()) _dtEligDate = today; }
        catch (e) { log('✖ 當沖資格（將於下一輪重試）:', (e.message || '').slice(0, 60)); }
      }
      if (isTradingDay(tw) && mins >= 8 * 60 && mins < 9 * 60 && _sqRecDate !== today) {
        // 同上：成功才標記。失敗時 08:00~09:00 這個窗內還會再試。
        try { await computeSqueezeNewsVerdict(); _sqRecDate = today; }
        catch (e) { log('✖ 軋空新聞判別（窗內將重試）:', (e.message || '').slice(0, 60)); }
        // 漲停預測的新聞判別接在後面（共用同一套抓取與判別，成本同量級）。
        // 分開 try：軋空那條失敗不該連帶讓漲停這條也沒有。
        // ⚠ 硬死線 08:50：盤前判別現在要跑到 08:46 才就緒（距開盤僅 14 分鐘），
        //   是多輪挑戰＋自檢＋引用強制把成本拉到 4~5 倍造成的。
        //   宇宙變大或 AI 變慢就會壓到 09:00，使用者盤前拿不到判別。
        //   寧可少判幾檔也不能拖到開盤——已判的部分照樣可用。
        try { await computeLimitUpNewsVerdict(8 * 60 + 50); }
        catch (e) { log('✖ 漲停新聞判別:', (e.message || '').slice(0, 60)); }
      }
      // ── 新聞內文判別管線（使用者 2026-08-29 指定分流）──
      // 盤後那趟 23:00：台灣盤後新聞於 24:00 前陸續出齊。
      //   不放更早：18:00 跑會漏掉晚間才發的重訊與外電。
      //   非交易日也跑——週末的新聞正是週一開盤要用的（使用者 08-28 指示）。
      if (mins >= 23 * 60 && _nvEveDate !== today) {
        // 成功才標記（與當沖資格同一課：先標記等於這天只嘗試一次）
        // ⚠ 盤後趟也要給死線（05:00）：dailyJobsLoop 是**循序**執行的，
        //   這個 job 實測要 131 分鐘，正常 23:00→01:10 沒問題，
        //   但上游變慢或 AI 變慢時會一路吃掉 06:00 國際盤、07:00 晨間判別、
        //   07:30 當沖資格、08:00 軋空判別——後兩者是使用者盤前要用的。
        //   05:00 留足一小時緩衝，且已完成的部分有分段存檔不會白跑。
        try { if (await computeNewsVerdictBatch('evening', 5 * 60)) _nvEveDate = today; }
        catch (e) { log('✖ 新聞判別·盤後（將重試）:', (e.message || '').slice(0, 60)); }
      }
      // 晨間那趟 07:00：國際與晨間新聞 06:00~07:00 到齊。
      //   **死線 08:00** ——08:00 是軋空/漲停判別的窗口，不能讓這條佔住。
      //   靠「跳過已判過的標題」把 150 檔壓進這一小時（多數晨間稿是盤後稿改寫）。
      if (isTradingDay(tw) && mins >= 7 * 60 && mins < 8 * 60 && _nvMornDate !== today) {
        try { if (await computeNewsVerdictBatch('morning', 8 * 60)) _nvMornDate = today; }
        catch (e) { log('✖ 新聞判別·晨間（窗內將重試）:', (e.message || '').slice(0, 60)); }
      }
      // 夜間覆蓋率補判（01:15 起跑，06:30 死線）——使用者 2026-09-01：
      //   夜間 Ollama 很閒，安排工作。盤後趟約 01:15 結束，訓練 02:00 才開始，
      //   之後到 06:40 都閒置 ⇒ 約 4 小時 55 分可用。
      //   只補「使用者看得到」的股票（推薦榜/軋空候選/漲停預測）中尚無判別者。
      // ⚠ 06:30 死線：不能吃到 06:40 行事曆同步與 07:00 晨間判別。
      if (mins >= 60 + 15 && mins < 6 * 60 + 30 && _nvNightDate !== today) {
        try { if (await computeNightBackfill()) _nvNightDate = today; }
        catch (e) { log('✖ 夜間補判（將重試）:', (e.message || '').slice(0, 60)); }
      }
      // 做空風控候選（2026-09-03）：盤中每 10 分鐘刷新（弱勢/處置/軋空狀態盤中都在變）。
      // 盤後定榜由 daily jobs 清單的 shortCandidates 條目負責（15:10 歸檔後）。
      if (isTradingDay(tw) && mins >= 9 * 60 && mins <= 13 * 60 + 40 && Date.now() - _shortCandAt > 10 * 60000) {
        _shortCandAt = Date.now();   // 先標記：週期性工作，失敗等下一輪
        try { await computeShortCandidates(); } catch (e) { log('✖ 做空候選:', (e.message || '').slice(0, 60)); }
      }
      // 🎯 縮量跳空漲停（2026-09-05）：13:36 收盤試撮結束後從快照定榜＋推播，每日一次；15:10 歸檔後由 daily jobs 重算不推播。
      if (isTradingDay(tw) && mins >= 13 * 60 + 36 && mins < 14 * 60 + 10 && _gapLuDate !== today) {
        try { if (await computeGapLimitUp({ push: true })) _gapLuDate = today; } catch (e) { log('✖ 跳空漲停:', (e.message || '').slice(0, 60)); }
      }
      // 盤中即時新聞判別（09:00~13:30，每 25 分鐘一趟）。
      // 使用者 2026-08-31：欣興盤中遭搜索當日跌 7.5%、世界先進工廠失火，
      // 這類消息盤前不存在、隔天才判就沒有意義。
      // ⚠ 刻意輕量：只看最近 45 分鐘的新文章、12 分鐘硬死線，
      //   不能與盤中其他工作搶 LLM 佇列。
      if (isTradingDay(tw) && mins >= 9 * 60 && mins <= 13 * 60 + 30
          && Date.now() - _nvIntradayAt > 25 * 60000) {
        _nvIntradayAt = Date.now();   // 先標記：這是週期性工作，失敗等下一輪即可
        try { await computeIntradayNewsVerdict(); }
        catch (e) { log('✖ 盤中新聞判別:', (e.message || '').slice(0, 60)); }
      }
      // 公開資訊觀測站重大訊息（2026-09-17）：07:00~23:30 每 30 分鐘一輪，非交易日也跑（假日仍有補登）。
      //   只抓取去重；一輪 1 次列表 ＋ 最多 150 次內文，與 MIS 額度無關（不同主機）。
      if (mins >= 7 * 60 && mins <= 23 * 60 + 30 && Date.now() - _mopsAt > 30 * 60000) {
        _mopsAt = Date.now();   // 先標記：週期性工作，失敗等下一輪
        try { await ingestMops(); } catch (e) { log('✖ MOPS 重訊:', (e.message || '').slice(0, 60)); }
      }
      // 新聞判別對答案（15:30：當日 OHLC 已入 chipArchive）
      if (isTradingDay(tw) && mins >= 15 * 60 + 30 && _nvReviewDate !== today) {
        try { if (await computeNewsVerdictReview()) _nvReviewDate = today; }
        catch (e) { log('✖ 新聞判別對答案（將重試）:', (e.message || '').slice(0, 60)); }
      }
      // 國際盤歷史每日更新（06:00：美股前一夜 04:00 已收，資料齊全）
      if (mins >= 6 * 60 && _globalHistDate !== today) {
        // 成功才標記（同 07:30 當沖資格）：這是軋空模型國際因子的原料，
        // 06:00 那一次失敗就整天沒有，而它每天只跑一次。
        try { await updateGlobalHistory(); _globalHistDate = today; }
        catch (e) { log('✖ 國際盤歷史（將於下一輪重試）:', (e.message || '').slice(0, 60)); }
      }
      // 軋空判讀模型訓練：**每個交易日之後的凌晨 02:00**（使用者 2026-08-31 指示；舊的「週二/五 01:00」已廢，
      //   2026-09-07 我還被殘留註解誤導過一次，故刪乾淨）。「昨天有開盤就訓練」＝週二～週六 02:00，
      //   每個交易日的收盤資料隔天凌晨就進模型。02:00 避開 01:00 前後的歸檔與晚間工作。
      // ⚠ 不設 isTradingDay(今天) 閘門——訓練吃的是歷史歸檔，跟今天開不開盤無關。
      // 冪等守衛只在記憶體 ⇒ 每次重啟都會再訓一次（09-04～09-05 重啟四次就多訓四次，白耗 30 分鐘算力）。
      //   開機第一次進來先從 squeezeModel/latest.updatedAt 接回「今天訓過了沒」。
      if (!_squeezeTrainInit) {
        _squeezeTrainInit = true;
        try {
          const m = (await db.collection('squeezeModel').doc('latest').get()).data();
          if (m?.updatedAt && isoDate(new Date(new Date(m.updatedAt).toLocaleString('en-US', { timeZone: 'Asia/Taipei' }))) === today) { _squeezeTrainDate = today; log('  · 軋空模型今日已訓練（開機接回，不重訓）'); }
        } catch { /* 讀不到就照舊邏輯，最多多訓一次 */ }
      }
      const _yTw = new Date(tw.getTime() - 86400000);
      if (isTradingDay(_yTw) && mins >= 2 * 60 && _squeezeTrainDate !== today) {
        // ⚠ **先標記再呼叫**是本專案記過的反模式（dayTradeRatio 因此斷 8 天）：
        //   訓練失敗時這天就不再重試，而下一次要等 3~4 天，
        //   使用者會看到「模型停止訓練」卻沒有任何告警。
        //   改為成功才標記；execScript 失敗時下一輪迴圈會重試。
        // execScript 現在回報成敗（見其註解）——失敗就不標記，下一輪重試
        if (await execScript('squeeze-train.mjs', ['250'], '🧪 軋空模型訓練', 30)) _squeezeTrainDate = today;
        else log('✖ 軋空模型訓練失敗，將於下一輪重試');
      }
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
        // 日韓早盤風向：**固定時刻表**（2026-08-06 由「每 15 分節流」改為具名時段）。
        // 為什麼要改：節流版的實際落點取決於 daemon 何時啟動——08:00 開跑就是
        // 08:00/08:14/08:28…，08:07 開跑就變成 08:07/08:21/08:35，**使用者要求的
        // 08:30 那一輪不保證存在**。改成具名 slot 後，每個時刻各自記錄是否跑過，
        // 錯過就在下一個 tick 立刻補跑（仍標同一個 slot 名），時刻本身不會消失。
        //   盤前 5 輪（領先窗口·08:30 為使用者指定必跑）＋開盤 1 輪（對齊用）
        //   ＋盤中 5 輪追蹤（日本 14:00、韓國 14:30 台北時間收盤前）。
        // 上游用量：11 輪 × 12 檔 = 每日 132 次，仍為常數（與線上人數無關＝唯一不變式）。
        if (_asiaSlotDate !== today) { _asiaSlotDate = today; _asiaSlotsDone = new Set(); }
        {
          // 只認「最近一個」到期時段：daemon 若在下午才啟動，過期的盤前時段
          // **標記跳過而不補跑**——補跑 08:00 卻抓到 13:40 的盤況是假資料，
          // 而且會把 11 個時段一次全打（132 次請求）。過期定義＝逾 20 分。
          const due = ASIA_SLOTS.filter(([mk, label]) => mins >= mk && !_asiaSlotsDone.has(label));
          if (due.length) {
            for (const [, label] of due.slice(0, -1)) _asiaSlotsDone.add(label);   // 舊的直接作廢
            const [mk, label] = due[due.length - 1];
            _asiaSlotsDone.add(label);
            if (mins - mk <= 20 && Date.now() - _asiaAt >= 60000) {
              _asiaAt = Date.now();
              try { await computeAsiaPremarket({ slot: label }); } catch (e) { log(`✖ 日韓早盤[${label}]:`, (e.message || '').slice(0, 80)); }
            } else if (mins - mk > 20) {
              log(`ℹ 日韓早盤[${label}] 已過期 ${mins - mk} 分，跳過不補（避免假盤前值）`);
            }
          }
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
          if (await execScript('audit-data-sources.mjs', ['--write'], '🩺 資料源健康稽核', 10)) _healthAuditDate = today;
          else log('✖ 健康稽核失敗，將重試');
          setTimeout(async () => {
            try {
              const h = (await db.collection('system').doc('dataHealth').get()).data();
              if (!h) return;
              // 稽核範圍異常（契約表縮水/probe 整批跳過）比「有異常」更危險——那是全綠假象
              if (h.auditIncomplete) log(`❌ 資料源健康：稽核範圍異常，只檢查 ${h.sourceCount} 個資料源（下限 ${h.minSources}）——本次結果不可信`);
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
          if (await execScript('topup-stock-history.mjs', [], '📈 日線補正', 20)) _histTopupDate = today;
          else log('✖ 日線補正失敗，將重試');
        }
        // 每日 15:25 抓當日市場委託失衡（MI_5MINS）。
        // 2026-08-02 起：三年歷史已回補（orderFlowArchive），這一步是「不讓它斷」——
        // bookDepth 的教訓就是回補/建立完沒接每日更新，半年後打開只有 9 天。
        // 冪等（腳本內建已存跳過），只跑當日一天故 --days 1。
        // 15:40 個股 5分K 歸檔（當沖模式的驗證原料·Yahoo 只保留60日故必須逐日存）
        // ⚠此資料的**成交量少計且逐日逐檔亂跳**（見 archive-intraday.mjs 檔頭），
        //   只可用於價格路徑與同日量形狀；三關法第一關請用 snap0930Archive。
        if (mins >= 15 * 60 + 40 && _intradayDate !== today && isTradingDay(tw)) {
          _intradayDate = today;
          // 用 execScript（它已處理中文路徑的百分號編碼——2026-07-24 那次靜默失敗的修法）
          execScript('archive-intraday.mjs', [], '🕐 盤中5分K歸檔', 40);
          // 20 分後彙總各模式的資料閘門進度（前端讀這一個 doc，不要自己數文件數）
          setTimeout(async () => {
            try {
              const ia = (await db.collection('intradayArchive').get()).docs.map(x => x.id).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x));
              const s0 = (await db.collection('snap0930Archive').get()).docs.map(x => x.id).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x));
              await db.collection('system').doc('modeStatus').set({
                updatedAt: Date.now(),
                daytrade: {
                  intradayDays: ia.length, snap0930Days: s0.length,
                  need: 480,
                  // 第一關要用 snap0930（自家 MIS·口徑可靠）；第三關才用 intraday（Yahoo·量不可靠）
                  gate1Ready: s0.length >= 480, gate3Ready: ia.length >= 480,
                  note: 'Yahoo 5分K 的成交量少計且逐日逐檔亂跳，第一關(前30分量)必須用 snap0930Archive，第三關(拉回品質)才用 intradayArchive 的價格路徑。兩者都要到 480 日才符合本站主窗＋OOT 標準。',
                },
              }, { merge: true });
              log(`✓ 模式資料閘門：當沖 intraday ${ia.length}日／snap0930 ${s0.length}日（需 480）`);
            } catch (e) { log('✖ 模式閘門彙總:', (e.message || '').slice(0, 80)); }
          }, 20 * 60000);
        }
        if (mins >= 15 * 60 + 25 && _orderFlowDate !== today && isTradingDay(tw)) {
          if (await execScript('backfill-orderflow.mjs', ['--days', '1'], '📋 委託失衡', 5)) _orderFlowDate = today;
          else log('✖ 委託失衡失敗，將重試');
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
          if (await execScript('sync-trading-calendar.mjs', [], '📅 休市日曆同步', 5)) _calSyncDate = today;
          else log('✖ 休市日曆同步失敗，將重試');
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
            const arch = (await readArchive(8))
              .map(x => ({ date: x.date, close: JSON.parse(x.closeJson) }))   // doc.date 與 doc.id 同值
              .sort((a, b) => a.date.localeCompare(b.date));
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
                winFrom: '13:20', winTo: '13:35', staleDropped: stale, archivedAt: Date.now(), fetchedAt: Date.now(),
              });
              log(`✓ 尾盤五檔歸檔 ${today}（${n} 檔·${mode}·窗外丟棄 ${stale}）`);
            } else {
              // ⚠⚠ **絕不可用空的跳過紀錄覆蓋已歸檔的好資料**（2026-08-11 查出的資料銷毀 bug）：
              //   `_depthArchDate` 是模組級變數，**daemon 一重啟就歸零**。只要在 13:36 之後
              //   重啟（LaunchAgent 拉起、當機、或人工重啟），這段會再跑一次，
              //   而新 process 的 `_depthWin` 是空的 → winOK=false → 走到這裡用 `.set()`
              //   把當天已存好的全市場五檔**整份覆寫成 {n:0, skipped:true}**。
              //   實證（daemon log）：
              //     05:40:02 ✓ 尾盤五檔歸檔 2026-08-11（1913 檔）
              //     12:28:09 ⚠ 跳過：累積窗無資料   ← 覆蓋
              //     13:24:52 ⚠ 跳過：累積窗無資料   ← 再覆蓋
              //   這解釋了空洞為何間歇：沒在 13:36 後重啟的那幾天就保住了（08-04/08-07）。
              //   而舊的理由字串「daemon 當時未運行？」把因果講反了——
              //   daemon 當時**有**運行且成功歸檔，是**之後重啟**把它抹掉的。
              //   ⚠ 這道守衛不能寫成提早 return：本區塊之後還有 15:10/16:30/16:45/21:45
              //     等多個排程，return 會把它們全部跳過，比原本的 bug 更糟。
              const exist = (await db.collection('bookDepthArchive').doc(today).get()).data();
              if (exist && (exist.n ?? 0) >= 300 && exist.byCodeJson) {
                log(`  ℹ 尾盤五檔 ${today} 已歸檔（${exist.n} 檔），本次不覆蓋`);
              } else {
              // 沒歸檔就要留下痕跡——舊版靜默跳過，9 天缺 2 天都沒人知道
              await db.collection('bookDepthArchive').doc(today).set({
                date: today, n, skipped: true,
                // ⚠ 理由要能分辨兩種完全不同的情況，否則會像先前那樣把因果講反：
                reason: winOK ? `窗內樣本僅 ${n} 檔（<300）`
                  : '本 process 的 13:20~13:35 累積窗為空（多半是 13:36 後才啟動的 process；'
                    + '若當日稍早已成功歸檔，上方守衛會攔下不覆蓋）',
                archivedAt: Date.now(), fetchedAt: Date.now(),
              });
              log(`⚠ 尾盤五檔歸檔跳過 ${today}：${winOK ? `窗內僅 ${n} 檔` : '累積窗無資料'}`);
              }
            }
            _depthWin = { date: '', data: {} };   // 釋放記憶體
          } catch (e) { log('✖ 尾盤五檔歸檔:', e.message); }
        }
        if (mins >= 15 * 60 + 10 && _dailyJobsDate !== today) { await runDailyJobs(); _dailyJobsDate = today; }
        if (mins >= 16 * 60 + 30 && _officialDate !== today) { await runJobSet(OFFICIAL_CATCHUP, '(official)'); _officialDate = today; }
        if (mins >= 21 * 60 + 45 && _marginDate !== today) {
          // ⚠ **成功才標記**（今天第二次踩到同一個反模式）：
          //   原本 _marginDate = today 寫在這裡，後面的訓練資料與檢討報表
          //   任何一步失敗就整天不再重試，而使用者會看到報表停在幾天前
          //   卻沒有任何告警——與早上訓練排程那個是同一課。
          await runJobSet(MARGIN_CATCHUP, '(margin)');
          let _marginOk = true;
          try { await computeChipPicks(); }
          catch (e) { _marginOk = false; log('✖ 資券後重算 chipPicks（將重試）:', e.message); }  // 讓晚間資券立刻進榜單/評分
          // 軋空訓練資料（使用者需求 2026-08-26）：把當日漲停股的**當日與前一日**
          // 完整狀態＋國際盤連動存進第二大腦。必須排在資券歸檔之後，否則
          // 融資券欄位是空的（當日 21:45 才回填）。
          try { await recordSqueezeTraining(); }
          catch (e) { _marginOk = false; log('✖ 軋空訓練資料（將重試）:', e.message); }
          // 做空訓練樣本（2026-09-03）：同班車——資券已歸檔，特徵最完整
          try { await recordShortTraining(); }
          catch (e) { log('✖ 做空訓練樣本（將重試）:', (e.message || '').slice(0, 60)); }
          // 逐日對答案＋漏網診斷（使用者要求逐日修正）
          try { await computeSqueezeReview({ backfillDays: 3 }); }
          catch (e) { _marginOk = false; log('✖ 軋空檢討（將重試）:', e.message); }
          if (_marginOk) _marginDate = today;
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
        // 只在**上櫃來源真的抓到**時才標記今日已補：TPEx 抖一下就整天缺上櫃，
        // 是 CLAUDE.md 記載過的痛點。後面兩個是依賴它的重算，本來就冪等，
        // 重試不會造成重複資料。
        let otcOk = false;
        try { await archiveOtcIndex(); otcOk = true; } catch (e) { log('✖ 櫃買指數歸檔（將於下一輪重試）:', e.message); }
        if (otcOk) _otcFixDate = today;
        try { await archiveChipDaily(); } catch (e) { log('✖ otc補跑 archive:', e.message); }
        try { await backfillOtcPending(); } catch (e) { log('✖ 上櫃補洞:', (e.message || '').slice(0, 60)); }   // 更早日子的 otcPending（2026-08-20 型）
        try { await computePriceEvents(); } catch (e) { log('✖ 價格結構事件:', (e.message || '').slice(0, 60)); }   // 上櫃併入後重算係數，供下面 dailySeq／swingHold 還原
        try { await computeStrategyPicks(); } catch (e) { log('✖ otc補跑 strategyPicks:', e.message); }
        try { await computeLimitUpForecast(); } catch (e) { log('✖ otc補跑 limitUp:', e.message); }
        try { await checkRsiHot(); } catch (e) { log('✖ rsiHot盤後:', e.message); }
        try { await computeSwingPicks(); } catch (e) { log('✖ 波段起漲盤後:', e.message); }
        try { await computeSwingHold(); } catch (e) { log('✖ 波段持有:', e.message); }        // 5/10/20/60 日連續成長榜＋整合榜（收盤定版·存歷史）
        try { await computeDailySeq(); } catch (e) { log('✖ dailySeq:', e.message); }          // 全市場每檔近 10 日漲跌×量＋三線位置（自選列小提示）   // 收盤定版價出貨警示（盤中另有每分檢查）
        // 第2套預選：先對前幾天的答案（scoreSwingCurves 讀的是歸檔，與今日分型無關），
        // 再產今日分型。順序反過來也不會錯，但這樣 log 讀起來是「先結算再開盤」。
        try { await scoreSwingCurves(); } catch (e) { log('✖ 曲線記分板:', e.message); }
        try { await computeSwingCurves(); } catch (e) { log('✖ 曲線分型:', e.message); }
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
if (!ONESHOT) daemonHealthLoop();   // 開機＋每小時：Ollama 探測、熔斷器狀態、任務耗時 → system/daemonHealth

// 再平衡設定監看：使用者在 UI 更新現金部位後，45 秒內重算配置漂移
// (否則要等每日排程，看起來像「輸入沒成功」)。
async function rebalanceSettingsLoop() {
  for (;;) {
    try {
      const premium = await getPremiumUsers();
      let stale = false;
      for (const u of premium) {
        const [st, led, rb, td] = await Promise.all([
          db.collection('users').doc(u.id).collection('data').doc('rebalanceSettings').get(),
          db.collection('users').doc(u.id).collection('data').doc('cashLedger').get(),
          db.collection('users').doc(u.id).collection('data').doc('rebalance').get(),
          db.collection('users').doc(u.id).collection('data').doc('trades').get(),
        ]);
        const rbAt = rb.data()?.updatedAt || 0;
        // trades 也要看：記一筆買賣同時改變持股與現金，原本不在監看清單，
        // 使用者下單後這張卡最慢要等到下一輪 daily jobs（可達數小時）才重算。
        if ((st.exists && (st.data().updatedAt || 0) > rbAt)
          || (led.exists && (led.data().updatedAt || 0) > rbAt)
          || (td.exists && (td.data().updatedAt || 0) > rbAt)) { stale = true; break; }
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
    gapLimitUp: () => computeGapLimitUp({ push: process.env.GAPLU_PUSH === '1' }),   // GAPLU_DATE=YYYY-MM-DD 指定事件日
    gapLimitUpReview: () => computeGapLimitUpReview(),
    swingHold: () => computeSwingHold({ force: process.env.SWING_HOLD_FORCE === '1' }),   // 波段持有榜（SWING_HOLD_FORCE=1 強制重算）
    dailySeq: () => computeDailySeq({ force: process.env.DAILY_SEQ_FORCE === '1' }),      // 全市場近 10 日漲跌×量＋三線位置
    // 新聞內文判別管線。第二個參數是死線（台北分鐘數），單次執行不設。
    // 測試用：NV_LIMIT 可縮小宇宙，避免驗證一次就跑滿 150 檔。
    newsVerdictEvening: () => computeNewsVerdictBatch('evening'),
    newsVerdictMorning: () => computeNewsVerdictBatch('morning'),
    newsVerdictReview: () => computeNewsVerdictReview(),
    newsVerdictIntraday: () => computeIntradayNewsVerdict(),
    otcBackfill: () => backfillOtcPending(+(process.env.OTC_BACKFILL_DAYS || 15)),   // 歸檔 otcPending 補上櫃日 K（2026-09-17）
    priceEvents: () => computePriceEvents(),   // 價格結構事件表（減資／面額變更／分割／大額除權）只記錄（2026-09-17）
    mops: () => ingestMops(),                 // 公開資訊觀測站重大訊息抓取去重（2026-09-17）
    sectorSpot: () => computeSectorSpot(),    // 產業現貨／原物料報價（免費來源）
    newsVerdictNight: () => computeNightBackfill(),
    // 驗證用：NV_CODES=3037,1303 單獨判別指定個股，不寫入正式存檔
    // 變異度量測：同一檔重複判別 N 次，看結果穩不穩。
    // NV_CODES=2882,3008 NV_REPS=3
    // ⚠ 這件事必須量：若同一檔跑三次得到三種結果，單次判別就不能用來排序。
    newsVerdictVariance: async () => {
      const codes = String(process.env.NV_CODES || '').split(',').map(x => x.trim()).filter(Boolean);
      const reps = +(process.env.NV_REPS || 3);
      if (!codes.length) { log('請設 NV_CODES=代號,代號'); return; }
      const snap = (await db.collection('marketSnapshot').doc('latest').get()).data();
      const q = JSON.parse(snap.quotesJson || '{}');
      const ctx = await newsJudgeContext([isoDate(taipei())]);
      const tally = {};
      for (const c of codes) {
        tally[c] = [];
        for (let i = 0; i < reps; i++) {
          const r = await judgeOneStock({ code: c, name: q[c] && q[c].name ? q[c].name : c }, ctx, {});
          const v = r && r.verdict;
          tally[c].push(v ? v.label + '/' + v.strength : '(無)');
        }
        const arr = tally[c];
        const uniq = [...new Set(arr)];
        const counts = uniq.map(u => u + ' x' + arr.filter(x => x === u).length);
        const name = q[c] && q[c].name ? q[c].name : '';
        log('  ▸ ' + c + ' ' + name + ': ' + arr.join(' | '));
        log('     ⇒ ' + (uniq.length === 1 ? '**完全一致**' : uniq.length + ' 種結果（' + counts.join('、') + '）'));
      }
    },
    newsVerdictProbe: async () => {
      const codes = String(process.env.NV_CODES || '').split(',').map(x => x.trim()).filter(Boolean);
      if (!codes.length) { log('請設 NV_CODES=代號,代號'); return; }
      const snap = (await db.collection('marketSnapshot').doc('latest').get()).data();
      const q = JSON.parse(snap.quotesJson || '{}');
      const ctx = await newsJudgeContext([isoDate(taipei())]);
      for (const c of codes) {
        const r = await judgeOneStock({ code: c, name: q[c]?.name || c }, ctx, {});
        const v = r?.verdict;
        log(`  ▸ ${c} ${q[c]?.name || ''} → ${v ? `${v.label}·強度${v.strength}·信心${v.confidence}·已預期${v.priced || '?'}` : '(無)'}`);
        if (r?.picked?.length) {
          log(`      ── 實際採用的 ${r.picked.length} 篇 ──`);
          r.picked.forEach((a, i) => {
            log(`      ${i + 1}. 《${a.title}》${a.hasBody ? `（內文來源:${a.bodyFrom || '?'}）` : '（僅標題）'}`);
            if (a.content) log(`         ${String(a.content).replace(/\s+/g, ' ').slice(0, 150)}`);
          });
        }
        if (v) {
          log(`      L1 抽取: 事件類型 ${v.eventType || '—'}｜確定性 ${v.certainty || '—'}｜新穎性 ${v.novelty || '—'}`);
          log(`      關鍵句: ${(v.keyQuote || '—').slice(0, 46)}`);
          log(`      影響路徑: ${(v.impactPath || '—').slice(0, 54)}`);
          log(`      初判挑戰: ${(v.challenge || '—').slice(0, 44)}`);
          log(`      ▸挑戰${v.challenged ? '✓' : '✗'} 方向${v.dirChecked ? '✓' : '✗'} 引用${v.quoteVerified != null ? `${v.quoteVerified}通過/${v.quoteFailed}失敗` : '✗'} 強度${v.strengthChecked ? '✓' : '✗'} | 閘門 ${v.gate || '通過'}`);
          if (v.quotes?.length) v.quotes.forEach(q => log(`        ❝ ${String(q).slice(0, 54)}`));
          if (v.strengthBasis) log(`        強度依據: ${String(v.strengthBasis).slice(0, 52)}`);
          if (v.unsupported?.length) v.unsupported.forEach(u => log(`        ✂ 刪除無依據: ${String(u).slice(0, 56)}`));
          if (v.unverifiedNums?.length) log(`        ⚠ 數字未查證: ${v.unverifiedNums.join('、')}`);
          if (v.challenges) for (const k in v.challenges) if (v.challenges[k] && v.challenges[k] !== '無')
            log(`        [${k}] ${String(v.challenges[k]).slice(0, 52)}`);
        }
      }
    },
    asia: () => computeAsiaPremarket({ lateCatchup: process.argv.includes('--late') }),
    chipPicks: () => computeChipPicks(),
    alerts: () => checkAlerts(),
    swingPicks: () => computeSwingPicks(),
    strengthPicks: () => computeStrengthPicks(),
    marketPulse: () => computeMarketPulse(),          // 大盤即時脈動
    limitQueue: async () => computeLimitQueue((await readSnapshotQuotes())?.quotes || {}),
    squeezePicks: () => computeSqueezePicks(),        // 手動產出軋空候選(含次交易日模式)
    squeezeReview: () => computeSqueezeReview({ backfillDays: Number(process.argv[process.argv.indexOf('--run') + 2] || 60) }),
    squeezeTraining: () => recordSqueezeTraining(),   // 手動補當日訓練資料
    globalHist: () => updateGlobalHistory(),          // 手動更新國際盤歷史
    // 只抓內文、不呼叫 LLM，把候選＋內文原樣倒成 JSON 給外部判別者使用。
    // 用途：Ollama 塞住而盤前死線逼近時，由其他 AI 接手判別（2026-09-01 使用者授權）。
    // ⚠ 刻意不複製抓取邏輯——直接用 fetchStockNewsMulti，
    //   否則就違反 4548 行那條「不可以複製第二份」。
    newsDump: async () => {
      const outPath = process.argv[process.argv.indexOf('--run') + 2];
      if (!outPath) { log('✖ newsDump 需要輸出路徑'); return; }
      const picks = (await db.collection('squeezePicks').doc('latest').get()).data();
      const fc = (await db.collection('limitUpForecast').doc('latest').get()).data();
      const seen = new Map();
      for (const it of (picks?.items || [])) seen.set(it.code, { ...it, _from: 'squeeze' });
      for (const it of [...(fc?.aList || []), ...(fc?.bList || [])]) {
        if (seen.has(it.code)) seen.get(it.code)._from += '+limitUp';
        else seen.set(it.code, { ...it, _from: 'limitUp' });
      }
      let indMap = {};
      try { indMap = await getIndustryMap(); } catch { /* 少一個錨，不擋 */ }
      const out = [];
      for (const it of seen.values()) {
        let news = [];
        try { news = await fetchStockNewsMulti(it.name, it.code); } catch (e) { log(`  ✖ ${it.code} 抓取:`, e.message); }
        out.push({ ...it, industry: indMap[it.code] || null, news });
      }
      const fs = await import('node:fs/promises');
      await fs.writeFile(outPath, JSON.stringify({
        generatedAt: Date.now(),
        squeezeTargetDate: picks?.targetDate || null, squeezeArchDate: picks?.archDate || null,
        limitUpDataDate: fc?.dataDate || null,
        stocks: out,
      }, null, 1));
      log(`✓ newsDump：${out.length} 檔（含內文 ${out.filter(s => s.news.some(n => n.hasBody)).length} 檔）→ ${outPath}`);
    },
    squeezeRec: () => computeSqueezeNewsVerdict(),
    limitUpRec: () => computeLimitUpNewsVerdict(),   // 漲停預測的新聞判別    // 手動產出新聞判別(讀內文+AI)
    limitUpForecast: () => computeLimitUpForecast(), // 漲停預測榜重算（機器模型，不用 LLM；盤外自動用歸檔模式）
    shortCandidates: () => computeShortCandidates(), // 做空風控候選榜（2026-09-03 第一期）
    shortTraining: () => recordShortTraining(),      // 手動補做空訓練樣本
    shortReview: () => computeShortReview(),         // 做空榜對答案
    revenue: () => computeRevenue(),              // 月營收排行（改口徑後手動重算）
    swingCurves: () => computeSwingCurves(),      // 第2套預選：PID 斜率曲線分型
    curveScore: () => scoreSwingCurves(),         // 第2套預選：60日實記對答案
    globalMarkets: () => computeGlobalMarkets(),
    trackPicks: () => trackPicks(),   // 推薦成績追蹤（改榜單清單後可手動補跑一次）
    tradeSignals: () => computeTradeSignals(),   // 當沖/隔日沖候選（改口徑後手動重算）
    recommendAdj: () => computeRecommendAdj(),   // 推薦榜已驗證訊號修正量
    reversalSignals: () => computeReversalSignals(),
    userRisk: () => computeUserRisk(),          // 投組相關性/分散度（與 stressTest 共寫 portfolioRisk）
    stressTest: () => computeStressTest(),
    chipArchive: () => archiveChipDaily(),        // 籌碼歸檔（法人/資券/借券/當沖）      // β/壓力測試（同上·兩者皆須 merge）   // 反轉訊號 v1（凍結·前瞻驗證）
    dayTradeEligible: () => computeDayTradeEligible(),  // 當沖資格名單（盤前可跑）
    dayTradeRatio: () => computeDayTradeRatio(),  // 當沖比率（統計傍晚才發布·會自動回溯補抓最近有統計的交易日）
  };
  const fn = JOBS[ONESHOT];
  if (!fn) { log(`✖ 未知 job「${ONESHOT}」。可用：${Object.keys(JOBS).join(', ')}`); process.exit(1); }
  try { await fn(); log(`✓ 單次執行完成：${ONESHOT}`); process.exit(0); }
  catch (e) { log(`✖ 單次執行失敗 ${ONESHOT}:`, e.stack || e.message); process.exit(1); }
}
