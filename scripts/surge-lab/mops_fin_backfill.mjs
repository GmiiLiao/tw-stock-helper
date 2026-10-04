#!/usr/bin/env node
// ── 起漲研究·季財報回補（公開資訊觀測站 t163sb04 綜合損益表彙總；官方；寫本機研究快取）──────────────
// 一季一市場一個請求就是全市場：TYPEK=sii／otc、year＝民國年、season＝01..04。⚠ Q2／Q3／Q4 為年初累計，解析端換算單季。
// 原始 HTML（UTF-8）gzip 存 .surge-cache/official/mops_t163sb04/{sii|otc}_{民國年}_{季}.html.gz；
// 驗證：頁面須含「上市公司／上櫃公司」與「第N季」字樣且有公司代號列，否則記 .skip.json。
// 同一出口 IP：逐請求間隔 ≥5 秒；平日 07:30～15:30 不跑（與 official_backfill 相同）。
// 用法：node scripts/surge-lab/mops_fin_backfill.mjs [--from 110] [--to 115] [--cache <目錄>]
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { inQuietWindow } from './official_backfill.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const SEASON_TXT = { 1: '第一季', 2: '第二季', 3: '第三季', 4: '第四季' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function args(argv) {
  const a = { from: 110, to: 115, cache: process.env.SURGE_CACHE || join(HERE, '.surge-cache'), gap: 5000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from') a.from = Number(argv[++i]);
    else if (argv[i] === '--to') a.to = Number(argv[++i]);
    else if (argv[i] === '--cache') a.cache = argv[++i];
    else throw new Error(`未知參數：${argv[i]}`);
  }
  return a;
}

/** 現在時點已過法定期限（取各業最晚：5/31、8/31、11/30、3/31）的季才抓，避免抓到還在陸續申報中的半份表。 */
function seasonClosed(rocY, s, now = new Date()) {
  const y = rocY + 1911;
  const due = s === 4 ? new Date(Date.UTC(y + 1, 3, 1)) : new Date(Date.UTC(y, [5, 8, 11][s - 1], 1));
  return now.getTime() >= due.getTime();
}

async function main() {
  const a = args(process.argv.slice(2));
  const dir = join(a.cache, 'official', 'mops_t163sb04'); mkdirSync(dir, { recursive: true });
  let ok = 0, skip = 0, fail = 0;
  for (let y = a.from; y <= a.to; y++) for (let s = 1; s <= 4; s++) for (const typek of ['sii', 'otc']) {
    if (!seasonClosed(y, s)) continue;
    const base = join(dir, `${typek}_${y}_${s}`);
    if (existsSync(`${base}.html.gz`) || existsSync(`${base}.skip.json`)) continue;
    if (inQuietWindow()) { console.log('進入平日 07:30～15:30，停止'); return; }
    try {
      const r = await fetch('https://mopsov.twse.com.tw/mops/web/ajax_t163sb04', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        body: `encodeURIComponent=1&step=1&firstin=1&off=1&isQuery=Y&TYPEK=${typek}&year=${y}&season=0${s}`, signal: AbortSignal.timeout(60000),
      });
      if (r.status === 403 || r.status === 429) { console.log(`HTTP ${r.status}，停止`); return; }
      const html = await r.text();
      const mkt = typek === 'sii' ? '上市公司' : '上櫃公司';
      const okPage = r.ok && html.includes(mkt) && html.includes(SEASON_TXT[s]) && /<td[^>]*>\s*\d{4}\s*<\/td>/.test(html);
      if (okPage) { writeFileSync(`${base}.html.gz`, gzipSync(html)); ok++; console.log(`✓ ${typek} ${y}Q${s}（${(html.length / 1e6).toFixed(2)}MB）`); }
      else { writeFileSync(`${base}.skip.json`, JSON.stringify({ http: r.status, head: html.slice(0, 200) })); skip++; console.log(`· ${typek} ${y}Q${s} 無資料或格式不符`); }
    } catch (e) { fail++; console.log(`✖ ${typek} ${y}Q${s}：${e.message}`); if (fail >= 3) return; }
    await sleep(a.gap + Math.floor(Math.random() * 1000));
  }
  console.log(`完成：寫入 ${ok}／略過 ${skip}／失敗 ${fail}`);
}

main().then(() => process.exit(0), e => { console.error('✖', e.message); process.exit(1); });
