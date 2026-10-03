// 台股 wiki 共用小工具：名稱正規化、檔名安全化、民國日期、數字格式、個人筆記保留。純函式，可單元測試。

/** 公司名稱正規化（比對用）：去公司型態後綴、空白、全半形括號，台→臺 */
export function normCompanyName(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .replace(/[（(]股[)）]/g, '')
    .replace(/股份有限公司$|有限公司$|公司$/g, '')
    .replace(/台/g, '臺')
    .replace(/[（）()]/g, '')
    .trim();
}

/** Obsidian 檔名／連結不可用 * " \ / < > : | ? # ^ [ ]，換成全形或移除 */
export function safeFileName(s) {
  return String(s || '')
    .replace(/\*/g, '＊').replace(/\//g, '／').replace(/\\/g, '＼').replace(/:/g, '：')
    .replace(/\|/g, '｜').replace(/\?/g, '？').replace(/"/g, '”').replace(/</g, '＜').replace(/>/g, '＞')
    .replace(/#/g, '＃').replace(/\^/g, '＾').replace(/\[/g, '［').replace(/\]/g, '］')
    .replace(/\s+/g, ' ').trim();
}

/** wiki 連結：[[資料夾/檔名|顯示]] */
export function wikiLink(folder, name, label) {
  const target = `${folder}/${safeFileName(name)}`;
  return `[[${target}|${String(label ?? name).replace(/[|\]]/g, ' ')}]]`;
}

/** 民國日期 → ISO：'100/10/18'、'1000625'、'19550207'（西元）都吃；不認得回 null */
export function rocToIso(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return `${+m[1] + 1911}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = t.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m && +m[1] > 1900) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{2,3})(\d{2})(\d{2})$/);
  if (m) return `${+m[1] + 1911}-${m[2]}-${m[3]}`;
  return null;
}

/** '478,113,725股（含私募0股）' / '341238364' → 478113725；不認得回 null */
export function parseShares(s) {
  const m = String(s ?? '').replace(/,/g, '').match(/\d+/);
  const n = m ? Number(m[0]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 億元顯示 */
export function fmtYi(n) {
  if (!Number.isFinite(n)) return '—';
  const yi = n / 1e8;
  return yi >= 100 ? `${Math.round(yi).toLocaleString('en-US')} 億` : `${yi.toFixed(1)} 億`;
}
export const fmtNum = (v, d = 2) => (Number.isFinite(v) ? Number(v).toFixed(d).replace(/\.?0+$/, '') : '—');
export const fmtPct = (v, d = 1) => (Number.isFinite(v) ? `${Number(v).toFixed(d)}%` : '—');

/** Markdown 表格儲存格：去換行；wiki 連結內的別名分隔改 `\|`（Obsidian 表格規則），其他直線換全形 */
export const cell = (v) => {
  const parts = String(v ?? '—').replace(/\r?\n/g, ' ').split(/(\[\[[^\]]*\]\])/);
  return parts.map(p => (p.startsWith('[[') ? p.replace(/\|/g, '\\|') : p.replace(/\|/g, '｜'))).join('').trim() || '—';
};

/** 縣市（取地址開頭，台→臺；「新竹科學園區新竹市…」這類先找出現的第一個縣市名） */
const COUNTIES = ['臺北市', '新北市', '桃園市', '臺中市', '臺南市', '高雄市', '基隆市', '新竹市', '嘉義市', '新竹縣', '苗栗縣',
  '彰化縣', '南投縣', '雲林縣', '嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣', '臺東縣', '澎湖縣', '金門縣', '連江縣'];
export function countyOf(address) {
  const a = String(address || '').replace(/台/g, '臺').replace(/^\d{3,6}/, '');
  let best = null; let bestAt = Infinity;
  for (const c of COUNTIES) { const i = a.indexOf(c); if (i >= 0 && i < bestAt) { best = c; bestAt = i; } }
  if (best) return best;
  // 舊制縣名（桃園縣、臺北縣…）
  const old = { '臺北縣': '新北市', '桃園縣': '桃園市', '臺中縣': '臺中市', '臺南縣': '臺南市', '高雄縣': '高雄市' };
  for (const [o, n] of Object.entries(old)) if (a.includes(o)) return n;
  return null;
}

// ── 個人筆記保留 ─────────────────────────────────────────────────────────
export const NOTES_MARKER = '<!-- ✍ 以下為個人筆記：重建 wiki 時保留，請寫在這行下面 -->';

/** 舊檔內容 → 標記後的個人筆記（沒有就回預設空區塊） */
export function extractNotes(oldContent) {
  if (!oldContent) return '';
  const i = oldContent.indexOf(NOTES_MARKER);
  return i >= 0 ? oldContent.slice(i + NOTES_MARKER.length).replace(/^\n+/, '') : '';
}
export function withNotes(generated, notes) {
  return `${generated.trimEnd()}\n\n---\n${NOTES_MARKER}\n${notes || ''}`.trimEnd() + '\n';
}

/** YAML frontmatter（只處理字串、數字、布林、字串陣列） */
export function frontmatter(obj) {
  const q = (v) => (typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(String(v)));
  const lines = ['---'];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    lines.push(Array.isArray(v) ? `${k}: [${v.map(q).join(', ')}]` : `${k}: ${q(v)}`);
  }
  lines.push('---');
  return lines.join('\n');
}
