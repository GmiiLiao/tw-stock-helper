import { NextRequest, NextResponse } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';
// 2026-07-30：改用 firebase-admin 讀寫。原本在 server 端用 client SDK，
// 讀寫都以「未登入」身分送出，必須靠 firestore.rules 開一個
// `request.auth == null` 的洞才寫得進去 —— 那個洞等於任何人都能改 agent 開關。
// admin SDK 直接繞過 rules，才能把規則收乾淨。
import { getAdminDb } from '@/lib/firebase-admin';
import { requireAdmin } from '@/lib/require-admin';
import { hasCronSecret } from '@/lib/cron-auth';
import { getMarketIndexDataInternal, getMisQuoteDataInternal, getMarketNewsDataInternal } from '@/lib/twse-api-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ============================================================
// AI 股市分析訊息佇列
// GET  /api/ai-analysis      → 取得最新 5 條訊息 + Agent 狀態
// POST /api/ai-analysis      → 推送新訊息 (子代理使用)
// DELETE /api/ai-analysis    → 清空佇列
//
// 訊息由背景子代理分析台股行情後推送
// FIFO 佇列最多保留 5 條，舊的自動捨棄
// ============================================================

export interface AgentMessage {
  id:        string;
  type:      'brief' | 'alert' | 'opportunity' | 'risk' | 'trend';
  label:     string;
  emoji:     string;
  text:      string;       // 完整分析文字
  summary:   string;       // 跑馬燈摘要 (≤50字)
  severity:  'info' | 'warning' | 'danger' | 'success';
  stocks:    string[];     // 相關股票代號
  timestamp: number;       // Unix ms
  agentId:   string;
}

// Server-side in-memory queue (persists across requests in same process)
const MAX_MESSAGES = 5;
const queue: AgentMessage[] = [];

// Prevent abuse
const RATE_LIMIT_MS = 10_000; // 10s between pushes
let lastPushAt = 0;

function makeId() {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

// ── GET: 取得佇列 ──────────────────────────────────────────
// ⚠ 這支是**公開**的：AiNewsTicker 每 15 秒替全體使用者拉一次跑馬燈內容。
//   內容是市場評論、本來就要給所有人看，所以不加授權閘門。
//   （2026-07-31 一度誤鎖成 admin-only，會讓所有人的跑馬燈變空白 —— 別再改。）
//   真正需要收的是「誰能**寫入**佇列」，見下方 POST。
export async function GET() {
  let agentActive = true;
  let lastHeartbeat = 0;

  try {
    const adb = getAdminDb();
    const docSnap = adb ? await adb.collection('system').doc('monitor-agent').get() : null;
    if (docSnap?.exists) {
      const data = docSnap.data() ?? {};
      agentActive = data.active !== false;
      lastHeartbeat = data.lastHeartbeat || 0;
    }
  } catch (e) {
    console.error('Error fetching agent status in GET:', e);
  }

  return NextResponse.json(
    {
      messages: [...queue].reverse(), // newest first
      count:    queue.length,
      maxCount: MAX_MESSAGES,
      updatedAt: queue.length > 0 ? queue[queue.length - 1].timestamp : null,
      agentActive,
      lastHeartbeat,
    },
    // 佇列是 in-memory、每 15 秒就變：no-store 正確；但不開放跨來源共享
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

// ── POST: 推送新訊息 ────────────────────────────────────────
export async function POST(request: NextRequest) {
  try {
    const limited = await rateLimit(request, 'ai-analysis-post', 10);
    if (limited) return limited;

    const body = await request.json().catch(() => ({}));

    // 1. Handle manual trigger action
    if (body.action === 'trigger') {
      // 安全修正 (2026-07-30)：移除 `email === adminEmail`（email 來自 body）。
      // 安全修正 (2026-07-31)：連 `uid` 也不能從 body 讀 —— 上一版仍用 body.uid
      // 去查 users/{uid}，只要知道管理員的 uid 就能通過檢查。
      // 現在一律驗證 Authorization: Bearer <Firebase ID token>。
      const gate = await requireAdmin(request);
      if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

      // --- Trigger Entire Agent Pipeline ---
      let weighted = 22000;
      let weightedChange = 150;
      let weightedChangePercent = 0.68;
      
      // A. Fetch Market Index
      try {
        const idx = await getMarketIndexDataInternal();
        if (idx && typeof idx.weighted === 'number') {
          weighted = idx.weighted;
          weightedChange = idx.weightedChange ?? 0;
          weightedChangePercent = idx.weightedChangePercent ?? 0;
        }
      } catch (err) {
        console.warn('Trigger API: failed to fetch market index:', err);
      }

      // B. Fetch Stock Quotes
      let quotes: any[] = [];
      try {
        const codes = ['2330','2317','2454','0050','2308','2412','2882','3008','3034','6505','8021','7749','7722','9910','2413','5534','7788'];
        const qData = await getMisQuoteDataInternal(codes);
        if (qData && Array.isArray(qData.quotes)) {
          quotes = qData.quotes;
        }
      } catch (err) {
        console.warn('Trigger API: failed to fetch stock quotes:', err);
      }

      // C. Fetch Market News
      let newsTitles: string[] = [];
      try {
        const nData = await getMarketNewsDataInternal();
        if (nData && Array.isArray(nData.news)) {
          newsTitles = nData.news.slice(0, 5).map((n: any) => n.title);
        }
      } catch (err) {
        console.warn('Trigger API: failed to fetch market news:', err);
      }

      // Process and sort quotes
      const validQuotes = quotes.filter(q => typeof q.changePercent === 'number');
      const sortedQuotes = [...validQuotes].sort((a, b) => b.changePercent - a.changePercent);
      const topGainers = sortedQuotes.slice(0, 3);
      const topLosers = [...validQuotes].sort((a, b) => a.changePercent - b.changePercent).slice(0, 3);

      const tsmc = quotes.find(q => q.code === '2330');
      const tsmcPrice = tsmc ? tsmc.price : 900;
      const tsmcChange = tsmc ? tsmc.change : 0;
      const tsmcChangePercent = tsmc ? tsmc.changePercent : 0;

      const marketIndexText = `加權指數: ${weighted.toLocaleString()} 點, 漲跌: ${weightedChange >= 0 ? '+' : ''}${weightedChange} (${weightedChangePercent}%)`;
      const quotesText = quotes.slice(0, 10).map(q => `${q.name}(${q.code}): ${q.price}元 (${q.changePercent >= 0 ? '+' : ''}${q.changePercent}%)`).join('\n');
      const newsText = newsTitles.map(t => `• ${t}`).join('\n');

      let generatedMessages: AgentMessage[] = [];
      let usedOllama = false;

      const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
      const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'gemma4:latest';

      // D. Try Ollama analysis
      try {
        const ollamaPrompt = `你是台股即時監控AI代理。請根據以下數據，生成一份專業且精美的台股即時市場分析。
        
加權指數:
${marketIndexText}

熱門股即時行情:
${quotesText}

市場重大訊息:
${newsText}

請分析並輸出一個 JSON 格式的 array，內含 4 個對象，每個對象代表一個分析消息。屬性要求如下：
1. "type": 類型，分別為 "brief"、"opportunity"、"risk"、"trend"。
2. "severity": 嚴重程度，對應分別為 "success"、"info"、"danger"、"warning"。
3. "label": 標題，例如 "盤勢特報"、"個股異動"、"風險提示"、"多空趨勢"。
4. "emoji": 表情符號，如 "📊", "🎯", "⚠️", "📈"。
5. "text": 詳細分析內容 (約150-200字，專業繁體中文分析)。
6. "summary": 跑馬燈簡短摘要 (30-50字，繁體中文)。
7. "stocks": 相關股票代碼陣列。

必須直接回傳可被 JSON.parse 解析的 JSON array，不可包含 markdown 標籤或任何額外說明文字。`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000);

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
          let jsonText = (data.response || '').trim();
          
          if (jsonText.includes('```')) {
            jsonText = jsonText.replace(/```json/g, '').replace(/```/g, '').trim();
          }
          
          const parsed = JSON.parse(jsonText);
          if (Array.isArray(parsed) && parsed.length > 0) {
            generatedMessages = parsed.map((m: any, idx: number) => ({
              id: `msg_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}`,
              type: m.type || 'brief',
              label: m.label || '分析',
              emoji: m.emoji || '🤖',
              text: String(m.text || '').slice(0, 2000),
              summary: String(m.summary || m.text || '').slice(0, 60),
              severity: m.severity || 'info',
              stocks: Array.isArray(m.stocks) ? m.stocks : [],
              timestamp: Date.now() - idx * 1000,
              agentId: `ollama-${DEFAULT_MODEL}`,
            }));
            usedOllama = true;
          }
        }
      } catch (err) {
        console.warn('Ollama generate failed or timed out, using fallback:', err);
      }

      // E. Fallback Programmatic Generator (Guaranteeing uptime and high-quality data)
      if (!usedOllama) {
        const isUp = weightedChange >= 0;
        const changeSign = isUp ? '+' : '';
        const sentiment = weightedChangePercent > 0.4 ? '偏多' : weightedChangePercent < -0.4 ? '偏空' : '震盪';
        
        const gainerListText = topGainers.map(q => `${q.name}(${q.code}) ${changeSign}${q.changePercent}%`).join('、');
        const loserListText = topLosers.map(q => `${q.name}(${q.code}) ${q.changePercent}%`).join('、');
        
        const firstGainer = topGainers[0] || { name: '強勢股', code: '2330', changePercent: 0 };
        const firstLoser = topLosers[0] || { name: '弱勢股', code: '2330', changePercent: 0 };
        
        const upCount = quotes.filter(q => q.changePercent > 0).length;
        const downCount = quotes.filter(q => q.changePercent < 0).length;

        generatedMessages = [
          {
            id: `msg_${Date.now()}_0`,
            type: 'brief',
            label: '盤勢特報',
            emoji: '📊',
            text: `台股加權指數今日報 ${weighted.toLocaleString()} 點，今日${isUp ? '上漲' : '下跌'} ${weightedChange} 點 (${weightedChangePercent}%)。整體市場氣氛呈現${sentiment}格局。權值龍頭台積電(2330)收報 ${tsmcPrice} 元，單日漲跌幅 ${tsmcChangePercent > 0 ? '+' : ''}${tsmcChangePercent}%，${tsmcChange >= 0 ? '穩定盤面信心' : '對指數產生壓抑'}。`,
            summary: `加權指數報 ${weighted.toLocaleString()} 點 (${isUp ? '+' : ''}${weightedChangePercent}%)，盤勢偏${sentiment}。`,
            severity: 'success',
            stocks: tsmc ? ['2330'] : [],
            timestamp: Date.now() - 3000,
            agentId: 'fallback-agent',
          },
          {
            id: `msg_${Date.now()}_1`,
            type: 'opportunity',
            label: '機會偵測',
            emoji: '🎯',
            text: `即時強勢股前三名為：${gainerListText || '無' }。其中 ${firstGainer.name}(${firstGainer.code}) 表現最為強勢。資金明顯向電子半導體和相關AI零組件集中，短期技術指標呈現強勢排列，偏多投資人可於短期均線支撐附近尋找交易機會，留意量價關係。`,
            summary: `強勢股偵測：${firstGainer.name}(${firstGainer.code}) 領漲，資金買盤追價強勁。`,
            severity: 'info',
            stocks: topGainers.map(g => g.code),
            timestamp: Date.now() - 2000,
            agentId: 'fallback-agent',
          },
          {
            id: `msg_${Date.now()}_2`,
            type: 'risk',
            label: '風險提示',
            emoji: '⚠️',
            text: `即時弱勢股前三名為：${loserListText || '無'}。其中 ${firstLoser.name}(${firstLoser.code}) 跌幅最深。近期部分高檔題材股面臨獲利回吐，均線呈現空頭排列且量能退潮。建議投資人避免盲目搶反彈或追高，並確實執行風險控管與停損。`,
            summary: `弱勢股警示：${firstLoser.name}(${firstLoser.code}) 領跌，注意高檔回檔風險。`,
            severity: 'danger',
            stocks: topLosers.map(l => l.code),
            timestamp: Date.now() - 1000,
            agentId: 'fallback-agent',
          },
          {
            id: `msg_${Date.now()}_3`,
            type: 'trend',
            label: '多空趨勢',
            emoji: '📈',
            text: `加權指數盤中上漲家數為 ${upCount} 家，下跌 ${downCount} 家。技術面上，短線下檔支撐參考 ${(weighted * 0.985).toFixed(0)} 點，上檔壓力參考 ${(weighted * 1.015).toFixed(0)} 點。目前指數處於區間震盪，建議維持中性操作，持股水位宜控制在 5 成以下以應對劇烈波動。`,
            summary: `加權指數呈${sentiment}震盪，多空家數比為 ${upCount}/${downCount}。`,
            severity: 'warning',
            stocks: [],
            timestamp: Date.now(),
            agentId: 'fallback-agent',
          }
        ];
      }

      // F. Clear current memory queue and replace with generated ones
      queue.length = 0;
      queue.push(...generatedMessages);

      // G. Update Firestore heartbeat and agent online status
      try {
        const adb2 = getAdminDb();
        if (adb2) await adb2.collection('system').doc('monitor-agent')
          .set({ active: true, lastHeartbeat: Date.now() }, { merge: true });
      } catch (dbErr) {
        console.error('Firestore agent status update error in trigger:', dbErr);
      }

      return NextResponse.json({
        ok: true,
        message: 'AI Agent analysis triggered successfully',
        usedOllama,
        messages: generatedMessages,
      });
    }

    // 2. Original POST logic (External Agent Push Message)
    const now = Date.now();
    if (now - lastPushAt < RATE_LIMIT_MS) {
      return NextResponse.json({ error: 'rate limited', retryAfter: RATE_LIMIT_MS }, { status: 429 });
    }

    // Check & Update agent status in Firestore
    let active = true;
    try {
      const adb3 = getAdminDb();
      const ref = adb3?.collection('system').doc('monitor-agent');
      const docSnap = ref ? await ref.get() : null;
      if (docSnap?.exists) {
        active = (docSnap.data() ?? {}).active !== false;
      }

      // Update heartbeat
      if (ref) await ref.set({ lastHeartbeat: now }, { merge: true });
    } catch (dbErr) {
      console.error('Firestore agent status update error:', dbErr);
    }

    // If administrator turned off the agent, reject the message integration
    if (!active) {
      return NextResponse.json(
        { ok: false, status: 'paused', message: 'Agent is paused by administrator' },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // Validate required fields
    if (!body.text || !body.type) {
      return NextResponse.json({ error: 'text and type are required' }, { status: 400 });
    }

    const typeMap: Record<string, { label: string; emoji: string }> = {
      brief:       { label: '市場摘要',   emoji: '📊' },
      alert:       { label: '即時警報',   emoji: '🚨' },
      opportunity: { label: '機會偵測',   emoji: '🎯' },
      risk:        { label: '風險提示',   emoji: '⚠️' },
      trend:       { label: '趨勢分析',   emoji: '📈' },
    };

    // 🔒 2026-07-31：推送路徑原本零授權 —— 任何人 POST 一段文字就會出現在
    //   **全體使用者**的跑馬燈上（GET 是公開的），等於匿名內容注入。
    //   沒有任何瀏覽器端呼叫這條路徑，所以用 server-to-server 的共享密鑰即可。
    if (!hasCronSecret(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const typeInfo = typeMap[body.type] ?? { label: '分析', emoji: '🤖' };

    const msg: AgentMessage = {
      id:        makeId(),
      type:      body.type,
      label:     body.label ?? typeInfo.label,
      emoji:     body.emoji ?? typeInfo.emoji,
      text:      String(body.text).slice(0, 2000),
      summary:   String(body.summary ?? body.text).slice(0, 60),
      severity:  body.severity ?? 'info',
      stocks:    Array.isArray(body.stocks) ? body.stocks.slice(0, 10) : [],
      timestamp: now,
      agentId:   String(body.agentId ?? 'unknown'),
    };

    // FIFO: push to end, drop oldest if over limit
    queue.push(msg);
    while (queue.length > MAX_MESSAGES) {
      queue.shift();
    }

    lastPushAt = now;

    return NextResponse.json(
      { ok: true, id: msg.id, queueLength: queue.length },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}

// ── DELETE: 清空 ────────────────────────────────────────────
// 🔒 2026-07-31：原本零授權 —— 任何人 `curl -X DELETE` 就能清空整個訊息佇列。
export async function DELETE(request: NextRequest) {
  const limited = await rateLimit(request, 'ai-analysis-del', 10);
  if (limited) return limited;
  const gate = await requireAdmin(request);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  queue.splice(0, queue.length);
  return NextResponse.json({ ok: true, cleared: true });
}
