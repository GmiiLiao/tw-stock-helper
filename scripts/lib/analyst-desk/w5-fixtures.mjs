// W5（存檔／發佈／排程／對答案）測試共用夾具：最小可用的 issue／pack。純資料、無 IO。非 .test.mjs，不被當成測試收集。
import { buildUseRules, DISCLAIMER_SHORT } from './constants.mjs';

export const DAY = '2026-10-02';
export const NEXT = '2026-10-05';
export const TRADING_DAYS = ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-09', '2026-10-12'];

const ref = (v, extra = {}) => ({ v, unit: '%', fmt: 'sg2', asOf: DAY, tier: '官方衍生', source: '熱力定版', ...extra });

export function makePack(day = DAY, edition = 'evening') {
  return {
    schema: 1, kind: 'analystPack', dataDate: day, edition,
    dates: { prev: '2026-10-01', data: day, next: NEXT },
    refs: {
      'm.ew': ref(0.57), 'm.n': ref(1950, { unit: '檔', fmt: 'int' }),
      'st.2330.ret': ref(1.2), 'st.2330.close': ref(1000, { unit: '元', fmt: 'pts1' }),
      'st.2317.ret': ref(-0.4), 'st.2317.close': ref(200, { unit: '元', fmt: 'pts1' }),
      'nv.2330.label': { v: '利多', unit: '文字', fmt: 'txt', asOf: day, tier: '媒體', source: '新聞判別' },
      'wk.2317.chain': { v: 'AI 伺服器供應鏈', unit: '文字', fmt: 'txt', asOf: day, tier: 'AI待驗', source: 'wiki' },
    },
    pools: { prev: [], data: [], next: [{ code: '2330', name: '台積電', market: '上市', industry: '半導體業', from: ['board.gainers'] }, { code: '2317', name: '鴻海', market: '上市', industry: '其他電子業', from: ['idx.contributor'] }, { code: '9999', name: '池內未入名單', market: '上櫃', industry: '其他', from: ['board.gainers'] }] },
    excluded: { prev: [], data: [], next: [{ code: '1101', reason: '處置' }] },
    adverse: {}, absent: [], degraded: [],
    calendar: { tradingDays: TRADING_DAYS, nextTradingDay: NEXT, holidaysAhead: [] },
    meta: { refCount: 8, bytes: 1000, inputs: { heatmap: { dataDate: day, echo: day, sha256: 'abc' } } },
  };
}

const claim = (id, raw, text, refs) => ({ id, raw, text, refs, kind: 'fact', tier: '官方衍生', direction: '無', authors: ['momentum'] });

export function makeIssue(day = DAY, edition = 'evening', over = {}) {
  const stock = (code, name, ind) => ({
    code, name, market: '上市', industry: ind, cardId: 'next', kind: 'watch',
    thesis: `${name}資料日收漲（程式渲染文字）`, thesisRaw: `${name}收 {{st.${code}.ret|sg2}}%`,
    evidence: [{ ref: `st.${code}.ret`, role: 'price' }, ...(code === '2330' ? [{ ref: 'nv.2330.label', role: 'news' }] : [{ ref: 'wk.2317.chain', role: 'industry' }])],
    watchConditions: [{ text: '收盤守住前日收盤', raw: `收盤守住 {{st.${code}.close|pts1}}`, refs: [`st.${code}.close`] }],
    risks: [{ text: '風險示例', raw: '風險示例', refs: [] }],
    adverse: [], sponsors: ['momentum'], asOf: { day, closeRef: `st.${code}.close` },
  });
  const mkCard = (id, title, stocks, kind) => ({
    id, title, asOf: { day, label: `前交易日 10/02` },
    sections: [{ id: 'overview', title: '概況', analyst: 'momentum', claims: [claim(`c-${id}`, '上市等權平均 {{m.ew|sg2}}%', '上市等權平均 +0.57%', ['m.ew'])] }],
    focus: { kind, poolRule: 'pool-v1', poolSize: 3, excludedCount: 1, stocks, note: stocks.length ? '' : '不足 5 檔，少列' },
  });
  const refTable = {};
  const pack = makePack(day, edition);
  for (const id of Object.keys(pack.refs)) refTable[id] = pack.refs[id];
  return {
    schema: 1, kind: 'dailyAnalyst', dataDate: day, edition, dates: { ...pack.dates },
    useRules: buildUseRules(),
    summary: {
      headline: '上市等權平均小幅上漲', headlineRaw: '上市等權平均 {{m.ew|sg2}}%',
      points: [claim('s1', '台積電收 {{st.2330.ret|sg2}}%', '台積電收 +1.20%', ['st.2330.ret'])],
      nextFocus: [], risks: [], byline: { editor: '總編輯', contributors: ['momentum'] },
    },
    cards: [mkCard('prev', '昨日股市（前交易日 10/01）', [], 'recap'), mkCard('data', '今日盤後（前交易日 10/02）', [], 'recap'), mkCard('next', '明日預期（下一交易日 10/05）', [stock('2330', '台積電', '半導體業'), stock('2317', '鴻海', '其他電子業')], 'watch')],
    linkages: [{ id: 'l1', from: { ref: 'm.ew' }, to: { ref: 'm.n' }, mechanism: '資金流向', tier: '站內整理', raw: '示例', text: '示例連動', refs: ['m.ew', 'm.n'], authors: ['global'] }],
    refTable,
    meta: {
      engineTier: 'claude', analysts: [{ id: 'momentum', engine: 'claude-cli', model: 'opus', rounds: 2 }], editor: { engine: 'claude-cli', model: 'opus' },
      check: { pass: true, rules: { R01: 'pass' }, blockers: 0, redactions: [{ rule: 'R14', claimId: 'c9', msg: '示例' }], warnings: [], repairRounds: 1 },
      degraded: [], fallback: null, pack: { sha256: 'packsha', refCount: 8, absent: [] },
    },
    ...over,
  };
}

/** 模板殼（引擎全降級）。 */
export function makeTemplateShell(day = DAY, edition = 'evening') {
  const i = makeIssue(day, edition);
  i.cards = []; i.meta = { ...i.meta, engineTier: 'template', fallback: 'template' };
  return i;
}
export { DISCLAIMER_SHORT };
