// ── 請求記錄（逐批寫入，不含 token）────────────────────────────────────────────
// 每行：[backfill] <台北時間> <JSON>；寫檔前整行再遮罩一次（縱深防禦：就算上游把 token 回聲在 msg 裡也抹掉）。
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { maskSecrets } from './secrets.mjs';
import { taipeiParts } from './timewin.mjs';

export function formatRecord(rec, { tag = 'backfill', now = Date.now, secrets = [] } = {}) {
  return maskSecrets(`[${tag}] ${taipeiParts(now()).iso} ${JSON.stringify(rec)}`, secrets);
}

export function createRequestLog(path, { secrets = [], tag = 'backfill', now = Date.now, batch = 20, append = appendFileSync, mkdir = mkdirSync } = {}) {
  let buf = [];
  let failed = false;
  const flush = () => {
    if (!buf.length || !path) { buf = []; return; }
    try { mkdir(dirname(path), { recursive: true }); append(path, `${buf.join('\n')}\n`); } catch (e) {
      if (!failed) console.warn(`⚠ 請求記錄寫入失敗（${e.code || e.message}），之後只在記憶體略過`);
      failed = true;
    }
    buf = [];
  };
  return {
    write(rec) { buf.push(formatRecord(rec, { tag, now, secrets })); if (buf.length >= batch) flush(); },
    flush,
    pending: () => buf.length,
  };
}
