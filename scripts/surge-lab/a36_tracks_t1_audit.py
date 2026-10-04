"""T1 分軌研究：鎖後稽核與描述性補遺（2026-10-05 審查修正）。

登錄 T1-TRACKS-PREREG-2026-10-04 v2 凍結、HOLDOUT 鎖檔產出一律不動；本檔所有輸出都是「鎖後描述」，不參與任何判定、
不得用於重新選模。偏差與更正寫在 tracks/DEVIATIONS_t1_tracks.md 的 DEV-005～DEV-008。本檔不在 a36_tracks_cv.CODE_FILES 內，
新增它不會改變 HO 摘要內嵌的程式雜湊。

  verify-ho   HO 逐位重現（同 a36_tracks_cv.py ho-eval --verify-identical），把逐檔 lock／now／磁碟 sha256、HEAD、時間寫成
              out/tracks_t1/tracks_t1_HO_VERIFY.json。HO 摘要內嵌偏差紀錄標題清單（a36_tracks_cv.deviations）與程式雜湊，
              偏差紀錄增列之後嚴格逐位必然不同，因此另報「除 deviations 欄外相同」。
  addendum    --group SELHC|HO：以同一個 a36_tracks_cv.evaluate 從已存的分數檢查點重算（先核對記錄檔 sha256 與鎖檔／摘要相同），
              補輸出到 out/tracks_t1/addendum/（不覆寫任何登錄產出）：
                · M0@20 選股；M 軌事件對 M0@20、M_atr14@5、M_combo@5、Mp1_Monly@10 的命中／漏網
                · 等名額組合清單（final_lists、proxy_lists）的選股與命中／漏網
                · 既有選股記錄的逐列註記：清單層級判定、處置狀態（＝原 tradable_status 的實際語意）、t 日起處置、
                  出場日無收盤分類與出場價敏感度（m_ 欄）、名稱補齊（name_src）、依日期的市場別
                · 出場日無收盤的件數揭露、出場價敏感度、排除 t 日起處置的 T1 敏感度、（HO）以未捨入 p 重算的 Holm
  pack        未進版控的登錄產出與補遺：≤ 500,000 bytes 的原檔直接進版控；較大的檔 gzip（mtime＝0、可重現），
              壓縮後 > 1,000,000 bytes 才分片；tracks_t1_G0.json 來源核對 → out/tracks_t1/tracks_t1_ARTIFACT_MANIFEST.json
用法：SURGE_CACHE=… SURGE_OFFICIAL_LIMIT=… SURGE_REVENUE=revenue_official.json SURGE_PIT_STRICT=1 \\
      python3 a36_tracks_t1_audit.py verify-ho [--cli-stdout PATH] | addendum --group SELHC|HO | pack
報酬一律未扣成本（成本另列參考，不當門檻）·事後欄位以 m_ 標示·非投資建議。
"""
import contextlib
import gzip
import io
import json
import os
import subprocess
import sys
import time

import numpy as np
import pandas as pd

import a36_tracks_build as BLD
import a36_tracks_cv as CV
import a36_tracks_decide as DC
import a36_tracks_eval as EV
import a36_tracks_fit as FIT
import a36_tracks_lib as L

OUT = BLD.OUT_DIR
ADD_DIR = os.path.join(OUT, 'addendum')
GZ_DIR = os.path.join(OUT, 'gz')
REL_OUT = CV.REL_OUT
RAW_COMMIT_MAX = 500_000
SHARD_LIMIT = 1_000_000
POST_LOCK = '鎖後描述（2026-10-05 審查補遺）：不參與任何判定，不得用於重新選模'
SELF = 'a36_tracks_t1_audit.py'

EXPECTED_DECISIONS = {'Mp': 'MP-REJECT', 'R': 'R-WATCH-ONLY', 'S': 'S-KEEP-AS-SHADOW', 'S_FB': 'SFB-KEEP-AS-SHADOW',
                      'DD': 'DD-INCONCLUSIVE', 'M': 'M-UNCHANGED', 'W': 'W-WATCH-ONLY'}
LIST_VERDICT = {
    'M0@10': '主榜 M0 參照（M-UNCHANGED）；本研究未對 M0 作可交易判定',
    'M0@20': '描述用（等名額對照的對照組）',
    'M_atr14@5': '描述用（DD2）',
    'M_combo@5': '描述用（DD2）',
    'M0s@10': 'M0*（Mp 對照，不參賽）',
    'Mp1@10': 'MP-REJECT：不進影子',
    'Mp1_Monly@10': 'MP-REJECT（C1 的描述清單）',
    'SFB_atr14@5': 'SFB-KEEP-AS-SHADOW：觀察／研究榜（探索性，未納入 Holm），非可交易名單',
    'R0_combo@5': 'R-WATCH-ONLY：不可交易，僅觀察',
    'R1@5': 'R 挑戰者未經確認（HO-model 對 R0 為負）⇒ 清單退回 R0，不使用',
    'R2@5': '落選挑戰者（SELECTION CI 下界 ≤ 0），不使用',
    'S0_atr14@5': 'S-KEEP-AS-SHADOW：觀察／研究榜・代理 lift 的時間外複製・容量受限（非可交易名單）',
    'S1@5': '落選挑戰者（SELECTION CI 下界 ≤ 0），不使用',
    'S2@5': '落選挑戰者（SELECTION CI 下界 ≤ 0），不使用',
    'W_atr14@3': 'W-WATCH-ONLY：不可交易，僅觀察',
}
EXIT_LABEL = {
    'ok': '',
    'panel_end': '出場日超出面板（報酬未計）',
    'no_close_after': '出場日起面板內不再有收盤（下市或停牌至面板末；報酬未計）',
    'illiquid_no_trade': '出場日無成交（推定：s 日 nan20>0 的冷門股；報酬未計）',
    'halt_then_resume': '出場日無收盤、之後恢復收盤（推定停牌；報酬未計）',
    'na': '',
}
HORIZONS = (('c5', 5), ('c10', 10))


def log(msg):
    BLD.log(msg)


def now() -> str:
    return time.strftime('%Y-%m-%dT%H:%M:%S%z')


def canon(obj) -> str:
    """NaN 安全的內容比對字串（json 的 NaN 記號兩邊一致；dict 比較遇 NaN 會誤判不等）。"""
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, default=BLD._np_default)


def git(*a) -> str:
    return subprocess.run(['git', '-C', L.LAB, *a], capture_output=True, text=True, check=True).stdout.strip()


def code_sha() -> dict:
    return dict(CV.code_sha(), **{SELF: L.file_sha256(os.path.join(L.LAB, SELF))})


def rows_of(b: bytes) -> int:
    return max(b.count(b'\n') - 1, 0)


# ───────────────────────── 純函式（有單元測試）─────────────────────────
def last_valid_index(fin: np.ndarray) -> np.ndarray:
    """fin[T, N] → 每格 ≤ i 的最後一個 True 的索引（沒有則 −1）。"""
    idx = np.where(fin, np.arange(fin.shape[0])[:, None], -1)
    return np.maximum.accumulate(idx, axis=0)


def next_valid_index(fin: np.ndarray) -> np.ndarray:
    """fin[T, N] → 每格 ≥ i 的第一個 True 的索引（沒有則 T）。"""
    T = fin.shape[0]
    idx = np.where(fin, np.arange(T)[:, None], T)
    return np.minimum.accumulate(idx[::-1], axis=0)[::-1]


def exit_alternatives(Ca, Oa, s, j, base, buyable, nan20, k) -> dict:
    """可買選股在出場日 e＝s+k（t＝s+1 起第 k 個交易日收盤）沒有收盤時的分類與兩種描述性出場價（不補 0）。
    alt_last：e 之前（含）最後一個收盤（≥ t）；alt_next：e 起第一個開盤。base 有值的列兩種 alt 都等於 base。"""
    T = Ca.shape[0]
    t = s + 1
    e = s + k
    ec = np.minimum(e, T - 1)
    tc = np.minimum(t, T - 1)
    open_t = np.where(t < T, Oa[tc, j], np.nan)
    lc = last_valid_index(np.isfinite(Ca))[ec, j]
    nc = next_valid_index(np.isfinite(Ca))[ec, j]
    no = next_valid_index(np.isfinite(Oa))[ec, j]
    have = np.isfinite(base)
    miss = buyable & ~have
    pend = miss & (e >= T)
    after = miss & ~pend & (nc >= T)
    rest = miss & ~pend & ~after
    illiq = rest & (np.nan_to_num(nan20, nan=0.0) > 0)
    cat = np.where(~buyable, 'na', np.where(have, 'ok', np.where(pend, 'panel_end', np.where(after, 'no_close_after',
                   np.where(illiq, 'illiquid_no_trade', 'halt_then_resume')))))
    with np.errstate(invalid='ignore', divide='ignore'):
        a_last = np.where(miss & ~pend & (lc >= t), Ca[np.clip(lc, 0, T - 1), j] / open_t - 1, np.nan)
        a_next = np.where(miss & ~pend & (no < T), Oa[np.clip(no, 0, T - 1), j] / open_t - 1, np.nan)
    gap = np.where(rest, (nc - e).astype(np.float64), np.nan)
    return dict(cat=cat, gap=gap, alt_last=np.where(have, base, a_last), alt_next=np.where(have, base, a_next))


def gz_parts(data: bytes, limit: int = SHARD_LIMIT) -> list:
    """可重現的 gzip（mtime＝0）。壓縮後 ≤ limit 回傳單一份；否則依行切成連續片段各自壓縮，
    依序串接後 gunzip 會逐位還原原檔（gzip 多成員串流）。"""
    whole = gzip.compress(data, 9, mtime=0)
    if len(whole) <= limit:
        return [whole]
    n = int(np.ceil(len(whole) / (limit * 0.9)))
    lines = data.splitlines(keepends=True)
    step = int(np.ceil(len(lines) / n))
    parts = [gzip.compress(b''.join(lines[i:i + step]), 9, mtime=0) for i in range(0, len(lines), step)]
    if any(len(p) > limit for p in parts):
        return gz_parts_finer(lines, limit, n * 2)
    return parts


def gz_parts_finer(lines: list, limit: int, n: int) -> list:
    step = max(int(np.ceil(len(lines) / n)), 1)
    parts = [gzip.compress(b''.join(lines[i:i + step]), 9, mtime=0) for i in range(0, len(lines), step)]
    if any(len(p) > limit for p in parts) and step > 1:
        return gz_parts_finer(lines, limit, n * 2)
    return parts


def gunzip_parts(parts: list) -> bytes:
    return gzip.decompress(b''.join(parts))


def fill_names(codes, names, fallback: dict) -> tuple:
    """names.json 的名稱優先；缺的依序用官方快照（現名）與 TWSE 終止上市名單；都沒有就寫「來源未提供」。"""
    out_n, out_s = [], []
    for c, n in zip(codes, names):
        if isinstance(n, str) and n:
            out_n.append(n)
            out_s.append('names.json')
        elif c in fallback:
            out_n.append(fallback[c][0])
            out_s.append(fallback[c][1])
        else:
            out_n.append('來源未提供')
            out_s.append('來源未提供')
    return np.array(out_n, dtype=object), np.array(out_s, dtype=object)


# ───────────────────────── 共用載入 ─────────────────────────
def name_fallback() -> dict:
    out = {}
    cols = {'TWSE': '公司簡稱', 'TPEx': 'CompanyAbbreviation'}
    for mkt, (rel, ccol, _) in L.LISTING_SNAPSHOTS.items():
        for r in json.load(gzip.open(os.path.join(L.MAIN_REPO, rel)))['payload']:
            c, n = str(r[ccol]).strip(), str(r.get(cols[mkt], '')).strip()
            if n:
                out.setdefault(c, (n, f'{mkt} 上市（櫃）快照 2026-10-02 簡稱（現名）'))
    for r in json.load(gzip.open(os.path.join(L.MAIN_REPO, L.SUSPEND_LISTING)))['payload']:
        c, n = str(r.get('Code', '')).strip(), str(r.get('Company', '')).strip()
        if c and n:
            out.setdefault(c, (n, 'TWSE 終止上市名單 2026-10-02'))
    return out


def transfers() -> dict:
    g0 = json.load(open(os.path.join(OUT, 'tracks_t1_G0.json'), encoding='utf-8'))
    return {x['code']: x for x in g0['build']['listing']['transfers']}


def nan20_of(df, ncodes) -> np.ndarray:
    keys = EV.row_keys(df, ncodes)
    assert np.all(np.diff(keys) > 0), '框架列鍵未嚴格遞增'
    out = np.full(len(df), np.nan)
    for t in EV.EVAL_TRACKS + ('NE',):
        z = np.load(os.path.join(FIT.TRACK_DIR, f'a36_tracks_{t}.npz'))
        k = z['m_s'].astype(np.int64) * ncodes + z['m_j']
        ix = np.searchsorted(keys, k)
        ok = (ix < len(keys)) & (keys[np.minimum(ix, len(keys) - 1)] == k)
        out[ix[ok]] = z['k_nan20'][ok]
    return out


def annotations(df, I, res) -> pd.DataFrame:
    """逐列註記（與 df 同索引）：出場日分類與 alt 出場價、名稱補齊、依日期的市場別、處置狀態。"""
    Ca, Oa = np.asarray(res['A']['C'], np.float64), np.asarray(res['A']['O'], np.float64)
    s, j = df.s.values.astype(np.int64), df.j.values.astype(np.int64)
    buy = df.buyable.values.astype(bool)
    n20 = nan20_of(df, len(I['codes']))
    cols = {'nan20_s': n20}
    for h, k in HORIZONS:
        base = df[f'm_{h}'].values.astype(np.float64)
        x = exit_alternatives(Ca, Oa, s, j, base, buy, n20, k)
        chk = np.isfinite(base) & buy
        with np.errstate(invalid='ignore', divide='ignore'):
            re = Ca[np.minimum(s[chk] + k, len(Ca) - 1), j[chk]] / Oa[s[chk] + 1, j[chk]] - 1
        assert np.nanmax(np.abs(re - base[chk])) < 1e-5, f'{h}：還原價重算與 m_{h} 不符（陣列未對齊）'
        cols.update({f'x_{h}_cat': x['cat'], f'x_{h}_gap': x['gap'], f'alt_last_{h}': x['alt_last'], f'alt_next_{h}': x['alt_next']})
    nm, src = fill_names(df.code.values, df.name.values, name_fallback())
    cols.update(name_filled=nm, name_src=src)
    tr = transfers()
    mk = df.market.values.astype(object).copy()
    for c, x in tr.items():
        m = (df.code.values == c) & (df.date_s.values < x['listing'])
        mk[m] = '轉市場前（前市場來源未提供）'
    cols['market_by_date'] = mk
    dk = df.dk.values
    cols['disposal_status'] = np.where(dk == 0, '非處置（DK_s＝0）', np.where(dk == 1, '處置中（DK_s＝1）', '處置狀態未知（來源缺漏）'))
    cols['t_exec_flag'] = np.where(df.m_disp_t_exec.values == 1, 't 日起處置（開盤前已公告）', '')
    return pd.DataFrame(cols, index=df.index)


def annotate_rows(pk_rows: pd.DataFrame, ax: pd.DataFrame, lid: str) -> pd.DataFrame:
    a = ax.loc[pk_rows.index]
    flags = []
    for h, _ in HORIZONS:
        flags.append(np.array([EXIT_LABEL[c] for c in a[f'x_{h}_cat'].values], dtype=object))
    lab = [';'.join(x for x in (f5 and f'c5：{f5}', f10 and f'c10：{f10}', te) if x) for f5, f10, te in zip(flags[0], flags[1], a.t_exec_flag.values)]
    return pd.DataFrame({
        'name_filled': a.name_filled.values, 'name_src': a.name_src.values, 'market_by_date': a.market_by_date.values,
        'list_verdict': LIST_VERDICT[lid], 'disposal_status': a.disposal_status.values, 't_exec_flag': a.t_exec_flag.values,
        'exit_c5_status': flags[0], 'exit_c5_gap_days': a.x_c5_gap.values, 'm_c5_alt_lastclose': EV.fmt_pct(a.alt_last_c5.values),
        'm_c5_alt_nextopen': EV.fmt_pct(a.alt_next_c5.values), 'exit_c10_status': flags[1], 'exit_c10_gap_days': a.x_c10_gap.values,
        'm_c10_alt_lastclose': EV.fmt_pct(a.alt_last_c10.values), 'm_c10_alt_nextopen': EV.fmt_pct(a.alt_next_c10.values),
        'extra_labels': lab, 'addendum_note': POST_LOCK + '·' + L.NOTE})


def with_names(rec: pd.DataFrame, fallback: dict) -> pd.DataFrame:
    if rec.empty:
        return rec
    nm, src = fill_names(rec.code.values, rec.name.values, fallback)
    return rec.assign(name=nm, name_src=src)


# ───────────────────────── verify-ho ─────────────────────────
def stage_verify_ho():
    t0 = now()
    lock = json.load(open(os.path.join(OUT, 'tracks_t1_HO_LOCK.json'), encoding='utf-8'))
    started = json.load(open(os.path.join(OUT, 'tracks_t1_HO_STARTED.json'), encoding='utf-8'))
    import a36_tracks_ho as HO
    out = HO.run(CV.load_all, CV.evaluate, started['selection'], CV.ho_models_and_lists)
    files = out['files']
    cmp = {}
    for k, v in files.items():
        p = os.path.join(OUT, k)
        disk = L.file_sha256(p) if os.path.exists(p) else None
        lk = lock['outputs_sha256'].get(k)
        cmp[k] = dict(lock=lk, now=EV.sha(v), disk=disk, equal=lk == EV.sha(v) == disk)
    strict = all(x['equal'] for x in cmp.values()) and set(files) == set(lock['outputs_sha256'])
    s_now = json.loads(files['tracks_t1_HO_summary.json'])
    s_disk = json.load(open(os.path.join(OUT, 'tracks_t1_HO_summary.json'), encoding='utf-8'))
    drop = lambda d: {k: v for k, v in d.items() if k != 'deviations'}
    rec = dict(generated_by=f'scripts/surge-lab/{SELF} verify-ho', time_start=t0, time_end=now(), head=git('rev-parse', 'HEAD'),
               registration_sha256=L.REG_SHA256, lock_time=lock['time'], lock_head=lock['head'],
               code_sha256_equal_lock=CV.code_sha() == lock['code_sha256'], code_sha256_now=code_sha(),
               decisions_now=out['decisions'], decisions_lock=lock['decisions'], decisions_equal=out['decisions'] == lock['decisions'],
               verify_identical=strict, summary_equal_except_deviations=canon(drop(s_now)) == canon(drop(s_disk)),
               deviations_at_lock=s_disk['deviations'], deviations_now=s_now['deviations'], files=cmp,
               method='HO.run(load_all, evaluate, STARTED.selection, ho_models_and_lists)＝ho-eval --verify-identical 的同一條程式路徑；只比對，不寫任何 HO 產出',
               note_deviations='HO 摘要內嵌 a36_tracks_cv.deviations()（偏差紀錄的標題清單）與 code_sha256；偏差紀錄增列後，嚴格逐位只會在該欄不同，'
                               '因此另報 summary_equal_except_deviations', note=L.NOTE)
    if '--cli-stdout' in sys.argv:
        p = sys.argv[sys.argv.index('--cli-stdout') + 1]
        txt = open(p, encoding='utf-8').read()
        cli = json.loads(txt[txt.index('\n{') + 1:] if not txt.startswith('{') else txt)   # stdout 第一行是 BLD.log 的進度訊息
        rec['prior_cli_run'] = dict(command='a36_tracks_cv.py ho-eval --verify-identical', stdout_sha256=L.file_sha256(p),
                                    verify_identical=cli['verify_identical'], files_equal={k: v['lock'] == v['now'] for k, v in cli['files'].items()},
                                    note='同一工作階段先以 CLI 跑過一次（stdout 只印到終端，原本無存檔）；本檔為可稽核版本')
    CV.attempt('post-lock:verify-identical（只驗證、不寫 HO 產出）')
    open(os.path.join(OUT, 'tracks_t1_HO_VERIFY.json'), 'wb').write(CV.dumps(rec))
    log(f'verify-ho：嚴格逐位 {strict}；除 deviations 外相同 {rec["summary_equal_except_deviations"]}；判定相同 {rec["decisions_equal"]}')


# ───────────────────────── addendum ─────────────────────────
def group_setup(group):
    I, res = CV.load_all()
    if group == 'SELHC':
        summ = json.load(open(os.path.join(OUT, 'tracks_t1_summary.json'), encoding='utf-8'))
        sel = summ['selection']
        E = CV.evaluate(I, res, I['reg'], 'SELHC', CV.SELHC_LISTS, CV.SELHC_MODELS, selection=sel)
        ref_lists, ref_rec = summ['lists'], {k: v['sha256'] for k, v in summ['record_files'].items()}
        pre = 'tracks_t1_SELHC_'
    else:
        lock = json.load(open(os.path.join(OUT, 'tracks_t1_HO_LOCK.json'), encoding='utf-8'))
        assert lock['decisions'] == EXPECTED_DECISIONS, f'鎖檔判定與預期不同：{lock["decisions"]}'
        summ = json.load(open(os.path.join(OUT, 'tracks_t1_HO_summary.json'), encoding='utf-8'))
        sel = json.load(open(os.path.join(OUT, 'tracks_t1_HO_STARTED.json'), encoding='utf-8'))['selection']
        models, lists = CV.ho_models_and_lists(sel)
        E = CV.evaluate(I, res, I['reg'], 'HO', lists, models, selection=sel)
        ref_lists, ref_rec = summ['lists'], dict(lock['outputs_sha256'])
        pre = 'tracks_t1_HO_'
    return I, res, E, sel, summ, ref_lists, ref_rec, pre


def consistency(E, ref_lists, ref_rec) -> dict:
    rec = {k: dict(ref=ref_rec.get(k), now=EV.sha(v), equal=ref_rec.get(k) == EV.sha(v)) for k, v in E['records'].items()}
    keys = ('hits', 'picks', 'precision_pct', 'delta_vs_rand_pp', 'p_vs_rand')
    bad = []
    for lid, d in E['metrics'].items():
        for w, m in d.items():
            r = ref_lists[lid][w]
            for k in keys:
                if canon(m[k]) != canon(r[k]):
                    bad.append(f'{lid}|{w}|{k}')
            if canon(m['c5_all_buyable']) != canon(r['c5_all_buyable']):
                bad.append(f'{lid}|{w}|c5_all_buyable')
    out = dict(records=rec, records_all_equal=all(x['equal'] for x in rec.values()), metric_mismatches=bad)
    assert out['records_all_equal'] and not bad, f'補遺的重算與已鎖／已 commit 的結果不同：{out}'
    return out


SENS_WINDOWS = ('SEL', 'HC', 'HO', 'HO-model', 'HO-2023', 'HO-2024')


def window_blocks(E) -> tuple:
    sets = E['sets']
    days_all = np.sort(np.concatenate([sets[w] for w in (('SEL', 'HC') if 'SEL' in sets else ('HO',))]))
    return days_all, E['pos'], E['IDX'], [w for w in SENS_WINDOWS if w in sets]


def dblock(rows, col, days_all, pos, IDX, w) -> dict:
    v = EV.daily_mean(rows, col, days_all)
    return EV.ret_block(v[pos[w]], IDX[w])


def exit_tables(E, dfx, lists) -> tuple:
    days_all, pos, IDX, wins = window_blocks(E)
    disc, sens, texec = {}, {}, {}
    for lid in lists:
        b = dfx.loc[EV.picks_of(E['df'], lid).index]
        b = b[b.buyable]
        disc[lid], sens[lid], texec[lid] = {}, {}, {}
        for w in wins:
            bw = b[b.s.isin(E['sets'][w])]
            d = dict(n_buyable=int(len(bw)))
            for h, _ in HORIZONS:
                vc = bw[f'x_{h}_cat'].value_counts()
                d[f'{h}_missing'] = int(len(bw) - vc.get('ok', 0))
                d[f'{h}_missing_by_cause'] = {c: int(vc.get(c, 0)) for c in ('halt_then_resume', 'illiquid_no_trade', 'no_close_after', 'panel_end')}
                d[f'{h}_alt_last_still_nan'] = int((~np.isfinite(bw[f'alt_last_{h}'].values)).sum())
                d[f'{h}_alt_next_still_nan'] = int((~np.isfinite(bw[f'alt_next_{h}'].values)).sum())
            disc[lid][w] = d
            s = {}
            for h, _ in HORIZONS:
                for tag, sub in (('all_buyable', b), ('dk0', b[b.dk == 0])):
                    s[f'{h}_{tag}'] = {lab: dblock(sub, col, days_all, pos, IDX, w) for lab, col in
                                       (('base_registered', f'm_{h}'), ('alt_last_close', f'alt_last_{h}'), ('alt_next_open', f'alt_next_{h}'))}
            sens[lid][w] = s
            b0 = b[b.dk == 0]
            bx = b0[b0.m_disp_t_exec != 1]
            texec[lid][w] = dict(n_dk0_buyable=int(b0.s.isin(E['sets'][w]).sum()),
                                 n_excluded_t_exec=int((b0.s.isin(E['sets'][w]) & (b0.m_disp_t_exec == 1)).sum()),
                                 **{f'{h}_dk0_{lab}': dblock(sub, f'm_{h}', days_all, pos, IDX, w)
                                    for h, _ in HORIZONS for lab, sub in (('base_registered', b0), ('excl_t_exec', bx))})
            base_chk = sens[lid][w]['c5_all_buyable']['base_registered']['daily_mean_pct']
            ref = E['metrics'][lid][w]['c5_all_buyable']['daily_mean_pct']
            assert canon(base_chk) == canon(ref), f'{lid}|{w}：基準逐日 c5 重算不符（{base_chk} vs {ref}）'
    return disc, sens, texec


def t6_sensitivity(E, dfx, summ) -> dict:
    """S0 的 T6（相對同軌同日全部可買列的超額）在兩種出場價下的描述值；HO 才計算。"""
    days_all, pos, IDX, wins = window_blocks(E)
    lid = 'S0_atr14@5'
    b = dfx.loc[EV.picks_of(E['df'], lid).index]
    b = b[b.buyable]
    pool = dfx[(dfx.track_name == 'S') & dfx.buyable]
    out = {}
    for lab, col in (('base_registered', 'm_c5'), ('alt_last_close', 'alt_last_c5'), ('alt_next_open', 'alt_next_c5')):
        x = EV.daily_mean(b, col, days_all) - EV.daily_mean(pool, col, days_all)
        out[lab] = EV.ret_block(x[pos['HO']], IDX['HO'])
    out['pool_rows_c5_missing_HO'] = int((pool.s.isin(E['sets']['HO']) & ~np.isfinite(pool.m_c5.values)).sum())
    locked = summ['decision_detail']['S_detail']['T6']['excess']
    assert canon(out['base_registered']) == canon(locked), f'T6 基準重算不符：{out["base_registered"]} vs {locked}'
    return out


def holm_exact(E, summ) -> dict:
    """登錄的 Holm 應以精確 p 計算；鎖檔用的 H_R、H_S 是四捨五入到 5 位的 p。重算並與鎖檔並列（判定不變才算一致）。"""
    P, vec, pos, IDX = E['pairs'], E['vec'], E['pos'], E['IDX']
    ni = DC.noninferiority_p(P['Mp1@10 − M0@10']['HO-model'])
    pR = EV.p_one_sided(P['R1@5 − R0_combo@5']['HO-model']['_boot_dprec'])

    def p_vs_rand(lid):
        v = EV.sub_vec(vec[lid], pos['HO'])
        return EV.p_one_sided(EV.ratio_b(v['hits'], v['picks'], IDX['HO']) - EV.ratio_b(v['E'], v['picks'], IDX['HO']))
    exact = {'H_Mp': ni['p_Mp'], 'H_R': pR, 'H_S': p_vs_rand('S0_atr14@5')}
    he, hl = DC.holm(exact), summ['decision_detail']['holm']
    return dict(exact_p=exact, holm_exact=he, holm_lock=hl, same_rejections={k: he[k]['reject'] == hl[k]['reject'] for k in he},
                secondary_R0_vs_rand_exact_p=p_vs_rand('R0_combo@5'), note='判定不受影響時，依登錄 §8.2 第 8 點「兩次中較保守者」即原判定')


def extra_records(E, group, pre, ax, fallback) -> dict:
    df = E['df']
    wn = np.array(L.WINDOW_NAMES)
    win_name = lambda x: wn[x.window.values]
    files = {}
    m_lists = [x for x in ('M0@20', 'M_atr14@5', 'M_combo@5', 'Mp1_Monly@10') if f'rk_{x}' in df]
    ev = with_names(EV.event_records(df, 'M', m_lists, win_name), fallback)
    files[f'{pre}addendum_M_extra_hits.csv'] = ev[ev.result == '命中']
    files[f'{pre}addendum_M_extra_misses.csv'] = ev[ev.result == '漏網']
    pk = EV.pick_records(df, 'M', ['M0@20'], win_name)
    files[f'{pre}addendum_M0at20_picks.csv'] = pd.concat([pk, annotate_rows(EV.picks_of(df, 'M0@20'), ax, 'M0@20')], axis=1)
    lab = {'SELHC': {'final_lists': '選模結果（W_R、W_S）', 'proxy_lists': '代理版（R0＋S0）'},
           'HO': {'final_lists': 'HO 前選定清單（W_R＝R1，描述；R1 在 HO-2023 屬面板起點限制）',
                  'proxy_lists': '依判定樹的最終清單（R0＋S0）'}}[group]
    for tag, spec in E['equal_slot'].items():
        pks, evs = [], []
        for lid in spec['lists']:
            t = EV.LSPEC[lid]['track']
            p = EV.pick_records(df, t, [lid], win_name)
            pks.append(pd.concat([p, annotate_rows(EV.picks_of(df, lid), ax, lid)], axis=1))
            evs.append(EV.event_records(df, t, [lid], win_name))
        cp = pd.concat(pks, ignore_index=True).assign(composite=tag, composite_label=lab[tag])
        ce = with_names(pd.concat(evs, ignore_index=True), fallback).assign(composite=tag, composite_label=lab[tag])
        files[f'{pre}addendum_composite_{tag}_picks.csv'] = cp
        files[f'{pre}addendum_composite_{tag}_hits.csv'] = ce[ce.result == '命中']
        files[f'{pre}addendum_composite_{tag}_misses.csv'] = ce[ce.result == '漏網']
    return files


def picks_annotation(E, lists, ax) -> pd.DataFrame:
    """既有選股記錄（tracks_t1_[HO_]{軌}_picks.csv）逐列註記，列序與原檔相同（同一個 EV.pick_records 迴圈）。"""
    df = E['df']
    wn = np.array(L.WINDOW_NAMES)
    parts = []
    for t in EV.EVAL_TRACKS:
        for lid in [x for x in EV.TRACK_PICK_LISTS[t] if x in lists]:
            pk = EV.picks_of(df, lid)
            key = pd.DataFrame({'source_file_track': t, 'window': wn[pk.window.values], 'date_s': pk.date_s.values, 'code': pk.code.values,
                                'list_id': lid, 'rank': pk[f'rk_{lid}'].values.astype(int)})
            parts.append(pd.concat([key, annotate_rows(pk, ax, lid).reset_index(drop=True)], axis=1))
    return pd.concat(parts, ignore_index=True)


def global_disclosures(E, I) -> dict:
    """transfer_min 面板第一天、999 哨兵值、M0 百分位母體排除 brk_future 列（揭露，不重跑）。"""
    tr = transfers()
    day0 = sorted(c for c, x in tr.items() if x['first_close'] == L.PANEL_START)
    codes = np.array(I['codes'])
    out = dict(transfer_first_close_at_panel_start=day0, training_rows_age_cap_lt250_due_to_day0={})
    for t in FIT.MODEL_TRACKS:
        z = np.load(os.path.join(FIT.TRACK_DIR, f'a36_tracks_{t}.npz'))
        m = (np.isin(codes[z['m_j']], day0) & (z['m_s'] >= FIT.MIN_TRAIN_S) & (z['k_age_cap'] < L.AGE_CAP)
             & (z['k_listing_src'] == L.LISTING_SRC.index('transfer_min')))
        n_train = int((z['m_s'] >= FIT.MIN_TRAIN_S).sum())
        out['training_rows_age_cap_lt250_due_to_day0'][t] = dict(rows=int(m.sum()), s_range=[int(z['m_s'][m].min()), int(z['m_s'][m].max())] if m.any() else None,
                                                                 track_rows_s_ge_125=n_train, events=int(z['m_y'][m].sum()))
        sent = {}
        for f in ('f_days_since_lu', 'f_dp_since'):
            if f in z.files:
                v = z[f][z['m_s'] >= FIT.MIN_TRAIN_S]
                sent[f] = dict(n_eq_999=int((v == 999).sum()), share_pct=round(float((v == 999).mean()) * 100, 2))
        out.setdefault('sentinel_999', {})[t] = sent
    df = E['df']
    out['M_rows_brk_future_only_in_window'] = {w: int(((df.track_name == 'M') & (df.m_fBF == 1) & df.s.isin(v)).sum()) for w, v in E['sets'].items()}
    out['brk_future_note'] = ('M0 的同日百分位母體沿用釘住資料集（排除只卡 brk_future 的列，全面板 23 列，G0.3），'
                              '只卡 brk_future 的 M 列另以資料集列錨定；母體每次至多差 1 列，屬可忽略的前視（G0.5 逐位重現所需）。前向 M0 推論的母體要用 M 軌全部列')
    return out


def write_csv_gz(name: str, frame: pd.DataFrame) -> dict:
    raw = EV.csv_bytes(frame)
    parts = gz_parts(raw)
    paths = []
    for i, p in enumerate(parts):
        fn = f'{name}.gz' if len(parts) == 1 else f'{name}.gz.part{i + 1:02d}'
        open(os.path.join(ADD_DIR, fn), 'wb').write(p)
        paths.append(dict(path=f'addendum/{fn}', bytes=len(p), sha256=EV.sha(p)))
    assert gunzip_parts(parts) == raw
    return dict(raw_sha256=EV.sha(raw), raw_bytes=len(raw), rows=rows_of(raw), gz=paths)


def stage_addendum():
    group = sys.argv[sys.argv.index('--group') + 1]
    assert group in ('SELHC', 'HO')
    t0 = time.time()
    if group == 'HO':
        CV.attempt('post-lock:addendum:start（鎖後描述，不寫 HO 鎖定產出）')
    I, res, E, sel, summ, ref_lists, ref_rec, pre = group_setup(group)
    cons = consistency(E, ref_lists, ref_rec)
    log(f'[{group}] 重算與鎖檔／摘要一致（{len(cons["records"])} 份記錄、全部清單指標）')
    ax = annotations(E['df'], I, res)
    dfx = E['df'][['s', 'buyable', 'dk', 'm_disp_t_exec', 'track_name', 'm_c5', 'm_c10']].join(ax)
    lists = list(E['metrics'])
    disc, sens, texec = exit_tables(E, dfx, lists)
    fallback = name_fallback()
    os.makedirs(ADD_DIR, exist_ok=True)
    frames = extra_records(E, group, pre, ax, fallback)
    frames[f'{pre}addendum_picks_annotation.csv'] = picks_annotation(E, lists, ax)
    files = {k: write_csv_gz(k, v) for k, v in frames.items()}
    eq = {tag: {w: dict(composite_picks=d['composite']['picks'], composite_hits=d['composite']['hits'], M0_top20_picks=d['M0_top20']['picks'],
                        M0_top20_hits=d['M0_top20']['hits'], delta_pp=d['composite_minus_M0top20']['dprec_pp'],
                        ci_pp=d['composite_minus_M0top20']['dprec_ci_pp'])
                for w, d in spec['by_window'].items()} | {'lists': spec['lists']} for tag, spec in E['equal_slot'].items()}
    out = dict(generated_by=f'scripts/surge-lab/{SELF} addendum --group {group}', time=now(), head=git('rev-parse', 'HEAD'),
               registration_sha256=L.REG_SHA256, code_sha256=code_sha(), post_lock_note=POST_LOCK, consistency_with_locked=cons,
               selection_used=sel, exit_return_missing=disc, exit_price_sensitivity=sens, t_exec_sensitivity_T1=texec,
               equal_slot_counts=eq, names_blank_in_locked_records=name_blank_counts(E, fallback),
               global_disclosures=global_disclosures(E, I), files=files,
               exit_cause_labels={k: v for k, v in EXIT_LABEL.items() if v}, list_verdicts=LIST_VERDICT,
               cost_reference=I['reg']['cost_reference'], note=L.NOTE, runtime_s=round(time.time() - t0, 1))
    if group == 'HO':
        out['holm_exact_p'] = holm_exact(E, summ)
        out['T6_exit_sensitivity_S0'] = t6_sensitivity(E, dfx, summ)
    open(os.path.join(ADD_DIR, f'{pre}ADDENDUM_summary.json'), 'wb').write(CV.dumps(out))
    if group == 'HO':
        CV.attempt('post-lock:addendum:done（鎖後描述）')
    log(f'[{group}] 補遺完成：{len(files)} 份 CSV（gz）＋摘要（{out["runtime_s"]}s）')


def name_blank_counts(E, fallback) -> dict:
    out = {}
    for k, v in E['records'].items():
        if not k.endswith('.csv'):
            continue
        fr = pd.read_csv(io.BytesIO(v), dtype={'code': str}, keep_default_na=False)
        if 'name' not in fr or fr.empty:
            continue
        blank = fr[fr.name == '']
        if len(blank):
            codes = sorted(set(blank.code))
            out[k] = dict(rows=int(len(blank)), codes={c: (fallback[c][0] if c in fallback else '來源未提供') for c in codes})
    return out


# ───────────────────────── pack ─────────────────────────
def registered_outputs(reg) -> dict:
    o = reg['outputs']
    out = {k: 'selection_and_half_confirm' for k in o['selection_and_half_confirm']}
    out.update({k: 'holdout_run_files' for k in o['holdout_run_files']})
    out.update({k: 'holdout_separate' for k in o['holdout_separate']})
    out.update({k: 'phase0_extra（未列於登錄 outputs）' for k in ('tracks_t1_events_SELHC.csv', 'tracks_t1_events_limit_rule_diff.csv', 'tracks_t1_G0_gate.json')})
    out['tracks_t1_HO_VERIFY.json'] = 'post_lock_audit'
    return out


def g0_provenance() -> dict:
    """tracks_t1_G0.json 是否就是產生 SEL 摘要 G0 欄位的那一版：(1) g0_status() 以現檔重算＝摘要的 G0；
    (2) stage_report 記憶體內重算（攔截寫檔），除 output_sha256（輸出目錄已多出檔案）與 git（HEAD 已前進）外逐欄相同；
    output_sha256 逐鍵比對現檔。"""
    import a36_tracks_stages as ST
    summ = json.load(open(os.path.join(OUT, 'tracks_t1_summary.json'), encoding='utf-8'))
    status_equal = canon(json.loads(CV.dumps(CV.g0_status()))) == canon(summ['G0'])
    cap = {}
    orig = BLD.jdump
    try:
        BLD.jdump = lambda obj, path: cap.__setitem__(path, json.loads(json.dumps(obj, ensure_ascii=False, default=BLD._np_default)))
        with contextlib.redirect_stdout(io.StringIO()):
            ST.stage_report()
    finally:
        BLD.jdump = orig
    path = os.path.join(OUT, 'tracks_t1_G0.json')
    rep, disk = cap[path], json.load(open(path, encoding='utf-8'))
    fields = {k: canon(rep.get(k)) == canon(disk.get(k)) for k in disk if k not in ('output_sha256', 'git')}
    osha = {k: dict(file=v, now=rep['output_sha256'].get(k), equal=v == rep['output_sha256'].get(k)) for k, v in disk['output_sha256'].items()}
    st = os.stat(path)
    return dict(g0_status_recomputed_equals_summary_G0=status_equal, report_fields_equal=fields, report_all_fields_equal=all(fields.values()),
                output_sha256_entries=len(osha), output_sha256_all_equal=all(x['equal'] for x in osha.values()),
                output_sha256_mismatch={k: v for k, v in osha.items() if not v['equal']},
                file_git_head=disk['git']['head'], file_git_a36_dirty=disk['git']['a36_dirty'],
                file_mtime=time.strftime('%Y-%m-%dT%H:%M:%S%z', time.localtime(st.st_mtime)),
                summary_commit=git('log', '-1', '--format=%H %cI', '--', 'out/tracks_t1/tracks_t1_summary.json'),
                note='G0.json 的 git.head 是它寫出當下的 HEAD；SEL 摘要的 G0 欄位由 select 階段以 g0_status() 讀這個檔產生')


def tracked(rel) -> bool:
    return bool(subprocess.run(['git', '-C', L.LAB, 'ls-files', '--', rel], capture_output=True, text=True).stdout.strip())


def committed_sha(rel) -> str | None:
    r = subprocess.run(['git', '-C', L.LAB, 'show', f'HEAD:scripts/surge-lab/{rel}'], capture_output=True)
    return EV.sha(r.stdout) if r.returncode == 0 else None


def stage_pack():
    reg = L.load_registration()
    regd = registered_outputs(reg)
    summ = json.load(open(os.path.join(OUT, 'tracks_t1_summary.json'), encoding='utf-8'))
    lock = json.load(open(os.path.join(OUT, 'tracks_t1_HO_LOCK.json'), encoding='utf-8'))
    g0 = json.load(open(os.path.join(OUT, 'tracks_t1_G0.json'), encoding='utf-8'))
    refs = {'SEL 摘要 record_files': {k: v['sha256'] for k, v in summ['record_files'].items()},
            'HO_LOCK outputs_sha256': lock['outputs_sha256'],
            'G0.json output_sha256': {os.path.basename(k): v for k, v in g0['output_sha256'].items() if k.startswith('out/tracks_t1/')},
            'HO 摘要 record_files': {k: v['sha256'] for k, v in json.load(open(os.path.join(OUT, 'tracks_t1_HO_summary.json'), encoding='utf-8'))['record_files'].items()}}
    os.makedirs(GZ_DIR, exist_ok=True)
    files, raw_add, gz_add = {}, [], []
    for name, role in regd.items():
        p = os.path.join(OUT, name)
        rel = f'out/tracks_t1/{name}'
        if not os.path.exists(p):
            files[name] = dict(role=role, exists=False, note='檔案不存在')
            continue
        data = open(p, 'rb').read()
        ent = dict(role=role, bytes=len(data), sha256=EV.sha(data), rows=rows_of(data) if name.endswith('.csv') else None,
                   refs={k: dict(sha256=v[name], equal=v[name] == EV.sha(data)) for k, v in refs.items() if name in v})
        if tracked(rel):
            ent['storage'] = 'git 原檔（先前已 commit）'
            ent['committed_blob_sha256_equal_disk'] = committed_sha(rel) == ent['sha256']
            if name.endswith('.jsonl'):
                head_lines = subprocess.run(['git', '-C', L.LAB, 'show', f'HEAD:scripts/surge-lab/{rel}'], capture_output=True).stdout.count(b'\n')
                ent['lines_at_head'], ent['lines_now'] = head_lines, data.count(b'\n')
                ent['note'] = '只增不改：HEAD 之後附加的列是鎖後稽核紀錄（post-lock:*），本次一併 commit'
        elif len(data) <= RAW_COMMIT_MAX:
            ent['storage'] = 'git 原檔（本次補 commit，DEV-005）'
            raw_add.append(rel)
        else:
            parts = gz_parts(data)
            assert gunzip_parts(parts) == data
            gl = []
            for i, b in enumerate(parts):
                fn = f'{name}.gz' if len(parts) == 1 else f'{name}.gz.part{i + 1:02d}'
                open(os.path.join(GZ_DIR, fn), 'wb').write(b)
                gl.append(dict(path=f'gz/{fn}', bytes=len(b), sha256=EV.sha(b)))
                gz_add.append(f'out/tracks_t1/gz/{fn}')
            ent.update(storage='git gzip（本次補 commit，原檔不進版控，DEV-005）', gz=gl, gz_roundtrip_identical=True,
                       restore=f'cat {" ".join(x["path"] for x in gl)} | gunzip > {name}')
        files[name] = ent
    add = {}
    for fn in sorted(os.listdir(ADD_DIR)) if os.path.isdir(ADD_DIR) else []:
        b = open(os.path.join(ADD_DIR, fn), 'rb').read()
        add[f'addendum/{fn}'] = dict(bytes=len(b), sha256=EV.sha(b))
    man = dict(generated_by=f'scripts/surge-lab/{SELF} pack', time=now(), head=git('rev-parse', 'HEAD'), registration_sha256=L.REG_SHA256,
               registration_file_sha256=L.file_sha256(L.REG_JSON), code_sha256=code_sha(), g0_provenance=g0_provenance(), files=files,
               addendum_files=add, rules=dict(raw_commit_max_bytes=RAW_COMMIT_MAX, gzip='gzip -9、mtime＝0（可重現）', shard_if_gz_bytes_over=SHARD_LIMIT,
                                              shard_restore='分片依序串接後 gunzip 逐位還原（gzip 多成員串流）'),
               all_refs_equal=all(r['equal'] for e in files.values() for r in e.get('refs', {}).values()),
               to_git_add=sorted(raw_add + gz_add), note=POST_LOCK + '·' + L.NOTE)
    open(os.path.join(OUT, 'tracks_t1_ARTIFACT_MANIFEST.json'), 'wb').write(CV.dumps(man))
    log(f'pack：原檔補 commit {len(raw_add)} 份、gzip {len(gz_add)} 份；所有參照 sha256 相符＝{man["all_refs_equal"]}；'
        f'G0 來源核對＝{man["g0_provenance"]["g0_status_recomputed_equals_summary_G0"]}／{man["g0_provenance"]["report_all_fields_equal"]}')


if __name__ == '__main__':
    st = sys.argv[1] if len(sys.argv) > 1 else ''
    {'verify-ho': stage_verify_ho, 'addendum': stage_addendum, 'pack': stage_pack}.get(st, lambda: sys.exit(__doc__))()
