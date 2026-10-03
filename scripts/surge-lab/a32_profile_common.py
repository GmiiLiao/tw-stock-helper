"""a32_profile 共用：2026 vs 2023-2025「隔日漲停前一日」輪廓比對（2026-10-03 使用者：「後續再獨立使用 2026 年至今的漲停前一天資料
來訓練，再做 2 者比對，找出差異點」）。

時代（era）切分，依 s 日（漲停前一日）：
  A ＝ 2023-01-11 ～ 2025-12-31（dataset_lu1 的全部 2025 以前列）
  B ＝ 2026-01-01 ～ 2026-10-01
分組：fresh（s 日未漲停＝新起漲）、cont（s 日已漲停＝延續）。
不確定度：以「連續 5 個交易日」為一塊的區塊 bootstrap（日內同漲同跌、行情有延續性，單日區塊會低估誤差）；
所有比例／AUC 都寫成「逐日分子／逐日分母」之和，bootstrap 只需重抽日權重。
尾盤五檔 x_bd_* 只有 2026-07-20 起 → 一律排除。只讀 dataset_lu1（經 a31_shared_common 的快取），不寫任何既有檔案。
"""
import json
import os
import numpy as np
import a31_shared_common as SC

HERE = os.path.dirname(os.path.abspath(__file__))
SP = os.path.join(HERE, '.surge-cache')
OUT = os.path.join(HERE, 'out')
ERA_B_START = '2026-01-01'
BLOCK = 5            # 區塊 bootstrap 的區塊長度（交易日）
N_BOOT = 1000
BOOK = ('x_bd_has', 'x_bd_bidlim', 'x_bd_bid', 'x_bd_ask', 'x_bd_imb', 'x_bd_q_v')


def load():
    """回傳 D：X（列×123 特徵，已排除 x_bd_*）、names、meta、dates、sd（每列 s 日字串）、era（0=A,1=B）、day 層級陣列。"""
    D = SC.load()
    names_all = list(D['names'])
    keep = [i for i, n in enumerate(names_all) if n not in BOOK]
    D['X'] = D['X'][:, keep]
    D['names'] = [str(names_all[i]) for i in keep]
    dates = np.array([str(x) for x in D['dates']])
    D['dates'] = dates
    D['sd'] = dates[D['s']]
    D['era'] = (D['sd'] >= ERA_B_START).astype(np.int8)
    D['fresh'] = D['lu_s'] == 0
    # 日層級：資料集內實際出現的 s 日
    D['days'] = np.unique(D['s'])
    return D


def is_day_constant(name):
    return name.startswith('f_mkt_')


def day_index(D):
    """把 s（dates 的索引）壓成 0..n_days-1 的連續索引，回傳 (row_day, day_dates)。"""
    days = D['days']
    pos = np.full(len(D['dates']), -1, np.int64); pos[days] = np.arange(len(days))
    return pos[D['s']], D['dates'][days]


def block_weights(day_dates, mask_days, n_boot=N_BOOT, block=BLOCK, seed=0):
    """在 mask_days 指定的日子內做連續區塊 bootstrap；回傳 (n_boot × n_days) 權重（未選日權重 0）。"""
    rng = np.random.default_rng(seed)
    idx = np.nonzero(mask_days)[0]
    blk = np.arange(len(idx)) // block
    nb = blk.max() + 1
    W = np.zeros((n_boot, len(day_dates)), np.float32)
    for b in range(n_boot):
        cnt = np.bincount(rng.integers(0, nb, nb), minlength=nb)
        W[b, idx] = cnt[blk]
    return W


def ratio_ci(num_d, den_d, W, base_mask):
    """點估計＝Σnum/Σden（base_mask 日），95% 區間＝區塊 bootstrap 百分位。"""
    pt = num_d[base_mask].sum() / max(den_d[base_mask].sum(), 1e-12)
    with np.errstate(divide='ignore', invalid='ignore'):
        bs = (W @ num_d) / (W @ den_d)
    lo, hi = np.nanpercentile(bs, [2.5, 97.5])
    return float(pt), float(lo), float(hi), bs


def wilson(k, n, z=1.96):
    if n == 0: return (float('nan'), float('nan'))
    p = k / n; den = 1 + z * z / n
    c = (p + z * z / (2 * n)) / den; h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return (float(c - h), float(c + h))


def industry_of_codes(codes):
    """codes → 產業名（peerComps_industries.json 快照；查不到＝'未分類'）。注意：產業歸屬是目前快照，非逐日。"""
    ind = json.load(open(os.path.join(SP, 'peerComps_industries.json')))
    m = {r['code']: k for k, rows in ind.items() for r in rows}
    return np.array([m.get(str(c), '未分類') for c in codes])


def pct(x, nd=1):
    return 'nan' if x is None or not np.isfinite(x) else f'{x * 100:.{nd}f}%'
