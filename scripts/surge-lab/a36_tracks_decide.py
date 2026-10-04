"""T1 分軌研究：選模規則（登錄 selection_rule）與 HOLDOUT 判定樹（登錄 primary_tests／decision_tree），全部依 JSON 機械計算。
所有報酬條件未扣成本；T1～T6、C1、C2、S_FB、DD 皆為未調整的 95% CI（未納入 Holm）。非投資建議。
"""
import numpy as np

import a36_tracks_eval as EV

MP_MARGIN_PREC = 0.0030      # 0.30pp（比例）
MP_MARGIN_C5 = 0.0015        # 0.15pp
ALPHA = 0.025
HOLM_M = 3
C1_LOWER = -0.30             # pp
C2_TOTAL, C2_ROLL, C2_WIN = 20.0, 35.0, 20
CHALLENGERS = {'R': ('R1@5', 'R2@5'), 'S': ('S1@5', 'S2@5')}
PROXY = {'R': 'R0_combo@5', 'S': 'S0_atr14@5'}


# ───────────────────────── SELECTION＋HALF-CONFIRM ─────────────────────────
def mp_gate(pair_sel: dict, pair_hc: dict) -> dict:
    """Mp1 在 SEL 與 HC 各自：Δprecision@10 點估計 ≥ −0.30pp 且 Δc5 逐日點估計 ≥ −0.15pp（不合併）。"""
    def ok(p):
        dc5 = p['dc5_pp']
        return dict(dprec10_pp=p['dprec_pp'], dc5_pp=dc5, dprec_ok=p['dprec_pp'] >= -MP_MARGIN_PREC * 100 - 1e-12,
                    dc5_ok=dc5 is not None and dc5 >= -MP_MARGIN_C5 * 100 - 1e-12)
    a, b = ok(pair_sel), ok(pair_hc)
    a['pass'] = a['dprec_ok'] and a['dc5_ok']
    b['pass'] = b['dprec_ok'] and b['dc5_ok']
    return dict(SEL=a, HC=b, carry_to_holdout=a['pass'] and b['pass'],
                outcome_if_fail='MP-REJECT（p_Mp 記 1）', rule='兩視窗各自：Δprecision@10 ≥ −0.30pp 且 Δc5 逐日 ≥ −0.15pp（點估計）')


def challenger_select(track: str, pairs_sel: dict, pairs_hc: dict) -> dict:
    """挑戰者 SEL 配對 Δprecision@5 的 95% CI 下界 > 0 才合格；多個取下界最高者；HC 同一 Δ 點估計 ≥ 0 才保留，否則改回代理。"""
    cand = {}
    for c in CHALLENGERS[track]:
        lo = pairs_sel[c]['dprec_ci_pp'][0]
        cand[c] = dict(sel_dprec_pp=pairs_sel[c]['dprec_pp'], sel_dprec_ci_pp=pairs_sel[c]['dprec_ci_pp'], qualified=lo > 0,
                       hc_dprec_pp=pairs_hc[c]['dprec_pp'])
    q = [c for c in cand if cand[c]['qualified']]
    best = max(q, key=lambda c: cand[c]['sel_dprec_ci_pp'][0]) if q else None
    if best is None:
        winner, why = PROXY[track], '沒有挑戰者在 SELECTION 的配對 Δprecision@5 CI 下界 > 0 ⇒ 預設代理'
    elif cand[best]['hc_dprec_pp'] >= 0:
        winner, why = best, f'{best} SEL CI 下界 > 0 且 HC 點估計 ≥ 0'
    else:
        winner, why = PROXY[track], f'{best} SEL 合格但 HC 點估計 < 0 ⇒ 改回代理'
    return dict(candidates=cand, best_qualified=best, winner=winner, why=why)


# ───────────────────────── HOLDOUT ─────────────────────────
def holm(pvals: dict) -> dict:
    """Holm step-down，m 固定 3（沒有執行的檢定 p＝1）：p_adj(i)＝max_{k≤i} min(1, (m−k+1)·p_(k))；p_adj ≤ 0.025 拒絕。"""
    keys = sorted(pvals, key=lambda k: (pvals[k], k))
    adj, run = {}, 0.0
    for i, k in enumerate(keys):
        run = max(run, min(1.0, (HOLM_M - i) * pvals[k]))
        adj[k] = run
    return {k: dict(p=pvals[k], p_adj=adj[k], reject=adj[k] <= ALPHA) for k in pvals}


def noninferiority_p(pair: dict) -> dict:
    p1 = EV.p_one_sided(pair['_boot_dprec'], -MP_MARGIN_PREC)
    p2 = EV.p_one_sided(pair['_boot_dc5'], -MP_MARGIN_C5)
    return dict(p_dprec10=p1, p_dc5=p2, p_Mp=max(p1, p2), dprec10_pp=pair['dprec_pp'], dprec10_ci_pp=pair['dprec_ci_pp'],
                dc5_pp=pair['dc5_pp'], dc5_ci_pp=pair['dc5_ci_pp'])


def c2_check(share_daily_picks: np.ndarray, share_daily_mp: np.ndarray) -> dict:
    tot = share_daily_mp.sum() / max(share_daily_picks.sum(), 1) * 100
    roll = []
    for a in range(0, len(share_daily_picks) - C2_WIN + 1):
        p = share_daily_picks[a:a + C2_WIN].sum()
        roll.append(share_daily_mp[a:a + C2_WIN].sum() / max(p, 1) * 100)
    mx = max(roll) if roll else float('nan')
    return dict(total_share_pct=round(tot, 3), max_rolling20_share_pct=round(mx, 3), n_windows=len(roll),
                pass_=bool(tot <= C2_TOTAL and mx <= C2_ROLL))


def tradable_tests(lm_full: dict, pair_vs_m0: dict, sub_dk0: dict) -> dict:
    """T1～T4（DK_s＝0 選股，登錄 metrics.tradable_returns）。sub_dk0＝{期名: {'c5': 點估計, 'c10': 點估計}}（兩段）。"""
    t1 = {h: lm_full[f'{h}_dk0'] for h in ('c5', 'c10')}
    ok = {h: t1[h]['ci_pct'] is not None and t1[h]['ci_pct'][0] > 0 for h in ('c5', 'c10')}
    h = 'c5' if ok['c5'] else ('c10' if ok['c10'] else None)
    out = dict(T1=dict(pass_=h is not None, horizon=h, c5_dk0=t1['c5'], c10_dk0=t1['c10']))
    if h is None:
        out.update(T2=dict(pass_=False, why='T1 未過，無期數可比'), T3=dict(pass_=False), T4=dict(pass_=False))
        out['all_pass'] = False
        return out
    ci2 = pair_vs_m0[f'd{h}_dk0_ci_pp']
    out['T2'] = dict(pass_=ci2 is not None and ci2[1] >= 0, horizon=h, delta_pp=pair_vs_m0[f'd{h}_dk0_pp'], ci_pp=ci2)
    out['T3'] = dict(pass_=t1[h]['daily_mean_pct'] is not None and t1[h]['daily_mean_pct'] > 0, note='由 T1 蘊含')
    pts = {k: v[h] for k, v in sub_dk0.items()}
    out['T4'] = dict(pass_=all(x is not None and x > 0 for x in pts.values()), points_pct=pts)
    out['all_pass'] = all(out[k]['pass_'] for k in ('T1', 'T2', 'T3', 'T4'))
    return out


def track_outcome(track, confirmed: bool, proxy_vs_rand_pt: float, tt: dict, t6=None) -> str:
    if not confirmed:
        return f'{track}-REJECT' if proxy_vs_rand_pt <= 0 else f'{track}-WATCH-ONLY'
    if track == 'S' and not (t6 and t6['pass_']):
        return 'S-WATCH-ONLY'
    return f'{track}-TRADABLE-SHADOW' if tt['all_pass'] else f'{track}-KEEP-AS-SHADOW'


def dd_outcome(ci_pct) -> str:
    if ci_pct is None:
        return 'DD-INCONCLUSIVE'
    if ci_pct[0] > 0:
        return 'DD-SUPPORTED'
    if ci_pct[1] < 0:
        return 'DD-CONTRADICTED'
    return 'DD-INCONCLUSIVE'
