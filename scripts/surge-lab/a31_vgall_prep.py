"""a31_vgall（對抗式驗證 G_ALL_top1）步驟 1：獨立從 dataset_lu1.npz 讀出特徵矩陣與標籤，不經 a31_shared_common。

特徵＝全部 f_*（排序後）＋ 6 個 x_*（不含尾盤五檔 x_bd_*）；欄位順序刻意與作者不同（作者用 npz 檔內順序），
以檢驗結果對 colsample 隨機性的穩健度。輸出 .surge-cache/a31_vgall_X.npy（float32）與 a31_vgall_meta.npz。
"""
import os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SP = os.path.join(HERE, '.surge-cache')
DS = os.path.join(SP, 'dataset_lu1.npz')
X_OUT = os.path.join(SP, 'a31_vgall_X.npy')
META_OUT = os.path.join(SP, 'a31_vgall_meta.npz')
X_EXTRA = ('x_lu_s', 'x_oneword_s', 'x_close_at_high', 'x_lu_streak', 'x_price', 'x_vol20')
META = ('m_s', 'm_j', 'm_y', 'm_y2', 'm_lu_s', 'm_locked1', 'm_buy_lu', 'm_otc', 'm_liquid', 'm_oc1', 'm_cc1')
SPLITS = (('DESIGN', '0000-00-00', '2025-06-30'), ('VALID', '2025-07-01', '2025-12-31'), ('TEST', '2026-01-01', '2026-10-01'))


def main() -> None:
    d = np.load(DS)
    fnames = sorted(k for k in d.files if k.startswith('f_'))
    names = fnames + list(X_EXTRA)
    bd = [k for k in d.files if k.startswith('x_bd_')]
    other_x = [k for k in d.files if k.startswith('x_') and k not in X_EXTRA and k not in bd]
    print(f'f_* {len(fnames)}、x_extra {len(X_EXTRA)}、x_bd {len(bd)}、其他 x_ {other_x}、合計特徵 {len(names)}')
    n = len(d['m_s'])
    X = np.lib.format.open_memmap(X_OUT, mode='w+', dtype=np.float32, shape=(n, len(names)))
    for i, k in enumerate(names):
        X[:, i] = d[k]
    X.flush()
    meta = {k: d[k] for k in META}
    dates = d['dates'].astype(str)
    sd = dates[meta['m_s']]
    split = np.full(n, -1, np.int8)
    for i, (_, lo, hi) in enumerate(SPLITS):
        split[(sd >= lo) & (sd <= hi)] = i
    for i, (nm, _, _) in enumerate(SPLITS):
        m = split == i
        print(f'{nm}: 列 {int(m.sum()):,}、日 {len(np.unique(meta["m_s"][m]))}、{sorted(set(sd[m]))[0]}～{sorted(set(sd[m]))[-1]}、基準率 {meta["m_y"][m].mean() * 100:.2f}%')
    print('未分配列', int((split < 0).sum()))
    np.savez(META_OUT, names=np.array(names), dates=dates, codes=d['codes'].astype(str), split=split, **meta)


if __name__ == '__main__':
    main()
