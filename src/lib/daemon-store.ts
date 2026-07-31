// ============================================================
// Resident AI daemon store (server-only, admin SDK).
//   • system/ai-daemon              — heartbeat + status
//   • users/{uid}/data/portfolioAnalysis — per-user holdings analysis
//
// The local daemon (scripts/ai-daemon.mjs) writes both; the app reads
// the heartbeat via /api/ai/daemon-status and the per-user analysis via
// the authed client SDK (own data).
// ============================================================

import { getAdminDb } from './firebase-admin';

export interface DaemonHeartbeat {
  active: boolean;
  lastHeartbeat: number; // epoch ms
  host?: string;
  model?: string;
  analyzedUsers?: number;
  note?: string;
}

export interface HoldingAnalysis {
  code: string;
  name: string;
  action: '續抱' | '加碼' | '減碼' | '出脫' | '換股' | '觀望';
  pnlPct: number;
  targetPrice: { low: number | null; mid: number | null; high: number | null }; // AI 推估
  stopLoss: number | null;
  sellTrigger: string;          // 何時脫手 / 條件
  newsSummary: string;
  rationale: string;            // 主要分析敘述
  isRisk: boolean;
  riskType: 'attention' | 'disposition' | null;
  swingAdvice: string | null;   // 波段操作建議（注意/處置股）
}

export interface PortfolioAnalysisDoc {
  uid: string;
  generatedAt: number;
  model: string;
  analyses: Record<string, HoldingAnalysis>; // keyed by code
}

const DAEMON_DOC = ['system', 'ai-daemon'] as const;

export async function writeHeartbeat(hb: DaemonHeartbeat): Promise<void> {
  const db = getAdminDb();
  if (!db) throw new Error('Admin Firestore unavailable');
  await db.collection(DAEMON_DOC[0]).doc(DAEMON_DOC[1]).set(hb, { merge: true });
}

export async function readHeartbeat(): Promise<DaemonHeartbeat | null> {
  const db = getAdminDb();
  if (!db) return null;
  try {
    const snap = await db.collection(DAEMON_DOC[0]).doc(DAEMON_DOC[1]).get();
    return snap.exists ? (snap.data() as DaemonHeartbeat) : null;
  } catch (e) {
    console.warn('[daemon-store] readHeartbeat failed', e);
    return null;
  }
}

export async function writePortfolioAnalysis(doc: PortfolioAnalysisDoc): Promise<void> {
  const db = getAdminDb();
  if (!db) throw new Error('Admin Firestore unavailable');
  await db.collection('users').doc(doc.uid).collection('data').doc('portfolioAnalysis').set(doc);
}

/** Per-stock AI swing evaluation (shared by code), written by the daemon. */
export interface StockAI {
  code: string;
  name: string;
  signal: string;        // deterministic rating signal at analysis time
  signalLabel: string;   // 強力買進 / 買進 / 觀察 / 中性
  swing: string;         // AI 波段操作分析（grounded prose）
  news?: Array<{ title: string; time?: string; source?: string; url?: string }>; // cached news for sentiment fallback
  generatedAt: number;
  model: string;
}

export async function readStockAI(code: string): Promise<StockAI | null> {
  const db = getAdminDb();
  if (!db) return null;
  try {
    const snap = await db.collection('stockAI').doc(code).get();
    return snap.exists ? (snap.data() as StockAI) : null;
  } catch (e) {
    console.warn('[daemon-store] readStockAI failed', code, e);
    return null;
  }
}

/** List premium+ users (the daemon analyses their holdings). */
export async function listPremiumUsers(): Promise<Array<{ uid: string; level: string }>> {
  const db = getAdminDb();
  if (!db) return [];
  const out: Array<{ uid: string; level: string }> = [];
  try {
    const snap = await db.collection('users').get();
    for (const d of snap.docs) {
      const lvl = (d.data().level as string) || 'registered';
      if (['premium', 'admin', 'superadmin'].includes(lvl)) out.push({ uid: d.id, level: lvl });
    }
  } catch (e) {
    console.warn('[daemon-store] listPremiumUsers failed', e);
  }
  return out;
}

/** Read a user's holdings array from users/{uid}/data/holdings. */
export async function readUserHoldings(uid: string): Promise<Array<{ code: string; name: string; buyPrice: number; quantity: number; buyDate?: string }>> {
  const db = getAdminDb();
  if (!db) return [];
  try {
    const snap = await db.collection('users').doc(uid).collection('data').doc('holdings').get();
    return snap.exists ? ((snap.data()?.holdings as []) || []) : [];
  } catch (e) {
    console.warn('[daemon-store] readUserHoldings failed', uid, e);
    return [];
  }
}
