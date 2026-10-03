"""a31-B 步驟 3：GBDT（numpy HistGBDT）學「隔日漲停」與「隔日漲停且開盤買得到」。

用法：python3 a31_simB_gbdt.py <ALL_y|ALL_buy|CONT_y|CONT_buy|FRESH_y|FRESH_buy>
  ALL  ＝全部列一個模型（x_lu_s 等為特徵，可自行分支）；負例抽 25%（權重 4）、正例全取
  CONT ＝只用延續群（s 日已漲停）列，不抽樣
  FRESH＝只用新起漲群列，負例抽 25%
  y    ＝m_y（隔日漲停）；buy＝m_buy_lu（隔日漲停且開盤 < 漲停價）
特徵＝123 個原值（f_*／x_*，不含尾盤五檔）＋同日百分位（非大盤類）。
流程：DESIGN 訓練 → VALID 依「每日前 3 名精確度＋AUC」選樹數 → 以該樹數產生 VALID／TEST 分數（DESIGN 模型；門檻轉移用）
      → 另以 DESIGN＋VALID 重訓同樹數，產生 TEST 分數（refit；只用於每日前 K）。
輸出：.surge-cache/a31_simB_gbdt_<name>.npz（score_des、score_dv、imp、名稱）
"""
import sys, time
import numpy as np
import a31_simB_common as C
from models import HistGBDT

NEG_KEEP = 0.25
CHECK = (100, 200, 300, 400, 500, 600)


class Feats:
    """依列索引即時組特徵（原值＋同日百分位），不在記憶體中展開整張 1.5M×234 矩陣。"""
    def __init__(self, D):
        self.X = D['X']
        self.R = np.load(C.RANK_CACHE, mmap_mode='r')
        self.keep = np.nonzero(~C.day_constant(D['X'], D['s']))[0]
        self.names = list(D['names']) + [f'pct_{D["names"][k]}' for k in self.keep]

    def __call__(self, idx):
        if len(idx) > 1 and not np.all(np.diff(idx) > 0): raise ValueError('idx 必須嚴格遞增（與標籤對齊）')
        return np.hstack([self.X[idx], np.asarray(self.R[idx])[:, self.keep]]).astype(np.float32)


def score_chunked(m, F, idx, n_trees=None, chunk=200000):
    """idx 須遞增。"""
    out = np.empty(len(idx), np.float32)
    for a in range(0, len(idx), chunk):
        out[a:a + chunk] = m.decision_function(F(idx[a:a + chunk]), n_trees=n_trees)
    return out


def daily_topk_prec(score, y, s, k):
    rid = C.rank_in_day(score, s)
    m = rid < k
    return y[m].mean()


def auc(score, y):
    o = np.argsort(score); r = np.empty(len(score)); r[o] = np.arange(1, len(score) + 1)
    n1 = y.sum(); n0 = len(y) - n1
    return (r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else 'ALL_y'
    grp, tgt = name.split('_')
    t0 = time.time()
    D = C.load()
    F = Feats(D); fnames = F.names
    y = (D['y'] if tgt == 'y' else D['buy_lu']).astype(np.int8)
    lu = D['lu_s'].astype(bool); sp = D['split']
    gm = np.ones(len(y), bool) if grp == 'ALL' else (lu if grp == 'CONT' else ~lu)
    rng = np.random.default_rng(7)
    params = dict(n_trees=max(CHECK), depth=3 if grp == 'CONT' else 5, lr=0.03 if grp == 'CONT' else 0.05,
                  min_child_h=2.0 if grp == 'CONT' else 5.0, l2=10.0, colsample=0.5, subsample=0.8, seed=3)

    def train_rows(spmask):
        ii = np.nonzero(gm & spmask)[0]
        if grp == 'CONT': return ii, np.ones(len(ii))
        keep = (y[ii] == 1) | (rng.random(len(ii)) < NEG_KEEP)
        ii = ii[keep]; w = np.where(y[ii] == 1, 1.0, 1 / NEG_KEEP)
        return ii, w

    tr, w = train_rows(sp == 0)
    print(f'[{name}] 訓練列 {len(tr):,}（正例 {int(y[tr].sum()):,}） 特徵 {len(fnames)}', flush=True)
    m = HistGBDT(**params).fit(F(tr), y[tr], w=w)
    print(f'[{name}] DESIGN 模型完成 {time.time() - t0:.0f}s', flush=True)
    va = np.nonzero(gm & (sp == 1))[0]
    best, best_val = None, -1
    for nt in CHECK:
        sc = score_chunked(m, F, va, n_trees=nt)
        p3 = daily_topk_prec(sc, D['y'][va].astype(float), D['s'][va], 3); a = auc(sc, y[va].astype(float))
        p10 = daily_topk_prec(sc, D['y'][va].astype(float), D['s'][va], 10)
        val = p3 + a                                           # 兩者同權（皆 0～1 量級）
        print(f'  trees {nt}: VALID AUC({tgt}) {a:.4f}  top3/day prec(m_y) {p3 * 100:.2f}%  top10/day {p10 * 100:.2f}%', flush=True)
        if val > best_val: best, best_val = nt, val
    print(f'[{name}] 選 {best} 棵', flush=True)
    score_des = np.full(len(y), np.nan, np.float32)
    q = np.nonzero(gm)[0]
    score_des[q] = score_chunked(m, F, q, n_trees=best)
    imp = m.gain_imp.copy()
    # DESIGN+VALID 重訓
    tr2, w2 = train_rows(sp <= 1)
    m2 = HistGBDT(**{**params, 'n_trees': best}).fit(F(tr2), y[tr2], w=w2)
    score_dv = np.full(len(y), np.nan, np.float32)
    te = np.nonzero(gm & (sp == 2))[0]
    score_dv[te] = score_chunked(m2, F, te)
    np.savez_compressed(f'{C.SP}/a31_simB_gbdt_{name}.npz', score_des=score_des, score_dv=score_dv, imp=imp,
                        imp_dv=m2.gain_imp, fnames=np.array(fnames), n_trees=best)
    o = np.argsort(-imp)[:20]
    print(f'[{name}] 重要度前 20：' + '、'.join(f'{fnames[i]}({imp[i] / imp.sum() * 100:.1f}%)' for i in o))
    print(f'[{name}] done {time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
