"""注意股名單：目錄、與起漲事件（T1／T2）的先後關係、與處置的升級關係。"""
import numpy as np, pandas as pd, warnings, os
import build as B, build_v2 as V, attention as AT, disposal as DP
warnings.filterwarnings('ignore')
pd.set_option('display.width', 220)
dates, codes, P = B.load_panel(); T, N = P['C'].shape; d_arr = np.array(dates)
A = AT.build_matrices(dates, codes)
print(f"對得上面板的公告 {A['rows']:,} 筆（非交易日略過 {A['miss']}）；個股-日：任何 {int(A['ANY'].sum()):,}、漲幅型 {int(A['RISE'].sum()):,}、跌幅型 {int(A['FALL'].sum()):,}、其他(量能/週轉/當沖…) {int(A['HEAT'].sum()):,}")
yr = np.array([d[:4] for d in dates])
C, Vv = P['C'], P['V']
vol20 = pd.DataFrame(Vv).rolling(20, min_periods=15).mean().values
liq = np.isfinite(C) & (C >= 10) & (vol20 >= 300); liq[:130] = False
def liq_prev(t, j): return liq[t - 1, j] if t >= 1 else False
tab = []
for Y in ('2022', '2023', '2024', '2025', '2026'):
    m = yr == Y
    tab.append(dict(年=Y, 任何=int(A['ANY'][m].sum()), 漲幅型=int(A['RISE'][m].sum()), 跌幅型=int(A['FALL'][m].sum()), 其他=int(A['HEAT'][m].sum()), 流動股漲幅型=int((A['RISE'] & np.vstack([np.zeros((1, N), bool), liq[:-1]]))[m].sum())))
print(pd.DataFrame(tab).to_string(index=False))
# ── 先後關係：T1／T2 起漲日 t 與漲幅型注意股公告日 X ──
ev = B.load_factor_events(dates, codes); Aj, Fd, _ = B.adjust(dates, codes, P, ev); EV = B.build_events(P, Aj, Fd); S = V.segments(EV, Aj['C'])
RISE = A['RISE']
def first_after(X, t, j, lo, hi):
    """t+lo..t+hi 內第一個 X 為 True 的 offset，沒有回 None。"""
    for k in range(lo, hi + 1):
        if 0 <= t + k < T and X[t + k, j]: return k
    return None
print('\n— 起漲日 t 與漲幅型注意股公告日 X 的先後（X−t，交易日；流動股起漲前一日）—')
for name, st in (('T1 連板≥2', S['start1']), ('T2 5日連漲>35%', S['start2'])):
    ts, js = np.nonzero(st); keep = np.array([liq_prev(t, j) for t, j in zip(ts, js)]); ts, js = ts[keep], js[keep]
    pre = np.array([first_after(RISE, t, j, -10, -1) is not None for t, j in zip(ts, js)])      # 起漲前 10 日內已有漲幅型注意
    lags = [first_after(RISE, t, j, 0, 20) for t, j in zip(ts, js)]
    got = np.array([l is not None for l in lags]); L = np.array([l for l in lags if l is not None])
    print(f'{name}：事件 {len(ts)}；起漲前 10 日內已在注意股 {pre.mean()*100:.1f}%；起漲日起 20 日內出現漲幅型注意公告 {got.mean()*100:.1f}%（10 日內 {np.mean([(l is not None and l<=10) for l in lags])*100:.1f}%）')
    vc = pd.Series(L).value_counts().sort_index()
    print('   X−t 分布：', {int(k): f'{v/len(L)*100:.0f}%' for k, v in vc.items() if k <= 12}, f'；中位 {np.median(L):.0f} 日')
# 基準：任一流動股-日，未來 0..10 日內出現漲幅型注意的機率
rr = np.zeros((T, N), bool)
for k in range(0, 11): rr[:T - k] |= RISE[k:]
base = rr[liq].mean(); print(f'基準：任一流動股-日其後 10 日內出現漲幅型注意公告的機率 {base*100:.2f}%')
# ── 反向：漲幅型注意（該股前 10 日無漲幅型注意＝「進入」）之前有沒有起漲事件 ──
print('\n— 漲幅型注意股「進入」（前 10 日無漲幅型公告，流動股）之前的起漲事件 —')
prev10 = np.zeros((T, N), bool)
for k in range(1, 11): prev10[k:] |= RISE[:T - k]
entry = RISE & ~prev10
xs, js = np.nonzero(entry); keep = np.array([liq_prev(t, j) for t, j in zip(xs, js)]); xs, js = xs[keep], js[keep]
print('進入事件數', len(xs))
for name, st in (('T1', S['start1']), ('T2', S['start2'])):
    lags = [first_after(st, x, j, -12, 0) for x, j in zip(xs, js)]    # t−x ∈ [−12,0]
    got = np.array([l is not None for l in lags]); L = -np.array([l for l in lags if l is not None])
    print(f'  前 12 日內有 {name} 起漲：{got.mean()*100:.1f}%（X−t 中位 {np.median(L):.0f} 日；分布 {dict(pd.Series(L).value_counts().sort_index().head(10))}）')
both = np.array([(first_after(S['start1'], x, j, -12, 0) is not None) or (first_after(S['start2'], x, j, -12, 0) is not None) for x, j in zip(xs, js)])
print(f'  T1 或 T2 起漲其後 12 日內進入漲幅型注意：僅 {both.mean()*100:.1f}% 的「進入」前有 T1/T2 起漲；其餘 {100-both.mean()*100:.1f}% 是較緩的上漲（5 日加總仍超過門檻、但未連板或連 5 日收紅）')
# ── 升級：注意 → 處置 ──
iv = DP.load_intervals(); d_idx = {d: i for i, d in enumerate(dates)}; ci = {c: i for i, c in enumerate(codes)}
DPUB = np.zeros((T, N), bool)
for r in iv:
    j = ci.get(r['code']); t = d_idx.get(r['pub'])
    if j is not None and t is not None: DPUB[t, j] = True
nxt = np.zeros((T, N), bool)
for k in range(1, 11): nxt[:T - k] |= DPUB[k:]
CUM = A['CUM']
print('\n— 注意股公告 → 其後 10 個交易日內出現「處置公告」的機率（流動股）—')
base_d = nxt[liq].mean(); print(f'基準：任一流動股-日 {base_d*100:.2f}%')
rows = []
for lab, mask in (('任何注意', A['ANY']), ('漲幅型', A['RISE']), ('其他型(量能/週轉/當沖…)', A['HEAT']), ('跌幅型', A['FALL'])):
    m = mask & np.vstack([np.zeros((1, N), bool), liq[:-1]]); rows.append(dict(類型=lab, 公告數=int(m.sum()), 十日內處置=nxt[m].mean() * 100, lift=nxt[m].mean() / base_d))
print(pd.DataFrame(rows).round(2).to_string(index=False))
rows = []
for lo, hi in ((1, 1), (2, 3), (4, 5), (6, 8), (9, 12), (13, 99)):
    m = A['ANY'] & (CUM >= lo) & (CUM <= hi) & np.vstack([np.zeros((1, N), bool), liq[:-1]])
    if m.sum(): rows.append(dict(累計次數=f'{lo}~{hi}', 公告數=int(m.sum()), 十日內處置=nxt[m].mean() * 100, lift=nxt[m].mean() / base_d))
print('依「累計次數」：'); print(pd.DataFrame(rows).round(2).to_string(index=False))
np.savez_compressed(f'{AT.SP}/att_mats.npz', ANY=A['ANY'], RISE=A['RISE'], FALL=A['FALL'], HEAT=A['HEAT'], CUM=A['CUM'], DPUB=DPUB)
