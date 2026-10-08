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

// ── 官方鏡像開跑閘門（2026-10-08·WP7）：實際 daemon 日誌行 ──
import { mirrorOutageGate, outageFamiliesOf, OUTAGE_RE } from './outage-scan.mjs';

const MIRROR_NOW = Date.parse('2026-10-07T14:40:00Z');   // 10-07 22:40 台北（鏡像 daily 被擋的那一輪）
const REAL_TPEX_LINES = [
  '2026-10-07T14:19:19.239Z   ⚠ 上櫃 openapi 鏡像重試 1 次仍失敗：The operation was aborted due to timeout',
  '2026-10-07T14:19:19.239Z   ⚠ 上櫃清單抓取失敗（鏡像回空）→ 改用帶日期端點後備',
  '2026-10-07T14:19:31.243Z   ⚠ 上櫃帶日期收盤（TPEx dailyQuotes 20261007）抓取失敗（回空）：The operation was aborted due to timeout',
  '2026-10-07T14:19:31.243Z   ⚠ 上櫃後備亦失敗 → 沿用上一份快取 901 檔（stale-if-error）',
  '2026-10-07T14:30:16.536Z   ⚠ 上櫃 openapi 鏡像重試 1 次仍失敗：terminated',
  '2026-10-07T14:30:17.000Z   ✓ 上櫃後備成功 901 檔',
];

test('鏡像閘門：上櫃大檔傳輸中斷／靠快取撐著＝降級（照跑），不是封鎖', () => {
  const g = mirrorOutageGate(REAL_TPEX_LINES.join('\n'), MIRROR_NOW);
  assert.deepEqual(Object.keys(g.blocked), [], '舊版這裡會整輪不跑（三個機構一起停）');
  assert.deepEqual(Object.keys(g.degraded), ['tpex']);
  assert.equal(g.degraded.tpex.length, 3, '只算 OUTAGE_RE 的行（鏡像重試 ×2、沿用快取 ×1）');
  // can-restart 的判定不變：同一批行仍擋重啟（記憶體快取蒸發的風險沒有變）
  assert.equal(recentOutageLines(REAL_TPEX_LINES.join('\n'), MIRROR_NOW, 30 * 60000).length, 3);
});

test('鏡像閘門：封鎖／限流訊號才擋，且只擋該家族；30 分鐘後自動恢復', () => {
  const tpex403 = '2026-10-07T14:35:00.000Z   ⚠ 上櫃 openapi 鏡像重試 1 次仍失敗：HTTP 403';
  const twse307 = '2026-10-07T14:36:00.000Z   ⚠ BWIBBU 改用 openapi 降級（rwd: HTTP 307），資料日 2026-10-06';
  const g = mirrorOutageGate([...REAL_TPEX_LINES, tpex403, twse307].join('\n'), MIRROR_NOW);
  assert.deepEqual(Object.keys(g.blocked).sort(), ['tpex', 'twse']);
  assert.ok(!g.degraded.tpex.includes(tpex403), '封鎖行不重複算進降級');
  assert.ok(!OUTAGE_RE.test(twse307), '證交所 307 封鎖行不含 OUTAGE_RE 字樣——舊閘門根本看不到它');
  // 31 分鐘後：窗外 ⇒ 自動恢復
  const later = mirrorOutageGate([tpex403, twse307].join('\n'), Date.parse('2026-10-07T15:07:00Z'));
  assert.deepEqual(later.blocked, {});
});

test('鏡像閘門：認不出機構的封鎖行 ⇒ 全部家族（*）；一般行裡的「封鎖」字樣不算', () => {
  const g = mirrorOutageGate([
    '2026-10-07T14:38:00.000Z   ⚠ 某來源：HTTP 429 Too Many Requests',
    '2026-10-07T14:38:30.000Z ✓ 新聞：美方宣布封鎖某港口',
  ].join('\n'), MIRROR_NOW);
  assert.deepEqual(Object.keys(g.blocked), ['*']);
  assert.equal(g.blocked['*'].length, 1);
});

test('outageFamiliesOf：依字樣歸家族', () => {
  assert.deepEqual(outageFamiliesOf('⚠ 上櫃後備亦失敗 → 沿用上一份快取 901 檔（stale-if-error）'), ['tpex']);
  assert.deepEqual(outageFamiliesOf('⚠ 本輪宇宙殘缺（tse=false otc=true）→ 不覆蓋快取'), ['twse']);
  assert.deepEqual(outageFamiliesOf('⚠ 上市 STOCK_DAY_ALL（www）重試 3 次仍失敗'), ['twse']);
  assert.deepEqual(outageFamiliesOf('⚠ 不明來源失敗'), ['*']);
});

// ── 2026-10-08 上櫃收盤改走共用取得層：新日誌字樣的歸類 ──
//   單純傳輸失敗（停滯／斷線／退避）不再擋重啟——種子改由本機快取供應，重啟不會蒸發；
//   真的靠記憶體快取／本地備份撐著時，原本的字樣照舊（照擋）；封鎖訊號仍讓鏡像停櫃買家族。
test('上櫃收盤新字樣：傳輸失敗＝不擋重啟；沿用記憶體快取照擋；HTTP 403＝鏡像停櫃買家族', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const transfer = [
    '2026-10-08T11:58:00.000Z   ⚠ 上櫃收盤檔 20261008 未取得（帶日期端點下載停滯（已收 1,374KB）·退避中（下次 20:02））→ 種子用最近一份已驗證檔 2026-10-07',
    '2026-10-08T11:58:01.000Z   ⚠ 上櫃帶日期收盤（TPEx dailyQuotes 20260820）未取得（回空）：帶日期端點傳輸中途被切斷（已收 0KB·ECONNRESET）',
    '2026-10-08T11:58:02.000Z   ⚠ strategyPicks：上櫃收盤檔 20261008 未取得（openapi 下載停滯（已收 3,823KB／4,670KB）），本輪僅上市（16:45 補跑）',
  ];
  assert.deepEqual(recentOutageLines(transfer.join('\n'), now), [], '傳輸失敗不擋 can-restart-daemon');
  const stale = '2026-10-08T11:59:00.000Z   ⚠ 上櫃後備亦失敗 → 沿用上一份快取 901 檔（stale-if-error）';
  assert.equal(recentOutageLines([...transfer, stale].join('\n'), now).length, 1, '記憶體快取撐著照擋');
  const blocked = '2026-10-08T11:59:30.000Z   ⚠ 上櫃收盤檔 20261008 未取得（今日櫃買網路已停用：帶日期端點 HTTP 403）→ 種子用最近一份已驗證檔 2026-10-07';
  const g = mirrorOutageGate([...transfer, blocked].join('\n'), now);
  assert.deepEqual(Object.keys(g.blocked), ['tpex']);
});
