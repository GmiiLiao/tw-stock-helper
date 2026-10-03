// 測試用校準資料（形狀同 scripts/data/attention-calibration.json；該檔依專案規則不進版控，只存在主 checkout）。
// 數字取自 2026-10-03 研究端產出（docs/SURGE-ATTENTION-2026-10-03.md §5、§9.2），測試只驗行為，不依賴確切數字。
export const ATTENTION_CAL_FIXTURE = Object.freeze({
  generatedAt: '2026-10-03',
  s5Tiers: { edges: [0.15, 0.24], labels: ['<15%', '15~24%', '≥24%'],
    nextDay: { fresh: [0.0002, 0.0862, 0.4063], inAttention: [0.0102, 0.1501, 0.6358], all: [0.0013, 0.1164, 0.6018] } },
  escalation10: {
    high: { tse: { p: 0.5139, n: 1117 }, otc: { p: 0.549, n: 1603 } },
    mid: { tse: { p: 0.2711, n: 3349 }, otc: { p: 0.3696, n: 4021 } },
    low: { tse: { p: 0.075, n: 6517 }, otc: { p: 0.0437, n: 4807 } },
    none: { tse: { p: 0.0049, n: 559110 }, otc: { p: 0.0112, n: 275105 } },
  },
});
