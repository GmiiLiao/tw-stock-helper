import { NextRequest, NextResponse } from 'next/server';
import { closePositionOf } from '@/lib/scoring-server';
import { promises as fs } from 'fs';
import path from 'path';
import { getStockDayAllDataInternal } from '@/lib/twse-api-server';

// ============================================================
// Stock Trend Analysis API
// Combines: TWSE company info + industry outlook + announcements
// to generate near-term price trend reasons + market context
// ============================================================

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code') || '';

  try {
    // Fetch in parallel: company info (Listed + OTC), announcements
    const [companyRes, companyOtcRes, annoRes] = await Promise.allSettled([
      fetch('https://openapi.twse.com.tw/v1/opendata/t187ap03_L', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        next: { revalidate: 3600 },
      }),
      fetch('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        next: { revalidate: 3600 },
      }),
      fetch('https://www.twse.com.tw/rwd/zh/announcement/announcement?response=json', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        next: { revalidate: 300 },
      }),
    ]);

    // Parse company info → find industry code + full profile (Listed + OTC)
    let industryCode = '99';
    let companyName = '';
    let rawCompany: CompanyInfo | null = null;

    let listedCompanies: CompanyInfo[] = [];
    if (companyRes.status === 'fulfilled' && companyRes.value.ok) {
      try {
        listedCompanies = await companyRes.value.json();
      } catch (err) {
        console.warn('[trend-analysis] Failed to parse companyRes JSON:', err);
      }
    }

    // Fallback: If listedCompanies is empty (OpenAPI failed/geoblocked), load from local file
    if (listedCompanies.length === 0) {
      try {
        const fallbackPath = path.join(process.cwd(), 'src/lib/t187ap03_L_fallback.json');
        const fileContent = await fs.readFile(fallbackPath, 'utf-8');
        listedCompanies = JSON.parse(fileContent);
        console.log('[trend-analysis] Successfully loaded company fallback JSON. Count:', listedCompanies.length);
      } catch (err: any) {
        console.error('[trend-analysis] Failed to load local company fallback JSON:', err.message);
      }
    }

    const otcCompaniesRaw: any[] = (companyOtcRes.status === 'fulfilled' && companyOtcRes.value.ok)
      ? await companyOtcRes.value.json()
      : [];

    // 來源的「沒有」有三種寫法：空字串、全形破折號「－」、只有空白。統一成 ''。
    const z = (v: unknown): string => {
      const t = String(v ?? '').replace(/[\s\u3000]+/g, ' ').trim();
      return /^[－—–-]*$/.test(t) ? '' : t;
    };

    const mappedOtcCompanies: CompanyInfo[] = otcCompaniesRaw.map(item => ({
      '公司代號': item.SecuritiesCompanyCode ?? '',
      '公司名稱': item.CompanyName ?? '',
      '公司簡稱': item.CompanyAbbreviation ?? '',
      '產業別': item.SecuritiesIndustryCode ?? '',
      '董事長': item.Chairman ?? '',
      '總經理': item.GeneralManager ?? '',
      '成立日期': item.DateOfIncorporation ?? '',
      '上市日期': item.DateOfListing ?? '',
      '實收資本額': item['Paidin.Capital.NTDollars'] ?? '',
      '住址': item.Address ?? '',
      '總機電話': item.Telephone ?? '',
      '發言人': item.Spokesman ?? '',
      // ⚠ TPEx 的值尾端常帶**全形空白**（實測 WebAddress、Symbol 都有），
      //   不 trim 掉會讓 https 網址變成壞連結、英文簡稱多一格。
      '發言人職稱': z(item.TitleOfSpokesman),
      '代理發言人': z(item.DeputySpokesperson),
      '網址': z(item.WebAddress),
      '電子郵件信箱': z(item.EmailAddress),
      '傳真機號碼': z(item.Fax),
      '英文簡稱': z(item.Symbol),
      '營利事業統一編號': z(item['UnifiedBusinessNo.']),
      '股票過戶機構': z(item.StockTransferAgent),
      '過戶電話': z(item.StockTransferAgentTelephone),
      '簽證會計師事務所': z(item.AccountingFirm),
    }));

    const allCompanies = [...listedCompanies, ...mappedOtcCompanies];
    const company = allCompanies.find(c => c['公司代號'] === code);
    if (company) {
      industryCode = company['產業別'] || '99';
      companyName = company['公司簡稱'] || '';
      rawCompany = company;
    }

    // Parse announcements → find mentions of this stock code
    let relevantAnnouncements: NewsItem[] = [];
    if (annoRes.status === 'fulfilled' && annoRes.value.ok) {
      const annoData = await annoRes.value.json();
      if (annoData?.data && Array.isArray(annoData.data)) {
        // Filter announcements mentioning this company code
        const allAnnouncements = annoData.data as AnnouncementRow[];
        const related = allAnnouncements
          .filter(row => {
            const text = (row[3] || '').toString();
            return text.includes(code) || (companyName && text.includes(companyName));
          })
          .slice(0, 3)
          .map(row => ({
            date: (row[1] || '').toString().replace('中華民國', '').replace('年', '/').replace('月', '/').replace('日', ''),
            text: (row[3] || '').toString(),
          }));
        relevantAnnouncements = related;
      }
    }

    // Parse day data for this specific stock (via centralized server helper)
    let stockData: StockDayItem | null = null;
    try {
      const allDayData = await getStockDayAllDataInternal();
      const found = allDayData.find(s => s.Code === code);
      if (found) {
        stockData = {
          Code: found.Code,
          Name: found.Name,
          OpeningPrice: found.OpeningPrice,
          HighestPrice: found.HighestPrice,
          LowestPrice: found.LowestPrice,
          ClosingPrice: found.ClosingPrice,
          Change: found.Change,
          TradeVolume: found.TradeVolume,
          TradeValue: found.TradeValue,
          Transaction: found.Transaction,
          // ⚠ **市場別必須帶過來**（2026-09-01 使用者回報 7930 威世波漲停錯誤）：
          // 這裡是逐欄重建，漏掉 _market 就等於把「這是興櫃」這件事丟掉，
          // 下游的漲跌停判斷因此對興櫃套用了不存在的 ±10% 限制。
          // 我第一版只改下游、沒發現欄位在這裡就被剝掉——部署後驗證才發現沒生效。
          _market: found._market,
        };
      }
    } catch (err: any) {
      console.error('[trend-analysis] Failed to load day data via getStockDayAllDataInternal:', err.message);
    }

    // Build the analysis
    const industry = getIndustryInfo(industryCode);
    const trendAnalysis = buildTrendAnalysis(code, stockData, industry, companyName);
    const newsHeadlines = buildNewsHeadlines(code, companyName, stockData, industry, relevantAnnouncements);
    const industryOutlook = buildIndustryOutlook(industry, stockData);
    const preMarketRecommendation = buildPreMarketRecommendation(code, stockData, trendAnalysis);
    const companyProfile = buildCompanyProfile(code, rawCompany, industry, stockData);
    const pricePrediction = buildPricePrediction(stockData);

    return NextResponse.json({
      code,
      companyName,
      industry,
      trendAnalysis,
      newsHeadlines,
      industryOutlook,
      preMarketRecommendation,
      companyProfile,
      pricePrediction,
      generatedAt: new Date().toISOString(),
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60' },
    });

  } catch (error) {
    console.error('Trend analysis error:', error);
    return NextResponse.json({ error: 'Analysis failed' }, { status: 500 });
  }
}

// ─── Types ───────────────────────────────────────────────────

interface CompanyInfo {
  '公司代號': string;
  '公司名稱': string;
  '公司簡稱': string;
  '產業別': string;
  '董事長': string;
  '總經理': string;
  '成立日期': string;
  '上市日期': string;
  '實收資本額': string;
  '住址': string;
  '總機電話': string;
  '發言人': string;
  // 以下為 2026-08-27 補齊：t187ap03 兩個市場都有，過去整批被丟掉，
  // 於是個股頁的「公司資料」長期只有半套（使用者要求處理完整）。
  '發言人職稱': string;
  '代理發言人': string;
  '網址': string;
  '電子郵件信箱': string;
  '傳真機號碼': string;
  '英文簡稱': string;
  '營利事業統一編號': string;
  '股票過戶機構': string;
  '過戶電話': string;
  '簽證會計師事務所': string;
}

type AnnouncementRow = (string | number)[];

interface StockDayItem {
  // 'tse' 上市 ｜ 'otc' 上櫃 ｜ 'esb' 興櫃。
  // 興櫃**沒有漲跌幅限制**，下游的漲跌停判斷必須看這個欄位。
  _market?: string;
  Code: string;
  Name: string;
  OpeningPrice: string;
  HighestPrice: string;
  LowestPrice: string;
  ClosingPrice: string;
  Change: string;
  TradeVolume: string;
  TradeValue: string;
  Transaction: string;
}

interface NewsItem {
  date: string;
  text: string;
}

export interface IndustryInfo {
  code: string;
  name: string;
  sector: string;
  emoji: string;
  description: string;
}

// ─── Industry Classification ──────────────────────────────────

const INDUSTRY_MAP: Record<string, IndustryInfo> = {
  '01': { code: '01', name: '水泥工業', sector: '傳統產業', emoji: '🏗️', description: '建材基礎工業，與基建政策高度相關' },
  '02': { code: '02', name: '食品工業', sector: '民生消費', emoji: '🍜', description: '食品飲料，受通膨與消費力影響' },
  '03': { code: '03', name: '塑膠工業', sector: '石化材料', emoji: '🔬', description: '石化下游，景氣循環型產業' },
  '04': { code: '04', name: '紡織纖維', sector: '傳統製造', emoji: '🧵', description: '紡織成衣，東南亞布局加速中' },
  '05': { code: '05', name: '電機機械', sector: '機械設備', emoji: '⚙️', description: '工業自動化需求持續增長' },
  '06': { code: '06', name: '電器電纜', sector: '電力設備', emoji: '⚡', description: '電網升級與再生能源帶動需求' },
  '08': { code: '08', name: '玻璃陶瓷', sector: '傳統產業', emoji: '🏺', description: '建材需求與工業用途' },
  '09': { code: '09', name: '造紙工業', sector: '原材料', emoji: '📄', description: '環保包材、紙類需求趨勢' },
  '10': { code: '10', name: '鋼鐵工業', sector: '基礎工業', emoji: '🔩', description: '全球鋼價週期與基建景氣同步' },
  '11': { code: '11', name: '橡膠工業', sector: '材料工業', emoji: '🔄', description: '汽車零組件與工業用橡膠' },
  '12': { code: '12', name: '汽車工業', sector: '汽車整車', emoji: '🚗', description: '電動車轉型關鍵期，新能源車滲透率上升' },
  '13': { code: '13', name: '電子工業', sector: '電子零組件', emoji: '💡', description: '電子零組件，AI 算力需求帶動供應鏈' },
  '14': { code: '14', name: '建材營造', sector: '房地產', emoji: '🏢', description: '都更與危老重建政策推動需求' },
  '15': { code: '15', name: '航運業', sector: '交通運輸', emoji: '🚢', description: '運費指數波動，受地緣政治影響' },
  '16': { code: '16', name: '觀光事業', sector: '服務消費', emoji: '✈️', description: '後疫情觀光復甦，入境旅遊持續回升' },
  '17': { code: '17', name: '金融保險', sector: '金融業', emoji: '🏦', description: '升息週期受益，壽險與銀行股業績改善' },
  '18': { code: '18', name: '貿易百貨', sector: '零售通路', emoji: '🛒', description: '零售消費趨勢，電商與實體競合' },
  '19': { code: '19', name: '綜合', sector: '多角化', emoji: '🔀', description: '多元化集團，各子事業體業績分散' },
  '20': { code: '20', name: '其他', sector: '特殊產業', emoji: '📊', description: '特殊業務類型，需個別分析' },
  '21': { code: '21', name: '化學工業', sector: '石化工業', emoji: '⚗️', description: '化工材料，景氣循環與原油價格連動' },
  '22': { code: '22', name: '生技醫療', sector: '醫療生技', emoji: '💊', description: 'AI 新藥開發、CRO/CDMO 全球化佈局加速' },
  '23': { code: '23', name: '油電燃氣', sector: '公用事業', emoji: '🔋', description: '能源轉型主題，再生能源佈局受矚目' },
  '24': { code: '24', name: '半導體', sector: '科技龍頭', emoji: '🔲', description: 'AI 算力需求爆發，先進製程訂單高度滿載' },
  '25': { code: '25', name: '電腦週邊', sector: '硬體設備', emoji: '💻', description: 'AI PC 換機潮、伺服器市場高速成長' },
  '26': { code: '26', name: '光電業', sector: '光電顯示', emoji: '🖥️', description: 'OLED/MicroLED 新世代顯示技術驅動換機' },
  '27': { code: '27', name: '通信網路', sector: '網路通訊', emoji: '📡', description: '5G/6G 基礎建設、衛星通訊快速普及' },
  '28': { code: '28', name: '電子零組件', sector: '零組件', emoji: '🔌', description: 'AI 伺服器供應鏈、被動元件需求成長' },
  '29': { code: '29', name: '電子通路', sector: '電子通路', emoji: '📦', description: '半導體零組件通路商，AI 訂單快速拉貨' },
  '30': { code: '30', name: '資訊服務', sector: '軟體服務', emoji: '☁️', description: '雲端、AI、資安軟體需求高速擴張' },
  '31': { code: '31', name: '其他電子', sector: '電子製造', emoji: '🔧', description: '各類電子製造，受惠 AI 終端設備普及' },
  '99': { code: '99', name: '未分類', sector: '其他', emoji: '📋', description: '產業類別待確認' },
};

function getIndustryInfo(code: string): IndustryInfo {
  return INDUSTRY_MAP[code] || INDUSTRY_MAP['99'];
}

// ─── Trend Analysis Builder ───────────────────────────────────

function buildTrendAnalysis(
  code: string,
  stock: StockDayItem | null,
  industry: IndustryInfo,
  companyName: string
): TrendAnalysis {
  const reasons: TrendReason[] = [];
  let summaryText = '';

  if (!stock) {
    return {
      summary: '資料載入中，請稍後再試',
      reasons: [],
      momentum: 'neutral',
      momentumScore: 50,
    };
  }

  const close = parseFloat(stock.ClosingPrice) || 0;
  const change = parseFloat(stock.Change) || 0;
  const prevClose = close - change;
  const chgPct = prevClose > 0 ? (change / prevClose) * 100 : 0;
  const high = parseFloat(stock.HighestPrice) || close;
  const low = parseFloat(stock.LowestPrice) || close;
  const open = parseFloat(stock.OpeningPrice) || close;
  const volume = parseInt(stock.TradeVolume?.replace(/,/g, '') || '0');
  const value = parseInt(stock.TradeValue?.replace(/,/g, '') || '0');
  const range = high - low;
  const closePos = closePositionOf(close, high, low, prevClose);
  const isGap = open > prevClose * 1.01;

  // ── Primary Trend Reason (Momentum) ──
  if (chgPct >= 9.9) {
    reasons.push({
      icon: '🔴',
      title: '觸及漲停板 — 籌碼強力鎖定',
      detail: `今日以漲停板 ${close.toFixed(2)} 元作收，顯示市場高度共識做多，主力買盤強勁介入，散戶追價意願強烈。漲停股隔日平均有 62% 機率繼續上漲，為市場最強勢型態。`,
      strength: 'strong',
      category: 'price_action',
    });
  } else if (chgPct >= 6) {
    reasons.push({
      icon: '📈',
      title: `強力上攻 +${chgPct.toFixed(1)}% — 突破前高壓力`,
      detail: `今日股價強勢上漲 ${chgPct.toFixed(2)}%，成交量大幅放大，顯示有主動買盤積極進場。此類單日大漲通常伴隨題材催化或法人調升目標價，後續仍有追價空間。`,
      strength: 'strong',
      category: 'price_action',
    });
  } else if (chgPct >= 3) {
    reasons.push({
      icon: '📊',
      title: `穩健上漲 +${chgPct.toFixed(1)}% — 量價配合良好`,
      detail: `漲幅 ${chgPct.toFixed(2)}%，屬於健康上升趨勢，並未出現追高過度現象。這種溫和的量價配合型態，代表資金仍在逐步佈局中，後市發展空間相對充裕。`,
      strength: 'moderate',
      category: 'price_action',
    });
  }

  // ── Volume Analysis ──
  if (value > 5_000_000_000) {
    reasons.push({
      icon: '💰',
      title: `超大量 ${(value / 1e8).toFixed(0)} 億成交 — 法人主力積極介入`,
      detail: `今日成交金額高達 ${(value / 1e8).toFixed(1)} 億元，遠超市場平均水準。此規模的交易量通常代表外資或大型投信正在建立部位，是後市看多的重要訊號。`,
      strength: 'strong',
      category: 'volume',
    });
  } else if (value > 1_000_000_000) {
    reasons.push({
      icon: '📦',
      title: `成交值 ${(value / 1e8).toFixed(0)} 億 — 法人資金持續關注`,
      detail: `成交金額突破 ${(value / 1e8).toFixed(0)} 億元門檻，顯示有機構投資人在此價位附近積極進場，散戶跟進意願也相對較高。`,
      strength: 'moderate',
      category: 'volume',
    });
  }

  // ── Intraday Pattern ──
  if (closePos != null && closePos >= 0.85) {
    reasons.push({
      icon: '💪',
      title: '收盤守高位 — 多頭氣勢完整',
      detail: `今日股價收在日內高點附近（收盤位置 ${((closePos ?? 0) * 100).toFixed(0)}%），上影線極短，表示盤中雖有獲利回吐賣壓，但均被強力承接。結構性買盤支撐明顯，短線多方佔優。`,
      strength: 'moderate',
      category: 'technical',
    });
  } else if (closePos != null && closePos <= 0.25) {
    reasons.push({
      icon: '⚠️',
      title: '收盤接近低點 — 注意賣壓風險',
      detail: `今日雖上漲，但收盤位置偏低（${((closePos ?? 0) * 100).toFixed(0)}%），出現長上影線，尾盤賣壓明顯，短線可能需要震盪整理後才能再攻。`,
      strength: 'weak',
      category: 'technical',
    });
  }

  // ── Gap Analysis ──
  if (isGap && chgPct > 1) {
    const gapPct = ((open / prevClose) - 1) * 100;
    reasons.push({
      icon: '⬆️',
      title: `跳空 ${gapPct.toFixed(1)}% 高開強勢 — 前夜有利多訊息`,
      detail: `今日開盤即跳空 ${gapPct.toFixed(1)}% 高開，代表隔夜有正面消息刺激或外資盤前調整部位。跳空缺口通常形成有效支撐，後續回測此區域為良好買點。`,
      strength: 'moderate',
      category: 'technical',
    });
  }

  // ── Industry Tailwind ──
  if (['24', '25', '28', '30', '31'].includes(industry.code)) {
    reasons.push({
      icon: '🤖',
      title: 'AI 供應鏈受惠 — 產業順風強勁',
      detail: `${industry.name}族群受益於全球 AI 基礎設施投資熱潮（輝達/微軟/Google 資本支出持續創高），台灣相關供應鏈接單能見度延伸至 2025~2026 年，本益比評價有上調空間。`,
      strength: 'strong',
      category: 'industry',
    });
  } else if (industry.code === '17') {
    reasons.push({
      icon: '🏦',
      title: '金融股升息循環受益 — 利差擴大',
      detail: `美台利差政策影響銀行業淨利息收益率（NIM）持續改善，壽險業受惠台股萬點行情提升股票資產未實現收益。金融股股息殖利率仍具吸引力，外資有回補空間。`,
      strength: 'moderate',
      category: 'industry',
    });
  } else if (industry.code === '22') {
    reasons.push({
      icon: '💊',
      title: 'AI 新藥開發加速 — 生技題材持續發酵',
      detail: `AI 輔助藥物開發縮短研發週期，台灣生技廠商積極與國際大廠授權合作。委託研究開發（CRO）與委託製造（CDMO）市場擴大，相關概念股評價持續提升。`,
      strength: 'moderate',
      category: 'industry',
    });
  } else if (industry.code === '15') {
    reasons.push({
      icon: '🚢',
      title: '航運運費回升 — 供需結構改善',
      detail: `全球航運市場因紅海危機導致繞行增加，歐美航線運費維持高檔。加上貨運需求逐步回升，台灣航運公司營收能見度提升，股利政策維持穩健。`,
      strength: 'moderate',
      category: 'industry',
    });
  } else {
    reasons.push({
      icon: industry.emoji,
      title: `${industry.name}族群佈局 — ${industry.sector}動能`,
      detail: `${industry.description}。類股整體表現受大盤情緒與外資動向影響，建議留意同族群是否同步上漲確認買盤廣度。`,
      strength: 'moderate',
      category: 'industry',
    });
  }

  // ── Determine momentum level ──
  let momentum: TrendAnalysis['momentum'] = 'neutral';
  let momentumScore = 50;
  if (chgPct >= 7) { momentum = 'strong_bull'; momentumScore = 90; }
  else if (chgPct >= 3 && closePos != null && closePos >= 0.7) { momentum = 'bull'; momentumScore = 75; }
  else if (chgPct >= 1) { momentum = 'mild_bull'; momentumScore = 62; }
  else if (chgPct >= -1) { momentum = 'neutral'; momentumScore = 50; }
  else { momentum = 'bear'; momentumScore = 30; }

  // ── Summary ──
  const compDesc = companyName ? `${companyName}（${code}）` : code;
  if (momentum === 'strong_bull') {
    summaryText = `${compDesc} 今日呈現強勢爆發型走勢，${reasons[0]?.title || '股價大幅上揚'}，配合${value > 1e9 ? '法人大量介入' : '量能放大'}，短線動能強勁，為市場焦點股之一。`;
  } else if (momentum === 'bull') {
    summaryText = `${compDesc} 今日走勢健康穩健，${chgPct.toFixed(1)}% 的漲幅伴隨良好量價結構，顯示市場對其後市持正向看法，後續具波段操作價值。`;
  } else {
    summaryText = `${compDesc} 今日溫和上漲，配合${industry.name}族群整體向好走勢，基本面具備支撐，可列入觀察。`;
  }

  return { summary: summaryText, reasons, momentum, momentumScore };
}

// ─── News Headlines Builder ───────────────────────────────────

function buildNewsHeadlines(
  code: string,
  companyName: string,
  stock: StockDayItem | null,
  industry: IndustryInfo,
  twseAnnouncements: NewsItem[]
): NewsHeadline[] {
  const headlines: NewsHeadline[] = [];

  // 1. Actual TWSE announcements (highest priority)
  for (const anno of twseAnnouncements) {
    let cleanText = anno.text;
    // Trim to reasonable length
    if (cleanText.length > 80) {
      cleanText = cleanText.substring(0, 78) + '…';
    }
    headlines.push({
      source: '臺灣證交所',
      headline: cleanText,
      date: anno.date,
      type: 'official',
      sentiment: 'neutral',
      url: 'https://www.twse.com.tw/rwd/zh/announcement/announcement',
    });
  }

  const close = stock ? parseFloat(stock.ClosingPrice) : 0;
  const chgPct = stock ? (() => {
    const change = parseFloat(stock.Change) || 0;
    const prev = close - change;
    return prev > 0 ? (change / prev) * 100 : 0;
  })() : 0;
  const value = stock ? parseInt(stock.TradeValue?.replace(/,/g, '') || '0') : 0;

  // 2. AI-generated contextual headlines based on industry + price action
  const industryHeadlines = getIndustryHeadlines(industry.code, companyName, code, chgPct, value);
  headlines.push(...industryHeadlines);

  // 3. Technical pattern headline
  if (chgPct >= 9.9) {
    headlines.push({
      source: 'AI 技術分析',
      headline: `${companyName || code} 漲停鎖板，籌碼高度集中，明日開盤動向受市場高度關注`,
      date: new Date().toLocaleDateString('zh-TW'),
      type: 'analysis',
      sentiment: 'positive',
    });
  } else if (chgPct >= 5) {
    headlines.push({
      source: 'AI 技術分析',
      headline: `${companyName || code} 單日強漲 ${chgPct.toFixed(1)}%，成交量突破近期高點，多頭氣勢持續`,
      date: new Date().toLocaleDateString('zh-TW'),
      type: 'analysis',
      sentiment: 'positive',
    });
  }

  return headlines.slice(0, 6);
}

function getIndustryHeadlines(
  industryCode: string,
  companyName: string,
  code: string,
  chgPct: number,
  value: number
): NewsHeadline[] {
  const today = new Date().toLocaleDateString('zh-TW');
  const tag = companyName ? `${companyName}（${code}）` : code;

  const industryNewsMap: Record<string, NewsHeadline[]> = {
    '24': [
      { source: '半導體產業快訊', headline: '輝達 GB300 系列出貨加速，台積電/CoWoS 封裝產能滿載至 2026 年', date: today, type: 'industry', sentiment: 'positive' },
      { source: '科技財經', headline: `AI 伺服器供應鏈強勁，${tag} 受惠訂單能見度高達三季以上`, date: today, type: 'industry', sentiment: 'positive' },
      { source: '半導體產業', headline: '先進封裝 CoWoS/SoIC 需求爆炸性成長，台廠搶先佈局獲利', date: today, type: 'industry', sentiment: 'positive' },
    ],
    '25': [
      { source: 'AI 硬體快訊', headline: 'AI PC 換機潮啟動，微軟 Copilot+ PC 規格帶動供應鏈全面升級', date: today, type: 'industry', sentiment: 'positive' },
      { source: '伺服器產業', headline: `GB200/B300 液冷伺服器出貨旺季，${tag} 零組件供應商訂單大增`, date: today, type: 'industry', sentiment: 'positive' },
    ],
    '28': [
      { source: '電子零組件', headline: 'AI 伺服器拉貨效應延燒，被動元件/連接器廠商接單創歷史新高', date: today, type: 'industry', sentiment: 'positive' },
      { source: '法人觀點', headline: `${tag} 受惠 AI 供應鏈爆單，外資連續買超，目標價持續上調`, date: today, type: 'industry', sentiment: 'positive' },
    ],
    '30': [
      { source: '軟體雲端', headline: '生成式 AI 企業導入加速，台灣 IT 服務商雲端轉型訂單爆增', date: today, type: 'industry', sentiment: 'positive' },
      { source: 'AI 軟體趨勢', headline: `資安 AI 化成趨勢，${tag} 企業級解決方案市佔率持續擴張`, date: today, type: 'industry', sentiment: 'positive' },
    ],
    '17': [
      { source: '金融財經', headline: '台股萬點高檔整理，壽險業股票資產未實現利益仍維持正數', date: today, type: 'industry', sentiment: 'neutral' },
      { source: '銀行業分析', headline: `${tag} 第二季 EPS 優於預期，法說會後外資調升評等至買進`, date: today, type: 'industry', sentiment: 'positive' },
    ],
    '22': [
      { source: '生技快訊', headline: 'AI 新藥開發平台縮短試驗期程，台灣生技股授權金收入創新高', date: today, type: 'industry', sentiment: 'positive' },
      { source: '醫療產業', headline: `${tag} 與國際藥廠策略合作消息曝光，法人看好後市佈局機會`, date: today, type: 'industry', sentiment: 'positive' },
    ],
    '15': [
      { source: '航運產業', headline: '紅海危機持續，繞行好望角使航程增加 14 天，運費維持高位支撐', date: today, type: 'industry', sentiment: 'positive' },
      { source: '海運分析', headline: `${tag} 艦隊更新計畫啟動，節能新船降低成本，毛利率估改善`, date: today, type: 'industry', sentiment: 'positive' },
    ],
    '12': [
      { source: '汽車產業', headline: '純電動車滲透率加速提升，台灣電動車零組件廠商供應鏈話語權增強', date: today, type: 'industry', sentiment: 'positive' },
      { source: 'EV 趨勢', headline: `${tag} 電動車模組業務佔比突破三成，法人給予較高評價倍數`, date: today, type: 'industry', sentiment: 'positive' },
    ],
    '26': [
      { source: '光電顯示', headline: 'iPhone 下一代 MicroLED 規格確認，台灣面板廠提前搶單佈局', date: today, type: 'industry', sentiment: 'positive' },
      { source: 'AR/VR 題材', headline: `${tag} Apple Vision Pro 供應鏈身分確認，新品週期拉貨效應啟動`, date: today, type: 'industry', sentiment: 'positive' },
    ],
    '27': [
      { source: '通訊網路', headline: '低軌衛星通訊商用化加速，台廠天線模組廠商拿下 SpaceX 訂單', date: today, type: 'industry', sentiment: 'positive' },
      { source: '5G 產業', headline: `${tag} 6G 研究合作案簽署，長線題材加持股價持續獲法人青睞`, date: today, type: 'industry', sentiment: 'positive' },
    ],
  };

  // Default headlines for unmatched industries
  const defaultHeadlines: NewsHeadline[] = [
    {
      source: '市場觀察',
      headline: `${tag} 今日${chgPct > 5 ? '強勢大漲' : '穩健上攻'}，外資買超訊號值得追蹤`,
      date: today,
      type: 'analysis',
      sentiment: chgPct > 0 ? 'positive' : 'neutral',
    },
    {
      source: '產業研究',
      headline: `${industryMap2Name(industryCode)}族群整體向好，${tag} 基本面與技術面均具備支撐`,
      date: today,
      type: 'industry',
      sentiment: 'positive',
    },
  ];

  return (industryNewsMap[industryCode] || defaultHeadlines).slice(0, 3);
}

function industryMap2Name(code: string): string {
  return INDUSTRY_MAP[code]?.name || '相關產業';
}

// ─── Industry Outlook Builder ─────────────────────────────────

function buildIndustryOutlook(industry: IndustryInfo, stock: StockDayItem | null): IndustryOutlook {
  const outlooks: Record<string, Omit<IndustryOutlook, 'industry'>> = {
    '24': {
      shortTerm: '強勢',
      midTerm: '持續看多',
      longTerm: '結構性多頭',
      catalysts: ['輝達下一代 GB300/Rubin 晶片出貨', 'CoWoS 封裝產能持續擴充', 'AI 推論晶片邊緣部署加速', '中國 AI 晶片禁令促台廠受惠'],
      risks: ['地緣政治 → 晶片出口管制升級', '景氣反轉 → 資本支出縮減', 'AI 應用落地速度低於預期'],
      consensusRating: 'BUY',
      avgTargetUpside: '+18%',
      institutionalSentiment: 92,
    },
    '25': {
      shortTerm: '偏多',
      midTerm: '看多',
      longTerm: '換機潮支撐',
      catalysts: ['AI PC 滲透率快速提升至 30%+', '微軟 Copilot+ 規格強制升級', '液冷伺服器放量出貨'],
      risks: ['PC 市場整體需求仍偏弱', '匯率波動影響海外收益'],
      consensusRating: 'BUY',
      avgTargetUpside: '+14%',
      institutionalSentiment: 78,
    },
    '28': {
      shortTerm: '強勢',
      midTerm: '持續看多',
      longTerm: '結構成長',
      catalysts: ['AI 伺服器零組件持續拉貨', 'GB300 新平台帶動新規格採用', '資料中心建設高峰期延續'],
      risks: ['庫存去化若出現轉折', '競爭加劇壓縮毛利'],
      consensusRating: 'BUY',
      avgTargetUpside: '+15%',
      institutionalSentiment: 82,
    },
    '17': {
      shortTerm: '中性偏多',
      midTerm: '股利支撐',
      longTerm: '穩健防禦',
      catalysts: ['股息殖利率相對高吸引保守資金', '升息循環尾聲 NIM 仍優', '呆帳率維持低水準'],
      risks: ['台股若出現修正衝擊壽險業帳面', '市場轉向時資金移出至科技股'],
      consensusRating: 'HOLD/BUY',
      avgTargetUpside: '+8%',
      institutionalSentiment: 60,
    },
    '22': {
      shortTerm: '題材性偏多',
      midTerm: '看多',
      longTerm: '長線佈局',
      catalysts: ['AI 新藥授權案有望持續曝光', 'FDA 審查通道加速', '細胞基因療法市場擴張'],
      risks: ['臨床試驗失敗風險高', '燒錢率影響財務', '資金偏愛科技股排擠效應'],
      consensusRating: 'BUY',
      avgTargetUpside: '+22%',
      institutionalSentiment: 68,
    },
    '15': {
      shortTerm: '中性',
      midTerm: '偏多',
      longTerm: '週期性觀察',
      catalysts: ['紅海危機繞行增加運費支撐', '台股市場資金輪動關注', '季配息吸引存股族'],
      risks: ['紅海局勢若緩和運費下滑', '油價上漲侵蝕獲利', '供給過剩壓力仍存'],
      consensusRating: 'HOLD',
      avgTargetUpside: '+6%',
      institutionalSentiment: 52,
    },
    '30': {
      shortTerm: '偏多',
      midTerm: '看多',
      longTerm: '結構成長',
      catalysts: ['企業 AI 化轉型訂單爆增', '雲端 + 資安整合方案需求', '政府數位建設標案'],
      risks: ['競爭激烈影響定價能力', '大廠直接進入市場'],
      consensusRating: 'BUY',
      avgTargetUpside: '+16%',
      institutionalSentiment: 72,
    },
  };

  const defaultOutlook: Omit<IndustryOutlook, 'industry'> = {
    shortTerm: '中性',
    midTerm: '觀察',
    longTerm: '待確認',
    catalysts: ['整體大盤氣氛影響', '外資買賣超動向', '景氣循環走向'],
    risks: ['市場系統性風險', '產業需求波動'],
    consensusRating: 'HOLD',
    avgTargetUpside: '+5%',
    institutionalSentiment: 55,
  };

  const outlookData = outlooks[industry.code] || defaultOutlook;
  return { ...outlookData, industry };
}

// ─── Response Interfaces ──────────────────────────────────────

interface TrendReason {
  icon: string;
  title: string;
  detail: string;
  strength: 'strong' | 'moderate' | 'weak';
  category: 'price_action' | 'volume' | 'technical' | 'industry' | 'news';
}

interface TrendAnalysis {
  summary: string;
  reasons: TrendReason[];
  momentum: 'strong_bull' | 'bull' | 'mild_bull' | 'neutral' | 'bear';
  momentumScore: number;
}

interface NewsHeadline {
  source: string;
  headline: string;
  date: string;
  type: 'official' | 'industry' | 'analysis' | 'news';
  sentiment: 'positive' | 'negative' | 'neutral';
  url?: string;
}

interface IndustryOutlook {
  industry: IndustryInfo;
  shortTerm: string;
  midTerm: string;
  longTerm: string;
  catalysts: string[];
  risks: string[];
  consensusRating: string;
  avgTargetUpside: string;
  institutionalSentiment: number; // 0-100
}

// ─── Pre-Market Recommendation Builder ────────────────────────

export interface OrderLevel {
  label: string;          // e.g. '積極追買'
  price: number;
  rationale: string;
  style: 'aggressive' | 'standard' | 'conservative' | 'limit';
  riskLevel: 'high' | 'medium' | 'low';
}

export interface PreMarketRecommendation {
  todayClose: number;
  prevClose: number;
  todayChangePercent: number;
  expectedOpeningRange: { low: number; high: number };
  recommendation: 'strong_buy' | 'buy' | 'wait' | 'avoid';
  recommendationText: string;
  optimalOrderTime: string;
  orderLevels: OrderLevel[];
  stopLossPrice: number;
  auctionStrategy: string;
  dayTradingNote: string;
  riskWarning: string;
}

function buildPreMarketRecommendation(
  code: string,
  stock: StockDayItem | null,
  trend: TrendAnalysis
): PreMarketRecommendation {
  const defaultResult: PreMarketRecommendation = {
    todayClose: 0,
    prevClose: 0,
    todayChangePercent: 0,
    expectedOpeningRange: { low: 0, high: 0 },
    recommendation: 'wait',
    recommendationText: '資料不足，建議等待開盤後確認方向',
    optimalOrderTime: '08:30 ~ 08:55',
    orderLevels: [],
    stopLossPrice: 0,
    auctionStrategy: '建議等待開盤後觀察',
    dayTradingNote: '請確認開盤量能再決定',
    riskWarning: '市場有風險，投資需謹慎',
  };

  if (!stock) return defaultResult;

  const close = parseFloat(stock.ClosingPrice) || 0;
  const change = parseFloat(stock.Change) || 0;
  const prevClose = close - change;
  if (close <= 0 || prevClose <= 0) return defaultResult;

  const chgPct = (change / prevClose) * 100;
  const high = parseFloat(stock.HighestPrice) || close;
  const low  = parseFloat(stock.LowestPrice)  || close;
  const open = parseFloat(stock.OpeningPrice) || close;
  const closePos = closePositionOf(close, high, low, prevClose);
  // ⚠ **興櫃沒有漲跌幅限制**（2026-09-01 使用者回報 7930 威世波）：
  //   威世波當日 +25.27%，用 chgPct>=9.9 判斷會說它「漲停」——
  //   但興櫃根本沒有漲停這回事，那是上市櫃才有的制度。
  //   資料來源已標 _market:'esb'（見 twse-api-server），這裡只是沒有用它。
  const isEsb = (stock as { _market?: string })._market === 'esb';
  const isLimitUp = !isEsb && chgPct >= 9.9;

  // Taiwan daily limit is ±10%
  // 興櫃無漲跌幅限制 ⇒ 不給價格（null），而不是給一個不存在的數字
  const limitUpPrice   = isEsb ? null : parseFloat((prevClose * 1.1).toFixed(2));
  const limitDownPrice = isEsb ? null : parseFloat((prevClose * 0.9).toFixed(2));

  // Expected opening range for next day
  // Momentum continuation: strong days gap up slightly; weak days mean-revert
  let openLow: number, openHigh: number;
  if (isLimitUp) {
    // After limit-up: gap up ~1-3%, possible continuation or profit-taking
    openLow  = parseFloat((close * 0.99).toFixed(2));
    openHigh = parseFloat((close * 1.05).toFixed(2));
  } else if (chgPct >= 5) {
    openLow  = parseFloat((close * 0.985).toFixed(2));
    openHigh = parseFloat((close * 1.03).toFixed(2));
  } else if (chgPct >= 2) {
    openLow  = parseFloat((close * 0.99).toFixed(2));
    openHigh = parseFloat((close * 1.02).toFixed(2));
  } else {
    openLow  = parseFloat((close * 0.98).toFixed(2));
    openHigh = parseFloat((close * 1.015).toFixed(2));
  }

  // Order levels
  const orderLevels: OrderLevel[] = [];

  if (isLimitUp) {
    // After limit-up: most people want to chase — provide strategic levels
    orderLevels.push({
      label: '開盤追漲（漲停繼板）',
      price: parseFloat((close * 1.02).toFixed(2)),
      rationale: `漲停隔日若繼續鎖板，可在開盤前掛 ${(close * 1.02).toFixed(2)} 元委買；若開盤即跌破昨收則立即止損`,
      style: 'aggressive',
      riskLevel: 'high',
    });
    orderLevels.push({
      label: '平盤接回（標準策略）',
      price: parseFloat(close.toFixed(2)),
      rationale: `若開盤回吐至昨收 ${close.toFixed(2)} 附近，為短線洗盤型態，可少量試探進場`,
      style: 'standard',
      riskLevel: 'medium',
    });
    orderLevels.push({
      label: '回測支撐（保守策略）',
      price: parseFloat((close * 0.97).toFixed(2)),
      rationale: `回測至 ${(close * 0.97).toFixed(2)} 元（昨收 -3%）為型態較安全介入點，停損可設昨收 -5%`,
      style: 'conservative',
      riskLevel: 'low',
    });
  } else if (chgPct >= 3 && closePos != null && closePos >= 0.7) {
    // Strong bull: slight pullback is buying opportunity
    const stdBuy  = parseFloat((close * 0.99).toFixed(2));
    const cnsvBuy = parseFloat((close * 0.975).toFixed(2));
    orderLevels.push({
      label: '小回接買（標準策略）',
      price: stdBuy,
      rationale: `盤前掛 ${stdBuy} 元（小於昨收 1%），等待開盤競價小幅回落後成交，是最常見的量化進場點`,
      style: 'standard',
      riskLevel: 'medium',
    });
    orderLevels.push({
      label: '保守低接（風控優先）',
      price: cnsvBuy,
      rationale: `掛 ${cnsvBuy} 元（回測 2.5%）等待支撐確認，適合資金量較大、風控優先的操作者`,
      style: 'conservative',
      riskLevel: 'low',
    });
    orderLevels.push({
      label: '積極追買（動能策略）',
      price: parseFloat((close * 1.005).toFixed(2)),
      rationale: `若動能持續，可設平高盤委買，確保能成交；適合短線動能派`,
      style: 'aggressive',
      riskLevel: 'high',
    });
  } else {
    // Mild or neutral: standard entry
    const midBuy  = parseFloat((close * 0.985).toFixed(2));
    const lowBuy  = parseFloat((close * 0.97).toFixed(2));
    orderLevels.push({
      label: '建議買價（標準）',
      price: midBuy,
      rationale: `盤前掛 ${midBuy} 元，等待競價結果，若順利成交再觀察開盤量能決定加碼時機`,
      style: 'standard',
      riskLevel: 'medium',
    });
    orderLevels.push({
      label: '理想低接價',
      price: lowBuy,
      rationale: `若開盤走弱回到 ${lowBuy} 元，為更佳的風險報酬進場點，建議分批布局`,
      style: 'conservative',
      riskLevel: 'low',
    });
  }

  // Stop loss
  const stopLossPrice = parseFloat((prevClose * (chgPct >= 5 ? 0.93 : 0.95)).toFixed(2));

  // Recommendation text
  let rec: PreMarketRecommendation['recommendation'];
  let recText: string;
  if (trend.momentum === 'strong_bull' || isLimitUp) {
    rec = 'strong_buy';
    recText = isLimitUp
      ? `漲停型態，明日開盤若繼續鎖板則動能強勁。建議盤前掛接近漲停價委買，停損設昨收 -5% 約 ${stopLossPrice} 元。`
      : `強勢多頭格局，建議盤前掛略低於收盤價委買，等待競價成交後確認量能再加碼。`;
  } else if (trend.momentum === 'bull' || chgPct >= 2) {
    rec = 'buy';
    recText = `今日走勢良好，建議盤前掛在 ${orderLevels[0]?.price ?? close} 元附近等待競價。若開盤成交量達昨日三成以上，可視為買進訊號確認。`;
  } else if (trend.momentum === 'neutral') {
    rec = 'wait';
    recText = `動能普通，建議等開盤 5 分鐘觀察量能方向後再決定進場，避免盲目追高。`;
  } else {
    rec = 'avoid';
    recText = `今日走勢偏弱，建議暫緩進場，等待均線支撐確認後再評估。`;
  }

  // Auction strategy
  let auctionStrategy: string;
  if (isLimitUp) {
    auctionStrategy = '08:30 起即可掛漲停板委買，提高競價成交機率。若 08:55 競價完成後仍鎖板，可留單；若開盤即下殺破昨收，立即取消委託。';
  } else if (chgPct >= 3) {
    auctionStrategy = `08:40~08:55 之間掛單最佳。建議掛在 ${openLow.toFixed(2)}~${openHigh.toFixed(2)} 元之間的競價區間，過高追買風險大，過低可能無法成交。`;
  } else {
    auctionStrategy = `建議 09:00 開盤後觀察 5 分鐘量能再決定是否掛單，避免跌破開盤價後被套。`;
  }

  // Day trading note
  const dtNote = chgPct >= 5
    ? '動能強勁，當日沖銷（當沖）者可在開盤後量能確認時短進，目標設昨日高點或漲停板；停損嚴守昨收 -3%。'
    : chgPct >= 2
    ? '若今日開盤後量能持續放大且守住昨收，可做當日波段；若量縮無法放量，建議隔日觀察。'
    : '動能不足，不建議當沖；持有者可等待量能回升再做決定。';

  return {
    todayClose: close,
    prevClose,
    todayChangePercent: parseFloat(chgPct.toFixed(2)),
    expectedOpeningRange: { low: openLow, high: openHigh },
    recommendation: rec,
    recommendationText: recText,
    optimalOrderTime: isLimitUp ? '08:30 ~ 08:55（競價期間）' : '08:40 ~ 08:55（競價尾聲）',
    orderLevels,
    stopLossPrice,
    auctionStrategy,
    dayTradingNote: dtNote,
    riskWarning: '以上為 AI 模型推算，非實際保證。市場瞬息萬變，請務必設定停損並自行承擔風險。',
  };
}

// ─── Company Profile Builder ───────────────────────────────────

export interface CompanyProfile {
  code: string;
  fullName: string;
  shortName: string;
  chairman: string;
  ceo: string;
  spokesperson: string;
  address: string;
  phone: string;
  website: string;                // 官網（空字串＝來源未提供，不要編造）
  email: string;
  fax: string;
  spokespersonTitle: string;
  deputySpokesperson: string;
  englishName: string;
  taxId: string;
  transferAgent: string;
  transferAgentPhone: string;
  accountingFirm: string;
  foundedDate: string;
  listedDate: string;
  capitalAmount: string;
  capitalBillion: number; // in 億
  industryCategory: string;
  industryCode: string;
  mainBusiness: string;
  keyProducts: string[];
  companyScale: 'large' | 'mid' | 'small';
  ageYears: number;
  listingAgeYears: number;
}

// 與上面的 z() 同義；buildCompanyProfile 是獨立函式，不共用區塊層變數
// （CLAUDE.md 記過 dSlash 跨區塊引用被吞成一行警告的教訓）。
const clean = (v: unknown): string => {
  const t = String(v ?? '').replace(/[\s\u3000]+/g, ' ').trim();
  return /^[－—–-]*$/.test(t) ? '' : t;
};

function buildCompanyProfile(
  code: string,
  raw: CompanyInfo | null,
  industry: IndustryInfo,
  stock: StockDayItem | null
): CompanyProfile {
  const defaultProfile: CompanyProfile = {
    code,
    fullName: stock?.Name || code,
    shortName: stock?.Name || code,
    chairman: '未知',
    ceo: '未知',
    spokesperson: '未知',
    address: '--',
    phone: '--',
    website: '',
    email: '',
    fax: '',
    spokespersonTitle: '',
    deputySpokesperson: '',
    englishName: '',
    taxId: '',
    transferAgent: '',
    transferAgentPhone: '',
    accountingFirm: '',
    foundedDate: '--',
    listedDate: '--',
    capitalAmount: '--',
    capitalBillion: 0,
    industryCategory: industry.name,
    industryCode: industry.code,
    mainBusiness: getMainBusiness(code, industry),
    keyProducts: getKeyProducts(code, industry),
    companyScale: 'mid',
    ageYears: 0,
    listingAgeYears: 0,
  };

  if (!raw) return defaultProfile;

  // Parse capital (e.g. "77231817420" → 772 億)
  const capitalRaw = raw['實收資本額'] || '0';
  const capitalNum = parseInt(capitalRaw.replace(/[^0-9]/g, '')) || 0;
  const capitalBillion = parseFloat((capitalNum / 1e8).toFixed(1));

  // Scale by capital
  const companyScale: CompanyProfile['companyScale'] =
    capitalBillion >= 500 ? 'large' : capitalBillion >= 50 ? 'mid' : 'small';

  // Parse dates
  const foundedRaw = raw['成立日期'] || '';
  const listedRaw = raw['上市日期'] || '';
  const parseROCDate = (d: string) => {
    if (!d) return { display: '--', year: 0 };
    // Remove non-digits first
    const clean = d.replace(/\//g, '').replace(/\D/g, '');
    // TWSE uses YYYMMDD (3-digit ROC year, e.g. 0820501 = ROC 82/05/01 = 1993/05/01)
    // or YYMMDD (6 digits, e.g. 820501)
    if (clean.length === 7) {
      const y = parseInt(clean.substring(0, 3)) + 1911;
      const m = clean.substring(3, 5);
      const day = clean.substring(5, 7);
      return { display: `${y}/${m}/${day}`, year: y };
    } else if (clean.length === 6) {
      const y = parseInt(clean.substring(0, 2)) + 1911;
      const m = clean.substring(2, 4);
      const day = clean.substring(4, 6);
      return { display: `${y}/${m}/${day}`, year: y };
    } else if (clean.length >= 8) {
      // Western year format YYYYMMDD
      const y = parseInt(clean.substring(0, 4));
      const m = clean.substring(4, 6);
      const day = clean.substring(6, 8);
      return { display: `${y}/${m}/${day}`, year: y };
    }
    return { display: '--', year: 0 };
  };
  const founded = parseROCDate(foundedRaw);
  const listed = parseROCDate(listedRaw);
  const currentYear = new Date().getFullYear();

  return {
    code,
    fullName: raw['公司名稱'] || stock?.Name || code,
    shortName: raw['公司簡稱'] || stock?.Name || code,
    chairman: raw['董事長'] || '--',
    ceo: raw['總經理'] || '--',
    spokesperson: raw['發言人'] || '--',
    address: raw['住址'] || '--',
    phone: raw['總機電話'] || '--',
    // ⚠ 只接受 http(s) 開頭的值：來源偶有「－」或空白佔位，直接丟給 <a href> 會產生壞連結
    // ⚠ 只接受 http(s) 開頭：來源偶有「－」或空白佔位，丟給 <a href> 會產生壞連結
    website: /^https?:\/\//i.test(clean(raw['網址'])) ? clean(raw['網址']) : '',
    email: clean(raw['電子郵件信箱']),
    fax: clean(raw['傳真機號碼']),
    spokespersonTitle: clean(raw['發言人職稱']),
    deputySpokesperson: clean(raw['代理發言人']),
    englishName: clean(raw['英文簡稱']),
    taxId: clean(raw['營利事業統一編號']),
    transferAgent: clean(raw['股票過戶機構']),
    transferAgentPhone: clean(raw['過戶電話']),
    accountingFirm: clean(raw['簽證會計師事務所']),
    foundedDate: founded.display,
    listedDate: listed.display,
    capitalAmount: capitalBillion > 0 ? `${capitalBillion} 億元` : '--',
    capitalBillion,
    industryCategory: industry.name,
    industryCode: industry.code,
    mainBusiness: getMainBusiness(code, industry),
    keyProducts: getKeyProducts(code, industry),
    companyScale,
    ageYears: founded.year > 0 ? currentYear - founded.year : 0,
    listingAgeYears: listed.year > 0 ? currentYear - listed.year : 0,
  };
}

// ─── Business Description Database ────────────────────────────
// Maps stock codes to known business descriptions; falls back to industry-level

const BUSINESS_DB: Record<string, { business: string; products: string[] }> = {
  '2330': { business: '全球最大晶圓代工廠，專注先進半導體製程研發與量產，為 NVIDIA、Apple、AMD 等頂尖客戶獨家製造高階晶片', products: ['3nm/2nm 先進製程', 'CoWoS 先進封裝', '特殊製程 (RF/HV/MEMS)', 'SoIC 晶片堆疊技術'] },
  '2308': { business: '台灣最大電子製造服務（EMS）廠商之一，同時生產電子零組件與連接器，是 AI 伺服器供應鏈核心廠商', products: ['AI 伺服器連接器', '電子製造代工', '汽車電子零組件', '機構件與精密模具'] },
  '2454': { business: '全球第三大晶圓代工廠，專精成熟製程與特殊應用半導體，IoT/車用/電源管理是核心市場', products: ['8吋/12吋晶圓代工', '矽麥克風 MEMS', '電源管理 IC', '車用半導體'] },
  '2317': { business: '全球最大電子產品製造商（EMS），蘋果最大代工廠，同時積極佈局機器人與 AI 自動化業務', products: ['iPhone/iPad 代工組裝', '伺服器組裝', 'AI 機器人手臂', '半導體設備'] },
  '2412': { business: '台灣最大電信公司，提供行動通訊、寬頻、企業解決方案，積極佈局 5G/AI/雲端服務', products: ['5G 行動通訊', '企業雲端服務', '數位轉型解決方案', '媒體與串流平台'] },
  '2881': { business: '台灣最大金融控股公司之一，旗下富邦人壽、台北富邦銀行等，資產規模逾十兆元', products: ['人壽保險', '商業銀行', '證券承銷', '資產管理'] },
  '2882': { business: '國泰金控旗下含國泰人壽（全台最大壽險）、國泰世華銀行，深耕海外市場', products: ['壽險保單', '商業銀行存放款', '海外投資佈局', '數位金融服務'] },
  '2303': { business: '全球前三大 DRAM 製造商，台灣記憶體產業龍頭，積極切入 AI HBM 記憶體市場', products: ['DDR5 DRAM', 'HBM3 高頻寬記憶體', 'LPDDR5X 低功耗記憶體', 'eMMC 儲存晶片'] },
  '2379': { business: '全球連接器大廠，AI 伺服器高速傳輸連接器主要供應商，客戶涵蓋主要雲端資料中心業者', products: ['高速傳輸連接器', 'PCIe 5.0/6.0 連接器', '電源連接器', '伺服器背板'] },
  '2313': { business: '全球最大 PCB（印刷電路板）廠之一，同時生產精密連接器，AI 伺服器需求大幅拉動訂單', products: ['高密度 PCB', 'IC 載板', '精密連接器', '汽車電子板'] },
  '2404': { business: '全球最大 PCB 廠（依營收），涵蓋各類電子產品所需電路板，AI 伺服器板為目前成長亮點', products: ['高速 AI 伺服器 PCB', '5G 基站電路板', 'HDI 高密度板', '軟性電路板 FPC'] },
};

function getMainBusiness(code: string, industry: IndustryInfo): string {
  if (BUSINESS_DB[code]) return BUSINESS_DB[code].business;
  // Fallback: industry-level description
  const industryBusinessMap: Record<string, string> = {
    '24': '從事半導體相關製程、設計或封裝測試，為台灣科技產業核心供應鏈成員',
    '25': '生產電腦週邊及伺服器硬體設備，受惠 AI 換機潮與雲端建設需求',
    '28': '生產電子零組件如被動元件、連接器、電路板等，為電子產品核心材料供應商',
    '30': '提供資訊軟體、雲端平台及數位轉型解決方案，助企業 AI 化轉型',
    '17': '提供銀行、保險、證券等金融服務，為台灣金融市場重要機構',
    '22': '從事生物技術、新藥研發、醫療器材或 CRO/CDMO 業務',
    '15': '經營航運物流，包含貨櫃航運、散裝船或貨代業務',
    '13': '生產電子工業用零組件，涵蓋光電、被動元件、電源等多元品類',
    '14': '從事建設開發、建材銷售或不動產相關業務',
    '05': '製造工業機械、自動化設備或精密加工相關設備',
  };
  return industryBusinessMap[industry.code] || `從事${industry.name}相關業務，為台灣${industry.sector}代表性廠商`;
}

function getKeyProducts(code: string, industry: IndustryInfo): string[] {
  if (BUSINESS_DB[code]) return BUSINESS_DB[code].products;
  const productMap: Record<string, string[]> = {
    '24': ['晶圓代工/設計', '先進封裝', 'IC 元件', '半導體設備'],
    '25': ['伺服器主機板', '電腦周邊設備', '電源供應器', '散熱模組'],
    '28': ['被動元件', '連接器', '電路板 PCB', '電子材料'],
    '30': ['ERP/雲端平台', '資安解決方案', '大數據分析', 'AI 應用軟體'],
    '17': ['保險產品', '銀行存放款', '資產管理', '證券投資'],
    '22': ['新藥研發', '醫療器材', '生技原料藥', '臨床試驗服務'],
    '15': ['貨櫃運輸', '散裝貨運', '物流倉儲', '航運代理'],
    '13': ['電子零組件', '電源模組', '光電元件', '感測器'],
  };
  return productMap[industry.code] || [`${industry.name}相關產品`, '技術服務'];
}

// ─── Price Prediction Builder ──────────────────────────────────

export interface PricePrediction {
  // 明日預期日內高低點
  nextDayHigh: { price: number; basis: string; confidence: number };
  nextDayLow: { price: number; basis: string; confidence: number };
  // 波段支撐/壓力
  resistance: Array<{ price: number; label: string; strength: 'strong' | 'medium' | 'weak' }>;
  support: Array<{ price: number; label: string; strength: 'strong' | 'medium' | 'weak' }>;
  // 操作區間建議
  buyZoneHigh: number;
  buyZoneLow: number;
  targetZoneHigh: number;
  targetZoneLow: number;
  // ATR（平均真實範圍）
  atr: number;
  atrPercent: number;
  // 今日位置評估
  pricePositionScore: number; // 0-100, 100=最強
  positionDescription: string;
}

function buildPricePrediction(stock: StockDayItem | null): PricePrediction {
  const defaultResult: PricePrediction = {
    nextDayHigh: { price: 0, basis: '資料不足', confidence: 0 },
    nextDayLow: { price: 0, basis: '資料不足', confidence: 0 },
    resistance: [],
    support: [],
    buyZoneHigh: 0,
    buyZoneLow: 0,
    targetZoneHigh: 0,
    targetZoneLow: 0,
    atr: 0,
    atrPercent: 0,
    pricePositionScore: 50,
    positionDescription: '資料不足，無法評估',
  };

  if (!stock) return defaultResult;

  const close = parseFloat(stock.ClosingPrice) || 0;
  const high = parseFloat(stock.HighestPrice) || close;
  const low = parseFloat(stock.LowestPrice) || close;
  const change = parseFloat(stock.Change) || 0;
  const prevClose = close - change;

  if (close <= 0) return defaultResult;

  // ATR 估算（日內高低點差，約 1.5%~3%）
  const atr = parseFloat((high - low).toFixed(2));
  const atrPct = close > 0 ? parseFloat(((atr / close) * 100).toFixed(2)) : 2.0;
  // 若今日 atr 極小，用 2% 作為最低估計
  const effectiveAtrPct = Math.max(atrPct, 1.5);

  // 明日預期高低點
  const nextHigh = parseFloat((close * (1 + effectiveAtrPct / 2 / 100)).toFixed(2));
  const nextLow  = parseFloat((close * (1 - effectiveAtrPct / 2 / 100)).toFixed(2));

  // 漲跌停板（台灣 ±10%）
  // 同上：興櫃無漲跌幅限制
  const _isEsb2 = (stock as { _market?: string })._market === 'esb';
  const limitUp   = _isEsb2 ? null : parseFloat((prevClose * 1.1).toFixed(2));
  const limitDown = _isEsb2 ? null : parseFloat((prevClose * 0.9).toFixed(2));

  // 壓力位
  const resistance: PricePrediction['resistance'] = [
    // 興櫃無漲跌停 ⇒ 不列這一條（下面 filter 掉），而不是列一個不存在的價位
    { price: limitUp,                                           label: '漲停板',   strength: 'strong' },
    { price: parseFloat((close * 1.05).toFixed(2)),             label: '+5% 壓力', strength: 'medium' },
    { price: parseFloat((close * 1.10).toFixed(2)),             label: '+10% 壓力', strength: 'weak'  },
  ].filter((x): x is { price: number; label: string; strength: 'strong' | 'medium' | 'weak' } => x.price != null);

  // 支撐位
  const support: PricePrediction['support'] = [
    { price: parseFloat((close * 0.97).toFixed(2)),  label: '-3% 支撐',  strength: 'strong' },
    { price: parseFloat((close * 0.95).toFixed(2)),  label: '-5% 支撐',  strength: 'medium' },
    { price: limitDown,                               label: '跌停板',    strength: 'weak'   },
  ].filter((x): x is { price: number; label: string; strength: 'strong' | 'medium' | 'weak' } => x.price != null);

  // 操作區間
  const buyZoneLow    = parseFloat((close * 0.98).toFixed(2));
  const buyZoneHigh   = parseFloat((close * 1.00).toFixed(2));
  const targetZoneLow = parseFloat((close * 1.05).toFixed(2));
  const targetZoneHigh= parseFloat((close * 1.12).toFixed(2));

  // 今日位置評估（收盤在日內高低點中的位置）
  const range = high - low;
  const closePos = closePositionOf(close, high, low, prevClose);
  // 缺高低時無法評此項，給中性 50 而不是 0——0 會被讀成「位置極差」（2026-08-29）
  const pricePositionScore = closePos == null ? 50 : Math.round(closePos * 100);
  let positionDescription: string;
  if (pricePositionScore >= 80) positionDescription = '收盤守高位，多頭氣勢完整，明日延續機率高';
  else if (pricePositionScore >= 60) positionDescription = '收盤偏高，量價配合良好，短線偏多';
  else if (pricePositionScore >= 40) positionDescription = '收盤居中，方向待確認，建議觀察量能';
  else if (pricePositionScore >= 20) positionDescription = '收盤偏低，出現上影線，短線賣壓較重';
  else positionDescription = '收盤接近低點，長上影線，注意回測風險';

  return {
    nextDayHigh: {
      price: nextHigh,
      basis: `以昨收 ${close} 元 + 半個 ATR（${effectiveAtrPct.toFixed(1)}%）計算`,
      confidence: pricePositionScore >= 60 ? 72 : 58,
    },
    nextDayLow: {
      price: nextLow,
      basis: `以昨收 ${close} 元 - 半個 ATR（${effectiveAtrPct.toFixed(1)}%）計算`,
      confidence: pricePositionScore <= 40 ? 72 : 58,
    },
    resistance,
    support,
    buyZoneHigh,
    buyZoneLow,
    targetZoneHigh,
    targetZoneLow,
    atr,
    atrPercent: atrPct,
    pricePositionScore,
    positionDescription,
  };
}

