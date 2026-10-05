// 測試夾具（非測試檔）：一份「好 pack」＋「好 issue」，壞案例由測試複製後變異。
// 完全虛構的資料，僅供 check／slots 單測。
import { createHash } from 'node:crypto';
import * as K from './constants.mjs';
import { collectUnits, collectRefUses } from './issue-units.mjs';
import { renderClaim, refsOfRaw, claimTier } from './slots.mjs';

export const TODAY = '2026-10-02';
export const DATES = { prev: '2026-10-01', data: '2026-10-02', next: '2026-10-05' };

export const UNIVERSE = [
  ['2330', '台積電', '上市', '半導體業'],
  ['2317', '鴻海', '上市', '其他電子業'],
  ['2454', '聯發科', '上市', '半導體業'],
  ['2412', '中華電', '上市', '通信網路業'],
  ['1301', '台塑', '上市', '塑膠工業'],
  ['3564', '其陽', '上櫃', '通信網路業'],
  ['2603', '長榮', '上市', '航運業'],
  ['6488', '環球晶', '上櫃', '半導體業'],
];
const IDX = { prev: [0, 1, 2, 3, 4], data: [3, 4, 5, 6, 7], next: [0, 1, 5, 6, 7] };
const POOL_IDX = { prev: [0, 1, 2, 3, 4, 5], data: [2, 3, 4, 5, 6, 7], next: [0, 1, 2, 3, 4, 5, 6, 7] };
const SPONSORS = [['momentum'], ['industry'], ['global'], ['momentum'], ['industry']];

const R = (v, unit, fmt, asOf, tier, source, label) => ({ v, unit, fmt, asOf, tier, source, ...(label ? { label } : {}) });

export function makePack() {
  const D = DATES.data, P = DATES.prev;
  const refs = {
    'm.ew': R(0.57, '%', 'sg2', D, '官方衍生', 'daily-heatmap', '上市等權平均'),
    'm.capW': R(0.42, '%', 'sg2', D, '官方衍生', 'daily-heatmap'),
    'm.n': R(1950, '檔', 'int', D, '官方衍生', 'daily-heatmap'),
    'm.val': R(4123.5, '億', 'bn1', D, '官方', 'twse'),
    'm.upRatio': R(0.614, '比率', 'pct0', D, '官方衍生', 'daily-heatmap'),
    'br.gapPp': R(-0.25, 'pp', 'sg2', D, '官方衍生', 'daily-heatmap'),
    'ix.pts': R(123.45, '點', 'pts1', D, '官方', 'twse'),
    'pv.m.ew': R(0.12, '%', 'sg2', P, '官方衍生', 'daily-heatmap'),
    'df.m.ew': R(0.45, 'pp', 'sg2', D, '官方衍生', 'daily-heatmap'),
    'pv.ind.半導體業.ew': R(0.8, '%', 'sg2', P, '官方衍生', 'daily-heatmap'),
    'ind.半導體業.ew': R(1.25, '%', 'sg2', D, '官方衍生', 'daily-heatmap'),
    'gl.^SOX.chgPct': R(2.4, '%', 'sg2', D, '媒體', 'yahoo'),
    'cal.exdiv.2330.date': R('2026-10-09', '文字', 'date', D, '官方', 'twse'),
    'wk.2330.chain': R('AI伺服器鏈', '文字', 'txt', D, '站內整理', 'wiki'),
  };
  for (const [code] of UNIVERSE) {
    refs[`st.${code}.ret`] = R(1.5, '%', 'sg2', D, '官方', 'twse');
    refs[`st.${code}.valM`] = R(8.5, '億', 'bn1', D, '官方', 'twse');
    refs[`st.${code}.close`] = R(100, '元', 'int', D, '官方', 'twse');
    refs[`st.${code}.flags`] = R('無', '文字', 'txt', D, '官方', 'twse');
    refs[`pv.st.${code}.ret`] = R(0.8, '%', 'sg2', P, '官方', 'twse');
    refs[`pv.st.${code}.valM`] = R(7.5, '億', 'bn1', P, '官方', 'twse');
    refs[`pv.st.${code}.close`] = R(99, '元', 'int', P, '官方', 'twse');
    refs[`nv.${code}.label`] = R(code === '3564' ? '利空' : '利多', '文字', 'txt', D, '媒體', 'newsVerdict');
    refs[`nv.${code}.certainty`] = R('已確認', '文字', 'txt', D, '媒體', 'newsVerdict');
    refs[`nv.${code}.eventType`] = R('營運', '文字', 'txt', D, '媒體', 'newsVerdict');
  }
  refs['mo.2454.C23.dir'] = R('利多', '文字', 'txt', D, '官方', 'mops');
  refs['mo.2454.C23.subject'] = R('公告主旨', '文字', 'txt', D, '官方', 'mops');
  const sorted = Object.fromEntries(Object.keys(refs).sort().map(k => [k, refs[k]]));

  const pools = {}, excluded = {};
  for (const id of K.CARD_IDS) {
    pools[id] = POOL_IDX[id].map(i => ({ code: UNIVERSE[i][0], name: UNIVERSE[i][1], market: UNIVERSE[i][2], industry: UNIVERSE[i][3], from: ['board.gainers'] }));
    excluded[id] = id === 'prev' ? [{ code: '9999', reason: '處置' }] : [];
  }
  return {
    schema: 1, kind: 'analystPack', dataDate: D, dates: { ...DATES }, edition: 'evening',
    refs: sorted, pools, excluded,
    adverse: { 3564: ['nv.3564.label'] },
    absent: ['taifexPositions'], degraded: [],
    calendar: { tradingDays: [P, D, DATES.next], nextTradingDay: DATES.next, holidaysAhead: ['2026-10-09', '2026-10-10'] },
    meta: { refCount: Object.keys(sorted).length, bytes: 0, inputs: {} },
  };
}

function stockFor(code, cardId) {
  const i = UNIVERSE.findIndex(u => u[0] === code);
  const [, name, market, industry] = UNIVERSE[i];
  const pv = cardId === 'prev' ? 'pv.' : '';
  const watch = cardId === 'next';
  const sp = SPONSORS[IDX[cardId].indexOf(i)] ?? ['momentum'];
  const s = {
    code, name, market, industry, cardId, kind: K.FOCUS_KIND_BY_CARD[cardId],
    thesis: `收盤事實：當日漲跌 {{${pv}st.${code}.ret|sg2}}%，列入資料觀察名單。`,
    evidence: [{ ref: `${pv}st.${code}.ret`, role: 'price' }, { ref: `${pv}st.${code}.valM`, role: 'volume' }],
    watchConditions: watch ? [{ text: `開盤後觀察成交值是否維持 {{st.${code}.valM|bn1}} 億水準。`, refs: [`st.${code}.valM`] }] : [],
    risks: [{ text: code === '3564' ? '媒體判別為 {{nv.3564.label|txt}}，須留意與價格走勢的落差，另有追價風險。' : '成交值集中且當日漲幅可能快速回吐，須留意追價風險。', refs: code === '3564' ? ['nv.3564.label'] : [] }],
    adverse: code === '3564' ? ['nv.3564.label'] : [],
    sponsors: sp,
    asOf: { day: cardId === 'prev' ? DATES.prev : DATES.data, closeRef: `${pv}st.${code}.close` },
  };
  return s;
}

/** 依規格完成一則 claim（text、refs、tier 由程式算；與 W3 assembleIssue 的 finishClaim 同法）。 */
export function buildGoodIssue(pack) {
  let n = 0;
  const C = (raw, o = {}) => {
    const kind = o.kind ?? 'fact';
    const refs = refsOfRaw(raw);
    return { id: `c${++n}`, raw, text: renderClaim({ raw, kind }, pack).text, refs, kind, tier: claimTier(refs, pack, kind), direction: o.direction ?? '無', authors: o.authors ?? ['momentum'], ...(o.cond ? { cond: o.cond } : {}) };
  };
  const SOXCOND = { if: { ref: 'gl.^SOX.chgPct', op: '<=', value: -1 }, watch: '半導體權值股開盤表現' };
  const cards = [
    {
      id: 'prev', title: K.cardTitle('prev', DATES.prev, TODAY), asOf: { day: DATES.prev, label: K.dayLabelOf('prev', DATES.prev, TODAY) },
      sections: [
        { id: 'overview', title: '盤勢總覽', analyst: 'momentum', claims: [C('上市等權平均 {{pv.m.ew|sg2}}%，屬前一交易日的盤面事實。', { direction: '持平' })] },
        { id: 'industry', title: '產業與族群', analyst: 'industry', claims: [C('官方產業別中，半導體業等權 {{pv.ind.半導體業.ew|sg2}}%。', { authors: ['industry'] })] },
      ],
      focus: { kind: 'recap', poolRule: K.POOL_RULE, poolSize: pack.pools.prev.length, excludedCount: pack.excluded.prev.length, stocks: IDX.prev.map(i => stockFor(UNIVERSE[i][0], 'prev')) },
    },
    {
      id: 'data', title: K.cardTitle('data', DATES.data, TODAY), asOf: { day: DATES.data, label: K.dayLabelOf('data', DATES.data, TODAY) },
      sections: [
        { id: 'overview', title: '盤勢總覽', analyst: 'momentum', claims: [C('上市等權平均 {{m.ew|sg2}}%，指數與等權相差 {{br.gapPp|sg2}}pp。', { direction: '偏強' })] },
        { id: 'diff', title: '與前一交易日的差異', analyst: 'momentum', claims: [C('與前一交易日相比，等權平均變動 {{df.m.ew|sg2}}pp。', { kind: 'comparison', direction: '偏強' })] },
        { id: 'momentum', title: '交易動能', analyst: 'momentum', claims: [C('兩市成交值 {{m.val|bn1}} 億元，上漲比 {{m.upRatio|pct0}}。')] },
        { id: 'news', title: '消息面', analyst: 'industry', claims: [C('其陽（3564）的媒體判別為 {{nv.3564.label|txt}}。', { direction: '利空', authors: ['industry'] })] },
        { id: 'global', title: '全球與總經', analyst: 'global', claims: [C('費半單日 {{gl.^SOX.chgPct|sg2}}%。', { direction: '偏強', authors: ['global'] })] },
      ],
      focus: { kind: 'recap', poolRule: K.POOL_RULE, poolSize: pack.pools.data.length, excludedCount: pack.excluded.data.length, stocks: IDX.data.map(i => stockFor(UNIVERSE[i][0], 'data')) },
    },
    {
      id: 'next', title: K.cardTitle('next', DATES.next, TODAY), asOf: { day: DATES.next, label: K.dayLabelOf('next', DATES.next, TODAY) },
      sections: [
        { id: 'outlook', title: '觀察重點', analyst: 'global', claims: [C('若費半單日 {{gl.^SOX.chgPct|sg2}}% 的變動延續，開盤後觀察半導體權值股量能。', { kind: 'conditional', cond: SOXCOND, authors: ['global'] })] },
        { id: 'linkage', title: '連動分析', analyst: 'global', claims: [C('費半 {{gl.^SOX.chgPct|sg2}}% 與半導體業等權 {{ind.半導體業.ew|sg2}}% 同向變動，屬可能影響。', { kind: 'linkage', authors: ['global', 'industry'] })] },
      ],
      focus: { kind: 'watch', poolRule: K.POOL_RULE, poolSize: pack.pools.next.length, excludedCount: pack.excluded.next.length, stocks: IDX.next.map(i => stockFor(UNIVERSE[i][0], 'next')) },
    },
  ];
  const linkRaw = '費半 {{gl.^SOX.chgPct|sg2}}% 與半導體業等權 {{ind.半導體業.ew|sg2}}% 同向變動，相關程度以歷史數據為準。';
  const linkRefs = ['gl.^SOX.chgPct', 'ind.半導體業.ew'];
  const issue = {
    schema: 1, kind: 'dailyAnalyst', dataDate: DATES.data, edition: 'evening', dates: { ...DATES },
    useRules: K.buildUseRules(),
    summary: {
      headline: '盤後事實整理：等權平均 {{m.ew|sg2}}%。',
      points: [
        C('上市等權平均 {{m.ew|sg2}}%，指數與等權相差 {{br.gapPp|sg2}}pp。', { direction: '偏強', authors: ['editor'] }),
        C('與前一交易日相比，等權平均變動 {{df.m.ew|sg2}}pp。', { kind: 'comparison', direction: '偏強', authors: ['editor'] }),
        C('兩市成交值 {{m.val|bn1}} 億元。', { authors: ['editor'] }),
      ],
      nextFocus: [C('若費半單日 {{gl.^SOX.chgPct|sg2}}% 的變動延續，觀察半導體權值股量能。', { kind: 'conditional', cond: SOXCOND, authors: ['editor'] })],
      risks: [C('資料觀察名單僅整理事實，來源未提供的欄位不推測。', { kind: 'caveat', authors: ['editor'] })],
      byline: { editor: '總編輯', contributors: ['momentum', 'industry', 'global'] },
    },
    cards,
    linkages: [{ id: 'l1', from: { ref: 'gl.^SOX.chgPct' }, to: { ref: 'ind.半導體業.ew' }, mechanism: '同業連動', tier: claimTier(linkRefs, pack, 'linkage'), text: linkRaw, refs: linkRefs, authors: ['global', 'industry'] }],
    refTable: {},
    meta: {
      engineTier: 'claude',
      analysts: ['momentum', 'industry', 'global'].map(id => ({ id, engine: 'claude-cli', model: 'test-model', rounds: 2 })),
      editor: { engine: 'claude-cli', model: 'test-model' },
      check: { pass: true, rules: {}, blockers: 0, redactions: [], warnings: [], repairRounds: 0 },
      degraded: [...pack.degraded], fallback: null,
      pack: { sha256: sha256(JSON.stringify(pack)), refCount: Object.keys(pack.refs).length, absent: [...pack.absent] },
    },
  };
  for (const u of collectRefUses(issue, collectUnits(issue))) if (pack.refs[u.id]) issue.refTable[u.id] = clone(pack.refs[u.id]);
  issue.refTable = Object.fromEntries(Object.keys(issue.refTable).sort().map(k => [k, issue.refTable[k]]));
  return issue;
}

export const sha256 = s => createHash('sha256').update(s).digest('hex');
export const clone = x => JSON.parse(JSON.stringify(x));
