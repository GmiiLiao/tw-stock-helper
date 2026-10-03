"""匯出符合條件的個股歷史資料（連 2 日漲停／5 日連漲≥30%）。
 · surge_events_all.csv   ：全市場所有「起漲日」（含冷門股、新上市；不限母體）— 最小欄位
 · surge_events_model.csv ：進入母體的起漲事件（起漲前一日 s 的特徵＋起漲後表現）— 分析用主檔
 · surge_controls_sample.csv：對照組抽樣（母體非事件列，每日隨機 20 列）— 供自行比較"""
import numpy as np, pandas as pd, json, warnings
import evallib as E
warnings.filterwarnings('ignore')
d = np.load(f'{E.B.SP}/dataset.npz'); dates = list(d['dates']); codes = list(d['codes'])
rev = json.load(open(f'{E.B.SP}/revenue.json')); name = {}
for m in sorted(rev): 
    for r in rev[m]['rows']: name[r['c']] = r['n']
# (1) 全部起漲日
ct, cj = d['cat_t'], d['cat_j']
allc = pd.DataFrame({'起漲日t': [dates[t] for t in ct], '前一日s': [dates[t - 1] for t in ct], '代號': [codes[j] for j in cj], '名稱': [name.get(codes[j], '') for j in cj],
                     '型態': np.where(d['cat_A'] & d['cat_B'], 'A+B', np.where(d['cat_A'] == 1, 'A連2漲停', 'B五日連漲30%')), '進入母體': d['cat_in_universe']})
allc.sort_values(['起漲日t', '代號']).to_csv('out/surge_events_all.csv', index=False, encoding='utf-8-sig')
print('全部起漲日', len(allc))
# (2) 母體事件
D = E.load(); names = D['names']; X = D['X']; s, j, y = D['s'], D['j'], D['y']
O = np.load(f'{E.B.SP}/oof.npz')
sc = O['gbdt_rank']
pos = np.nonzero(y == 1)[0]
rk = pd.Series(sc).groupby(s).rank(pct=True, ascending=True).values       # 同日分數百分位（僅測試期有值）
cols = ['atr14', 'day_range', 'range20', 'bbw', 'dt_ratio20', 'n_lu_20', 'n_lu_60', 'n_lu_250', 'days_since_lu', 'r1', 'r5', 'r20', 'r60', 'r120', 'c_ma20', 'c_ma60', 'c_ma120', 'ma20_slope5', 'bull_align',
        'pos20', 'pos60', 'dist_hi20', 'dist_hi60', 'vr5', 'vr20', 'v_rank120', 'log_tv20', 'macd_dif', 'macd_hist', 'macd_gold3', 'kd_k', 'kd_gold3', 'rsi14', 'fgn_5', 'trust_5', 'ml_chg20', 'ms_to_ml', 'lend_to_v', 'rev_yoy', 'ind_lu_cnt5', 'close_pos', 'upper_shadow', 'body',
        'mkt_lu_cnt5', 'mkt_r1']
ev = pd.DataFrame({'前一日s': [dates[i] for i in s[pos]], '起漲日t': [dates[i + 1] for i in s[pos]], '代號': [codes[k] for k in j[pos]], '名稱': [name.get(codes[k], '') for k in j[pos]],
                   '型態': np.where(D['yA'][pos] & D['yB'][pos], 'A+B', np.where(D['yA'][pos], 'A連2漲停', 'B五日連漲30%'))})
for c in cols: ev[c] = X[pos, names.index(c)]
ev['s收盤(原始)'] = D['close_raw'][pos]; ev['20日均量(張)'] = D['vol20'][pos]
ev['t開盤跳空%'] = D['f_open1'][pos] * 100; ev['t開盤即鎖漲停(買不到)'] = D['locked_open'][pos]
ev['t開→5日收%'] = D['o_c5'][pos] * 100; ev['t開→10日收%'] = D['o_c10'][pos] * 100; ev['t開→20日收%'] = D['o_c20'][pos] * 100; ev['10日內最高漲幅%'] = D['f_maxup10'][pos] * 100
ev['模型同日分數百分位(外樣本,僅2025起)'] = rk[pos] * np.isfinite(sc[pos]) + np.where(np.isfinite(sc[pos]), 0, np.nan)
ev.sort_values(['起漲日t', '代號']).round(4).to_csv('out/surge_events_model.csv', index=False, encoding='utf-8-sig')
print('母體事件', len(ev), '欄位', ev.shape[1])
# (3) 對照組抽樣
rng = np.random.default_rng(0); neg = np.nonzero(y == 0)[0]
sel = []
for day, grp in pd.DataFrame({'s': s[neg], 'i': neg}).groupby('s'):
    sel.extend(rng.choice(grp.i.values, min(5, len(grp)), replace=False))
sel = np.array(sel)
ct_ = pd.DataFrame({'前一日s': [dates[i] for i in s[sel]], '代號': [codes[k] for k in j[sel]], '名稱': [name.get(codes[k], '') for k in j[sel]]})
for c in cols: ct_[c] = X[sel, names.index(c)]
ct_.sort_values(['前一日s', '代號']).round(4).to_csv('out/surge_controls_sample.csv', index=False, encoding='utf-8-sig')
print('對照抽樣', len(ct_))
