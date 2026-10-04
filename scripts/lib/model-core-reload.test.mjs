import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateModelCore, readModelCore, backupModelCore, decideModelCoreReload, datedBackupName, MIN_LEADERS } from './model-core-reload.mjs';

const join = (...p) => p.join('/');
const REAL = JSON.parse(readFileSync(new URL('../data/model-core.json', import.meta.url), 'utf8'));

function memFs(files = {}) {
  const store = { ...files };
  return {
    store,
    readFileSync: (p) => { if (!(p in store)) { const e = new Error('nope'); e.code = 'ENOENT'; throw e; } return store[p]; },
    writeFileSync: (p, s) => { store[p] = s; },
    mkdirSync: () => {},
    existsSync: (p) => p in store,
  };
}

test('實際 scripts/data/model-core.json 通過驗證（防驗證器比生產檔嚴而永遠拒換）', () => {
  assert.deepEqual(validateModelCore(REAL), { ok: true });
});

test('缺 tierBase.neutral／adds 權重／thresholds 不單調／龍頭殘缺 → 拒絕', () => {
  assert.equal(validateModelCore({ ...REAL, tierBase: { S: 59 } }).ok, false);
  assert.equal(validateModelCore({ ...REAL, adds: { ...REAL.adds, sqz: { name: 'x' } } }).ok, false);
  assert.equal(validateModelCore({ ...REAL, thresholds: { ...REAL.thresholds, bullish: { min: 40 } } }).ok, false);
  assert.equal(validateModelCore({ ...REAL, leaders: REAL.leaders.slice(0, MIN_LEADERS - 1) }).ok, false);
  assert.equal(validateModelCore({ ...REAL, costPct: NaN }).ok, false);
  assert.equal(validateModelCore(null).ok, false);
});

test('readModelCore：讀不到／壞 JSON 不丟例外', () => {
  const fs = memFs({ '/a': '{bad' });
  assert.equal(readModelCore(fs, '/missing').ok, false);
  assert.match(readModelCore(fs, '/a').reason, /JSON/);
});

test('datedBackupName 取 generatedAt 日期，缺時用 fallback', () => {
  assert.equal(datedBackupName({ generatedAt: '2026-08-11T14:25:15.777Z' }, '2026-10-04'), 'model-core.2026-08-11.json');
  assert.equal(datedBackupName({}, '2026-10-04'), 'model-core.2026-10-04.json');
});

test('backupModelCore 寫 prev＋帶日期檔；帶日期檔已存在不覆寫', () => {
  const raw = JSON.stringify(REAL);
  const fs = memFs({ '/d/model-core.json': raw, '/bk/model-core.2026-08-11.json': 'OLD' });
  const r = backupModelCore(fs, { src: '/d/model-core.json', dir: '/bk', today: '2026-10-04', join });
  assert.equal(r.ok, true);
  assert.equal(fs.store['/bk/model-core.prev.json'], raw);
  assert.equal(fs.store['/bk/model-core.2026-08-11.json'], 'OLD');
});

test('backupModelCore 現行檔無效時不備份（不讓壞檔蓋掉 prev）', () => {
  const fs = memFs({ '/d/model-core.json': '{}', '/bk/model-core.prev.json': 'GOOD' });
  const r = backupModelCore(fs, { src: '/d/model-core.json', dir: '/bk', today: '2026-10-04', join });
  assert.equal(r.ok, false);
  assert.equal(fs.store['/bk/model-core.prev.json'], 'GOOD');
});

test('重建成功且新檔有效 → swap', () => {
  const next = { ...REAL, generatedAt: '2026-11-02T09:20:00Z' };
  const fs = memFs({ '/d/m.json': JSON.stringify(next) });
  const r = decideModelCoreReload(fs, { src: '/d/m.json', buildOk: true, backupRaw: JSON.stringify(REAL), current: REAL });
  assert.equal(r.action, 'swap');
  assert.equal(r.core.generatedAt, '2026-11-02T09:20:00Z');
});

test('重建成功但新檔無效 → 保留舊版並把檔案還原', () => {
  const oldRaw = JSON.stringify(REAL);
  const fs = memFs({ '/d/m.json': JSON.stringify({ ...REAL, leaders: [] }) });
  const r = decideModelCoreReload(fs, { src: '/d/m.json', buildOk: true, backupRaw: oldRaw, current: REAL });
  assert.equal(r.action, 'keep');
  assert.equal(r.core, REAL);
  assert.equal(r.restored, true);
  assert.equal(fs.store['/d/m.json'], oldRaw);
});

test('重建腳本失敗 → 保留舊版（即使檔案已被半途改寫也還原）', () => {
  const oldRaw = JSON.stringify(REAL);
  const fs = memFs({ '/d/m.json': JSON.stringify({ ...REAL, generatedAt: 'x' }) });
  const r = decideModelCoreReload(fs, { src: '/d/m.json', buildOk: false, backupRaw: oldRaw, current: REAL });
  assert.equal(r.action, 'keep');
  assert.match(r.reason, /重建腳本失敗/);
  assert.equal(fs.store['/d/m.json'], oldRaw);
});

test('沒有備份時失敗 → keep 但不動檔案', () => {
  const fs = memFs({ '/d/m.json': '{}' });
  const r = decideModelCoreReload(fs, { src: '/d/m.json', buildOk: true, backupRaw: null, current: null });
  assert.equal(r.action, 'keep');
  assert.equal(r.restored, false);
  assert.equal(fs.store['/d/m.json'], '{}');
});
