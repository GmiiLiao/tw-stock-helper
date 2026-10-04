"""T1 分軌研究 HOLDOUT（2023-08-01～2024-12-31）：只算一次的評估與判定（由 a36_tracks_cv.py ho-eval 呼叫；哨兵 commit 後才可執行）。

順序：第一道檢查＝HO 分區標籤 assertion（NE_LU_S 事件＝0、各軌事件加總＝全部 T1 事件）→ 代理與選定模型的清單（同一個 evaluate）
→ Holm（m＝3，家族單尾 α＝0.025）→ 判定樹（登錄 decision_tree，機械計算）。新模型清單只在 HO-model（2024Q2～Q4，186 日）判定；
HO-2023 的模型類結果只作描述（面板起點限制，不作判定）；排除 2024Q4 的敏感度只作描述。
報酬一律未扣成本·非投資建議。
"""
import json

import numpy as np

import a36_tracks_decide as DC
import a36_tracks_eval as EV
import a36_tracks_lib as L

NEW_MODEL_LISTS = ('Mp1@10', 'Mp1_Monly@10', 'M0s@10', 'R1@5', 'R2@5', 'S1@5', 'S2@5')
PANEL_START_NOTE = '面板起點限制，不作判定'


def ho_label_assertion(res) -> dict:
    """在任何指標之前：HO 視窗的 NE_LU_S 事件數與「各軌事件加總＝全部 T1 事件」（以全面板 y 與軌道矩陣核對）。"""
    win, y, tr, dom = res['cal']['window'], res['fl']['y'], res['part']['track'], res['domain']
    ho = np.nonzero(win == 1)[0]
    yy, tt, dd = y[ho].astype(bool), tr[ho], dom[ho]
    out = dict(all_T1_events=int(yy.sum()), events_outside_domain=int((yy & ~dd).sum()),
               events_by_track={t: int((yy & (tt == L.TID[t])).sum()) for t in L.TRACKS}, NE_LU_S_events=int((yy & (tt == L.TID['NE_LU_S'])).sum()))
    out['sum_tracks'] = sum(out['events_by_track'].values())
    out['pass_'] = out['NE_LU_S_events'] == 0 and out['sum_tracks'] == out['all_T1_events'] and out['events_outside_domain'] == 0
    return out


def sub_dk0(lm, keys) -> dict:
    return {k: {h: lm[k][f'{h}_dk0']['daily_mean_pct'] for h in ('c5', 'c10')} for k in keys}


def decide(E, sel) -> dict:
    M, P = E['metrics'], E['pairs']
    tests, detail = {}, {}
    # H_Mp（非劣性，HO-model）
    if sel['Mp1_carry_to_holdout']:
        ni = DC.noninferiority_p(P['Mp1@10 − M0@10']['HO-model'])
        tests['H_Mp'] = ni['p_Mp']
        c1p = EV.public(P['Mp1_Monly@10 − M0s@10']['HO-model'])
        detail['Mp'] = dict(noninferiority=ni, C1=dict(c1p, pass_=c1p['dprec_ci_pp'][0] > DC.C1_LOWER), C2=E['c2']['HO-model'],
                            M_rows_noninferiority_descriptive=EV.public(P['Mp1_Monly@10 − M0@10']['HO-model']),
                            label='擴大覆蓋面的產品決策，不是統計增益')
    else:
        tests['H_Mp'] = 1.0
        detail['Mp'] = dict(note='Mp1 未通過 SEL／HC 閘 ⇒ MP-REJECT，p_Mp 記 1（未在 HO 計算 Mp1）')
    for t in ('R', 'S'):
        W, prox = sel[f'W_{t}'], DC.PROXY[t]
        if W == prox:
            tests[f'H_{t}'] = M[prox]['HO']['p_vs_rand']
            detail[t] = dict(test=f'Δprecision@5({prox} − RAND_{t}) > 0（全部 347 日）', delta_pp=M[prox]['HO']['delta_vs_rand_pp'],
                             ci_pp=M[prox]['HO']['delta_vs_rand_ci_pp'],
                             label=('代理 lift 的時間外確認，不代表模型增益，也不代表可交易' if t == 'R' else '代理 lift 的時間外複製，不代表模型增益，也不代表可交易'))
        else:
            pr = P[f'{W} − {prox}']['HO-model']
            tests[f'H_{t}'] = pr['p_dprec_gt0']
            detail[t] = dict(test=f'Δprecision@5({W} − {prox}) > 0（HO-model 186 日）', delta_pp=pr['dprec_pp'], ci_pp=pr['dprec_ci_pp'],
                             secondary_proxy_vs_rand=dict(label='次要', delta_pp=M[prox]['HO']['delta_vs_rand_pp'], p=M[prox]['HO']['p_vs_rand']))
    H = DC.holm(tests)
    out = dict(holm=H, tests=detail)
    mp_adopt = bool(sel['Mp1_carry_to_holdout'] and H['H_Mp']['reject'] and detail['Mp']['C1']['pass_'] and detail['Mp']['C2']['pass_'])
    out['Mp'] = 'MP-ADOPT-SHADOW' if mp_adopt else 'MP-REJECT'
    for t in ('R', 'S'):
        W, prox = sel[f'W_{t}'], DC.PROXY[t]
        win = 'HO' if W == prox else 'HO-model'
        wr_pt = M[W][win]['delta_vs_rand_pp']
        confirmed = bool(H[f'H_{t}']['reject'] and wr_pt is not None and wr_pt > 0)
        final = W if confirmed else prox
        fwin, halves = ('HO', ('HO-2023', 'HO-2024')) if final == prox else ('HO-model', ('HO-model-a', 'HO-model-b'))
        tt = DC.tradable_tests(M[final][fwin], EV.public(P[f'{final} − M0@10'][fwin]), sub_dk0(M[final], halves)) if confirmed else None
        t6 = None
        if t == 'S' and confirmed:
            ex = M[final][fwin]['c5_excess_vs_pool']
            t6 = dict(pass_=ex['ci_pct'] is not None and ex['ci_pct'][1] >= 0, excess=ex)
        out[t] = DC.track_outcome(t, confirmed, M[prox]['HO']['delta_vs_rand_pp'], tt, t6)
        out[f'{t}_detail'] = dict(W=W, confirmed=confirmed, W_minus_RAND_pp=wr_pt, W_minus_RAND_window=win, final_list=final, window_for_T=fwin,
                                  proxy_minus_RAND_HO_pp=M[prox]['HO']['delta_vs_rand_pp'], T=tt, T6=t6,
                                  capacity_label='容量受限' if t == 'S' else None, unadjusted_note='T1～T6 未納入 Holm（未調整 95% CI）')
    if mp_adopt:
        out['S_FB'] = 'SFB-NA'
    else:
        lm = M['SFB_atr14@5']
        keep = lm['HO']['delta_vs_rand_ci_pp'][0] > 0 and lm['HO-2023']['delta_vs_rand_pp'] > 0 and lm['HO-2024']['delta_vs_rand_pp'] > 0
        out['S_FB'] = 'SFB-KEEP-AS-SHADOW' if keep else 'SFB-WATCH-ONLY'
        out['S_FB_detail'] = dict(delta_vs_rand_pp=lm['HO']['delta_vs_rand_pp'], ci_pp=lm['HO']['delta_vs_rand_ci_pp'],
                                  HO_2023_pp=lm['HO-2023']['delta_vs_rand_pp'], HO_2024_pp=lm['HO-2024']['delta_vs_rand_pp'], note='探索性，未納入 Holm')
    out['DD'] = DC.dd_outcome(E['dd1']['HO']['ci_pct'])
    out['DD1'] = E['dd1']['HO']
    out['DD2_descriptive'] = {lid: {k: M[lid]['HO'][k] for k in ('c5_dk1', 'c5_dk0', 'c10_dk1', 'c10_dk0')} for lid in ('M_atr14@5', 'M_combo@5', 'R0_combo@5')}
    out['M'] = 'M-UNCHANGED'
    out['W'] = 'W-WATCH-ONLY'
    return out


def run(load_all, evaluate, sel, ho_models_and_lists) -> dict:
    from a36_tracks_cv import DISCLOSURES, compact_pairs, deviations, dumps, partition_counts, code_sha   # 同一條程式路徑
    I, res = load_all()
    first = ho_label_assertion(res)
    if not first['pass_']:
        summ = dict(registration=L.REG_SHA256, first_assertion=first, result='HO 分區標籤 assertion 失敗：停止（不報任何評估數字）', note=L.NOTE)
        return dict(files={'tracks_t1_HO_summary.json': dumps(summ)}, decisions='HO-ASSERTION-FAILED')
    models, lists = ho_models_and_lists(sel)
    E = evaluate(I, res, I['reg'], 'HO', lists, models, selection=sel)
    dec = decide(E, sel)
    metrics = {lid: {w: (dict(m, _label=PANEL_START_NOTE) if lid in NEW_MODEL_LISTS and w in ('HO', 'HO-2023', 'HO-ex2024Q4') else m)
                     for w, m in d.items()} for lid, d in E['metrics'].items()}
    summ = dict(registration=dict(id='T1-TRACKS-PREREG-2026-10-04', version=2, sha256=L.REG_SHA256), code_sha256=code_sha(),
                generated_by='scripts/surge-lab/a36_tracks_cv.py ho-eval', first_assertion=first, selection_used=sel, models=models, lists_evaluated=lists,
                partition=partition_counts(E), decisions={k: dec[k] for k in ('Mp', 'R', 'S', 'S_FB', 'DD', 'M', 'W')}, decision_detail=dec,
                lists=metrics, pairs=compact_pairs(E['pairs']), equal_slot_control_descriptive=E['equal_slot'], DD1=E['dd1'], C2=E['c2'],
                window_roles={'HO': '代理清單、M0 參照、代理對 RAND、S_FB、DD1、DD2（347 日）', 'HO-model': '新模型清單的判定窗（186 日）',
                              'HO-2023／HO-2024': 'T4 兩段（代理）；模型類 HO-2023 只作描述', 'HO-model-a／b': '挑戰者 T4 兩段',
                              'HO-ex2024Q4／HO-model-ex2024Q4': '排除 2024Q4（曾調超參數）的敏感度，只作描述'},
                record_files={k: dict(sha256=EV.sha(v), bytes=len(v)) for k, v in E['records'].items()},
                disclosures=DISCLOSURES + ['HOLDOUT 只算一次；本檔數字不得用來重新選模', 'lab 其他工作曾用過 2023～2024（tune.py 以 2024Q4 選超參數等，登錄 §8.4）'],
                deviations=deviations(), note=L.NOTE)
    files = dict(E['records'])
    files['tracks_t1_HO_summary.json'] = dumps(summ)
    return dict(files=files, decisions={k: dec[k] for k in ('Mp', 'R', 'S', 'S_FB', 'DD', 'M', 'W')})
