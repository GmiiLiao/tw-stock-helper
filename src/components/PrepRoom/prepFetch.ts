// 盤前備課各分頁共用的 JSON 讀取（2026-10-05）：
//   呼叫端 signal（卸載／startLiveLoop 停止時 abort）＋ 8 秒逾時（CLAUDE.md：fetch 一律 AbortSignal.timeout(8000)）。
//   非 2xx 一律丟錯，讓 startLiveLoop 退避、呼叫端保留上一份資料；不吞錯、不回假資料。
// SqueezePanel／GapLimitUpPanel 也用這支（它們同時掛在舊版戰情，行為兩邊一致）。

export const PREP_FETCH_TIMEOUT_MS = 8_000;

/** 呼叫端 signal＋8 秒逾時合成一個 signal（AbortSignal.any 不存在的舊瀏覽器走手動串接） */
export function withFetchTimeout(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(PREP_FETCH_TIMEOUT_MS);
  if (!parent) return timeout;
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === 'function') return any([parent, timeout]);
  const ac = new AbortController();
  const relay = (s: AbortSignal) => () => ac.abort(s.reason);
  if (parent.aborted) ac.abort(parent.reason);
  else if (timeout.aborted) ac.abort(timeout.reason);
  else {
    parent.addEventListener('abort', relay(parent), { once: true });
    timeout.addEventListener('abort', relay(timeout), { once: true });
  }
  return ac.signal;
}

/** GET JSON；回傳值可能是 null（latestDoc：文件尚未產生）——呼叫端自行驗證形狀 */
export async function prepFetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const r = await fetch(url, { signal: withFetchTimeout(signal) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** 給畫面看的短句：逾時／HTTP 狀態，不含內部細節 */
export function fetchErrorText(e: unknown): string {
  if (e instanceof Error && e.name === 'TimeoutError') return `逾時（${PREP_FETCH_TIMEOUT_MS / 1000} 秒）`;
  if (e instanceof Error && e.message) return e.message;
  return '讀取失敗';
}
