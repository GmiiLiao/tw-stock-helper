"""(1) 安慰劑：同一天內隨機洗牌標籤（保留每日正例數＝保留日期效應、抹掉特徵關係），跑完全相同的滾動驗證。
   (2) 重要度：訓練 ≤2025-12、保留 2026-01 起（單一最終保留期）；gain 與「同日內置換」的 wdAUC 下降，單一特徵與特徵群。"""
import os, numpy as np, pandas as pd, warnings, time, json
import evallib as E, groups as G
from models import HistGBDT
from run_cv import run, GB, PURGE, NEG_FRAC
warnings.filterwarnings('ignore')
t0 = time.time()
D = E.load(primary_only=True); R = E.rank_features(D); names = D['names']; s, y = D['s'], D['y']
# (1) 安慰劑
res = []
for sd in (() if os.environ.get('SKIP_PLACEBO') else (11, 12, 13)):
    rng = np.random.default_rng(sd)
    ys = y.copy()
    order = np.lexsort((rng.random(len(s)), s))            # 同日內隨機排序
    # 以「同日內重新指派」：每天把該日正例數個標籤隨機放到該日的列上
    ys = np.zeros_like(y)
    starts = np.r_[0, np.nonzero(np.diff(s[order]))[0] + 1, len(s)]
    pos_per_day = np.bincount(s, weights=y, minlength=s.max() + 1).astype(int)
    for a, b in zip(starts[:-1], starts[1:]):
        d = s[order[a]]; k = pos_per_day[d]
        if k > 0: ys[order[a:b][:k]] = 1                   # order 在日內已隨機 → 前 k 個即隨機抽樣
    D2 = {**D, 'y': ys}
    oof = run(D2, R, lambda: HistGBDT(**GB), 'placebo', seed=sd)
    m = np.isfinite(oof); t, _ = E.topk_table(oof[m], s[m], ys[m], Ks=(10, 20))
    res.append((E.within_day_auc(oof[m], s[m], ys[m]), E.pooled_auc(oof[m], ys[m]), t.lift[0], t.lift[1]))
    print('placebo seed', sd, 'wdAUC %.4f AUC %.4f lift@10 %.2f lift@20 %.2f' % res[-1], round(time.time() - t0), 's', flush=True)
r = np.array(res) if res else np.zeros((1, 4)); print('安慰劑平均 wdAUC %.4f±%.4f  lift@10 %.2f±%.2f' % (r[:, 0].mean(), r[:, 0].std(), r[:, 2].mean(), r[:, 2].std()))
# (2) 重要度（保留期 2026-01-01 起）
dates = np.array(D['dates']); ts = int(np.searchsorted(dates, '2026-01-01'))
tr = np.nonzero(s <= ts - PURGE)[0]; te = np.nonzero(s >= ts)[0]
rng = np.random.default_rng(0); neg = tr[y[tr] == 0]; pos = tr[y[tr] == 1]
tr_s = np.concatenate([pos, rng.choice(neg, int(len(neg) * NEG_FRAC), replace=False)])
m = HistGBDT(**GB).fit(R[tr_s], y[tr_s])
Xte, ste, yte = R[te], s[te], y[te]
base_sc = m.decision_function(Xte); base_wd = E.within_day_auc(base_sc, ste, yte)
t, b = E.topk_table(base_sc, ste, yte, Ks=(5, 10, 20, 50))
print('\n保留期 2026-01 起：訓練列 %d（正例 %d）、測試列 %d（正例 %d）；wdAUC %.4f AUC %.4f' % (len(tr_s), len(pos), len(te), yte.sum(), base_wd, E.pooled_auc(base_sc, yte)))
print(t.round(3).to_string(index=False))
# 同日內置換：對每一天，把該日各列的某特徵值隨機換位
order = np.lexsort((np.random.default_rng(9).random(len(ste)), ste))
starts = np.r_[0, np.nonzero(np.diff(ste[order]))[0] + 1, len(ste)]
def permute_cols(cols, seed):
    rr = np.random.default_rng(seed); Xp = Xte.copy()
    for a, b2 in zip(starts[:-1], starts[1:]):
        idx = order[a:b2]; perm = idx[rr.permutation(len(idx))]
        Xp[np.ix_(idx, cols)] = Xte[np.ix_(perm, cols)]
    return Xp
imp = []
for k, nm in enumerate(names):
    drops = [base_wd - E.within_day_auc(m.decision_function(permute_cols([k], sd)), ste, yte) for sd in (1, 2)]
    imp.append((nm, np.mean(drops), m.gain_imp[k] / m.gain_imp.sum()))
I = pd.DataFrame(imp, columns=['feat', 'perm_drop_wdAUC', 'gain_share']).sort_values('perm_drop_wdAUC', ascending=False)
I.to_csv(f'{E.B.SP}/importance{E.TAG}.csv', index=False)
print('\n— 單一特徵（同日置換後 wdAUC 下降；gain 占比）Top 25 —'); print(I.head(25).round(4).to_string(index=False))
ix = {n: i for i, n in enumerate(names)}
gi = []
for g, feats in G.GROUPS.items():
    cols = [ix[f] for f in feats]
    drops = [base_wd - E.within_day_auc(m.decision_function(permute_cols(cols, sd)), ste, yte) for sd in (1, 2)]
    gi.append((g, np.mean(drops), sum(m.gain_imp[c] for c in cols) / m.gain_imp.sum()))
GI = pd.DataFrame(gi, columns=['group', 'perm_drop_wdAUC', 'gain_share']).sort_values('perm_drop_wdAUC', ascending=False)
GI.to_csv(f'{E.B.SP}/importance_groups{E.TAG}.csv', index=False)
print('\n— 特徵群（整群同日置換）—'); print(GI.round(4).to_string(index=False))
