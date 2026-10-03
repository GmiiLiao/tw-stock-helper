import numpy as np, pandas as pd, warnings
import build as B
warnings.filterwarnings('ignore')
d = np.load(f'{B.SP}/dataset.npz')
dates = list(d['dates']); codes = list(d['codes'])
ct, cj, cA, cB, cin = d['cat_t'], d['cat_j'], d['cat_A'], d['cat_B'], d['cat_in_universe']
cdf = pd.DataFrame({'t': ct, 'code': [codes[j] for j in cj], 'date': [dates[t] for t in ct], 'A': cA, 'B': cB, 'inU': cin})
cdf['ym'] = cdf.date.str[:7]; cdf['year'] = cdf.date.str[:4]
cdf['type'] = np.where(cdf.A & cdf.B, 'A+B', np.where(cdf.A, 'A only', 'B only'))
print('=== 全部起漲日（不限母體）===', len(cdf))
print(cdf.groupby(['year', 'type']).size().unstack(fill_value=0).assign(total=lambda x: x.sum(1)))
print('\n=== 月度（全部/母體內）===')
m = cdf.groupby('ym').agg(all=('t', 'size'), inU=('inU', 'sum'))
m['LUperday'] = [None]*len(m)
print(m.tail(26).to_string())
# 母體內事件的規模與前瞻
s = d['m_s']; y = d['m_y']; pos = y == 1
M = {k: d[f'm_{k}'] for k in ['yA','yB','f_maxup10','o_c1','o_c2','o_c5','o_c10','o_c20','f_open1','locked_open','f_mindn5_vs_open','vol20','close_raw']}
pdf = pd.DataFrame({k: v[pos] for k, v in M.items()}); pdf['s'] = s[pos]; pdf['date_s'] = [dates[i] for i in pdf.s]
pdf['type'] = np.where(pdf.yA.astype(bool) & pdf.yB.astype(bool), 'A+B', np.where(pdf.yA.astype(bool), 'A only', 'B only'))
print('\n=== 母體內事件（n=%d）起漲後表現（以 t 開盤進場；還原價、未扣費稅）===' % len(pdf))
g = pdf.groupby('type')
out = pd.DataFrame({
    'n': g.size(),
    '跳空開盤(t開/ s收)均%': g.f_open1.mean() * 100,
    '一字鎖漲停開盤(買不到)%': g.locked_open.mean() * 100,
    '10日最高漲幅 中位%': g.f_maxup10.median() * 100,
    't開→1日收 均%': g.o_c1.mean() * 100,
    't開→5日收 均%': g.o_c5.mean() * 100,
    't開→5日收 中位%': g.o_c5.median() * 100,
    't開→10日收 均%': g.o_c10.mean() * 100,
    't開→20日收 均%': g.o_c20.mean() * 100,
    '5日內最深回檔(對t開)中位%': g.f_mindn5_vs_open.median() * 100,
})
print(out.round(2).T.to_string())
allp = pdf
print('\n全體 t開→5日收：均 %.2f%% 中位 %.2f%% 勝率 %.1f%%；排除一字鎖漲停開盤後（買得到）：均 %.2f%% 中位 %.2f%% 勝率 %.1f%% n=%d' % (
    allp.o_c5.mean()*100, allp.o_c5.median()*100, (allp.o_c5>0).mean()*100,
    allp[allp.locked_open==0].o_c5.mean()*100, allp[allp.locked_open==0].o_c5.median()*100, (allp[allp.locked_open==0].o_c5>0).mean()*100, (allp.locked_open==0).sum()))
# 事件群聚：同一起漲日的母體內事件數
cl = pdf.groupby('date_s').size().sort_values(ascending=False)
print('\n=== 起漲前一日(s)事件數最多的日子 ===')
print(cl.head(12).to_string())
print('單日 ≥10 檔的日子數', (cl >= 10).sum(), '涵蓋事件', int(cl[cl >= 10].sum()), '/', len(pdf))
# 同一檔重複
rep = pd.Series([codes[j] for j in d['m_j'][pos]]).value_counts()
print('\n事件最多的個股（母體內）'); print(rep.head(10).to_string()); print('事件涉及個股', rep.size, '平均每檔', round(len(pdf)/rep.size, 2))
pdf.to_pickle(f'{B.SP}/pos_events.pkl')
