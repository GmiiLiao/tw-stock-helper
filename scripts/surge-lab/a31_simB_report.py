"""a31-B 步驟 4：彙整所有相似度／模型分數 → 協定報表（DESIGN／VALID／TEST、Wilson、可買精確度、前緣、新起漲 vs 延續）。

分數來源（先跑 a31_simB_profile.py、a31_simB_knn.py U/A/T15、a31_simB_gbdt.py 各模型）：
  COUNT／NB（相似處個數／樸素貝氏）、kNN_<W>_k<k>、CENT_<W>、GBDT_<name>（DESIGN 模型）、GBDTdv_<name>（DESIGN＋VALID 重訓，只做每日前 K）
選擇器：
  · 每日前 k 名（k＝1/3/10）
  · 門檻：在 VALID 找使 VALID 精確度 ≥ 目標（50～90%）且 ≥30 筆的最低分數門檻，原封不動套到 TEST
輸出：out/a31_simB_selectors.csv、out/a31_simB_frontier.csv；印摘要。
"""
import os, json
import numpy as np, pandas as pd
import a31_simB_common as C

TARGETS = (0.5, 0.6, 0.7, 0.8, 0.9)


def load_scores(D):
    lu = D['lu_s'].astype(bool); n = len(lu)
    S = {}
    p = np.load(f'{C.SP}/a31_simB_scores_profile.npz'); S['COUNT'] = p['cnt']; S['NB'] = p['nb']
    for w in ('U', 'A', 'T15'):
        f = f'{C.SP}/a31_simB_knn_{w}.npz'
        if not os.path.exists(f): continue
        z = np.load(f)
        for i, k in enumerate(z['ks']): S[f'kNN_{w}_k{k}'] = z['knn'][:, i]
        S[f'CENT_{w}'] = z['cent']
    g = {}
    for nm in ('ALL_y', 'ALL_buy', 'FRESH_y', 'FRESH_buy', 'CONT_y', 'CONT_buy'):
        f = f'{C.SP}/a31_simB_gbdt_{nm}.npz'
        if os.path.exists(f): g[nm] = np.load(f)
    for nm, z in g.items():
        S[f'GBDT_{nm}'] = z['score_des']; S[f'GBDTdv_{nm}'] = z['score_dv']
    for t in ('y', 'buy'):                                     # 分群模型合併（兩者皆為校準後 log-odds）
        if f'FRESH_{t}' in g and f'CONT_{t}' in g:
            S[f'GBDT_SPLIT_{t}'] = np.where(lu, g[f'CONT_{t}']['score_des'], g[f'FRESH_{t}']['score_des'])
            S[f'GBDTdv_SPLIT_{t}'] = np.where(lu, g[f'CONT_{t}']['score_dv'], g[f'FRESH_{t}']['score_dv'])
    return S


def selector_rows(name, sc, D, scope_mask, scope):
    """每日前 k、VALID 門檻選擇器的 DESIGN／VALID／TEST 統計。"""
    rows = []
    sc = np.where(scope_mask & np.isfinite(sc), sc, -np.inf)
    rid = C.rank_in_day(sc, D['s'])
    valid_has = np.isfinite(sc[D['split'] == 1]).any()
    for k in (1, 3, 10):
        m = (rid < k) & np.isfinite(sc)
        rows.append(_row(name, scope, f'top{k}/day', m, D))
    if valid_has and not name.startswith('GBDTdv'):
        for t in TARGETS:
            th = C.threshold_from_valid(np.where(np.isfinite(sc), sc, -np.inf), D, t)
            if th is None:
                rows.append(dict(score=name, scope=scope, rule=f'VALID≥{int(t * 100)}%', note='VALID 達不到')); continue
            m = np.isfinite(sc) & (sc >= th)
            rows.append(_row(name, scope, f'VALID≥{int(t * 100)}% (θ={th:.4g})', m, D))
    return rows


def _row(name, scope, rule, m, D):
    r = dict(score=name, scope=scope, rule=rule)
    for sp, nm in ((0, 'DES'), (1, 'VAL'), (2, 'TEST')):
        st = C.stats(m, D, D['split'] == sp)
        r[f'{nm}_n'] = st['n']; r[f'{nm}_prec'] = st['prec']
        if nm == 'TEST':
            r.update(TEST_wlb=st['wlb'], TEST_buy=st['buy'], TEST_days=st['days'], TEST_ppd=st['ppd'], TEST_cont=st['cont'])
    return r


def book_exploratory(D):
    """尾盤五檔（47 日、全在 TEST 內）：前 23 日選門檻、後 24 日驗證——僅探索，不屬協定。"""
    z = np.load(C.DS)
    has = z['x_bd_has'] == 1; qv = z['x_bd_q_v']; bidlim = z['x_bd_bidlim']
    lu = D['lu_s'] == 1; s = D['s']
    days = np.unique(s[has]); cut = days[len(days) // 2]
    out = []
    for nm, x in (('q_v', qv), ('bidlim', bidlim)):
        base = has & lu & np.isfinite(x)
        a = base & (s < cut); b = base & (s >= cut)
        for q in (0.5, 0.75, 0.9, 0.95):
            th = np.quantile(x[a], q)
            for lab, mm in (('first-half', a), ('second-half', b)):
                sel = mm & (x >= th)
                k = int(D['y'][sel].sum()); n = int(sel.sum())
                out.append(dict(feat=nm, q=q, th=float(th), half=lab, n=n, prec=k / n if n else np.nan, wlb=C.wilson_lb(k, n) if n else np.nan,
                                buy=D['buy_lu'][sel].mean() if n else np.nan, base=D['y'][mm].mean()))
    return pd.DataFrame(out)


def main():
    D = C.load(); S = load_scores(D)
    lu = D['lu_s'].astype(bool)
    rows, front = [], []
    for name, sc in S.items():
        scopes = [('all', np.ones(len(lu), bool)), ('fresh', ~lu), ('cont', lu)]
        if name.startswith('CENT') or name in ('GBDT_FRESH_y', 'GBDT_FRESH_buy', 'GBDTdv_FRESH_y', 'GBDTdv_FRESH_buy'):
            scopes = [s for s in scopes if s[0] != 'all' and (not name.startswith(('GBDT_FRESH', 'GBDTdv_FRESH')) or s[0] == 'fresh')]
        if name.startswith(('GBDT_CONT', 'GBDTdv_CONT')): scopes = [('cont', lu)]
        for scope, sm in scopes:
            rows += selector_rows(name, sc, D, sm, scope)
            for r in C.frontier(np.where(sm & np.isfinite(sc), sc, -np.inf), D, split=2, tops=(30, 100, 300, 1000, 3000)):
                front.append(dict(score=name, scope=scope, **r))
    T = pd.DataFrame(rows); F = pd.DataFrame(front)
    T.to_csv(f'{C.OUT}/a31_simB_selectors.csv', index=False, float_format='%.4f')
    F.to_csv(f'{C.OUT}/a31_simB_frontier.csv', index=False, float_format='%.4f')
    pd.set_option('display.width', 250); pd.set_option('display.max_rows', 500)
    # 摘要：TEST 每日前 1／3／10 與 top30/100/300 總數
    piv = F.pivot_table(index=['score', 'scope'], columns='sel', values='prec')
    cols = ['top1/day', 'top3/day', 'top10/day', 'top30 total', 'top100 total', 'top300 total', 'top1000 total']
    print('=== TEST 前緣（精確度＝隔日漲停比例）')
    print((piv[cols] * 100).round(1).sort_values('top3/day', ascending=False).to_string())
    pivb = F.pivot_table(index=['score', 'scope'], columns='sel', values='buy')
    print('\n=== TEST 前緣（可買精確度＝隔日漲停且開盤買得到）')
    print((pivb[cols] * 100).round(1).sort_values('top3/day', ascending=False).to_string())
    print('\n=== VALID 門檻選擇器（VALID 精確度目標 → TEST 實際），只列 TEST n≥1')
    th = T[T.rule.str.startswith('VALID') & T.TEST_n.fillna(0).ge(1)]
    print(th[['score', 'scope', 'rule', 'DES_n', 'DES_prec', 'VAL_n', 'VAL_prec', 'TEST_n', 'TEST_prec', 'TEST_wlb', 'TEST_buy', 'TEST_days', 'TEST_ppd']].to_string(index=False))
    print('\nVALID 達不到的目標：')
    print(T[T.get('note').notna()][['score', 'scope', 'rule']].groupby(['rule']).size().to_string() if 'note' in T else '無')
    B = book_exploratory(D)
    B.to_csv(f'{C.OUT}/a31_simB_book_exploratory.csv', index=False, float_format='%.4f')
    print('\n=== 探索（非協定）：延續群 × 尾盤漲停價委買（前半 23 日定門檻 → 後半 24 日）')
    print(B.to_string(index=False))


if __name__ == '__main__':
    main()
