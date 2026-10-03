import numpy as np, pandas as pd, warnings
import evallib as E
warnings.filterwarnings('ignore')
pd.set_option('display.width', 200)
D = E.load(); O = np.load(f'{E.B.SP}/oof.npz'); dates = np.array(D['dates']); s, y = D['s'], D['y']
names = D['names']; X = D['X']
test = np.isfinite(O['gbdt_rank'])
rk = {k: D[k] for k in ['o_c5', 'o_c10', 'o_c20', 'locked_open']}; rk['s'] = s
# ① 排除群聚日（該日母體內事件≥15 檔）
cnt = pd.Series(s[y == 1]).value_counts(); cl = set(cnt[cnt >= 15].index)
nc = test & ~np.isin(s, list(cl))
print('群聚日', len(cl), '：', sorted(dates[list(cl)])[:12], '...')
for lab, mask in (('全部測試日', test), ('排除群聚日', nc)):
    t, base = E.topk_table(O['gbdt_rank'][mask], s[mask], y[mask], Ks=(10, 20))
    out = [f'{lab}: wdAUC {E.within_day_auc(O["gbdt_rank"][mask], s[mask], y[mask]):.3f} lift@10 {t.lift[0]:.2f} lift@20 {t.lift[1]:.2f}']
    for h in ('o_c5', 'o_c10', 'o_c20'):
        uni = E.universe_returns(s, rk, mask, hold=h); pk = E.pick_returns(O['gbdt_rank'], s, rk, 10, mask=mask, hold=h)
        dp = pk.groupby('s').ret.mean(); du = uni.groupby('s').ret.mean(); j = pd.concat([dp, du], axis=1, keys=['p', 'u']).dropna(); ex = j.p - j.u
        lo, hi = E.boot_ci(pd.DataFrame({'s': j.index, 'ret': ex.values}))
        out.append(f'   {h}: 選股均 {pk.ret.mean()*100:5.2f}% 基準 {uni.ret.mean()*100:5.2f}% 日均超額 {ex.mean()*100:5.2f}% CI[{lo*100:.2f},{hi*100:.2f}]')
    print('\n'.join(out))
# ② 超額 vs 大盤（同日母體等權 5 日報酬）三分位
h = 'o_c5'
uni = E.universe_returns(s, rk, test, hold=h); pk = E.pick_returns(O['gbdt_rank'], s, rk, 10, mask=test, hold=h)
dp = pk.groupby('s').ret.mean(); du = uni.groupby('s').ret.mean(); j = pd.concat([dp, du], axis=1, keys=['p', 'u']).dropna()
j['ex'] = j.p - j.u; j['q'] = pd.qcut(j.u, 3, labels=['空頭日(基準報酬最低1/3)', '中性日', '多頭日(最高1/3)'])
print('\n② 依「該日母體 5 日報酬」分三組：選股超額')
print(j.groupby('q', observed=True).agg(days=('p', 'size'), pick=('p', 'mean'), uni=('u', 'mean'), excess=('ex', 'mean')).mul([1, 100, 100, 100]).round(2).to_string())
b = np.polyfit(j.u, j.p, 1); print('日報酬回歸：選股 = %.2f × 母體 + %.3f%%（beta>1 代表高波動放大大盤）' % (b[0], b[1] * 100))
# 選股的平均 ATR vs 母體
idx = np.nonzero(test)[0]; r = E.rank_in_day_desc(O['gbdt_rank'][idx], s[idx]); sel = idx[r < 10]
atr = X[:, names.index('atr14')]
print('前10名平均 ATR14 %.2f%% vs 母體中位 %.2f%%；平均 20 日均成交值 log10(千元) %.2f vs %.2f' % (np.nanmean(atr[sel]) * 100, np.nanmedian(atr[idx]) * 100, np.nanmean(X[sel, names.index('log_tv20')]), np.nanmean(X[idx, names.index('log_tv20')])))
# ③ 各季大盤背景
qtr = np.array([dates[i][:4] + 'Q' + str((int(dates[i][5:7]) - 1) // 3 + 1) for i in s])
print('\n③ 各季：母體 5 日等權平均報酬（未扣成本）')
for q in sorted(set(qtr[test])):
    m = test & (qtr == q); u = E.universe_returns(s, rk, m, hold='o_c5'); print(q, '%.2f%%' % (u.ret.mean() * 100), ' 母體 20 日', '%.2f%%' % (E.universe_returns(s, rk, m, hold='o_c20').ret.mean() * 100))
