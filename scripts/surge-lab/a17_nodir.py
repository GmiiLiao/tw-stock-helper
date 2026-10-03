"""拿掉『s 日方向類』特徵後的外樣本表現。T2（5 日連漲）的區段起點定義使「前一天不是上漲日」有一部分是定義造成的，
這裡把 s 日當天的方向／K 線／短線動能特徵全部移除，只留股性、趨勢、波動、量能水準、籌碼、營收、產業、大盤。"""
import numpy as np, warnings
import evallib as E
from models import HistGBDT
from run_cv import run, GB
warnings.filterwarnings('ignore')
DIR = ['r1', 'r3', 'r5', 'body', 'close_pos', 'upper_shadow', 'lower_shadow', 'gap', 'up_days5', 'up_streak', 'macd_hist_d1', 'macd_hist_d3', 'macd_hist', 'macd_hist_pos', 'macd_gold3', 'kd_gold3',
       'kd_kd', 'rk_r5', 'pv_up_surge', 'c_ma5', 'brk20', 'brk60', 'vr5', 'trust_1', 'fgn_1', 'inst_pct_v1', 'rsi5']
D = E.load(); R = E.rank_features(D); names = D['names']; s, y, ex = D['s'], D['y'], D['extra']
cols = [i for i, n in enumerate(names) if n not in DIR]
print(f'{E.TAG}: 移除 {len(names) - len(cols)} 個當日方向類特徵，保留 {len(cols)} 個')
oof = run(D, R, lambda: HistGBDT(**GB), 'nodir', cols=cols)
m = np.isfinite(oof) & ~ex
t, base = E.topk_table(oof[m], s[m], y[m], Ks=(5, 10, 20, 50))
O = np.load(f'{E.B.SP}/oof{E.TAG}.npz'); sc = O['gbdt_rank']
print('完整特徵 GBDT：同日 AUC %.3f lift@10 %.2f' % (E.within_day_auc(sc[m], s[m], y[m]), E.topk_table(sc[m], s[m], y[m], Ks=(10,))[0].lift[0]))
print('移除方向類   ：同日 AUC %.3f（正例 %d）' % (E.within_day_auc(oof[m], s[m], y[m]), y[m].sum())); print(t.round(3).to_string(index=False))
