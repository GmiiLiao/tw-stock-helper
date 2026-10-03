"""事前選股的實際報酬（未扣費稅，與專案「比對不扣成本」口徑一致；成本 0.4425% 另列參考）。
進場＝隔日開盤（一字鎖漲停開盤＝買不到，略過）；持有 h 日（含進場日，第 h 日收盤出）；基準＝同日同母體同規則的等權平均。"""
import numpy as np, pandas as pd, warnings
import evallib as E
warnings.filterwarnings('ignore')
pd.set_option('display.width', 220)
D = E.load(); O = np.load(f'{E.B.SP}/oof.npz'); dates = np.array(D['dates']); s, y = D['s'], D['y']
test = np.isfinite(O['gbdt_rank'])
ret_keys = {k: D[k] for k in ['o_c1', 'o_c2', 'o_c5', 'o_c10', 'o_c20', 'locked_open']}; ret_keys['s'] = s
COST = 0.4425
def summarize(pk, uni, name, K, h):
    # 以「日」為單位：每日各檔等權平均 → 再對日平均（避免多檔日權重過大）
    d_pick = pk.groupby('s').ret.mean(); d_uni = uni.groupby('s').ret.mean()
    j = pd.concat([d_pick, d_uni], axis=1, keys=['p', 'u']).dropna()
    ex = (j.p - j.u)
    lo, hi = E.boot_ci(pd.DataFrame({'s': j.index, 'ret': ex.values}))
    return dict(model=name, K=K, hold=h, n=len(pk), days=len(j), picks_mean=pk.ret.mean() * 100, picks_median=pk.ret.median() * 100,
                win=(pk.ret > 0).mean() * 100, uni_mean=uni.ret.mean() * 100, excess_day_mean=ex.mean() * 100, ex_lo=lo * 100, ex_hi=hi * 100,
                big_loss=(pk.ret < -0.10).mean() * 100, p5=np.percentile(pk.ret, 5) * 100, fill=pk.fill.iloc[0] * 100 if len(pk) else np.nan)
rows = []
for name in ['base_random', 'base_atr', 'logit_rank', 'gbdt_raw', 'gbdt_rank']:
    for h in ['o_c5']:
        uni = E.universe_returns(s, ret_keys, test, hold=h)
        for K in (5, 10, 20):
            pk = E.pick_returns(O[name], s, ret_keys, K, mask=test, hold=h)
            rows.append(summarize(pk, uni, name, K, h))
R = pd.DataFrame(rows)
print('=== 持有 5 日（隔日開盤進、第 5 日收盤出；未扣成本）===')
print(R.round(2).to_string(index=False))
print('\n=== gbdt_rank 不同持有期（K=10）===')
rows = []
for h in ['o_c1', 'o_c2', 'o_c5', 'o_c10', 'o_c20']:
    uni = E.universe_returns(s, ret_keys, test, hold=h); pk = E.pick_returns(O['gbdt_rank'], s, ret_keys, 10, mask=test, hold=h)
    rows.append(summarize(pk, uni, 'gbdt_rank', 10, h))
print(pd.DataFrame(rows).round(2).to_string(index=False))
# 命中事件 vs 未命中的報酬拆解
pk_idx = np.nonzero(test)[0]
rk = E.rank_in_day_desc(O['gbdt_rank'][pk_idx], s[pk_idx]); sel = pk_idx[rk < 10]
r5 = D['o_c5'][sel].astype(float); ok = np.isfinite(r5) & (D['locked_open'][sel] == 0)
hit = y[sel][ok] == 1
print('\nTop10 picks：命中事件 n=%d 平均 %.2f%%；未命中 n=%d 平均 %.2f%% 中位 %.2f%%' % (hit.sum(), r5[ok][hit].mean() * 100, (~hit).sum(), r5[ok][~hit].mean() * 100, np.median(r5[ok][~hit]) * 100))
print('未命中但漲幅 ≥+10%% 的比例 %.1f%%（近似「慢半拍的起漲」）；跌幅 ≤-10%% 的比例 %.1f%%' % ((r5[ok][~hit] >= .10).mean() * 100, (r5[ok][~hit] <= -.10).mean() * 100))
# 各季（gbdt top10 超額）
qtr = np.array([dates[i][:4] + 'Q' + str((int(dates[i][5:7]) - 1) // 3 + 1) for i in s])
rows = []
for q in sorted(set(qtr[test])):
    m = test & (qtr == q)
    uni = E.universe_returns(s, ret_keys, m, hold='o_c5'); pk = E.pick_returns(O['gbdt_rank'], s, ret_keys, 10, mask=m, hold='o_c5')
    r = summarize(pk, uni, 'gbdt_rank', 10, 'o_c5'); r['Q'] = q; rows.append(r)
print('\n=== gbdt_rank Top10 各季（5 日）===')
print(pd.DataFrame(rows)[['Q', 'days', 'picks_mean', 'picks_median', 'win', 'uni_mean', 'excess_day_mean', 'ex_lo', 'ex_hi', 'big_loss']].round(2).to_string(index=False))
print('\n參考：成本 %.4f%%（專案口徑）→ 若 5 日超額 < 此值則淨負' % COST)
