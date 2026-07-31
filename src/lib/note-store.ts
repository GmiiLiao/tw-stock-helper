// ============================================================
// AI note store (server-only). Holds analyses produced by the LOCAL
// second-brain + Ollama pipeline (scripts/local-analyze.mjs), so the
// app can surface "local AI commentary" to users.
//
// Schema: collection `aiNotes` / doc `{code}`.
// ============================================================

import { getAdminDb } from './firebase-admin';

export interface AiNote {
  code: string;
  name?: string;
  analysis: string;      // markdown / plain text
  model: string;         // e.g. 'gemma4:latest'
  source: string;        // e.g. 'local-ollama'
  generatedAt: number;   // epoch ms
}

const COLLECTION = 'aiNotes';

export async function writeNote(note: AiNote): Promise<void> {
  const db = getAdminDb();
  if (!db) throw new Error('Admin Firestore unavailable (no credentials)');
  await db.collection(COLLECTION).doc(note.code).set(note);
}

export async function readNote(code: string): Promise<AiNote | null> {
  const db = getAdminDb();
  if (!db) return null;
  try {
    const snap = await db.collection(COLLECTION).doc(code).get();
    return snap.exists ? (snap.data() as AiNote) : null;
  } catch (e) {
    console.warn('[note-store] readNote failed', code, e);
    return null;
  }
}
