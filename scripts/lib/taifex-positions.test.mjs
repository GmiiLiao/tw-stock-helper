// node --test scripts/lib/taifex-positions.test.mjs
// 外資台指期未平倉（期交所三大法人·區分各期貨契約）：正確列（臺股期貨×外資及陸資）、正確欄（多方未平倉−空方未平倉）、
// 回聲驗證、欄位不符拒收、文件 basisVersion；官方鏡像本機檔在就再對四個已驗證日（second-brain 不進版控，沒有就略過）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseForeignTxfOI, foreignTradeNetSumOf, taifexPositionsDoc, futContractsRequest, isCurrentTaifexBasis, mergeTaifexPositionsDoc,
  TAIFEX_POSITIONS_BASIS, TAIFEX_FUT_CONTRACTS_URL,
} from './taifex-positions.mjs';
import { FUT_CONTRACTS_20261007 } from './taifex-positions.fixture.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIRROR = join(process.env.OFFICIAL_ROOT || join(REPO, 'second-brain', 'official'), 'www.taifex.com.tw', 'taifex_fut_contracts');

test('10-07：臺股期貨×外資及陸資 未平倉淨口數＝多方未平倉−空方未平倉（−79,101），不是 23 種期貨交易淨額合計（−21,459）', () => {
  const r = parseForeignTxfOI(FUT_CONTRACTS_20261007, '2026-10-07');
  assert.equal(r.status, 'ok', r.reason);
  assert.equal(r.dataDate, '2026-10-07');
  assert.equal(r.longOI, 13545);
  assert.equal(r.shortOI, 92646);
  assert.equal(r.netOI, -79101);
  assert.equal(r.netOI, r.longOI - r.shortOI);
  assert.equal(r.tradeNet, 408, '同一列的交易口數淨額（另列，不是未平倉）');
  // 舊 daemon 寫進 foreignTxfNetOI 的值＝外資及陸資在所有期貨商品的「交易」口數淨額合計（研究輸出 daemon_style_trade_net_sum）
  assert.equal(foreignTradeNetSumOf(FUT_CONTRACTS_20261007), -21459);
});

test('回聲：CSV 自報日期≠期望日 ⇒ notYet（官方還沒出那一天，不寫成期望日的值）', () => {
  const r = parseForeignTxfOI(FUT_CONTRACTS_20261007, '2026-10-08');
  assert.equal(r.status, 'notYet');
  assert.equal(r.dataDate, '2026-10-07');
  assert.equal(r.netOI, undefined);
});

test('只有表頭／查無資料 ⇒ notYet；欄位改名或順序變了 ⇒ invalid（依欄名取值，缺欄就拒收，不猜位置）', () => {
  const head = FUT_CONTRACTS_20261007.split('\r\n')[0];
  assert.equal(parseForeignTxfOI(`${head}\r\n`, '2026-10-07').status, 'notYet');
  assert.equal(parseForeignTxfOI('<html>查無資料</html>', '2026-10-07').status, 'notYet');
  assert.equal(parseForeignTxfOI('', '2026-10-07').status, 'notYet');
  const renamed = FUT_CONTRACTS_20261007.replace('多方未平倉口數,', '多方未平倉量,');
  assert.equal(parseForeignTxfOI(renamed, '2026-10-07').status, 'invalid');
  // 欄位順序變了但欄名都在：照欄名取值，結果相同
  const lines = FUT_CONTRACTS_20261007.split('\r\n').filter(Boolean).map(l => l.split(','));
  const swapped = lines.map(c => { const x = [...c]; [x[9], x[11]] = [x[11], x[9]]; return x.join(','); }).join('\r\n');
  const s = parseForeignTxfOI(swapped, '2026-10-07');
  assert.equal(s.status, 'ok'); assert.equal(s.netOI, -79101);
});

test('淨額欄與（多方−空方）不一致 ⇒ invalid（官方檔內部矛盾，不寫）；找不到臺股期貨×外資列 ⇒ invalid', () => {
  const bad = FUT_CONTRACTS_20261007.replace('13545,135388163,92646,925985823,-79101', '13545,135388163,92646,925985823,-79000');
  assert.equal(parseForeignTxfOI(bad, '2026-10-07').status, 'invalid');
  const noRow = FUT_CONTRACTS_20261007.split('\r\n').filter(l => !l.startsWith('2026/10/07,臺股期貨,外資及陸資')).join('\r\n');
  assert.equal(parseForeignTxfOI(noRow, '2026-10-07').status, 'invalid');
  const mixed = FUT_CONTRACTS_20261007.replace('2026/10/07,電子期貨,自營商', '2026/10/06,電子期貨,自營商');
  assert.equal(parseForeignTxfOI(mixed, '2026-10-07').status, 'invalid', '同一檔內日期不一致');
});

test('big5 位元組直接可解（官方原檔是 cp950）', { skip: existsSync(join(MIRROR, '2026-10-07.csv.gz')) ? false : '本機沒有官方鏡像——略過' }, () => {
  const buf = gunzipSync(readFileSync(join(MIRROR, '2026-10-07.csv.gz')));
  const r = parseForeignTxfOI(buf, '2026-10-07');
  assert.equal(r.status, 'ok'); assert.equal(r.netOI, -79101);
});

test('官方鏡像四個已驗證日（研究輸出 foreign_txf_oi.csv）', { skip: existsSync(join(MIRROR, '2026-10-02.csv.gz')) ? false : '本機沒有官方鏡像——略過' }, () => {
  const want = { '2026-10-02': -80304, '2026-10-05': -77004, '2026-10-06': -79517, '2026-10-07': -79101 };
  for (const [d, v] of Object.entries(want)) {
    const p = join(MIRROR, `${d}.csv.gz`);
    if (!existsSync(p)) continue;
    const r = parseForeignTxfOI(gunzipSync(readFileSync(p)), d);
    assert.equal(r.status, 'ok', `${d} ${r.reason}`);
    assert.equal(r.netOI, v, d);
  }
});

test('請求：與官方鏡像同一支 CSV 端點（POST form、帶日期 YYYY/MM/DD、全部商品），一律要逾時', () => {
  const q = futContractsRequest('2026-10-07');
  assert.equal(q.url, TAIFEX_FUT_CONTRACTS_URL);
  assert.equal(q.init.method, 'POST');
  assert.equal(new URLSearchParams(q.init.body).get('queryStartDate'), '2026/10/07');
  assert.equal(new URLSearchParams(q.init.body).get('queryEndDate'), '2026/10/07');
  assert.equal(new URLSearchParams(q.init.body).get('commodityId'), '');
  assert.ok(q.init.signal instanceof AbortSignal, '要帶逾時 signal');
});

test('文件：date＝資料日 YYYYMMDD、basisVersion、多空未平倉另列；外資沒取得時未平倉欄全為 null（不沿用別天）', () => {
  const r = parseForeignTxfOI(FUT_CONTRACTS_20261007, '2026-10-07');
  const doc = taifexPositionsDoc({ expectYmd: '20261007', foreign: r, putCallRatio: 85.2 }, 1000);
  assert.equal(doc.date, '20261007');
  assert.equal(doc.basisVersion, TAIFEX_POSITIONS_BASIS);
  assert.equal(doc.foreignTxfNetOI, -79101);
  assert.equal(doc.foreignTxfLongOI, 13545);
  assert.equal(doc.foreignTxfShortOI, 92646);
  assert.equal(doc.foreignTxfTradeNet, 408);
  assert.equal(doc.putCallRatio, 85.2);
  assert.equal(doc.updatedAt, 1000);
  assert.ok(isCurrentTaifexBasis(doc));
  const miss = taifexPositionsDoc({ expectYmd: '20261008', foreign: parseForeignTxfOI(FUT_CONTRACTS_20261007, '2026-10-08'), putCallRatio: 90 }, 2000);
  assert.equal(miss.date, '20261008');
  for (const k of ['foreignTxfNetOI', 'foreignTxfLongOI', 'foreignTxfShortOI', 'foreignTxfTradeNet']) assert.equal(miss[k], null, k);
  assert.match(miss.foreignTxfStatus, /notYet/);
  assert.equal(isCurrentTaifexBasis({ foreignTxfNetOI: -21459 }), false, '沒有 basisVersion＝舊口徑（交易淨額合計）');
});

test('同日重跑（15:10 ok → 16:30 期交所逾時、只拿到 P/C）：保留同一資料日已取得的未平倉，不被 null 蓋掉；別天／舊口徑／未取得的不保留', () => {
  const ok = taifexPositionsDoc({ expectYmd: '20261007', foreign: parseForeignTxfOI(FUT_CONTRACTS_20261007, '2026-10-07'), putCallRatio: 85.2 }, 1000);
  const failed = taifexPositionsDoc({ expectYmd: '20261007', foreign: { status: 'failed', dataDate: null, reason: 'TimeoutError' }, putCallRatio: 86.1 }, 2000);
  const m = mergeTaifexPositionsDoc(ok, failed);
  for (const k of ['foreignTxfNetOI', 'foreignTxfLongOI', 'foreignTxfShortOI', 'foreignTxfTradeNet']) assert.equal(m[k], ok[k], k);
  assert.equal(m.foreignTxfStatus, 'ok');
  assert.equal(m.putCallRatio, 86.1, 'P/C 用新取得的');
  assert.equal(m.updatedAt, 2000); assert.equal(m.date, '20261007'); assert.equal(m.basisVersion, TAIFEX_POSITIONS_BASIS);
  // 外資 ok 但 P/C 這次沒拿到 ⇒ 保留同日 P/C
  const okNoPc = taifexPositionsDoc({ expectYmd: '20261007', foreign: parseForeignTxfOI(FUT_CONTRACTS_20261007, '2026-10-07'), putCallRatio: null }, 3000);
  assert.equal(mergeTaifexPositionsDoc(ok, okNoPc).putCallRatio, 85.2);
  // 別天：不保留（不沿用別天的值）
  const nextDay = taifexPositionsDoc({ expectYmd: '20261008', foreign: { status: 'failed', dataDate: null, reason: 'x' }, putCallRatio: 90 }, 4000);
  const m2 = mergeTaifexPositionsDoc(ok, nextDay);
  assert.equal(m2.foreignTxfNetOI, null); assert.equal(m2.date, '20261008');
  // 現有文件是舊口徑（沒有 basisVersion）或同日也沒取得：不保留
  assert.equal(mergeTaifexPositionsDoc({ date: '20261007', foreignTxfNetOI: -21459, foreignTxfStatus: 'ok' }, failed).foreignTxfNetOI, null);
  assert.equal(mergeTaifexPositionsDoc(failed, failed).foreignTxfNetOI, null);
  assert.equal(mergeTaifexPositionsDoc(null, failed).foreignTxfNetOI, null);
  // 新的是 ok：一律用新的
  assert.deepEqual(mergeTaifexPositionsDoc(failed, ok), ok);
});
