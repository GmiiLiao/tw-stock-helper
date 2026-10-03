"""a31-B 步驟 2：kNN 相似度與「正例輪廓中心」比對（同日百分位空間）。

用法：python3 a31_simB_knn.py <U|A|T15>
  U  ＝123 個參數等權（「所有參數一起比相似」的字面版）
  A  ＝依 DESIGN 單參數分離度加權：w＝max(|AUC−0.5|−0.02, 0)（分群各自計算；a31_simB_profile.csv）
  T15＝分離度前 15 名參數等權
分群：新起漲（s 日未漲停）與延續（s 日已漲停）各自在群內找鄰居（兩群分布差太多，混找會被群別主導）。
參考庫＝DESIGN 列（新起漲：全部正例＋隨機 60,000 負例，負例以抽樣率回權；延續：DESIGN 全部列）。
查詢＝VALID＋TEST 列（DESIGN 列不評分——避免自己找到自己）。
分數：kNN 正例比例（k＝25/100/400，回權後≈局部隔日漲停機率）；CENT＝到最近負例中心距離−到最近正例中心距離（各 16 群 k-means）。
輸出：.surge-cache/a31_simB_knn_<W>.npz
"""
import sys, time
import numpy as np, pandas as pd
import a31_simB_common as C

KS = (25, 100, 400)
NEG_REF = 60000
N_CENT = 16
CHUNK = 2048


def weights(D, scheme, group):
    names = D['names']
    if scheme == 'U': return np.ones(len(names), np.float32)
    T = pd.read_csv(f'{C.OUT}/a31_simB_profile.csv'); T = T[T.group == group].set_index('feature').reindex(names)
    sep = T['sep'].fillna(0).values
    if scheme == 'A': return np.maximum(sep - 0.02, 0).astype(np.float32)
    if scheme == 'T15':
        w = np.zeros(len(names), np.float32); w[np.argsort(-sep)[:15]] = 1; return w
    raise ValueError(scheme)


def kmeans(Z, k, iters=30, seed=0):
    rng = np.random.default_rng(seed)
    cen = Z[rng.choice(len(Z), k, replace=False)].copy()
    for _ in range(iters):
        d = (Z ** 2).sum(1)[:, None] + (cen ** 2).sum(1)[None] - 2 * Z @ cen.T
        a = d.argmin(1)
        for c in range(k):
            if (a == c).any(): cen[c] = Z[a == c].mean(0)
    return cen


def knn_scores(Zr, yr, wr, Zq):
    """回傳 (len(Zq), len(KS)) 的回權正例比例。"""
    rn = (Zr ** 2).sum(1)
    out = np.zeros((len(Zq), len(KS)), np.float32)
    kmax = max(KS)
    for a in range(0, len(Zq), CHUNK):
        q = Zq[a:a + CHUNK]
        d = rn[None, :] - 2 * q @ Zr.T          # |q|² 對同一列是常數，排序不需要
        nn = np.argpartition(d, kmax, axis=1)[:, :kmax]
        dd = np.take_along_axis(d, nn, 1); o = np.argsort(dd, 1); nn = np.take_along_axis(nn, o, 1)
        yy = yr[nn]; ww = wr[nn]
        for i, k in enumerate(KS):
            pw = (yy[:, :k] * ww[:, :k]).sum(1); tw = ww[:, :k].sum(1)
            out[a:a + len(q), i] = pw / tw
    return out


def main():
    scheme = sys.argv[1] if len(sys.argv) > 1 else 'A'
    t0 = time.time()
    D = C.load(); R = C.ranks(D)
    y = D['y'].astype(np.float32); lu = D['lu_s'].astype(bool); sp = D['split']
    n = len(y)
    S = np.full((n, len(KS)), np.nan, np.float32); CENT = np.full(n, np.nan, np.float32)
    rng = np.random.default_rng(1)
    for group, gm in (('fresh', ~lu), ('cont', lu)):
        w = weights(D, scheme, group); sw = np.sqrt(w)[None, :]
        ref = np.nonzero(gm & (sp == 0))[0]
        if group == 'fresh':
            pos = ref[y[ref] == 1]; neg = ref[y[ref] == 0]
            negs = rng.choice(neg, NEG_REF, replace=False)
            ref = np.r_[pos, negs]; wr = np.r_[np.ones(len(pos)), np.full(NEG_REF, len(neg) / NEG_REF)].astype(np.float32)
        else:
            wr = np.ones(len(ref), np.float32)
        Zr = (R[ref] * sw).astype(np.float32); yr = y[ref]
        q = np.nonzero(gm & (sp >= 1))[0]
        Zq = (R[q] * sw).astype(np.float32)
        S[q] = knn_scores(Zr, yr, wr, Zq)
        cp = kmeans(Zr[yr == 1], N_CENT); cn = kmeans(Zr[yr == 0][:60000], N_CENT, seed=2)
        qn = (Zq ** 2).sum(1)[:, None]
        dp = (qn + (cp ** 2).sum(1)[None] - 2 * Zq @ cp.T).min(1); dn = (qn + (cn ** 2).sum(1)[None] - 2 * Zq @ cn.T).min(1)
        CENT[q] = dn - dp
        print(f'[{scheme}] {group}: refs {len(ref):,}（正例 {int(yr.sum()):,}）查詢 {len(q):,}  {time.time() - t0:.0f}s', flush=True)
    np.savez_compressed(f'{C.SP}/a31_simB_knn_{scheme}.npz', knn=S, cent=CENT, ks=np.array(KS))
    print('done', time.time() - t0)


if __name__ == '__main__':
    main()
