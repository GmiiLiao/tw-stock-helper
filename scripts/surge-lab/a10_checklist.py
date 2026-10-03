"""可手算的檢核表：條件與配點只用 2023–2024 訓練期決定（每群挑 lift 最高、CI 下界>1、涵蓋≥3% 的一條），
再拿 2025–2026 驗證。對照 GBDT。"""
import numpy as np, pandas as pd, warnings
import evallib as E, conds
warnings.filterwarnings('ignore')
pd.set_option('display.width', 220)
D = E.load(primary_only=True); s, y = D['s'], D['y'].astype(np.int64); dates = np.array(D['dates'])
yr = np.array([dates[i][:4] for i in s]); nday = np.bincount(s); pday = np.bincount(s, weights=y); rate_row = (pday / np.maximum(nday, 1))[s]
C = conds.build(D)
trn = np.isin(yr, ['2023', '2024']); tst = np.isin(yr, ['2025', '2026'])
rng = np.random.default_rng(4)
rows = []
for (g, lab), m in C.items():
    mm = m & trn
    if mm.sum() < 0.03 * trn.sum(): continue
    obs_d = np.bincount(s, weights=y * mm, minlength=len(nday)); exp_d = np.bincount(s, weights=mm * rate_row, minlength=len(nday))
    days = np.unique(s[trn]); lift = obs_d.sum() / exp_d.sum()
    bs = [obs_d[i].sum() / exp_d[i].sum() for i in (rng.choice(days, len(days)) for _ in range(200))]
    rows.append(dict(group=g, cond=lab, lift_train=lift, lo=np.percentile(bs, 2.5), n=int(mm.sum())))
T = pd.DataFrame(rows)
T = T[(T.lo > 1.0)].sort_values('lift_train', ascending=False)
sel = T.groupby('group').head(1)
sel = sel[sel.group != '組合'].sort_values('lift_train', ascending=False)
print('2023–2024 訓練期挑出的條件（每群 lift 最高者）：'); print(sel.round(2).to_string(index=False))
score = np.zeros(len(s))
for _, r in sel.iterrows(): score += C[(r.group, r.cond)].astype(float)
tab = []
base = y[tst].mean()
for k in sorted(set(score[tst].astype(int))):
    mm = tst & (score == k)
    tab.append(dict(points=k, rows=int(mm.sum()), events=int(y[mm].sum()), rate_pct=y[mm].mean() * 100, lift=y[mm].mean() / base))
print('\n2025–2026 驗證：條件命中數 → 隔日起漲率'); print(pd.DataFrame(tab).round(3).to_string(index=False))
sc = score + np.random.default_rng(0).random(len(s)) * 1e-3
tt, bb = E.topk_table(sc[tst], s[tst], y[tst], Ks=(5, 10, 20, 50))
print('\n檢核表 每日前K名（2025–2026，同分隨機）：'); print(tt.round(3).to_string(index=False))
print('wdAUC %.3f（GBDT 同期約 0.79；ATR 單一排名 0.77）' % E.within_day_auc(sc[tst], s[tst], y[tst]))
pd.DataFrame(sel).to_csv(f'{E.B.SP}/checklist{E.TAG}.csv', index=False)
