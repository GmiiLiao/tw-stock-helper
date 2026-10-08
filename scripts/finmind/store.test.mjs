// 落地（gzip 成員追加＋索引、斷點續抓、原子收尾、單程序鎖）單元測試：node --test scripts/finmind/store.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, appendFileSync, statSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { groupPaths, readDone, openGroup, appendMember, finalizeGroup, closeGroup, readGroupRows, readMemberRows,
  writeJsonAtomic, readJson, acquireLock, releaseLock, gzipLines } from './store.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'fm-store-'));
const gz = rows => gzipSync(rows.map(r => JSON.stringify(r)).join('\n') + '\n');

test('groupPaths：日期群組放年份子目錄；快照／區間放資料集根；by-stock 變體另一個子目錄', () => {
  const p = groupPaths('/r', 'TaiwanStockKBar', '2026-10-07');
  assert.equal(p.final, '/r/TaiwanStockKBar/2026/2026-10-07.jsonl.gz');
  assert.equal(p.part, '/r/TaiwanStockKBar/2026/2026-10-07.part.jsonl.gz');
  assert.equal(p.finalIdx, '/r/TaiwanStockKBar/2026/2026-10-07.idx.tsv');
  assert.equal(groupPaths('/r', 'X', 'snapshot_2026-10-08').final, '/r/X/snapshot_2026-10-08.jsonl.gz');
  assert.equal(groupPaths('/r', 'TaiwanStockTradingDailyReport', '2026-10-07', 'by-stock').final, '/r/TaiwanStockTradingDailyReport/by-stock/2026/2026-10-07.jsonl.gz');
  assert.throws(() => groupPaths('/r', 'X', '../etc'), /群組/);
});

test('追加成員→收尾：多成員 gzip 可整檔解壓、索引可按成員隨機讀取；readDone 回報完成', () => {
  const p = groupPaths(tmp(), 'TaiwanStockKBar', '2026-10-07');
  const g = openGroup(p);
  appendMember(g, '2330', gz([{ stock_id: '2330', close: 1 }]), 1);
  appendMember(g, '9999', null, 0);   // 空成員：只記索引
  appendMember(g, '6129', gz([{ stock_id: '6129', close: 2 }, { stock_id: '6129', close: 3 }]), 2);
  let st = readDone(p);
  assert.deepEqual([...st.done].sort(), ['2330', '6129', '9999']);
  assert.equal(st.final, false); assert.equal(st.status, 'partial');
  finalizeGroup(g);
  assert.ok(existsSync(p.final) && !existsSync(p.part) && existsSync(p.finalIdx));
  st = readDone(p);
  assert.equal(st.final, true); assert.equal(st.status, 'complete'); assert.equal(st.rows, 3);
  assert.deepEqual(readGroupRows(p).map(r => r.close), [1, 2, 3]);
  assert.deepEqual(readMemberRows(p, '6129').map(r => r.close), [2, 3]);
  assert.deepEqual(readMemberRows(p, '9999'), []);
});

test('全空群組收尾：檔案仍是合法 gzip，狀態 empty', () => {
  const p = groupPaths(tmp(), 'X', '2026-10-07');
  const g = openGroup(p);
  appendMember(g, '*', null, 0);
  finalizeGroup(g);
  assert.equal(gunzipSync(readFileSync(p.final)).length, 0);
  assert.equal(readDone(p).status, 'empty');
});

test('斷點續抓：資料檔尾端有未登錄的半截成員→截掉；索引尾行指向不存在的位元組→丟掉', () => {
  const p = groupPaths(tmp(), 'TaiwanStockKBar', '2026-10-07');
  let g = openGroup(p);
  appendMember(g, '2330', gz([{ a: 1 }]), 1);
  appendMember(g, '2603', gz([{ a: 2 }]), 1);
  closeGroup(g);
  const good = statSync(p.part).size;
  appendFileSync(p.part, gzipSync('{"a":3}\n').subarray(0, 10));   // 程序在寫資料途中被殺
  appendFileSync(p.partIdx, `6129\t1\t${good}\t${good + 999}\n`);   // 索引超出檔尾
  g = openGroup(p);
  assert.deepEqual([...g.done.keys()], ['2330', '2603']);
  assert.equal(statSync(p.part).size, good);
  appendMember(g, '6129', gz([{ a: 3 }]), 1);
  finalizeGroup(g);
  assert.deepEqual(readGroupRows(p).map(r => r.a), [1, 2, 3]);
});

test('斷點續抓：最後一個成員位元組損毀（解不開）→丟掉該成員重抓', () => {
  const p = groupPaths(tmp(), 'X', '2026-10-07');
  let g = openGroup(p);
  appendMember(g, 'A', gz([{ a: 1 }]), 1);
  appendMember(g, 'B', gz([{ a: 2 }]), 1);
  closeGroup(g);
  const size = statSync(p.part).size;
  truncateSync(p.part, size - 4); appendFileSync(p.part, Buffer.from([0, 0, 0, 0]));   // 尾端 CRC/長度被改壞
  g = openGroup(p);
  assert.deepEqual([...g.done.keys()], ['A']);
  closeGroup(g);
});

test('已收尾的群組可重開追加（例如之後補 ETF）', () => {
  const p = groupPaths(tmp(), 'TaiwanStockKBar', '2026-10-07');
  let g = openGroup(p); appendMember(g, '2330', gz([{ a: 1 }]), 1); finalizeGroup(g);
  g = openGroup(p);
  assert.ok(g.done.has('2330'));
  appendMember(g, '0050', gz([{ a: 9 }]), 1); finalizeGroup(g);
  assert.deepEqual(readGroupRows(p).map(r => r.a), [1, 9]);
});

test('成員代號不可含分隔字元（索引是 TSV）', () => {
  const g = openGroup(groupPaths(tmp(), 'X', '2026-10-07'));
  assert.throws(() => appendMember(g, 'a\tb', null, 0), /成員/);
  closeGroup(g);
});

test('gzipLines：逐列寫入 gzip 串流（背壓）→ Buffer', async () => {
  const w = gzipLines();
  await w.write(['{"a":1}', '{"a":2}']);
  const buf = await w.end();
  assert.equal(gunzipSync(buf).toString(), '{"a":1}\n{"a":2}\n');
});

test('writeJsonAtomic／readJson：原子寫入；讀壞檔回預設值', () => {
  const d = tmp(); const f = join(d, 'sub', 'x.json');
  writeJsonAtomic(f, { a: 1 });
  assert.deepEqual(readJson(f, null), { a: 1 });
  writeFileSync(join(d, 'bad.json'), '{oops');
  assert.deepEqual(readJson(join(d, 'bad.json'), { z: 1 }), { z: 1 });
});

test('單程序鎖：活著的程序持有時拒絕；死掉的程序留下的鎖可接手；只釋放自己的鎖', () => {
  const d = tmp();
  const lock = acquireLock(d, { pid: process.pid });
  assert.throws(() => acquireLock(d, { pid: 999999 }), /另一個/);
  releaseLock(lock);
  writeFileSync(join(d, '_lock.json'), JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: 'x' }));   // 不存在的 pid
  const l2 = acquireLock(d, { pid: process.pid });
  assert.equal(readJson(join(d, '_lock.json')).pid, process.pid);
  releaseLock({ ...l2, pid: 1 });   // 不是自己的：不刪
  assert.ok(existsSync(join(d, '_lock.json')));
  releaseLock(l2);
  assert.ok(!existsSync(join(d, '_lock.json')));
});

test('forEachRow：串流逐列讀（含進行中的 .part）', async () => {
  const { forEachRow } = await import('./store.mjs');
  const p = groupPaths(tmp(), 'X', '2026-10-07');
  const g = openGroup(p);
  appendMember(g, 'A', gz([{ a: 1 }, { a: 2 }]), 2);
  closeGroup(g);
  const got = [];
  assert.equal(await forEachRow(p, r => got.push(r.a)), 2);
  assert.deepEqual(got, [1, 2]);
  assert.equal(await forEachRow(groupPaths(tmp(), 'X', '2026-10-08'), () => {}), 0);
});
