'use client';

import { useBrokerSettings } from '@/lib/useBrokerSettings';
import { STD_FEE_RATE, STD_TAX_RATE, DAYTRADE_TAX_RATE } from '@/lib/tw-fee';

// ── 成本參考（依持有方式；不作比對）──────────────────────────────────────
// 使用者 2026-09-30 規則：「計算結果不可扣成本的方式來比對——成本依持有方式比例不同」。
//   ⇒ 成績一律顯示未扣成本；成本在這裡依持有方式列出，由使用者依自己的操作方式換算。
//   手續費買賣各收一次、依使用者自己的券商折讓（users/{uid}/data/cashLedger.broker）；
//   證交稅賣出才收：現股當沖 0.15%、其餘 0.3%。持有越久，每日攤提越低。
export default function CostReference({ holdDays = [5, 10, 20] }: { holdDays?: number[] }) {
  const [broker] = useBrokerSettings();
  const feeRoundTrip = STD_FEE_RATE * 100 * broker.discount * 2;
  const dayTrade = feeRoundTrip + DAYTRADE_TAX_RATE * 100;
  const normal = feeRoundTrip + STD_TAX_RATE * 100;
  const disc = broker.discount >= 1 ? '全額' : `${+(broker.discount * 10).toFixed(2)} 折`;
  const perDay = holdDays.map(d => `${d} 日每日約 ${(normal / d).toFixed(3)}%`).join('、');
  return (
    <span>
      成本參考（依持有方式；手續費 {disc}；上列成績皆<b>未扣成本</b>）：當沖來回 {dayTrade.toFixed(2)}%・隔日沖 {normal.toFixed(2)}%・波段 {normal.toFixed(2)}%（{perDay}）。未含每筆最低手續費。
    </span>
  );
}
