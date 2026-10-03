"""前視偏誤（PIT）檢查：把資料截掉最後 CUT 天，重算特徵；截斷前已存在的日期，特徵值必須逐格相等。
若有任何特徵在 s 日的值會因為「s 之後的資料」而改變，就是偷看未來。"""
import numpy as np, warnings
import build as B
warnings.filterwarnings('ignore')
CUT = 60
dates, codes, P = B.load_panel(); T, N = P['C'].shape
def run(Pin, d):
    ev = B.load_factor_events(d, codes); A, Fd, _ = B.adjust(d, codes, Pin, ev); EV = B.build_events(Pin, A, Fd)
    import pandas as pd
    Cdf=pd.DataFrame(A['C']); Vdf=pd.DataFrame(Pin['V'])
    vol20=Vdf.rolling(20,min_periods=15).mean().values
    cnt130=Cdf.notna().astype(float).rolling(B.HIST_WIN,min_periods=1).sum().values
    nan20=Cdf.isna().astype(float).rolling(20,min_periods=1).sum().values
    el=np.isfinite(Pin['C'])&(Pin['C']>=B.MIN_PRICE)&(vol20>=B.MIN_VOL20)&(cnt130>=B.HIST_NEED)&(nan20==0)
    return B.compute_features(d, codes, Pin, A, EV, el)
Ffull = run(P, dates)
Pcut = {k: v[:T-CUT].copy() for k, v in P.items()}
Fcut = run(Pcut, dates[:T-CUT])
bad = []
for k in Ffull:
    a = Ffull[k][:T-CUT]; b = Fcut[k]
    both = np.isfinite(a) & np.isfinite(b)
    mism = (np.isfinite(a) != np.isfinite(b)).sum()
    diff = np.abs(a[both] - b[both]); scale = np.maximum(np.abs(a[both]), 1e-6)
    rel = (diff / scale).max() if diff.size else 0
    if mism > 0 or rel > 1e-3:
        bad.append((k, int(mism), float(rel)))
print(f'特徵 {len(Ffull)} 個；截斷 {CUT} 天重算比對 → 不一致 {len(bad)} 個')
for b in bad: print('  ✗', b)

print('\n— 不一致格數明細 —')
tot = (T-CUT) * N
for k, _, _ in bad:
    a = Ffull[k][:T-CUT]; b = Fcut[k]
    both = np.isfinite(a) & np.isfinite(b)
    neq = both & (np.abs(a-b) > 1e-3*np.maximum(np.abs(a),1e-6))
    # 只看母體（有效格）
    print(f'{k:18s} 不一致 {int(neq.sum()):7d} 格 / 有效 {int(both.sum()):9d}（{neq.sum()/both.sum()*100:.4f}%）')
# 是否與「截斷點之後有除權息」的股票有關
import json
ev = B.load_factor_events(dates, codes)
cutdate = dates[T-CUT]
late = {c for c,d,s,f in ev if d >= cutdate}
ci = {c:i for i,c in enumerate(codes)}
late_j = np.array([ci[c] for c in late if c in ci])
for k, _, _ in bad:
    a = Ffull[k][:T-CUT]; b = Fcut[k]
    both = np.isfinite(a) & np.isfinite(b)
    neq = both & (np.abs(a-b) > 1e-3*np.maximum(np.abs(a),1e-6))
    in_late = np.zeros(N,bool); in_late[late_j]=True
    print(f'{k:18s} 不一致格中屬「截斷後有除權息」股票的比例 {neq[:, in_late].sum()/max(neq.sum(),1)*100:.1f}%')
