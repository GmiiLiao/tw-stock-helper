// node --test scripts/lib/tracks-pins.test.mjs
// T1 分軌前向釘選閘門：觸及釘選檔時 sha256 要等於登錄值或有 PIN-UPDATE 列；沒觸及的不管（不把整個 repo 的一致性放進測試閘門——
// 合併帶進來的不符會讓所有人的 commit 都被擋；全面稽核用 node scripts/check-tracks-pins.mjs 不帶參數）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePinUpdates, pinViolations } from './tracks-pins.mjs';

const A = 'a'.repeat(64); const B = 'b'.repeat(64); const C = 'c'.repeat(64);
const pins = { 'scripts/surge-lab/build.py': A, 'scripts/surge-lab/disposal.py': B };

test('PIN-UPDATE 列解析（同 a36_tracks_fwd_rules.pin_updates 的正規式）', () => {
  const u = parsePinUpdates(`## FDEV-009 改 build.py\nPIN-UPDATE: scripts/surge-lab/build.py ${C}\n  PIN-UPDATE: scripts/surge-lab/build.py ${B}  \n說明 PIN-UPDATE: x ${A}\n\`PIN-UPDATE: <scripts/surge-lab/檔名> <新 sha256>\``);
  assert.deepEqual([...u['scripts/surge-lab/build.py']].sort(), [B, C]);
  assert.equal(Object.keys(u).length, 1);
});

test('沒觸及釘選檔 ⇒ 不擋（即使工作樹的釘選檔已不符）', () => {
  assert.deepEqual(pinViolations({ pins, staged: ['src/x.ts', 'scripts/surge-lab/a37_tracks_fwd.py'], shaOf: () => C, updates: {} }), []);
});

test('觸及且 sha 不符、也沒有 PIN-UPDATE ⇒ 擋；登錄值相符或有 PIN-UPDATE ⇒ 放行；刪除 ⇒ 擋', () => {
  const shaOf = f => ({ 'scripts/surge-lab/build.py': C, 'scripts/surge-lab/disposal.py': B })[f];
  assert.deepEqual(pinViolations({ pins, staged: ['scripts/surge-lab/build.py', 'scripts/surge-lab/disposal.py'], shaOf, updates: {} }),
    [{ file: 'scripts/surge-lab/build.py', now: C, registered: A }]);
  assert.deepEqual(pinViolations({ pins, staged: ['scripts/surge-lab/build.py'], shaOf, updates: parsePinUpdates(`PIN-UPDATE: scripts/surge-lab/build.py ${C}`) }), []);
  assert.deepEqual(pinViolations({ pins, staged: ['scripts/surge-lab/disposal.py'], shaOf: () => null, updates: {} }),
    [{ file: 'scripts/surge-lab/disposal.py', now: null, registered: B }]);
});
