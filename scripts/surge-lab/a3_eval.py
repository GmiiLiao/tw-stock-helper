import numpy as np, pandas as pd, warnings
import evallib as E
warnings.filterwarnings('ignore')
pd.set_option('display.width', 220); pd.set_option('display.max_columns', 30)
D = E.load(); O = np.load(f'{E.B.SP}/oof.npz'); dates = np.array(D['dates'])
s, y = D['s'], D['y']
test = np.isfinite(O['gbdt_rank'])
print('測試列', int(test.sum()), '正例', int(y[test].sum()), '基準率 %.3f%%' % (y[test].mean() * 100), '日數', len(np.unique(s[test])))
yr = np.array([dates[i][:4] for i in s]); qtr = np.array([dates[i][:4] + 'Q' + str((int(dates[i][5:7]) - 1) // 3 + 1) for i in s])
cnt = pd.Series(s[y == 1]).value_counts(); cluster_days = set(cnt[cnt >= 15].index)
nc = test & ~np.isin(s, list(cluster_days))
models = ['base_random', 'base_atr', 'base_nlu250', 'base_composite', 'logit_rank', 'gbdt_raw', 'gbdt_rank']
rows = []
for m in models:
    sc = O[m]
    t, base = E.topk_table(sc[test], s[test], y[test], Ks=(5, 10, 20, 50))
    r = dict(model=m, wdAUC=E.within_day_auc(sc[test], s[test], y[test]), AUC=E.pooled_auc(sc[test], y[test]),
             wdAUC_noCluster=E.within_day_auc(sc[nc], s[nc], y[nc]))
    for _, x in t.iterrows(): r[f'lift@{int(x.K)}'] = x.lift; r[f'prec@{int(x.K)}%'] = x.precision * 100; r[f'recall@{int(x.K)}%'] = x.recall * 100
    rows.append(r)
R = pd.DataFrame(rows).set_index('model')
print('\n=== 外樣本總表（2025Q1~2026Q3）===')
print(R[['wdAUC', 'AUC', 'wdAUC_noCluster', 'lift@5', 'lift@10', 'lift@20', 'lift@50', 'prec@10%', 'recall@10%', 'recall@50%']].round(3).to_string())
print('\n=== 各季 within-day AUC / lift@10（gbdt_rank vs 基準）===')
qs = sorted(set(qtr[test]))
tb = []
for q in qs:
    m = test & (qtr == q)
    row = dict(Q=q, n_pos=int(y[m].sum()), base_rate=y[m].mean() * 100)
    for mod in ['base_atr', 'base_composite', 'logit_rank', 'gbdt_rank']:
        row[f'{mod}.wd'] = E.within_day_auc(O[mod][m], s[m], y[m])
    t, _ = E.topk_table(O['gbdt_rank'][m], s[m], y[m], Ks=(10,)); row['gbdt lift@10'] = t.lift[0]; row['gbdt prec@10 %'] = t.precision[0] * 100
    tb.append(row)
print(pd.DataFrame(tb).round(3).to_string(index=False))
print('\n=== 子群（gbdt_rank）===')
for nm, m in [('A only', test & D['yA'] & ~D['yB']), ('B only', test & D['yB'] & ~D['yA'])]:
    # 子群：正例只取該型態、負例全部
    mm = test & ((y == 0) | (D['yA'] & ~D['yB'] if 'A' in nm else D['yB'] & ~D['yA']))
    t, b = E.topk_table(O['gbdt_rank'][mm], s[mm], y[mm], Ks=(10, 20))
    print(nm, 'n_pos', int(y[mm].sum()), 'wdAUC %.3f' % E.within_day_auc(O['gbdt_rank'][mm], s[mm], y[mm]), 'lift@10 %.1f lift@20 %.1f' % (t.lift[0], t.lift[1]))
liq = test & (D['X'][:, D['names'].index('log_tv20')] >= np.log10(5e4))
t, b = E.topk_table(O['gbdt_rank'][liq], s[liq], y[liq], Ks=(5, 10, 20, 50))
print('\n流動性≥0.5億(AI波段候選池口徑)：n_rows', int(liq.sum()), 'n_pos', int(y[liq].sum()), '基準率 %.3f%%' % (b * 100), 'wdAUC %.3f' % E.within_day_auc(O['gbdt_rank'][liq], s[liq], y[liq]))
print(t.round(3).to_string(index=False))
