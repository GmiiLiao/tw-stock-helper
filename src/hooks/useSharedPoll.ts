'use client';

/**
 * 共享輪詢 hook —— 解決前端三個結構性問題
 *
 * 1) **同一支 API 被多個元件各自輪詢**
 *    /api/twse/market-index 目前有 3 個常駐元件在打（Header.tsx:63 每 5 秒、
 *    AiNewsTicker.tsx:164 每 60 秒、DecisionDesk.tsx:114 每 30 秒），
 *    每次觸發 7 個外部請求。改用同一個 key 之後，N 個元件共用一條輪詢。
 *
 * 2) **document.hidden 判斷全站 0 次**
 *    38 個輪詢點沒有一個會在分頁切到背景時停下來。
 *    使用者把分頁丟著過夜，5 秒輪詢照打一整晚。
 *
 * 3) **間隔只在掛載時算一次**
 *    `setInterval(load, isTradingHours() ? 30_000 : 120_000)` 這種寫法，
 *    三元判斷在 effect 掛載當下算一次就固定死。
 *    早上 8:50 開頁的人整天卡在慢速；13:00 開頁的人整夜維持高頻。
 *    這裡用遞迴 setTimeout，每次都重算。
 *
 * 對照 worldmonitor `src/services/smart-poll-loop.ts`（VisibilityHub 多路複用
 * 單一 visibilitychange listener）與 `src/app/refresh-scheduler.ts`（named
 * in-flight guard + 分批 stagger 避免 resume 時的 thundering herd）。
 */

import { useEffect, useRef, useState } from 'react';
import { pollInterval } from '@/lib/market-clock';

type Subscriber<T> = (data: T | null, err: unknown) => void;

interface Channel<T> {
  url: string;
  fetcher: () => Promise<T>;
  subs: Set<Subscriber<T>>;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  last: T | null;
  lastAt: number;
  failures: number;
  intervalFor: () => number | null;
}

const channels = new Map<string, Channel<unknown>>();

/* 單一 visibilitychange listener 多路複用給所有 channel。
   38 個元件各掛一個 listener 是沒必要的。 */
let visibilityBound = false;
function bindVisibility() {
  if (visibilityBound || typeof document === 'undefined') return;
  visibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      for (const ch of channels.values()) {
        if (ch.timer) { clearTimeout(ch.timer); ch.timer = null; }
      }
      return;
    }
    // 回到前景：分批喚醒，避免所有 channel 同時打過去。
    // 高頻的先醒（使用者最有感），前 4 個間隔 100ms，其餘 300ms。
    const list = [...channels.values()]
      .filter((c) => c.subs.size > 0)
      .sort((a, b) => (a.intervalFor() ?? 1e9) - (b.intervalFor() ?? 1e9));
    list.forEach((ch, i) => {
      const delay = i < 4 ? i * 100 : 400 + (i - 4) * 300;
      ch.timer = setTimeout(() => void run(ch), delay);
    });
  });
}

async function run<T>(ch: Channel<T>): Promise<void> {
  if (ch.inFlight) { schedule(ch); return; }          // 自我去重
  if (typeof document !== 'undefined' && document.hidden) { ch.timer = null; return; }
  if (ch.subs.size === 0) { ch.timer = null; return; } // 沒人訂閱就停

  ch.inFlight = true;
  try {
    const data = await ch.fetcher();
    ch.last = data;
    ch.lastAt = Date.now();
    ch.failures = 0;
    ch.subs.forEach((s) => s(data, null));
  } catch (err) {
    ch.failures += 1;
    ch.subs.forEach((s) => s(ch.last, err));
  } finally {
    ch.inFlight = false;
    schedule(ch);
  }
}

function schedule<T>(ch: Channel<T>): void {
  if (ch.timer) clearTimeout(ch.timer);
  const base = ch.intervalFor();
  if (base === null) {
    // 休市或分頁在背景 —— 完全停擺。60 秒後再回來看時段有沒有變。
    ch.timer = setTimeout(() => void run(ch), 60_000);
    return;
  }
  // 失敗指數退避，上限 8 倍；±10% jitter 避免多分頁同步撞上游
  const backoff = Math.min(2 ** ch.failures, 8);
  const jitter = 0.9 + Math.random() * 0.2;
  ch.timer = setTimeout(() => void run(ch), Math.round(base * backoff * jitter));
}

export interface SharedPollOptions {
  /** 盤中間隔（ms） */
  regularMs: number;
  /** 盤前間隔，預設 regularMs × 2 */
  preOpenMs?: number;
  /** 休市間隔；傳 null（預設）代表休市時完全停止輪詢 */
  closedMs?: number | null;
  /** 掛載時若已有 N 毫秒內的資料就直接用，不重打 */
  freshMs?: number;
}

/**
 * @param key   同一個 key 的所有元件共用一條輪詢。用 API 路徑當 key 即可。
 * @param fetcher 實際取資料的函式
 */
export function useSharedPoll<T>(
  key: string,
  fetcher: () => Promise<T>,
  opts: SharedPollOptions,
): { data: T | null; error: unknown; loading: boolean; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    bindVisibility();

    let ch = channels.get(key) as Channel<T> | undefined;
    if (!ch) {
      ch = {
        url: key,
        fetcher,
        subs: new Set(),
        timer: null,
        inFlight: false,
        last: null,
        lastAt: 0,
        failures: 0,
        intervalFor: () =>
          pollInterval({
            regularMs: optsRef.current.regularMs,
            preOpenMs: optsRef.current.preOpenMs,
            closedMs: optsRef.current.closedMs ?? null,
          }),
      };
      channels.set(key, ch as Channel<unknown>);
    }

    const sub: Subscriber<T> = (d, e) => {
      setData(d);
      setError(e);
      setLoading(false);
    };
    ch.subs.add(sub);

    // 已經有夠新的資料就直接用，不要為了新訂閱者再打一次
    const fresh = optsRef.current.freshMs ?? optsRef.current.regularMs;
    if (ch.last !== null && Date.now() - ch.lastAt < fresh) {
      sub(ch.last, null);
    } else if (!ch.timer && !ch.inFlight) {
      void run(ch);
    }

    return () => {
      ch!.subs.delete(sub);
      if (ch!.subs.size === 0 && ch!.timer) {
        clearTimeout(ch!.timer);
        ch!.timer = null;
      }
    };
    // key 變了才重新訂閱；fetcher identity 變動不應該重建 channel
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const refresh = () => {
    const ch = channels.get(key) as Channel<T> | undefined;
    if (ch && !ch.inFlight) void run(ch);
  };

  return { data, error, loading, refresh };
}

/** 診斷：目前有幾條輪詢在跑、各有幾個訂閱者 */
export function pollChannelStats() {
  return [...channels.entries()].map(([k, c]) => ({
    key: k,
    subscribers: c.subs.size,
    intervalMs: c.intervalFor(),
    failures: c.failures,
    ageMs: c.lastAt ? Date.now() - c.lastAt : null,
  }));
}
