"""前向登錄修訂 v1.1（a37_tracks_reg；HO-BURNED 後 S0／S_FB 只觀察）的測試：python3 a37_tracks_reg_test.py（或 pytest -q）。
涵蓋：真實登錄檔（v1＋v1.1）雜湊與鏈結核對；竄改（雜湊、版本、修訂對象、釘選摘要、覆寫範圍、判定字串）一律拒跑；
覆寫只動清單層級欄位且不改 FR.FWD_LISTS；core 套用後池／名單／名次不動、parity 不受影響、不可重複套用；
G250／G500 升級語意與 v1 切分逐格等價；freeze_core 寫出的封印 core 帶 v1.1 標籤，缺口記錄帶修訂指標。
"""
import copy
import json
import os
import shutil
import tempfile

import a36_tracks_fwd_rules as FR
import a36_tracks_lib as L
import a37_tracks_core as C
import a37_tracks_fwd as FWD
import a37_tracks_fwd_io as IO
import a37_tracks_reg as REG
import a37_tracks_score as SC

WATCH = '只觀察（保留驗證期作廢·待前向 G250）'
PROXIES = ('S0_atr14@5', 'SFB_atr14@5', 'R0_combo@5', 'W_atr14@3')


def _tmp():
    return tempfile.mkdtemp(prefix='a37reg')


def _refuses(fn) -> str:
    try:
        fn()
    except SystemExit as e:
        return str(e)
    raise AssertionError('應該拒跑卻沒有')


def _tampered(mutate) -> tuple:
    """複製 v1.1 JSON、套 mutate、重算雜湊寫進暫存 md（只測語意核對，不是雜湊核對）。"""
    d = _tmp()
    obj = json.load(open(REG.AMEND_JSON, encoding='utf-8'))
    mutate(obj)
    jp, mp = os.path.join(d, 'a.json'), os.path.join(d, 'a.md')
    json.dump(obj, open(jp, 'w', encoding='utf-8'), ensure_ascii=False)
    open(mp, 'w', encoding='utf-8').write(f'| **JSON 封存雜湊（sha256）** | **`{L.canonical_sha256(obj)}`** |\n')
    return jp, mp


# ───────────────────────── 載入與鏈結 ─────────────────────────
def test_load_real_amendment_chain():
    v1 = FR.load_forward_registration()
    a = REG.load_amendment()
    assert a['registration_id'] == FR.FWD_REG_ID == v1['registration_id']
    assert a['version'] == '1.1' and a['amends']['version'] == 1
    assert a['amends']['sha256'] == L.canonical_sha256(v1) == FR.recorded_sha256()
    assert L.canonical_sha256(a) == FR.recorded_sha256(REG.AMEND_MD)
    assert a['implementation_pins']['n_files'] == len(v1['implementation_pins']['files_sha256']) == 17
    assert a['basis']['verdicts']['ho_burned']['S'] == 'S-WATCH-ONLY' and a['basis']['verdicts']['ho_burned']['S_FB'] == 'SFB-WATCH-ONLY'
    assert a['basis']['verdicts']['changed'] == ['S', 'S_FB']
    pv = a['basis']['proxy_vs_rand_pp']                                   # HO-BURNED 的 REJECT 條件：代理對 RAND（HO）點估計 ≤ 0 ⇒ 都不成立
    assert pv['R0_combo@5']['HO'] > 0 and pv['S0_atr14@5']['HO'] > 0
    assert a['scope']['in_shadow_research_lists'] == [] and set(a['scope']['grey_watch_only_lists']) == set(PROXIES)


def test_hash_mismatch_refused():
    d = _tmp()
    jp, mp = os.path.join(d, 'a.json'), os.path.join(d, 'a.md')
    shutil.copy(REG.AMEND_JSON, jp)
    shutil.copy(REG.AMEND_MD, mp)
    obj = json.load(open(jp, encoding='utf-8'))
    obj['lists_override']['S0_atr14@5']['label'] += '·竄改'
    json.dump(obj, open(jp, 'w', encoding='utf-8'), ensure_ascii=False)
    assert '雜湊' in _refuses(lambda: REG.load_amendment(jp, mp))
    assert '找不到' in _refuses(lambda: REG.load_amendment(os.path.join(d, 'none.json'), mp))


def test_semantic_tampering_refused():
    def ver(o):
        o['version'] = '1.2'

    def amends(o):
        o['amends']['sha256'] = '0' * 64

    def pins(o):
        o['implementation_pins']['files_sha256_canonical'] = '1' * 64

    def extra_list(o):
        o['lists_override']['R0_combo@5'] = dict(o['lists_override']['S0_atr14@5'])

    def extra_field(o):
        o['lists_override']['S0_atr14@5']['K'] = 10                        # 不准改 K、池、排名

    def verdict_text(o):
        o['lists_override']['S0_atr14@5']['list_verdict'] = 'S-KEEP-AS-SHADOW：' + o['lists_override']['S0_atr14@5']['label']

    def role(o):
        o['lists_override']['SFB_atr14@5']['g250_role'] = 'CONFIRM'

    def reg_id(o):
        o['registration_id'] = 'T1-TRACKS-FWD-2026-10-06'

    for fn, why in ((ver, 'version'), (amends, '修訂對象'), (pins, 'implementation_pins'), (extra_list, '覆寫範圍'), (extra_field, '覆寫欄位'),
                    (verdict_text, 'list_verdict'), (role, 'g250_role'), (reg_id, 'registration_id')):
        jp, mp = _tampered(fn)
        msg = _refuses(lambda: REG.load_amendment(jp, mp))
        assert why in msg, (why, msg)
    jp, mp = _tampered(lambda o: None)                                    # 原樣（只換位置）照常載入
    assert REG.load_amendment(jp, mp)['version'] == '1.1'


# ───────────────────────── 有效清單與角色 ─────────────────────────
def test_effective_lists_override_only_s0_sfb_and_never_mutates_fr():
    before = copy.deepcopy(FR.FWD_LISTS)
    a = REG.load_amendment()
    eff = REG.effective_lists(a)
    assert FR.FWD_LISTS == before                                         # 釘選模組的物件一字不動
    for lid, ver in (('S0_atr14@5', 'S-WATCH-ONLY'), ('SFB_atr14@5', 'SFB-WATCH-ONLY')):
        e = eff[lid]
        assert e['grey'] is True and e['verdict'] == ver and e['g250'] == 'WATCH_UPGRADABLE'
        assert e['label'].startswith(WATCH if lid == 'S0_atr14@5' else f'探索性·{WATCH}') and '不可交易' in e['label'] and '容量受限' in e['label']
        assert e['list_verdict'] == f'{ver}：{e["label"]}' and e['title'].startswith('灰底・')
        for k in ('track', 'pool', 'K', 'kind', 'src', 'section', 'exploratory'):
            assert e[k] == FR.FWD_LISTS[lid][k], (lid, k)              # 池、K、排名、區塊代碼不變
    for lid in ('R0_combo@5', 'W_atr14@3', 'M0@10', 'M0@20'):
        assert {k: v for k, v in eff[lid].items() if k not in ('list_verdict', 'title')} == FR.FWD_LISTS[lid]
        assert eff[lid]['list_verdict'] == FR.LIST_VERDICT_FWD[lid] and eff[lid]['title'] is None
    assert REG.gate_roles(a) == {'S0_atr14@5': 'WATCH_UPGRADABLE', 'SFB_atr14@5': 'WATCH_UPGRADABLE', 'R0_combo@5': 'WATCH_UPGRADABLE', 'W_atr14@3': 'DESCRIPTIVE'}


# ───────────────────────── core 套用 ─────────────────────────
def _fake_core():
    lists = {}
    for lid in PROXIES:
        s = FR.FWD_LISTS[lid]
        codes = [f'{i:04d}' for i in range(1, 8)]
        lists[lid] = dict(track=s['track'], pool=list(s['pool']), K=s['K'], ranking=s['src'], section=s['section'], grey_watch_only=s['grey'],
                          exploratory=s['exploratory'], label=s['label'], list_verdict=FR.LIST_VERDICT_FWD[lid], n_pool=len(codes),
                          ranked_codes=codes, ranked_scores=[1.0 / i for i in range(1, 8)], ranked_combo_n=None,
                          picks=[dict(rank=i + 1, code=c) for i, c in enumerate(codes[:s['K']])], rand=dict(seed=1, draw=codes[:2], picks=s['K']))
    return dict(kind='t1-tracks-core', registration_id=FR.FWD_REG_ID, registration_sha256=FR.recorded_sha256(), date_s='2026-10-06',
                domain=dict(codes=['0001', '0002'], track=[6, 5]), lists=lists)


def test_apply_to_core_changes_labels_only_and_keeps_parity():
    a = REG.load_amendment()
    core = _fake_core()
    orig = copy.deepcopy(core)
    out = REG.apply_to_core(core, a)
    assert core == orig                                                   # 回傳新 dict，不改輸入
    assert C.compare_core(orig, out)['equal'] is True                     # parity（軌道／池列數／名單／名次／分數）不受影響
    for lid in PROXIES:
        o, b = out['lists'][lid], orig['lists'][lid]
        for k in ('track', 'pool', 'K', 'ranking', 'section', 'n_pool', 'ranked_codes', 'ranked_scores', 'picks', 'rand', 'exploratory'):
            assert o[k] == b[k], (lid, k)
    s0, sfb, r0, w = (out['lists'][k] for k in PROXIES)
    assert s0['grey_watch_only'] is True and s0['entry_verdict'] == 'S-WATCH-ONLY' and s0['g250_role'] == 'WATCH_UPGRADABLE' and s0['label'].startswith(WATCH)
    assert sfb['grey_watch_only'] is True and sfb['entry_verdict'] == 'SFB-WATCH-ONLY' and sfb['list_verdict'].startswith('SFB-WATCH-ONLY：探索性·')
    assert r0['label'] == FR.LABEL_GREY and r0['entry_verdict'] == 'R-WATCH-ONLY' and r0['g250_role'] == 'WATCH_UPGRADABLE'
    assert w['entry_verdict'] == 'W-WATCH-ONLY' and w['g250_role'] == 'DESCRIPTIVE'
    ra = out['registration_amendment']
    assert ra['version'] == '1.1' and ra['sha256'] == FR.recorded_sha256(REG.AMEND_MD) and ra['amends_sha256'] == FR.recorded_sha256()
    assert ra['deviation'] == 'FDEV-008' and ra['json'] == 'scripts/surge-lab/tracks/registration_t1_tracks_forward_v1_1.json'
    assert out['registration_sha256'] == FR.recorded_sha256()             # v1 的雜湊照記（機制沿用 v1）
    try:
        REG.apply_to_core(out, a)
        raise AssertionError('重複套用應該被拒')
    except ValueError:
        pass


# ───────────────────────── G250／G500 升級語意 ─────────────────────────
def test_gate_report_v1_1_upgrade_semantics_and_v1_equivalence():
    roles = REG.gate_roles(REG.load_amendment())
    ok_proc = {f'P{i}': dict(ok=True) for i in range(1, 9)}
    w = lambda d, lo, hi: dict(delta_pp=d, delta_ci_pp=[lo, hi])
    good = {lid: w(0.5, 0.1, 0.9) for lid in SC.FWD_LIST_IDS}
    w250 = {'S0_atr14@5': w(0.5, 0.1, 0.9), 'SFB_atr14@5': w(0.3, -0.1, 0.7), 'R0_combo@5': w(-0.1, -0.5, 0.3), 'W_atr14@3': w(1, 0.5, 2)}
    g = SC.gate_report({'g60': good, 'g250': w250}, 250, ok_proc, roles=roles)
    assert g['g250']['verdict'] == {'S0_atr14@5': 'UPGRADE', 'SFB_atr14@5': 'EXTEND', 'R0_combo@5': 'STAY-WATCH', 'W_atr14@3': 'DESCRIPTIVE'}
    assert g['g250']['roles'] == roles
    w500 = dict(w250, **{'SFB_atr14@5': w(0.4, 0.05, 0.8)})
    g = SC.gate_report({'g60': good, 'g250': w250, 'g500': w500}, 500, ok_proc, roles=roles)
    assert g['g500']['verdict'] == {'SFB_atr14@5': 'UPGRADE'}
    g = SC.gate_report({'g60': good, 'g250': w250, 'g500': dict(w250, **{'SFB_atr14@5': w(0.2, -0.3, 0.7)})}, 500, ok_proc, roles=roles)
    assert g['g500']['verdict'] == {'SFB_atr14@5': 'STAY-WATCH'}
    crash = SC.gate_report({'g60': dict(good, **{'SFB_atr14@5': w(-0.2, -0.6, -0.05)})}, 60, ok_proc, roles=roles)
    assert crash['g60']['outcome'] == 'HALT-FOR-REVIEW' and crash['g60']['crash']['SFB_atr14@5'] is True     # 只觀察的清單照樣查崩壞
    for bad in ({}, dict(roles, **{'S0_atr14@5': 'CONFIRM'})):
        try:
            SC.gate_report({'g60': good}, 60, ok_proc, roles=bad)
            raise AssertionError('roles 不合規應該丟錯')
        except ValueError:
            pass
    # v1.1 的升級檢定與 v1 的維持檢定：同一個量、同一組門檻 ⇒ 切分逐格相同，只有結果名稱不同
    same = {'CONFIRM': 'UPGRADE', 'EXTEND': 'EXTEND', 'DROP': 'STAY-WATCH'}
    vals = (None, float('nan'), -1.0, -1e-9, 0.0, 1e-9, 0.4)
    for p in vals:
        for lo in vals:
            assert same[FR.g250_keep(p, lo)] == FR.g250_watch(p, lo), (p, lo)


# ───────────────────────── freeze_core／write_gap 寫出的記錄 ─────────────────────────
def test_freeze_core_seals_amended_labels_and_gap_carries_amendment():
    import a37_tracks_fwd_test as T
    orig_l, orig_b = C.listing_asof, C.build_core
    C.listing_asof = lambda root, day: dict(snaps={}, names={}, files={}, sha256='x')
    C.build_core = lambda I, s, t, lst, extra: dict(_fake_core(), schema='t', **{k: v for k, v in extra.items() if k != 'dataBasis'})
    try:
        out, cache = _tmp(), _tmp()
        I, ctx = T._fake_freeze_inputs(out, cache)
        ctx = dict(ctx, now_override='2026-10-05T23:50')
        r = FWD.freeze_core(I, ctx, '2026-10-05', '2026-10-06')
        assert r['result'] == 'written', r
        doc = json.load(open(SC.core_path(out, '2026-10-05'), encoding='utf-8'))
        assert IO.verify_seal(doc) and doc['registration_amendment']['version'] == '1.1'
        assert doc['lists']['S0_atr14@5']['grey_watch_only'] is True and doc['lists']['S0_atr14@5']['list_verdict'].startswith('S-WATCH-ONLY：' + WATCH)
        assert doc['lists']['SFB_atr14@5']['entry_verdict'] == 'SFB-WATCH-ONLY'
        assert ctx['amend']['version'] == '1.1'                          # 直接呼叫 freeze_core 也會補載修訂
    finally:
        C.listing_asof, C.build_core = orig_l, orig_b
    out = _tmp()
    ctx = dict(plan=dict(preflightBlocks=[]), now=IO.now_tw('2026-10-06T09:30'), rehearsal=True, now_override=None)
    assert FWD.write_gap(dict(out=out), ctx, '2026-10-05', '2026-10-06', '測試') == 'written'
    g = json.load(open(SC.gap_path(out, '2026-10-05'), encoding='utf-8'))
    assert IO.verify_seal(g) and g['registration_amendment']['sha256'] == FR.recorded_sha256(REG.AMEND_MD)


if __name__ == '__main__':
    tests = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    for t in tests:
        t()
    print(f'{len(tests)} 項測試全部通過')
