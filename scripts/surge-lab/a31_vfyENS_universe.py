"""Verification step 5: how many 'limit-up on s' rows did the dataset drop because s+1 had no close or a structural break
(information not known at the decision time)? Read-only."""
import numpy as np, pandas as pd
import build as B
dates, codes, P = B.load_panel(); T, N = P['C'].shape
A, F_day, _ = B.adjust(dates, codes, P, B.load_factor_events(dates, codes))
EV = B.build_events(P, A, F_day); LU = EV['LU']; brk = EV['brk']; C = P['C']
cnt130 = pd.DataFrame(A['C']).notna().astype(float).rolling(B.HIST_WIN, min_periods=1).sum().values
d = np.array(dates)
base = np.isfinite(C) & (cnt130 >= B.HIST_NEED) & LU
base[T - 1] = False
nx_nan = np.vstack([~np.isfinite(C[1:]), np.zeros((1, N), bool)]); nx_brk = np.vstack([brk[1:], np.zeros((1, N), bool)])
for lab, lo, hi in (('DESIGN', '2023-01-11', '2025-06-30'), ('VALID', '2025-07-01', '2025-12-31'), ('TEST', '2026-01-01', '2026-10-01')):
    rows = (d >= lo) & (d <= hi)
    b = base & rows[:, None]
    print(f'{lab}: LU-on-s cells {int(b.sum()):,}; dropped for s+1 no close {int((b & nx_nan).sum())}, s+1 break {int((b & nx_brk & ~nx_nan).sum())}')
