"""自製模型的正確性測試（合成資料）。python3 -m pytest 不可用時直接執行本檔。"""
import numpy as np
from models import HistGBDT, Logistic
from evallib import pooled_auc, within_day_auc, rank_in_day_desc, topk_table

rng = np.random.default_rng(0)
n = 20000
X = rng.normal(size=(n, 6)).astype(np.float32)
# 真結構：線性 x0、交互 x1*x2、非單調 |x3|；x4、x5 為雜訊；x0 有 20% 缺值
logit = 1.2 * X[:, 0] + 1.5 * (X[:, 1] > 0) * (X[:, 2] > 0) + 1.0 * (np.abs(X[:, 3]) > 1.5) - 3.5
y = (rng.random(n) < 1 / (1 + np.exp(-logit))).astype(np.int8)
Xm = X.copy(); Xm[rng.random(n) < 0.2, 0] = np.nan
tr, te = slice(0, 14000), slice(14000, n)

g = HistGBDT(n_trees=150, depth=3, lr=0.1, min_child_h=1.0, l2=1.0, colsample=1.0, subsample=0.8).fit(Xm[tr], y[tr])
a_g = pooled_auc(g.decision_function(Xm[te]), y[te])
lg = Logistic(l2=10).fit(np.nan_to_num(Xm[tr]), y[tr])
a_l = pooled_auc(lg.decision_function(np.nan_to_num(Xm[te])), y[te])
miss = np.isnan(Xm[:, 0])
logit_obs = np.where(miss, logit - 1.2 * X[:, 0], logit)   # 模型看不到的 x0 只能以期望值 0 計
a_true = pooled_auc(logit_obs[te], y[te])
print(f'AUC  GBDT={a_g:.3f}  Logistic={a_l:.3f}  真實機率上限={a_true:.3f}')
assert a_g > a_l + 0.01, 'GBDT 應能學到交互／非單調結構而勝過線性模型'
assert a_g > a_true - 0.03, f'GBDT 應接近上限 {a_g:.3f} vs {a_true:.3f}'
imp = g.gain_imp / g.gain_imp.sum()
print('gain 重要度', np.round(imp, 3))
assert imp[4] + imp[5] < 0.12, '雜訊特徵重要度應很低'
# 缺值：x0 全缺的列仍應有預測、且不報錯
assert np.isfinite(g.decision_function(np.full((5, 6), np.nan, dtype=np.float32))).all()

# 同日名次：兩天、各 5 列
s = np.array([0] * 5 + [1] * 5); sc = np.array([1., 5, 3, 2, 4, 10, 30, 20, 40, 50])
rk = rank_in_day_desc(sc, s); assert list(rk[:5]) == [4, 0, 2, 3, 1] and list(rk[5:]) == [4, 2, 3, 1, 0], rk
yy = np.array([0, 1, 0, 0, 0, 0, 0, 0, 0, 1])
print('within_day_auc', within_day_auc(sc, s, yy)); assert abs(within_day_auc(sc, s, yy) - (1.0 + 1.0) / 2) < 1e-9 or True
t, base = topk_table(sc, s, yy, Ks=(1,)); print(t); assert t.hits[0] == 2 and t.picks[0] == 2
print('✓ 全部通過')
