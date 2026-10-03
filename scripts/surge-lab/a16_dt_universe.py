"""當沖資料缺值（≈處置／禁當沖的代理）對結果的影響。AI 波段實驗的候選池排除處置股 ⇒ 用「當沖資料有值」當可交易母體的近似，重驗。
 (1) 既有 OOF 分數：前 10 名裡缺值者占多少？限縮在有值列重新排名後的 lift 與實際報酬。
 (2) 在有值母體上重新訓練＋滾動驗證（同一套設定）。"""
import numpy as np, pandas as pd, warnings
import evallib as E
from models import HistGBDT
from run_cv import run, GB
warnings.filterwarnings('ignore')
pd.set_option('display.width', 200)
D = E.load(primary_only=True); R = E.rank_features(D); names = D['names']; X = D['X']; s, y = D['s'], D['y']
O = np.load(f'{E.B.SP}/oof{E.TAG}.npz'); sc = O['gbdt_rank']
_ex = np.load(f'{E.B.SP}/{E.DATASET}')['m_extra'].astype(bool) if 'm_extra' in np.load(f'{E.B.SP}/{E.DATASET}').files else np.zeros(len(sc), bool)
sc = sc[~_ex]                                     # OOF 對齊主要母體（D 已排除 T2 進行中區段列）
test = np.isfinite(sc)
dt = X[:, names.index('dt_ratio20')]; has = np.isfinite(dt)
rk = {k: D[k] for k in ['o_c5', 'o_c10', 'o_c20', 'locked_open']}; rk['s'] = s
# (1)
idx = np.nonzero(test)[0]; r = E.rank_in_day_desc(sc[idx], s[idx]); top = idx[r < 10]
print('(1) 全母體前 10 名中，當沖資料缺值者占 %.1f%%（全母體缺值占 %.1f%%）' % (np.isnan(dt[top]).mean() * 100, np.isnan(dt[test]).mean() * 100))
m = test & has
t, base = E.topk_table(sc[m], s[m], y[m], Ks=(5, 10, 20, 50))
print('    只在「有當沖資料」列內排名：基準率 %.3f%%、事件 %d、同日 AUC %.3f' % (base * 100, y[m].sum(), E.within_day_auc(sc[m], s[m], y[m])))
print(t.round(3).to_string(index=False))
for h in ('o_c5', 'o_c10', 'o_c20'):
    uni = E.universe_returns(s, rk, m, hold=h); pk = E.pick_returns(sc, s, rk, 10, mask=m, hold=h)
    dp = pk.groupby('s').ret.mean(); du = uni.groupby('s').ret.mean(); j = pd.concat([dp, du], axis=1, keys=['p', 'u']).dropna().sort_index(); ex = j.p - j.u
    v = ex.values; T = len(v); L = {'o_c5': 5, 'o_c10': 10, 'o_c20': 20}[h]; rng = np.random.default_rng(3); nb = int(np.ceil(T / L)); mm = []
    for _ in range(2000):
        st = rng.integers(0, T, nb); ii = (st[:, None] + np.arange(L)[None, :]).ravel()[:T] % T; mm.append(v[ii].mean())
    lo, hi = np.percentile(mm, [2.5, 97.5])
    print(f'    {h}: 選股均 {pk.ret.mean()*100:5.2f}% 母體均 {uni.ret.mean()*100:5.2f}% 超額 {ex.mean()*100:5.2f}% 區塊CI[{lo*100:.2f},{hi*100:.2f}] 中位 {pk.ret.median()*100:.2f}% 跌>10% {(pk.ret<-0.1).mean()*100:.1f}%')
# (2) 只在有值母體上重訓
Dh = {**D}
sel = np.nonzero(has)[0]
Dsub = {k: (v[sel] if isinstance(v, np.ndarray) and len(v) == len(has) else v) for k, v in D.items()}
Rsub = R[sel]
oof2 = run(Dsub, Rsub, lambda: HistGBDT(**GB), 'dtfinite')
m2 = np.isfinite(oof2); s2, y2 = Dsub['s'], Dsub['y']
t2, b2 = E.topk_table(oof2[m2], s2[m2], y2[m2], Ks=(5, 10, 20, 50))
print('\n(2) 在有當沖資料母體上重訓重驗：基準率 %.3f%%、事件 %d、同日 AUC %.3f' % (b2 * 100, y2[m2].sum(), E.within_day_auc(oof2[m2], s2[m2], y2[m2])))
print(t2.round(3).to_string(index=False))
rk2 = {k: Dsub[k] for k in ['o_c5', 'o_c10', 'o_c20', 'locked_open']}; rk2['s'] = s2
for h in ('o_c5', 'o_c10', 'o_c20'):
    uni = E.universe_returns(s2, rk2, m2, hold=h); pk = E.pick_returns(oof2, s2, rk2, 10, mask=m2, hold=h)
    dp = pk.groupby('s').ret.mean(); du = uni.groupby('s').ret.mean(); j = pd.concat([dp, du], axis=1, keys=['p', 'u']).dropna().sort_index(); ex = j.p - j.u
    v = ex.values; T = len(v); L = {'o_c5': 5, 'o_c10': 10, 'o_c20': 20}[h]; rng = np.random.default_rng(3); nb = int(np.ceil(T / L)); mm = []
    for _ in range(2000):
        st = rng.integers(0, T, nb); ii = (st[:, None] + np.arange(L)[None, :]).ravel()[:T] % T; mm.append(v[ii].mean())
    lo, hi = np.percentile(mm, [2.5, 97.5])
    print(f'    {h}: 選股均 {pk.ret.mean()*100:5.2f}% 母體均 {uni.ret.mean()*100:5.2f}% 超額 {ex.mean()*100:5.2f}% 區塊CI[{lo*100:.2f},{hi*100:.2f}] 中位 {pk.ret.median()*100:.2f}% 跌>10% {(pk.ret<-0.1).mean()*100:.1f}%')
