"""官方注意股（TWSE notice＋TPEx attention）→ 與面板對齊的逐日矩陣。

語意（以資料驗證，a22 前置檢查）
  · 公告「日期」＝觸發日 X：公告列的收盤價欄位等於 X 當天收盤價（5,173/5,235＝98.8%）；盤後公布、次一營業日起生效。
    ⇒ 在 s＝X−1 收盤時，X 的公告尚不存在；PIT 特徵只能用 pub ≤ s−1 的公告。
  · 官方「最近六個營業日累積收盤價漲(跌)幅」＝最近 6 個交易日**單日報酬率的算術加總**（非複利）：6 個樣本逐一吻合（33.07% vs 33.1%…）。
條文分類（第 X 款）
  價格型：第 1～5 款（6 日累積漲跌幅，第 2 款為 60／90 日起迄兩日漲幅，第 3 款加成交量、第 4 款加週轉率、第 5 款加單一券商集中）；
          文字含「漲幅」＝RISE、「跌幅」＝FALL。
  其他（量能／週轉／估值／當沖／借券…）：第 6～13 款＝HEAT。
"""
import json, os, re
import numpy as np

SP = os.environ.get('SURGE_CACHE', os.path.join(os.path.dirname(os.path.abspath(__file__)), '.surge-cache'))
_DATE = re.compile(r'(\d{2,3})[./](\d{1,2})[./](\d{1,2})')
_CN = {'一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '十一': 11, '十二': 12, '十三': 13}


def iso(s):
    m = _DATE.search(str(s or ''))
    return f'{int(m.group(1)) + 1911:04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}' if m else None


def clauses(txt):
    return sorted({_CN[k] for k in re.findall(r'第([一二三四五六七八九十]+)款', txt) if k in _CN})


def load_rows():
    out = []
    tw = json.load(open(f'{SP}/attention_twse.json')); F = tw['fields']; ix = {k: i for i, k in enumerate(F)}
    for r in tw['data']:
        code = str(r[ix['證券代號']]).strip()
        if not re.fullmatch(r'\d{4}', code): continue
        out.append((code, iso(r[ix['日期']]), int(str(r[ix['累計次數']]).strip() or 0), str(r[ix['注意交易資訊']]), 'TWSE'))
    tp = json.load(open(f'{SP}/attention_tpex.json')); F = tp['fields']; ix = {k: i for i, k in enumerate(F)}
    for r in tp['data']:
        code = str(r[ix['證券代號']]).strip()
        if not re.fullmatch(r'\d{4}', code): continue
        out.append((code, iso(r[ix['公告日期']]), int(str(r[ix['累計']]).strip() or 0), str(r[ix['注意交易資訊']]), 'TPEx'))
    return out


def build_matrices(dates, codes):
    """回傳 dict：ANY／RISE／FALL／HEAT（T×N bool；公告日 X 當天為 True）、CUM（T×N int16；公告列的累計次數，同日多列取最大）。
       RISE＝含第 1～5 款且文字有「漲幅」；FALL＝第 1～5 款且「跌幅」；HEAT＝其他款（含第 6～13 款，且不是 RISE/FALL）。"""
    d_arr = np.array(dates); T = len(d_arr); N = len(codes); ci = {c: i for i, c in enumerate(codes)}
    ANY = np.zeros((T, N), bool); RISE = np.zeros((T, N), bool); FALL = np.zeros((T, N), bool); HEAT = np.zeros((T, N), bool)
    CUM = np.zeros((T, N), np.int16); miss = 0; rows = 0
    for code, d, cum, txt, src in load_rows():
        j = ci.get(code)
        if j is None or not d: continue
        t = int(np.searchsorted(d_arr, d))
        if t >= T or d_arr[t] != d: miss += 1; continue          # 非面板交易日（極少）
        rows += 1
        cl = set(clauses(txt)); price = bool(cl & {1, 2, 3, 4, 5})
        rise = price and '漲幅' in txt; fall = price and '跌幅' in txt and '漲幅' not in txt
        ANY[t, j] = True
        if rise: RISE[t, j] = True
        if fall: FALL[t, j] = True
        if not (rise or fall): HEAT[t, j] = True
        CUM[t, j] = max(CUM[t, j], cum)
    return dict(ANY=ANY, RISE=RISE, FALL=FALL, HEAT=HEAT, CUM=CUM, rows=rows, miss=miss)


def pit_features(A, T):
    """前視安全的注意股歷史特徵（只用 pub ≤ s−1 的公告）。回傳 name -> T×N float32。"""
    N = A['ANY'].shape[1]
    def lag1(X):
        out = np.zeros_like(X); out[1:] = X[:-1]; return out
    anyk = lag1(A['ANY'].astype(np.int32)); risek = lag1(A['RISE'].astype(np.int32))
    cs = np.cumsum(anyk, axis=0); cr = np.cumsum(risek, axis=0)
    def roll(a, w):
        out = a.copy(); out[w:] = a[w:] - a[:-w]; return out
    idx = np.where(anyk > 0, np.arange(T)[:, None], -1); last = np.maximum.accumulate(idx, axis=0)
    since = np.where(last >= 0, np.arange(T)[:, None] - last, 999).astype(np.float32)
    cum_last = lag1(A['CUM'].astype(np.int32)); cum_roll = np.maximum.accumulate(np.where(anyk > 0, cum_last, 0), axis=0)   # 近期最大累計（粗略）
    return {'at_cnt5': roll(cs, 5).astype(np.float32), 'at_cnt20': roll(cs, 20).astype(np.float32), 'at_cnt60': roll(cs, 60).astype(np.float32),
            'at_rise20': roll(cr, 20).astype(np.float32), 'at_since': since, 'at_cnt250': roll(cs, 250).astype(np.float32)}
