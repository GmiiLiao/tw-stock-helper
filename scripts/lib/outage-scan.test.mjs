// node --test scripts/lib/outage-scan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recentOutageLines } from './outage-scan.mjs';

test('只回最近窗內、符合故障字樣的行', () => {
  const now = Date.parse('2026-10-03T05:40:00Z');
  const log = [
    '2026-10-03T05:36:07.984Z   ⚠ 上櫃後備亦失敗 → 沿用上一份快取 903 檔（stale-if-error）',
    '2026-10-03T05:00:00.000Z   ⚠ 上櫃後備亦失敗 → 沿用上一份快取 903 檔（stale-if-error）',
    '2026-10-03T05:39:00.000Z ✓ 產業輪動：領漲 化學',
    '沒有時間戳的行 stale-if-error',
  ].join('\n');
  const r = recentOutageLines(log, now);
  assert.equal(r.length, 1);
  assert.ok(r[0].startsWith('2026-10-03T05:36'));
  assert.deepEqual(recentOutageLines('', now), []);
});
