'use client';

import { useEffect, useState } from 'react';

// ── 每檔「近 10 日漲跌×成交量 ＋ 三線位置」共用取用（2026-09-17）──
// 資料：daemon 收盤後寫 dailySeq/latest（全市場，每日一份），route /api/twse/daily-seq?codes= 只回要的檔。
// 這個 hook 做的是「多列各自要、合成一次請求」：各列呼叫 useDailySeq(code)，50ms 內收齊的代號合併成一批
// （最多 60 檔／批），模組層快取到資料日換天為止。列再多、上游都是 0——資料在 Firestore，符合唯一不變式。
// 形狀（與 daemon 一致）：[ma5, ma20, ma60, chg1, vol1, …, chg10, vol10]；ma 旗標 1=站上、0=之下、-1=資料不足。

export type DailySeq = number[];
const cache = new Map<string, DailySeq | null>();   // null＝查過但沒有（例：興櫃／新股）
let cacheDate = '';
const pending = new Set<string>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

const notify = () => { for (const l of listeners) l(); };

async function flush() {
  timer = null;
  const codes = [...pending]; pending.clear();
  for (let i = 0; i < codes.length; i += 60) {
    const batch = codes.slice(i, i + 60);
    try {
      const r = await fetch(`/api/twse/daily-seq?codes=${batch.join(',')}`);
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      if (j?.dataDate && j.dataDate !== cacheDate) { cache.clear(); cacheDate = j.dataDate; }   // 換天：整批作廢
      for (const c of batch) cache.set(c, j?.seq?.[c] ?? null);
    } catch {
      // 失敗不寫 null（那是「查過沒有」的意思）；留在未知狀態，下次掛載再要
    }
  }
  notify();
}

function request(code: string) {
  if (cache.has(code) || pending.has(code)) return;
  pending.add(code);
  if (!timer) timer = setTimeout(flush, 50);
}

export function useDailySeq(code: string | null | undefined): DailySeq | null | undefined {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!code) return;
    const l = () => bump(v => v + 1);
    listeners.add(l);
    request(code);
    return () => { listeners.delete(l); };
  }, [code]);
  if (!code) return undefined;
  return cache.get(code);   // undefined＝還沒回來；null＝沒有此檔
}

export const dailySeqMa = (s: DailySeq | null | undefined): (boolean | null)[] | undefined =>
  s ? s.slice(0, 3).map(v => (v === 1 ? true : v === 0 ? false : null)) : undefined;
export const dailySeqPairs = (s: DailySeq | null | undefined): number[] | undefined => (s ? s.slice(3) : undefined);
