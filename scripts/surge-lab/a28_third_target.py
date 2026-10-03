"""第三個訓練目標「10 日內進入漲幅型注意股」(ATT10)：與 T1／T2 的標籤交叉驗證，以及三模型集成的外樣本評估。
對齊方式：三份資料集的主要母體列以 (s, 代號) 取交集（三個 OOF 分數都存在的測試期列）。"""
import numpy as np, pandas as pd, os, warnings
import evallib as E
warnings.filterwarnings('ignore')
pd.set_option('display.width', 220)
SP = E.B.SP
def load(ds, label=''):
    d = np.load(f'{SP}/{ds}'); ex = d['m_extra'].astype(bool) if 'm_extra' in d.files else np.zeros(len(d['m_s']), bool)
    tag = '_' + os.path.splitext(ds)[0].replace('dataset_', '') + (('_' + label) if label else '')
    O = np.load(f'{SP}/oof{tag}.npz')
    y = d[f'm_{label}'] if label else d['m_y']
    k = d['m_s'].astype(np.int64)[~ex] * 100000 + d['m_j'][~ex]
    return pd.DataFrame({'k': k, 's': d['m_s'][~ex], 'y': y[~ex].astype(np.int8), 'sc': O['gbdt_rank'][~ex]})
t1 = load('dataset_t1.npz'); t2 = load('dataset_t2.npz'); a10 = load('dataset_at.npz', 'yh10'); a1 = load('dataset_at.npz')
m = t1.merge(t2[['k', 'y', 'sc']], on='k', suffixes=('_t1', '_t2')).merge(a10[['k', 'y', 'sc']].rename(columns={'y': 'y_a10', 'sc': 'sc_a10'}), on='k')
m = m.dropna(subset=['sc_t1', 'sc_t2', 'sc_a10'])
print(f'三目標交集測試列 {len(m):,}；事件 T1 {int(m.y_t1.sum())}、T2 {int(m.y_t2.sum())}、ATT10 {int(m.y_a10.sum())}')
# ── 標籤交叉驗證 ──
print('\n— 標籤一致性（同一 (s, 代號)）—')
for a, b in (('y_t1', 'y_a10'), ('y_t2', 'y_a10'), ('y_t1', 'y_t2')):
    pa = m[m[a] == 1][b].mean(); pb = m[m[b] == 1][a].mean()
    print(f'  P({b}=1 | {a}=1) = {pa*100:.1f}%；P({a}=1 | {b}=1) = {pb*100:.1f}%；基準 P({b}=1) = {m[b].mean()*100:.2f}%')
union = (m.y_t1 | m.y_t2).astype(int)
print(f'  ATT10 事件中「次日即 T1 或 T2 起漲」的比例 {m[m.y_a10 == 1].pipe(lambda g: (g.y_t1 | g.y_t2).mean())*100:.1f}%（其餘＝起漲日不在次日、或較緩的上漲）')
# ── 集成 ──
for c in ('sc_t1', 'sc_t2', 'sc_a10'):
    m['r_' + c] = m.groupby('s')[c].rank(pct=True)
m['ens3'] = (m.r_sc_t1 + m.r_sc_t2 + m.r_sc_a10) / 3
m['ens_t1a'] = (m.r_sc_t1 + m.r_sc_a10) / 2
m['ens_t2a'] = (m.r_sc_t2 + m.r_sc_a10) / 2
def ev(sc, y):
    t, base = E.topk_table(m[sc].values, m.s.values, m[y].values, Ks=(10, 20, 50))
    return E.within_day_auc(m[sc].values, m.s.values, m[y].values), t.lift[0], t.lift[1], t.lift[2]
rows = []
for score in ('sc_t1', 'sc_t2', 'sc_a10', 'ens_t1a', 'ens_t2a', 'ens3'):
    r = {'分數': score}
    for lab in ('y_t1', 'y_t2', 'y_a10'):
        a, l10, l20, l50 = ev(score, lab); r[f'{lab} AUC'] = a; r[f'{lab} lift@10'] = l10; r[f'{lab} lift@50'] = l50
    rows.append(r)
R = pd.DataFrame(rows); print('\n— 外樣本（交集列）：各分數在三個標籤上的同日 AUC／lift —'); print(R.round(3).to_string(index=False))
# 依日 block bootstrap：ens vs 單一模型的 AUC 差
def wd_by_day(sc, y):
    r = m.groupby('s')[sc].rank(pct=True); return pd.DataFrame({'s': m.s, 'r': r, 'y': m[y]}).query('y == 1').groupby('s').r.agg(['sum', 'count'])
for lab, base_sc in (('y_t1', 'sc_t1'), ('y_t2', 'sc_t2')):
    A = wd_by_day('ens3', lab); Bq = wd_by_day(base_sc, lab); days = sorted(set(m.s))
    Sa = A.reindex(days).fillna(0); Sb = Bq.reindex(days).fillna(0)
    rng = np.random.default_rng(5); T = len(days); L = 20; nb = int(np.ceil(T / L)); d = []
    for _ in range(1000):
        st = rng.integers(0, T, nb); idx = ((st[:, None] + np.arange(L)[None, :]).ravel()[:T]) % T
        d.append(Sa['sum'].values[idx].sum() / max(Sa['count'].values[idx].sum(), 1) - Sb['sum'].values[idx].sum() / max(Sb['count'].values[idx].sum(), 1))
    print(f'集成(3) − {base_sc} 在 {lab}：同日 AUC 差 {np.mean(d):+.4f}，區塊 95% CI [{np.percentile(d,2.5):+.4f}, {np.percentile(d,97.5):+.4f}]')
