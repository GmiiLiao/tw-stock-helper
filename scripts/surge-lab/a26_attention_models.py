"""(1) 跨目標：T1／T2 的外樣本分數能不能偵測「進入注意股」，反過來亦然（以 (s,j) 對齊的交集列）。
   (2) 注意股歷史（前視安全）加入 T1／T2 模型的增益；以及在「近 20 日沒進過注意股」的乾淨母體內的表現。"""
import numpy as np, pandas as pd, warnings, os
import build as B, attention as AT, evallib as E
from models import HistGBDT
from run_cv import run, GB
warnings.filterwarnings('ignore')
pd.set_option('display.width', 220)
SP = B.SP
def load(dsname, label=''):
    os.environ['SURGE_DATASET'] = dsname; os.environ['SURGE_LABEL'] = label
    import importlib; importlib.reload(E)
    D = E.load(primary_only=True); O = np.load(f'{SP}/oof{E.TAG}.npz'); d = np.load(f'{SP}/{E.DATASET}')
    ex = d['m_extra'].astype(bool) if 'm_extra' in d.files else np.zeros(len(O['gbdt_rank']), bool)
    return D, O['gbdt_rank'][~ex], E.TAG
Dt1, sc1, _ = load('dataset_t1.npz'); Dt2, sc2, _ = load('dataset_t2.npz'); Da1, sca1, _ = load('dataset_at.npz'); Da10, sca10, _ = load('dataset_at.npz', 'yh10')
key = lambda D: D['s'].astype(np.int64) * 100000 + D['j']
def cross(Dsrc, ssrc, Dtgt, stgt, name_src, name_tgt):
    """src 模型分數在 tgt 標籤上的外樣本表現（交集列）；同時給 tgt 自己的分數作對照。"""
    ks, kt = key(Dsrc), key(Dtgt); common = np.intersect1d(ks, kt)
    ps = pd.Series(np.arange(len(ks)), index=ks).loc[common].values; pt = pd.Series(np.arange(len(kt)), index=kt).loc[common].values
    a, b = ssrc[ps], stgt[pt]; y = Dtgt['y'][pt]; s = Dtgt['s'][pt]; m = np.isfinite(a) & np.isfinite(b)
    r1 = E.topk_table(a[m], s[m], y[m], Ks=(10,)); r2 = E.topk_table(b[m], s[m], y[m], Ks=(10,))
    print(f'{name_src}→{name_tgt}：交集 {int(m.sum()):,} 列、事件 {int(y[m].sum())}；跨目標 同日AUC {E.within_day_auc(a[m], s[m], y[m]):.3f} lift@10 {r1[0].lift[0]:.1f}｜目標自己 同日AUC {E.within_day_auc(b[m], s[m], y[m]):.3f} lift@10 {r2[0].lift[0]:.1f}')
print('— (1) 跨目標偵測 —')
cross(Dt1, sc1, Da10, sca10, 'T1模型', '進注意≤10日'); cross(Dt2, sc2, Da10, sca10, 'T2模型', '進注意≤10日')
cross(Da10, sca10, Dt1, sc1, '進注意≤10日模型', 'T1起漲'); cross(Da10, sca10, Dt2, sc2, '進注意≤10日模型', 'T2起漲')
cross(Dt1, sc1, Da1, sca1, 'T1模型', '進注意前1日'); cross(Da1, sca1, Dt1, sc1, '進注意前1日模型', 'T1起漲')
# ── (2) 注意股歷史特徵 ──
dates, codes, P = B.load_panel(); T = len(dates)
A = AT.build_matrices(dates, codes); PF = AT.pit_features(A, T)
print('\n— (2) 注意股歷史（PIT：僅用 pub≤s−1）加入 T1／T2 —')
for tname, dsname in (('T1', 'dataset_t1.npz'), ('T2', 'dataset_t2.npz')):
    os.environ['SURGE_DATASET'] = dsname; os.environ['SURGE_LABEL'] = ''
    import importlib; importlib.reload(E)
    D = E.load(primary_only=True); R = E.rank_features(D); s, j, y = D['s'], D['j'], D['y']
    O = np.load(f'{SP}/oof{E.TAG}.npz'); d = np.load(f'{SP}/{E.DATASET}'); ex = d['m_extra'].astype(bool) if 'm_extra' in d.files else np.zeros(len(O['gbdt_rank']), bool)
    sc0 = O['gbdt_rank'][~ex]; m0 = np.isfinite(sc0)
    EX = np.stack([PF[k][s, j] for k in ('at_cnt5', 'at_cnt20', 'at_cnt60', 'at_rise20', 'at_since', 'at_cnt250')], 1).astype(np.float32)
    oof = run(D, np.hstack([R, EX]), lambda: HistGBDT(**GB), 'with_att'); m1 = np.isfinite(oof)
    def met(sc, m): 
        t, _ = E.topk_table(sc[m], s[m], y[m], Ks=(10, 20)); return E.within_day_auc(sc[m], s[m], y[m]), t.lift[0], t.lift[1], int(y[m].sum())
    print(f'{tname}: 無注意股特徵 同日AUC {met(sc0, m0)[0]:.3f} lift@10/20 {met(sc0, m0)[1]:.1f}/{met(sc0, m0)[2]:.1f}｜加入 {met(oof, m1)[0]:.3f} {met(oof, m1)[1]:.1f}/{met(oof, m1)[2]:.1f}（事件 {met(oof, m1)[3]}）')
    clean = m0 & (PF['at_cnt20'][s, j] == 0)
    print(f'     近 20 日未進過注意股的乾淨母體（事件 {int(y[clean].sum())}／全部 {int(y[m0].sum())}＝{y[clean].sum()/y[m0].sum()*100:.0f}%）：同日AUC {met(sc0, clean)[0]:.3f} lift@10/20 {met(sc0, clean)[1]:.1f}/{met(sc0, clean)[2]:.1f}')
    # 事件率對注意股歷史
    nday = np.bincount(s, minlength=T); pday = np.bincount(s, weights=y, minlength=T); rate_row = (pday / np.maximum(nday, 1))[s]
    for lab, mm in (('近20日有注意', PF['at_cnt20'][s, j] > 0), ('近5日有注意', PF['at_cnt5'][s, j] > 0), ('近20日無注意', PF['at_cnt20'][s, j] == 0), ('近250日從未注意', PF['at_cnt250'][s, j] == 0)):
        print(f'     {lab}: 列 {int(mm.sum()):,} 事件率 {y[mm].mean()*100:.3f}% lift {y[mm].sum()/rate_row[mm].sum():.2f}')
