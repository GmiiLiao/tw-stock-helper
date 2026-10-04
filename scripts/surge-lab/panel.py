"""面板資料建置：chipArchive 快取 → 對齊的 (日期 × 代號) 矩陣。
輸入：chipArchive.json.gz（Firestore chipArchive 全量匯出）
輸出：panel.npz（C,V,O,H,L,IF,IT,ML,MS,LEND,DT）＋ dates / codes——**價格為原始（未還原）價**。
⚠ 2026-10-03 修正：舊版在這裡先套一次 priceEvents 係數，build.adjust 又把 priceEvents（＋除權息）再套一次 ⇒
  priceEvents 事件股的還原價被乘兩次、事件日被誤判成結構斷點（之後 125 日被排出母體），漲停價的參考價也算錯
  （2026-10-01 因此誤排 4303、5314、5386、6669）。現在面板只放原始價，所有還原只在 build.adjust 做一次；
  build_events 的漲停判定本來就以「原始前收 × 當日係數」為參考價，面板必須是原始價才對。
"""
import gzip, json, sys, os
import numpy as np

SP = os.environ.get('SURGE_CACHE', os.path.join(os.path.dirname(os.path.abspath(__file__)), '.surge-cache'))
MIN_STOCKS = 1500  # 殘缺日門檻（同經驗庫訓練）

def load_rows():
    with gzip.open(f'{SP}/chipArchive.json.gz', 'rt') as f:
        return json.load(f)

def build(rows):
    good = []
    skipped = []
    for r in rows:
        if not r.get('closeJson'):
            skipped.append((r['date'], 'no close')); continue
        m = json.loads(r['closeJson'])
        if len(m) < MIN_STOCKS:
            skipped.append((r['date'], f'only {len(m)}')); continue
        good.append((r['date'], m, r))
    good.sort(key=lambda x: x[0])
    dates = [g[0] for g in good]
    codes = sorted({c for _, m, _ in good for c in m if len(c) == 4 and c.isdigit() and not c.startswith('00')})
    ci = {c: i for i, c in enumerate(codes)}
    T, N = len(dates), len(codes)
    mk = lambda: np.full((T, N), np.nan, dtype=np.float64)
    C, V, O, H, L = mk(), mk(), mk(), mk(), mk()
    IF, IT, ML, MS, LEND, DT = mk(), mk(), mk(), mk(), mk(), mk()
    for t, (d, m, r) in enumerate(good):
        for c, v in m.items():
            j = ci.get(c)
            if j is None: continue
            C[t, j], V[t, j], O[t, j], H[t, j], L[t, j] = v[0], v[1], v[2], v[3], v[4]
        if r.get('instJson'):
            for c, v in json.loads(r['instJson']).items():
                j = ci.get(c)
                if j is not None: IF[t, j], IT[t, j] = v[0], v[1]
        if r.get('marginJson'):
            for c, v in json.loads(r['marginJson']).items():
                j = ci.get(c)
                if j is not None: ML[t, j], MS[t, j] = v[0], v[1]
        if r.get('lendingJson'):
            for c, v in json.loads(r['lendingJson']).items():
                j = ci.get(c)
                if j is not None: LEND[t, j] = v if not isinstance(v, list) else v[0]
        if r.get('dayTradeJson'):
            for c, v in json.loads(r['dayTradeJson']).items():
                j = ci.get(c)
                if j is not None: DT[t, j] = v if not isinstance(v, list) else v[0]
    return dates, codes, dict(C=C, V=V, O=O, H=H, L=L, IF=IF, IT=IT, ML=ML, MS=MS, LEND=LEND, DT=DT), skipped

def apply_factors(dates, codes, P, items):
    """（已停用，2026-10-03：會與 build.adjust 重複還原。保留函式僅供舊結果重現對照，勿在建面板時呼叫。）"""
    ci = {c: i for i, c in enumerate(codes)}
    d_arr = np.array(dates)
    n = 0
    for e in items or []:
        if not ((e.get('factor') or 0) > 0): continue
        j = ci.get(e['code'])
        if j is None: continue
        mask = d_arr < e['date']
        for k in ('C', 'O', 'H', 'L'):
            P[k][mask, j] *= e['factor']
        n += 1
    return n

if __name__ == '__main__':
    rows = load_rows()
    dates, codes, P, skipped = build(rows)
    # 不在面板套用任何還原係數（見檔頭；還原只在 build.adjust 做一次）
    print('days', len(dates), dates[0], dates[-1], 'codes', len(codes), 'skipped', len(skipped), skipped[:10], '（原始價，未還原）')
    # 原子寫入（2026-10-04）：研究腳本與起漲影子共用 panel.npz，先寫暫存檔再 os.replace，讀取中的程序不會讀到半套
    tmp = f'{SP}/panel.npz.tmp{os.getpid()}'
    with open(tmp, 'wb') as fh:
        np.savez_compressed(fh, dates=np.array(dates), codes=np.array(codes), **P)
    os.replace(tmp, f'{SP}/panel.npz')
    # 資料品質：每日檔數、相鄰日期間隔
    cnt = (~np.isnan(P['C'])).sum(1)
    print('stocks/day min/median/max', cnt.min(), int(np.median(cnt)), cnt.max())
    import datetime as dt
    gaps = []
    for a, b in zip(dates[:-1], dates[1:]):
        g = (dt.date.fromisoformat(b) - dt.date.fromisoformat(a)).days
        if g > 4: gaps.append((a, b, g))
    print('gaps>4d', gaps)
    for k in ('IF', 'ML', 'LEND', 'DT'):
        cov = (~np.isnan(P[k])).sum(1)
        print(k, 'days with data', int((cov > 500).sum()), 'first', dates[int(np.argmax(cov > 500))])
