"""大盤環境與「當天有多少股票隔日起漲」。日層級分析：每個 s 日一列。"""
import numpy as np, pandas as pd, warnings
import evallib as E
warnings.filterwarnings('ignore')
pd.set_option('display.width', 220)
D = E.load(); names = D['names']; X = D['X']; s, y = D['s'], D['y']; dates = np.array(D['dates'])
nday = np.bincount(s, minlength=len(dates)); pday = np.bincount(s, weights=y, minlength=len(dates))
days = np.nonzero(nday > 0)[0]
first_row = {d: np.nonzero(s == d)[0][0] for d in days}
mk = ['mkt_r1', 'mkt_r5', 'mkt_r20', 'mkt_breadth_ma20', 'mkt_lu_cnt', 'mkt_lu_cnt5', 'mkt_vol_ratio', 'mkt_near_hi']
df = pd.DataFrame({'d': days, 'date': dates[days], 'n': nday[days], 'pos': pday[days]})
for k in mk: df[k] = [X[first_row[d], names.index(k)] for d in days]
df['rate'] = df.pos / df.n * 100; df['yr'] = df.date.str[:4]
# 前一日起漲事件數（事件自相關：昨天有人起漲，今天也容易有）
df['pos_lag1'] = df.pos.shift(1); df['pos_lag5'] = df.pos.rolling(5).sum().shift(1)
df['mkt_lu_lag'] = df.mkt_lu_cnt
print('日數', len(df), '平均每日事件', round(df.pos.mean(), 2), '中位', df.pos.median(), '最大', int(df.pos.max()))
print('\n— 日事件率與大盤特徵的 Spearman（全期／逐年）—')
rows = []
for k in mk + ['pos_lag1', 'pos_lag5']:
    r = dict(feat=k, all=df[['rate', k]].corr(method='spearman').iloc[0, 1])
    for Y in ('2023', '2024', '2025', '2026'):
        sub = df[df.yr == Y]; r[Y] = sub[['rate', k]].corr(method='spearman').iloc[0, 1]
    rows.append(r)
print(pd.DataFrame(rows).round(3).to_string(index=False))
print('\n— 年內分四分位（排除年度漂移）：大盤漲停家數 → 隔日事件率% —')
def q4(col):
    out = []
    for Y, sub in df.groupby('yr'):
        sub = sub.copy(); sub['q'] = pd.qcut(sub[col].rank(method='first'), 4, labels=['Q1低', 'Q2', 'Q3', 'Q4高'])
        out.append(sub.groupby('q', observed=True).rate.mean().rename(Y))
    return pd.concat(out, axis=1)
for col in ['mkt_lu_cnt5', 'mkt_r1', 'mkt_r5', 'mkt_breadth_ma20', 'mkt_near_hi']:
    print(f'\n{col}'); print(q4(col).round(3).to_string())
# 急殺後 V 轉：mkt_r1 ≤ -3%（等權中位數）
print('\n— 大盤單日急殺（母體中位數報酬 ≤ -2.5%）之後一日的事件率 —')
sh = df[df.mkt_r1 <= -0.025]
print(sh[['date', 'mkt_r1', 'mkt_r5', 'n', 'pos', 'rate']].round(3).to_string(index=False))
print('這些日子的平均事件率 %.2f%% vs 全體 %.2f%%；佔全部事件 %.1f%%' % (sh.rate.mean(), df.rate.mean(), sh.pos.sum() / df.pos.sum() * 100))
