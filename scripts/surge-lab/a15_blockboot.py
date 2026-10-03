"""持有期重疊 → 逐日 bootstrap 的 CI 偏窄。改用『循環區塊 bootstrap』（區塊長 L 個連續交易日）重算超額報酬 CI，並補基準組合完整欄位。"""
import numpy as np, pandas as pd, warnings
import evallib as E
warnings.filterwarnings('ignore')
pd.set_option('display.width', 200)
D = E.load(); O = np.load(f'{E.B.SP}/oof.npz'); s, y = D['s'], D['y']
test = np.isfinite(O['gbdt_rank'])
rk = {k: D[k] for k in ['o_c5', 'o_c10', 'o_c20', 'locked_open']}; rk['s'] = s
def block_ci(ex, L, n=2000, seed=3):
    v = ex.values; T = len(v); rng = np.random.default_rng(seed); nb = int(np.ceil(T / L)); m = []
    for _ in range(n):
        st = rng.integers(0, T, nb); idx = (st[:, None] + np.arange(L)[None, :]).ravel()[:T] % T
        m.append(v[idx].mean())
    return np.percentile(m, [2.5, 97.5])
print('超額報酬（gbdt 前10 − 同日母體等權）：逐日 bootstrap vs 區塊 bootstrap')
for h, L in (('o_c5', 5), ('o_c10', 10), ('o_c20', 20)):
    uni = E.universe_returns(s, rk, test, hold=h); pk = E.pick_returns(O['gbdt_rank'], s, rk, 10, mask=test, hold=h)
    dp = pk.groupby('s').ret.mean(); du = uni.groupby('s').ret.mean(); j = pd.concat([dp, du], axis=1, keys=['p', 'u']).dropna().sort_index(); ex = j.p - j.u
    lo0, hi0 = E.boot_ci(pd.DataFrame({'s': j.index, 'ret': ex.values}))
    lo1, hi1 = block_ci(ex, L)
    lo2, hi2 = block_ci(ex, 2 * L)
    print(f'{h}: 超額 {ex.mean()*100:5.2f}%  逐日 CI[{lo0*100:5.2f},{hi0*100:5.2f}]  區塊(L={L}) CI[{lo1*100:5.2f},{hi1*100:5.2f}]  區塊(L={2*L}) CI[{lo2*100:5.2f},{hi2*100:5.2f}]')
# 基準組合完整欄位
t, base = E.topk_table(O['base_composite'][test], s[test], y[test], Ks=(5, 10, 20, 50))
print('\n組合基準(ATR+漲停史+趨勢+低借券) wdAUC %.3f AUC %.3f' % (E.within_day_auc(O['base_composite'][test], s[test], y[test]), E.pooled_auc(O['base_composite'][test], y[test])))
print(t.round(3).to_string(index=False))
