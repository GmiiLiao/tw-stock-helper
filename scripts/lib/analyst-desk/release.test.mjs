import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAction, applyRelease } from '../../release-daily-analyst.mjs';

const fakeDb = () => { const store = new Map(); return { store, collection: c => ({ doc: d => ({ get: async () => ({ exists: store.has(`${c}/${d}`), data: () => store.get(`${c}/${d}`) }), set: async v => { store.set(`${c}/${d}`, v); } }) }) }; };

test('parseAction：互斥與預設', () => {
  assert.equal(parseAction(['--on']), 'on'); assert.equal(parseAction(['--off']), 'off');
  assert.equal(parseAction(['--status']), 'status'); assert.equal(parseAction([]), 'status');
  assert.equal(parseAction(['--on', '--off']), null); assert.equal(parseAction(['--x']), null);
});

test('applyRelease：預設未放行；放行與撤回寫 system/analystRelease', async () => {
  const db = fakeDb();
  assert.deepEqual(await applyRelease({ db, action: 'status' }), { released: false, exists: false, updatedAt: null });
  assert.equal((await applyRelease({ db, action: 'on', now: 5 })).released, true);
  assert.deepEqual(db.store.get('system/analystRelease'), { released: true, updatedAt: 5 });
  assert.equal((await applyRelease({ db, action: 'status' })).released, true);
  assert.equal((await applyRelease({ db, action: 'off', now: 6 })).released, false);
});
