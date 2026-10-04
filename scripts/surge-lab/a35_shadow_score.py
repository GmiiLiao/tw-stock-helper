"""a35_shadow_score.py — 對答案：拿凍結檔＋下一交易日收盤，算影子名單與站上同日 pred 的命中。

用法（週一收盤後只需這一條；需要的收盤／除權息會唯讀補抓）
  python3 a35_shadow_score.py out/shadow_2026-10-02.json --fetch
  python3 a35_shadow_score.py out/shadow_2026-10-02.json                 # 面板（panel.npz）已含下一交易日時不需 --fetch
  python3 a35_shadow_score.py 'out/shadow_hist/shadow_*.json'            # 多檔＝逐日＋合併（Wilson／5 日區塊 bootstrap／兩市脈絡）
  python3 a35_shadow_score.py out/shadow_hist/shadow_2026-09-30.json     # 演練：對舊日期（面板已有隔日）
輸出：逐名單的 精確度／可買精確度（隔日漲停且開盤 < 漲停價）／新起漲 vs 延續（打分日已漲停）分開／分市場、與當日基準率（lift）、
      兩市當日漲跌停家數／成交值上下文；寫 out/shadow_score_{日}.json（多檔時 out/shadow_score_pooled.json＋shadow_score_days.csv）。
漲停真值：build.build_events 的 LU（除權息參考價＋檔位）；另以 daemon 規則（前收×1.1 取檔位）交叉檢查，兩者不一致的檔列出。
防呆：凍結檔 sha256 不符→拒絕；下一交易日兩市收盤檔數不足（上櫃延遲）→拒絕（--allow-incomplete 才放行）；
      下一交易日的除權息尚未涵蓋→警告（該日除權息股的漲停判定可能不準）。
"""
import os
import sys
import json
import glob
import argparse
import subprocess
import plistlib
import warnings
import numpy as np
import pandas as pd
import a35_shadow_lib as L

warnings.filterwarnings('ignore')
B = L.B
KS = (10, 30)
LIST_NAMES = ('overallTop30', 'twseTop30', 'tpexTop30', 'freshTop30', 'continuationTop30', 'researchUniverseTop30')
SITE_LISTS = ('site_top10', 'site_top30', 'site_B', 'model_cont_matchedB')
MIN_MARKET_FRAC = 0.9          # 下一交易日各市場收盤檔數 ≥ 打分日的這個比例才算到齊


def wilson(h: float, n: float, z: float = 1.96) -> tuple:
    if n <= 0: return (None, None)
    p = h / n; c = p + z * z / (2 * n); r = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); d = 1 + z * z / n
    return (round(float((c - r) / d), 4), round(float((c + r) / d), 4))


# ───────────────────────── 下一交易日資料 ─────────────────────────
def _cred() -> str:
    pl = plistlib.load(open(os.path.expanduser('~/Library/LaunchAgents/com.gmii.twstock.ai-daemon.plist'), 'rb'))
    return (pl.get('EnvironmentVariables') or {}).get('GOOGLE_APPLICATION_CREDENTIALS')


def run_fetch(date: str) -> None:
    env = dict(os.environ)
    try: env['GOOGLE_APPLICATION_CREDENTIALS'] = _cred()
    except Exception as e: L.log(f'讀 plist 憑證失敗：{e}')
    r = subprocess.run(['node', os.path.join(L.HERE, 'a35_shadow_fetch.mjs'), date], capture_output=True, text=True, env=env, cwd=L.HERE, timeout=300)
    print((r.stdout + r.stderr).strip())
    if r.returncode not in (0, 3): raise RuntimeError(f'a35_shadow_fetch.mjs 失敗（{r.returncode}）')


def exright_status(day: str, cover: list) -> str:
    """目標日 day 的除權息資料涵蓋狀態（回傳警告文字；None＝完整涵蓋）。"""
    hist = json.load(open(os.path.join(B.REPO, 'scripts/data/exright-history.json'))).get('to') or '0000'
    delta_p = f'{L.SP}/exright_delta.json'
    delta = json.load(open(delta_p)) if os.path.exists(delta_p) else {}
    rec = [c for c in cover if c[0] == day]
    if day <= hist: return None
    if rec:
        d, err, counts, twse_only = rec[0]
        if err and not twse_only: return f'{day} 除權息抓取失敗（{err}）——當日除權息股的漲停判定可能不準'
        if err and twse_only: return f'{day} 上櫃除權息抓取失敗（{err}），僅補上市——上櫃當日除權息股的漲停判定可能不準'
        return None
    if delta.get('to') and day <= delta['to']: return f'{day} 只有上市除權息（exright_delta.json；上櫃：{delta.get("tpex")}）——上櫃當日除權息股的漲停判定可能不準'
    return f'{day} 的除權息資料尚未補（exright-history 止於 {hist}）：加 --fetch 或先跑 node a35_shadow_fetch.mjs {day}；否則當日除權息股的漲停判定可能不準'


def panel_with_day(day: str, allow_fetch: bool) -> tuple:
    """面板（含 day 這一天）。面板沒有就用 a35_shadow_close_{day}.json 補一列（唯讀抓取）。回傳 (dates, codes, P, source)。"""
    dates, codes, P = L.load_default_panel()
    if day in dates: return dates, codes, P, 'panel.npz'
    pf = f'{L.SP}/a35_shadow_close_{day}.json'
    if not os.path.exists(pf):
        if not allow_fetch: raise SystemExit(f'面板沒有 {day}，且沒有 {pf}；請加 --fetch（唯讀補抓下一交易日收盤）')
        run_fetch(day)
    if not os.path.exists(pf): raise SystemExit(f'補抓後仍沒有 {pf}（chipArchive/{day} 尚未寫入？）')
    j = json.load(open(pf))
    if j.get('complete') is False or j.get('otcPending'): L.log(f'⚠ chipArchive/{day} complete={j.get("complete")} otcPending={j.get("otcPending")}')
    ci = {c: i for i, c in enumerate(codes)}
    T, N = P['C'].shape
    P2 = {k: np.vstack([v, np.full((1, N), np.nan)]) for k, v in P.items()}
    for c, v in (j.get('close') or {}).items():
        i = ci.get(c)
        if i is not None: P2['C'][T, i], P2['V'][T, i], P2['O'][T, i], P2['H'][T, i], P2['L'][T, i] = v[0], v[1], v[2], v[3], v[4]
    return list(dates) + [day], codes, P2, f'.surge-cache/a35_shadow_close_{day}.json'


# ───────────────────────── 單日對答案 ─────────────────────────
def daemon_lu(c: np.ndarray, pc: np.ndarray) -> np.ndarray:
    """站上 daemon 規則（ai-daemon.mjs luIsLimitUp）：前收×1.1 以「前收所在檔位」向下取整。"""
    tk = B.tick_of(pc)
    lim = np.floor(pc * 1.1 / tk + 1e-9) * tk
    return (pc > 0) & (c > 0) & (c >= np.round(lim, 2) - 1e-9)


def stats_of(codes: list, ci: dict, lu_s: np.ndarray, lu1: np.ndarray, buy1: np.ndarray, mk: np.ndarray, k: int = None) -> dict:
    codes = codes[:k] if k else codes
    idx = [ci.get(c) for c in codes]
    known = [i for i in idx if i is not None]
    a = np.array(known, int)
    n = len(codes)
    if len(a) == 0: return dict(n=n, unknown=n, hit=0, buy=0, nFresh=0, hitFresh=0, nCont=0, hitCont=0, nTse=0, hitTse=0, nOtc=0, hitOtc=0)
    fresh = ~lu_s[a]; hit = lu1[a]; buy = buy1[a]
    return dict(n=n, unknown=n - len(a), hit=int(hit.sum()), buy=int(buy.sum()),
                nFresh=int(fresh.sum()), hitFresh=int((hit & fresh).sum()), nCont=int((~fresh).sum()), hitCont=int((hit & ~fresh).sum()),
                nTse=int((mk[a] == 'tse').sum()), hitTse=int((hit & (mk[a] == 'tse')).sum()), nOtc=int((mk[a] == 'otc').sum()), hitOtc=int((hit & (mk[a] == 'otc')).sum()))


def site_selections(site: dict) -> dict:
    codes = site.get('codes') or []; ranks = site.get('ranksTop120') or {}
    top10 = [c for c, r in sorted(ranks.items(), key=lambda kv: kv[1]) if r <= 10] if ranks else codes[:10]
    if len(top10) != 10: top10 = codes[:10]
    return dict(site_top10=top10, site_top30=codes[:30], site_B=[b['code'] for b in (site.get('bList') or [])])


def score_one(fz: dict, x: L.Ctx, t: int, t1: int, allow_incomplete: bool, exright_cover: list) -> dict:
    s_day, d1 = x.dates[t], x.dates[t1]
    cnt = lambda tt, m: int(((x.mk == m) & np.isfinite(x.P['C'][tt])).sum())
    cov = {m: (cnt(t, m), cnt(t1, m)) for m in ('tse', 'otc')}
    incomplete = [m for m, (a, b) in cov.items() if b < MIN_MARKET_FRAC * a]
    if incomplete and not allow_incomplete:
        raise SystemExit(f'{d1} 收盤檔數不足（{cov}；{incomplete} < {MIN_MARKET_FRAC:.0%} × 打分日）——上櫃／上市資料可能尚未到齊，拒絕對答案（--allow-incomplete 可放行）')
    ci = {c: i for i, c in enumerate(x.codes)}
    lu_s = x.LU[t]; lu1 = x.LU[t1] & np.isfinite(x.P['C'][t1]); buy1 = lu1 & ~x.open_lim[t1]
    pc = x.prev[t1]; c1 = x.P['C'][t1]
    lu1_daemon = daemon_lu(c1, pc) & np.isfinite(c1)
    disagree = [dict(code=x.codes[j], name=x.names.get(x.codes[j], ''), buildLU=bool(lu1[j]), daemonLU=bool(lu1_daemon[j]), close=float(c1[j]), prevClose=float(pc[j]), fDay=float(x.F_day[t1, j]))
                for j in np.nonzero(lu1 ^ lu1_daemon)[0]]
    # 基準率（站上實盤濾網母體；打分日已漲停／未漲停分層）
    js = L.live_universe(x, t); pool = L.pool_mask(x, t, js); pj = js[pool]
    base = {}
    for name, m in (('all', np.ones(len(pj), bool)), ('fresh', ~lu_s[pj]), ('cont', lu_s[pj]), ('tse', x.mk[pj] == 'tse'), ('otc', x.mk[pj] == 'otc')):
        n = int(m.sum()); h = int(lu1[pj][m].sum())
        base[name] = dict(n=n, hit=h, buy=int(buy1[pj][m].sum()), rate=round(h / n, 5) if n else None)
    res = dict(scoringDay=s_day, targetDay=d1, frozenSha256=fz['sha256'], kind=fz.get('kind'), modelHash=fz.get('modelHash'), trainCutoff=fz['training']['cutoffDate'],
               generatedAt=fz.get('generatedAt'), coverage=dict(tse=dict(scoringDay=cov['tse'][0], targetDay=cov['tse'][1]), otc=dict(scoringDay=cov['otc'][0], targetDay=cov['otc'][1])),
               exrightCoverage=[dict(date=d, error=e, counts=c, twseOnly=w) for (d, e, c, w) in exright_cover],
               truth=dict(rule='build.build_events LU（除權息參考價＋檔位）；buyable＝LU 且開盤價 < 漲停價', nLimitUp=int(lu1.sum()), nBuyableLimitUp=int(buy1.sum()),
                          nLimitUpDaemonRule=int(lu1_daemon.sum()), disagreeWithDaemonRule=disagree),
               baseRatePool=base, marketContext=dict(scoringDay=fz.get('marketContext'), targetDay=L.market_context(x, t1)), lists={})
    for name in LIST_NAMES:
        codes = [e['code'] for e in fz['lists'].get(name, [])]
        res['lists'][name] = {str(k): stats_of(codes, ci, lu_s, lu1, buy1, x.mk, k) for k in KS}
    sel = site_selections(fz.get('site') or {})
    res['site'] = dict(source=(fz.get('site') or {}).get('source'), writtenAt=(fz.get('site') or {}).get('writtenAt'), nB=len(sel['site_B']))
    res['lists']['site_top10'] = {'10': stats_of(sel['site_top10'], ci, lu_s, lu1, buy1, x.mk)}
    res['lists']['site_top30'] = {'30': stats_of(sel['site_top30'], ci, lu_s, lu1, buy1, x.mk)}
    res['lists']['site_B'] = {'B': stats_of(sel['site_B'], ci, lu_s, lu1, buy1, x.mk)}
    nb = len(sel['site_B'])
    cont = [e['code'] for e in fz['lists'].get('continuationTop30', [])][:L.EVAL_TOP]   # 舊名單只有 30 列：比對口徑固定前 30
    res['lists']['model_cont_matchedB'] = {'B': stats_of(cont, ci, lu_s, lu1, buy1, x.mk, nb)} if nb else {}
    hit_of = lambda e: dict(rank=e['rank'], code=e['code'], name=e['name'], market=e['market'], lu=bool(lu1[ci[e['code']]]) if e['code'] in ci else None,
                            buyable=bool(buy1[ci[e['code']]]) if e['code'] in ci else None, limitUpAtS=e['limitUpAtS'])
    # 逐檔對答案：每個子榜都列（2026-10-04 起，供管理後台逐檔標示；舊版只有 overallTop30）
    res['hits'] = {name: [hit_of(e) for e in fz['lists'].get(name, [])] for name in LIST_NAMES}
    res['hits']['site_top30'] = [dict(rank=i + 1, code=c, lu=bool(lu1[ci[c]]) if c in ci else None, buyable=bool(buy1[ci[c]]) if c in ci else None,
                                      limitUpAtS=bool(lu_s[ci[c]]) if c in ci else None) for i, c in enumerate(sel['site_top30'])]
    return res


def fmt(st: dict, key: str = 'hit') -> str:
    return f'{st[key]:>2}/{st["n"]:<2}'


def print_day(r: dict) -> None:
    b = r['baseRatePool']; mc = r['marketContext']['targetDay']
    print(f'\n════ 打分日 {r["scoringDay"]} → 對答案 {r["targetDay"]}  （凍結檔 {r["frozenSha256"][:12]}、模型 {r["modelHash"][:12]}、訓練截止 {r["trainCutoff"]}）')
    print(f'  漲停（build 規則）{r["truth"]["nLimitUp"]} 檔（可買 {r["truth"]["nBuyableLimitUp"]}；daemon 規則 {r["truth"]["nLimitUpDaemonRule"]}；兩規則不一致 {len(r["truth"]["disagreeWithDaemonRule"])} 檔）'
          f'｜上市 {mc["tse"]["nLimitUp"]}／上櫃 {mc["otc"]["nLimitUp"]}；跌停 上市 {mc["tse"]["nLimitDown"]}／上櫃 {mc["otc"]["nLimitDown"]}')
    print(f'  基準率（站上濾網母體 {b["all"]["n"]} 檔）：整體 {b["all"]["rate"] * 100:.2f}%｜新起漲 {b["fresh"]["rate"] * 100:.2f}%（{b["fresh"]["n"]} 檔）｜延續（打分日已漲停）{(b["cont"]["rate"] or 0) * 100:.1f}%（{b["cont"]["n"]} 檔）'
          f'｜上市 {b["tse"]["rate"] * 100:.2f}%｜上櫃 {b["otc"]["rate"] * 100:.2f}%')
    print(f'  {"名單":<24}{"命中":>7}{"可買":>7}{"新起漲":>9}{"延續":>9}{"上市":>9}{"上櫃":>9}')
    for name, ks in r['lists'].items():
        for k, st in ks.items():
            lab = f'{name}@{k}'
            print(f'  {lab:<24}{fmt(st):>7}{fmt(st, "buy"):>7}{st["hitFresh"]:>5}/{st["nFresh"]:<3}{st["hitCont"]:>5}/{st["nCont"]:<3}{st["hitTse"]:>5}/{st["nTse"]:<3}{st["hitOtc"]:>5}/{st["nOtc"]:<3}')
    for w in r.get('warnings', []): print('  ⚠', w)


# ───────────────────────── 合併 ─────────────────────────
def pooled(days: list, boot: int, block: int, seed: int = 20261004) -> dict:
    out = {}
    keys = sorted({(n, k) for d in days for n, ks in d['lists'].items() for k in ks})
    nd = len(days)
    rng = np.random.default_rng(seed)
    nb = int(np.ceil(nd / block)); blk = np.arange(nd) // block
    draws = rng.integers(0, nb, size=(boot, nb)); W = np.zeros((boot, nb))
    for j in range(nb): W[np.arange(boot), draws[:, j]] += 1
    W = W[:, blk]                                              # (boot, nd) 各日權重
    for (n, k) in keys:
        row = {}
        for fld in ('n', 'hit', 'buy', 'nFresh', 'hitFresh', 'nCont', 'hitCont', 'nTse', 'hitTse', 'nOtc', 'hitOtc'):
            row[fld] = np.array([d['lists'].get(n, {}).get(k, {}).get(fld, 0) for d in days], float)
        tot = {f: float(v.sum()) for f, v in row.items()}
        rec = dict(days=int(((row['n']) > 0).sum()), **{f: int(v) for f, v in tot.items()})
        for lab, num, den in (('precision', 'hit', 'n'), ('buyable', 'buy', 'n'), ('fresh', 'hitFresh', 'nFresh'), ('cont', 'hitCont', 'nCont'), ('tse', 'hitTse', 'nTse'), ('otc', 'hitOtc', 'nOtc')):
            if tot[den] > 0:
                rec[lab] = round(tot[num] / tot[den], 4); rec[lab + 'Wilson'] = wilson(tot[num], tot[den])
                d = W @ row[den]; ok = d > 0
                bs = (W @ row[num])[ok] / d[ok]
                rec[lab + 'Block'] = (round(float(np.percentile(bs, 2.5)), 4), round(float(np.percentile(bs, 97.5)), 4))
        out[f'{n}@{k}'] = rec
    # 配對差（影子 vs 站上）
    diffs = {}
    for a, b in (('overallTop30@10', 'site_top10@10'), ('overallTop30@30', 'site_top30@30'), ('model_cont_matchedB@B', 'site_B@B')):
        if a in out and b in out:
            na, ha = np.array([d['lists'].get(a.split('@')[0], {}).get(a.split('@')[1], {}).get('n', 0) for d in days], float), np.array([d['lists'].get(a.split('@')[0], {}).get(a.split('@')[1], {}).get('hit', 0) for d in days], float)
            nb_, hb = np.array([d['lists'].get(b.split('@')[0], {}).get(b.split('@')[1], {}).get('n', 0) for d in days], float), np.array([d['lists'].get(b.split('@')[0], {}).get(b.split('@')[1], {}).get('hit', 0) for d in days], float)
            if na.sum() > 0 and nb_.sum() > 0:
                est = ha.sum() / na.sum() - hb.sum() / nb_.sum()
                da = (W @ ha) / np.maximum(W @ na, 1e-9) - (W @ hb) / np.maximum(W @ nb_, 1e-9)
                diffs[f'{a} - {b}'] = dict(diff=round(float(est), 4), ci95=(round(float(np.percentile(da, 2.5)), 4), round(float(np.percentile(da, 97.5)), 4)), pGt0=round(float((da > 0).mean()), 3))
    return dict(days=nd, blockDays=block, bootstrap=boot, lists=out, pairedDiffs=diffs)


def context_analysis(days: list) -> dict:
    """使用者假設：隔日漲停家數隨「大盤＋成交值」浮動——命中率應與當日市場容量一起看。每日一列、依當日漲停家數／成交值分三組。"""
    rows = []
    for d in days:
        mc = d['marketContext']['targetDay']
        r = dict(day=d['targetDay'], nLU_all=mc['all']['nLimitUp'], nLU_tse=mc['tse']['nLimitUp'], nLU_otc=mc['otc']['nLimitUp'],
                 nLD_all=mc['all']['nLimitDown'], turnover_tse=mc['tse']['turnoverMNTD'], turnover_otc=mc['otc']['turnoverMNTD'],
                 med_tse=mc['tse']['medianRetPct'], med_otc=mc['otc']['medianRetPct'], idx_otc=mc['otc'].get('indexRetPct'),
                 base_all=d['baseRatePool']['all']['rate'])
        for nm, k in (('model30', ('overallTop30', '30')), ('model10', ('overallTop30', '10')), ('site30', ('site_top30', '30')), ('site10', ('site_top10', '10'))):
            st = d['lists'].get(k[0], {}).get(k[1])
            r[nm + '_hit'] = st['hit'] if st else np.nan; r[nm + '_n'] = st['n'] if st else np.nan
        rows.append(r)
    df = pd.DataFrame(rows)
    out = dict(perDay=df.to_dict('records'))
    if len(df) >= 12:
        rk = lambda s: s.rank()
        cors = {}
        for a in ('nLU_all', 'turnover_tse', 'med_tse', 'med_otc'):
            for b in ('model30_hit', 'site30_hit', 'base_all'):
                if df[a].notna().sum() > 5 and df[b].notna().sum() > 5:
                    cors[f'spearman({a},{b})'] = round(float(rk(df[a]).corr(rk(df[b]))), 3)
        out['spearman'] = cors
        df['tercile'] = pd.qcut(df['nLU_all'].rank(method='first'), 3, labels=['少漲停日', '中', '多漲停日'])
        t = []
        for g, s in df.groupby('tercile', observed=True):
            t.append(dict(group=str(g), days=len(s), meanLU=round(float(s.nLU_all.mean()), 1), baseRate=round(float(s.base_all.mean()), 4),
                          model30=round(float(s.model30_hit.sum() / s.model30_n.sum()), 4), site30=round(float(s.site30_hit.sum() / s.site30_n.sum()), 4) if s.site30_n.sum() else None))
        out['byLimitUpTercile'] = t
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('frozen', nargs='+', help='凍結檔（可多個、可用引號包起來的 glob）')
    ap.add_argument('--fetch', action='store_true', help='面板沒有下一交易日時，唯讀補抓收盤＋除權息（a35_shadow_fetch.mjs）')
    ap.add_argument('--allow-incomplete', action='store_true', help='下一交易日收盤檔數不足也照算（不建議）')
    ap.add_argument('--out', help='單檔輸出路徑（預設 out/shadow_score_{日}.json）；多檔時為合併輸出（預設 out/shadow_score_pooled.json）')
    ap.add_argument('--boot', type=int, default=2000); ap.add_argument('--block', type=int, default=5)
    ap.add_argument('--quiet-days', action='store_true', help='多檔時不印逐日表')
    a = ap.parse_args()
    paths = sorted({p for pat in a.frozen for p in (glob.glob(pat) or [pat])})
    fzs = []
    for p in paths:
        fz = json.load(open(p, encoding='utf-8'))
        if not L.verify_seal(fz): raise SystemExit(f'{p} 的 sha256 與內容不符——凍結檔被改過或毀損，拒絕對答案')
        fzs.append((p, fz))
    fzs.sort(key=lambda z: z[1]['scoringDay'])
    last_day = fzs[-1][1]['scoringDay']
    # 需要的最後一個目標日
    dates0, _, _ = L.load_default_panel()
    need = None
    if last_day == dates0[-1]: need = fzs[-1][1].get('targetDay')
    if need and need > dates0[-1]:
        dates, codes, P, src = panel_with_day(need, a.fetch)
    else:
        dates, codes, P = L.load_default_panel(); src = 'panel.npz'
    extra, cover = L.load_extra_exright()
    x = L.build_ctx(dates, codes, P, with_features=False, extra_factor_items=extra)
    L.log(f'面板來源 {src}；日期 {dates[0]}～{dates[-1]}；額外除權息 {len(extra)} 筆（涵蓋檔 {[c[0] for c in cover]}）')
    days = []
    for p, fz in fzs:
        s_day = fz['scoringDay']
        if s_day not in x.dates: print(f'略過 {p}：面板沒有 {s_day}'); continue
        t = x.dates.index(s_day)
        if t + 1 >= x.T: print(f'略過 {p}：{s_day} 是面板最後一天，還沒有下一交易日收盤（用 --fetch）'); continue
        t1 = t + 1
        r = score_one(fz, x, t, t1, a.allow_incomplete, cover)
        r['warnings'] = []
        if fz.get('targetDay') and fz['targetDay'] != x.dates[t1]: r['warnings'].append(f'凍結檔預期下一交易日 {fz["targetDay"]}，面板實際為 {x.dates[t1]}')
        w = exright_status(x.dates[t1], cover)
        if w: r['warnings'].append(w)
        if r['truth']['disagreeWithDaemonRule']: r['warnings'].append('build 規則與 daemon 規則對 ' + '、'.join(d['code'] for d in r['truth']['disagreeWithDaemonRule'][:10]) + ' 判定不同（見 JSON truth.disagreeWithDaemonRule）')
        days.append(r)
        if len(fzs) == 1 or not a.quiet_days: print_day(r)
    if not days: return 1
    if len(days) == 1:
        # 只有事前凍結的對答案放 out/shadow_score_{日}.json（後台發佈讀這個）；歷史回推／補產的演練另存，不蓋掉同日的前向結果
        d0 = days[0]
        out = a.out or (os.path.join(L.OUT, f'shadow_score_{d0["scoringDay"]}.json') if d0.get('kind') == 'frozen-forward'
                        else os.path.join(L.OUT, 'shadow_hist', f'shadow_score_{d0["scoringDay"]}.{d0.get("kind")}.json'))
        L.write_json(out, days[0]); L.log(f'寫入 {out}')
        return 0
    P_ = pooled(days, a.boot, a.block)
    ctx = context_analysis(days)
    out = a.out or os.path.join(L.OUT, 'shadow_score_pooled.json')
    # frozenSha256／hits：供管理後台把每日逐檔結果對回同一份凍結名單（2026-10-04）
    L.write_json(out, dict(pooled=P_, context=ctx, days=[dict(scoringDay=d['scoringDay'], targetDay=d['targetDay'], lists=d['lists'], baseRatePool=d['baseRatePool'], nLimitUp=d['truth']['nLimitUp'],
                                                                nBuyableLimitUp=d['truth']['nBuyableLimitUp'], frozenSha256=d['frozenSha256'], hits=d['hits'],
                                                                marketContext=d['marketContext'], warnings=d.get('warnings', [])) for d in days]))
    pd.DataFrame(ctx['perDay']).to_csv(os.path.join(L.OUT, os.path.basename(out).replace('.json', '_days.csv')), index=False)
    print(f'\n════ 合併 {len(days)} 日（{days[0]["scoringDay"]}～{days[-1]["scoringDay"]}）；Wilson 95%（逐筆）／{a.block} 日區塊 bootstrap 95%')
    print(f'  {"名單":<26}{"n":>6}{"命中":>7}{"精確度":>8}{"Wilson":>16}{"區塊":>16}{"可買":>8}{"新起漲":>9}{"延續":>9}{"上市":>9}{"上櫃":>9}')
    pc = lambda v: '   —  ' if v is None else f'{v * 100:5.1f}%'
    rg = lambda t: '       —      ' if not t else f'[{t[0] * 100:4.1f},{t[1] * 100:4.1f}]'
    for k, r in P_['lists'].items():
        if 'precision' not in r: continue
        print(f'  {k:<26}{r["n"]:>6}{r["hit"]:>7}{pc(r["precision"]):>8}{rg(r.get("precisionWilson")):>16}{rg(r.get("precisionBlock")):>16}{pc(r.get("buyable")):>8}{pc(r.get("fresh")):>9}{pc(r.get("cont")):>9}{pc(r.get("tse")):>9}{pc(r.get("otc")):>9}')
    for k, d in P_['pairedDiffs'].items(): print(f'  配對差 {k}: {d["diff"] * 100:+.1f}pp  區塊 95% [{d["ci95"][0] * 100:+.1f}, {d["ci95"][1] * 100:+.1f}]  P(差>0)={d["pGt0"]}')
    if ctx.get('byLimitUpTercile'):
        print('  依當日漲停家數分三組：' + '；'.join(f'{g["group"]}（{g["days"]} 日、均 {g["meanLU"]} 檔漲停、基準 {g["baseRate"] * 100:.2f}%）影子@30 {g["model30"] * 100:.1f}% 站上@30 {("%.1f%%" % (g["site30"] * 100)) if g["site30"] is not None else "—"}' for g in ctx['byLimitUpTercile']))
        print('  Spearman：' + '、'.join(f'{k} {v}' for k, v in ctx['spearman'].items()))
    L.log(f'寫入 {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
