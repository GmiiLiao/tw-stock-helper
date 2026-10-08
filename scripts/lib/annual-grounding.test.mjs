// 年報原文核對（J4-4「ok並強制不可有幻覺」）：node --test scripts/lib/annual-grounding.test.mjs
// 固定案例取自 2026-10-08 本機年報節錄實測（J4 批次 item4 稽核、role-regression-cases）；回歸案例的原文窗在 annual-grounding.fixture.json
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  GROUND_VER, MIN_TEXT_CHARS, prepareText, textUsable, groundName, isGarbledName, decodeByteLiterals,
  isPlaceholderCounterparty, codedAliasInText, counterpartyEvidence, prepareKnownNames, normLoose,
} from './annual-grounding.mjs';

const FIXTURE = JSON.parse(fs.readFileSync(new URL('./annual-grounding.fixture.json', import.meta.url), 'utf8'));

test('規則有版本號；門檻 800 字', () => {
  assert.match(GROUND_VER, /^ag-\d{4}-\d{2}-\d{2}\.\d+$/);
  assert.equal(MIN_TEXT_CHARS, 800);
});

test('節錄門檻：0 字、過短、錨點沒命中實質小節都整份不用（1234 黑松等 40 份 0 字）', () => {
  assert.deepEqual(textUsable(prepareText(''), []), { ok: false, reason: 'text-empty' });
  assert.deepEqual(textUsable(prepareText('伍、營運概況\n'), ['products']), { ok: false, reason: 'text-short' });
  assert.deepEqual(textUsable(prepareText('主要產品'.repeat(300)), ['plants', 'uses']), { ok: false, reason: 'no-anchor' });
  assert.deepEqual(textUsable(prepareText('主要產品'.repeat(300)), ['products']), { ok: true });
  assert.deepEqual(textUsable(null, ['products']), { ok: false, reason: 'text-empty' });
});

test('loose 索引逐字對回 exact（含相容表意字、異體字、標點）', () => {
  const T = prepareText('柯尼卡美 能達、系统中国 有限公司（台灣）\n高雄巿 ABC Co., Ltd.');
  assert.equal(T.loose.length, T.looseMap.length);
  for (let j = 0; j < T.loose.length; j++) {
    const c = T.exact[T.looseMap[j]].toLowerCase();
    assert.equal(T.loose[j], normLoose(c) || c, `第 ${j} 字`);
  }
  assert.ok(T.loose.includes('系統中國有限公司臺灣'));
});

test('非空節錄裡的提示詞範例回聲剔除（真空壓膜機／射出成型機出現在 153 份）', () => {
  const T = prepareText('主要產品為水泥及預拌混凝土，生產設備為旋窯與水泥磨。'.repeat(40));
  assert.equal(groundName('真空壓膜機', T).ok, false);
  assert.equal(groundName('水泥磨', T).ok, true);
  assert.equal(groundName('水泥磨', prepareText('')).ok, false);
});

test('亂碼名（位元組字面、U+FFFD）讀取端一律不用，不還原', () => {
  assert.equal(decodeByteLiterals('休閒<0xEF><0xA7><0x90>').normalize('NFKC'), '休閒類');
  const T = prepareText('產品名稱 百分比\n休閒類 46.91%\n鮮食類 53.09%');
  assert.equal(isGarbledName('休閒<0xEF><0xA7><0x90>'), true);
  assert.deepEqual(groundName('休閒<0xEF><0xA7><0x90>', T), { ok: false, tier: 'garbled' });
  assert.equal(groundName('半精紡用散毛<0xEF><0xA7><', T).ok, false);
  assert.equal(isGarbledName('休閒�'), true);
  assert.equal(isGarbledName('休閒類'), false);
});

test('只做不改指涉的正規化：空白斷行、公司後綴、異體字、地名別名、組合名', () => {
  const T = prepareText('1 柯尼卡美 能達辦公 系统中国 有限公司 834,452\n須經由炖爐熱處理\n高雄巿及宜蘭縣\n外銷中國大陸\n原料 PTA、EG');
  assert.equal(groundName('柯尼卡美能達辦公系統中國有限公司', T).ok, true);
  assert.equal(groundName('燉爐', T).ok, true);
  assert.equal(groundName('高雄市', T).ok, true);
  assert.equal(groundName('中國', T).ok, true);
  assert.equal(groundName('PTA、EG', T).ok, true);
  assert.equal(groundName('Glencore Coal Sales PTY Limited', prepareText('Glencore Coal Sales Pty. Ltd.')).ok, true);
  assert.equal(groundName('台灣塑膠工業(股)公司', prepareText('與台灣塑膠工業股份有限公司訂約')).ok, true);
});

test('改寫、合併、推論出來的名稱一律視為找不到', () => {
  const T = prepareText('主要競爭者 福壽、金葫蘆、富香\n頭份及林園兩廠產品互補\n紐澳、東南亞等既有市場');
  assert.equal(groundName('富壽', T).ok, false);     // 1260：福壽＋富香 混成
  assert.equal(groundName('頭份廠', T).ok, false);   // 1305：原文沒有「頭份廠」
  assert.equal(groundName('澳洲', T).ok, false);     // 1449：原文是「紐澳」
});

test('英文後綴要有空白或標點隔開才剝（SEMCO 不可剝成 sem）', () => {
  const T = prepareText('本公司研發部門持續投入 semiconductor 相關研究。');
  assert.equal(groundName('SEMCO', T).ok, false);
  assert.deepEqual(counterpartyEvidence('SEMCO', T, 'suppliers').roles, []);
});

test('交易對手代號名與泛稱剔除，但真實兩字母公司保留', () => {
  for (const n of ['A公司', '甲客戶', '客戶1', '客戶X', '供應商甲', 'AE001', 'B', '其他', '客戶名稱A', '客戶-A(輪胎)', '集團A客戶', 'FD-001', '第一大銷貨客戶', 'HY廠商', '國際廠商', '車規客戶', '國內外廠商', '未揭露']) {
    assert.equal(isPlaceholderCounterparty(n), true, n);
  }
  for (const n of ['HP', 'LG', '台積電', 'Apple', 'TP-Link', '中華電信', 'NVIDIA']) assert.equal(isPlaceholderCounterparty(n), false, n);
});

test('進銷貨表「得以代號為之」的其他寫法也是代號名（2026-10-09 反證審查：9 檔 25 項＋同型 19 項曾漏過）', () => {
  for (const n of ['210594', '293', '1000221', '10243', 'S08', 'A01', 'B07', 'C01', 'BAA001', 'AAC014', 'A0001', 'KM1035', 'C100014', 'S200038', 'D00619', 'P522600',
    'P131486(註)', 'R商', 'G商', 'L-H商', '其他(註)', '其他（註）', '其它客戶']) {
    assert.equal(isPlaceholderCounterparty(n), true, n);
  }
  for (const n of ['3M', 'MR', 'WD', 'HP', 'ABB', 'AMD', 'NEC', 'JFE', 'BMW', '9FF', 'Nintendo Switch 2', '其士', '中纖', 'TP-Link']) assert.equal(isPlaceholderCounterparty(n), false, n);
});

test('大寫字母代號表（1449「AU公司、BC公司…」）視同代號名；單獨出現的 NEC 不算', () => {
  const T = prepareText('客戶名稱 F公司 27,274 E公司 66,488 AR公司 72,325 BJ公司 25,853 BC公司 66,421 N公司 20,717 AU公司 1,000');
  assert.equal(codedAliasInText('BC', T), true);
  assert.equal(codedAliasInText('AU', T), true);
  assert.equal(codedAliasInText('NEC', prepareText('主要供應商為NEC公司及日立')), false);
  assert.equal(codedAliasInText('台積電', T), false);
});

// ── 客戶／供應商關係（O9）──────────────────────────────────────────────────────
const ev = (name, text, field, opts) => counterpartyEvidence(name, prepareText(text), field, opts).verdict;

test('進貨表裡的對象不是客戶（2013 中鋼構→中鋼）', () => {
  const t = '(四)最近二年度曾占進(銷)貨總額百分之十以上之客戶名單\n1.最近二年度曾占進貨總額百分之十以上之客戶名單\n名 稱 金 額 占全年度進貨淨額比率(%)\n1 中國鋼鐵(股)公司 4,520,278 60.02';
  assert.equal(ev('中國鋼鐵(股)公司', t, 'customers'), 'opposite');
  assert.equal(ev('中國鋼鐵(股)公司', t, 'suppliers'), 'proven');
});

test('敘述句以最近的標記為準（1444 力鵬、1726 科慕、2109 林園先進）', () => {
  assert.equal(ev('力鵬', '供應廠商為亞東石化、東聯、南亞及中纖；…，下游銷貨地點亦以國內布廠為主,如力鵬、福懋及弘裕等', 'customers'), 'proven');
  assert.equal(ev('台灣科慕', '目前國內、外主要供應商為Lanxess、SunChemical、台灣科慕、台色等', 'suppliers'), 'proven');
  assert.equal(ev('台灣科慕', '目前國內、外主要供應商為Lanxess、SunChemical、台灣科慕、台色等', 'customers'), 'opposite');
  assert.equal(ev('林園先進', '(四)主要進銷貨客戶名單：1.最近二年度10%以上進貨供應商之資料：無 本公司主要原料…其供應商福懋、林園先進、台橡等均是高知名度', 'suppliers'), 'proven');
});

test('表頭：進貨合計列之後的「主要銷貨客戶名單」、用「佔」的銷貨表（1722、2227）', () => {
  assert.equal(ev('台豐興實業有限公司', '3SABIC737,229 11% 液氨供應商 其他 5,014,420 72% 進貨淨額 6,520,089 100% 2.主要銷貨客戶名單：(1)肥料產品 113年度 客戶名稱 金額 占該年度比例 台豐興實業有限公司 506,567仟元 17.01', 'customers'), 'proven');
  assert.equal(ev('裕融企業(股)公司', '進貨淨額 19,814,742 100 2.最近二年度佔銷貨總額百分之十以上之客戶資料 名稱 金額 銷貨淨額比率 1 裕融企業(股)公司 19,474,010 84 關係人', 'customers'), 'proven');
});

test('同一名稱兩種角色都有 ⇒ both，不當交易對手（1444 力鵬：敘述是客戶、進貨表是供應商）', () => {
  const t = '下游銷貨地點亦以國內布廠為主,如力鵬、福懋。…… (四)最近兩年度任一年度中曾占進(銷)貨總額百分之十以上之客戶名稱 1.進貨(1)紡織及其他部門 2力鵬871,614 18 關聯企業';
  assert.equal(ev('力鵬', t, 'suppliers'), 'both');
  assert.equal(ev('力鵬', t, 'customers'), 'both');
});

test('產業列舉、競爭描述、金融往來不是交易關係', () => {
  assert.equal(ev('南亞', '2產業上下游呈金字塔結構黏性膠帶之上游為基材、化工原料,主要廠商為南亞、華夏、長興及炎洲等。', 'suppliers'), 'non-transaction');
  assert.equal(ev('長榮海運', '根據Alphaliner100統計,台灣在世界30大貨櫃船公司就佔了四間,分別為長榮海運、陽明海運、萬海航運以及德翔海運', 'customers'), 'non-transaction');
  assert.equal(ev('彰化商業銀行', '七、重要契約契約性質當事人契約起訖日期主要內容限制條款授信合約彰化商業銀行104/10/05-119/10/05長期擔保放款', 'suppliers'), 'non-transaction');
  assert.equal(ev('揚智', '機上盒晶片由博通主導高階市場,中低階則由揚智、晶晨、海思、聯發科、瑞昱等業者搶占市場。', 'suppliers'), 'non-transaction');
  assert.equal(ev('嘉晶', '(B)產業上、中、下游之關聯性:分離式元件產業的結構大致可分為上游原材料供應業。目前國內主要晶圓材料與擴散材料供應商包括中美矽晶、嘉晶等。', 'suppliers'), 'non-transaction');
});

test('重要契約表依合約種類判角色（1725：銷售合約＝本檔賣給對方）', () => {
  const t = '七、重要契約:契約性質當事人契約起訖日期主要內容限制條款買賣台灣塑膠工業(股)公司115/01/01~115/12/31銷售合約無買賣國喬石油化學(股)公司115/01/01~115/12/31採購合約無';
  assert.equal(ev('台灣塑膠工業', t, 'suppliers'), 'opposite');
  assert.equal(ev('台灣塑膠工業', t, 'customers'), 'proven');
  assert.equal(ev('國喬石油化學', t, 'suppliers'), 'proven');
});

test('「供應…原料之廠商有X」是本檔供應廠商；「售予X」是銷售；名稱後的「供電」不是供應（1447、1513，2026-10-09）', () => {
  const t = '(三)主要原料之供應狀況 1.尼龍粒 2.加工絲供應加工絲原料之廠商有力麗、宏州、東隆、中纖等加工絲大廠,加上本公司自製的尼龍絲';
  assert.equal(ev('宏州', t, 'suppliers'), 'proven');
  assert.equal(ev('中纖', t, 'suppliers'), 'proven');
  assert.equal(ev('宏州', '產業上、中、下游之關聯性:國內加工絲廠商有宏州、東隆等', 'suppliers'), 'non-transaction');   // 沒有「供應…之」仍是產業列舉
  assert.equal(ev('台電公司', '本公司產品以內銷為主,重電產品以直接銷售方式售予台電公司、公共設施事業及各大工廠。', 'customers'), 'proven');
  assert.equal(ev('台電公司', '長期業務發展計劃台電公司統包工程、公路隧道機電工程、捷運供電系統工程', 'suppliers'), 'unknown');
});

test('「由X供應」「向X購買」「與X訂定供料合約」是供應；「主要仍由…供應」的市場描述不是', () => {
  assert.equal(ev('南亞塑膠工業股份有限公司', '(2)可塑劑:主要由南亞塑膠工業股份有限公司供應,特殊之可塑劑則自國外進口。', 'suppliers'), 'proven');
  assert.equal(ev('台塑', '本公司所需AN以由國內取得為主。2.丙烯腈(AN)與中石化訂定供料合約,國內亦定期向台塑購買,並視供需狀況', 'suppliers'), 'proven');
  assert.equal(ev('中石化', '本公司所需AN以由國內取得為主。2.丙烯腈(AN)與中石化訂定供料合約,國內亦定期向台塑購買', 'suppliers'), 'proven');
  assert.equal(ev('南亞', '國內傳統用途市場,主要仍由本集團、南亞供應或是進口。', 'customers'), 'non-transaction');
});

test('關係企業字樣：章節標頭不成角色；表格上一列的「子公司」欄不算；同句另有供應敘述照敘述', () => {
  assert.equal(ev('磐亞', '降低成本。※合併公司1、磐亞公司(1)產業之現況與發展', 'customers'), 'non-transaction');
  assert.equal(ev('浙江普禮', '由本公司之上游供應商觀之,鑄鐵粗材供應商為本公司之轉投資公司浙江普禮及國內福信公司', 'suppliers'), 'proven');
  assert.equal(ev('鼎泰車業(股)公司', '最近二年度主要銷貨客戶資料 名稱金額占全年度銷貨淨額比率%與發行人關係 1南陽實業(股)公司3,408,074 29本公司之子公司 2鼎泰車業(股)公司1,395,148 12', 'customers'), 'proven');
});

test('延伸防呆：「東南亞」裡的「南亞」、已知較長名稱裡的短名不算出現', () => {
  const t = '主要客戶為日本、中南美、北美及亞洲成衣商等,尤其是亞洲地區之越南、斯里蘭卡、東南亞等地。';
  assert.deepEqual(counterpartyEvidence('南亞', prepareText(t), 'customers').roles, []);
  const known = prepareKnownNames(['中鋼構', '中鋼']);
  assert.deepEqual(counterpartyEvidence('中鋼', prepareText('主要客戶為中鋼構等'), 'customers', { known }).roles, []);
  assert.equal(ev('中鋼', '主要客戶為中鋼、中鋼構等', 'customers', { known }), 'proven');
});

test('沒有任何標記 ⇒ unknown（不當交易對手）', () => {
  assert.equal(ev('台積電', '台積電於本年度宣布擴產。', 'customers'), 'unknown');
  assert.equal(ev('台積電', '', 'customers'), 'unknown');
});

test(`回歸案例：${FIXTURE.cases.length} 筆年報客戶／供應商（定稿初判＋原文更正）`, () => {
  const known = prepareKnownNames(FIXTURE.knownNames);
  const counts = { keep: 0, drop: 0 };
  for (const c of FIXTURE.cases) {
    const r = counterpartyEvidence(c.name, prepareText(c.excerpt), c.field, { known });
    counts[c.verdict]++;
    assert.equal(r.verdict, c.fullTextVerdict, `${c.code} ${c.field} ${c.name}：原文窗與全文判定不同`);
    if (c.verdict === 'keep') assert.equal(r.verdict, 'proven', `${c.code} ${c.field} ${c.name} 應保留（${c.why}）`);
    else assert.notEqual(r.verdict, 'proven', `${c.code} ${c.field} ${c.name} 應剔除（${c.why}）`);
  }
  assert.deepEqual(counts, { keep: 9, drop: 29 });
});
