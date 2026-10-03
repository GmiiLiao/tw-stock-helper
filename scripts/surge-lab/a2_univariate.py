"""逐特徵鑑別力（同日內百分位排名 → 去除「哪一天」的效應）。
auc_w ＝ 正例（起漲前一日）在「同一天所有母體股票」中該特徵的平均百分位（0.5＝無鑑別力；>0.5＝事件前該值偏高）。
CI／t 用「依日期重抽」bootstrap（同日樣本不獨立）。"""
import numpy as np, pandas as pd, warnings, json
import build as B
import evallib as E
warnings.filterwarnings('ignore')
d = np.load(f'{B.SP}/{E.DATASET}')
dates = list(d['dates'])
PRIM = (d['m_extra'] == 0) if 'm_extra' in d.files else np.ones(len(d['m_s']), bool)     # 只用主要母體（排除 T2 進行中區段額外列）
s = d['m_s'][PRIM]; y = (d[f'm_{E.LABEL}'] if E.LABEL else d['m_y'])[PRIM].astype(bool); yA = d['m_yA'][PRIM].astype(bool); yB = d['m_yB'][PRIM].astype(bool)
names = sorted(k[2:] for k in d.files if k.startswith('f_'))
year = np.array([dates[i][:4] for i in s])
pos = np.nonzero(y)[0]
cnt_by_day = pd.Series(s[pos]).value_counts()
cluster_days = set(cnt_by_day[cnt_by_day >= 15].index)
is_cluster = np.array([i in cluster_days for i in s[pos]])
print('母體', len(s), '正例', len(pos), '群聚日(≥15檔)', len(cluster_days), '群聚日事件', int(is_cluster.sum()))
rows = []
rng = np.random.default_rng(1)
days_all = np.unique(s[pos]); NDAYS = int(s.max()) + 1
for k in names:
    x = pd.Series(d[f'f_{k}'].astype(np.float64)[PRIM])
    r = x.groupby(s).rank(pct=True, method='average').values       # 同日百分位；NaN 保留
    rp = r[pos]; ok = np.isfinite(rp)
    if ok.sum() < 300: 
        rows.append(dict(feat=k, n=int(ok.sum()))); continue
    def auc(mask): 
        m = ok & mask; return rp[m].mean() if m.sum() >= 50 else np.nan
    allm = np.ones(len(pos), bool)
    res = dict(feat=k, n=int(ok.sum()), cover=float(np.isfinite(x.values).mean()),
               auc=auc(allm), auc_nocluster=auc(~is_cluster), auc_A=auc(yA[pos] & ~yB[pos]), auc_B=auc(yB[pos] & ~yA[pos]),
               **{f'auc_{Y}': auc(year[pos] == Y) for Y in ('2023', '2024', '2025', '2026')})
    # 依日期 bootstrap
    dpos = s[pos][ok]; dfp = pd.DataFrame({'d': dpos, 'r': rp[ok]}).groupby('d').r.agg(['sum', 'count'])
    S, Nn = dfp['sum'].values, dfp['count'].values
    bs = []
    for _ in range(300):
        idx = rng.integers(0, len(S), len(S)); bs.append(S[idx].sum() / Nn[idx].sum())
    res['se_iid'] = float(np.std(bs))
    # 區塊 bootstrap：以「日曆交易日」為軸、每塊 20 個連續日（相鄰日事件不獨立）；t 以此為準
    Sf = np.zeros(NDAYS); Nf = np.zeros(NDAYS); Sf[dfp.index.values] = S; Nf[dfp.index.values] = Nn
    nb = int(np.ceil(NDAYS / 20)); bb = []
    for _ in range(300):
        st = rng.integers(0, NDAYS, nb); idx = ((st[:, None] + np.arange(20)[None, :]).ravel()[:NDAYS]) % NDAYS
        bb.append(Sf[idx].sum() / max(Nf[idx].sum(), 1e-9))
    res['se'] = float(np.std(bb)); res['t'] = (res['auc'] - 0.5) / res['se'] if res['se'] > 0 else np.nan
    # 偏高 / 偏低 前 20% 的事件占比（隨機＝20%）
    res['top20'] = float((rp[ok] >= 0.8).mean()); res['bot20'] = float((rp[ok] <= 0.2).mean())
    yrs = [res[f'auc_{Y}'] for Y in ('2023', '2024', '2025', '2026')]
    sg = np.sign(res['auc'] - 0.5)
    res['yrs_same_sign'] = int(sum(1 for v in yrs if np.isfinite(v) and np.sign(v - 0.5) == sg))
    # 事件與對照的原始值（中位）
    xv = x.values
    res['med_pos'] = float(np.nanmedian(xv[pos])); res['med_all'] = float(np.nanmedian(xv))
    res['p25_pos'] = float(np.nanpercentile(xv[pos], 25)); res['p75_pos'] = float(np.nanpercentile(xv[pos], 75))
    rows.append(res)
R = pd.DataFrame(rows)
R['effect'] = (R.auc - 0.5).abs()
R = R.sort_values('effect', ascending=False)
R.to_csv(f'{B.SP}/univariate{E.TAG}.csv', index=False)
pd.set_option('display.width', 250); pd.set_option('display.max_columns', 30)
show = R[['feat', 'auc', 'se', 't', 'auc_nocluster', 'auc_A', 'auc_B', 'auc_2023', 'auc_2024', 'auc_2025', 'auc_2026', 'yrs_same_sign', 'top20', 'bot20', 'med_pos', 'med_all', 'cover']].copy()
print(show.head(60).round(3).to_string(index=False))
print('\n|t|≥3 且四年同向≥3 的特徵數:', int(((R.t.abs() >= 3) & (R.yrs_same_sign >= 3)).sum()), '/', len(R))
