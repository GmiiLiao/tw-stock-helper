"""時點訊號：同一檔股票「自己」的歷史比較。
把每個特徵在「該股自己所有母體日」內排百分位，看起漲前一天(s)落在自己歷史的哪個位置。
＝扣掉「這檔本來就是高波動/愛漲停的股性」之後，剩下的才是『什麼時候』的訊號。
只用有 ≥2 個事件、且母體日 ≥80 的股票（同股至少有對照日）。CI 依股票重抽（同股事件不獨立）。"""
import numpy as np, pandas as pd, warnings
import evallib as E, groups as G
warnings.filterwarnings('ignore')
pd.set_option('display.width', 220)
D = E.load(); names = D['names']; X = D['X']; j = D['j']; y = D['y']
ev_cnt = pd.Series(j[y == 1]).value_counts()
rowcnt = pd.Series(j).value_counts()
keep_stocks = set(ev_cnt[ev_cnt >= 2].index) & set(rowcnt[rowcnt >= 80].index)
m = np.isin(j, list(keep_stocks))
print('納入股票', len(keep_stocks), '列', int(m.sum()), '事件', int(y[m].sum()))
jj = j[m]; yy = y[m]
rng = np.random.default_rng(2)
grp = {f: g for g, fs in G.GROUPS.items() for f in fs}
U = pd.read_csv(f'{E.B.SP}/univariate.csv').set_index('feat')
rows = []
stock_ids = np.unique(jj[yy == 1])
for k, nm in enumerate(names):
    if nm.startswith('mkt_'): continue
    x = pd.Series(X[m, k].astype(np.float64))
    r = x.groupby(jj).rank(pct=True, method='average').values
    rp = r[yy == 1]; ok = np.isfinite(rp)
    if ok.sum() < 200: continue
    auc_ws = rp[ok].mean()
    dfp = pd.DataFrame({'j': jj[yy == 1][ok], 'r': rp[ok]}).groupby('j').r.agg(['sum', 'count'])
    S, N = dfp['sum'].values, dfp['count'].values
    bs = [S[i].sum() / N[i].sum() for i in (rng.integers(0, len(S), len(S)) for _ in range(300))]
    rows.append(dict(feat=nm, group=grp.get(nm, ''), auc_within_stock=auc_ws, se=np.std(bs), t=(auc_ws - 0.5) / np.std(bs), auc_cross_section=U.loc[nm, 'auc']))
R = pd.DataFrame(rows); R['effect'] = (R.auc_within_stock - 0.5).abs(); R = R.sort_values('effect', ascending=False)
R.to_csv(f'{E.B.SP}/timing_within_stock.csv', index=False)
print('\n— 同股自比：起漲前一日落在「自己歷史」的百分位（0.5＝與平常日無異）—')
print(R.head(40).round(3).to_string(index=False))
print('\n各群平均 |auc−0.5|：同股自比 vs 跨股（橫斷面）')
g = R.assign(ws=(R.auc_within_stock - 0.5).abs(), cs=(R.auc_cross_section - 0.5).abs()).groupby('group')[['ws', 'cs']].mean()
print(g.sort_values('cs', ascending=False).round(3).to_string())
