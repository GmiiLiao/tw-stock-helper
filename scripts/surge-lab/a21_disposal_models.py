"""官方處置名單相關的外樣本檢驗（T1／T2 各跑一次）：
  (A) AI 波段候選池口徑：排除「處置中」與「當晚公告」→ (a) 沿用全母體模型分數重新排名 (b) 只用該母體重訓
  (B) 加入官方處置歷史特徵（在處置、近20/60日處置日數、距上次處置、近250日處置次數）與市場別（上櫃）→ 全母體與 (A) 母體各測
  (C) 市場別拆開看（上市／上櫃）：同日 AUC 與 lift"""
import numpy as np, pandas as pd, json, warnings
import evallib as E, disposal as DP
from models import HistGBDT
from run_cv import run, GB
warnings.filterwarnings('ignore')
pd.set_option('display.width', 220)
D = E.load(primary_only=True); R = E.rank_features(D); names = D['names']; s, j, y = D['s'], D['j'], D['y']; dates = np.array(D['dates']); codes = D['codes']; T = len(dates)
Z = np.load(f'{E.B.SP}/disposal_mats.npz'); KNOWN, PUB = Z['KNOWN'], Z['PUB']
F = DP.features({'KNOWN': KNOWN}, T)
IN = KNOWN[s, j]; PEND = PUB[s, j] & ~IN; DISPX = IN | PEND
mk = json.load(open(f'{E.B.SP}/code_market.json')); market = np.array([mk.get(c, '?') for c in codes])[j]
O = np.load(f'{E.B.SP}/oof{E.TAG}.npz'); sc_full = O['gbdt_rank']
_d = np.load(f'{E.B.SP}/{E.DATASET}'); ex = _d['m_extra'].astype(bool) if 'm_extra' in _d.files else np.zeros(len(sc_full), bool)
sc0 = sc_full[~ex]; test0 = np.isfinite(sc0)
rk_ = {k: D[k] for k in ['o_c5', 'o_c10', 'o_c20', 'locked_open']}; rk_['s'] = s

def metr(score, mask, Ks=(5, 10, 20, 50)):
    t, base = E.topk_table(score[mask], s[mask], y[mask], Ks=Ks)
    r = dict(n_pos=int(y[mask].sum()), base=base * 100, wdAUC=E.within_day_auc(score[mask], s[mask], y[mask]))
    for _, x in t.iterrows(): r[f'lift@{int(x.K)}'] = x.lift; r[f'recall@{int(x.K)}'] = x.recall * 100
    return r

def block_ci(ex_, L, n=2000, seed=3):
    Tn = len(ex_); rng = np.random.default_rng(seed); nb = int(np.ceil(Tn / L)); m = []
    for _ in range(n):
        st = rng.integers(0, Tn, nb); idx = ((st[:, None] + np.arange(L)[None, :]).ravel()[:Tn]) % Tn; m.append(ex_[idx].mean())
    return np.percentile(m, [2.5, 97.5])

def returns(score, mask, label):
    out = []
    for h, L in (('o_c5', 5), ('o_c10', 10), ('o_c20', 20)):
        uni = E.universe_returns(s, rk_, mask, hold=h); pk = E.pick_returns(score, s, rk_, 10, mask=mask, hold=h)
        dp = pk.groupby('s').ret.mean(); du = uni.groupby('s').ret.mean(); jn = pd.concat([dp, du], axis=1, keys=['p', 'u']).dropna().sort_index(); ex_ = (jn.p - jn.u).values
        lo, hi = block_ci(ex_, L)
        out.append(f'{h[2:]}: 選股{pk.ret.mean()*100:5.2f}% 母體{uni.ret.mean()*100:5.2f}% 超額{ex_.mean()*100:5.2f}% [{lo*100:.2f},{hi*100:.2f}] 中位{pk.ret.median()*100:.2f}% 跌>10%:{(pk.ret<-0.1).mean()*100:.1f}%')
    print(f'    {label}\n      ' + '\n      '.join(out))

print(f'===== {E.TAG.strip("_").upper()}')
# (A)
mA = test0 & ~DISPX
r = metr(sc0, test0); print(f'基準（全母體）: 事件 {r["n_pos"]} wdAUC {r["wdAUC"]:.3f} lift@10 {r["lift@10"]:.2f} 召回@10 {r["recall@10"]:.1f}%')
r = metr(sc0, mA); print(f'(A-a) 非處置母體、沿用模型分數: 事件 {r["n_pos"]} 基準率 {r["base"]:.3f}% wdAUC {r["wdAUC"]:.3f} lift@5/10/20/50 {r["lift@5"]:.1f}/{r["lift@10"]:.1f}/{r["lift@20"]:.1f}/{r["lift@50"]:.1f} 召回@10 {r["recall@10"]:.1f}%')
returns(sc0, mA, '(A-a) 固定持有（前10名／日）')
oofA = run(D, R, lambda: HistGBDT(**GB), 'nondisp', cols=None) if False else None
# (A-b) 重訓：訓練只用非處置列
class Sub: pass
sel = np.nonzero(~DISPX)[0]
Dsub = {k: (v[sel] if isinstance(v, np.ndarray) and len(v) == len(s) else v) for k, v in D.items()}
oofb_sub = run(Dsub, R[sel], lambda: HistGBDT(**GB), 'nondisp')
oofb = np.full(len(s), np.nan); oofb[sel] = oofb_sub; mb = np.isfinite(oofb)
r = metr(oofb, mb); print(f'(A-b) 非處置母體、只用該母體重訓: 事件 {r["n_pos"]} wdAUC {r["wdAUC"]:.3f} lift@5/10/20/50 {r["lift@5"]:.1f}/{r["lift@10"]:.1f}/{r["lift@20"]:.1f}/{r["lift@50"]:.1f} 召回@10 {r["recall@10"]:.1f}%')
returns(oofb, mb, '(A-b) 固定持有（前10名／日）')
# (B) 加入官方處置歷史＋市場別
EXTRA = np.stack([F['dp_in'][s, j], F['dp_cnt20'][s, j], F['dp_cnt60'][s, j], F['dp_since'][s, j], F['dp_n250'][s, j], (market == 'otc').astype(np.float32)], 1).astype(np.float32)
RX = np.hstack([R, EXTRA])
oofx = run(D, RX, lambda: HistGBDT(**GB), 'with_disp')
mx = np.isfinite(oofx)
r0 = metr(sc0, test0); r1 = metr(oofx, mx)
print(f'(B) 加入處置歷史＋市場別（全母體）: wdAUC {r1["wdAUC"]:.3f}（無：{r0["wdAUC"]:.3f}）lift@10 {r1["lift@10"]:.2f}（{r0["lift@10"]:.2f}）召回@10 {r1["recall@10"]:.1f}%（{r0["recall@10"]:.1f}%）')
r0 = metr(sc0, mA); r1 = metr(oofx, mx & ~DISPX)
print(f'(B) 同上、在非處置母體內評估: wdAUC {r1["wdAUC"]:.3f}（無：{r0["wdAUC"]:.3f}）lift@10 {r1["lift@10"]:.2f}（{r0["lift@10"]:.2f}）召回@10 {r1["recall@10"]:.1f}%（{r0["recall@10"]:.1f}%）')
# 只加市場別 / 只加處置歷史（歸因）
for lab, cols in (('只加市場別(is_otc)', [EXTRA.shape[1] - 1]), ('只加處置歷史(5項)', list(range(5)))):
    RXs = np.hstack([R, EXTRA[:, cols]]); o = run(D, RXs, lambda: HistGBDT(**GB), lab); mm = np.isfinite(o) & ~DISPX
    r1 = metr(o, mm); print(f'    {lab}（非處置母體內）: wdAUC {r1["wdAUC"]:.3f} lift@10 {r1["lift@10"]:.2f}')
# (C) 市場別
print('(C) 市場別（全母體模型分數；各自在市場內排名）：')
for mkt in ('tse', 'otc'):
    m = test0 & (market == mkt); r = metr(sc0, m); print(f'    {mkt}: 事件 {r["n_pos"]} 基準率 {r["base"]:.3f}% wdAUC {r["wdAUC"]:.3f} lift@10 {r["lift@10"]:.2f} 召回@10 {r["recall@10"]:.1f}%')
