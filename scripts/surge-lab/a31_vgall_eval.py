"""a31_vgall 步驟 4：評估自己重訓的 G_ALL 分數（VALID 選型確認、TEST 精確度／可買精確度／種子穩健度／決策時點消融）。"""
import os
import numpy as np
from a31_vgall_checks import top_n_mask, wilson_lb, describe

HERE = os.path.dirname(os.path.abspath(__file__))
SP = os.path.join(HERE, '.surge-cache')


def full(sc_rows: np.ndarray, rows: np.ndarray, n: int) -> np.ndarray:
    out = np.full(n, np.nan)
    out[rows] = sc_rows
    return out


def exec_stats(sel: np.ndarray, M: dict) -> str:
    """開盤可執行面：開盤沒鎖住的選股中隔日收漲停的比例、開盤→收盤平均報酬。"""
    nl = sel & (M['m_locked1'] == 0)
    n = int(nl.sum())
    if n == 0:
        return 'no unlocked picks'
    k = int(M['m_y'][nl].sum())
    oc = M['m_oc1'][nl]
    return f'開盤未鎖 {n} 筆：其中收漲停 {k}（{k / n * 100:.1f}%）、開→收平均 {np.nanmean(oc) * 100:+.2f}%、中位 {np.nanmedian(oc) * 100:+.2f}%'


def main() -> None:
    Mz = np.load(os.path.join(SP, 'a31_vgall_meta.npz'))
    M = {k: Mz[k] for k in Mz.files}
    names = list(M['names'])
    X = np.load(os.path.join(SP, 'a31_vgall_X.npy'), mmap_mode='r')
    extra = dict(lu_s=np.asarray(X[:, names.index('x_lu_s')]), ow=np.asarray(X[:, names.index('x_oneword_s')]))
    s, y, split = M['m_s'], M['m_y'], M['split']
    N = len(y)

    # VALID 選型確認
    best = None
    for tag in ('D4', 'D3'):
        f = os.path.join(SP, f'a31_vgall_score_{tag}.npz')
        if not os.path.exists(f):
            print(f'{tag} 缺'); continue
        Z = np.load(f)
        for k in (150, 300, 450, 600):
            sc = full(Z[f'VALID_{k}'], Z['VALID_rows'], N)
            ps = [y[top_n_mask(sc, s, n) & (split == 1)].mean() for n in (1, 3, 10)]
            crit = float(np.mean(ps))
            print(f'[VALID] {tag} trees={k}: top1 {ps[0] * 100:.1f}% top3 {ps[1] * 100:.1f}% top10 {ps[2] * 100:.1f}%  crit {crit * 100:.2f}')
            if best is None or crit > best[0]:
                best = (crit, tag, k)
        sc = full(Z['DESIGN'], Z['DESIGN_rows'], N)
        print(f'[DESIGN 樣本內] {tag} 600 top1 ' + describe(top_n_mask(sc, s, 1) & (split == 0), M, extra))
        sc = full(Z['VALID'], Z['VALID_rows'], N)
        print(f'[VALID] {tag} 600 top1 ' + describe(top_n_mask(sc, s, 1) & (split == 1), M, extra))
    print(f'[VALID 選型] 最佳 {best}')

    author_top1 = np.load(os.path.join(SP, 'a31_vgall_author_top1.npy')) & (split == 2)
    test_days = len(np.unique(s[split == 2]))
    for tag in ('DV4s0', 'DV4s1', 'DV4s2', 'DV4m', 'DV4c'):
        f = os.path.join(SP, f'a31_vgall_score_{tag}.npz')
        if not os.path.exists(f):
            print(f'{tag} 缺'); continue
        Z = np.load(f)
        sc = full(Z['TEST'], Z['TEST_rows'], N)
        for n in (1, 3, 10):
            sel = top_n_mask(sc, s, n) & (split == 2)
            print(f'[TEST] {tag} top{n}/day ' + describe(sel, M, extra))
            if n == 1:
                print(f'        {exec_stats(sel, M)}；與作者 top1 重疊 {int((sel & author_top1).sum())}/180')
        rows = Z['TEST_rows']; o = rows[np.argsort(-Z['TEST'], kind='stable')]
        fr = []
        for K in (30, 100, 300, 1000):
            idx = o[:K]; k = int(y[idx].sum())
            fr.append(f'top{K}: {k / K * 100:.1f}% (LB {wilson_lb(k, K) * 100:.1f}%, buy {M["m_buy_lu"][idx].mean() * 100:.1f}%, {len(np.unique(s[idx]))}日)')
        print(f'[TEST 全期前緣] {tag} ' + '；'.join(fr))

    # 簡單基準：每日隨機選 1 檔 s 日一字鎖（沒有就隨機選 1 檔 s 日漲停）的期望精確度（TEST）
    ow = extra['ow'] == 1; lu = extra['lu_s'] == 1
    exp_hit, exp_buy, nd = 0.0, 0.0, 0
    for d in np.unique(s[split == 2]):
        m = (s == d)
        pool = m & ow if (m & ow).any() else m & lu
        if not pool.any():
            continue
        exp_hit += y[pool].mean(); exp_buy += M['m_buy_lu'][pool].mean(); nd += 1
    print(f'[基準] TEST 每日隨機 1 檔一字鎖（無則漲停）期望精確度 {exp_hit / nd * 100:.1f}%、可買 {exp_buy / nd * 100:.1f}%（{nd} 日，共 {test_days} 日）')


if __name__ == '__main__':
    main()
