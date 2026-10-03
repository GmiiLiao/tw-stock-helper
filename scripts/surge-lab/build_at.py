"""進入注意股（漲幅型）的偵測資料集（2026-10-02，使用者：進入注意股前一日應該就是起漲現象，比對是否有相同條件）。

ENTRY[X]＝X 日出現漲幅型注意公告（第 1～5 款且「漲幅」），且該股前 10 個交易日內沒有漲幅型公告（＝「進入」）。公告日期 X＝觸發日（盤後公布、次一營業日起生效）。
樣本列 (s, 代號)：流動、歷史足夠、無價格結構斷點、不在 2025-04-07～04-10 衝擊視窗；
  並要求 s 當天沒有漲幅型公告、s 前 10 日內（只用 pub ≤ s−1，前視安全）也沒有 ⇒ 乾淨的「尚未進入」狀態。
標籤 y_h[s]＝ENTRY 出現在 s+1..s+h 之內（h＝1,3,5,10）；h=1 即「前一日」。m_y 存 h=1，其餘存 m_yh3／m_yh5／m_yh10（evallib 以 SURGE_LABEL 切換）。
"""
import numpy as np, pandas as pd
import build as B, build_v2 as V, attention as AT

def main():
    dates, codes, P = B.load_panel(); T, N = P['C'].shape; d_arr = np.array(dates)
    events = B.load_factor_events(dates, codes); A, F_day, _ = B.adjust(dates, codes, P, events); EV = B.build_events(P, A, F_day)
    M = AT.build_matrices(dates, codes); RISE = M['RISE']
    Ca, Vv = A['C'], P['V']; Cdf = pd.DataFrame(Ca); Vdf = pd.DataFrame(Vv)
    vol20 = Vdf.rolling(20, min_periods=15).mean().values
    cnt130 = Cdf.notna().astype(float).rolling(B.HIST_WIN, min_periods=1).sum().values
    nan20 = Cdf.isna().astype(float).rolling(20, min_periods=1).sum().values
    brk_past = pd.DataFrame(EV['brk'].astype(float)).rolling(B.HIST_NEED, min_periods=1).max().values > 0
    brk_future = np.zeros_like(brk_past)
    for k in range(1, 6): brk_future[:-k] |= EV['brk'][k:]
    elig_base = np.isfinite(P['C']) & (P['C'] >= B.MIN_PRICE) & (vol20 >= B.MIN_VOL20) & (cnt130 >= B.HIST_NEED) & (nan20 == 0)
    shock = (d_arr >= V.SHOCK_S[0]) & (d_arr <= V.SHOCK_S[1])
    base_ok = elig_base & ~brk_past & ~brk_future; base_ok[T - 11:] = False; base_ok[shock, :] = False
    prev10 = V.any_window(RISE, 1, 10)                       # RISE 在 [t−10, t−1]
    ENTRY = RISE & ~prev10
    mask = base_ok & ~RISE & ~prev10                          # s 當天無公告、s 前 10 日無（PIT）
    labels = {}
    for h in (1, 3, 5, 10):
        y = np.zeros((T, N), bool)
        for k in range(1, h + 1): y[:T - k] |= ENTRY[k:]
        labels[h] = y
    F = B.compute_features(dates, codes, P, A, EV, elig_base)
    dsl = F['days_since_lu'].copy(); dsl[~np.isfinite(dsl)] = 999.0; F['days_since_lu'] = dsl.astype(np.float32)
    si, ji = np.nonzero(mask)
    meta = {'s': si.astype(np.int32), 'j': ji.astype(np.int32), 'y': labels[1][si, ji].astype(np.int8),
            'yh3': labels[3][si, ji].astype(np.int8), 'yh5': labels[5][si, ji].astype(np.int8), 'yh10': labels[10][si, ji].astype(np.int8),
            'yA': np.zeros(len(si), np.int8), 'yB': labels[1][si, ji].astype(np.int8), 'extra': np.zeros(len(si), np.int8)}
    meta.update(V.forward_meta(si, ji, A, P, F_day, T)); meta['vol20'] = vol20[si, ji].astype(np.float32)
    feats = {k: v[si, ji] for k, v in F.items()}
    st_t, st_j = np.nonzero(ENTRY)
    cat = {'t': st_t.astype(np.int32), 'j': st_j.astype(np.int32), 'in_universe': np.array([bool(mask[t - 1, j]) if t >= 1 else False for t, j in zip(st_t, st_j)], np.int8)}
    np.savez_compressed(f'{B.SP}/dataset_at.npz', dates=np.array(dates), codes=np.array(codes), **{f'm_{k}': v for k, v in meta.items()}, **{f'f_{k}': v for k, v in feats.items()}, **{f'cat_{k}': v for k, v in cat.items()})
    yr = np.array([dates[i][:4] for i in si])
    print(f'母體 {len(si):,} 列；進入事件（全市場流動股）{int(ENTRY.sum())}、母體內 h=1 正例 {int(meta["y"].sum())}（基準率 {meta["y"].mean()*100:.3f}%）；h=3 {meta["yh3"].mean()*100:.3f}% h=5 {meta["yh5"].mean()*100:.3f}% h=10 {meta["yh10"].mean()*100:.3f}%')
    print('各年 h=1 正例：', {str(Y): int(meta['y'][yr == Y].sum()) for Y in sorted(set(yr))})

if __name__ == '__main__':
    main()
