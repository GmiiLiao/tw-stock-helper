// README 產生（docs.mjs）單元測試：node --test scripts/finmind/docs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSpec } from './datasets.mjs';
import { writeDocs, FIELD_NOTES_START, FIELD_NOTES_END } from './docs.mjs';

test('writeDocs：README 不存在才寫；--refresh-docs 覆寫時保留人工「實測筆記」區塊（2026-10-08 試抓者寫入的欄位口徑差異）', () => {
  const root = mkdtempSync(join(tmpdir(), 'fm-docs-'));
  const spec = getSpec('TaiwanStockKBar');
  writeDocs(root, [spec]);
  const p = join(root, spec.name, 'README.md');
  const notes = `${FIELD_NOTES_START}\n## 試抓實測\n- 量約官方 92–99%\n${FIELD_NOTES_END}\n`;
  writeFileSync(p, `${readFileSync(p, 'utf8')}\n${notes}`);
  writeDocs(root, [spec]);                    // 不覆寫
  assert.ok(readFileSync(p, 'utf8').includes('量約官方 92–99%'));
  writeDocs(root, [spec], { force: true });   // 覆寫，但實測筆記要留著
  const after = readFileSync(p, 'utf8');
  assert.ok(after.includes('量約官方 92–99%'));
  assert.equal(after.split(FIELD_NOTES_START).length, 2, '區塊只出現一次');
  assert.ok(after.startsWith('# TaiwanStockKBar'));
  const top = join(root, 'README.md');
  writeFileSync(top, `${readFileSync(top, 'utf8')}\n${notes}`);
  writeDocs(root, [spec], { force: true });
  assert.ok(readFileSync(top, 'utf8').includes('量約官方 92–99%'), '根目錄 README 的實測筆記也要保留');
});
