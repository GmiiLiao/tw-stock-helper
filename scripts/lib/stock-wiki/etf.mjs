// 台股 wiki：ETF 基本資料整理（上市：證交所 t187ap47_L 官方；上櫃：櫃買來源暫不可達時只有快照名稱）
import { rocToIso } from './util.mjs';

// 發行投信（由基金中文名稱開頭推導；期信基金「期元大」歸元大期貨）。順序：長的在前，避免「大華」吃掉「大華銀」
const ISSUERS = [
  ['富蘭克林華美', '富蘭克林華美投信'], ['華南永昌', '華南永昌投信'], ['中國信託', '中國信託投信'], ['第一金', '第一金投信'],
  ['大華銀', '大華銀投信'], ['未來資產', '未來資產投信'], ['路博邁', '路博邁投信'], ['施羅德', '施羅德投信'],
  ['保德信', '保德信投信'], ['貝萊德', '貝萊德投信'], ['期元大', '元大期貨'], ['期街口', '街口投信'],
  ['元大', '元大投信'], ['國泰', '國泰投信'], ['富邦', '富邦投信'], ['群益', '群益投信'], ['復華', '復華投信'],
  ['中信', '中國信託投信'], ['永豐', '永豐投信'], ['凱基', '凱基投信'], ['兆豐', '兆豐投信'], ['統一', '統一投信'],
  ['新光', '新光投信'], ['野村', '野村投信'], ['台新', '台新投信'], ['街口', '街口投信'], ['合庫', '合庫投信'],
  ['柏瑞', '柏瑞投信'], ['安聯', '安聯投信'], ['摩根', '摩根投信'], ['聯博', '聯博投信'], ['國票', '國票投信'],
  ['宏利', '宏利投信'], ['瀚亞', '瀚亞投信'], ['富達', '富達投信'], ['百達', '百達投信'], ['台中銀', '台中銀投信'],
  ['日盛', '日盛投信'], ['匯豐', '匯豐投信'], ['景順', '景順投信'], ['鋒裕匯理', '鋒裕匯理投信'], ['PGIM', '保德信投信'],
];
export function issuerOf(fullName, shortName) {
  for (const s of [fullName, shortName]) {
    const t = String(s || '').trim();
    for (const [prefix, issuer] of ISSUERS) if (t.startsWith(prefix)) return issuer;
  }
  return null;
}

/** 基金類型 → 投資地域與策略標籤 */
export function etfTags(type, hasForeign) {
  const t = String(type || '');
  const tags = [];
  if (/槓桿|反向/.test(t)) tags.push('槓桿反向');
  if (/期貨/.test(t)) tags.push('期貨型');
  if (/主動/.test(t)) tags.push('主動式');
  if (/債/.test(t)) tags.push('債券');
  if (/平衡/.test(t)) tags.push('平衡型');
  const foreign = /國外|境外|外幣/.test(t) || /^是/.test(String(hasForeign || ''));
  tags.push(foreign ? '國外成分' : '國內成分');
  return tags;
}

/** t187ap47_L 一列 → 正規化 ETF 物件 */
export function normalizeEtfRow(r) {
  const fullName = String(r['基金中文名稱'] || '').trim();
  const shortName = String(r['基金簡稱'] || '').trim();
  const type = String(r['基金類型'] || '').trim();
  const index = String(r['標的指數/追蹤指數名稱'] || '').trim();
  return {
    code: String(r['基金代號'] || '').trim(),
    name: shortName, fullName,
    englishName: String(r['基金英文名稱'] || '').trim(),
    type, tags: etfTags(type, r['是否包含國外成分股']),
    index: index && !/^(不適用|無|－|-)$/.test(index) ? index : null,
    customIndex: String(r['標的指數是否為客製化或需揭露相關資訊之指數'] || '').trim() || null,
    hasForeign: String(r['是否包含國外成分股'] || '').trim() || null,
    establishDate: rocToIso(r['成立日期']), listDate: rocToIso(r['上市日期']),
    manager: String(r['基金經理人'] || '').trim() || null,
    custodian: String(r['保管機構'] || '').trim() || null,
    units: Number(String(r['發行單位數/轉換數'] || '').replace(/,/g, '')) || null,
    issuer: issuerOf(fullName, shortName),
    asOf: rocToIso(r['出表日期']),
    src: 'twse-t187ap47',
  };
}
