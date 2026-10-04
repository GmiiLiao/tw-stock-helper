"""v2 資料建置：重新定義條件（2026-10-02 使用者）

使用者的四項新條件
  1. 排除 2025-04-09 急殺事件（國際事件造成崩盤，該訊息要從新聞得知 ⇒ 「新聞識讀」列為必要性前置條件，不在本模型內）。
     實作：s 日落在 [2025-04-07, 2025-04-10]（三個崩盤日＋反彈日）的樣本一律不用（正例、負例皆是）。
  2. T1（特徵1）：只找「連續漲停 ≥2 日」的**起漲前日**。起漲日 t＝連板的第一天，s＝t−1。
     「前一日已漲停則當日不再使用」「區間內日期不再用於調查，算入同一上漲區段」⇒ s 當天已漲停者不用；
     連板區段內的日子不用；區段結束後 COOLDOWN 日內也不用（同一上漲區段的延續，續抱／再攻另行訓練）。
  3. T2（特徵2）：只找「連續 5 日收盤上漲且累計 >35%」的**起漲前日**。起漲日 t＝合併後區段的第一天，s＝t−1；區段內日期不用、區段後 COOLDOWN 日內不用。
  4. 不做停損停利條件日、不做續抱辨識（另案訓練）。

兩個目標各自成一份資料集（dataset_t1.npz／dataset_t2.npz，格式同 v1，供 evallib 以 SURGE_DATASET 切換）。

與 v1 的差異（含審查者建議）
  · 冷卻只用「已完成」的區段（不再用 s 日之後才能確定的 B 型標記）；T2 另保留「進行中區段」列（m_extra=1，標籤 0）供更貼近實盤的評估，訓練不用。
  · days_since_lu 缺值（從未漲停）改填 999。
"""
import numpy as np, pandas as pd, os, sys
import build as B

SHOCK_S = ('2025-04-07', '2025-04-10')   # s 日視窗（含）
COOLDOWN = 10
T2_RET = 1.35                              # 超過 35%（嚴格大於）


def lag(X, k):
    if k == 0: return X.copy()
    out = np.zeros_like(X); out[k:] = X[:-k]; return out

def lead(X, k):
    if k == 0: return X.copy()
    out = np.zeros_like(X); out[:-k] = X[k:]; return out

def any_window(X, a, b):
    """out[s] = any X[s−k] for k in [a, b]（k≥0 落後）。"""
    out = np.zeros_like(X)
    for k in range(a, b + 1): out |= lag(X, k)
    return out


def segments(EV, Ca):
    T, N = Ca.shape
    LU, up, Caprev = EV['LU'], EV['up'], EV['Caprev']
    # T1：連續漲停 ≥2
    start1 = LU & lead(LU, 1) & ~lag(LU, 1)
    seg1 = LU & (lag(LU, 1) | lead(LU, 1))
    # T2：5 日連漲且累計 >35%
    upall = up.copy()
    for k in range(1, 5): upall &= lead(up, k)
    r5 = np.full_like(Ca, np.nan); r5[:T - 4] = Ca[4:] / Caprev[:T - 4]       # r5[t]=C[t+4]/C[t−1]
    W2 = upall & (r5 > T2_RET) & np.isfinite(r5)
    seg2 = any_window(W2, 0, 4)
    start2 = seg2 & ~lag(seg2, 1)
    # 冷卻（只用已完成資訊）
    cool1 = any_window(seg1, 1, COOLDOWN)                        # s 前 10 日內的連板日（皆 ≤ s−1，PIT 安全）
    cool2 = any_window(W2, 4, 4 + COOLDOWN)                       # 視窗起點 v ∈ [s−14, s−4]（已完成）；進行中的 v ∈ [s−3, s] 不用
    return dict(LU=LU, start1=start1, seg1=seg1, W2=W2, seg2=seg2, start2=start2, cool1=cool1, cool2=cool2)


def forward_meta(si, ji, A, P, F_day, T):
    Ca, Oa = A['C'], A['O']
    meta = {}
    def fwd(k):
        out = np.full(len(si), np.nan, dtype=np.float32); ok = si + k < T
        out[ok] = Ca[si[ok] + k, ji[ok]] / Ca[si[ok], ji[ok]] - 1; return out
    for k in (1, 2, 5, 10, 20): meta[f'f_c{k}'] = fwd(k)
    out = np.full(len(si), np.nan, dtype=np.float32); ok = si + 1 < T
    out[ok] = Oa[si[ok] + 1, ji[ok]] / Ca[si[ok], ji[ok]] - 1; meta['f_open1'] = out
    for k in (1, 2, 5, 10, 20):
        out = np.full(len(si), np.nan, dtype=np.float32); ok = si + k < T
        out[ok] = Ca[si[ok] + k, ji[ok]] / Oa[si[ok] + 1, ji[ok]] - 1; meta[f'o_c{k}'] = out
    Hdf = pd.DataFrame(A['H']); Ldf = pd.DataFrame(A['L'])
    hmax10 = Hdf[::-1].rolling(10, min_periods=1).max()[::-1].shift(-1).values
    lmin5 = Ldf[::-1].rolling(5, min_periods=1).min()[::-1].shift(-1).values
    meta['f_maxup10'] = (hmax10[si, ji] / Ca[si, ji] - 1).astype(np.float32)
    meta['f_mindn5_vs_open'] = (lmin5[si, ji] / Oa[np.minimum(si + 1, T - 1), ji] - 1).astype(np.float32)
    Craw = P['C']; ref_t = B.round_tick(Craw[si, ji] * F_day[np.minimum(si + 1, T - 1), ji]); lim_t = B.limit_up_price(ref_t)
    U = B.official_limit_up(*Craw.shape)
    if U is not None:
        u1 = U[np.minimum(si + 1, T - 1), ji]; lim_t = np.where(np.isfinite(u1) & (u1 > 0) & (u1 < 9000), u1, lim_t)
    opn = P['O'][np.minimum(si + 1, T - 1), ji]
    meta['locked_open'] = (np.isfinite(opn) & (opn >= lim_t - 1e-9)).astype(np.int8)
    meta['close_raw'] = Craw[si, ji].astype(np.float32)
    return meta


def main():
    dates, codes, P = B.load_panel(); T, N = P['C'].shape
    events = B.load_factor_events(dates, codes)
    A, F_day, n_used = B.adjust(dates, codes, P, events)
    EV = B.build_events(P, A, F_day)
    S = segments(EV, A['C'])
    LU = S['LU']
    Ca, V = A['C'], P['V']
    Cdf, Vdf = pd.DataFrame(Ca), pd.DataFrame(V)
    vol20 = Vdf.rolling(20, min_periods=15).mean().values
    cnt130 = Cdf.notna().astype(float).rolling(B.HIST_WIN, min_periods=1).sum().values
    nan20 = Cdf.isna().astype(float).rolling(20, min_periods=1).sum().values
    brk_past = pd.DataFrame(EV['brk'].astype(float)).rolling(B.HIST_NEED, min_periods=1).max().values > 0
    brk_future = np.zeros_like(brk_past)
    for k in range(1, 6): brk_future[:-k] |= EV['brk'][k:]
    elig_base = np.isfinite(P['C']) & (P['C'] >= B.MIN_PRICE) & (vol20 >= B.MIN_VOL20) & (cnt130 >= B.HIST_NEED) & (nan20 == 0)
    d_arr = np.array(dates)
    shock = (d_arr >= SHOCK_S[0]) & (d_arr <= SHOCK_S[1])
    print(f'排除 s 日視窗 {SHOCK_S}：{int(shock.sum())} 個交易日 {[str(x) for x in d_arr[shock]]}')
    base_ok = elig_base & ~brk_past & ~brk_future
    base_ok[T - 5:] = False
    base_ok[shock, :] = False

    e1 = base_ok & ~LU & ~S['cool1']
    e2 = base_ok & ~S['seg2'] & ~S['cool2']
    e2_extra = base_ok & S['seg2'] & ~S['cool2'] & ~e2          # 進行中區段列（實盤上看不出已在區段中）
    # 加上（有人於 T−5 之後）
    start1_next = lead(S['start1'], 1); start2_next = lead(S['start2'], 1)

    F = B.compute_features(dates, codes, P, A, EV, elig_base)
    dsl = F['days_since_lu'].copy(); dsl[~np.isfinite(dsl)] = 999.0; F['days_since_lu'] = dsl.astype(np.float32)   # 從未漲停＝很久以前
    print('特徵', len(F))

    # 事件漏斗（各目標）
    def funnel(start, task, ok_mask):
        st_t, st_j = np.nonzero(start)
        c = dict(total=len(st_t), shock=0, price=0, liq=0, hist=0, nan=0, brk=0, seg_or_lu=0, cooldown=0, tail=0, IN=0)
        for t, j in zip(st_t, st_j):
            s = t - 1
            if s < 0: continue
            if shock[s]: c['shock'] += 1; continue
            if not (P['C'][s, j] >= B.MIN_PRICE): c['price'] += 1; continue
            if not (vol20[s, j] >= B.MIN_VOL20): c['liq'] += 1; continue
            if not (cnt130[s, j] >= B.HIST_NEED): c['hist'] += 1; continue
            if nan20[s, j] > 0: c['nan'] += 1; continue
            if brk_past[s, j] or brk_future[s, j]: c['brk'] += 1; continue
            if s >= T - 5: c['tail'] += 1; continue
            if ok_mask[s, j]: c['IN'] += 1
            else: c['cooldown'] += 1
        return c
    fn1 = funnel(S['start1'], 'T1', e1); fn2 = funnel(S['start2'], 'T2', e2)
    print('T1 漏斗', fn1); print('T2 漏斗', fn2)

    meta_common = {}
    for task, e_main, e_extra, start_next, other_next in (('t1', e1, None, start1_next, start2_next), ('t2', e2, e2_extra, start2_next, start1_next)):
        mask = e_main | (e_extra if e_extra is not None else False)
        si, ji = np.nonzero(mask)
        pos = start_next[si, ji]
        oth = other_next[si, ji]
        extra = (e_extra[si, ji] if e_extra is not None else np.zeros(len(si), bool))
        meta = {'s': si.astype(np.int32), 'j': ji.astype(np.int32), 'y': pos.astype(np.int8),
                'yA': (pos & oth).astype(np.int8), 'yB': (pos & ~oth).astype(np.int8), 'extra': extra.astype(np.int8)}
        meta.update(forward_meta(si, ji, A, P, F_day, T))
        meta['vol20'] = vol20[si, ji].astype(np.float32)
        feats = {k: v[si, ji] for k, v in F.items()}
        # 事件目錄（全市場）
        st = S['start1'] if task == 't1' else S['start2']
        st_t, st_j = np.nonzero(st)
        inU = np.array([bool(mask[t - 1, j] and not (e_extra is not None and e_extra[t - 1, j])) if t >= 1 else False for t, j in zip(st_t, st_j)], dtype=np.int8)
        cat = {'t': st_t.astype(np.int32), 'j': st_j.astype(np.int32), 'in_universe': inU}
        np.savez_compressed(f'{B.SP}/dataset_{task}{os.environ.get("SURGE_DATASET_SUFFIX", "")}.npz', dates=np.array(dates), codes=np.array(codes),
                            **{f'm_{k}': v for k, v in meta.items()}, **{f'f_{k}': v for k, v in feats.items()}, **{f'cat_{k}': v for k, v in cat.items()})
        prim = ~extra
        yr = np.array([dates[i][:4] for i in si])
        by = {str(Y): (int(pos[prim & (yr == Y)].sum()), int((prim & (yr == Y)).sum())) for Y in sorted(set(yr))}
        print(f'[{task}] 母體 {int(prim.sum()):,} 列（另有進行中區段列 {int(extra.sum()):,}）；正例 {int(pos[prim].sum()):,}（與另一目標重疊 {int((pos & oth)[prim].sum())}）；基準率 {pos[prim].mean() * 100:.3f}%；各年 正例/列數 {str(by)}')


if __name__ == '__main__':
    main()
