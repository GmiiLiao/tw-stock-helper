'use client';

// D2 放大層「資料健康」：每個來源的資料本身時間（不是抓取時間）＋本頁三層抓取的成敗。
// 只用匯流排與各區段的 asOf（契約層級資料），不依賴任何區塊的內部欄位；daemon 心跳、外資台指淨未平倉等在指揮列。
import { useMemo } from 'react';
import { useWarData } from './WarRoomContext';
import { useFeedsSections } from './FeedData';
import { stampOf, hhmmss, type FreshKind, type StampState } from './parts/freshness';
import type { LayerMeta } from './useWarRoomBus';
import { indexAsOf } from './TopView';
import { useNewsBoard } from './NewsModel';
import { newsHealthOf } from '../../../scripts/lib/warroom-news.mjs';
import zs from './ZoomLayer.module.css';

interface HealthRow {
  label: string; kind: FreshKind; asOf: number | null | undefined; layer: LayerMeta | null; openOnly?: boolean; note?: string;
  /** 不套資料章門檻、直接顯示的狀態（新聞判別：只看適用日，盤中趟無新消息不寫入） */
  fixed?: { text: string; cls?: string };
}

const STATE_CLASS: Partial<Record<StampState, string>> = { live: zs.ok, delayed: zs.warn, stale: zs.bad };

function fetchText(m: LayerMeta | null): { text: string; cls?: string } {
  if (!m) return { text: '—' };
  if (m.failCount > 0) return { text: `連續失敗 ${m.failCount} 次${m.lastOkAt ? `·上次成功 ${hhmmss(m.lastOkAt)}` : ''}`, cls: zs.bad };
  return m.lastOkAt ? { text: `成功 ${hhmmss(m.lastOkAt)}`, cls: zs.ok } : { text: '尚未抓取' };
}

/** 新聞判別（持股燈）：判別表是今日適用 ●、否則 ▲（與指揮列健康燈同一支 newsHealthOf） */
function newsRow(news: ReturnType<typeof useNewsBoard>, layer: LayerMeta): HealthRow {
  const base = { label: '新聞判別（持股燈）', kind: 'news' as const, asOf: news.board?.meta.updatedAt ?? null, layer };
  if (news.status === 'loading') return { ...base, fixed: { text: '讀取中' } };
  const nh = newsHealthOf(news.board?.meta ?? null, news.ctx);
  return { ...base, note: nh.note, fixed: { text: `${nh.glyph} ${nh.text}`, cls: nh.state === 'ok' ? zs.ok : zs.bad } };
}

export default function ZoomHealth() {
  const { index, quotes, pulse, board, layers, now, segment, fastCodes } = useWarData();
  const { events, sectors, limitFlow } = useFeedsSections();
  const news = useNewsBoard();

  const rows = useMemo<HealthRow[]>(() => {
    let reveal: number | null = null;
    for (const q of Object.values(quotes)) if (q.revealAt != null && (reveal == null || q.revealAt > reveal)) reveal = q.revealAt;
    return [
      { label: '指數（加權／櫃買）', kind: 'index', asOf: indexAsOf(index), layer: layers.index },
      { label: '持股與釘選報價（最新揭示）', kind: 'quote', asOf: reveal, layer: layers.quotes, openOnly: true, note: fastCodes.length ? `追蹤 ${fastCodes.length} 檔` : '尚未登記代號' },
      { label: '大盤脈動／警示', kind: 'list', asOf: pulse?.top.asOf, layer: layers.pulse },
      { label: '時段焦點', kind: 'list', asOf: pulse?.focus.asOf, layer: layers.pulse },
      { label: '盤中機會榜', kind: 'list', asOf: board?.b1.asOf, layer: layers.board, openOnly: true },
      { label: '異動流（爆量／漲停／雷達）', kind: 'list', asOf: events?.ok ? events.data.marketAsOf : null, layer: layers.board },
      { label: '異動流（新聞判別／重訊）', kind: 'news', asOf: events?.asOf, layer: layers.board },
      { label: '族群資金', kind: 'sector', asOf: sectors?.asOf, layer: layers.board, openOnly: true },
      { label: '漲停順序流', kind: 'list', asOf: limitFlow?.asOf, layer: layers.board, openOnly: true },
      newsRow(news, layers.board),
    ];
  }, [index, quotes, pulse, board, layers, events, sectors, limitFlow, fastCodes, news]);

  return (
    <div className={zs.healthWrap}>
      <table className={zs.health}>
        <thead>
          <tr><th>來源</th><th>資料時間</th><th>本頁抓取</th><th>備註</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const st = r.fixed ? null : stampOf({ kind: r.kind, asOf: r.asOf ?? null, now, segment, openOnly: r.openOnly });
            const f = fetchText(r.layer);
            return (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td className={r.fixed ? r.fixed.cls : st ? STATE_CLASS[st.state] : undefined}>{r.fixed ? r.fixed.text : st?.text}</td>
                <td className={f.cls}>{f.text}</td>
                <td>{r.note ?? ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className={zs.foot}>
        資料時間取自資料本身（揭示或產出時刻），不是抓取時間。快層（指數、報價）依揭示節奏、中層 30 秒、慢層 60 秒；13:45 後與背景分頁停止輪詢。
        daemon 心跳與外資台指淨未平倉（◆ 前交易日）見指揮列。
      </p>
    </div>
  );
}
