"""大盤委託失衡（orderFlowArchive，2023-07-31 起，市場層級）能否預測『隔日有多少檔起漲』。
日層級：s 日的失衡指標 vs 隔日起漲事件率；年內 Spearman（去年度漂移）與年內四分位。"""
import numpy as np, pandas as pd, json, warnings
import evallib as E
warnings.filterwarnings('ignore')
pd.set_option('display.width', 200)
D = E.load(); s, y = D['s'], D['y']; dates = np.array(D['dates'])
nday = np.bincount(s, minlength=len(dates)); pday = np.bincount(s, weights=y, minlength=len(dates))
df = pd.DataFrame({'date': dates, 'n': nday, 'pos': pday}); df = df[df.n > 0].copy(); df['rate'] = df.pos / df.n * 100; df['yr'] = df.date.str[:4]
of = pd.DataFrame(json.load(open(f'{E.B.SP}/orderflow.json')))
keep = ['date', 'imbalance', 'imb0930', 'imb1300', 'tailImbShift', 'auctionShift', 'bidWithdraw', 'askWithdraw', 'bidPerOrder', 'askPerOrder', 'fillRate']
of = of[keep]
df = df.merge(of, on='date', how='inner'); print('合併日數', len(df), df.date.min(), df.date.max())
for c in keep[1:]: df[c + '_d'] = df[c]
rows = []
for c in keep[1:]:
    r = dict(feat=c, all=df[['rate', c]].corr(method='spearman').iloc[0, 1])
    for Y in ('2023', '2024', '2025', '2026'):
        sub = df[df.yr == Y]
        r[Y] = sub[['rate', c]].corr(method='spearman').iloc[0, 1] if len(sub) > 30 else np.nan
    rows.append(r)
R = pd.DataFrame(rows); print(R.round(3).to_string(index=False))
print('\n年內四分位 → 隔日事件率%（imbalance）')
out = []
for Y, sub in df.groupby('yr'):
    sub = sub.copy(); sub['q'] = pd.qcut(sub['imbalance'].rank(method='first'), 4, labels=['Q1低', 'Q2', 'Q3', 'Q4高'])
    out.append(sub.groupby('q', observed=True).rate.mean().rename(Y))
print(pd.concat(out, axis=1).round(3).to_string())
