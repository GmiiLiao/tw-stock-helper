"""實盤對答案（2026-10-03 使用者：「用 10/1 盤後的資料跑一次模型名單，和 10/2、10/5 實際漲停的股票對答案」）。

做法＝與外樣本驗證（run_cv.py）完全相同的程序，只是「測試日」換成指定日：
  · 模型：T1（隔日起連續漲停 ≥2 日）的 GBDT（同 GB 參數、同 117 個特徵的同日百分位、負例抽 10%）。
  · 訓練：dataset_t1.npz 中 s ≤ 打分日 − 11 個交易日的列（PURGE 同驗證；標籤用到 s+2，留緩衝），只用打分日以前就已確定的資料。
  · 打分母體：打分日當天的 T1 母體（收盤≥10、20 日均量≥300 張、歷史≥125 日、近 20 日無缺值、無結構斷點、當天未漲停、
    近 10 日無連板區段）。研究母體另排除「未來 5 日內有結構斷點」——那需要未來資料，實盤不用。
  · 對答案：打分日隔一個交易日的「漲停」＝收盤價 ≥ 以除權息參考價與檔位算出的漲停價（build.build_events，PIT 已驗證）。
    T1 標籤本身（隔日起連板）要再下一個交易日才知道 ⇒ 打分日為最後兩個交易日時標為「待定」。
  · 另列：ATR 單一排名、隨機的期望命中、外樣本近期每日前 10 名的命中分布（判斷這一天是否典型）。
用法：SURGE_DATASET=dataset_t1.npz python3 a30_live_list.py 2026-10-01 2026-10-02
"""
import os, sys, json, hashlib, datetime, warnings
os.environ.setdefault('SURGE_DATASET', 'dataset_t1.npz')
import numpy as np, pandas as pd
import build as B, build_v2 as V, evallib as E
from models import HistGBDT
from run_cv import GB, PURGE, NEG_FRAC
warnings.filterwarnings('ignore')
pd.set_option('display.width', 250); pd.set_option('display.max_columns', 30)

DAYS = sys.argv[1:] or ['2026-10-01', '2026-10-02']
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
names_map = json.load(open(f'{B.SP}/names.json')) if os.path.exists(f'{B.SP}/names.json') else {}
mk = json.load(open(f'{B.SP}/code_market.json'))

# ── 面板、事件、特徵（同 build_v2.main）──
dates, codes, P = B.load_panel(); T, N = P['C'].shape
A, F_day, _ = B.adjust(dates, codes, P, B.load_factor_events(dates, codes))
EV = B.build_events(P, A, F_day); S = V.segments(EV, A['C']); LU = S['LU']
Ca, Vv = A['C'], P['V']
vol20 = pd.DataFrame(Vv).rolling(20, min_periods=15).mean().values
cnt130 = pd.DataFrame(Ca).notna().astype(float).rolling(B.HIST_WIN, min_periods=1).sum().values
nan20 = pd.DataFrame(Ca).isna().astype(float).rolling(20, min_periods=1).sum().values
brk_past = pd.DataFrame(EV['brk'].astype(float)).rolling(B.HIST_NEED, min_periods=1).max().values > 0
elig_base = np.isfinite(P['C']) & (P['C'] >= B.MIN_PRICE) & (vol20 >= B.MIN_VOL20) & (cnt130 >= B.HIST_NEED) & (nan20 == 0)
live_ok = elig_base & ~brk_past & ~LU & ~S['cool1']
F = B.compute_features(dates, codes, P, A, EV, elig_base)
dsl = F['days_since_lu'].copy(); dsl[~np.isfinite(dsl)] = 999.0; F['days_since_lu'] = dsl.astype(np.float32)

# ── 訓練資料（與 run_cv 同）──
D = E.load(); R = E.rank_features(D); names = D['names']
assert names == sorted(F.keys()), '特徵集合與訓練資料不一致'
ix = {n: i for i, n in enumerate(names)}


def train(cut_s, seed=0):
    s, y = D['s'], D['y']
    tr = np.nonzero((s <= cut_s - PURGE) & ~D['extra'])[0]
    rng = np.random.default_rng(seed + cut_s)
    neg, pos = tr[y[tr] == 0], tr[y[tr] == 1]
    tr_s = np.concatenate([pos, rng.choice(neg, int(len(neg) * NEG_FRAC), replace=False)])
    return HistGBDT(**GB).fit(R[tr_s], y[tr_s]), dates[int(s[tr].max())], len(tr_s), int(y[tr_s].sum())


def live_ranks(t, js):
    X = np.stack([F[n][t, js] for n in names], 1).astype(np.float64)
    Rl = np.empty_like(X)
    for k, n in enumerate(names):
        Rl[:, k] = X[:, k] if n.startswith('mkt_') else pd.Series(X[:, k]).rank(pct=True, method='average').values
    return Rl.astype(np.float32), X


def lim_price(t_next, j):
    ref = B.round_tick(P['C'][t_next - 1, j] * F_day[t_next, j]); return B.limit_up_price(ref)


results = {}
for day in DAYS:
    t = dates.index(day); js = np.nonzero(live_ok[t])[0]
    Rl, Xl = live_ranks(t, js)
    m0, last_train, ntr, npos = train(t, 0)
    sc = m0.decision_function(Rl)
    seeds = [m0.decision_function(Rl)] + [train(t, k)[0].decision_function(Rl) for k in (1, 2, 3, 4)]
    top10_sets = [set(np.argsort(-x)[:10]) for x in seeds]
    stab = np.mean([len(top10_sets[0] & z) / 10 for z in top10_sets[1:]])
    order = np.argsort(-sc); rank = np.empty(len(js), int); rank[order] = np.arange(len(js))
    atr_rank = pd.Series(Xl[:, ix['atr14']]).rank(ascending=False, method='first').values - 1
    rows = []
    has_next = t + 1 < T
    for i, j in enumerate(js):
        c = codes[j]; r = dict(rank=int(rank[i]) + 1, code=c, name=names_map.get(c, ''), mkt=mk.get(c, '?'), score=round(float(sc[i]), 4),
                               close=float(P['C'][t, j]), atr14=round(float(Xl[i, ix['atr14']]), 4), atr_rank=int(atr_rank[i]) + 1)
        if has_next:
            tn = t + 1; lp = lim_price(tn, j); o, cl = P['O'][tn, j], P['C'][tn, j]
            r.update(next_date=dates[tn], next_LU=bool(LU[tn, j]), next_open=float(o) if np.isfinite(o) else None, next_close=float(cl) if np.isfinite(cl) else None,
                     next_locked_open=bool(np.isfinite(o) and o >= lp - 1e-9), next_lim=float(lp),
                     next_chg=round(float(Ca[tn, j] / Ca[t, j] - 1) * 100, 2) if np.isfinite(Ca[tn, j]) else None,
                     next_open_to_close=round(float(cl / o - 1) * 100, 2) if np.isfinite(o) and np.isfinite(cl) and o > 0 else None,
                     T1_label=('待定（需 ' + (dates[t + 2] if t + 2 < T else '下一交易日') + '）') if t + 2 >= T else bool(LU[tn, j] and LU[t + 2, j]))
        rows.append(r)
    L = pd.DataFrame(rows).sort_values('rank').reset_index(drop=True)
    results[day] = dict(L=L, t=t, last_train=last_train, ntr=ntr, npos=npos, stab=stab, n=len(js))
    print(f'\n════ 打分日 {day}（盤後）｜母體 {len(js)} 檔｜訓練至 s≤{last_train}（{ntr:,} 列、正例 {npos}）｜前 10 名跨 5 個種子平均重疊 {stab:.0%}')
    cols = ['rank', 'code', 'name', 'mkt', 'score', 'close', 'atr_rank'] + (['next_LU', 'next_locked_open', 'next_chg', 'next_open_to_close'] if has_next else [])
    print(L[cols].head(20).to_string(index=False))
    if has_next:
        tn = t + 1; nlu = int(L.next_LU.sum()); base = nlu / len(L)
        print(f'\n— 對答案：{dates[tn]} 實際漲停（母體內）{nlu} 檔／{len(L)}（{base * 100:.2f}%）')
        for K in (5, 10, 20, 50):
            h = int(L.head(K).next_LU.sum()); ha = int(L[L.atr_rank <= K].next_LU.sum())
            print(f'   前 {K:>2} 名：命中 {h}（隨機期望 {K * base:.2f}；ATR 單一排名 {ha}）')
        hit = L[L.next_LU]
        print(f'   {dates[tn]} 漲停者在名單上的名次：{sorted(hit["rank"].tolist())}（中位 {int(hit["rank"].median()) if len(hit) else "—"}；母體 {len(L)} 檔）')
        # 全市場的漲停（含不在母體者）
        all_lu = np.nonzero(LU[tn] & np.isfinite(P['C'][tn]))[0]
        why = []
        for j in all_lu:
            c = codes[j]
            if live_ok[t, j]: w = '母體內'
            elif not np.isfinite(P['C'][t, j]): w = '前日無收盤'
            elif LU[t, j]: w = '前日已漲停（規則排除）'
            elif P['C'][t, j] < B.MIN_PRICE: w = '股價<10'
            elif not (vol20[t, j] >= B.MIN_VOL20): w = '20日均量<300張'
            elif not (cnt130[t, j] >= B.HIST_NEED): w = '上市未滿125日'
            elif nan20[t, j] > 0: w = '近20日有缺值'
            elif brk_past[t, j]: w = '結構斷點'
            elif S['cool1'][t, j]: w = '近10日剛連板（冷卻）'
            else: w = '其他'
            why.append(w)
        print(f'   全市場 {dates[tn]} 漲停 {len(all_lu)} 檔（不含 00 開頭 ETF）：{pd.Series(why).value_counts().to_dict()}')
        results[day]['all_lu'] = [(codes[j], names_map.get(codes[j], ''), w) for j, w in zip(all_lu, why)]
        print(L[L.next_LU][['rank', 'code', 'name', 'mkt', 'score', 'atr_rank', 'next_locked_open', 'next_chg']].to_string(index=False))

# ── 外樣本近期每日前 10 名命中分布（判斷單日是否典型；OOF＝滾動外樣本、模型不含測試期）──
O = np.load(f'{B.SP}/oof_t1.npz'); sc_o = O['gbdt_rank']; s_o = D['s']; fin = np.isfinite(sc_o) & ~D['extra']
rk = E.rank_in_day_desc(np.where(fin, sc_o, -1e9), s_o)
nextLU = LU[np.minimum(s_o + 1, T - 1), D['j']] & (s_o + 1 < T)
df = pd.DataFrame(dict(s=s_o[fin], top=rk[fin] < 10, t1=D['y'][fin] == 1, lu=nextLU[fin]))
g = df.groupby('s').apply(lambda x: pd.Series(dict(n=len(x), t1_hit=int((x.top & x.t1).sum()), lu_hit=int((x.top & x.lu).sum()), t1_all=int(x.t1.sum()), lu_all=int(x.lu.sum()))))
g.index = [dates[i] for i in g.index]
q3 = g[g.index >= '2026-07-01']
print(f'\n════ 外樣本（2026-07-01～{q3.index[-1]}，{len(q3)} 個交易日）每日前 10 名：')
print(f'   隔日漲停（單日）命中：平均 {q3.lu_hit.mean():.2f} 檔／日、至少 1 檔的日子 {(q3.lu_hit > 0).mean() * 100:.0f}%；母體每日漲停平均 {q3.lu_all.mean():.1f} 檔／{q3.n.mean():.0f}')
print(f'   隔日起連板（T1）命中：平均 {q3.t1_hit.mean():.2f} 檔／日、至少 1 檔的日子 {(q3.t1_hit > 0).mean() * 100:.0f}%；母體每日 T1 事件平均 {q3.t1_all.mean():.1f}')
print('   最近 10 日：'); print(q3.tail(10).to_string())

# ── 凍結名單（10/5 對答案用）──
frozen = {'generatedAt': datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat(timespec='seconds'),
          'note': '盤後名單凍結；待下一交易日收盤後對答案。T1 模型＝隔日起連續漲停≥2日。非投資建議。', 'lists': {}}
for day, r in results.items():
    frozen['lists'][day] = {'trainedThrough': r['last_train'], 'universe': r['n'], 'top50': r['L'].head(50)[['rank', 'code', 'name', 'mkt', 'score', 'close']].to_dict('records')}
blob = json.dumps(frozen, ensure_ascii=False, sort_keys=True)
fn = f'{OUT}/live_lists_{"_".join(DAYS)}.json'; os.makedirs(OUT, exist_ok=True); open(fn, 'w').write(blob)
print(f'\n凍結 → {fn}  sha256={hashlib.sha256(blob.encode()).hexdigest()[:16]}')
for day, r in results.items(): r['L'].to_csv(f'{OUT}/live_list_{day}.csv', index=False)
