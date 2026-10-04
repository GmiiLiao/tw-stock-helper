"""a35_shadow 防呆：live 特徵建構 vs 研究資料集（a32_walkforward_X.npy）逐欄對照。

用法：python3 a35_shadow_parity.py [日期…]            # 預設抽 6 個日期
      python3 a35_shadow_parity.py --selftest          # 另外重現 a32 快取的 ALL_y_202609_s1 分數，並用 live 特徵打分對照（約 3～10 分鐘，單核）
目的：證明（1）live 路徑算出來的特徵與訓練用資料集同值（差只來自「母體少了 s+1 條件」造成的百分位微小變動）；
      （2）訓練函式與 a32_walkforward_fit.py 逐位相同（--selftest）。
"""
import sys
import time
import numpy as np
import a35_shadow_lib as L

DEFAULT_DAYS = ['2026-09-30', '2026-09-15', '2026-08-14', '2026-07-16', '2026-03-02', '2025-11-10']


def parity(days: list) -> bool:
    x = L.build_ctx()
    st = L.Store(); M = np.load(L.META_PATH); mj = M['m_j']
    names = st.names
    ok_all = True
    print(f'欄位 {len(names)}；面板 T={x.T} N={x.N}；資料集列 {len(st.s):,}')
    for d in days:
        t = x.dates.index(d)
        rows = np.nonzero(st.s == t)[0]
        js_live, Xl = L.live_X(x, t, names)
        pos = {int(j): i for i, j in enumerate(js_live)}
        common = [(r, pos[int(mj[r])]) for r in rows if int(mj[r]) in pos]
        only_store = int(len(rows) - len(common)); only_live = int(len(js_live) - len(common))
        ri = np.array([a for a, _ in common]); li = np.array([b for _, b in common])
        Xs = np.asarray(st.X[ri]); Xv = Xl[li]
        both_nan = np.isnan(Xs) & np.isnan(Xv)
        nan_mismatch = int((np.isnan(Xs) ^ np.isnan(Xv)).sum())
        diff = np.where(both_nan, 0.0, np.abs(Xs.astype(np.float64) - Xv.astype(np.float64)))
        diff[np.isnan(diff)] = 0.0
        pct_cols = [k for k, n in enumerate(names) if n.startswith('pct_')]
        raw_cols = [k for k in range(len(names)) if k not in set(pct_cols)]
        d_pct = diff[:, pct_cols]; d_raw = diff[:, raw_cols]
        exact_pct = float((d_pct == 0).mean()); exact_raw = float((d_raw == 0).mean())
        print(f'\n── {d}（t={t}）：資料集 {len(rows)} 列、live {len(js_live)} 列、共同 {len(common)}；只在資料集 {only_store}、只在 live {only_live}（＝ s+1 無收盤／s+1 結構斷點的 {only_live} 列）')
        print(f'   非百分位欄（{len(raw_cols)} 欄）：完全相同 {exact_raw * 100:.3f}%，最大差 {d_raw.max():.3g}；百分位欄（{len(pct_cols)} 欄）：完全相同 {exact_pct * 100:.2f}%，'
              f'最大差 {d_pct.max():.4f}，差>0.002 的格 {(d_pct > 0.002).mean() * 100:.4f}%、>0.01 的格 {(d_pct > 0.01).mean() * 100:.5f}%；NaN 不一致 {nan_mismatch} 格')
        bad = [(names[k], float(diff[:, k].max())) for k in raw_cols if diff[:, k].max() > 1e-6]
        if bad: print('   ⚠ 非百分位欄有差異：', bad[:8])
        ok = (not bad) and nan_mismatch == 0 and only_store == 0 and d_pct.max() < 0.05
        ok_all &= ok
        print('   →', 'PASS' if ok else 'FAIL')
    print('\n總結：', 'PASS' if ok_all else 'FAIL')
    return ok_all


def selftest() -> bool:
    """以 L.fit_job 的同一條路重現 a32 快取：ALL、y、2026-09、seed 1（訓練 s < 2026-09 首日索引 − 2 ⇒ s ≤ t0 − 3）。"""
    st = L.Store()
    t0 = int(np.searchsorted(st.dates, '2026-09-01'))
    cutoff = t0 - 3
    tag = 'ALL_y_202609_s1'
    t_start = time.time()
    rows, tr, w = L.train_rows(st, cutoff, 1, tag)
    ref = np.load(f'{L.SP}/a32_walkforward_sc_{tag}.npz', allow_pickle=False)
    info = __import__('json').loads(str(ref['info']))
    print(f'重現 {tag}：本地訓練列 {len(rows):,}（a32：{info["train_rows_full"]:,}）、fit 列 {len(tr):,}（a32：{info["fit_rows"]:,}）、正例 {int(st.y[rows].sum())}（a32：{info["train_pos"]}）')
    if len(tr) != info['fit_rows']:
        print('FAIL：fit 列數不同'); return False
    Xtr = np.asarray(st.X[tr])
    m = L.FastGBDT(seed=1, **L.PARAMS).fit(Xtr, st.y[tr], w=w)
    sc_rows = ref['rows']
    pick = sc_rows[np.isin(st.s[sc_rows], np.arange(t0, t0 + 6))]           # 9 月前 6 個交易日
    sc = m.decision_function(np.asarray(st.X[pick]), n_trees=600)
    refsc = ref['score_600'][np.searchsorted(sc_rows, pick)]
    d = np.abs(sc - refsc.astype(np.float64))
    print(f'分數差：最大 {d.max():.3g}、平均 {d.mean():.3g}（float32 儲存的量化誤差量級 ~1e-6）；耗時 {time.time() - t_start:.0f}s')
    ok = d.max() < 1e-4
    print('→', 'PASS' if ok else 'FAIL')
    # ── 第二段：live 建構的特徵＋同一個模型 ⇒ 與 a32 快取分數比對（端對端：特徵路徑＋模型路徑）──
    x = L.build_ctx(); M = np.load(L.META_PATH); mj = M['m_j']
    for day in ('2026-09-15', '2026-09-30'):
        t = x.dates.index(day)
        js, Xl = L.live_X(x, t, st.names)
        sl = m.decision_function(Xl, n_trees=600)
        idx = np.nonzero(st.s == t)[0]
        pos = {int(j): i for i, j in enumerate(js)}
        pr = [(r, pos[int(mj[r])]) for r in idx if int(mj[r]) in pos]
        a = np.array([refpos for refpos, _ in pr]); b = np.array([lp for _, lp in pr])
        ref_sc = ref['score_600'][np.searchsorted(sc_rows, a)].astype(np.float64); live_sc = sl[b]
        d2 = np.abs(ref_sc - live_sc)
        top = lambda v, k: set(np.argsort(-v, kind='stable')[:k])
        o10 = len(top(ref_sc, 10) & top(live_sc, 10)); o30 = len(top(ref_sc, 30) & top(live_sc, 30))
        q = np.percentile(d2, 99.9)
        print(f'live vs a32 快取（{day}，共同 {len(pr)} 列）：分數差（logit）平均 {d2.mean():.5f}、99.9 百分位 {q:.4f}、最大 {d2.max():.4f}（個別列因百分位差 ≤0.003 跨過樹分裂點）；前 10 重疊 {o10}/10、前 30 重疊 {o30}/30')
        ok &= (o10 >= 9) and (o30 >= 28) and d2.mean() < 0.02
    print('→', 'PASS' if ok else 'FAIL')
    return ok


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    ok = parity(args or DEFAULT_DAYS)
    if '--selftest' in sys.argv: ok = selftest() and ok
    sys.exit(0 if ok else 1)
