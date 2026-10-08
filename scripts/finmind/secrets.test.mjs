// FinMind token 讀取／遮罩 單元測試：node --test scripts/finmind/secrets.test.mjs
// 夾具 token 全是假值（隨機字串），不打網路。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvCandidates, readTokenCandidates, maskSecrets, scrubBody, chooseToken, describeCandidates } from './secrets.mjs';

const FAKE_A = 'eyFAKEaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaTAILAAAA';
const FAKE_B = 'eyFAKEbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbTAILBBBB';

test('parseEnvCandidates：重複鍵全部列為候選（照檔案順序），空值另列行號，不取 dotenv 的「最後一行勝出」', () => {
  const text = ['A=1', `FINMIND_TOKEN=${FAKE_A}`, 'FINMIND_TOKEN=', `export FINMIND_TOKEN="${FAKE_B}"`, '# FINMIND_TOKEN=commented'].join('\n');
  const r = parseEnvCandidates(text);
  assert.deepEqual(r.candidates.map(c => c.line), [2, 4]);
  assert.equal(r.candidates[0].value, FAKE_A);
  assert.equal(r.candidates[1].value, FAKE_B, '引號要剝掉');
  assert.deepEqual(r.empty, [3]);
});

test('parseEnvCandidates：單引號、行尾註解、CRLF、等號兩側空白', () => {
  const text = `FINMIND_TOKEN = '${FAKE_A}'\r\nFINMIND_TOKEN=${FAKE_B} # 註解\r\nOTHER_FINMIND_TOKEN=x`;
  const r = parseEnvCandidates(text);
  assert.deepEqual(r.candidates.map(c => c.value), [FAKE_A, FAKE_B]);
});

test('readTokenCandidates：從檔案讀；檔案不存在時錯誤訊息只講路徑不講值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fm-secrets-'));
  const p = join(dir, '.env.local');
  writeFileSync(p, `FINMIND_TOKEN=${FAKE_A}\n`);
  assert.equal(readTokenCandidates(p).candidates[0].value, FAKE_A);
  assert.throws(() => readTokenCandidates(join(dir, 'nope')), e => /讀不到/.test(e.message) && !e.message.includes(FAKE_A));
});

test('describeCandidates：只給行號與長度，不含值', () => {
  const d = describeCandidates([{ line: 22, value: FAKE_A }]);
  assert.deepEqual(d, [{ line: 22, length: FAKE_A.length }]);
  assert.ok(!JSON.stringify(d).includes(FAKE_A));
});

test('maskSecrets：完整 token、token 末 8 碼、Bearer 標頭、token_tail 欄位、URL 的 token= 參數一律遮掉', () => {
  const s = [
    `Authorization: Bearer ${FAKE_A}`,
    `{"msg":"bad","status":400,"token_tail":"${FAKE_A.slice(-8)}"}`,
    `raw=${FAKE_A}`,
    `tail-only ${FAKE_B.slice(-8)} here`,
    'https://api.finmindtrade.com/api/v4/data?dataset=X&token=zzzzzzzzzzzz',
  ].join('\n');
  const m = maskSecrets(s, [FAKE_A, FAKE_B]);
  assert.ok(!m.includes(FAKE_A));
  assert.ok(!m.includes(FAKE_A.slice(-8)));
  assert.ok(!m.includes(FAKE_B.slice(-8)));
  assert.ok(!m.includes('zzzzzzzzzzzz'));
  assert.match(m, /Bearer \*\*\*/);
  assert.match(m, /"token_tail":"\*\*\*"/);
});

test('maskSecrets：非字串輸入不爆、短字串不誤遮', () => {
  assert.equal(maskSecrets(undefined, [FAKE_A]), '');
  assert.equal(maskSecrets('price 2330', ['abc']), 'price 2330');
});

test('scrubBody：遞迴刪除 token_tail／token／authorization 鍵，字串值再遮罩，不改原物件', () => {
  const body = { msg: `oops ${FAKE_A}`, status: 400, token_tail: FAKE_A.slice(-8), nested: [{ Authorization: 'Bearer x', ok: 1 }] };
  const out = scrubBody(body, [FAKE_A]);
  assert.deepEqual(Object.keys(out).sort(), ['msg', 'nested', 'status']);
  assert.deepEqual(out.nested, [{ ok: 1 }]);
  assert.ok(!JSON.stringify(out).includes(FAKE_A.slice(-8)));
  assert.equal(body.token_tail, FAKE_A.slice(-8), '原物件不變（不可變更）');
});

test('chooseToken：依序以 user_info 驗 level，選第一個 level≥3；只回傳行號，失敗清單不含值', async () => {
  const cands = [{ line: 22, value: FAKE_B }, { line: 24, value: FAKE_A }];
  const seen = [];
  const verify = async tok => { seen.push(tok === FAKE_A ? 'A' : 'B'); return tok === FAKE_A ? { ok: true, http: 200, level: 3, info: { level: 3 } } : { ok: true, http: 200, level: 1, info: { level: 1 } }; };
  const r = await chooseToken(cands, verify);
  assert.equal(r.line, 24); assert.equal(r.level, 3); assert.equal(r.token, FAKE_A);
  assert.deepEqual(seen, ['B', 'A']);
  assert.deepEqual(r.rejected, [{ line: 22, length: FAKE_B.length, http: 200, level: 1 }]);
});

test('chooseToken：全部不合格時丟錯，訊息只有行號／長度／http／level', async () => {
  const cands = [{ line: 22, value: FAKE_A }];
  await assert.rejects(chooseToken(cands, async () => ({ ok: false, http: 401, level: null })),
    e => /第 22 行/.test(e.message) && !e.message.includes(FAKE_A) && !e.message.includes(FAKE_A.slice(-8)));
  await assert.rejects(chooseToken([], async () => ({})), /找不到/);
});

test('chooseToken：verify 本身丟出含 token 的錯誤，也要遮掉', async () => {
  const cands = [{ line: 22, value: FAKE_A }];
  await assert.rejects(chooseToken(cands, async t => { throw new Error(`net fail ${t}`); }),
    e => !e.message.includes(FAKE_A) && !e.message.includes(FAKE_A.slice(-8)));
});
