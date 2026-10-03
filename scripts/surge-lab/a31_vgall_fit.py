"""a31_vgall 步驟 2：訓練一個 HistGBDT 並對指定切分打分（獨立實作；只共用 models.HistGBDT）。

用法：python3 a31_vgall_fit.py <tag> <train: D|DV> <depth> <n_trees> <seed> <drop: none|margin|chip>
  train=D  ：只用 DESIGN 訓練 → 打 DESIGN（樣本內）與 VALID，並存 150/300/450/600 樹的 VALID 分數
  train=DV ：DESIGN+VALID 重訓 → 打 TEST
  drop=margin：拿掉 21:45 才齊的資券／借券／當沖欄（ml_*、ms_*、lend_*、dt_*）
  drop=chip  ：再拿掉三大法人欄（fgn_*、trust_*、inst_pct_v1）→ 只剩收盤即有的價量
負例抽 15%（與作者同比例、不同亂數）。輸出 .surge-cache/a31_vgall_score_<tag>.npz。
"""
import os
import sys
import time
import numpy as np
from models import HistGBDT

HERE = os.path.dirname(os.path.abspath(__file__))
SP = os.path.join(HERE, '.surge-cache')
NEG_FRAC = 0.15
MARGIN_PREFIX = ('f_ml_', 'f_ms_', 'f_lend_', 'f_dt_')
CHIP_PREFIX = ('f_fgn_', 'f_trust_', 'f_inst_pct')


def feature_mask(names: np.ndarray, drop: str) -> np.ndarray:
    keep = np.ones(len(names), bool)
    if drop in ('margin', 'chip'):
        keep &= ~np.array([n.startswith(MARGIN_PREFIX) for n in names])
    if drop == 'chip':
        keep &= ~np.array([n.startswith(CHIP_PREFIX) for n in names])
    if drop not in ('none', 'margin', 'chip'):
        raise ValueError(drop)
    return keep


def main() -> None:
    tag, train, depth, nt, seed, drop = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), sys.argv[6]
    M = np.load(os.path.join(SP, 'a31_vgall_meta.npz'))
    X = np.load(os.path.join(SP, 'a31_vgall_X.npy'), mmap_mode='r')
    names = M['names']; split = M['split']; y = M['m_y'].astype(np.int8)
    keep = np.nonzero(feature_mask(names, drop))[0]
    print(f'[{tag}] 特徵 {len(keep)}（drop={drop}）：拿掉 {[n for i, n in enumerate(names) if i not in set(keep)]}', flush=True)
    tr_rows = np.nonzero(split == 0)[0] if train == 'D' else np.nonzero((split == 0) | (split == 1))[0]
    rng = np.random.default_rng(1000 + seed)
    pos = tr_rows[y[tr_rows] == 1]; neg = tr_rows[y[tr_rows] == 0]
    smp = np.sort(np.concatenate([pos, rng.choice(neg, int(len(neg) * NEG_FRAC), replace=False)]))
    Xtr = np.asarray(X[smp][:, keep]); ytr = y[smp]
    print(f'[{tag}] 訓練列 {len(smp):,}（正例 {len(pos):,}）', flush=True)
    t0 = time.time()
    m = HistGBDT(n_trees=nt, depth=depth, lr=0.05, min_child_h=3.0, l2=20.0, colsample=0.5, subsample=0.8, seed=seed).fit(Xtr, ytr)
    print(f'[{tag}] 訓練 {time.time() - t0:.0f}s', flush=True)
    out = {}
    if train == 'D':
        for sp_i, nm in ((0, 'DESIGN'), (1, 'VALID')):
            rows = np.nonzero(split == sp_i)[0]
            Xs = np.asarray(X[rows][:, keep])
            if nm == 'VALID':
                for k in (150, 300, 450, 600):
                    if k <= nt: out[f'VALID_{k}'] = m.decision_function(Xs, n_trees=k).astype(np.float32)
            out[nm] = m.decision_function(Xs).astype(np.float32); out[f'{nm}_rows'] = rows
    else:
        rows = np.nonzero(split == 2)[0]
        out['TEST'] = m.decision_function(np.asarray(X[rows][:, keep])).astype(np.float32); out['TEST_rows'] = rows
    imp = sorted(zip(m.gain_imp, names[keep]), reverse=True)[:15]
    print(f'[{tag}] 重要度前 15：' + '、'.join(n for _, n in imp), flush=True)
    np.savez(os.path.join(SP, f'a31_vgall_score_{tag}.npz'), **out)
    print(f'[{tag}] 完成 {time.time() - t0:.0f}s', flush=True)


if __name__ == '__main__':
    main()
