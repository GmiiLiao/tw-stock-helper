"""v2 外樣本評估（每個目標一次；以 SURGE_DATASET 選 dataset_t1/t2.npz）。
 · 指標：同日 AUC、每日前 K 名 lift／召回、區塊 bootstrap CI（區塊＝20 個連續交易日）
 · 敏感度：排除群聚日、排除 2025-04 衝擊後 25 日、AI 候選池近似（當沖資料有值）、流動性≥0.5 億、（T2）含進行中區段列
 · 固定持有期報酬（隔日開盤進、第 h 日收盤出；一字鎖漲停略過；基準＝同日同母體等權）——**不含停損停利**（另案訓練）
"""
import numpy as np, pandas as pd, warnings, os
import evallib as E
warnings.filterwarnings('ignore')
pd.set_option('display.width', 220)
D = E.load(); O = np.load(f'{E.B.SP}/oof{E.TAG}.npz'); dates = np.array(D['dates']); s, y, extra = D['s'], D['y'], D['extra']
names = D['names']; X = D['X']; Ix = lambda n: names.index(n)
task = E.TAG.strip('_').upper()
sc = O['gbdt_rank']
fin = np.isfinite(sc)
test = fin & ~extra
print(f'===== {task}：測試列 {int(test.sum()):,}（正例 {int(y[test].sum())}、日數 {len(np.unique(s[test]))}、基準率 {y[test].mean()*100:.3f}%）')


def block_ci(fn, days, L=20, n=1000, seed=7):
    """fn(day_subset_array)->統計量；days 為排序後的測試日；循環區塊 bootstrap。"""
    rng = np.random.default_rng(seed); T = len(days); nb = int(np.ceil(T / L)); out = []
    for _ in range(n):
        st = rng.integers(0, T, nb); idx = ((st[:, None] + np.arange(L)[None, :]).ravel()[:T]) % T
        out.append(fn(idx))
    return np.percentile(out, [2.5, 97.5])


def metrics(score, mask, Ks=(5, 10, 20, 50), ci=False):
    ss, yy = s[mask], y[mask]
    t, base = E.topk_table(score[mask], ss, yy, Ks=Ks)
    r = dict(wdAUC=E.within_day_auc(score[mask], ss, yy), AUC=E.pooled_auc(score[mask], yy), n_pos=int(yy.sum()), base=base * 100)
    for _, x in t.iterrows():
        r[f'lift@{int(x.K)}'] = x.lift; r[f'recall@{int(x.K)}'] = x.recall * 100
    if ci:
        days = np.unique(ss); di = {d: i for i, d in enumerate(days)}; dix = np.array([di[v] for v in ss])
        nd = len(days)
        # 每日：正例同日百分位和／正例數；前10名命中數；列數；正例數
        pr = pd.Series(score[mask]).groupby(ss).rank(pct=True, method='average').values
        S = np.bincount(dix, weights=pr * (yy == 1), minlength=nd); Nn = np.bincount(dix, weights=(yy == 1), minlength=nd)
        rk = E.rank_in_day_desc(score[mask], ss); hit10 = np.bincount(dix, weights=((rk < 10) & (yy == 1)), minlength=nd)
        k10 = np.bincount(dix, weights=(rk < 10), minlength=nd); rows = np.bincount(dix, minlength=nd).astype(float)
        P = np.bincount(dix, weights=(yy == 1), minlength=nd)
        f_auc = lambda idx: S[idx].sum() / max(Nn[idx].sum(), 1e-9)
        f_lift = lambda idx: (hit10[idx].sum() / max(k10[idx].sum(), 1e-9)) / max(P[idx].sum() / rows[idx].sum(), 1e-12)
        r['wdAUC_ci'] = tuple(block_ci(f_auc, days)); r['lift10_ci'] = tuple(block_ci(f_lift, days))
    return r


# ── 1. 外樣本總表 ──
rows = []
for m in ['base_random', 'base_atr', 'base_nlu250', 'base_composite', 'logit_rank', 'gbdt_raw', 'gbdt_rank']:
    r = metrics(O[m], test, ci=(m == 'gbdt_rank')); r['model'] = m; rows.append(r)
R = pd.DataFrame(rows).set_index('model')
print(R[['wdAUC', 'AUC', 'lift@5', 'lift@10', 'lift@20', 'lift@50', 'recall@10', 'recall@50']].round(3).to_string())
g = R.loc['gbdt_rank']; print(f"gbdt_rank 區塊 95% CI：同日 AUC [{g.wdAUC_ci[0]:.3f}, {g.wdAUC_ci[1]:.3f}]；lift@10 [{g['lift10_ci'][0]:.2f}, {g['lift10_ci'][1]:.2f}]")
# ATR 與 GBDT 的差
d_auc = g.wdAUC - R.loc['base_atr'].wdAUC
print(f'GBDT − ATR 單一排名：同日 AUC {d_auc:+.4f}；lift@10 {g["lift@10"] - R.loc["base_atr"]["lift@10"]:+.2f}')

# ── 2. 各季 ──
qtr = np.array([dates[i][:4] + 'Q' + str((int(dates[i][5:7]) - 1) // 3 + 1) for i in s])
tb = []
for q in sorted(set(qtr[test])):
    m = test & (qtr == q); r = metrics(sc, m, Ks=(10,)); tb.append(dict(Q=q, n_pos=r['n_pos'], base=r['base'], wdAUC=r['wdAUC'], lift10=r['lift@10'], atr_wd=E.within_day_auc(O['base_atr'][m], s[m], y[m])))
print('\n各季：'); print(pd.DataFrame(tb).round(3).to_string(index=False))

# ── 3. 敏感度 ──
cnt = pd.Series(s[test & (y == 1)]).value_counts(); thr = 10
cl = set(cnt[cnt >= thr].index)
shock_end = int(np.searchsorted(dates, '2025-04-10')); post_shock = (s > shock_end) & (s <= shock_end + 25)
dt = X[:, Ix('dt_ratio20')]
liq = X[:, Ix('log_tv20')] >= np.log10(5e4)
sens = {
    f'排除群聚日（單日≥{thr}個起漲前日）': test & ~np.isin(s, list(cl)),
    '排除 2025-04 衝擊後 25 個交易日': test & ~post_shock,
    '當沖資料有值（AI 候選池近似，排除疑似處置）': test & np.isfinite(dt),
    '流動性≥0.5 億': test & liq,
    '只看 2025 年': test & (np.array([dates[i][:4] for i in s]) == '2025'),
    '只看 2026 年': test & (np.array([dates[i][:4] for i in s]) == '2026'),
}
if extra.any():
    sens['含「進行中區段」列當負例（貼近實盤）'] = fin
rows = []
for k, m in sens.items():
    r = metrics(sc, m, Ks=(10, 20)); rows.append(dict(條件=k, n_pos=r['n_pos'], base=r['base'], wdAUC=r['wdAUC'], lift10=r['lift@10'], lift20=r['lift@20'], recall10=r['recall@10']))
print('\n敏感度：'); print(pd.DataFrame(rows).round(3).to_string(index=False))
# 與另一目標重疊／單獨
for lab, m_pos in (('與另一目標重疊（yA）', D['yA']), ('僅本目標（yB）', D['yB'])):
    m = test & ((y == 0) | m_pos); r = metrics(sc, m, Ks=(10, 20))
    print(f'{lab}: 正例 {r["n_pos"]} wdAUC {r["wdAUC"]:.3f} lift@10 {r["lift@10"]:.2f} lift@20 {r["lift@20"]:.2f}')

# ── 4. 固定持有期報酬（無停損停利）──
rk_ = {k: D[k] for k in ['o_c5', 'o_c10', 'o_c20', 'locked_open']}; rk_['s'] = s
rows = []
for K in (10,):
    for h, L in (('o_c5', 5), ('o_c10', 10), ('o_c20', 20)):
        uni = E.universe_returns(s, rk_, test, hold=h); pk = E.pick_returns(sc, s, rk_, K, mask=test, hold=h)
        dp = pk.groupby('s').ret.mean(); du = uni.groupby('s').ret.mean(); j = pd.concat([dp, du], axis=1, keys=['p', 'u']).dropna().sort_index(); ex = (j.p - j.u).values
        rng = np.random.default_rng(3); Tn = len(ex); nb = int(np.ceil(Tn / L)); mm = []
        for _ in range(2000):
            st = rng.integers(0, Tn, nb); idx = ((st[:, None] + np.arange(L)[None, :]).ravel()[:Tn]) % Tn; mm.append(ex[idx].mean())
        lo, hi = np.percentile(mm, [2.5, 97.5])
        rows.append(dict(K=K, 持有=h, 選股均=pk.ret.mean() * 100, 母體均=uni.ret.mean() * 100, 超額=ex.mean() * 100, 區塊CI=f'[{lo*100:.2f}, {hi*100:.2f}]', 中位=pk.ret.median() * 100, 勝率=(pk.ret > 0).mean() * 100, 跌10以上=(pk.ret < -0.10).mean() * 100, t=ex.mean() / (np.std(mm) + 1e-12)))
print('\n固定持有期（前 10 名／日；隔日開盤進；未扣成本；無停損停利）：'); print(pd.DataFrame(rows).round(2).to_string(index=False))
idx_ = np.nonzero(test)[0]; r = E.rank_in_day_desc(sc[idx_], s[idx_]); top = idx_[r < 10]; ok = np.isfinite(D['o_c5'][top]) & (D['locked_open'][top] == 0)
hit = (y[top] == 1)[ok]; r5 = D['o_c5'][top][ok].astype(float)
print('前10名命中事件者 5 日平均 %.2f%%（n=%d）；未命中 %.2f%%（中位 %.2f%%）' % (r5[hit].mean() * 100, hit.sum(), r5[~hit].mean() * 100, np.median(r5[~hit]) * 100))
print('前10名中當沖資料缺值者占 %.1f%%（母體 %.1f%%）' % (np.isnan(dt[top]).mean() * 100, np.isnan(dt[test]).mean() * 100))
