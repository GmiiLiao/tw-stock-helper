import { NextRequest, NextResponse } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'gemma4:latest';

interface StockCompareItem {
  code: string;
  name: string;
  price: number;
  changePercent: number;
  volume: number;
}

export async function POST(request: NextRequest) {
  // 直打本機 Ollama 的路徑：生產環境打不到（安全地壞著），但仍不可讓人免費反覆觸發（WM-SCAN R2 選項 a）
  const limited = await rateLimit(request, 'compare-agent', 10);
  if (limited) return limited;
  try {
    const body = await request.json().catch(() => ({}));
    const {
      groupName = '未命名分組',
      stocks = [],
      budget = 500000,
      profitTarget = 10,
      profitTargetType = 'percent',
      tradeDuration = 'swing',
      lotType = 'lot'
    } = body as {
      groupName: string;
      stocks: StockCompareItem[];
      budget: number;
      profitTarget: number;
      profitTargetType: 'percent' | 'amount';
      tradeDuration: 'day' | 'swing';
      lotType: 'lot' | 'odd';
    };

  if (!Array.isArray(stocks) || stocks.length === 0) {
    return NextResponse.json({ error: '請提供要比較的股票列表' }, { status: 400 });
  }

  if (stocks.length > 5) {
    return NextResponse.json({ error: '最多只能比較 5 檔股票' }, { status: 400 });
  }

  const nowStr = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });

  // ── Build prompt for Ollama ──
  const ollamaPrompt = `你是台灣股市資深分析與投資顧問。請分析以下自選股比較分組：【${groupName}】之股票數據，為用戶提供最佳選購建議與潛在風險報告。

投資條件與參數設定：
- 投資預算：${budget.toLocaleString()} 元
- 獲利目標：${profitTargetType === 'percent' ? `${profitTarget}%` : `${profitTarget.toLocaleString()} 元`}
- 操作週期：${tradeDuration === 'day' ? '當沖交易 (單日沖銷，減半證交稅，注意波動度)' : '波段操作 (波段持有，留意基本面與中長期均線)'}
- 交易單位：${lotType === 'lot' ? '整張 (1,000股)' : '零股 (1股)'}

股票列表與即時行情：
${stocks.map(s => `- ${s.name}(${s.code}): 現價 ${s.price.toFixed(2)} 元, 今日漲跌幅 ${s.changePercent >= 0 ? '+' : ''}${s.changePercent.toFixed(2)}%, 今日成交量 ${(s.volume / 1000).toFixed(1)}k 股`).join('\n')}

請以專業、嚴謹、口吻平實但充滿交易洞察力的繁體中文（台灣股市術語，如：個股、均線、法人、當沖、多頭、停損）產出報告。內容必須包含：
1. 【分組綜合評估與預算配置】說明此組合整體特質（高價股、高波動、保守型等）、資金應如何分配（如：偏向哪幾檔、各自建議買進張/股數、預估總花費、剩餘閒置資金配置建議）。
2. 【最佳選購建議與契合度分析】針對這 ${stocks.length} 檔股票，分別說明其操作契合度與推薦優先順序，分析買進時機點與目標出場價。請務必針對每一檔股票「明確推論建議購買張數（或零股數）」與「具體持有時間策略」（例如當沖：盤中幾分鐘/小時內出場；波段：持有幾日或觀察何種均線訊號出場）。
3. 【個別股票潛在風險報告】詳細指出每一檔股票當下面臨的風險（如：流動性、技術面突破後的拉回、成交量退潮、總經或產業逆風等）。
4. 【避險與停損建議】給予具體的操作心態、停損價格/成數建議。

請直接以 Markdown 格式輸出報告，不需要有任何前言或自我介紹，字數約 600-800 字。`;

  let report = '';
  let usedOllama = false;

  // Try Ollama query
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

    const ollamaRes = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        prompt: ollamaPrompt,
        stream: false,
        options: {
          temperature: 0.7,
          num_predict: 1200,
        }
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (ollamaRes.ok) {
      const data = await ollamaRes.json();
      report = (data.response || '').trim();
      if (report) {
        usedOllama = true;
      }
    }
  } catch (err) {
    console.warn('Ollama generate in compare-agent failed or timed out. Running fallback generator.', err);
  }

  // Fallback: Professional programmatic stock analyst report generator
  if (!usedOllama) {
    report = generateFallbackReport(groupName, stocks, budget, profitTarget, profitTargetType, tradeDuration, lotType, nowStr);
  }

  return NextResponse.json({
    report,
    timestamp: Date.now(),
    usedOllama,
    model: usedOllama ? DEFAULT_MODEL : 'fallback-analyst-v1'
  });

  } catch (error) {
    console.error('compare-agent API error:', error);
    return NextResponse.json({ error: '分析過程中發生錯誤' }, { status: 500 });
  }
}

// ────────────────────────────────────────────────────────
// Programmatic Fallback Report Generator
// ────────────────────────────────────────────────────────
function generateFallbackReport(
  groupName: string,
  stocks: StockCompareItem[],
  budget: number,
  profitTarget: number,
  profitTargetType: 'percent' | 'amount',
  tradeDuration: 'day' | 'swing',
  lotType: 'lot' | 'odd',
  nowStr: string
): string {
  // Sort stocks by return or volume to prioritize recommendation
  const sortedByPerf = [...stocks].sort((a, b) => b.changePercent - a.changePercent);
  const sortedByVol = [...stocks].sort((a, b) => b.volume - a.volume);
  
  // Choose primary pick based on tradeDuration
  let primaryPick = sortedByPerf[0];
  let secondaryPick = sortedByPerf[1] || sortedByPerf[0];
  
  if (tradeDuration === 'day') {
    // For day trading, prioritize high volume & high volatility
    const dayTradeCandidates = [...stocks].sort((a, b) => {
      const scoreA = a.volume * Math.abs(a.changePercent);
      const scoreB = b.volume * Math.abs(b.changePercent);
      return scoreB - scoreA;
    });
    primaryPick = dayTradeCandidates[0];
    secondaryPick = dayTradeCandidates[1] || dayTradeCandidates[0];
  } else {
    // For swing trading, prioritize positive trend or large capitalization
    const swingCandidates = [...stocks].sort((a, b) => b.changePercent - a.changePercent);
    primaryPick = swingCandidates[0];
    secondaryPick = swingCandidates[1] || swingCandidates[0];
  }

  // Pre-calculate recommendations per stock
  const stockAnalyses = stocks.map((s, idx) => {
    const isUp = s.changePercent >= 0;
    const price = s.price || 1;
    
    // Calculate shares purchase potential
    let maxShares = 0;
    if (lotType === 'lot') {
      maxShares = Math.floor(budget / (price * 1000)) * 1000;
    } else {
      maxShares = Math.floor(budget / price);
    }
    const cost = maxShares * price;
    const fee = Math.max(20, Math.floor(cost * 0.001425));
    const totalCost = cost + fee;

    // Calculate target sell price
    let targetPrice = 0;
    if (profitTargetType === 'percent') {
      targetPrice = parseFloat((price * (1 + profitTarget / 100)).toFixed(2));
    } else {
      // profitTarget is amount. Let's find target price per share
      if (maxShares > 0) {
        const rate = 1 - 0.001425 - (tradeDuration === 'day' ? 0.0015 : 0.003);
        targetPrice = parseFloat(((cost + fee + profitTarget) / (maxShares * rate)).toFixed(2));
      } else {
        targetPrice = parseFloat((price * 1.1).toFixed(2)); // default +10% if budget is too low
      }
    }

    const stopLoss = parseFloat((price * (tradeDuration === 'day' ? 0.97 : 0.94)).toFixed(2));

    // Determine suitability
    let suitability = '中等';
    let suggestion = '';
    let holdingStrategy = '';

    if (tradeDuration === 'day') {
      holdingStrategy = '當日沖銷 (盤中 30-120 分鐘內拉高出場，或跌破均價線即刻沖銷，絕不留單過夜)';
      if (s.volume > 3000000 && Math.abs(s.changePercent) > 1.5) {
        suitability = '極佳';
        suggestion = '當前量能充沛、振幅足夠，適合開盤半小時內進場，賺取極速動能利潤。';
      } else if (s.volume < 500000) {
        suitability = '偏低';
        suggestion = '流動性稍嫌不足，當沖容易因買賣價差大而產生額外摩擦成本。';
      } else {
        suitability = '中等';
        suggestion = '波動相對平緩，可做為輔助觀察。盤中如見大單敲進或跌破均價線再考慮操作。';
      }
    } else {
      holdingStrategy = `波段持有 (預計 5 - 15 個交易日，以跌破 10 日線或達到獲利目標時出場)`;
      if (s.changePercent > 0 && s.volume > 1000000) {
        suitability = '高';
        suggestion = '量增價揚，呈現多頭攻擊態勢。適合分批佈局，以 5 日線為支撐進場。';
      } else if (s.changePercent < -2) {
        suitability = '中下 (拉回尋找支撐)';
        suggestion = '股價拉回整理中。短期均線下彎，建議先等待股價在季線或月線附近止跌打底完成再行低接。';
      } else {
        suitability = '中等';
        suggestion = '處於區間橫盤震盪整理階段。建議採取箱型操作策略，於箱型下緣低接、上緣調節。';
      }
    }

    // Determine risk points
    let riskDesc = '';
    if (s.volume < 100000) {
      riskDesc = '🚨 **流動性極低風險**：日成交量不足，買賣價差較寬，容易買得到賣不出。';
    } else if (Math.abs(s.changePercent) > 5) {
      riskDesc = '⚠️ **追高套牢風險**：短線波動劇烈，單日已劇烈拉升，技術指標處於超買區，需防範隔日沖主力倒貨。';
    } else if (s.changePercent < 0) {
      riskDesc = '📉 **技術面修正風險**：股價正處於下行趨勢或拉回修正中，若跌破重要均線支撐，可能引發多單停損潮。';
    } else {
      riskDesc = '⚖️ **震盪洗盤風險**：處於無方向的整理區間，資金效率可能被拖累，需防範久盤必跌或主力洗盤。';
    }

    return {
      code: s.code,
      name: s.name,
      price,
      maxShares,
      totalCost,
      targetPrice,
      stopLoss,
      suitability,
      suggestion,
      riskDesc,
      holdingStrategy,
    };
  });

  // Build the markdown text
  let md = `## 📊 自選股 AI 深度比較報告
*分析時間：${nowStr} | 分析模型：台股專家子代理 (本地 fallback 分析器)*

本報告針對自選股分組 **【${groupName}】** 中包含的 ${stocks.length} 檔個股，依據設定的預算 **${(budget/10000).toFixed(0)} 萬元**、獲利目標 **${profitTargetType === 'percent' ? `${profitTarget}%` : `${profitTarget.toLocaleString()} 元`}** 以及 **${tradeDuration === 'day' ? '當沖交易 (單日)' : '波段操作'}** (以**${lotType === 'lot' ? '整張' : '零股'}**交易) 進行全方位深度評估與配置建議。

---

### 一、分組綜合評估與預算配置

本分組共包含 ${stocks.length} 檔個股，主要涵蓋了不同的市值與波動特性。
基於您設定的 **${(budget/10000).toFixed(0)} 萬元** 投資預算，資金配置建議如下：

*   **資金配置策略 (核心與衛星配置)**：
    *   **主力配置 (推薦首選：${primaryPick.name} ${primaryPick.code})**：建議分配約 **50% - 60%** 的預算至此標的。該股${tradeDuration === 'day' ? '成交量與動能強勁，為當沖優良標的' : '目前趨勢較具優勢，適合波段佈局'}。
    *   **衛星配置 (防禦/輔助：${secondaryPick.name} ${secondaryPick.code})**：分配 **30% - 40%** 預算以分散風險，尋求第二波段機會。
    *   **其餘個股**：建議暫時列為觀望，或僅用極小比例 (如零股) 進行試單。
*   **具體購買力估算** (以預算額度上限計算)：
${stockAnalyses.map(a => `    *   **${a.name}(${a.code})**：單獨購買建議買進 **${a.maxShares.toLocaleString()} 股** (${lotType === 'lot' ? `${a.maxShares/1000} 張` : '零股'})，預估花費約 **${Math.round(a.totalCost).toLocaleString()} 元**。`).join('\n')}

---

### 二、最佳選購建議與契合度分析

以下是針對每檔個股在 **${tradeDuration === 'day' ? '當沖' : '波段'}** 操作下的推薦優先度評分：

${stockAnalyses.map((a, idx) => `#### **[推薦順位 #${idx + 1}] ${a.name} (${a.code})**
*   **策略契合度**：\`${a.suitability}\`
*   **建議購買數量**：**${a.maxShares.toLocaleString()} 股** (${lotType === 'lot' ? `${a.maxShares/1000} 張` : '零股'})
*   **建議持有時間策略**：**${a.holdingStrategy}**
*   **參考進場點**：${a.price.toFixed(2)} 元附近 (建議分批佈局，切忌一次性滿倉)
*   **獲利目標價 (目標獲利 ${profitTargetType === 'percent' ? `${profitTarget}%` : `${profitTarget.toLocaleString()} 元`})**：**${a.targetPrice.toFixed(2)} 元**
*   **建議停損點**：**${a.stopLoss.toFixed(2)} 元**
*   **操作指引**：${a.suggestion}`).join('\n\n')}

---

### 三、個別股票潛在風險報告

操作此分組股票，應特別注意以下個別風險因素：

${stockAnalyses.map(a => `*   **${a.name} (${a.code})**：
    ${a.riskDesc}`).join('\n')}

---

### 四、避險與停損建議

1.  **停損機制的執行**：
    *   **${tradeDuration === 'day' ? '當沖交易' : '波段操作'}** 停損非常關鍵。${tradeDuration === 'day' ? '當沖建議跌破今日開盤價或日內均價線 (通常為 2%-3% 空間) 即刻執行停損，絕不留單過夜。' : '波段操作建議以買入成本下挫 6% - 8% 作為絕對停損線，或是當股價收盤帶量跌破關鍵 20日均線(月線) 時出場。'}
2.  **預算分批配置 (拒絕滿倉)**：
    *   切勿在同一時點將 ${(budget/10000).toFixed(0)} 萬元預算一次買滿單一股票。建議採「3-3-4」原則分三批建倉，唯有股價符合預期且方向正確時才加碼。
3.  **大盤走勢連動**：
    *   台股易受美股及權值龍頭台積電波動影響，若大盤整體融資餘額過高或技術面出現破位走勢，應調降本分組的持股比例，多留現金為宜。

*免責聲明：本報告所提供之數據分析與建議僅供學術參考，不構成實際投資買賣之邀約。投資人應獨立評估風險，並自負投資損益責任。*`;

  return md;
}
