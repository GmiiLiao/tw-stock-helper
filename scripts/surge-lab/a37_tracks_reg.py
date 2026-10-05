"""T1 分軌前向影子：前向登錄修訂 v1.1（T1-TRACKS-FWD-2026-10-05；HO-BURNED 後 S0／S_FB 改只觀察）的載入與套用。

v1 登錄（registration_t1_tracks_forward.json，sha256 ec1a0bf8…）與釘選的 a36_tracks_fwd_rules（FWD_LISTS 等）一字不改；本檔不在
implementation_pins、也不在接線前證明綁定的 PREWIRE_CODE 內（只改清單層級的標籤與 G250 角色，不碰任何池、名單、名次或分數）：
  · load_amendment：先驗 v1（FR.load_forward_registration），再重算 v1.1 JSON 正規化 sha256 與 md 表頭比對，
    核對 registration_id、version、amends（＝v1 封存雜湊）、釘選摘要（＝v1 的 implementation_pins）與覆寫範圍；任一不符 ⇒ SystemExit（拒跑）。
  · effective_lists：FR.FWD_LISTS 套上 v1.1 覆寫後的新 dict（不改原物件）。
  · apply_to_core：core 凍結內容（a37_tracks_core.build_core 的 v1 標籤）→ 換上 v1.1 的判定／標籤／灰底，加修訂指標（回傳新 dict）。
  · gate_roles：G250／G500 用的角色（S0、S_FB 由 KEEP 改為 WATCH_UPGRADABLE）。
登錄全文：tracks/REGISTRATION_t1_tracks_forward_v1_1.md；依據 DEVIATIONS_t1_tracks.md DEV-014、DEVIATIONS_t1_tracks_forward.md FDEV-008。
影子模式·未扣成本·非投資建議。
"""
import json
import os

import a36_tracks_fwd_rules as FR
import a36_tracks_lib as L

AMEND_VERSION = '1.1'
AMEND_JSON = os.path.join(L.LAB, 'tracks', 'registration_t1_tracks_forward_v1_1.json')
AMEND_MD = os.path.join(L.LAB, 'tracks', 'REGISTRATION_t1_tracks_forward_v1_1.md')
AMEND_DEVIATION = 'FDEV-008'
# v1.1 只准覆寫這些清單與欄位（其餘沿用 v1）；登錄 JSON 的 override_fields 必須與此相同
OVERRIDE_LISTS = ('S0_atr14@5', 'SFB_atr14@5')
OVERRIDE_FIELDS = ('entry_verdict', 'grey_watch_only', 'label', 'list_verdict', 'g250_role', 'title')
G250_ROLES = ('KEEP', 'WATCH_UPGRADABLE', 'DESCRIPTIVE')
# 登錄欄名 → FR.FWD_LISTS 欄名
_FR_KEY = {'entry_verdict': 'verdict', 'grey_watch_only': 'grey', 'label': 'label', 'g250_role': 'g250'}


def _refuse(msg: str):
    raise SystemExit(f'前向登錄修訂 v{AMEND_VERSION}：{msg}：拒跑')


def load_amendment(json_path: str = AMEND_JSON, md_path: str = AMEND_MD, v1: dict = None) -> dict:
    """v1 先驗（v1 不符時 FR 自己丟 SystemExit），再驗 v1.1；回傳 v1.1 JSON 物件。"""
    v1 = v1 if v1 is not None else FR.load_forward_registration()
    if not os.path.isfile(json_path) or not os.path.isfile(md_path):
        _refuse(f'找不到 {os.path.basename(json_path)} 或 {os.path.basename(md_path)}')
    obj = json.load(open(json_path, encoding='utf-8'))
    h, want = L.canonical_sha256(obj), FR.recorded_sha256(md_path)
    if h != want:
        _refuse(f'JSON 雜湊 {h} ≠ 封存 {want}')
    if obj.get('registration_id') != FR.FWD_REG_ID or v1.get('registration_id') != FR.FWD_REG_ID:
        _refuse(f'registration_id {obj.get("registration_id")} ≠ {FR.FWD_REG_ID}')
    if obj.get('version') != AMEND_VERSION:
        _refuse(f'version {obj.get("version")!r} ≠ {AMEND_VERSION!r}')
    am = obj.get('amends') or {}
    v1_sha = L.canonical_sha256(v1)
    if am.get('version') != v1.get('version') or am.get('sha256') != v1_sha or am.get('sha256') != FR.recorded_sha256():
        _refuse(f'修訂對象不是封存的 v1（amends.sha256 {am.get("sha256")}，v1 {v1_sha}）')
    pins = (obj.get('implementation_pins') or {})
    if pins.get('inherit') != 'v1' or pins.get('files_sha256_canonical') != L.canonical_sha256(v1['implementation_pins']['files_sha256']):
        _refuse('implementation_pins 摘要與 v1 不同（本修訂不准改釘選）')
    ov = obj.get('lists_override') or {}
    if tuple(obj.get('override_fields') or ()) != OVERRIDE_FIELDS or set(ov) != set(OVERRIDE_LISTS):
        _refuse(f'覆寫範圍不符（清單 {sorted(ov)}，欄位 {obj.get("override_fields")}）')
    for lid, o in ov.items():
        if lid not in FR.FWD_LISTS or set(o) - set(OVERRIDE_FIELDS) - {'why'} or not set(OVERRIDE_FIELDS) <= set(o):
            _refuse(f'{lid} 的覆寫欄位不符：{sorted(o)}')
        if o['g250_role'] not in G250_ROLES or not isinstance(o['grey_watch_only'], bool):
            _refuse(f'{lid} 的 g250_role／grey_watch_only 不合規')
        if o['list_verdict'] != f'{o["entry_verdict"]}：{o["label"]}':
            _refuse(f'{lid} 的 list_verdict 與 entry_verdict／label 不一致')
    return obj


def effective_lists(amend: dict) -> dict:
    """FR.FWD_LISTS（v1）套上 v1.1 覆寫；回傳新 dict，另加 list_verdict 與 title（沒覆寫的清單 title＝None，介面沿用 v1 標題）。"""
    out = {}
    for lid, spec in FR.FWD_LISTS.items():
        o = amend['lists_override'].get(lid)
        base = dict(spec, list_verdict=FR.LIST_VERDICT_FWD[lid], title=None)
        if o is None:
            out[lid] = base
            continue
        out[lid] = dict(base, **{_FR_KEY[k]: o[k] for k in _FR_KEY}, list_verdict=o['list_verdict'], title=o['title'])
    return out


def gate_roles(amend: dict) -> dict:
    """G250／G500 的角色：KEEP ⇒ g250_keep；WATCH_UPGRADABLE ⇒ g250_watch；DESCRIPTIVE ⇒ 只描述。"""
    eff = effective_lists(amend)
    return {lid: eff[lid]['g250'] for lid in ('S0_atr14@5', 'SFB_atr14@5', 'R0_combo@5', 'W_atr14@3')}


def ref(amend: dict) -> dict:
    """寫進每份封印記錄（core、缺口、摘要）的修訂指標。"""
    return dict(registration_id=amend['registration_id'], version=amend['version'], sha256=L.canonical_sha256(amend),
                json=os.path.relpath(AMEND_JSON, FR.REPO_ROOT), amends_version=amend['amends']['version'], amends_sha256=amend['amends']['sha256'],
                deviation=AMEND_DEVIATION, basis='DEVIATIONS_t1_tracks.md DEV-014（HO-BURNED）',
                note='S0／S_FB 改只觀察（灰底）；G250 為升級檢定；其餘前向機制沿用 v1')


def apply_to_core(doc: dict, amend: dict) -> dict:
    """core 凍結內容（尚未封印）→ 新 dict：每份清單換上 v1.1 的 label、list_verdict、grey_watch_only，加 entry_verdict、g250_role；
    池、名單、名次、分數、RAND 一律不動。另加 registration_amendment。已有 registration_amendment（重複套用）就拒絕。"""
    if 'registration_amendment' in doc:
        raise ValueError('core 已套用過登錄修訂（不可重複套用）')
    eff = effective_lists(amend)
    lists = {}
    for lid, fl in doc['lists'].items():
        e = eff[lid]
        lists[lid] = dict(fl, label=e['label'], list_verdict=e['list_verdict'], grey_watch_only=e['grey'], entry_verdict=e['verdict'], g250_role=e['g250'])
    return dict(doc, lists=lists, registration_amendment=ref(amend))
