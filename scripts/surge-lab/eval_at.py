"""進入注意股（漲幅型）提前量曲線：h＝1,3,5,10 個交易日的外樣本偵測力。"""
import numpy as np, pandas as pd, os, json, warnings
import evallib as E
warnings.filterwarnings('ignore')
pd.set_option('display.width', 220)
os.environ['SURGE_DATASET'] = 'dataset_at.npz'
rows = []
for lab, h in (('', 1), ('yh3', 3), ('yh5', 5), ('yh10', 10)):
    os.environ['SURGE_LABEL'] = lab
    import importlib; importlib.reload(E)
    D = E.load(); O = np.load(f'{E.B.SP}/oof{E.TAG}.npz'); s, y = D['s'], D['y']
    m = np.isfinite(O['gbdt_rank'])
    for name in ('base_atr', 'logit_rank', 'gbdt_rank'):
        t, base = E.topk_table(O[name][m], s[m], y[m], Ks=(5, 10, 20, 50))
        rows.append(dict(提前日數=h, 模型=name, 事件=int(y[m].sum()), 基準率=base * 100, 同日AUC=E.within_day_auc(O[name][m], s[m], y[m]), **{f'lift@{int(x.K)}': x.lift for _, x in t.iterrows()}, 精確度10=t.precision[1] * 100, 召回10=t.recall[1] * 100, 召回50=t.recall[3] * 100))
R = pd.DataFrame(rows)
print(R[R.模型.isin(['base_atr', 'gbdt_rank'])].round(3).to_string(index=False))
# h=1 各季＋市場別
os.environ['SURGE_LABEL'] = ''; importlib.reload(E)
D = E.load(); O = np.load(f'{E.B.SP}/oof{E.TAG}.npz'); s, y = D['s'], D['y']; dates = np.array(D['dates']); sc = O['gbdt_rank']; m = np.isfinite(sc)
qtr = np.array([dates[i][:4] + 'Q' + str((int(dates[i][5:7]) - 1) // 3 + 1) for i in s])
tb = []
for q in sorted(set(qtr[m])):
    mm = m & (qtr == q); t, _ = E.topk_table(sc[mm], s[mm], y[mm], Ks=(10,)); tb.append(dict(Q=q, 事件=int(y[mm].sum()), 基準率=y[mm].mean() * 100, 同日AUC=E.within_day_auc(sc[mm], s[mm], y[mm]), lift10=t.lift[0]))
print('\nh=1 各季：'); print(pd.DataFrame(tb).round(3).to_string(index=False))
mk = json.load(open(f'{E.B.SP}/code_market.json')); market = np.array([mk.get(c, '?') for c in D['codes']])[D['j']]
for mkt in ('tse', 'otc'):
    mm = m & (market == mkt); t, base = E.topk_table(sc[mm], s[mm], y[mm], Ks=(10,)); print(f'h=1 {mkt}: 事件 {int(y[mm].sum())} 基準率 {base*100:.3f}% 同日AUC {E.within_day_auc(sc[mm], s[mm], y[mm]):.3f} lift@10 {t.lift[0]:.2f}')
