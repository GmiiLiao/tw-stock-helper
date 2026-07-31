// ============================================================
// Pre-market brief store (server-only, admin). The resident daemon
// publishes a 開盤前 AI 策略快報 (~08:45 Taipei on trading days):
// 10 high-potential picks with entry/exit + a market strategy narrative.
// Read by /api/premarket-brief and shown to premium members.
// ============================================================

import { getAdminDb } from './firebase-admin';

export interface PremarketPick {
  code: string;
  name: string;
  signal: string;
  signalLabel: string;   // 強力買進 / 買進 / 觀察 / 中性
  score: number;
  price: number;
  changePercent: number;
  buy: number | null;    // 建議進場 (MA 支撐)
  target: number | null; // 目標 (AI 推估)
  stop: number | null;   // 停損
  note: string;          // 一句話進出場/操作建議
  swingAction?: string;  // 波段分級（強力買進/買進/…）
  swingScore?: number;   // 波段紀律評分 0-100
  swingBias?: number;    // 乖離率 %
  chase?: boolean;       // 追高風險（乖離>5%）
}

export interface PremarketBrief {
  date: string;          // ISO trading date
  generatedAt: number;
  model: string;
  marketStrategy: string;   // AI 大盤策略敘述
  picks: PremarketPick[];   // 10 檔
  disclaimer: string;
}

const COLLECTION = 'premarketBrief';

export async function writePremarketBrief(brief: PremarketBrief): Promise<void> {
  const db = getAdminDb();
  if (!db) throw new Error('Admin Firestore unavailable');
  await Promise.all([
    db.collection(COLLECTION).doc(brief.date).set(brief),
    db.collection(COLLECTION).doc('latest').set(brief),
  ]);
}

export async function readLatestPremarket(): Promise<PremarketBrief | null> {
  const db = getAdminDb();
  if (!db) return null;
  try {
    const snap = await db.collection(COLLECTION).doc('latest').get();
    return snap.exists ? (snap.data() as PremarketBrief) : null;
  } catch (e) {
    console.warn('[premarket-store] readLatest failed', e);
    return null;
  }
}
