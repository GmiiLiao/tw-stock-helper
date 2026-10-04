"""官方化重訓的穩健度（2026-10-04；由 scratchpad robust.py 移入版控）。

輸入：{SP}/dataset_{task}_off.npz＋cv_official.py 存的 {SP}/official_cv_scores_{task}.npz（base／official 3 種子平均外樣本分數）。
      分數檔的列指紋（m_s／m_j／m_y 的 sha256）必須與資料集相同，而且分數檔記錄的輸入指紋（fingerprint.scores_inputs：
      資料集 npz 的「內容」sha256、月營收檔、官方漲停價檔）必須與磁碟上現在的檔逐項相同——任一不符就拒跑。
      只比列指紋不夠：T2L 修正前後列與標籤完全相同（7ea21009…），只有 26 個特徵欄變了。沒有輸入指紋的舊分數檔一律拒收。
輸出：out/official_cv_robust.json（只含本次指定的任務；整份覆寫）
  overall      每日前 10 名精確度（%）
  by_half      分半年：天數、base／official 精確度、official−base 的配對 20 日區塊 bootstrap 95% 區間（百分點）
  T1／T2       開盤即鎖（買不到）比例、可買進精確度、開盤買進後 1／5／10 日收盤報酬（平均、中位、勝率）＋同期可買進全母體基準
  LU1          可買進漲停精確度（隔日漲停且開盤買得到）、延續（s 已漲停）占比、新起漲／延續各自精確度、開盤即鎖比例、
               開盤→收盤報酬、只看新起漲（s 未漲停）時的前 10 名能力
用法：SURGE_CACHE=<快取> python3 cv_official_robust.py t1L t2L lu1L [--out <路徑>]
報酬皆未扣成本；非投資建議。
"""
import hashlib
import json
import os
import sys
import numpy as np
import pandas as pd
import build as B
import fingerprint as FP

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
K = 10; BLOCK = 20; NB = 2000


def topk(sc, s, k=K):
    df = pd.DataFrame({'i': np.arange(len(sc)), 's': s, 'sc': sc + np.random.default_rng(0).random(len(sc)) * 1e-9})
    df['rk'] = df.groupby('s')['sc'].rank(ascending=False, method='first')
    return df.loc[df.rk <= k, ['i', 's']]


def boot_diff(a, b, rng):
    """a、b：每日 (hit, n) DataFrame，同一批日子；回 a−b 精確度差的 95% 區間（百分點）。"""
    T = len(a); nb = int(np.ceil(T / BLOCK)); out = []
    ah, an, bh, bn = a.hit.values, a.n.values, b.hit.values, b.n.values
    for _ in range(NB):
        st = rng.integers(0, T, nb); idx = ((st[:, None] + np.arange(BLOCK)[None, :]).ravel()[:T]) % T
        out.append(ah[idx].sum() / an[idx].sum() - bh[idx].sum() / bn[idx].sum())
    return [round(float(np.percentile(out, 2.5)) * 100, 2), round(float(np.percentile(out, 97.5)) * 100, 2)]


def rows_sig(d):
    h = hashlib.sha256()
    for k in ('m_s', 'm_j', 'm_y'): h.update(np.ascontiguousarray(d[k].astype({'m_s': np.int32, 'm_j': np.int32, 'm_y': np.int8}[k])).tobytes())
    return h.hexdigest()[:16]


def load(task):
    d = np.load(f'{B.SP}/dataset_{task}_off.npz')
    sp = f'{B.SP}/official_cv_scores_{task}.npz'
    if not os.path.exists(sp): raise SystemExit(f'{sp} 不存在——先跑 cv_official.py {task}（--quick 亦可）')
    sc = np.load(sp)
    sig = rows_sig(d)
    if str(sc['rows_sig']) != sig or int(sc['n_rows']) != len(d['m_s']):
        raise SystemExit(f'{task}：分數檔列指紋 {sc["rows_sig"]}／{int(sc["n_rows"])} 列 ≠ 資料集 {sig}／{len(d["m_s"])} 列（資料集重建後要重跑 cv_official）')
    if 'inputs' not in sc.files:
        raise SystemExit(f'{task}：分數檔 {sp} 沒有輸入指紋（舊版 cv_official 產生）——列指紋抓不到「只有特徵變」，重跑 cv_official {task}')
    bad = FP.verify_inputs(json.loads(str(sc['inputs'])), d, B.SP)
    if bad: raise SystemExit(f'{task}：分數檔與現在的輸入不符，拒跑（避免修正前後口徑混用）：\n  ' + '\n  '.join(bad))
    return d, sc


def pick_lists(d, sc, s, extra, tdr, y, dates):
    picks = {}
    for m in ('base', 'official'):
        test = np.isfinite(sc[m]) & ~extra & ~tdr
        idx = np.nonzero(test)[0]
        p = topk(sc[m][idx], s[idx]); p['row'] = idx[p.i.values]; p['y'] = y[p.row.values]
        p['date'] = dates[p.s.values]; p['period'] = [x[:4] + ('H1' if x[5:7] <= '06' else 'H2') for x in p.date]
        picks[m] = p
    return picks


def by_half(picks, rng):
    per = {}
    for per_k in sorted(set(picks['base'].period)):
        a = picks['official'][picks['official'].period == per_k].groupby('s').agg(hit=('y', 'sum'), n=('y', 'size'))
        b = picks['base'][picks['base'].period == per_k].groupby('s').agg(hit=('y', 'sum'), n=('y', 'size'))
        j = a.index.intersection(b.index); a, b = a.loc[j], b.loc[j]
        per[per_k] = dict(days=len(j), base=round(b.hit.sum() / b.n.sum() * 100, 2), official=round(a.hit.sum() / a.n.sum() * 100, 2),
                          diff_ci=boot_diff(a, b, rng))
    return per


def lu1_block(d, sc, picks, s, y, tdr):
    rep = {}
    lu_s = d['m_lu_s'].astype(bool); buy = d['m_buy_lu'].astype(int); locked = d['m_locked1'].astype(bool)
    oc1 = d['m_oc1']; cc1 = d['m_cc1']
    for m, p in picks.items():
        r = p.row.values
        rep[m] = dict(prec=round(y[r].mean() * 100, 2), buyable_lu_prec=round(buy[r].mean() * 100, 2),
                      share_cont=round(lu_s[r].mean() * 100, 1), prec_fresh=round(y[r][~lu_s[r]].mean() * 100, 2) if (~lu_s[r]).any() else None,
                      prec_cont=round(y[r][lu_s[r]].mean() * 100, 2) if lu_s[r].any() else None,
                      locked_open_share=round(locked[r].mean() * 100, 1),
                      oc1_mean_buyable=round(float(np.nanmean(np.where(locked[r], np.nan, oc1[r]))) * 100, 2),
                      cc1_mean=round(float(np.nanmean(cc1[r])) * 100, 2))
        test = np.isfinite(sc[m]) & ~tdr & ~lu_s                  # 只看新起漲（s 未漲停）的前 10：模型在「真的新起漲」上的能力
        idx = np.nonzero(test)[0]; q = topk(sc[m][idx], s[idx]); rr = idx[q.i.values]
        rep[m]['fresh_only_top10'] = dict(prec=round(y[rr].mean() * 100, 2), buyable=round(buy[rr].mean() * 100, 2), base_rate=round(y[idx].mean() * 100, 2))
    return rep


def t12_block(d, sc, picks, extra, tdr, y):
    rep = {}
    locked = d['m_locked_open'].astype(bool)
    for m, p in picks.items():
        r = p.row.values; ok = ~locked[r]
        rep[m] = dict(prec=round(y[r].mean() * 100, 2), locked_open_share=round(locked[r].mean() * 100, 1),
                      buyable_prec=round(y[r][ok].mean() * 100, 2),
                      **{f'o_c{k}_mean': round(float(np.nanmean(d[f'm_o_c{k}'][r][ok])) * 100, 2) for k in (1, 5, 10)},
                      **{f'o_c{k}_median': round(float(np.nanmedian(d[f'm_o_c{k}'][r][ok])) * 100, 2) for k in (5, 10)},
                      **{f'o_c{k}_win': round(float(np.nanmean(d[f'm_o_c{k}'][r][ok] > 0)) * 100, 1) for k in (5, 10)})
    test = np.isfinite(sc['base']) & ~extra & ~tdr & ~locked     # 同期全母體（可買進）均值，當作基準
    rep['universe'] = {f'o_c{k}_mean': round(float(np.nanmean(d[f'm_o_c{k}'][test])) * 100, 2) for k in (1, 5, 10)}
    return rep


def analyse(task):
    d, sc = load(task)
    n = len(d['m_s']); extra = d['m_extra'].astype(bool) if 'm_extra' in d.files else np.zeros(n, bool)
    tdr = d['m_tdr'].astype(bool)
    dates = np.array(d['dates']); s = d['m_s']; y = d['m_y'].astype(int)
    rep = {'task': task, 'rows_sig': str(sc['rows_sig']), 'scores_env': json.loads(str(sc['env'])), 'scores_quick': bool(sc['quick']),
           'scores_inputs': json.loads(str(sc['inputs']))}
    rng = np.random.default_rng(7)
    picks = pick_lists(d, sc, s, extra, tdr, y, dates)
    rep['overall'] = {m: round(picks[m].y.mean() * 100, 2) for m in picks}
    rep['by_half'] = by_half(picks, rng)
    rep.update(lu1_block(d, sc, picks, s, y, tdr) if task.startswith('lu1') else t12_block(d, sc, picks, extra, tdr, y))
    return rep


def main():
    argv = sys.argv[1:]
    path = argv[argv.index('--out') + 1] if '--out' in argv else os.path.join(OUT, 'official_cv_robust.json')
    tasks = [a for i, a in enumerate(argv) if not a.startswith('--') and (i == 0 or argv[i - 1] != '--out')] or ['t1L', 't2L', 'lu1L']
    out = {t: analyse(t) for t in tasks}
    out['_meta'] = dict(K=K, block=BLOCK, nboot=NB, note='精確度＝每日前 10 名命中率（%）；diff_ci＝official−base 百分點 95% 區間；報酬未扣成本；非投資建議')
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = f'{path}.tmp{os.getpid()}'
    with open(tmp, 'w', encoding='utf-8') as f: json.dump(out, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)
    print(json.dumps(out, ensure_ascii=False, indent=1))
    print(f'→ {path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
