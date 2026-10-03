"""方案 A 對照組：同一份「全部參數」交給 GBDT（不限 70% 共同條件、可學交互作用）——量上限用。

模型（皆不含尾盤五檔 x_bd_*，因 DESIGN 期間沒有）：
  G_ALL  ：全體列、標籤 m_y；DESIGN 訓練 → VALID 選樹數／深度 → DESIGN+VALID 重訓 → TEST 打分
  G_CONT ：只用 s 日已漲停列（續漲停）；同上
  G_BUY  ：全體列、標籤 m_buy_lu（隔日漲停且開盤買得到）
負例抽 15%（排序不受影響）。輸出 .surge-cache/a31_shared_scores.npz（每列分數；未打分＝NaN）。
"""
import numpy as np
import a31_shared_common as C
from models import HistGBDT

NEG_FRAC = 0.15
GRID = ((3, 600), (4, 600))
CHECK = (150, 300, 450, 600)


def sample(idx, y, rng):
    pos = idx[y[idx] == 1]; neg = idx[y[idx] == 0]
    return np.sort(np.concatenate([pos, rng.choice(neg, int(len(neg) * NEG_FRAC), replace=False)]))


def fit(X, y, depth, nt, seed=0):
    return HistGBDT(n_trees=nt, depth=depth, lr=0.05, min_child_h=3.0, l2=20.0, colsample=0.5, subsample=0.8, seed=seed).fit(X, y)


def topn_prec(score, s, y, n):
    sel = C.topn_per_day(score, s, n)
    return y[sel].mean()


def run(name, D, X, lab, rows):
    rng = np.random.default_rng(0)
    y = D[lab].astype(np.int8); sp = D['split']; s = D['s']
    dz = np.nonzero(rows & (sp == 0))[0]; dv = np.nonzero(rows & (sp == 1))[0]
    tr = sample(dz, y, rng)
    best = None
    for depth, nt in GRID:
        m = fit(X[tr], y[tr], depth, nt)
        for k in CHECK:
            sc = m.decision_function(X[dv], n_trees=k)
            p1, p3, p10 = (topn_prec(sc, s[dv], y[dv], n) for n in (1, 3, 10))
            crit = (p1 + p3 + p10) / 3
            print(f'{name} depth={depth} trees={k}: VALID top1 {p1 * 100:.1f}% top3 {p3 * 100:.1f}% top10 {p10 * 100:.1f}%', flush=True)
            if best is None or crit > best[0]: best = (crit, depth, k)
    _, depth, k = best
    print(f'{name} 選用 depth={depth} trees={k}')
    # VALID 分數（DESIGN 模型）＋ TEST 分數（DESIGN+VALID 重訓）
    m = fit(X[tr], y[tr], depth, k)
    out = np.full(len(y), np.nan, np.float32)
    out[dv] = m.decision_function(X[dv]); out[dz] = m.decision_function(X[dz])      # DESIGN 分數為樣本內，只供參考
    dzv = np.nonzero(rows & (sp <= 1))[0]; dt = np.nonzero(rows & (sp == 2))[0]
    tr2 = sample(dzv, y, rng)
    m2 = fit(X[tr2], y[tr2], depth, k)
    out[dt] = m2.decision_function(X[dt])
    imp = sorted(zip(m2.gain_imp, D['names_used']), reverse=True)[:15]
    print(f'{name} 重要度前 15：' + '、'.join(f'{n}' for _, n in imp))
    return out


def main():
    D = C.load()
    keep = [i for i, n in enumerate(D['names']) if n not in C.BD_FEATS]
    D['names_used'] = [D['names'][i] for i in keep]
    X = D['X'][:, keep]
    allr = np.ones(len(D['y']), bool); cont = D['lu_s'] == 1
    S = {}
    S['G_ALL'] = run('G_ALL', D, X, 'y', allr)
    S['G_CONT'] = run('G_CONT', D, X, 'y', cont)
    S['G_BUY'] = run('G_BUY', D, X, 'buy_lu', allr)
    np.savez(f'{C.B.SP}/a31_shared_scores.npz', **S)


if __name__ == '__main__':
    main()
