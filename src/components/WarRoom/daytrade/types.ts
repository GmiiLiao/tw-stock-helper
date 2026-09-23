// 當沖工作台前端型別（對應 daemon scripts/lib/daytrade-engine.mjs 的 daytradeAlerts/live 輸出）
export type Side = 'long' | 'short';

export interface ScoreItem { key: string; label: string; max: number; score: number | null; evidence: string }
export interface ScorePart { score: number; knownMax: number; max: number }
export interface DeskScore {
  market: ScoreItem[]; stock: ScoreItem[]; entry: ScoreItem[];
  total: number; knownMax: number; missing: string[]; tier: '優先觀察' | '等待' | '低優先' | null;
  parts: { market: ScorePart; stock: ScorePart; entry: ScorePart };
}
export interface DeskPlan {
  type: string; why: string; t: number; entry: number; stop: number; d: number; costR: number;
  targets: number[]; hit: boolean[]; trail: number; exit: { t: number; px: number; reason: string } | null; netR: number | null;
}
export interface DeskWatch { type: string; trigger: number | null; stop: number | null; note: string }
export interface AlertSt {
  phase: 'on' | 'stop'; since: number; entry: number; best: number; room: number | null;
  stopAt: number | null; stopPx: number | null; ret: number | null; n: number; reason?: string; netR?: number | null;
}
export interface DeskRowData {
  code: string; name: string; st: AlertSt | null;
  m: { at: number; c: number; chg: number; vwap: number | null; vwapDev: number | null; pace: number | null; bars: number };
  score: DeskScore; warnings: string[]; plan: DeskPlan | null; watch: DeskWatch[];
  vetoed: { type: string; t: number; veto: string[] } | null;
  orb: { O: number; H: number; L: number; formedAt: number } | null; falseBreaks: number;
}
export interface AlertEvent { t: number; code: string; name: string; side: Side; kind: 'on' | 'stop'; px: number; room: number | null; ret: number | null; reason: string | null; type: string | null }
export interface SideBucket { trN: number; teN: number; trR: number; teR: number; trWin?: number; teWin?: number; teHit1?: number; teHit2?: number }
export interface DeskEvidence { version: string; from: string; to: string; days: number; cut: string; verdict: string; long: Record<string, SideBucket>; short: Record<string, SideBucket> }
export interface AlertDoc {
  found: boolean; date?: string; at?: number; version?: string;
  params?: { orbBars: number; timeStopBars: number; noNewAfter: number; closeOut: number; maxStopPct: number; maxVwapDevPct: number; minNetR2: number; nearLimitPct: number };
  evidence?: DeskEvidence | null; long?: DeskRowData[]; short?: DeskRowData[]; events?: AlertEvent[];
}
/** 名單列（預測榜／轉空型態），不一定在 5 秒監控內 */
export interface BaseRow {
  side: Side; code: string; name: string; market: string; rank: number;
  price: number | null; chg: number | null; hiUp: number | null; give: number | null; vwapDev: number | null;
  label: string; labelColor: string; reason: string;
}
