// 原始碼釘住（新聞規則類別 A4：daemon judgeOneStock 的事實確認與規則判定、三個 newsVerdict 寫入端）：
//   node --test scripts/lib/news-rule-daemon-pin.test.mjs
//   daemon 是 disk 即部署，這組測試確保（停損規範 SKILL §10A.2；2026-10-05 審查修正）：
//   ①主判別提示詞與回答解析和 HEAD 逐字相同——事實題**不嵌進**主判別（免得主判別的 label 漂移）；
//   ②事實題在主判別定案之後、每個命中的類別另問一次；③規則判定不看 AI 原判 label（漏網修正）；④三個寫入端都存規則欄位。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const daemon = readFileSync(join(HERE, '..', 'ai-daemon.mjs'), 'utf8');
const code = s => s.replace(/\/\/.*$/gm, '');   // 只看程式碼（註解可以提到這些字）
const judge = daemon.slice(daemon.indexOf('async function judgeOneStock('), daemon.indexOf('async function newsJudgeContext('));

test('主判別提示詞不含事實題：沒有【規則事實確認】、沒有「事實Cxx」回答格式；回答格式最後一行同 HEAD', () => {
  assert.ok(judge.length > 1000, '找得到 judgeOneStock');
  for (const bad of ['ruleAsk', 'ruleFactPromptParts', 'parseRuleFactLines', '【規則事實確認】']) assert.ok(!code(judge).includes(bad), bad);
  assert.ok(judge.includes('⚠ 強度與信心是兩件事：信心＝你對判斷本身有多確定；強度＝事件本身多大。\n\n請用**繁體中文**依此格式回答，不要多餘文字：'));
  assert.ok(judge.includes('風險: （一句話，50 字內，指出這個判斷最大的不確定性；無明顯風險寫「無」）`;'));
});

test('事實題在主判別定案之後另問：每個命中的類別一次（本機模型、priority 1、NEWS_TEMP）；觸發範圍＝與本檔同時出現的報導前 1,200 字', () => {
  const c = code(judge);
  assert.ok(c.includes('const ruleTrig = ruleTriggerScan(_picked, countMentions, 1200);'));
  const loop = c.indexOf('for (const c of ruleTrig.codes) {');
  assert.ok(loop > 0);
  assert.ok(loop > c.indexOf("if (verdict && (verdict.label === '中性' || verdict.label === '資訊不足')) {"), '在中性歸零之後（主判別定案）');
  assert.ok(loop > c.indexOf("gate: 'E-引用強制',"), '在引用強制之後');
  assert.ok(c.includes('const a2 = await askOllama(q, { priority: 1, temperature: NEWS_TEMP });'));
  assert.ok(c.includes('facts[c] = a2 ? parseRuleFactAnswer(c, a2) : null;'));
  assert.ok(c.includes('verdict = applyRuleFacts(verdict, { facts });'));
  assert.ok(!c.includes('const LEGAL ='), '不再另寫一份法律字樣');
});

test('規則判定不看 AI 原判 label（漏網修正）：條件只有 verdict 與觸發；舊的 `verdict.label !== \'利空\'` 條件已拿掉', () => {
  const c = code(judge);
  assert.ok(c.includes('if (verdict && ruleTrig.codes.length) {'));
  assert.ok(!c.includes("if (verdict && negHits.length && verdict.label !== '利空') {"));
});

test('三個 newsVerdict 寫入端（夜補、盤中、盤後／晨間）都存規則欄位（ruleFieldsOf 共用一支）', () => {
  const c = code(daemon);
  assert.equal((c.match(/\.\.\.ruleFieldsOf\(v\),/g) || []).length, 3);
  for (const anchor of ["pass: 'night', at: Date.now(),", "pass: 'intraday', at: Date.now(),", 'basis: v.basis, n: v.n, pass, at: Date.now(),']) {
    const i = c.indexOf(anchor);
    assert.ok(i > 0, anchor);
    const end = c.indexOf('};', i);
    assert.ok(c.slice(i, end).includes('...ruleFieldsOf(v),'), `${anchor} 這個寫入端沒存規則欄位`);
  }
});

test('主判別回答解析與 HEAD 相同：daemon 裡不再有任何事實行解析', () => {
  const regs = [...judge.matchAll(/const (m\w+) = ans\.match\((\/.+?\/[a-z]*)\);/g)].map(m => m[1]);
  assert.ok(regs.length >= 14, `主判別欄位正規式 ${regs.length} 個`);
  assert.ok(!regs.some(r => /fact/i.test(r)));
  assert.ok(!/事實\\s\*/.test(judge));
});
