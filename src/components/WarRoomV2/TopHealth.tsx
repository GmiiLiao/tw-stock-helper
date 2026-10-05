'use client';

// 資料健康（指揮列健康燈＋彈窗；手機 S1 面板；放大層 'health' 也可直接掛 <TopHealthPanel/>）。
// 每一列是「該來源資料本身的時間」（revealAt／asOf／at），不是抓取時間；門檻與資料章同一支 stampOf。
// 不新增任何請求：全部取自匯流排已有的 index／quotes／pulse／board 與 build-top 的心跳、快線統計、外資台指。
import { useMemo } from 'react';
import { useWarData } from './WarRoomContext';
import { stampOf, hhmm, hhmmss, mmdd, type FreshKind, type StampState } from './parts/freshness';
import { fmtNet, netToneOf, toneClassOf } from './parts/fmt';
import type { WarSegment } from '@/lib/warroom/session';
import { indexAsOf } from './TopView';
import { useNewsBoard } from './NewsModel';
import { newsHealthOf } from '../../../scripts/lib/warroom-news.mjs';
import css from './TopZones.module.css';

/** daemon 心跳逾時門檻（與 /api/ai/daemon-status 的 STALE_MS 同值） */
const HEARTBEAT_STALE_MS = 180_000;
const POLLING: ReadonlySet<WarSegment> = new Set(['pre', 'preclear', 'open', 'mid', 'tail', 'auction', 'closing']);

export type HealthStatus = 'ok' | 'warn' | 'bad';

interface Row { key: string; label: string; time: string; state: StampState | 'ok' | 'bad' | 'none'; note: string }

export interface HealthView { status: HealthStatus; label: string; rows: Row[]; failed: readonly string[] }

const BAD_STATES: ReadonlySet<Row['state']> = new Set(['stale', 'bad']);
const WARN_STATES: ReadonlySet<Row['state']> = new Set(['delayed']);

function stampRow(key: string, label: string, kind: FreshKind, asOf: number | null | undefined, now: number, segment: WarSegment, note = '', openOnly = false): Row {
  const s = stampOf({ kind, asOf: asOf ?? null, now, segment, openOnly });
  return { key, label, time: s.text, state: s.state, note };
}

export function useTopHealth(): HealthView {
  const { index, quotes, pulse, board, layers, now, segment, clock } = useWarData();
  const news = useNewsBoard();
  return useMemo(() => {
    const top = pulse?.top?.ok ? pulse.top.data : null;
    const rows: Row[] = [];

    let reveal: number | null = null;
    for (const q of Object.values(quotes)) if (q.revealAt != null && (reveal == null || q.revealAt > reveal)) reveal = q.revealAt;
    const lag = top?.hotLag;
    const lagNote = lag?.p50 != null && lag.at != null ? `快線揭示落後中位 ${lag.p50} 秒（${hhmm(lag.at)} 統計）` : '';
    rows.push(stampRow('quote', '報價揭示', 'quote', reveal, now, segment, lagNote, true));

    const idxAt = indexAsOf(index);   // 來源自報的 tradeDate＋tradeTime（不是 daemon 寫入時刻）
    const idxNote = layers.index.failCount ? `連線失敗 ${layers.index.failCount} 次·保留上一份` : '';
    rows.push(stampRow('index', '加權／櫃買', 'index', idxAt, now, segment, idxNote));

    const pulseNote = layers.pulse.failCount ? `連線失敗 ${layers.pulse.failCount} 次·保留上一份` : '';
    rows.push(stampRow('pulse', '家數／漲跌停', 'list', pulse?.top?.asOf ?? null, now, segment, pulseNote, true));
    rows.push(stampRow('focus', '時段焦點', 'list', pulse?.focus?.asOf ?? null, now, segment));
    const boardNote = layers.board.failCount ? `連線失敗 ${layers.board.failCount} 次·保留上一份` : '';
    rows.push(stampRow('b1', '機會榜', 'list', board?.b1?.asOf ?? null, now, segment, boardNote, true));
    rows.push(stampRow('feeds', '異動／族群／漲停流', 'list', board?.feeds?.asOf ?? null, now, segment, '', true));
    // 新聞判別：只看「判別表是不是今日適用」（盤中趟無新消息不寫入，updatedAt 舊不算故障；daemon 活著看心跳列）
    if (news.status === 'loading') {
      rows.push({ key: 'news', label: '新聞判別', time: '—', state: 'none', note: '讀取中' });
    } else {
      const nh = newsHealthOf(news.board?.meta ?? null, news.ctx);
      rows.push({ key: 'news', label: '新聞判別', time: nh.text, state: nh.state, note: `${nh.note}${news.stale ? '·這次讀取失敗，顯示上一份' : ''}` });
    }

    // daemon 心跳：以「這份 pulse 組裝時」的年齡判斷（13:45 後頁面不再輪詢，不可拿現在時間去比而誤報離線）
    const hb = top?.heartbeat?.lastHeartbeat ?? null;
    const at = pulse?.at ?? null;
    if (hb != null && at != null) {
      const age = Math.max(0, at - hb);
      const ok = age <= HEARTBEAT_STALE_MS && top?.heartbeat?.active !== false;
      rows.push({ key: 'daemon', label: 'daemon 心跳', time: hhmmss(hb), state: ok ? 'ok' : 'bad', note: ok ? '' : `心跳逾時 ${Math.round(age / 60_000)} 分（${hhmm(at)} 檢查）` });
    } else if (!pulse && !layers.pulse.failCount) {
      rows.push({ key: 'daemon', label: 'daemon 心跳', time: '—', state: 'none', note: '讀取中' });
    } else {
      rows.push({ key: 'daemon', label: 'daemon 心跳', time: '—', state: 'bad', note: '讀不到心跳' });
    }

    const tx = top?.taifex;
    if (tx?.date) {
      const ms = Date.UTC(+tx.date.slice(0, 4), +tx.date.slice(4, 6) - 1, +tx.date.slice(6, 8), 4);
      const isToday = tx.date === clock.ymd.replace(/-/g, '');
      const value = tx.foreignTxfNetOI != null ? `${fmtNet(tx.foreignTxfNetOI)} 口` : '—';
      const pc = tx.putCallRatio != null ? `·P/C ${tx.putCallRatio}%` : '';
      rows.push({ key: 'taifex', label: '外資台指淨未平倉', time: isToday ? `■ 今日盤後 ${mmdd(ms)}` : `◆ 前交易日 ${mmdd(ms)}`, state: 'none', note: `${value}${pc}` });
    } else {
      rows.push({ key: 'taifex', label: '外資台指淨未平倉', time: '—', state: 'none', note: '尚無資料' });
    }
    rows.push({ key: 'txf', label: '台指期盤中', time: '—', state: 'none', note: '無盤中資料來源' });

    // 總燈：daemon 心跳逾時、輪詢時段的指數／家數過期、連線連續失敗 ⇒ 異常；延遲或部分來源讀不到 ⇒ 延遲
    const polling = POLLING.has(segment);
    // 掛載後第一次抓取還沒回來（沒有資料也沒失敗過）不算異常
    const loading = (k: string) => (k === 'index' ? !index && !layers.index.failCount : k === 'pulse' ? !pulse && !layers.pulse.failCount : false);
    const watched = rows.filter(r => !loading(r.key) && (r.key === 'daemon' || (polling && (r.key === 'index' || r.key === 'pulse'))));
    const failed = top?.failed ?? [];
    const layerFail = Math.max(layers.index.failCount, layers.pulse.failCount, layers.board.failCount);
    let status: HealthStatus = 'ok';
    if (watched.some(r => BAD_STATES.has(r.state)) || layerFail >= 3 || (!pulse && layers.pulse.failCount > 0)) status = 'bad';
    else if (watched.some(r => WARN_STATES.has(r.state)) || failed.length > 0 || layerFail > 0
      || (polling && rows.some(r => (r.key === 'b1' || r.key === 'feeds') && (r.state === 'stale' || r.state === 'delayed')))) status = 'warn';
    const label = status === 'ok' ? '正常' : status === 'warn' ? '延遲' : '異常';
    return { status, label, rows, failed };
  }, [index, quotes, pulse, board, layers, now, segment, clock.ymd, news]);
}

const GLYPH_CLASS: Partial<Record<Row['state'], string>> = {
  live: css.hGlyphLive, ok: css.hGlyphLive, delayed: css.hGlyphWarn, stale: css.hGlyphWarn, bad: css.hGlyphWarn,
};

function TimeCell({ row }: { row: Row }) {
  if (row.state === 'ok') return <><i className={css.hGlyphLive} style={{ fontStyle: 'normal' }}>●</i> {row.time}</>;
  if (row.state === 'bad') return <><i className={css.hGlyphWarn} style={{ fontStyle: 'normal' }}>▲</i> {row.time}</>;
  const glyph = row.time.charAt(0);
  const cls = GLYPH_CLASS[row.state];
  if (cls && '●◐▲'.includes(glyph)) return <><i className={cls} style={{ fontStyle: 'normal' }}>{glyph}</i>{row.time.slice(1)}</>;
  return <>{row.time}</>;
}

/** 健康明細表（彈窗、手機面板、放大層共用） */
export default function TopHealthPanel() {
  const { pulse } = useWarData();
  const view = useTopHealth();
  const taifexOI = pulse?.top?.ok ? pulse.top.data.taifex?.foreignTxfNetOI ?? null : null;
  return (
    <div>
      <table className={css.hTable}>
        <tbody>
          {view.rows.map(r => (
            <tr key={r.key}>
              <td>{r.label}</td>
              <td><TimeCell row={r} /></td>
              <td className={r.key === 'taifex' && taifexOI != null ? toneClassOf(netToneOf(taifexOI)) : undefined}>{r.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {view.failed.length > 0 && <div className={css.hNote}>這次讀取失敗：{view.failed.join('、')}（保留上一份）</div>}
      <div className={css.hNote}>
        時間＝資料本身的揭示或產出時刻，不是抓取時間。觸停損依規範 stop-v1 由本頁暫算（單一裝置判定、未含除權息調整）；daemon 的停損推播是舊制算法，列在二級。其他個人警示讀 daemon 寫入的警示文件；自設價警示已分檔儲存，觸發時不會覆蓋 daemon 警示。
      </div>
    </div>
  );
}
