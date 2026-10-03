"""注意股與起漲的時間軸；以及「前 5 日報酬加總」單一指標的偵測力。"""
import numpy as np, pandas as pd, warnings, os
import build as B, build_v2 as V, attention as AT
warnings.filterwarnings('ignore')
pd.set_option('display.width', 220)
dates, codes, P = B.load_panel(); T, N = P['C'].shape
ev = B.load_factor_events(dates, codes); Aj, Fd, _ = B.adjust(dates, codes, P, ev); EV = B.build_events(P, Aj, Fd); S = V.segments(EV, Aj['C'])
Ca = Aj['C']; ret = Ca / pd.DataFrame(Ca).shift(1).values - 1
ret_f = np.nan_to_num(ret)
cs = np.cumsum(ret_f, axis=0)
def roll_sum(k):
    out = np.full((T, N), np.nan); out[k:] = cs[k:] - cs[:-k]; return out          # Σ ret[t−k+1..t]
S5, S6 = roll_sum(5), roll_sum(6)
M = np.load(f'{B.SP}/att_mats.npz'); RISE = M['RISE']
vol20 = pd.DataFrame(P['V']).rolling(20, min_periods=15).mean().values
liq = np.isfinite(P['C']) & (P['C'] >= 10) & (vol20 >= 300); liq[:130] = False
liq_prev = np.vstack([np.zeros((1, N), bool), liq[:-1]])
# 累計：自 t 起到 u 為止是否已進入漲幅型注意（含 u 當天公告）
print('— 起漲日 t 前後（lag=u−t）：6 日報酬加總（官方注意股口徑）與「已進入漲幅型注意」比例 —')
for name, st in (('T1 連板≥2', S['start1']), ('T2 5日連漲>35%', S['start2'])):
    ts, js = np.nonzero(st); keep = np.array([liq_prev[t, j] for t, j in zip(ts, js)]); ts, js = ts[keep], js[keep]
    rows = []
    for lag in range(-3, 8):
        u = ts + lag; ok = (u >= 6) & (u < T)
        v6 = S6[u[ok], js[ok]]; v5 = S5[u[ok], js[ok]]
        ent = np.zeros(ok.sum(), bool)
        for k in range(0, 11):    # 在 [t, u] 內出現漲幅型公告 → 已進入
            pass
        got = np.array([RISE[max(t, 0):u_ + 1, j].any() if u_ >= t else False for t, j, u_ in zip(ts[ok], js[ok], u[ok])])
        rows.append(dict(lag=lag, S6中位=np.median(v6) * 100, S6_ge25=(v6 >= 0.25).mean() * 100, S6_ge32=(v6 >= 0.32).mean() * 100, 已進入注意=got.mean() * 100))
    print(name, f'（事件 {len(ts)}；lag=0 為起漲日 t，t−1 是起漲前日）'); print(pd.DataFrame(rows).round(1).to_string(index=False))
# 「前 5 日報酬加總」單一指標偵測進入注意（AT 母體列）
d = np.load(f'{B.SP}/dataset_at.npz'); s, j, y = d['m_s'], d['m_j'], d['m_y'].astype(bool)
s5 = S5[s, j]
import evallib as E
for lab, sc in (('前5日報酬加總 S5(s)', s5), ('前1日報酬', ret_f[s, j]), ('前3日報酬加總', (roll_sum(3))[s, j]), ('ATR14', np.nan_to_num(d['f_atr14']))):
    m = np.isfinite(sc)
    t, base = E.topk_table(np.where(m, sc, -9)[m], s[m], y[m].astype(int), Ks=(10, 50))
    print(f'{lab:14s} 同日AUC {E.within_day_auc(sc[m], s[m], y[m].astype(int)):.3f} lift@10 {t.lift[0]:.1f} lift@50 {t.lift[1]:.1f}')
# 進入前一日（X−1）的 S5 分布
st_t, st_j = np.nonzero(RISE & ~np.vstack([np.zeros((1, N), bool), RISE[:-1]]))
