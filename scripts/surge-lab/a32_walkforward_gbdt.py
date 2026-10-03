"""a32_walkforward 用的 HistGBDT 子類別：數學與 models.HistGBDT 完全相同（已驗證預測值與重要度逐位相同），只改記憶體配置。

  · 分箱矩陣改成 column-major（Fortran order），單欄抽取為連續記憶體
  · 每棵樹開始時把抽到的列 × 抽到的欄先取出一次（原版每一層重取一次）
實測（60k 列、60 棵、機器滿載下）：23.4s → 10.7s，輸出逐位相同。
"""
import numpy as np
from models import HistGBDT


class FastGBDT(HistGBDT):
    def _bin(self, X):
        Xb = np.empty(X.shape, dtype=np.uint8, order='F')
        for f in range(X.shape[1]):
            col = X[:, f]; b = np.searchsorted(self.edges[f], col, side='left').astype(np.int32) + 1
            b[~np.isfinite(col)] = 0
            Xb[:, f] = b
        return Xb

    def _grow(self, Xb, g, h, rows, feats):
        D, nb, l2, mch = self.depth, self.nb, self.l2, self.min_child_h
        nid = np.zeros(len(rows), dtype=np.int64)
        gr, hr = g[rows], h[rows]
        cols = {f: Xb[rows, f].astype(np.int64) for f in feats}
        levels = []
        for d in range(D):
            nn = 1 << d
            Gt = np.bincount(nid, weights=gr, minlength=nn); Ht = np.bincount(nid, weights=hr, minlength=nn)
            best_gain = np.full(nn, 0.0); best_f = np.full(nn, -1, dtype=np.int64); best_b = np.zeros(nn, dtype=np.int64)
            base = nid * nb
            for f in feats:
                key = base + cols[f]
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
