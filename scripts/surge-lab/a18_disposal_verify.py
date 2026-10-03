"""用官方處置名單驗證「當沖資料缺值＝處置／禁當沖」代理，並量化起漲事件與處置狀態的關係。"""
import numpy as np, pandas as pd, warnings, os
import build as B, disposal as DP
warnings.filterwarnings('ignore')
pd.set_option('display.width', 220)
dates, codes, P = B.load_panel(); T, N = P['C'].shape
d_arr = np.array(dates)
iv = DP.load_intervals(); M = DP.build_matrices(dates, codes, iv)
DISP, KNOWN, PUB = M['DISP'], M['KNOWN'], M['PUB']
print(f'官方處置區間 {len(iv)} 筆（去重後）；對得上面板 4 碼個股的有效區間 {len(M["intervals"])} 筆；個股-日處置格 {int(DISP.sum()):,}；涉及 {int(DISP.any(0).sum())} 檔')
# 區間長度（交易日）
L = pd.DataFrame(M['intervals'])
L['era'] = np.where(L.start >= DP.NEW_REGIME, '新制(≥2026-08-10)', '舊制')
print('\n— 處置區間長度（交易日）分布 —')
for era, g in L.groupby('era'):
    vc = g.len.value_counts().sort_index()
    print(era, f'n={len(g)}', {int(k): int(v) for k, v in vc.items() if v >= 3})
# 當沖資料缺值代理（同 build.py：近 20 日有值 <15）
C, V, DT = P['C'], P['V'], P['DT']
vol20 = pd.DataFrame(V).rolling(20, min_periods=15).mean().values
valid20 = pd.DataFrame(np.isfinite(DT).astype(float)).rolling(20, min_periods=1).sum().values
proxy = valid20 < 15
act = np.isfinite(C) & (C >= 10) & (vol20 >= 300)
act[:130] = False
disp20 = pd.DataFrame(DISP.astype(float)).rolling(20, min_periods=1).sum().values
disp40 = pd.DataFrame(DISP.astype(float)).rolling(40, min_periods=1).sum().values
print(f'\n活躍列（價≥10、20日均量≥300張）{int(act.sum()):,}；其中代理（當沖缺值）{int((proxy & act).sum()):,}（{(proxy & act).sum()/act.sum()*100:.1f}%）；官方近 20 日有處置 {int(((disp20 >= 1) & act).sum()):,}（{((disp20>=1)&act).sum()/act.sum()*100:.1f}%）')
a = act
tp = (proxy & (disp20 >= 1) & a).sum(); fp = (proxy & (disp20 == 0) & a).sum(); fn = (~proxy & (disp20 >= 1) & a).sum(); tn = (~proxy & (disp20 == 0) & a).sum()
print('\n— 代理 vs 官方（近 20 日有處置日）混淆矩陣（活躍列）—')
print(f'              官方有處置  官方無處置')
print(f'代理(缺值)   {tp:10,d}  {fp:10,d}')
print(f'代理(有值)   {fn:10,d}  {tn:10,d}')
print(f'→ 代理的精確度 P(官方處置|缺值) = {tp/(tp+fp)*100:.1f}%；召回 P(缺值|官方處置) = {tp/(tp+fn)*100:.1f}%')
for k in (1, 6, 10):
    m = (disp20 >= k) & a; print(f'   官方近20日處置日數≥{k}：{int(m.sum()):,} 列，其中代理缺值 {int((proxy & m).sum()):,}（召回 {(proxy&m).sum()/m.sum()*100:.1f}%）')
cur = DISP & a
print(f'   官方「當日在處置期」：{int(cur.sum()):,} 列，代理缺值 {int((proxy & cur).sum()):,}（{(proxy&cur).sum()/cur.sum()*100:.1f}%）；其中第 1～5 個處置日的缺值率（代理需累積缺值日，延遲反應）：')
# 處置第 k 日的代理缺值率
Kd = np.zeros((T, N), int)
for iv_ in M['intervals']:
    j = codes.index(iv_['code']) if False else None
ci = {c: i for i, c in enumerate(codes)}
rows = []
for iv_ in M['intervals']:
    j = ci[iv_['code']]
    for k, t in enumerate(range(iv_['ts'], iv_['te'] + 1), start=1):
        if act[t, j]: rows.append((k, bool(proxy[t, j])))
rk = pd.DataFrame(rows, columns=['k', 'proxy']); g = rk.groupby(np.minimum(rk.k, 12)).proxy.agg(['mean', 'size'])
print('   處置第 k 日（≥12 併為 12）缺值率：', {int(i): f'{r["mean"]*100:.0f}%' for i, r in g.iterrows()})
# 處置結束後 k 日的缺值率（20 日窗殘留）
rows = []
for iv_ in M['intervals']:
    j = ci[iv_['code']]
    for k in range(1, 26):
        t = iv_['te'] + k
        if t < T and act[t, j] and not DISP[t, j]: rows.append((k, bool(proxy[t, j])))
re = pd.DataFrame(rows, columns=['k', 'proxy']).groupby('k').proxy.mean()
print('   處置結束後第 k 日缺值率：', {int(k): f'{v*100:.0f}%' for k, v in re.items() if k in (1, 3, 5, 8, 10, 12, 15, 20, 25)})
# 代理缺值但官方 40 日內都沒處置：是什麼？
un = proxy & a & (disp40 == 0)
print(f'\n代理缺值但官方近 40 日皆無處置：{int(un.sum()):,} 列（占缺值列 {un.sum()/(proxy&a).sum()*100:.1f}%）')
# 這些列的連續缺值長度
runs = []
for j in np.nonzero(un.any(0))[0]:
    m = (proxy[:, j] & a[:, j]); idx = np.nonzero(m)[0]
    if len(idx) == 0: continue
    br = np.nonzero(np.diff(idx) != 1)[0]; st = np.r_[idx[0], idx[br + 1]]; en = np.r_[idx[br], idx[-1]]
    runs += list(en - st + 1)
runs = np.array(runs); print(f'   其所在連續缺值區段長度：中位 {np.median(runs):.0f}、>=60 日占 {(runs>=60).mean()*100:.0f}%（長期不可當沖標的）')
byy = pd.DataFrame({'yr': np.repeat([d[:4] for d in dates], N).reshape(T, N)[a], 'proxy': proxy[a], 'disp20': (disp20 >= 1)[a]})
print('\n各年：代理缺值占比／官方近20日處置占比／代理精確度')
print(byy.groupby('yr').apply(lambda g: pd.Series({'代理缺值%': g.proxy.mean() * 100, '官方處置%': g.disp20.mean() * 100, '精確度%': (g.proxy & g.disp20).sum() / max(g.proxy.sum(), 1) * 100})).round(1).to_string())
np.savez_compressed(f'{DP.SP}/disposal_mats.npz', DISP=DISP, KNOWN=KNOWN, PUB=PUB, START=M['START'])
pd.DataFrame(M['intervals']).to_csv(f'{DP.SP}/disposal_intervals.csv', index=False)
