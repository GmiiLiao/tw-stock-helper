// 台股 wiki：產業別解析——以 MOPS 公司基本資料的「產業類別」為主，各來源名稱統一成同一套字
//
// MOPS（上市櫃興櫃都有）> 證交所 t187ap03_L 產業代碼（由 MOPS 實際資料學出代碼→名稱）> 站內同業表（月營收產業別）
// 代碼→名稱不寫死：用同時有兩邊資料的上市公司學出對照，學不到才用內建後備表（2026-10 版證交所代碼）。

const FALLBACK_CODE_NAME = {
  '01': '水泥工業', '02': '食品工業', '03': '塑膠工業', '04': '紡織纖維', '05': '電機機械', '06': '電器電纜',
  '08': '玻璃陶瓷', '09': '造紙工業', '10': '鋼鐵工業', '11': '橡膠工業', '12': '汽車工業', '14': '建材營造',
  '15': '航運業', '16': '觀光餐旅', '17': '金融保險業', '18': '貿易百貨', '20': '其他', '21': '化學工業',
  '22': '生技醫療業', '23': '油電燃氣業', '24': '半導體業', '25': '電腦及週邊設備業', '26': '光電業',
  '27': '通信網路業', '28': '電子零組件業', '29': '電子通路業', '30': '資訊服務業', '31': '其他電子業',
  '35': '綠能環保', '36': '數位雲端', '37': '運動休閒', '38': '居家生活', '91': '存託憑證',
};

/** 名稱正規化：去空白；「其他業」→「其他」（MOPS 與月營收表對同一類用字不同） */
export const normIndustry = (s) => String(s || '').replace(/\s+/g, '').replace(/^其他業$/, '其他').trim() || null;

/** 由（t187ap03 代碼, MOPS 名稱）配對學出代碼→名稱，取多數決 */
export function learnCodeNames(pairs) {
  const votes = {};
  for (const [code, name] of pairs) {
    const n = normIndustry(name); if (!code || !n) continue;
    ((votes[code] ||= {})[n] = (votes[code][n] || 0) + 1);
  }
  const out = { ...FALLBACK_CODE_NAME };
  for (const [code, v] of Object.entries(votes)) out[code] = Object.entries(v).sort((a, b) => b[1] - a[1])[0][0];
  return out;
}

/** 單檔產業別：回 { name, src } 或 null */
export function resolveIndustry({ mopsName, twseCode, peerName }, codeNames) {
  const m = normIndustry(mopsName);
  if (m) return { name: m, src: 'mops-t05st03' };
  if (twseCode && codeNames[twseCode]) return { name: codeNames[twseCode], src: 'twse-t187ap03' };
  const p = normIndustry(peerName);
  if (p) return { name: p, src: 'peerComps' };
  return null;
}
