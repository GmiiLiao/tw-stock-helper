"""起漲事件 × 官方處置狀態／市場別（T1／T2 各跑一次，SURGE_DATASET 切換）。
狀態（s 日收盤時已知）：IN＝在處置期；PEND＝s 日當晚才公告、次一營業日起處置（AI 波段 17:00 後決策才知道）；
RECENT＝處置剛結束 ≤10 個交易日；PAST＝近 250 日內曾處置；NONE。"""
import numpy as np, pandas as pd, json, warnings
import evallib as E, disposal as DP
warnings.filterwarnings('ignore')
pd.set_option('display.width', 220)
D = E.load(primary_only=True); s, j, y = D['s'], D['j'], D['y']; dates = np.array(D['dates']); codes = D['codes']
Z = np.load(f'{E.B.SP}/disposal_mats.npz'); KNOWN, PUB = Z['KNOWN'], Z['PUB']
T = len(dates)
F = DP.features({'KNOWN': KNOWN}, T)
since, n250 = F['dp_since'], F['dp_n250']
IN = KNOWN[s, j]; PEND = PUB[s, j] & ~IN
since_r = since[s, j]
RECENT = ~IN & (since_r <= 10); PAST = ~IN & ~RECENT & (n250[s, j] > 0)
status = np.where(IN, 'IN 處置中', np.where(PEND, 'PEND 當晚公告', np.where(RECENT, 'RECENT 剛結束≤10日', np.where(PAST, 'PAST 近250日曾處置', 'NONE 無'))))
mk = json.load(open(f'{E.B.SP}/code_market.json')); market = np.array([mk.get(c, '?') for c in codes])[j]
nday = np.bincount(s, minlength=T); pday = np.bincount(s, weights=y, minlength=T); rate_row = (pday / np.maximum(nday, 1))[s]
rows = []
for st in ['NONE 無', 'PAST 近250日曾處置', 'RECENT 剛結束≤10日', 'PEND 當晚公告', 'IN 處置中']:
    m = status == st
    obs = y[m].sum(); exp = rate_row[m].sum()
    rows.append(dict(狀態=st, 列數=int(m.sum()), 占母體=m.mean() * 100, 事件=int(obs), 占事件=obs / y.sum() * 100, 事件率=y[m].mean() * 100 if m.any() else np.nan, lift=obs / exp if exp > 0 else np.nan))
print(f'===== {E.TAG.strip("_").upper()}：事件 × 官方處置狀態（母體 {len(s):,} 列、事件 {int(y.sum())}）')
print(pd.DataFrame(rows).round(2).to_string(index=False))
rows = []
for mkt in ('tse', 'otc', '?'):
    m = market == mkt
    if not m.any(): continue
    obs = y[m].sum(); exp = rate_row[m].sum()
    rows.append(dict(市場=mkt, 列數=int(m.sum()), 占母體=m.mean() * 100, 事件=int(obs), 占事件=obs / y.sum() * 100, 事件率=y[m].mean() * 100, lift=obs / exp))
print('\n市場別：'); print(pd.DataFrame(rows).round(2).to_string(index=False))
# 市場內再看處置
print('\n市場內「處置中或當晚公告」的事件率：')
for mkt in ('tse', 'otc'):
    m = (market == mkt); d_ = m & (IN | PEND); n_ = m & ~(IN | PEND)
    print(f'  {mkt}: 處置/公告 列{int(d_.sum()):,} 事件率 {y[d_].mean()*100:.3f}%（{int(y[d_].sum())}）；其餘 列{int(n_.sum()):,} 事件率 {y[n_].mean()*100:.3f}%（{int(y[n_].sum())}）')
# 前 10 名（外樣本）的構成
O = np.load(f'{E.B.SP}/oof{E.TAG}.npz'); sc_full = O['gbdt_rank']
ex = np.load(f'{E.B.SP}/{E.DATASET}')['m_extra'].astype(bool) if 'm_extra' in np.load(f'{E.B.SP}/{E.DATASET}').files else np.zeros(len(sc_full), bool)
sc = sc_full[~ex]; test = np.isfinite(sc)
idx = np.nonzero(test)[0]; rk = E.rank_in_day_desc(sc[idx], s[idx]); top = idx[rk < 10]
print('\n外樣本前 10 名／日 的構成（共 %d 筆；母體對照）：' % len(top))
for lab, m in (('上櫃', market == 'otc'), ('上市', market == 'tse'), ('處置中(IN)', IN), ('當晚公告(PEND)', PEND), ('處置中或當晚公告', IN | PEND), ('剛結束≤10日', RECENT)):
    print(f'  {lab:14s} 前10名 {m[top].mean()*100:5.1f}%  vs 測試母體 {m[test].mean()*100:5.1f}%')
np.savez_compressed(f'{E.B.SP}/disp_status{E.TAG}.npz', IN=IN, PEND=PEND, RECENT=RECENT, since=since_r, n250=n250[s, j], market=market)
