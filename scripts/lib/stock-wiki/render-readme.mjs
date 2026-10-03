// 台股 wiki：首頁（README.md）——總覽、來源與可信度、索引、限制、擴充方式
import { frontmatter } from './util.mjs';

export function renderReadme(model, L, st, SOURCES, FOLDERS) {
  const pct = (n) => `${n}/${st.stocks}（${Math.round((n / Math.max(st.stocks, 1)) * 100)}%）`;
  const inds = [...model.industries.values()].sort((a, b) => b.members.length - a.members.length);
  const topGroups = model.groups.slice(0, 40);
  const etfIdx = [...model.indexes.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 30);
  return [frontmatter({ type: 'home', updated: st.today, tags: ['首頁'] }), '',
    '# 台股資料 wiki（第二大腦）', '',
    `> 產生日 ${st.today}｜收盤快照 ${st.snapshotDate || '—'}｜由 \`scripts/build-stock-wiki.mjs\` 產生。用 Obsidian 開啟 \`second-brain/wiki\` 資料夾即可瀏覽與看關聯圖。`, '',
    '## 收錄範圍', '',
    `- 個股 ${st.stocks} 檔（上市＋上櫃＋興櫃）、ETF ${st.etfs} 檔`,
    `- 產業 ${st.industries}、產業鏈 ${st.chains}、關係企業群 ${st.groups}、法人股東 ${st.holderPages}、地區 ${st.regions}、指數 ${st.indexes}、投信 ${st.issuers}、重大訊息日 ${st.announceDays}`, '',
    '| 覆蓋率 | 檔數 |', '|---|---|',
    `| 官方公司基本資料（MOPS） | ${pct(st.withMops)} |`, `| 主要經營業務 | ${pct(st.withMainBusiness)} |`,
    `| 產業別 | ${pct(st.withIndustry)} |`, `| 在站內產業鏈內 | ${pct(st.inChain)} |`,
    `| 屬於關係企業群 | ${pct(st.inGroup)} |`, `| 有本地新聞 | ${pct(st.withNews)} |`,
    `| 經營輪廓（產品／原料／客戶／設備／廠房） | ${pct(st.withProfile)} |`,
    `| 依產品跨入其他產業（AI 分類·待驗） | ${pct(st.crossIndustry)} |`, `| 有產品×國家（生產地／銷售地） | ${pct(st.withProductGeo)} |`, '',
    '## 資料夾', '',
    ...Object.entries(FOLDERS).map(([, f]) => `- \`${f}/\``),
    '- `_graph/graph.json`：全圖節點與邊（含來源代號），`_graph/stocks.json`：每檔精簡輪廓（給本地 AI／daemon 讀）', '',
    '## 來源與可信度', '',
    '每個段落標題後面的〔…〕標示該段來源。可信度由高到低：**官方 > 官方衍生 > 站內推導／站內整理 > 近似 > 媒體 > AI 待驗**。', '',
    '| 代號 | 來源 | 等級 |', '|---|---|---|',
    ...Object.entries(SOURCES).map(([k, v]) => `| \`${k}\` | ${v.label} | ${v.tier} |`), '',
    '## 已知限制（不捏造：缺就寫「來源未提供」）', '',
    '- **櫃買中心網域本機 DNS 解析失敗**（2026-10-03 起）：上櫃 ETF 基本資料、上櫃公司董監持股明細暫缺；上櫃公司基本資料改由 MOPS 取得不受影響。DNS 修復後重跑 `crawl` 即補上。',
    '- 集團（關係企業群）＝每家公司連到「最大法人股東」（持股 ≥5% 或 10% 大股東）串成的持股關聯群，含控制關係與策略投資，不等於公司法的關係企業；群名取市值最大者，不是官方集團名冊。公股與創投不串群；自然人（家族成員）之間的關係刻意不推導。上櫃／興櫃公司的董監明細來自櫃買中心，目前暫缺。',
    '- 產業鏈上中下游目前只有站內人工整理的主題鏈（代表股），不是全市場。',
    '- ETF 成分股只有 0050/006208 的市值近似值；其他 ETF 需投信 PCF。',
    '- 產品／原料／客戶／設備／廠房：官方結構化資料沒有，見下節。',
    '- **產品連動**（產品族／跨產業／產品×國家）：產品族與產業歸屬是 AI 分類，同義寫法合併成「標準名」；生產地／銷售地多為 AI 整理，年報有標明「廠區生產哪些產品」時以年報為準。'
      + '2025 年度起的新式年報已無「生產量值表／銷售量值表」，各產品內外銷金額大多沒有官方數字。', '',
    '## 擴充：經營輪廓', '',
    '把 `{code}.json` 放進 `second-brain/wiki/.cache/profiles/` 後重跑 `build`，個股頁「經營輪廓」與 `產品/` `原料/` `客戶/` `供應商/` `設備/` `生產據點/`（依國家）`競爭者/` `銷售市場/` 實體頁會自動生成並互相連結。格式：', '',
    '```json',
    '{ "src": "annual-report-2025", "asOf": "2026-05", "conf": "高", "summary": "一句話定位",',
    '  "products":  [{ "name": "晶圓代工", "share": "營收 90%" }],',
    '  "materials": [{ "name": "矽晶圓" }], "customers": [{ "name": "Apple", "country": "美國" }],',
    '  "suppliers": [], "equipment": [{ "name": "EUV 曝光機" }], "plants": [{ "name": "亞利桑那廠", "location": "美國亞利桑那州", "country": "美國" }],',
    '  "competitors": [{ "name": "Samsung", "country": "韓國" }], "markets": [{ "name": "美國", "share": "65%" }] }',
    '```', '',
    '每個項目可另帶 `src`、`conf`（高／中／低）。AI 從記憶整理的請標 `"src": "ai-knowledge"`，頁面會照實顯示為待驗。', '',
    '## 重建', '', '```bash', 'node scripts/build-stock-wiki.mjs crawl   # 官方慢變數（30 天快取，可中斷續跑）', 'node scripts/build-stock-wiki.mjs build   # 零上游請求重建', '```', '',
    '頁面最下方「✍ 個人筆記」標記以下的內容，重建時會保留。', '',
    '## 索引：產業', '', inds.map(i => `${L.industry(i.name)}（${i.members.length}${i.crossMembers?.length ? `＋跨入 ${i.crossMembers.length}` : ''}）`).join('｜'), '',
    model.families?.size ? `## 索引：產品族（${model.families.size}，AI 分類·待驗）\n\n${[...model.families.values()].sort((a, b) => b.producers.size - a.producers.size).map(f => `${L.family(f.name)}（${f.producers.size}）`).join('｜')}\n` : '',
    '## 索引：產業鏈', '', model.chains.map(c => L.chain(c.name)).join('｜'), '',
    `## 索引：關係企業群（前 ${topGroups.length}，依家數）`, '', topGroups.map(g => `${L.group(g.name)}（${g.members.length}）`).join('｜'), '',
    '## 索引：ETF 追蹤指數', '', etfIdx.map(([n, cs]) => `${L.index(n)}（${cs.length}）`).join('｜'), '',
    '## 索引：投信', '', [...model.issuers.entries()].sort((a, b) => b[1].length - a[1].length).map(([n, cs]) => `${L.issuer(n)}（${cs.length}）`).join('｜'), '',
    '## 索引：重大訊息', '', model.announceDays.map(d => L.day(d.date)).reverse().join('｜'),
  ].join('\n');
}
