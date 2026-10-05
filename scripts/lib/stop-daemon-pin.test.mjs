// 原始碼釘住（停損 v1.1 S2b 推播文字＋S3 影子試算的 daemon 接線）：node --test scripts/lib/stop-daemon-pin.test.mjs
//   daemon 是 disk 即部署，這組測試確保：①九處推播文字都改由 ai-stoploss-text.mjs 產生、舊的指令句不再出現；
//   ②舊算法的錨點（推播停損、if 鏈、紀律停損、analyses.stopLoss 語意）原樣保留；③影子路徑不推播、不寫 alerts、不讀寫 _hwm；
//   ④S3 影子期 LLM 提示詞不改（SKILL §10.1、llm-contract 時程），只量測現有輸出。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const daemon = readFileSync(join(HERE, '..', 'ai-daemon.mjs'), 'utf8');
const runner = readFileSync(join(HERE, 'stop-shadow-runner.mjs'), 'utf8');
const store = readFileSync(join(HERE, 'stop-shadow-store.mjs'), 'utf8');
const code = s => s.replace(/\/\/.*$/gm, '');   // 只看程式碼（註解可以提到這些字）

test('S2b：九處推播文字改由 ai-stoploss-text.mjs 產生；舊指令句不再出現在 daemon 程式碼', () => {
  for (const fn of ['stopPushTextS2b(', 'trailPushTextS2b(', 'disciplinePushTextS2b(', 'defenseListText(', 'defensePushText(', 'plungePushText(',
    'watchDropPushText(', 'watchDropSummaryText(', 'overnightOpenPushText(']) assert.ok(daemon.includes(fn), fn);
  for (const old of ['— 建議檢視風險', '— 建議鎖利出場', '持股請確認停損價位', '持有者請即刻確認停損價位', '——確認停損', '**建議動作**',
    '請開投組頁查看防禦清單', '隔日沖開盤賣出提醒', '已觸發第 ${days} 天未處理', '若觸發當日執行，可少虧約']) assert.ok(!code(daemon).includes(old), old);
});

test('舊算法錨點原樣保留（S2b 只換字串；回滾與 legacyPushStop／legacyDisciplineStop 依賴它們）', () => {
  assert.ok(daemon.includes('const stop = a.stopLoss > 0 ? a.stopLoss : +(avg * 0.92).toFixed(2);'));
  assert.ok(daemon.includes("if (price <= stop) { type = 'stop';"));
  assert.ok(daemon.includes("else if (trailActive && price <= trailStop && price > avg) { type = 'trailing';"));
  assert.ok(daemon.includes('const stop = +Math.max(a.stopLoss > 0 ? a.stopLoss : 0, avg * 0.92).toFixed(2);'));
  assert.ok(daemon.includes("const stop = +Math.max(pa[code]?.stopLoss > 0 ? pa[code].stopLoss : 0, avg * 0.92).toFixed(2);"));
  assert.ok(daemon.includes('stopLoss: st?.stopLoss ?? null,'), 'analyses[code].stopLoss 一直是 /api/rating 的 ATR 帶（J11）');
  assert.ok(daemon.includes('const hw = _hwm[wkey] = Math.max(_hwm[wkey] || avg, price);'), '現行獲利回落線照舊（切換時才取代）');
});

test('影子路徑：不推播、不寫 alerts、不讀寫 _hwm；失敗不觸發現行推播的去重撤回', () => {
  for (const src of [code(runner), code(store)]) {
    // pushAlerts( 是 daemon 的推播出口（plan* 回傳的 pushAlerts 欄位只是「若切換會送什麼」的資料，影子只把它記進 wouldPush）
    for (const bad of ['pushAlerts(', "doc('alerts')", '_hwm', 'tgSend', 'webpush', 'pushAgentMsg(']) assert.ok(!src.includes(bad), bad);
  }
  const hook = daemon.slice(daemon.indexOf('// ── 停損 v1.1 影子試算（S3：只記錄、不推播、不寫 alerts）'), daemon.indexOf("} catch (e) { _alerted.rollback(_tok); log('  ✖ alerts'"));
  assert.ok(hook.includes('_stopShadow.tick(') && hook.includes('.catch('), '盤中影子在 checkAlerts 每位會員迴圈內、錯誤各自吞掉');
  assert.ok(!code(hook).includes('_alerted'), '影子不碰現行推播的去重');
  assert.ok(daemon.indexOf('_stopShadow.tick(') > daemon.indexOf("pushAlerts(uid, newAlerts).catch(() => {});\n        for (const al of newAlerts) log(`  🔔 ${uid} ${al.message}`);"), '影子在現行推播寫入之後');
  assert.ok(/import\('\.\/lib\/stop-shadow-runner\.mjs'\)/.test(daemon), '影子以動態 import 載入（載入失敗不影響 daemon）');
  assert.ok(!/^import .*ai-stoploss\.mjs'/m.test(daemon), 'daemon 不靜態 import 集線器（會連帶載入另一流程的 after-market-news）');
});

test('排程段落成功才 markJobDone（盤前 stopShadowPre、收盤 stopShadowClose），開機讀回 readJobMarks', () => {
  assert.ok(runner.includes("await markJobDone('stopShadowClose', target)"));
  assert.ok(runner.includes("await markJobDone('stopShadowPre', todayYmd)"));
  assert.ok(runner.includes('await readJobMarks()'));
  assert.ok(daemon.includes('trainDone: ymd => _otcFixDate === ymd'), '收盤結算看資料到齊班車，不看時鐘');
});

test('LLM：S3 影子期不改提示詞（SKILL §10.1、llm-contract 時程）——持股分析與個股波段的提示詞維持 HEAD 原文，只量測現有輸出', () => {
  const a = daemon.slice(daemon.indexOf('function buildPrompt('), daemon.indexOf('function parseSwing('));
  assert.ok(a.includes('function buildPrompt({ code, name, pnlPct, avgCost, price, rating, news, isRisk, riskType, chip }) {'), '簽章同 HEAD（沒有 stop 參數）');
  assert.ok(a.includes("join('、')}；停損 ${st.stopLoss}`);"), '持股分析的帶照 HEAD 給');
  assert.ok(a.includes('請勿杜撰數據。結尾不需免責聲明。${STRICT_RULE}\n'), '持股分析規則句同 HEAD（不接 PHASE1_STOP_RULE）');
  const s = daemon.slice(daemon.indexOf('async function swingForCode('), daemon.indexOf('async function analyzeAll('));
  assert.ok(s.includes("join('、')}、停損 ${st.stopLoss}` : ''"), '個股波段的帶照 HEAD 給');
  assert.ok(s.includes('具體波段進出價位與停損；'), '個股波段要求照 HEAD');
  assert.ok(s.includes('結尾不需免責聲明。${STRICT_RULE}\\n\\n【數據】'), '個股波段規則句同 HEAD');
  for (const bad of ['PHASE1_STOP_RULE', 'STOP_REF_FORMAT', 'phase1HoldingStopLine(', 'phase1HypotheticalStopLine(', 'splitStopRef(', '停損只能引用上面的停損']) {
    assert.ok(!code(daemon).includes(bad), `S3 不接提示詞片段：${bad}`);
  }
  const u = daemon.slice(daemon.indexOf('async function analyzeUser('), daemon.indexOf('async function swingForCode('));
  assert.ok(u.includes('const out = await askOllama(buildPrompt({ code, name: g.name, pnlPct, avgCost, price, rating, news, isRisk, riskType, chip }));'));
  assert.ok(u.includes('expectRef: false') && s.includes('expectRef: false'), 'S3 量測不記 T1（提示詞沒要求 STOP_REF）');
  assert.ok(s.includes('const out = await askOllama(prompt);') && s.includes('markUnverified(out.trim(), badNums, 900)'));
});
