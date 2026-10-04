"""「全部漲停前一日」資料集（2026-10-03 使用者：「對所有漲停前一日的股票當天的所有參數做統計跟比對，找相似處帶入公式，
重新制定方案直到準確率能達 9 成以上」）。

與 T1／T2 資料集的差異：不限「起漲」——**任何隔日漲停**都是正例，包含連板延續（s 當天已漲停）、低量股；
母體＝s 日與 s+1 日都有收盤、上市滿 125 個交易日的 4 碼個股（不含 00 開頭），排除 2025-04-07～10 衝擊視窗與
s+1 日結構斷點（還原後仍跳動 >±10.5%，多為停牌復牌／未還原事件，漲停判定不可信）。
欄位
  · f_*：117 個 s 日特徵（build.compute_features，只用 ≤ s 的資料；PIT 已驗證）＋ s 日漲停型態／尾盤五檔特徵（x_*）。
  · m_y＝s+1 漲停；m_y2＝s+1 與 s+2 都漲停；m_lu_s＝s 當天已漲停；m_locked1＝s+1 開盤即在漲停價（開盤買不到）；
    m_buy_lu＝s+1 漲停且開盤買得到（開盤 < 漲停價）；m_oc1＝s+1 開盤→收盤報酬；m_cc1＝s→s+1 收盤報酬（還原）。
  · 尾盤五檔（bookDepthArchive，2026-07-20 起、47 日）：x_bd_has（有無資料）、x_bd_bidlim（委買在漲停價的張數）、
    x_bd_bid/x_bd_ask（五檔委買／委賣總張）、x_bd_imb（委買÷(委買+委賣)）、x_bd_q_v（漲停委買張÷當日成交張）。
"""
import gzip, json, os
import numpy as np, pandas as pd
import build as B, build_v2 as V

SHOCK = ('2025-04-07', '2025-04-10')


def main():
    dates, codes, P = B.load_panel(); T, N = P['C'].shape
    A, F_day, _ = B.adjust(dates, codes, P, B.load_factor_events(dates, codes))
    EV = B.build_events(P, A, F_day); LU = EV['LU']; brk = EV['brk']
    Ca, C, O, H, L, Vv = A['C'], P['C'], P['O'], P['H'], P['L'], P['V']
    vol20 = pd.DataFrame(Vv).rolling(20, min_periods=15).mean().values
    cnt130 = pd.DataFrame(Ca).notna().astype(float).rolling(B.HIST_WIN, min_periods=1).sum().values
    nan20 = pd.DataFrame(Ca).isna().astype(float).rolling(20, min_periods=1).sum().values
    elig_base = np.isfinite(C) & (C >= B.MIN_PRICE) & (vol20 >= B.MIN_VOL20) & (cnt130 >= B.HIST_NEED) & (nan20 == 0)
    F = B.compute_features(dates, codes, P, A, EV, elig_base)
    dsl = F['days_since_lu'].copy(); dsl[~np.isfinite(dsl)] = 999.0; F['days_since_lu'] = dsl.astype(np.float32)

    # 漲停價（s 日、s+1 日）：參考價＝原始前收 × 當日係數（同 build_events）
    Cff = pd.DataFrame(C).ffill().values
    prev = np.vstack([np.full((1, N), np.nan), Cff[:-1]])
    lim = B.limit_up_price(B.round_tick(prev * F_day))
    U = B.official_limit_up(T, N)
    if U is not None: lim = np.where(np.isfinite(U) & (U > 0) & (U < 9000), U, lim)   # 一字鎖／開盤即漲停也以官方漲停價判定
    oneword = LU & np.isfinite(O) & (O >= lim - 1e-9) & (L >= lim - 1e-9)          # 一字鎖：開低收都在漲停價
    open_lim = np.isfinite(O) & (O >= lim - 1e-9)                                   # 開盤即漲停（買不到）

    d_arr = np.array(dates); shock = (d_arr >= SHOCK[0]) & (d_arr <= SHOCK[1])
    nxt = lambda X: np.vstack([X[1:], np.zeros((1, N), X.dtype)])
    ok = np.isfinite(C) & nxt(np.isfinite(C)) & (cnt130 >= B.HIST_NEED) & ~nxt(brk)
    ok[T - 1] = False; ok[shock] = False
    si, ji = np.nonzero(ok)
    print(f'母體列 {len(si):,}（{dates[si.min()]}～{dates[si.max()]}）')

    # 尾盤五檔
    BD = {k: np.full((T, N), np.nan, np.float32) for k in ('bd_has', 'bd_bidlim', 'bd_bid', 'bd_ask', 'bd_imb', 'bd_q_v')}
    ci = {c: i for i, c in enumerate(codes)}; di = {d: i for i, d in enumerate(dates)}
    if os.path.exists(f'{B.SP}/bookdepth.json.gz'):
        for day in json.load(gzip.open(f'{B.SP}/bookdepth.json.gz', 'rt')):
            t = di.get(day['date'])
            if t is None or not day.get('byCode'): continue
            BD['bd_has'][t, :] = 0
            for c, v in day['byCode'].items():
                j = ci.get(c)
                if j is None: continue
                if isinstance(v, list): bid, ask, bl = float(v[0]), float(v[1]), np.nan
                else:
                    bids, asks = v.get('bid') or [], v.get('ask') or []
                    bid = float(sum(x[1] or 0 for x in bids)); ask = float(sum(x[1] or 0 for x in asks))
                    bl = float(sum((x[1] or 0) for x in bids if x[0] and np.isfinite(lim[t, j]) and x[0] >= lim[t, j] - 1e-9))
                BD['bd_has'][t, j] = 1; BD['bd_bid'][t, j] = bid; BD['bd_ask'][t, j] = ask; BD['bd_bidlim'][t, j] = bl
                BD['bd_imb'][t, j] = bid / (bid + ask) if bid + ask > 0 else np.nan
                BD['bd_q_v'][t, j] = bl / Vv[t, j] if np.isfinite(bl) and Vv[t, j] > 0 else np.nan
        print('尾盤五檔日數', int(np.nanmax(BD['bd_has'], axis=1).__ge__(0).sum()))

    X = {f'f_{k}': v[si, ji] for k, v in F.items()}
    X.update({f'x_{k}': v[si, ji] for k, v in BD.items()})
    X['x_lu_s'] = LU[si, ji].astype(np.float32); X['x_oneword_s'] = oneword[si, ji].astype(np.float32)
    X['x_close_at_high'] = (np.isfinite(H[si, ji]) & (C[si, ji] >= H[si, ji] - 1e-9)).astype(np.float32)
    X['x_lu_streak'] = np.zeros(len(si), np.float32)
    run = np.zeros((T, N), np.int16)
    for t in range(T): run[t] = np.where(LU[t], (run[t - 1] + 1) if t else 1, 0)
    X['x_lu_streak'] = run[si, ji].astype(np.float32)
    X['x_price'] = C[si, ji].astype(np.float32); X['x_vol20'] = vol20[si, ji].astype(np.float32)
    mk = json.load(open(f'{B.SP}/code_market.json')); mkt = np.array([1 if mk.get(c) == 'otc' else 0 for c in codes], np.int8)
    t1 = si + 1; t2 = np.minimum(si + 2, T - 1)
    meta = dict(s=si.astype(np.int32), j=ji.astype(np.int32), y=LU[t1, ji].astype(np.int8),
                y2=(LU[t1, ji] & LU[t2, ji] & (si + 2 < T)).astype(np.int8), lu_s=LU[si, ji].astype(np.int8),
                locked1=open_lim[t1, ji].astype(np.int8), buy_lu=(LU[t1, ji] & ~open_lim[t1, ji]).astype(np.int8),
                otc=mkt[ji], liquid=elig_base[si, ji].astype(np.int8),
                oc1=(C[t1, ji] / O[t1, ji] - 1).astype(np.float32), cc1=(Ca[t1, ji] / Ca[si, ji] - 1).astype(np.float32))
    np.savez_compressed(f'{B.SP}/dataset_lu1{os.environ.get("SURGE_DATASET_SUFFIX", "")}.npz', dates=d_arr, codes=np.array(codes), **{f'm_{k}': v for k, v in meta.items()}, **X)
    y, lu_s, buy = meta['y'], meta['lu_s'], meta['buy_lu']
    print(f'正例（隔日漲停）{int(y.sum()):,}（基準率 {y.mean() * 100:.2f}%）：其中前日已漲停（延續）{int((y & lu_s).sum()):,}、新起漲 {int((y & ~lu_s.astype(bool)).sum()):,}；'
          f'隔日開盤買得到的漲停 {int(buy.sum()):,}；前日已漲停者隔日續漲停率 {y[lu_s == 1].mean() * 100:.1f}%（開盤買得到 {buy[lu_s == 1].mean() * 100:.1f}%）')
    for yr in ('2023', '2024', '2025', '2026'):
        m = np.array([dates[i][:4] == yr for i in si]); print(yr, f'列 {int(m.sum()):,}、漲停 {int(y[m].sum()):,}（{y[m].mean() * 100:.2f}%）')


if __name__ == '__main__':
    main()
