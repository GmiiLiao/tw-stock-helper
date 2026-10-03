"""a31_vgall 步驟 3（不需模型）：標籤一致性、母體前視（s+1 停牌／斷點被剔除）、簡單基準、用自己的 top-N 重評作者存下的分數。"""
import os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SP = os.path.join(HERE, '.surge-cache')


def wilson_lb(k: int, n: int, z: float = 1.96) -> float:
    if n == 0:
        return float('nan')
    p = k / n
    den = 1 + z * z / n
    return (p + z * z / (2 * n) - z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / den


def top_n_mask(score: np.ndarray, s: np.ndarray, n: int, seed: int = 7) -> np.ndarray:
    """每個 s 日分數最高的 n 列（NaN 不選；同分隨機）。獨立實作：用 argsort 而非作者的 lexsort。"""
    rng = np.random.default_rng(seed)
    ok = np.nonzero(np.isfinite(score))[0]
    jitter = rng.random(len(ok)) * 1e-9
    order = ok[np.lexsort((-(score[ok].astype(np.float64) + jitter), s[ok]))]
    sel = np.zeros(len(score), bool)
    ss = s[order]
    first = np.r_[True, ss[1:] != ss[:-1]]
    grp_start = np.maximum.accumulate(np.where(first, np.arange(len(ss)), 0))
    rank = np.arange(len(ss)) - grp_start
    sel[order[rank < n]] = True
    return sel


def describe(sel: np.ndarray, M: dict, extra: dict) -> str:
    n = int(sel.sum())
    if n == 0:
        return 'n=0'
    k = int(M['m_y'][sel].sum()); kb = int(M['m_buy_lu'][sel].sum())
    days = len(np.unique(M['m_s'][sel]))
    lock = M['m_locked1'][sel].mean()
    return (f'prec {k / n * 100:5.1f}% ({k}/{n}) LB {wilson_lb(k, n) * 100:5.1f}% days {days} buy {kb / n * 100:5.1f}% '
            f'locked@open {lock * 100:5.1f}% lu_s {extra["lu_s"][sel].mean() * 100:5.1f}% oneword_s {extra["ow"][sel].mean() * 100:5.1f}%')


def main() -> None:
    Mz = np.load(os.path.join(SP, 'a31_vgall_meta.npz'))
    M = {k: Mz[k] for k in Mz.files}
    names = list(M['names'])
    X = np.load(os.path.join(SP, 'a31_vgall_X.npy'), mmap_mode='r')
    ow = np.asarray(X[:, names.index('x_oneword_s')]); lus = np.asarray(X[:, names.index('x_lu_s')])
    streak = np.asarray(X[:, names.index('x_lu_streak')])
    s, j, y, split = M['m_s'], M['m_j'], M['m_y'], M['split']
    dates = M['dates']; NJ = int(j.max()) + 1; T = len(dates)
    extra = dict(lu_s=lus, ow=ow)

    # 1. 標籤一致性：m_y(s,j) 應等於隔日列的 x_lu_s(s+1,j)；m_lu_s 應等於 x_lu_s
    key = s.astype(np.int64) * NJ + j
    pos = {int(k): i for i, k in enumerate(key)} if False else None
    order = np.argsort(key); ks = key[order]
    nxt_key = (s.astype(np.int64) + 1) * NJ + j
    idx = np.searchsorted(ks, nxt_key); idx = np.minimum(idx, len(ks) - 1)
    has_next = ks[idx] == nxt_key
    nxt_row = order[idx]
    agree = (y[has_next] == lus[nxt_row[has_next]]).mean()
    print(f'[標籤] 有隔日列 {int(has_next.sum()):,}／{len(y):,}；m_y 與隔日 x_lu_s 一致率 {agree * 100:.4f}%；m_lu_s==x_lu_s {np.mean(M["m_lu_s"] == lus) * 100:.4f}%')
    bad = has_next & (y != lus[np.where(has_next, nxt_row, 0)])
    print(f'[標籤] 不一致列 {int(bad.sum())}')

    # 2. 母體前視：s 日漲停（＝前一列 m_y=1）但 (s, j) 列不存在 ⇒ 因 s+1 無收盤或 s+1 結構斷點被剔除
    shock = (dates >= '2025-04-07') & (dates <= '2025-04-10')
    prv_lu = (y == 1)  # 列 (s-1, j) 的 m_y=1 ⇒ (s, j) 漲停
    s_lu = s[prv_lu] + 1; j_lu = j[prv_lu]
    want = s_lu.astype(np.int64) * NJ + j_lu
    ii = np.minimum(np.searchsorted(ks, want), len(ks) - 1)
    exists = ks[ii] == want
    valid_day = (s_lu < T - 1) & ~shock[np.minimum(s_lu, T - 1)]
    for nm, lo, hi in (('DESIGN', '0000', '2025-06-30'), ('VALID', '2025-07-01', '2025-12-31'), ('TEST', '2026-01-01', '2026-10-01')):
        dd = dates[np.minimum(s_lu, T - 1)]
        m = valid_day & (dd >= lo) & (dd <= hi)
        print(f'[母體前視] {nm}: s 日漲停 {int(m.sum()):,} 檔日，其中因 s+1 停牌/斷點不在資料集 {int((m & ~exists).sum())}（{(m & ~exists).sum() / max(m.sum(), 1) * 100:.2f}%）')
    # 若被剔除的那些在 TEST 都被選中且全部算失敗，對 top1 的最壞影響上界：
    dd = dates[np.minimum(s_lu, T - 1)]
    mt = valid_day & (dd >= '2026-01-01') & (dd <= '2026-10-01') & ~exists
    print(f'[母體前視] TEST 被剔除的 s 日漲停檔日分布在 {len(np.unique(s_lu[mt]))} 個 s 日')

    # 3. 簡單基準（TEST）
    for nm, sp_i in (('DESIGN', 0), ('VALID', 1), ('TEST', 2)):
        m = split == sp_i
        for lab, cond in (('s 日漲停', lus == 1), ('s 日一字鎖', ow == 1), ('s 日漲停但非一字', (lus == 1) & (ow == 0)),
                          ('一字鎖 & 連板=1', (ow == 1) & (streak == 1)), ('一字鎖 & 連板>=2', (ow == 1) & (streak >= 2))):
            c = m & cond
            n = int(c.sum()); k = int(y[c].sum())
            print(f'[基準] {nm:6s} {lab:14s}: P(隔日漲停) {k / max(n, 1) * 100:5.1f}% ({k}/{n})  可買 {M["m_buy_lu"][c].mean() * 100:5.1f}%  開盤鎖 {M["m_locked1"][c].mean() * 100:5.1f}%  每日 {n / len(np.unique(s[m])):.1f} 檔')

    # 4. 用自己的 top-N 重評作者存下的 G_ALL 分數
    G = np.load(os.path.join(SP, 'a31_shared_scores.npz'))
    g = G['G_ALL'].astype(np.float64)
    print(f'[作者分數] 長度 {len(g):,}（資料集 {len(y):,}）；有分數列 {int(np.isfinite(g).sum()):,}')
    for n in (1, 3, 10):
        sel = top_n_mask(g, s, n)
        for nm, sp_i in (('DESIGN', 0), ('VALID', 1), ('TEST', 2)):
            print(f'[作者分數 top{n}] {nm:6s} ' + describe(sel & (split == sp_i), M, extra))
    np.save(os.path.join(SP, 'a31_vgall_author_top1.npy'), top_n_mask(g, s, 1))


if __name__ == '__main__':
    main()
