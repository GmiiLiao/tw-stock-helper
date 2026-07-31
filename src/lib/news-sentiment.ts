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

export interface NewsLite { title: string; time?: string; source?: string; url?: string }

export interface ScoredNewsItem {
  title: string; source?: string; url?: string;
  date: string;            // YYYY-MM-DD
  sentiment: number;       // signed magnitude (-2..+2) at publish
  kind: 'bull' | 'bear' | 'neutral';
  validDays: number;       // 有效期（交易日）
  weight: number;          // current time-decayed weight (0..1); 0 = expired
  effective: number;       // sentiment * weight (contribution)
}

export interface NewsSentiment {
  newsScore: number;       // aggregate ∈ [-1, +1]
  adjustment: number;      // ±20-point score adjustment (20% weight)
  bull: number;            // # active bullish items
  bear: number;            // # active bearish items
  total: number;           // # de-duped items considered
  label: string;           // 偏多 / 偏空 / 中性
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
    const date = toDate(it.time);
    // Dedup: same date + same (normalised) content counted once.
    const key = `${date}|${normTitle(it.title)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const { sentiment, kind, validDays } = classify(it.title);
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
    });
  }

  // Aggregate active (weight>0) contributions; ~4 weighted points → saturate ±1.
  const active = scored.filter(s => s.weight > 0 && s.sentiment !== 0);
  const sum = active.reduce((a, s) => a + s.effective, 0);
  const newsScore = Math.max(-1, Math.min(1, sum / 4));
  const adjustment = Math.round(newsScore * 20);
  const bull = active.filter(s => s.sentiment > 0).length;
  const bear = active.filter(s => s.sentiment < 0).length;
  const label = newsScore > 0.15 ? '偏多' : newsScore < -0.15 ? '偏空' : '中性';

  return {
    newsScore: parseFloat(newsScore.toFixed(2)),
    adjustment, bull, bear, total: scored.length, label,
    items: scored.sort((a, b) => Math.abs(b.effective) - Math.abs(a.effective)).slice(0, 12),
  };
}
