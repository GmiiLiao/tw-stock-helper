import numpy as np, pandas as pd, warnings, datetime as dt
import evallib as E
warnings.filterwarnings('ignore')
pd.set_option('display.width', 200)
D = E.load(); s, y = D['s'], D['y'].astype(float); dates = np.array(D['dates']); nd = len(dates)
nday = np.bincount(s, minlength=nd); pday = np.bincount(s, weights=y, minlength=nd)
dd = pd.DataFrame({'date': dates, 'n': nday, 'pos': pday}); dd = dd[dd.n > 0].copy()
dd['yr'] = dd.date.str[:4]; dd['dt'] = pd.to_datetime(dd.date)
# 事件起漲日 t = s 的下一個交易日；用 s 的屬性分組（資訊在 s 已知）
dd['dow_s'] = dd.dt.dt.dayofweek          # 0=週一…4=週五（s 日）
dd['dom'] = pd.cut(dd.dt.dt.day, [0, 5, 10, 15, 20, 25, 31], labels=['1-5', '6-10', '11-15', '16-20', '21-25', '26-31'])
dd['mon'] = dd.dt.dt.month
dd['rate'] = dd.pos / dd.n
yr_rate = dd.groupby('yr').apply(lambda g: g.pos.sum() / g.n.sum())
dd['exp'] = dd.n * dd.yr.map(yr_rate)
def tab(col):
    g = dd.groupby(col, observed=True).agg(days=('n', 'size'), events=('pos', 'sum'), exp=('exp', 'sum'))
    g['ratio'] = g.events / g.exp
    # 依日 bootstrap
    rng = np.random.default_rng(1); out = []
    for k, sub in dd.groupby(col, observed=True):
        o, e = sub.pos.values, sub.exp.values
        bs = [o[i].sum() / e[i].sum() for i in (rng.integers(0, len(o), len(o)) for _ in range(300))]
        out.append((np.percentile(bs, 2.5), np.percentile(bs, 97.5)))
    g['lo'] = [a for a, b in out]; g['hi'] = [b for a, b in out]
    return g.round(2)
print('— 星期（s 日；起漲日為其下一個交易日）—'); print(tab('dow_s').to_string())
print('\n— 月內日（s 日）；1~10 日為月營收公布期 —'); print(tab('dom').to_string())
print('\n— 月份（排除年度漂移）—'); print(tab('mon').to_string())
# 股價位階與規模
names = D['names']; X = D['X']; px = D['close_raw'].astype(float); lp = np.log10(px)
rp = pd.Series(lp).groupby(s).rank(pct=True).values
print('\n— 股價位階：s 日原始收盤價 同日百分位（0.5＝無鑑別）—')
print('正例平均百分位 %.3f（>0.5＝偏高價）；中位價 事件 %.1f vs 全體 %.1f 元' % (rp[y == 1].mean(), np.median(px[y == 1]), np.median(px)))
bins = [10, 15, 20, 30, 50, 100, 200, 10000]
cut = pd.cut(px, bins)
g = pd.DataFrame({'bin': cut, 'y': y, 's': s}).groupby('bin', observed=True).agg(n=('y', 'size'), events=('y', 'sum'))
# MH 校正
rate_row = (pday / np.maximum(nday, 1))[s]
g['exp'] = pd.Series(rate_row).groupby(cut).sum()
g['lift_MH'] = g.events / g.exp
print(g.round(2).to_string())
