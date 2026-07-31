// ── 決策歸因快照（Point-In-Time）───────────────────────────────────
// 「用了哪些功能得出這筆選股」無法事後重建（榜單每天變），必須在下單當下快照。
// 買入記錄時呼叫 captureTradeContext：抓各榜公開 API，記錄該股此刻——
//   是否在候選便條／撿尾盤榜(名次+評分)／S~B分級(級別+勝率)／漲停預測榜／
//   爆量榜／籌碼判讀／性格分類——外加使用者近 30 分鐘操作足跡。
// 寫入 users/{uid}/ctx/{tradeId}（owner 規則）；daemon 每日 join 賣出結果
// 算「功能別勝率」。fire-and-forget：失敗不影響下單流程。

import { doc, setDoc } from 'firebase/firestore';
import { db, auth } from './firebase';
import { getFootprint } from './activity-logger';

interface TradeLike { id: string; code: string; type: string; price: number; quantity: number; date: string }

const jget = async (url: string): Promise<Record<string, unknown> | null> => {
  try {
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(url, { signal: ctl.signal }).finally(() => clearTimeout(tm));
    return r.ok ? await r.json() : null;
  } catch { return null; }
};

export async function captureTradeContext(trade: TradeLike, candidateCodes: string[]): Promise<void> {
  try {
    const user = auth?.currentUser;
    if (!user || trade.type !== 'buy') return;
    const code = trade.code;

    const [picks, tail, lu, vs, verdict, character] = await Promise.all([
      jget('/api/ai/chip-picks'),
      jget('/api/twse/intraday-picks'),
      jget('/api/ai/limitup-forecast'),
      jget('/api/ai/vol-surge'),
      jget(`/api/ai/chip-verdict?codes=${code}`),
      jget('/api/ai/chip-character'),
    ]);

    // 各榜出現與名次（找不到＝null，誠實記錄）
    const rankIn = (arr: unknown, key = 'code'): { rank: number; item: Record<string, unknown> } | null => {
      if (!Array.isArray(arr)) return null;
      const i = arr.findIndex((x: Record<string, unknown>) => x?.[key] === code);
      return i >= 0 ? { rank: i + 1, item: arr[i] as Record<string, unknown> } : null;
    };
    const p = picks as Record<string, unknown[]> | null;
    const graded = rankIn(p?.graded);
    const layout = rankIn(p?.layout);
    const tailPick = rankIn((tail as Record<string, unknown> | null)?.picks as unknown[]);
    const luA = rankIn((lu as Record<string, unknown> | null)?.aList as unknown[]);
    const surge = rankIn((vs as Record<string, unknown> | null)?.items as unknown[]);
    const vd = (verdict as { byCode?: Record<string, unknown> } | null)?.byCode?.[code] ?? null;
    const charRows = (character as { rows?: { code: string }[] } | null)?.rows;
    const ch = Array.isArray(charRows) ? charRows.find(r => r.code === code) ?? null : null;

    const gi = graded?.item as { tier?: string; win?: number } | undefined;
    const ti = tailPick?.item as { score?: number; grade?: string } | undefined;
    const li = luA?.item as { score?: number } | undefined;
    const ctx = {
      tradeId: trade.id, code, side: trade.type, price: trade.price, quantity: trade.quantity,
      tradeDate: trade.date, at: Date.now(),
      // 功能出現快照
      inCandidates: candidateCodes.includes(code),
      graded: graded ? { rank: graded.rank, tier: gi?.tier ?? null, win: gi?.win ?? null } : null,
      layoutRank: layout?.rank ?? null,
      tailPick: tailPick ? { rank: tailPick.rank, score: ti?.score ?? null, grade: ti?.grade ?? null } : null,
      limitUpRank: luA ? { rank: luA.rank, score: li?.score ?? null } : null,
      volSurgeRank: surge?.rank ?? null,
      verdict: vd, character: ch,
      // 近 30 分鐘足跡（頁面／功能事件序列）
      footprint: getFootprint().map(f => ({ a: f.action, d: f.details, t: f.t })),
      // 結果由 daemon 關單後回填
      outcome: null as null | { realizedPnL: number; sellDate: string; holdDays: number },
      v: 1,
    };
    await setDoc(doc(db, 'users', user.uid, 'ctx', trade.id), JSON.parse(JSON.stringify(ctx)));
  } catch (e) {
    console.error('captureTradeContext failed (non-blocking):', e);
  }
}
