// 台股 wiki：頁面路徑與連結（全 vault 唯一的命名規則來源——改這裡，所有頁面與連結一起變）
import { safeFileName, wikiLink } from './util.mjs';

export const FOLDERS = {
  stock: '個股', etf: 'ETF', industry: '產業', chain: '產業鏈', group: '集團', holder: '法人股東',
  region: '地區', index: '指數', issuer: '投信', day: '重大訊息', family: '產品族',
};

export function makeLinks(model) {
  const stockTitle = (code) => { const s = model.stocks.get(code); return s ? `${code} ${s.name}` : code; };
  const etfTitle = (code) => { const e = model.etfs.get(code); return e ? `${code} ${e.name}` : code; };
  const holderHasPage = (name) => (model.holders.get(name)?.codes.size || 0) >= 2 && !model.holders.get(name)?.listedCode;
  return {
    stockTitle, etfTitle, holderHasPage,
    path: {
      stock: (code) => `${FOLDERS.stock}/${safeFileName(stockTitle(code))}.md`,
      etf: (code) => `${FOLDERS.etf}/${safeFileName(etfTitle(code))}.md`,
      named: (kind, name) => `${FOLDERS[kind] || kind}/${safeFileName(name)}.md`,
    },
    stock: (code, label) => (model.stocks.has(code) ? wikiLink(FOLDERS.stock, stockTitle(code), label ?? stockTitle(code)) : model.etfs.has(code) ? wikiLink(FOLDERS.etf, etfTitle(code), label ?? etfTitle(code)) : code),
    etf: (code, label) => (model.etfs.has(code) ? wikiLink(FOLDERS.etf, etfTitle(code), label ?? etfTitle(code)) : code),
    industry: (n) => wikiLink(FOLDERS.industry, n, n),
    chain: (n) => wikiLink(FOLDERS.chain, n, n),
    group: (n) => wikiLink(FOLDERS.group, n, n),
    holder: (n) => (holderHasPage(n) ? wikiLink(FOLDERS.holder, n, n) : n),
    region: (n) => wikiLink(FOLDERS.region, n, n),
    index: (n) => wikiLink(FOLDERS.index, n, n),
    issuer: (n) => wikiLink(FOLDERS.issuer, n, n),
    day: (d) => wikiLink(FOLDERS.day, d, d),
    entity: (folder, n, label) => wikiLink(folder, n, label ?? n),
    family: (n) => (model.families?.has(n) ? wikiLink(FOLDERS.family, n, n) : n),
  };
}
