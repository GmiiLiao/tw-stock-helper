// ── FinMind 請求限速：令牌桶（平滑）＋滾動一小時硬上限＋每秒上限 ─────────────────────
//   capFor(now) 由 timewin.hourlyCapAt 提供（平日盤中 1,500、其餘 5,000）；伺服器回報的上限（api_request_limit_hour）
//   低於本機設定時取其 90%。seed(n) 以 user_info 的 user_count 預佔額度（視為過去一小時平均送出），重啟後不會一口氣衝過上限。
//   時鐘可注入，單元測試不睡覺。
const HOUR = 3600e3;
const SERVER_MARGIN = 0.9;

export function createRateLimiter({ now = Date.now, capFor = () => 5000, perSecond = 2, burst = 20 } = {}) {
  const stamps = [];   // 過去一小時內的請求時刻（遞增）
  let tokens = burst;
  let last = now();
  let serverCap = Infinity;

  const cap = () => Math.max(1, Math.min(capFor(now()), serverCap));
  const prune = () => { const t = now(); while (stamps.length && stamps[0] <= t - HOUR) stamps.shift(); };
  const refill = () => {
    const t = now();
    tokens = Math.min(burst, tokens + Math.max(0, t - last) * (cap() / HOUR));
    last = t;
  };

  return {
    cap,
    inLastHour() { prune(); return stamps.length; },
    /** 現在要再等多少毫秒才能送下一個請求（0＝可送）。 */
    waitMs() {
      refill(); prune();
      const t = now(); const c = cap();
      let w = 0;
      if (tokens < 1) w = Math.max(w, Math.ceil((1 - tokens) * HOUR / c));
      if (stamps.length >= c) w = Math.max(w, stamps[stamps.length - c] + HOUR - t);
      const prev = stamps[stamps.length - 1];
      if (prev != null) w = Math.max(w, prev + 1000 / perSecond - t);
      return Math.max(0, Math.ceil(w));
    },
    /** 送出一個請求後登記。 */
    record() { refill(); tokens -= 1; stamps.push(now()); },
    /**
     * 以伺服器已用量預佔：視為過去一小時內平均送出（逐步過期）。
     * 舊版視為「剛剛送出」，重啟後要整整等一小時才能用（2026-10-08 實測：伺服器 4,343 時重啟，1,044 個請求卡到隔一小時）；
     * 每小時上限照樣守住（近一小時合計不超過 cap），伺服器用量另由 user_info 每 300 個請求監看（≥95% 暫停）。
     */
    seed(n) {
      const k = Math.floor(Number(n));
      if (!Number.isFinite(k) || k <= 0) return;
      const t = now();
      const seeded = Array.from({ length: k }, (_, i) => t - HOUR + ((i + 1) * HOUR) / (k + 1));
      const merged = [...stamps, ...seeded].sort((a, b) => a - b);
      stamps.length = 0; stamps.push(...merged);
      tokens = Math.min(tokens, 0);
    },
    /** 伺服器回報的每小時上限（取 90%）。 */
    setServerCap(limitHour) {
      const v = Number(limitHour);
      if (limitHour == null || !Number.isFinite(v) || v <= 0) return;
      serverCap = Math.floor(v * SERVER_MARGIN);
    },
  };
}
