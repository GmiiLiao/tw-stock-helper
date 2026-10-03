"""方案 A 字面版之二：「跟歷史上漲停前一日有多像」——最近鄰相似度。

參數：ALL 區隔 lift 前 NF 個共同條件的參數，以 DESIGN 經驗分布轉成 0～1 分位（缺值＝0.5），再加 x_lu_s、x_oneword_s。
參考庫：DESIGN 全部正例＋10% 負例（負例權重 10）。
分數：K 個最近鄰（歐氏距離）的加權正例比例＝「跟漲停前一日相似的程度」。
VALID／TEST 全部列打分 → 每日前 1／3／10 名、TEST 全期前 30／100／300 名。
"""
import json
import numpy as np, pandas as pd
import a31_shared_common as C

NF = 20
K = 50
NEG_FRAC = 0.10
CHUNK = 1500


def main():
    D = C.load(); nm = {n: i for i, n in enumerate(D['names'])}
    conds = json.load(open(f'{C.B.SP}/a31_shared_conds.json'))['ALL']
    conds = sorted([c for c in conds if c.get('lift') and np.isfinite(c['lift'])], key=lambda c: -c['lift'])[:NF]
    feats = [c['feature'] for c in conds]
    sp = D['split']; dz = sp == 0
    Z = np.empty((len(D['y']), NF + 2), np.float32)
    for k, f in enumerate(feats):
        x = D['X'][:, nm[f]]; ref = np.sort(x[dz & np.isfinite(x)])
        u = np.searchsorted(ref, x, 'right') / len(ref)
        u[~np.isfinite(x)] = 0.5
        Z[:, k] = u
    Z[:, NF] = D['X'][:, nm['x_lu_s']]; Z[:, NF + 1] = D['X'][:, nm['x_oneword_s']]
    rng = np.random.default_rng(0)
    pos = np.nonzero(dz & (D['y'] == 1))[0]; neg = np.nonzero(dz & (D['y'] == 0))[0]
    neg = rng.choice(neg, int(len(neg) * NEG_FRAC), replace=False)
    ref = np.concatenate([pos, neg]); R = Z[ref]; wR = np.where(D['y'][ref] == 1, 1.0, 1 / NEG_FRAC); yR = D['y'][ref].astype(np.float64)
    r2 = (R ** 2).sum(1)
    q = np.nonzero(sp >= 1)[0]
    score = np.full(len(D['y']), np.nan)
    for a in range(0, len(q), CHUNK):
        idx = q[a:a + CHUNK]; Q = Z[idx]
        d2 = (Q ** 2).sum(1)[:, None] + r2[None, :] - 2 * Q @ R.T
        nn = np.argpartition(d2, K, axis=1)[:, :K]
        w = wR[nn]; score[idx] = (w * yR[nn]).sum(1) / w.sum(1)
        if a % (CHUNK * 60) == 0: print(f'  {a:,}/{len(q):,}', flush=True)
    np.save(f'{C.B.SP}/a31_shared_knn.npy', score.astype(np.float32))
    print('參數：' + '、'.join(feats))
    import a31_shared_frontier as FR
    R2 = pd.DataFrame(FR.frontier('A_KNN', score, D))
    for c in ('VALID_prec', 'TEST_prec', 'TEST_lb', 'TEST_buy'): R2[c] = (R2[c] * 100).round(1)
    print(R2.to_string(index=False))
    R2.to_csv('out/a31_shared_knn.csv', index=False)


if __name__ == '__main__':
    main()
