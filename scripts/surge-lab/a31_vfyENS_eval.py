"""Verification step 3: rebuild ENS_cont from independent members, pick theta on VALID, report TEST; adversarial checks.
usage: python3 a31_vfyENS_eval.py [author|mine]   (source of the GBDT_ALL_y member; 'mine' = a31_vfyENS_gbdtall_s11.npz)
"""
import sys
import numpy as np

SP = '/Users/gmii/Documents/股票助手app/tw-stock-app/scripts/surge-lab/.surge-cache'
SRC = sys.argv[1] if len(sys.argv) > 1 else 'author'
z = np.load(f'{SP}/dataset_lu1.npz')
dates = z['dates']; s = z['m_s']; j = z['m_j']; ds = dates[s]
y = z['m_y'].astype(int); lu = z['m_lu_s'].astype(bool); buy = z['m_buy_lu'].astype(int); locked = z['m_locked1'].astype(int)
oc1 = z['m_oc1']; cc1 = z['m_cc1']; ow = z['x_oneword_s'] == 1; streak = z['x_lu_streak']
split = np.where(ds <= '2025-06-30', 0, np.where(ds <= '2025-12-31', 1, 2))
NDAYS = {sp: len(np.unique(s[split == sp])) for sp in (0, 1, 2)}
M = np.load(f'{SP}/a31_vfyENS_members.npz')
gall = np.load(f'{SP}/a31_simB_gbdt_ALL_y.npz')['score_des'] if SRC == 'author' else np.load(f'{SP}/a31_vfyENS_gbdtall_s11.npz')['score']


def wilson(k, n, zz=1.96):
    if n == 0: return float('nan')
    p = k / n
    return (p + zz * zz / (2 * n) - zz * np.sqrt(p * (1 - p) / n + zz * zz / (4 * n * n))) / (1 + zz * zz / n)


def ens_of(members):
    v = (split == 1) & lu
    P = []
    for sc in members:
        ref = np.sort(sc[v & np.isfinite(sc)])
        pc = np.searchsorted(ref, sc, side='right') / len(ref)
        P.append(np.where(lu & np.isfinite(sc), pc, np.nan))
    with np.errstate(all='ignore'):
        e = np.nanmean(np.stack(P, 1), 1)
    return np.where(lu & np.isfinite(e), e, -np.inf)


def theta_valid(score, tgt, min_n=30):
    vi = np.nonzero((split == 1) & np.isfinite(score))[0]
    o = vi[np.argsort(-score[vi], kind='mergesort')]
    n = np.arange(1, len(o) + 1); p = np.cumsum(y[o]) / n
    ok = np.nonzero((p >= tgt) & (n >= min_n))[0]
    return None if len(ok) == 0 else float(score[o][ok.max()])


def rep(m, label):
    out = []
    for sp, nm in ((0, 'DES'), (1, 'VAL'), (2, 'TEST')):
        mm = m & (split == sp); n = int(mm.sum())
        if n == 0: out.append(f'{nm} n=0'); continue
        k = int(y[mm].sum())
        out.append(f'{nm} n={n} p={k / n:.3f}' + (f' wlb={wilson(k, n):.3f} buy={buy[mm].mean():.3f} days={len(np.unique(s[mm]))} ppd={n / NDAYS[2]:.2f} lockedOpen={locked[mm].mean():.2f}' if sp == 2 else ''))
    print(f'{label:<46} ' + ' | '.join(out))


base = [M['GBDT_CONT_s3'], gall, M['kNN_U_k400'], M['kNN_A_k100'], M['NB']]
ens = ens_of(base)
th = theta_valid(ens, 0.6)
print(f'== GBDT_ALL source: {SRC};  theta(VALID>=60%,n>=30) = {th}')
sel = ens >= th
rep(sel, 'ENS_cont (independent members) >= theta')
for t in (0.5, 0.7):
    tt = theta_valid(ens, t); print(f'  target {t}: theta={tt}') if tt is None else rep(ens >= tt, f'  target {t} theta={tt:.4f}')

print('\n-- robustness: GBDT_CONT seed / member drop-out (theta re-picked on VALID each time)')
for nm, mem in (('seed17', [M['GBDT_CONT_s17'], gall, M['kNN_U_k400'], M['kNN_A_k100'], M['NB']]),
                ('seed29', [M['GBDT_CONT_s29'], gall, M['kNN_U_k400'], M['kNN_A_k100'], M['NB']]),
                ('drop GBDT_ALL', [M['GBDT_CONT_s3'], M['kNN_U_k400'], M['kNN_A_k100'], M['NB']]),
                ('drop kNNs', [M['GBDT_CONT_s3'], gall, M['NB']]),
                ('drop NB', [M['GBDT_CONT_s3'], gall, M['kNN_U_k400'], M['kNN_A_k100']]),
                ('GBDT_ALL only', [gall]), ('GBDT_CONT only', [M['GBDT_CONT_s3']]), ('NB only', [M['NB']]), ('kNN_U only', [M['kNN_U_k400']])):
    e = ens_of(mem); t = theta_valid(e, 0.6)
    if t is None: print(f'  {nm:<16} VALID>=60% unreachable'); continue
    rep(e >= t, f'  {nm:<16} theta={t:.4f}')

print('\n-- threshold sensitivity around theta (fixed members)')
for t in (0.96, 0.97, 0.975, 0.98, th, 0.985, 0.99):
    rep(ens >= t, f'  ens>={t:.4f}')

print('\n-- composition of TEST picks')
mt = sel & (split == 2); n = mt.sum()
print(f'  picks {n}; s-day one-word locked LU {ow[mt].mean():.3f}; streak>=2 {(streak[mt] >= 2).mean():.3f}; median streak {np.median(streak[mt])}; '
      f'distinct stocks {len(np.unique(j[mt]))}; s+1 opened locked {locked[mt].mean():.3f}')
for L in (1, 0):
    mm = mt & (locked == L)
    print(f'  locked_at_open={L}: n={mm.sum()} limit-up={y[mm].mean() if mm.any() else float("nan"):.3f} mean open->close={np.nanmean(oc1[mm]) if mm.any() else float("nan"):+.4f}')
nl = mt & (locked == 0)
print(f'  BUYABLE trade (buy at s+1 open, sell at close) on non-locked picks: n={nl.sum()} mean oc1={np.nanmean(oc1[nl]):+.4f} '
      f'median={np.nanmedian(oc1[nl]):+.4f} win={np.mean(oc1[nl] > 0):.3f}')
print('  streak distribution of TEST picks:', {int(k): int(v) for k, v in zip(*np.unique(streak[mt], return_counts=True))})

print('\n-- base rates in continuation group (P(y=1 | lu_s))  and trivial no-model rules (theta on VALID)')
for sp in (0, 1, 2):
    m = lu & (split == sp)
    print(f'  split {sp}: cont rows/day {m.sum() / NDAYS[sp]:.1f}  P(y)={y[m].mean():.3f}  P(y|oneword_s)={y[m & ow].mean():.3f}  '
          f'P(locked1)={locked[m].mean():.3f}  P(y|locked1)={y[m & (locked == 1)].mean():.3f}  P(buy_lu)={buy[m].mean():.3f}')
for stk in (2, 3, 4):
    rep(lu & ow & (streak >= stk), f'  RULE oneword & streak>={stk}')
lt = np.log1p(np.nan_to_num(z['f_log_tv20'], nan=99))
for nm, sc in (('-f_log_tv20 (low turnover) in oneword', np.where(lu & ow, -z['f_log_tv20'], -np.inf)),
               ('-x_vol20 in oneword', np.where(lu & ow, -z['x_vol20'], -np.inf)),
               ('streak + oneword', np.where(lu, streak + 10 * ow, -np.inf))):
    sc = np.where(np.isfinite(sc), sc, -np.inf); t = theta_valid(sc, 0.6)
    if t is None: print(f'  {nm}: VALID>=60% unreachable'); continue
    rep(sc >= t, f'  {nm} theta={t:.3g}')

print('\n-- TEST precision by month and day-clustered bootstrap')
mon = np.array([d[:7] for d in ds])
for mo in sorted(set(mon[mt])):
    mm = mt & (mon == mo); print(f'  {mo}: n={mm.sum():>3} prec={y[mm].mean():.3f} buy={buy[mm].mean():.3f}')
days = np.unique(s[mt]); rng = np.random.default_rng(0)
per = {d: (y[mt & (s == d)].sum(), (mt & (s == d)).sum()) for d in days}
kk = np.array([per[d][0] for d in days]); nn = np.array([per[d][1] for d in days])
bs = []
for _ in range(5000):
    b = rng.integers(0, len(days), len(days)); bs.append(kk[b].sum() / nn[b].sum())
print(f'  day-cluster bootstrap 95% CI: [{np.quantile(bs, 0.025):.3f}, {np.quantile(bs, 0.975):.3f}]  (Wilson iid LB {wilson(kk.sum(), nn.sum()):.3f})')
stk = np.unique(j[mt]); ks = np.array([y[mt & (j == q)].sum() for q in stk]); ns = np.array([(mt & (j == q)).sum() for q in stk])
bs2 = []
for _ in range(5000):
    b = rng.integers(0, len(stk), len(stk)); bs2.append(ks[b].sum() / ns[b].sum())
print(f'  stock-cluster bootstrap 95% CI: [{np.quantile(bs2, 0.025):.3f}, {np.quantile(bs2, 0.975):.3f}]; picks that repeat the same stock on the next trading day: '
      f'{int(sum(((mt) & (j == q) & np.isin(s, s[mt & (j == q)] + 1)).sum() for q in stk))}')

print('\n-- TEST frontier for this ENS score (precision / buyable)')
te = np.nonzero((split == 2) & np.isfinite(ens))[0]
o = te[np.argsort(-ens[te], kind='mergesort')]
for N in (30, 100, 300, 1000):
    p = o[:N]; print(f'  top{N} total: prec={y[p].mean():.3f} wlb={wilson(y[p].sum(), N):.3f} buy={buy[p].mean():.3f} days={len(np.unique(s[p]))}')
for k in (1, 3, 10):
    rk = np.zeros(len(s), int) + 10 ** 9
    for d in np.unique(s[te]):
        ii = te[s[te] == d]; ii = ii[np.argsort(-ens[ii], kind='mergesort')]; rk[ii] = np.arange(len(ii))
    m = (split == 2) & (rk < k) & np.isfinite(ens)
    print(f'  top{k}/day: n={m.sum()} prec={y[m].mean():.3f} buy={buy[m].mean():.3f}')
np.savez_compressed(f'{SP}/a31_vfyENS_eval_{SRC}.npz', ens=ens.astype(np.float32), theta=th)
