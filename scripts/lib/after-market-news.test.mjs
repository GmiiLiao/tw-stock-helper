import test from 'node:test';
import assert from 'node:assert/strict';
import { rankMediaVerdicts, classifyOfficial, rankOfficial } from './after-market-news.mjs';

const v = (label, strength, confidence, certainty, novelty, priced) => ({ label, strength, confidence, certainty, novelty, priced, reason: 'r' });

test('媒體：只排利多／利空；中性、資訊不足只計數；高強度×高信心×首次×未反映排最前', () => {
  const r = rankMediaVerdicts({
    A: v('利多', '極強', '高', '已確認', '首次', '否'),
    B: v('利多', '弱', '低', '傳聞', '重複', '是'),
    C: v('利空', '強', '高', '已確認', '首次', '不確定'),
    D: v('中性', '強', '高', '已確認', '首次', '否'),
    E: v('資訊不足', null, null, null, null, null),
  });
  assert.deepEqual(r.items.map(x => x.code), ['A', 'C', 'B']);
  assert.equal(r.neutral, 1); assert.equal(r.insufficient, 1); assert.equal(r.bullish, 2); assert.equal(r.bearish, 1);
  assert.ok(Math.abs(r.items.reduce((s, x) => s + x.share, 0) - 1) < 1e-3);
  assert.equal(r.items[0].order, 1);
});

test('媒體：缺值保守取低、不補高；輸出欄位不含 score／signal', () => {
  const r = rankMediaVerdicts({ A: { label: '利多' }, B: v('利多', '中', '中', '預期', '首次', '否') });
  assert.equal(r.items[0].code, 'B');
  for (const k of Object.keys(r.items[0])) assert.ok(!/score|signal|buy|rank/i.test(k), k);
});

test('官方：規則類型與基礎權重；方向只有規則類才給', () => {
  assert.deepEqual(pick(classifyOfficial('公告本公司董事長遭檢調搜索')), { id: 'C16a', dir: '−', weight: 0.9 });
  assert.deepEqual(pick(classifyOfficial('公告本公司辦理現金增資發行新股')), { id: 'C09', dir: null, weight: 0.35 });
  assert.deepEqual(pick(classifyOfficial('公告本公司取得重大訂單')), { id: 'C01', dir: null, weight: 0.45 });
  assert.equal(classifyOfficial('公告本公司股票面額由「新台幣10元」變更為「新台幣5元」，公告期間：115年7月22日').weight, 0);
  assert.equal(classifyOfficial('今天天氣很好').id, null);
});

const pick = c => ({ id: c.id, dir: c.dir, weight: c.weight });

test('官方：例行（權重 0）與未分類不入排行；依權重排序；占比加總 1', () => {
  const r = rankOfficial([
    { code: '1', name: 'a', subject: '公告本公司取得重大訂單', at: 1 },
    { code: '2', name: 'b', subject: '公告董事長遭檢調搜索', at: 2 },
    { code: '3', name: 'c', subject: '公告本公司更名', at: 3 },
    { code: '4', name: 'd', subject: '其他事項', at: 4 },
  ]);
  assert.deepEqual(r.items.map(x => x.code), ['2', '1']);
  assert.equal(r.routine, 1); assert.equal(r.unclassified, 1); assert.equal(r.total, 4);
  assert.ok(r.items.every(x => x.basis === '主旨'));
  assert.ok(Math.abs(r.items.reduce((s, x) => s + x.share, 0) - 1) < 1e-3);
});

test('官方：同公司同事件類型多則公告合併成一列、權重不隨則數累加；不同事件類型各自一列', () => {
  const r = rankOfficial([
    { code: '6787', name: '晶瑞光', subject: '公告本公司現金增資暫定承銷價格', at: 1 },
    { code: '6787', name: '晶瑞光', subject: '公告本公司現金增資認股繳款期間', at: 3 },
    { code: '6787', name: '晶瑞光', subject: '公告本公司現金增資全體董事放棄認購', at: 2 },
    { code: '6787', name: '晶瑞光', subject: '公告本公司取得重大訂單', at: 4 },
    { code: '2330', name: '台積電', subject: '公告本公司取得重大訂單', at: 5 },
  ]);
  assert.equal(r.items.length, 3);
  const cap = r.items.find(x => x.code === '6787' && x.type === 'C09');
  assert.equal(cap.count, 3); assert.equal(cap.weight, 0.35);
  assert.deepEqual(cap.announcements.map(a => a.at), [3, 2, 1], '展開清單依時間新到舊');
  assert.equal(cap.subject, '公告本公司現金增資認股繳款期間');
  assert.equal(r.rankedAnnouncements, 5); assert.equal(r.ranked, 3);
});

test('官方：updatedAt＝所有公告（含例行與未分類）中最晚的時間', () => {
  const r = rankOfficial([{ code: '1', name: 'a', subject: '公告本公司更名', at: 9 }, { code: '2', name: 'b', subject: '其他', at: 5 }, { code: '3', name: 'c', subject: '公告取得重大訂單', at: 7 }]);
  assert.equal(r.updatedAt, 9);
});
