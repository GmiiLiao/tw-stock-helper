"""官方特徵重新訓練與對照（2026-10-04 使用者：「目前的參數資料不足以準確找出起漲日」⇒ 加官方來源特徵重訓）。

同一批列、同一套滾動外樣本協定（run_cv：每季一折、purge 11、負例抽 10%、GBDT depth 2×250），只換特徵集：
  base     ＝原有特徵（T1/T2：117 個 f_*；lu1：再加 x_lu_s／x_oneword_s／x_close_at_high／x_lu_streak／log 價／log 量／m_otc）
  official ＝官方化模型：base 去掉非官方的 peerComps 產業共振（NON_OFFICIAL_BASE），加上全部官方特徵組（GROUPS，含官方產業別 ind_off、季財報 fin）
  +g       ＝base＋單一官方特徵組（看每組單獨帶來多少）
  −g       ＝official−單一組（看拿掉哪組會掉）
  official+grp ＝實驗組：再加 wiki 集團共振（2026-10 靜態快照，回測有前視，只供參考）
base 與 official 各跑 3 個種子（負例抽樣＋GBDT 隨機性），其餘 1 個種子。評估列排除進行中區段列（T2）與 91xx 台灣存託憑證。
指標：同日 AUC、每日前 10／30 名精確度與相對基準倍數；all−base 以 20 日區塊 bootstrap（配對，同一批日子）給 95% 區間。
命中／漏網兩份逐件記錄（使用者 2026-10-04 規定，記憶 feedback-backtest-hits-and-misses）：base 與 official 各寫
  out/official_cv_{task}_{模型}_hits.csv、_misses.csv（日期、代號、名稱、市場、分數、同日名次、關鍵特徵同日百分位、各來源當天有無值），
  T1／T2 另寫 _outside.csv（事件發生但不在母體：被哪道濾網擋掉），以及 _hitmiss_summary.json（命中 vs 漏網的特徵百分位與缺值率差異）。
用法：SURGE_CACHE=<快取> python3 cv_official.py t1|t2|lu1 [--quick]
"""
import os, sys, json, time
import numpy as np, pandas as pd
import build as B, run_cv
from models import HistGBDT
from official_features import GROUPS, EXPERIMENTAL, NON_OFFICIAL_BASE

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out'); os.makedirs(OUT, exist_ok=True)
LU_EXTRAS = ['x_lu_s', 'x_oneword_s', 'x_close_at_high', 'x_lu_streak']
SEEDS = (0, 1, 2)
BLOCK, NBOOT = 20, 2000


def load(task):
    d = np.load(f'{B.SP}/dataset_{task}_off.npz')
    names = sorted(k[2:] for k in d.files if k.startswith('f_'))
    X = np.stack([d[f'f_{k}'] for k in names], 1).astype(np.float32)
    raw_names = []
    if task.startswith('lu1'):
        ex = [d[k].astype(np.float32) for k in LU_EXTRAS] + [np.log10(np.maximum(d['x_price'], 1e-3)).astype(np.float32),
              np.log10(np.maximum(d['x_vol20'], 1e-3)).astype(np.float32), d['m_otc'].astype(np.float32)]
        X = np.concatenate([X, np.stack(ex, 1)], 1); raw_names = LU_EXTRAS + ['log_price', 'log_vol20', 'm_otc']
    n = len(d['m_s'])
    D = dict(dates=list(d['dates']), s=d['m_s'], j=d['m_j'], codes=list(d['codes']), y=d['m_y'].astype(np.int8), names=names + raw_names, raw_names=set(raw_names),
             extra=(d['m_extra'].astype(bool) if 'm_extra' in d.files else np.zeros(n, bool)), tdr=d['m_tdr'].astype(bool), X=X,
             cat={k[4:]: d[k] for k in d.files if k.startswith('cat_')})
    return D


# 命中／漏網記錄用：關鍵特徵（同日百分位）與各來源「當天有沒有值」的代表欄位
KEY_FEATS = ['atr14', 'dt_ratio20', 'n_lu_250', 'days_since_lu', 'vr20', 'v_rank120', 'r1', 'r5', 'r20', 'c_ma120', 'lend_to_v', 'ml_chg5', 'ms_to_ml',
             'fgn_5', 'trust_5', 'rev_yoy', 'brk60', 'close_pos', 'o_avglot_r', 'o_trades_vr20', 'o_vwap_dev', 'o_turn', 'o_log_mcap', 'o_fhold_chg5',
             'o_dself_5', 'o_dhedge_5', 'o_dt_ratio20_all', 'o_lu_follow', 'o_overhead240', 'o_rev_hi12', 'o_fin_eps_yoy_p', 'o_fin_gm_yoy', 'o_ind_lu_cnt', 'o_ind_r5_rel']
SOURCE_FLAGS = {  # 來源 → 代表欄位（有值＝該來源當天有資料）
    '官方日成交結構(MI_INDEX/dailyQuotes)': 'o_avglot', '發行股數(MI_QFIIS/dailyQuotes)': 'o_turn', '外資持股(MI_QFIIS,僅上市)': 'o_fhold',
    '自營商(T86/上櫃三大法人)': 'o_dself_1', '當沖(TWTB4U/上櫃intraday)': 'o_dt_ratio_all', '季財報(MOPS t163sb04)': 'o_fin_gm',
    '月營收(MOPS/openapi)': 'rev_yoy', '官方產業別(MOPS t05st03)': 'o_ind_lu_cnt', '融資券(MI_MARGN)': 'ml_to_v', '借券(TWT93U)': 'lend_to_v', '法人(T86)': 'fgn_1',
}


def _names_markets():
    nm = json.load(open(f'{B.SP}/names.json')) if os.path.exists(f'{B.SP}/names.json') else {}
    mk = json.load(open(f'{B.SP}/code_market.json')) if os.path.exists(f'{B.SP}/code_market.json') else {}
    return nm, mk


def write_records(task, model, sc, D, R, test, K):
    """命中（真事件且在當日前 K 名）與漏網（真事件但不在前 K 名）逐件記錄＋差異摘要。"""
    nm, mk = _names_markets(); ix = {n: i for i, n in enumerate(D['names'])}
    idx = np.nonzero(test)[0]
    sub = pd.DataFrame({'row': idx, 's': D['s'][idx], 'sc': sc[idx] + np.random.default_rng(0).random(len(idx)) * 1e-9})
    sub['rank'] = sub.groupby('s')['sc'].rank(ascending=False, method='first').astype(int)
    sub['n_day'] = sub.groupby('s')['sc'].transform('size')
    pos = sub[D['y'][sub.row.values] == 1].copy()
    rows = pos.row.values; codes = [D['codes'][j] for j in D['j'][rows]]
    out = pd.DataFrame({'date': [D['dates'][t] for t in pos.s.values], 'code': codes, 'name': [nm.get(c, '') for c in codes],
                        'market': [mk.get(c, '') for c in codes], 'score': pos.sc.round(4).values, 'rank': pos['rank'].values, 'n_day': pos.n_day.values,
                        'result': np.where(pos['rank'].values <= K, '命中', '漏網')})
    for f in KEY_FEATS:
        if f in ix: out[f'pct_{f}'] = np.round(R[rows, ix[f]], 3)
    for lab, f in SOURCE_FLAGS.items():
        if f in ix: out[f'有值:{lab}'] = np.isfinite(D['X'][rows, ix[f]]).astype(int)
    base = f'{OUT}/official_cv_{task}_{model}'
    out[out.result == '命中'].to_csv(f'{base}_hits.csv', index=False)
    out[out.result == '漏網'].sort_values(['date', 'rank']).to_csv(f'{base}_misses.csv', index=False)
    hit, miss = out[out.result == '命中'], out[out.result == '漏網']
    summ = {'K': K, 'n_hit': len(hit), 'n_miss': len(miss),
            'feature_pct_mean': {c[4:]: [round(float(hit[c].mean()), 3), round(float(miss[c].mean()), 3)] for c in out.columns if c.startswith('pct_')},
            'source_has_value_rate': {c[3:]: [round(float(hit[c].mean()), 3), round(float(miss[c].mean()), 3)] for c in out.columns if c.startswith('有值:')},
            'miss_rank_bins': miss['rank'].pipe(lambda r: pd.cut(r, [K, 30, 100, 300, 10**6]).value_counts().sort_index().astype(int).to_dict()),
            'by_market': {m: [int((hit.market == m).sum()), int((miss.market == m).sum())] for m in ('tse', 'otc')}}
    summ['miss_rank_bins'] = {str(k): v for k, v in summ['miss_rank_bins'].items()}
    summ['_legend'] = 'feature_pct_mean／source_has_value_rate 的兩個數字＝[命中, 漏網]'
    if task[:2] in ('t1', 't2') and D['cat']:
        write_outside(task, model, D, set(np.unique(D['s'][test])))
    json.dump(summ, open(f'{base}_hitmiss_summary.json', 'w'), ensure_ascii=False, indent=1)
    return summ


def write_outside(task, model, D, test_days):
    """母體外的事件（測試期內）：起漲前日 s＝t−1 不在母體 ⇒ 依 build_v2 的濾網順序推斷被誰擋掉。"""
    dates, codes, P = B.load_panel()
    nm, mk = _names_markets(); V = P['V']
    vol20 = pd.DataFrame(V).rolling(20, min_periods=15).mean().values
    cnt = pd.DataFrame(P['C']).notna().astype(float).rolling(B.HIST_WIN, min_periods=1).sum().values
    cat = D['cat']; recs = []
    for t, j, inu in zip(cat['t'], cat['j'], cat['in_universe']):
        s = int(t) - 1
        if inu or s < 0 or s not in test_days: continue
        c = codes[j]
        why = ('股價<10' if not P['C'][s, j] >= B.MIN_PRICE else '20日均量<300張' if not vol20[s, j] >= B.MIN_VOL20
               else '上市未滿125日' if not cnt[s, j] >= B.HIST_NEED else '其他（冷卻期／價格結構斷點／近20日缺值／衝擊日）')
        recs.append(dict(date=dates[s], event_day=dates[t], code=c, name=nm.get(c, ''), market=mk.get(c, ''), reason=why))
    pd.DataFrame(recs).to_csv(f'{OUT}/official_cv_{task}_{model}_outside.csv', index=False)


def ranks(D, task):
    """非市場、非原值欄位轉同日百分位（同 evallib.rank_features）；快取到 SP，資料集重建後自動失效。"""
    cache = f'{B.SP}/ranks_{task}_off_{len(D["s"])}.npy'; src = f'{B.SP}/dataset_{task}_off.npz'
    if os.path.exists(cache) and os.path.getmtime(cache) >= os.path.getmtime(src):
        R = np.load(cache)
        if R.shape == D['X'].shape: return R
    R = np.empty_like(D['X']); s = D['s']
    for k, nm in enumerate(D['names']):
        if nm.startswith('mkt_') or nm in D['raw_names']: R[:, k] = D['X'][:, k]
        else: R[:, k] = pd.Series(D['X'][:, k].astype(np.float64)).groupby(s).rank(pct=True, method='average').values.astype(np.float32)
    np.save(cache, R); return R


def day_stats(score, s, y, K):
    """每天：前 K 名命中數、選股數、正例同日百分位和、正例數。"""
    df = pd.DataFrame({'s': s, 'y': y, 'sc': score + np.random.default_rng(0).random(len(score)) * 1e-9})
    df['rk'] = df.groupby('s')['sc'].rank(ascending=False, method='first')
    df['pct'] = df.groupby('s')['sc'].rank(pct=True, method='average')
    g = df.groupby('s')
    return pd.DataFrame({'hit': g.apply(lambda x: int(x.loc[x.rk <= K, 'y'].sum())), 'n': g.apply(lambda x: int((x.rk <= K).sum())),
                         'psum': g.apply(lambda x: float(x.loc[x.y == 1, 'pct'].sum())), 'npos': g['y'].sum(), 'rows': g.size()})


def summarize(st, base_rate):
    prec = st.hit.sum() / max(st.n.sum(), 1)
    return dict(auc=float(st.psum.sum() / max(st.npos.sum(), 1)), prec=float(prec), lift=float(prec / base_rate), hits=int(st.hit.sum()), picks=int(st.n.sum()))


def paired_boot(stA, stB, rng):
    """all−base 的配對區塊 bootstrap：同一組重抽的日子同時算兩邊。"""
    j = stA.index.intersection(stB.index); A, Bb = stA.loc[j], stB.loc[j]; T = len(j); nb = int(np.ceil(T / BLOCK))
    dp, da = [], []
    for _ in range(NBOOT):
        st = rng.integers(0, T, nb); idx = ((st[:, None] + np.arange(BLOCK)[None, :]).ravel()[:T]) % T
        a, b = A.iloc[idx], Bb.iloc[idx]
        dp.append(a.hit.sum() / max(a.n.sum(), 1) - b.hit.sum() / max(b.n.sum(), 1))
        da.append(a.psum.sum() / max(a.npos.sum(), 1) - b.psum.sum() / max(b.npos.sum(), 1))
    return dict(dprec=[float(np.percentile(dp, 2.5)), float(np.percentile(dp, 97.5))], dauc=[float(np.percentile(da, 2.5)), float(np.percentile(da, 97.5))])


def main():
    task = sys.argv[1]; quick = '--quick' in sys.argv
    K = 10
    D = load(task); R = ranks(D, task)
    names = D['names']; ix = {n: i for i, n in enumerate(names)}
    off = [g for gl in GROUPS.values() for g in gl]
    new_names = {n for gl in GROUPS.values() for n in gl} | {n for gl in EXPERIMENTAL.values() for n in gl}   # 官方新特徵（含 mkt_lu_off 等市場層）一律不進 base
    base_cols = [i for i, n in enumerate(names) if not n.startswith('o_') and n not in new_names]
    grp_cols = {g: [ix[n] for n in gl if n in ix] for g, gl in GROUPS.items()}
    nonoff = {ix[n] for n in NON_OFFICIAL_BASE if n in ix}
    all_cols = [i for i in base_cols if i not in nonoff] + [ix[n] for n in off if n in ix]
    configs = [('base', base_cols, SEEDS), ('official', all_cols, SEEDS)]
    if not quick:
        configs += [(f'+{g}', base_cols + c, (0,)) for g, c in grp_cols.items()]
        configs += [(f'-{g}', [i for i in all_cols if i not in set(c)], (0,)) for g, c in grp_cols.items()]
        configs += [('official+grp', all_cols + [ix[n] for gl in EXPERIMENTAL.values() for n in gl if n in ix], (0,))]
    t0 = time.time(); res = {}; stats = {}
    for name, cols, seeds in configs:
        sc_sum = None
        for sd in seeds:
            sc = run_cv.run(D, R, lambda: HistGBDT(**{**run_cv.GB, 'seed': sd}), name, seed=sd, cols=cols)
            z = sc.copy()
            sc_sum = z if sc_sum is None else sc_sum + z
        sc = sc_sum / len(seeds)
        test = np.isfinite(sc) & ~D['extra'] & ~D['tdr']
        st = day_stats(sc[test], D['s'][test], D['y'][test], K); base_rate = D['y'][test].mean()
        stats[name] = st; res[name] = {**summarize(st, base_rate), 'nfeat': len(cols), 'seeds': len(seeds)}
        if name in ('base', 'official'): res[name]['hitmiss'] = write_records(task, name, sc, D, R, test, K)
        if task.startswith('lu1'):
            st30 = day_stats(sc[test], D['s'][test], D['y'][test], 30); res[name]['prec30'] = float(st30.hit.sum() / max(st30.n.sum(), 1))
        print(f'[{task}] {name:<12} 特徵 {len(cols):>3}  同日AUC {res[name]["auc"]:.4f}  前{K}精確度 {res[name]["prec"] * 100:5.2f}%  lift {res[name]["lift"]:.2f}  （{round(time.time() - t0)}s）', flush=True)
    rng = np.random.default_rng(11)
    for name in res:
        if name != 'base': res[name]['vs_base'] = paired_boot(stats[name], stats['base'], rng)
    res['_meta'] = dict(task=task, K=K, test_rows=int(test.sum()), positives=int(D['y'][test].sum()), days=int(len(stats['base'])), base_rate=float(base_rate),
                        protocol='run_cv 每季一折 2025Q1～2026Q3、purge 11、負例 10%、HistGBDT depth2×250；排除進行中區段列與 91xx TDR', groups=GROUPS)
    json.dump(res, open(f'{OUT}/official_cv_{task}.json', 'w'), ensure_ascii=False, indent=1)
    print(json.dumps({k: {kk: v[kk] for kk in ('auc', 'prec', 'lift') if kk in v} | ({'vs_base': v['vs_base']} if 'vs_base' in v else {}) for k, v in res.items() if k != '_meta'}, ensure_ascii=False, indent=0))


if __name__ == '__main__':
    main()
