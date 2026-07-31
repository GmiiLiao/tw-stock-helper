import { NextRequest, NextResponse } from 'next/server';
import { readNote, writeNote, type AiNote } from '@/lib/note-store';

export const runtime = 'nodejs';

// ============================================================
// /api/ai/stock-note
//   GET  ?code=2330           → read the local-AI analysis note
//   POST { code, analysis, model, name }  → store one (from local pipeline)
//
// POST is guarded by CRON_SECRET (same as the daily cron) so only the
// local second-brain pipeline can write notes.
// ============================================================

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const provided = req.headers.get('x-cron-secret') || req.nextUrl.searchParams.get('secret');
  return provided === secret;
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')?.trim();
  if (!code) return NextResponse.json({ error: 'Missing code' }, { status: 400 });
  const note = await readNote(code);
  if (!note) return NextResponse.json({ error: 'No note yet', code }, { status: 404 });
  return NextResponse.json(note, {
    headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=120' },
  });
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: Partial<AiNote>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }); }
  if (!body.code || !body.analysis) {
    return NextResponse.json({ error: 'code and analysis required' }, { status: 400 });
  }
  const note: AiNote = {
    code: body.code,
    name: body.name,
    analysis: body.analysis,
    model: body.model || 'unknown',
    source: body.source || 'local-ollama',
    generatedAt: Date.now(),
  };
  try {
    await writeNote(note);
    return NextResponse.json({ ok: true, code: note.code });
  } catch (e) {
    console.error('[api/ai/stock-note] write failed', e);
    return NextResponse.json({ error: 'write failed' }, { status: 500 });
  }
}
