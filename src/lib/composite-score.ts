// ── 綜合評分（2年實測校準·隔日語意）——籌碼推選與決策工作台共用 ──
// 2026-07-19 兩輪稽核修正：①舊 tier 勝率(59/55/52/50)為無證據高估→實測。
// ②watchHot「53」為漲停幻覺（81%樣本=漲停鎖死日買不到；可交易部分僅34-43%）→42。
// 重定錨後分數分佈約 44~65（基底 51-61 ＋ adds −7~+4）。
// ⚠定位：分數=「排序＋避開濾網」——只有 A 級基底(61)費稅後淨正(+0.17%/筆·淨勝51%)；
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
  k9?: number | null;           // KD(9) 的 K 值——僅 >90 極度超買計為避開訊號（見下方檢定紀錄）
  belowMA5?: boolean | null;    // 收盤跌破 5 日線（收盤口徑）——配 K 80~90 為避開訊號
}

// ── KD（隨機指標）2026-08-02 三輪檢定結論 ─────────────────────────────
// 使用者提出教科書用法「判斷超買超賣＋尋找波段轉折」。十二命題全測，結果：
//
// ❌ 買進端全不採：K<20/K<10 超賣、低檔黃金交叉、K上穿20、低檔鈍化。
//    主窗看似有效（K<10 開賣 +0.229%），**OOT 全垮**（-0.043%）；
//    且 K 與 RSI5 相關係數 0.838/0.830，RSI5<20 之中 80.4% 同時 K<20
//    ＝高度冗餘。增量檢定：RSI5<20 單獨主窗 +0.134%，配 K<20 升到 +0.197%，
//    但 OOT 兩者皆換號轉負 → 增量不成立。
// ❌ 黃金交叉（不限位階）主窗兩半窗方向就不一致，直接淘汰。
//    ——與 RSI 檢定同一個教訓：「確認型」訊號的代價是遲到。
//
// ✅ 唯一採用：**K>90 極度超買 → 避開（−2）**
//    絕對報酬（明開賣·扣費稅 0.4425%）：
//      主窗 -0.265%[兩半 -0.368/-0.185]·勝 34.5%（基準 -0.129%·勝 41.5%）
//      OOT  -0.244%[兩半 -0.218/-0.256]·勝 29.7%（基準 -0.125%·勝 38.5%）
//    regime：主窗 多-0.39/空-0.195、OOT 多-0.268/空-0.213 —— 兩窗×兩 regime 四格全負。
//    增量檢定（控制變數分層後仍較差）：16 格中 14 格通過，
//      控制今日漲幅 4 層、5日漲幅 2 層、RSI5 2 層、60日位階 2 層皆同向為負，
//      證明**不是「剛大漲過」的代理**（RSI 高檔當初就是栽在這一關）。
//    ⚠誠實揭露：兩格未過，皆為 OOT 小樣本——chg 5~8.5%(n=196)、
//      posture60<0.9(n=129)。故僅作 −2 扣分，不單獨成榜、不作為賣出訊號。
//    日均約 7.5~9.6 檔。
// ──────────────────────────────────────────────────────────────────

// 2026-08-01 重定錨：基底＝**明開賣毛勝率%**（audit-weights 乾淨窗實測）。
// 舊值(49/50/47/46)是收盤賣口徑——產品鐵律是明開賣，數字必須跟實際執行同口徑。
// 分數語意＝「明開盤賣出的上漲機率估計」；詳細統計見 tier-meta.ts（單一真相來源）。
const TIER_BASE: Record<string, number> = { S: 59, A: 61, 'B+': 60, B: 58, watch: 51, danger: 54 };

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
  // KD 唯一過關項：K>90 極度超買＝避開（買進端全在 OOT 垮掉，見檔頭檢定紀錄）
  if ((i.k9 ?? 0) > 90) {
    sc -= 2;
    badges.push({ t: `📉K${Math.round(i.k9 as number)}超買`, c: '#2f9e44', tip: 'KD 極度超買(K>90)：明開賣主窗 -0.265%·勝34.5%／OOT -0.244%·勝29.7%（基準約 -0.13%·勝40%），兩窗×兩regime四格全負，控制漲幅/RSI/位階後仍較差＝非「剛大漲過」的代理。⚠僅作扣分不作賣訊（OOT 兩個小樣本格未過）' });
  } else if ((i.k9 ?? 0) > 80) {
    // KDMA 策略二的實測修正版（2026-08-02·見檔尾檢定紀錄）：
    // 原文說「高檔鈍化只要沒跌破 5 日線就抱牢」——實測抱牢組確實優於跌破組，
    // 但**兩組絕對值都是負的**，所以真正可用的是「跌破」這一側，不是「抱牢」。
    if (i.belowMA5) {
      sc -= 2;
      badges.push({ t: `📉K${Math.round(i.k9 as number)}破5MA`, c: '#2f9e44', tip: 'KD 高檔(80~90)＋跌破5日線：明開賣主窗 -0.263%·勝37.7%／OOT -0.248%·勝33.4%（基準約-0.13%·勝40%），四格全負、分層控制20/22、與K>90重疊僅2%＝獨立訊號。⚠原文「沒跌破5MA就抱牢」的抱牢側實測仍為負(-0.152%)，只是虧較少，不可當買訊' });
    } else {
      badges.push({ t: `KD${Math.round(i.k9 as number)}`, c: '#94a3b8', tip: 'KD 高檔(80~90)但未跌破5日線：實測 -0.152%／-0.153%，雖優於跌破組(-0.266%/-0.260%)但仍為負——不計分，僅供位階參考（K>80 整段兩半窗方向不一致）' });
    }
  }
  if ((i.distributedPct ?? 0) >= 30) sc -= 1;
  return { score: Math.max(5, Math.min(95, Math.round(sc))), badges, pos };
}
