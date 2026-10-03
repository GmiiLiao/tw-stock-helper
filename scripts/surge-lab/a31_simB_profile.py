"""a31-B 步驟 1：全部「漲停前一日」的逐參數統計比對＋「相似處計數」公式（使用者原始想法的直接實作）。

1. 每個參數（123 個 f_*／x_*，同日百分位）在 DESIGN 期：正例（隔日漲停）vs 負例的中位數、同日百分位 AUC、
   正例落在負例分布前 10% 的比例（相似處強度），分「新起漲（s 日未漲停）」與「延續（s 日已漲停）」兩群。
2. 相似處公式：
   · COUNT：每參數切 10 分位箱，DESIGN 上計算 似然比 LR＝P(箱|正例)/P(箱|負例)；股票落在 LR≥1.5 的箱即「一處相似」，
     分數＝相似處個數（使用者原意：「有多少相似的地方就帶入公式」）。
   · NB：同一張表的 log LR 加總（＝樸素貝氏；COUNT 的加權版）。
   兩者皆分群（新起漲／延續）各算一張表，並加上群內先驗 log odds。
輸出：out/a31_simB_profile.csv、.surge-cache/a31_simB_scores_profile.npz；印 VALID／TEST 前緣。
"""
import numpy as np, pandas as pd
import a31_simB_common as C

NB_BINS = 10
LR_MATCH = 1.5


def auc_from_scores(x, y):
    o = np.argsort(x, kind='mergesort'); r = np.empty(len(x)); r[o] = np.arange(1, len(x) + 1)
    # 同值平均名次
    xs = x[o]; b = np.r_[0, np.nonzero(np.diff(xs))[0] + 1, len(xs)]
    for a, e in zip(b[:-1], b[1:]):
        if e - a > 1: r[o[a:e]] = (a + 1 + e) / 2
    n1 = y.sum(); n0 = len(y) - n1
    return (r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)


def profile_table(D, R):
    des = D['split'] == 0; y = D['y'].astype(bool); lu = D['lu_s'].astype(bool)
    rows = []
    rng = np.random.default_rng(0)
    for grp, gm in (('fresh', ~lu), ('cont', lu)):
        m = des & gm
        # AUC 用抽樣負例加速（正例全取）
        pos = np.nonzero(m & y)[0]; neg = np.nonzero(m & ~y)[0]
        neg = neg if len(neg) <= 200000 else rng.choice(neg, 200000, replace=False)
        ii = np.r_[pos, neg]; yy = np.r_[np.ones(len(pos)), np.zeros(len(neg))]
        for k, nm in enumerate(D['names']):
            x = R[ii, k].astype(np.float64)
            rawp = D['X'][pos, k]; rawn = D['X'][neg, k]
            q90 = np.quantile(R[neg, k], 0.9); q10 = np.quantile(R[neg, k], 0.1)
            rows.append(dict(group=grp, feature=nm, auc=auc_from_scores(x, yy),
                             pos_med_pct=float(np.median(R[pos, k])), neg_med_pct=float(np.median(R[neg, k])),
                             pos_med_raw=float(np.nanmedian(rawp)), neg_med_raw=float(np.nanmedian(rawn)),
                             pos_share_top10=float((R[pos, k] > q90).mean()), pos_share_bot10=float((R[pos, k] < q10).mean())))
    T = pd.DataFrame(rows)
    T['sep'] = (T['auc'] - 0.5).abs()
    return T.sort_values(['group', 'sep'], ascending=[True, False])


def lr_tables(D, R, gm):
    """DESIGN 上每參數 10 分位箱的 log LR（加 1 平滑）。"""
    des = D['split'] == 0; y = D['y'].astype(bool)
    B = np.minimum((R * NB_BINS).astype(np.int16), NB_BINS - 1)
    m = des & gm
    LR = np.zeros((R.shape[1], NB_BINS))
    for k in range(R.shape[1]):
        cp = np.bincount(B[m & y, k], minlength=NB_BINS) + 1.0; cn = np.bincount(B[m & ~y, k], minlength=NB_BINS) + 1.0
        LR[k] = np.log((cp / cp.sum()) / (cn / cn.sum()))
    prior = np.log(y[m].mean() / (1 - y[m].mean()))
    return LR, prior, B


def score_profile(D, R):
    lu = D['lu_s'].astype(bool)
    nb = np.zeros(len(lu)); cnt = np.zeros(len(lu))
    for gm in (~lu, lu):
        LR, prior, B = lr_tables(D, R, gm)
        ii = np.nonzero(gm)[0]
        Lsum = np.zeros(len(ii)); Lcnt = np.zeros(len(ii))
        for k in range(R.shape[1]):
            v = LR[k][B[ii, k]]
            Lsum += v; Lcnt += (v >= np.log(LR_MATCH))
        nb[ii] = prior + Lsum
        cnt[ii] = Lcnt + 1000 * (prior > -2)        # 延續群（先驗 ~21%）整體排在新起漲群之前：相似處數相同時先選延續
    return nb, cnt


def main():
    D = C.load(); R = C.ranks(D)
    T = profile_table(D, R)
    T.to_csv(f'{C.OUT}/a31_simB_profile.csv', index=False, float_format='%.4f')
    for g in ('fresh', 'cont'):
        print(f'\n=== {g}：DESIGN 單參數分離度前 25（AUC 為同日百分位；pos_share_top10＝正例落在負例前10%的比例，隨機＝10%）')
        print(T[T.group == g].head(25)[['feature', 'auc', 'pos_med_pct', 'neg_med_pct', 'pos_med_raw', 'neg_med_raw', 'pos_share_top10', 'pos_share_bot10']].to_string(index=False))
        tt = T[T.group == g]
        print(f'  {g}：|AUC-0.5|>0.10 的參數 {int((tt.sep > 0.10).sum())} 個、>0.05 {int((tt.sep > 0.05).sum())} 個、<0.02 {int((tt.sep < 0.02).sum())} 個（共 {len(tt)}）')
    nb, cnt = score_profile(D, R)
    np.savez_compressed(f'{C.SP}/a31_simB_scores_profile.npz', nb=nb.astype(np.float32), cnt=cnt.astype(np.float32))
    lu = D['lu_s'].astype(bool)
    for nm, sc in (('COUNT（相似處個數）', cnt), ('NB（log LR 加總）', nb)):
        for sp, spn in ((1, 'VALID'), (2, 'TEST')):
            print(f'\n--- {nm} {spn} 前緣（全部列）')
            for r in C.frontier(sc, D, split=sp): print('  ' + C.fmt(r))
        # 延續群內／新起漲群內分開排
        for gname, gm in (('fresh', ~lu), ('cont', lu)):
            print(f'--- {nm} TEST 前緣（只在 {gname} 群內排序）')
            for r in C.frontier(np.where(gm, sc, -np.inf), D, split=2, tops=(30, 100, 300, 1000)): print('  ' + C.fmt(r))
    # COUNT 的分數分布：相似處 ≥ x 個時的精確度（新起漲群，TEST）
    print('\n--- 新起漲群：相似處個數 ≥ x 的精確度（DESIGN／VALID／TEST）')
    fresh_cnt = np.where(~lu, cnt, np.nan)
    for x in range(20, 80, 5):
        m = fresh_cnt >= x
        out = []
        for sp in (0, 1, 2):
            st = C.stats(m, D, D['split'] == sp); out.append(f"{st['n']:>7} {st['prec'] * 100:5.2f}%")
        print(f'  ≥{x:>2} 處：' + ' | '.join(out))
    print('\n--- 延續群：相似處個數 ≥ x 的精確度（DESIGN／VALID／TEST）')
    cont_cnt = np.where(lu, cnt - 1000, np.nan)
    for x in range(10, 80, 5):
        m = cont_cnt >= x
        out = []
        for sp in (0, 1, 2):
            st = C.stats(m, D, D['split'] == sp); out.append(f"{st['n']:>7} {st['prec'] * 100:5.2f}% buy {st['buy'] * 100:4.1f}%")
        print(f'  ≥{x:>2} 處：' + ' | '.join(out))


if __name__ == '__main__':
    main()
