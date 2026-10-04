// daemon-code-hash：execScript 子腳本納入雜湊（2026-10-04·WM-SCAN G4-30）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { daemonCodeHash, deriveExecScripts } from './daemon-code-hash.mjs';

test('推導：字面值呼叫點全收、註解與函式定義不算', () => {
  const src = [
    'function execScript(name, args, tag, timeoutMin = 10) {}',
    '//   呼叫端 `if (await execScript(...)) _x = today` 會永遠拿到 undefined',
    "if (await execScript('audit-data-sources.mjs', ['--write'], 't', 10)) ok();",
    "setTimeout(() => execScript(\"build-model-core.mjs\", [], 't', 10), 1);",
    "execScript('audit-data-sources.mjs', [], 'dup');   // 去重",
    "const u = 'https://x.tw/a'; execScript('backup-brain.mjs', [], 'b');",
  ].join('\n');
  const d = deriveExecScripts(src);
  assert.equal(d.ok, true, d.reason);
  assert.deepEqual(d.scripts, ['audit-data-sources.mjs', 'backup-brain.mjs', 'build-model-core.mjs']);
});

test('推導失敗：非字面值參數、0 支、檔案不存在都回 ok=false', () => {
  assert.equal(deriveExecScripts("execScript(name, [], 't')").ok, false);
  assert.equal(deriveExecScripts("execScript(`x-${a}.mjs`, [], 't')").ok, false);
  assert.equal(deriveExecScripts('const a = 1;').ok, false);
  assert.equal(deriveExecScripts("execScript('gone.mjs', [])", () => false).ok, false);
});

test('雜湊：子腳本及其 import 納入；改子腳本會改變雜湊；推導失敗退回全收', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dch-'));
  try {
    const s = join(dir, 'scripts'); mkdirSync(join(s, 'lib'), { recursive: true });
    writeFileSync(join(s, 'ai-daemon.mjs'), "import { a } from './lib/a.mjs';\nexecScript('child.mjs', [], 'c');\n");
    writeFileSync(join(s, 'lib', 'a.mjs'), 'export const a = 1;\n');
    writeFileSync(join(s, 'child.mjs'), "import { b } from './lib/b.mjs';\n");
    writeFileSync(join(s, 'lib', 'b.mjs'), 'export const b = 1;\n');
    writeFileSync(join(s, 'unrelated.mjs'), '// 不是子腳本\n');
    const r1 = daemonCodeHash(join(s, 'ai-daemon.mjs'));
    const names = r1.files.map(f => f.slice(f.lastIndexOf('/scripts/') + 1));
    assert.deepEqual(names, ['scripts/ai-daemon.mjs', 'scripts/child.mjs', 'scripts/lib/a.mjs', 'scripts/lib/b.mjs']);
    assert.deepEqual(r1.children, ['child.mjs']);
    writeFileSync(join(s, 'lib', 'b.mjs'), 'export const b = 2;\n');
    assert.notEqual(daemonCodeHash(join(s, 'ai-daemon.mjs')).hash, r1.hash, '子腳本的 import 改了要反映在雜湊');
    writeFileSync(join(s, 'ai-daemon.mjs'), "import { a } from './lib/a.mjs';\nexecScript(dyn, [], 'c');\n");
    const r3 = daemonCodeHash(join(s, 'ai-daemon.mjs'));
    assert.match(r3.derivation, /推導失敗/);
    assert.ok(r3.children.includes('unrelated.mjs') && r3.children.includes('child.mjs'), '退回全收 scripts/ 頂層 .mjs');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
