// ─────────────────────────────────────────────────────────────────────────
// 操作模式（2026-08-03 模式化）——口徑隔離從「註解＋人的記性」升級為型別約束
//
// 為什麼需要這一層：
//   本站的每一個實證數字都綁在一個**口徑**上（持有期／進場時點／出場規則／
//   成本）。同一個變數換個口徑可以完全相反：
//     · vol20：隔日沖是「<1.5% 扣 2 分」的避開項；波段是「≥1.5% 才進場」的 gate
//     · RSI 高檔：對買方是「別追」（5日淨較差）；對持有者卻「不是賣訊」（續抱較好）
//     · 波段起漲訊號：5 日 +1.10%，但拿去隔日沖是 -0.06%
//   在此之前這條規則只存在於註解裡，靠寫程式的人記得。這個檔案讓它變成
//   編譯期就會擋下的事——跨模式取數字必須顯式轉換，不能默默混用。
//
// 多模態鐵律（model-core caveat）：每個模式的權重必須各自回測，**絕不互借**。
// ─────────────────────────────────────────────────────────────────────────

export type ModeKey = 'nextday' | 'swing' | 'daytrade';

export interface ModeCaliber {
  key: ModeKey;
  label: string;
  icon: string;
  /** 持有期人話版 */
  horizon: string;
  /** 進場時點 */
  entry: string;
  /** 出場規則——這是隔日沖最大的單一效應，每個模式都要明寫 */
  exit: string;
  /** 來回成本%（手續費×2＋證交稅） */
  costPct: number;
  /** 是否有經本站關卡驗證的評分模型。false ⇒ **不可顯示分數** */
  hasScoreModel: boolean;
  /** 該模式的可交易宇宙基準（供 UI 誠實揭露「隨便買會怎樣」） */
  baseline: string;
  /** 資料狀態；null＝資料齊備 */
  dataGate: { have: number; need: number; note: string } | null;
}

export const MODES: Record<ModeKey, ModeCaliber> = {
  nextday: {
    key: 'nextday', label: '隔日沖', icon: '🎯',
    horizon: '1 個交易日',
    entry: '今日收盤買（可交易宇宙：當日漲幅 ≤8.5%）',
    exit: '**明日開盤賣**——唯一兩窗淨正(+0.061/+0.118%)；抱到收盤 -0.33% 會把開盤溢價吐光',
    costPct: 0.4425,
    hasScoreModel: true,
    baseline: '明開賣 -0.13%·淨勝約 41%（隨便買一檔平均是賠的）',
    dataGate: null,
  },
  swing: {
    key: 'swing', label: '波段', icon: '🌊',
    horizon: '5 個交易日',
    entry: '今日收盤買（⭐三重確認 ∧ vol20≥1.5% ∧ 空頭日）',
    exit: '第 5 個交易日收盤賣；破前低無條件停損',
    costPct: 0.4425,
    hasScoreModel: false,   // 刻意不建 0~100 評分卡，用「榜單 ∧ gate ∧ 提醒」三層
    baseline: '5日淨均 -0.30%(主窗)／+0.36%(OOT)·淨勝 42.6%／48.2%',
    dataGate: null,
  },
  daytrade: {
    key: 'daytrade', label: '當沖', icon: '⏳',
    horizon: '當日內',
    entry: '盤中（當沖工作台：ORB／突破回踩／開低反轉·事前寫定觸發價與結構停損）',
    exit: '當日平倉',
    costPct: 0.2925,        // 當沖證交稅減半 0.15%
    hasScoreModel: false,   // ⚠無經驗證的評分模型。當沖工作台的 M/S/E 是「規則符合度」清單分（tw-day-trading 技巧），明示非機率、有缺項不給分級——不等於評分模型
    baseline: '尚無經驗證的基準——原料不足，不做宣稱',
    dataGate: {
      have: 0, need: 480,
      note: '三關法第一關(前30分量)需 snap0930Archive、第三關(拉回品質)需 intradayArchive。Yahoo 5分K 只保留 60 交易日故須逐日歸檔，且**其成交量少計且逐日亂跳**（實測單檔最差 0.325 倍），第一關必須用自家 snap0930Archive。資料到位前本模式只提供觀察工具，不給評分。',
    },
  },
};

export const DEFAULT_MODE: ModeKey = 'nextday';
export const MODE_KEYS = Object.keys(MODES) as ModeKey[];
export const isModeKey = (v: unknown): v is ModeKey => typeof v === 'string' && v in MODES;

/**
 * 跨模式取用的顯式轉換閘門。
 * 任何要把 A 模式的數字用在 B 模式的地方，都必須經過這裡並寫下理由——
 * 回傳的是「警告字串」而不是數字，因為**沒有任何數字可以直接搬過去**。
 * 這個函式存在的目的就是讓「想偷懶直接用」變得不可能。
 */
export function crossModeNotice(from: ModeKey, to: ModeKey, what: string): string {
  const A = MODES[from], B = MODES[to];
  return `⚠「${what}」是 ${A.icon}${A.label}口徑（${A.horizon}·${A.exit.split('——')[0]}）的實證，`
    + `目前在 ${B.icon}${B.label}（${B.horizon}）。兩者持有期與出場規則不同，數字不可互推。`;
}

/** 該模式可否顯示分數。UI 一律先問這個，false 就不要渲染任何分數 */
export const canShowScore = (m: ModeKey): boolean => MODES[m].hasScoreModel;

/** 資料閘門進度（供當沖入口顯示累積進度） */
export function dataProgress(m: ModeKey): { pct: number; text: string } | null {
  const g = MODES[m].dataGate;
  if (!g) return null;
  const pct = Math.min(100, Math.round((g.have / g.need) * 100));
  return { pct, text: `${g.have} / ${g.need} 日（${pct}%）` };
}
