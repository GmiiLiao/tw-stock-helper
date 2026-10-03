"""前視安全的注意→處置升級校準（取代 a22／a27 以「累計」欄位計數的錯誤版本）。
「累計次數」不能用：上市＝查詢區間內該股列數（含區間內之後的公告＝前視），上櫃＝當日公告總股數（a29 前置驗證 100%）。
改用官方處置規則模擬（TWSE notetrans 註記）：處置觸發＝第1款連續3日｜計入條款連續5日｜最近10日內6日｜最近30日內12日；
「可能達處置」（再一天就處置）＝第1款連續2日｜計入條款連續4日｜最近9日內≥5日｜最近29日內≥11日（計入條款、重新計數等細則見下方註解，以官方名單逐檔修正）。
先以 2026-10-02 官方名單驗證模擬，再算 P(10 個交易日內出現處置公告 | D 日狀態)，流動股、分市場。"""
import numpy as np, pandas as pd, json, warnings
import build as B, attention as AT, disposal as DP
warnings.filterwarnings('ignore')
pd.set_option('display.width', 220)
dates, codes, P = B.load_panel(); T, N = P['C'].shape; d_arr = np.array(dates); ci = {c: i for i, c in enumerate(codes)}
mk = json.load(open(f'{B.SP}/code_market.json')); market = np.array([mk.get(c, '?') for c in codes])
C1 = np.zeros((T, N), bool); C18 = np.zeros((T, N), bool); ANY = np.zeros((T, N), bool); ONLYH = np.zeros((T, N), bool)
for code, d, cum, txt, src in AT.load_rows():
    j = ci.get(code)
    if j is None or not d: continue
    t = int(np.searchsorted(d_arr, d))
    if t >= T or d_arr[t] != d: continue
    cl = set(AT.clauses(txt)); ANY[t, j] = True
    if 1 in cl: C1[t, j] = True
    if cl & set(range(1, 9)): C18[t, j] = True
ONLYH = ANY & ~C18
Z = np.load(f'{B.SP}/disposal_mats.npz'); DISP = Z['DISP']
# 規則（以 2026-10-02 官方兩份名單逐檔對照修正）：
#   · 一般處置期間的注意日照樣計（條文只排除「監視督導會報決議」的特殊處置）；但每次處置「開始日」起重新計數（之前的注意日不再計）
#   · 計入處置的條款：上市第 1~5、7、8 款（第 6 款估值型不計）；上櫃第 1~8 款（含第 6 款）
#   · 「可能達處置」不要求 D 日當天被注意，只看截至 D 日的視窗
C6 = np.zeros((T, N), bool)
for code, d, cum, txt, src in AT.load_rows():
    j = ci.get(code)
    if j is None or not d: continue
    t = int(np.searchsorted(d_arr, d))
    if t < T and d_arr[t] == d and 6 in set(AT.clauses(txt)): C6[t, j] = True
is_otc = (market == 'otc')[None, :]
CNT = np.where(is_otc, C18, C18 & ~(C6 & ~(C18 & ~C6)))   # 先粗算，下行精算
# 精算：上市「計入」＝含第 1~5、7、8 款任一（只有第 6 款者不計）
cl_other = np.zeros((T, N), bool)
for code, d, cum, txt, src in AT.load_rows():
    j = ci.get(code)
    if j is None or not d: continue
    t = int(np.searchsorted(d_arr, d))
    if t < T and d_arr[t] == d and set(AT.clauses(txt)) & {1, 2, 3, 4, 5, 7, 8}: cl_other[t, j] = True
CNT = np.where(is_otc, C18, cl_other)
START = Z['START']
last_start = np.maximum.accumulate(np.where(START, np.arange(T)[:, None], -1), axis=0)   # 截至 t 最近一次處置起日
def since_reset_run(X):
    out = np.zeros(X.shape, np.int16); r = np.zeros(X.shape[1], np.int16)
    for t in range(X.shape[0]):
        reset = START[t]; r = np.where(reset & ~X[t], 0, r)
        r = np.where(X[t], np.where(reset, 1, r + 1), 0); out[t] = r
    return out
def since_reset_wsum(X, w):
    out = np.zeros(X.shape, np.int16)
    cs = np.vstack([np.zeros((1, X.shape[1]), np.int32), np.cumsum(X, axis=0, dtype=np.int32)])
    for t in range(X.shape[0]):
        lo = np.maximum(t - w + 1, np.maximum(last_start[t], 0)); lo = np.minimum(lo, t + 1)
        out[t] = cs[t + 1] - cs[lo, np.arange(X.shape[1])]
    return out
r1 = since_reset_run(C1); r18 = since_reset_run(CNT); s9 = since_reset_wsum(CNT, 9); s29 = since_reset_wsum(CNT, 29)
N1 = (r1 == 2); N2 = (r18 == 4); N3 = (s9 >= 5); N4 = (s29 >= 11)
NEAR = N1 | N2 | N3 | N4
C18c = CNT                      # 下方校準沿用此名稱＝「計入處置的注意」
# ── 驗證：2026-10-02 官方名單 ──
t0 = dates.index('2026-10-02')
official = {'tse': {'2033', '2305', '3016', '6533', '6672', '8201'}, 'otc': {'3455', '6538', '6708'}}
sim = {m: {codes[j] for j in np.nonzero(NEAR[t0])[0] if market[j] == m} for m in ('tse', 'otc')}
for m in ('tse', 'otc'):
    print(f'2026-10-02 {m}：官方 {sorted(official[m])}｜模擬 {sorted(sim[m])}｜交集 {len(official[m] & sim[m])}/{len(official[m])}，模擬多出 {sorted(sim[m] - official[m])}')
# ── 校準 ──
vol20 = pd.DataFrame(P['V']).rolling(20, min_periods=15).mean().values
liq = np.isfinite(P['C']) & (P['C'] >= 10) & (vol20 >= 300); liq[:130] = False
DPUB = np.load(f'{B.SP}/att_mats.npz')['DPUB']
nxt10 = np.zeros((T, N), bool)
for k in range(1, 11): nxt10[:T - k] |= DPUB[k:]
ok = liq & ~DISP; ok[T - 10:] = False
cnt10 = since_reset_wsum(C18c, 10)
states = {
    '可能達處置（模擬官方名單）': NEAR,
    '注意（第1~8款）且非可能達處置': C18c & ~NEAR,
    '注意但只因不計入的條款（上市第6、9~13款；上櫃第9~13款）': ANY & ~CNT & ~NEAR,   # 互斥：與正式程式同優先序（高＞中＞低＞無）
    '當日無注意': ~ANY & ~NEAR,
}
rows = []
for lab, m0 in states.items():
    for mkt in ('tse', 'otc', 'all'):
        m = ok & m0 & ((market[None, :] == mkt) if mkt != 'all' else True)
        if m.sum(): rows.append(dict(狀態=lab, 市場=mkt, 列數=int(m.sum()), 十日內處置=nxt10[m].mean() * 100))
R = pd.DataFrame(rows); print('\n— P(10 個交易日內出現處置公告 | D 日狀態)（流動股、非處置中）—')
print(R.pivot_table(index='狀態', columns='市場', values='十日內處置', sort=False).round(1).to_string())
print(R.pivot_table(index='狀態', columns='市場', values='列數', sort=False).to_string())
print('\n— 依「近 10 日第1~8款注意天數（含當日）」（D 日有第1~8款注意者）—')
rows = []
for lo, hi in ((1, 1), (2, 2), (3, 3), (4, 5), (6, 10)):
    for mkt in ('tse', 'otc'):
        m = ok & C18c & (cnt10 >= lo) & (cnt10 <= hi) & (market[None, :] == mkt)
        if m.sum(): rows.append(dict(近10日天數=f'{lo}~{hi}' if lo != hi else str(lo), 市場=mkt, 列數=int(m.sum()), 十日內處置=nxt10[m].mean() * 100, 其中可能達處置占=NEAR[m].mean() * 100))
print(pd.DataFrame(rows).pivot_table(index='近10日天數', columns='市場', values=['十日內處置', '列數'], sort=False).round(1).to_string())
# 給正式程式的表
cal = {}
for lab, key in (('可能達處置（模擬官方名單）', 'near'), ('注意（第1~8款）且非可能達處置', 'att18'), ('注意但只因不計入的條款（上市第6、9~13款；上櫃第9~13款）', 'heatOnly'), ('當日無注意', 'none')):
    cal[key] = {}
    for mkt in ('tse', 'otc'):
        r = R[(R.狀態 == lab) & (R.市場 == mkt)]
        if len(r): cal[key][mkt] = {'p': round(float(r.十日內處置.iloc[0]) / 100, 4), 'n': int(r.列數.iloc[0])}
json.dump(cal, open(f'{B.SP}/escalation_pit.json', 'w'), ensure_ascii=False, indent=1); print('\n→ escalation_pit.json', json.dumps(cal, ensure_ascii=False))
