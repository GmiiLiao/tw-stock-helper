import { NextRequest, NextResponse } from 'next/server';
import { getStockDayAllDataInternal, getMarketIndexDataInternal, getMarketNewsDataInternal } from '@/lib/twse-api-server';

// ============================================================
// AI News Agent — Streams Ollama analysis of market news
// POST /api/ai/news-agent
// Body: { prompt?, marketData?, news?, model? }
// Returns: Server-Sent Events stream
// ============================================================

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'gemma4:latest';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const type = searchParams.get('type') || 'daily_brief';

  // ── Fetch live context data ───────────────────────────────
  let marketSummary = '';
  let newsTitles = '';

  try {
    const [indexRes, newsRes, stockRes] = await Promise.allSettled([
      getMarketIndexDataInternal(),
      getMarketNewsDataInternal(),
      getStockDayAllDataInternal(),
    ]);

    if (indexRes.status === 'fulfilled') {
      const idx = indexRes.value;
      const sign = idx.weightedChange >= 0 ? '+' : '';
      marketSummary = `台股加權指數：${idx.weighted.toLocaleString()} (${sign}${idx.weightedChange?.toFixed(2)}, ${sign}${idx.weightedChangePercent?.toFixed(2)}%)`;
    }

    if (newsRes.status === 'fulfilled') {
      const nd = newsRes.value;
      const titles = (nd.news || []).slice(0, 8).map((n: { title: string }) => `• ${n.title}`).join('\n');
      newsTitles = titles;
    }

    if (stockRes.status === 'fulfilled') {
      const stocks = stockRes.value;
      const limitUp   = stocks.filter(s => parseFloat(s.Change||'0') >= 9.9 * parseFloat(s.ClosingPrice||'1') / 100).length;
      const limitDown = stocks.filter(s => parseFloat(s.Change||'0') <= -9.9 * parseFloat(s.ClosingPrice||'1') / 100).length;
      const upCount   = stocks.filter(s => parseFloat(s.Change||'0') > 0).length;
      const downCount = stocks.filter(s => parseFloat(s.Change||'0') < 0).length;
      marketSummary += `\n上漲：${upCount} / 下跌：${downCount} / 漲停：${limitUp} / 跌停：${limitDown}`;

      // Top 5 gainers
      const sorted = stocks
        .filter(s => parseFloat(s.ClosingPrice||'0') > 0 && /^\d{4}$/.test(s.Code||''))
        .map(s => ({
          code: s.Code, name: s.Name,
          chg: parseFloat(s.ClosingPrice||'0') > 0
            ? (parseFloat(s.Change||'0') / (parseFloat(s.ClosingPrice||'1') - parseFloat(s.Change||'0'))) * 100
            : 0,
        }))
        .sort((a, b) => b.chg - a.chg)
        .slice(0, 5);
      const gainers = sorted.map(s => `${s.name}(${s.code}) +${s.chg.toFixed(2)}%`).join('、');
      marketSummary += `\n今日強勢：${gainers}`;
    }
  } catch (e) {
    console.error('Context fetch error:', e);
  }

  // ── Build prompt by type ──────────────────────────────────
  const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
  let prompt = '';

  switch (type) {
    case 'daily_brief':
      prompt = `你是台灣股市資深分析師，請用繁體中文，以簡潔專業的語氣分析今日市場，分三段：
【市場摘要】一句話概述今日大盤走勢
【主要驅動因素】條列2-3點今日影響市場的關鍵因素（含總經與產業）
【操作建議】今日市場給散戶的1-2個具體操作建議

當前時間：${now}
市場數據：
${marketSummary}

近期市場新聞：
${newsTitles}

請直接輸出分析，不要有前言或自我介紹，不要使用 markdown 標題符號，保持在200字以內。`;
      break;

    case 'sentiment':
      prompt = `你是台股市場情緒分析師，根據以下數據，用繁體中文評估今日市場情緒（極度恐慌/恐慌/中性/樂觀/極度樂觀），並給出情緒指數（0-100）和一句理由。

數據：${marketSummary}

格式：情緒：[等級] | 指數：[0-100] | 理由：[一句話]`;
      break;

    case 'international':
      prompt = `你是國際財經分析師，請用繁體中文評估以下因素對台股的潛在影響：
- 美聯準會利率政策走向
- 中美科技脫鉤態勢
- 輝達AI晶片需求與台積電訂單
- 全球半導體庫存週期

市場背景：${marketSummary}

請條列3個國際因素對台股的具體影響，每點控制在40字以內。`;
      break;

    case 'risk':
      prompt = `你是風險管理專家，根據今日台股數據，用繁體中文條列今日投資人需注意的3個風險點，每點含「風險描述」和「應對方法」，控制在150字內。

今日數據：${marketSummary}`;
      break;

    default:
      prompt = `用繁體中文分析：${searchParams.get('q') || '今日台股市場概況'}\n數據：${marketSummary}`;
  }

  // ── Stream Ollama response ────────────────────────────────
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const ollamaRes = await fetch(`${OLLAMA_URL}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: DEFAULT_MODEL,
            prompt,
            stream: true,
            options: {
              temperature: 0.72,
              num_predict: 400,
              top_p: 0.9,
            },
          }),
        });

        if (!ollamaRes.ok || !ollamaRes.body) {
          const errMsg = `data: ${JSON.stringify({ error: 'Ollama not available', hint: '請確認 Ollama 已啟動 (ollama serve)' })}\n\n`;
          controller.enqueue(encoder.encode(errMsg));
          controller.close();
          return;
        }

        // Send metadata first
        const meta = `data: ${JSON.stringify({
          type: 'meta',
          marketSummary,
          analysisType: type,
          model: DEFAULT_MODEL,
          timestamp: new Date().toISOString(),
        })}\n\n`;
        controller.enqueue(encoder.encode(meta));

        // Stream tokens
        const reader = ollamaRes.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split('\n').filter(l => l.trim());

          for (const line of lines) {
            try {
              const json = JSON.parse(line);
              if (json.response) {
                const sseData = `data: ${JSON.stringify({ type: 'token', token: json.response })}\n\n`;
                controller.enqueue(encoder.encode(sseData));
              }
              if (json.done) {
                const doneMsg = `data: ${JSON.stringify({ type: 'done', totalDuration: json.total_duration })}\n\n`;
                controller.enqueue(encoder.encode(doneMsg));
              }
            } catch { /* skip malformed JSON */ }
          }
        }
      } catch (err) {
        const errMsg = `data: ${JSON.stringify({
          error: 'Stream error',
          detail: String(err),
          hint: '請確認 Ollama 已啟動：在終端機執行 ollama serve',
        })}\n\n`;
        controller.enqueue(encoder.encode(errMsg));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { prompt, model } = body;

  if (!prompt) {
    return NextResponse.json({ error: 'prompt required' }, { status: 400 });
  }

  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        prompt,
        stream: false,
        options: { temperature: 0.7, num_predict: 300 },
      }),
    });

    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const data = await res.json();
    return NextResponse.json({ response: data.response, model: DEFAULT_MODEL });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 503 });
  }
}
