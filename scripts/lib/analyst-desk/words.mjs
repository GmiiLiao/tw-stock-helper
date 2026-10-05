// ─────────────────────────────────────────────────────────────────────────────
// 禁用詞表（R09／R10／R19／R22）與語言／格式偵測（R20）——集中、版控、純函式。
//
// 設計原則（誤殺是這份表的第一風險，所以先講白名單）：
//   1. 描述事實的詞不可誤殺：「買賣超」「外資買超」「融資買進」「借券賣出」「買進成交」「追價風險」「處置」「保證金」…
//      → DESCRIPTIVE_ALLOW：掃描前先把這些片段遮掉（用同長度的占位字元，位置不變）。
//   2. 否定／免責用法不可誤殺：「非投資建議」「不構成推薦」「不是買賣訊號」「不預測」…
//      → 命中詞前方同一子句內（≤14 字、不跨 ，。；、！？：）出現 NEGATION_LEAD 即視為否定用法放行（R22 不放行）。
//      注意 `非(?!常)`：「非常看多」不是否定。「未」不列入（「未來將上漲」的「未」不是否定）。
//   3. 程式固定句（免責、useRules 文字）整段放行（FIXED_PHRASES）。
//   4. 回歸測試：words.test 以 daily-heatmap 的 narrative／render 輸出與 second-brain/daily-heatmap/reports/*.md 當負樣本，
//      誤報必須為 0；新增詞前先跑那個測試。
// 每條規則附 id、rule、level（block｜warn）與註解（誤殺考量）。
// ─────────────────────────────────────────────────────────────────────────────
import { FIXED_PHRASES } from './constants.mjs';

const R = (id, rule, level, source, note, flags = 'g') => Object.freeze({ id, rule, level, re: new RegExp(source, flags), note });

// ═══ 描述性用語白名單（遮掉再掃）══════════════════════════════════════════════
const ACTORS = '外資及陸資|外資|陸資|投信|自營商|三大法人|法人|主力|大戶|散戶|融資|融券|借券|當沖|信用交易|公司|大廠|業者|廠商';
export const DESCRIPTIVE_ALLOW = Object.freeze([
  // 籌碼／信用交易欄位名稱本身就含買賣字樣（買賣超、買超、賣超不含禁用詞，列出供測試與文件）
  { id: 'net-flow', re: /買賣超|買超|賣超/g, note: '法人／券商買賣超＝描述事實' },
  // 「<市場參與者>＋買進／賣出」＝事實描述（外資買進 100 張、融資買進、借券賣出）；中間容 ≤2 字（外資連續買進）
  { id: 'actor-flow', re: new RegExp(`(?:${ACTORS})[^，。；、\\s]{0,2}(?:買進|買入|賣出|加碼|減碼)`, 'g'), note: '「外資買進」「融資買進」「借券賣出」「法人減碼」＝描述事實，不是對讀者的指示' },
  // 買進／賣出＋統計名詞（買進成交、賣出張數…）；不含「買進價」（像價位指示）
  { id: 'flow-stat', re: /(?:買進|買入|賣出)(?:成交|張數|股數|金額|均價|口數|餘額|淨額|家數|比重|占比|日報|量)/g, note: '成交統計欄位名稱' },
  // 公司事件（MOPS 取得／處分資產）
  { id: 'corp-asset', re: /(?:買進|買入|賣出)(?:不動產|土地|廠房|設備|股權|資產|庫藏股|公司債)/g, note: '公司取得／處分資產公告' },
  // 公司動作：加碼資本支出（不是對讀者說加碼）
  { id: 'corp-capex', re: /(?:加碼|減碼)(?:資本支出|資本開支|投資|擴產|擴廠|採購|投入|庫存)/g, note: '公司擴產／資本支出描述' },
  // 布局：公司策略名詞；單獨的「布局」仍擋（逢低布局＝建議）
  { id: 'corp-layout', re: /(?:全球|海外|產能|供應鏈|產線|據點|商業|專利|策略|通路|人才|市場)(?:布|佈)局/g, note: '公司策略名詞' },
  { id: 'margin-deposit', re: /保證金/g, note: '融資／期貨保證金＝制度名詞（擋「保證」是為了「保證獲利」）' },
  { id: 'risk-terms', re: /追價風險|追高風險|處置|注意股|分盤交易/g, note: '風險旗標描述用語' },
  // 產業／產品名稱含「訊號」（類比與混合訊號 IC、訊號處理）：不是站內模型訊號
  { id: 'tech-signal', re: /(?:混合|類比|數位|射頻|音訊|視訊|影像|通訊)訊號|訊號(?:IC|晶片|處理|線|傳輸|轉換)/g, note: '半導體／通訊產業名詞' },
  { id: 'shape-label', re: /(?:少數|多數|普遍|單檔|族群|單一)?帶動型|單檔帶動|少數帶動/g, note: '熱力技能的形態標籤（shape），不是因果句' },
]);

/** 否定／免責前導：命中詞前方同一子句出現這些即放行。 */
export const NEGATION_LEAD = /不是|並非|非(?!常)|不構成|不含|不提供|不做|不進|不計|不作為|不等於|不屬於|不代表|不預測|不涉及|不得|禁止|不具/;
const CLAUSE_BREAK = /[，。；！？：:\n（）()「」]/; // 不含「、」：「不含價格目標、買賣或進出場指示」整串屬同一否定
const NEGATION_WINDOW = 14;

// ═══ R09：禁用語（硬）══════════════════════════════════════════════════════════
export const TRADE_TERMS = Object.freeze([
  R('r09-target', 'R09', 'block', '目標價|價格目標|目標區|目標位|目標股價|合理價|理論價', '價格目標；「目標」單字不擋（營運目標、財測目標）'),
  R('r09-stop', 'R09', 'block', '停損|停利|止損|止盈|停損價|停利價', '停損停利'),
  R('r09-trade-verb', 'R09', 'block', '進場|出場|買進|買入|賣出|加碼|減碼|搶進|卡位|低接|抄底|逢低|逢高', '買賣動詞；描述性用法由 DESCRIPTIVE_ALLOW 放行'),
  R('r09-layout', 'R09', 'block', '布局|佈局', '逢低布局＝建議；公司策略名詞由白名單放行'),
  R('r09-guarantee', 'R09', 'block', '保證|必漲|必跌|穩賺|穩賠|一定會|確定(?:上漲|下跌)|翻倍', '「保證金」由白名單放行；「一定」單字不擋'),
  R('r09-advice', 'R09', 'block', '建議|推薦|值得買|值得布局|勝率|命中率', '對投資人的建議／推薦；「非投資建議」等否定用法由否定前導放行'),
  R('r09-sr-level', 'R09', 'block', '(?:支撐|壓力|阻力)(?:位|區|價|帶|線)', '技術位階；「賣壓」「資金壓力」不擋'),
  R('r09-en', 'R09', 'block', '\\b(?:buy|sell|target\\s*price|stop[- ]?loss|take[- ]?profit|outperform|underperform|overweight|underweight)\\b', '英文買賣語', 'gi'),
]);

// ═══ R10：預測句型 ═════════════════════════════════════════════════════════════
const MOVE = '上漲|下跌|大漲|大跌|突破|站上|跌破|走高|走低|續漲|續跌|回升|回落|反彈|回檔|創高|創新高|創新低|填息|收高|收低|拉升|攀升|下殺|重挫|噴出';
export const PREDICTION_PATTERNS = Object.freeze([
  R('r10-will-move', 'R10', 'block', `將(?:會|再|持續)?(?:${MOVE})`, '「將於」「將公告」是排程事實，不擋；只擋「將＋漲跌動詞」'),
  R('r10-outlook', 'R10', 'block', '可望|有望|看多|看空|看漲|看跌|續強|續漲|上攻|料將|勢必|恐將|恐再', '展望詞；「非常看多」不放行（非(?!常)）'),
  R('r10-attack', 'R10', 'block', '衝(?:高|上|破|關|刺高)|直衝|狂衝|挑戰\\s*[\\d§][\\d,.§]*\\s*點', '「衝擊」「衝突」不擋'),
  R('r10-expect-move', 'R10', 'block', '預[計期估](?:會|將)?[^。，；]{0,10}(?:漲跌幅|上漲|下跌|漲|跌|走高|走低|反彈|回落|攀升|創高|突破)', '「預期型」(certainty 標籤)、「預計於 10/8 召開」不擋'),
  R('r10-price-aim', 'R10', 'block', '(?:上看|下看|看到|下探|站上|跌破|突破|挑戰)\\s*\\d', '價位預言；後接數字才擋（裸數字另受 R03 管）'),
  R('r10-probability', 'R10', 'block', '機率[^。，；]{0,4}(?:大|高|低|小|偏)|(?:開高|開低|上漲|下跌)[^。，；]{0,3}機率', '03 §3.3 反例：「明日開高機率大」'),
  R('r10-hype', 'R10', 'block', '有撐|資金簇擁|簇擁', '03 §3.3 反例用語'),
  R('r10-soft', 'R10', 'warn', '看好|狂飆|暴漲|暴跌|飆漲|預估|預料', '多為轉述第三方（法人看好）或形容詞；只警示不擋'),
]);
/** 未來時態＋漲跌動詞（R10 結構檢查：只准出現在 conditional 或 next 卡的 outlook／linkage，且須含條件詞）。 */
export const FUTURE_MOVE_RE = new RegExp(`(?:將|會|預計|預期|可能|恐)(?:再|持續|繼續)?(?:${MOVE}|轉強|轉弱|擴大|縮小|收斂|延續)`, 'g');
/** 條件式用語：未來句必含其一（R10）。 */
export const CONDITIONAL_WORDS_RE = /若|當|如果|倘|觀察|留意|關注是否|是否/;

// ═══ R19：分數／訊號／評級名詞（描述 vs 風險分離）═══════════════════════════════
export const SCORE_TERMS = Object.freeze([
  R('r19-zh', 'R19', 'block', '評分|評級|評等|分數|訊號|信號|模型看好|模型評|排名第|推薦榜|強勢榜|picksHistory|picksScoreboard', '站內模型分數／訊號名詞；「n<8 不排名」「非訊號」由否定前導放行；「熱度名次」不擋'),
  R('r19-en', 'R19', 'block', '\\b(?:score|signal|rating|baseScore|baseSignal)\\b', '英文同義', 'gi'),
]);

// ═══ R22：傳導語氣（linkage／outlook）══════════════════════════════════════════
export const CAUSAL_TERMS = Object.freeze([
  R('r22-hard', 'R22', 'block', '導致|因此將|因此會|必然|勢必|必定|肯定會|致使', '只准「可能影響」「相關」「同向／反向變動」（04 R22）'),
  R('r22-soft', 'R22', 'warn', '帶動|造成|使得|由於|所以|因而', '因果連接詞：03 R12 僅在量測通過時可用；警示不擋。熱力形態標籤「帶動型」由白名單放行'),
]);

// ═══ R20：語言與格式 ═══════════════════════════════════════════════════════════
/**
 * 簡體專用字（繁體不會出現的字形）。刻意排除「繁簡同形」或繁體也用的字（台、里、后、干、谷、余、范、云、面、制、征…）。
 * 負樣本（daily-heatmap 報告）零命中是上線條件；新增字前先跑 words.test。
 */
export const SIMPLIFIED_CHARS = '这个们为来说对发时会国业产经济动现长开关门问应总统计资价报导书买卖张机构师过还运术样种复员户场车称体视观优势轮转币须项领获让该认将断续连组织线级严积极强处临显决盘汇银险贷债税财务营亏损涨预测评议权兴实达联华环际战条数据标准电网络软阳乐记录创间题费厂压释赢钱铁钢钛铜铝镍锂储单双与专东轻货输装备设试验变异当并从属结办尝区医药听话语读诉请谈谁调谢证识订访许论讯译诚误帮丛仅仪优伤伦侧侦俭儿党兰关兴养兽冲决况净减划则刚创别剧办务动励劲劳势勋协单卖卫厂历压厌县参双发变叙叶号叹后吓吗启员响哑员团园围图圆圣场坏块坚坛坝坞坟垒垦堑够头夹夺奋奖妇妈妆姗娱婴宁实审宪宫宽宾对寻导寿将尔尘尝层属岁岛峡币师帐帘带帮干并广庆应库废开异弃张弹强归当录彦彻征径忆忧怀态怜总恋恳恶恼悦悬惊惨惯愿戏战户扑执扩扫扬扰抚抛拟拥择挂挡挣捡换损摇摄摆携搅数敌敛斋断无旧时显晓晕暂术机杀杂权条来杨极构枪柜标栋树样桥梦检楼欢欧毕毙气汉汤沟没沥沦沧泛泪泽洁洒浅浆浇浊测济浏浑浓涌涛涝润涨渐渔温湾溃满滚滞滥滨灭灯灵灾炉炼烂烛烟烦烧热爱爷牵犹状狭独狮猎猪猫献獭玛环现琐电画畅疗疯痒痴瘾盖盘着睁矿码砖础确礼祸离秃种积称窃窍竞笔笼筑筛签简类粮紧纠红纪纤约级纯纲纳纵纷纸纹线练组细织终绍经结绕绘给络绝统绢绣继绩绪续维绵综绿缓编缘缝缩网罗罚罢羁职联聪肃肠肤肾胀胁胜脑脚脏腊腾舆艰艺节芜苏苹范茧荣药获莲萝营萧蓝蔼虏虑虚虽蚀蚁蛮补衬袄装裤见观规视览觉触计订认讨让训议讯记讲讳许论设访证评识诈诉诊词译试诗诚话诞询该详语误说请诸诺读课谁调谅谈谊谋谓谜谢谣谨谱贝贞负贡财责贤败账货质贩贪贫购贯贴贵贸费贺贼贾资赁赂赃赋赌赏赔赖赚赛赞赠赢赵趋跃踪车轨轩转轮软轰载轻较辅辆辈输辖辩辽达迁过迈运还这进远违连迟适选递邮邻酝酱释鉴针钓钟钢钥钦钱钻铁铃铅铜银铸链销锁锅锋错键锐锡镇镜长门闪闭问闯闲间闷闹闻阅阔队阳阴阵阶际陆陈陕险随隐难雏电霉静页顶项顺须顾顿颁颂预颅领颇颈频颗题额风飘饭饮饰饱饼馆骂驰驱驶驻骆验骑骗骤髅鱼鲜鸟鸡鸣鸭鸿鹅鹤麦黄齐齿龄龙';
/** 繁體也會用到的字（誤放進上面清單時在此剔除）：后（皇后）干（干擾）范（姓）征（征服）划（划算）叶（叶韻）冲 准（核准）泛（泛用）着腊。 */
const ALSO_TRADITIONAL = '后干范征划叶冲准泛着腊';
const SIMPLIFIED_SET = new Set([...SIMPLIFIED_CHARS].filter(c => !ALSO_TRADITIONAL.includes(c)));
/** 回傳出現的簡體專用字（去重、依出現順序）。 */
export function findSimplified(text) {
  const out = [];
  for (const ch of String(text ?? '')) if (SIMPLIFIED_SET.has(ch) && !out.includes(ch)) out.push(ch);
  return out;
}

export const EMOJI_RE = /\p{Extended_Pictographic}/u;
/** Markdown 殘留：粗體、標題、行內碼、連結語法、清單符號、跳脫底線、表格豎線。（槽位的 | 已先被遮掉） */
export const MARKDOWN_RES = Object.freeze([
  { id: 'bold', re: /\*\*|__/ },
  { id: 'heading', re: /(?:^|\n)\s{0,3}#{1,6}\s/ },
  { id: 'code', re: /`/ },
  { id: 'link-syntax', re: /\[[^\]]*\]\([^)]*\)/ },
  { id: 'bullet', re: /(?:^|\n)\s*(?:[-*•]|\d+\.)\s+\S/ },
  { id: 'escaped-underscore', re: /\\_/ },
  { id: 'table-pipe', re: /\|/ },
]);
export const EXTERNAL_LINK_RE = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|tw|org|net|io|co|gov|edu)\b/i;

// ═══ 掃描器 ════════════════════════════════════════════════════════════════════
const MASK = '　'; // 全形空白：占位但不構成詞

function maskSpans(text, res) {
  let t = text;
  for (const re of res) t = t.replace(re, m => MASK.repeat(m.length));
  return t;
}

/** 遮掉程式固定句與描述性用語（保留長度，位置不變）。 */
export function maskAllowed(text) {
  let t = String(text ?? '');
  for (const p of FIXED_PHRASES) if (p && t.includes(p)) t = t.split(p).join(MASK.repeat(p.length));
  return maskSpans(t, DESCRIPTIVE_ALLOW.map(a => new RegExp(a.re.source, a.re.flags)));
}

/** 命中位置之前、同一子句內是否有否定／免責前導。 */
export function isNegated(text, index) {
  let start = Math.max(0, index - NEGATION_WINDOW);
  for (let i = index - 1; i >= start; i--) if (CLAUSE_BREAK.test(text[i])) { start = i + 1; break; }
  return NEGATION_LEAD.test(text.slice(start, index));
}

const GROUPS = Object.freeze({ R09: TRADE_TERMS, R10: PREDICTION_PATTERNS, R19: SCORE_TERMS, R22: CAUSAL_TERMS });
/** 這些規則的否定用法放行；R22（傳導語氣）不放行。 */
const NEGATION_EXEMPT = new Set(['R09', 'R10', 'R19']);

/**
 * 掃描文字。回傳 [{ rule, id, level, term, index }]（依位置排序）。
 * rules：要掃的規則（預設 R09／R10／R19／R22）。text 應已去掉槽位（以占位字元取代）。
 */
export function scanWords(text, { rules = ['R09', 'R10', 'R19', 'R22'] } = {}) {
  const src = String(text ?? '');
  const masked = maskAllowed(src);
  const hits = [];
  for (const rule of rules) {
    for (const def of GROUPS[rule] ?? []) {
      for (const m of masked.matchAll(new RegExp(def.re.source, def.re.flags))) {
        if (NEGATION_EXEMPT.has(rule) && isNegated(masked, m.index)) continue;
        hits.push({ rule, id: def.id, level: def.level, term: m[0], index: m.index });
      }
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}
