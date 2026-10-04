// ============================================================
// Market report store (server-only). Holds the after-close 盤勢分析
// produced by the daily cron, so the app can show "yesterday's close
// analysis" instantly without recomputing.
//
// Schema: collection `marketReports` / doc `{YYYY-MM-DD}`  + doc `latest`.
// ============================================================

import { getAdminDb } from './firebase-admin';

export interface ReportPick {
  code: string;
  name: string;
  score: number;
  grade: string;
  signal: string;
  price: number;
  changePercent: number;
  /** standard MA-support buy zone price, if available */
  buy: number | null;
  /** first sell target price, if available */
  target: number | null;
  stopLoss: number | null;
  reasons: string[];
}

export interface MarketReport {
  date: string;            // ISO trading date the report covers
  generatedAt: number;     // epoch ms
  breadth: { up: number; down: number; flat: number; total: number; advancePct: number };
  topPicks: ReportPick[];
  riskHighlights: string[];
  summary: string;
  meta: { totalAnalyzed: number; enriched: number; historyCovered: number; /** false＝處置名單殘缺，精選未能排除處置股（G2-10） */ dispositionComplete?: boolean };
}

const COLLECTION = 'marketReports';

export async function writeMarketReport(report: MarketReport): Promise<void> {
  const db = getAdminDb();
  if (!db) throw new Error('Admin Firestore unavailable (no credentials)');
  await Promise.all([
    db.collection(COLLECTION).doc(report.date).set(report),
    db.collection(COLLECTION).doc('latest').set(report),
  ]);
}

export async function readLatestReport(): Promise<MarketReport | null> {
  const db = getAdminDb();
  if (!db) return null;
  try {
    const snap = await db.collection(COLLECTION).doc('latest').get();
    return snap.exists ? (snap.data() as MarketReport) : null;
  } catch (e) {
    console.warn('[report-store] readLatestReport failed', e);
    return null;
  }
}

export async function readReport(date: string): Promise<MarketReport | null> {
  const db = getAdminDb();
  if (!db) return null;
  try {
    const snap = await db.collection(COLLECTION).doc(date).get();
    return snap.exists ? (snap.data() as MarketReport) : null;
  } catch (e) {
    console.warn('[report-store] readReport failed', date, e);
    return null;
  }
}
