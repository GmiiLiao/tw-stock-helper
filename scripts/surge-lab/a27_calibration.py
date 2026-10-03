"""正式整合用的校準表（研究端產出，寫成 JSON 供 daemon 使用）：
  (1) 持有狀態：P(隔日／3 日內出現漲幅型注意公告 | 前 5 日單日報酬加總 S5 分段)，分「目前未在注意中」與「近 10 日已有注意」兩群、並分市場
  (2) 【作廢】風險旗標依「累計次數」：上市累計次數含查詢區間內之後的公告（前視）、上櫃累計＝當日公告總股數，都不是個股次數；改用 a29_pit_escalation.py
全部只用流動股（收盤≥10、20 日均量≥300 張）；公告日期＝觸發日；S5 用公告前一日收盤可知的資料。"""
import numpy as np, pandas as pd, json, warnings
import build as B
warnings.filterwarnings('ignore')
pd.set_option('display.width', 220)
dates, codes, P = B.load_panel(); T, N = P['C'].shape
mk = json.load(open(f'{B.SP}/code_market.json')); market = np.array([mk.get(c, '?') for c in codes])
ev = B.load_factor_events(dates, codes); Aj, Fd, _ = B.adjust(dates, codes, P, ev)
Ca = Aj['C']; ret = np.full((T, N), np.nan); ret[1:] = Ca[1:] / Ca[:-1] - 1
rf = np.nan_to_num(ret); cs = np.cumsum(rf, axis=0)
S5 = np.full((T, N), np.nan); S5[5:] = cs[5:] - cs[:-5]                 # Σ ret[t−4..t]
vol20 = pd.DataFrame(P['V']).rolling(20, min_periods=15).mean().values
liq = np.isfinite(P['C']) & (P['C'] >= 10) & (vol20 >= 300); liq[:130] = False
M = np.load(f'{B.SP}/att_mats.npz'); RISE, ANY, CUM, DPUB = M['RISE'], M['ANY'], M['CUM'], M['DPUB']
nxt1 = np.zeros((T, N), bool); nxt1[:-1] = RISE[1:]
nxt3 = np.zeros((T, N), bool)
for k in range(1, 4): nxt3[:-k] |= RISE[k:]
prev10 = np.zeros((T, N), bool)
for k in range(0, 10): prev10[k:] |= ANY[:T - k] if k else ANY      # 含當日：s 日或前 9 日有任何注意公告
valid = liq & np.isfinite(S5); valid[T - 3:] = False
edges = [-9, 0.05, 0.10, 0.15, 0.18, 0.21, 0.24, 0.27, 0.30, 9]
labels = ['<5%', '5~10%', '10~15%', '15~18%', '18~21%', '21~24%', '24~27%', '27~30%', '≥30%']
out = {'generatedAt': None, 'definition': 'S5＝最近 5 個交易日（含當日）單日收盤報酬率的算術加總；官方注意股第 1 款門檻為最近 6 日加總（≥32% 等）', 'buckets': labels, 'edges': edges[1:-1], 'nextDay': {}, 'next3': {}, 'n': {}}
print('— (1) 隔日／3 日內出現漲幅型注意公告的機率，依 S5（前 5 日報酬加總）—')
rows = []
for grp, gm in (('未在注意中', ~prev10), ('近10日已有注意', prev10)):
    for mkt in ('all', 'tse', 'otc'):
        mm = valid & gm & ((market[None, :] == mkt) if mkt != 'all' else True)
        b = np.digitize(S5, edges[1:-1])
        for k, lab in enumerate(labels):
            m = mm & (b == k)
            n = int(m.sum())
            if n == 0: continue
            p1 = nxt1[m].mean(); p3 = nxt3[m].mean()
            rows.append(dict(群=grp, 市場=mkt, S5=lab, 列數=n, 隔日=p1 * 100, 三日內=p3 * 100))
            key = f'{grp}|{mkt}'
            out['nextDay'].setdefault(key, []).append(round(float(p1), 4)); out['next3'].setdefault(key, []).append(round(float(p3), 4)); out['n'].setdefault(key, []).append(n)
R = pd.DataFrame(rows)
print(R[R.市場 == 'all'].round(2).to_string(index=False))
print('\n分市場（未在注意中）：'); print(R[(R.市場 != 'all') & (R.群 == '未在注意中')].pivot_table(index='S5', columns='市場', values='隔日', sort=False).round(2).to_string())
# (2) 升級：注意公告後 10 日內處置公告，依累計次數 × 市場
nxt10d = np.zeros((T, N), bool)
for k in range(1, 11): nxt10d[:T - k] |= DPUB[k:]
liq_prev = np.vstack([np.zeros((1, N), bool), liq[:-1]])
print('\n— (2) 注意公告後 10 個交易日內出現處置公告的機率，依累計次數 × 市場 —')
rows = []; esc = {}
for mkt in ('tse', 'otc', 'all'):
    for lo, hi, lab in ((1, 1, '1'), (2, 3, '2~3'), (4, 5, '4~5'), (6, 8, '6~8'), (9, 12, '9~12'), (13, 999, '≥13')):
        m = ANY & (CUM >= lo) & (CUM <= hi) & liq_prev & ((market[None, :] == mkt) if mkt != 'all' else True)
        m[T - 10:] = False
        if m.sum() == 0: continue
        p = nxt10d[m].mean(); rows.append(dict(市場=mkt, 累計=lab, 公告數=int(m.sum()), 十日內處置=p * 100))
        esc.setdefault(mkt, {})[lab] = {'p': round(float(p), 4), 'n': int(m.sum())}
E2 = pd.DataFrame(rows); print(E2.pivot_table(index='累計', columns='市場', values='十日內處置', sort=False).round(1).to_string())
print(E2.pivot_table(index='累計', columns='市場', values='公告數', sort=False).to_string())
m = liq & ~ANY; m[T - 10:] = False; print('基準（流動股、當日無注意）：%.2f%%' % (nxt10d[m].mean() * 100))
out['escalation10'] = esc; out['escalationBase'] = round(float(nxt10d[m].mean()), 4)
out['window'] = {'from': dates[130], 'to': dates[-1]}
json.dump(out, open(f'{B.SP}/attention_calibration.json', 'w'), ensure_ascii=False, indent=1)
print('→ attention_calibration.json')
