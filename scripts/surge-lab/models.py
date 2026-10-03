"""純 numpy 的直方圖 GBDT（logloss）與 L2 邏輯迴歸；環境沒有 sklearn/lightgbm，不另外安裝。

HistGBDT  ：level-wise、完整二元樹（深度 depth）、NaN 另成 0 號箱、column/row 子抽樣、gain 重要度
Logistic  ：標準化＋Newton（IRLS）＋L2
"""
import numpy as np


class HistGBDT:
    def __init__(self, n_trees=200, depth=3, lr=0.05, n_bins=48, min_child_h=2.0, l2=5.0,
                 colsample=0.5, subsample=0.8, seed=0, min_gain=1e-6):
        self.n_trees, self.depth, self.lr, self.n_bins = n_trees, depth, lr, n_bins
        self.min_child_h, self.l2, self.colsample, self.subsample, self.seed = min_child_h, l2, colsample, subsample, seed
        self.min_gain = min_gain

    # ── 分箱 ──
    def _fit_bins(self, X):
        self.edges = []
        for f in range(X.shape[1]):
            col = X[:, f]; ok = np.isfinite(col)
            if ok.sum() < 10: self.edges.append(np.array([])); continue
            qs = np.unique(np.quantile(col[ok], np.linspace(0, 1, self.n_bins + 1)[1:-1]))
            self.edges.append(qs)

    def _bin(self, X):
        Xb = np.empty(X.shape, dtype=np.uint8)
        for f in range(X.shape[1]):
            col = X[:, f]; b = np.searchsorted(self.edges[f], col, side='left').astype(np.int32) + 1
            b[~np.isfinite(col)] = 0
            Xb[:, f] = b
        return Xb

    def fit(self, X, y, w=None, verbose=False):
        rng = np.random.default_rng(self.seed)
        n, F = X.shape
        self._fit_bins(X); Xb = self._bin(X)
        self.nb = max(len(e) for e in self.edges) + 2          # 0＝缺值、1..len(edges)+1
        y = y.astype(np.float64); w = np.ones(n) if w is None else w.astype(np.float64)
        p0 = np.clip((w * y).sum() / w.sum(), 1e-6, 1 - 1e-6)
        self.base = np.log(p0 / (1 - p0))
        score = np.full(n, self.base)
        self.trees = []
        self.gain_imp = np.zeros(F)
        for it in range(self.n_trees):
            p = 1 / (1 + np.exp(-score))
            g = (p - y) * w; h = np.maximum(p * (1 - p), 1e-6) * w
            rows = np.nonzero(rng.random(n) < self.subsample)[0] if self.subsample < 1 else np.arange(n)
            feats = np.sort(rng.choice(F, max(1, int(F * self.colsample)), replace=False)) if self.colsample < 1 else np.arange(F)
            tree = self._grow(Xb, g, h, rows, feats)
            self.trees.append(tree)
            score += self.lr * self._predict_tree(tree, Xb)
            if verbose and (it + 1) % 50 == 0: print(f'  tree {it + 1}/{self.n_trees}')
        return self

    def _grow(self, Xb, g, h, rows, feats):
        D, nb, l2, mch = self.depth, self.nb, self.l2, self.min_child_h
        nid = np.zeros(len(rows), dtype=np.int64)
        gr, hr = g[rows], h[rows]
        levels = []
        for d in range(D):
            nn = 1 << d
            Gt = np.bincount(nid, weights=gr, minlength=nn); Ht = np.bincount(nid, weights=hr, minlength=nn)
            best_gain = np.full(nn, 0.0); best_f = np.full(nn, -1, dtype=np.int64); best_b = np.zeros(nn, dtype=np.int64)
            for f in feats:
                key = nid * nb + Xb[rows, f]
                Hg = np.bincount(key, weights=gr, minlength=nn * nb).reshape(nn, nb)
                Hh = np.bincount(key, weights=hr, minlength=nn * nb).reshape(nn, nb)
                GL = np.cumsum(Hg, 1)[:, :-1]; HL = np.cumsum(Hh, 1)[:, :-1]
                GR = Gt[:, None] - GL; HR = Ht[:, None] - HL
                with np.errstate(divide='ignore', invalid='ignore'):
                    gain = GL ** 2 / (HL + l2) + GR ** 2 / (HR + l2) - (Gt ** 2 / (Ht + l2))[:, None]
                gain[(HL < mch) | (HR < mch)] = -np.inf
                bb = np.argmax(gain, 1); bg = gain[np.arange(nn), bb]
                upd = bg > best_gain + 1e-12
                best_gain = np.where(upd, bg, best_gain); best_f = np.where(upd, f, best_f); best_b = np.where(upd, bb, best_b)
            valid = best_gain > self.min_gain
            best_f = np.where(valid, best_f, -1)
            for nd in np.nonzero(valid)[0]: self.gain_imp[best_f[nd]] += best_gain[nd]
            levels.append((best_f.copy(), best_b.copy()))
            fsel = best_f[nid]
            xv = Xb[rows, np.maximum(fsel, 0)]
            go_left = (fsel < 0) | (xv <= best_b[nid])
            nid = nid * 2 + (~go_left).astype(np.int64)
        nl = 1 << D
        G = np.bincount(nid, weights=gr, minlength=nl); H = np.bincount(nid, weights=hr, minlength=nl)
        leaf = -G / (H + l2)
        return levels, leaf

    def _predict_tree(self, tree, Xb):
        levels, leaf = tree
        n = Xb.shape[0]; nid = np.zeros(n, dtype=np.int64)
        ar = np.arange(n)
        for (bf, bb) in levels:
            fsel = bf[nid]
            xv = Xb[ar, np.maximum(fsel, 0)]
            go_left = (fsel < 0) | (xv <= bb[nid])
            nid = nid * 2 + (~go_left).astype(np.int64)
        return leaf[nid]

    def decision_function(self, X, n_trees=None):
        Xb = self._bin(X)
        s = np.full(X.shape[0], self.base)
        for tr in self.trees[:n_trees]:
            s += self.lr * self._predict_tree(tr, Xb)
        return s


class Logistic:
    def __init__(self, l2=50.0, iters=25):
        self.l2, self.iters = l2, iters

    def _prep(self, X):
        Z = np.where(np.isfinite(X), X, self.med)
        return (Z - self.mu) / self.sd

    def fit(self, X, y, w=None):
        X = X.astype(np.float64)
        self.med = np.nanmedian(X, 0); self.med = np.where(np.isfinite(self.med), self.med, 0.0)
        Z = np.where(np.isfinite(X), X, self.med)
        self.mu = Z.mean(0); self.sd = Z.std(0); self.sd[self.sd < 1e-9] = 1.0
        Z = (Z - self.mu) / self.sd
        n, F = Z.shape
        A = np.hstack([Z, np.ones((n, 1))])
        wt = np.ones(n) if w is None else w
        beta = np.zeros(F + 1); beta[-1] = np.log(y.mean() / (1 - y.mean()))
        R = np.eye(F + 1) * self.l2; R[-1, -1] = 0
        for _ in range(self.iters):
            z = A @ beta; p = 1 / (1 + np.exp(-np.clip(z, -30, 30)))
            grad = A.T @ (wt * (p - y)) + R @ beta
            W = wt * p * (1 - p)
            Hs = (A * W[:, None]).T @ A + R
            step = np.linalg.solve(Hs + 1e-6 * np.eye(F + 1), grad)
            beta -= step
            if np.abs(step).max() < 1e-6: break
        self.beta = beta
        return self

    def decision_function(self, X):
        Z = self._prep(X.astype(np.float64))
        return Z @ self.beta[:-1] + self.beta[-1]
