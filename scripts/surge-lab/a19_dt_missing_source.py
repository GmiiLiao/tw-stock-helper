"""當沖資料缺值到底是什麼？ 市場別（上市／上櫃）、官方處置、其餘。"""
import numpy as np, pandas as pd, json, warnings
import build as B
warnings.filterwarnings('ignore')
pd.set_option('display.width', 200)
dates, codes, P = B.load_panel(); T, N = P['C'].shape
mk = json.load(open(f'{B.SP}/code_market.json'))
market = np.array([mk.get(c, '?') for c in codes])
print('代碼市場對照：', pd.Series(market).value_counts().to_dict())
C, V, DT = P['C'], P['V'], P['DT']
vol20 = pd.DataFrame(V).rolling(20, min_periods=15).mean().values
valid20 = pd.DataFrame(np.isfinite(DT).astype(float)).rolling(20, min_periods=1).sum().values
proxy = valid20 < 15
act = np.isfinite(C) & (C >= 10) & (vol20 >= 300); act[:130] = False
Z = np.load(f'{B.SP}/disposal_mats.npz'); DISP = Z['DISP']
disp20 = pd.DataFrame(DISP.astype(float)).rolling(20, min_periods=1).sum().values
yr = np.array([d[:4] for d in dates])
print('\n— 代理缺值比例：依市場別 × 年 —')
rows = []
for mkt in ('tse', 'otc'):
    for Y in ('2023', '2024', '2025', '2026'):
        m = act & (market[None, :] == mkt) & (yr[:, None] == Y)
        rows.append(dict(市場=mkt, 年=Y, 活躍列=int(m.sum()), 缺值占比=proxy[m].mean() * 100, 官方處置占比=(disp20 >= 1)[m].mean() * 100))
print(pd.DataFrame(rows).round(1).to_string(index=False))
# 缺值列的構成
nan = proxy & act
tot = nan.sum()
comp = {'上櫃(otc)': int((nan & (market[None, :] == 'otc')).sum()), '上市(tse)': int((nan & (market[None, :] == 'tse')).sum())}
print('\n缺值列的市場構成：', {k: f'{v/tot*100:.1f}%' for k, v in comp.items()})
print('上市缺值列中官方近20日有處置：%.1f%%；上櫃：%.1f%%' % ((nan & (market[None, :] == 'tse') & (disp20 >= 1)).sum() / max((nan & (market[None, :] == 'tse')).sum(), 1) * 100, (nan & (market[None, :] == 'otc') & (disp20 >= 1)).sum() / max((nan & (market[None, :] == 'otc')).sum(), 1) * 100))
# 上櫃 DT 資料是否「整檔都缺」？ 看上櫃股逐日 DT 有值比例（時間序）
for mkt in ('tse', 'otc'):
    cols = np.nonzero(market == mkt)[0]
    cov = np.isfinite(DT[:, cols]).sum(1) / np.maximum(np.isfinite(C[:, cols]).sum(1), 1)
    print(f'{mkt} 逐日 DT 有值覆蓋率（對有收盤者）：2023 {cov[yr=="2023"].mean()*100:.0f}% 2024 {cov[yr=="2024"].mean()*100:.0f}% 2025 {cov[yr=="2025"].mean()*100:.0f}% 2026 {cov[yr=="2026"].mean()*100:.0f}%')
