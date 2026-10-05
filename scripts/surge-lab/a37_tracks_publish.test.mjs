// node --test scripts/surge-lab/a37_tracks_publish.test.mjs
// T1 分軌前向發佈：本機封印記錄 → 逐位副本（gzip＋分片）→ 讀回 sha256 相符；--restore 只補本機不存在的檔、不覆寫、壞副本不寫。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

test('發佈乾跑：一天的凍結檔清單判定與該版本後台標籤不一致時，只擋那一天、其餘照常（exit 1＋列出那一天），不再整批中止', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a37pubday-'));
  const amend = { registration_id: 'T1-TRACKS-FWD-2026-10-05', version: '1.1' };
  const days = { '2026-10-06': {}, '2026-10-07': { 'S0_atr14@5': { list_verdict: 'S-KEEP-AS-SHADOW：觀察／研究榜', picks: [] } }, '2026-10-08': {} };
  for (const [d, lists] of Object.entries(days)) {
    writeFileSync(join(dir, `tracks_fwd_${d}.json`), JSON.stringify({ kind: 't1-tracks-core', date_s: d, t: null, rehearsal: false, lists, registration_amendment: amend }));
  }
  // 封印＝與 a37_tracks_fwd_io.seal_of 同參數的正規化 JSON sha256（發佈端用 python3 重算核對）
  const PY = existsSync('/Library/Frameworks/Python.framework/Versions/3.14/bin/python3') ? '/Library/Frameworks/Python.framework/Versions/3.14/bin/python3' : 'python3';
  const seal = 'import json,hashlib,sys,glob\nfor f in glob.glob(sys.argv[1]+"/tracks_fwd_*.json"):\n    o=json.load(open(f,encoding="utf-8"))\n'
    + '    o["seal"]=hashlib.sha256(json.dumps(o,sort_keys=True,ensure_ascii=False,separators=(",",":"),allow_nan=False).encode("utf-8")).hexdigest()\n'
    + '    json.dump(o,open(f,"w",encoding="utf-8"),ensure_ascii=False)';
  execFileSync(PY, ['-c', seal, dir]);
  const r = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'a37_tracks_publish.mjs'), '--dir', dir, '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /凍結 2 日/);                                          // 兩天照常建日文件
  assert.match(r.stdout, /日文件 2 份/);
  assert.match(r.stdout, /逐位副本本機往返 全部逐位相同/);                     // 逐位副本（三天的封印記錄）照常
  assert.match(r.stderr, /2026-10-07：凍結檔 S0_atr14@5 的清單判定與後台標籤不一致（v1\.1）/);
  assert.doesNotMatch(r.stderr, /整批中止/);
});
