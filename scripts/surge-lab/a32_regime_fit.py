"""a32_regime 步驟 2：訓練各模型並打分（同一套 GBDT 設定，見 a32_regime_common.GBDT_PARAMS）。

用法：python3 a32_regime_fit.py <tag> [seed]
  FIX25    ：s ≤ 2025-12-31 全部訓練 → 打 2026（固定模型）
  D25H1    ：s ≤ 2025-06-30 訓練 → 打 2025H2 與 2026（與前次研究 DESIGN 同窗；2025H2 對照組）
  W9_25    ：2024-10-01～2025-06-30（約 185 日，與 2026 訓練窗等長）→ 打 2025H2（控制「訓練量」的對照組）
  D24      ：s ≤ 2024-12-31 訓練 → 打 2025 全年（2025 冷月份的樣本外對照組）
  M26      ：只用 2026-01-01～2026-10-01 訓練 → 打 2023–2025 全部（從未見過；模擬「下一段若像 2025」）
  ROLL26   ：2026 內逐月擴張窗、只用 2026 資料：月 M 的分數來自 2026-01-01～M 前一日訓練的模型（2 月起）
  ROLLALL  ：逐月擴張窗、全部歷史（2023～M 前一日）：月 M 的分數（2026-01 起；1 月＝FIX25 同窗）
無洩漏說明：列 s 的標籤在 s+1 收盤即知；預測 M 月第一天 s 時，訓練用到的最後一列是 s−1（標籤＝s 收盤），已知。
輸出：.surge-cache/a32_regime_score_<tag>[_s<seed>].npz（score：全長 float32、未打分＝NaN；imp：gain 重要度）
"""
import os
import sys
import time
import numpy as np
import a32_regime_common as C

MONTHS_26 = ['2026-%02d' % m for m in range(1, 11)]


def month_start(ym): return ym + '-01'


def next_month(ym):
    y, m = int(ym[:4]), int(ym[5:])
    return f'{y + (m == 12)}-{(m % 12) + 1:02d}'


def main():
    tag = sys.argv[1]; seed = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    t0 = time.time()
    D = C.load(); sd = D['sd']; N = len(sd)
    score = np.full(N, np.nan, np.float32); imps = {}; info = {}

    def one(name, train, target):
        m, ntr, npos = C.fit_gbdt(D, train, seed=seed)
        sc = C.score_rows(m, D, target)
        score[target] = sc[target]; imps[name] = m.gain_imp
        info[name] = (ntr, npos, int(target.sum()))
        print(f'[{tag}/{name}] 訓練列 {ntr:,}（正例 {npos:,}）→ 打分列 {int(target.sum()):,}  {time.time() - t0:.0f}s', flush=True)

    if tag == 'FIX25':
        one('all', sd <= '2025-12-31', sd >= '2026-01-01')
    elif tag == 'D25H1':
        one('all', sd <= '2025-06-30', sd >= '2025-07-01')
    elif tag == 'W9_25':
        one('all', (sd >= '2024-10-01') & (sd <= '2025-06-30'), (sd >= '2025-07-01') & (sd <= '2025-12-31'))
    elif tag == 'D24':
        one('all', sd <= '2024-12-31', (sd >= '2025-01-01') & (sd <= '2025-12-31'))
    elif tag == 'M26':
        one('all', sd >= '2026-01-01', sd <= '2025-12-31')
    elif tag in ('ROLL26', 'ROLLALL'):
        lo = '2026-01-01' if tag == 'ROLL26' else '0000'
        for ym in MONTHS_26:
            if tag == 'ROLL26' and ym == '2026-01': continue
            st = month_start(ym); en = month_start(next_month(ym))
            one(ym, (sd >= lo) & (sd < st), (sd >= st) & (sd < en))
    else:
        raise ValueError(tag)
    fn = f'a32_regime_score_{tag}' + (f'_s{seed}' if seed else '') + '.npz'
    np.savez_compressed(os.path.join(C.SP, fn), score=score, names=np.array(D['names']),
                        imp_keys=np.array(list(imps)), imp=np.array([imps[k] for k in imps]),
                        info=np.array([info[k] for k in imps]))
    print(f'[{tag}] 完成 {time.time() - t0:.0f}s → {fn}', flush=True)


if __name__ == '__main__':
    main()
