"""停損情境（預先固定格點，不挑最佳）：隔日開盤進、持有 H 日、盤中跌破進場價 −x% 即停損。
⚠ 台股沒有交易所停損單：實務上是盤中自行監控後市價單，成交價一定比停損價差。故同時報告四種成交假設（由樂觀到悲觀）：
  stop ：剛好以停損價成交（原先唯一假設，最樂觀；跳空以開盤價）
  slip1：停損價再差 1%
  mid  ：停損價與當日最低價的中點
  low  ：當日最低價（最悲觀）
收盤跌停（收盤≤前收×0.905）一律以收盤價（鎖死賣不掉）。基準＝同日同母體同規則（含同停損與同成交假設）等權平均；進場一字鎖漲停開盤＝買不到、略過。
區塊 bootstrap（區塊長＝持有日數）。審查者（mle-reviewer）指出原假設過樂觀，2026-10-02 補。"""
import numpy as np, pandas as pd, warnings
import build as B, evallib as E
warnings.filterwarnings('ignore')
pd.set_option('display.width', 220)
D = E.load(); O_ = np.load(f'{E.B.SP}/oof.npz'); s, j, y = D['s'], D['j'], D['y']
dates, codes, P = B.load_panel(); T, N = P['C'].shape
ev = B.load_factor_events(dates, codes); A, Fd, _ = B.adjust(dates, codes, P, ev)
Ca, Oa, La = A['C'], A['O'], A['L']
test = np.isfinite(O_['gbdt_rank'])

def sim(rows, H, x, fill):
    t = s[rows] + 1; jj = j[rows]
    ok = (t + H - 1 <= T - 1) & (D['locked_open'][rows] == 0)
    rows, t, jj = rows[ok], t[ok], jj[ok]
    E0 = Oa[t, jj]; ok = np.isfinite(E0) & (E0 > 0)
    rows, t, jj, E0 = rows[ok], t[ok], jj[ok], E0[ok]
    exit_px = np.full(len(rows), np.nan); done = np.zeros(len(rows), bool); bad = np.zeros(len(rows), bool)
    for k in range(H):
        d = t + k
        lo, op, cl = La[d, jj], Oa[d, jj], Ca[d, jj]; pcl = Ca[d - 1, jj]
        bad |= ~(np.isfinite(lo) & np.isfinite(cl) & np.isfinite(op))
        if x is not None:
            S = E0 * (1 - x)
            hit = (~done) & (lo <= S)
            base = np.where(op < S, op, S) if k > 0 else S
            if fill == 'stop': px = base
            elif fill == 'slip1': px = base * 0.99
            elif fill == 'mid': px = (base + lo) / 2
            else: px = lo
            px = np.minimum(px, base) if fill != 'stop' else px
            px = np.where(cl <= pcl * 0.905, cl, px)
            exit_px[hit] = px[hit]; done |= hit
        if k == H - 1: exit_px[~done] = cl[~done]
    r = exit_px / E0 - 1
    good = ~bad & np.isfinite(r)
    return rows[good], r[good]

def block_ci(v, L, n=2000, seed=3):
    Tn = len(v); rng = np.random.default_rng(seed); nb = int(np.ceil(Tn / L)); m = []
    for _ in range(n):
        st = rng.integers(0, Tn, nb); idx = (st[:, None] + np.arange(L)[None, :]).ravel()[:Tn] % Tn; m.append(v[idx].mean())
    return np.percentile(m, [2.5, 97.5])

def summ(rows_pick, rows_all, H, x, fill):
    rp, r_p = sim(rows_pick, H, x, fill); ra, r_a = sim(rows_all, H, x, fill)
    dp = pd.DataFrame({'s': s[rp], 'r': r_p}).groupby('s').r.mean(); da = pd.DataFrame({'s': s[ra], 'r': r_a}).groupby('s').r.mean()
    jn = pd.concat([dp, da], axis=1, keys=['p', 'u']).dropna().sort_index(); ex = (jn.p - jn.u).values
    lo, hi = block_ci(ex, H)
    return dict(H=H, stop=('無' if x is None else f'-{int(x*100)}%'), fill=('—' if x is None else fill), mean=r_p.mean() * 100, median=np.median(r_p) * 100, uni=r_a.mean() * 100,
                excess=ex.mean() * 100, lo=lo * 100, hi=hi * 100, big10=(r_p < -0.10).mean() * 100, p5=np.percentile(r_p, 5) * 100)

idx = np.nonzero(test)[0]
rk = E.rank_in_day_desc(O_['gbdt_rank'][idx], s[idx]); picks = idx[rk < 10]
rows = []
for H in (5, 10, 20):
    rows.append(summ(picks, idx, H, None, 'stop'))
    for x in (0.05, 0.07, 0.10):
        for fill in ('stop', 'slip1', 'mid', 'low'):
            rows.append(summ(picks, idx, H, x, fill))
R = pd.DataFrame(rows)
print(R.round(2).to_string(index=False))
R.to_csv(f'{E.B.SP}/stoploss.csv', index=False)
