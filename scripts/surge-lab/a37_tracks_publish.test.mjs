// node --test scripts/surge-lab/a37_tracks_publish.test.mjs
// T1 分軌前向發佈：本機封印記錄 → 逐位副本（gzip＋分片）→ 讀回 sha256 相符；--restore 只補本機不存在的檔、不覆寫、壞副本不寫。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { collect, rawWrites, readBackShas, restoreFromRaw } from './a37_tracks_publish.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'a37pub-'));
  const core = { kind: 't1-tracks-core', date_s: '2026-10-06', t: '2026-10-07', rehearsal: false, lists: {}, seal: 'c'.repeat(64), note: '中文' };
  writeFileSync(join(dir, 'tracks_fwd_2026-10-06.json'), JSON.stringify(core));
  writeFileSync(join(dir, 'tracks_fwd_score_2026-10-06_y.json'), JSON.stringify({ kind: 't1-tracks-score', stage: 'y', frozen_seal: core.seal, seal: 'd'.repeat(64) }));
  writeFileSync(join(dir, 'tracks_fwd_gap_2026-10-07.json'), JSON.stringify({ kind: 't1-tracks-gap', date_s: '2026-10-07', rehearsal: false, seal: 'e'.repeat(64) }));
  writeFileSync(join(dir, 'tracks_fwd_2026-10-08.json'), JSON.stringify({ kind: 't1-tracks-core', date_s: '2026-10-08', rehearsal: true, seal: 'f'.repeat(64) }));
  mkdirSync(join(dir, 'prewire'));
  writeFileSync(join(dir, 'prewire', 'tracks_fwd_prewire_20261007T221500.json'), JSON.stringify({ kind: 't1-tracks-prewire', seal: 'a'.repeat(64) }));
  writeFileSync(join(dir, 'tracks_fwd_summary.json'), JSON.stringify({ rehearsal: false }));
  return dir;
}

test('collect：封印記錄（core、評分、缺口、接線前證明）都有逐位副本 id；演練檔與摘要不收', () => {
  const c = collect(fixture());
  assert.deepEqual(c.raw.map(r => r.id).sort(), ['tracks-raw-core-2026-10-06', 'tracks-raw-gap-2026-10-07', 'tracks-raw-prewire-20261007T221500', 'tracks-raw-score-2026-10-06-y']);
  assert.ok(c.skipped.some(s => s.includes('2026-10-08')));
});

test('逐位副本往返：gzip→分片→讀回→解壓 sha256＝本機原檔；restore 只補不存在的檔、不覆寫、壞副本不寫', async () => {
  const src = fixture();
  const c = collect(src);
  const writes = new Map(rawWrites(c.raw));
  const get = async id => writes.get(id) ?? null;
  const back = await readBackShas(get, c.raw.map(r => r.id));
  for (const r of c.raw) assert.equal(back[r.id], r.sha256, r.id);
  const heads = [...writes].filter(([, w]) => w.kind === 't1-tracks-raw').map(([id, data]) => ({ id, data }));
  const dst = mkdtempSync(join(tmpdir(), 'a37restore-'));
  writeFileSync(join(dst, 'tracks_fwd_gap_2026-10-07.json'), '本機已有、內容不同');
  const r = await restoreFromRaw(dst, heads, get);
  assert.deepEqual(r.restored.sort(), ['prewire/tracks_fwd_prewire_20261007T221500.json', 'tracks_fwd_2026-10-06.json', 'tracks_fwd_score_2026-10-06_y.json']);
  assert.deepEqual(r.conflict, ['tracks_fwd_gap_2026-10-07.json']);
  assert.equal(readFileSync(join(dst, 'tracks_fwd_gap_2026-10-07.json'), 'utf8'), '本機已有、內容不同');      // 不覆寫
  for (const f of r.restored) assert.equal(sha(readFileSync(join(dst, f))), sha(readFileSync(join(src, f))), f);
  const again = await restoreFromRaw(dst, heads, get);
  assert.equal(again.restored.length, 0); assert.equal(again.same.length, 3);
  const tampered = heads.map(h => (h.id === 'tracks-raw-core-2026-10-06' ? { ...h, data: { ...h.data, sha256: '0'.repeat(64) } } : h));
  const dst2 = mkdtempSync(join(tmpdir(), 'a37restore-'));
  const r2 = await restoreFromRaw(dst2, tampered, get);
  assert.ok(r2.bad.some(x => x.includes('sha256 不符')));
  assert.ok(!existsSync(join(dst2, 'tracks_fwd_2026-10-06.json')));
  const evil = heads.map(h => (h.id === 'tracks-raw-gap-2026-10-07' ? { ...h, data: { ...h.data, file: '../../etc/x.json' } } : h));
  const r3 = await restoreFromRaw(mkdtempSync(join(tmpdir(), 'a37restore-')), evil, get);
  assert.ok(r3.bad.some(x => x.includes('檔名不合規')));
});
