// ============================================================
// News sentiment scoring (PURE, client-safe) — the 20% news weight.
//
// Classifies each REAL news item (title from whitelisted sources) as a
// bullish (上漲) / bearish (下跌) / neutral signal with a magnitude, assigns
// a validity period (有效期) by news type, decays weight to 0 at expiry,
// dedupes same-date + same-content articles, and aggregates into a
// newsScore ∈ [-1,+1]. The composite scorer applies this as a ±20-point
// adjustment (i.e. up to 20% influence). Keyword-based → grounded, no
// hallucination (every classification traces to the article title).
// ============================================================

// verdict/verdictBasis 是**唯一有資格影響分數**的欄位（使用者 2026-08-29 明令）：
//   verdict 必須來自 AI **讀完內文**後的利多/利空判別，
//   verdictBasis 記錄判別依據，只有 'content' 能參與調分。
//   標題（不論是關鍵字比對還是 LLM 讀標題）一律不得動分數。
export interface NewsLite {
  title: string; time?: string; source?: string; url?: string;
  // ⚠ 「資訊不足」是 daemon 會實際給出的第四種結果（AI 讀了但判不出來），
  //   與「中性」意義完全不同：中性＝判過了沒方向，資訊不足＝根本無從判斷。
  //   型別漏了它會落到 else 被當成中性，畫面就會謊稱「AI 判別為中性」。
  verdict?: '利多' | '利空' | '中性' | '資訊不足';
  verdictBasis?: 'content' | 'title';
  verdictConfidence?: '高' | '中' | '低';
  // 強度＝AI 預期的市場反應大小，與信心是兩件事（信心＝對判斷本身的確定度）。
  // 使用者 2026-08-29：固定幅度無法跨個股排序——「營收年增 200%」與
  // 「年增 5%」的市場反應本來就不同，判別必須帶出量級。
  verdictStrength?: '極強' | '強' | '中' | '弱';
  // 判別**產出的時間**。時效衰減要用它，不能用被掛上的那則新聞的時間：
  // 判別若掛在比它更新的新聞上，等於讓一個沒看過那則新聞的判別
  // 拿到滿分新鮮度。用判別自己的時間才誠實。
  verdictAt?: string;
  verdictReason?: string;   // AI 讀完內文後給的理由——這是內文判別最有價值的產出，要讓使用者看到
}

export interface ScoredNewsItem {
  title: string; source?: string; url?: string;
  date: string;            // YYYY-MM-DD
  sentiment: number;       // signed magnitude (-2..+2) at publish
  kind: 'bull' | 'bear' | 'neutral';
  validDays: number;       // 有效期（交易日）
  weight: number;          // current time-decayed weight (0..1); 0 = expired
  effective: number;       // sentiment * weight (contribution)
  // 判別依據。只有 'content'（AI 讀完內文）能參與調分；
  // 'title' 僅供顯示，永遠不計分。缺值視同 'title'。
  verdictBasis: 'content' | 'title';
  verdict?: '利多' | '利空' | '中性' | '資訊不足';   // 保留原判別，供區分「中性」與「資訊不足」
}

export interface NewsSentiment {
  newsScore: number;       // aggregate ∈ [-1, +1]
  adjustment: number;      // ±20-point score adjustment (20% weight)
  bull: number;            // # active bullish items
  bear: number;            // # active bearish items
  total: number;           // # de-duped items considered
  label: string;           // 偏多 / 偏空 / 中性 / 未判別
  judgedByAI: boolean;     // 是否已有 AI 內文判別（判為中性也算判過）
  inconclusive: boolean;   // AI 讀了但判不出來（≠ 判為中性）
  verdictReason?: string;  // AI 的判別理由（有才給，不編造）
  ratedCount: number;      // 有多空傾向的篇數（中性者不進分群）
  storyCount: number;      // 併群後的故事數（標題相似者併為一則）
  gradedCount: number;     // 真正參與調分的故事數（＝有 AI 內文判別的）
  items: ScoredNewsItem[];
}

// Strong (±2) and mild (±1) keyword sets. Longer-lasting types get longer 有效期.
const BULL_STRONG = ['漲停', '大漲', '飆', '飆漲', '噴出', '創新高', '創高', '新高', '天價', '長紅', '暴增', '利多', '報喜', '亮眼', '突破', '大單', '接單', '訂單', '擴產', '漲價', '調漲', '超預期', '大賺', '獲利創', '營收創', '買超', '回購', '庫藏股', '大進補'];
const BULL_MILD = ['上漲', '走高', '走揚', '齊揚', '勁揚', '成長', '看好', '增持', '樂觀', '回升', '回神', '轉強', '轉機', '加碼', '受惠', '正面', '優於', '強攻', '點火', '旺'];
const BEAR_STRONG = ['跌停', '重挫', '暴跌', '崩', '崩跌', '跳水', '殺盤', '下殺', '破底', '摜破', '新低', '虧損', '大跌', '利空', '下修', '減產', '砍單', '衰退', '違約', '處置', '財報不佳', '認列', '虧', '賣超', '減持', '降評', '爆雷', '踩雷', '翻黑'];
const BEAR_MILD = ['下跌', '走低', '收黑', '疲弱', '看淡', '保守', '回檔', '拉回', '轉弱', '壓力', '負面', '遜於', '示警', '警示', '賣壓', '獲利了結'];
// Long-validity (≈10d): fundamental/structural news. Medium (≈5d): analyst/法說. Else short (≈2d).
const LONG_KW = ['財報', '營收', '法說', '併購', '接單', '訂單', '擴產', '新廠', '認列', '配息', '股利', '增資', '減資', '財測'];
const MED_KW = ['目標價', '評等', '降評', '升評', '分析師', '外資', '投信', '研究報告', '展望'];

function classify(title: string): { sentiment: number; kind: ScoredNewsItem['kind']; validDays: number } {
  const t = title;
  let s = 0;
  if (BULL_STRONG.some(k => t.includes(k))) s += 2;
  else if (BULL_MILD.some(k => t.includes(k))) s += 1;
  if (BEAR_STRONG.some(k => t.includes(k))) s -= 2;
  else if (BEAR_MILD.some(k => t.includes(k))) s -= 1;
  // clamp to ±2
  s = Math.max(-2, Math.min(2, s));
  const kind: ScoredNewsItem['kind'] = s > 0 ? 'bull' : s < 0 ? 'bear' : 'neutral';
  const validDays = LONG_KW.some(k => t.includes(k)) ? 10 : MED_KW.some(k => t.includes(k)) ? 5 : 2;
  return { sentiment: s, kind, validDays };
}

const toDate = (iso?: string): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const normTitle = (t: string) => t.replace(/[\s\p{P}]/gu, '').slice(0, 24);
// 相似度用**完整**正規化標題（normTitle 截 24 字是給精確去重用的）。
const normFull = (t: string) => t.replace(/[\s\p{P}]/gu, '');
// 中文標題相似度：字元 bigram 的 Dice 係數。
// 為什麼不用「完全相同」：同一則故事被各家改寫標題重發，正規化後仍然不同
//   （實測 2330：「台積電8月分紅開獎 工程師年薪上看600萬」與
//     「台積電8月分紅開獎！工程師年薪上看600萬元」是兩筆），
//   於是同一件事被重複計分——聚合又是累加不是平均，直接放大槓桿。
const bigrams = (t: string) => {
  const x = normFull(t); const out = new Set<string>();
  for (let i = 0; i < x.length - 1; i++) out.add(x.slice(i, i + 2));
  return out;
};
const dice = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const g of a) if (b.has(g)) inter++;
  return (2 * inter) / (a.size + b.size);
};
const SIM_THRESHOLD = 0.6;   // 實測門檻：同故事改寫 ≥0.6，不同故事 <0.4

/** Approx calendar days for a validity expressed in trading days (×1.4 for weekends). */
const calDays = (tradingDays: number) => Math.ceil(tradingDays * 1.4);

/**
 * Analyse a list of news items into a sentiment score. `nowMs` lets callers
 * pass a deterministic clock (defaults to Date.now()).
 */
export function analyzeNews(items: NewsLite[], nowMs = Date.now()): NewsSentiment {
  const seen = new Set<string>();
  const scored: ScoredNewsItem[] = [];

  for (const it of items || []) {
    if (!it?.title) continue;
    // 有 AI 判別時用判別產出時間算衰減（理由見 NewsLite.verdictAt）
    const date = toDate(
      it.verdictBasis === 'content' && it.verdictAt ? it.verdictAt : it.time
    );
    // Dedup: same date + same (normalised) content counted once.
    const key = `${date}|${normTitle(it.title)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // ⚠ 有 AI 內文判別時，**幅度也必須來自它**，不能只把 basis 標成 content
    //   卻仍用標題關鍵字算大小——那等於換個名義違反同一條規則。
    //   信心度直接縮放幅度：判別自己說「低」的時候就不該有滿分的影響力。
    const cls = classify(it.title);
    const useAI = it.verdictBasis === 'content' && !!it.verdict;
    const confK = it.verdictConfidence === '高' ? 1 : it.verdictConfidence === '中' ? 0.7 : 0.4;
    // 強度決定幅度、信心決定折扣。兩者相乘後的可用範圍是 0.24 ~ 3.0（12 倍），
    // 舊版只有 0.8 ~ 2.0（2.5 倍）——那個範圍不足以區分「營收年增 200%」
    // 與「取得一張認證」，也就無法用來跨個股排高低。
    const strK = it.verdictStrength === '極強' ? 3
      : it.verdictStrength === '強' ? 2
      : it.verdictStrength === '弱' ? 0.6 : 1.2;   // 缺值保守取「中」
    const sentiment = useAI
      ? (it.verdict === '利多' ? 1 : it.verdict === '利空' ? -1 : 0) * strK * confK
      : cls.sentiment;
    const kind: 'bull' | 'bear' | 'neutral' = useAI
      ? (sentiment > 0 ? 'bull' : sentiment < 0 ? 'bear' : 'neutral')
      : cls.kind;
    // 有效期仍依新聞**類型**判定（基本面 10 日／法說 5 日／其他 2 日），
    // 這與判別方向無關，沿用 classify 的結果。
    const validDays = cls.validDays;
    // Time-decay weight: linear from 1 (fresh) → 0 at expiry; expired = 0.
    let weight = 1;
    if (date) {
      const ageDays = (nowMs - new Date(date + 'T00:00:00+08:00').getTime()) / 86_400_000;
      const window = calDays(validDays);
      weight = ageDays <= 0 ? 1 : ageDays >= window ? 0 : 1 - ageDays / window;
    }
    weight = parseFloat(weight.toFixed(2));
    scored.push({
      title: it.title, source: it.source, url: it.url, date,
      sentiment, kind, validDays, weight,
      effective: parseFloat((sentiment * weight).toFixed(2)),
      verdictBasis: it.verdictBasis === 'content' ? 'content' : 'title',
      verdict: it.verdict,
    });
  }

  // ⛔ **硬規定（使用者 2026-08-29 明令）：只用標題絕對不得調分。**
  //   合法的調分來源只有一種——AI 讀完內文後給出的利多/利空判別。
  //   理由（docs/EXPERIMENTS.md）：只憑標題的判別實測**與結果反向**，
  //   而讀完內文的 AI 判別因為還在累積 newsLift 反而刻意不加權
  //   ⇒ 等於最粗糙的方法拿到最大的實權，紀律完全顛倒。
  //   實測 2026-08-29 線上 /api/rating：2454 吃滿 +20 → 100 分 STRONG_BUY、
  //   2330 +18 → 100 分 STRONG_BUY，全部出自標題關鍵字。
  //   ⚠ 聚合是 sum/4 的**累加**不是平均 ⇒ 餵進來的新聞越多槓桿越大，
  //     任何擴大新聞來源的改動都會 silently 放大它。這道閘門必須寫在程式裡。
  // ── 同故事分群 → **群內先取平均**，再以「一則故事」的身分參與聚合 ──
  //   （使用者 2026-08-29 指示：標題類似的新聞，判定用平均分後再聚合）
  //   同一則故事被各家改寫標題重發是常態，逐篇累加等於同一件事重複計分；
  //   聚合又是 sum/4 的累加不是平均 ⇒ 來源越多、槓桿越大。
  //   實測 2330：分紅那則有 2 種寫法、永續報告書那則有 2 種寫法，
  //   Dice 相似度 0.974 / 0.745，都會被併成一群。
  //   ⚠ 誠實的限制：用詞幾乎不重疊的重改寫（如「台積Q2分紅360億」⇄
  //     「台積電第2季員工酬勞約360億元創高」，Dice 僅 0.211）標題比對抓不到。
  //     不為了它降門檻——那會把不相干的新聞併成一群。要抓它得比對內文。
  // ⚠ 「AI 判為中性」≠「還沒判別」。中性的 sentiment 是 0，會被 active 濾掉，
  //   若只看 gradedCount 就會誤報成「未判別」——那是把兩個不同狀態說成同一個。
  // ⚠ 要加 weight > 0：判別過期（超過有效期、權重衰減到 0）之後，
  //   若仍回報 judgedByAI=true，畫面會說「AI內文判別為中性」，
  //   但真相是**判別已失效**。兩者對使用者的意義完全不同。
  //   （daemon 掛掉時 latest 會一直供舊判別，這道檢查是最後一層保護。）
  const judgedByAI = scored.some(s => s.verdictBasis === 'content' && s.weight > 0);
  // 「資訊不足」單獨辨識——它不是中性，不可混為一談
  const inconclusive = scored.some(s => s.verdictBasis === 'content' && s.weight > 0 && s.verdict === '資訊不足')
    && !scored.some(s => s.verdictBasis === 'content' && s.weight > 0 && s.verdict !== '資訊不足');
  const active = scored.filter(s => s.weight > 0 && s.sentiment !== 0);
  const clusters: ScoredNewsItem[][] = [];
  const grams = new Map<ScoredNewsItem, Set<string>>();
  for (const it of active) {
    const g = bigrams(it.title);
    grams.set(it, g);
    const hit = clusters.find(c => dice(grams.get(c[0])!, g) >= SIM_THRESHOLD);
    if (hit) hit.push(it); else clusters.push([it]);
  }
  // 一群 = 一則故事。群內取平均，權重取**最新**那篇（故事的新鮮度以最新一次發佈為準）。
  // 同一事件最多採計 3 篇（使用者 2026-08-29 指定），取**最新的 3 篇**。
  // 一群＝一個事件，這 3 篇合起來只產出**一個**結果與權重，不是三份貢獻。
  // 為什麼要設上限而不是全取平均：某些事件會被十幾家改寫轉發，
  // 全取平均等於讓「被轉發次數」影響結果，那是媒體行為不是事件本身。
  const STORY_MAX = 3;
  const stories = clusters.map(cRaw => {
    const c = cRaw.slice().sort((a, b) =>
      new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, STORY_MAX);
    // 有內文判別的成員存在時，平均只取那些——否則等於讓標題判斷混進計分。
    const withContent = c.filter(x => x.verdictBasis === 'content');
    const base = withContent.length ? withContent : c;
    const sentiment = base.reduce((a, x) => a + x.sentiment, 0) / base.length;
    const weight = Math.max(...c.map(x => x.weight));   // 取這 3 篇裡最新的權重
    return {
      sentiment,
      weight,
      effective: parseFloat((sentiment * weight).toFixed(2)),
      verdictBasis: withContent.length ? 'content' as const : 'title' as const,
      size: cRaw.length,        // 原始篇數（揭露被轉發幾次），採計則以 c 為準
    };
  });
  const graded = stories.filter(x => x.verdictBasis === 'content');
  const sum = graded.reduce((a, x) => a + x.effective, 0);
  const newsScore = Math.max(-1, Math.min(1, sum / 4));
  const adjustment = Math.round(newsScore * 20);
  // 口徑：bull/bear 改算**故事數**而非篇數，否則同一件事會被數很多次。
  const bull = stories.filter(x => x.sentiment > 0).length;
  const bear = stories.filter(x => x.sentiment < 0).length;
  // 沒有任何內文判別時要**據實說「未判別」**，不可留白讓人以為新聞已納入評估。
  const label = graded.length === 0
    ? (inconclusive ? 'AI 讀完內文但資訊不足，無法判斷（不計分）'
       : judgedByAI ? 'AI內文判別為中性（不影響評分）'
       : '未判別（尚無AI內文判別，不計分）')
    : newsScore > 0.15 ? '偏多' : newsScore < -0.15 ? '偏空' : '中性';

  return {
    newsScore: parseFloat(newsScore.toFixed(2)),
    adjustment, bull, bear, total: scored.length, label,
    // ⚠ total − storyCount 不可解讀為「重複稿數」：中間還隔著一道
    //   「中性不進分群」的過濾。兩個原因混成一個數字就會誤導
    //   （實測 2891/6526：25 篇全判中性 ⇒ storyCount 0，不是 25 篇重複）。
    //   所以中間這層必須顯式揭露。
    judgedByAI,                      // 是否已有 AI 內文判別（中性也算判過）
    inconclusive,                    // AI 讀了但資訊不足（與中性分開）
    // 只在真的有理由時才給——沒有就留 undefined，讓下游顯示原本的文字，不編造
    verdictReason: (items || []).find(x => x?.verdictBasis === 'content' && x?.verdictReason)?.verdictReason,
    ratedCount: active.length,       // 有多空傾向的篇數
    storyCount: stories.length,      // 併群後的**故事數**（同故事只算一則）
    gradedCount: graded.length,      // 真正參與調分的故事數（＝有內文判別的）
    items: scored.sort((a, b) => Math.abs(b.effective) - Math.abs(a.effective)).slice(0, 12),
  };
}
