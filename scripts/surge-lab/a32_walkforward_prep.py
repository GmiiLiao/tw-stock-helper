"""a32_walkforward 步驟 1：從 dataset_lu1.npz 組出逐月前推（walk-forward）比較用的特徵矩陣。

特徵（共 124 欄）：
  · 109 個 f_*（非大盤類）→ 同日百分位（pandas groupby(s).rank(pct=True)；NaN 保留為 NaN，GBDT 另成缺值箱）
  · 8 個 f_mkt_*（同日不變的大盤欄）→ 原值
  · x_lu_s、x_oneword_s、x_close_at_high、x_lu_streak、log(x_price)、log(x_vol20)、m_otc
  · 不含尾盤五檔 x_bd_*（2026-07-20 起才有）
輸出：.surge-cache/a32_walkforward_X.npy（float32，1,537,630×124，memmap）與 a32_walkforward_meta.npz。
"""
import os
import time
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
SP = os.path.join(HERE, '.surge-cache')
DS = os.path.join(SP, 'dataset_lu1.npz')
X_OUT = os.path.join(SP, 'a32_walkforward_X.npy')
META_OUT = os.path.join(SP, 'a32_walkforward_meta.npz')
RAW_PREFIX = 'f_mkt_'
X_FLAGS = ('x_lu_s', 'x_oneword_s', 'x_close_at_high', 'x_lu_streak')
META = ('m_s', 'm_j', 'm_y', 'm_y2', 'm_lu_s', 'm_locked1', 'm_buy_lu', 'm_otc', 'm_oc1', 'm_cc1')


def main() -> None:
    t0 = time.time()
    z = np.load(DS)
    s = z['m_s']
    fnames = [k for k in z.files if k.startswith('f_')]
    names = ([f'pct_{k}' for k in fnames if not k.startswith(RAW_PREFIX)] + [k for k in fnames if k.startswith(RAW_PREFIX)]
             + list(X_FLAGS) + ['log_x_price', 'log_x_vol20', 'm_otc'])
    n = len(s)
    X = np.lib.format.open_memmap(X_OUT, mode='w+', dtype=np.float32, shape=(n, len(names)))
    col = 0
    for k in fnames:
        if k.startswith(RAW_PREFIX): continue
        v = z[k].astype(np.float64)
        v[~np.isfinite(v)] = np.nan
        X[:, col] = pd.Series(v).groupby(s).rank(pct=True, method='average').values.astype(np.float32); col += 1
    for k in fnames:
        if not k.startswith(RAW_PREFIX): continue
        X[:, col] = z[k]; col += 1
    for k in X_FLAGS:
        X[:, col] = z[k]; col += 1
    with np.errstate(divide='ignore', invalid='ignore'):
        X[:, col] = np.log(np.maximum(z['x_price'], 1e-6)); col += 1
        X[:, col] = np.log1p(np.maximum(z['x_vol20'], 0)); col += 1
    X[:, col] = z['m_otc']; col += 1
    assert col == len(names), (col, len(names))
    X.flush()
    # 大盤欄同日不變的檢查（若非同日不變，原值也仍是合理特徵，只做提示）
    for k in fnames:
        if k.startswith(RAW_PREFIX):
            sd = pd.Series(z[k][:300000]).groupby(s[:300000]).std().fillna(0).median()
            print(f'{k} 同日標準差中位數 {sd:.2e}')
    dates = z['dates'].astype(str)
    np.savez(META_OUT, names=np.array(names), dates=dates, codes=z['codes'].astype(str), **{k: z[k] for k in META})
    nan_share = np.isnan(np.asarray(X[::50])).mean(0)
    print(f'特徵 {len(names)}；NaN 比例最高 5 欄：' + '、'.join(f'{names[i]} {nan_share[i] * 100:.1f}%' for i in np.argsort(-nan_share)[:5]))
    print(f'完成 {time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
