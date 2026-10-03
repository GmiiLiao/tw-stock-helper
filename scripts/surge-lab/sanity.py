import numpy as np, pandas as pd, os, random
import build as B
dates, codes, P = B.load_panel(); T, N = P['C'].shape
events = B.load_factor_events(dates, codes); A, F_day, _ = B.adjust(dates, codes, P, events); EV = B.build_events(P, A, F_day)
Ca = A['C']; V = P['V']
start = EV['start']; st, sj = np.nonzero(start)
# 漏斗：起漲日 t 的前一日 s 為何不在母體
Cdf = pd.DataFrame(Ca); Vdf = pd.DataFrame(V)
vol20 = Vdf.rolling(20, min_periods=15).mean().values
cnt130 = Cdf.notna().astype(float).rolling(B.HIST_WIN, min_periods=1).sum().values
nan20 = Cdf.isna().astype(float).rolling(20, min_periods=1).sum().values
brk_past = pd.DataFrame(EV['brk'].astype(float)).rolling(B.HIST_NEED, min_periods=1).max().values > 0
brk_fut = np.zeros_like(brk_past)
for k in range(1,6): brk_fut[:-k] |= EV['brk'][k:]
reasons = {'total':0,'t<1':0,'price<10':0,'vol20<300':0,'history<125':0,'nan in 20d':0,'s is LU':0,'break past':0,'break future':0,'recent mark (cooldown)':0,'s>T-6':0,'IN':0}
for t,j in zip(st,sj):
    reasons['total']+=1
    s=t-1
    if s<0: reasons['t<1']+=1; continue
    if not (P['C'][s,j]>=B.MIN_PRICE): reasons['price<10']+=1; continue
    if not (vol20[s,j]>=B.MIN_VOL20): reasons['vol20<300']+=1; continue
    if not (cnt130[s,j]>=B.HIST_NEED): reasons['history<125']+=1; continue
    if nan20[s,j]>0: reasons['nan in 20d']+=1; continue
    if EV['LU'][s,j]: reasons['s is LU']+=1; continue
    if brk_past[s,j]: reasons['break past']+=1; continue
    if brk_fut[s,j]: reasons['break future']+=1; continue
    if EV['recent'][s,j]: reasons['recent mark (cooldown)']+=1; continue
    if s>=T-5: reasons['s>T-6']+=1; continue
    reasons['IN']+=1
print('漏斗（依序淘汰）:'); [print(f'  {k:28s}{v:6d}') for k,v in reasons.items()]
# 起漲日 by year (全部 / 母體內)
d=np.load(f'{B.SP}/dataset.npz')
s=d['m_s']; y=d['m_y']; yr=np.array([dates[i][:4] for i in s])
print('\n年度  母體列數  正例  基準率%')
for Y in sorted(set(yr)):
    m=yr==Y; print(Y, m.sum(), y[m].sum(), round(y[m].mean()*100,3))
# 抽查：A 與 B 各 4 檔
random.seed(7)
def show(t,j):
    c=codes[j]; lo=max(0,t-4); hi=min(T,t+7)
    print(f'--- {c} 起漲日 t={dates[t]}  s={dates[t-1]}')
    for i in range(lo,hi):
        r=Ca[i,j]/Ca[i-1,j]-1 if i>0 else 0
        tag=('LU ' if EV['LU'][i,j] else '   ')+('^' if i==t else ' ')
        print(f'   {dates[i]} {tag} raw_close={P["C"][i,j]:8.2f} adjC={Ca[i,j]:8.2f} ret={r*100:6.2f}% vol={V[i,j]:8.0f}')
pa=[(t,j) for t,j in zip(st,sj) if EV['A_start'][t,j] and not EV['B_start'][t,j] and t>400]
pb=[(t,j) for t,j in zip(st,sj) if EV['B_start'][t,j] and not EV['A_start'][t,j] and t>400]
for t,j in random.sample(pa,3): show(t,j)
for t,j in random.sample(pb,3): show(t,j)
