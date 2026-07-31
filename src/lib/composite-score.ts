// ── 綜合評分（2年實測校準·隔日語意）——籌碼推選與決策工作台共用 ──
// 2026-07-19 兩輪稽核修正：①舊 tier 勝率(59/55/52/50)為無證據高估→實測。
// ②watchHot「53」為漲停幻覺（81%樣本=漲停鎖死日買不到；可交易部分僅34-43%）→42。
// 可交易宇宙實測校準（單調）：<40→34-38% · 40-45→44% · 46-51→47% · ≥52→48-50%(n小)
// ⚠定位：分數=「排序＋避開濾網」——≥52 為相對最強分組但淨期望≈0；
// 淨正入場需配撿尾盤定版濾網（破20日高×強尾×3~7）×明早開盤賣出場（炒作型更強）。
// 加減分（僅保留兩窗方向一致者）：
//   🏔破高×強尾 +2（穩定正）  ⚡軋空觸發 +2（穩定正）  💪強尾單獨 −2（兩窗皆負·舊+2為誤）
//   🪤接棒 −2（-1.8~-2.3pp）  倒貨≥30% −1（-0.8pp）  🔥5日≥20%過熱 −2（批次1過篩·兩期兩窗regime全同向）
//   破高單獨/弱尾盤：兩窗方向不穩 → 權重 0，僅徽章提示不計分。

export interface SignalBadge { t: string; c: string; tip: string }
export interface CompositeInput {
  baseWin?: number | null;      // 勝率雷達實測勝率（優先）
  tier?: string | null;         // 無勝率時以級別推底
  price?: number | null; chg?: number | null;
  high?: number | null; low?: number | null;   // 今日高低（收位判定）
  hi20?: number | null;         // 前 20 日高
  sqzSetup?: boolean;           // 昨日融券增 ≥ 昨量 0.5%
  c5?: number | null;           // 5 日前收盤（過熱懲罰 ret5 用）
  mktChg?: number | null;       // 大盤當日漲跌%（跟風懲罰用·三關法第二關日線代理）
  charLabel?: string | null;    // 籌碼性格（炒作型/一般/長期核心）——長期核心停用動能加分（性格分割檢定）
  mgChg?: number | null;        // 昨日融資日增減（張）
  foreignToday?: number | null; // 今日(或 t-1)外資淨買（散戶接棒判定）
  distributedPct?: number | null;
}

// 2 年實測 tier 基底（舊值 59/55/52/50/45/35 為高估，已修正）
const TIER_BASE: Record<string, number> = { S: 49, A: 50, 'B+': 47, B: 46, watch: 42, danger: 44 };

export function computeComposite(i: CompositeInput): { score: number; badges: SignalBadge[]; pos: number | null } {
  let sc = i.baseWin ?? TIER_BASE[i.tier ?? ''] ?? 45;
  const badges: SignalBadge[] = [];
  const price = i.price ?? 0, chg = i.chg ?? 0;
  const hi = i.high ?? 0, lo = i.low ?? 0;
  const pos = hi > lo && price > 0 ? (price - lo) / (hi - lo) : null;
  const brk = i.hi20 != null && i.hi20 > 0 && price > i.hi20;
  const sqzT = !!i.sqzSetup && chg > 2;

  const isCore = i.charLabel === '長期核心';
  if (brk && pos != null && pos >= 0.7) {
    if (!isCore) { sc += 2; badges.push({ t: '🏔破高', c: '#f03e3e', tip: '突破20日高＋強尾盤：2年實測 45.4-48.2%·淨均+0.3~0.6%/筆（兩窗穩定正）' }); }
    else badges.push({ t: '🏔破高', c: '#94a3b8', tip: '長期核心股：破高×強尾實測無效（性格分割檢定兩窗❌）——不計分僅提示' });
  }
  else if (brk) { badges.push({ t: '🏔破高', c: '#f97316', tip: '突破20日高（未配強尾）：2年實測 44.0% 低於基準——單獨突破不加分，僅提示' }); }
  else if (i.hi20 != null && i.hi20 > 0 && price > 0) {
    const d = (i.hi20 / price - 1) * 100;
    if (d > 0 && d <= 3) badges.push({ t: `🏔距高${d.toFixed(1)}%`, c: '#7dd3fc', tip: `前20日高 ${i.hi20}——逼近突破位（突破需配強尾盤才有實證效果）` });
  }
  if (sqzT) { sc += 2; badges.push({ t: '⚡軋空', c: '#f59e0b', tip: '昨券大增＋今強漲：2年實測 46.0-47.7%·淨均+0.33~0.48%/筆 vs 基準（穩定正）' }); }
  else if (i.sqzSetup) badges.push({ t: '⚡setup', c: '#a78bfa', tip: '昨日融券大增——今日漲>2% 即觸發軋空啟動' });
  if (pos != null && pos >= 0.8 && Math.abs(chg) > 1 && !(brk && pos >= 0.7)) { sc -= 2; badges.push({ t: '💪強尾', c: '#94a3b8', tip: '強尾盤「單獨」出現（未配突破）：2年實測 41.3-43.8% 低於基準——舊版+2為誤，已修正為−2' }); }
  if (pos != null && pos <= 0.2 && Math.abs(chg) > 1) { badges.push({ t: '⚠弱尾', c: '#2f9e44', tip: '收位≤20%：兩窗方向不穩（近半年淨負、2年勝率反小正）——不計分僅提示，空頭段自行提高警覺' }); }
  if (i.mktChg != null && i.mktChg >= 1 && chg >= 3 && chg - i.mktChg < 1) { sc -= 2; badges.push({ t: '🐑跟風', c: '#a3a3a3', tip: '大盤大漲日只同步漲（RS<1）＝跟風型態：700日日配對實測 -0.36~-1.46pp·淨勝僅29%（三關法第二關·2026-07-19 驗證）' }); }
  const ret5 = (i.c5 ?? 0) > 0 && price > 0 ? (price / (i.c5 as number) - 1) * 100 : null;
  if (ret5 != null && ret5 >= 20) {
    if (!isCore) { sc -= 2; badges.push({ t: `🔥5日+${ret5.toFixed(0)}%`, c: '#fb7185', tip: '5日累計漲幅≥20%＝短線過熱：700日×兩窗×regime全同向 -0.24~-0.55pp（批次1過篩·重疊檢查後獨立成立）' }); }
    else badges.push({ t: `🔥5日+${ret5.toFixed(0)}%`, c: '#94a3b8', tip: '長期核心股：過熱訊號兩窗不穩——不計分僅提示' });
  }
  if ((i.mgChg ?? 0) > 0 && (i.foreignToday ?? 0) < 0) { sc -= 2; badges.push({ t: '🪤接棒', c: '#84cc16', tip: '融資增＋外資賣＝散戶接棒：2年實測 -1.8~-2.3pp（穩定負）' }); }
  if ((i.distributedPct ?? 0) >= 30) sc -= 1;
  return { score: Math.max(5, Math.min(95, Math.round(sc))), badges, pos };
}
